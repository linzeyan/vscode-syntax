//! Running someone else's language server.
//!
//! poly implements no completion, no go-to-definition and no rename. For the
//! languages that have a real language server the answer to "how should poly
//! do this" is R7's: it should not, it should run gopls. This module is the
//! plumbing that lets one editor connection reach one of them.
//!
//! What poly adds over installing those extensions directly is that the
//! routing, the resolution and the lifecycle sit next to the formatting and
//! lint that already work this way — one extension, one binary, one place
//! where "which tool answers for this language" is decided.
//!
//! The proxy is deliberately dumb: it does not interpret a single request. A
//! reply that poly could improve on is a reply poly would have to keep
//! improving, and the whole point is that the server's own maintainers are
//! better at that than poly ever will be.

use std::io::BufReader;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use lsp_server::{Message, Notification, Request, RequestId, Response};

/// Ids poly invents for its own traffic, so they can be told apart from the
/// editor's. The editor's client numbers its requests; nothing it sends will
/// collide with a string in this shape.
const POLY_ID: &str = "poly:";

/// How long a server gets to answer `initialize` before poly gives up on it.
///
/// Bounded because this wait happens on the thread serving the editor: a
/// server that never answers would otherwise take formatting and lint down
/// with it, which is a far worse failure than not having completion.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// How long a server gets to answer `shutdown` before poly stops being polite
/// about it. Short: the editor is already closing, and the kill that follows
/// is a correct if blunt answer.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

/// The requests poly hands over, paired with the capability field a server
/// uses to declare it.
///
/// Rename and code actions are here despite returning workspace edits: poly
/// never applies one. The edit travels to the editor, the editor applies it,
/// and poly sees the result as ordinary document changes — the same thing
/// typing produces. What poly formats afterwards is whatever the file then says.
///
/// Code actions carry the one exception to "the proxy interprets nothing":
/// the two kind families in `is_withheld_kind` are stripped, from the
/// registration and again from every reply. `editor.codeActionsOnSave` runs
/// them, and VSCode runs it *before* `editor.formatOnSave` — so gopls's
/// `source.organizeImports` and poly's gofumpt would both be rewriting the
/// import block on one keystroke, and they disagree about it: goimports keeps a
/// hand-split group inside the std imports, gofumpt merges it. Save ordering
/// would decide, which is not a thing to leave to save ordering.
///
/// What is left is the lightbulb, where the user asks for one action at a time
/// and nothing else is rewriting the file at that moment. It also keeps
/// `codeAction/resolve` routable: with the on-save kinds gone there is one
/// action list on screen, so it can use the same trick
/// `completionItem/resolve` does.
///
/// A code action mostly carries a `command` rather than an `edit` — every one
/// of gopls's does, measured — so `workspace/executeCommand` has to route too,
/// or the lightbulb offers refactorings that do nothing. See `server_commands`.
pub const PROXIED: &[(&str, &str)] = &[
    ("textDocument/hover", "hoverProvider"),
    ("textDocument/definition", "definitionProvider"),
    ("textDocument/typeDefinition", "typeDefinitionProvider"),
    ("textDocument/implementation", "implementationProvider"),
    ("textDocument/references", "referencesProvider"),
    ("textDocument/documentSymbol", "documentSymbolProvider"),
    ("textDocument/completion", "completionProvider"),
    ("textDocument/rename", "renameProvider"),
    ("textDocument/codeAction", "codeActionProvider"),
    // Read-only, document-scoped, no follow-up request to route: the same
    // shape as hover, which is why they arrive as one batch rather than one
    // decision each. Every one of them was measured as declared by at least
    // three of the six servers before being added — a row here that no server
    // answers is a registration the editor acts on and nothing fulfils.
    ("textDocument/signatureHelp", "signatureHelpProvider"),
    (
        "textDocument/documentHighlight",
        "documentHighlightProvider",
    ),
    ("textDocument/foldingRange", "foldingRangeProvider"),
    ("textDocument/declaration", "declarationProvider"),
    ("textDocument/selectionRange", "selectionRangeProvider"),
    // gopls's `assignVariableTypes` writes the inferred type onto every `:=`,
    // which is the one thing a reader of unfamiliar Go cannot get from the
    // text in front of them. Declared by gopls and rust-analyzer; neither asks
    // for resolution, but `inlayHint/resolve` is routed anyway, because the
    // flag that would trigger it lives in the server's own options and poly
    // passes those through verbatim.
    ("textDocument/inlayHint", "inlayHintProvider"),
    // The two hierarchies are what the editor's References panel offers beside
    // the reference list, and they are the half of "who uses this" that spans
    // files. Both are a `prepare` whose result the editor hands back as the
    // `item` of a follow-up request; those route by the file the item names,
    // which is exact rather than "whichever server answered last".
    ("textDocument/prepareCallHierarchy", "callHierarchyProvider"),
    ("textDocument/prepareTypeHierarchy", "typeHierarchyProvider"),
    // The actions a server offers about a whole file rather than a position:
    // for gopls, `go generate` on a .go and `go mod tidy` / `govulncheck` on a
    // go.mod. Held back until commands routed, because a lens is a command with
    // a label on it and clicking one that goes nowhere is worse than not
    // offering it. It coexists with poly-editor's own reference-count lens
    // rather than replacing it: that one needs no server at all, and the editor
    // shows every provider's lenses together.
    ("textDocument/codeLens", "codeLensProvider"),
];

// Capabilities the servers declare that poly leaves alone, so the next person
// adding a row above does not have to rediscover which were already weighed:
//
// - `documentOnTypeFormatting` (4 of 6 declare it): poly is the formatter.
//   This is the `source.organizeImports` collision without even the save
//   boundary to contain it — it fires mid-keystroke.
// - `semanticTokens` (4 of 6): routable, but a whole token set per change is
//   a different traffic profile, and it lands on top of the TextMate layer
//   poly-syntax-highlight already paints. Worth its own decision.

/// Requests poly routes but never registers.
///
/// The editor sends these because of something inside somebody else's
/// registration: a flag (`renameProvider.prepareProvider`,
/// `completionProvider.resolveProvider`, and the two other `resolveProvider`s)
/// or, for the hierarchy follow-ups, the items a `prepare` request returned.
/// Registering any of them separately would claim a capability no server
/// declared.
pub const EXTRA_ROUTED: &[&str] = &[
    "textDocument/prepareRename",
    "completionItem/resolve",
    "codeAction/resolve",
    "inlayHint/resolve",
    "codeLens/resolve",
    "callHierarchy/incomingCalls",
    "callHierarchy/outgoingCalls",
    "typeHierarchy/supertypes",
    "typeHierarchy/subtypes",
];

/// Notifications every running server needs, rather than the one that owns a
/// document.
///
/// `didChangeWatchedFiles` arrives because a *server* asked for it: gopls
/// registers a watcher for `**/*.{go,mod,sum,work}`, and poly forwards that
/// registration to the editor like any other server-to-client request. Until
/// now the notification that came back was dropped, which left every such
/// server blind to anything that did not arrive as a keystroke — a `git
/// checkout`, a `go mod tidy`, and a go.work appearing beside two modules that
/// until that moment could not see each other.
///
/// Broadcast rather than routed, because the notification names a list of
/// files rather than a document, and each server already filters by the globs
/// it registered for.
pub const BROADCAST: &[&str] = &["workspace/didChangeWatchedFiles"];

/// A code action kind poly keeps to itself, because running it would rewrite
/// the file the formatter is about to rewrite.
///
/// Two families, not every `source.*`. The first version withheld the whole
/// namespace, which was over-broad by a lot: gopls puts `Browse documentation`,
/// `Add test for run`, `Browse assembly`, `Browse free symbols` and
/// `Split package` under `source.*` too, and none of them touches formatting.
/// Withholding those meant the Go lightbulb had almost nothing in it and nobody
/// noticed, because an absent action looks the same as one the server did not
/// offer.
///
/// What has to stay withheld is what `editor.codeActionsOnSave` runs *before*
/// `editor.formatOnSave`: gopls's `source.organizeImports` and poly's gofumpt
/// disagree about import grouping, and save ordering would pick the winner.
/// `source.fixAll` is here for the same reason — it adds imports too — and
/// `source.formatAll` because it is the formatter: terraform-ls declares
/// `source.formatAll.terraform`, which is `terraform fmt` racing poly's own.
///
/// Prefix match down the dot-separated kind hierarchy, so `source` (which means
/// all of them) and `source.fixAll.foo` are both withheld, while a vendor kind
/// that merely starts with the same letters is not.
fn is_withheld_kind(kind: &str) -> bool {
    // Bare `source` means every source action, so it covers the three below.
    kind == "source"
        || [
            "source.organizeImports",
            "source.fixAll",
            "source.formatAll",
        ]
        .iter()
        .any(|family| kind == *family || kind.starts_with(&format!("{family}.")))
}

/// Is the editor asking only for the kinds poly does not hand over?
///
/// `editor.codeActionsOnSave` asks by kind, so a request that names nothing
/// else is that save arriving. Answering it here keeps a server poly is about
/// to ignore off the save path entirely, rather than paying for a round trip
/// whose whole answer gets thrown away.
pub fn only_withheld_actions(params: &serde_json::Value) -> bool {
    let Some(only) = params
        .get("context")
        .and_then(|context| context.get("only"))
        .and_then(serde_json::Value::as_array)
    else {
        return false;
    };
    !only.is_empty()
        && only
            .iter()
            .all(|kind| kind.as_str().is_some_and(is_withheld_kind))
}

/// A code action reply with the on-save kinds taken out.
///
/// The registration already tells the editor poly does not offer them, but
/// `codeActionKinds` is optional — a server that declared none gets asked for
/// everything, and this is what keeps the promise on its behalf.
pub fn without_withheld_actions(mut result: serde_json::Value) -> serde_json::Value {
    let Some(actions) = result.as_array_mut() else {
        return result;
    };
    // A bare Command has no `kind` and so cannot be an on-save action.
    actions.retain(|action| {
        !action
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .is_some_and(is_withheld_kind)
    });
    result
}

/// Document lifecycle notifications a downstream server needs to see. Without
/// these it is reading files from disk while the editor holds unsaved changes,
/// and every answer is subtly stale.
pub const SYNCED: &[&str] = &[
    "textDocument/didOpen",
    "textDocument/didChange",
    "textDocument/didSave",
    "textDocument/didClose",
];

pub struct Downstream {
    /// Binary name. Identifies the server in logs, in registration ids, and as
    /// the key poly routes on.
    pub name: String,
    /// Every language poly routes to this server. Usually one; clangd answers
    /// for both c and cpp, and one process has to serve them — a second clangd
    /// would index the same project again for the same answers.
    pub languages: Vec<String>,
    /// `capabilities` from the server's `initialize` result, verbatim. poly
    /// re-registers a subset of these with the editor rather than asserting
    /// what the server can do.
    pub capabilities: serde_json::Value,
    child: Child,
    stdin: ChildStdin,
    /// Fires when the server answers poly's `shutdown`. `stop` waits on it
    /// before sending `exit`.
    shutdown_ack: mpsc::Receiver<()>,
}

impl Downstream {
    /// Start `command`, complete the LSP handshake, and begin pumping its
    /// output to `forward`.
    ///
    /// `init_params` is the editor's own `InitializeParams`, passed through
    /// unchanged: the server has to see the same rootUri, workspaceFolders and
    /// client capabilities the editor offered, or it resolves imports against
    /// the wrong tree. poly is a pipe here, not a negotiator.
    ///
    /// `args` is only ever what the binary needs to be a language server at
    /// all — see `LAUNCH` in `lsp.rs`. Inventing anything beyond that is how a
    /// proxy starts making decisions for the server it is meant to be relaying.
    ///
    /// `logs` false sends the server's stderr to the void rather than asking it
    /// to be quiet: not every server has a flag for that (terraform-ls has
    /// none), and this way poly needs no opinion about any of them.
    pub fn start(
        name: &str,
        languages: &[String],
        command: &Path,
        args: &[&str],
        logs: bool,
        init_params: &serde_json::Value,
        forward: Box<dyn Fn(Message) + Send>,
    ) -> Result<Downstream> {
        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if logs { Stdio::piped() } else { Stdio::null() })
            .spawn()
            .with_context(|| format!("starting {name} ({})", command.display()))?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");

        // A server's stderr is where it says it cannot find the toolchain or
        // ran out of memory. Dropping it would turn every such failure into
        // "completion just does not work", which is the shape of bug this
        // project keeps finding and refusing to ship.
        if let Some(stderr) = child.stderr.take() {
            let name = name.to_string();
            std::thread::spawn(move || {
                use std::io::BufRead;
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    eprintln!("[{name}] {line}");
                }
            });
        }

        // One reader thread does the framing for both phases. The handshake
        // drains the channel with a deadline; everything after it is pumped
        // straight through.
        let (tx, rx) = mpsc::channel::<Message>();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(message)) = Message::read(&mut reader) {
                if tx.send(message).is_err() {
                    break; // poly stopped listening
                }
            }
        });

        let handshake = RequestId::from(format!("{POLY_ID}initialize"));
        Message::Request(Request {
            id: handshake.clone(),
            method: "initialize".to_string(),
            params: init_params.clone(),
        })
        .write(&mut stdin)
        .with_context(|| format!("sending initialize to {name}"))?;

        let capabilities = loop {
            let message = rx.recv_timeout(HANDSHAKE_TIMEOUT).map_err(|e| match e {
                // The channel closes when the child's stdout hits EOF, so this
                // is the server having exited. Worth telling apart: "it died"
                // and "it is ignoring us" have different causes, and the first
                // is answered immediately rather than after the full wait.
                mpsc::RecvTimeoutError::Disconnected => {
                    anyhow!("{name} exited without answering initialize")
                }
                mpsc::RecvTimeoutError::Timeout => anyhow!(
                    "{name} did not answer initialize within {}s",
                    HANDSHAKE_TIMEOUT.as_secs()
                ),
            })?;
            match message {
                Message::Response(response) if response.id == handshake => {
                    if let Some(error) = response.error {
                        return Err(anyhow!("{name} refused initialize: {}", error.message));
                    }
                    break response
                        .result
                        .and_then(|mut r| r.get_mut("capabilities").map(serde_json::Value::take))
                        .unwrap_or(serde_json::Value::Null);
                }
                // A server may log or ask the editor something before it
                // answers; those are the editor's business either way.
                other => forward(other),
            }
        };

        Message::Notification(Notification {
            method: "initialized".to_string(),
            params: serde_json::json!({}),
        })
        .write(&mut stdin)
        .with_context(|| format!("sending initialized to {name}"))?;

        let tag_with = name.to_string();
        let (ack_tx, shutdown_ack) = mpsc::channel::<()>();
        let shutdown_id = RequestId::from(format!("{POLY_ID}shutdown"));
        std::thread::spawn(move || {
            for message in rx {
                // Replies to poly's own requests are poly's business; passing
                // them on would have the editor answering for a request it
                // never made.
                if let Message::Response(response) = &message {
                    if is_poly_id(&response.id) {
                        // The exception: `stop` is waiting on this one.
                        if response.id == shutdown_id {
                            let _ = ack_tx.send(());
                        }
                        continue;
                    }
                }
                // A request from the server carries an id in *its* numbering,
                // and the editor's reply comes back to poly with that id and
                // nothing else. Tagging it with the server is what lets the
                // reply find its way home once there is more than one.
                let message = match message {
                    Message::Request(mut request) => {
                        request.id = tag(&tag_with, &request.id);
                        Message::Request(request)
                    }
                    Message::Response(response) => Message::Response(forwarded(response)),
                    other => other,
                };
                forward(message);
            }
        });

        Ok(Downstream {
            name: name.to_string(),
            languages: languages.to_vec(),
            capabilities,
            child,
            stdin,
            shutdown_ack,
        })
    }

    pub fn send(&mut self, message: Message) -> Result<()> {
        message
            .write(&mut self.stdin)
            .with_context(|| format!("writing to {}", self.name))
    }

    /// Ask the server to stop, then make sure it did.
    ///
    /// The editor closing is not a reason to leave a gopls behind holding a
    /// module's worth of memory, and a server that ignores `exit` is exactly
    /// the one that would.
    pub fn stop(&mut self) {
        let _ = Message::Request(Request {
            id: RequestId::from(format!("{POLY_ID}shutdown")),
            method: "shutdown".to_string(),
            params: serde_json::Value::Null,
        })
        .write(&mut self.stdin);
        // `exit` follows the shutdown *response*, not the request. Sending
        // both back to back looked fine against three servers and was wrong
        // the whole time: terraform-ls rejects an exit that arrives first
        // ("cannot exit as session is initialized") and then has to be killed
        // instead of being allowed to close down on its own terms.
        let _ = self.shutdown_ack.recv_timeout(SHUTDOWN_TIMEOUT);
        let _ = Message::Notification(Notification {
            method: "exit".to_string(),
            params: serde_json::Value::Null,
        })
        .write(&mut self.stdin);
        for _ in 0..20 {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The `client/registerCapability` entries poly sends once a server is up.
///
/// Dynamic registration rather than declaring these in poly's own `initialize`
/// result, because an LSP capability is server-wide while this one is not:
/// poly speaks for 29 languages and gopls answers for one. A documentSelector
/// is how the editor is told which. It also means a server that failed to
/// start registers nothing at all, rather than leaving the editor offering a
/// feature that answers null.
///
/// Driven by what the server declared, never by poly's idea of it — gopls's
/// completion trigger characters are gopls's to choose, and a capability it
/// does not have must not reach the editor as one that does.
///
/// One registration per method covers every language the server answers for,
/// which is why the id is keyed by server rather than language: clangd
/// registering twice, once for c and once for cpp, would be two registrations
/// claiming the same id.
pub fn registrations(
    capabilities: &serde_json::Value,
    name: &str,
    languages: &[String],
) -> Vec<serde_json::Value> {
    let selector: Vec<serde_json::Value> = languages
        .iter()
        .map(|language| serde_json::json!({ "scheme": "file", "language": language }))
        .collect();
    let selector = serde_json::Value::Array(selector);
    PROXIED
        .iter()
        .filter_map(|(method, capability)| {
            let declared = capabilities.get(capability)?;
            if declared.is_null() || declared == &serde_json::Value::Bool(false) {
                return None;
            }
            // A capability is either `true` or an options object; the object
            // is the server's own registration options already.
            let mut options = match declared {
                serde_json::Value::Object(map) => serde_json::Value::Object(map.clone()),
                _ => serde_json::json!({}),
            };
            options["documentSelector"] = selector.clone();
            // The editor picks providers by declared kind, so claiming the
            // ones poly strips out of every reply would put it back on the
            // save path to answer nothing. A server whose kinds were *all*
            // on-save has nothing left to register for.
            if *method == "textDocument/codeAction" {
                if let Some(kinds) = options
                    .get_mut("codeActionKinds")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    kinds.retain(|kind| !kind.as_str().is_some_and(is_withheld_kind));
                    if kinds.is_empty() {
                        return None;
                    }
                }
            }
            Some(serde_json::json!({
                "id": format!("{POLY_ID}{name}:{method}"),
                "method": method,
                "registerOptions": options,
            }))
        })
        .chain(execute_command_registration(capabilities, name))
        .collect()
}

/// The commands a server says it can run.
///
/// Empty for a server that declared none, which is most of the thin ones; gopls
/// declares 47.
pub fn server_commands(capabilities: &serde_json::Value) -> Vec<String> {
    capabilities
        .get("executeCommandProvider")
        .and_then(|provider| provider.get("commands"))
        .and_then(serde_json::Value::as_array)
        .map(|commands| {
            commands
                .iter()
                .filter_map(|command| command.as_str())
                // poly declared its own three at initialize, and the editor
                // registers a real VSCode command per id -- a duplicate throws
                // there and takes the whole client down with it. No server has
                // ever collided (theirs are `gopls.*`, `rust-analyzer.*`), but
                // the failure would be total and silent-looking, so it is
                // cheaper to make it unrepresentable.
                .filter(|command| !crate::lsp::EXECUTE_COMMANDS.contains(command))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Does this server answer `workspace/symbol`?
///
/// Read at request time rather than remembered, because which servers are
/// running changes through the session: opening a .lua an hour in adds one, and
/// the query has to reach it.
pub fn answers_workspace_symbol(capabilities: &serde_json::Value) -> bool {
    !matches!(
        capabilities.get("workspaceSymbolProvider"),
        None | Some(serde_json::Value::Null) | Some(serde_json::Value::Bool(false))
    )
}

/// The one `workspace/symbol` registration, minted once per session.
///
/// Once, not once per server, and the id says so by carrying no server name.
/// The editor turns each registration into a provider and queries every one of
/// them, so a second registration would mean a second `workspace/symbol`
/// request arriving for the same keystroke — and each of those fans out to
/// every server, so the user would see each symbol twice with two servers up
/// and three times with three.
///
/// `resolveProvider` is deliberately not claimed even when a server offers it.
/// A `workspaceSymbol/resolve` names no document and carries only the symbol's
/// own `data`, which belongs to whichever server made it; with the query fanned
/// out to all of them there is no honest way to route the follow-up. Not
/// claiming it means the servers must answer with complete locations, which is
/// what the protocol requires of a provider that does not resolve.
pub fn workspace_symbol_registration() -> serde_json::Value {
    serde_json::json!({
        "id": format!("{POLY_ID}workspace/symbol"),
        "method": "workspace/symbol",
        "registerOptions": {},
    })
}

/// Every server's answers to one query, as one list.
///
/// Concatenated in no particular order: each server ranks its own results and
/// nothing poly knows would let it rank across projects in different languages.
/// The editor sorts what it gets.
pub fn merge_symbols(answers: Vec<serde_json::Value>) -> serde_json::Value {
    let symbols: Vec<serde_json::Value> = answers
        .into_iter()
        .filter_map(|answer| match answer {
            serde_json::Value::Array(symbols) => Some(symbols),
            // `null` is a legal answer meaning "nothing", and an error was
            // already dropped by the caller. Neither is a reason to lose the
            // servers that did answer.
            _ => None,
        })
        .flatten()
        .collect();
    serde_json::Value::Array(symbols)
}

/// The registration that makes a downstream server's commands runnable.
///
/// Without it the lightbulb is decoration. A code action mostly carries a
/// `command` rather than an `edit` -- for gopls it is *always* a command, all
/// eight measured -- and the editor only turns a command into a request if some
/// registration named it, because that is what makes it a VSCode command in the
/// first place. So poly registering nothing here meant clicking `Extract
/// declarations to new file` did nothing at all.
///
/// Not part of the `PROXIED` loop: `ExecuteCommandRegistrationOptions` carries
/// a command list and no documentSelector, which is the one place the "scope it
/// to this server's languages" rule does not apply -- a command is global, and
/// routing it by name is exact anyway.
fn execute_command_registration(
    capabilities: &serde_json::Value,
    name: &str,
) -> Option<serde_json::Value> {
    let commands = server_commands(capabilities);
    if commands.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "id": format!("{POLY_ID}{name}:workspace/executeCommand"),
        "method": "workspace/executeCommand",
        "registerOptions": { "commands": commands },
    }))
}

/// A downstream response on its way to the editor, with a null result put back.
///
/// `lsp_server` parses a JSON `null` result into `None`, and skips the field
/// entirely when it serializes — so a reply that went in as `"result": null`
/// comes out carrying neither `result` nor `error`, which is not a legal
/// response. `null` is a real answer here ("no definition at this position")
/// and every server sends it eventually.
fn forwarded(mut response: Response) -> Response {
    if response.result.is_none() && response.error.is_none() {
        response.result = Some(serde_json::Value::Null);
    }
    response
}

/// Was this id minted by poly rather than by the editor?
pub fn is_poly_id(id: &RequestId) -> bool {
    serde_json::to_value(id)
        .ok()
        .and_then(|value| value.as_str().map(|s| s.starts_with(POLY_ID)))
        .unwrap_or(false)
}

/// `42` -> `"gopls:42"`. The tag rides on the id itself, so a reply routes with
/// no table for poly to keep in step with the traffic.
fn tag(name: &str, id: &RequestId) -> RequestId {
    RequestId::from(format!("{name}:{id}"))
}

/// Undo `tag`: the server poly sent this request out for, and the id that
/// server knows it by.
pub fn untag(id: &RequestId) -> Option<(String, RequestId)> {
    let tagged = serde_json::to_value(id).ok()?;
    let tagged = tagged.as_str()?;
    let (name, original) = tagged.split_once(':')?;
    // `tag` formats through Display, which quotes a string id and leaves a
    // numeric one bare -- so this parses back to whichever the server used.
    let original = original
        .parse::<i32>()
        .map(RequestId::from)
        .unwrap_or_else(|_| RequestId::from(original.trim_matches('"').to_string()));
    Some((name.to_string(), original))
}

/// A response saying poly has nothing for this request.
///
/// Sent when a request arrives for a language whose server is not running: an
/// empty answer is the truth, and an error would surface as a popup about a
/// feature the user did not ask poly for.
pub fn nothing(id: RequestId) -> Response {
    Response {
        id,
        result: Some(serde_json::Value::Null),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A server that dies on startup must fail the spawn, not the daemon.
    ///
    /// This is not hypothetical: a rustup or mise shim for a component that
    /// is not installed sits on PATH, resolves, runs, and exits — poly cannot
    /// tell those apart from a working server until it tries. Waiting out the
    /// full handshake timeout for one would freeze formatting and lint for
    /// every language, which is a far worse outcome than no completion.
    #[test]
    fn a_server_that_exits_fails_fast_and_says_so() {
        let started = std::time::Instant::now();
        let outcome = Downstream::start(
            "notaserver",
            &["go".to_string()],
            // Prints a version and exits: a process that speaks no LSP at all,
            // which is exactly what a broken shim looks like from here.
            &std::env::current_exe().unwrap(),
            &[],
            true,
            &serde_json::json!({}),
            Box::new(|_| {}),
        );
        let error = match outcome {
            Ok(_) => panic!("a process that speaks no LSP cannot be a language server"),
            Err(e) => e,
        };
        assert!(
            error.to_string().contains("exited without answering"),
            "{error:#}"
        );
        assert!(
            started.elapsed() < HANDSHAKE_TIMEOUT,
            "waited out the full timeout for a server that was already gone"
        );
    }

    #[test]
    fn tagging_survives_a_round_trip() {
        for original in [RequestId::from(42), RequestId::from("abc".to_string())] {
            let (name, back) = untag(&tag("gopls", &original)).expect("tagged id parses");
            assert_eq!(name, "gopls");
            assert_eq!(back, original, "id changed shape in transit");
        }
        // The editor's own ids are untagged and must stay that way.
        assert!(untag(&RequestId::from(7)).is_none());
    }

    /// Found on Windows against a rust-analyzer with no workspace loaded: it
    /// answered `"result": null` and the editor got `{"jsonrpc":"2.0","id":3}`,
    /// a response with neither field. Nothing Windows-specific about it —
    /// every server sends a null result the moment it has no answer.
    #[test]
    fn a_null_result_survives_the_trip_to_the_editor() {
        let raw = r#"{"jsonrpc":"2.0","id":3,"result":null}"#;
        let parsed: Response = serde_json::from_str(raw).expect("a response");
        assert!(
            parsed.result.is_none(),
            "lsp_server started keeping null results; this workaround can go"
        );

        let sent = serde_json::to_string(&forwarded(parsed)).expect("serialises");
        assert!(sent.contains(r#""result":null"#), "{sent}");

        // An error response must not grow a result alongside its error.
        let raw = r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"no"}}"#;
        let failed: Response = serde_json::from_str(raw).expect("a response");
        let sent = serde_json::to_string(&forwarded(failed)).expect("serialises");
        assert!(!sent.contains("result"), "{sent}");
    }

    #[test]
    fn poly_ids_are_distinguishable_from_the_editors() {
        assert!(is_poly_id(&RequestId::from(format!("{POLY_ID}initialize"))));
        assert!(!is_poly_id(&RequestId::from(1)));
        assert!(!is_poly_id(&RequestId::from("1".to_string())));
    }

    /// Registration is driven by what the server declared, not by poly's list:
    /// a capability the server does not have must not be advertised to the
    /// editor, or the feature exists in the UI and answers nothing.
    #[test]
    fn only_declared_capabilities_are_registered() {
        let declared = serde_json::json!({
            "hoverProvider": true,
            // Explicitly unsupported, and absent entirely: both mean the
            // editor must not be told the feature exists.
            "definitionProvider": false,
            "completionProvider": {"triggerCharacters": ["."], "resolveProvider": true},
        });
        let registrations = registrations(&declared, "gopls", &["go".to_string()]);
        let methods: Vec<&str> = registrations
            .iter()
            .map(|r| r["method"].as_str().unwrap())
            .collect();
        assert_eq!(methods, ["textDocument/hover", "textDocument/completion"]);

        // The server's own options ride along untouched: poly does not invent
        // trigger characters for someone else's completion.
        let completion = &registrations[1]["registerOptions"];
        assert_eq!(completion["triggerCharacters"], serde_json::json!(["."]));
        assert_eq!(completion["resolveProvider"], serde_json::json!(true));
        // Scoped to the one language this server answers for, not to all 29
        // poly speaks for.
        assert_eq!(completion["documentSelector"][0]["language"], "go");
        assert_eq!(
            registrations[0]["registerOptions"]["documentSelector"][0]["scheme"],
            "file"
        );
    }

    /// clangd is the one server measured that declares no `codeLensProvider`,
    /// and it is the reason this is worth a test of its own.
    ///
    /// A lens registration the server cannot fulfil is not a quiet no-op: the
    /// editor asks for lenses on every change to every visible document, and
    /// each one is a round trip to a server that will answer an empty list
    /// forever. `documentSelector` makes it per-language, so the cost lands on
    /// exactly the files that can never get an answer.
    #[test]
    fn a_server_without_lenses_is_not_registered_for_them() {
        let gopls = serde_json::json!({"codeLensProvider": {}});
        let clangd = serde_json::json!({"hoverProvider": true});

        let methods = |declared: &serde_json::Value, name: &str, language: &str| {
            registrations(declared, name, &[language.to_string()])
                .iter()
                .map(|r| r["method"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            methods(&gopls, "gopls", "go"),
            ["textDocument/codeLens"],
            "an empty options object is a declaration, not an absence"
        );
        assert!(!methods(&clangd, "clangd", "c").contains(&"textDocument/codeLens".to_string()));
    }

    /// The whole point of proxying code actions at all: the on-save kinds are
    /// the ones that would race gofumpt, and they must not survive the trip.
    #[test]
    fn on_save_kinds_never_reach_the_editor() {
        let reply = serde_json::json!([
            {"title": "Organize Imports", "kind": "source.organizeImports"},
            {"title": "Fix All", "kind": "source.fixAll"},
            {"title": "Everything source", "kind": "source"},
            // terraform-ls's, and it is `terraform fmt` under another name.
            {"title": "Format Document", "kind": "source.formatAll.terraform"},
            // gopls's, and none of them touch formatting.
            {"title": "Browse documentation", "kind": "source.doc"},
            {"title": "Extract function", "kind": "refactor.extract"},
            {"title": "Add missing import", "kind": "quickfix"},
            // A vendor kind that merely starts with the same letters, and a
            // bare Command with no kind at all. Both are the lightbulb's.
            {"title": "Sourcery thing", "kind": "sourcery.refactor"},
            {"title": "A Command", "command": "gopls.tidy"},
        ]);
        let filtered = without_withheld_actions(reply);
        let kept: Vec<&str> = filtered
            .as_array()
            .expect("still a list")
            .iter()
            .map(|action| action["title"].as_str().unwrap())
            .collect();
        assert_eq!(
            kept,
            [
                "Browse documentation",
                "Extract function",
                "Add missing import",
                "Sourcery thing",
                "A Command"
            ]
        );

        // A server answering `null` says nothing, and nothing is not a list.
        assert!(without_withheld_actions(serde_json::Value::Null).is_null());
    }

    /// The save path, recognised by what it asks for. Getting this wrong in
    /// either direction is bad: a false positive silently kills the lightbulb,
    /// a false negative puts a downstream round trip back on every save.
    #[test]
    fn a_request_for_only_on_save_kinds_is_recognised() {
        let only = |kinds: serde_json::Value| serde_json::json!({"context": {"only": kinds}});
        assert!(only_withheld_actions(&only(serde_json::json!([
            "source.organizeImports"
        ]))));
        assert!(only_withheld_actions(&only(serde_json::json!([
            "source.organizeImports",
            "source.fixAll"
        ]))));

        // The lightbulb asks for these, or for nothing in particular. The
        // narrowing that let gopls's `source.doc` through has to reach here too,
        // or the request carrying it is answered `[]` without ever being sent.
        assert!(!only_withheld_actions(&only(serde_json::json!([
            "quickfix"
        ]))));
        assert!(!only_withheld_actions(&only(serde_json::json!([
            "source.doc"
        ]))));
        assert!(!only_withheld_actions(&serde_json::json!({"context": {}})));
        assert!(!only_withheld_actions(&serde_json::json!({})));
        // An empty `only` is not "only the on-save kinds".
        assert!(!only_withheld_actions(&only(serde_json::json!([]))));
        // Mixed has something poly does hand over, so it goes downstream and
        // the reply filter takes the rest.
        assert!(!only_withheld_actions(&only(serde_json::json!([
            "quickfix",
            "source.fixAll"
        ]))));
    }

    /// The editor picks providers by declared kind, so the registration has to
    /// tell the same story every reply does.
    #[test]
    fn registration_does_not_claim_the_on_save_kinds() {
        let declared = serde_json::json!({
            "codeActionProvider": {
                "codeActionKinds": ["quickfix", "refactor.extract", "source.organizeImports"],
                "resolveProvider": true,
            },
        });
        let declares_both = registrations(&declared, "gopls", &["go".to_string()]);
        assert_eq!(declares_both.len(), 1);
        let options = &declares_both[0]["registerOptions"];
        assert_eq!(
            options["codeActionKinds"],
            serde_json::json!(["quickfix", "refactor.extract"])
        );
        // Everything else the server said about itself still rides along.
        assert_eq!(options["resolveProvider"], serde_json::json!(true));

        // A server whose kinds were all on-save has nothing left to offer, and
        // registering for it would put poly back on the save path to answer [].
        let only_on_save = serde_json::json!({
            "codeActionProvider": {"codeActionKinds": ["source.fixAll"]},
        });
        assert!(registrations(&only_on_save, "x", &["go".to_string()]).is_empty());

        // Declaring no kinds means the server does not say; poly still
        // registers, and the reply filter is what keeps the promise.
        let unspecified = serde_json::json!({"codeActionProvider": true});
        let declares_nothing = registrations(&unspecified, "x", &["go".to_string()]);
        assert_eq!(declares_nothing.len(), 1);
        assert!(declares_nothing[0]["registerOptions"]
            .get("codeActionKinds")
            .is_none());
    }

    /// A server covering several languages registers once for all of them.
    ///
    /// Registering per language would mint the same id twice, and the second
    /// `client/registerCapability` for an id the editor already holds is an
    /// error — the feature would come and go depending on which file was
    /// opened first.
    #[test]
    fn one_server_covers_every_language_it_answers_for() {
        let declared = serde_json::json!({"hoverProvider": true});
        let languages = ["c".to_string(), "cpp".to_string()];
        let registrations = registrations(&declared, "clangd", &languages);

        assert_eq!(
            registrations.len(),
            1,
            "one registration, not one per language"
        );
        assert_eq!(registrations[0]["id"], "poly:clangd:textDocument/hover");
        let selector = &registrations[0]["registerOptions"]["documentSelector"];
        let covered: Vec<&str> = selector
            .as_array()
            .expect("a selector per language")
            .iter()
            .map(|entry| entry["language"].as_str().unwrap())
            .collect();
        assert_eq!(covered, ["c", "cpp"]);
    }

    /// Registering the server's commands is what makes its code actions do
    /// anything: gopls answers every one of them with a `command` and no `edit`,
    /// so an unregistered command id is a lightbulb entry that silently no-ops.
    #[test]
    fn a_servers_commands_are_registered_but_never_polys_own() {
        let declared = serde_json::json!({
            "executeCommandProvider": {
                "commands": [
                    "gopls.extract_to_new_file",
                    "gopls.change_signature",
                    // A server that somehow named one of poly's: registering it
                    // twice in the editor throws and kills the whole client.
                    crate::lsp::EXECUTE_COMMANDS[0],
                ],
            },
        });
        let declares_commands = registrations(&declared, "gopls", &["go".to_string()]);
        assert_eq!(declares_commands.len(), 1);
        let registration = &declares_commands[0];
        assert_eq!(registration["method"], "workspace/executeCommand");
        assert_eq!(registration["id"], "poly:gopls:workspace/executeCommand");
        assert_eq!(
            registration["registerOptions"]["commands"],
            serde_json::json!(["gopls.extract_to_new_file", "gopls.change_signature"])
        );
        // A command list is global, so unlike every other registration it must
        // not be scoped to a language.
        assert!(registration["registerOptions"]
            .get("documentSelector")
            .is_none());

        // Nothing to register for a server that runs no commands, and that
        // empty list is also how `route` decides a command is poly's own.
        let no_commands = registrations(&serde_json::json!({"hoverProvider": true}), "x", &[]);
        assert!(no_commands
            .iter()
            .all(|r| r["method"] != "workspace/executeCommand"));
        assert!(server_commands(&serde_json::json!({})).is_empty());
    }
}

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
/// `source.*` kinds are stripped, from the registration and again from every
/// reply. Those are the kinds `editor.codeActionsOnSave` runs, and VSCode runs
/// them *before* `editor.formatOnSave` — so gopls's `source.organizeImports`
/// and poly's gofumpt would both be rewriting the import block on one
/// keystroke, and they disagree about it: goimports keeps a hand-split group
/// inside the std imports, gofumpt merges it. Save ordering would decide, which
/// is not a thing to leave to save ordering.
///
/// What is left is the lightbulb, where the user asks for one action at a time
/// and nothing else is rewriting the file at that moment. It also keeps
/// `codeAction/resolve` routable: with the on-save kinds gone there is one
/// action list on screen, so it can use the same trick
/// `completionItem/resolve` does.
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
];

/// Requests poly routes but never registers.
///
/// The editor sends these because of a flag inside somebody else's
/// registration — `renameProvider.prepareProvider` for the first,
/// `completionProvider.resolveProvider` for the second,
/// `codeActionProvider.resolveProvider` for the third — so registering them
/// separately would claim a capability the server never declared.
pub const EXTRA_ROUTED: &[&str] = &[
    "textDocument/prepareRename",
    "completionItem/resolve",
    "codeAction/resolve",
];

/// A code action kind the editor runs on save rather than on request.
///
/// Prefix match down the LSP kind hierarchy, which is dot-separated: `source`
/// and `source.organizeImports` are both on-save kinds, while a vendor kind
/// that merely starts with the same letters is not.
fn is_source_kind(kind: &str) -> bool {
    kind == "source" || kind.starts_with("source.")
}

/// Is the editor asking only for the kinds poly does not hand over?
///
/// `editor.codeActionsOnSave` asks by kind, so a request that names nothing
/// else is that save arriving. Answering it here keeps a server poly is about
/// to ignore off the save path entirely, rather than paying for a round trip
/// whose whole answer gets thrown away.
pub fn only_source_actions(params: &serde_json::Value) -> bool {
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
            .all(|kind| kind.as_str().is_some_and(is_source_kind))
}

/// A code action reply with the on-save kinds taken out.
///
/// The registration already tells the editor poly does not offer them, but
/// `codeActionKinds` is optional — a server that declared none gets asked for
/// everything, and this is what keeps the promise on its behalf.
pub fn without_source_actions(mut result: serde_json::Value) -> serde_json::Value {
    let Some(actions) = result.as_array_mut() else {
        return result;
    };
    // A bare Command has no `kind` and so cannot be an on-save action.
    actions.retain(|action| {
        !action
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .is_some_and(is_source_kind)
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
                    kinds.retain(|kind| !kind.as_str().is_some_and(is_source_kind));
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
        .collect()
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

    /// The whole point of proxying code actions at all: the on-save kinds are
    /// the ones that would race gofumpt, and they must not survive the trip.
    #[test]
    fn on_save_kinds_never_reach_the_editor() {
        let reply = serde_json::json!([
            {"title": "Organize Imports", "kind": "source.organizeImports"},
            {"title": "Fix All", "kind": "source.fixAll"},
            {"title": "Everything source", "kind": "source"},
            {"title": "Extract function", "kind": "refactor.extract"},
            {"title": "Add missing import", "kind": "quickfix"},
            // A vendor kind that merely starts with the same letters, and a
            // bare Command with no kind at all. Both are the lightbulb's.
            {"title": "Sourcery thing", "kind": "sourcery.refactor"},
            {"title": "A Command", "command": "gopls.tidy"},
        ]);
        let filtered = without_source_actions(reply);
        let kept: Vec<&str> = filtered
            .as_array()
            .expect("still a list")
            .iter()
            .map(|action| action["title"].as_str().unwrap())
            .collect();
        assert_eq!(
            kept,
            [
                "Extract function",
                "Add missing import",
                "Sourcery thing",
                "A Command"
            ]
        );

        // A server answering `null` says nothing, and nothing is not a list.
        assert!(without_source_actions(serde_json::Value::Null).is_null());
    }

    /// The save path, recognised by what it asks for. Getting this wrong in
    /// either direction is bad: a false positive silently kills the lightbulb,
    /// a false negative puts a downstream round trip back on every save.
    #[test]
    fn a_request_for_only_on_save_kinds_is_recognised() {
        let only = |kinds: serde_json::Value| serde_json::json!({"context": {"only": kinds}});
        assert!(only_source_actions(&only(serde_json::json!([
            "source.organizeImports"
        ]))));
        assert!(only_source_actions(&only(serde_json::json!([
            "source.organizeImports",
            "source.fixAll"
        ]))));

        // The lightbulb asks for these, or for nothing in particular.
        assert!(!only_source_actions(&only(serde_json::json!(["quickfix"]))));
        assert!(!only_source_actions(&serde_json::json!({"context": {}})));
        assert!(!only_source_actions(&serde_json::json!({})));
        // An empty `only` is not "only the on-save kinds".
        assert!(!only_source_actions(&only(serde_json::json!([]))));
        // Mixed has something poly does hand over, so it goes downstream and
        // the reply filter takes the rest.
        assert!(!only_source_actions(&only(serde_json::json!([
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
}

//! LSP daemon: full-sync document store, config-aware formatting (poly.toml
//! `[languages.map]` affects the editor exactly like the CLI, R5/A4),
//! lint-on-save diagnostics, and batch formatting via workspace/executeCommand
//! (shared with the CLI through crate::batch).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::Result;
use lsp_server::{Connection, Message, Notification, Response};
use lsp_types::{
    DidChangeTextDocumentParams, DidCloseTextDocumentParams, DidOpenTextDocumentParams,
    DidSaveTextDocumentParams, DocumentFormattingParams, DocumentRangeFormattingParams,
    ExecuteCommandOptions, ExecuteCommandParams, Hover, HoverContents, HoverParams,
    HoverProviderCapability, MarkupContent, MarkupKind, OneOf, Position, PublishDiagnosticsParams,
    Range, SaveOptions, ServerCapabilities, TextDocumentSyncCapability, TextDocumentSyncKind,
    TextDocumentSyncOptions, TextDocumentSyncSaveOptions, TextEdit, Url,
};

const INTERNAL_ERROR: i32 = -32603;
const METHOD_NOT_FOUND: i32 = -32601;
/// Command ids the daemon answers `workspace/executeCommand` for.
///
/// They must not collide with the ids the extension contributes: an LSP client
/// registers every command a server advertises as an editor command of the same
/// name, so sharing an id with `vscode.commands.registerCommand` makes that
/// registration throw and the client never finishes starting -- no formatter,
/// no diagnostics, no error anyone can see. Hence `poly.minifyJsonEdits` here
/// against `poly.minifyJson` in package.json: the server hands back edits, the
/// editor command is what applies them.
const FORMAT_PATHS: &str = "poly.formatPaths";
const MINIFY_JSON: &str = "poly.minifyJsonEdits";
const EDITOR_CONFIG: &str = "poly.editorConfig";
const EXECUTE_COMMANDS: &[&str] = &[FORMAT_PATHS, MINIFY_JSON, EDITOR_CONFIG];

pub fn run() -> Result<()> {
    let (connection, io_threads) = Connection::stdio();
    // The connection must be dropped before joining: the writer thread only
    // exits once every sender handle to its channel is gone.
    serve(connection)?;
    io_threads.join()?;
    Ok(())
}

/// Languages poly hands to a real language server, and the binary that serves
/// them.
///
/// PATH only, never a managed download — the same policy rustfmt and
/// clang-format already follow (01 §4.3). A language server has to match the
/// toolchain that built the project, and a version poly chose would be a
/// version poly chose wrong.
///
/// buf is the one entry that reason does not reach, so it is the one entry
/// poly resolves through the tool registry instead. A `.proto` is a
/// declaration with no build behind it: there is no toolchain for
/// `buf lsp serve` to be out of step with, and poly already pins that exact
/// binary as protobuf's formatter and linter. Making it PATH-only would mean
/// downloading buf to format a file and then refusing to use it to navigate
/// the same file. See `server_command`.
const LANGUAGE_SERVERS: &[(&str, &str)] = &[
    ("go", "gopls"),
    ("rust", "rust-analyzer"),
    ("c", "clangd"),
    ("cpp", "clangd"),
    ("swift", "sourcekit-lsp"),
    // Terraform only. Generic .hcl (Packer, Consul) is a different language
    // that happens to share a syntax, and terraform-ls would read it as a
    // module that makes no sense.
    ("terraform", "terraform-ls"),
    ("lua", "lua-language-server"),
    ("protobuf", "buf"),
];

/// What a binary needs before it is a language server at all.
///
/// Not a preference and not poly's opinion: `terraform-ls` on its own prints
/// its usage and exits, because the language server is a subcommand of it.
/// buf is the same shape -- it is a whole protobuf toolkit, and the server is
/// one verb of it. Every other server here is its own entry point.
const LAUNCH: &[(&str, &[&str])] = &[("terraform-ls", &["serve"]), ("buf", &["lsp", "serve"])];

/// How poly gets hold of a language server binary.
///
/// The tool registry when poly pins the binary, PATH when the project does.
/// Membership in the registry is the test rather than a name check: it is
/// exactly the statement "poly chose this version", and buf is the only
/// language server that statement is true of. It also means `poly.toml` can
/// turn buf off or point it somewhere else through the same `[tools]` entry
/// that governs it as a formatter, rather than through a second setting that
/// says the same thing.
fn server_command(name: &str, config: &poly_core::Config) -> Option<PathBuf> {
    if poly_tools::tool(name).is_some() {
        return poly_tools::resolve(name, config, false)
            .command()
            .map(Path::to_path_buf);
    }
    poly_tools::find_on_path(name)
}

fn args_for(table: &'static [(&str, &[&str])], name: &str) -> &'static [&'static str] {
    table
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, args)| *args)
        .unwrap_or(&[])
}

/// The language server that answers for `language`, if poly knows one.
fn server_for(language: &str) -> Option<&'static str> {
    LANGUAGE_SERVERS
        .iter()
        .find(|(known, _)| *known == language)
        .map(|(_, name)| *name)
}

/// Every language a server answers for.
///
/// The map is written language-first because that is the direction a request
/// arrives in, but the server is what gets started — clangd serves c and cpp
/// from one process, and starting one per language would index the project
/// twice to give the same answers.
fn languages_for(name: &str) -> Vec<String> {
    LANGUAGE_SERVERS
        .iter()
        .filter(|(_, known)| *known == name)
        .map(|(language, _)| language.to_string())
        .collect()
}

struct Server {
    connection: Connection,
    documents: HashMap<Url, String>,
    lint_on_save: bool,
    /// Opt-in, and off by default: taking over Go means colliding with a
    /// golang.go the user has probably already installed, and that is their
    /// call to make rather than something a poly upgrade does to them.
    language_servers: bool,
    /// Whether a downstream server's own stderr reaches poly's log. On by
    /// default: a server explaining why it cannot answer well is exactly what
    /// this project refuses to swallow. Off sends it to the void — poly's own
    /// messages about a server that is missing or died are unaffected, since
    /// those are poly's to write.
    language_server_logs: bool,
    /// The editor's own InitializeParams, replayed to each downstream server.
    init_params: serde_json::Value,
    /// Running servers, keyed by binary name rather than language: clangd
    /// answers for c and cpp and there must be exactly one of it.
    ///
    /// Started on first sight of a document it answers for, never eagerly —
    /// gopls costs seconds and memory, and most sessions never open a Go file.
    /// A server that failed to start is remembered as absent so poly does not
    /// retry the spawn on every keystroke.
    downstream: HashMap<String, Option<crate::proxy::Downstream>>,
    /// Server that answered the most recent `textDocument/completion`, which is
    /// the only thing that can route a `completionItem/resolve`. See `route`.
    last_completion: Option<String>,
    /// The same, for `codeAction/resolve`.
    last_code_action: Option<String>,
    /// Editor ids of `textDocument/codeAction` requests still in flight.
    ///
    /// A response carries an id and no method, so this is the only way the pump
    /// thread can tell a code action list from any other reply — and the pump
    /// thread is where it has to be told, because a downstream response never
    /// reaches the main loop. Shared for the same reason `diagnostics` is.
    code_action_ids: Arc<Mutex<HashSet<lsp_server::RequestId>>>,
    /// Content hash at last lint per document: external linters cost tens of
    /// ms to seconds, so an unchanged save republishes nothing.
    lint_hashes: HashMap<Url, u64>,
    diagnostics: Arc<Mutex<Diagnostics>>,
}

/// Every source of diagnostics for a document, in one place.
///
/// `publishDiagnostics` replaces the whole set for a uri, so no source can
/// publish on its own — the last one to speak erases the rest. Everything is
/// kept here and every publish sends the union.
///
/// Shared rather than owned by `Server` because the downstream half arrives on
/// another thread: a language server publishes when it has something to say,
/// not when the editor asks poly a question.
#[derive(Default)]
struct Diagnostics {
    lint: HashMap<Url, Vec<lsp_types::Diagnostic>>,
    format: HashMap<Url, lsp_types::Diagnostic>,
    downstream: HashMap<Url, Vec<lsp_types::Diagnostic>>,
}

impl Diagnostics {
    /// The whole set for a uri, as the editor should see it.
    ///
    /// The formatter's parse failure is dropped for a proxied document on
    /// purpose: it is one the language server already reports, with a range
    /// covering the problem rather than the point the formatter gave up at.
    /// Lint findings are not dropped — selene and swiftlint report things no
    /// language server looks for, and silently losing them on a setting the
    /// user turned on for *more* information would be the wrong trade.
    fn merged(&self, uri: &Url, proxied: bool) -> Vec<lsp_types::Diagnostic> {
        let mut all = self.lint.get(uri).cloned().unwrap_or_default();
        if !proxied {
            all.extend(self.format.get(uri).cloned());
        }
        all.extend(self.downstream.get(uri).cloned().unwrap_or_default());
        all
    }

    fn forget(&mut self, uri: &Url) {
        self.lint.remove(uri);
        self.format.remove(uri);
        self.downstream.remove(uri);
    }
}

fn serve(connection: Connection) -> Result<()> {
    let capabilities = ServerCapabilities {
        text_document_sync: Some(TextDocumentSyncCapability::Options(
            TextDocumentSyncOptions {
                open_close: Some(true),
                change: Some(TextDocumentSyncKind::FULL),
                save: Some(TextDocumentSyncSaveOptions::SaveOptions(SaveOptions {
                    include_text: Some(false),
                })),
                ..Default::default()
            },
        )),
        document_formatting_provider: Some(OneOf::Left(true)),
        // Format Selection, and the `formatOnSaveMode: modifications` setting
        // that rides on the same request. Answered by narrowing a whole-document
        // format rather than by formatting the selected text, so see
        // `format_response` before assuming this is the fragment formatter the
        // name suggests.
        document_range_formatting_provider: Some(OneOf::Left(true)),
        // Rule documentation for a finding already on screen -- not a language
        // feature. A6 rules out completion, go-to-definition and the rest, all
        // of which mean understanding the code; this only reads out what the
        // linter that produced the squiggle has to say about its own rule.
        hover_provider: Some(HoverProviderCapability::Simple(true)),
        execute_command_provider: Some(ExecuteCommandOptions {
            commands: EXECUTE_COMMANDS.iter().map(|c| c.to_string()).collect(),
            ..Default::default()
        }),
        ..Default::default()
    };
    let init_params = connection.initialize(serde_json::to_value(capabilities)?)?;
    let option = |name: &str, default: bool| {
        init_params
            .get("initializationOptions")
            .and_then(|o| o.get(name))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(default)
    };
    let lint_on_save = option("lintOnSave", true);
    let language_servers = option("languageServers", false);
    let language_server_logs = option("languageServerLogs", true);

    let mut server = Server {
        connection,
        documents: HashMap::new(),
        lint_on_save,
        language_servers,
        language_server_logs,
        init_params,
        downstream: HashMap::new(),
        last_completion: None,
        last_code_action: None,
        code_action_ids: Arc::new(Mutex::new(HashSet::new())),
        lint_hashes: HashMap::new(),
        diagnostics: Arc::new(Mutex::new(Diagnostics::default())),
    };

    // A receive error means the editor closed the pipe: nothing left to serve.
    while let Ok(message) = server.connection.receiver.recv() {
        match message {
            Message::Request(request) => {
                if server.connection.handle_shutdown(&request)? {
                    break;
                }
                let started = Instant::now();
                let method = request.method.clone();
                // A proxied language answers for itself. The reply carries the
                // editor's own request id, so it lands where it belongs
                // without poly touching it.
                let request = match server.route(request) {
                    Ok(None) => continue,
                    Ok(Some(request)) => request,
                    Err(e) => {
                        eprintln!("[poly] {method}: {e:#}");
                        continue;
                    }
                };
                let response = match method.as_str() {
                    "textDocument/formatting" => server.on_formatting(request),
                    "textDocument/rangeFormatting" => server.on_range_formatting(request),
                    "textDocument/hover" => server.on_hover(request),
                    "workspace/executeCommand" => server.on_execute_command(request),
                    // Reached poly because no downstream claimed it. Dropping
                    // it is not a harmless no-op: the editor waits on that id
                    // for the rest of the session, so the feature looks hung
                    // instead of absent.
                    _ => Response::new_err(
                        request.id,
                        METHOD_NOT_FOUND,
                        format!("poly does not handle {method}"),
                    ),
                };
                eprintln!(
                    "[poly] {method} {:.1}ms",
                    started.elapsed().as_secs_f64() * 1000.0
                );
                server.connection.sender.send(Message::Response(response))?;
            }
            Message::Notification(notification) => server.on_notification(notification)?,
            // Either an answer to something poly asked the editor (its own
            // registrations), or one meant for a downstream server that asked
            // through poly.
            Message::Response(response) => server.on_client_response(response),
        }
    }

    // Here rather than only on the `shutdown` path: an editor that dies takes
    // its pipe with it and never asks politely, and that is exactly when a
    // downstream server is left holding a project's worth of memory. Observed
    // as rust-analyzer's "client exited without proper shutdown sequence".
    server.stop_downstream();
    Ok(())
}

impl Server {
    /// Hand `request` to a downstream server if one answers for it.
    ///
    /// `Ok(None)` means it was forwarded and poly must stay quiet — two
    /// replies to one id is a protocol violation, and the editor believes the
    /// first. `Ok(Some(request))` hands it back for poly to answer itself.
    fn route(&mut self, request: lsp_server::Request) -> Result<Option<lsp_server::Request>> {
        if !crate::proxy::PROXIED
            .iter()
            .any(|(method, _)| *method == request.method)
            && !crate::proxy::EXTRA_ROUTED.contains(&request.method.as_str())
        {
            return Ok(Some(request));
        }
        // completionItem/resolve names no document -- it is a follow-up about
        // an item some server already produced, and once two servers are up
        // there is nothing in the request to tell them apart. The item's `data`
        // field could carry the origin, but that field belongs to the server
        // that made the item and rewriting it would break resolve outright.
        // A resolve is always about the list currently on screen, and there is
        // only ever one of those, so the last completion's server is it.
        let name = match request.method.as_str() {
            "completionItem/resolve" => self.last_completion.clone(),
            // Same problem, same answer, and only because the on-save kinds are
            // gone: those put several action lists in flight at once, and
            // "whichever server answered last" would be the wrong one. The
            // lightbulb is one list at a time, like a completion list.
            "codeAction/resolve" => self.last_code_action.clone(),
            _ => request
                .params
                .get("textDocument")
                .and_then(|d| d.get("uri"))
                .and_then(serde_json::Value::as_str)
                .and_then(|uri| Url::parse(uri).ok())
                .and_then(|uri| self.server_of(&uri))
                .map(str::to_string),
        };
        let Some(name) = name else {
            return Ok(Some(request));
        };
        if request.method == "textDocument/completion" {
            self.last_completion = Some(name.clone());
        }
        if request.method == "textDocument/codeAction" {
            if crate::proxy::only_source_actions(&request.params) {
                // The save asking for kinds poly does not hand over. An empty
                // list is the honest answer and it costs no round trip.
                let empty = Response {
                    id: request.id,
                    result: Some(serde_json::json!([])),
                    error: None,
                };
                self.connection.sender.send(Message::Response(empty))?;
                return Ok(None);
            }
            self.last_code_action = Some(name.clone());
        }
        match self.downstream.get_mut(&name) {
            Some(Some(server)) => {
                // Only once it is really going downstream: an id recorded for a
                // request poly answers itself would sit in the set forever,
                // since nothing comes back through the pump thread to clear it.
                if request.method == "textDocument/codeAction" {
                    self.code_action_ids
                        .lock()
                        .expect("code action lock")
                        .insert(request.id.clone());
                }
                server.send(Message::Request(request))?;
                Ok(None)
            }
            // The server was registered for and is now gone: answer nothing
            // rather than let the editor wait for a reply that is never
            // coming.
            Some(None) => {
                let empty = crate::proxy::nothing(request.id);
                self.connection.sender.send(Message::Response(empty))?;
                Ok(None)
            }
            None => Ok(Some(request)),
        }
    }

    /// A reply from the editor: to poly's own registration, or to a request a
    /// downstream server made through poly.
    fn on_client_response(&mut self, response: Response) {
        if crate::proxy::is_poly_id(&response.id) {
            if let Some(error) = &response.error {
                eprintln!(
                    "[poly] the editor rejected a registration: {}",
                    error.message
                );
            }
            return;
        }
        let Some((name, id)) = crate::proxy::untag(&response.id) else {
            return; // not ours and not theirs; nothing to do with it
        };
        if let Some(Some(server)) = self.downstream.get_mut(&name) {
            let restored = Response { id, ..response };
            if let Err(e) = server.send(Message::Response(restored)) {
                eprintln!("[poly] {name}: {e:#}");
            }
        }
    }

    /// Start the server that answers for `language`, if there is one and it is
    /// wanted.
    ///
    /// Called on didOpen, and keyed by server: opening a .cpp after a .c finds
    /// the clangd that is already running rather than starting a second one.
    /// Failure is recorded as "this server is absent" so a missing gopls costs
    /// one message rather than one spawn attempt per keystroke — and it is a
    /// message, because a silently absent feature is the failure this project
    /// keeps refusing to ship.
    fn ensure_downstream(&mut self, language: &str, uri: &Url) {
        let Some(name) = server_for(language) else {
            return;
        };
        if !self.language_servers || self.downstream.contains_key(name) {
            return;
        }
        let languages = languages_for(name);
        // The document's own config, so a `[tools]` entry disabling or
        // relocating a registry-resolved server is honoured the same way it is
        // for the formatter (R5/A4).
        let config = poly_core::Config::discover(&uri_path(uri))
            .unwrap_or_else(|_| poly_core::Config::empty());
        let Some(command) = server_command(name, &config) else {
            eprintln!(
                "[poly] {name} is unavailable — no language features for {}",
                languages.join(", ")
            );
            self.downstream.insert(name.to_string(), None);
            return;
        };
        let sender = self.connection.sender.clone();
        let diagnostics = Arc::clone(&self.diagnostics);
        let code_action_ids = Arc::clone(&self.code_action_ids);
        let started = Instant::now();
        let server = crate::proxy::Downstream::start(
            name,
            &languages,
            &command,
            args_for(LAUNCH, name),
            self.language_server_logs,
            &self.init_params,
            Box::new(move |message| {
                // Two things cannot just be passed along. A publishDiagnostics
                // replaces the whole set for the uri, so forwarding it verbatim
                // erases poly's own findings; a code action list may carry the
                // on-save kinds poly promised the editor it does not offer.
                let message = merge_publish(&diagnostics, message);
                let _ = sender.send(strip_source_actions(&code_action_ids, message));
            }),
        );
        match server {
            Ok(server) => {
                eprintln!(
                    "[poly] {name} ready in {:.0}ms",
                    started.elapsed().as_secs_f64() * 1000.0
                );
                self.register_downstream(&server);
                self.downstream.insert(name.to_string(), Some(server));
            }
            // Every error out of `start` already names the server, so this
            // does not repeat it.
            Err(e) => {
                eprintln!("[poly] {e:#}");
                self.downstream.insert(name.to_string(), None);
            }
        }
    }

    /// Tell the editor which features this server answers for, scoped to its
    /// languages. Nothing was declared at initialize, so until this lands the
    /// editor offers none of them.
    fn register_downstream(&mut self, server: &crate::proxy::Downstream) {
        let registrations =
            crate::proxy::registrations(&server.capabilities, &server.name, &server.languages);
        if registrations.is_empty() {
            eprintln!("[poly] {} declared nothing poly proxies", server.name);
            return;
        }
        let request = lsp_server::Request {
            id: lsp_server::RequestId::from(format!("poly:register:{}", server.name)),
            method: "client/registerCapability".to_string(),
            params: serde_json::json!({ "registrations": registrations }),
        };
        let _ = self.connection.sender.send(Message::Request(request));
    }

    /// The language poly detects for a document, by the same rules the CLI
    /// uses (R5/A4).
    fn language_of(&self, uri: &Url) -> Option<String> {
        let path = uri_path(uri);
        poly_core::Config::discover(&path)
            .unwrap_or_else(|_| poly_core::Config::empty())
            .language(&path)
    }

    /// The server poly would route this document to, running or not.
    fn server_of(&self, uri: &Url) -> Option<&'static str> {
        self.language_of(uri).as_deref().and_then(server_for)
    }

    fn stop_downstream(&mut self) {
        for server in self.downstream.values_mut().flatten() {
            server.stop();
        }
    }

    fn on_formatting(&mut self, request: lsp_server::Request) -> Response {
        let params: DocumentFormattingParams = match serde_json::from_value(request.params) {
            Ok(params) => params,
            Err(e) => return Response::new_err(request.id, INTERNAL_ERROR, e.to_string()),
        };
        self.format_response(request.id, params.text_document.uri, None)
    }

    fn on_range_formatting(&mut self, request: lsp_server::Request) -> Response {
        let params: DocumentRangeFormattingParams = match serde_json::from_value(request.params) {
            Ok(params) => params,
            Err(e) => return Response::new_err(request.id, INTERNAL_ERROR, e.to_string()),
        };
        self.format_response(request.id, params.text_document.uri, Some(params.range))
    }

    /// Format a document, answering with the edits the editor asked for.
    ///
    /// `Some(range)` is Format Selection. poly still formats the *whole*
    /// document and then keeps only the changes that land inside the selection,
    /// rather than formatting the selected text on its own. Two reasons, and
    /// the second is the one that settles it: a selection is rarely a parsable
    /// unit -- half a function, one arm of a match, three lines of a table --
    /// and a fragment formatter that did parse it could still reach a different
    /// answer than `poly fmt` does for the same lines, which is exactly the
    /// editor/CI split A4 exists to prevent.
    fn format_response(
        &mut self,
        id: lsp_server::RequestId,
        uri: Url,
        range: Option<Range>,
    ) -> Response {
        let Some(text) = self.documents.get(&uri).cloned() else {
            // Nothing opened for this uri: no edits rather than an error, so a
            // race with didClose degrades to a no-op save.
            return Response::new_ok(id, serde_json::json!([]));
        };
        match formatted_text(&uri, &text) {
            Ok(formatted) => {
                if self.lock().format.remove(&uri).is_some() {
                    let _ = self.publish_all(&uri);
                }
                let edits = match (formatted, range) {
                    (Some(new_text), Some(range)) => edits_within(&text, &new_text, range),
                    (Some(new_text), None) => vec![TextEdit {
                        range: full_range(&text),
                        new_text,
                    }],
                    // Already formatted, or a language poly does not format.
                    (None, _) => vec![],
                };
                Response::new_ok(id, serde_json::json!(edits))
            }
            // A parse failure is the file's problem, not the request's. As an
            // LSP error it became a toast that named no line and could not be
            // clicked; as a diagnostic it lands in Problems with a squiggle
            // where the parser stopped, which is what every other linter does.
            Err(error) => {
                self.lock()
                    .format
                    .insert(uri.clone(), format_diagnostic(&error.to_string(), &text));
                let _ = self.publish_all(&uri);
                Response::new_ok(id, serde_json::json!([]))
            }
        }
    }

    /// Rule documentation for the finding under the cursor.
    ///
    /// Anchored to a published diagnostic rather than to the text: poly has no
    /// model of what is under the cursor, and the one thing it does know is
    /// what it already flagged there. Everywhere else — every other tool, and
    /// sqruff on a line with no finding — this answers nothing and the
    /// editor's other hover providers are unaffected.
    fn on_hover(&mut self, request: lsp_server::Request) -> Response {
        let params: HoverParams = match serde_json::from_value(request.params) {
            Ok(params) => params,
            Err(e) => return Response::new_err(request.id, INTERNAL_ERROR, e.to_string()),
        };
        let at = params.text_document_position_params;
        let hover = self
            .lock()
            .lint
            .get(&at.text_document.uri)
            .and_then(|diagnostics| rule_hover(diagnostics, at.position));
        Response::new_ok(request.id, serde_json::json!(hover))
    }

    fn on_execute_command(&mut self, request: lsp_server::Request) -> Response {
        let params: ExecuteCommandParams = match serde_json::from_value(request.params) {
            Ok(params) => params,
            Err(e) => return Response::new_err(request.id, INTERNAL_ERROR, e.to_string()),
        };
        match params.command.as_str() {
            FORMAT_PATHS => match run_format_paths(params.arguments.first()) {
                Ok(summary) => Response::new_ok(request.id, summary),
                Err(e) => Response::new_err(request.id, INTERNAL_ERROR, format!("{e:#}")),
            },
            MINIFY_JSON => self.run_minify(request.id, params.arguments.first()),
            EDITOR_CONFIG => match editor_config(params.arguments.first()) {
                Ok(settings) => Response::new_ok(request.id, settings),
                Err(e) => Response::new_err(request.id, INTERNAL_ERROR, format!("{e:#}")),
            },
            other => Response::new_err(
                request.id,
                INTERNAL_ERROR,
                format!("unknown command {other:?}"),
            ),
        }
    }

    /// Minify an open document, returning edits for the editor to apply.
    ///
    /// Edits rather than a file write, for two reasons that both come down to
    /// this being an editor command: the buffer may be dirty, and writing to
    /// disk behind it would either lose those changes or fight them; and an
    /// edit leaves undo as one keystroke, which is what a user reaches for
    /// first after seeing a whole file collapse to one line.
    ///
    /// The language comes from poly's own detection rather than the editor's
    /// language id, so the command answers for exactly the files `poly minify`
    /// would (R5/A4) -- including a `.json` the project remapped in poly.toml.
    fn run_minify(
        &mut self,
        id: lsp_server::RequestId,
        argument: Option<&serde_json::Value>,
    ) -> Response {
        let uri = argument
            .and_then(|a| a.get("uri"))
            .and_then(serde_json::Value::as_str)
            .and_then(|u| Url::parse(u).ok());
        let Some(uri) = uri else {
            return Response::new_err(
                id,
                INTERNAL_ERROR,
                format!("{MINIFY_JSON} needs a uri argument"),
            );
        };
        let Some(text) = self.documents.get(&uri).cloned() else {
            return Response::new_err(id, INTERNAL_ERROR, format!("{uri} is not open"));
        };
        let Some(language) = self.language_of(&uri) else {
            return Response::new_ok(id, serde_json::json!([]));
        };
        match poly_engines::minify(&language, &uri_path(&uri), &text) {
            Ok(Some(minified)) => Response::new_ok(
                id,
                serde_json::json!([TextEdit {
                    range: full_range(&text),
                    new_text: minified,
                }]),
            ),
            // Already minified, or a language with nothing to strip: no edits
            // rather than an error, so the command is a quiet no-op.
            Ok(None) => Response::new_ok(id, serde_json::json!([])),
            Err(e) => Response::new_err(id, INTERNAL_ERROR, format!("{e:#}")),
        }
    }

    fn on_notification(&mut self, notification: Notification) -> Result<()> {
        self.sync_downstream(&notification);
        match notification.method.as_str() {
            "textDocument/didOpen" => {
                let params: DidOpenTextDocumentParams =
                    serde_json::from_value(notification.params)?;
                let uri = params.text_document.uri;
                self.documents
                    .insert(uri.clone(), params.text_document.text);
                if self.lint_on_save {
                    self.publish_lint(&uri)?;
                }
            }
            "textDocument/didChange" => {
                let params: DidChangeTextDocumentParams =
                    serde_json::from_value(notification.params)?;
                // FULL sync: the last change carries the entire document.
                if let Some(change) = params.content_changes.into_iter().last() {
                    self.documents.insert(params.text_document.uri, change.text);
                }
            }
            "textDocument/didSave" => {
                let params: DidSaveTextDocumentParams =
                    serde_json::from_value(notification.params)?;
                if self.lint_on_save {
                    self.publish_lint(&params.text_document.uri)?;
                }
            }
            "textDocument/didClose" => {
                let params: DidCloseTextDocumentParams =
                    serde_json::from_value(notification.params)?;
                let uri = params.text_document.uri;
                self.documents.remove(&uri);
                self.lint_hashes.remove(&uri);
                self.lock().forget(&uri);
                // Clear diagnostics so closed files don't linger in Problems.
                self.publish(&uri, Vec::new())?;
            }
            _ => {}
        }
        Ok(())
    }

    /// Mirror a document lifecycle notification to the server that owns the
    /// language, starting it on first sight.
    ///
    /// Without this a downstream server reads the file from disk while the
    /// editor holds unsaved edits, and every answer is quietly one save
    /// behind. `didOpen` is also the only signal poly gets that this session
    /// is going to need the server at all.
    fn sync_downstream(&mut self, notification: &Notification) {
        if !crate::proxy::SYNCED.contains(&notification.method.as_str()) {
            return;
        }
        let Some(uri) = notification
            .params
            .get("textDocument")
            .and_then(|d| d.get("uri"))
            .and_then(serde_json::Value::as_str)
            .and_then(|uri| Url::parse(uri).ok())
        else {
            return;
        };
        let Some(language) = self.language_of(&uri) else {
            return;
        };
        if notification.method == "textDocument/didOpen" {
            self.ensure_downstream(&language, &uri);
        }
        let Some(name) = server_for(&language) else {
            return;
        };
        if let Some(Some(server)) = self.downstream.get_mut(name) {
            if let Err(e) = server.send(Message::Notification(notification.clone())) {
                eprintln!("[poly] {name}: {e:#}");
            }
        }
    }

    fn publish_lint(&mut self, uri: &Url) -> Result<()> {
        let Some(text) = self.documents.get(uri) else {
            return Ok(());
        };
        let hash = {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            text.hash(&mut hasher);
            hasher.finish()
        };
        if self.lint_hashes.get(uri) == Some(&hash) {
            return Ok(()); // unchanged since last lint
        }
        self.lint_hashes.insert(uri.clone(), hash);
        let path = uri_path(uri);
        let started = Instant::now();
        let diagnostics = lint_document(&path, text);
        eprintln!(
            "[poly] lint {} {:.1}ms ({} issues)",
            path.display(),
            started.elapsed().as_secs_f64() * 1000.0,
            diagnostics.len()
        );
        self.lock().lint.insert(uri.clone(), diagnostics);
        self.publish_all(uri)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Diagnostics> {
        // Poisoned means a thread panicked mid-update. The critical sections
        // here are map reads and inserts, so that cannot happen without a bug
        // worth crashing on.
        self.diagnostics.lock().expect("diagnostics lock")
    }

    /// Publish everything known about a document, from whichever source.
    ///
    /// Every publish poly makes about its own findings goes through here, so
    /// this is the one place that has to know a downstream server may also have
    /// something to say about the same uri. A missing formatter is unaffected:
    /// that path returns without an error and says so on stderr, so nothing is
    /// swallowed by staying quiet in the editor.
    fn publish_all(&mut self, uri: &Url) -> Result<()> {
        let diagnostics = self.lock().merged(uri, self.is_proxied(uri));
        self.publish(uri, diagnostics)
    }

    /// Is a downstream server answering for this document?
    fn is_proxied(&self, uri: &Url) -> bool {
        self.server_of(uri)
            .is_some_and(|name| matches!(self.downstream.get(name), Some(Some(_))))
    }

    fn publish(&mut self, uri: &Url, diagnostics: Vec<lsp_types::Diagnostic>) -> Result<()> {
        let params = PublishDiagnosticsParams {
            uri: uri.clone(),
            diagnostics,
            version: None,
        };
        self.connection
            .sender
            .send(Message::Notification(Notification::new(
                "textDocument/publishDiagnostics".to_string(),
                params,
            )))?;
        Ok(())
    }
}

fn uri_path(uri: &Url) -> PathBuf {
    uri.to_file_path()
        .unwrap_or_else(|_| PathBuf::from(uri.path()))
}

/// Underline from the reported position to the end of that line.
///
/// A zero-width range draws no squiggle at all, and the parsers only report
/// where they stopped, not how much is wrong — the rest of the line is the
/// honest extent. Columns convert to UTF-16, which is what LSP positions are
/// counted in, so CJK before the error does not shift the underline.
fn error_range(text: &str, line: u32, col: u32) -> Range {
    let line0 = line.saturating_sub(1);
    let source = text.lines().nth(line0 as usize).unwrap_or_default();
    let utf16_col = |chars: usize| -> u32 {
        source
            .chars()
            .take(chars)
            .map(|c| c.len_utf16() as u32)
            .sum()
    };
    let start = utf16_col(col.saturating_sub(1) as usize);
    let end = utf16_col(source.chars().count()).max(start + 1);
    Range {
        start: Position::new(line0, start),
        end: Position::new(line0, end),
    }
}

fn format_diagnostic(message: &str, text: &str) -> lsp_types::Diagnostic {
    // Unplaceable errors (a missing tool, an option the engine rejects) still
    // belong in Problems; line 1 is where the file starts and the message says
    // the rest.
    let (line, col) = poly_core::diag::parse_position(message).unwrap_or((1, 1));
    lsp_types::Diagnostic {
        range: error_range(text, line, col),
        severity: Some(lsp_types::DiagnosticSeverity::ERROR),
        code: Some(lsp_types::NumberOrString::String("format".to_string())),
        source: Some("poly".to_string()),
        message: message.to_string(),
        ..Default::default()
    }
}

/// The document as poly would write it, or `None` if there is nothing to write
/// — already formatted, or a file poly does not format at all.
fn formatted_text(uri: &Url, text: &str) -> Result<Option<String>> {
    let path = uri_path(uri);
    // Rediscover per call: an upward stat chain is cheap (<1ms) and picks up
    // poly.toml edits without a watcher.
    let config = poly_core::Config::discover(&path).unwrap_or_else(|_| poly_core::Config::empty());
    let Some(lang) = config.language(&path) else {
        return Ok(None);
    };
    if !crate::fmt::formattable(&lang) {
        return Ok(None);
    }
    crate::fmt::format_text(&lang, &path, text, &config)
}

/// The parts of a whole-document reformat that fall inside `range`.
///
/// A line diff, because a selection is a span of lines: each hunk the formatter
/// produced becomes its own edit, and the hunks the selection does not touch
/// are dropped. That is the point — the rest of the file comes back as the user
/// left it, even where poly would have rewritten it.
///
/// A hunk the selection only partly covers is returned whole, and deliberately.
/// A hunk is a run of lines with no unchanged line inside it, which is exactly
/// the statement that the diff found no way to line its two halves up: there is
/// no "first three lines of the change" to return. Cutting one at the selection
/// boundary would mean inventing an alignment and emitting text neither the
/// user nor `poly fmt` would ever write. Overshooting the selection is visible
/// and one undo away; wrong text is neither.
fn edits_within(text: &str, formatted: &str, range: Range) -> Vec<TextEdit> {
    let old = lines(text);
    let new = lines(formatted);
    let first = range.start.line as usize;
    // Selecting whole lines by dragging down the gutter ends the range at
    // column 0 of the line *after* the last highlighted one. That line is not
    // selected, and reformatting it would be one line more than the user asked
    // for every single time.
    let last = if range.end.character == 0 && range.end.line > range.start.line {
        range.end.line.saturating_sub(1)
    } else {
        range.end.line
    } as usize;

    similar::capture_diff_slices(similar::Algorithm::Myers, &old, &new)
        .into_iter()
        .filter(|op| op.tag() != similar::DiffTag::Equal)
        .filter_map(|op| {
            let span = op.old_range();
            // A pure insertion replaces no lines, so it has no extent of its own
            // to compare against the selection; it belongs to the line it goes
            // in front of.
            let extent = span.end.max(span.start + 1);
            (span.start <= last && extent > first).then(|| TextEdit {
                range: Range {
                    start: line_start(&old, span.start),
                    end: line_start(&old, span.end),
                },
                new_text: new[op.new_range()].concat(),
            })
        })
        .collect()
}

/// Split on newlines, keeping the terminators, so the pieces concatenate back
/// into the text they came from.
fn lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(end) = rest.find('\n') {
        out.push(&rest[..=end]);
        rest = &rest[end + 1..];
    }
    if !rest.is_empty() {
        out.push(rest);
    }
    out
}

/// The LSP position at the start of line `i`, or the end of the document when
/// there is no such line.
///
/// `lines` counts pieces of text, and a file ending in a newline has one more
/// line than it has pieces — the empty one after the last terminator. A file
/// that does not end in one has no line past its last, so an edit reaching
/// there ends at the end of that line instead; a position on a line the editor
/// does not have is an error, not a clamp it fixes up.
fn line_start(lines: &[&str], i: usize) -> Position {
    if i < lines.len() {
        return Position::new(i as u32, 0);
    }
    match lines.last() {
        Some(last) if last.ends_with('\n') => Position::new(lines.len() as u32, 0),
        Some(last) => Position::new((lines.len() - 1) as u32, last.encode_utf16().count() as u32),
        None => Position::new(0, 0),
    }
}

/// Tool resolution memoized for the daemon's lifetime: resolution can hit
/// the network (managed download), which must not run on every save.
fn resolved_tool(name: &str, config: &poly_core::Config) -> Option<PathBuf> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    static CACHE: Mutex<Option<HashMap<String, Option<PathBuf>>>> = Mutex::new(None);
    let mut cache = CACHE.lock().expect("tool cache lock");
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some(hit) = cache.get(name) {
        return hit.clone();
    }
    let resolved = poly_tools::resolve(name, config, false);
    let path = resolved.command().map(Path::to_path_buf);
    if path.is_none() {
        eprintln!("[poly] lint tool {name}: unavailable ({resolved:?})");
    }
    cache.insert(name.to_string(), path.clone());
    path
}

fn is_workflow_file(path: &Path) -> bool {
    path.to_str()
        .map(|s| s.replace('\\', "/"))
        .is_some_and(|s| s.contains(".github/workflows/"))
}

fn external_lint(
    lang: &str,
    path: &Path,
    text: &str,
    config: &poly_core::Config,
) -> anyhow::Result<Vec<poly_core::diag::Issue>> {
    let mut issues = Vec::new();

    // typos has no language of its own: `poly check` runs it repo-wide over
    // the walk roots, which is why a misspelling could fail CI while the
    // editor never mentioned it -- the last editor/CI split A4 forbids.
    //
    // Handed the path rather than the buffer, even though typos does read
    // stdin: on stdin the document is called `-`, so the per-extension config
    // (`[type.*]`, keyed off the file name) does not apply and the editor
    // would answer differently from CI for exactly the repos that configure
    // it. Reading from disk is what didOpen and didSave already guarantee is
    // current, the same trade biome makes above.
    if let Some(cmd) = resolved_tool("typos", config) {
        issues.extend(
            poly_tools::run::typos_paths(
                &cmd,
                &[path.to_path_buf()],
                &config.lint_exclude,
                config.root.as_deref(),
            )?
            .into_iter()
            .map(|f| f.issue),
        );
    }

    // biome and eslint are project-local only and never managed, so they
    // resolve through the same detection `poly check` uses rather than the
    // tool registry.
    if poly_tools::project::BIOME_LANGUAGES.contains(&lang) {
        if let Some(bin) = crate::fmt::cached_project_tool("biome", path) {
            // biome cannot lint stdin, so this reads the file from disk —
            // correct for didOpen/didSave, which is when we lint.
            let root = poly_tools::project::root_of(&bin).unwrap_or(Path::new("."));
            issues.extend(
                poly_tools::run::biome_files(&bin, root, &[path.to_path_buf()])?
                    .into_iter()
                    .map(|f| f.issue),
            );
        }
    }
    if lang == "typescript" {
        if let Some(bin) = crate::fmt::cached_project_tool("eslint", path) {
            issues.extend(poly_tools::run::eslint_stdin(&bin, path, text)?);
        }
    }

    // Managed tool for the language, if any. Independent of the above: a
    // project can run both, and their findings do not overlap.
    let name = match lang {
        "shellscript" => "shellcheck",
        "dockerfile" => "hadolint",
        "yaml" if is_workflow_file(path) => "actionlint",
        "python" => "ruff",
        "lua" => "selene",
        "swift" => "swiftlint",
        _ => return Ok(issues),
    };
    let Some(cmd) = resolved_tool(name, config) else {
        return Ok(issues);
    };
    issues.extend(match name {
        "shellcheck" => poly_tools::run::shellcheck_stdin(&cmd, text)?,
        "hadolint" => poly_tools::run::hadolint_stdin(&cmd, text)?,
        // The editor has to see the same SC findings CI does, which means
        // handing actionlint the shellcheck poly resolves rather than hoping
        // one is on PATH.
        "actionlint" => poly_tools::run::actionlint_stdin(
            &cmd,
            text,
            resolved_tool("shellcheck", config).as_deref(),
        )?,
        "ruff" => poly_tools::run::ruff_stdin(&cmd, path, text)?,
        "selene" => poly_tools::run::selene_stdin(&cmd, path, text)?,
        "swiftlint" => poly_tools::run::swiftlint_stdin(&cmd, path, text)?,
        _ => unreachable!(),
    });
    Ok(issues)
}

/// Record a downstream server's diagnostics and hand back what to send instead.
///
/// Anything that is not a `publishDiagnostics` travels on untouched. So does a
/// `publishDiagnostics` whose params will not parse: passing the server's own
/// notification through is no worse than what poly did before, and dropping it
/// would lose the only report of a real problem.
///
/// The document is proxied by definition — a server only publishes about files
/// it was given — so the formatter's parse failure stays suppressed here for
/// the same reason `merged` suppresses it.
fn merge_publish(store: &Mutex<Diagnostics>, message: Message) -> Message {
    let Message::Notification(notification) = &message else {
        return message;
    };
    if notification.method != "textDocument/publishDiagnostics" {
        return message;
    }
    let Ok(params) =
        serde_json::from_value::<PublishDiagnosticsParams>(notification.params.clone())
    else {
        return message;
    };
    let mut store = store.lock().expect("diagnostics lock");
    store
        .downstream
        .insert(params.uri.clone(), params.diagnostics);
    let merged = PublishDiagnosticsParams {
        diagnostics: store.merged(&params.uri, true),
        uri: params.uri,
        version: params.version,
    };
    drop(store);
    Message::Notification(Notification::new(
        "textDocument/publishDiagnostics".to_string(),
        merged,
    ))
}

/// Take the on-save kinds out of a code action list on its way to the editor.
///
/// Here rather than in the main loop because a downstream response never gets
/// there: the pump thread is the only place it exists. A response carries an id
/// and no method, so `pending` — filled by `route` as each request goes out —
/// is what says which one this is.
fn strip_source_actions(
    pending: &Mutex<HashSet<lsp_server::RequestId>>,
    message: Message,
) -> Message {
    let Message::Response(mut response) = message else {
        return message;
    };
    if !pending
        .lock()
        .expect("code action lock")
        .remove(&response.id)
    {
        return Message::Response(response);
    }
    response.result = response.result.map(crate::proxy::without_source_actions);
    Message::Response(response)
}

fn lint_document(path: &Path, text: &str) -> Vec<lsp_types::Diagnostic> {
    let config = poly_core::Config::discover(path).unwrap_or_else(|_| poly_core::Config::empty());
    // A file `[lint] exclude` drops has to come back clean here too, or
    // Problems shows findings no `poly check` run will ever produce. Naming a
    // file on the command line still beats the exclude (batch::resolve_targets
    // keeps that), but opening one in an editor is the walk's case, not that
    // one -- nobody asked for this file specifically, it just happens to be
    // on screen.
    if config.excluded(path, poly_core::Scope::Lint) {
        return Vec::new();
    }
    let Some(lang) = config.language(path) else {
        return Vec::new();
    };
    let mut issues = match poly_engines::lint::lint(&lang, path, text) {
        Ok(issues) => issues,
        Err(e) => {
            eprintln!("[poly] lint error {}: {e:#}", path.display());
            Vec::new()
        }
    };
    match external_lint(&lang, path, text, &config) {
        Ok(more) => issues.extend(more),
        Err(e) => eprintln!("[poly] external lint error {}: {e:#}", path.display()),
    }
    // Same call `poly check` makes, so a rule silenced in poly.toml is silent
    // in Problems too. A suppression only one side honors is the editor/CI
    // split A4 exists to prevent.
    issues.retain(|i| !config.lint_ignored(path, i.source, &i.code));
    issues.into_iter().map(lint_diagnostic).collect()
}

/// The editor's copy of a `poly check` record.
///
/// The remedy is folded into the message because LSP has no field for it and a
/// fix the terminal names but Problems does not is exactly the editor/CI split
/// A4 forbids. Wording comes from `Fix::describe`, the same call the CLI makes,
/// so the two cannot drift apart. The docs link becomes `codeDescription`,
/// which VSCode renders as the rule code turned into a hyperlink.
fn lint_diagnostic(i: poly_core::diag::Issue) -> lsp_types::Diagnostic {
    let message = match &i.fix {
        Some(fix) => format!("{}\n\nfix: {}", i.message, fix.describe(i.source)),
        None => i.message,
    };
    lsp_types::Diagnostic {
        range: Range {
            start: Position::new(i.line, i.col),
            end: Position::new(i.end_line, i.end_col),
        },
        severity: Some(match i.severity {
            poly_core::diag::Severity::Error => lsp_types::DiagnosticSeverity::ERROR,
            poly_core::diag::Severity::Warning => lsp_types::DiagnosticSeverity::WARNING,
            poly_core::diag::Severity::Info => lsp_types::DiagnosticSeverity::INFORMATION,
            poly_core::diag::Severity::Hint => lsp_types::DiagnosticSeverity::HINT,
        }),
        code: Some(lsp_types::NumberOrString::String(i.code)),
        code_description: i
            .url
            .as_deref()
            .and_then(|url| Url::parse(url).ok())
            .map(|href| lsp_types::CodeDescription { href }),
        source: Some(i.source.to_string()),
        message,
        ..Default::default()
    }
}

/// The first diagnostic covering `position` whose rule poly can document.
///
/// Overlapping findings are possible and only one hover can be returned; the
/// first in publication order is the same one Problems lists first, so the
/// hover and the panel agree about which finding is being explained.
fn rule_hover(diagnostics: &[lsp_types::Diagnostic], position: Position) -> Option<Hover> {
    diagnostics.iter().find_map(|d| {
        if !covers(d.range, position) {
            return None;
        }
        let source = d.source.as_deref()?;
        let lsp_types::NumberOrString::String(code) = d.code.as_ref()? else {
            return None;
        };
        let doc = poly_engines::lint::rule_doc(source, code)?;
        Some(Hover {
            // The heading names the rule because VSCode stacks this under the
            // diagnostic's own hover: without it, two blocks of prose about
            // the same squiggle read as one, and with several diagnostics on
            // the line it is the only thing saying which one this explains.
            contents: HoverContents::Markup(MarkupContent {
                kind: MarkupKind::Markdown,
                value: format!("**{source}/{code}**\n\n{doc}"),
            }),
            range: Some(d.range),
        })
    })
}

/// Is `position` inside `range`? Inclusive of both ends: the cursor sits
/// *between* characters, so a hover at the last column of a squiggle is still
/// a hover over it.
fn covers(range: Range, position: Position) -> bool {
    let after_start =
        (position.line, position.character) >= (range.start.line, range.start.character);
    let before_end = (position.line, position.character) <= (range.end.line, range.end.character);
    after_start && before_end
}

/// `poly.editorConfig` argument: `{"uri": "file:///..."}`.
///
/// What `.editorconfig` asks the editor to do about this file, so the extension
/// can apply it without parsing the file itself. The whole point is that this
/// resolves through the same ec4rs call and the same file chain `poly fmt`
/// obeys: a resolver on the TypeScript side would be a second answer to the
/// same question, and the two would part company on exactly the projects with
/// enough config to need one.
///
/// Answers for any path, open or not and in any language — the files this
/// matters most for are the ones poly does not format, which are also the ones
/// it never sees.
///
/// `formatted` is that distinction, handed over rather than guessed at: poly's
/// formatters already trim trailing whitespace and terminate the file, so the
/// editor must not do it a second time for a document poly is about to rewrite.
fn editor_config(argument: Option<&serde_json::Value>) -> Result<serde_json::Value> {
    let uri = argument
        .and_then(|a| a.get("uri"))
        .and_then(serde_json::Value::as_str)
        .and_then(|u| Url::parse(u).ok())
        .ok_or_else(|| anyhow::anyhow!("{EDITOR_CONFIG} needs a uri argument"))?;
    let path = uri_path(&uri);
    let settings = poly_core::editorconfig_editor_settings(&path);
    let config = poly_core::Config::discover(&path).unwrap_or_else(|_| poly_core::Config::empty());
    let formatted = config
        .language(&path)
        .is_some_and(|lang| crate::fmt::formattable(&lang));
    Ok(serde_json::json!({
        "insertSpaces": settings.insert_spaces,
        "tabSize": settings.tab_size,
        "trimTrailingWhitespace": settings.trim_trailing_whitespace,
        "insertFinalNewline": settings.insert_final_newline,
        "endOfLine": settings.end_of_line,
        "formatted": formatted,
    }))
}

/// `poly.formatPaths` argument: `{"mode": "paths"|"gitRepo"|"gitChanged",
/// "paths": [...]}`. Git scopes resolve from the first path.
fn run_format_paths(arg: Option<&serde_json::Value>) -> Result<serde_json::Value> {
    let arg = arg.ok_or_else(|| anyhow::anyhow!("missing argument"))?;
    let mode = arg.get("mode").and_then(|v| v.as_str()).unwrap_or("paths");
    let paths: Vec<PathBuf> = arg
        .get("paths")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default();
    let start = paths
        .first()
        .ok_or_else(|| anyhow::anyhow!("empty paths"))?;
    let targets = match mode {
        "paths" => paths.clone(),
        "gitRepo" => {
            let root = crate::batch::git_root(start)
                .ok_or_else(|| anyhow::anyhow!("no git repository above {}", start.display()))?;
            vec![root]
        }
        "gitChanged" => {
            let root = crate::batch::git_root(start)
                .ok_or_else(|| anyhow::anyhow!("no git repository above {}", start.display()))?;
            let changed = crate::batch::git_changed_files(&root)?;
            if changed.is_empty() {
                return Ok(serde_json::json!({
                    "total": 0, "changed": [], "unchanged": 0, "errors": []
                }));
            }
            changed
        }
        other => anyhow::bail!("unknown mode {other:?}"),
    };
    // No editor-side flags: A4 says the editor and CI must agree on which
    // files exist, and an escape hatch only one of them has breaks that. A
    // project that needs the walk widened says so in poly.toml, which both
    // sides read.
    let summary = crate::batch::format_paths(&targets, false, poly_core::Walk::default())?;
    Ok(serde_json::json!({
        "total": summary.total,
        "changed": summary.changed.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
        "unchanged": summary.unchanged,
        "errors": summary.errors.iter()
            .map(|(p, e)| serde_json::json!({"path": p.display().to_string(), "error": e}))
            .collect::<Vec<_>>(),
    }))
}

fn full_range(text: &str) -> Range {
    let mut line_count: u32 = 0;
    let mut last_line_utf16: u32 = 0;
    for line in text.split('\n') {
        line_count += 1;
        last_line_utf16 = line.encode_utf16().count() as u32;
    }
    Range {
        start: Position::new(0, 0),
        end: Position::new(line_count.saturating_sub(1), last_line_utf16),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagnostic(source: &str) -> lsp_types::Diagnostic {
        lsp_types::Diagnostic {
            source: Some(source.to_string()),
            message: source.to_string(),
            ..Default::default()
        }
    }

    fn sources(diagnostics: &[lsp_types::Diagnostic]) -> Vec<&str> {
        diagnostics
            .iter()
            .map(|d| d.source.as_deref().unwrap_or("?"))
            .collect()
    }

    fn uri() -> Url {
        Url::parse("file:///a.lua").expect("valid uri")
    }

    /// A server command id must never be an id the extension contributes.
    ///
    /// An LSP client registers every command the server advertises as an editor
    /// command of the same name, so a shared id makes that registration throw
    /// and the client never finishes starting -- no formatter, no diagnostics,
    /// and nothing in the UI that says why. Found the expensive way, by a
    /// six-minute extension-host run; this asks the same question in
    /// milliseconds.
    #[test]
    fn no_server_command_collides_with_a_contributed_one() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../extensions/lsp/package.json");
        let text = std::fs::read_to_string(&manifest).expect("the extension manifest");
        let package: serde_json::Value = serde_json::from_str(&text).expect("valid package.json");
        let contributed: Vec<&str> = package["contributes"]["commands"]
            .as_array()
            .expect("contributes.commands")
            .iter()
            .filter_map(|c| c["command"].as_str())
            .collect();
        assert!(!contributed.is_empty(), "no contributed commands parsed");

        for command in EXECUTE_COMMANDS {
            assert!(
                !contributed.contains(command),
                "{command} is both a server command and one the extension registers"
            );
        }
    }

    /// A language poly detects but the editor does not is a file poly formats
    /// from the CLI and never in an editor.
    ///
    /// Some associations are ours to add: `.bats` and `.azcli` are shell that
    /// VSCode's built-in shellscript does not claim, `.mdx` is markdown that
    /// nothing built-in claims. Both extensions have to declare them.
    /// poly-syntax-highlight owns language declarations, but the three
    /// extensions are independent, and someone running only poly-lsp would
    /// otherwise get a plain-text file with no formatter bound to it. Two
    /// manifests saying the same thing is the cost, and this is what stops them
    /// drifting -- an extension added to one and not the other formats or does
    /// not depending on what is installed.
    ///
    /// Keyed off whatever poly-lsp declares rather than a list written here:
    /// the next association to be added is covered without anyone remembering
    /// to widen this test, which is the failure mode a hard-coded list has.
    ///
    /// Only one of the two manifests is edited by hand.
    /// extensions/syntax/package.json is generated from grammars/sources.json,
    /// and CI regenerates it and fails on any diff -- a hand edit there
    /// survives `make gates` and dies in the grammars job.
    #[test]
    fn both_manifests_teach_the_editor_the_same_extensions() {
        let declared = |extension: &str, id: &str| -> Vec<String> {
            let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../../../extensions/{extension}/package.json"));
            let text = std::fs::read_to_string(&manifest).expect("the extension manifest");
            let package: serde_json::Value =
                serde_json::from_str(&text).expect("valid package.json");
            package["contributes"]["languages"]
                .as_array()
                .expect("contributes.languages")
                .iter()
                .filter(|l| l["id"] == id)
                .flat_map(|l| l["extensions"].as_array().cloned().unwrap_or_default())
                .filter_map(|e| e.as_str().map(str::to_string))
                .collect()
        };
        let ids = |extension: &str| -> Vec<String> {
            let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../../../extensions/{extension}/package.json"));
            let text = std::fs::read_to_string(&manifest).expect("the extension manifest");
            let package: serde_json::Value =
                serde_json::from_str(&text).expect("valid package.json");
            package["contributes"]["languages"]
                .as_array()
                .expect("contributes.languages")
                .iter()
                .filter_map(|l| l["id"].as_str().map(str::to_string))
                .collect()
        };

        let declaring = ids("lsp");
        assert!(!declaring.is_empty(), "poly-lsp declares no languages");
        for id in &declaring {
            let lsp = declared("lsp", id);
            assert_eq!(
                lsp,
                declared("syntax", id),
                "{id}: the two manifests have drifted"
            );
            // And what they declare has to be what poly itself detects, or the
            // editor names a language the CLI would not have picked.
            for extension in &lsp {
                let name = format!("a{extension}");
                assert_eq!(
                    poly_core::builtin_language(Path::new(&name)),
                    Some(id.as_str()),
                    "{extension} is declared to the editor but poly does not detect it as {id}"
                );
            }
        }
        // The two that motivated this, so the loop above cannot pass by
        // iterating over nothing.
        assert!(
            declaring.contains(&"shellscript".to_string()),
            "{declaring:?}"
        );
        assert!(declaring.contains(&"markdown".to_string()), "{declaring:?}");
    }

    /// The extension asks for a file it may never have shown poly, so this has
    /// to answer for any path — and it has to say whether poly is the formatter,
    /// because that decides who trims the file on save. Both doing it is not
    /// harmless: a project that turned trimming off for one glob would get it
    /// done anyway by whichever side was not told.
    #[test]
    fn editor_config_answers_for_any_path_and_says_who_formats_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".editorconfig"),
            "root = true\n\
             \n\
             [*]\n\
             indent_style = space\n\
             indent_size = 2\n\
             \n\
             [*.ini]\n\
             trim_trailing_whitespace = false\n",
        )
        .expect("write .editorconfig");
        let ask = |name: &str| {
            let uri = Url::from_file_path(dir.path().join(name)).expect("absolute path");
            editor_config(Some(&serde_json::json!({ "uri": uri.to_string() })))
                .expect("settings for an existing path")
        };

        let ts = ask("a.ts");
        assert_eq!(ts["formatted"], true);
        assert_eq!(ts["tabSize"], 2);
        assert_eq!(ts["insertSpaces"], true);
        // Said nothing, so it stays null: a default here would overwrite the
        // setting the user chose in their own editor.
        assert!(ts["endOfLine"].is_null(), "{ts}");

        // .ini is not a language poly formats, and it is exactly the case this
        // exists for -- nothing else in poly would ever look at this file.
        let ini = ask("a.ini");
        assert_eq!(ini["formatted"], false);
        assert_eq!(ini["trimTrailingWhitespace"], false);
        assert_eq!(ini["tabSize"], 2, "still inherits [*]: {ini}");

        // No uri is the caller's bug. An error, not an empty answer the
        // extension would go on to apply to the document.
        assert!(editor_config(None).is_err());
    }

    /// Turning the proxy on must not cost the user findings it never replaces.
    ///
    /// selene and swiftlint are the two linters that run in the editor for a
    /// proxied language, and no language server looks for what they look for.
    /// Before these were merged, whichever side published last erased the
    /// other, and the setting silently traded lint away for language features.
    #[test]
    fn a_proxied_document_keeps_both_halves() {
        let mut store = Diagnostics::default();
        store.lint.insert(uri(), vec![diagnostic("selene")]);
        store
            .downstream
            .insert(uri(), vec![diagnostic("Lua Diagnostics.")]);

        assert_eq!(
            sources(&store.merged(&uri(), true)),
            ["selene", "Lua Diagnostics."]
        );
    }

    /// The formatter's parse failure is the one thing a server does replace,
    /// with a range covering the problem rather than the point rustfmt gave up.
    #[test]
    fn a_proxied_document_drops_only_the_format_error() {
        let mut store = Diagnostics::default();
        store.lint.insert(uri(), vec![diagnostic("selene")]);
        store.format.insert(uri(), diagnostic("poly/format"));

        assert_eq!(
            sources(&store.merged(&uri(), false)),
            ["selene", "poly/format"]
        );
        assert_eq!(sources(&store.merged(&uri(), true)), ["selene"]);
    }

    /// The downstream half arrives as a notification poly has to rewrite in
    /// flight; everything else it forwards has to come out unchanged.
    #[test]
    fn merge_publish_rewrites_only_diagnostics() {
        let store = Mutex::new(Diagnostics::default());
        store
            .lock()
            .expect("lock")
            .lint
            .insert(uri(), vec![diagnostic("selene")]);

        let incoming = Message::Notification(Notification::new(
            "textDocument/publishDiagnostics".to_string(),
            PublishDiagnosticsParams {
                uri: uri(),
                diagnostics: vec![diagnostic("Lua Diagnostics.")],
                version: None,
            },
        ));
        let Message::Notification(out) = merge_publish(&store, incoming) else {
            panic!("still a notification");
        };
        let params: PublishDiagnosticsParams =
            serde_json::from_value(out.params).expect("params survive the rewrite");
        assert_eq!(sources(&params.diagnostics), ["selene", "Lua Diagnostics."]);
        // Recorded, not just forwarded: poly's next publish has to include the
        // server's half too, or saving the file would erase it again.
        assert_eq!(
            sources(&store.lock().expect("lock").merged(&uri(), true)),
            ["selene", "Lua Diagnostics."]
        );

        let other = Message::Notification(Notification::new(
            "window/logMessage".to_string(),
            serde_json::json!({"type": 3, "message": "hi"}),
        ));
        let Message::Notification(out) = merge_publish(&store, other) else {
            panic!("untouched");
        };
        assert_eq!(out.method, "window/logMessage");
    }

    /// A publishDiagnostics poly cannot parse still has to reach the editor:
    /// the server is reporting a real problem either way, and dropping it would
    /// make poly the reason a diagnostic vanished.
    #[test]
    fn merge_publish_passes_unparsable_diagnostics_through() {
        let store = Mutex::new(Diagnostics::default());
        let incoming = Message::Notification(Notification::new(
            "textDocument/publishDiagnostics".to_string(),
            serde_json::json!({"uri": "not a uri"}),
        ));
        let Message::Notification(out) = merge_publish(&store, incoming) else {
            panic!("still a notification");
        };
        assert_eq!(out.params, serde_json::json!({"uri": "not a uri"}));
    }

    /// The pump thread sees responses to everything, so it has to filter the
    /// code action lists and leave every other reply alone — a hover result
    /// rewritten as if it were an action list is a far worse bug than the one
    /// this is preventing.
    #[test]
    fn only_a_code_action_reply_is_filtered() {
        let pending = Mutex::new(HashSet::from([lsp_server::RequestId::from(7)]));
        let list = serde_json::json!([
            {"title": "Organize Imports", "kind": "source.organizeImports"},
            {"title": "Extract", "kind": "refactor.extract"},
        ]);
        let reply = |id: i32| {
            Message::Response(Response {
                id: lsp_server::RequestId::from(id),
                result: Some(list.clone()),
                error: None,
            })
        };

        let Message::Response(filtered) = strip_source_actions(&pending, reply(7)) else {
            panic!("still a response");
        };
        assert_eq!(
            filtered.result.unwrap(),
            serde_json::json!([{"title": "Extract", "kind": "refactor.extract"}])
        );

        // Same payload, an id poly never recorded: not a code action list, so
        // it travels untouched.
        let Message::Response(passed) = strip_source_actions(&pending, reply(8)) else {
            panic!("still a response");
        };
        assert_eq!(passed.result.unwrap(), list);

        // The id is spent once it is answered, so a later reply reusing the
        // number cannot be mistaken for another action list.
        assert!(pending.lock().unwrap().is_empty());
    }

    /// The routing table is read in both directions and they have to agree.
    ///
    /// `downstream` is keyed by server while requests arrive by language, so a
    /// language whose server does not list it back would spawn a process no
    /// request could ever reach.
    #[test]
    fn every_language_maps_to_a_server_that_claims_it() {
        for (language, name) in LANGUAGE_SERVERS {
            assert_eq!(server_for(language), Some(*name));
            assert!(
                languages_for(name).contains(&language.to_string()),
                "{name} does not answer for {language}"
            );
        }
        // The case this keying exists for: one process, both languages.
        assert_eq!(languages_for("clangd"), ["c", "cpp"]);
        assert_eq!(server_for("c"), server_for("cpp"));
        // A language poly formats but has no server for stays poly's alone.
        assert_eq!(server_for("typescript"), None);
    }

    /// poly passes arguments only where the binary is not itself the server.
    ///
    /// Everything else it might want — quieter logs, in particular — it gets
    /// by changing what it does with the output, not by telling the server how
    /// to behave. terraform-ls has no logging flag at all, which is what
    /// settled that.
    #[test]
    fn only_a_server_that_needs_a_subcommand_gets_arguments() {
        assert_eq!(args_for(LAUNCH, "terraform-ls"), ["serve"]);
        for own_entry_point in [
            "gopls",
            "rust-analyzer",
            "clangd",
            "sourcekit-lsp",
            "lua-language-server",
        ] {
            assert!(
                args_for(LAUNCH, own_entry_point).is_empty(),
                "{own_entry_point}"
            );
        }
    }

    /// Problems has to carry everything the terminal carries, in the same
    /// words: a user who reads one and then the other must not have to work out
    /// that they are the same finding.
    #[test]
    fn a_diagnostic_carries_the_fix_and_the_docs_link() {
        let issue = |fix, url: Option<&str>| poly_core::diag::Issue {
            line: 0,
            col: 7,
            end_line: 0,
            end_col: 9,
            severity: poly_core::diag::Severity::Warning,
            code: "F401".to_string(),
            message: "`os` imported but unused".to_string(),
            source: "ruff",
            fix,
            url: url.map(str::to_string),
        };

        let full = lint_diagnostic(issue(
            Some(poly_core::diag::Fix::Described {
                what: "Remove unused import: `os`".to_string(),
                safe: false,
            }),
            Some("https://docs.astral.sh/ruff/rules/unused-import"),
        ));
        // Pinned literally, not via Fix::describe: the point is the vocabulary
        // itself, which a test calling the same function could not catch
        // changing.
        assert_eq!(
            full.message,
            "`os` imported but unused\n\nfix: Remove unused import: `os` (unsafe: review it)"
        );
        assert_eq!(
            full.code_description.map(|d| d.href.to_string()),
            Some("https://docs.astral.sh/ruff/rules/unused-import".to_string())
        );

        // Nothing supplied, nothing appended — an empty "fix:" line would read
        // as poly having no idea rather than the tool having said nothing.
        let bare = lint_diagnostic(issue(None, None));
        assert_eq!(bare.message, "`os` imported but unused");
        assert!(bare.code_description.is_none());
    }

    /// sqruff's rule prose is compiled into this binary and has nowhere else to
    /// go: no documentation site means no `code_description` link, so without
    /// the hover the reader is told what is wrong and never why.
    #[test]
    fn hover_explains_the_finding_under_the_cursor() {
        let text = "select a,b from t\nWHERE x = 1;\n";
        let diagnostics = lint_document(Path::new("/nonexistent/a.sql"), text);
        let flagged = diagnostics.first().expect("a sqruff finding").range;

        let hover = rule_hover(&diagnostics, flagged.start).expect("hover at the squiggle");
        let HoverContents::Markup(markup) = hover.contents else {
            panic!("expected markdown");
        };
        assert_eq!(markup.kind, MarkupKind::Markdown);
        assert!(markup.value.starts_with("**sqruff/"), "{}", markup.value);
        // The tool's own words, not a paraphrase: the section headings are
        // sqruff's, and losing them means the hover stopped being its docs.
        assert!(markup.value.contains("Best practice"), "{}", markup.value);
        // Highlighting the finding, not the word: the range is the squiggle's.
        assert_eq!(hover.range, Some(flagged));

        // Off the finding, poly has nothing to say and must not shadow whatever
        // else the editor would have shown there.
        assert!(rule_hover(&diagnostics, Position::new(500, 0)).is_none());

        // A tool that documents itself on the web is already served by the link
        // on its code; a second copy here could only be the staler one.
        let ruff = lint_diagnostic(poly_core::diag::Issue {
            line: 0,
            col: 0,
            end_line: 0,
            end_col: 3,
            severity: poly_core::diag::Severity::Warning,
            code: "F401".to_string(),
            message: "unused".to_string(),
            source: "ruff",
            fix: None,
            url: None,
        });
        assert!(rule_hover(&[ruff], Position::new(0, 1)).is_none());
    }

    /// Apply edits the way an editor would, so a test can assert about the file
    /// the user ends up with rather than about a list of ranges.
    ///
    /// Back to front, because every offset is measured against the original
    /// text. Columns are byte offsets here, not UTF-16: the fixtures are ASCII,
    /// and the thing under test is which lines are edited.
    fn apply(text: &str, edits: &[TextEdit]) -> String {
        let offset = |position: Position| -> usize {
            let mut offset = 0;
            for (i, line) in lines(text).iter().enumerate() {
                if i == position.line as usize {
                    return offset + position.character as usize;
                }
                offset += line.len();
            }
            text.len()
        };
        let mut out = text.to_string();
        for edit in edits.iter().rev() {
            out.replace_range(
                offset(edit.range.start)..offset(edit.range.end),
                &edit.new_text,
            );
        }
        out
    }

    fn selection(from: (u32, u32), to: (u32, u32)) -> Range {
        Range {
            start: Position::new(from.0, from.1),
            end: Position::new(to.0, to.1),
        }
    }

    /// Format Selection has to leave the rest of the file alone, including the
    /// parts poly would have rewritten.
    ///
    /// This is the whole difference from Format Document, and it is the reason
    /// the request cannot just return the same whole-file edit: a user who
    /// selects one query in a file of ten is saying they do not want the other
    /// nine touched, and returning them anyway is worse than answering nothing.
    #[test]
    fn a_selection_gets_only_the_changes_inside_it() {
        let old = "a\n  BAD1\nc\n  BAD2\ne\n";
        let new = "a\nGOOD1\nc\nGOOD2\ne\n";

        let edits = edits_within(old, new, selection((3, 0), (3, 6)));
        assert_eq!(edits.len(), 1, "{edits:?}");
        assert_eq!(apply(old, &edits), "a\n  BAD1\nc\nGOOD2\ne\n");

        // Both, when the selection covers both.
        let edits = edits_within(old, new, selection((0, 0), (4, 1)));
        assert_eq!(edits.len(), 2, "{edits:?}");
        assert_eq!(apply(old, &edits), new);

        // Neither, when it covers neither. An empty list, not an error: a
        // selection over already-formatted lines is a no-op, not a failure.
        assert!(edits_within(old, new, selection((2, 0), (2, 1))).is_empty());
    }

    /// Dragging down the gutter selects whole lines and ends the range at column
    /// 0 of the line after the last one highlighted. Treating that line as
    /// selected would reformat one line more than the user asked for, on the
    /// most common way there is to make a selection.
    #[test]
    fn a_whole_line_selection_stops_where_the_highlight_does() {
        let old = "a\n  BAD1\nc\n  BAD2\ne\n";
        let new = "a\nGOOD1\nc\nGOOD2\ne\n";

        // Highlights lines 1 and 2. Line 3 is where the caret is, not where the
        // selection is, and its hunk stays untouched.
        let edits = edits_within(old, new, selection((1, 0), (3, 0)));
        assert_eq!(apply(old, &edits), "a\nGOOD1\nc\n  BAD2\ne\n");

        // A caret with nothing selected is not the same shape: (3,0) to (3,0)
        // is on line 3, so line 3's hunk is the one it asks for.
        let edits = edits_within(old, new, selection((3, 0), (3, 0)));
        assert_eq!(apply(old, &edits), "a\n  BAD1\nc\nGOOD2\ne\n");
    }

    /// A hunk the selection covers only part of comes back whole.
    ///
    /// Not a rounding error — a hunk has no unchanged line inside it, which is
    /// the diff saying it could not line the two halves up, so there is no
    /// "part" of it to return. The alternative to overshooting is either doing
    /// nothing (Format Selection looks broken on exactly the messy block it is
    /// for) or splicing text at a boundary the diff never found, which is how a
    /// formatter produces something no one wrote.
    #[test]
    fn a_hunk_the_selection_straddles_is_applied_whole() {
        let old = "a\n  BAD1\n  BAD2\nd\n";
        let new = "a\nGOOD1\nGOOD2\nd\n";

        let edits = edits_within(old, new, selection((1, 0), (1, 6)));
        assert_eq!(edits.len(), 1, "one hunk, not two: {edits:?}");
        assert_eq!(apply(old, &edits), new);
    }

    /// The two ends of a file are where line arithmetic goes wrong: an
    /// insertion has no lines of its own to match against the selection, and a
    /// file with no trailing newline has no line after its last one for an edit
    /// to end on.
    #[test]
    fn edits_at_the_edges_of_the_file_stay_in_the_document() {
        // An appended line belongs to the end of the file, so a selection that
        // reaches the end gets it and one that does not, does not.
        let edits = edits_within("a\nb\n", "a\nb\nc\n", selection((2, 0), (2, 0)));
        assert_eq!(apply("a\nb\n", &edits), "a\nb\nc\n");
        assert!(edits_within("a\nb\n", "a\nb\nc\n", selection((0, 0), (0, 1))).is_empty());

        // No trailing newline: the edit has to end at the end of the last line,
        // because there is no line 2 for it to end at the start of.
        let edits = edits_within("a\nb", "a\nB", selection((1, 0), (1, 1)));
        assert_eq!(edits[0].range.end, Position::new(1, 1));
        assert_eq!(apply("a\nb", &edits), "a\nB");
    }

    /// `lines` has to be the exact inverse of concatenation, or every edit
    /// `edits_within` builds is off by a newline.
    #[test]
    fn lines_keep_their_terminators() {
        for text in ["a\nb\n", "a\nb", "", "\n", "a"] {
            assert_eq!(lines(text).concat(), text);
        }
        assert_eq!(lines("a\nb\n"), ["a\n", "b\n"]);
        assert_eq!(lines("a\nb"), ["a\n", "b"]);
        assert!(lines("").is_empty());
    }

    #[test]
    fn full_range_covers_document() {
        let range = full_range("ab\ncdé\n");
        assert_eq!(range.start, Position::new(0, 0));
        assert_eq!(range.end, Position::new(2, 0));
        let range = full_range("ab\ncdé");
        assert_eq!(range.end, Position::new(1, 3));
    }

    #[test]
    fn lint_document_maps_sql_issues() {
        let diagnostics = lint_document(Path::new("/nonexistent/a.sql"), "select a,b from t\n");
        assert!(!diagnostics.is_empty());
        assert_eq!(diagnostics[0].source.as_deref(), Some("sqruff"));
    }

    /// `[lint] exclude` is the setting that decides what CI looks at, so an
    /// excluded file has to be silent in Problems as well. The same text in a
    /// sibling directory still reports, or this would pass just as well with
    /// linting switched off.
    #[test]
    fn an_excluded_file_is_silent_in_the_editor_too() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::write(
            root.join("poly.toml"),
            "[lint]\nexclude = [\"vendor/**\"]\n",
        )
        .expect("write poly.toml");
        let sql = "select a,b from t\n";

        assert!(lint_document(&root.join("vendor/a.sql"), sql).is_empty());
        assert!(!lint_document(&root.join("src/a.sql"), sql).is_empty());
    }

    /// The squiggle's position is scraped out of prose, so the prose is a
    /// contract. If an engine upgrade rewords its parse error, this fails here
    /// rather than silently pinning every future error to line 1.
    #[test]
    fn every_engine_error_can_be_placed() {
        let cases: &[(&str, &str, (u32, u32))] = &[
            ("a.py", "x = 1\ndef f(:\n    pass\n", (2, 7)),
            ("a.yaml", "a: 1\n  b: 2\n", (2, 4)),
            ("a.graphql", "query { a b\n", (2, 1)),
            // markup_fmt names the unclosed <span> before the position it gave
            // up at; pointing at the tag itself is the more useful of the two.
            ("a.html", "<div><span></div>\n", (1, 6)),
            ("a.json", "{\n  \"a\": 1,\n  \"b\": ,\n}\n", (3, 8)),
            ("a.toml", "[table\nkey = \"v\"\n", (1, 7)),
            ("a.ts", "function f(a: number {\n  return a;\n}\n", (1, 22)),
        ];
        for (name, broken, want) in cases {
            let message = poly_engines::format_file(Path::new(name), broken)
                .expect_err(&format!("{name}: expected a parse failure"))
                .to_string();
            assert_eq!(
                poly_core::diag::parse_position(&message),
                Some(*want),
                "{name}: could not place {message:?}"
            );
        }
    }

    #[test]
    fn a_format_error_underlines_the_rest_of_the_line() {
        let text = "a: 1\n  b: 2\n";
        let diagnostic = format_diagnostic("yaml parse error at line 2, column 4", text);
        assert_eq!(diagnostic.range.start, Position::new(1, 3));
        assert_eq!(diagnostic.range.end, Position::new(1, 6), "to end of line");
        assert_eq!(diagnostic.source.as_deref(), Some("poly"));

        // Columns are UTF-16, and only a character outside the BMP tells the
        // two apart: CJK is one unit like any other char, an emoji is two. The
        // engines count characters, so column 3 here is UTF-16 offset 3, not 2.
        let range = error_range("😀x = (\n", 1, 3);
        assert_eq!(range.start, Position::new(0, 3));

        // No position in the message at all still produces a usable squiggle
        // rather than a zero-width range VSCode would not draw.
        let diagnostic = format_diagnostic("shfmt: not installed", "x\n");
        assert_eq!(diagnostic.range.start, Position::new(0, 0));
        assert!(diagnostic.range.end.character > 0);
    }
}

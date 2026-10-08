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
/// no diagnostics, no error anyone can see. Hence `poly.minifyEdits` here
/// against `poly.minify` in package.json: the server hands back edits, the
/// editor command is what applies them.
const FORMAT_PATHS: &str = "poly.formatPaths";
const MINIFY: &str = "poly.minifyEdits";
const EDITOR_CONFIG: &str = "poly.editorConfig";
const FORMAT_TEXT: &str = "poly.formatText";
pub(crate) const EXECUTE_COMMANDS: &[&str] = &[FORMAT_PATHS, MINIFY, EDITOR_CONFIG, FORMAT_TEXT];

pub fn run() -> Result<()> {
    let (connection, io_threads) = Connection::stdio();
    // The connection must be dropped before joining: the writer thread only
    // exits once every sender handle to its channel is gone.
    serve(connection)?;
    io_threads.join()?;
    Ok(())
}

struct Server {
    connection: Connection,
    documents: HashMap<Url, String>,
    /// The language each open document has in the editor, as its didOpen said.
    ///
    /// Navigation only -- see `navigated`. Same keys as `documents` and dropped
    /// with it, which is why `log_memory` does not count it separately.
    language_ids: HashMap<Url, String>,
    lint_on_save: bool,
    /// Whether every document opened and closed writes a line saying what poly
    /// is holding. Off by default: it is a line per file in a log people read
    /// to find out why a lint did not run.
    memory_log: bool,
    /// The editor's own InitializeParams, kept for the workspace folders
    /// `crate::navigate::root_of` searches -- updated as folders come and go.
    init_params: serde_json::Value,
    /// Content hash at last lint per document: external linters cost tens of
    /// ms to seconds, so an unchanged save republishes nothing.
    lint_hashes: HashMap<Url, u64>,
    /// Scopes a whole-package lint has already been asked for. Opening a second
    /// file in a module poly has already looked at costs nothing; golangci-lint
    /// type-checks the package, so the first look is the expensive one and there
    /// is no reason to repeat it until a save. The linter is part of the key
    /// because one directory can be both — a Go module with .tf files in it is
    /// two scopes that happen to share a path.
    package_roots: HashSet<(PackageLinter, PathBuf)>,
    /// Queue for the package-lint worker, created on first use. Most sessions
    /// never open a Go or Terraform file and should not pay for a thread that
    /// would spend them blocked on an empty channel.
    package_jobs: Option<std::sync::mpsc::Sender<PackageJob>>,
    diagnostics: Arc<Mutex<Diagnostics>>,
    /// What poly read from GraphQL and nginx files to answer references with.
    /// See `crate::navigate`.
    navigation: crate::navigate::Index,
}

/// A linter that answers about a whole directory tree rather than a buffer.
///
/// Three of them, and they disagree about what a scope is: golangci-lint reads
/// a Go module and everything under it, clippy reads a cargo workspace and
/// every crate in it, tflint reads one directory and does not descend. That
/// difference is why the findings are keyed by the run that produced them
/// rather than by a path prefix.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum PackageLinter {
    Golangci,
    Clippy,
    Tflint,
}

impl PackageLinter {
    /// The name `[tools]` resolves it under, which is also the name in the log.
    ///
    /// `cargo` and not `clippy`: clippy is a cargo subcommand, so cargo is the
    /// binary poly resolves and the one `[tools] cargo = "off"` turns off.
    fn tool(self) -> &'static str {
        match self {
            Self::Golangci => "golangci-lint",
            Self::Clippy => "cargo",
            Self::Tflint => "tflint",
        }
    }

    /// The same call `poly check` makes over the same scope. Anything cheaper —
    /// one package, one file, a cached subset — would be a second opinion, and
    /// the editor and CI holding two of those is what A4 forbids.
    fn run(self, cmd: &Path, root: &Path) -> Result<Vec<poly_tools::run::FileIssue>> {
        match self {
            Self::Golangci => poly_tools::run::golangci_module(cmd, root),
            Self::Clippy => poly_tools::run::clippy_workspace(cmd, root),
            Self::Tflint => poly_tools::run::tflint_dir(cmd, root),
        }
    }
}

/// One whole-package lint to run.
struct PackageJob {
    linter: PackageLinter,
    root: PathBuf,
}

/// Every source of diagnostics for a document, in one place.
///
/// `publishDiagnostics` replaces the whole set for a uri, so no source can
/// publish on its own — the last one to speak erases the rest. Everything is
/// kept here and every publish sends the union.
///
/// Shared rather than owned by `Server` because the whole-package half arrives
/// on the worker thread, when a linter finishes rather than when the editor
/// asks poly a question.
#[derive(Default)]
struct Diagnostics {
    lint: HashMap<Url, Vec<lsp_types::Diagnostic>>,
    /// Findings from a linter that answers about a whole scope at once, so they
    /// arrive for files nobody opened. Kept apart from `lint` because they are
    /// replaced as a set per run rather than per file: the only way to know a
    /// finding is fixed is that the next run did not repeat it.
    ///
    /// Keyed by the run — the linter and the directory it ran in — because that
    /// is the unit being replaced. Asking "which findings did the last run own"
    /// with a path prefix is wrong as soon as scopes nest, and with tflint they
    /// nest by default: linting `envs/prod` must not erase what the run in
    /// `envs/prod/modules/db` found and is not going to repeat.
    package: HashMap<(PackageLinter, PathBuf), HashMap<Url, Vec<lsp_types::Diagnostic>>>,
    format: HashMap<Url, lsp_types::Diagnostic>,
}

impl Diagnostics {
    /// The whole set for a uri, as the editor should see it.
    ///
    /// The formatter's error is dropped on an unparsable document: see
    /// `says_it_does_not_parse`.
    fn merged(&self, uri: &Url) -> Vec<lsp_types::Diagnostic> {
        let mut all = self.lint.get(uri).cloned().unwrap_or_default();
        all.extend(
            self.package
                .values()
                .filter_map(|found| found.get(uri))
                .flatten()
                .cloned(),
        );
        if !all.iter().any(says_it_does_not_parse) {
            all.extend(self.format.get(uri).cloned());
        }
        all
    }

    fn forget(&mut self, uri: &Url) {
        self.lint.remove(uri);
        for found in self.package.values_mut() {
            found.remove(uri);
        }
        self.format.remove(uri);
    }
}

/// Whether a lint finding is the claim "this file does not parse".
///
/// Five rules make it -- `toml/syntax`, `typescript/syntax`, `graphql/syntax`,
/// `php/syntax` and arity's `syntax-error` -- and when one of them has spoken,
/// the formatter's error on save is the same sentence in the same place. It is
/// the formatter's copy that goes: `toml/syntax` carries a category, a rule
/// doc and a suppression key, and `poly/format` carries none of the three.
/// Measured by hand on one broken file per language: four of the five arrive at
/// the identical line *and* column, and three of those repeat the parser's
/// sentence verbatim.
///
/// The whole format error goes rather than only the ones that carry a position,
/// which was the obvious rule and is wrong: arity reports "input contains 2
/// parser diagnostic(s)" with no position at all, so the obvious rule would
/// have left R -- the one language where the duplicate is *three* findings --
/// exactly as it was.
///
/// What that gives up is a format error of the other kind, one saying the
/// formatter is missing or that it refused an option, on a file that also does
/// not parse. In practice there is almost nothing there to give up: for a rule
/// above to have fired, that language's parser has to have run, and in four of
/// the five it is the formatter's own parser. The fifth is arity, which is R's
/// linter and R's formatter in one binary -- if it were missing there would be
/// no `arity/syntax-error` either. And the message is not lost, only deferred:
/// it comes back the moment the file parses, which is the moment the user could
/// have acted on it.
fn says_it_does_not_parse(found: &lsp_types::Diagnostic) -> bool {
    matches!(
        &found.code,
        Some(lsp_types::NumberOrString::String(code))
            if code == "syntax" || code == "syntax-error"
    )
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
        // For GraphQL and nginx references, which search the workspace folder a
        // document is in. Without it the editor never sends
        // `workspace/didChangeWorkspaceFolders` at all, and a second project
        // added to the window would be searched as if it were not there.
        workspace: Some(lsp_types::WorkspaceServerCapabilities {
            workspace_folders: Some(lsp_types::WorkspaceFoldersServerCapabilities {
                supported: Some(true),
                change_notifications: Some(OneOf::Left(true)),
            }),
            file_operations: None,
        }),
        ..Default::default()
    };
    let init_params = connection.initialize(serde_json::to_value(capabilities)?)?;
    let mut server = Server::new(connection, init_params);
    // Here and not in `Server::new`, which the tests build sessions with: a
    // request sent from there would sit first in every test's editor queue.
    server.register_navigation();
    // The daemon and not every CLI run: the editor is where most people meet
    // poly, and `poly check` on a CI runner has no business writing to $HOME.
    match crate::settings::write_global() {
        Ok(Some(path)) => eprintln!("[poly] wrote {}", path.display()),
        Ok(None) => {}
        Err(e) => eprintln!("[poly] could not write the global poly.toml: {e:#}"),
    }

    // A receive error means the editor closed the pipe: nothing left to serve.
    while let Ok(message) = server.connection.receiver.recv() {
        match message {
            Message::Request(request) => {
                if handle_shutdown(&server.connection, &request)? {
                    break;
                }
                let started = Instant::now();
                let method = request.method.clone();
                let response = match method.as_str() {
                    "textDocument/formatting" => server.on_formatting(request),
                    "textDocument/rangeFormatting" => server.on_range_formatting(request),
                    "textDocument/hover" => server.on_hover(request),
                    // Registered for GraphQL and nginx only, so these reach poly
                    // for those two and for nothing else. See `crate::navigate`.
                    "textDocument/documentSymbol" => server.on_document_symbol(request),
                    "textDocument/references" => server.on_references(request),
                    "workspace/executeCommand" => server.on_execute_command(request),
                    // Dropping it is not a harmless no-op: the editor waits on
                    // that id for the rest of the session, so the feature looks
                    // hung instead of absent.
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
            // The editor's answer to the one thing poly asks it, the
            // navigation registration. Only a refusal is worth a line.
            Message::Response(response) => {
                if let Some(error) = &response.error {
                    eprintln!(
                        "[poly] the editor rejected a registration: {}",
                        error.message
                    );
                }
            }
        }
    }
    Ok(())
}

/// `Connection::handle_shutdown`, without its one rule that does not hold.
///
/// lsp-server takes the message after `shutdown` to be `exit` and fails on
/// anything else. But the editor can still be answering something poly asked
/// before the shutdown -- the answer to a `client/registerCapability` is the
/// one observed -- and that is not a protocol violation. It made the daemon exit 2 in the middle of a
/// restart, and the client does not restart a server that dies while it is
/// being stopped: a toggle of the Lint switch that raced a registration left
/// the window without poly until a reload.
fn handle_shutdown(connection: &Connection, request: &lsp_server::Request) -> Result<bool> {
    if request.method != "shutdown" {
        return Ok(false);
    }
    connection
        .sender
        .send(Response::new_ok(request.id.clone(), ()).into())?;
    // Thirty seconds, as lsp-server waits. An editor that never sends `exit`
    // has gone, and ending is what it would have asked for anyway.
    let deadline = Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match connection
            .receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(Message::Notification(notification)) if notification.method == "exit" => {
                return Ok(true)
            }
            Ok(_) => continue,
            Err(_) => return Ok(true),
        }
    }
}

impl Server {
    /// A session for the editor that sent `init_params`, with nothing open and
    /// nothing started.
    ///
    /// Apart from `serve` so the tests can hold one over an in-memory
    /// connection: what a didOpen records and tells the editor is only visible
    /// from inside a session.
    fn new(connection: Connection, init_params: serde_json::Value) -> Server {
        let option = |name: &str, default: bool| {
            init_params
                .get("initializationOptions")
                .and_then(|o| o.get(name))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(default)
        };
        let lint_on_save = option("lintOnSave", true);
        let memory_log = option("memoryLog", false);

        Server {
            connection,
            documents: HashMap::new(),
            language_ids: HashMap::new(),
            lint_on_save,
            memory_log,
            init_params,
            lint_hashes: HashMap::new(),
            package_roots: HashSet::new(),
            package_jobs: None,
            diagnostics: Arc::new(Mutex::new(Diagnostics::default())),
            navigation: crate::navigate::Index::default(),
        }
    }

    /// The language poly detects for a document, by the same rules the CLI
    /// uses (R5/A4).
    fn language_of(&self, uri: &Url) -> Option<String> {
        let path = uri_path(uri);
        poly_core::Config::discover(&path)
            .unwrap_or_else(|_| poly_core::Config::empty())
            .language(&path)
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
        match formatted_text(&uri_path(&uri), &text) {
            Ok(formatted) => {
                if self.lock().format.remove(&uri).is_some() {
                    let _ = self.publish_all(&uri);
                }
                let edits = match (formatted, range) {
                    (Some(new_text), Some(range)) => edits_within(&text, &new_text, range),
                    (Some(new_text), None) => line_edits(&text, &new_text, |_| true),
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

    /// Ask the editor to send GraphQL and nginx outline and reference requests
    /// here. See `crate::navigate::registrations` for why this is not a
    /// capability declared at initialize.
    fn register_navigation(&self) {
        let request = lsp_server::Request {
            id: lsp_server::RequestId::from("poly:register:navigate".to_string()),
            method: "client/registerCapability".to_string(),
            params: serde_json::json!({ "registrations": crate::navigate::registrations() }),
        };
        let _ = self.connection.sender.send(Message::Request(request));
    }

    /// The language and text of a document poly navigates itself, or `None`
    /// for any other: the buffer when it is open, the file when it is not.
    fn navigated(&self, uri: &Url) -> Option<(String, String)> {
        let path = uri_path(uri);
        let language = self
            .language_ids
            .get(uri)
            .cloned()
            .or_else(|| {
                ["graphql", "nginx"]
                    .into_iter()
                    .find(|l| crate::navigate::is_file_of(l, &path))
                    .map(str::to_string)
            })
            .filter(|language| poly_engines::symbols::applies(language))?;
        let text = match self.documents.get(uri) {
            Some(text) => text.clone(),
            None => std::fs::read_to_string(&path).ok()?,
        };
        Some((language, text))
    }

    fn on_document_symbol(&mut self, request: lsp_server::Request) -> Response {
        let Some(uri) = request_uri(&request.params) else {
            return Response::new_ok(request.id, serde_json::Value::Null);
        };
        match self.navigated(&uri) {
            Some((language, text)) => Response::new_ok(
                request.id,
                crate::navigate::document_symbols(&language, &text),
            ),
            None => Response::new_ok(request.id, serde_json::Value::Null),
        }
    }

    /// Every place the name under the cursor is written, across the workspace
    /// folder the document is in.
    fn on_references(&mut self, request: lsp_server::Request) -> Response {
        let params: lsp_types::ReferenceParams = match serde_json::from_value(request.params) {
            Ok(params) => params,
            Err(e) => return Response::new_err(request.id, INTERNAL_ERROR, e.to_string()),
        };
        let at = params.text_document_position;
        let uri = at.text_document.uri;
        let Some((language, text)) = self.navigated(&uri) else {
            return Response::new_ok(request.id, serde_json::Value::Null);
        };
        // Not on a name: an empty list, which is what the editor shows as
        // "no references" -- null would read as "nobody answered".
        let Some((space, name)) = crate::navigate::mention_at(&language, &text, at.position) else {
            return Response::new_ok(request.id, serde_json::json!([]));
        };
        let root = crate::navigate::root_of(&self.init_params, &uri_path(&uri));
        let open: Vec<(Url, &str)> = self
            .documents
            .iter()
            .filter(|(open, _)| self.language_ids.get(*open) == Some(&language))
            .map(|(open, text)| (open.clone(), text.as_str()))
            .collect();
        let found = self.navigation.references(
            &language,
            &root,
            &open,
            (space, &name),
            params.context.include_declaration,
        );
        Response::new_ok(request.id, serde_json::json!(found))
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
            MINIFY => self.run_minify(request.id, params.arguments.first()),
            EDITOR_CONFIG => match editor_config(params.arguments.first()) {
                Ok(settings) => Response::new_ok(request.id, settings),
                Err(e) => Response::new_err(request.id, INTERNAL_ERROR, format!("{e:#}")),
            },
            FORMAT_TEXT => match format_text_edits(params.arguments.first()) {
                Ok(edits) => Response::new_ok(request.id, serde_json::json!(edits)),
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
            return Response::new_err(id, INTERNAL_ERROR, format!("{MINIFY} needs a uri argument"));
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
        match notification.method.as_str() {
            "textDocument/didOpen" => {
                let params: DidOpenTextDocumentParams =
                    serde_json::from_value(notification.params)?;
                let uri = params.text_document.uri;
                self.language_ids
                    .insert(uri.clone(), params.text_document.language_id);
                self.documents
                    .insert(uri.clone(), params.text_document.text);
                if self.lint_on_save {
                    self.publish_lint(&uri)?;
                    self.queue_package_lint(&uri, false);
                }
                self.log_memory("didOpen");
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
                    self.queue_package_lint(&params.text_document.uri, true);
                }
            }
            "workspace/didChangeWorkspaceFolders" => {
                let folders = folders_after(&self.init_params, &notification.params);
                eprintln!("[poly] workspace folders: {}", folders.len());
                self.init_params["workspaceFolders"] = serde_json::Value::Array(folders);
            }
            "textDocument/didClose" => {
                let params: DidCloseTextDocumentParams =
                    serde_json::from_value(notification.params)?;
                let uri = params.text_document.uri;
                self.documents.remove(&uri);
                self.language_ids.remove(&uri);
                self.lint_hashes.remove(&uri);
                self.lock().forget(&uri);
                // Clear diagnostics so closed files don't linger in Problems.
                self.publish(&uri, Vec::new())?;
                self.log_memory("didClose");
            }
            _ => {}
        }
        Ok(())
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

    /// Say what poly is holding, so a growing RSS can be blamed on something.
    ///
    /// The soak in `tools/lsp-smoke.py` has always been able to see the daemon
    /// get bigger and never able to say what got bigger -- `ps` reports one
    /// number and poly has five places to keep something. These are those five,
    /// and RSS is printed beside them so a line stands on its own.
    ///
    /// Written on open and close rather than on a timer. Those are the two
    /// events that change what poly holds by a whole document, a timer would
    /// repeat the same numbers at an idle daemon forever, and neither one needs
    /// a thread that can see `Server`.
    ///
    /// Diagnostics are counted, not weighed: knowing that the package map holds
    /// 4,000 findings is what points at golangci-lint, and a byte count of the
    /// same thing would need every one of them serialized to produce it.
    fn log_memory(&self, event: &str) {
        if !self.memory_log {
            return;
        }
        let text: usize = self.documents.values().map(String::len).sum();
        let diagnostics = self.lock();
        let package: usize = diagnostics.package.values().map(HashMap::len).sum();
        let package_found: usize = diagnostics
            .package
            .values()
            .flat_map(HashMap::values)
            .map(Vec::len)
            .sum();
        let lint: usize = diagnostics.lint.values().map(Vec::len).sum();
        eprintln!(
            "[poly] memory after {event}: rss {}; {} documents {}; {} lint hashes; \
             {} package scopes; findings lint {lint} package {package_found} over {package} files, \
             format {}",
            rss_kb().map_or_else(|| "?".to_string(), human_kb),
            self.documents.len(),
            human_kb(text as u64 / 1024),
            self.lint_hashes.len(),
            self.package_roots.len(),
            diagnostics.format.len(),
        );
    }

    /// Ask for a whole-package lint of the module this document belongs to.
    ///
    /// `fresh` is what separates the two callers. A save wants a new answer and
    /// says so; an open only wants the module looked at once, because ten files
    /// opened from one module are one module's worth of findings and ten
    /// compiles. Nothing happens here beyond queueing — golangci-lint takes
    /// seconds on a real module, and the main loop is where the editor's
    /// requests are answered.
    fn queue_package_lint(&mut self, uri: &Url, fresh: bool) {
        let path = uri_path(uri);
        let Some((linter, root)) = self
            .language_of(uri)
            .and_then(|language| package_lint_scope(&language, &path))
        else {
            return;
        };
        let first = self.package_roots.insert((linter, root.clone()));
        if !fresh && !first {
            return;
        }
        if self.package_jobs.is_none() {
            let (jobs, queue) = std::sync::mpsc::channel();
            let store = Arc::clone(&self.diagnostics);
            let sender = self.connection.sender.clone();
            std::thread::spawn(move || {
                package_lint_worker(&queue, &store, |message| {
                    let _ = sender.send(message);
                });
            });
            self.package_jobs = Some(jobs);
        }
        let job = PackageJob { linter, root };
        // A send error means the worker died, which it only does when the queue
        // is dropped with the server. Nothing useful to say at that point.
        let _ = self.package_jobs.as_ref().expect("package queue").send(job);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Diagnostics> {
        // Poisoned means a thread panicked mid-update. The critical sections
        // here are map reads and inserts, so that cannot happen without a bug
        // worth crashing on.
        self.diagnostics.lock().expect("diagnostics lock")
    }

    /// Publish everything known about a document, from whichever source.
    ///
    /// A missing formatter is unaffected: that path returns without an error
    /// and says so on stderr, so nothing is swallowed by staying quiet in the
    /// editor.
    fn publish_all(&mut self, uri: &Url) -> Result<()> {
        let diagnostics = self.lock().merged(uri);
        self.publish(uri, diagnostics)
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

/// This process's resident set, in kilobytes.
///
/// Two implementations because the two platforms keep it in different places,
/// and `None` on anything else rather than a number that might be a guess: a
/// memory log whose memory figure is wrong is worse than one without it.
///
/// Linux reads `VmRSS` out of `/proc/self/status` rather than the resident
/// pages in `statm`, which would need the page size and get it wrong on the
/// 16K-page arm64 kernels. macOS has no `/proc`, so it asks `ps` -- one
/// short-lived process per file opened, which is the price of not linking a
/// crate for one number behind a setting that ships off.
#[cfg(target_os = "linux")]
fn rss_kb() -> Option<u64> {
    std::fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

#[cfg(target_os = "macos")]
fn rss_kb() -> Option<u64> {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn rss_kb() -> Option<u64> {
    None
}

/// Kilobytes as something a person reads without counting digits.
fn human_kb(kb: u64) -> String {
    if kb < 1024 {
        format!("{kb} KB")
    } else {
        format!("{:.1} MB", kb as f64 / 1024.0)
    }
}

/// The document a request is about.
fn request_uri(params: &serde_json::Value) -> Option<Url> {
    Url::parse(params.get("textDocument")?.get("uri")?.as_str()?).ok()
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
fn formatted_text(path: &Path, text: &str) -> Result<Option<String>> {
    // Rediscover per call: an upward stat chain is cheap (<1ms) and picks up
    // poly.toml edits without a watcher.
    let config = poly_core::Config::discover(path).unwrap_or_else(|_| poly_core::Config::empty());
    // `[format] exclude` is the project saying another program owns these
    // bytes — a lockfile, generated output, a byte-exact fixture. `poly fmt`
    // honours it and so does the lint side below, so format-on-save has to as
    // well: without this, opening one of those files and saving rewrites on the
    // spot exactly what CI is required never to touch, and `pnpm install
    // --frozen-lockfile` fails on a file nobody edited.
    if config.excluded(path, poly_core::Scope::Format) {
        return Ok(None);
    }
    let Some(lang) = config.language(path) else {
        return Ok(None);
    };
    if !crate::fmt::formattable(&lang) {
        return Ok(None);
    }
    crate::fmt::format_text(&lang, path, text, &config)
}

/// Format a buffer that has no file behind it, as edits.
///
/// An untitled buffer never reaches `format_response`: the client's document
/// selector is `file` only, because a didOpen also starts lint and the language
/// server behind the language, and neither has anything to do with text that
/// has no path. So the client sends the text itself, with a path to detect the
/// language and discover poly.toml from -- a name carrying the extension VSCode
/// gives that language, in the workspace folder -- and poly keeps nothing.
fn format_text_edits(argument: Option<&serde_json::Value>) -> Result<Vec<TextEdit>> {
    let field = |name: &str| {
        argument
            .and_then(|a| a.get(name))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("{FORMAT_TEXT} needs a {name} argument"))
    };
    let text = field("text")?;
    Ok(formatted_text(Path::new(field("path")?), text)?
        .map(|formatted| line_edits(text, &formatted, |_| true))
        .unwrap_or_default())
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

    line_edits(text, formatted, |span| {
        // A pure insertion replaces no lines, so it has no extent of its own
        // to compare against the selection; it belongs to the line it goes
        // in front of.
        let extent = span.end.max(span.start + 1);
        span.start <= last && extent > first
    })
}

/// A reformat as one edit per changed run of lines, for the runs `keep`
/// accepts by their line span in `text`.
///
/// Format Document goes through here too, rather than answering with one edit
/// that replaces the document. The format shortcut applies edits as they come
/// (`formatNow` in the extension), and one edit over the whole document took
/// the cursor and the scroll position with it: every press made the view jump,
/// even when the formatter changed one line. Lines the formatter left alone
/// are now lines the editor never touches.
fn line_edits(
    text: &str,
    formatted: &str,
    keep: impl Fn(std::ops::Range<usize>) -> bool,
) -> Vec<TextEdit> {
    let old = lines(text);
    let new = lines(formatted);
    // A reformat that changes every line -- a file reindented -- is the diff's
    // worst case, quadratic in its length, and format-on-save waits on this.
    // Past the deadline the diff settles for fewer, larger runs, which are
    // still exact: only how much of the file each edit spans changes.
    let deadline = Instant::now() + std::time::Duration::from_millis(200);
    similar::capture_diff_slices_deadline(similar::Algorithm::Myers, &old, &new, Some(deadline))
        .into_iter()
        .filter(|op| op.tag() != similar::DiffTag::Equal && keep(op.old_range()))
        .map(|op| TextEdit {
            range: Range {
                start: line_start(&old, op.old_range().start),
                end: line_start(&old, op.old_range().end),
            },
            new_text: new[op.new_range()].concat(),
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

fn external_lint(
    lang: &str,
    path: &Path,
    text: &str,
    config: &poly_core::Config,
) -> anyhow::Result<Vec<poly_core::diag::Issue>> {
    let mut issues = Vec::new();

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
    // R goes through the file for the reason biome does, and for a second one
    // that is stronger: arity's stdin mode has no package around it, so every
    // symbol another file in the package defines becomes `undefined-symbol`.
    // On dplyr's `mutate.R` that is 87 findings against the 1 `poly check`
    // reports -- an editor full of squiggles CI has never heard of, which is
    // the split A4 exists to prevent.
    if lang == "r" {
        if let Some(bin) = resolved_tool("arity", config) {
            let root = poly_tools::run::r_package_root(path);
            issues.extend(
                poly_tools::run::arity_dir(&bin, &root, &[path.to_path_buf()])?
                    .into_iter()
                    .map(|f| f.issue),
            );
        }
    }

    // Shell embedded in a file that is not a shell script: a Dockerfile `RUN`,
    // a workflow `run:`. Independent of the tool below, and it has to be — the
    // editor squiggle and `poly check`'s output are one answer (R5/A4), and
    // `poly check` runs this over the same files.
    //
    // The snippets are extracted before shellcheck is resolved, so a Dockerfile
    // whose every `RUN` is exec form never triggers a download.
    let snippets = poly_engines::shell::embedded(lang, path, text);
    if !snippets.is_empty() {
        if let Some(shellcheck) = resolved_tool("shellcheck", config) {
            issues.extend(crate::embedded_shell(&shellcheck, &snippets, text)?);
        }
    }

    // Managed tool for the language, if any. Independent of the above: a
    // project can run both, and their findings do not overlap.
    let name = match lang {
        "shellscript" => "shellcheck",
        "dockerfile" => "hadolint",
        "yaml" if poly_core::is_workflow_file(path) => "actionlint",
        "swift" => "swiftlint",
        _ => return Ok(issues),
    };
    let Some(cmd) = resolved_tool(name, config) else {
        return Ok(issues);
    };
    issues.extend(match name {
        "shellcheck" => poly_tools::run::shellcheck_stdin(&cmd, text)?,
        "hadolint" => poly_tools::run::hadolint_stdin(&cmd, text)?,
        // Its own checks only: the shell in every `run:` block was already
        // checked above, at the offending word rather than at the key.
        "actionlint" => poly_tools::run::actionlint_stdin(&cmd, text)?,
        "swiftlint" => poly_tools::run::swiftlint_stdin(&cmd, path, text)?,
        _ => unreachable!(),
    });
    Ok(issues)
}

/// The workspace folders after applying one `didChangeWorkspaceFolders` event.
///
/// Kept in `init_params` because that is where `crate::navigate::root_of`
/// reads them, so a folder added an hour into the session is searched like one
/// that was open at startup. `rootUri` and `rootPath` are left alone: they are
/// deprecated and name the folder the window was opened with.
fn folders_after(
    init_params: &serde_json::Value,
    params: &serde_json::Value,
) -> Vec<serde_json::Value> {
    let uri_of = |folder: &serde_json::Value| {
        folder
            .get("uri")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let mut folders: Vec<serde_json::Value> = init_params
        .get("workspaceFolders")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(event) = params.get("event") else {
        return folders;
    };
    // Removed before added, and matched by uri rather than by position: the
    // editor sends the folders it changed, not the list it now has.
    let removed: HashSet<String> = event
        .get("removed")
        .and_then(serde_json::Value::as_array)
        .map(|list| list.iter().filter_map(uri_of).collect())
        .unwrap_or_default();
    folders.retain(|folder| !uri_of(folder).is_some_and(|uri| removed.contains(&uri)));
    if let Some(added) = event.get("added").and_then(serde_json::Value::as_array) {
        folders.extend(added.iter().cloned());
    }
    folders
}

/// The scope a whole-package linter would run over for this document, if poly
/// runs one for the language.
///
/// Three languages, because three of the linters poly drives cannot answer
/// about a single buffer: golangci-lint type-checks the package, clippy
/// compiles the crate, and tflint reads a directory as one Terraform module.
/// Those are the languages where `poly check` reported findings the editor
/// never showed. Every other linter poly drives takes a file on stdin and is
/// handled by `lint_document`.
///
/// The units are the tools' own: a Go module, a cargo workspace, and one
/// Terraform directory — tflint does not descend, so neither does this. All
/// three match what `poly check` groups by, which is the point (A4).
fn package_lint_scope(language: &str, path: &Path) -> Option<(PackageLinter, PathBuf)> {
    match language {
        "go" => poly_tools::run::go_module_root(path).map(|root| (PackageLinter::Golangci, root)),
        "rust" => {
            poly_tools::run::cargo_workspace_root(path).map(|root| (PackageLinter::Clippy, root))
        }
        "terraform" => path
            .parent()
            .map(|dir| (PackageLinter::Tflint, dir.to_path_buf())),
        _ => None,
    }
}

/// Run queued package lints, one at a time, forever.
///
/// Serial on purpose: golangci-lint refuses to run twice at once in the same
/// module, and two modules compiling in parallel is a lot of machine for
/// something nobody is waiting on.
fn package_lint_worker(
    queue: &std::sync::mpsc::Receiver<PackageJob>,
    store: &Mutex<Diagnostics>,
    send: impl Fn(Message),
) {
    // A receive error means the queue was dropped with the server.
    while let Ok(job) = queue.recv() {
        // Saves that arrived while the previous run was compiling are still
        // waiting. Collapse them by root: golangci-lint reads the module from
        // disk, so three saves in a row would compile three times to report the
        // same thing three times.
        let mut batch = vec![job];
        while let Ok(queued) = queue.try_recv() {
            batch.push(queued);
        }
        batch.sort_by(|a, b| (a.linter.tool(), &a.root).cmp(&(b.linter.tool(), &b.root)));
        batch.dedup_by(|a, b| a.linter == b.linter && a.root == b.root);
        for job in batch {
            run_package_lint(&job, store, &send);
        }
    }
}

/// Swap in a run's new findings and say which documents changed hands.
///
/// What that run recorded last time *is* the previous report — nothing else
/// records what it said — so dropping it is how a fixed finding disappears. The
/// answer is the union of old and new, not just what was found: a uri that
/// appears only in the previous report needs an empty publish, or the finding
/// the user just fixed stays on screen until they close the file.
///
/// Only this run's own entry is touched. The per-file linters, any language
/// server, and any *other* whole-scope run have their own entries for these
/// same documents, and this run knows nothing about what they found.
fn replace_package_findings(
    store: &mut Diagnostics,
    job: &PackageJob,
    fresh: HashMap<Url, Vec<lsp_types::Diagnostic>>,
) -> Vec<Url> {
    let previous = store
        .package
        .remove(&(job.linter, job.root.clone()))
        .unwrap_or_default();
    let mut affected: HashSet<Url> = previous.into_keys().collect();
    affected.extend(fresh.keys().cloned());
    store.package.insert((job.linter, job.root.clone()), fresh);
    affected.into_iter().collect()
}

/// Lint one scope and publish what changed.
fn run_package_lint(job: &PackageJob, store: &Mutex<Diagnostics>, send: &impl Fn(Message)) {
    let config =
        poly_core::Config::discover(&job.root).unwrap_or_else(|_| poly_core::Config::empty());
    let Some(cmd) = resolved_tool(job.linter.tool(), &config) else {
        return;
    };
    let started = Instant::now();
    let found = match job.linter.run(&cmd, &job.root) {
        Ok(found) => found,
        Err(e) => {
            eprintln!("[poly] {} {}: {e:#}", job.linter.tool(), job.root.display());
            return;
        }
    };
    let mut fresh: HashMap<Url, Vec<lsp_types::Diagnostic>> = HashMap::new();
    // Whole-scope linters report on files no editor has open, so the
    // suppressions have to be read from disk here. `lint_document` reads the
    // buffer instead, which is the only difference between the two.
    let mut inline = poly_core::InlineCache::new();
    for mut found in found {
        // The same filters `lint_document` applies, for the same reason: a rule
        // silenced in poly.toml or in the file itself has to be silent in
        // Problems too.
        if config.excluded(&found.file, poly_core::Scope::Lint)
            || config.lint_ignored(&found.file, found.issue.source, &found.issue.code)
            || inline.for_file(&found.file, &config).suppresses(
                found.issue.line,
                found.issue.source,
                &found.issue.code,
            )
        {
            continue;
        }
        if let Some(severity) = config.lint_severity(found.issue.source, &found.issue.code) {
            found.issue.severity = severity;
        }
        let Ok(uri) = Url::from_file_path(&found.file) else {
            continue;
        };
        fresh
            .entry(uri)
            .or_default()
            .push(lint_diagnostic(found.issue));
    }
    eprintln!(
        "[poly] {} {} {:.1}ms ({} files)",
        job.linter.tool(),
        job.root.display(),
        started.elapsed().as_secs_f64() * 1000.0,
        fresh.len()
    );

    let publishes = {
        let mut store = store.lock().expect("diagnostics lock");
        replace_package_findings(&mut store, job, fresh)
            .into_iter()
            .map(|uri| {
                let diagnostics = store.merged(&uri);
                (uri, diagnostics)
            })
            .collect::<Vec<_>>()
    };
    for (uri, diagnostics) in publishes {
        send(Message::Notification(Notification::new(
            "textDocument/publishDiagnostics".to_string(),
            PublishDiagnosticsParams {
                uri,
                diagnostics,
                version: None,
            },
        )));
    }
}

fn lint_document(path: &Path, text: &str) -> Vec<lsp_types::Diagnostic> {
    let config = poly_core::Config::discover(path).unwrap_or_else(|_| poly_core::Config::empty());
    // The same reading of poly.toml `poly check` prints, on the channel the
    // daemon has: the editor shows the server's stderr as poly's output. A
    // `[tools]` name that turns nothing off is a mistake worth the same
    // sentence in both places, and the editor is where most people meet it
    // first -- CI only sees the file once it is pushed.
    crate::settings::report(&config);
    // A file `[lint] exclude` drops has to come back clean here too, or
    // Problems shows findings no `poly check` run will ever produce. Naming a
    // file on the command line still beats the exclude (batch::resolve_targets
    // keeps that), but opening one in an editor is the walk's case, not that
    // one -- nobody asked for this file specifically, it just happens to be
    // on screen.
    if config.excluded(path, poly_core::Scope::Lint) {
        return Vec::new();
    }
    // Above the Unicode scan, which would otherwise reach it: `poly check`
    // leaves a diagram's save file out of its walk (poly_core::diagram_file).
    let lang = config.language(path);
    if lang.is_none() && poly_core::diagram_file(path) {
        return Vec::new();
    }
    // Above the language gate, and above `lint_engine` below it, because this
    // is the one rule with no language: CSS has no linter here and a zero-width
    // space in a `.css` is exactly as broken as one in a `.py`. Run any lower
    // and it would cover the languages poly happens to have a linter for and no
    // others, which is a minority of the files an editor opens.
    //
    // From the buffer rather than from disk, unlike spelling: there is no
    // per-file configuration keyed off the name, so the text is all it needs.
    // That does not make it live. It runs when the rest of lint does -- on
    // open and on save, since didChange only stores the text -- so a pasted
    // character is underlined at the next save, not as it lands. `poly check`
    // calls the same function with what it read from disk.
    let unicode = poly_engines::unicode::check(text);
    let Some(lang) = lang else {
        // Rare from this client -- its document selector only sends languages
        // poly names -- and reachable from any other, plus from a file whose
        // extension poly does not map. No language means no comment syntax and
        // so no inline suppression, but `[lint] ignore` in poly.toml still
        // applies and so does a severity override, which is why it goes through
        // the same tail as everything else.
        return finish(unicode, path, &config, &poly_core::InlineIgnores::empty());
    };
    // Asked before linting rather than dispatching straight into the engines,
    // because for JavaScript and TypeScript the answer is "eslint has this
    // file" -- and `poly check` steps back there too. An engine only one of
    // them runs is the editor/CI split A4 exists to prevent.
    let mut issues = match crate::lint_engine(&lang, path) {
        None => Vec::new(),
        Some(_) => match poly_engines::lint::lint(&lang, path, text) {
            Ok(issues) => issues,
            Err(e) => {
                eprintln!("[poly] lint error {}: {e:#}", path.display());
                Vec::new()
            }
        },
    };
    // A schema is not a language's linter -- a YAML file is checked against one
    // only when it or poly.toml names it -- so it is asked beside `lint_engine`
    // rather than through it, as `poly check` asks. From the buffer, so a
    // directive takes effect as it is typed, at the next lint.
    match poly_engines::schema::lint(
        &lang,
        path,
        text,
        &config.lint_schemas(path),
        poly_tools::schema,
    ) {
        Ok(found) => issues.extend(found.into_iter().flatten()),
        Err(e) => eprintln!("[poly] schema error {}: {e:#}", path.display()),
    }
    // Spelling is asked separately because it has no language to dispatch on,
    // and from disk rather than from the buffer: on stdin the document is
    // called `-`, so the per-type config keyed off the file name stops applying
    // and the editor would answer differently from CI for exactly the repos
    // that configure it. didOpen and didSave are what make the file on disk the
    // current one — the same trade biome makes in `external_lint`.
    match poly_engines::lint::spell(path) {
        Ok(found) => issues.extend(found),
        Err(e) => eprintln!("[poly] spell error {}: {e:#}", path.display()),
    }
    issues.extend(unicode);
    match external_lint(&lang, path, text, &config) {
        Ok(more) => issues.extend(more),
        Err(e) => eprintln!("[poly] external lint error {}: {e:#}", path.display()),
    }
    // Same two calls `poly check` makes, so a rule silenced in poly.toml or in
    // the file itself is silent in Problems too. A suppression only one side
    // honors is the editor/CI split A4 exists to prevent.
    //
    // Scanned from the buffer rather than from disk: the comment the user is
    // typing is the one that should apply, and a squiggle that only clears on
    // save is a suppression that looks broken.
    let inline = poly_core::InlineIgnores::scan(Some(&lang), text);
    finish(issues, path, &config, &inline)
}

/// What every finding goes through on its way to Problems, whichever path it
/// arrived by: the project's suppressions, then the project's severities.
///
/// Its own function because `lint_document` now has two exits -- a file with no
/// language still has findings -- and a second copy of this is how one of them
/// would end up honouring a `[lint] ignore` the other did not.
fn finish(
    mut issues: Vec<poly_core::diag::Issue>,
    path: &Path,
    config: &poly_core::Config,
    inline: &poly_core::InlineIgnores,
) -> Vec<lsp_types::Diagnostic> {
    issues.extend(inline.syntax_issues(crate::hadolint_is_off(config)));
    issues.retain(|i| {
        !config.lint_ignored(path, i.source, &i.code)
            && !inline.suppresses(i.line, i.source, &i.code)
    });
    // The colour of the squiggle is the project's decision too, and it is the
    // same call `poly check` makes before it decides the exit code.
    for issue in &mut issues {
        if let Some(severity) = config.lint_severity(issue.source, &issue.code) {
            issue.severity = severity;
        }
    }
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
    // A diagram editor is the other program that writes the whole file on
    // save; a final newline added here is one its next save takes out again.
    let formatted = poly_core::diagram_file(&path)
        || config
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

    /// `[format] exclude` has to reach format-on-save, not just `poly fmt`.
    ///
    /// The list is how a project says another program owns a file's bytes: a
    /// lockfile, generated output, a byte-exact fixture. Honouring it in the
    /// batch path alone means CI leaves the file alone and the editor rewrites
    /// it the moment somebody opens and saves — the editor/CI split A4 exists
    /// to prevent, and a `pnpm install --frozen-lockfile` failure on a file
    /// nobody edited. Found by `tools/lsp-fmt-diff.py`, which asks both paths
    /// about the same file; this repo's own poly.toml excludes
    /// `extensions/*/pnpm-lock.yaml` for exactly that reason.
    #[test]
    fn format_on_save_honours_the_format_exclude_list() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(
            root.join("poly.toml"),
            "[format]\nexclude = [\"vendor/**\"]\n",
        )
        .unwrap();
        std::fs::create_dir(root.join("vendor")).unwrap();
        let messy = "a:   1\n";

        let excluded = root.join("vendor").join("a.yaml");
        assert_eq!(
            formatted_text(&excluded, messy).unwrap(),
            None,
            "an excluded file must come back with no edits"
        );

        // The control: without it this test would pass on a formatter that had
        // stopped working at all.
        let ordinary = root.join("a.yaml");
        assert!(
            formatted_text(&ordinary, messy).unwrap().is_some(),
            "a file outside the list still formats"
        );
    }

    fn diagnostic(source: &str) -> lsp_types::Diagnostic {
        lsp_types::Diagnostic {
            source: Some(source.to_string()),
            message: source.to_string(),
            ..Default::default()
        }
    }

    /// The same, reporting a named rule: `merged` reads the code, not the name.
    fn finding(source: &str, code: &str) -> lsp_types::Diagnostic {
        lsp_types::Diagnostic {
            code: Some(lsp_types::NumberOrString::String(code.to_string())),
            ..diagnostic(source)
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

    fn package_job(linter: PackageLinter, root: &str) -> PackageJob {
        PackageJob {
            linter,
            root: PathBuf::from(root),
        }
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
                // A diagram is named for the editor, which shows its source,
                // and left alone by poly on purpose: the drawing's editor
                // rewrites the whole file on every save.
                if poly_core::diagram_file(Path::new(&name)) {
                    continue;
                }
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

        // Not a language poly formats either, but the drawio or excalidraw
        // editor rewrites it whole on every save: a newline the save hook
        // added would be churn in every diagram a repo commits.
        for diagram in [
            "arch.drawio.svg",
            "flow.drawio",
            "flow.dio",
            "sketch.excalidraw.json",
            "sketch.excalidraw",
            "mine.excalidrawlib",
        ] {
            assert_eq!(ask(diagram)["formatted"], true, "{diagram}");
        }

        // No uri is the caller's bug. An error, not an empty answer the
        // extension would go on to apply to the document.
        assert!(editor_config(None).is_err());
    }

    /// The linter reports `toml/syntax` on change and the formatter fails on
    /// the same error on save, at the same line and column and in the same
    /// words. Both were published, so the editor drew two squiggles over one
    /// character -- and the second of them had no rule doc to hover and no
    /// code to suppress.
    #[test]
    fn the_formatter_does_not_repeat_a_parse_failure() {
        let mut store = Diagnostics::default();
        store.format.insert(uri(), diagnostic("poly/format"));

        // The control: a finding about something other than parsing leaves the
        // formatter alone. A file can be misspelt *and* badly formatted, and
        // those are two things to say.
        store.lint.insert(uri(), vec![finding("typos", "spelling")]);
        assert_eq!(sources(&store.merged(&uri())), ["typos", "poly/format"]);

        store.lint.insert(uri(), vec![finding("toml", "syntax")]);
        assert_eq!(sources(&store.merged(&uri())), ["toml"]);

        // arity spells the same claim differently, and it is the case a rule
        // keyed on "does the format error carry a position" would have missed:
        // arity's does not carry one.
        store
            .lint
            .insert(uri(), vec![finding("arity", "syntax-error")]);
        assert_eq!(sources(&store.merged(&uri())), ["arity"]);
    }

    /// The rules the editor treats as "this file does not parse" are exactly
    /// the ones the catalog has.
    ///
    /// Both directions matter and they fail differently. A new syntax rule
    /// spelled some third way keeps the double report and nobody would notice;
    /// a rule renamed *into* this shape starts silencing the formatter on files
    /// that parse perfectly well.
    #[test]
    fn the_parse_failures_the_editor_knows_are_the_ones_the_catalog_has() {
        let mut ids: Vec<&str> = poly_core::catalog::catalog()
            .values()
            .flatten()
            .filter(|id| {
                let (_, rule) = id.split_once('/').expect("a tool/rule id");
                says_it_does_not_parse(&finding("t", rule))
            })
            .map(String::as_str)
            .collect();
        ids.sort_unstable();
        assert_eq!(
            ids,
            [
                "arity/syntax-error",
                "graphql/syntax",
                "php/syntax",
                "toml/syntax",
                "typescript/syntax",
            ]
        );
    }

    /// Three publishers, one uri, and `publishDiagnostics` replaces the whole
    /// set: every one of them has to survive the others.
    ///
    /// This is the shape of the bug package lint could have introduced. The
    /// per-file linters publish on save, the formatter on format, and
    /// golangci-lint whenever a module finishes compiling — three independent
    /// clocks. If any of them sent only its own half, saving a Go file would
    /// erase the module's findings and the next module run would erase the
    /// file's.
    #[test]
    fn no_publisher_erases_another() {
        let mut store = Diagnostics::default();
        store.lint.insert(uri(), vec![diagnostic("typos")]);
        store.package.insert(
            (PackageLinter::Golangci, PathBuf::from("/w")),
            HashMap::from([(uri(), vec![diagnostic("golangci-lint")])]),
        );
        store.format.insert(uri(), diagnostic("poly/format"));

        assert_eq!(
            sources(&store.merged(&uri())),
            ["typos", "golangci-lint", "poly/format"]
        );
    }

    /// A module's report is replaced as a set, and a fixed finding only
    /// disappears because the next run did not repeat it.
    #[test]
    fn a_fixed_package_finding_is_published_away() {
        let job = package_job(PackageLinter::Golangci, "/w/api");
        let fixed = Url::parse("file:///w/api/fixed.go").expect("valid uri");
        let broken = Url::parse("file:///w/api/broken.go").expect("valid uri");
        // A second module, mid-run in the same session. Its findings are no
        // business of this run and must outlive it.
        let elsewhere = Url::parse("file:///w/cli/main.go").expect("valid uri");

        let mut store = Diagnostics::default();
        store.package.insert(
            (PackageLinter::Golangci, PathBuf::from("/w/api")),
            HashMap::from([
                (fixed.clone(), vec![diagnostic("unused")]),
                (broken.clone(), vec![diagnostic("errcheck")]),
            ]),
        );
        store.package.insert(
            (PackageLinter::Golangci, PathBuf::from("/w/cli")),
            HashMap::from([(elsewhere.clone(), vec![diagnostic("errcheck")])]),
        );
        // The per-file linters also have something to say about the file that
        // was fixed. The whole-module run knows nothing about it and must not
        // take it away.
        store.lint.insert(fixed.clone(), vec![diagnostic("typos")]);

        let fresh = HashMap::from([(broken.clone(), vec![diagnostic("errcheck")])]);
        let mut affected = replace_package_findings(&mut store, &job, fresh);
        affected.sort_by(|a, b| a.as_str().cmp(b.as_str()));

        assert_eq!(
            affected,
            [broken.clone(), fixed.clone()],
            "the cleared file is republished too, or the squiggle never goes away"
        );
        assert_eq!(sources(&store.merged(&fixed)), ["typos"]);
        assert_eq!(sources(&store.merged(&broken)), ["errcheck"]);
        assert_eq!(
            sources(&store.merged(&elsewhere)),
            ["errcheck"],
            "another module's report is not this run's to clear"
        );
    }

    /// Two whole-scope runs that cover overlapping paths keep their own reports.
    ///
    /// This is why the store is keyed by the run and not by a path prefix. Both
    /// halves are ordinary layouts rather than corner cases: tflint reads one
    /// directory and does not descend, so a repository with `envs/prod` and
    /// `envs/prod/modules/db` in it has two runs whose findings both stand; and
    /// a Go module with .tf files in it is one directory that is two scopes. A
    /// prefix answer to "what did the last run own" would have a save in the
    /// parent erase the nested report, and a save of the .tf file erase what
    /// golangci-lint said about the .go file beside it — in both cases with
    /// nothing left to put it back.
    #[test]
    fn one_run_does_not_clear_another_that_overlaps_it() {
        let nested = Url::parse("file:///w/envs/prod/modules/db/main.tf").expect("valid uri");
        let parent = Url::parse("file:///w/envs/prod/main.tf").expect("valid uri");
        let beside = Url::parse("file:///w/envs/prod/main.go").expect("valid uri");

        let mut store = Diagnostics::default();
        store.package.insert(
            (
                PackageLinter::Tflint,
                PathBuf::from("/w/envs/prod/modules/db"),
            ),
            HashMap::from([(nested.clone(), vec![diagnostic("tflint")])]),
        );
        store.package.insert(
            (PackageLinter::Golangci, PathBuf::from("/w/envs/prod")),
            HashMap::from([(beside.clone(), vec![diagnostic("errcheck")])]),
        );

        let job = package_job(PackageLinter::Tflint, "/w/envs/prod");
        let fresh = HashMap::from([(parent.clone(), vec![diagnostic("tflint")])]);
        let affected = replace_package_findings(&mut store, &job, fresh);

        assert_eq!(
            affected,
            std::slice::from_ref(&parent),
            "a run republishes what it owns, and it owns neither of the others"
        );
        assert_eq!(
            sources(&store.merged(&nested)),
            ["tflint"],
            "the directory below has its own run and tflint never descended into it"
        );
        assert_eq!(
            sources(&store.merged(&beside)),
            ["errcheck"],
            "the other linter's report shares a directory, not a run"
        );
    }

    /// A server that starts an hour into the session has to be told about the
    /// folders open now, not the ones open at startup.
    ///
    /// The event carries what changed, never the resulting list, so poly has to
    /// keep the list itself. Matching removals by uri rather than by position
    /// is the part worth pinning: the editor is under no obligation to send
    /// back the same object it was given, and a `name` differing by a character
    /// would leave a removed folder in the list forever.
    #[test]
    fn workspace_folders_track_what_the_editor_reports() {
        let folder =
            |name: &str| serde_json::json!({"uri": format!("file:///w/{name}"), "name": name});
        let init = serde_json::json!({
            "rootUri": "file:///w/api",
            "workspaceFolders": [folder("api"), folder("cli")],
        });

        let swap = serde_json::json!({
            "event": {
                // Same uri, different name than the editor first sent.
                "added": [folder("web")],
                "removed": [{"uri": "file:///w/cli", "name": "renamed since"}],
            }
        });
        let after = folders_after(&init, &swap);
        assert_eq!(
            after
                .iter()
                .filter_map(|f| f["uri"].as_str())
                .collect::<Vec<_>>(),
            ["file:///w/api", "file:///w/web"]
        );

        // A window opened on a single file has no folders at all, and the first
        // one added must not be lost to that.
        let bare = serde_json::json!({"rootUri": serde_json::Value::Null});
        let added = serde_json::json!({"event": {"added": [folder("api")], "removed": []}});
        assert_eq!(folders_after(&bare, &added).len(), 1);

        // An event poly cannot read leaves the list as it was. Dropping every
        // folder would be a far worse answer than ignoring the notification.
        assert_eq!(folders_after(&init, &serde_json::json!({})).len(), 2);
    }

    /// Which files a whole-scope linter is asked about has to mean the same
    /// thing in the editor as in `poly check` (A4), and the two tools that have
    /// one do not agree about what a scope is.
    #[test]
    fn a_package_scope_is_whatever_the_tool_itself_reads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("real path");
        std::fs::write(root.join("go.mod"), "module x\n").expect("write go.mod");
        let nested = root.join("internal/api");
        std::fs::create_dir_all(&nested).expect("mkdir");
        let file = nested.join("api.go");
        std::fs::write(&file, "package api\n").expect("write api.go");

        // Go: up to the module, however deep the file is.
        assert_eq!(
            package_lint_scope("go", &file),
            Some((PackageLinter::Golangci, root.clone()))
        );
        // Terraform: the file's own directory and no further, because that is
        // all tflint reads. `poly check` groups .tf files by parent dir for the
        // same reason.
        let plan = nested.join("main.tf");
        assert_eq!(
            package_lint_scope("terraform", &plan),
            Some((PackageLinter::Tflint, nested.clone()))
        );
        // Rust: past the member crate to the workspace, because that is the
        // scope cargo itself resolves. Stopping at the member would give one
        // scope per crate in a workspace and a target directory each.
        std::fs::write(
            root.join("Cargo.toml"),
            "[workspace]\nmembers = [\"api\"]\n",
        )
        .expect("write workspace");
        let member = root.join("api");
        std::fs::create_dir_all(member.join("src")).expect("mkdir");
        std::fs::write(member.join("Cargo.toml"), "[package]\nname = \"api\"\n")
            .expect("write member");
        let source = member.join("src/lib.rs");
        std::fs::write(&source, "pub fn f() {}\n").expect("write lib.rs");
        assert_eq!(
            package_lint_scope("rust", &source),
            Some((PackageLinter::Clippy, root.clone()))
        );
        // Everything else is a stdin-sized linter, and nothing else may queue a
        // whole-directory run.
        assert_eq!(package_lint_scope("python", &file), None);
        // A .go file outside any module: no root, nothing to run.
        let orphan = dir.path().parent().expect("parent").join("nowhere.go");
        assert_eq!(package_lint_scope("go", &orphan), None);
    }

    /// The race that took poly out of a window: the editor stopping the daemon
    /// while answering a registration poly had just asked for. The answer
    /// lands between `shutdown` and `exit`, and the daemon has to wait for the
    /// `exit` rather than fail on the answer.
    #[test]
    fn an_answer_arriving_during_shutdown_does_not_fail_it() {
        let (server, editor) = Connection::memory();
        let shutdown = lsp_server::Request::new(7.into(), "shutdown".to_string(), ());
        let late = Response::new_ok(
            lsp_server::RequestId::from("poly:register:navigate".to_string()),
            (),
        );
        editor.sender.send(Message::Response(late)).unwrap();
        editor
            .sender
            .send(Message::Notification(Notification::new(
                "exit".to_string(),
                (),
            )))
            .unwrap();

        assert!(handle_shutdown(&server, &shutdown).unwrap());
        let Ok(Message::Response(answered)) = editor.receiver.try_recv() else {
            panic!("shutdown was not answered");
        };
        assert_eq!(answered.id, 7.into());
    }

    #[test]
    fn a_request_other_than_shutdown_is_left_to_the_loop() {
        let (server, editor) = Connection::memory();
        let hover = lsp_server::Request::new(1.into(), "textDocument/hover".to_string(), ());
        assert!(!handle_shutdown(&server, &hover).unwrap());
        assert!(
            editor.receiver.try_recv().is_err(),
            "answered a request it does not own"
        );
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

    /// A session over an in-memory pipe, and the editor's end of it.
    ///
    /// Lint is off: linting would resolve the tools a file needs -- a download
    /// on a machine that does not have them.
    fn session(mut options: serde_json::Value) -> (Server, Connection) {
        let (server, editor) = Connection::memory();
        options["lintOnSave"] = serde_json::json!(false);
        let init = serde_json::json!({ "initializationOptions": options });
        (Server::new(server, init), editor)
    }

    /// A project of its own, so no poly.toml above the temp dir decides
    /// anything.
    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("poly.toml"), "").unwrap();
        (dir, root)
    }

    /// Format Document answers with the lines that changed, not the document.
    ///
    /// It used to answer with one edit replacing everything, and the format
    /// shortcut applies edits as they arrive: the cursor and the scroll
    /// position went with the replaced text, so the view jumped on every press,
    /// even for a one-line fix. `"b"`, between the two fixes, is the line that
    /// shows it.
    #[test]
    fn format_document_leaves_the_lines_it_did_not_change_alone() {
        let (_dir, root) = project();
        let (mut server, _editor) = session(serde_json::json!({}));
        let uri = Url::from_file_path(root.join("a.json")).unwrap();
        let text = "{\n  \"a\":  1,\n  \"b\": 2,\n  \"c\":  3\n}\n";
        server
            .on_notification(Notification::new(
                "textDocument/didOpen".to_string(),
                serde_json::json!({
                    "textDocument": {"uri": uri, "languageId": "json", "version": 1, "text": text},
                }),
            ))
            .unwrap();

        let response = server.format_response(1.into(), uri, None);
        let edits: Vec<TextEdit> = serde_json::from_value(response.result.unwrap()).unwrap();
        let starts: Vec<u32> = edits.iter().map(|edit| edit.range.start.line).collect();
        assert_eq!(starts, [1, 3], "{edits:?}");
        assert_eq!(
            apply(text, &edits),
            "{\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3\n}\n"
        );
    }

    /// An untitled buffer is formatted as whatever the path it arrives with
    /// says it is. The path is the only thing that says: the same text under a
    /// name with no extension is a language poly cannot name, and gets nothing.
    #[test]
    fn an_untitled_buffer_formats_as_the_path_it_is_given() {
        let (_dir, root) = project();
        let text = "{\"a\":1,\n\n\"b\":2}\n";
        let named = root.join("Untitled-1.json");
        let edits =
            format_text_edits(Some(&serde_json::json!({"path": named, "text": text}))).unwrap();
        assert!(!edits.is_empty(), "nothing to format in {text:?}");
        assert_eq!(
            apply(text, &edits),
            formatted_text(&named, text).unwrap().unwrap()
        );

        let bare = root.join("Untitled-1");
        let edits =
            format_text_edits(Some(&serde_json::json!({"path": bare, "text": text}))).unwrap();
        assert!(edits.is_empty(), "{edits:?}");
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

    /// The daemon's half of `tests/check.rs`'s diagram case. The client sends
    /// an excalidraw file, which VSCode calls json, so the server is what keeps
    /// Problems as quiet as `poly check`.
    #[test]
    fn a_diagram_is_silent_in_the_editor_until_mapped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        // A typo in a label, and the no-break space drawio writes for `&nbsp;`:
        // one finding for spelling, which reads the disk, and one for the
        // Unicode scan, which reads the buffer.
        let text = "{\"text\": \"teh\u{a0}label\"}\n"; // poly: ignore typos/typo
        let (diagram, plain) = (root.join("sketch.excalidraw.json"), root.join("plain.json"));
        std::fs::write(&diagram, text).expect("write diagram");
        std::fs::write(&plain, text).expect("write plain");

        let found = lint_document(&plain, text);
        let sources: Vec<_> = found.iter().filter_map(|d| d.source.as_deref()).collect();
        assert!(
            sources.contains(&"typos") && sources.contains(&"poly"),
            "{sources:?}"
        );
        assert!(lint_document(&diagram, text).is_empty());

        std::fs::write(
            root.join("poly.toml"),
            "[languages.map]\n\"*.excalidraw.json\" = \"json\"\n",
        )
        .expect("write poly.toml");
        assert_eq!(lint_document(&diagram, text).len(), found.len());
    }

    /// `[lint.severity]` colours the squiggle, and `[lint] ignore` removes it.
    ///
    /// The daemon's half of `tests/check.rs`'s category cases. A level that
    /// moved the terminal's word and the exit code but left the editor showing
    /// the old colour would be the editor/CI split A4 exists to prevent, read
    /// in its subtlest form: the finding is in both places and the two disagree
    /// about how much it matters.
    #[test]
    fn the_editor_reads_the_projects_severity_and_its_ignores() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let file = root.join("Dockerfile");
        let text = "FROM alpine:3.19\nRUN apk add curl\n";
        std::fs::write(&file, text).expect("write Dockerfile");

        let level = |found: &[lsp_types::Diagnostic], code: &str| {
            found
                .iter()
                .find(
                    |d| matches!(&d.code, Some(lsp_types::NumberOrString::String(c)) if c == code),
                )
                .and_then(|d| d.severity)
        };

        let found = lint_document(&file, text);
        assert_eq!(
            level(&found, "docker-apk-unpinned"),
            Some(lsp_types::DiagnosticSeverity::WARNING)
        );

        std::fs::write(
            root.join("poly.toml"),
            "[lint]\nignore = [\"wasted-bytes\"]\n\n\
             [lint.severity]\nunpinned-dependency = \"hint\"\n",
        )
        .expect("write poly.toml");
        let found = lint_document(&file, text);
        assert_eq!(
            level(&found, "docker-apk-unpinned"),
            Some(lsp_types::DiagnosticSeverity::HINT)
        );
        assert_eq!(level(&found, "docker-apk-no-cache"), None);
    }

    /// `.proto` got nothing in the editor until now: `buf lint` ran only from
    /// `poly check`, and `external_lint` never had a protobuf arm, so a field
    /// named `BadField` was a finding in CI and a clean file on screen. The
    /// fixture is `tests/check.rs`'s, and the numbers are asserted rather than
    /// the emptiness, so a rule that stops firing fails here too.
    ///
    /// The protocol-level half of this — real `publishDiagnostics` against real
    /// `poly check` output — is in `tests/check.rs`, because this is a library
    /// call and that is a daemon.
    #[test]
    fn a_proto_is_linted_in_the_editor_at_the_same_positions_as_the_cli() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("a.proto");
        let text = "syntax = \"proto3\";\npackage a.b;\nmessage bad {\n  string X = 1;\n}\n";
        std::fs::write(&file, text).expect("write proto");

        let found = lint_document(&file, text);
        let mut seen: Vec<(String, u32, u32)> = found
            .iter()
            .filter_map(|d| match &d.code {
                Some(lsp_types::NumberOrString::String(code)) => {
                    Some((code.clone(), d.range.start.line, d.range.start.character))
                }
                _ => None,
            })
            .collect();
        seen.sort();
        assert_eq!(
            seen,
            [
                ("proto-field-lower-snake-case".to_string(), 3, 9),
                ("proto-message-pascal-case".to_string(), 2, 8),
            ]
        );
        assert!(found.iter().all(|d| d.source.as_deref() == Some("poly")));

        // And the project's own `buf.yaml` narrows the editor exactly as it
        // narrows CI -- a selection only one side honours is the same split.
        std::fs::write(
            dir.path().join("buf.yaml"),
            "version: v2\nlint:\n  use: [MESSAGE_PASCAL_CASE]\n",
        )
        .expect("write buf.yaml");
        assert_eq!(lint_document(&file, text).len(), 1);
    }

    /// The daemon's half of `tests/check.rs`'s inline suppression cases, on the
    /// same fixtures.
    ///
    /// Both sides call the same `InlineIgnores`, and this is what keeps that
    /// true: a comment that silences a finding in CI and leaves the squiggle on
    /// screen is the editor/CI split A4 exists to prevent, and it is the split
    /// nobody notices until they are staring at a Problems panel that disagrees
    /// with a green build.
    #[test]
    fn an_inline_comment_is_silent_in_the_editor_too() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        let codes = |name: &str, text: &str| -> Vec<String> {
            lint_document(&root.join(name), text)
                .into_iter()
                .filter_map(|d| match d.code {
                    Some(lsp_types::NumberOrString::String(code)) => Some(code),
                    _ => None,
                })
                .collect()
        };

        // Trailing: LT01 on this line is gone, CP01 on the next is not.
        assert_eq!(
            codes(
                "trailing.sql",
                "select a,b from t  -- poly: ignore sqruff/LT01\nWHERE x = 1;\n"
            ),
            ["CP01"]
        );
        // On its own line, for the line below.
        assert!(codes(
            "above.sql",
            "select a, b from t\n-- poly: ignore sqruff/CP01\nWHERE x = 1;\n"
        )
        .is_empty());
        // A comment poly cannot read is a diagnostic of its own here too, and
        // the finding it was aimed at stays on screen.
        let found = codes("bad.sql", "select a,b from t  -- poly: ignore LT01\n");
        assert!(found.contains(&"ignore-syntax".to_string()), "{found:?}");
        assert!(found.contains(&"LT01".to_string()), "{found:?}");
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

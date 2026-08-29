//! LSP daemon: full-sync document store, config-aware formatting (poly.toml
//! `[languages.map]` affects the editor exactly like the CLI, R5/A4),
//! lint-on-save diagnostics, and batch formatting via workspace/executeCommand
//! (shared with the CLI through crate::batch).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Result;
use lsp_server::{Connection, Message, Notification, Response};
use lsp_types::{
    DidChangeTextDocumentParams, DidCloseTextDocumentParams, DidOpenTextDocumentParams,
    DidSaveTextDocumentParams, DocumentFormattingParams, ExecuteCommandOptions,
    ExecuteCommandParams, Hover, HoverContents, HoverParams, HoverProviderCapability,
    MarkupContent, MarkupKind, OneOf, Position, PublishDiagnosticsParams, Range, SaveOptions,
    ServerCapabilities, TextDocumentSyncCapability, TextDocumentSyncKind, TextDocumentSyncOptions,
    TextDocumentSyncSaveOptions, TextEdit, Url,
};

const INTERNAL_ERROR: i32 = -32603;
const FORMAT_PATHS: &str = "poly.formatPaths";

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
    lint_on_save: bool,
    /// Content hash at last lint per document: external linters cost tens of
    /// ms to seconds, so an unchanged save republishes nothing.
    lint_hashes: HashMap<Url, u64>,
    /// publishDiagnostics replaces the whole set for a uri, so the two sources
    /// cannot each publish on their own — the last one to speak would erase the
    /// other. Both are kept here and merged on every publish.
    lint_diagnostics: HashMap<Url, Vec<lsp_types::Diagnostic>>,
    format_errors: HashMap<Url, lsp_types::Diagnostic>,
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
        // Rule documentation for a finding already on screen -- not a language
        // feature. A6 rules out completion, go-to-definition and the rest, all
        // of which mean understanding the code; this only reads out what the
        // linter that produced the squiggle has to say about its own rule.
        hover_provider: Some(HoverProviderCapability::Simple(true)),
        execute_command_provider: Some(ExecuteCommandOptions {
            commands: vec![FORMAT_PATHS.to_string()],
            ..Default::default()
        }),
        ..Default::default()
    };
    let init_params = connection.initialize(serde_json::to_value(capabilities)?)?;
    let lint_on_save = serde_json::from_value::<lsp_types::InitializeParams>(init_params)
        .ok()
        .and_then(|p| p.initialization_options)
        .and_then(|o| o.get("lintOnSave").and_then(|v| v.as_bool()))
        .unwrap_or(true);

    let mut server = Server {
        connection,
        documents: HashMap::new(),
        lint_on_save,
        lint_hashes: HashMap::new(),
        lint_diagnostics: HashMap::new(),
        format_errors: HashMap::new(),
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
                let response = match method.as_str() {
                    "textDocument/formatting" => Some(server.on_formatting(request)),
                    "textDocument/hover" => Some(server.on_hover(request)),
                    "workspace/executeCommand" => Some(server.on_execute_command(request)),
                    _ => None,
                };
                if let Some(response) = response {
                    eprintln!(
                        "[poly] {method} {:.1}ms",
                        started.elapsed().as_secs_f64() * 1000.0
                    );
                    server.connection.sender.send(Message::Response(response))?;
                }
            }
            Message::Notification(notification) => server.on_notification(notification)?,
            Message::Response(_) => {}
        }
    }

    Ok(())
}

impl Server {
    fn on_formatting(&mut self, request: lsp_server::Request) -> Response {
        let params: DocumentFormattingParams = match serde_json::from_value(request.params) {
            Ok(params) => params,
            Err(e) => return Response::new_err(request.id, INTERNAL_ERROR, e.to_string()),
        };
        let uri = params.text_document.uri;
        let Some(text) = self.documents.get(&uri).cloned() else {
            // Nothing opened for this uri: no edits rather than an error, so a
            // race with didClose degrades to a no-op save.
            return Response::new_ok(request.id, serde_json::json!([]));
        };
        match format_document(&uri, &text) {
            Ok(edits) => {
                if self.format_errors.remove(&uri).is_some() {
                    let _ = self.publish_all(&uri);
                }
                Response::new_ok(request.id, serde_json::json!(edits))
            }
            // A parse failure is the file's problem, not the request's. As an
            // LSP error it became a toast that named no line and could not be
            // clicked; as a diagnostic it lands in Problems with a squiggle
            // where the parser stopped, which is what every other linter does.
            Err(error) => {
                self.format_errors
                    .insert(uri.clone(), format_diagnostic(&error.to_string(), &text));
                let _ = self.publish_all(&uri);
                Response::new_ok(request.id, serde_json::json!([]))
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
            .lint_diagnostics
            .get(&at.text_document.uri)
            .and_then(|diagnostics| rule_hover(diagnostics, at.position));
        Response::new_ok(request.id, serde_json::json!(hover))
    }

    fn on_execute_command(&mut self, request: lsp_server::Request) -> Response {
        let params: ExecuteCommandParams = match serde_json::from_value(request.params) {
            Ok(params) => params,
            Err(e) => return Response::new_err(request.id, INTERNAL_ERROR, e.to_string()),
        };
        if params.command != FORMAT_PATHS {
            return Response::new_err(
                request.id,
                INTERNAL_ERROR,
                format!("unknown command {:?}", params.command),
            );
        }
        match run_format_paths(params.arguments.first()) {
            Ok(summary) => Response::new_ok(request.id, summary),
            Err(e) => Response::new_err(request.id, INTERNAL_ERROR, format!("{e:#}")),
        }
    }

    fn on_notification(&mut self, notification: Notification) -> Result<()> {
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
                self.lint_diagnostics.remove(&uri);
                self.format_errors.remove(&uri);
                // Clear diagnostics so closed files don't linger in Problems.
                self.publish(&uri, Vec::new())?;
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
        self.lint_diagnostics.insert(uri.clone(), diagnostics);
        self.publish_all(uri)
    }

    /// Lint findings plus the formatter's parse failure, if it has one.
    fn publish_all(&mut self, uri: &Url) -> Result<()> {
        let mut diagnostics = self.lint_diagnostics.get(uri).cloned().unwrap_or_default();
        diagnostics.extend(self.format_errors.get(uri).cloned());
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

fn format_document(uri: &Url, text: &str) -> Result<Vec<TextEdit>> {
    let path = uri_path(uri);
    // Rediscover per call: an upward stat chain is cheap (<1ms) and picks up
    // poly.toml edits without a watcher.
    let config = poly_core::Config::discover(&path).unwrap_or_else(|_| poly_core::Config::empty());
    let Some(lang) = config.language(&path) else {
        return Ok(vec![]);
    };
    if !crate::fmt::formattable(&lang) {
        return Ok(vec![]);
    }
    Ok(
        match crate::fmt::format_text(&lang, &path, text, &config)? {
            Some(new_text) => vec![TextEdit {
                range: full_range(text),
                new_text,
            }],
            None => vec![],
        },
    )
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
    // biome and eslint are project-local only and never managed, so they
    // resolve through the same detection `poly check` uses rather than the
    // tool registry.
    let mut issues = Vec::new();
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

fn lint_document(path: &Path, text: &str) -> Vec<lsp_types::Diagnostic> {
    let config = poly_core::Config::discover(path).unwrap_or_else(|_| poly_core::Config::empty());
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

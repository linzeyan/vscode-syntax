//! Embedded lint: sqruff for SQL, selene for Lua, ruff for Python and Jupyter.
//! External-tool lint (shellcheck, hadolint, actionlint, typos) lives in
//! poly-tools; the LSP daemon and the CLI merge both sources.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{anyhow, bail, Context, Result};
use poly_core::diag::{Fix, Issue, Severity};

/// Does `lang` have an embedded linter? Batch callers use this to avoid
/// reading thousands of files whose lint would return nothing.
pub fn supported(lang: &str) -> bool {
    matches!(lang, "sql" | "toml" | "lua" | "python" | "jupyter")
}

/// Rule documentation poly is holding that a diagnostic has no way to carry.
///
/// Every other tool either publishes a rule page — which becomes the
/// `code_description` link on the code — or says nothing, and both already
/// reach the reader. sqruff is the one that does neither: it has no
/// documentation site to link to, so `url` is empty, while the full
/// anti-pattern/best-practice prose for each rule is compiled into this very
/// binary. Version-exact and readable offline, and until now with no way out.
///
/// `None` is the answer for everything else, deliberately: poly does not
/// paraphrase a tool's rules, it repeats what the tool itself says.
pub fn rule_doc(source: &str, code: &str) -> Option<&'static str> {
    if source != "sqruff" {
        return None;
    }
    static DOCS: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    DOCS.get_or_init(|| {
        sqruff_lib::rules::rules()
            .iter()
            .map(|rule| (rule.code(), rule.long_description().trim()))
            .filter(|(_, doc)| !doc.is_empty())
            .collect()
    })
    .get(code)
    .copied()
}

/// Lint `text` as `lang` with embedded engines only. Languages without one
/// return no issues.
pub fn lint(lang: &str, path: &Path, text: &str) -> Result<Vec<Issue>> {
    match lang {
        "sql" => lint_sql(text),
        "toml" => Ok(lint_toml(text)),
        "lua" => lint_lua(path, text),
        "python" | "jupyter" => lint_python(path, text),
        _ => Ok(Vec::new()),
    }
}

/// TOML syntax errors. The formatter already refuses a broken file, but that
/// only ever surfaced through `poly fmt` — a syntax error is precisely what an
/// editor should show while you are still typing it, and a broken Cargo.toml
/// or pyproject.toml is worth failing CI over.
///
/// Syntax only: schema validation of known files is N1, deferred.
fn lint_toml(text: &str) -> Vec<Issue> {
    let Err(err) = text.parse::<toml::Value>() else {
        return Vec::new();
    };
    let span = err.span().unwrap_or(0..0);
    let (line, col) = line_col(text, span.start);
    let (end_line, end_col) = line_col(text, span.end);
    vec![Issue {
        line,
        col,
        end_line,
        end_col,
        severity: Severity::Error,
        code: "syntax".to_string(),
        // toml wraps its messages over several lines for terminal display;
        // diagnostics are one line in every consumer we have.
        message: err
            .message()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
        source: "toml",
        fix: None,
        // There is no rule to link, only the grammar the parser is enforcing.
        // The version matters: the `toml` crate implements 1.0.0, and 1.1.0
        // legalises things (newlines in inline tables, unicode escapes in bare
        // keys) that this parser rejects, so linking the current spec would
        // point at a document that disagrees with the error.
        url: Some("https://toml.io/en/v1.0.0".to_string()),
    }]
}

/// Byte offset -> 0-based (line, column in chars). Offsets that are not char
/// boundaries fall back to the start of the file rather than panicking.
fn line_col(text: &str, offset: usize) -> (u32, u32) {
    let Some(before) = text.get(..offset.min(text.len())) else {
        return (0, 0);
    };
    let line = before.matches('\n').count() as u32;
    let col = before.rsplit('\n').next().unwrap_or("").chars().count() as u32;
    (line, col)
}

fn lint_sql(text: &str) -> Result<Vec<Issue>> {
    let linted = crate::sql_linter()?
        .lint_string(text, None, false)
        .map_err(|e| anyhow!("sqruff error: {e}"))?;
    Ok(linted
        .violations()
        .iter()
        .map(|v| {
            let line = (v.line_no.max(1) - 1) as u32;
            let col = (v.line_pos.max(1) - 1) as u32;
            Issue {
                line,
                col,
                end_line: line,
                end_col: col + 1,
                severity: Severity::Warning,
                code: v.rule_code().to_string(),
                message: v.description.clone(),
                source: "sqruff",
                // sqruff carries a fixable flag but no description of the
                // rewrite, and publishes no rule documentation to link to.
                // `poly fmt` is the honest instruction here rather than a
                // generic "the tool can fix it": format_sql *is* sqruff's
                // fixer, so reformatting resolves exactly these.
                fix: v.fixable.then_some(Fix::Reformat),
                url: None,
            }
        })
        .collect())
}

// ── lua (selene) ───────────────────────────────────────────────────────────

/// selene's config table, over the value kind poly's TOML parser produces.
/// selene's own binary uses `toml::value::Value` here for the same reason: the
/// per-lint `[config]` entries are only deserialized once each lint says what
/// shape it wants.
type SeleneConfig = selene_lib::CheckerConfig<toml::Value>;

/// A warm checker plus the dialect its standard library says to parse in.
///
/// The two travel together because selene derives one from the other: a std of
/// `luau` parses Luau, `lua51` parses 5.1, and parsing a file in the wrong one
/// turns every finding into a parse error.
struct LuaLinter {
    checker: selene_lib::Checker<toml::Value>,
    version: full_moon::LuaVersion,
}

/// The checker governing `path`, built once per `selene.toml`.
///
/// Keyed by config file rather than held in a single `OnceLock` like sqruff's:
/// a monorepo can have several, and `poly check` at its root has to lint each
/// package under its own. Failures are cached too -- a broken selene.toml
/// should report once, not once per Lua file in the tree.
fn lua_linter(path: &Path) -> Result<Arc<LuaLinter>> {
    type Cache = HashMap<Option<PathBuf>, std::result::Result<Arc<LuaLinter>, String>>;
    static CACHE: Mutex<Option<Cache>> = Mutex::new(None);
    // selene resolved selene.toml against its own working directory, so poly
    // already found the file and passed `--config`; embedding changes only who
    // walks, not where the answer comes from.
    let key = poly_core::nearest_ancestor_file(path, "selene.toml");
    let mut guard = CACHE.lock().expect("lua linter cache lock");
    let cache = guard.get_or_insert_with(HashMap::new);
    let built = match cache.get(&key) {
        Some(hit) => hit.clone(),
        None => {
            let built = build_lua_linter(key.as_deref())
                .map(Arc::new)
                .map_err(|e| format!("{e:#}"));
            cache.insert(key, built.clone());
            built
        }
    };
    built.map_err(|e| anyhow!(e))
}

fn build_lua_linter(config_file: Option<&Path>) -> Result<LuaLinter> {
    let (config, config_dir) = match config_file {
        Some(file) => {
            let text = std::fs::read_to_string(file)
                .with_context(|| format!("reading {}", file.display()))?;
            let config: SeleneConfig =
                toml::from_str(&text).with_context(|| format!("parsing {}", file.display()))?;
            (config, file.parent().map(Path::to_path_buf))
        }
        // No selene.toml is not an error: selene lints with its defaults, and
        // `std` then means lua51.
        None => (SeleneConfig::default(), None),
    };
    let library = standard_library(config.std(), config_dir.as_deref(), 0)?;
    // Taken before the library moves into the checker. An unusable version is
    // a config error, not something to silently parse as 5.1: `std = "lua54"`
    // and 5.4 syntax rejected as a parse error is the worst of both.
    let version = {
        let (version, problems) = library.lua_version();
        if let Some(problem) = problems.first() {
            match problem {
                selene_lib::standard_library::LuaVersionError::FeatureNotEnabled(feature) => bail!(
                    "selene: this build cannot parse {feature}; \
                     it has the dialects selene's own release binary has"
                ),
                selene_lib::standard_library::LuaVersionError::Unknown(version) => {
                    bail!("selene: unknown lua version {version:?}")
                }
            }
        }
        version
    };
    let checker = selene_lib::Checker::new(config, library)
        .map_err(|e| anyhow!("selene configuration: {e}"))?;
    Ok(LuaLinter { checker, version })
}

/// The standard library `name` asks for, as selene resolves it.
///
/// `name` is a `+`-joined list, each segment either a file the project ships
/// or one of selene's built-ins, and each may name a `base` to extend.
///
/// Two departures from the binary, both forced and both narrow. selene looks
/// for a segment's file in its process working directory *and* next to
/// selene.toml; only the second survives here, because an embedded linter has
/// no meaningful cwd -- the editor's is wherever VSCode was started. And
/// `std = "roblox"` without a local `roblox.yml` made selene download a
/// Roblox API dump; poly reports that instead of reaching for the network
/// during a lint.
fn standard_library(
    name: &str,
    dir: Option<&Path>,
    depth: usize,
) -> Result<selene_lib::standard_library::StandardLibrary> {
    use selene_lib::standard_library::StandardLibrary;
    // A `base` pointing back at its own file recurses forever. selene has the
    // same hole; poly cannot afford it, because the daemon reads whatever
    // config the open project happens to have.
    if depth > 8 {
        bail!("selene: standard library {name:?} extends itself");
    }
    let mut collected: Option<StandardLibrary> = None;
    for segment in name.split('+') {
        let library = match local_standard_library(segment, dir)? {
            Some(mut library) => {
                if let Some(base) = library.base.clone() {
                    library.extend(standard_library(&base, dir, depth + 1)?);
                }
                library
            }
            // Built-ins resolve their own `base` on the way out, and carry
            // their own `name` -- which is what makes the roblox lints fire.
            None => StandardLibrary::from_name(segment).ok_or_else(|| {
                anyhow!(
                    "selene: no standard library {segment:?}; \
                     poly knows lua51, lua52, lua53 and luau, and reads a \
                     {segment}.yml or {segment}.toml next to selene.toml"
                )
            })?,
        };
        match collected {
            Some(mut already) => {
                already.extend(library);
                collected = Some(already);
            }
            None => collected = Some(library),
        }
    }
    collected.ok_or_else(|| anyhow!("selene: standard library {name:?} is empty"))
}

/// A `<name>.toml` / `.yml` / `.yaml` the project ships next to its
/// selene.toml. The `.toml` spelling is selene's older v1 schema, which is why
/// it converts rather than deserializing into the same type.
fn local_standard_library(
    name: &str,
    dir: Option<&Path>,
) -> Result<Option<selene_lib::standard_library::StandardLibrary>> {
    let Some(dir) = dir else {
        return Ok(None);
    };
    let toml_file = dir.join(format!("{name}.toml"));
    if toml_file.is_file() {
        let text = std::fs::read_to_string(&toml_file)
            .with_context(|| format!("reading {}", toml_file.display()))?;
        let v1: selene_lib::standard_library::v1::StandardLibrary =
            toml::from_str(&text).with_context(|| format!("parsing {}", toml_file.display()))?;
        return Ok(Some(v1.into()));
    }
    for extension in ["yml", "yaml"] {
        let file = dir.join(format!("{name}.{extension}"));
        if file.is_file() {
            let text = std::fs::read_to_string(&file)
                .with_context(|| format!("reading {}", file.display()))?;
            return serde_yaml::from_str(&text)
                .map(Some)
                .with_context(|| format!("parsing {}", file.display()));
        }
    }
    Ok(None)
}

/// One page per lint, named exactly by the code selene reports. `parse_error`
/// is the exception: it is how selene reports invalid Lua, not a lint, and has
/// no page -- linking it would send the reader somewhere that 404s.
fn selene_url(code: &str) -> Option<String> {
    (code != "parse_error")
        .then(|| format!("https://kampfkarren.github.io/selene/lints/{code}.html"))
}

fn lint_lua(path: &Path, text: &str) -> Result<Vec<Issue>> {
    let linter = lua_linter(path)?;
    let ast = match full_moon::parse_fallible(text, linter.version).into_result() {
        Ok(ast) => ast,
        // What selene does: report the parse failures and no lints, because
        // every lint below would be reading a tree the parser gave up on.
        Err(errors) => return Ok(errors.iter().map(|e| lua_parse_error(text, e)).collect()),
    };
    let mut found = linter.checker.test_on(&ast);
    // selene sorts by start position before printing, and `poly check` prints
    // findings in the order the linter hands them over.
    found.sort_by_key(|one| one.diagnostic.start_position());
    Ok(found
        .into_iter()
        .filter_map(|one| {
            let severity = match one.severity {
                // `lints.<name> = "allow"` in selene.toml. Reaching poly at
                // all would make the setting look broken.
                selene_lib::lints::Severity::Allow => return None,
                selene_lib::lints::Severity::Error => Severity::Error,
                selene_lib::lints::Severity::Warning => Severity::Warning,
            };
            let diagnostic = one.diagnostic;
            let (line, col) = line_col(text, diagnostic.primary_label.range.0 as usize);
            let (end_line, end_col) = line_col(text, diagnostic.primary_label.range.1 as usize);
            Some(Issue {
                line,
                col,
                end_line,
                end_col,
                severity,
                url: selene_url(diagnostic.code),
                code: diagnostic.code.to_string(),
                message: diagnostic.message,
                source: "selene",
                // selene ships no rewrites: every lint it has describes a
                // mistake to think about rather than an edit to apply.
                fix: None,
            })
        })
        .collect())
}

/// A parse failure, in the words and at the span selene reports it with.
fn lua_parse_error(text: &str, error: &full_moon::Error) -> Issue {
    let (message, range) = match error {
        full_moon::Error::AstError(ast) => (
            format!("unexpected token `{}`", ast.token()),
            (
                ast.token().start_position().bytes(),
                ast.token().end_position().bytes(),
            ),
        ),
        // full_moon's Display for the error kind is word for word what selene
        // writes out by hand, and it cannot fall behind a new variant.
        full_moon::Error::TokenizerError(error) => {
            let at = error.position().bytes();
            (error.error().to_string(), (at, at))
        }
    };
    let (line, col) = line_col(text, range.0);
    let (end_line, end_col) = line_col(text, range.1);
    Issue {
        line,
        col,
        end_line,
        end_col,
        severity: Severity::Error,
        code: "parse_error".to_string(),
        message,
        source: "selene",
        fix: None,
        url: None,
    }
}

// ── python (ruff) ──────────────────────────────────────────────────────────

/// ruff's configuration as the project wrote it, with nothing layered on top.
///
/// `resolve_root_settings` takes a transformer because ruff's own CLI uses it
/// to apply `--select` and friends over the file it just read. poly has no
/// such flags -- the project's config is the whole answer -- and ruff's no-op
/// implementation is `#[cfg(test)]`, so this is the one line of it poly needs.
struct AsWritten;

impl ruff_workspace::resolver::ConfigurationTransformer for AsWritten {
    fn transform(
        &self,
        config: ruff_workspace::configuration::Configuration,
    ) -> ruff_workspace::configuration::Configuration {
        config
    }
}

/// The ruff settings governing `path`.
///
/// Two caches, because the two halves cost different things and are shared at
/// different granularity. Finding the config is a stat-walk up the tree and its
/// answer is per directory; *resolving* it parses that file and every file it
/// extends and compiles the rule selection, and its answer is per config file
/// -- so a monorepo with three hundred package directories and one ruff.toml
/// walks three hundred times and resolves once.
///
/// This is the difference between embedding ruff and regressing it. The
/// downloaded binary paid resolution once per `poly check` because it was one
/// subprocess for the whole batch; the embedded linter runs per file under
/// rayon, so an unmemoized `resolve_root_settings` would turn a fixed cost into
/// a per-file one. Failures are cached for the reason phase 1 caches them: a
/// broken ruff.toml should report once, not once per Python file in the tree.
fn python_settings(path: &Path) -> Result<Arc<ruff_workspace::Settings>> {
    type Found = HashMap<PathBuf, Option<PathBuf>>;
    type Built =
        HashMap<Option<PathBuf>, std::result::Result<Arc<ruff_workspace::Settings>, String>>;
    static FOUND: Mutex<Option<Found>> = Mutex::new(None);
    static BUILT: Mutex<Option<Built>> = Mutex::new(None);

    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    // ruff's own discovery rather than `nearest_ancestor_file`: the nearest
    // `pyproject.toml` only counts if it actually carries a `[tool.ruff]`
    // table, and `ruff.toml` and `.ruff.toml` both win over it. Reimplementing
    // that ordering is how the editor and CI would start disagreeing with the
    // project's own config, which is the one thing this must not do.
    let config = {
        let mut guard = FOUND.lock().expect("ruff config discovery lock");
        let found = guard.get_or_insert_with(HashMap::new);
        match found.get(&dir) {
            Some(hit) => hit.clone(),
            None => {
                let hit =
                    ruff_workspace::pyproject::find_settings_toml(&dir).with_context(|| {
                        format!("looking for a ruff config above {}", dir.display())
                    })?;
                found.insert(dir, hit.clone());
                hit
            }
        }
    };

    let mut guard = BUILT.lock().expect("ruff settings cache lock");
    let built = guard.get_or_insert_with(HashMap::new);
    let settings = match built.get(&config) {
        Some(hit) => hit.clone(),
        None => {
            let hit = build_python_settings(config.as_deref())
                .map(Arc::new)
                .map_err(|e| format!("{e:#}"));
            built.insert(config, hit.clone());
            hit
        }
    };
    settings.map_err(|e| anyhow!(e))
}

/// Resolve one config file, or fall back the way ruff falls back.
///
/// Same order ruff's CLI uses once the project's own file is out of the
/// picture: a user-level `~/.config/ruff/ruff.toml`, then ruff's built-in
/// defaults. The user-level step is here because the downloaded binary honored
/// it, and a rule set that changes when poly stops shelling out is exactly the
/// silent drift this port exists to avoid.
fn build_python_settings(config: Option<&Path>) -> Result<ruff_workspace::Settings> {
    use ruff_workspace::resolver::{resolve_root_settings, ConfigurationOrigin};
    if let Some(file) = config {
        return resolve_root_settings(file, &AsWritten, ConfigurationOrigin::Ancestor)
            .with_context(|| format!("reading {}", file.display()));
    }
    if let Some(file) = ruff_workspace::pyproject::find_user_settings_toml() {
        return resolve_root_settings(&file, &AsWritten, ConfigurationOrigin::UserSettings)
            .with_context(|| format!("reading {}", file.display()));
    }
    Ok(ruff_workspace::Settings::default())
}

fn lint_python(path: &Path, text: &str) -> Result<Vec<Issue>> {
    let source_type = ruff_python_ast::PySourceType::from(path);
    // A .ipynb is JSON, not Python. Handing the raw text to the linter would
    // report on the container -- every `"cell_type"` a syntax error -- so it
    // goes through the notebook reader, which concatenates the code cells and
    // keeps the map back to them.
    let source_kind = if source_type.is_ipynb() {
        ruff_linter::source_kind::SourceKind::ipy_notebook(
            ruff_notebook::Notebook::from_source_code(text)
                .map_err(|e| anyhow!("reading {}: {e}", path.display()))?,
        )
    } else {
        ruff_linter::source_kind::SourceKind::Python {
            code: text.to_string(),
            is_stub: source_type.is_stub(),
        }
    };
    let settings = python_settings(path)?;
    let found = ruff_linter::linter::lint_only(
        path,
        // Package detection only feeds rules that ask "is this file in a
        // package" (import sorting's first-party guess, N999's module-name
        // check). Resolving it means another walk per file for something the
        // stdin path never had either.
        None,
        &settings.linter,
        // What the subprocess ran with by default. `# noqa` is how a Python
        // project silences one line, and honouring it in CI but not in the
        // editor is the split A4 forbids.
        ruff_linter::settings::flags::Noqa::Enabled,
        &source_kind,
        source_type,
        ruff_linter::linter::ParseSource::None,
    );
    let notebook = source_kind
        .as_ipy_notebook()
        .map(ruff_notebook::Notebook::index);
    Ok(found
        .diagnostics
        .iter()
        .filter_map(|diagnostic| python_issue(diagnostic, notebook))
        .collect())
}

/// One ruff diagnostic, read the way `ruff --output-format json` reads it.
///
/// Field for field the same accessors ruff's own JSON emitter calls, so what
/// poly reports is what the subprocess reported rather than a second opinion
/// about the same finding.
fn python_issue(
    diagnostic: &ruff_db::diagnostic::Diagnostic,
    notebook: Option<&ruff_notebook::NotebookIndex>,
) -> Option<Issue> {
    // A diagnostic with no span has no line to sit on. ruff emits one with a
    // null location; the JSON poly used to parse required the field, so such a
    // finding would have failed the whole run. Dropping it is strictly better
    // and, so far, hypothetical.
    let mut start = diagnostic.ruff_start_location()?;
    let mut end = diagnostic.ruff_end_location()?;
    // Notebook rows are relative to the cell, so a bare file:line:col points at
    // the wrong place in the .ipynb -- the cell has to be named, and the row
    // translated into it.
    let cell = notebook.map(|index| {
        // 1 is ruff's own fallback for a row it cannot place in a cell.
        let cell = index.cell(start.line).map_or(1, |cell| cell.get());
        start = index.translate_line_column(&start);
        end = index.translate_line_column(&end);
        cell
    });
    let message = diagnostic.concise_message().to_string();
    Some(Issue {
        line: start.line.get().saturating_sub(1) as u32,
        col: start.column.get().saturating_sub(1) as u32,
        end_line: end.line.get().saturating_sub(1) as u32,
        end_col: end.column.get().saturating_sub(1) as u32,
        // Uniformly a warning, as it was when poly read ruff's JSON: ruff calls
        // every finding an error there, including the style rules, and passing
        // that through would make a missing trailing comma as loud as a syntax
        // error.
        severity: Severity::Warning,
        // `secondary_code_or_id`, not `secondary_code`: a syntax error has no
        // rule code and ruff falls back to the diagnostic's own id, which is
        // how `invalid-syntax` reaches the output. Verified against the 0.16.5
        // binary rather than assumed -- poly's old `unwrap_or("ruff")` never
        // fired, because ruff always sent a code.
        code: diagnostic.secondary_code_or_id().to_string(),
        message: match cell {
            Some(cell) => format!("cell {cell}: {message}"),
            None => message,
        },
        source: "ruff",
        fix: diagnostic
            .fix()
            .map(|fix| match diagnostic.first_help_text() {
                Some(what) => Fix::Described {
                    what: what.to_string(),
                    // "unsafe" is ruff's own word for an edit that can change
                    // behavior; anything short of Safe gets the warning.
                    safe: fix.applicability() == ruff_diagnostics::Applicability::Safe,
                },
                // A fix ruff computed but never titled. It has never been observed,
                // and the old JSON path would have failed to parse it outright.
                None => Fix::Automatic,
            }),
        url: diagnostic.documentation_url().map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_violations_have_positions() {
        let issues = lint("sql", Path::new("a.sql"), "select a,b from t\n").unwrap();
        assert!(!issues.is_empty());
        assert!(issues.iter().all(|i| i.source == "sqruff"));
    }

    /// Every code sqruff can report has to resolve, or the hover is present
    /// for some findings and silently absent for others. The lookup is built
    /// from the same registry the linter runs, so this fails if an upgrade
    /// changes how codes are spelled rather than at a user's cursor.
    #[test]
    fn every_sqruff_rule_has_documentation() {
        let issues = lint(
            "sql",
            Path::new("a.sql"),
            "select a,b from t\nWHERE x = 1;\n",
        )
        .unwrap();
        assert!(issues.len() >= 2, "{issues:?}");
        for issue in &issues {
            let doc = rule_doc(issue.source, &issue.code)
                .unwrap_or_else(|| panic!("no docs for {}/{}", issue.source, issue.code));
            assert!(doc.contains("Best practice"), "{}: {doc}", issue.code);
        }

        // Only the tool that has nothing else to offer. ruff's rules are
        // linked from the diagnostic already; repeating them here would be
        // poly holding a second, staler copy.
        assert!(rule_doc("ruff", "F401").is_none());
        assert!(rule_doc("sqruff", "NOSUCHRULE").is_none());
    }

    /// A real Lua mistake, reported where selene reports it. selene hands over
    /// byte offsets and an editor needs 0-based line and column, so the
    /// position is the substance of this test rather than a detail of it: an
    /// off-by-one here underlines the wrong word in every Lua file.
    #[test]
    fn lua_violations_carry_positions_and_rule_pages() {
        let text = "local function f()\n\tlocal unused = 1\n\treturn nosuchglobal\nend\nreturn f\n";
        let issues = lint("lua", Path::new("a.lua"), text).unwrap();
        assert_eq!(issues.len(), 2, "{issues:?}");
        assert!(issues.iter().all(|i| i.source == "selene"), "{issues:?}");

        // Every number here is what `selene --display-style json2 0.31.0`
        // printed for this file, so a regression in the byte-offset arithmetic
        // shows up as a disagreement with the tool poly replaced rather than
        // with a number somebody typed.
        let unused = &issues[0];
        assert_eq!(unused.code, "unused_variable");
        assert_eq!((unused.line, unused.col), (1, 7), "{unused:?}");
        assert_eq!((unused.end_line, unused.end_col), (1, 13), "{unused:?}");
        assert_eq!(unused.severity, Severity::Warning);
        assert_eq!(
            unused.url.as_deref(),
            Some("https://kampfkarren.github.io/selene/lints/unused_variable.html")
        );

        // The lua51 standard library is what makes this one a finding, and
        // what keeps `print` on the next line from being one.
        let undefined = &issues[1];
        assert_eq!(undefined.code, "undefined_variable");
        assert_eq!(undefined.severity, Severity::Error, "{undefined:?}");
        assert_eq!((undefined.line, undefined.col), (2, 8), "{undefined:?}");
        assert_eq!(
            (undefined.end_line, undefined.end_col),
            (2, 20),
            "{undefined:?}"
        );
        assert!(lint("lua", Path::new("a.lua"), "return print\n")
            .unwrap()
            .is_empty());
    }

    /// Invalid Lua is a finding rather than an error, in selene's own words.
    /// The editor shows it while the line is still half-typed, which is the
    /// one moment a Lua file is guaranteed not to parse.
    #[test]
    fn lua_parse_failures_are_reported_at_their_token() {
        let issues = lint("lua", Path::new("a.lua"), "local x =\nreturn x\n").unwrap();
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert_eq!(issues[0].code, "parse_error");
        assert_eq!(issues[0].severity, Severity::Error);
        assert!(issues[0].line > 0 || issues[0].col > 0, "{:?}", issues[0]);
        // Not a lint, so there is no page to send anyone to.
        assert_eq!(issues[0].url, None);
    }

    /// The project's selene.toml decides, and poly finds it by walking up from
    /// the file. Walking up from poly's own working directory instead would
    /// make the daemon -- started wherever VSCode happened to be -- lint with
    /// defaults while CI lints with the project's rules (A4).
    #[test]
    fn a_projects_selene_toml_governs_its_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        let file = dir.path().join("src/a.lua");
        let text = "local function f()\n\tlocal unused = 1\nend\n";
        std::fs::write(&file, text).unwrap();

        assert!(!lint("lua", &file, text).unwrap().is_empty());
        std::fs::write(
            dir.path().join("selene.toml"),
            "[lints]\nunused_variable = \"allow\"\n",
        )
        .unwrap();
        // A second tempdir, because the checker is cached per config file and
        // the first answer was cached under "no selene.toml here".
        let other = tempfile::tempdir().unwrap();
        std::fs::create_dir(other.path().join("src")).unwrap();
        let governed = other.path().join("src/a.lua");
        std::fs::write(&governed, text).unwrap();
        std::fs::write(
            other.path().join("selene.toml"),
            "[lints]\nunused_variable = \"allow\"\n",
        )
        .unwrap();
        assert_eq!(lint("lua", &governed, text).unwrap().len(), 0);
    }

    /// A std the project ships, loaded from beside its selene.toml. selene
    /// looked in its own working directory as well; poly cannot, and this is
    /// the half that survives -- so it has to keep working, or every Neovim
    /// and Roblox config in the world starts reporting undefined globals.
    #[test]
    fn a_projects_own_standard_library_is_read() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("selene.toml"), "std = \"lua51+game\"\n").unwrap();
        std::fs::write(
            dir.path().join("game.yml"),
            "---\nglobals:\n  hero:\n    property: read-only\n",
        )
        .unwrap();
        let file = dir.path().join("a.lua");
        let text = "return hero\n";
        std::fs::write(&file, text).unwrap();
        let issues = lint("lua", &file, text).unwrap();
        assert!(issues.is_empty(), "{issues:?}");
    }

    /// A Python file in its own directory, with an explicit (empty) ruff.toml.
    ///
    /// Empty rather than absent on purpose: it pins the run to ruff's built-in
    /// rule selection, so the test cannot be swayed by a
    /// `~/.config/ruff/ruff.toml` on whoever's machine is running it.
    fn python_project(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ruff.toml"), "").unwrap();
        for (name, body) in files {
            std::fs::write(dir.path().join(name), body).unwrap();
        }
        dir
    }

    /// The whole record for one finding: position, rule code, the rule's own
    /// page, and ruff's sentence about the edit it would make. Every field
    /// came out of ruff's JSON before this was embedded, and each one is
    /// somewhere a reader looks -- the code in the terminal, the URL as the
    /// hover link, the fix text in both.
    #[test]
    fn python_unused_import_reports_a_placed_fixable_finding() {
        let text = "import os\n\nprint(1)\n";
        let dir = python_project(&[("a.py", text)]);
        let issues = lint("python", &dir.path().join("a.py"), text).unwrap();

        let found = issues
            .iter()
            .find(|i| i.code == "F401")
            .unwrap_or_else(|| panic!("no F401 in {issues:?}"));
        assert_eq!(found.source, "ruff");
        // Uniformly a warning: ruff calls every finding an error in JSON.
        assert_eq!(found.severity, Severity::Warning);
        // 0-based, and pointing at `os` on the first line rather than at 0:0.
        assert_eq!((found.line, found.col), (0, 7));
        assert_eq!((found.end_line, found.end_col), (0, 9));
        assert!(found.message.contains("`os`"), "{found:?}");
        assert_eq!(
            found.url.as_deref(),
            Some("https://docs.astral.sh/ruff/rules/unused-import")
        );
        // ruff is the only tool that ships the remedy in words, and "safe" is
        // its own word for an edit that cannot change behavior.
        match &found.fix {
            Some(Fix::Described { what, safe }) => {
                assert!(what.contains("Remove unused import"), "{what}");
                assert!(*safe, "removing an unused import is a safe fix");
            }
            other => panic!("expected a described fix, got {other:?}"),
        }
    }

    /// An unsafe fix has to stay marked unsafe. It is the one distinction ruff
    /// draws that poly passes through verbatim, and flattening it would have
    /// poly telling people an edit is safe when its author said otherwise.
    #[test]
    fn python_keeps_ruffs_verdict_on_an_unsafe_fix() {
        let text = "def f():\n    x = 1\n    return 2\n";
        let dir = python_project(&[("a.py", text)]);
        let issues = lint("python", &dir.path().join("a.py"), text).unwrap();
        let found = issues
            .iter()
            .find(|i| i.code == "F841")
            .unwrap_or_else(|| panic!("no F841 in {issues:?}"));
        assert!(
            matches!(&found.fix, Some(Fix::Described { safe: false, .. })),
            "{found:?}"
        );
    }

    /// The project's own ruff.toml decides which rules run. This is the whole
    /// reason to resolve the config rather than lint at ruff's defaults: poly's
    /// promise is that the editor and CI agree with the project, and a rule the
    /// project turned off still being reported breaks it in the loudest way.
    #[test]
    fn a_projects_ruff_toml_selects_the_rules() {
        let text = "import os\n\nprint(1)\n";
        let ignored = tempfile::tempdir().unwrap();
        std::fs::write(
            ignored.path().join("ruff.toml"),
            "lint.ignore = [\"F401\"]\n",
        )
        .unwrap();
        let file = ignored.path().join("a.py");
        std::fs::write(&file, text).unwrap();
        let issues = lint("python", &file, text).unwrap();
        assert!(
            !issues.iter().any(|i| i.code == "F401"),
            "the project silenced F401: {issues:?}"
        );

        // And the same file, in a project that did not, still reports it --
        // otherwise this test would pass on a linter that reports nothing.
        let dir = python_project(&[("a.py", text)]);
        let issues = lint("python", &dir.path().join("a.py"), text).unwrap();
        assert!(issues.iter().any(|i| i.code == "F401"), "{issues:?}");
    }

    /// `# noqa` is how a Python project silences one line. The subprocess
    /// honored it by default; the editor and CI both have to keep doing so, or
    /// every suppression in every Python repo starts reappearing.
    #[test]
    fn python_honours_noqa() {
        let text = "import os  # noqa: F401\n\nprint(1)\n";
        let dir = python_project(&[("a.py", text)]);
        let issues = lint("python", &dir.path().join("a.py"), text).unwrap();
        assert!(!issues.iter().any(|i| i.code == "F401"), "{issues:?}");
    }

    /// A syntax error carries ruff's own identifier rather than a rule code.
    ///
    /// `invalid-syntax`, verified against the 0.16.5 binary poly used to
    /// download -- not the literal "ruff" the old JSON path had a fallback
    /// for. That fallback never fired, because ruff always sends a code, and
    /// keeping the real one means `[lint.per-file-ignores]` can name it.
    #[test]
    fn python_syntax_errors_carry_ruffs_own_code() {
        let text = "def f(:\n    return 1\n";
        let dir = python_project(&[("a.py", text)]);
        let issues = lint("python", &dir.path().join("a.py"), text).unwrap();
        assert!(!issues.is_empty(), "a broken file has to report something");
        assert!(
            issues.iter().all(|i| i.code == "invalid-syntax"),
            "{issues:?}"
        );
        // No rule, so no page to link.
        assert!(issues.iter().all(|i| i.url.is_none()), "{issues:?}");
        assert!(issues.iter().all(|i| i.fix.is_none()), "{issues:?}");
    }

    /// A notebook is JSON on disk and Python inside its cells. Linting the
    /// container would report on `"cell_type"`; what has to come back is a
    /// position inside a cell, and the cell named, because `file:line:col`
    /// alone points at the wrong line of the .ipynb.
    #[test]
    fn notebook_findings_are_cell_relative_and_say_which_cell() {
        // r## because a markdown cell's `"# Title` would close an r#" string.
        let notebook = r##"{
 "cells": [
  {"cell_type": "markdown", "metadata": {}, "source": ["# Title\n"]},
  {"cell_type": "code", "execution_count": null, "metadata": {}, "outputs": [],
   "source": ["x = 1\n", "print(x)\n"]},
  {"cell_type": "code", "execution_count": null, "metadata": {}, "outputs": [],
   "source": ["import os\n"]}
 ],
 "metadata": {"language_info": {"name": "python", "version": "3.12.0"}},
 "nbformat": 4,
 "nbformat_minor": 5
}
"##;
        let dir = python_project(&[("nb.ipynb", notebook)]);
        let issues = lint("jupyter", &dir.path().join("nb.ipynb"), notebook).unwrap();
        let found = issues
            .iter()
            .find(|i| i.code == "F401")
            .unwrap_or_else(|| panic!("no F401 in {issues:?}"));
        // Third cell of the notebook, counting the markdown one -- ruff counts
        // every cell, not just the code ones.
        assert!(found.message.starts_with("cell 3: "), "{found:?}");
        // Row 1 *of that cell*, not row 6 of the concatenated source and not a
        // line of the surrounding JSON.
        assert_eq!((found.line, found.col), (0, 7));
    }

    #[test]
    fn unwired_language_is_quiet() {
        assert!(lint("json", Path::new("a.json"), "{}").unwrap().is_empty());
    }

    #[test]
    fn toml_syntax_error_has_a_position() {
        let issues = lint("toml", Path::new("a.toml"), "a = 1\nb = [1, 2\n").unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].source, "toml");
        assert_eq!(issues[0].severity, Severity::Error);
        // Points into the file, not at 0:0, and stays on one line.
        assert!(issues[0].line > 0, "{:?}", issues[0]);
        assert!(!issues[0].message.contains('\n'), "{:?}", issues[0]);
        // Pinned to the spec version the parser implements, not to whatever
        // toml.io currently serves.
        assert_eq!(issues[0].url.as_deref(), Some("https://toml.io/en/v1.0.0"));

        assert!(lint("toml", Path::new("a.toml"), "a = 1\n")
            .unwrap()
            .is_empty());
    }
}

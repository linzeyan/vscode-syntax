//! Embedded lint: sqruff for SQL, selene for Lua, ruff for Python and Jupyter,
//! poly's own rules for Dockerfiles and GitHub Actions workflows, and typos over
//! every file regardless of language. External-tool lint (shellcheck, hadolint,
//! actionlint) lives in poly-tools; the LSP daemon and the CLI merge both
//! sources.
//!
//! Dockerfiles and workflows are the odd ones out and the module doc is the
//! place to say so. Every other engine here is a *substitution*: poly links the
//! same code the tool ships, so the findings are the tool's findings and parity
//! is a testable property. hadolint is Haskell and actionlint is Go; neither can
//! be linked in and neither has a Rust equivalent worth embedding -- so
//! `lint_dockerfile` and `crate::workflow::lint` are reimplementations, their
//! rules are poly's opinions rather than anyone's answers, and each covers only
//! the structural half of what the tool it sits beside reports. See
//! `DOCKER_RULES` and `crate::workflow::RULES`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{anyhow, bail, Context, Result};
use poly_core::diag::{Fix, Issue, Severity};

/// Does this file have an embedded linter? Batch callers use this to avoid
/// reading thousands of files whose lint would return nothing.
///
/// Takes the path as well as the language because YAML is only linted when it
/// is a workflow: a repository of Kubernetes manifests and Helm charts is
/// thousands of YAML files poly has no opinion about, and `is_workflow_file` is
/// the same question `lint` asks below. The two have to agree, which is why
/// neither answers it alone.
///
/// Spelling is not on this list and never can be: see `spell`.
pub fn supported(lang: &str, path: &Path) -> bool {
    match lang {
        "sql" | "toml" | "lua" | "python" | "jupyter" | "dockerfile" => true,
        "yaml" => poly_core::is_workflow_file(path),
        _ => false,
    }
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
/// `poly` is the second, and for the same reason rather than a new one: the
/// Dockerfile and workflow rules are poly's own, so there is no upstream page to
/// send anyone to and the prose has to ship in the binary. This does not loosen
/// the policy below -- poly still does not paraphrase somebody else's rule, it
/// documents the ones it wrote.
///
/// `None` is the answer for everything else, deliberately: poly does not
/// paraphrase a tool's rules, it repeats what the tool itself says.
pub fn rule_doc(source: &str, code: &str) -> Option<&'static str> {
    match source {
        "sqruff" => {
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
        // One namespace for every rule poly wrote, two tables behind it: the
        // codes are already prefixed by what they lint (`docker-`, `actions-`),
        // so a third engine adds a table here rather than a second source name
        // the reader has to learn.
        "poly" => DOCKER_RULES
            .iter()
            .chain(crate::workflow::RULES)
            .find(|(rule, _)| *rule == code)
            .map(|(_, doc)| *doc),
        _ => None,
    }
}

/// Lint `text` as `lang` with embedded engines only. Languages without one
/// return no issues.
pub fn lint(lang: &str, path: &Path, text: &str) -> Result<Vec<Issue>> {
    match lang {
        "sql" => lint_sql(text),
        "toml" => Ok(lint_toml(text)),
        "lua" => lint_lua(path, text),
        "python" | "jupyter" => lint_python(path, text),
        "dockerfile" => Ok(lint_dockerfile(text)),
        // A workflow is YAML, so this is the one arm that reads the path as well
        // as the language: `poly check` on a Kubernetes repository must not
        // report `unknown workflow key` on every manifest in it.
        "yaml" if poly_core::is_workflow_file(path) => Ok(crate::workflow::lint(text)),
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
pub(crate) fn line_col(text: &str, offset: usize) -> (u32, u32) {
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

// ── dockerfile (poly's own rules) ──────────────────────────────────────────

/// Every Dockerfile rule poly has, with the prose `rule_doc` serves for it.
///
/// The codes are poly's own -- `docker-untagged-base`, not `hadolint/DL3006`.
/// That is the whole difference between this engine and the others: linking
/// sqruff or ruff means reporting *their* findings under *their* codes, because
/// the implementation is theirs. Here the implementation is poly's, so claiming
/// DL3006 would put poly's behaviour behind hadolint's name and behind a wiki
/// page describing something poly did not run. A descriptive name needs no
/// lookup and promises nothing it does not deliver.
///
/// One table rather than a doc string beside each emitter, because a rule with
/// no explanation is worse here than anywhere else: poly's own rules have no
/// documentation site, so an undocumented code reaches a reader as four words
/// in a terminal with nothing behind them. `every_docker_rule_is_documented`
/// holds this list and the codes the linter emits to the same set, in both
/// directions.
const DOCKER_RULES: &[(&str, &str)] = &[
    (
        "docker-add-instead-of-copy",
        "`ADD` does three jobs: it copies, it downloads URLs, and it unpacks \
         local tar archives in place. Only the first is usually meant, and the \
         other two happen silently -- a source that turns out to be a tarball \
         arrives extracted, and one that turns out to be a URL is fetched at \
         build time with no checksum and no cache. `COPY` copies. Use `ADD` \
         when the extraction is the point, and say so.",
    ),
    (
        "docker-apk-no-cache",
        "`apk add` writes a package index under /var/cache/apk that nothing \
         reads again, and it stays in the layer forever. `--no-cache` fetches \
         the index, uses it, and never writes it -- equivalent to \
         `apk update && apk add && rm -rf /var/cache/apk/*` in one flag, and \
         with no way to forget the last third.",
    ),
    (
        "docker-apk-unpinned",
        "`apk add curl` installs whichever curl the Alpine mirror serves today. \
         The same Dockerfile then builds different software next week, and a \
         build that worked cannot be reproduced to find out what changed. \
         `apk add curl=8.5.0-r0` says which one.",
    ),
    (
        "docker-apt-get-interactive",
        "Without `-y`, `apt-get install` asks for a confirmation. A build has no \
         terminal to type it into, so apt reads EOF and aborts -- or, worse, \
         waits. This is a broken build, not a style preference.",
    ),
    (
        "docker-apt-get-no-clean",
        "`apt-get update` leaves tens of megabytes of package lists under \
         /var/lib/apt/lists. Nothing reads them after the install, and deleting \
         them in a *later* layer does not shrink the image -- the bytes are \
         already committed. `rm -rf /var/lib/apt/lists/*` has to be in the same \
         `RUN`. A `RUN --mount=type=cache` over the apt directories is the other \
         answer, and this rule does not fire on one.",
    ),
    (
        "docker-apt-get-no-recommends",
        "Debian's recommended packages are installed by default and are \
         routinely larger than what was asked for -- a build tool pulling in a \
         documentation set, a client pulling in a server. Every one of them is \
         software in the image that nobody chose and nobody audits. \
         `--no-install-recommends` installs what the line says.",
    ),
    (
        "docker-apt-get-unpinned",
        "`apt-get install curl` installs whichever curl the archive serves \
         today, so the same Dockerfile builds different software over time and a \
         build that worked cannot be reproduced. `curl=7.88.1-10` says which \
         one. The counter-argument is real and worth stating: Debian and Ubuntu \
         drop the superseded version the moment a security update lands, so a \
         pin can make the image stop building on somebody else's schedule. That \
         is a reason to silence this rule for a package, with the reason \
         written down -- not a reason it is wrong.",
    ),
    (
        "docker-apt-get-update-alone",
        "An `apt-get update` in its own `RUN` becomes a layer Docker will \
         happily reuse for months. The `apt-get install` in the next `RUN` then \
         resolves against a package index from whenever that layer was built, \
         and installs versions the mirror no longer has -- a 404 in the middle \
         of a build that changed nothing. Update and install in one `RUN` so \
         they are cached or invalidated together.",
    ),
    (
        "docker-cd-in-run",
        "A `cd` inside `RUN` lasts exactly as long as that instruction's shell. \
         The next `RUN` starts back where the last `WORKDIR` left it, so a file \
         written by the line below lands somewhere other than the line above \
         suggests. `WORKDIR` changes the directory for everything after it, and \
         is visible in `docker inspect`.",
    ),
    (
        "docker-copy-multiple-sources-no-slash",
        "With more than one source, `COPY` requires the destination to be a \
         directory, and the way to say so is a trailing slash. Without it the \
         build fails outright -- and on the day someone deletes one of the \
         sources it stops failing and starts silently copying a single file to \
         the destination *name*.",
    ),
    (
        "docker-duplicate-env-key",
        "Only the last `ENV` for a key survives into the image. The earlier one \
         is dead, and there is nothing in the file to say which of the two the \
         author meant -- the reader has to know that later wins.",
    ),
    (
        "docker-duplicate-label-key",
        "Only the last `LABEL` for a key survives into the image metadata. The \
         earlier one is dead, and a reader looking for the version an image \
         claims has two answers in front of them and no way to tell which one \
         `docker inspect` will print.",
    ),
    (
        "docker-invalid-port",
        "`EXPOSE` takes a TCP or UDP port: a number in 1..=65535, optionally \
         `/tcp` or `/udp`, optionally a range. Anything else is either a typo or \
         a misunderstanding of what the instruction takes, and Docker rejects \
         it at build time.",
    ),
    (
        "docker-latest-base",
        "`latest` is a tag that moves. The image that built and passed its tests \
         yesterday is not the image the same Dockerfile pulls today, and there \
         is nothing in the repository recording which one it was. Name the \
         version, or pin a digest with `@sha256:...` if the version itself is \
         not enough.",
    ),
    (
        "docker-maintainer-deprecated",
        "`MAINTAINER` has been deprecated since Docker 1.13 and its value is not \
         part of the image's structured metadata. \
         `LABEL org.opencontainers.image.authors=\"...\"` is the replacement, is \
         in the OCI spec, and can be read back out of any registry.",
    ),
    (
        "docker-missing-from",
        "A build starts from a base image, so the first instruction has to be \
         `FROM` (an `ARG` used to parameterise it may come before). Anything \
         else is a file that does not build.",
    ),
    (
        "docker-multiple-cmd",
        "Only the last `CMD` in a stage has any effect. An earlier one is dead \
         and reads as though it applies -- the usual cause is a second `CMD` \
         added without noticing the first.",
    ),
    (
        "docker-multiple-entrypoint",
        "Only the last `ENTRYPOINT` in a stage has any effect. An earlier one is \
         dead and reads as though it applies, and unlike a dead `CMD` there is \
         nothing at runtime that hints the container is starting something other \
         than what the first line named.",
    ),
    (
        "docker-pip-unpinned",
        "`pip install requests` installs whatever PyPI serves at build time, \
         including major versions released after the Dockerfile was written. \
         `requests==2.31.0`, or a requirements file that pins, makes the build \
         repeatable and makes an upgrade a reviewable change rather than a \
         Tuesday.",
    ),
    (
        "docker-pipe-without-pipefail",
        "`/bin/sh` reports the exit status of the *last* command in a pipeline. \
         `RUN curl ... | tar x` therefore succeeds when curl 404s, because tar \
         cheerfully unpacked nothing, and the failure surfaces much later as a \
         missing file. `SHELL [\"/bin/bash\", \"-o\", \"pipefail\", \"-c\"]` \
         makes the pipeline fail where it broke.",
    ),
    (
        "docker-root-user",
        "With no `USER`, the container's process runs as root -- root in the \
         container is root on the host kernel, and the only thing between them \
         is the namespace. It is also the account that ends up owning every file \
         the container writes to a mounted volume. A `USER` in the final stage \
         is the one-line version of not relying on that. Some images genuinely \
         have to run as root; that is worth silencing per file with the reason \
         written down.",
    ),
    (
        "docker-secret-in-env",
        "`ENV` and `ARG` values are baked into the image and are readable with \
         `docker history` by anyone who can pull it -- deleting the file later \
         does not remove them, because the layer that set them is still there. \
         A build-time secret belongs in `RUN --mount=type=secret`; a run-time \
         one belongs in the runtime environment, not the image.",
    ),
    (
        "docker-shell-form-command",
        "The shell form wraps the process in `/bin/sh -c`, which becomes PID 1 \
         and does not forward signals to its child. `docker stop` then reaches \
         the shell, the real process never sees SIGTERM, and the container is \
         SIGKILLed ten seconds later mid-write. The exec form \
         (`[\"prog\", \"arg\"]`) makes the process itself PID 1.",
    ),
    (
        "docker-sudo-in-run",
        "A `RUN` already runs as whatever the last `USER` said, which is root \
         unless the file says otherwise -- so `sudo` is either doing nothing or \
         is not installed. It also needs a TTY it does not have. If the step \
         needs different privileges, `USER` is how a Dockerfile says so.",
    ),
    (
        "docker-untagged-base",
        "An image reference with no tag means `:latest`, which is a tag that \
         moves. The same Dockerfile builds different software on different days \
         and nothing in the repository records which base it was. Name a \
         version, or pin a digest with `@sha256:...`.",
    ),
    (
        "docker-workdir-relative",
        "A relative `WORKDIR` resolves against whatever the previous one left \
         behind, so inserting an instruction above it silently moves everything \
         below. An absolute path means the same thing wherever it appears in the \
         file.",
    ),
];

/// Byte range into the Dockerfile text, from the parser's own spans.
type DockerSpan = dprint_plugin_dockerfile::ast::Span;

/// One finding, anchored on the line the offending text starts on.
///
/// The end is clamped to that line: a `RUN` continued over twelve lines is one
/// instruction with one span, and underlining all of it fills the screen for a
/// complaint about one word. Every tool that reports on Dockerfiles marks a
/// line, and so does this.
fn docker_issue(
    text: &str,
    at: usize,
    end: usize,
    code: &str,
    severity: Severity,
    message: String,
    fix: Option<Fix>,
) -> Issue {
    let (line, col) = line_col(text, at);
    let line_end = text[at.min(text.len())..]
        .find('\n')
        .map_or(text.len(), |i| at + i);
    // A caller with no narrower end than "this instruction" gets the line
    // instead. An instruction's span can cover a dozen continued lines, and
    // underlining all of them to complain about one package name is a squiggle
    // over the whole screen.
    let end = if end > at && end <= line_end {
        end
    } else {
        line_end
    };
    let (end_line, end_col) = line_col(text, end);
    Issue {
        line,
        col,
        end_line,
        end_col,
        severity,
        code: code.to_string(),
        message,
        // poly's own rules, under poly's own name. See `DOCKER_RULES`.
        source: "poly",
        fix,
        // There is no page to link: the prose is in `DOCKER_RULES` and reaches
        // the editor through `rule_doc`.
        url: None,
    }
}

/// Where `needle` sits inside the instruction at `span`, as an absolute offset.
///
/// Falls back to the start of the instruction. Findings about one word of a
/// long `RUN` -- an unpinned package, a `cd` -- are worth pointing at rather
/// than aiming at the keyword, and the parser hands over spans for
/// instructions, not for the words inside a shell command it never parsed.
fn docker_locate(text: &str, span: DockerSpan, needle: &str) -> usize {
    let end = span.end.min(text.len());
    let Some(slice) = text.get(span.start..end) else {
        return span.start;
    };
    slice
        .match_indices(needle)
        .find(|(i, _)| {
            let before = slice[..*i].chars().next_back();
            let after = slice[i + needle.len()..].chars().next();
            let boundary = |c: Option<char>| {
                c.is_none_or(|c| !c.is_alphanumeric() && !matches!(c, '_' | '-' | '.' | '/'))
            };
            boundary(before) && boundary(after)
        })
        .map_or(span.start, |(i, _)| span.start + i)
}

/// One command out of a `RUN` body, with the paren depth it runs at.
struct DockerCommand {
    words: Vec<String>,
    depth: usize,
}

impl DockerCommand {
    fn name(&self) -> &str {
        self.words.first().map_or("", String::as_str)
    }

    fn has_flag(&self, flag: &str) -> bool {
        self.words.iter().any(|w| w == flag)
    }

    /// The first non-flag word after the command name -- `install` in
    /// `apt-get -y install curl`.
    fn subcommand(&self) -> &str {
        self.words
            .iter()
            .skip(1)
            .find(|w| !w.starts_with('-'))
            .map_or("", String::as_str)
    }

    /// The operands after the subcommand: the packages, without the flags.
    fn operands(&self) -> impl Iterator<Item = &String> {
        self.words
            .iter()
            .skip(1)
            .filter(|w| !w.starts_with('-'))
            .skip(1)
    }
}

/// The commands a `RUN` body runs, plus whether any of them was piped into
/// another.
///
/// Deliberately not a shell parser. Quotes are honoured so a `;` inside a
/// string does not split a command and `\` continues a word, and that is the
/// end of it: every rule below asks only "what is this command called and which
/// flags did it get", which survives the approximation. Anything needing more
/// than that is the shellcheck-shaped analysis poly does not attempt here --
/// see the module doc.
fn docker_commands(body: &str) -> (Vec<DockerCommand>, bool) {
    let mut commands: Vec<DockerCommand> = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut depth = 0usize;
    let mut piped = false;
    let mut quote: Option<char> = None;
    let mut chars = body.chars().peekable();

    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            started = true;
            match c {
                _ if c == q => quote = None,
                // Only a double-quoted string honours backslash escapes; inside
                // single quotes a backslash is a backslash.
                '\\' if q == '"' => {
                    if let Some(next) = chars.next() {
                        word.push(next);
                    }
                }
                _ => word.push(c),
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                started = true;
            }
            '\\' => {
                if let Some(next) = chars.next() {
                    word.push(next);
                    started = true;
                }
            }
            '&' | '|' | ';' | '\n' | '(' | ')' => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
                match c {
                    // `||` is a fallback, not a pipeline; only a lone `|` sends
                    // one command's output into the next, which is the case the
                    // pipefail rule is about.
                    '|' if chars.peek() == Some(&'|') => {
                        chars.next();
                    }
                    '|' => piped = true,
                    '&' if chars.peek() == Some(&'&') => {
                        chars.next();
                    }
                    _ => {}
                }
                if !words.is_empty() {
                    commands.push(DockerCommand {
                        words: std::mem::take(&mut words),
                        depth,
                    });
                }
                match c {
                    '(' => depth += 1,
                    ')' => depth = depth.saturating_sub(1),
                    _ => {}
                }
            }
            c if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            _ => {
                word.push(c);
                started = true;
            }
        }
    }
    if started {
        words.push(word);
    }
    if !words.is_empty() {
        commands.push(DockerCommand { words, depth });
    }
    (commands, piped)
}

/// The text of a breakable string, with the line continuations closed up and
/// the comment lines dropped.
///
/// A comment inside a `RUN` is not part of the command, but the shell would see
/// the words either side of it joined, so the pieces are joined with a space
/// rather than concatenated -- otherwise `RUN a \` / `# note` / `&& b` would
/// read as one word.
fn docker_breakable(value: &dprint_plugin_dockerfile::ast::BreakableString<'_>) -> String {
    use dprint_plugin_dockerfile::ast::BreakableStringComponent as Component;
    value
        .components
        .iter()
        .filter_map(|component| match component {
            Component::String(s) => Some(s.content.as_ref()),
            Component::Comment(_) => None,
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The shell text of a `RUN`/`CMD`/`ENTRYPOINT` argument, whichever form it is
/// written in. The exec form is not run through a shell at all, so its elements
/// are joined only so the "which command is this" rules can read them.
fn docker_expr_text(expr: &dprint_plugin_dockerfile::ast::ShellOrExecExpr<'_>) -> String {
    use dprint_plugin_dockerfile::ast::ShellOrExecExpr;
    match expr {
        ShellOrExecExpr::Shell(shell) => docker_breakable(shell),
        ShellOrExecExpr::Exec(array) => array
            .elements
            .iter()
            .map(|e| e.content.as_ref())
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// The tag part of an image reference, or `None` for an untagged one.
///
/// The colon in `localhost:5000/img` belongs to the registry, not to a tag, so
/// only the part after the last `/` is searched.
fn docker_image_tag(image: &str) -> Option<&str> {
    let name = image.rsplit('/').next().unwrap_or(image);
    name.split_once(':').map(|(_, tag)| tag)
}

/// The state one build stage accumulates, reset at every `FROM`.
///
/// Per stage rather than per file because that is the scope Docker gives each
/// of these: a new `FROM` starts with none of the previous stage's `ENV`,
/// `USER`, `SHELL`, `CMD` or `ENTRYPOINT`.
#[derive(Default)]
struct DockerStage {
    /// Where to anchor a finding about the stage as a whole.
    from: usize,
    env: std::collections::HashSet<String>,
    labels: std::collections::HashSet<String>,
    cmds: usize,
    entrypoints: usize,
    /// The argument of the last `USER`, if the stage has one.
    user: Option<String>,
    /// A `SHELL` in this stage that turned on `pipefail`.
    pipefail: bool,
}

/// Lint a Dockerfile against poly's own rules.
///
/// A parse failure returns nothing rather than an error. The parser here is a
/// formatter's, and lenient by construction -- a line it cannot make sense of
/// becomes `Instruction::Unknown` and the file still parses -- so a hard failure
/// means a file so far outside the grammar that there are no instructions to
/// have an opinion about, and `poly fmt` already refuses it with a position.
fn lint_dockerfile(text: &str) -> Vec<Issue> {
    use dprint_plugin_dockerfile::ast::{CopyArgs, Dockerfile, Instruction, ShellOrExecExpr};

    let Ok(file) = Dockerfile::parse(text) else {
        return Vec::new();
    };
    let mut found: Vec<Issue> = Vec::new();
    let mut stage = DockerStage::default();
    let mut stages: Vec<DockerStage> = Vec::new();
    // Stage names, so a later `FROM build` is read as "the stage above" rather
    // than as an untagged image on Docker Hub.
    let mut aliases: Vec<String> = Vec::new();
    let mut seen_from = false;
    let mut said_missing_from = false;

    for instruction in &file.instructions {
        // A heredoc wraps the instruction that opened it; the body is the shell
        // script, so it is appended to the command text below.
        let (instruction, heredoc) = match instruction {
            Instruction::Heredoc(h) => (h.instruction.as_ref(), Some(h.body)),
            other => (other, None),
        };
        let span = instruction.span();

        // ONBUILD is skipped whole: the instruction it carries runs in someone
        // else's build, against a base image and a working directory this file
        // does not describe. Reporting on it here reports on a Dockerfile that
        // does not exist yet.
        if matches!(instruction, Instruction::Onbuild(_)) {
            continue;
        }
        // A line the parser could not place. It is kept verbatim so formatting
        // never fails on it, and poly declines to guess what it meant.
        if matches!(instruction, Instruction::Unknown(_)) {
            continue;
        }

        if !seen_from && !said_missing_from {
            match instruction {
                Instruction::From(_) => {}
                // An ARG before the first FROM is how the base image itself is
                // parameterised, and is the one thing Docker allows up there.
                Instruction::Arg(_) => {}
                _ => {
                    said_missing_from = true;
                    found.push(docker_issue(
                        text,
                        span.start,
                        span.end,
                        "docker-missing-from",
                        Severity::Error,
                        "a build has to start from a base image: the first \
                         instruction should be FROM"
                            .to_string(),
                        None,
                    ));
                }
            }
        }

        match instruction {
            Instruction::From(from) => {
                // A new FROM closes the stage above it: none of its ENV, USER,
                // SHELL, CMD or ENTRYPOINT carries over.
                if seen_from {
                    stages.push(std::mem::take(&mut stage));
                }
                seen_from = true;
                stage = DockerStage {
                    from: span.start,
                    ..DockerStage::default()
                };
                if let Some(alias) = &from.alias {
                    aliases.push(alias.content.to_lowercase());
                }
                let image = from.image.content.as_ref();
                let is_stage = aliases.iter().any(|a| a == &image.to_lowercase());
                // `scratch` is the empty image and has no tag to give it; `$FOO`
                // is decided by an ARG poly cannot resolve; a digest already
                // pins the thing a tag would only name.
                if is_stage || image == "scratch" || image.contains('$') || image.contains('@') {
                    continue;
                }
                match docker_image_tag(image) {
                    None => found.push(docker_issue(
                        text,
                        from.image.span.start,
                        from.image.span.end,
                        "docker-untagged-base",
                        Severity::Warning,
                        format!("`{image}` has no tag, so the build pulls whatever `latest` points at today"),
                        None,
                    )),
                    Some("latest") => found.push(docker_issue(
                        text,
                        from.image.span.start,
                        from.image.span.end,
                        "docker-latest-base",
                        Severity::Warning,
                        format!("`{image}` is a tag that moves: name the version the build was tested against"),
                        None,
                    )),
                    Some(_) => {}
                }
            }
            Instruction::Run(run) => {
                let mut body = docker_expr_text(&run.expr);
                if let Some(heredoc) = heredoc {
                    body.push('\n');
                    body.push_str(heredoc);
                }
                docker_run_rules(text, span, &body, &mut stage, &mut found);
            }
            Instruction::Cmd(cmd) => {
                stage.cmds += 1;
                if stage.cmds > 1 {
                    found.push(docker_issue(
                        text,
                        span.start,
                        span.end,
                        "docker-multiple-cmd",
                        Severity::Warning,
                        "only the last CMD in a stage has any effect".to_string(),
                        None,
                    ));
                }
                if matches!(cmd.expr, ShellOrExecExpr::Shell(_)) {
                    found.push(docker_shell_form(text, span, "CMD"));
                }
            }
            Instruction::Entrypoint(entrypoint) => {
                stage.entrypoints += 1;
                if stage.entrypoints > 1 {
                    found.push(docker_issue(
                        text,
                        span.start,
                        span.end,
                        "docker-multiple-entrypoint",
                        Severity::Warning,
                        "only the last ENTRYPOINT in a stage has any effect".to_string(),
                        None,
                    ));
                }
                if matches!(entrypoint.expr, ShellOrExecExpr::Shell(_)) {
                    found.push(docker_shell_form(text, span, "ENTRYPOINT"));
                }
            }
            Instruction::Shell(shell) => {
                stage.pipefail = docker_expr_text(&shell.expr).contains("pipefail");
            }
            Instruction::Env(env) => {
                for var in &env.vars {
                    let key = var.key.content.as_ref();
                    if !stage.env.insert(key.to_string()) {
                        found.push(docker_issue(
                            text,
                            var.key.span.start,
                            var.key.span.end,
                            "docker-duplicate-env-key",
                            Severity::Warning,
                            format!("`{key}` is set more than once in this stage; only the last one survives"),
                            None,
                        ));
                    }
                    if let Some(issue) = docker_secret(
                        text,
                        var.key.span,
                        key,
                        &docker_breakable(&var.value),
                        "ENV",
                    ) {
                        found.push(issue);
                    }
                }
            }
            Instruction::Arg(arg) => {
                if let Some(value) = &arg.value {
                    if let Some(issue) = docker_secret(
                        text,
                        arg.name.span,
                        arg.name.content.as_ref(),
                        value.content.as_ref(),
                        "ARG",
                    ) {
                        found.push(issue);
                    }
                }
            }
            Instruction::Label(label) => {
                for one in &label.labels {
                    let key = one.name.content.as_ref();
                    if !stage.labels.insert(key.to_string()) {
                        found.push(docker_issue(
                            text,
                            one.name.span.start,
                            one.name.span.end,
                            "docker-duplicate-label-key",
                            Severity::Warning,
                            format!("`{key}` is labelled more than once in this stage; only the last one survives"),
                            None,
                        ));
                    }
                }
            }
            Instruction::Copy(copy) => {
                let (sources, destination) = match &copy.args {
                    CopyArgs::Paths {
                        sources,
                        destination,
                    } => (
                        sources.len(),
                        Some(destination.content.as_ref().to_string()),
                    ),
                    // `COPY ["a", "b", "dest"]`: the last element is the
                    // destination, the rest are sources.
                    CopyArgs::Exec(array) => (
                        array.elements.len().saturating_sub(1),
                        array.elements.last().map(|e| e.content.to_string()),
                    ),
                };
                if let Some(destination) = destination {
                    if sources > 1 && !docker_is_directory(&destination) {
                        found.push(docker_issue(
                            text,
                            span.start,
                            span.end,
                            "docker-copy-multiple-sources-no-slash",
                            Severity::Error,
                            format!(
                                "COPY has {sources} sources, so `{destination}` has to end in `/` to be a directory"
                            ),
                            Some(Fix::Described {
                                what: format!("Write the destination as `{destination}/`"),
                                safe: true,
                            }),
                        ));
                    }
                }
            }
            Instruction::Misc(misc) => {
                let keyword = misc.instruction.content.to_lowercase();
                let arguments = docker_breakable(&misc.arguments);
                docker_misc_rules(text, span, &keyword, &arguments, &mut stage, &mut found);
            }
            // Healthcheck carries a nested CMD; the shell-form argument applies
            // to a health probe far less than to PID 1, and the multiple-CMD
            // count must not see it.
            Instruction::Healthcheck(_)
            | Instruction::Onbuild(_)
            | Instruction::Heredoc(_)
            | Instruction::Unknown(_) => {}
        }
    }

    if seen_from {
        stages.push(stage);
        // Only the last stage becomes the image. An earlier one is a build
        // stage whose filesystem is thrown away, so it running as root is not a
        // property of anything that ships.
        if let Some(last) = stages.last() {
            let complaint = match last.user.as_deref() {
                None => Some("no USER, so the container's process runs as root".to_string()),
                Some(user) if docker_is_root(user) => Some(format!("the last USER is `{user}`")),
                Some(_) => None,
            };
            if let Some(complaint) = complaint {
                found.push(docker_issue(
                    text,
                    last.from,
                    last.from,
                    "docker-root-user",
                    Severity::Warning,
                    format!("{complaint}: root in the container is root on the host kernel"),
                    None,
                ));
            }
        }
    }

    found.sort_by_key(|issue| (issue.line, issue.col));
    found
}

fn docker_shell_form(text: &str, span: DockerSpan, keyword: &str) -> Issue {
    docker_issue(
        text,
        span.start,
        span.end,
        "docker-shell-form-command",
        Severity::Warning,
        format!(
            "{keyword} in shell form runs under `/bin/sh -c`, which becomes PID 1 \
             and does not forward SIGTERM to the real process"
        ),
        None,
    )
}

/// Is `destination` something `COPY` will treat as a directory?
///
/// `.` and `..` are directories without a slash, and a destination built out of
/// a variable could end in one -- poly does not know what the variable holds and
/// does not guess.
fn docker_is_directory(destination: &str) -> bool {
    destination.ends_with('/')
        || destination.ends_with('\\')
        || destination == "."
        || destination == ".."
        || destination.ends_with("/.")
        || destination.contains('$')
}

/// `USER root`, however it is spelled. The group half of `root:root` says
/// nothing about the account the process runs as.
fn docker_is_root(user: &str) -> bool {
    matches!(user.split(':').next().unwrap_or(user), "root" | "0")
}

/// The instructions the parser does not give a dedicated node to: `WORKDIR`,
/// `USER`, `EXPOSE`, `ADD`, `MAINTAINER` and the rest all arrive as a keyword
/// plus an argument string.
fn docker_misc_rules(
    text: &str,
    span: DockerSpan,
    keyword: &str,
    arguments: &str,
    stage: &mut DockerStage,
    found: &mut Vec<Issue>,
) {
    let words: Vec<&str> = arguments.split_whitespace().collect();
    match keyword {
        "workdir" => {
            let Some(path) = words.first() else { return };
            // A variable could hold an absolute path; a Windows container's
            // `C:\app` is absolute in the way that matters.
            if path.starts_with('/')
                || path.starts_with('$')
                || path.contains(":\\")
                || path.starts_with('\\')
            {
                return;
            }
            found.push(docker_issue(
                text,
                docker_locate(text, span, path),
                span.end,
                "docker-workdir-relative",
                Severity::Warning,
                format!(
                    "`{path}` is relative, so it resolves against whatever WORKDIR came before it"
                ),
                None,
            ));
        }
        "user" => {
            if let Some(user) = words.first() {
                stage.user = Some((*user).to_string());
            }
        }
        "maintainer" => found.push(docker_issue(
            text,
            span.start,
            span.end,
            "docker-maintainer-deprecated",
            Severity::Info,
            "MAINTAINER was deprecated in Docker 1.13 and is not part of the image's metadata"
                .to_string(),
            Some(Fix::Described {
                what: format!(
                    "Use `LABEL org.opencontainers.image.authors=\"{}\"`",
                    arguments.trim()
                ),
                safe: true,
            }),
        )),
        "expose" => {
            for port in &words {
                if port.contains('$') {
                    continue;
                }
                if docker_port_valid(port) {
                    continue;
                }
                found.push(docker_issue(
                    text,
                    docker_locate(text, span, port),
                    span.end,
                    "docker-invalid-port",
                    Severity::Error,
                    format!(
                        "`{port}` is not a port: EXPOSE takes 1..=65535, optionally /tcp or /udp"
                    ),
                    None,
                ));
            }
        }
        "add" => {
            let paths: Vec<&&str> = words.iter().filter(|w| !w.starts_with("--")).collect();
            let Some((_, sources)) = paths.split_last() else {
                return;
            };
            // The two things ADD does that COPY cannot: fetch a URL, and unpack
            // a local tar archive. Either is a reason to have written ADD.
            let deliberate = sources.iter().any(|source| {
                source.starts_with("http://")
                    || source.starts_with("https://")
                    || source.starts_with("git@")
                    || source.contains(".git#")
                    || docker_is_archive(source)
            });
            if deliberate || sources.is_empty() {
                return;
            }
            found.push(docker_issue(
                text,
                span.start,
                span.end,
                "docker-add-instead-of-copy",
                Severity::Warning,
                "ADD also downloads URLs and unpacks archives; COPY only copies".to_string(),
                Some(Fix::Described {
                    what: "Use COPY".to_string(),
                    safe: true,
                }),
            ));
        }
        _ => {}
    }
}

/// The extensions `ADD` unpacks in place. `.zip` is deliberately not among
/// them: Docker does not extract it, so an `ADD` of one is still just a copy.
fn docker_is_archive(source: &str) -> bool {
    [
        ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar.zst", ".gz",
        ".bz2", ".xz",
    ]
    .iter()
    .any(|extension| source.ends_with(extension))
}

fn docker_port_valid(port: &str) -> bool {
    let port = port.split('/').next().unwrap_or(port);
    let number = |value: &str| value.parse::<u32>().is_ok_and(|n| (1..=65535).contains(&n));
    match port.split_once('-') {
        Some((low, high)) => number(low) && number(high),
        None => number(port),
    }
}

/// Names whose value is a credential often enough that a literal one in the
/// image is worth a second look. Matched as substrings of the upper-cased key.
const DOCKER_SECRET_MARKERS: &[&str] = &[
    "PASSWORD",
    "PASSWD",
    "SECRET",
    "TOKEN",
    "APIKEY",
    "API_KEY",
    "ACCESS_KEY",
    "PRIVATE_KEY",
    "CREDENTIAL",
];

/// A credential-shaped `ENV` or `ARG` with a literal value.
///
/// Deliberately narrow, because the cost of a false positive here is a reader
/// learning to ignore the rule. A key naming a *file* or a *path* to a secret is
/// not a secret; neither is one whose value is another variable, or empty, or a
/// boolean -- in each of those cases the image is carrying a reference, which is
/// exactly what the rule is asking for.
fn docker_secret(
    text: &str,
    span: DockerSpan,
    key: &str,
    value: &str,
    keyword: &str,
) -> Option<Issue> {
    let upper = key.to_uppercase();
    if upper.ends_with("_FILE") || upper.ends_with("_PATH") {
        return None;
    }
    if !DOCKER_SECRET_MARKERS
        .iter()
        .any(|marker| upper.contains(marker))
    {
        return None;
    }
    let value = value.trim();
    let literal = !value.is_empty()
        && !value.contains('$')
        && !value.starts_with('/')
        && !value.starts_with("./")
        && !matches!(value.to_lowercase().as_str(), "true" | "false" | "none");
    if !literal {
        return None;
    }
    Some(docker_issue(
        text,
        span.start,
        span.end,
        "docker-secret-in-env",
        Severity::Warning,
        format!(
            "{keyword} `{key}` bakes a literal value into the image, where \
             `docker history` reads it back"
        ),
        None,
    ))
}

/// `pip`, or the same program called by the interpreter version it belongs to:
/// `pip3`, `pip3.7`, `pip2.7`. Anything after the digits has to be a version,
/// so `pipenv` and `pip-compile` -- different programs with different
/// arguments -- are not mistaken for it.
fn docker_is_pip(name: &str) -> bool {
    name.strip_prefix("pip").is_some_and(|rest| {
        rest.chars().all(|c| c.is_ascii_digit() || c == '.')
            && !rest.starts_with('.')
            && !rest.ends_with('.')
    })
}

/// The command underneath the words that are not the command.
///
/// `DEBIAN_FRONTEND=noninteractive apt-get install ...` is one of the most
/// common shapes there is in a real Dockerfile, and reading its name as
/// `DEBIAN_FRONTEND=noninteractive` makes every apt rule below quietly stop
/// applying to it -- a linter that reports nothing on the files that need it
/// most. `sudo` and `env` are the same problem spelled as words. Measured
/// against a corpus of 248 Dockerfiles, this one function was the difference on
/// 11 of them.
fn docker_unwrap(command: &DockerCommand) -> DockerCommand {
    let mut words = command.words.as_slice();
    while let Some(first) = words.first() {
        let assignment = first.split_once('=').is_some_and(|(name, _)| {
            !name.is_empty()
                && !name.starts_with(|c: char| c.is_ascii_digit())
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        });
        if !assignment && !matches!(first.as_str(), "sudo" | "env" | "command" | "exec") {
            break;
        }
        words = &words[1..];
    }
    DockerCommand {
        words: words.to_vec(),
        depth: command.depth,
    }
}

/// Every rule that reads the shell inside a `RUN`.
fn docker_run_rules(
    text: &str,
    span: DockerSpan,
    body: &str,
    stage: &mut DockerStage,
    found: &mut Vec<Issue>,
) {
    let (mut commands, piped) = docker_commands(body);
    // `RUN --mount=...` flags are not parsed as flags -- they land at the front
    // of the shell text -- so the first command starts with them. A cache mount
    // over the package directories is a real answer to the "clean up after
    // yourself" rules below, so it is read out before they run.
    let mut mounts: Vec<String> = Vec::new();
    if let Some(first) = commands.first_mut() {
        while first
            .words
            .first()
            .is_some_and(|word| word.starts_with("--"))
        {
            mounts.push(first.words.remove(0));
        }
        if first.words.is_empty() {
            commands.remove(0);
        }
    }
    let cached = |directory: &str| {
        mounts
            .iter()
            .any(|mount| mount.contains("type=cache") && mount.contains(directory))
    };

    let mut apt_update = false;
    let mut apt_install = false;
    let mut apt_cleaned = false;

    for written in &commands {
        let name = written.name();
        // What the line actually runs, once the prefixes that are not the
        // command are out of the way. The rules just below want the command as
        // written -- `sudo` is the finding -- and every rule after them wants
        // the command underneath it.
        let command = &docker_unwrap(written);

        match name {
            // A `cd` in a subshell is scoped to that subshell on purpose --
            // `(cd build && make)` is the idiom for exactly this rule's advice,
            // written inline.
            "cd" if command.depth == 0 => found.push(docker_issue(
                text,
                docker_locate(text, span, "cd"),
                span.end,
                "docker-cd-in-run",
                Severity::Warning,
                "a `cd` inside RUN ends with this instruction's shell; WORKDIR \
                 changes the directory for everything after it"
                    .to_string(),
                None,
            )),
            "sudo" => found.push(docker_issue(
                text,
                docker_locate(text, span, "sudo"),
                span.end,
                "docker-sudo-in-run",
                Severity::Warning,
                "a RUN already runs as the current USER, which is root unless a \
                 USER instruction said otherwise"
                    .to_string(),
                None,
            )),
            "rm" if command
                .words
                .iter()
                .any(|word| word.contains("/var/lib/apt/lists")) =>
            {
                apt_cleaned = true;
            }
            _ => {}
        }

        match command.name() {
            "apt-get" | "apt" => match command.subcommand() {
                "update" => apt_update = true,
                "install" => {
                    apt_install = true;
                    docker_apt_rules(text, span, command, found);
                }
                _ => {}
            },
            "apk" if command.subcommand() == "add" => docker_apk_rules(text, span, command, found),
            // Not `"pip" | "pip3"`: an image that installs several interpreters
            // calls the one it means by version, and `pip3.7 install` is a real
            // line in a real Dockerfile that a two-name match reads as an
            // unknown command.
            name if docker_is_pip(name) => {
                if command.subcommand() == "install" {
                    docker_pip_rules(text, span, command, found);
                }
            }
            // `python -m pip install ...` is the same command wearing a hat.
            name if name.starts_with("python") => {
                if let Some(index) = command.words.iter().position(|word| word == "-m") {
                    if command.words.get(index + 1).is_some_and(|m| m == "pip") {
                        let inner = DockerCommand {
                            words: command.words[index + 1..].to_vec(),
                            depth: command.depth,
                        };
                        if inner.subcommand() == "install" {
                            docker_pip_rules(text, span, &inner, found);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if apt_update && !apt_install {
        found.push(docker_issue(
            text,
            docker_locate(text, span, "apt-get"),
            span.end,
            "docker-apt-get-update-alone",
            Severity::Warning,
            "an `apt-get update` on its own becomes a cached layer, and the next \
             RUN's install then resolves against a stale package index"
                .to_string(),
            None,
        ));
    }
    if apt_install && !apt_cleaned && !cached("/var/lib/apt") && !cached("/var/cache/apt") {
        found.push(docker_issue(
            text,
            docker_locate(text, span, "apt-get"),
            span.end,
            "docker-apt-get-no-clean",
            Severity::Warning,
            "the package lists stay in this layer; deleting them in a later RUN \
             does not shrink the image"
                .to_string(),
            Some(Fix::Described {
                what: "Append `&& rm -rf /var/lib/apt/lists/*` to this RUN".to_string(),
                safe: true,
            }),
        ));
    }
    if piped && !stage.pipefail && !body.contains("pipefail") {
        found.push(docker_issue(
            text,
            span.start,
            span.end,
            "docker-pipe-without-pipefail",
            Severity::Warning,
            "`/bin/sh` reports only the last command in a pipeline, so a failure \
             upstream of the `|` passes as a successful build"
                .to_string(),
            Some(Fix::Described {
                what: "Set `SHELL [\"/bin/bash\", \"-o\", \"pipefail\", \"-c\"]` above this RUN"
                    .to_string(),
                // bash is not in every base image, and the SHELL applies to
                // every RUN below it.
                safe: false,
            }),
        ));
    }
}

fn docker_apt_rules(text: &str, span: DockerSpan, command: &DockerCommand, found: &mut Vec<Issue>) {
    // `-qq` implies `-y`, and a bundled short flag (`-yq`) is still a yes.
    let assumed_yes = command.words.iter().any(|word| {
        matches!(word.as_str(), "--yes" | "--assume-yes" | "-qq")
            || (word.starts_with('-') && !word.starts_with("--") && word.contains('y'))
    });
    if !assumed_yes {
        found.push(docker_issue(
            text,
            docker_locate(text, span, "install"),
            span.end,
            "docker-apt-get-interactive",
            Severity::Error,
            "`apt-get install` without `-y` waits for a confirmation the build \
             has no terminal to type"
                .to_string(),
            Some(Fix::Described {
                what: "Add `-y` to `apt-get install`".to_string(),
                safe: true,
            }),
        ));
    }
    let recommends_off = command.has_flag("--no-install-recommends")
        || command
            .words
            .iter()
            .any(|word| word.contains("Install-Recommends=false"));
    if !recommends_off {
        found.push(docker_issue(
            text,
            docker_locate(text, span, "install"),
            span.end,
            "docker-apt-get-no-recommends",
            Severity::Warning,
            "recommended packages are installed by default, so the image gets \
             software the line never named"
                .to_string(),
            Some(Fix::Described {
                what: "Add `--no-install-recommends`".to_string(),
                // It changes what lands in the image, which is the point, and
                // occasionally something was relying on a recommendation.
                safe: false,
            }),
        ));
    }
    for package in command.operands() {
        if package.contains('=') || package.contains('$') || package.ends_with(".deb") {
            continue;
        }
        found.push(docker_issue(
            text,
            docker_locate(text, span, package),
            span.end,
            "docker-apt-get-unpinned",
            Severity::Warning,
            format!(
                "`{package}` has no version, so this installs whatever the archive serves today"
            ),
            None,
        ));
    }
}

fn docker_apk_rules(text: &str, span: DockerSpan, command: &DockerCommand, found: &mut Vec<Issue>) {
    if !command.has_flag("--no-cache") {
        found.push(docker_issue(
            text,
            docker_locate(text, span, "add"),
            span.end,
            "docker-apk-no-cache",
            Severity::Warning,
            "`apk add` writes a package index into the layer that nothing reads \
             again"
                .to_string(),
            Some(Fix::Described {
                what: "Add `--no-cache` to `apk add`".to_string(),
                safe: true,
            }),
        ));
    }
    for package in command.operands() {
        if package.contains('=') || package.contains('$') || package.ends_with(".apk") {
            continue;
        }
        found.push(docker_issue(
            text,
            docker_locate(text, span, package),
            span.end,
            "docker-apk-unpinned",
            Severity::Warning,
            format!(
                "`{package}` has no version, so this installs whatever the mirror serves today"
            ),
            None,
        ));
    }
}

fn docker_pip_rules(text: &str, span: DockerSpan, command: &DockerCommand, found: &mut Vec<Issue>) {
    // `-r requirements.txt` and `-e .` both put the versions somewhere else, and
    // that somewhere else is the file to look at.
    if command
        .words
        .iter()
        .any(|word| matches!(word.as_str(), "-r" | "--requirement" | "-e" | "--editable"))
    {
        return;
    }
    for package in command.operands() {
        let pinned = package.contains("==")
            || package.contains('$')
            || package.starts_with('.')
            || package.starts_with('/')
            || package.contains("://")
            || package.ends_with(".whl")
            || package.ends_with(".tar.gz");
        if pinned {
            continue;
        }
        found.push(docker_issue(
            text,
            docker_locate(text, span, package),
            span.end,
            "docker-pip-unpinned",
            Severity::Warning,
            format!("`{package}` has no version, so this installs whatever PyPI serves today"),
            None,
        ));
    }
}

// ── spelling (typos) ───────────────────────────────────────────────────────

/// Spell-check one file, whatever it is.
///
/// A second entry point rather than another `supported` arm, and the seam is
/// the point: typos is the one checker with no language. It reads a LICENSE, a
/// Dockerfile and a .py alike, and what it needs to know about a file is not
/// which language poly calls it but which *type* typos calls it -- `lock` and
/// `cert` are checked with no dictionary at all, and `[type.rust]` in a
/// project's config addresses that name. Routing it through `lint(lang, ..)`
/// would mean naming every language poly knows and still missing every file
/// poly knows no language for, which is a large share of what a spell checker
/// exists to read.
///
/// Takes a path and no text, also deliberately. Deciding a PNG is a picture
/// rather than prose, and decoding a UTF-16 source file, are both part of what
/// typos does and both need the bytes; and the daemon already read the file
/// from disk rather than the buffer, because on stdin the document is called
/// `-` and the per-type config keyed off the file name stops applying.
pub fn spell(path: &Path) -> Result<Vec<Issue>> {
    // `Policy` and `init_dir` both assert an absolute path, and the config a
    // file answers to is decided by walking its ancestors -- neither survives a
    // bare `a.rs` handed over by an editor.
    let path =
        std::path::absolute(path).with_context(|| format!("resolving {}", path.display()))?;
    let speller = speller(&path)?;
    if speller.excluded(&path) {
        return Ok(Vec::new());
    }
    let policy = speller.engine.policy(&path);

    let mut found = Vec::new();
    if policy.check_filenames {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            let ignored = ignored_ranges(name.as_bytes(), &policy);
            found.extend(
                typos::check_str(name, policy.tokenizer, policy.dict)
                    .filter(|typo| !is_ignored(&ignored, typo.span()))
                    .map(|typo| spell_issue(&typo, None)),
            );
        }
    }
    if !policy.check_files {
        return Ok(found);
    }
    let (buffer, binary) = read_for_spelling(&path)?;
    // Without this poly spell-checks the bytes of a PNG. `policy.binary` is the
    // project saying it wants that anyway (`[default] binary = true`).
    if binary && !policy.binary {
        return Ok(found);
    }

    let ignored = ignored_ranges(&buffer, &policy);
    // typos reports whole-buffer offsets and a diagnostic needs a line plus an
    // offset within it. Findings arrive in ascending offset order, so one
    // forward pass over the buffer counts every line exactly once -- which is
    // what typos' own AccumulateLineNum/extract_line do, and they are private
    // to it.
    let (mut line, mut line_start, mut scanned) = (0u32, 0usize, 0usize);
    for typo in typos::check_bytes(&buffer, policy.tokenizer, policy.dict) {
        if is_ignored(&ignored, typo.span()) {
            continue;
        }
        // `max` only so that an ordering change upstream cannot panic here.
        let offset = typo.byte_offset.min(buffer.len()).max(scanned);
        for (i, byte) in buffer[scanned..offset].iter().enumerate() {
            if *byte == b'\n' {
                line += 1;
                line_start = scanned + i + 1;
            }
        }
        scanned = offset;
        found.push(spell_issue(
            &typo,
            Some((line, (offset - line_start) as u32)),
        ));
    }
    Ok(found)
}

/// One typo, worded and positioned the way `typos --format json` worded and
/// positioned it -- this is a port, so the record has to be the same record.
///
/// `at` is `None` for a typo in the file *name*. typos reports those with no
/// line number, so poly anchors them at the very start and says why in the
/// message, rather than aiming a path offset at whatever happens to sit at that
/// offset in the contents.
///
/// The column is the typo's *byte* offset within its line while the width
/// counts *characters*. That mismatch is inherited, not invented: it is the
/// pair of numbers the JSON path produced, and squaring it up would silently
/// move every column poly has ever reported on a line with non-ASCII text
/// before the typo.
fn spell_issue(typo: &typos::Typo<'_>, at: Option<(u32, u32)>) -> Issue {
    let (line, col, width) = match at {
        Some((line, col)) => (line, col, typo.typo.chars().count() as u32),
        None => (0, 0, 0),
    };
    // `Valid` never gets this far (typos drops it) and `Invalid` is a word the
    // dictionary knows is wrong with nothing to put in its place -- defensive
    // in typos itself, and a case the JSON poly used to parse could not even
    // represent, since `corrections: null` would have failed the whole run.
    let corrections: Vec<&str> = match &typo.corrections {
        typos::Status::Corrections(corrections) => corrections.iter().map(AsRef::as_ref).collect(),
        _ => Vec::new(),
    };
    Issue {
        line,
        col,
        end_line: line,
        end_col: col + width,
        severity: Severity::Info,
        code: "typo".to_string(),
        message: format!(
            "`{}` should be `{}`{}",
            typo.typo,
            corrections.join("` or `"),
            if at.is_none() {
                " (in the file name)"
            } else {
                ""
            }
        ),
        source: "typos",
        // The correction is already in the message; what this adds is that
        // `typos --write` would apply it without a human.
        fix: Some(Fix::Automatic),
        url: None,
    }
}

/// The byte ranges `[default] extend-ignore-re` covers, computed once per
/// buffer. A typo touching one of them is a typo inside a region the project
/// asked not to be read -- a license header, a base64 blob, a vendored table.
fn ignored_ranges(
    content: &[u8],
    policy: &typos_cli::policy::Policy<'_, '_, '_>,
) -> Vec<std::ops::Range<usize>> {
    if policy.ignore.is_empty() {
        return Vec::new();
    }
    let Ok(text) = std::str::from_utf8(content) else {
        return Vec::new();
    };
    policy
        .ignore
        .iter()
        .flat_map(|pattern| pattern.find_iter(text).map(|found| found.range()))
        .collect()
}

fn is_ignored(blocks: &[std::ops::Range<usize>], span: std::ops::Range<usize>) -> bool {
    let end = span.end.saturating_sub(1);
    blocks
        .iter()
        .any(|block| block.contains(&span.start) || block.contains(&end))
}

/// The file's bytes as typos would read them, and whether it is a picture.
///
/// UTF-16 is decoded rather than skipped, so the offsets below index the
/// decoded text -- which is what the binary reported too, and the only shape a
/// line and column can be given in.
fn read_for_spelling(path: &Path) -> Result<(Vec<u8>, bool)> {
    use content_inspector::ContentType;

    let buffer = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let decode = |encoding: &'static encoding_rs::Encoding| -> Result<Vec<u8>> {
        let mut decoded = String::with_capacity(buffer.len() * 2);
        let (result, at) = encoding
            .new_decoder_with_bom_removal()
            .decode_to_string_without_replacement(&buffer, &mut decoded, true);
        match result {
            encoding_rs::DecoderResult::InputEmpty => Ok(decoded.into_bytes()),
            _ => Err(anyhow!(
                "invalid {} encoding at byte {at} in {}",
                encoding.name(),
                path.display()
            )),
        }
    };
    Ok(match content_inspector::inspect(&buffer) {
        // UTF-32 reads as binary because typos has no decoder for it either.
        ContentType::BINARY | ContentType::UTF_32LE | ContentType::UTF_32BE => (buffer, true),
        ContentType::UTF_16LE => (decode(encoding_rs::UTF_16LE)?, false),
        ContentType::UTF_16BE => (decode(encoding_rs::UTF_16BE)?, false),
        ContentType::UTF_8 | ContentType::UTF_8_BOM => (buffer, false),
    })
}

/// A typos configuration, resolved, plus the exclusions that came with it.
struct Speller {
    engine: typos_cli::policy::ConfigEngine<'static>,
    /// `[files] extend-exclude`, compiled the way typos compiled it.
    ///
    /// typos applied these while walking; poly walks instead, so they have to
    /// be matched here or a repo that told typos to leave `vendored/` alone
    /// would suddenly have all of it spell-checked. The rest of `[files]`
    /// (`ignore-hidden`, `ignore-vcs`, `ignore-dot`) describes a walk poly no
    /// longer runs -- poly's own walk answers those now, for every tool at
    /// once, which is what `--hidden` and `--no-ignore` came to mean.
    excludes: ignore::gitignore::Gitignore,
}

impl Speller {
    fn excluded(&self, path: &Path) -> bool {
        self.excludes
            .matched_path_or_any_parents(path, false)
            .is_ignore()
    }
}

/// One arena for every config poly ever loads.
///
/// `ConfigEngine` borrows its string storage, and interning is what makes a
/// `[default.extend-words]` entry a `&str` the dictionary can hand back.
/// Sharing one is what the typos binary does with its single run; poly's is
/// process-wide because the daemon is one process for a whole editing session.
fn spell_storage() -> &'static typos_cli::policy::ConfigStorage {
    static STORAGE: OnceLock<typos_cli::policy::ConfigStorage> = OnceLock::new();
    STORAGE.get_or_init(typos_cli::policy::ConfigStorage::new)
}

/// The typos configuration governing `path`.
///
/// Two caches, for the reason `python_settings` has two: finding the config is
/// a stat-walk whose answer is per directory, while *building* one parses that
/// file, compiles its globs and regexes and interns its word list, so its
/// answer is per config file. A monorepo with three hundred package
/// directories and one `_typos.toml` walks three hundred times and builds once.
/// This is the difference between embedding typos and regressing it: the
/// subprocess paid for its config once for the whole batch, and poly runs this
/// per file under rayon. Failures cache too, so a broken `_typos.toml` is
/// parsed once and every file after it fails from the remembered error rather
/// than re-reading the file; `cmd_check` is what collapses those into one
/// message.
///
/// Resolving per file rather than once per command-line argument is the one
/// deliberate departure. The binary loaded a config from each *argument* and
/// applied it to everything underneath, so `poly check .` used the root's
/// config for the whole repo while the editor, which handed typos a single
/// file, used the nearest one above it -- the same file answered to two
/// different configs depending on who asked. Per file is the editor's answer,
/// and A4 says there is only supposed to be one.
fn speller(path: &Path) -> Result<Arc<Speller>> {
    type Anchors = HashMap<PathBuf, std::result::Result<PathBuf, String>>;
    type Built = HashMap<PathBuf, std::result::Result<Arc<Speller>, String>>;
    static ANCHORS: Mutex<Option<Anchors>> = Mutex::new(None);
    static BUILT: Mutex<Option<Built>> = Mutex::new(None);

    let dir = path.parent().unwrap_or(path).to_path_buf();
    let anchor = {
        let mut guard = ANCHORS.lock().expect("typos config discovery lock");
        let anchors = guard.get_or_insert_with(HashMap::new);
        match anchors.get(&dir) {
            Some(hit) => hit.clone(),
            None => {
                let hit = spell_anchor(&dir).map_err(|e| format!("{e:#}"));
                anchors.insert(dir, hit.clone());
                hit
            }
        }
    }
    .map_err(|e| anyhow!(e))?;

    let mut guard = BUILT.lock().expect("typos config cache lock");
    let built = guard.get_or_insert_with(HashMap::new);
    let speller = match built.get(&anchor) {
        Some(hit) => hit.clone(),
        None => {
            let hit = build_speller(&anchor)
                .map(Arc::new)
                .map_err(|e| format!("{e:#}"));
            built.insert(anchor, hit.clone());
            hit
        }
    };
    speller.map_err(|e| anyhow!(e))
}

/// The directory whose typos config governs files under `dir`.
///
/// typos' own discovery rather than `nearest_ancestor_file`, because the file
/// it looks for is one of five and two of them only count conditionally: a
/// `Cargo.toml` is a typos config exactly when it carries
/// `[workspace.metadata.typos]` or `[package.metadata.typos]`, and a
/// `pyproject.toml` when it carries `[tool.typos]`. Reimplementing that is how
/// poly would start disagreeing with the project's own configuration.
///
/// The filesystem root when nothing is found, so that every file still resolves
/// to *some* initialized directory and gets typos' defaults.
fn spell_anchor(dir: &Path) -> Result<PathBuf> {
    for ancestor in dir.ancestors() {
        if typos_cli::config::Config::from_dir(ancestor)
            .with_context(|| format!("reading the typos config in {}", ancestor.display()))?
            .is_some()
        {
            return Ok(ancestor.to_path_buf());
        }
    }
    Ok(dir.ancestors().last().unwrap_or(dir).to_path_buf())
}

fn build_speller(anchor: &Path) -> Result<Speller> {
    let mut engine = typos_cli::policy::ConfigEngine::new(spell_storage());
    engine
        .init_dir(anchor)
        .with_context(|| format!("loading the typos config for {}", anchor.display()))?;
    let mut excludes = ignore::gitignore::GitignoreBuilder::new(anchor);
    for pattern in engine.walk(anchor).extend_exclude() {
        excludes
            .add_line(None, pattern)
            .with_context(|| format!("[files] extend-exclude pattern {pattern:?}"))?;
    }
    let excludes = excludes
        .build()
        .context("building [files] extend-exclude")?;
    Ok(Speller { engine, excludes })
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

    // ── dockerfile ─────────────────────────────────────────────────────────

    fn docker_codes(text: &str) -> Vec<String> {
        lint("dockerfile", Path::new("Dockerfile"), text)
            .unwrap()
            .into_iter()
            .map(|issue| {
                assert_eq!(issue.source, "poly", "{issue:?}");
                assert_eq!(issue.url, None, "poly's own rules have no page to link");
                issue.code
            })
            .collect()
    }

    /// Does linting `text` report `code`? Every fixture below triggers other
    /// rules incidentally -- a one-line Dockerfile with no USER is already a
    /// `docker-root-user` -- so a rule is asked about by name rather than by
    /// counting findings.
    fn fires(text: &str, code: &str) -> bool {
        docker_codes(text).iter().any(|found| found == code)
    }

    /// A file that triggers each rule, one row per rule.
    ///
    /// The per-rule tests below each carry their own fixture, and this is a
    /// second copy on purpose: those ask whether a rule fires for the right
    /// reason, and this asks whether the rule set and the *documented* rule set
    /// are the same set. Only a list that is complete by construction can
    /// answer the second question, and `every_docker_rule_is_documented`
    /// fails if a row here stops triggering what it claims to.
    const TRIGGERS: &[(&str, &str)] = &[
        ("docker-add-instead-of-copy", "FROM a:1\nADD app.js /app/x\n"),
        ("docker-apk-no-cache", "FROM a:1\nRUN apk add curl=1\n"),
        ("docker-apk-unpinned", "FROM a:1\nRUN apk add --no-cache curl\n"),
        (
            "docker-apt-get-interactive",
            "FROM a:1\nRUN apt-get install --no-install-recommends curl=1 && rm -rf /var/lib/apt/lists/*\n",
        ),
        (
            "docker-apt-get-no-clean",
            "FROM a:1\nRUN apt-get install -y --no-install-recommends curl=1\n",
        ),
        (
            "docker-apt-get-no-recommends",
            "FROM a:1\nRUN apt-get install -y curl=1 && rm -rf /var/lib/apt/lists/*\n",
        ),
        (
            "docker-apt-get-unpinned",
            "FROM a:1\nRUN apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*\n",
        ),
        ("docker-apt-get-update-alone", "FROM a:1\nRUN apt-get update\n"),
        ("docker-cd-in-run", "FROM a:1\nRUN cd /app && make\n"),
        (
            "docker-copy-multiple-sources-no-slash",
            "FROM a:1\nCOPY one two /app\n",
        ),
        ("docker-duplicate-env-key", "FROM a:1\nENV A=1\nENV A=2\n"),
        ("docker-duplicate-label-key", "FROM a:1\nLABEL a=1\nLABEL a=2\n"),
        ("docker-invalid-port", "FROM a:1\nEXPOSE 99999\n"),
        ("docker-latest-base", "FROM ubuntu:latest\n"),
        ("docker-maintainer-deprecated", "FROM a:1\nMAINTAINER me@example.com\n"),
        ("docker-missing-from", "RUN echo hi\n"),
        ("docker-multiple-cmd", "FROM a:1\nCMD [\"a\"]\nCMD [\"b\"]\n"),
        (
            "docker-multiple-entrypoint",
            "FROM a:1\nENTRYPOINT [\"a\"]\nENTRYPOINT [\"b\"]\n",
        ),
        ("docker-pip-unpinned", "FROM a:1\nRUN pip install requests\n"),
        ("docker-pipe-without-pipefail", "FROM a:1\nRUN cat x | tar xz\n"),
        ("docker-root-user", "FROM a:1\nCMD [\"a\"]\n"),
        ("docker-secret-in-env", "FROM a:1\nENV DB_PASSWORD=hunter2\n"),
        ("docker-shell-form-command", "FROM a:1\nCMD npm start\n"),
        ("docker-sudo-in-run", "FROM a:1\nRUN sudo make install\n"),
        ("docker-untagged-base", "FROM ubuntu\n"),
        ("docker-workdir-relative", "FROM a:1\nWORKDIR app\n"),
    ];

    /// Every code poly emits has prose behind it, and every piece of prose
    /// belongs to a code poly emits.
    ///
    /// Both directions, because poly's Dockerfile rules have no documentation
    /// site: a code with no entry reaches the reader as four words in a
    /// terminal with nothing to look up, and an entry with no code is prose
    /// about a rule that no longer exists. `every_sqruff_rule_has_documentation`
    /// asks the same question of the tool poly links; this asks it of the rules
    /// poly wrote.
    #[test]
    fn every_docker_rule_is_documented() {
        let mut emitted: Vec<&str> = Vec::new();
        for (code, fixture) in TRIGGERS {
            assert!(
                fires(fixture, code),
                "{code} no longer fires for its own fixture: {fixture:?}"
            );
            emitted.push(code);
        }
        emitted.sort_unstable();
        emitted.dedup();
        let mut documented: Vec<&str> = DOCKER_RULES.iter().map(|(code, _)| *code).collect();
        documented.sort_unstable();
        assert_eq!(
            emitted, documented,
            "rules and their documentation disagree"
        );

        for (code, doc) in DOCKER_RULES {
            assert_eq!(rule_doc("poly", code), Some(*doc), "{code}");
            assert!(doc.len() > 80, "{code}: {doc}");
        }
        assert!(rule_doc("poly", "docker-no-such-rule").is_none());
        // Still nobody else's rules: the policy `rule_doc` documents is that
        // poly repeats what a tool says rather than paraphrasing it.
        assert!(rule_doc("hadolint", "DL3006").is_none());
    }

    /// A finding lands on the line the offending text starts on, and marks the
    /// word rather than the keyword.
    ///
    /// Anchoring is the substance of a Dockerfile finding: a `RUN` continued
    /// over a dozen lines is one instruction with one span, so a rule that
    /// reported the span would underline the screen to complain about one
    /// package name.
    #[test]
    fn a_finding_marks_the_word_it_is_about_not_the_whole_instruction() {
        let text = "FROM debian:12\nRUN apt-get update \\\n  && apt-get install -y --no-install-recommends \\\n       curl \\\n  && rm -rf /var/lib/apt/lists/*\nUSER app\n";
        let issues = lint("dockerfile", Path::new("Dockerfile"), text).unwrap();
        let found = issues
            .iter()
            .find(|i| i.code == "docker-apt-get-unpinned")
            .unwrap_or_else(|| panic!("{issues:?}"));
        // Line 3 (0-based), at `curl`, not line 1 where the RUN starts.
        assert_eq!((found.line, found.col), (3, 7), "{found:?}");
        assert_eq!(found.end_line, found.line, "one line, not the instruction");
        assert!(found.end_col > found.col, "{found:?}");
    }

    /// A base image with no tag means `:latest`, which is a tag that moves, so
    /// the same file builds different software on different days.
    #[test]
    fn an_untagged_base_image_is_not_reproducible() {
        assert!(fires("FROM ubuntu\nUSER app\n", "docker-untagged-base"));
        assert!(!fires(
            "FROM ubuntu:24.04\nUSER app\n",
            "docker-untagged-base"
        ));
        // A digest pins harder than a tag ever could.
        assert!(!fires(
            "FROM ubuntu@sha256:abc\nUSER app\n",
            "docker-untagged-base"
        ));
        // `scratch` is the empty image and has no tag to give it; a registry's
        // port is not a tag; and a stage name is not an image at all.
        assert!(!fires("FROM scratch\nUSER app\n", "docker-untagged-base"));
        assert!(!fires(
            "FROM localhost:5000/img:1\nUSER app\n",
            "docker-untagged-base"
        ));
        assert!(!fires(
            "FROM ubuntu:24.04 AS build\nFROM build\nUSER app\n",
            "docker-untagged-base"
        ));
        // An ARG decides which image this is; poly does not guess what it holds.
        assert!(!fires(
            "ARG BASE=ubuntu:24.04\nFROM $BASE\nUSER app\n",
            "docker-untagged-base"
        ));
    }

    /// `latest` names a different image every week, and nothing in the
    /// repository records which one a green build used.
    #[test]
    fn a_latest_base_image_is_not_reproducible() {
        assert!(fires(
            "FROM ubuntu:latest\nUSER app\n",
            "docker-latest-base"
        ));
        assert!(!fires(
            "FROM ubuntu:24.04\nUSER app\n",
            "docker-latest-base"
        ));
    }

    /// A build starts from a base image; a file whose first instruction is not
    /// `FROM` does not build at all.
    #[test]
    fn a_dockerfile_without_a_base_image_does_not_build() {
        assert!(fires("RUN echo hi\nUSER app\n", "docker-missing-from"));
        assert!(!fires(
            "FROM a:1\nRUN echo hi\nUSER app\n",
            "docker-missing-from"
        ));
        // ARG before FROM is how the base image itself is parameterised, and is
        // the one thing Docker allows up there.
        assert!(!fires(
            "ARG V=1\nFROM a:$V\nUSER app\n",
            "docker-missing-from"
        ));
        // Reported once, not once per instruction below it.
        assert_eq!(
            docker_codes("RUN a\nRUN b\nRUN c\n")
                .iter()
                .filter(|c| *c == "docker-missing-from")
                .count(),
            1
        );
    }

    /// Without `-y` apt waits for a confirmation the build has no terminal to
    /// type, so this is a broken build rather than a style preference.
    #[test]
    fn an_interactive_apt_get_hangs_a_build() {
        let clean = "&& rm -rf /var/lib/apt/lists/*\nUSER app\n";
        assert!(fires(
            &format!("FROM a:1\nRUN apt-get install --no-install-recommends c=1 {clean}"),
            "docker-apt-get-interactive"
        ));
        assert!(!fires(
            &format!("FROM a:1\nRUN apt-get install -y --no-install-recommends c=1 {clean}"),
            "docker-apt-get-interactive"
        ));
        // `-qq` implies `-y`, and a bundled short flag still carries one.
        assert!(!fires(
            &format!("FROM a:1\nRUN apt-get install -qq --no-install-recommends c=1 {clean}"),
            "docker-apt-get-interactive"
        ));
        assert!(!fires(
            &format!("FROM a:1\nRUN apt-get install -yq --no-install-recommends c=1 {clean}"),
            "docker-apt-get-interactive"
        ));
        assert_eq!(
            lint(
                "dockerfile",
                Path::new("Dockerfile"),
                "FROM a:1\nRUN apt-get install c\n"
            )
            .unwrap()
            .iter()
            .find(|i| i.code == "docker-apt-get-interactive")
            .and_then(|i| i.fix.clone()),
            Some(Fix::Described {
                what: "Add `-y` to `apt-get install`".to_string(),
                safe: true
            })
        );
    }

    /// Debian installs recommended packages by default, so the image ends up
    /// carrying software the line never named and nobody audited.
    #[test]
    fn apt_recommends_install_software_nobody_asked_for() {
        let clean = "&& rm -rf /var/lib/apt/lists/*\nUSER app\n";
        assert!(fires(
            &format!("FROM a:1\nRUN apt-get install -y c=1 {clean}"),
            "docker-apt-get-no-recommends"
        ));
        assert!(!fires(
            &format!("FROM a:1\nRUN apt-get install -y --no-install-recommends c=1 {clean}"),
            "docker-apt-get-no-recommends"
        ));
        // The same thing said through apt's config machinery.
        assert!(!fires(
            &format!(
                "FROM a:1\nRUN apt-get install -y -o APT::Install-Recommends=false c=1 {clean}"
            ),
            "docker-apt-get-no-recommends"
        ));
    }

    /// An `apt-get update` in its own layer is cached for months, so the next
    /// RUN's install resolves against a package index the mirror has moved on
    /// from and 404s in the middle of a build that changed nothing.
    #[test]
    fn a_cached_apt_update_layer_installs_versions_that_no_longer_exist() {
        assert!(fires(
            "FROM a:1\nRUN apt-get update\nUSER app\n",
            "docker-apt-get-update-alone"
        ));
        assert!(!fires(
            "FROM a:1\nRUN apt-get update && apt-get install -y --no-install-recommends c=1 && rm -rf /var/lib/apt/lists/*\nUSER app\n",
            "docker-apt-get-update-alone"
        ));
    }

    /// Package lists that stay in the layer are tens of megabytes nothing reads
    /// again, and deleting them in a later RUN does not get them back.
    #[test]
    fn apt_lists_left_behind_are_committed_to_the_layer() {
        assert!(fires(
            "FROM a:1\nRUN apt-get install -y --no-install-recommends c=1\nUSER app\n",
            "docker-apt-get-no-clean"
        ));
        assert!(!fires(
            "FROM a:1\nRUN apt-get install -y --no-install-recommends c=1 && rm -rf /var/lib/apt/lists/*\nUSER app\n",
            "docker-apt-get-no-clean"
        ));
        // A cache mount is the other real answer, and keeping the lists is then
        // the whole point of it.
        assert!(!fires(
            "FROM a:1\nRUN --mount=type=cache,target=/var/lib/apt apt-get install -y --no-install-recommends c=1\nUSER app\n",
            "docker-apt-get-no-clean"
        ));
    }

    /// An unpinned package installs whatever the archive serves today, so the
    /// same file builds different software over time.
    #[test]
    fn an_unpinned_apt_package_changes_under_the_build() {
        let clean = "&& rm -rf /var/lib/apt/lists/*\nUSER app\n";
        assert!(fires(
            &format!("FROM a:1\nRUN apt-get install -y --no-install-recommends curl {clean}"),
            "docker-apt-get-unpinned"
        ));
        assert!(!fires(
            &format!(
                "FROM a:1\nRUN apt-get install -y --no-install-recommends curl=7.88.1-10 {clean}"
            ),
            "docker-apt-get-unpinned"
        ));
        // A local .deb carries its own version, and a variable is somebody
        // else's decision.
        assert!(!fires(
            &format!("FROM a:1\nRUN apt-get install -y --no-install-recommends ./x.deb {clean}"),
            "docker-apt-get-unpinned"
        ));
        assert!(!fires(
            &format!("FROM a:1\nRUN apt-get install -y --no-install-recommends c=$V {clean}"),
            "docker-apt-get-unpinned"
        ));
    }

    /// `apk add` writes an index into the layer that nothing reads again;
    /// `--no-cache` is the one flag that does update, install and clean up.
    #[test]
    fn an_apk_cache_is_dead_weight_in_the_layer() {
        assert!(fires(
            "FROM a:1\nRUN apk add curl=1\nUSER app\n",
            "docker-apk-no-cache"
        ));
        assert!(!fires(
            "FROM a:1\nRUN apk add --no-cache curl=1\nUSER app\n",
            "docker-apk-no-cache"
        ));
    }

    /// The same reproducibility argument as apt, against a mirror that moves
    /// faster.
    #[test]
    fn an_unpinned_apk_package_changes_under_the_build() {
        assert!(fires(
            "FROM a:1\nRUN apk add --no-cache curl\nUSER app\n",
            "docker-apk-unpinned"
        ));
        assert!(!fires(
            "FROM a:1\nRUN apk add --no-cache curl=8.5.0-r0\nUSER app\n",
            "docker-apk-unpinned"
        ));
    }

    /// An unpinned pip install picks up major versions released after the
    /// Dockerfile was written, so an upgrade happens on a Tuesday instead of in
    /// a review.
    #[test]
    fn an_unpinned_pip_package_upgrades_itself() {
        assert!(fires(
            "FROM a:1\nRUN pip install requests\nUSER app\n",
            "docker-pip-unpinned"
        ));
        assert!(!fires(
            "FROM a:1\nRUN pip install requests==2.31.0\nUSER app\n",
            "docker-pip-unpinned"
        ));
        // A requirements file and an editable install both put the versions
        // somewhere else, and that somewhere else is the file to look at.
        assert!(!fires(
            "FROM a:1\nRUN pip install -r requirements.txt\nUSER app\n",
            "docker-pip-unpinned"
        ));
        // The same command wearing a hat, and the same command called by the
        // interpreter version it belongs to -- `pip3.7 install ansible` is a
        // real line in a real Dockerfile.
        assert!(fires(
            "FROM a:1\nRUN python3 -m pip install requests\nUSER app\n",
            "docker-pip-unpinned"
        ));
        assert!(fires(
            "FROM a:1\nRUN pip3.7 install ansible\nUSER app\n",
            "docker-pip-unpinned"
        ));
        // A different program with different arguments.
        assert!(!fires(
            "FROM a:1\nRUN pipenv install requests\nUSER app\n",
            "docker-pip-unpinned"
        ));
    }

    /// A `cd` dies with the RUN's shell, so a file written by the next
    /// instruction lands somewhere other than the line above suggests.
    #[test]
    fn a_cd_inside_run_does_not_outlive_the_instruction() {
        assert!(fires(
            "FROM a:1\nRUN cd /app && make\nUSER app\n",
            "docker-cd-in-run"
        ));
        assert!(!fires(
            "FROM a:1\nWORKDIR /app\nRUN make\nUSER app\n",
            "docker-cd-in-run"
        ));
        // A subshell scopes the `cd` on purpose: that is this rule's own advice,
        // written inline.
        assert!(!fires(
            "FROM a:1\nRUN (cd /app && make) && ls\nUSER app\n",
            "docker-cd-in-run"
        ));
    }

    /// A RUN already runs as the current USER, so `sudo` either does nothing or
    /// is not installed -- and it needs a TTY the build does not have.
    #[test]
    fn sudo_in_a_run_has_nothing_to_escalate_from() {
        assert!(fires(
            "FROM a:1\nRUN sudo make install\nUSER app\n",
            "docker-sudo-in-run"
        ));
        assert!(!fires(
            "FROM a:1\nRUN make install\nUSER app\n",
            "docker-sudo-in-run"
        ));
        // The command sudo wraps is still linted, or every apt rule could be
        // sidestepped by prefixing the line.
        assert!(fires(
            "FROM a:1\nRUN sudo apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*\nUSER app\n",
            "docker-apt-get-unpinned"
        ));
    }

    /// `DEBIAN_FRONTEND=noninteractive apt-get install ...` is one of the most
    /// common lines there is in a real Dockerfile. Reading its command name as
    /// the assignment makes every apt rule stop applying to exactly the files
    /// that need them -- it was the difference on 11 of the 248 Dockerfiles this
    /// engine was measured against.
    #[test]
    fn an_environment_prefix_does_not_hide_the_command_it_sets_up() {
        let codes = docker_codes(
            "FROM a:1\nRUN DEBIAN_FRONTEND=noninteractive apt-get install -y curl\nUSER app\n",
        );
        assert!(
            codes.contains(&"docker-apt-get-unpinned".to_string()),
            "{codes:?}"
        );
        assert!(
            codes.contains(&"docker-apt-get-no-recommends".to_string()),
            "{codes:?}"
        );
        // Several prefixes, and `env` spelled as a word.
        assert!(fires(
            "FROM a:1\nRUN LC_ALL=C DEBIAN_FRONTEND=noninteractive env apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*\nUSER app\n",
            "docker-apt-get-unpinned"
        ));
        // Not every word with an `=` is an assignment: a RUN flag keeps the
        // command it precedes.
        assert!(!fires(
            "FROM a:1\nRUN --mount=type=cache,target=/var/lib/apt apt-get install -y --no-install-recommends curl=1 && rm -rf /var/lib/apt/lists/*\nUSER app\n",
            "docker-apt-get-unpinned"
        ));
    }

    /// `/bin/sh` reports only the last command in a pipeline, so a download
    /// that 404s passes as a successful build and fails much later as a missing
    /// file.
    #[test]
    fn a_pipeline_under_sh_hides_the_failure_that_matters() {
        assert!(fires(
            "FROM a:1\nRUN cat x | tar xz\nUSER app\n",
            "docker-pipe-without-pipefail"
        ));
        assert!(!fires(
            "FROM a:1\nRUN cat x\nUSER app\n",
            "docker-pipe-without-pipefail"
        ));
        // `||` is a fallback, not a pipeline.
        assert!(!fires(
            "FROM a:1\nRUN cat x || true\nUSER app\n",
            "docker-pipe-without-pipefail"
        ));
        // A SHELL that turned pipefail on answers this for every RUN under it.
        assert!(!fires(
            "FROM a:1\nSHELL [\"/bin/bash\", \"-o\", \"pipefail\", \"-c\"]\nRUN cat x | tar xz\nUSER app\n",
            "docker-pipe-without-pipefail"
        ));
        // ...and only under it: a new stage starts with the default shell back.
        assert!(fires(
            "FROM a:1\nSHELL [\"/bin/bash\", \"-o\", \"pipefail\", \"-c\"]\nFROM b:1\nRUN cat x | tar xz\nUSER app\n",
            "docker-pipe-without-pipefail"
        ));
        // A `|` inside a quoted string is not a pipeline.
        assert!(!fires(
            "FROM a:1\nRUN grep 'a|b' x\nUSER app\n",
            "docker-pipe-without-pipefail"
        ));
    }

    /// A relative WORKDIR resolves against whatever came before it, so
    /// inserting an instruction above silently moves everything below.
    #[test]
    fn a_relative_workdir_moves_when_the_file_above_it_changes() {
        assert!(fires(
            "FROM a:1\nWORKDIR app\nUSER app\n",
            "docker-workdir-relative"
        ));
        assert!(!fires(
            "FROM a:1\nWORKDIR /app\nUSER app\n",
            "docker-workdir-relative"
        ));
        // A variable could hold an absolute path, and a Windows container's
        // `C:\app` is absolute in the way that matters.
        assert!(!fires(
            "FROM a:1\nWORKDIR $D\nUSER app\n",
            "docker-workdir-relative"
        ));
        assert!(!fires(
            "FROM a:1\nWORKDIR C:\\app\nUSER app\n",
            "docker-workdir-relative"
        ));
    }

    /// ADD also fetches URLs and unpacks archives, both silently. COPY copies.
    #[test]
    fn add_does_two_things_nobody_asked_for() {
        assert!(fires(
            "FROM a:1\nADD app.js /app/x\nUSER app\n",
            "docker-add-instead-of-copy"
        ));
        assert!(!fires(
            "FROM a:1\nCOPY app.js /app/x\nUSER app\n",
            "docker-add-instead-of-copy"
        ));
        // Fetching and unpacking are the two reasons to have written ADD.
        assert!(!fires(
            "FROM a:1\nADD https://example.com/x.txt /app/x\nUSER app\n",
            "docker-add-instead-of-copy"
        ));
        assert!(!fires(
            "FROM a:1\nADD src.tar.gz /app/\nUSER app\n",
            "docker-add-instead-of-copy"
        ));
        // .zip is not one of them: Docker does not extract it, so that ADD is
        // still just a copy.
        assert!(fires(
            "FROM a:1\nADD src.zip /app/x\nUSER app\n",
            "docker-add-instead-of-copy"
        ));
    }

    /// With several sources the destination has to be a directory, and the
    /// trailing slash is how a Dockerfile says so; without it the build fails.
    #[test]
    fn a_multi_source_copy_needs_a_directory_destination() {
        assert!(fires(
            "FROM a:1\nCOPY one two /app\nUSER app\n",
            "docker-copy-multiple-sources-no-slash"
        ));
        assert!(!fires(
            "FROM a:1\nCOPY one two /app/\nUSER app\n",
            "docker-copy-multiple-sources-no-slash"
        ));
        // One source to a file name is exactly what COPY is for.
        assert!(!fires(
            "FROM a:1\nCOPY one /app/one\nUSER app\n",
            "docker-copy-multiple-sources-no-slash"
        ));
        // `.` is a directory without needing a slash, and a variable may end in
        // one.
        assert!(!fires(
            "FROM a:1\nWORKDIR /app\nCOPY one two .\nUSER app\n",
            "docker-copy-multiple-sources-no-slash"
        ));
        // The JSON form counts its elements the same way.
        assert!(fires(
            "FROM a:1\nCOPY [\"one\", \"two\", \"/app\"]\nUSER app\n",
            "docker-copy-multiple-sources-no-slash"
        ));
    }

    /// Only the last ENV for a key survives, so the earlier line is dead and
    /// nothing in the file says which one was meant.
    #[test]
    fn a_duplicated_env_key_leaves_a_dead_line() {
        assert!(fires(
            "FROM a:1\nENV A=1\nENV A=2\nUSER app\n",
            "docker-duplicate-env-key"
        ));
        assert!(!fires(
            "FROM a:1\nENV A=1\nENV B=2\nUSER app\n",
            "docker-duplicate-env-key"
        ));
        // A new stage starts with none of the last one's environment.
        assert!(!fires(
            "FROM a:1\nENV A=1\nFROM b:1\nENV A=2\nUSER app\n",
            "docker-duplicate-env-key"
        ));
    }

    /// Only the last LABEL for a key survives, so a reader looking for the
    /// version an image claims has two answers and no way to pick.
    #[test]
    fn a_duplicated_label_key_leaves_a_dead_line() {
        assert!(fires(
            "FROM a:1\nLABEL v=1\nLABEL v=2\nUSER app\n",
            "docker-duplicate-label-key"
        ));
        assert!(!fires(
            "FROM a:1\nLABEL v=1\nLABEL w=2\nUSER app\n",
            "docker-duplicate-label-key"
        ));
    }

    /// EXPOSE takes a TCP or UDP port; anything else is a typo Docker rejects
    /// at build time.
    #[test]
    fn an_out_of_range_expose_is_not_a_port() {
        assert!(fires(
            "FROM a:1\nEXPOSE 99999\nUSER app\n",
            "docker-invalid-port"
        ));
        assert!(fires(
            "FROM a:1\nEXPOSE http\nUSER app\n",
            "docker-invalid-port"
        ));
        assert!(fires(
            "FROM a:1\nEXPOSE 0\nUSER app\n",
            "docker-invalid-port"
        ));
        assert!(!fires(
            "FROM a:1\nEXPOSE 8080\nUSER app\n",
            "docker-invalid-port"
        ));
        assert!(!fires(
            "FROM a:1\nEXPOSE 53/udp\nUSER app\n",
            "docker-invalid-port"
        ));
        assert!(!fires(
            "FROM a:1\nEXPOSE 8000-8010\nUSER app\n",
            "docker-invalid-port"
        ));
        assert!(!fires(
            "FROM a:1\nEXPOSE $PORT\nUSER app\n",
            "docker-invalid-port"
        ));
    }

    /// MAINTAINER has been deprecated since 1.13 and its value is not part of
    /// the image's structured metadata, so nothing can read it back.
    #[test]
    fn maintainer_puts_the_author_somewhere_nothing_reads() {
        assert!(fires(
            "FROM a:1\nMAINTAINER me@example.com\nUSER app\n",
            "docker-maintainer-deprecated"
        ));
        assert!(!fires(
            "FROM a:1\nLABEL org.opencontainers.image.authors=\"me@example.com\"\nUSER app\n",
            "docker-maintainer-deprecated"
        ));
    }

    /// Only the last CMD in a stage has any effect; an earlier one reads as
    /// though it applies.
    #[test]
    fn only_the_last_cmd_in_a_stage_runs() {
        assert!(fires(
            "FROM a:1\nCMD [\"a\"]\nCMD [\"b\"]\nUSER app\n",
            "docker-multiple-cmd"
        ));
        assert!(!fires(
            "FROM a:1\nCMD [\"a\"]\nUSER app\n",
            "docker-multiple-cmd"
        ));
        // One per stage is one per stage.
        assert!(!fires(
            "FROM a:1\nCMD [\"a\"]\nFROM b:1\nCMD [\"b\"]\nUSER app\n",
            "docker-multiple-cmd"
        ));
        // A HEALTHCHECK carries a nested CMD and is not one of these.
        assert!(!fires(
            "FROM a:1\nCMD [\"a\"]\nHEALTHCHECK CMD [\"c\"]\nUSER app\n",
            "docker-multiple-cmd"
        ));
    }

    /// Only the last ENTRYPOINT has any effect, and unlike a dead CMD nothing
    /// at runtime hints the container started something else.
    #[test]
    fn only_the_last_entrypoint_in_a_stage_runs() {
        assert!(fires(
            "FROM a:1\nENTRYPOINT [\"a\"]\nENTRYPOINT [\"b\"]\nUSER app\n",
            "docker-multiple-entrypoint"
        ));
        assert!(!fires(
            "FROM a:1\nENTRYPOINT [\"a\"]\nUSER app\n",
            "docker-multiple-entrypoint"
        ));
    }

    /// The shell form makes `/bin/sh -c` PID 1, and it does not forward
    /// SIGTERM -- so `docker stop` waits out its timeout and SIGKILLs the real
    /// process mid-write.
    #[test]
    fn a_shell_form_command_never_sees_sigterm() {
        assert!(fires(
            "FROM a:1\nCMD npm start\nUSER app\n",
            "docker-shell-form-command"
        ));
        assert!(fires(
            "FROM a:1\nENTRYPOINT /app/run\nUSER app\n",
            "docker-shell-form-command"
        ));
        assert!(!fires(
            "FROM a:1\nCMD [\"npm\", \"start\"]\nUSER app\n",
            "docker-shell-form-command"
        ));
        assert!(!fires(
            "FROM a:1\nENTRYPOINT [\"/app/run\"]\nUSER app\n",
            "docker-shell-form-command"
        ));
    }

    /// Root in the container is root on the host kernel, and it is the account
    /// that ends up owning everything the container writes to a volume.
    #[test]
    fn a_container_with_no_user_runs_as_root() {
        assert!(fires("FROM a:1\nCMD [\"x\"]\n", "docker-root-user"));
        assert!(fires(
            "FROM a:1\nUSER root\nCMD [\"x\"]\n",
            "docker-root-user"
        ));
        assert!(fires(
            "FROM a:1\nUSER 0:0\nCMD [\"x\"]\n",
            "docker-root-user"
        ));
        assert!(!fires(
            "FROM a:1\nUSER app\nCMD [\"x\"]\n",
            "docker-root-user"
        ));
        // Only the final stage becomes the image: a build stage's filesystem is
        // thrown away, so its user is not a property of anything that ships.
        assert!(!fires(
            "FROM a:1 AS build\nRUN make\nFROM b:1\nUSER app\nCMD [\"x\"]\n",
            "docker-root-user"
        ));
        assert!(fires(
            "FROM a:1 AS build\nUSER app\nFROM b:1\nCMD [\"x\"]\n",
            "docker-root-user"
        ));
    }

    /// An ENV or ARG value is in the image forever and `docker history` reads
    /// it back; deleting the file later does not remove the layer that set it.
    #[test]
    fn a_literal_credential_in_env_stays_in_the_image() {
        assert!(fires(
            "FROM a:1\nENV DB_PASSWORD=hunter2\nUSER app\n",
            "docker-secret-in-env"
        ));
        assert!(fires(
            "FROM a:1\nARG API_TOKEN=abc123\nUSER app\n",
            "docker-secret-in-env"
        ));
        assert!(!fires(
            "FROM a:1\nENV DB_HOST=db\nUSER app\n",
            "docker-secret-in-env"
        ));
        // A reference to a secret is what the rule is asking for, not what it
        // is complaining about: a path, a file name, another variable.
        assert!(!fires(
            "FROM a:1\nENV DB_PASSWORD_FILE=/run/secrets/db\nUSER app\n",
            "docker-secret-in-env"
        ));
        assert!(!fires(
            "FROM a:1\nENV DB_PASSWORD=$FROM_BUILD_ARG\nUSER app\n",
            "docker-secret-in-env"
        ));
        assert!(!fires(
            "FROM a:1\nARG TOKEN=\nUSER app\n",
            "docker-secret-in-env"
        ));
    }

    /// A clean Dockerfile reports nothing. Without this every rule above could
    /// pass on a linter that fires on everything.
    #[test]
    fn a_well_formed_dockerfile_is_quiet() {
        let text = "FROM debian:12-slim\n\
             SHELL [\"/bin/bash\", \"-o\", \"pipefail\", \"-c\"]\n\
             RUN apt-get update \\\n \
             && apt-get install -y --no-install-recommends curl=7.88.1-10 \\\n \
             && rm -rf /var/lib/apt/lists/*\n\
             WORKDIR /app\n\
             COPY src one /app/\n\
             ENV PORT=8080\n\
             EXPOSE 8080\n\
             USER app\n\
             ENTRYPOINT [\"/app/run\"]\n\
             CMD [\"--help\"]\n";
        assert_eq!(docker_codes(text), Vec::<String>::new());
    }

    /// A file the parser cannot make sense of reports nothing rather than
    /// failing the run. The parser here is a formatter's and lenient by
    /// construction, so anything it rejects outright is a file `poly fmt`
    /// already refuses with a position.
    #[test]
    fn an_unparsable_dockerfile_is_not_an_error() {
        assert!(lint("dockerfile", Path::new("Dockerfile"), "\u{0}\u{1}garbage").is_ok());
        assert!(docker_codes("").is_empty());
    }

    // ── spelling ───────────────────────────────────────────────────────────

    /// A project on disk, because every question `spell` answers is asked of
    /// the filesystem: which config governs the file, what type its name makes
    /// it, and whether its bytes are text.
    fn spelling_project(config: &str, files: &[(&str, &[u8])]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        // Canonicalized because macOS hands out /var/folders/... and resolves
        // it to /private/var/..., and the config cache is keyed by directory.
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("_typos.toml"), config).unwrap();
        for (name, body) in files {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        dir
    }

    fn spell_at(dir: &tempfile::TempDir, name: &str) -> Vec<Issue> {
        let root = dir.path().canonicalize().unwrap();
        spell(&root.join(name)).unwrap_or_else(|e| panic!("{name}: {e:#}"))
    }

    /// The whole record for one misspelling, and every number in it is what
    /// `typos --format json 1.49.1` printed for this exact file. That is the
    /// point of the test: poly now computes the line, the offset within it and
    /// the width itself, and an off-by-one here moves the squiggle in every
    /// file anyone has.
    ///
    /// The column is a *byte* offset into the line while the width counts
    /// *characters* -- inherited from the JSON, asserted so nobody tidies it up
    /// without meaning to.
    #[test]
    fn a_misspelling_carries_typos_own_message_and_position() {
        let dir = spelling_project(
            "",
            &[(
                "src/main.rs",
                b"// A recieve typo and a Recieve one.\nlet abandonned = 1;\n",
            )],
        );
        let issues = spell_at(&dir, "src/main.rs");
        assert_eq!(issues.len(), 3, "{issues:?}");

        let first = &issues[0];
        assert_eq!(first.message, "`recieve` should be `receive`");
        assert_eq!(first.source, "typos");
        assert_eq!(first.code, "typo");
        assert_eq!(first.severity, Severity::Info);
        assert_eq!(first.fix, Some(Fix::Automatic));
        assert_eq!(first.url, None);
        assert_eq!((first.line, first.col), (0, 5), "{first:?}");
        assert_eq!((first.end_line, first.end_col), (0, 12), "{first:?}");

        // Case is the dictionary's own doing, and the reason `typos` had to
        // come in whole: a hand-rolled word list corrects this to `receive`.
        assert_eq!(issues[1].message, "`Recieve` should be `Receive`");
        assert_eq!((issues[1].line, issues[1].col), (0, 24), "{issues:?}");

        // Second line, so the line counter has actually advanced and the
        // column is measured from the start of *that* line.
        assert_eq!(issues[2].message, "`abandonned` should be `abandoned`");
        assert_eq!((issues[2].line, issues[2].col), (1, 4), "{issues:?}");
    }

    /// typos reports a misspelled file name with no line number at all. poly
    /// anchors it at the very start and says why, rather than aiming a path
    /// offset at whatever happens to sit at that offset in the contents.
    #[test]
    fn a_misspelled_file_name_is_anchored_at_the_start() {
        let dir = spelling_project("", &[("reciever.py", b"x = 1\n")]);
        let issues = spell_at(&dir, "reciever.py");
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert_eq!(
            issues[0].message,
            "`reciever` should be `receiver` (in the file name)"
        );
        // Zero width, not the length of the word: there is no line for the
        // word to have a width on.
        assert_eq!(
            (
                issues[0].line,
                issues[0].col,
                issues[0].end_line,
                issues[0].end_col
            ),
            (0, 0, 0, 0),
            "{issues:?}"
        );
    }

    /// `[default.extend-words]` mapping a word to itself is how a project says
    /// a misspelling is load-bearing -- this repo's own `_typos.toml` does it
    /// for parser fixtures. Only `typos_cli::config` reads that table, which is
    /// why poly links the whole crate rather than the dictionary alone.
    #[test]
    fn a_projects_extend_words_suppresses() {
        let allowed = spelling_project(
            "[default.extend-words]\nteh = \"teh\"\n",
            &[("a.md", b"teh recieve\n")],
        );
        let issues = spell_at(&allowed, "a.md");
        assert_eq!(issues.len(), 1, "only `recieve` survives: {issues:?}");
        assert!(issues[0].message.starts_with("`recieve`"), "{issues:?}");

        // Same file, no such entry: proof the suppression is the config and
        // not the dictionary declining to have an opinion.
        let plain = spelling_project("", &[("a.md", b"teh recieve\n")]);
        assert_eq!(spell_at(&plain, "a.md").len(), 2);
    }

    /// `extend-ignore-re` blanks out a region of a file. Without it poly
    /// reports inside the base64 blobs and vendored tables projects use it for.
    #[test]
    fn extend_ignore_re_blanks_out_a_region() {
        let dir = spelling_project(
            "[default]\nextend-ignore-re = [\"(?s)IGNORE-START.*?IGNORE-END\"]\n",
            &[("a.md", b"IGNORE-START seperate IGNORE-END\nand a recieve\n")],
        );
        let issues = spell_at(&dir, "a.md");
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert!(issues[0].message.starts_with("`recieve`"), "{issues:?}");
    }

    /// typos checks a lockfile and a certificate with no dictionary and skips a
    /// picture outright. Losing any of the three means poly reporting
    /// "misspellings" in machine-written files, which is noise nobody can act
    /// on -- and it is `typos_cli`'s per-file-type policy, not poly's, that
    /// decides so.
    #[test]
    fn machine_written_and_binary_files_are_left_alone() {
        // A real PNG header, so content_inspector calls it binary, with the
        // bytes of a typo after it.
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01".to_vec();
        png.extend_from_slice(b"\x00recieve abandonned\x00");
        let dir = spelling_project(
            "",
            &[
                (
                    "package-lock.json",
                    b"{\"name\": \"abandonned-recieve\"}\n".as_slice(),
                ),
                (
                    "server.crt",
                    b"-----BEGIN CERTIFICATE-----\nMIIBabandonnedrecieve\n".as_slice(),
                ),
                ("pixel.png", &png),
                // The control: the same words in a file with no special type
                // are still reported, so this test cannot pass by checking
                // nothing at all.
                ("notes.md", b"abandonned recieve\n".as_slice()),
            ],
        );
        assert!(spell_at(&dir, "package-lock.json").is_empty());
        assert!(spell_at(&dir, "server.crt").is_empty());
        assert!(spell_at(&dir, "pixel.png").is_empty());
        assert_eq!(spell_at(&dir, "notes.md").len(), 2);
    }

    /// `[files] extend-exclude` used to be applied by typos' own walk. poly
    /// walks now, so it has to be applied per file or a repo that told typos to
    /// leave a directory alone would silently have all of it read.
    #[test]
    fn files_extend_exclude_still_excludes() {
        let dir = spelling_project(
            "[files]\nextend-exclude = [\"vendored/**\"]\n",
            &[
                ("vendored/lib.js", b"// recieve\n".as_slice()),
                ("src/lib.js", b"// recieve\n".as_slice()),
            ],
        );
        assert!(spell_at(&dir, "vendored/lib.js").is_empty());
        assert_eq!(spell_at(&dir, "src/lib.js").len(), 1);
    }

    /// A file whose nearest config is not the one at the repo root answers to
    /// its own. The typos binary could not do this for `poly check` -- it
    /// loaded one config per command-line argument -- so the editor and CI
    /// disagreed about a package that configured itself (A4).
    #[test]
    fn the_nearest_config_wins_per_file() {
        let dir = spelling_project(
            "",
            &[
                ("outer.md", b"teh\n".as_slice()),
                (
                    "pkg/_typos.toml",
                    b"[default.extend-words]\nteh = \"teh\"\n",
                ),
                ("pkg/inner.md", b"teh\n".as_slice()),
            ],
        );
        assert_eq!(spell_at(&dir, "outer.md").len(), 1);
        assert!(spell_at(&dir, "pkg/inner.md").is_empty());
    }
}

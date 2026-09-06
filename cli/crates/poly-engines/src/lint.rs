//! Embedded lint: sqruff for SQL, selene for Lua, ruff for Python and Jupyter,
//! deno_lint for JavaScript and TypeScript, rumdl for Markdown, poly's own
//! rules for Dockerfiles and GitHub Actions workflows, and typos over every
//! file regardless of language.
//! External-tool lint (shellcheck, hadolint, actionlint) lives in poly-tools;
//! the LSP daemon and the CLI merge both sources.
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
use poly_core::diag::{severity_of, Fix, Issue, Reported, Severity};

/// Which embedded checker lints this file, under the name its findings carry.
///
/// Takes the path as well as the language because YAML is only linted when it
/// is a workflow: a repository of Kubernetes manifests and Helm charts is
/// thousands of YAML files poly has no opinion about, and `is_workflow_file` is
/// the same question `lint` asks below. The two have to agree, which is why
/// neither answers it alone.
///
/// The name is the one that appears in `[source/code]`, so a coverage line and
/// a finding are the same word -- `poly/docker` is the prefix of every
/// `poly/docker-*` code, and `ruff` is what a Python finding is signed with.
///
/// Spelling is not on this list and never can be: see `spell`.
///
/// "Which checker exists for this file", not "which one poly will run": a
/// project that carries eslint or biome keeps them, and the caller that knows
/// about project-local tools is the one that decides (`poly-cli`'s
/// `lint_engine`, A3).
pub fn engine(lang: &str, path: &Path) -> Option<&'static str> {
    Some(match lang {
        "sql" => "sqruff",
        "toml" => "toml",
        "lua" => "selene",
        "python" | "jupyter" => "ruff",
        "typescript" => "deno_lint",
        "graphql" => "graphql",
        "markdown" => "rumdl",
        "dockerfile" => "poly/docker",
        "yaml" if poly_core::is_workflow_file(path) => "poly/actions",
        other if crate::proto::supported(other) => "poly/proto",
        _ => return None,
    })
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
        // One namespace for every rule poly wrote, four tables behind it: the
        // codes are already prefixed by what they lint (`docker-`, `actions-`,
        // `proto-`), so a fourth engine adds a table here rather than a second
        // source name the reader has to learn. `INLINE_RULES` is poly-core's
        // because the rule is poly-core's -- a suppression comment is not a
        // language's.
        "poly" => poly_rule(code).map(|(_, _, doc)| *doc),
        _ => None,
    }
}

/// The level poly reports its own `code` at.
///
/// `severity_of` answers this for every other source, from what the tool said.
/// poly's rules have no upstream to take a word from, so the level is a
/// property of the rule and lives in the rule's own row -- one place per rule
/// for what it says, what it means and how loud it is, rather than a level
/// chosen at whichever of the 63 emit sites happens to construct it.
///
/// A code with no row falls back to warning and cannot happen: the
/// both-directions tests over the four tables hold them to the codes the
/// linters emit, so an unlisted rule fails a test rather than arriving here.
pub fn rule_severity(code: &str) -> Severity {
    poly_rule(code).map_or(Severity::Warning, |(_, severity, _)| *severity)
}

fn poly_rule(code: &str) -> Option<&'static (&'static str, Severity, &'static str)> {
    DOCKER_RULES
        .iter()
        .chain(crate::workflow::RULES)
        .chain(crate::proto::RULES)
        .chain(poly_core::INLINE_RULES)
        .find(|(rule, _, _)| *rule == code)
}

/// Lint `text` as `lang` with embedded engines only. Languages without one
/// return no issues.
pub fn lint(lang: &str, path: &Path, text: &str) -> Result<Vec<Issue>> {
    match lang {
        "sql" => lint_sql(text),
        "toml" => Ok(lint_toml(text)),
        "lua" => lint_lua(path, text),
        "python" | "jupyter" => lint_python(path, text),
        // One language name for eight extensions (.ts through .cjs), so the
        // file name is what tells JSX from a comparison -- see `lint_typescript`.
        "typescript" => lint_typescript(path, text),
        "graphql" => Ok(lint_graphql(text)),
        // Reads the path for a third reason: two of the seven rules ask the
        // file system about the links in the text -- see `lint_markdown`.
        "markdown" => lint_markdown(path, text),
        "dockerfile" => Ok(lint_dockerfile(text)),
        // A workflow is YAML, so this is the one arm that reads the path as well
        // as the language: `poly check` on a Kubernetes repository must not
        // report `unknown workflow key` on every manifest in it.
        "yaml" if poly_core::is_workflow_file(path) => Ok(crate::workflow::lint(text)),
        // Reads the path for a different reason: the `buf.yaml` governing this
        // file decides which of poly's rules the project asked for.
        "protobuf" => Ok(crate::proto::lint(path, text)),
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
        severity: severity_of("toml", Reported::Nothing),
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
                severity: severity_of("sqruff", Reported::Nothing),
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
    let key = poly_core::nearest_ancestor_file(path, &["selene.toml"]);
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
                selene_lib::lints::Severity::Error => severity_of("selene", Reported::Error),
                selene_lib::lints::Severity::Warning => severity_of("selene", Reported::Warning),
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
        severity: severity_of("selene", Reported::Error),
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
        // `Nothing`, not what ruff says: ruff calls every finding an error,
        // including the style rules, and passing that through would make a
        // missing trailing comma as loud as a syntax error. A scale that ranks
        // everything the same ranks nothing, so poly ranks it (`severity_of`).
        severity: severity_of("ruff", Reported::Nothing),
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

// ── javascript and typescript (deno_lint) ──────────────────────────────────

/// What a project's `deno.json` says about linting, and nothing else.
///
/// `lint.rules` is the whole of it. `deno lint` also reads `lint.include` and
/// `lint.exclude`, and poly deliberately does not: which files are checked is
/// the walk's answer and `[lint] exclude`'s, the same division ruff and selene
/// already live under here -- their configs pick rules, poly picks files.
#[derive(Default, serde::Deserialize)]
struct DenoConfig {
    lint: Option<DenoLint>,
    #[serde(rename = "compilerOptions")]
    compiler_options: Option<DenoCompilerOptions>,
}

/// The two compiler settings a *lint* run depends on.
///
/// Not a general reader of `compilerOptions`: these two name the function JSX
/// compiles to, which is the difference between `import React` being used and
/// being an unused import. Everything else there is the type checker's.
#[derive(Default, serde::Deserialize)]
struct DenoCompilerOptions {
    #[serde(rename = "jsxFactory")]
    jsx_factory: Option<String>,
    #[serde(rename = "jsxFragmentFactory")]
    jsx_fragment_factory: Option<String>,
}

#[derive(Default, serde::Deserialize)]
struct DenoLint {
    rules: Option<DenoRules>,
}

#[derive(Default, serde::Deserialize)]
struct DenoRules {
    tags: Option<Vec<String>>,
    include: Option<Vec<String>>,
    exclude: Option<Vec<String>>,
}

/// Recommended rules that are about Deno the runtime rather than about
/// JavaScript, and are off in a project that is not a Deno project.
///
/// Both say so in their own message -- "Window is no longer available in Deno",
/// "for compatibility between the Window context and the Web Workers" -- and
/// both are simply untrue of a browser or Electron renderer, where `window` is
/// the global that is supposed to be there. Over 25,489 real files they were
/// 2,334 findings in 426 files, every one of them telling a browser project
/// that a working line of code does not work.
///
/// This is not poly editing somebody's rule set: it is the same question
/// `engine` asks about YAML, where a repository of Kubernetes manifests is
/// thousands of files the workflow rules have no opinion about. A project with
/// a `deno.json` *is* a Deno project, so there the recommended set is run
/// whole and poly's answer is `deno lint`'s answer.
///
/// The rest of the recommended set stays on, including `require-await`, which
/// was 67% of the findings in that corpus: an `async` function with no `await`
/// in it is deno's default opinion and precisely poly's definition of a
/// warning -- suspicious, possibly deliberate, worth a look. A project that
/// disagrees has one line of poly.toml (`[lint] ignore`).
const DENO_RUNTIME_RULES: &[&str] = &["no-window", "no-window-prefix"];

/// deno's own defaults for the two settings above, which are TypeScript's.
///
/// They matter to one rule and matter a lot: with no factory named, the `React`
/// in `import React from "react"` is used by nothing a linter can see, and
/// `no-unused-vars` fires on every `.tsx` file in a project using the classic
/// runtime. That was the entire difference between poly and `deno lint` over
/// 25,489 files -- five findings, all of them this.
const JSX_FACTORY: &str = "React.createElement";
const JSX_FRAGMENT_FACTORY: &str = "React.Fragment";

/// The rules and the JSX settings governing one file, built once per
/// `deno.json`.
struct JsLinter {
    linter: deno_lint::linter::Linter,
    config: deno_lint::linter::LintConfig,
}

/// The linter governing `path`, built once per `deno.json`.
///
/// Keyed by config file for the reason `lua_linter` is: a monorepo can have
/// several, and building the 122 rule objects per file would be paid once per
/// file in a repository of thousands.
fn js_linter(path: &Path) -> Result<Arc<JsLinter>> {
    type Cache = HashMap<Option<PathBuf>, std::result::Result<Arc<JsLinter>, String>>;
    static CACHE: Mutex<Option<Cache>> = Mutex::new(None);
    let key = poly_core::nearest_ancestor_file(path, &["deno.json", "deno.jsonc"]);
    let mut guard = CACHE.lock().expect("js linter cache lock");
    let cache = guard.get_or_insert_with(HashMap::new);
    let built = match cache.get(&key) {
        Some(hit) => hit.clone(),
        None => {
            let built = build_js_linter(key.as_deref())
                .map(Arc::new)
                .map_err(|e| format!("{e:#}"));
            cache.insert(key, built.clone());
            built
        }
    };
    built.map_err(|e| anyhow!(e))
}

fn build_js_linter(config_file: Option<&Path>) -> Result<JsLinter> {
    let config: DenoConfig = match config_file {
        Some(file) => {
            let text = std::fs::read_to_string(file)
                .with_context(|| format!("reading {}", file.display()))?;
            // Comments are legal in both spellings -- `deno.jsonc` announces it
            // and `deno.json` allows it anyway -- so this is the parser deno
            // reads the file with rather than a plain JSON one.
            let value = jsonc_parser::parse_to_serde_value(&text, &Default::default())
                .with_context(|| format!("parsing {}", file.display()))?;
            match value {
                Some(value) => serde_json::from_value(value)
                    .with_context(|| format!("reading the lint section of {}", file.display()))?,
                None => DenoConfig::default(),
            }
        }
        // No deno.json is the ordinary case: a Node or browser project is
        // still JavaScript, and deno's own defaults are what it gets.
        None => DenoConfig::default(),
    };
    let compiler_options = config.compiler_options.unwrap_or_default();
    let rules = config.lint.unwrap_or_default().rules.unwrap_or_default();
    let mut exclude = rules.exclude.unwrap_or_default();
    if config_file.is_none() {
        exclude.extend(DENO_RUNTIME_RULES.iter().map(|rule| (*rule).to_string()));
    }
    let selected = deno_lint::rules::filtered_rules(
        deno_lint::rules::get_all_rules(),
        // deno's default when `tags` is absent, spelled out because
        // `filtered_rules` reads `None` as "every rule there is".
        Some(
            rules
                .tags
                .unwrap_or_else(|| vec!["recommended".to_string()]),
        ),
        Some(exclude),
        rules.include,
    );
    Ok(JsLinter {
        linter: deno_lint::linter::Linter::new(deno_lint::linter::LinterOptions {
            rules: selected,
            // Every code there is, not just the enabled ones: this is what
            // `ban-unknown-rule-code` checks a `// deno-lint-ignore` against,
            // and narrowing it would report a real rule as a typo.
            all_rule_codes: deno_lint::rules::get_all_rules()
                .into_iter()
                .map(|rule| std::borrow::Cow::Borrowed(rule.code()))
                .collect(),
            // The directives deno itself honours. poly's own `# poly: ignore`
            // is applied later, over every source alike.
            custom_ignore_file_directive: None,
            custom_ignore_diagnostic_directive: None,
        }),
        config: deno_lint::linter::LintConfig {
            // A pragma in the file still wins; this is only what applies when
            // the file says nothing, which is deno's rule for it too.
            default_jsx_factory: Some(
                compiler_options
                    .jsx_factory
                    .unwrap_or_else(|| JSX_FACTORY.to_string()),
            ),
            default_jsx_fragment_factory: Some(
                compiler_options
                    .jsx_fragment_factory
                    .unwrap_or_else(|| JSX_FRAGMENT_FACTORY.to_string()),
            ),
        },
    })
}

/// Lint one JavaScript or TypeScript file with the rules `deno lint` would.
///
/// A file that does not parse is reported as `typescript/syntax` rather than
/// returned as an error: one unparsable file is a finding about that file, and
/// failing the call would mark the whole embedded pass broken and take every
/// other file's findings down with it.
fn lint_typescript(path: &Path, text: &str) -> Result<Vec<Issue>> {
    use deno_ast::diagnostics::Diagnostic;

    let linter = js_linter(path)?;
    // Absolute, because a `file://` URL cannot be built from a relative path.
    // The specifier only names the file in diagnostics poly rewrites anyway, so
    // a path that will not absolutize falls back to something parseable rather
    // than skipping the file.
    let specifier = std::path::absolute(path)
        .ok()
        .and_then(|abs| deno_ast::ModuleSpecifier::from_file_path(abs).ok())
        .unwrap_or_else(|| {
            deno_ast::ModuleSpecifier::parse("file:///buffer.ts").expect("a literal file URL")
        });
    let result = linter.linter.lint_file(deno_lint::linter::LintFileOptions {
        specifier,
        source_code: text.to_string(),
        // From the path rather than from the specifier: the extension is what
        // decides whether `<div/>` is JSX or a comparison, and poly maps eight
        // of them to this one language.
        media_type: deno_ast::MediaType::from_path(path),
        config: linter.config.clone(),
        // The hook deno's own CLI hangs its JavaScript plugins on. poly runs no
        // plugins, and a project that wants them has `deno lint`.
        external_linter: None,
    });
    let (parsed, diagnostics) = match result {
        Ok(pair) => pair,
        Err(parse) => return Ok(vec![js_parse_error(text, &parse)]),
    };
    // swc recovers from most syntax errors and keeps parsing, so a file can be
    // linted and invalid at once. Those recovered errors are reported too:
    // `Err` above is only the one swc could not get past, and a run that showed
    // three lint findings while silently swallowing "unterminated string" would
    // be describing a file that does not run as if it merely had opinions.
    let mut issues: Vec<Issue> = parsed
        .diagnostics()
        .iter()
        .map(|d| js_parse_error(text, d))
        .collect();
    issues.extend(diagnostics.iter().map(|d| {
        // Diagnostics with no range are about the whole file; deno_lint has
        // none today, and line 0 is where poly puts a file-wide claim.
        let (line, col, end_line, end_col) = d
            .range
            .as_ref()
            .map_or((0, 0, 0, 0), |r| span(text, r.range));
        Issue {
            line,
            col,
            end_line,
            end_col,
            severity: severity_of("deno_lint", Reported::Nothing),
            code: d.details.code.clone(),
            // The hint is half the message for most of these rules --
            // `no-window` says what is wrong and the hint says to write
            // `globalThis` -- and poly has one line to say both in.
            message: match &d.details.hint {
                Some(hint) => format!("{} ({hint})", d.details.message),
                None => d.details.message.clone(),
            },
            source: "deno_lint",
            // Every fix deno_lint carries is a rewrite it describes; poly
            // does not apply them, so the description is the whole of what
            // it can pass on.
            fix: d.details.fixes.first().map(|fix| Fix::Described {
                what: fix.description.to_string(),
                // deno_lint has no unsafe tier: a rule offers a fix when
                // the rewrite preserves behaviour.
                safe: true,
            }),
            url: d.docs_url().map(|url| url.into_owned()),
        }
    }));
    Ok(issues)
}

/// The file is not JavaScript. swc's message, at swc's position.
fn js_parse_error(text: &str, parse: &deno_ast::ParseDiagnostic) -> Issue {
    use deno_ast::diagnostics::Diagnostic;

    // Through `span` rather than `display_position`, which is 1-based and
    // counts a tab as two columns: a file indented with tabs would put the
    // squiggle in the wrong place, and only in that file.
    let (line, col, end_line, end_col) = span(text, parse.range());
    Issue {
        line,
        col,
        end_line,
        end_col,
        severity: severity_of("typescript", Reported::Nothing),
        code: "syntax".to_string(),
        message: parse.message().to_string(),
        source: "typescript",
        fix: None,
        // There is no rule to link, only the grammar swc is enforcing.
        url: None,
    }
}

/// A deno_lint range as poly's four 0-based numbers.
///
/// `SourcePos` counts from `START_SOURCE_POS`, which is what deno_ast documents
/// as the position every parse starts at, so subtracting it gives the byte
/// offset into the text poly handed over -- and `line_col` takes it from there,
/// so a deno_lint finding is placed exactly as a ruff or selene one is.
fn span(text: &str, range: deno_ast::SourceRange) -> (u32, u32, u32, u32) {
    let start = deno_ast::StartSourcePos::START_SOURCE_POS;
    let (line, col) = line_col(text, range.start.as_byte_index(start));
    let (end_line, end_col) = line_col(text, range.end.as_byte_index(start));
    (line, col, end_line, end_col)
}

// ── graphql (apollo-parser) ────────────────────────────────────────────────

/// GraphQL's grammar, and deliberately nothing else.
///
/// The same claim `toml/syntax` and `typescript/syntax` make: this file is not
/// the language its name says it is, said at the character where that stopped
/// being true. The parser is the one already in the binary -- pretty_graphql is
/// built on apollo-parser, so `poly fmt` has been reading GraphQL with it all
/// along -- which is what makes "the formatter refused it" and "the linter
/// reported it" the same sentence about the same character rather than two
/// tools' opinions.
///
/// *Validating* GraphQL is a different question, and the answer is no (09
/// §4.7). apollo-compiler can do it, and over 854 real `.graphql` files its
/// verdict was 908 findings of which about 99% were "defined in another file":
/// federation's `@link` directives, types declared in a sibling module, a
/// schema fragment with no root type. A schema is assembled from many files and
/// poly reads one, so almost every validation rule would be reporting the
/// shape of the project rather than a defect. The parser has no such problem:
/// a file either is GraphQL or is not.
fn lint_graphql(text: &str) -> Vec<Issue> {
    apollo_parser::Parser::new(text)
        .parse()
        .errors()
        .map(|error| {
            let (line, col) = line_col(text, error.index());
            // `data` is the token the parser choked on, so the squiggle covers
            // it. It is empty for the errors that are about the end of the file
            // rather than about a token, and there the range collapses to the
            // position -- which is the honest extent of "it stopped here".
            let (end_line, end_col) = line_col(text, error.index() + error.data().len());
            Issue {
                line,
                col,
                end_line,
                end_col,
                severity: severity_of("graphql", Reported::Nothing),
                code: "syntax".to_string(),
                message: error.message().to_string(),
                source: "graphql",
                fix: None,
                // No rule to link, only the grammar the parser is enforcing.
                // The edition matters and apollo-parser names it: October 2021.
                url: Some("https://spec.graphql.org/October2021/".to_string()),
            }
        })
        .collect()
}

/// The sentence `poly fmt` puts on a GraphQL file it could not parse.
///
/// pretty_graphql builds its own message in `Display`, and that code panics on
/// an error at byte 0: it maps the offset to line 0 and then indexes
/// `line_bounds[line - 1]`. `!!!` is enough to reach it, and the blast radius
/// was the whole command -- `poly fmt` over a repository with one malformed
/// `.graphql` in it exited 101 having formatted nothing, and in the editor it
/// was the daemon that died. So poly never formats that error: it reads the
/// same parser's errors itself, which also puts the column in characters like
/// every other engine here rather than in bytes.
pub(crate) fn graphql_format_error(text: &str) -> String {
    match lint_graphql(text).first() {
        // The wording pretty_graphql used, kept: `parse_position` reads it, and
        // `every_engine_error_can_be_placed` holds every engine to a shape it
        // can read.
        Some(issue) => format!(
            "syntax error at line {}, col {}: {}",
            issue.line + 1,
            issue.col + 1,
            issue.message
        ),
        // The formatter refused a document this parser accepts. Same parser and
        // same input, so there is nothing that can put us here -- and if
        // something does, the file must still not format silently.
        None => "syntax error".to_string(),
    }
}

// ── markdown (rumdl) ───────────────────────────────────────────────────────

/// The seven rumdl rules poly runs, out of the eighty-four rumdl has.
///
/// rumdl is a linter *and* a formatter, and for Markdown poly is already the
/// formatter. Over 4,947 real `.md` files rumdl reported 120,570 findings, and
/// running `poly fmt` in between two runs of it is what divides them:
///
/// * 13 rules go to zero once the file has been formatted -- they were
///   reporting the layout `poly fmt` produces.
/// * MD013 (line length) survives formatting and is 77.3% of what is left, for
///   the same reason: poly's Markdown formatter does not reflow prose.
/// * MD036 goes *up*, 1,340 -> 2,394. `poly fmt` puts a blank line after a
///   bold line that introduces a list, and MD036 then reads that line as a
///   paragraph pretending to be a heading. `poly fmt` creates 1,054 of them.
///
/// So the whole set is not on the table: `poly check` would report 2,394
/// findings that `poly fmt` wrote a second earlier, which is the failure that
/// turned hadolint's and actionlint's shellcheck passes off.
///
/// These seven pass both halves of the test rather than one. Their count is
/// identical either side of formatting -- 948 before, 948 after, so `poly fmt`
/// has no opinion about them -- and each reports something *broken* rather than
/// a preference: a link to a file that is not there, an anchor no heading
/// defines, `(text)[url]` written backwards. 948 findings in 202 of those
/// files, 0.93% of what rumdl says about them.
///
/// A project's own `.rumdl.toml` is deliberately not read, which is where this
/// engine parts company with ruff, selene and deno_lint. Their configs pick
/// rules for a tool that only lints; a rumdl config picks rules for a rumdl
/// that also formats, and honouring one would put MD036 and the twelve like it
/// back on top of poly's own formatter. Which rules run stays poly's answer
/// (09 §1.3), and `[lint] ignore` is how a project subtracts from it.
const MARKDOWN_RULES: &[&str] = &[
    "MD001", "MD011", "MD042", "MD045", "MD051", "MD052", "MD057",
];

/// The seven, built once.
///
/// `Rule` is `Send + Sync`, so unlike the per-config caches above this is one
/// set for the whole process: nothing about it depends on which file or which
/// project is being linted.
fn markdown_rules() -> &'static [Box<dyn rumdl_lib::rule::Rule>] {
    static RULES: OnceLock<Vec<Box<dyn rumdl_lib::rule::Rule>>> = OnceLock::new();
    RULES.get_or_init(|| {
        let config = rumdl_lib::config::Config::default();
        MARKDOWN_RULES
            .iter()
            .map(|name| {
                rumdl_lib::rules::create_rule_by_name(name, &config)
                    .expect("a rule name the pinned rumdl has")
            })
            .collect()
    })
}

/// Which Markdown this file is written in.
///
/// poly maps `.mdx` onto the same language as `.md` -- one formatter, one
/// language id in the editor -- but they are not the same grammar, and rumdl
/// knows the difference: in MDX a `{expression}` and a `<Component />` are
/// syntax rather than the stray braces and raw HTML that Standard reads them
/// as. The other flavors rumdl has (MkDocs, Pandoc, Quarto) are project-wide
/// choices with no extension to detect them by, so they stay out of reach until
/// something asks for them.
fn markdown_flavor(path: &Path) -> rumdl_lib::config::MarkdownFlavor {
    match path.extension().and_then(std::ffi::OsStr::to_str) {
        Some("mdx") => rumdl_lib::config::MarkdownFlavor::MDX,
        _ => rumdl_lib::config::MarkdownFlavor::Standard,
    }
}

/// Lint one Markdown file with the seven rules above.
///
/// The path is passed as well as the text because two of the seven resolve
/// against the file system: MD057 asks whether `../CONTRIBUTING.md` exists, and
/// both it and MD051 resolve relative to the file's own directory. The text is
/// still what gets linted, so an editor buffer with unsaved edits is checked as
/// it stands -- the path only says where it stands.
fn lint_markdown(path: &Path, text: &str) -> Result<Vec<Issue>> {
    let warnings = rumdl_lib::lint(
        text,
        markdown_rules(),
        false,
        markdown_flavor(path),
        Some(path.to_path_buf()),
        // rumdl's own `Config`, which the rules were already built from. It is
        // read again here for per-file overrides poly does not use.
        None,
    )
    .map_err(|e| anyhow!("rumdl error: {e}"))?;
    Ok(warnings
        .into_iter()
        .map(|w| {
            // Every rule signs its warnings; the field is an Option because the
            // type is also what a rule's own tests construct by hand.
            let code = w.rule_name.unwrap_or_default();
            Issue {
                // rumdl counts lines and columns from 1, in characters; poly
                // counts from 0, in characters. Saturating because a rule that
                // reported column 0 would otherwise wrap to the end of the line
                // rather than land at its start.
                line: w.line.saturating_sub(1) as u32,
                col: w.column.saturating_sub(1) as u32,
                end_line: w.end_line.saturating_sub(1) as u32,
                end_col: w.end_column.saturating_sub(1) as u32,
                severity: severity_of("rumdl", markdown_level(w.severity)),
                message: w.message,
                source: "rumdl",
                // rumdl's fix is a rewrite with no sentence attached: a range
                // and the text to put there. poly does not apply it -- `poly
                // fmt` is dprint, not rumdl -- so "it can be rewritten" is the
                // whole of what there is to pass on.
                fix: w.fix.is_some().then_some(Fix::Automatic),
                url: Some(format!("https://rumdl.dev/{}/", code.to_lowercase())),
                code,
            }
        })
        .collect())
}

/// rumdl's three levels in the vocabulary `severity_of` translates from.
fn markdown_level(severity: rumdl_lib::rule::Severity) -> Reported {
    match severity {
        rumdl_lib::rule::Severity::Error => Reported::Error,
        rumdl_lib::rule::Severity::Warning => Reported::Warning,
        rumdl_lib::rule::Severity::Info => Reported::Info,
    }
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
///
/// # What the three severities mean here
///
/// poly is the only opinion on a Dockerfile now -- hadolint defaults to off --
/// so these decide what `[lint] fail-on` blocks a build on, and a tier picked
/// per rule by feel is a tier nobody can predict. Every rule carries its level
/// in the row below, under one definition:
///
/// * `Error` -- poly expects the build, or Docker itself, to reject this. It is
///   about to fail; the only question is how far in. Four rules qualify.
/// * `Warning` -- it builds, and the image or the build is wrong, fragile or
///   contradictory in a way with a cost somebody pays later. Most rules.
/// * `Info` -- it builds and behaves; what is here is redundant or deprecated,
///   and removing it changes nothing at runtime.
///
/// The line matters most where poly disagrees with hadolint, and it settles
/// both directions. A second `ENTRYPOINT` is unambiguously a mistake and
/// hadolint calls it an error, but the image builds and runs, so it stays a
/// warning -- promoting it would make `Error` mean "a mistake" instead of "it
/// does not build", and then the tier stops predicting anything. `MAINTAINER`
/// is hadolint's error and poly's info for the same reason read the other way:
/// it builds, it runs, and the value is simply not in the image's metadata.
const DOCKER_RULES: &[(&str, Severity, &str)] = &[
    (
        "docker-add-instead-of-copy",
        Severity::Warning,
        "`ADD` does three jobs: it copies, it downloads URLs, and it unpacks \
         local tar archives in place. Only the first is usually meant, and the \
         other two happen silently -- a source that turns out to be a tarball \
         arrives extracted, and one that turns out to be a URL is fetched at \
         build time with no checksum and no cache. `COPY` copies. Use `ADD` \
         when the extraction is the point, and say so.",
    ),
    (
        "docker-apk-no-cache",
        Severity::Warning,
        "`apk add` writes a package index under /var/cache/apk that nothing \
         reads again, and it stays in the layer forever. `--no-cache` fetches \
         the index, uses it, and never writes it -- equivalent to \
         `apk update && apk add && rm -rf /var/cache/apk/*` in one flag, and \
         with no way to forget the last third.",
    ),
    (
        "docker-apk-unpinned",
        Severity::Warning,
        "`apk add curl` installs whichever curl the Alpine mirror serves today. \
         The same Dockerfile then builds different software next week, and a \
         build that worked cannot be reproduced to find out what changed. \
         `apk add curl=8.5.0-r0` says which one.",
    ),
    (
        "docker-apt-get-interactive",
        // The one rule where poly is louder than hadolint (which calls it a
        // warning), and it stays that way now poly is the only voice. The
        // corpus agrees in the way that matters -- one occurrence in 256 real
        // Dockerfiles, because a file with this in it never built and so never
        // got committed.
        Severity::Error,
        "Without `-y`, `apt-get install` asks for a confirmation. A build has no \
         terminal to type it into, so apt reads EOF and aborts -- or, worse, \
         waits. This is a broken build, not a style preference.",
    ),
    (
        "docker-apt-get-no-clean",
        Severity::Warning,
        "`apt-get update` leaves tens of megabytes of package lists under \
         /var/lib/apt/lists. Nothing reads them after the install, and deleting \
         them in a *later* layer does not shrink the image -- the bytes are \
         already committed. `rm -rf /var/lib/apt/lists/*` has to be in the same \
         `RUN`. A `RUN --mount=type=cache` over the apt directories is the other \
         answer, and this rule does not fire on one.",
    ),
    (
        "docker-apt-get-no-recommends",
        Severity::Warning,
        "Debian's recommended packages are installed by default and are \
         routinely larger than what was asked for -- a build tool pulling in a \
         documentation set, a client pulling in a server. Every one of them is \
         software in the image that nobody chose and nobody audits. \
         `--no-install-recommends` installs what the line says.",
    ),
    (
        "docker-apt-get-unpinned",
        Severity::Warning,
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
        Severity::Warning,
        "An `apt-get update` in its own `RUN` becomes a layer Docker will \
         happily reuse for months. The `apt-get install` in the next `RUN` then \
         resolves against a package index from whenever that layer was built, \
         and installs versions the mirror no longer has -- a 404 in the middle \
         of a build that changed nothing. Update and install in one `RUN` so \
         they are cached or invalidated together.",
    ),
    (
        "docker-apt-not-apt-get",
        Severity::Warning,
        "`apt` prints \"this APT has Super Cow Powers\" and, more to the point, \
         \"WARNING: apt does not have a stable CLI interface. Use with caution \
         in scripts.\" -- upstream's own words. Its output format and its flags \
         are free to change between Debian releases, so a `RUN apt install` that \
         works today can break on a base-image bump with no change to the \
         Dockerfile. `apt-get` and `apt-cache` are the interfaces Debian keeps \
         stable, and they are what a script should call.",
    ),
    (
        "docker-cd-in-run",
        Severity::Warning,
        "A `cd` inside `RUN` lasts exactly as long as that instruction's shell. \
         The next `RUN` starts back where the last `WORKDIR` left it, so a file \
         written by the line below lands somewhere other than the line above \
         suggests. `WORKDIR` changes the directory for everything after it, and \
         is visible in `docker inspect`.",
    ),
    (
        "docker-copy-multiple-sources-no-slash",
        Severity::Error,
        "With more than one source, `COPY` requires the destination to be a \
         directory, and the way to say so is a trailing slash. Without it the \
         build fails outright -- and on the day someone deletes one of the \
         sources it stops failing and starts silently copying a single file to \
         the destination *name*.",
    ),
    (
        "docker-copy-relative-no-workdir",
        Severity::Warning,
        "With no `WORKDIR` anywhere in the stage, a relative `COPY` destination \
         resolves against `/`. `COPY app.jar .` therefore lands the file at \
         `/app.jar`, which is almost never where the line was aiming -- and \
         because it succeeds, nothing says so until something further down \
         cannot find it. A `WORKDIR` above the `COPY` gives the destination a \
         stated meaning; an absolute destination says it outright.",
    ),
    (
        "docker-copy-whole-filesystem",
        Severity::Warning,
        "`COPY --from=stage / /` copies that stage's entire root over this one: \
         its `/etc/passwd`, its package database, its `/var`, its libraries. \
         What ships is then neither image, and the parts of the base that were \
         overwritten are whichever ones the other stage happened to have. It \
         also defeats layer caching completely -- every byte of the source stage \
         is one layer here. Copy the paths the image actually needs.",
    ),
    (
        "docker-duplicate-env-key",
        Severity::Warning,
        "Only the last `ENV` for a key survives into the image. The earlier one \
         is dead, and there is nothing in the file to say which of the two the \
         author meant -- the reader has to know that later wins.",
    ),
    (
        "docker-duplicate-label-key",
        Severity::Warning,
        "Only the last `LABEL` for a key survives into the image metadata. The \
         earlier one is dead, and a reader looking for the version an image \
         claims has two answers in front of them and no way to tell which one \
         `docker inspect` will print.",
    ),
    (
        "docker-from-platform-pinned",
        Severity::Warning,
        "`FROM --platform=linux/amd64 ...` builds that stage for that \
         architecture whatever the host is, and it *succeeds* on an arm64 \
         machine -- producing an image whose binaries cannot exec, which is a \
         message about the loader at `docker run` rather than anything at build \
         time. A multi-arch build wants the default (the host, or what buildx \
         asked for); a stage that genuinely has to be one architecture wants \
         `--platform=$BUILDPLATFORM` or a build argument that says why.",
    ),
    (
        "docker-from-platform-redundant",
        Severity::Info,
        "`--platform=$TARGETPLATFORM` is what `FROM` already does. buildx sets \
         `TARGETPLATFORM` to the platform it is building for and resolves every \
         unflagged `FROM` against exactly that, so the flag restates the \
         default and leaves a reader working out whether it was meant to change \
         something.",
    ),
    (
        "docker-go-install-unpinned",
        Severity::Warning,
        "`go install example.com/cmd@latest`, or a `go get` with no version at \
         all, resolves against whatever the module proxy serves at build time. \
         The binary in the image is then not the one that was tested, and \
         nothing in the repository records which one it was. `@v1.2.3` -- or a \
         commit -- names it.",
    ),
    (
        "docker-invalid-port",
        Severity::Error,
        "`EXPOSE` takes a TCP or UDP port: a number in 1..=65535, optionally \
         `/tcp` or `/udp`, optionally a range. Anything else is either a typo or \
         a misunderstanding of what the instruction takes, and Docker rejects \
         it at build time.",
    ),
    (
        "docker-latest-base",
        Severity::Warning,
        "`latest` is a tag that moves. The image that built and passed its tests \
         yesterday is not the image the same Dockerfile pulls today, and there \
         is nothing in the repository recording which one it was. Name the \
         version, or pin a digest with `@sha256:...` if the version itself is \
         not enough.",
    ),
    (
        "docker-maintainer-deprecated",
        Severity::Info,
        "`MAINTAINER` has been deprecated since Docker 1.13 and its value is not \
         part of the image's structured metadata. \
         `LABEL org.opencontainers.image.authors=\"...\"` is the replacement, is \
         in the OCI spec, and can be read back out of any registry.",
    ),
    (
        "docker-missing-from",
        Severity::Error,
        "A build starts from a base image, so the first instruction has to be \
         `FROM` (an `ARG` used to parameterise it may come before). Anything \
         else is a file that does not build.",
    ),
    (
        "docker-multiple-cmd",
        Severity::Warning,
        "Only the last `CMD` in a stage has any effect. An earlier one is dead \
         and reads as though it applies -- the usual cause is a second `CMD` \
         added without noticing the first.",
    ),
    (
        "docker-multiple-entrypoint",
        Severity::Warning,
        "Only the last `ENTRYPOINT` in a stage has any effect. An earlier one is \
         dead and reads as though it applies, and unlike a dead `CMD` there is \
         nothing at runtime that hints the container is starting something other \
         than what the first line named.",
    ),
    (
        "docker-npm-unpinned",
        Severity::Warning,
        "`npm install -g typescript` installs whatever the registry serves \
         today, so the same Dockerfile builds against a different compiler next \
         week. `typescript@5.4.5` says which one. Installing from a \
         package-lock.json instead -- `npm ci` -- pins everything at once and \
         this rule does not fire on it.",
    ),
    (
        "docker-pip-cache",
        Severity::Warning,
        "pip downloads every wheel into ~/.cache/pip and then never reads it \
         again: the image is built once, and the layer carries the cache for \
         the rest of its life. On a Python image that is routinely more than \
         the packages themselves. `--no-cache-dir` fetches, installs, and \
         writes nothing.",
    ),
    (
        "docker-pip-unpinned",
        Severity::Warning,
        "`pip install requests` installs whatever PyPI serves at build time, \
         including major versions released after the Dockerfile was written. \
         `requests==2.31.0`, or a requirements file that pins, makes the build \
         repeatable and makes an upgrade a reviewable change rather than a \
         Tuesday.",
    ),
    (
        "docker-pipe-without-pipefail",
        Severity::Warning,
        "`/bin/sh` reports the exit status of the *last* command in a pipeline. \
         `RUN curl ... | tar x` therefore succeeds when curl 404s, because tar \
         cheerfully unpacked nothing, and the failure surfaces much later as a \
         missing file. `SHELL [\"/bin/bash\", \"-o\", \"pipefail\", \"-c\"]` \
         makes the pipeline fail where it broke.",
    ),
    (
        "docker-root-user",
        Severity::Warning,
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
        Severity::Warning,
        "`ENV` and `ARG` values are baked into the image and are readable with \
         `docker history` by anyone who can pull it -- deleting the file later \
         does not remove them, because the layer that set them is still there. \
         A build-time secret belongs in `RUN --mount=type=secret`; a run-time \
         one belongs in the runtime environment, not the image.",
    ),
    (
        "docker-shell-form-command",
        Severity::Warning,
        "The shell form wraps the process in `/bin/sh -c`, which becomes PID 1 \
         and does not forward signals to its child. `docker stop` then reaches \
         the shell, the real process never sees SIGTERM, and the container is \
         SIGKILLed ten seconds later mid-write. The exec form \
         (`[\"prog\", \"arg\"]`) makes the process itself PID 1.",
    ),
    (
        "docker-sudo-in-run",
        Severity::Warning,
        "A `RUN` already runs as whatever the last `USER` said, which is root \
         unless the file says otherwise -- so `sudo` is either doing nothing or \
         is not installed. It also needs a TTY it does not have. If the step \
         needs different privileges, `USER` is how a Dockerfile says so.",
    ),
    (
        "docker-untagged-base",
        Severity::Warning,
        "An image reference with no tag means `:latest`, which is a tag that \
         moves. The same Dockerfile builds different software on different days \
         and nothing in the repository records which base it was. Name a \
         version, or pin a digest with `@sha256:...`.",
    ),
    (
        "docker-wget-and-curl",
        Severity::Info,
        "Two programs that fetch a URL, where the image needs one. Whichever \
         arrived second is a package to install, patch and carry for the life \
         of the image, for a job the first one already did. Reported as info \
         rather than a warning because it costs bytes rather than \
         correctness -- and because both are sometimes there on purpose, when \
         one comes from the base image and a step needs a flag the other does \
         not have.",
    ),
    (
        "docker-workdir-relative",
        Severity::Warning,
        "A relative `WORKDIR` resolves against whatever the previous one left \
         behind, so inserting an instruction above it silently moves everything \
         below. An absolute path means the same thing wherever it appears in the \
         file.",
    ),
    (
        "docker-yum-no-clean",
        Severity::Warning,
        "`yum install` leaves its downloaded rpms and metadata under \
         /var/cache/yum, and they stay in the layer forever. `yum clean all` in \
         the same `RUN` removes them; in a later `RUN` it removes nothing, \
         because the bytes are already committed. A \
         `RUN --mount=type=cache` over the yum directories is the other answer, \
         and this rule does not fire on one.",
    ),
    (
        "docker-yum-unpinned",
        Severity::Warning,
        "`yum install -y nginx` installs whichever nginx the repository serves \
         today, so the same Dockerfile builds different software over time. \
         `nginx-1.20.1` says which one. The counter-argument is the same as for \
         Debian and just as real: a repository drops the superseded version \
         when a security update lands, so a pin can make the image stop \
         building on somebody else's schedule. That is a reason to silence this \
         for a package with the reason written down, not a reason it is wrong.",
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
        severity: rule_severity(code),
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
    /// Whether a `WORKDIR` has been set in this stage yet. See
    /// `docker-copy-relative-no-workdir`.
    workdir: bool,
    /// Whether this stage's `FROM` names another stage in this file, and so
    /// starts with that stage's working directory rather than `/`. poly then
    /// declines to say anything about a relative `COPY` destination here.
    inherits: bool,
}

/// The state that belongs to the file rather than to one stage.
///
/// Only the wget/curl pair so far, and it is here rather than in `DockerStage`
/// because the redundancy is a property of the image being built: fetching with
/// curl in the builder and wget in the final stage still ships both.
#[derive(Default)]
struct DockerFile {
    /// Where each was first run as a command -- not where it was named as a
    /// package to install, which is the same word in a different job.
    wget: Option<usize>,
    curl: Option<usize>,
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
    let mut file_state = DockerFile::default();
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
                if let Some(alias) = &from.alias {
                    aliases.push(alias.content.to_lowercase());
                }
                let image = from.image.content.as_ref();
                let is_stage = aliases.iter().any(|a| a == &image.to_lowercase());
                stage = DockerStage {
                    from: span.start,
                    // A stage built on another stage starts with that stage's
                    // WORKDIR, which this file does state -- just not here.
                    inherits: is_stage,
                    ..DockerStage::default()
                };
                docker_from_platform(text, from, &mut found);
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
                        format!("`{image}` has no tag, so the build pulls whatever `latest` points at today"),
                        None,
                    )),
                    Some("latest") => found.push(docker_issue(
                        text,
                        from.image.span.start,
                        from.image.span.end,
                        "docker-latest-base",
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
                docker_run_rules(text, span, &body, &mut stage, &mut file_state, &mut found);
            }
            Instruction::Cmd(cmd) => {
                stage.cmds += 1;
                if stage.cmds > 1 {
                    found.push(docker_issue(
                        text,
                        span.start,
                        span.end,
                        "docker-multiple-cmd",
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
                            format!("`{key}` is labelled more than once in this stage; only the last one survives"),
                            None,
                        ));
                    }
                }
            }
            Instruction::Copy(copy) => {
                let (paths, destination) = match &copy.args {
                    CopyArgs::Paths {
                        sources,
                        destination,
                    } => (
                        sources.iter().map(|s| s.content.to_string()).collect(),
                        Some(destination.content.as_ref().to_string()),
                    ),
                    // `COPY ["a", "b", "dest"]`: the last element is the
                    // destination, the rest are sources.
                    CopyArgs::Exec(array) => (
                        array.elements.split_last().map_or(Vec::new(), |(_, rest)| {
                            rest.iter().map(|e| e.content.to_string()).collect()
                        }),
                        array.elements.last().map(|e| e.content.to_string()),
                    ),
                };
                let sources = paths.len();
                // `--from` is what makes `/` a stage's root rather than the
                // build context's, which is the case this is about.
                let from_stage = copy.flags.iter().any(|flag| flag.name.content == "from");
                if from_stage && paths.iter().any(|source| source == "/") {
                    found.push(docker_issue(
                        text,
                        span.start,
                        span.end,
                        "docker-copy-whole-filesystem",
                        "copying `/` out of another stage overwrites this image's own \
                         root with that stage's"
                            .to_string(),
                        None,
                    ));
                }
                if let Some(destination) = destination {
                    // A relative destination with no WORKDIR anywhere in the
                    // stage resolves against `/`, which is where the file lands
                    // and almost never where the line meant. Skipped for a stage
                    // built on another stage, whose working directory this file
                    // sets somewhere poly is not looking.
                    if !stage.workdir
                        && !stage.inherits
                        && !destination.starts_with('/')
                        && !destination.starts_with('$')
                        && !destination.contains(":\\")
                        && !destination.starts_with('\\')
                    {
                        found.push(docker_issue(
                            text,
                            span.start,
                            span.end,
                            "docker-copy-relative-no-workdir",
                            format!(
                                "no WORKDIR in this stage, so `{destination}` resolves against `/`"
                            ),
                            None,
                        ));
                    }
                    if sources > 1 && !docker_is_directory(&destination) {
                        found.push(docker_issue(
                            text,
                            span.start,
                            span.end,
                            "docker-copy-multiple-sources-no-slash",
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

    // Anchored on whichever of the two appears later: that is the line at which
    // the file started carrying both, and the one whose author had a choice.
    if let (Some(wget), Some(curl)) = (file_state.wget, file_state.curl) {
        let (at, second, first) = if wget > curl {
            (wget, "wget", "curl")
        } else {
            (curl, "curl", "wget")
        };
        found.push(docker_issue(
            text,
            at,
            at,
            "docker-wget-and-curl",
            format!(
                "`{second}` fetches URLs and so does the `{first}` above; the image ships both"
            ),
            None,
        ));
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
                    format!("{complaint}: root in the container is root on the host kernel"),
                    None,
                ));
            }
        }
    }

    found.sort_by_key(|issue| (issue.line, issue.col));
    found
}

/// The two rules about `FROM --platform=...`.
///
/// Split by what the value is, and silent on anything else. `$TARGETPLATFORM`
/// is exactly what an unflagged `FROM` resolves to, so the flag is redundant; a
/// literal like `linux/amd64` overrides the host and is the one that produces an
/// image nobody can run. Any *other* variable -- `$BUILDPLATFORM`, or an ARG the
/// project defined -- is a deliberate choice whose value poly cannot see, and
/// guessing at it is how a rule earns its reputation.
fn docker_from_platform(
    text: &str,
    from: &dprint_plugin_dockerfile::ast::FromInstruction<'_>,
    found: &mut Vec<Issue>,
) {
    let Some(flag) = from
        .flags
        .iter()
        .find(|flag| flag.name.content == "platform")
    else {
        return;
    };
    let value = flag.value.content.as_ref();
    let (start, end) = (flag.span.start, flag.span.end);
    if matches!(value, "$TARGETPLATFORM" | "${TARGETPLATFORM}") {
        found.push(docker_issue(
            text,
            start,
            end,
            "docker-from-platform-redundant",
            "`--platform=$TARGETPLATFORM` is what FROM already does".to_string(),
            Some(Fix::Described {
                what: "Drop the `--platform` flag".to_string(),
                safe: true,
            }),
        ));
    } else if !value.contains('$') {
        found.push(docker_issue(
            text,
            start,
            end,
            "docker-from-platform-pinned",
            format!(
                "`--platform={value}` builds this stage for {value} on every host, and \
                 the mismatch surfaces at `docker run` rather than here"
            ),
            None,
        ));
    }
}

fn docker_shell_form(text: &str, span: DockerSpan, keyword: &str) -> Issue {
    docker_issue(
        text,
        span.start,
        span.end,
        "docker-shell-form-command",
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
            // Set whether or not the path is absolute: what
            // `docker-copy-relative-no-workdir` asks is whether the stage states
            // a working directory at all, and a relative one still does (the
            // rule just above says what is wrong with it).
            stage.workdir = true;
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
    file: &mut DockerFile,
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
    let mut yum_install = false;
    // Order matters here in a way it does not for apt: a `yum clean all` before
    // the install it was meant to follow leaves that install's rpms in the
    // layer, and writing the two the wrong way round is exactly the mistake.
    let mut yum_cleaned = false;

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
            "apt-get" | "apt" => {
                if command.name() == "apt" {
                    found.push(docker_issue(
                        text,
                        docker_locate(text, span, "apt"),
                        span.end,
                        "docker-apt-not-apt-get",
                        "`apt` has no stable CLI, by its own warning: use `apt-get` \
                         (or `apt-cache`) in a build"
                            .to_string(),
                        Some(Fix::Described {
                            what: "Call `apt-get` instead".to_string(),
                            safe: true,
                        }),
                    ));
                }
                match command.subcommand() {
                    "update" => apt_update = true,
                    "install" => {
                        apt_install = true;
                        docker_apt_rules(text, span, command, found);
                    }
                    _ => {}
                }
            }
            "apk" if command.subcommand() == "add" => docker_apk_rules(text, span, command, found),
            "yum" => match command.subcommand() {
                "install" => {
                    yum_install = true;
                    yum_cleaned = false;
                    docker_yum_rules(text, span, command, found);
                }
                "clean" if command.operands().any(|word| word == "all") => yum_cleaned = true,
                _ => {}
            },
            // `npm ci` installs exactly what package-lock.json says, which is
            // the pin this rule is asking for; only `install` is a free choice.
            "npm" if matches!(command.subcommand(), "install" | "i") => {
                docker_npm_rules(text, span, command, found);
            }
            "go" if matches!(command.subcommand(), "get" | "install") => {
                docker_go_rules(text, span, command, found);
            }
            // Where a URL fetcher is *run*. `apt-get install wget` names the
            // same word as a package, and an image that installs one and uses
            // the other is not the redundancy this is about.
            "wget" => {
                file.wget
                    .get_or_insert_with(|| docker_locate(text, span, "wget"));
            }
            "curl" => {
                file.curl
                    .get_or_insert_with(|| docker_locate(text, span, "curl"));
            }
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
            "the package lists stay in this layer; deleting them in a later RUN \
             does not shrink the image"
                .to_string(),
            Some(Fix::Described {
                what: "Append `&& rm -rf /var/lib/apt/lists/*` to this RUN".to_string(),
                safe: true,
            }),
        ));
    }
    if yum_install && !yum_cleaned && !cached("/var/cache/yum") {
        found.push(docker_issue(
            text,
            docker_locate(text, span, "yum"),
            span.end,
            "docker-yum-no-clean",
            "the downloaded rpms and metadata stay in this layer; `yum clean all` \
             in a later RUN does not shrink the image"
                .to_string(),
            Some(Fix::Described {
                what: "Append `&& yum clean all` to this RUN".to_string(),
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
            format!(
                "`{package}` has no version, so this installs whatever the mirror serves today"
            ),
            None,
        ));
    }
}

fn docker_yum_rules(text: &str, span: DockerSpan, command: &DockerCommand, found: &mut Vec<Issue>) {
    for package in command.operands() {
        // `nginx-1.20.1` is the pin yum takes; a local rpm and a variable are
        // both already decided elsewhere. `@core` is a group, which has no
        // version to give.
        let pinned = package.contains('$')
            || package.ends_with(".rpm")
            || package.starts_with('@')
            || package.contains("://")
            || package
                .rsplit_once('-')
                .is_some_and(|(_, tail)| tail.starts_with(|c: char| c.is_ascii_digit()));
        if pinned {
            continue;
        }
        found.push(docker_issue(
            text,
            docker_locate(text, span, package),
            span.end,
            "docker-yum-unpinned",
            format!(
                "`{package}` has no version, so this installs whatever the repository serves today"
            ),
            None,
        ));
    }
}

fn docker_npm_rules(text: &str, span: DockerSpan, command: &DockerCommand, found: &mut Vec<Issue>) {
    for package in command.operands() {
        // The version marker is an `@` that is not the one starting a scope:
        // `@scope/name` is unpinned, `@scope/name@1.2.3` is not.
        let after_first = package
            .char_indices()
            .nth(1)
            .map_or("", |(at, _)| &package[at..]);
        let pinned = after_first.contains('@')
            || package.contains('$')
            || package.starts_with('.')
            || package.starts_with('/')
            // `file:`, `git+ssh://`, `github:owner/repo`: every npm specifier
            // that is not a registry name carries a colon, and each of them
            // names its own source rather than "today's".
            || package.contains(':')
            || package.ends_with(".tgz");
        if pinned {
            continue;
        }
        found.push(docker_issue(
            text,
            docker_locate(text, span, package),
            span.end,
            "docker-npm-unpinned",
            format!(
                "`{package}` has no version, so this installs whatever the registry serves today"
            ),
            None,
        ));
    }
}

fn docker_go_rules(text: &str, span: DockerSpan, command: &DockerCommand, found: &mut Vec<Issue>) {
    for package in command.operands() {
        // A local path is the module being built, not something fetched, and
        // `all`/`./...` are patterns over it.
        let pinned = package.contains('@')
            || package.contains('$')
            || package.starts_with('.')
            || package.starts_with('/')
            || package == "all";
        if pinned {
            continue;
        }
        found.push(docker_issue(
            text,
            docker_locate(text, span, package),
            span.end,
            "docker-go-install-unpinned",
            format!(
                "`{package}` has no `@version`, so this builds whatever the proxy serves today"
            ),
            None,
        ));
    }
}

fn docker_pip_rules(text: &str, span: DockerSpan, command: &DockerCommand, found: &mut Vec<Issue>) {
    // Asked before the `-r` return below, because the cache is written whatever
    // the packages were named in.
    //
    // Any `--no-cache...` counts, not just the full `--no-cache-dir`: pip's
    // parser is optparse, which accepts an unambiguous abbreviation of a long
    // option, and `--no-cache-dir` is the only option pip has starting that way.
    // `pip install --no-cache x` therefore does disable the cache -- hadolint
    // reports it anyway, and matching that would have been a false positive on
    // six files of the corpus.
    if !command
        .words
        .iter()
        .any(|word| word.starts_with("--no-cache"))
    {
        found.push(docker_issue(
            text,
            docker_locate(text, span, "install"),
            span.end,
            "docker-pip-cache",
            "pip writes every downloaded wheel into the layer's cache directory, \
             where nothing reads it again"
                .to_string(),
            Some(Fix::Described {
                what: "Add `--no-cache-dir` to `pip install`".to_string(),
                safe: true,
            }),
        ));
    }
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
        severity: severity_of("typos", Reported::Nothing),
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

    // ── javascript and typescript ──────────────────────────────────────────

    fn js(path: &str, text: &str) -> Vec<Issue> {
        lint("typescript", Path::new(path), text).expect("deno_lint runs")
    }

    /// The recommended set, at deno_lint's codes, with deno_lint's pages.
    ///
    /// Every number here is what `deno lint 2.6.1` prints for this file, so a
    /// regression in the position arithmetic shows up as a disagreement with
    /// the tool poly embeds rather than with a number somebody typed.
    #[test]
    fn typescript_findings_carry_deno_lints_codes_and_positions() {
        let text = "const x: any = 1;\nlet y = 2;\nconsole.log(x, y);\n";
        let issues = js("a.ts", text);
        let codes: Vec<&str> = issues.iter().map(|i| i.code.as_str()).collect();
        assert_eq!(codes, ["no-explicit-any", "prefer-const"], "{issues:?}");
        assert!(issues.iter().all(|i| i.source == "deno_lint"), "{issues:?}");

        // `any` is at 1:9 0-based, and the range covers the three characters.
        let any = &issues[0];
        assert_eq!((any.line, any.col), (0, 9), "{any:?}");
        assert_eq!((any.end_line, any.end_col), (0, 12), "{any:?}");
        // deno_lint ranks nothing -- every finding is printed as an error --
        // so the level is poly's, and it is not error.
        assert_eq!(any.severity, Severity::Warning);
        assert_eq!(
            any.url.as_deref(),
            Some("https://docs.deno.com/lint/rules/no-explicit-any")
        );
        // The hint is where the remedy lives for most of these rules, and one
        // line has to hold both halves.
        assert!(any.message.contains("Use a specific type"), "{any:?}");
    }

    /// JSX is decided by the file name, which is the whole reason `lint` takes
    /// the path: poly calls eight extensions "typescript", and `<T>(x)` is a
    /// type assertion in one of them and an element in another.
    #[test]
    fn the_extension_decides_whether_angle_brackets_are_jsx() {
        let text = "export const a = <div>{1}</div>;\n";
        let jsx = js("a.tsx", text);
        assert!(jsx.iter().all(|i| i.source != "typescript"), "{jsx:?}");
        // The same text in a .ts file is not valid TypeScript.
        let issues = js("a.ts", text);
        assert!(
            issues.iter().any(|i| i.source == "typescript"),
            "{issues:?}"
        );
    }

    /// A file that does not parse is invalid, said at the offending character.
    ///
    /// The position is the substance of the test: deno_ast hands back positions
    /// counted from a constant it documents as the start of every parse, and if
    /// that ever stops holding, every JavaScript finding poly prints lands
    /// somewhere else. A tab is in the fixture because `display_position`, the
    /// obvious alternative, counts one as two columns.
    #[test]
    fn an_unparsable_file_is_reported_as_invalid_typescript() {
        let text = "const a = 1;\nfunction g() {\n\tconst b = \"unterminated;\n}\n";
        let issues = js("a.ts", text);
        let broken = issues
            .iter()
            .find(|i| i.source == "typescript")
            .unwrap_or_else(|| panic!("no syntax finding in {issues:?}"));
        assert_eq!(broken.code, "syntax");
        assert_eq!(broken.severity, Severity::Error);
        // The `"` is the 11th character of the third line, counting the tab as
        // one; a column of 12 would mean the tab was counted as two.
        assert_eq!((broken.line, broken.col), (2, 11), "{broken:?}");
        assert_eq!(broken.message, "Unterminated string constant");
        assert_eq!(broken.url, None);

        // swc recovered, so the file was linted as well as reported on: a
        // syntax error must not silently take the rest of the file's findings
        // with it.
        assert!(issues.iter().any(|i| i.source == "deno_lint"), "{issues:?}");
    }

    /// JSX uses the factory, so importing it is not an unused import.
    ///
    /// This was the whole of the difference between poly and `deno lint` over
    /// 25,489 real files: five `.tsx` files whose `import React` poly called
    /// unused because it had named no factory for JSX to compile to. The other
    /// import in the fixture is the control -- the rule still works.
    #[test]
    fn a_jsx_file_uses_the_factory_it_imports() {
        let text = "import React from \"react\";\nimport Unused from \"./x\";\nexport const a = <div />;\n";
        let codes: Vec<String> = js("a.tsx", text).into_iter().map(|i| i.code).collect();
        assert_eq!(codes, ["no-unused-vars"]);
        let issues = js("a.tsx", text);
        assert!(issues[0].message.contains("`Unused`"), "{issues:?}");
    }

    /// deno's own directive is honoured, because it is deno's linter running.
    #[test]
    fn a_deno_lint_ignore_comment_silences_the_rule_it_names() {
        let text = "// deno-lint-ignore no-explicit-any\nexport const x: any = 1;\n";
        let issues = js("a.ts", text);
        assert!(issues.is_empty(), "{issues:?}");
    }

    /// The project's deno.json picks the rules, exactly as its selene.toml and
    /// ruff.toml do for the other two embedded linters.
    #[test]
    fn deno_json_narrows_the_rule_set() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.ts");
        let text = "export const x: any = 1;\n";
        std::fs::write(&file, text).unwrap();
        assert_eq!(js(file.to_str().unwrap(), text).len(), 1);

        // Comments, because the file is allowed to have them and poly reads it
        // with the parser deno reads it with.
        std::fs::write(
            dir.path().join("deno.json"),
            "{\n  // ours\n  \"lint\": { \"rules\": { \"exclude\": [\"no-explicit-any\"] } }\n}\n",
        )
        .unwrap();
        let issues = js(file.to_str().unwrap(), text);
        assert!(issues.is_empty(), "{issues:?}");
    }

    /// The two rules that are about Deno rather than about JavaScript are off
    /// until a project says it is a Deno project.
    ///
    /// A browser app is the case that matters: `window.addEventListener` is
    /// how the platform works there, and "Window is no longer available in
    /// Deno" is a sentence about somebody else's runtime.
    #[test]
    fn the_deno_runtime_rules_wait_for_a_deno_project() {
        let dir = tempfile::tempdir().unwrap();
        let (browser, deno) = (dir.path().join("browser"), dir.path().join("deno"));
        std::fs::create_dir_all(&browser).unwrap();
        std::fs::create_dir_all(&deno).unwrap();
        std::fs::write(deno.join("deno.json"), "{}\n").unwrap();

        let text = "window.addEventListener(\"load\", () => {});\n";
        let quiet = js(browser.join("a.ts").to_str().unwrap(), text);
        assert!(quiet.is_empty(), "{quiet:?}");

        let flagged = js(deno.join("a.ts").to_str().unwrap(), text);
        assert_eq!(
            flagged.iter().map(|i| i.code.as_str()).collect::<Vec<_>>(),
            ["no-window", "no-window-prefix"],
            "{flagged:?}"
        );
    }

    // ── graphql ────────────────────────────────────────────────────────────

    /// A file that is not GraphQL, reported at the token the parser choked on.
    ///
    /// The CJK in the description is the unit test: `data` is a byte length and
    /// the column is a character count, so an end column of 24 would mean the
    /// span was measured in the wrong one.
    #[test]
    fn a_graphql_file_that_is_not_graphql_says_where() {
        let text = "\"文件說明文字\"\ntype Query {\n  a: Int!\n";
        let issues = lint("graphql", Path::new("a.graphql"), text).unwrap();
        let [issue] = &issues[..] else {
            panic!("expected one finding, got {issues:?}");
        };
        assert_eq!(issue.code, "syntax");
        assert_eq!(issue.source, "graphql");
        assert_eq!(issue.severity, Severity::Error);
        assert_eq!(
            issue.url.as_deref(),
            Some("https://spec.graphql.org/October2021/")
        );
        // The closing brace never arrives, so the parser stops at the end of
        // the last line it read.
        assert_eq!((issue.line, issue.col), (3, 0), "{issue:?}");

        // A valid document is silent, including one whose first definition is a
        // description string -- the fixture above is only invalid because it
        // does not close.
        let whole = format!("{text}}}\n");
        let quiet = lint("graphql", Path::new("a.graphql"), &whole).unwrap();
        assert!(quiet.is_empty(), "{quiet:?}");
    }

    /// An error at the very first byte is reported like any other.
    ///
    /// It is called out because this is the offset that used to panic on the
    /// formatter's path (`a_graphql_error_at_the_first_byte_is_a_message_not_a_crash`),
    /// and because the two paths now share this parse: a file that lints as
    /// broken and formats as fine would be the editor and CI disagreeing about
    /// whether the file is GraphQL at all.
    #[test]
    fn a_graphql_error_at_the_first_byte_is_placed_at_the_first_character() {
        let issues = lint("graphql", Path::new("a.graphql"), "!!!\n").unwrap();
        assert_eq!((issues[0].line, issues[0].col), (0, 0), "{issues:?}");
        assert_eq!(issues[0].code, "syntax");

        // An empty file is not an empty document: GraphQL's grammar wants at
        // least one definition, which is what every parser for it says.
        let empty = lint("graphql", Path::new("a.graphql"), "").unwrap();
        assert_eq!(empty.len(), 1, "{empty:?}");
        assert_eq!((empty[0].line, empty[0].col), (0, 0), "{empty:?}");
    }

    // ── markdown ───────────────────────────────────────────────────────────

    /// Every name in `MARKDOWN_RULES` is a rule the pinned rumdl has.
    ///
    /// `markdown_rules` panics on a name rumdl does not know, and with an exact
    /// pin that cannot happen without somebody changing the pin -- which is
    /// exactly when it must fail here rather than in an editor.
    ///
    /// The catalog is asked in the same breath, in the direction the poly-rule
    /// gate above cannot cover: a `rumdl/` row naming a rule poly stopped
    /// running is a category entry nothing can ever land in. The other
    /// direction is deliberately not asserted -- MD001 and MD045 have no
    /// category on purpose, and `catalog.toml` says why.
    #[test]
    fn the_seven_markdown_rules_are_rules_rumdl_has() {
        let names: Vec<&str> = markdown_rules().iter().map(|rule| rule.name()).collect();
        assert_eq!(names, MARKDOWN_RULES);

        for (category, rules) in poly_core::catalog::catalog() {
            for id in rules {
                let Some(code) = id.strip_prefix("rumdl/") else {
                    continue;
                };
                assert!(
                    MARKDOWN_RULES.contains(&code),
                    "{category} names {id}, which is not a rule poly runs"
                );
            }
        }
    }

    /// A link to a file that is not there, placed where rumdl places it.
    ///
    /// The position is the substance: rumdl counts lines and columns from one
    /// and in characters, poly counts from zero and in characters, and the
    /// CJK in the link text is there so that a byte count would give a
    /// different answer from the right one.
    #[test]
    fn a_relative_link_to_a_missing_file_is_reported_where_rumdl_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("README.md");
        let text = "# Title\n\nSee [設定說明](./docs/config.md).\n";
        std::fs::write(&file, text).unwrap();

        let issues = lint("markdown", &file, text).unwrap();
        let [issue] = &issues[..] else {
            panic!("expected one finding, got {issues:?}");
        };
        assert_eq!(issue.code, "MD057");
        assert_eq!(issue.source, "rumdl");
        // rumdl calls a link to a missing file an error, and poly takes its
        // word: this is the half of its scale that means what poly means.
        assert_eq!(issue.severity, Severity::Error);
        assert_eq!(issue.url.as_deref(), Some("https://rumdl.dev/md057/"));
        // The squiggle covers the target rather than the whole link:
        // `./docs/config.md` is characters 11..27 of the third line, 0-based.
        // In bytes it starts at 19, because the four characters of the link
        // text are three bytes each -- so this is the assertion that says the
        // column is a character count.
        assert_eq!((issue.line, issue.col), (2, 11), "{issue:?}");
        assert_eq!((issue.end_line, issue.end_col), (2, 27), "{issue:?}");

        // The same link with the file in place is not a finding. Without this
        // the test above would pass just as well if MD057 flagged every link.
        std::fs::create_dir(dir.path().join("docs")).unwrap();
        std::fs::write(dir.path().join("docs/config.md"), "# Config\n").unwrap();
        let quiet = lint("markdown", &file, text).unwrap();
        assert!(quiet.is_empty(), "{quiet:?}");
    }

    /// What `poly fmt` decides, `poly check` does not also report.
    ///
    /// Four of the seventy-seven rules that stay off, in one file: a line over
    /// rumdl's eighty columns (MD013), a heading with no blank line under it
    /// (MD022), a list with no blank line above it (MD032), and a bold line
    /// standing alone (MD036). The full rule set reports all four here; poly
    /// reports none of them, because `poly fmt` decides all four.
    ///
    /// MD036 is the one worth the fixture. It is not in the file because
    /// somebody wrote it that way -- it is what `poly fmt` *produces*: put the
    /// blank line above the list that MD032 asks for, and the bold line above
    /// it becomes a paragraph in bold. 1,054 of the 2,394 MD036 findings over
    /// 4,947 real files were written by poly's own formatter, which is the
    /// whole argument for `MARKDOWN_RULES` being seven names rather than a tag.
    #[test]
    fn the_markdown_rules_poly_fmt_owns_are_not_run() {
        let text = "# Title\n\n**Not a heading**\n\n- one\n- two\n\nA line of prose that runs comfortably past the eighty columns rumdl's MD013 holds a line to.\n\n## Next\nStraight under the heading.\n- three\n";
        let issues = lint("markdown", Path::new("a.md"), text).unwrap();
        assert!(issues.is_empty(), "{issues:?}");
    }

    /// rumdl's own directive is honoured, because it is rumdl running.
    #[test]
    fn a_rumdl_disable_comment_silences_the_rule_it_names() {
        let reversed = "See (the docs)[https://example.com] for more.\n";
        let issues = lint("markdown", Path::new("a.md"), reversed).unwrap();
        assert_eq!(
            issues.iter().map(|i| i.code.as_str()).collect::<Vec<_>>(),
            ["MD011"],
            "{issues:?}"
        );

        let silenced = format!("<!-- rumdl-disable MD011 -->\n\n{reversed}");
        let quiet = lint("markdown", Path::new("a.md"), &silenced).unwrap();
        assert!(quiet.is_empty(), "{quiet:?}");
    }

    /// `.mdx` is a different grammar, and the extension is the only thing that
    /// says so.
    ///
    /// poly calls both files "markdown" -- one formatter, one language id in the
    /// editor -- so without the flavor every JSX component in an `.mdx` file is
    /// read as raw HTML. Here that swallows the fenced block inside it, and the
    /// reversed link in what is plainly code gets reported.
    #[test]
    fn mdx_is_linted_as_mdx() {
        let text = "<Steps>\n  <Step>\n```text\nsee (this)[https://example.com] reversed\n```\n  </Step>\n</Steps>\n";
        let mdx = lint("markdown", Path::new("a.mdx"), text).unwrap();
        assert!(mdx.is_empty(), "{mdx:?}");
        let md = lint("markdown", Path::new("a.md"), text).unwrap();
        assert_eq!(
            md.iter().map(|i| i.code.as_str()).collect::<Vec<_>>(),
            ["MD011"],
            "{md:?}"
        );
    }

    // ── dockerfile ─────────────────────────────────────────────────────────

    fn docker_codes(text: &str) -> Vec<String> {
        lint("dockerfile", Path::new("Dockerfile"), text)
            .unwrap()
            .into_iter()
            .map(|issue| {
                assert_eq!(issue.source, "poly", "{issue:?}");
                assert_eq!(issue.url, None, "poly's own rules have no page to link");
                // `docker_issue` reads the level from the rule's row, so this
                // is asking whether a finding got built without it: an `Issue`
                // written out by hand can still carry a severity chosen at the
                // emit site, which is what this step removed. Every fixture in
                // the file passes through here, so all of them are asked.
                assert_eq!(
                    issue.severity,
                    rule_severity(&issue.code),
                    "{} is reported at a level `DOCKER_RULES` does not state",
                    issue.code
                );
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
        ("docker-apt-not-apt-get", "FROM a:1\nRUN apt update\n"),
        ("docker-cd-in-run", "FROM a:1\nRUN cd /app && make\n"),
        (
            "docker-copy-multiple-sources-no-slash",
            "FROM a:1\nCOPY one two /app\n",
        ),
        ("docker-copy-relative-no-workdir", "FROM a:1\nCOPY one .\n"),
        (
            "docker-copy-whole-filesystem",
            "FROM a:1 AS build\nFROM a:1\nWORKDIR /app\nCOPY --from=build / /\n",
        ),
        ("docker-duplicate-env-key", "FROM a:1\nENV A=1\nENV A=2\n"),
        ("docker-duplicate-label-key", "FROM a:1\nLABEL a=1\nLABEL a=2\n"),
        ("docker-from-platform-pinned", "FROM --platform=linux/amd64 a:1\n"),
        (
            "docker-from-platform-redundant",
            "FROM --platform=$TARGETPLATFORM a:1\n",
        ),
        (
            "docker-go-install-unpinned",
            "FROM a:1\nRUN go install example.com/cmd\n",
        ),
        ("docker-invalid-port", "FROM a:1\nEXPOSE 99999\n"),
        ("docker-latest-base", "FROM ubuntu:latest\n"),
        ("docker-maintainer-deprecated", "FROM a:1\nMAINTAINER me@example.com\n"),
        ("docker-missing-from", "RUN echo hi\n"),
        ("docker-multiple-cmd", "FROM a:1\nCMD [\"a\"]\nCMD [\"b\"]\n"),
        (
            "docker-multiple-entrypoint",
            "FROM a:1\nENTRYPOINT [\"a\"]\nENTRYPOINT [\"b\"]\n",
        ),
        (
            "docker-npm-unpinned",
            "FROM a:1\nRUN npm install -g typescript\n",
        ),
        (
            "docker-pip-cache",
            "FROM a:1\nRUN pip install requests==2.31.0\n",
        ),
        ("docker-pip-unpinned", "FROM a:1\nRUN pip install requests\n"),
        ("docker-pipe-without-pipefail", "FROM a:1\nRUN cat x | tar xz\n"),
        ("docker-root-user", "FROM a:1\nCMD [\"a\"]\n"),
        ("docker-secret-in-env", "FROM a:1\nENV DB_PASSWORD=hunter2\n"),
        ("docker-shell-form-command", "FROM a:1\nCMD npm start\n"),
        ("docker-sudo-in-run", "FROM a:1\nRUN sudo make install\n"),
        ("docker-untagged-base", "FROM ubuntu\n"),
        (
            "docker-wget-and-curl",
            "FROM a:1\nRUN curl -o x https://e.example\nRUN wget https://e.example\n",
        ),
        ("docker-workdir-relative", "FROM a:1\nWORKDIR app\n"),
        ("docker-yum-no-clean", "FROM a:1\nRUN yum install -y nginx-1.20.1\n"),
        (
            "docker-yum-unpinned",
            "FROM a:1\nRUN yum install -y nginx && yum clean all\n",
        ),
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
        let mut documented: Vec<&str> = DOCKER_RULES.iter().map(|(code, _, _)| *code).collect();
        documented.sort_unstable();
        assert_eq!(
            emitted, documented,
            "rules and their documentation disagree"
        );

        for (code, severity, doc) in DOCKER_RULES {
            assert_eq!(rule_doc("poly", code), Some(*doc), "{code}");
            assert_eq!(rule_severity(code), *severity, "{code}");
            assert!(doc.len() > 80, "{code}: {doc}");
        }
        assert!(rule_doc("poly", "docker-no-such-rule").is_none());
        // Still nobody else's rules: the policy `rule_doc` documents is that
        // poly repeats what a tool says rather than paraphrasing it.
        assert!(rule_doc("hadolint", "DL3006").is_none());
    }

    /// Every rule poly wrote has a category, and every `poly/` id in the
    /// catalog is a rule poly still has.
    ///
    /// The catalog lives in poly-core because a category is cross-language and
    /// the rules live here, so nothing but this holds the two together. A rule
    /// with no category cannot be named in `[lint]` by anything but its own
    /// code, and an entry for a rule that no longer exists is a category line
    /// that silently covers nothing.
    #[test]
    fn every_poly_rule_has_a_category() {
        let mine: Vec<&str> = DOCKER_RULES
            .iter()
            .chain(crate::workflow::RULES)
            .chain(crate::proto::RULES)
            .chain(poly_core::INLINE_RULES)
            .map(|(code, _, _)| *code)
            .collect();
        for code in &mine {
            assert!(
                poly_core::catalog::category_of("poly", code).is_some(),
                "{code} has no category"
            );
        }
        for (category, rules) in poly_core::catalog::catalog() {
            for id in rules {
                let Some(code) = id.strip_prefix("poly/") else {
                    continue;
                };
                assert!(
                    mine.contains(&code),
                    "{category} names {id}, which is not a rule poly has"
                );
            }
        }
    }

    /// Every rule in a category is reported at the same severity.
    ///
    /// This is the half of "unified rules" a machine can hold: the vocabulary
    /// is only worth something if `unpinned-dependency` means one thing to
    /// `--fail-on`, whichever language it was found in. It has already earned
    /// its keep -- `actions-invalid-glob` sat at warning next to twenty rules
    /// about a workflow GitHub rejects, all of them error.
    ///
    /// Sources with their own scale are skipped rather than guessed at: they
    /// rank each finding when they report it, so there is no level here to
    /// compare. `ranks_its_own` is the same table `severity_of` reads.
    #[test]
    fn a_category_reports_at_one_severity() {
        for (category, rules) in poly_core::catalog::catalog() {
            let mut levels: Vec<(&str, Severity)> = Vec::new();
            for id in rules {
                let (source, code) = id.split_once('/').expect("a tool/rule id");
                let severity = if source == "poly" {
                    rule_severity(code)
                } else if poly_core::diag::ranks_its_own(source) {
                    continue;
                } else {
                    severity_of(source, Reported::Nothing)
                };
                levels.push((id, severity));
            }
            if let Some((first, level)) = levels.first() {
                for (id, other) in &levels {
                    assert_eq!(
                        level,
                        other,
                        "{category}: {first} is {} and {id} is {}",
                        level.as_str(),
                        other.as_str()
                    );
                }
            }
        }
    }

    /// Every replacement poly offers for a `# hadolint ignore=` is a rule poly
    /// actually has.
    ///
    /// The table lives in poly-core, next to the sentence it words, and the
    /// rules live here; nothing but this test holds the two together. Without
    /// it, renaming a rule would leave poly telling people to write a
    /// suppression that silences nothing -- which is the exact failure the
    /// migration signal exists to report.
    #[test]
    fn hadolint_replacements_name_real_rules() {
        let rules: Vec<&str> = DOCKER_RULES.iter().map(|(code, _, _)| *code).collect();
        for (hadolint, poly) in poly_core::HADOLINT_REPLACEMENTS {
            assert!(rules.contains(poly), "{hadolint} -> {poly}: no such rule");
            assert!(
                hadolint.starts_with("DL"),
                "{hadolint} is not a hadolint code"
            );
        }
        // One entry per hadolint code, or the message would name a rule and
        // then name another.
        let mut codes: Vec<&str> = poly_core::HADOLINT_REPLACEMENTS
            .iter()
            .map(|(code, _)| *code)
            .collect();
        let total = codes.len();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), total, "a hadolint code is mapped twice");
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

    /// pip's download cache is written into the layer and never read again.
    ///
    /// The abbreviation is the point of the second half. pip parses its options
    /// with optparse, which accepts any unambiguous prefix of a long option, and
    /// `--no-cache-dir` is the only one starting `--no-cache` -- so
    /// `pip install --no-cache` really does disable the cache. hadolint reports
    /// it anyway; matching that would have been a false positive on four files
    /// of the corpus, all of them written by someone who got it right.
    #[test]
    fn a_pip_cache_is_dead_weight_in_the_layer() {
        assert!(fires(
            "FROM a:1\nRUN pip install requests==2.31.0\nUSER app\n",
            "docker-pip-cache"
        ));
        assert!(!fires(
            "FROM a:1\nRUN pip install --no-cache-dir requests==2.31.0\nUSER app\n",
            "docker-pip-cache"
        ));
        assert!(!fires(
            "FROM a:1\nRUN pip install --no-cache requests==2.31.0\nUSER app\n",
            "docker-pip-cache"
        ));
        // Independent of where the versions are written: a requirements file
        // pins the packages and says nothing about the cache.
        assert!(fires(
            "FROM a:1\nRUN pip install -r requirements.txt\nUSER app\n",
            "docker-pip-cache"
        ));
    }

    /// `apt` warns, in its own output, that it has no stable CLI. A build that
    /// calls it can break on a base-image bump with no change to the Dockerfile.
    #[test]
    fn apt_is_not_the_interface_a_script_should_call() {
        assert!(fires(
            "FROM a:1\nRUN apt update && apt install -y curl=1\nUSER app\n",
            "docker-apt-not-apt-get"
        ));
        assert!(!fires(
            "FROM a:1\nRUN apt-get update && apt-get install -y curl=1\nUSER app\n",
            "docker-apt-not-apt-get"
        ));
        // Still the same package manager underneath, so the rules about how it
        // is called keep applying to it.
        assert!(fires(
            "FROM a:1\nRUN apt install -y curl\nUSER app\n",
            "docker-apt-get-unpinned"
        ));
    }

    /// yum's rpms and metadata stay in the layer, and the cleanup has to come
    /// after the install that produced them.
    ///
    /// The ordering is not pedantry: a `yum clean all` written before the
    /// install it was meant to follow is a real shape in a real Dockerfile, and
    /// it cleans nothing. It is also where poly is right and hadolint is not --
    /// hadolint reports three corpus files whose cleanup is correct.
    #[test]
    fn yum_leaves_its_downloads_in_the_layer() {
        assert!(fires(
            "FROM a:1\nRUN yum install -y nginx-1.20.1\nUSER app\n",
            "docker-yum-no-clean"
        ));
        assert!(!fires(
            "FROM a:1\nRUN yum install -y nginx-1.20.1 && yum clean all\nUSER app\n",
            "docker-yum-no-clean"
        ));
        assert!(fires(
            "FROM a:1\nRUN yum clean all && yum install -y nginx-1.20.1\nUSER app\n",
            "docker-yum-no-clean"
        ));
        // The same answer poly already accepts for apt: a cache mount means the
        // bytes never land in the layer to begin with.
        assert!(!fires(
            "FROM a:1\nRUN --mount=type=cache,target=/var/cache/yum yum install -y nginx-1.20.1\nUSER app\n",
            "docker-yum-no-clean"
        ));
    }

    /// The reproducibility argument again, against a yum repository.
    #[test]
    fn an_unpinned_yum_package_changes_under_the_build() {
        let clean = |packages: &str| {
            format!("FROM a:1\nRUN yum install -y {packages} && yum clean all\nUSER app\n")
        };
        assert!(fires(&clean("nginx"), "docker-yum-unpinned"));
        assert!(!fires(&clean("nginx-1.20.1"), "docker-yum-unpinned"));
        // A local rpm, a group and a URL are each already decided somewhere the
        // version string is not.
        assert!(!fires(&clean("./nginx.rpm"), "docker-yum-unpinned"));
        assert!(!fires(&clean("@core"), "docker-yum-unpinned"));
        assert!(!fires(
            &clean("https://example.com/nginx.rpm"),
            "docker-yum-unpinned"
        ));
        // A hyphen that is not a version marker. `zlib-devel` is a package
        // name, and reading its tail as a version would silence the rule on
        // most of what a build installs.
        assert!(fires(&clean("zlib-devel"), "docker-yum-unpinned"));
    }

    /// npm installs whatever the registry serves unless the line says which.
    #[test]
    fn an_unpinned_npm_package_changes_under_the_build() {
        assert!(fires(
            "FROM a:1\nRUN npm install -g typescript\nUSER app\n",
            "docker-npm-unpinned"
        ));
        assert!(!fires(
            "FROM a:1\nRUN npm install -g typescript@5.4.5\nUSER app\n",
            "docker-npm-unpinned"
        ));
        // A scope is an `@` that is not a version, and a scoped package with a
        // version has both.
        assert!(fires(
            "FROM a:1\nRUN npm install -g @scope/thing\nUSER app\n",
            "docker-npm-unpinned"
        ));
        assert!(!fires(
            "FROM a:1\nRUN npm install -g @scope/thing@1.2.3\nUSER app\n",
            "docker-npm-unpinned"
        ));
        // `npm ci` installs exactly what the lockfile says, which is the pin
        // this rule is asking for. So does a bare `npm install` in a project
        // with a package.json, which names no packages at all.
        assert!(!fires(
            "FROM a:1\nRUN npm ci\nUSER app\n",
            "docker-npm-unpinned"
        ));
        assert!(!fires(
            "FROM a:1\nRUN npm install\nUSER app\n",
            "docker-npm-unpinned"
        ));
    }

    /// `go install pkg` with no `@version` builds whatever the proxy serves.
    #[test]
    fn an_unpinned_go_install_builds_a_different_binary_each_time() {
        assert!(fires(
            "FROM a:1\nRUN go install example.com/cmd/thing\nUSER app\n",
            "docker-go-install-unpinned"
        ));
        assert!(!fires(
            "FROM a:1\nRUN go install example.com/cmd/thing@v1.2.3\nUSER app\n",
            "docker-go-install-unpinned"
        ));
        // `go get` is the same fetch under an older spelling, and the corpus
        // still has it.
        assert!(fires(
            "FROM a:1\nRUN go get github.com/jxskiss/ssl-cert-server\nUSER app\n",
            "docker-go-install-unpinned"
        ));
        // A local path is the module being built, not something fetched.
        assert!(!fires(
            "FROM a:1\nRUN go install ./cmd/thing\nUSER app\n",
            "docker-go-install-unpinned"
        ));
    }

    /// `FROM --platform=` says two different things, and only one of them is a
    /// mistake worth stopping for.
    ///
    /// A literal overrides the host and still builds, so the failure arrives at
    /// `docker run` as a message about the loader. `$TARGETPLATFORM` is exactly
    /// what an unflagged `FROM` already resolves to, so it changes nothing.
    /// Anything else is a variable poly cannot see the value of, and a rule that
    /// guesses there is a rule people learn to ignore.
    #[test]
    fn a_platform_on_from_is_either_an_override_or_a_restatement() {
        assert!(fires(
            "FROM --platform=linux/amd64 a:1\nUSER app\n",
            "docker-from-platform-pinned"
        ));
        assert!(fires(
            "FROM --platform=$TARGETPLATFORM a:1\nUSER app\n",
            "docker-from-platform-redundant"
        ));
        assert!(fires(
            "FROM --platform=${TARGETPLATFORM} a:1\nUSER app\n",
            "docker-from-platform-redundant"
        ));
        for code in [
            "docker-from-platform-pinned",
            "docker-from-platform-redundant",
        ] {
            assert!(!fires("FROM a:1\nUSER app\n", code));
            assert!(!fires(
                "FROM --platform=$BUILDPLATFORM a:1\nUSER app\n",
                code
            ));
            assert!(!fires("FROM --platform=$MY_ARCH a:1\nUSER app\n", code));
        }
        // The redundant one is info: dropping the flag changes nothing about
        // the image, which is the whole finding. See the tiers on DOCKER_RULES.
        let issues = lint(
            "dockerfile",
            Path::new("Dockerfile"),
            "FROM --platform=$TARGETPLATFORM a:1\nUSER app\n",
        )
        .unwrap();
        let found = issues
            .iter()
            .find(|i| i.code == "docker-from-platform-redundant")
            .expect("the rule fired");
        assert_eq!(found.severity, Severity::Info);
    }

    /// `COPY --from=stage / /` overwrites this image's root with another's.
    #[test]
    fn copying_a_whole_filesystem_out_of_a_stage_overwrites_this_one() {
        assert!(fires(
            "FROM a:1 AS build\nFROM a:1\nWORKDIR /app\nCOPY --from=build / /\nUSER app\n",
            "docker-copy-whole-filesystem"
        ));
        assert!(!fires(
            "FROM a:1 AS build\nFROM a:1\nWORKDIR /app\nCOPY --from=build /out/app /app\nUSER app\n",
            "docker-copy-whole-filesystem"
        ));
        // Without `--from` the source is the build context, which is a
        // different instruction doing a different thing.
        assert!(!fires(
            "FROM a:1\nWORKDIR /app\nCOPY / /\nUSER app\n",
            "docker-copy-whole-filesystem"
        ));
    }

    /// With no WORKDIR anywhere in the stage, a relative COPY destination
    /// resolves against `/` -- and succeeds, so nothing says so.
    #[test]
    fn a_relative_copy_with_no_workdir_lands_at_the_root() {
        assert!(fires(
            "FROM a:1\nCOPY app.jar .\nUSER app\n",
            "docker-copy-relative-no-workdir"
        ));
        assert!(!fires(
            "FROM a:1\nWORKDIR /app\nCOPY app.jar .\nUSER app\n",
            "docker-copy-relative-no-workdir"
        ));
        assert!(!fires(
            "FROM a:1\nCOPY app.jar /app/\nUSER app\n",
            "docker-copy-relative-no-workdir"
        ));
        // The WORKDIR has to be above the COPY, because that is the order the
        // build runs in.
        assert!(fires(
            "FROM a:1\nCOPY app.jar .\nWORKDIR /app\nUSER app\n",
            "docker-copy-relative-no-workdir"
        ));
        // A stage built on another stage starts with that stage's working
        // directory. This file does state it -- just not here -- so poly
        // declines rather than guessing.
        assert!(!fires(
            "FROM a:1 AS build\nWORKDIR /src\nFROM build\nCOPY app.jar .\nUSER app\n",
            "docker-copy-relative-no-workdir"
        ));
        // A destination poly cannot resolve is not one it complains about.
        assert!(!fires(
            "FROM a:1\nCOPY app.jar $DEST\nUSER app\n",
            "docker-copy-relative-no-workdir"
        ));
    }

    /// Two programs that fetch a URL, where the image needs one.
    ///
    /// Info rather than a warning, deliberately: it costs bytes rather than
    /// correctness, and a file that installs one and uses the other has a
    /// reason. Being *named* as a package is not using it -- `apt-get install
    /// wget` and then `curl` everywhere is one fetcher, not two.
    #[test]
    fn an_image_that_ships_both_wget_and_curl_carries_one_too_many() {
        assert!(fires(
            "FROM a:1\nRUN curl -o x https://e.example\nRUN wget https://e.example\nUSER app\n",
            "docker-wget-and-curl"
        ));
        assert!(!fires(
            "FROM a:1\nRUN curl -o x https://e.example\nUSER app\n",
            "docker-wget-and-curl"
        ));
        assert!(!fires(
            "FROM a:1\nRUN apt-get install -y --no-install-recommends wget=1 \
             && rm -rf /var/lib/apt/lists/*\nRUN curl -o x https://e.example\nUSER app\n",
            "docker-wget-and-curl"
        ));
        let issues = lint(
            "dockerfile",
            Path::new("Dockerfile"),
            "FROM a:1\nRUN curl -o x https://e.example\nRUN wget https://e.example\nUSER app\n",
        )
        .unwrap();
        let found = issues
            .iter()
            .find(|i| i.code == "docker-wget-and-curl")
            .expect("the rule fired");
        assert_eq!(found.severity, Severity::Info);
        // Anchored on the second of the two: that is the line at which the file
        // started carrying both.
        assert_eq!(found.line, 2);
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

//! Language detection, poly.toml config, and file walking — shared by the CLI
//! and the LSP daemon so editor and CI behavior stay identical (R5/A4).

pub mod diag;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use globset::{Glob, GlobMatcher, GlobSet, GlobSetBuilder};
use serde::Deserialize;

/// Built-in extension -> language id table. Ids match VSCode language ids
/// where one exists so `[languages.map]` values read the same in both worlds.
const EXTENSIONS: &[(&str, &str)] = &[
    ("rs", "rust"),
    ("ts", "typescript"),
    ("tsx", "typescript"),
    ("js", "typescript"),
    ("jsx", "typescript"),
    ("mjs", "typescript"),
    ("cjs", "typescript"),
    ("mts", "typescript"),
    ("cts", "typescript"),
    ("json", "json"),
    ("jsonc", "json"),
    ("md", "markdown"),
    ("markdown", "markdown"),
    ("toml", "toml"),
    ("css", "css"),
    ("scss", "scss"),
    ("less", "less"),
    ("yaml", "yaml"),
    ("yml", "yaml"),
    ("py", "python"),
    ("pyi", "python"),
    // ruff reads and writes .ipynb directly; poly treats it as its own
    // language so the notebook never reaches the plain-Python engine.
    ("ipynb", "jupyter"),
    ("sql", "sql"),
    ("xml", "xml"),
    ("xsd", "xml"),
    ("xsl", "xml"),
    ("xslt", "xml"),
    ("svg", "xml"),
    ("html", "html"),
    ("htm", "html"),
    ("vue", "vue"),
    ("svelte", "svelte"),
    ("astro", "astro"),
    ("jinja", "jinja"),
    ("jinja2", "jinja"),
    ("j2", "jinja"),
    ("graphql", "graphql"),
    ("gql", "graphql"),
    ("graphqls", "graphql"),
    ("proto", "protobuf"),
    ("sh", "shellscript"),
    ("bash", "shellscript"),
    ("zsh", "shellscript"),
    // Both are shell with a different job, and neither is in VSCode's built-in
    // shellscript extension list -- which is why an extension existed to
    // format them. shfmt reads them as what they are.
    ("bats", "shellscript"),
    ("azcli", "shellscript"),
    ("go", "go"),
    ("lua", "lua"),
    ("swift", "swift"),
    ("c", "c"),
    ("h", "cpp"),
    ("cpp", "cpp"),
    ("cc", "cpp"),
    ("cxx", "cpp"),
    ("hpp", "cpp"),
    ("hh", "cpp"),
    ("tf", "terraform"),
    ("tfvars", "terraform"),
    ("hcl", "hcl"),
];

/// Formatter knobs inherited from whatever `.editorconfig` covers `path`.
///
/// poly's three knobs are exactly three EditorConfig keys, so this is a
/// mapping rather than a new configuration surface. Nothing else is read, and
/// each omission has a reason: `end_of_line` is already handled by
/// `format_text`'s CRLF round-trip, `insert_final_newline` and
/// `trim_trailing_whitespace` are things every formatter here does
/// unconditionally, and `charset` is not poly's to change.
///
/// Values poly cannot act on are dropped rather than raised, which is the
/// opposite of what poly.toml does with the same number. That asymmetry is the
/// point: poly.toml is the project talking to poly, so a value it cannot act
/// on is a mistake worth stopping for; `.editorconfig` is the project talking
/// to every editor it has ever used, and `max_line_length = 0` -- a common way
/// to write "no limit" -- must not stop a poly run.
///
/// Returns defaults for any error at all, including an unreadable or malformed
/// file. poly is a reader of this file, not its owner; refusing to format a
/// repo because some other tool's config file has a typo in it would be poly
/// enforcing a standard it does not define.
pub fn editorconfig_options(path: &Path) -> FormatOptions {
    use ec4rs::property::{IndentSize, IndentStyle, MaxLineLen, TabWidth};

    let Ok(props) = ec4rs::properties_of(path) else {
        return FormatOptions::default();
    };
    let use_tabs = match props.get::<IndentStyle>() {
        Ok(IndentStyle::Tabs) => Some(true),
        Ok(IndentStyle::Spaces) => Some(false),
        Err(_) => None,
    };
    // `indent_size = tab` defers to tab_width, which is the one place these
    // two keys interact.
    let indent = match props.get::<IndentSize>() {
        Ok(IndentSize::Value(n)) => Some(n),
        Ok(IndentSize::UseTabWidth) => match props.get::<TabWidth>() {
            Ok(TabWidth::Value(n)) => Some(n),
            Err(_) => None,
        },
        Err(_) => None,
    };
    let indent_width = indent
        .and_then(|n| u8::try_from(n).ok())
        .filter(|n| INDENT_WIDTH.contains(n));
    let line_width = match props.get::<MaxLineLen>() {
        Ok(MaxLineLen::Value(n)) => u16::try_from(n).ok().filter(|n| LINE_WIDTH.contains(n)),
        Ok(MaxLineLen::Off) | Err(_) => None,
    };
    FormatOptions {
        line_width,
        indent_width,
        use_tabs,
    }
}

/// What `.editorconfig` asks an *editor* to do, as opposed to a formatter.
///
/// Every field is optional and `None` means the file said nothing, which is
/// not the same as saying a default: the editor already has settings of its
/// own, and overwriting them with EditorConfig's defaults would make a
/// `.editorconfig` that mentions only `indent_size` silently reset four other
/// things.
///
/// Names are LSP's (`FormattingOptions.tabSize`, `insertSpaces`) rather than
/// EditorConfig's, because this is the side of the mapping the editor speaks.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct EditorSettings {
    /// `indent_style`. Spaces is `true`, tabs is `false`.
    pub insert_spaces: Option<bool>,
    /// How wide one indent level is, or how wide a tab is drawn — the editor
    /// has one number for both. See `editorconfig_editor_settings`.
    pub tab_size: Option<u8>,
    pub trim_trailing_whitespace: Option<bool>,
    pub insert_final_newline: Option<bool>,
    /// `"\n"` or `"\r\n"`. `end_of_line = cr` resolves to `None`: no editor
    /// this targets offers it, and guessing at one of the other two would be
    /// poly rewriting every line ending in the file to something the project
    /// did not ask for.
    pub end_of_line: Option<&'static str>,
}

/// Editor behaviour inherited from whatever `.editorconfig` covers `path`.
///
/// The sibling of `editorconfig_options`, which reads the same file for the
/// three knobs poly formats with. Two functions rather than one because the
/// two answers are consumed at different moments and one of them can be wrong
/// without the other being: formatting happens on demand and can be checked,
/// while these govern what the editor does as the user types, before poly has
/// been asked anything.
///
/// This is what makes poly able to replace an EditorConfig extension rather
/// than sit next to one. The value is not that the properties get read — any
/// implementation reads them — it is that they are read *here*, by the same
/// ec4rs call and the same file chain `poly fmt` obeys. A second resolver in
/// the extension would be a second answer, and the two would disagree on
/// exactly the projects with complicated configs, which are the projects that
/// wrote one for a reason.
///
/// `charset` and `max_line_length` are deliberately absent. Changing a file's
/// encoding after the editor has already decoded it is how a file gets
/// corrupted, and a ruler is `editor.rulers`, which is a setting rather than a
/// per-file option — honouring it would mean writing to the user's
/// settings.json.
pub fn editorconfig_editor_settings(path: &Path) -> EditorSettings {
    use ec4rs::property::{
        EndOfLine, FinalNewline, IndentSize, IndentStyle, TabWidth, TrimTrailingWs,
    };

    // Same failure policy as `editorconfig_options`: poly reads this file, it
    // does not own it, so a malformed one leaves the editor's own settings alone
    // rather than raising.
    let Ok(props) = ec4rs::properties_of(path) else {
        return EditorSettings::default();
    };
    let insert_spaces = match props.get::<IndentStyle>() {
        Ok(IndentStyle::Tabs) => Some(false),
        Ok(IndentStyle::Spaces) => Some(true),
        Err(_) => None,
    };
    let width = |n: usize| u8::try_from(n).ok().filter(|n| INDENT_WIDTH.contains(n));
    let indent_size = match props.get::<IndentSize>() {
        Ok(IndentSize::Value(n)) => width(n),
        // `indent_size = tab` is a deferral, not a number.
        Ok(IndentSize::UseTabWidth) | Err(_) => None,
    };
    let tab_width = match props.get::<TabWidth>() {
        Ok(TabWidth::Value(n)) => width(n),
        Err(_) => None,
    };
    // EditorConfig has two numbers where the editor has one, and they mean
    // different things: `indent_size` is how far one level indents,
    // `tab_width` is how wide a tab character is drawn. Which one
    // `editor.tabSize` stands for depends on which character is doing the
    // indenting, so the answer follows `indent_style`. Each falls back to the
    // other, which is the spec's own rule and also the only sane reading of a
    // file that sets just one.
    let tab_size = if insert_spaces == Some(false) {
        tab_width.or(indent_size)
    } else {
        indent_size.or(tab_width)
    };
    EditorSettings {
        insert_spaces,
        tab_size,
        trim_trailing_whitespace: match props.get::<TrimTrailingWs>() {
            Ok(TrimTrailingWs::Value(on)) => Some(on),
            Err(_) => None,
        },
        insert_final_newline: match props.get::<FinalNewline>() {
            Ok(FinalNewline::Value(on)) => Some(on),
            Err(_) => None,
        },
        end_of_line: match props.get::<EndOfLine>() {
            Ok(EndOfLine::Lf) => Some("\n"),
            Ok(EndOfLine::CrLf) => Some("\r\n"),
            Ok(EndOfLine::Cr) | Err(_) => None,
        },
    }
}

/// Detect by built-in rules only (no config). Filename rules run before
/// extension rules so `Dockerfile.dev` is dockerfile, not a "dev" extension.
pub fn builtin_language(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_str()?;
    if name == "Dockerfile" || name.starts_with("Dockerfile.") || name.ends_with(".dockerfile") {
        return Some("dockerfile");
    }
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    EXTENSIONS.iter().find(|(e, _)| *e == ext).map(|(_, l)| *l)
}

// ── poly.toml ──────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawConfig {
    languages: RawLanguages,
    format: RawFormat,
    lint: RawLint,
    walk: RawWalk,
    tools: BTreeMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "kebab-case")]
struct RawWalk {
    include_hidden: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawLanguages {
    map: BTreeMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawFormat {
    exclude: Vec<String>,
    /// See `Config::format_fail_on`. Kebab-case like every other key.
    #[serde(rename = "fail-on")]
    fail_on: Option<String>,
    // Per-language option tables: `[format.python]`, `[format.typescript]`, …
    // serde forbids pairing flatten with deny_unknown_fields, but FormatOptions
    // carries its own, so a typo'd key still fails the parse.
    #[serde(flatten)]
    languages: BTreeMap<String, FormatOptions>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawLint {
    exclude: Vec<String>,
    #[serde(rename = "fail-on")]
    fail_on: Option<String>,
    /// Glob -> the `tool/rule` codes that path may not report. See
    /// `Config::lint_ignored`.
    #[serde(rename = "per-file-ignores")]
    per_file_ignores: BTreeMap<String, Vec<String>>,
}

/// One entry of a `[lint.per-file-ignores]` list.
///
/// Spelled exactly as poly prints it — `ruff/F401` is what `[ruff/F401]` in a
/// finding means — so silencing a rule is copying the code out of the output
/// rather than looking up a syntax. `ruff/*` covers every rule from one tool.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Suppression {
    tool: String,
    /// `None` for `tool/*`.
    rule: Option<String>,
}

impl Suppression {
    fn parse(entry: &str, pattern: &str) -> Result<Suppression> {
        // Shape only: an unknown tool or rule name is self-revealing (the
        // finding keeps appearing), but `"F401"` with no tool looks like a
        // spelling poly ought to understand and would silently match nothing.
        let (tool, rule) = entry
            .split_once('/')
            .filter(|(t, r)| !t.is_empty() && !r.is_empty())
            .with_context(|| {
                format!(
                    "[lint.per-file-ignores] {pattern:?}: {entry:?} is not a rule code — write it \
                     the way poly prints it, `tool/rule` (e.g. \"ruff/F401\") or `tool/*`"
                )
            })?;
        anyhow::ensure!(
            !rule.contains('/'),
            "[lint.per-file-ignores] {pattern:?}: {entry:?} has more than one `/`"
        );
        Ok(Suppression {
            tool: tool.to_string(),
            rule: (rule != "*").then(|| rule.to_string()),
        })
    }

    fn matches(&self, source: &str, code: &str) -> bool {
        self.tool == source && self.rule.as_deref().is_none_or(|rule| rule == code)
    }
}

/// Per-language formatter knobs from `[format.<lang>]`.
///
/// Deliberately only the three settings every formatter agrees on. Anything
/// engine-specific belongs in that engine's own config file, which the
/// project-local tool layer already defers to (02 §3.4) — re-exposing each
/// engine's full surface here would be a second, worse copy of it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "kebab-case")]
pub struct FormatOptions {
    pub line_width: Option<u16>,
    pub indent_width: Option<u8>,
    pub use_tabs: Option<bool>,
}

/// Widest line poly will format to. Around what an 8K display fits at a small
/// font, so it is past any real preference and still short of the values that
/// are only ever typos. `u16` alone would accept 65535, which is not a line.
pub const LINE_WIDTH: std::ops::RangeInclusive<u16> = 1..=1000;

/// Deepest single indent. Eight is the widest anyone actually uses (Linux
/// kernel C); sixteen leaves room to be wrong about that without accepting the
/// 200-space indent a stray keystroke produces.
pub const INDENT_WIDTH: std::ops::RangeInclusive<u8> = 1..=16;

impl FormatOptions {
    /// Nothing set: engines can keep using their cached default configuration.
    pub fn is_default(&self) -> bool {
        *self == FormatOptions::default()
    }

    /// `self` wins field by field; `base` fills the rest.
    ///
    /// Field-wise rather than all-or-nothing for the same reason nested
    /// poly.toml files merge that way: a project that sets `line-width` in
    /// poly.toml and `indent_style` in `.editorconfig` means both.
    pub fn over(self, base: FormatOptions) -> FormatOptions {
        FormatOptions {
            line_width: self.line_width.or(base.line_width),
            indent_width: self.indent_width.or(base.indent_width),
            use_tabs: self.use_tabs.or(base.use_tabs),
        }
    }

    /// Reject values no formatter could act on.
    ///
    /// Checked here rather than left to the engine because the failure is
    /// otherwise invisible: a `line-width = 1000` meant as `100` produces a
    /// file that is technically formatted and looks nothing like the rest of
    /// the repo, and nothing in the run says why. Same reasoning as
    /// `deny_unknown_fields` — a setting that cannot do what it says should
    /// stop the run, not quietly change the output.
    fn check(&self, lang: &str) -> Result<()> {
        if let Some(width) = self.line_width {
            anyhow::ensure!(
                LINE_WIDTH.contains(&width),
                "[format.{lang}] line-width = {width}: must be {}..={}",
                LINE_WIDTH.start(),
                LINE_WIDTH.end()
            );
        }
        if let Some(width) = self.indent_width {
            anyhow::ensure!(
                INDENT_WIDTH.contains(&width),
                "[format.{lang}] indent-width = {width}: must be {}..={}",
                INDENT_WIDTH.start(),
                INDENT_WIDTH.end()
            );
        }
        Ok(())
    }
}

pub struct Config {
    /// Compiled `[languages.map]`, in file order. Patterns match against the
    /// file name (`*.tpl`) or the full path when the pattern contains a `/`.
    map: Vec<(GlobMatcher, String)>,
    pub format_exclude: Vec<String>,
    pub lint_exclude: Vec<String>,
    /// Severity floor for `poly fmt --check`'s exit code. Separate from the
    /// lint one on purpose: "unformatted files fail the build, spelling
    /// suggestions do not" is a coherent policy and a common one.
    pub format_fail_on: crate::diag::FailOn,
    pub lint_fail_on: crate::diag::FailOn,
    format_exclude_set: GlobSet,
    lint_exclude_set: GlobSet,
    /// `[lint.per-file-ignores]`, in file order. A GlobSet would say only
    /// *that* something matched, and each pattern carries its own rule list.
    lint_ignores: Vec<(GlobMatcher, Vec<Suppression>)>,
    format_options: BTreeMap<String, FormatOptions>,
    pub tools: BTreeMap<String, String>,
    /// `[walk] include-hidden`. A project decision rather than a per-run one:
    /// a repo whose sources live under a dotted directory needs this on for
    /// every invocation, editor included, or the editor and CI disagree about
    /// which files exist (A4).
    pub include_hidden: bool,
    /// Directory of the nearest poly.toml (config root); None when no config.
    pub root: Option<PathBuf>,
}

/// Which `exclude` list to consult.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
    Format,
    Lint,
}

impl Config {
    /// Walk upward from `start` (a file or directory), collect every
    /// `poly.toml` on the way, and field-level-merge them with nearer files
    /// winning — monorepo subdirs override only what they declare.
    pub fn discover(start: &Path) -> Result<Config> {
        let mut dir = if start.is_dir() {
            start
        } else {
            start.parent().unwrap_or(start)
        };
        let mut chain: Vec<PathBuf> = Vec::new(); // nearest first
        loop {
            let candidate = dir.join("poly.toml");
            if candidate.is_file() {
                chain.push(candidate);
            }
            match dir.parent() {
                Some(parent) => dir = parent,
                None => break,
            }
        }
        let mut merged = toml::Value::Table(Default::default());
        for path in chain.iter().rev() {
            let text = std::fs::read_to_string(path)
                .with_context(|| format!("reading {}", path.display()))?;
            let value: toml::Value = text
                .parse()
                .with_context(|| format!("parsing {}", path.display()))?;
            merge(&mut merged, value);
        }
        let raw: RawConfig = merged
            .try_into()
            .with_context(|| format!("invalid poly.toml (chain from {})", start.display()))?;
        for (lang, options) in &raw.format.languages {
            options.check(lang)?;
        }
        let mut map = Vec::new();
        for (pattern, lang) in &raw.languages.map {
            let glob = Glob::new(pattern)
                .with_context(|| format!("invalid [languages.map] pattern {pattern:?}"))?;
            map.push((glob.compile_matcher(), lang.clone()));
        }
        Ok(Config {
            map,
            format_fail_on: parse_fail_on(raw.format.fail_on.as_deref(), "format")?,
            lint_fail_on: parse_fail_on(raw.lint.fail_on.as_deref(), "lint")?,
            format_exclude_set: compile_excludes(&raw.format.exclude)?,
            lint_exclude_set: compile_excludes(&raw.lint.exclude)?,
            lint_ignores: compile_per_file_ignores(&raw.lint.per_file_ignores)?,
            format_exclude: raw.format.exclude,
            lint_exclude: raw.lint.exclude,
            format_options: raw.format.languages,
            tools: raw.tools,
            include_hidden: raw.walk.include_hidden,
            root: chain
                .first()
                .and_then(|p| p.parent())
                .map(Path::to_path_buf),
        })
    }

    pub fn empty() -> Config {
        Config {
            map: Vec::new(),
            format_fail_on: crate::diag::FailOn::default(),
            lint_fail_on: crate::diag::FailOn::default(),
            format_exclude: Vec::new(),
            lint_exclude: Vec::new(),
            format_exclude_set: GlobSet::empty(),
            lint_exclude_set: GlobSet::empty(),
            lint_ignores: Vec::new(),
            format_options: BTreeMap::new(),
            tools: BTreeMap::new(),
            include_hidden: false,
            root: None,
        }
    }

    /// Does this config exclude `path`? Patterns are anchored at the config's
    /// own directory, the way a .gitignore in that directory would be, so a
    /// package-level `poly.toml` saying `generated/**` means its own
    /// `generated/`, not whichever directory the command was invoked from.
    pub fn excluded(&self, path: &Path, scope: Scope) -> bool {
        let set = match scope {
            Scope::Format => &self.format_exclude_set,
            Scope::Lint => &self.lint_exclude_set,
        };
        if set.is_empty() {
            return false;
        }
        set.is_match(self.relative(path))
    }

    /// Is this finding silenced for this file by `[lint.per-file-ignores]`?
    ///
    /// The narrower neighbour of `[lint] exclude`: a test fixture with a
    /// deliberate typo or a vendored script with one unquoted expansion is
    /// still worth linting for everything *else*, and dropping the whole file
    /// to silence one rule is how a suppression stops being reviewable.
    ///
    /// Called with the same `source` and `code` the terminal prints as
    /// `[source/code]`, so what you read in the output is what you paste into
    /// the config. Anchored at the config's own directory like `exclude`, and
    /// consulted by the CLI and the daemon alike — a rule silenced only in the
    /// editor is the editor/CI split A4 exists to prevent.
    pub fn lint_ignored(&self, path: &Path, source: &str, code: &str) -> bool {
        if self.lint_ignores.is_empty() {
            return false;
        }
        let relative = self.relative(path);
        self.lint_ignores.iter().any(|(matcher, entries)| {
            matcher.is_match(relative) && entries.iter().any(|e| e.matches(source, code))
        })
    }

    /// Path as the patterns in this config were written: relative to the
    /// directory holding the poly.toml they came from.
    fn relative<'p>(&self, path: &'p Path) -> &'p Path {
        match &self.root {
            Some(root) => path.strip_prefix(root).unwrap_or(path),
            None => path,
        }
    }

    /// Formatter knobs for `lang`, from `[format.<lang>]`. Nested poly.toml
    /// files field-merge like everything else, so a package can override just
    /// `line-width` and keep the repo's `indent-width`.
    ///
    /// This is what the project said explicitly. What a `.editorconfig` says
    /// is separate on purpose -- see `editorconfig_options`, and the caller
    /// that merges the two.
    pub fn format_options(&self, lang: &str) -> FormatOptions {
        self.format_options.get(lang).copied().unwrap_or_default()
    }

    /// `[languages.map]` first (project truth), then built-in detection.
    pub fn language(&self, path: &Path) -> Option<String> {
        let name = path.file_name()?.to_str()?;
        for (matcher, lang) in &self.map {
            let candidate: &Path = if matcher.glob().glob().contains('/') {
                path
            } else {
                Path::new(name)
            };
            if matcher.is_match(candidate) {
                return Some(lang.clone());
            }
        }
        builtin_language(path).map(str::to_string)
    }
}

/// A misspelled severity fails the parse rather than falling back to the
/// default, for the same reason a misspelled `line-width` does: the silent
/// fallback here is "fail on everything", which looks like the setting simply
/// having no effect.
fn parse_fail_on(value: Option<&str>, section: &str) -> Result<crate::diag::FailOn> {
    match value {
        None => Ok(crate::diag::FailOn::default()),
        Some(v) => crate::diag::FailOn::parse(v).map_err(|e| anyhow::anyhow!("[{section}] {e}")),
    }
}

fn compile_per_file_ignores(
    raw: &BTreeMap<String, Vec<String>>,
) -> Result<Vec<(GlobMatcher, Vec<Suppression>)>> {
    let mut compiled = Vec::new();
    for (pattern, entries) in raw {
        let glob = Glob::new(pattern)
            .with_context(|| format!("invalid [lint.per-file-ignores] pattern {pattern:?}"))?;
        let entries = entries
            .iter()
            .map(|entry| Suppression::parse(entry, pattern))
            .collect::<Result<Vec<_>>>()?;
        compiled.push((glob.compile_matcher(), entries));
    }
    Ok(compiled)
}

fn compile_excludes(patterns: &[String]) -> Result<GlobSet> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(
            Glob::new(pattern).with_context(|| format!("invalid exclude pattern {pattern:?}"))?,
        );
    }
    builder.build().context("building exclude matcher")
}

/// Resolves the config for each file in a batch, memoized per directory.
///
/// 02 §"設定分層" wants the nearest `poly.toml` above the *target file*, but a
/// batch run touches thousands of files across a handful of directories, and
/// re-walking the chain for each one would re-read the same TOML over and over.
#[derive(Default)]
pub struct ConfigCache {
    by_dir: HashMap<PathBuf, Arc<Config>>,
}

impl ConfigCache {
    pub fn new() -> ConfigCache {
        ConfigCache::default()
    }

    /// Config governing `path`. An unreadable or invalid `poly.toml` yields an
    /// empty config rather than failing the whole batch — the file itself is
    /// still worth formatting, and `poly check` reports the config error.
    pub fn for_file(&mut self, path: &Path) -> Arc<Config> {
        let dir = path.parent().unwrap_or(path).to_path_buf();
        if let Some(hit) = self.by_dir.get(&dir) {
            return Arc::clone(hit);
        }
        let config = Arc::new(Config::discover(path).unwrap_or_else(|_| Config::empty()));
        self.by_dir.insert(dir, Arc::clone(&config));
        config
    }
}

/// Deep-merge `incoming` into `base`: tables merge key-wise, everything else
/// (scalars, arrays) replaces wholesale.
fn merge(base: &mut toml::Value, incoming: toml::Value) {
    match (base, incoming) {
        (toml::Value::Table(b), toml::Value::Table(inc)) => {
            for (k, v) in inc {
                match b.get_mut(&k) {
                    Some(slot) => merge(slot, v),
                    None => {
                        b.insert(k, v);
                    }
                }
            }
        }
        (slot, v) => *slot = v,
    }
}

// ── file walking ───────────────────────────────────────────────────────────

/// Whether the walk honors the ignore files git honors: `.gitignore`,
/// `.ignore`, `.git/info/exclude` and the global excludes file (`core.
/// excludesFile`, else `$XDG_CONFIG_HOME/git/ignore`) — the ancestors' copies
/// of each included.
///
/// poly.toml's own `exclude` is not one of these and stays in force either way:
/// it is the project saying "never touch this", not the VCS saying "do not
/// track this". The two answer different questions and a file can need both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ignores {
    Respect,
    /// `--no-ignore`: the file you need to check is sometimes the generated,
    /// vendored or built one that git was told to leave alone.
    Disregard,
}

/// Whether dotted files and directories are walked.
///
/// Skipped by default, because a dot prefix is how a tree says "this is
/// machinery, not source" and most of what it hides is enormous — `.venv`,
/// `.terraform`, editor state. `.github` is the standing exception and is
/// walked either way: its workflows are source, and linting them is the whole
/// reason actionlint is wired in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hidden {
    Skip,
    /// `--hidden` or `[walk] include-hidden`.
    Include,
}

/// The two ways a walk can be widened past its defaults. Neither can narrow it:
/// hiding more files is what `exclude` is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Walk {
    pub ignores: Ignores,
    pub hidden: Hidden,
}

impl Default for Walk {
    fn default() -> Self {
        Walk {
            ignores: Ignores::Respect,
            hidden: Hidden::Skip,
        }
    }
}

/// Collect files under `paths`, honoring [`Walk`] plus `exclude` globs.
/// Explicit file arguments always pass through.
///
/// `anchor` is the directory the patterns are relative to — the config's own
/// root, so `vendor/**` in a repo-root `poly.toml` means the repo's `vendor/`
/// regardless of which subdirectory the command was pointed at. Falls back to
/// the walk root when there is no config (in which case there are no patterns
/// either).
pub fn walk_files(
    paths: &[PathBuf],
    exclude: &[String],
    anchor: Option<&Path>,
    walk: Walk,
) -> Result<Vec<PathBuf>> {
    let hidden = walk.hidden == Hidden::Skip;
    let mut out = Vec::new();
    for root in paths {
        if root.is_file() {
            out.push(root.clone());
            continue;
        }
        let mut overrides = ignore::overrides::OverrideBuilder::new(anchor.unwrap_or(root));
        for pattern in exclude {
            // In OverrideBuilder, a "!" prefix means "ignore this glob".
            overrides
                .add(&format!("!{pattern}"))
                .with_context(|| format!("invalid exclude pattern {pattern:?}"))?;
        }
        // .git is machinery under any setting: object files are not source, and
        // there are tens of thousands of them. Skipping it by dot prefix alone
        // would mean --hidden walked the whole object store.
        overrides.add("!.git/")?;
        let mut builder = ignore::WalkBuilder::new(root);
        // .github matters (workflow linting/formatting) and the dot prefix
        // would otherwise hide it; walk it as an extra root. Redundant once
        // hidden files are included, and the dedup below absorbs that.
        let github = root.join(".github");
        if hidden && github.is_dir() {
            builder.add(github);
        }
        let respect = walk.ignores == Ignores::Respect;
        let walker = builder
            .overrides(overrides.build()?)
            .hidden(hidden)
            .ignore(respect)
            .git_ignore(respect)
            .git_global(respect)
            .git_exclude(respect)
            // Without this, `--no-ignore` inside a subdirectory would still
            // obey the repo-root .gitignore above it.
            .parents(respect)
            .build();
        for entry in walker {
            let entry = entry?;
            if entry.file_type().is_some_and(|t| t.is_file()) {
                out.push(entry.into_path());
            }
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_detection() {
        let cases = [
            ("a/b.ts", Some("typescript")),
            ("b.yml", Some("yaml")),
            ("Dockerfile", Some("dockerfile")),
            ("Dockerfile.dev", Some("dockerfile")),
            ("base.dockerfile", Some("dockerfile")),
            ("noext", None),
            ("a.unknown", None),
        ];
        for (path, expected) in cases {
            assert_eq!(builtin_language(Path::new(path)), expected, "{path}");
        }
    }

    #[test]
    fn map_overrides_builtin_and_upward_merge() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("poly.toml"),
            "[languages.map]\n\"*.tpl\" = \"hcl\"\n\"*.yml\" = \"json\"\n[format]\nexclude = [\"vendor/**\"]\n",
        )
        .unwrap();
        let sub = root.join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(
            sub.join("poly.toml"),
            "[languages.map]\n\"*.yml\" = \"toml\"\n",
        )
        .unwrap();

        let cfg = Config::discover(&sub.join("x.txt")).unwrap();
        // Nearer file wins per key; unrelated keys inherit from the outer file.
        assert_eq!(cfg.language(Path::new("a.yml")).as_deref(), Some("toml"));
        assert_eq!(cfg.language(Path::new("a.tpl")).as_deref(), Some("hcl"));
        assert_eq!(
            cfg.language(Path::new("a.ts")).as_deref(),
            Some("typescript")
        );
        assert_eq!(cfg.format_exclude, vec!["vendor/**"]);
        assert_eq!(cfg.root.as_deref(), Some(sub.as_path()));

        let outer = Config::discover(root).unwrap();
        assert_eq!(outer.language(Path::new("a.yml")).as_deref(), Some("json"));
    }

    #[test]
    fn format_options_merge_field_wise_across_the_chain() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("poly.toml"),
            "[format.python]\nline-width = 100\nindent-width = 4\n[format.typescript]\nuse-tabs = true\n",
        )
        .unwrap();
        let pkg = root.join("pkg");
        std::fs::create_dir(&pkg).unwrap();
        // Overrides one key; the repo-wide indent-width must survive, or a
        // package could not tweak width without restating everything.
        std::fs::write(pkg.join("poly.toml"), "[format.python]\nline-width = 79\n").unwrap();

        let outer = Config::discover(root).unwrap();
        assert_eq!(outer.format_options("python").line_width, Some(100));
        assert_eq!(outer.format_options("typescript").use_tabs, Some(true));
        // A language with no table gets defaults, not an error.
        assert!(outer.format_options("json").is_default());

        let inner = Config::discover(&pkg).unwrap();
        assert_eq!(inner.format_options("python").line_width, Some(79));
        assert_eq!(inner.format_options("python").indent_width, Some(4));
        assert_eq!(inner.format_options("typescript").use_tabs, Some(true));
    }

    #[test]
    fn a_misspelled_format_option_fails_the_parse() {
        let dir = tempfile::tempdir().unwrap();
        // Silently ignoring this would mean poly.toml says one thing and the
        // output does another, with nothing to look at.
        std::fs::write(
            dir.path().join("poly.toml"),
            "[format.python]\nline_width = 100\n",
        )
        .unwrap();
        let err = match Config::discover(dir.path()) {
            Err(e) => format!("{e:#}"),
            Ok(_) => panic!("a misspelled option must not be silently ignored"),
        };
        assert!(err.contains("poly.toml"), "{err}");
    }

    /// A width outside these bounds is a typo, not a preference, and the way it
    /// fails otherwise is the worst kind: the file formats, looks nothing like
    /// the rest of the repo, and nothing in the run says why.
    #[test]
    fn widths_outside_the_usable_range_fail_the_parse() {
        let parse = |body: &str| {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("poly.toml"), body).unwrap();
            Config::discover(dir.path())
                .map(|_| ())
                .map_err(|e| format!("{e:#}"))
        };

        let err = parse("[format.python]\nline-width = 5000\n").unwrap_err();
        assert!(err.contains("line-width = 5000"), "{err}");
        assert!(
            err.contains("1..=1000"),
            "the message must name the range: {err}"
        );

        // Zero is in range for the type and meaningless for a formatter.
        assert!(parse("[format.json]\nline-width = 0\n").is_err());
        assert!(parse("[format.json]\nindent-width = 0\n").is_err());

        let err = parse("[format.json]\nindent-width = 17\n").unwrap_err();
        assert!(err.contains("1..=16"), "{err}");

        // The edges themselves stay legal: the bound is on the absurd, not on
        // anyone's taste.
        assert!(parse("[format.json]\nline-width = 1000\nindent-width = 16\n").is_ok());
        assert!(parse("[format.json]\nline-width = 1001\n").is_err());
    }

    #[test]
    fn nested_config_applies_per_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("poly.toml"),
            "[languages.map]\n\"*.tpl\" = \"hcl\"\n[format]\nexclude = [\"vendor/**\"]\n",
        )
        .unwrap();
        let pkg = root.join("pkg");
        std::fs::create_dir(&pkg).unwrap();
        std::fs::write(
            pkg.join("poly.toml"),
            "[languages.map]\n\"*.tpl\" = \"json\"\n[format]\nexclude = [\"generated/**\"]\n",
        )
        .unwrap();

        let mut cache = ConfigCache::new();
        // Same extension, two answers — which one depends on where the file is.
        let outer = cache.for_file(&root.join("a.tpl"));
        let inner = cache.for_file(&pkg.join("a.tpl"));
        assert_eq!(outer.language(Path::new("a.tpl")).as_deref(), Some("hcl"));
        assert_eq!(inner.language(Path::new("a.tpl")).as_deref(), Some("json"));

        // Each config's patterns are anchored at its own directory, so the
        // outer `vendor/**` does not reach into pkg/.
        assert!(outer.excluded(&root.join("vendor/x.tpl"), Scope::Format));
        assert!(!outer.excluded(&pkg.join("vendor/x.tpl"), Scope::Format));
        assert!(inner.excluded(&pkg.join("generated/x.tpl"), Scope::Format));
        // Arrays replace rather than merge, so pkg dropped the outer list.
        assert!(!inner.excluded(&pkg.join("vendor/x.tpl"), Scope::Format));
        // lint excludes are a separate list; neither file set one.
        assert!(!inner.excluded(&pkg.join("generated/x.tpl"), Scope::Lint));
    }

    /// The intent is "keep linting this file, minus this rule" — so anything
    /// that is not the named rule on the named path has to survive, or the
    /// setting is just a slower `exclude`.
    #[test]
    fn per_file_ignores_silence_only_the_named_rule() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("poly.toml"),
            "[lint.per-file-ignores]\n\
             \"tests/**\" = [\"ruff/F401\"]\n\
             \"vendor/*.sh\" = [\"shellcheck/*\"]\n",
        )
        .unwrap();
        let config = Config::discover(root).unwrap();

        assert!(config.lint_ignored(&root.join("tests/a.py"), "ruff", "F401"));
        // A different rule, a different tool, and a different path each still
        // report.
        assert!(!config.lint_ignored(&root.join("tests/a.py"), "ruff", "E501"));
        assert!(!config.lint_ignored(&root.join("tests/a.py"), "typos", "F401"));
        assert!(!config.lint_ignored(&root.join("src/a.py"), "ruff", "F401"));

        // `tool/*` is the whole tool, on that path only.
        assert!(config.lint_ignored(&root.join("vendor/x.sh"), "shellcheck", "SC2086"));
        assert!(config.lint_ignored(&root.join("vendor/x.sh"), "shellcheck", "SC1017"));
        assert!(!config.lint_ignored(&root.join("vendor/x.sh"), "typos", "typo"));
        assert!(!config.lint_ignored(&root.join("src/x.sh"), "shellcheck", "SC2086"));

        // Patterns are anchored at the poly.toml's directory, like `exclude`:
        // "tests/**" written at the repo root means that root's tests/.
        let nested = root.join("pkg");
        std::fs::create_dir(&nested).unwrap();
        assert!(!config.lint_ignored(&nested.join("tests/a.py"), "ruff", "F401"));
    }

    /// A code with no tool would match nothing and read like a working
    /// setting. Same reasoning as `deny_unknown_fields`: a line that cannot do
    /// what it says stops the run.
    #[test]
    fn a_malformed_suppression_fails_the_parse() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let write = |body: &str| std::fs::write(root.join("poly.toml"), body).unwrap();

        let error = |root: &Path| match Config::discover(root) {
            Ok(_) => panic!("expected the parse to fail"),
            Err(e) => format!("{e:#}"),
        };

        write("[lint.per-file-ignores]\n\"tests/**\" = [\"F401\"]\n");
        let err = error(root);
        assert!(err.contains("F401"), "{err}");
        assert!(err.contains("tool/rule"), "{err}");

        write("[lint.per-file-ignores]\n\"tests/**\" = [\"a/b/c\"]\n");
        assert!(error(root).contains("more than one"));

        // The shape is all that is checked: poly cannot know every rule code
        // its tools will grow, and an unknown one is visible anyway — the
        // finding it was meant to silence keeps being printed.
        write("[lint.per-file-ignores]\n\"tests/**\" = [\"ruff/NOSUCHRULE\"]\n");
        assert!(Config::discover(root).is_ok());
    }

    #[test]
    fn walk_respects_gitignore_and_exclude() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("vendor")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join(".gitignore"), "ignored.ts\n").unwrap();
        std::fs::write(root.join("src/keep.ts"), "").unwrap();
        std::fs::write(root.join("ignored.ts"), "").unwrap();
        std::fs::write(root.join("vendor/skip.ts"), "").unwrap();
        // .gitignore matters even outside a git repo? `ignore` only honors it
        // inside a repo, so create the marker.
        std::fs::create_dir_all(root.join(".git")).unwrap();

        let walk = |ignores| {
            let options = Walk {
                ignores,
                ..Default::default()
            };
            let files =
                walk_files(&[root.to_path_buf()], &["vendor/**".into()], None, options).unwrap();
            files
                .iter()
                .map(|p| p.strip_prefix(root).unwrap().to_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };

        let names = walk(Ignores::Respect);
        assert!(names.contains(&"src/keep.ts".to_string()), "{names:?}");
        assert!(!names.iter().any(|n| n.contains("ignored")), "{names:?}");
        assert!(!names.iter().any(|n| n.contains("vendor")), "{names:?}");

        // --no-ignore reaches the ignored file, but poly.toml's exclude is the
        // project's own decision and survives.
        let names = walk(Ignores::Disregard);
        assert!(names.contains(&"ignored.ts".to_string()), "{names:?}");
        assert!(names.contains(&"src/keep.ts".to_string()), "{names:?}");
        assert!(!names.iter().any(|n| n.contains("vendor")), "{names:?}");
    }

    #[test]
    fn hidden_files_are_opt_in_but_git_never_is() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for sub in [".git", ".config", ".github/workflows", "src"] {
            std::fs::create_dir_all(root.join(sub)).unwrap();
        }
        std::fs::write(root.join("src/keep.ts"), "").unwrap();
        std::fs::write(root.join(".config/tool.ts"), "").unwrap();
        std::fs::write(root.join(".dotfile.ts"), "").unwrap();
        std::fs::write(root.join(".github/workflows/ci.yml"), "").unwrap();
        std::fs::write(root.join(".git/hooks.ts"), "").unwrap();

        let walk = |hidden| {
            let options = Walk {
                hidden,
                ..Default::default()
            };
            walk_files(&[root.to_path_buf()], &[], None, options)
                .unwrap()
                .iter()
                .map(|p| p.strip_prefix(root).unwrap().to_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };

        let names = walk(Hidden::Skip);
        assert!(names.contains(&"src/keep.ts".to_string()), "{names:?}");
        // .github is the standing exception: workflows are source.
        assert!(
            names.contains(&".github/workflows/ci.yml".to_string()),
            "{names:?}"
        );
        assert!(!names.iter().any(|n| n.starts_with(".config")), "{names:?}");
        assert!(!names.contains(&".dotfile.ts".to_string()), "{names:?}");

        let names = walk(Hidden::Include);
        assert!(names.contains(&".config/tool.ts".to_string()), "{names:?}");
        assert!(names.contains(&".dotfile.ts".to_string()), "{names:?}");
        assert_eq!(
            names.iter().filter(|n| n.contains("ci.yml")).count(),
            1,
            "the extra .github root must not double-list it: {names:?}"
        );
        // Reaching hidden files must not mean walking the object store.
        assert!(!names.iter().any(|n| n.starts_with(".git/")), "{names:?}");
    }

    #[test]
    fn editorconfig_maps_three_keys_and_drops_what_it_cannot_use() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // `root = true` keeps this test off whatever .editorconfig happens to
        // sit above the temp directory.
        std::fs::write(
            root.join(".editorconfig"),
            "root = true\n\
             \n\
             [*]\n\
             indent_style = tab\n\
             indent_size = 4\n\
             max_line_length = 100\n\
             \n\
             [*.py]\n\
             indent_style = space\n\
             indent_size = tab\n\
             tab_width = 2\n\
             max_line_length = off\n\
             \n\
             [*.js]\n\
             indent_size = 999\n\
             max_line_length = 2000\n",
        )
        .unwrap();

        let opts = |name: &str| editorconfig_options(&root.join(name));

        assert_eq!(
            opts("a.ts"),
            FormatOptions {
                line_width: Some(100),
                indent_width: Some(4),
                use_tabs: Some(true),
            }
        );
        assert_eq!(
            opts("a.py"),
            FormatOptions {
                // `max_line_length = off` is a real answer -- "no limit" --
                // not a missing one, so it must leave poly's default alone
                // rather than become a width.
                line_width: None,
                // indent_size = tab defers to tab_width.
                indent_width: Some(2),
                use_tabs: Some(false),
            }
        );
        // Out-of-range values are dropped, not raised: this file belongs to
        // every editor the repo has used, so poly reads what it can and stays
        // out of the way of the rest. The narrower section still inherits
        // indent_style from [*].
        assert_eq!(
            opts("a.js"),
            FormatOptions {
                line_width: None,
                indent_width: None,
                use_tabs: Some(true),
            }
        );
    }

    /// The editor half of the same file: what poly tells VSCode to do while the
    /// user types, rather than what it formats with.
    ///
    /// The point of resolving it here is that these answers come from the same
    /// ec4rs call and the same file chain as the formatter's. A second resolver
    /// in the extension would disagree on exactly this test's fixture -- glob
    /// sections, inheritance, and the two width keys deferring to each other.
    #[test]
    fn editorconfig_answers_what_the_editor_asks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join(".editorconfig"),
            "root = true\n\
             \n\
             [*]\n\
             indent_style = space\n\
             indent_size = 2\n\
             trim_trailing_whitespace = true\n\
             insert_final_newline = true\n\
             end_of_line = lf\n\
             \n\
             [*.go]\n\
             indent_style = tab\n\
             tab_width = 8\n\
             \n\
             [*.md]\n\
             trim_trailing_whitespace = false\n\
             \n\
             [*.bat]\n\
             end_of_line = crlf\n\
             \n\
             [*.odd]\n\
             end_of_line = cr\n",
        )
        .unwrap();

        let settings = |name: &str| editorconfig_editor_settings(&root.join(name));

        assert_eq!(
            settings("a.ts"),
            EditorSettings {
                insert_spaces: Some(true),
                tab_size: Some(2),
                trim_trailing_whitespace: Some(true),
                insert_final_newline: Some(true),
                end_of_line: Some("\n"),
            }
        );
        // Tabs: the editor's one number is how wide a tab is drawn, so
        // tab_width answers rather than the indent_size inherited from [*].
        // Everything else still inherits.
        assert_eq!(
            settings("a.go"),
            EditorSettings {
                insert_spaces: Some(false),
                tab_size: Some(8),
                trim_trailing_whitespace: Some(true),
                insert_final_newline: Some(true),
                end_of_line: Some("\n"),
            }
        );
        // Markdown turning trimming off is the reason this property is read at
        // all: two trailing spaces are a hard line break, and a global "trim on
        // save" deletes them.
        assert_eq!(settings("a.md").trim_trailing_whitespace, Some(false));
        assert_eq!(settings("a.bat").end_of_line, Some("\r\n"));
        // `cr` is a real answer poly has no way to give, so it says nothing
        // rather than pick one of the other two and rewrite every line ending.
        assert_eq!(settings("a.odd").end_of_line, None);

        // No file, nothing said: every field stays None so the editor keeps the
        // settings the user chose. A default here would silently reset them.
        let bare = tempfile::tempdir().unwrap();
        std::fs::write(bare.path().join(".editorconfig"), "root = true\n").unwrap();
        assert_eq!(
            editorconfig_editor_settings(&bare.path().join("a.ts")),
            EditorSettings::default()
        );
    }

    #[test]
    fn poly_toml_beats_editorconfig_key_by_key() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join(".editorconfig"),
            "root = true\n[*]\nindent_style = tab\nindent_size = 8\nmax_line_length = 120\n",
        )
        .unwrap();
        std::fs::write(
            root.join("poly.toml"),
            "[format.typescript]\nline-width = 80\n",
        )
        .unwrap();

        let file = root.join("a.ts");
        let config = Config::discover(&file).unwrap();
        let merged = config
            .format_options("typescript")
            .over(editorconfig_options(&file));

        assert_eq!(
            merged,
            FormatOptions {
                // Named in poly.toml: the explicit setting wins.
                line_width: Some(80),
                // Absent from poly.toml: inherited rather than reset to poly's
                // own default, which is what makes .editorconfig worth reading
                // at all.
                indent_width: Some(8),
                use_tabs: Some(true),
            }
        );
    }
}

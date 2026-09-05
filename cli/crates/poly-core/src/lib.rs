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
    // MDX is markdown with ESM imports and JSX blocks. The markdown engine
    // leaves both untouched -- they are block-level HTML as far as it is
    // concerned -- while still normalizing the prose around them, and a
    // project carrying prettier gets the full job because poly hands prettier
    // the real path and prettier picks its mdx parser from the extension.
    ("mdx", "markdown"),
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
    // VSCode's built-in handlebars extension owns the id and this exact
    // extension list; poly only adds a formatter for it.
    ("hbs", "handlebars"),
    ("handlebars", "handlebars"),
    ("hjs", "handlebars"),
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

/// Every language id built-in detection can produce, sorted and deduplicated.
///
/// The set `[languages.map]` values and `[format.<lang>]` tables are checked
/// against, and the set the generated poly.example.toml lists. Derived from
/// `EXTENSIONS` rather than written out a second time, because a hand-copied
/// list is exactly what went stale: `handlebars` and `protobuf` were detected
/// for two releases before the documentation heard about them.
///
/// `dockerfile` is added by hand because it is the one id no extension yields
/// -- `builtin_language` reaches it through a filename rule.
pub fn builtin_languages() -> Vec<&'static str> {
    let mut ids: Vec<&'static str> = EXTENSIONS.iter().map(|(_, lang)| *lang).collect();
    ids.push("dockerfile");
    ids.sort_unstable();
    ids.dedup();
    ids
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
    /// The grammar itself, with no surface attached. `Err` is the sentence a
    /// reader needs, and the two callers put it where their surface can show it
    /// -- the config aborts the parse, an inline comment reports a finding.
    /// One function because there is one syntax: what poly prints is what you
    /// paste, into either place.
    fn parse_code(entry: &str) -> Result<Suppression, String> {
        // Shape only: an unknown tool or rule name is self-revealing (the
        // finding keeps appearing), but `"F401"` with no tool looks like a
        // spelling poly ought to understand and would silently match nothing.
        let (tool, rule) = entry
            .split_once('/')
            .filter(|(t, r)| !t.is_empty() && !r.is_empty())
            .ok_or_else(|| {
                format!(
                    "{entry:?} is not a rule code — write it the way poly prints it, `tool/rule` \
                     (e.g. \"ruff/F401\") or `tool/*`"
                )
            })?;
        if rule.contains('/') {
            return Err(format!("{entry:?} has more than one `/`"));
        }
        Ok(Suppression {
            tool: tool.to_string(),
            rule: (rule != "*").then(|| rule.to_string()),
        })
    }

    fn parse(entry: &str, pattern: &str) -> Result<Suppression> {
        Suppression::parse_code(entry)
            .map_err(|reason| anyhow::anyhow!("[lint.per-file-ignores] {pattern:?}: {reason}"))
    }

    fn matches(&self, source: &str, code: &str) -> bool {
        self.tool == source && self.rule.as_deref().is_none_or(|rule| rule == code)
    }
}

// ── inline suppressions ────────────────────────────────────────────────────

/// What an inline suppression comment says, after whatever introduces a comment
/// in that language.
const INLINE_MARKER: &str = "poly: ignore";

/// The rule `syntax_issues` reports under, and the prose `lint::rule_doc`
/// serves for it.
///
/// Exported so the documentation lives next to the code that emits it, the way
/// poly's Dockerfile and workflow rules do -- poly's own rules have no upstream
/// page to link, so the prose ships in the binary or the reader has nothing to
/// look up.
pub const INLINE_RULES: &[(&str, &str)] = &[(
    "ignore-syntax",
    "A `poly: ignore` comment poly will not act on. Codes are spelled the way \
     poly prints them -- `[ruff/F401]` in a finding is `ruff/F401` in the \
     comment -- and `tool/*` covers one tool entirely. A bare `F401` names no \
     tool, so it would match nothing and read like a working suppression. In a \
     Dockerfile a trailing comment is reported too: `poly fmt` moves it onto a \
     line of its own, where it would cover the next instruction instead, so it \
     belongs above the line it excuses. Either way the comment is reported \
     rather than the run aborted, because one comment in one file is not a \
     reason to stop checking a repo. The same rule reports a \
     `# hadolint ignore=` in a Dockerfile when hadolint is off, for the same \
     reason: it silences nothing, and poly names the code to write instead.",
)];

/// hadolint's rule codes, mapped to the poly rule that says the same thing.
///
/// Only used to word one sentence: when hadolint is off, a
/// `# hadolint ignore=DL3008` silences nothing, and "write
/// `# poly: ignore poly/docker-apt-get-unpinned` instead" is a better answer
/// than "this does nothing". A code with no entry gets the shorter sentence
/// rather than a guess.
///
/// Only the `DL` codes are here. hadolint's other half is shellcheck run over
/// every `RUN`, and poly reports those itself now under shellcheck's own name,
/// so `SC2086` becomes `shellcheck/SC2086` by construction rather than by a
/// table that would have to list every shellcheck rule there is.
///
/// Poly does **not** honour hadolint's syntax, and this table is not a step
/// towards it. Reading `# hadolint ignore=` as a suppression would be a
/// compatibility layer for a tool poly no longer runs -- two syntaxes for one
/// job, forever, and a comment whose meaning depends on a `[tools]` line
/// somewhere else. What this does is tell the author what poly's own syntax
/// spells it as, once, so the comment can be replaced and deleted.
///
/// Read against the two tools' messages by hand, and held to the rules that
/// actually exist by `hadolint_replacements_name_real_rules` in poly-engines,
/// which is the crate that owns `DOCKER_RULES`.
pub const HADOLINT_REPLACEMENTS: &[(&str, &str)] = &[
    ("DL3000", "docker-workdir-relative"),
    ("DL3002", "docker-root-user"),
    ("DL3003", "docker-cd-in-run"),
    ("DL3004", "docker-sudo-in-run"),
    ("DL3006", "docker-untagged-base"),
    ("DL3007", "docker-latest-base"),
    ("DL3008", "docker-apt-get-unpinned"),
    ("DL3009", "docker-apt-get-no-clean"),
    ("DL3011", "docker-invalid-port"),
    ("DL3013", "docker-pip-unpinned"),
    ("DL3014", "docker-apt-get-interactive"),
    ("DL3015", "docker-apt-get-no-recommends"),
    ("DL3016", "docker-npm-unpinned"),
    ("DL3018", "docker-apk-unpinned"),
    ("DL3019", "docker-apk-no-cache"),
    ("DL3020", "docker-add-instead-of-copy"),
    ("DL3021", "docker-copy-multiple-sources-no-slash"),
    ("DL3025", "docker-shell-form-command"),
    ("DL3027", "docker-apt-not-apt-get"),
    ("DL3029", "docker-from-platform-pinned"),
    ("DL3032", "docker-yum-no-clean"),
    ("DL3033", "docker-yum-unpinned"),
    ("DL3042", "docker-pip-cache"),
    ("DL3045", "docker-copy-relative-no-workdir"),
    ("DL3061", "docker-missing-from"),
    ("DL3062", "docker-go-install-unpinned"),
    ("DL3064", "docker-secret-in-env"),
    ("DL3065", "docker-from-platform-redundant"),
    ("DL3067", "docker-copy-whole-filesystem"),
    ("DL4000", "docker-maintainer-deprecated"),
    ("DL4001", "docker-wget-and-curl"),
    ("DL4003", "docker-multiple-cmd"),
    ("DL4004", "docker-multiple-entrypoint"),
    ("DL4006", "docker-pipe-without-pipefail"),
];

/// Comment introducers an inline suppression may follow, by language id.
///
/// Keyed on the id `Config::language` produces, so `EXTENSIONS` stays the only
/// place that says which file is which language -- a second file-type table is
/// how `nearest_ancestor_file` came to have two implementations that
/// disagreed. `inline_suppression_covers_every_language` holds the two lists
/// together: every id `builtin_languages` yields is either here or in that
/// test's list of the ones deliberately left out.
///
/// Three families is the whole set poly needs, and a language outside them gets
/// no inline suppression at all rather than a guess: `[lint.per-file-ignores]`
/// still works there, and the finding continuing to appear says so.
const COMMENT_PREFIXES: &[(&str, &[&str])] = &[
    ("c", &["//"]),
    ("cpp", &["//"]),
    ("dockerfile", &["#"]),
    ("go", &["//"]),
    ("graphql", &["#"]),
    // Both spellings are HCL's own.
    ("hcl", &["#", "//"]),
    ("terraform", &["#", "//"]),
    // The id covers .jsonc as well as .json, and .jsonc is where a comment is
    // legal. Writing one in strict JSON breaks the file loudly on the next
    // parse, which is not a failure mode poly has to protect anyone from.
    ("json", &["//"]),
    ("less", &["//"]),
    ("lua", &["--"]),
    ("protobuf", &["//"]),
    ("python", &["#"]),
    ("rust", &["//"]),
    ("scss", &["//"]),
    ("shellscript", &["#"]),
    ("sql", &["--"]),
    ("swift", &["//"]),
    ("toml", &["#"]),
    ("typescript", &["//"]),
    ("yaml", &["#"]),
];

fn comment_prefixes(lang: &str) -> &'static [&'static str] {
    COMMENT_PREFIXES
        .iter()
        .find(|(id, _)| *id == lang)
        .map_or(&[], |(_, prefixes)| *prefixes)
}

/// One suppression comment, and the lines it silences.
struct InlineEntry {
    /// Inclusive, 0-based. One line for a trailing comment, two when the
    /// comment is on a line of its own -- see `InlineIgnores::scan`.
    first: u32,
    last: u32,
    codes: Vec<Suppression>,
}

/// A `poly: ignore` comment poly reports on instead of acting on: one it cannot
/// read, or one it cannot promise will still mean this tomorrow.
struct RejectedIgnore {
    line: u32,
    col: u32,
    end_col: u32,
    /// Already worded for the reader — by the same parser the config uses, when
    /// the codes are what is wrong.
    reason: String,
}

/// A `# hadolint ignore=` comment, kept in case this run has to say it is inert.
///
/// Collected always and reported only when hadolint is off, because whether it
/// is off is a fact about the run rather than about the file — the same
/// Dockerfile is correctly annotated for one project and stale for the next.
struct HadolintIgnore {
    line: u32,
    col: u32,
    end_col: u32,
    codes: Vec<String>,
}

/// Languages whose formatter moves a trailing comment onto a line of its own.
///
/// Dockerfile alone, and this list is the reason it is named rather than
/// guessed at: `poly fmt` rewrites
///
///   FROM ubuntu  # poly: ignore poly/docker-untagged-base
///
/// into the comment and the instruction on separate lines, which under the
/// line-above rule makes the suppression govern the *next* instruction. The
/// YAML, Python, Lua and TOML formatters all leave a trailing comment where it
/// is, so nothing else belongs here -- adding a language without checking its
/// formatter would turn correct advice into wrong advice.
fn relocates_trailing_comments(lang: &str) -> bool {
    lang == "dockerfile"
}

/// The `# poly: ignore <tool/rule>, …` comments in one file.
///
/// The line-level neighbour of `[lint.per-file-ignores]`, and the same
/// vocabulary: the codes are what the terminal prints, so silencing a finding
/// is copying `[ruff/F401]` out of the output into either a comment or the
/// config. `per-file-ignores` has no line dimension -- two `RUN apt-get` lines
/// where only one is excusable cannot be written there at all -- and a whole
/// file dropped to excuse one line is how a suppression stops being reviewable.
///
/// Applies to every finding poly reports, not only the rules poly wrote:
/// filtering happens after collection, so a downloaded tool's code and an
/// embedded engine's are silenced by the same comment. Each tool's own syntax
/// (`# noqa`, `# hadolint ignore=`, `# shellcheck disable=`) keeps working
/// untouched; this is the one that covers all of them at once.
///
/// Deliberately not a parse. A comment introducer inside a string literal is
/// accepted as a comment, and living with that false accept costs one wrong
/// suppression in a file somebody wrote on purpose, while avoiding it costs a
/// parser for every language poly reports on.
pub struct InlineIgnores {
    entries: Vec<InlineEntry>,
    rejected: Vec<RejectedIgnore>,
    hadolint: Vec<HadolintIgnore>,
}

impl InlineIgnores {
    pub fn empty() -> InlineIgnores {
        InlineIgnores {
            entries: Vec::new(),
            rejected: Vec::new(),
            hadolint: Vec::new(),
        }
    }

    /// Read `text` as `lang` and collect what it suppresses.
    ///
    /// A comment covers the line it sits on. When it is alone on its line it
    /// covers the line below as well, which is the only other placement worth
    /// having: a line long enough to need a suppression often has no room for a
    /// trailing comment, and one continued over several lines cannot carry one
    /// at all. A trailing comment stops at its own line, so the suppression
    /// cannot leak onto the next statement -- the difference between the two
    /// forms is whether anything precedes the comment on that line.
    ///
    /// The exception is a language whose formatter relocates trailing comments,
    /// where the trailing form is reported and does nothing. See
    /// `relocates_trailing_comments`.
    pub fn scan(lang: Option<&str>, text: &str) -> InlineIgnores {
        let prefixes = lang.map_or(&[][..], comment_prefixes);
        if prefixes.is_empty() {
            return InlineIgnores::empty();
        }
        let relocated = lang.is_some_and(relocates_trailing_comments);
        let mut found = InlineIgnores::empty();
        for (number, line) in text.lines().enumerate() {
            let number = number as u32;
            let column = |byte: usize| line[..byte].chars().count() as u32;
            // hadolint's own syntax, recorded rather than obeyed. See
            // `hadolint_migration_issues`.
            if lang == Some("dockerfile") {
                if let Some((at, codes_at)) = find_hadolint_ignore(line) {
                    found.hadolint.push(HadolintIgnore {
                        line: number,
                        col: column(at),
                        end_col: column(line.len()),
                        codes: line[codes_at..]
                            .split_whitespace()
                            .next()
                            .unwrap_or("")
                            .split(',')
                            .map(str::trim)
                            .filter(|code| !code.is_empty())
                            .map(str::to_string)
                            .collect(),
                    });
                }
            }
            let Some((at, codes_at)) = find_inline_marker(line, prefixes) else {
                continue;
            };
            let mut codes = Vec::new();
            let mut named_anything = false;
            let mut cursor = codes_at;
            for token in line[codes_at..].split(',') {
                let start = cursor + (token.len() - token.trim_start().len());
                cursor += token.len() + 1; // the comma the split removed
                let token = token.trim();
                if token.is_empty() {
                    continue;
                }
                named_anything = true;
                match Suppression::parse_code(token) {
                    Ok(code) => codes.push(code),
                    Err(reason) => found.rejected.push(RejectedIgnore {
                        line: number,
                        col: column(start),
                        end_col: column(start + token.len()),
                        reason,
                    }),
                }
            }
            if !named_anything {
                found.rejected.push(RejectedIgnore {
                    line: number,
                    col: column(at),
                    end_col: column(line.len()),
                    reason: format!(
                        "`{INLINE_MARKER}` with no rule code silences nothing — name the rules the \
                         way poly prints them, `tool/rule` (e.g. \"ruff/F401\") or `tool/*`"
                    ),
                });
            }
            let standalone = line[..at].trim().is_empty();
            // Reported rather than honoured, and the reasoning is the one poly
            // applies to a code it cannot read: it silences nothing now, so it
            // cannot later silence something else. Honouring it until the next
            // `poly fmt` would mean the same comment governs one instruction
            // today and its neighbour tomorrow, and the day it moves is the day
            // the warning saying so disappears. A Dockerfile suppression goes
            // above the line -- which is where `# hadolint ignore=` already
            // goes, so it is the placement the language's readers expect.
            if relocated && !standalone {
                found.rejected.push(RejectedIgnore {
                    line: number,
                    col: column(at),
                    end_col: column(line.len()),
                    reason: format!(
                        "a trailing `{INLINE_MARKER}` silences nothing in a Dockerfile — `poly \
                         fmt` moves a trailing comment onto a line of its own, where it would \
                         cover the next instruction instead. Write it on the line above."
                    ),
                });
                continue;
            }
            if !codes.is_empty() {
                found.entries.push(InlineEntry {
                    first: number,
                    last: number + u32::from(standalone),
                    codes,
                });
            }
        }
        found
    }

    /// Is this finding silenced by a comment in the file it was found in?
    ///
    /// Takes what the terminal prints as `[source/code]`, like
    /// `Config::lint_ignored`, and is called from the same two places for the
    /// same reason: a suppression only one of the CLI and the daemon honours is
    /// the editor/CI split A4 exists to prevent.
    pub fn suppresses(&self, line: u32, source: &str, code: &str) -> bool {
        self.entries.iter().any(|entry| {
            (entry.first..=entry.last).contains(&line)
                && entry.codes.iter().any(|c| c.matches(source, code))
        })
    }

    /// Findings for the comments poly declined to act on.
    ///
    /// Reported rather than fatal, which is the one place this parts company
    /// with the config: a malformed entry in poly.toml stops the run because
    /// nothing else would reveal it, and a malformed comment cannot abort a
    /// whole repo's check over one line in one file. It silences nothing
    /// either way, so the finding it was aimed at is still printed next to this
    /// one.
    pub fn syntax_issues(&self, hadolint_off: bool) -> Vec<crate::diag::Issue> {
        let reported = |line: u32, col: u32, end_col: u32, message: String| crate::diag::Issue {
            line,
            col,
            end_line: line,
            end_col,
            severity: crate::diag::Severity::Warning,
            code: INLINE_RULES[0].0.to_string(),
            message,
            // poly's own rule about a comment poly will not act on. See
            // `INLINE_RULES`.
            source: "poly",
            fix: None,
            url: None,
        };
        let mut found: Vec<crate::diag::Issue> = self
            .rejected
            .iter()
            .map(|bad| reported(bad.line, bad.col, bad.end_col, bad.reason.clone()))
            .collect();
        if hadolint_off {
            found.extend(self.hadolint.iter().map(|stale| {
                reported(
                    stale.line,
                    stale.col,
                    stale.end_col,
                    hadolint_migration_message(&stale.codes),
                )
            }));
        }
        found.sort_by_key(|issue| (issue.line, issue.col));
        found
    }
}

/// What to tell the author of a `# hadolint ignore=` that no longer does
/// anything.
///
/// The comment was written to silence a real finding, and with hadolint off it
/// silences nothing — which is the same failure `poly/ignore-syntax` already
/// exists to report, so it is reported as the same rule. What poly does *not*
/// do is honour it: the codes below name poly's replacement so the comment can
/// be rewritten and deleted, rather than being kept working forever behind a
/// second syntax.
fn hadolint_migration_message(codes: &[String]) -> String {
    let replacements: Vec<String> = codes
        .iter()
        .filter_map(|code| {
            // hadolint runs shellcheck over every `RUN`, so half of what a
            // `# hadolint ignore=` silences in the wild is an SC code. poly
            // reports those itself now, from its own shellcheck seam and under
            // shellcheck's own name -- so the suppression has a home, and
            // telling the author to delete it would throw away a finding they
            // had already looked at.
            if let Some(number) = code.strip_prefix("SC") {
                if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) {
                    return Some(format!("shellcheck/{code}"));
                }
            }
            HADOLINT_REPLACEMENTS
                .iter()
                .find(|(hadolint, _)| hadolint == code)
                .map(|(_, poly)| format!("poly/{poly}"))
        })
        .collect();
    let named = codes.join(", ");
    let turn_on = "or set `hadolint = \"on\"` under `[tools]` to keep running it";
    if replacements.is_empty() {
        return format!(
            "`hadolint ignore={named}` silences nothing — poly does not run hadolint by \
             default, and has no rule of its own for it. Delete the comment, {turn_on}."
        );
    }
    let write = replacements.join(", ");
    let rest = if replacements.len() == codes.len() {
        String::new()
    } else {
        format!(
            " (poly has no rule of its own for the other {})",
            codes.len() - replacements.len()
        )
    };
    format!(
        "`hadolint ignore={named}` silences nothing — poly does not run hadolint by default. \
         Write `# {INLINE_MARKER} {write}` instead{rest}, {turn_on}."
    )
}

/// The `# hadolint ignore=` on this line: where the comment starts, and where
/// the codes begin after it.
///
/// hadolint's own placement rule is that the comment sits on its own line above
/// the instruction, so a trailing one is not looked for — and `poly fmt` would
/// move it anyway, which is the reasoning `relocates_trailing_comments` already
/// records.
fn find_hadolint_ignore(line: &str) -> Option<(usize, usize)> {
    let at = line.find('#')?;
    if !line[..at].trim().is_empty() {
        return None;
    }
    let rest = line[at + 1..].trim_start_matches('#').trim_start();
    let codes = rest.strip_prefix("hadolint")?.trim_start();
    let codes = codes.strip_prefix("ignore")?.trim_start();
    let codes = codes.strip_prefix('=')?;
    Some((at, line.len() - codes.len()))
}

/// The first `<comment> poly: ignore` on this line: where the comment starts,
/// and where the rule codes begin after it.
fn find_inline_marker(line: &str, prefixes: &[&str]) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    for prefix in prefixes {
        for (at, _) in line.match_indices(prefix) {
            let after = &line[at + prefix.len()..];
            // `##`, `///`, `-----`: the introducer repeated is still one comment.
            let after = match prefix.chars().next() {
                Some(c) => after.trim_start_matches(c),
                None => after,
            };
            let Some(rest) = after.trim_start().strip_prefix(INLINE_MARKER) else {
                continue;
            };
            // `poly: ignored the docs` is prose that starts the same way.
            if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
                continue;
            }
            if best.is_none_or(|(previous, _)| at < previous) {
                best = Some((at, line.len() - rest.len()));
            }
            break;
        }
    }
    best
}

/// Reads each file's inline suppressions once, for callers holding findings
/// rather than buffers.
///
/// The sibling of `ConfigCache`, and memoized for the same reason: a batch run
/// filters thousands of findings and several of them land in one file, so the
/// alternative is re-reading that file once per finding.
#[derive(Default)]
pub struct InlineCache {
    by_file: HashMap<PathBuf, Arc<InlineIgnores>>,
}

impl InlineCache {
    pub fn new() -> InlineCache {
        InlineCache::default()
    }

    /// What `path` suppresses inline. `config` answers what language it is, so
    /// a `[languages.map]` entry decides the comment syntax too.
    ///
    /// A file that cannot be read yields nothing: whatever produced a finding
    /// for it has already read it, and failing here would turn a deleted file
    /// into an error about suppressions.
    pub fn for_file(&mut self, path: &Path, config: &Config) -> Arc<InlineIgnores> {
        if let Some(hit) = self.by_file.get(path) {
            return Arc::clone(hit);
        }
        let lang = config.language(path);
        let scanned = Arc::new(
            match lang.filter(|lang| !comment_prefixes(lang).is_empty()) {
                // Read only for a language that could carry one: a walk covers
                // every file in the repo, images included.
                Some(lang) => std::fs::read_to_string(path)
                    .map(|text| InlineIgnores::scan(Some(&lang), &text))
                    .unwrap_or_else(|_| InlineIgnores::empty()),
                None => InlineIgnores::empty(),
            },
        );
        self.by_file
            .insert(path.to_path_buf(), Arc::clone(&scanned));
        scanned
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

    /// The languages `[format.<lang>]` tables were written for.
    ///
    /// Exposed so the caller that owns the language table can say whether each
    /// one is a language at all. poly-core cannot ask that question itself: an
    /// id it does not detect may still be one an engine formats, and the two
    /// lists live in different crates.
    pub fn format_languages(&self) -> impl Iterator<Item = &str> {
        self.format_options.keys().map(String::as_str)
    }

    /// `[languages.map]` as written: glob, then the language id it maps to.
    pub fn language_map(&self) -> impl Iterator<Item = (&str, &str)> {
        self.map
            .iter()
            .map(|(matcher, lang)| (matcher.glob().glob(), lang.as_str()))
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

/// Nearest `name` at or above `start`'s directory.
///
/// How poly finds another tool's config file — buf.yaml, selene.toml. Both
/// tools resolve their own against a working directory, which for the daemon
/// is wherever the editor happened to launch poly from; anchoring on the file
/// instead is what keeps the editor and CI reading the same config (A4).
pub fn nearest_ancestor_file(start: &Path, name: &str) -> Option<PathBuf> {
    let start = std::path::absolute(start).unwrap_or_else(|_| start.to_path_buf());
    let mut dir = if start.is_dir() {
        start.as_path()
    } else {
        start.parent()?
    };
    loop {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = dir.parent()?;
    }
}

/// Is `path` a GitHub Actions workflow?
///
/// Exactly `.github/workflows/<name>.yml`, and nothing nested below that: GitHub
/// reads that one directory and does not descend, so a file in
/// `.github/workflows/templates/` is a fragment somebody keeps there, not a
/// workflow. Extension and both directory names, in that order.
///
/// Here rather than beside any one caller because there are three, and until
/// this existed two of them disagreed: `poly check` compared the path components
/// while the daemon matched the substring `.github/workflows/`, so a file one
/// directory deeper was linted in the editor and not in CI. That is the split
/// A4 exists to prevent, and it is the same reason `nearest_ancestor_file` lives
/// here.
pub fn is_workflow_file(path: &Path) -> bool {
    let extension = path.extension().and_then(|e| e.to_str());
    if !matches!(extension, Some("yml" | "yaml")) {
        return false;
    }
    let mut ancestors = path.components().rev();
    ancestors.next();
    ancestors
        .next()
        .is_some_and(|c| c.as_os_str() == "workflows")
        && ancestors.next().is_some_and(|c| c.as_os_str() == ".github")
}

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

    /// One answer for "is this a workflow", because there used to be two.
    ///
    /// `poly check` compared the path components and the daemon matched the
    /// substring `.github/workflows/`, so a file one directory deeper was linted
    /// in the editor and not in CI -- the editor/CI split A4 exists to prevent.
    /// The components version is the one that survived: GitHub reads that
    /// directory and does not descend, so a file under `workflows/templates/` is
    /// a fragment somebody keeps there rather than something that ever runs.
    #[test]
    fn a_workflow_is_the_directory_github_actually_reads() {
        for yes in [
            ".github/workflows/ci.yml",
            ".github/workflows/release.yaml",
            "/abs/path/.github/workflows/ci.yml",
        ] {
            assert!(is_workflow_file(Path::new(yes)), "{yes}");
        }
        for no in [
            // The case the two implementations disagreed on.
            ".github/workflows/templates/base.yml",
            ".github/actions/setup/action.yml",
            ".github/dependabot.yml",
            "workflows/ci.yml",
            "k8s/deployment.yaml",
            ".github/workflows/notes.md",
            ".github/workflows",
        ] {
            assert!(!is_workflow_file(Path::new(no)), "{no}");
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

    /// The syntax is the config's, and the only difference is where it is
    /// written: a comment sits next to the code it excuses, so the reason and
    /// the suppression are reviewed together.
    #[test]
    fn an_inline_comment_silences_the_line_it_is_on() {
        let scan = |text: &str| InlineIgnores::scan(Some("python"), text);

        // Trailing: its own line only. The next line is a different statement
        // and a suppression that reaches it is one nobody wrote.
        let found = scan("import os  # poly: ignore ruff/F401\nimport sys\n");
        assert!(found.suppresses(0, "ruff", "F401"));
        assert!(!found.suppresses(1, "ruff", "F401"));
        // Only the rule named, and only from the tool named.
        assert!(!found.suppresses(0, "ruff", "E501"));
        assert!(!found.suppresses(0, "typos", "F401"));

        // On a line of its own: the line below, which is the line it annotates,
        // plus its own -- a long line has no room for a trailing comment and a
        // continued one has nowhere to put it at all.
        let found = scan("# poly: ignore ruff/F401\nimport os\nimport sys\n");
        assert!(found.suppresses(1, "ruff", "F401"));
        assert!(!found.suppresses(2, "ruff", "F401"));

        // Two lines away is not reviewable, so it does not reach.
        let found = scan("# poly: ignore ruff/F401\n\nimport os\n");
        assert!(!found.suppresses(2, "ruff", "F401"));

        // Several codes in one comment, and `tool/*` for a whole tool.
        let found = scan("x = 1  # poly: ignore ruff/F401, typos/typo\n# poly: ignore ruff/*\ny\n");
        assert!(found.suppresses(0, "ruff", "F401"));
        assert!(found.suppresses(0, "typos", "typo"));
        assert!(found.suppresses(2, "ruff", "ANYTHING"));
        assert!(!found.suppresses(2, "typos", "typo"));

        // Nothing to say about a file with no such comment.
        assert!(!scan("import os\n").suppresses(0, "ruff", "F401"));
    }

    /// Every finding poly reports, not only the rules poly wrote. Filtering
    /// happens after collection, so the comment cannot tell a downloaded tool's
    /// code from an embedded engine's -- which is the point: poly is one
    /// surface over many tools, and a suppression covering only poly's own
    /// rules would be the opposite.
    #[test]
    fn an_inline_comment_covers_any_tools_code() {
        let found = InlineIgnores::scan(
            Some("dockerfile"),
            "# poly: ignore hadolint/DL3008, poly/docker-apt-get-unpinned\nRUN apt-get install x\n",
        );
        assert!(found.suppresses(1, "hadolint", "DL3008"));
        assert!(found.suppresses(1, "poly", "docker-apt-get-unpinned"));
    }

    /// Comment syntax is per language, and a language poly has no introducer
    /// for gets nothing at all rather than a guess -- `[lint.per-file-ignores]`
    /// still covers it, and the finding continuing to appear says so.
    #[test]
    fn inline_comments_follow_the_languages_own_syntax() {
        let cases = [
            ("python", "x = 1  # poly: ignore ruff/F401", true),
            ("shellscript", "x=1 ## poly: ignore shellcheck/SC2086", true),
            ("yaml", "a: 1 # poly: ignore actionlint/syntax-check", true),
            (
                "rust",
                "let x = 1; // poly: ignore clippy/needless_return",
                true,
            ),
            (
                "typescript",
                "const x = 1; /// poly: ignore eslint/no-var",
                true,
            ),
            ("sql", "select a -- poly: ignore sqruff/LT01", true),
            (
                "lua",
                "local x -- poly: ignore selene/unused_variable",
                true,
            ),
            // The false accept this design takes on purpose, landing on the
            // file that documents it: `//` inside a Rust string is not a
            // comment, and poly does not parse Rust to find that out. What the
            // scan then reads as a second code is the row's own `, true)`.
            // poly: ignore poly/ignore-syntax
            ("terraform", "x = 1 // poly: ignore tflint/rule", true),
            // The introducer is the language's, so python's `#` is not rust's.
            (
                "rust",
                "let x = 1; # poly: ignore clippy/needless_return",
                false,
            ),
            // poly: ignore poly/ignore-syntax
            ("python", "x = 1  // poly: ignore ruff/F401", false),
            // Markdown, HTML and friends have no line comment poly reads.
            ("markdown", "text <!-- poly: ignore typos/typo -->", false),
            ("css", "a {} /* poly: ignore typos/typo */", false),
        ];
        for (lang, line, expected) in cases {
            let found = InlineIgnores::scan(Some(lang), line);
            let (source, code) = {
                let tail = line.split("poly: ignore ").nth(1).unwrap();
                let code = tail.split_whitespace().next().unwrap();
                code.split_once('/').unwrap()
            };
            assert_eq!(
                found.suppresses(0, source, code),
                expected,
                "{lang}: {line:?}"
            );
        }

        // A file poly cannot name a language for is the same case as a language
        // with no comment syntax.
        assert!(!InlineIgnores::scan(None, "# poly: ignore typos/typo\nx\n")
            .suppresses(1, "typos", "typo"));
    }

    /// The comment-prefix table is keyed by the ids `EXTENSIONS` produces, and
    /// this is what keeps it from becoming a second file-type table that drifts
    /// -- the way `nearest_ancestor_file` once had two implementations. A new
    /// language has to be named in one list or the other.
    #[test]
    fn inline_suppression_covers_every_language() {
        // Left out for a reason, not by omission: the first four are markup
        // whose comments are block-delimited (`<!-- -->`, `/* */`, `{# #}`),
        // which is not one of the three families this reads, and .ipynb is JSON
        // around the source -- ruff reports notebook positions that do not
        // index the file's own lines, so a comment placed by line number would
        // land somewhere else entirely.
        const NO_INLINE: &[&str] = &[
            "astro",
            "css",
            "handlebars",
            "html",
            "jinja",
            "jupyter",
            "markdown",
            "svelte",
            "vue",
            "xml",
        ];
        for lang in builtin_languages() {
            let has = !comment_prefixes(lang).is_empty();
            assert_eq!(
                has,
                !NO_INLINE.contains(&lang),
                "{lang}: a new language needs a comment prefix here or a place in NO_INLINE"
            );
        }
        // And nothing in the table for a language that no longer exists.
        for (lang, _) in COMMENT_PREFIXES {
            assert!(builtin_languages().contains(lang), "{lang}");
        }
    }

    /// A code poly cannot read is reported instead of aborting the run: it is
    /// one comment in one file, the finding it aimed at is still printed, and a
    /// repo-wide check that stops for it would be a worse trade than the config
    /// makes -- there, nothing else would reveal the mistake.
    #[test]
    fn a_malformed_inline_code_is_reported_not_fatal() {
        let found = InlineIgnores::scan(Some("python"), "import os  # poly: ignore F401\n");
        let issues = found.syntax_issues(false);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].source, "poly");
        assert_eq!(issues[0].code, "ignore-syntax");
        assert!(issues[0].message.contains("F401"), "{:?}", issues[0]);
        // The same sentence the config gives for the same mistake.
        assert!(issues[0].message.contains("tool/rule"), "{:?}", issues[0]);
        // Pointed at the code itself, not at the line.
        assert_eq!(issues[0].line, 0);
        assert_eq!((issues[0].col, issues[0].end_col), (26, 30));
        assert!(!found.suppresses(0, "ruff", "F401"));

        // The good codes in a comment still work; only the bad one is reported.
        let found = InlineIgnores::scan(Some("python"), "x  # poly: ignore ruff/F401, E501\n");
        assert!(found.suppresses(0, "ruff", "F401"));
        assert_eq!(found.syntax_issues(false).len(), 1);

        // No code at all silences nothing and reads like it does.
        let found = InlineIgnores::scan(Some("python"), "# poly: ignore\nimport os\n");
        assert_eq!(found.syntax_issues(false).len(), 1);
        assert!(found.syntax_issues(false)[0]
            .message
            .contains("no rule code"));

        // An unknown tool or rule is left alone: poly cannot know every code
        // its tools will grow, and the finding it was aimed at keeps appearing.
        let found = InlineIgnores::scan(Some("python"), "x  # poly: ignore ruff/NOSUCHRULE\n");
        assert!(found.syntax_issues(false).is_empty());
    }

    /// In a Dockerfile the trailing form is reported and does nothing, because
    /// poly's own Dockerfile formatter moves a trailing comment onto a line of
    /// its own -- where the line-above rule would make it cover the *next*
    /// instruction. `a_trailing_dockerfile_suppression_would_move` in
    /// `tests/check.rs` pins that formatter behaviour, so this rule cannot
    /// quietly become wrong advice.
    ///
    /// Silencing nothing is the point rather than a shortfall: a suppression
    /// that works today and governs its neighbour after the next `poly fmt` is
    /// the editor/CI-shaped failure where the two answers are the same tool at
    /// two moments, and nothing in the second run says what changed.
    #[test]
    fn a_dockerfile_suppression_belongs_above_the_line() {
        let trailing = InlineIgnores::scan(
            Some("dockerfile"),
            "FROM ubuntu  # poly: ignore poly/docker-untagged-base\nRUN make\n",
        );
        assert!(!trailing.suppresses(0, "poly", "docker-untagged-base"));
        let issues = trailing.syntax_issues(false);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, "ignore-syntax");
        assert!(issues[0].message.contains("poly fmt"), "{:?}", issues[0]);
        assert!(issues[0].message.contains("line above"), "{:?}", issues[0]);

        // The placement poly asks for, which is also where `# hadolint ignore=`
        // goes: honoured, and nothing to report.
        let above = InlineIgnores::scan(
            Some("dockerfile"),
            "# poly: ignore poly/docker-untagged-base\nFROM ubuntu\n",
        );
        assert!(above.suppresses(1, "poly", "docker-untagged-base"));
        assert!(above.syntax_issues(false).is_empty());

        // Every other formatter poly ships leaves a trailing comment where it
        // is, so the rule stops at Dockerfile.
        for lang in ["python", "yaml", "toml", "lua"] {
            assert!(!relocates_trailing_comments(lang), "{lang}");
        }
        let python = InlineIgnores::scan(Some("python"), "import os  # poly: ignore ruff/F401\n");
        assert!(python.suppresses(0, "ruff", "F401"));
        assert!(python.syntax_issues(false).is_empty());
    }

    /// With hadolint off, a `# hadolint ignore=` silences nothing -- and poly
    /// says what to write instead rather than quietly dropping a suppression
    /// its author meant.
    ///
    /// The gate is the whole point. Someone who set `hadolint = "on"` has a
    /// comment that works, and telling them to rewrite it would be poly nagging
    /// about a tool it is running. The two halves of this test are the same
    /// file read under the two settings.
    #[test]
    fn a_hadolint_suppression_is_named_only_when_hadolint_is_off() {
        let found = InlineIgnores::scan(
            Some("dockerfile"),
            "# hadolint ignore=DL3008\nRUN apt-get install -y curl\n",
        );
        // Never honoured, either way: poly does not read hadolint's syntax.
        // Reporting it is not a step towards doing so.
        assert!(!found.suppresses(1, "poly", "docker-apt-get-unpinned"));
        assert!(!found.suppresses(1, "hadolint", "DL3008"));

        assert!(found.syntax_issues(false).is_empty(), "hadolint is running");

        let issues = found.syntax_issues(true);
        assert_eq!(issues.len(), 1);
        // The same rule as every other comment poly will not act on.
        assert_eq!(issues[0].code, "ignore-syntax");
        assert_eq!(issues[0].source, "poly");
        assert_eq!(issues[0].line, 0);
        // Names the replacement, so the fix is a paste rather than a lookup.
        assert!(
            issues[0]
                .message
                .contains("poly: ignore poly/docker-apt-get-unpinned"),
            "{:?}",
            issues[0]
        );
        // And the way back, for whoever wanted hadolint after all.
        assert!(issues[0].message.contains("\"on\""), "{:?}", issues[0]);

        // Several codes in one comment become one replacement line.
        let many = InlineIgnores::scan(
            Some("dockerfile"),
            "# hadolint ignore=DL3006,DL3008\nFROM ubuntu\n",
        )
        .syntax_issues(true);
        assert_eq!(many.len(), 1);
        assert!(
            many[0]
                .message
                .contains("poly/docker-untagged-base, poly/docker-apt-get-unpinned"),
            "{:?}",
            many[0]
        );

        // An SC code is hadolint's shellcheck half, and poly runs shellcheck
        // over Dockerfile `RUN` bodies itself -- so the suppression has a real
        // home, and "delete it" would throw away a finding somebody had already
        // looked at. Half the `# hadolint ignore=` comments on the corpus are
        // this shape.
        let shell = InlineIgnores::scan(
            Some("dockerfile"),
            "# hadolint ignore=SC2086\nRUN echo $x\n",
        )
        .syntax_issues(true);
        assert_eq!(shell.len(), 1);
        assert!(
            shell[0].message.contains("poly: ignore shellcheck/SC2086"),
            "{:?}",
            shell[0]
        );

        // A code poly declined to implement gets the honest answer rather than
        // a guess: DL3059 is in the residual gap on purpose.
        let unknown =
            InlineIgnores::scan(Some("dockerfile"), "# hadolint ignore=DL3059\nRUN make\n")
                .syntax_issues(true);
        assert_eq!(unknown.len(), 1);
        assert!(
            unknown[0].message.contains("no rule of its own"),
            "{:?}",
            unknown[0]
        );

        // Not a Dockerfile, not this rule -- `# hadolint ignore=` in a shell
        // script is a comment about nothing and poly has no business reading
        // it.
        assert!(
            InlineIgnores::scan(Some("shellscript"), "# hadolint ignore=DL3008\n")
                .syntax_issues(true)
                .is_empty()
        );
        // Trailing, where hadolint itself would not read it either.
        assert!(
            InlineIgnores::scan(Some("dockerfile"), "FROM ubuntu # hadolint ignore=DL3006\n")
                .syntax_issues(true)
                .is_empty()
        );
    }

    /// The marker is a comment poly reads, not a word it greps for.
    #[test]
    fn only_a_real_ignore_comment_counts() {
        let scan = |text: &str| InlineIgnores::scan(Some("python"), text);

        // Prose that starts the same way is prose.
        assert!(scan("x  # poly: ignored ruff/F401\n")
            .syntax_issues(false)
            .is_empty());
        assert!(!scan("x  # poly: ignored ruff/F401\n").suppresses(0, "ruff", "F401"));
        // No introducer at all: this is code, not a comment.
        assert!(!scan("poly: ignore ruff/F401\n").suppresses(0, "ruff", "F401"));
    }

    #[test]
    fn inline_cache_reads_each_file_once_and_survives_a_missing_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("a.py"), "import os  # poly: ignore ruff/F401\n").unwrap();
        // A `[languages.map]` entry decides the comment syntax too: the
        // language poly thinks a file is has to be the same answer everywhere.
        std::fs::write(
            root.join("poly.toml"),
            "[languages.map]\n\"*.tpl\" = \"python\"\n",
        )
        .unwrap();
        std::fs::write(root.join("b.tpl"), "x  # poly: ignore typos/typo\n").unwrap();
        let config = Config::discover(root).unwrap();

        let mut cache = InlineCache::new();
        assert!(cache
            .for_file(&root.join("a.py"), &config)
            .suppresses(0, "ruff", "F401"));
        assert!(cache
            .for_file(&root.join("b.tpl"), &config)
            .suppresses(0, "typos", "typo"));
        // A file the walk found and something deleted since is not an error.
        assert!(!cache
            .for_file(&root.join("gone.py"), &config)
            .suppresses(0, "ruff", "F401"));
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

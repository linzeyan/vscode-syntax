//! Shared lint issue type: embedded engines (sqruff) and external tools
//! (shellcheck, hadolint, ...) both produce these; the CLI and the LSP
//! daemon render them.

/// Ordered most severe first, and `Ord` follows that order: `Error < Hint`
/// reads backwards, so comparisons go through `at_least` rather than `<=`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Error,
    Warning,
    Info,
    Hint,
}

impl Severity {
    /// Is this at least as severe as `floor`?
    pub fn at_least(self, floor: Severity) -> bool {
        self <= floor
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Info => "info",
            Severity::Hint => "hint",
        }
    }
}

/// What the tool that found something called it, in the one vocabulary poly
/// translates from.
///
/// Each parser turns its own tool's spelling into this -- eslint's `2`, biome's
/// `"fatal"`, shellcheck's `"style"` -- because reading one tool's JSON is that
/// parser's job. What the word then *means* is not that parser's business, and
/// `severity_of` is where it is decided, so "is this fatal under `--fail-on
/// error`" cannot depend on which linter happened to find it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reported {
    Error,
    Warning,
    Info,
    /// Below info: shellcheck's `style`, and anything a tool ranks under its
    /// own informational tier.
    Style,
    /// The tool said nothing about how bad this is. Most say nothing at all.
    Nothing,
}

/// How much of its own severity a source is taken at its word for.
enum Policy {
    /// Its levels already mean what poly's mean, so they pass through.
    ItsOwn,
    /// It ranks nothing, so poly ranks all of it, once, here.
    Poly(Severity),
    /// poly's own rules, where the level is a property of the rule and lives
    /// beside it -- `lint::DOCKER_RULES`, `workflow::RULES`, `proto::RULES`,
    /// `INLINE_RULES`, all four read by `lint::rule_severity`. That is the
    /// function to call for a `poly` finding; this row exists so the list below
    /// covers every source poly reports under, not as an answer.
    PerRule,
}

/// Every source poly reports under, and what its severity means here.
///
/// The judgement is not what the tool called it but what the finding means, on
/// four levels that have to hold across every language poly checks:
///
/// - **error**: almost certainly a defect. It breaks, it is unsafe, or it is
///   invalid.
/// - **warning**: suspicious, and possibly deliberate. Somebody should look.
/// - **info**: style and consistency. Correctness is not in question.
/// - **hint**: a preference.
///
/// A row per source rather than a `match` per parser, because the rows are only
/// worth anything next to each other: shellcheck's `style` and biome's
/// `information` are the same claim, and a tool that ranks nothing is making no
/// claim at all -- which is a decision poly has to make on its behalf, in the
/// open, rather than by whatever literal the parser next door happened to use.
/// `every_source_states_its_policy` holds this list and the code to the same
/// set, so a new tool cannot arrive without one.
const POLICY: &[(&str, Policy)] = &[
    // These four rank their own findings on scales that already mean this.
    // hadolint reports shellcheck's, in shellcheck's words.
    ("shellcheck", Policy::ItsOwn),
    ("hadolint", Policy::ItsOwn),
    ("swiftlint", Policy::ItsOwn),
    ("clippy", Policy::ItsOwn),
    // biome and eslint likewise, once their spellings are normalized: biome's
    // `fatal`/`information` and eslint's 2/1.
    ("biome", Policy::ItsOwn),
    ("eslint", Policy::ItsOwn),
    // tflint's third level is `notice`, which is style: it reads as info here
    // rather than as the warning everything-but-error used to collapse to.
    ("tflint", Policy::ItsOwn),
    // selene ranks its lints, and a Lua file it cannot parse is reported at
    // error by poly -- the tool did say the file is not Lua.
    ("selene", Policy::ItsOwn),
    // actionlint ranks nothing, and everything it reports now is a validity
    // problem: a workflow that fails its schema, id, event, permission or
    // expression checks fails at run time. Its shellcheck pass is off (poly
    // runs shellcheck itself, at the offending word), which is what makes this
    // constant true; the pyflakes pass is the one remaining finding that is a
    // lint rather than a validity error, and it is rare enough to live with.
    ("actionlint", Policy::Poly(Severity::Error)),
    // golangci-lint ranks nothing. Its default set is govet, staticcheck and
    // friends: things worth a look that are sometimes deliberate.
    ("golangci-lint", Policy::Poly(Severity::Warning)),
    // Neither does ruff, whose default set is the same shape. A rule-level
    // answer -- F821 is a defect, E501 is style -- is what the catalog is for.
    ("ruff", Policy::Poly(Severity::Warning)),
    // sqruff ranks nothing either. Most of its rules are layout, but a `poly
    // check` that called SQL findings info would make them invisible under the
    // default fail-on, and this is the level SQL has always been reported at.
    ("sqruff", Policy::Poly(Severity::Warning)),
    // A misspelling is not a correctness claim, which is exactly info -- and
    // why `--fail-on warning` is the setting a repo with prose adopts first.
    ("typos", Policy::Poly(Severity::Info)),
    // `poly deadcode`'s three. "Nothing calls this" is the definition of
    // suspicious-but-possibly-deliberate: the caller may be a test, another
    // module, or somebody else's repository.
    ("deadcode", Policy::Poly(Severity::Warning)),
    ("knip", Policy::Poly(Severity::Warning)),
    ("vulture", Policy::Poly(Severity::Warning)),
    // A file that does not parse is invalid, and that is the only thing poly
    // reports about TOML.
    ("toml", Policy::Poly(Severity::Error)),
    ("poly", Policy::PerRule),
];

/// Does this source rank its own findings?
///
/// Asked by the gate over `catalog.toml`: a category's severity can only be
/// held to one value where poly is the one deciding it. A source with its own
/// scale answers per finding, at run time, and there is nothing to compare
/// until it does.
pub fn ranks_its_own(source: &str) -> bool {
    matches!(
        POLICY.iter().find(|(name, _)| *name == source),
        Some((_, Policy::ItsOwn))
    )
}

/// poly's opinion of one finding, from what the tool said about it.
///
/// An unknown source is ranked warning rather than dropped or panicked over: a
/// finding poly cannot classify is still a finding, and
/// `every_source_states_its_policy` is what keeps this branch unreachable.
pub fn severity_of(source: &str, reported: Reported) -> Severity {
    match POLICY.iter().find(|(name, _)| *name == source) {
        Some((_, Policy::Poly(severity))) => *severity,
        Some((_, Policy::PerRule)) | None => Severity::Warning,
        Some((_, Policy::ItsOwn)) => match reported {
            Reported::Error => Severity::Error,
            // A tool with levels that did not use one here. Nothing to take at
            // its word, so this is the same default the sources without any get.
            Reported::Warning | Reported::Nothing => Severity::Warning,
            Reported::Info => Severity::Info,
            Reported::Style => Severity::Hint,
        },
    }
}

/// How severe a finding has to be before poly exits non-zero.
///
/// Poly reports four severities and used to fail on all of them, so a repo
/// with one `info` spelling suggestion could not have a green pipeline without
/// excluding the file. This is the knob for that -- not Rust's `-D warnings`,
/// which exists because warnings are *not* fatal there.
///
/// `Never` is deliberately reachable: `poly check` as a report, with the
/// pipeline gated on something else, is a legitimate way to adopt poly on an
/// existing codebase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailOn {
    Severity(Severity),
    Never,
}

impl Default for FailOn {
    /// Every severity fails, which is what poly did before this existed.
    fn default() -> Self {
        FailOn::Severity(Severity::Hint)
    }
}

impl FailOn {
    pub fn fails(self, severity: Severity) -> bool {
        match self {
            FailOn::Severity(floor) => severity.at_least(floor),
            FailOn::Never => false,
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "error" => Ok(FailOn::Severity(Severity::Error)),
            "warning" => Ok(FailOn::Severity(Severity::Warning)),
            "info" => Ok(FailOn::Severity(Severity::Info)),
            "hint" => Ok(FailOn::Severity(Severity::Hint)),
            "never" => Ok(FailOn::Never),
            other => Err(format!(
                "unknown fail-on value {other:?}: expected error, warning, info, hint or never"
            )),
        }
    }
}

#[derive(Debug)]
pub struct Issue {
    /// 0-based, like LSP positions.
    pub line: u32,
    pub col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub severity: Severity,
    pub code: String,
    pub message: String,
    pub source: &'static str,
    /// How to resolve it, when the producing tool says so. Both fields are
    /// `None` far more often than not: most linters report what is wrong and
    /// leave the remedy to their documentation. `None` here means "nobody told
    /// us" — poly never guesses a fix or a link it has not verified.
    pub fix: Option<Fix>,
    /// Rule documentation. Either handed over by the tool (ruff) or derived
    /// from a code whose URL scheme is stable and checked (shellcheck,
    /// hadolint).
    pub url: Option<String>,
}

/// What resolving an issue takes.
#[derive(Debug, Clone, PartialEq)]
pub enum Fix {
    /// The tool spelled out the change, e.g. ruff's "Remove unused import".
    Described { what: String, safe: bool },
    /// The tool can rewrite it but says nothing about what it would do.
    Automatic,
    /// poly's own formatters produce the corrected file.
    Reformat,
}

impl Fix {
    /// The one sentence poly uses to say how to resolve this, wherever it says
    /// it. The terminal and the editor hover have to word it identically or a
    /// reader has to learn two vocabularies for one product; `source` names the
    /// tool because "can rewrite this automatically" is a claim about a
    /// specific fixer, not about poly.
    pub fn describe(&self, source: &str) -> String {
        match self {
            // "unsafe" is ruff's own word for an edit that can change behavior,
            // so it is passed on rather than softened.
            Fix::Described { what, safe: true } => what.clone(),
            Fix::Described { what, safe: false } => format!("{what} (unsafe: review it)"),
            Fix::Automatic => format!("{source} can rewrite this automatically"),
            Fix::Reformat => "run `poly fmt`".to_string(),
        }
    }
}

/// Pull a 1-based line and column out of a formatter error message.
///
/// Seven parsers sit behind `poly fmt`, each with its own error type, and none
/// hands back a machine-readable position through the `anyhow` chain. They use
/// two spellings between them, so both are tried.
/// `every_engine_error_can_be_placed` pins that, so a message that stops
/// matching fails a test instead of quietly landing on line 1.
///
/// Shared rather than duplicated because the CLI and the LSP have to place the
/// same error identically: a squiggle in the editor and a `file:line:col` in CI
/// that disagree are worse than either alone (R5/A4).
pub fn parse_position(message: &str) -> Option<(u32, u32)> {
    prose_position(message).or_else(|| trailing_position(message))
}

/// "line N, column M" (dprint-json, dprint-toml, ruff, pretty_yaml,
/// markup_fmt) or "line N, col M" (pretty_graphql).
fn prose_position(message: &str) -> Option<(u32, u32)> {
    // First line only: pretty_yaml continues into a code frame whose gutter is
    // full of digits. The first match also wins on purpose — markup_fmt names
    // the unclosed tag before the position it gave up at, and the opening tag
    // is the more useful place to point.
    let head = message.lines().next()?.to_ascii_lowercase();
    let after_line = head.split_once("line ")?.1;
    let line = leading_number(after_line)?;
    let after_col = after_line.split_once("col")?.1;
    let after_col = after_col.strip_prefix("umn").unwrap_or(after_col);
    let col = leading_number(after_col.trim_start_matches([' ', ':', ',']))?;
    Some((line, col))
}

/// dprint-typescript names no line in prose; it draws a code frame and closes
/// with "at file:///a.ts:1:22". Scanned from the bottom, because the frame
/// above it also contains colons.
fn trailing_position(message: &str) -> Option<(u32, u32)> {
    message.lines().rev().find_map(|line| {
        let (rest, col) = line.trim_end().rsplit_once(':')?;
        let (_, line_no) = rest.rsplit_once(':')?;
        Some((leading_number(line_no)?, leading_number(col)?))
    })
}

fn leading_number(s: &str) -> Option<u32> {
    let digits: String = s.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every source poly reports under states its policy, and every stated
    /// policy is a source poly reports under.
    ///
    /// A tool that arrives without a row is not an unclassified tool: it is one
    /// whose findings are all ranked warning by the fallback in `severity_of`,
    /// including the ones that break a build, and nothing says so. Nothing in
    /// the type system connects a `source` field written out in another crate
    /// to this list, so the connection is a read of the sources -- the four
    /// crates are one workspace, and reading a sibling's file at test time is
    /// what the extension-manifest gates already do.
    ///
    /// A row with nothing reporting under it is the same failure read
    /// backwards: a rename that left the policy behind, so the tool under its
    /// new name is landing on the fallback.
    #[test]
    fn every_source_states_its_policy() {
        let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        // Assembled rather than written out, so the scan does not find itself
        // in this file and demand a policy for a source spelled `, `.
        let needle = ["source", ": \""].concat();
        let mut reported: Vec<String> = Vec::new();
        for name in ["poly-core", "poly-engines", "poly-tools", "poly-cli"] {
            let src = workspace.join(name).join("src");
            for entry in std::fs::read_dir(&src).expect("a crate's src directory") {
                let path = entry.expect("a directory entry").path();
                if path.extension().is_none_or(|ext| ext != "rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).expect("a source file");
                reported.extend(
                    text.split(needle.as_str())
                        .skip(1)
                        .filter_map(|rest| rest.split('"').next())
                        .map(str::to_string),
                );
            }
        }
        reported.sort();
        reported.dedup();

        let stated: Vec<&str> = POLICY.iter().map(|(name, _)| *name).collect();
        for source in &reported {
            assert!(
                stated.contains(&source.as_str()),
                "{source} reports findings and has no row in POLICY"
            );
        }
        for source in &stated {
            assert!(
                reported.iter().any(|found| found == source),
                "POLICY ranks {source}, and nothing reports under that name"
            );
        }
    }
}

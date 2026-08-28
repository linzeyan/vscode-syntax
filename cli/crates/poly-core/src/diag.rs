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

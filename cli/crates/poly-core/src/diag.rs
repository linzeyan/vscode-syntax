//! Shared lint issue type: embedded engines (sqruff) and external tools
//! (shellcheck, hadolint, ...) both produce these; the CLI and the LSP
//! daemon render them.

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Severity {
    Error,
    Warning,
    Info,
    Hint,
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

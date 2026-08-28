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
}

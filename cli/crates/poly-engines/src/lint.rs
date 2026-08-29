//! Embedded lint: sqruff for SQL. External-tool lint (shellcheck, hadolint,
//! actionlint, typos) lives in poly-tools; the LSP daemon and the CLI merge
//! both sources.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use anyhow::{anyhow, Result};
use poly_core::diag::{Fix, Issue, Severity};

/// Does `lang` have an embedded linter? Batch callers use this to avoid
/// reading thousands of files whose lint would return nothing.
pub fn supported(lang: &str) -> bool {
    matches!(lang, "sql" | "toml")
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
pub fn lint(lang: &str, _path: &Path, text: &str) -> Result<Vec<Issue>> {
    match lang {
        "sql" => lint_sql(text),
        "toml" => Ok(lint_toml(text)),
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

//! Everything poly prints about a finding, in the four shapes it prints it.
//!
//! One module because a finding has one definition: the terminal record, the
//! JSON object, the aligned table and the markdown table have to agree about
//! what the fix line says and where the issue is, and they stop agreeing the
//! moment they live in different files.
//!
//! `text` is the contract -- `path:line:col: severity [tool/rule] message` --
//! and does not move. The others exist for the consumers that were reaching for
//! `sed` to turn it back into fields; poly's own CI was one of them, rebuilding
//! GitHub annotations out of prose and only able to anchor them to the job
//! rather than to the offending line.
//!
//! stdout carries the report and nothing else. The summary line and the "tool
//! skipped" notes stay on stderr: they are how a human knows a run is
//! progressing, and they are not the report.

use anyhow::{bail, Result};
use poly_core::diag::{FailOn, Severity};
use poly_tools::run::FileIssue;
use serde_json::{json, Value};

/// Bumped when a field changes meaning or leaves. A new field does not bump it:
/// a consumer reading `issues[].file` is unaffected by a sibling appearing.
const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Format {
    #[default]
    Text,
    Json,
    Table,
    TableMarkdown,
}

impl Format {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "text" => Ok(Format::Text),
            "json" => Ok(Format::Json),
            "table" => Ok(Format::Table),
            "table_markdown" => Ok(Format::TableMarkdown),
            other => bail!(
                "unknown --format value {other:?}: expected text, json, table or table_markdown"
            ),
        }
    }
}

/// `file:line:col`, 1-based, as the text record spells it.
fn location(found: &FileIssue) -> String {
    format!(
        "{}:{}:{}",
        found.file.display(),
        found.issue.line + 1,
        found.issue.col + 1
    )
}

/// The first line of a message. Tools that draw code frames (the format
/// engines) produce several; a row and a record are both one line by
/// definition, so the rest is detail the text and JSON shapes carry.
fn head(message: &str) -> &str {
    message
        .split_once('\n')
        .map_or(message, |(h, _)| h)
        .trim_end()
}

/// One record shape for everything poly reports, whichever tool found it:
///
/// ```text
/// lint.py:1:8: warning [ruff/F401] `os` imported but unused
///     fix   Remove unused import: `os`
///     docs  https://docs.astral.sh/ruff/rules/unused-import
/// ```
///
/// The first line stays single and prefix-anchored so `rg`, CI annotation
/// scripts and the terminal's file-link detection keep working. The
/// continuations only appear when the tool actually supplied something —
/// most linters report what is wrong and leave the remedy to their docs, and
/// poly does not invent the difference. `--compact` drops them for parsers
/// that want exactly one line per issue.
///
/// A message that spans lines (the code frames the format engines draw) keeps
/// its first line in the record and the rest as indented detail, so one issue
/// is still one anchored line however verbose the tool was.
pub fn render_issue(found: &FileIssue, compact: bool) -> String {
    let issue = &found.issue;
    let (first, detail) = issue
        .message
        .split_once('\n')
        .unwrap_or((&issue.message, ""));
    let mut out = format!(
        "{}: {} [{}/{}] {}\n",
        location(found),
        issue.severity.as_str(),
        issue.source,
        issue.code,
        first.trim_end()
    );
    if compact {
        return out;
    }
    for line in detail.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            out.push('\n');
        } else {
            out.push_str(&format!("    {line}\n"));
        }
    }
    if let Some(fix) = &issue.fix {
        out.push_str(&format!("    fix   {}\n", fix.describe(issue.source)));
    }
    if let Some(url) = &issue.url {
        out.push_str(&format!("    docs  {url}\n"));
    }
    out
}

/// One finding, with every field the text record spends punctuation on.
///
/// Positions are 1-based, agreeing with the text record and with the editors
/// and CI annotations that consume them; `Issue` stores them 0-based because
/// that is what LSP wants. The end position is exclusive, also as in LSP.
///
/// `message` is whole, code frames included. The text record splits the first
/// line off so one issue stays one anchored line; a parser is under no such
/// constraint, and truncating for it would throw the frame away.
fn json_issue(found: &FileIssue, fail_on: FailOn) -> Value {
    let i = &found.issue;
    json!({
        "file": found.file.display().to_string(),
        "line": i.line + 1,
        "col": i.col + 1,
        "end_line": i.end_line + 1,
        "end_col": i.end_col + 1,
        "severity": i.severity.as_str(),
        "tool": i.source,
        "rule": i.code,
        "message": i.message,
        // The rendered sentence rather than the variant: the terminal, the
        // editor hover and this have to word a remedy identically, or a reader
        // ends up learning three vocabularies for one product.
        "fix": i.fix.as_ref().map(|f| f.describe(i.source)),
        "docs": i.url,
        // Whether this one counts toward the exit code under the fail-on in
        // force. Re-deriving it means reimplementing the severity ordering, and
        // a consumer marking annotations wants exactly this distinction.
        "fatal": fail_on.fails(i.severity),
    })
}

fn json_document(command: &str, issues: &[FileIssue], fail_on: FailOn, summary: Value) -> String {
    let doc = json!({
        "version": SCHEMA_VERSION,
        "command": command,
        "issues": issues.iter().map(|i| json_issue(i, fail_on)).collect::<Vec<_>>(),
        "summary": summary,
    });
    // Pretty because a document is as often read by a person debugging their
    // pipeline as by the pipeline. Every JSON parser is indifferent.
    format!(
        "{}\n",
        serde_json::to_string_pretty(&doc).expect("diagnostics serialize")
    )
}

/// Columns: where, how bad, who said so, what.
///
/// Deliberately not fix and docs. A row has to stay one line, and a column of
/// URLs is wider than the other three put together; `text` and `json` carry
/// them. A table is the overview you scan before opening one of those.
///
/// Widths are counted in `char`s, so a table whose paths are CJK aligns a
/// column or two narrow. Every tool poly runs reports in English, and the
/// alternative is a unicode-width dependency for a cosmetic edge.
fn table(issues: &[FileIssue]) -> String {
    // Nothing found, nothing printed -- the same silence `text` keeps, so a
    // clean run looks clean in every format instead of emitting a bare header.
    if issues.is_empty() {
        return String::new();
    }
    let header = ["FILE", "SEVERITY", "RULE", "MESSAGE"];
    let rows: Vec<[String; 4]> = issues
        .iter()
        .map(|found| {
            let i = &found.issue;
            [
                location(found),
                i.severity.as_str().to_string(),
                format!("{}/{}", i.source, i.code),
                head(&i.message).to_string(),
            ]
        })
        .collect();

    let mut width = header.map(|h| h.chars().count());
    for row in &rows {
        for (w, cell) in width.iter_mut().zip(row) {
            *w = (*w).max(cell.chars().count());
        }
    }

    let mut out = String::new();
    // The last column is never padded: trailing spaces are invisible, survive
    // copy-paste, and turn a clean diff into a whitespace argument.
    let line = |cells: [&str; 4], out: &mut String| {
        for (n, cell) in cells.iter().enumerate() {
            if n == cells.len() - 1 {
                out.push_str(cell);
            } else {
                out.push_str(&format!("{cell:<pad$}  ", pad = width[n]));
            }
        }
        out.push('\n');
    };
    line(header, &mut out);
    for row in &rows {
        line([&row[0], &row[1], &row[2], &row[3]], &mut out);
    }
    out
}

/// A cell in a GitHub-flavoured table: the pipe is the only character that can
/// end one early, and a newline cannot appear in one at all.
fn cell(text: &str) -> String {
    text.replace('|', "\\|")
}

/// The markdown twin of `table`, for `$GITHUB_STEP_SUMMARY` and PR comments.
///
/// The docs URL rides on the rule cell rather than taking a column of its own:
/// the rule is the thing being documented, and markdown renders the link
/// without spending any width on it. That is the one thing this shape can carry
/// that the aligned table cannot.
fn table_markdown(issues: &[FileIssue]) -> String {
    if issues.is_empty() {
        return String::new();
    }
    let mut out = String::from("| File | Severity | Rule | Message |\n| --- | --- | --- | --- |\n");
    for found in issues {
        let i = &found.issue;
        let rule = format!("{}/{}", i.source, i.code);
        let rule = match &i.url {
            Some(url) => format!("[{}]({url})", cell(&rule)),
            None => cell(&rule),
        };
        out.push_str(&format!(
            "| `{}` | {} | {} | {} |\n",
            cell(&location(found)),
            i.severity.as_str(),
            rule,
            cell(head(&i.message))
        ));
    }
    out
}

/// What `poly check` puts on stdout.
pub struct Check<'a> {
    pub issues: &'a [FileIssue],
    pub fail_on: FailOn,
    pub ran: usize,
    pub missing: &'a [String],
    pub failed: &'a [String],
}

impl Check<'_> {
    pub fn render(&self, format: Format, compact: bool) -> String {
        match format {
            Format::Text => self
                .issues
                .iter()
                .map(|i| render_issue(i, compact))
                .collect(),
            Format::Table => table(self.issues),
            Format::TableMarkdown => table_markdown(self.issues),
            Format::Json => json_document(
                "check",
                self.issues,
                self.fail_on,
                json!({
                    "issues": self.issues.len(),
                    "fatal": self.fatal(),
                    "tools_ran": self.ran,
                    // Named, not counted: "2 tools missing" sends a reader back
                    // to the stderr log to find out which, which is the whole
                    // thing these formats exist to avoid.
                    "tools_missing": self.missing,
                    "tools_failed": self.failed,
                }),
            ),
        }
    }

    pub fn fatal(&self) -> usize {
        self.issues
            .iter()
            .filter(|i| self.fail_on.fails(i.issue.severity))
            .count()
    }
}

/// What `poly fmt` puts on stdout.
///
/// `formatted` is what poly wrote, and is empty under `--check`, where the same
/// files appear in `issues` instead: "this file is not formatted" is a finding,
/// "I reformatted it" is not. Only `text` prints those lines -- a table of
/// successes is not a report, and the stderr summary already counts them.
pub struct Fmt<'a> {
    pub issues: &'a [FileIssue],
    pub formatted: &'a [String],
    pub fail_on: FailOn,
    pub total: usize,
    pub unchanged: usize,
    pub missing: &'a [String],
    pub check: bool,
}

impl Fmt<'_> {
    pub fn render(&self, format: Format, compact: bool) -> String {
        match format {
            Format::Text => {
                let mut out = String::new();
                for path in self.formatted {
                    out.push_str(&format!("formatted {path}\n"));
                }
                for issue in self.issues {
                    out.push_str(&render_issue(issue, compact));
                }
                out
            }
            Format::Table => table(self.issues),
            Format::TableMarkdown => table_markdown(self.issues),
            Format::Json => json_document(
                "fmt",
                self.issues,
                self.fail_on,
                json!({
                    "files": self.total,
                    "unchanged": self.unchanged,
                    // Said outright so a consumer never has to infer which run
                    // this was from an empty `formatted` list.
                    "check": self.check,
                    "formatted": self.formatted,
                    "formatters_missing": self.missing,
                }),
            ),
        }
    }
}

/// The severity a `poly fmt --check` finding carries, shared with `main` so the
/// exit code and the `fatal` field cannot disagree about it.
pub const UNFORMATTED: Severity = Severity::Warning;

#[cfg(test)]
mod tests {
    use super::*;
    use poly_core::diag::Fix;
    use std::path::PathBuf;

    fn issue(fix: Option<Fix>, url: Option<&str>) -> FileIssue {
        FileIssue {
            file: PathBuf::from("lint.py"),
            issue: poly_core::diag::Issue {
                line: 0,
                col: 7,
                end_line: 0,
                end_col: 9,
                severity: Severity::Warning,
                code: "F401".to_string(),
                message: "`os` imported but unused".to_string(),
                source: "ruff",
                fix,
                url: url.map(str::to_string),
            },
        }
    }

    #[test]
    fn an_issue_renders_what_where_and_how_to_fix() {
        let full = issue(
            Some(Fix::Described {
                what: "Remove unused import: `os`".to_string(),
                safe: true,
            }),
            Some("https://docs.astral.sh/ruff/rules/unused-import"),
        );
        assert_eq!(
            render_issue(&full, false),
            "lint.py:1:8: warning [ruff/F401] `os` imported but unused\n\
             \x20   fix   Remove unused import: `os`\n\
             \x20   docs  https://docs.astral.sh/ruff/rules/unused-import\n"
        );

        // CI parsers want exactly one line per issue, and the first line alone
        // is the whole record: everything after it is advice.
        assert_eq!(
            render_issue(&full, true),
            "lint.py:1:8: warning [ruff/F401] `os` imported but unused\n"
        );

        // A tool that supplied nothing gets nothing invented on its behalf.
        assert_eq!(
            render_issue(&issue(None, None), false),
            "lint.py:1:8: warning [ruff/F401] `os` imported but unused\n"
        );

        // ruff's own word for an edit that can change behavior has to survive.
        let risky = issue(
            Some(Fix::Described {
                what: "Remove assignment".to_string(),
                safe: false,
            }),
            None,
        );
        assert!(render_issue(&risky, false).contains("(unsafe: review it)"));

        // Naming the tool keeps "automatic" honest: poly check does not run it.
        let auto = issue(Some(Fix::Automatic), None);
        assert!(render_issue(&auto, false).contains("ruff can rewrite this"));
    }

    /// The point of the JSON shape is that nothing has to be parsed back out of
    /// prose, so every field the record spends punctuation on has to be here.
    #[test]
    fn json_carries_every_field_the_record_encodes() {
        let found = [issue(
            Some(Fix::Described {
                what: "Remove unused import: `os`".to_string(),
                safe: false,
            }),
            Some("https://docs.astral.sh/ruff/rules/unused-import"),
        )];
        let report = Check {
            issues: &found,
            fail_on: FailOn::Severity(Severity::Error),
            ran: 3,
            missing: &["tflint".to_string()],
            failed: &[],
        };
        let doc: Value = serde_json::from_str(&report.render(Format::Json, false)).unwrap();

        assert_eq!(doc["version"], 1);
        assert_eq!(doc["command"], "check");
        let issue = &doc["issues"][0];
        assert_eq!(issue["file"], "lint.py");
        // 1-based, matching the record: the struct is 0-based for LSP's sake.
        assert_eq!(issue["line"], 1);
        assert_eq!(issue["col"], 8);
        assert_eq!(issue["severity"], "warning");
        assert_eq!(issue["tool"], "ruff");
        assert_eq!(issue["rule"], "F401");
        assert_eq!(issue["message"], "`os` imported but unused");
        // The same sentence the terminal prints, unsafe marker included.
        assert_eq!(
            issue["fix"],
            "Remove unused import: `os` (unsafe: review it)"
        );
        assert_eq!(
            issue["docs"],
            "https://docs.astral.sh/ruff/rules/unused-import"
        );
        // A warning under --fail-on error is reported but not fatal, and the
        // consumer is told which without reimplementing the ordering.
        assert_eq!(issue["fatal"], false);
        assert_eq!(doc["summary"]["fatal"], 0);
        assert_eq!(doc["summary"]["issues"], 1);
        assert_eq!(doc["summary"]["tools_missing"][0], "tflint");
    }

    /// A tool that said nothing about a remedy has to serialize as null, not as
    /// an empty string: "no fix known" and "the fix is nothing" differ.
    #[test]
    fn json_says_null_rather_than_guessing() {
        let found = [issue(None, None)];
        let doc: Value = serde_json::from_str(
            &Check {
                issues: &found,
                fail_on: FailOn::default(),
                ran: 1,
                missing: &[],
                failed: &[],
            }
            .render(Format::Json, false),
        )
        .unwrap();
        assert!(doc["issues"][0]["fix"].is_null());
        assert!(doc["issues"][0]["docs"].is_null());
    }

    #[test]
    fn the_table_aligns_on_its_widest_cell() {
        let mut long = issue(None, None);
        long.file = PathBuf::from("scripts/deploy/entrypoint.sh");
        long.issue.source = "shellcheck";
        long.issue.code = "SC2086".to_string();
        long.issue.severity = Severity::Error;
        long.issue.message = "Double quote to prevent globbing".to_string();
        let found = [issue(None, None), long];

        let out = table(&found);
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[0].starts_with("FILE"));
        // Every column starts at the same offset on every row, which is the
        // only property a table has that the record does not.
        for column in ["warning", "error"] {
            let row = lines.iter().find(|l| l.contains(column)).unwrap();
            assert_eq!(
                row.find(column).unwrap(),
                lines[0].find("SEVERITY").unwrap(),
                "severity column moved on {row:?}"
            );
        }
        // Trailing whitespace would survive copy-paste into a diff.
        assert!(lines.iter().all(|l| l == &l.trim_end()), "{out:?}");
        // Clean runs stay silent rather than printing a lone header.
        assert_eq!(table(&[]), "");
    }

    #[test]
    fn the_markdown_table_links_the_rule_and_escapes_the_cells() {
        let mut piped = issue(None, Some("https://example.test/F401"));
        piped.issue.message = "expected `a | b`".to_string();
        let out = table_markdown(&[piped]);

        assert!(
            out.starts_with("| File | Severity | Rule | Message |\n| --- | --- | --- | --- |\n")
        );
        // The URL costs no column: it is what the rule name points at.
        assert!(
            out.contains("[ruff/F401](https://example.test/F401)"),
            "{out}"
        );
        // An unescaped pipe would end the cell early and shift every column
        // after it, which is how a table silently reports the wrong rule.
        assert!(out.contains(r"expected `a \| b`"), "{out}");
        assert_eq!(table_markdown(&[]), "");
    }

    /// A multi-line message is one row and one record, and the same one.
    #[test]
    fn every_one_line_shape_takes_the_same_first_line() {
        let mut framed = issue(None, None);
        framed.issue.message = "unexpected token\n  1 | let x =\n    |         ^".to_string();

        assert!(table(&[framed]).lines().count() == 2);
        let mut framed = issue(None, None);
        framed.issue.message = "unexpected token\n  1 | let x =".to_string();
        assert!(table(&[framed]).contains("unexpected token"));
        let mut framed = issue(None, None);
        framed.issue.message = "unexpected token\n  1 | let x =".to_string();
        assert!(!table(&[framed]).contains("let x ="));
    }
}

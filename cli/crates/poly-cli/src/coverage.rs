//! What this run checked, what it did not, and why: `poly tools list` for one
//! run rather than for the machine.
//!
//! The gap this closes is not a missing checker, it is silence. shellcheck has
//! no Windows build, a project without eslint gets no eslint, hadolint is off
//! until a project asks for it -- and each of those was a checker quietly not
//! looking at files that were in scope, which made "nothing is wrong" and
//! "nothing looked" print exactly the same thing. A run that says which is which
//! is the difference between a green pipeline and a green pipeline that means
//! something (09 §1.5).
//!
//! An entry exists because the walk found files for that checker, not because
//! the checker ran: the ones worth printing are precisely the ones that never
//! started. `files` is therefore *files in scope* -- what poly handed the
//! checker -- and not what the checker went on to read. A tool's own
//! configuration narrows it further (a `_typos.toml` exclude, a `buf.yaml`
//! selecting fewer rules), and those are the tool's answer to report, not
//! poly's.

use std::collections::BTreeMap;

use serde_json::{json, Value};

/// Why a checker with files in scope did or did not report on them.
///
/// The variants are the distinctions a reader acts on, which is why "off" is
/// three of them: a project that wrote `hadolint = "off"` wants a different
/// sentence from one that never mentioned hadolint, and a project with no
/// eslint has nothing to fix at all.
#[derive(Debug, PartialEq)]
pub enum Status {
    /// It ran over those files. Not a claim about what it found -- that is the
    /// report.
    Ran,
    /// Nowhere to get it, and how to fix that (`poly_tools::Resolved::Missing`).
    Missing(String),
    /// `[tools] <name> = "off"`.
    Disabled,
    /// poly does not run it unless a project asks (`poly_tools::DEFAULT_OFF`).
    OffByDefault,
    /// A project-local tool this project does not carry. Not a failure and not
    /// a gap: eslint checks the files of projects that chose eslint.
    Absent(&'static str),
    /// It ran and broke. Reported rather than fatal on the spot, because one
    /// broken linter is not a reason to throw away every other tool's findings.
    Failed(String),
}

impl Status {
    /// The word a machine reads. Stable: `--format json` consumers key on it.
    pub fn word(&self) -> &'static str {
        match self {
            Status::Ran => "ran",
            Status::Missing(_) => "missing",
            Status::Disabled => "disabled",
            Status::OffByDefault => "off-by-default",
            Status::Absent(_) => "absent",
            Status::Failed(_) => "failed",
        }
    }

    /// The sentence a person reads, in the vocabulary the rest of poly already
    /// uses for the same state -- `poly tools install` words a default-off tool
    /// this way, and a second phrasing for one state is a second thing to learn.
    pub fn reason(&self, tool: &str) -> Option<String> {
        match self {
            Status::Ran => None,
            Status::Missing(why) | Status::Failed(why) => Some(why.clone()),
            Status::Disabled => Some(format!("`{tool} = \"off\"` under [tools] in poly.toml")),
            Status::OffByDefault => Some(format!(
                "add `{tool} = \"on\"` under [tools] to run it as well"
            )),
            Status::Absent(why) => Some((*why).to_string()),
        }
    }
}

struct Entry {
    files: usize,
    status: Status,
}

/// Every checker this run had files for, in one place.
///
/// Also the run's own bookkeeping: the exit code asks it how many tools failed
/// and how many are missing, so the list a reader sees and the number the
/// pipeline acts on cannot come apart.
#[derive(Default)]
pub struct Coverage {
    /// Keyed by checker name, which sorts the report alphabetically. Order by
    /// status would put the interesting rows first and move every other row
    /// whenever one of them changed, which is worse for anything diffing two
    /// runs.
    entries: BTreeMap<String, Entry>,
}

impl Coverage {
    /// Record one checker's verdict over the `files` the walk found for it.
    ///
    /// Nothing is recorded for a checker with no files: a repository with no Go
    /// has not lost anything by golangci-lint not running, and a line per
    /// registry entry per run would bury the ones that matter.
    pub fn record(&mut self, tool: impl Into<String>, files: usize, status: Status) {
        if files == 0 {
            return;
        }
        self.entries.insert(tool.into(), Entry { files, status });
    }

    fn count(&self, word: &str) -> usize {
        self.entries
            .values()
            .filter(|e| e.status.word() == word)
            .count()
    }

    pub fn ran(&self) -> usize {
        self.count("ran")
    }

    /// Checkers poly could not find. `--strict` fails on these and on nothing
    /// else here: a tool that is absent from a project that never wanted it is
    /// not a gap, and one that is off is a decision somebody made.
    pub fn missing(&self) -> usize {
        self.count("missing")
    }

    pub fn failed(&self) -> usize {
        self.count("failed")
    }

    /// The block that goes on stderr, or nothing at all when no checker had
    /// files -- `poly check` on a directory of images has nothing to report and
    /// no coverage to report either.
    pub fn render(&self) -> String {
        if self.entries.is_empty() {
            return String::new();
        }
        let name_width = self.entries.keys().map(String::len).max().unwrap_or(0);
        let count_width = self
            .entries
            .values()
            .map(|e| e.files.to_string().len())
            .max()
            .unwrap_or(1);
        let mut out = String::from("coverage:\n");
        for (tool, entry) in &self.entries {
            let files = if entry.files == 1 { "file" } else { "files" };
            out.push_str(&format!(
                "  {tool:<name_width$}  {count:>count_width$} {files:<5}  {status}",
                count = entry.files,
                status = entry.status.word(),
            ));
            if let Some(reason) = entry.status.reason(tool) {
                out.push_str(&format!(" — {reason}"));
            }
            out.push('\n');
        }
        out
    }

    /// The same rows for `--format json`, where a pipeline can act on them
    /// without parsing the block above.
    pub fn json(&self) -> Value {
        Value::Array(
            self.entries
                .iter()
                .map(|(tool, entry)| {
                    json!({
                        "tool": tool,
                        "files": entry.files,
                        "status": entry.status.word(),
                        "reason": entry.status.reason(tool),
                    })
                })
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Where the nth whitespace-separated token of `line` starts, so alignment
    /// can be asserted without restating the format string.
    fn token_at(line: &str, n: usize) -> usize {
        line.char_indices()
            .filter(|(i, c)| !c.is_whitespace() && (*i == 0 || line.as_bytes()[i - 1] == b' '))
            .nth(n)
            .map(|(i, _)| i)
            .expect("token")
    }

    /// Every state a reader has to tell apart prints its own sentence, and the
    /// counts the exit code is built from agree with the rows.
    #[test]
    fn every_status_says_what_to_do_about_it() {
        let mut coverage = Coverage::default();
        coverage.record("typos", 412, Status::Ran);
        coverage.record(
            "shellcheck",
            4,
            Status::Missing("no managed build for win-x64 and not on PATH".to_string()),
        );
        coverage.record("hadolint", 1, Status::OffByDefault);
        coverage.record("tflint", 2, Status::Disabled);
        coverage.record("eslint", 9, Status::Absent("no eslint in this project"));
        coverage.record("cargo", 30, Status::Failed("could not build".to_string()));

        let out = coverage.render();
        let row = |tool: &str| {
            out.lines()
                .find(|l| l.trim_start().starts_with(tool))
                .unwrap_or_else(|| panic!("no row for {tool} in {out}"))
                .to_string()
        };
        // A default-off tool is told how to turn it on; a disabled one is told
        // where the line it wrote lives. Reversing those two sends a reader
        // looking for a poly.toml they never wrote.
        assert!(
            row("hadolint").ends_with(
                "off-by-default — add `hadolint = \"on\"` under [tools] to run it as well"
            ),
            "{out}"
        );
        assert!(
            row("tflint").ends_with("disabled — `tflint = \"off\"` under [tools] in poly.toml"),
            "{out}"
        );
        // "ran" carries no reason: there is nothing to do about it.
        assert!(row("typos").ends_with("412 files  ran"), "{out}");
        // The reason a checker did not run is on the same line as the checker,
        // because that is the pairing the reader came for.
        assert!(
            row("shellcheck").ends_with("missing — no managed build for win-x64 and not on PATH"),
            "{out}"
        );
        assert!(
            row("eslint").ends_with("absent — no eslint in this project"),
            "{out}"
        );
        // One file is one file. A count column that says "1 files" is the kind
        // of thing a reader stops trusting the rest of the line over.
        assert!(row("hadolint").contains("1 file "), "{out}");
        // Every status word starts at the same column, which is the only thing
        // a block of rows has that six separate sentences would not.
        for tool in ["shellcheck", "hadolint", "tflint", "eslint", "cargo"] {
            assert_eq!(token_at(&row(tool), 3), token_at(&row("typos"), 3), "{out}");
        }

        // Only "missing" feeds --strict, and only "failed" feeds exit 2: a tool
        // that is off or absent is a decision rather than a gap.
        assert_eq!(coverage.ran(), 1);
        assert_eq!(coverage.missing(), 1);
        assert_eq!(coverage.failed(), 1);
    }

    /// A checker with nothing to check is not a coverage gap, and printing one
    /// line per registry entry per run would bury the rows that are.
    #[test]
    fn a_checker_with_no_files_is_not_a_row() {
        let mut coverage = Coverage::default();
        coverage.record(
            "golangci-lint",
            0,
            Status::Missing("not on PATH".to_string()),
        );
        assert_eq!(coverage.render(), "");
        assert_eq!(coverage.missing(), 0);
        assert_eq!(coverage.json(), json!([]));
    }

    /// The JSON rows carry the same four facts the block does, so a pipeline
    /// never has to parse prose to find out what went unchecked.
    #[test]
    fn json_carries_the_reason_too() {
        let mut coverage = Coverage::default();
        coverage.record("ruff", 8, Status::Ran);
        coverage.record(
            "shellcheck",
            4,
            Status::Missing("no Windows build".to_string()),
        );
        let rows = coverage.json();

        assert_eq!(rows[0]["tool"], "ruff");
        assert_eq!(rows[0]["files"], 8);
        assert_eq!(rows[0]["status"], "ran");
        // Null rather than an empty string: "nothing to explain" and "the
        // explanation is nothing" are different answers.
        assert!(rows[0]["reason"].is_null());
        assert_eq!(rows[1]["status"], "missing");
        assert_eq!(rows[1]["reason"], "no Windows build");
    }
}

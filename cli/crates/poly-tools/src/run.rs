//! Lint runners: spawn a resolved tool, parse its JSON output into Issues.
//! All tools here exit non-zero when they find problems — only a failed
//! spawn or output we cannot parse is an error.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{anyhow, Context, Result};
use poly_core::diag::{Fix, Issue, Severity};
use serde::Deserialize;

pub struct FileIssue {
    pub file: PathBuf,
    pub issue: Issue,
}

/// Nearest `name` at or above `start`'s directory. Tools that resolve their
/// own config against the *cwd* (selene) otherwise lint with default rules
/// whenever poly is invoked from outside the project, which would make CI and
/// the editor disagree for no visible reason.
fn nearest_ancestor_file(start: &Path, name: &str) -> Option<PathBuf> {
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

fn run(cmd: &Path, args: &[&str], files: &[PathBuf], stdin: Option<&str>) -> Result<Vec<u8>> {
    run_impl(cmd, None, args, files, stdin)
}

/// Same, but rooted at `cwd` for tools that resolve config relative to it.
fn run_in(
    cmd: &Path,
    cwd: &Path,
    args: &[&str],
    files: &[PathBuf],
    stdin: Option<&str>,
) -> Result<Vec<u8>> {
    run_impl(cmd, Some(cwd), args, files, stdin)
}

fn run_impl(
    cmd: &Path,
    cwd: Option<&Path>,
    args: &[&str],
    files: &[PathBuf],
    stdin: Option<&str>,
) -> Result<Vec<u8>> {
    let mut command = Command::new(cmd);
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    command.args(args);
    command.args(files.iter().map(|p| p.as_os_str()));
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("running {}", cmd.display()))?;
    if let Some(text) = stdin {
        child
            .stdin
            .take()
            .expect("piped stdin")
            .write_all(text.as_bytes())?;
    }
    Ok(child.wait_with_output()?.stdout)
}

/// Generic stdin->stdout formatter invocation (prettier, rustfmt, shfmt).
/// Non-zero exit means the tool rejected the input (syntax error).
pub fn format_stdin(cmd: &Path, args: &[&str], text: &str) -> Result<Option<String>> {
    let mut child = Command::new(cmd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("running {}", cmd.display()))?;
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(text.as_bytes())?;
    let out = child.wait_with_output()?;
    if !out.status.success() {
        anyhow::bail!(
            "{} failed: {}",
            cmd.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("formatter"),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let formatted = String::from_utf8(out.stdout).context("formatter output not UTF-8")?;
    Ok((formatted != text).then_some(formatted))
}

fn shellcheck_severity(level: &str) -> Severity {
    match level {
        "error" => Severity::Error,
        "warning" => Severity::Warning,
        "info" => Severity::Info,
        _ => Severity::Hint,
    }
}

// ── shellcheck ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ShellcheckItem {
    file: String,
    line: u32,
    column: u32,
    #[serde(rename = "endLine")]
    end_line: u32,
    #[serde(rename = "endColumn")]
    end_column: u32,
    level: String,
    code: u64,
    message: String,
    /// Present with the replacements shellcheck would apply, null otherwise.
    /// It never describes them in words, so all poly can report is that a
    /// mechanical fix exists.
    fix: Option<serde_json::Value>,
}

/// One page per code, and the scheme has been stable for a decade. Derived
/// rather than guessed: the wiki 404s for a code that does not exist, so a
/// wrong link would be visible rather than silently misleading.
fn shellcheck_url(code: u64) -> String {
    format!("https://www.shellcheck.net/wiki/SC{code}")
}

fn shellcheck_parse(stdout: &[u8]) -> Result<Vec<FileIssue>> {
    let items: Vec<ShellcheckItem> =
        serde_json::from_slice(stdout).context("parsing shellcheck output")?;
    Ok(items
        .into_iter()
        .map(|i| FileIssue {
            file: PathBuf::from(i.file),
            issue: Issue {
                line: i.line.saturating_sub(1),
                col: i.column.saturating_sub(1),
                end_line: i.end_line.saturating_sub(1),
                end_col: i.end_column.saturating_sub(1),
                severity: shellcheck_severity(&i.level),
                code: format!("SC{}", i.code),
                message: i.message,
                source: "shellcheck",
                fix: i.fix.is_some().then_some(Fix::Automatic),
                url: Some(shellcheck_url(i.code)),
            },
        })
        .collect())
}

pub fn shellcheck_files(cmd: &Path, files: &[PathBuf]) -> Result<Vec<FileIssue>> {
    shellcheck_parse(&run(cmd, &["-f", "json"], files, None)?)
}

pub fn shellcheck_stdin(cmd: &Path, text: &str) -> Result<Vec<Issue>> {
    let out = run(cmd, &["-f", "json", "-"], &[], Some(text))?;
    Ok(shellcheck_parse(&out)?
        .into_iter()
        .map(|f| f.issue)
        .collect())
}

// ── hadolint ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct HadolintItem {
    file: String,
    line: u32,
    column: u32,
    level: String,
    code: String,
    message: String,
}

/// hadolint runs shellcheck over every RUN line, so its output carries SC
/// codes alongside its own DL ones; they document in different places.
fn hadolint_url(code: &str) -> String {
    match code.strip_prefix("SC").and_then(|n| n.parse().ok()) {
        Some(n) => shellcheck_url(n),
        None => format!("https://github.com/hadolint/hadolint/wiki/{code}"),
    }
}

fn hadolint_parse(stdout: &[u8]) -> Result<Vec<FileIssue>> {
    let items: Vec<HadolintItem> =
        serde_json::from_slice(stdout).context("parsing hadolint output")?;
    Ok(items
        .into_iter()
        .map(|i| {
            let line = i.line.saturating_sub(1);
            let col = i.column.saturating_sub(1);
            FileIssue {
                file: PathBuf::from(i.file),
                issue: Issue {
                    line,
                    col,
                    end_line: line,
                    end_col: col + 1,
                    severity: shellcheck_severity(&i.level),
                    source: "hadolint",
                    fix: None,
                    url: Some(hadolint_url(&i.code)),
                    code: i.code,
                    message: i.message,
                },
            }
        })
        .collect())
}

pub fn hadolint_files(cmd: &Path, files: &[PathBuf]) -> Result<Vec<FileIssue>> {
    hadolint_parse(&run(cmd, &["--format", "json", "--no-fail"], files, None)?)
}

pub fn hadolint_stdin(cmd: &Path, text: &str) -> Result<Vec<Issue>> {
    let out = run(
        cmd,
        &["--format", "json", "--no-fail", "-"],
        &[],
        Some(text),
    )?;
    Ok(hadolint_parse(&out)?.into_iter().map(|f| f.issue).collect())
}

// ── actionlint ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ActionlintItem {
    filepath: String,
    line: u32,
    column: u32,
    kind: String,
    message: String,
}

/// actionlint has no rule pages -- its `kind` is a category, not a rule -- but
/// the checks that need a reference carry one inline, always as a trailing
/// `see <url> ...` clause. Lifting it into the docs slot keeps the record's
/// first line to one readable line and puts the link where every other tool's
/// link is; leaving it in would print the same URL twice.
fn actionlint_docs(message: &str) -> (String, Option<String>) {
    let Some(at) = message.find(" see http") else {
        return (message.to_string(), None);
    };
    let url = message[at + " see ".len()..]
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_end_matches(['.', ',', ')']);
    (message[..at].to_string(), Some(url.to_string()))
}

fn actionlint_parse(stdout: &[u8]) -> Result<Vec<FileIssue>> {
    let items: Vec<ActionlintItem> =
        serde_json::from_slice(stdout).context("parsing actionlint output")?;
    Ok(items
        .into_iter()
        .map(|i| {
            let line = i.line.saturating_sub(1);
            let col = i.column.saturating_sub(1);
            let (message, url) = actionlint_docs(&i.message);
            FileIssue {
                file: PathBuf::from(i.filepath),
                issue: Issue {
                    line,
                    col,
                    end_line: line,
                    end_col: col + 1,
                    severity: Severity::Error,
                    code: i.kind,
                    message,
                    source: "actionlint",
                    fix: None,
                    url,
                },
            }
        })
        .collect())
}

pub fn actionlint_files(cmd: &Path, files: &[PathBuf]) -> Result<Vec<FileIssue>> {
    actionlint_parse(&run(cmd, &["-format", "{{json .}}"], files, None)?)
}

pub fn actionlint_stdin(cmd: &Path, text: &str) -> Result<Vec<Issue>> {
    let out = run(cmd, &["-format", "{{json .}}", "-"], &[], Some(text))?;
    Ok(actionlint_parse(&out)?
        .into_iter()
        .map(|f| f.issue)
        .collect())
}

// ── typos ──────────────────────────────────────────────────────────────────

/// typos interleaves record kinds on stdout: `binary_file` (skipped file) and
/// `error` carry none of the position fields, so a single tagged enum keeps
/// typo records strictly validated while letting the rest pass by.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TyposRecord {
    Typo(TyposItem),
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct TyposItem {
    path: String,
    /// Absent when the typo is in the file *name*: there is no line, and
    /// `byte_offset` then indexes the path instead of the contents.
    line_num: Option<u32>,
    byte_offset: u32,
    typo: String,
    corrections: Vec<String>,
}

/// Repo-wide spell check: one invocation over the walk roots (typos does its
/// own file discovery and respects .gitignore).
///
/// Because it discovers files itself, it never sees poly's walk and would
/// otherwise ignore `[lint] exclude` entirely — the one tool where that is
/// most visible, since it reports on every file type. The patterns are
/// forwarded to its own gitignore-style `--exclude`.
///
/// `root` is the poly.toml directory the patterns are written relative to.
/// typos matches `--exclude` against paths relative to *its own* working
/// directory, so `poly check some/repo` from outside would match every pattern
/// against `some/repo/...` and silently exclude nothing. Anchoring the child
/// at `root` makes `poly check .` and `poly check path/to/repo` agree.
/// Re-express `paths` relative to `root`, which becomes the child's cwd.
///
/// A path outside the root is left as given: it can only be an absolute one
/// (a relative walk from inside the root cannot leave it), and absolute paths
/// ignore the child's cwd anyway.
fn scope_to_root(paths: &[PathBuf], root: Option<&Path>) -> Vec<PathBuf> {
    let Some(root) = root else {
        return paths.to_vec();
    };
    paths
        .iter()
        .map(|p| match p.strip_prefix(root) {
            Ok(rel) if rel.as_os_str().is_empty() => PathBuf::from("."),
            Ok(rel) => rel.to_path_buf(),
            Err(_) => p.clone(),
        })
        .collect()
}

pub fn typos_paths(
    cmd: &Path,
    paths: &[PathBuf],
    exclude: &[String],
    root: Option<&Path>,
) -> Result<Vec<FileIssue>> {
    let mut args = vec!["--format", "json"];
    for pattern in exclude {
        args.extend_from_slice(&["--exclude", pattern]);
    }
    // An empty root is `Config::discover` reporting "the cwd"; Command rejects
    // it as a working directory.
    let root = root.filter(|r| !r.as_os_str().is_empty());
    let scoped = scope_to_root(paths, root);
    let stdout = run_impl(cmd, root, &args, &scoped, None)?;
    let mut out = Vec::new();
    for line in stdout.split(|&b| b == b'\n').filter(|l| !l.is_empty()) {
        let record: TyposRecord =
            serde_json::from_slice(line).map_err(|e| anyhow!("parsing typos output line: {e}"))?;
        let TyposRecord::Typo(item) = record else {
            continue;
        };
        // A misspelled file name gets anchored at the very start with the
        // reason spelled out, rather than aiming a path offset at whatever
        // happens to sit there in the contents.
        let (line0, col, width) = match item.line_num {
            Some(n) => (
                n.saturating_sub(1),
                item.byte_offset,
                item.typo.chars().count() as u32,
            ),
            None => (0, 0, 0),
        };
        // Paths come back relative to the child's cwd; put the root back so
        // what we print still resolves from the user's shell.
        let reported = item.path.trim_start_matches("./").trim_start_matches(".\\");
        out.push(FileIssue {
            file: match root {
                Some(root) => root.join(reported),
                None => PathBuf::from(reported),
            },
            issue: Issue {
                line: line0,
                col,
                end_line: line0,
                end_col: col + width,
                severity: Severity::Info,
                code: "typo".to_string(),
                message: format!(
                    "`{}` should be `{}`{}",
                    item.typo,
                    item.corrections.join("` or `"),
                    if item.line_num.is_none() {
                        " (in the file name)"
                    } else {
                        ""
                    }
                ),
                source: "typos",
                // The correction is already in the message; what this adds is
                // that `typos --write` would apply it without a human.
                fix: Some(Fix::Automatic),
                url: None,
            },
        });
    }
    Ok(out)
}

// ── ruff ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct RuffPos {
    row: u32,
    column: u32,
}

/// ruff is the only tool that ships a remediation sentence with the finding.
/// `applicability` is "safe" when applying the edit cannot change behavior.
#[derive(Deserialize)]
struct RuffFix {
    message: String,
    applicability: String,
}

#[derive(Deserialize)]
struct RuffItem {
    filename: String,
    code: Option<String>,
    message: String,
    location: RuffPos,
    end_location: RuffPos,
    /// 1-based cell index for notebooks; absent for .py files.
    cell: Option<u32>,
    /// Both absent on syntax errors, which no rule owns.
    fix: Option<RuffFix>,
    url: Option<String>,
}

fn ruff_parse(stdout: &[u8]) -> Result<Vec<FileIssue>> {
    let items: Vec<RuffItem> = serde_json::from_slice(stdout).context("parsing ruff output")?;
    Ok(items
        .into_iter()
        .map(|i| FileIssue {
            file: PathBuf::from(i.filename),
            issue: Issue {
                line: i.location.row.saturating_sub(1),
                col: i.location.column.saturating_sub(1),
                end_line: i.end_location.row.saturating_sub(1),
                end_col: i.end_location.column.saturating_sub(1),
                severity: Severity::Warning,
                code: i.code.unwrap_or_else(|| "ruff".to_string()),
                // Notebook rows are relative to the cell, so a bare
                // file:line:col would point at the wrong place in the .ipynb.
                message: match i.cell {
                    Some(cell) => format!("cell {cell}: {}", i.message),
                    None => i.message,
                },
                source: "ruff",
                fix: i.fix.map(|f| Fix::Described {
                    what: f.message,
                    safe: f.applicability == "safe",
                }),
                url: i.url,
            },
        })
        .collect())
}

pub fn ruff_files(cmd: &Path, files: &[PathBuf]) -> Result<Vec<FileIssue>> {
    ruff_parse(&run(
        cmd,
        &["check", "--output-format", "json"],
        files,
        None,
    )?)
}

pub fn ruff_stdin(cmd: &Path, path: &Path, text: &str) -> Result<Vec<Issue>> {
    let path_arg = path.to_string_lossy();
    let out = run(
        cmd,
        &[
            "check",
            "--output-format",
            "json",
            "--stdin-filename",
            &path_arg,
            "-",
        ],
        &[],
        Some(text),
    )?;
    Ok(ruff_parse(&out)?.into_iter().map(|f| f.issue).collect())
}

// ── selene ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SeleneSpan {
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
}

#[derive(Deserialize)]
struct SeleneLabel {
    filename: String,
    span: SeleneSpan,
}

#[derive(Deserialize)]
struct SeleneItem {
    #[serde(rename = "type")]
    kind: String,
    severity: String,
    code: String,
    message: String,
    primary_label: SeleneLabel,
}

/// One page per lint, named exactly by the code selene reports. `parse_error`
/// is the exception: it is how selene reports invalid Lua, not a lint, and has
/// no page — linking it would send the reader somewhere that 404s.
fn selene_url(code: &str) -> Option<String> {
    (code != "parse_error")
        .then(|| format!("https://kampfkarren.github.io/selene/lints/{code}.html"))
}

/// selene emits json2: one JSON object per line, already 0-based.
pub fn selene_files(cmd: &Path, files: &[PathBuf]) -> Result<Vec<FileIssue>> {
    let config = files
        .first()
        .and_then(|f| nearest_ancestor_file(f, "selene.toml"));
    let config_arg = config.map(|p| p.to_string_lossy().into_owned());
    let mut args = vec!["--display-style", "json2"];
    if let Some(c) = &config_arg {
        args.extend_from_slice(&["--config", c]);
    }
    selene_parse(&run(cmd, &args, files, None)?)
}

/// Lint an unsaved buffer. selene reads `-` as stdin and reports the filename
/// as "-", so the caller owns the path.
pub fn selene_stdin(cmd: &Path, path: &Path, text: &str) -> Result<Vec<Issue>> {
    let config = nearest_ancestor_file(path, "selene.toml");
    let config_arg = config.map(|p| p.to_string_lossy().into_owned());
    let mut args = vec!["--display-style", "json2"];
    if let Some(c) = &config_arg {
        args.extend_from_slice(&["--config", c]);
    }
    args.push("-");
    Ok(selene_parse(&run(cmd, &args, &[], Some(text))?)?
        .into_iter()
        .map(|f| f.issue)
        .collect())
}

fn selene_parse(stdout: &[u8]) -> Result<Vec<FileIssue>> {
    let mut out = Vec::new();
    for line in stdout.split(|&b| b == b'\n').filter(|l| !l.is_empty()) {
        let Ok(item) = serde_json::from_slice::<SeleneItem>(line) else {
            continue; // Summary line and other non-diagnostic records
        };
        if item.kind != "Diagnostic" {
            continue;
        }
        out.push(FileIssue {
            file: PathBuf::from(item.primary_label.filename),
            issue: Issue {
                line: item.primary_label.span.start_line,
                col: item.primary_label.span.start_column,
                end_line: item.primary_label.span.end_line,
                end_col: item.primary_label.span.end_column,
                severity: if item.severity == "Error" {
                    Severity::Error
                } else {
                    Severity::Warning
                },
                url: selene_url(&item.code),
                code: item.code,
                message: item.message,
                source: "selene",
                fix: None,
            },
        });
    }
    Ok(out)
}

// ── swiftlint ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SwiftlintItem {
    /// null in stdin mode, and for whole-file violations.
    file: Option<String>,
    line: Option<u32>,
    character: Option<u32>,
    severity: String,
    rule_id: String,
    reason: String,
}

/// One page per rule, named by `rule_id`. swiftlint knows which of its rules
/// are correctable, but only as a column in `swiftlint rules` -- a second
/// subprocess per run to learn something the violation itself never says, so
/// poly reports the page and leaves the remedy to it.
fn swiftlint_url(rule_id: &str) -> String {
    format!("https://realm.github.io/SwiftLint/{rule_id}.html")
}

fn swiftlint_parse(stdout: &[u8], fallback: &Path) -> Result<Vec<FileIssue>> {
    // No violations means no output at all, not an empty array.
    if stdout.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }
    let items: Vec<SwiftlintItem> =
        serde_json::from_slice(stdout).context("parsing swiftlint output")?;
    Ok(items
        .into_iter()
        .map(|i| {
            let line = i.line.unwrap_or(1).saturating_sub(1);
            let col = i.character.unwrap_or(1).saturating_sub(1);
            FileIssue {
                file: i.file.map_or_else(|| fallback.to_path_buf(), PathBuf::from),
                issue: Issue {
                    line,
                    col,
                    end_line: line,
                    end_col: col + 1,
                    severity: if i.severity.eq_ignore_ascii_case("error") {
                        Severity::Error
                    } else {
                        Severity::Warning
                    },
                    url: Some(swiftlint_url(&i.rule_id)),
                    code: i.rule_id,
                    message: i.reason,
                    source: "swiftlint",
                    fix: None,
                },
            }
        })
        .collect())
}

pub fn swiftlint_files(cmd: &Path, files: &[PathBuf]) -> Result<Vec<FileIssue>> {
    let stdout = run(cmd, &["lint", "--reporter", "json"], files, None)?;
    swiftlint_parse(&stdout, Path::new(""))
}

pub fn swiftlint_stdin(cmd: &Path, path: &Path, text: &str) -> Result<Vec<Issue>> {
    let stdout = run(
        cmd,
        &["lint", "--reporter", "json", "--use-stdin"],
        &[],
        Some(text),
    )?;
    Ok(swiftlint_parse(&stdout, path)?
        .into_iter()
        .map(|f| f.issue)
        .collect())
}

// ── tflint (directory semantics) ───────────────────────────────────────────

#[derive(Deserialize)]
struct TflintPos {
    line: u32,
    column: u32,
}

#[derive(Deserialize)]
struct TflintRange {
    filename: String,
    start: TflintPos,
    end: TflintPos,
}

#[derive(Deserialize)]
struct TflintRule {
    name: String,
    severity: String,
    /// tflint ships each rule's documentation URL, pinned to the ruleset
    /// version that produced the finding — better than anything poly could
    /// derive, which would point at whatever the ruleset says today.
    #[serde(default)]
    link: String,
}

#[derive(Deserialize)]
struct TflintItem {
    rule: TflintRule,
    message: String,
    range: TflintRange,
    /// Whether `tflint --fix` rewrites this one.
    #[serde(default)]
    fixable: bool,
}

#[derive(Deserialize)]
struct TflintOutput {
    issues: Vec<TflintItem>,
}

/// tflint works per directory: reduce the .tf file list to unique parent
/// dirs and run once per dir. With --chdir, tflint maps issue filenames
/// back to the original cwd, so they are used as-is (no dir join).
pub fn tflint_files(cmd: &Path, files: &[PathBuf]) -> Result<Vec<FileIssue>> {
    let mut dirs: Vec<PathBuf> = files
        .iter()
        .map(|f| {
            f.parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."))
        })
        .collect();
    dirs.sort();
    dirs.dedup();
    let mut out = Vec::new();
    for dir in dirs {
        let chdir = format!("--chdir={}", dir.display());
        out.extend(tflint_parse(&run(
            cmd,
            &["--format", "json", &chdir],
            &[],
            None,
        )?)?);
    }
    Ok(out)
}

fn tflint_parse(stdout: &[u8]) -> Result<Vec<FileIssue>> {
    let parsed: TflintOutput = serde_json::from_slice(stdout).context("parsing tflint output")?;
    Ok(parsed
        .issues
        .into_iter()
        .map(|i| FileIssue {
            file: PathBuf::from(i.range.filename),
            issue: Issue {
                line: i.range.start.line.saturating_sub(1),
                col: i.range.start.column.saturating_sub(1),
                end_line: i.range.end.line.saturating_sub(1),
                end_col: i.range.end.column.saturating_sub(1),
                severity: if i.rule.severity == "error" {
                    Severity::Error
                } else {
                    Severity::Warning
                },
                code: i.rule.name,
                message: i.message,
                source: "tflint",
                fix: i.fixable.then_some(Fix::Automatic),
                url: (!i.rule.link.is_empty()).then_some(i.rule.link),
            },
        })
        .collect())
}

// ── golangci-lint (module semantics) ───────────────────────────────────────

#[derive(Deserialize)]
struct GolangciPos {
    #[serde(rename = "Filename")]
    filename: String,
    #[serde(rename = "Line")]
    line: u32,
    #[serde(rename = "Column")]
    column: u32,
}

#[derive(Deserialize)]
struct GolangciFix {
    #[serde(rename = "Message")]
    message: String,
}

#[derive(Deserialize)]
struct GolangciItem {
    #[serde(rename = "FromLinter")]
    from_linter: String,
    #[serde(rename = "Text")]
    text: String,
    #[serde(rename = "Pos")]
    pos: GolangciPos,
    /// Present when the analyzer computed an edit `golangci-lint --fix` would
    /// apply. The edit itself is byte offsets into the file poly is not
    /// rewriting; the message describing it is the useful half.
    #[serde(rename = "SuggestedFixes", default)]
    suggested_fixes: Vec<GolangciFix>,
}

/// golangci-lint documents every linter on one page, one anchor per linter.
/// The anchor form is the one the site's own linter index links to.
fn golangci_url(linter: &str) -> String {
    format!("https://golangci-lint.run/docs/linters/configuration/#{linter}")
}

#[derive(Deserialize)]
struct GolangciOutput {
    #[serde(rename = "Issues", default)]
    issues: Vec<GolangciItem>,
}

/// golangci-lint works per module: reduce .go files to their go.mod roots
/// and run `./...` once per module.
pub fn golangci_files(cmd: &Path, files: &[PathBuf]) -> Result<Vec<FileIssue>> {
    let mut roots: Vec<PathBuf> = files.iter().filter_map(|f| go_module_root(f)).collect();
    roots.sort();
    roots.dedup();
    let mut out = Vec::new();
    for root in roots {
        let output = Command::new(cmd)
            .args([
                "run",
                "--output.json.path",
                "stdout",
                "--path-mode",
                "abs",
                "./...",
            ])
            .current_dir(&root)
            .stdout(Stdio::piped())
            // Refusals ("parallel golangci-lint is running", bad config, a
            // module that will not build) only show up on stderr; without it
            // the failure reads as "empty output" and says nothing useful.
            .stderr(Stdio::piped())
            .output()
            .with_context(|| format!("running {}", cmd.display()))?;
        // stdout carries the JSON document followed by a text summary; take
        // only the first JSON value.
        let parsed: GolangciOutput = serde_json::Deserializer::from_slice(&output.stdout)
            .into_iter()
            .next()
            .with_context(|| {
                let stderr = String::from_utf8_lossy(&output.stderr);
                match stderr.lines().find(|l| !l.trim().is_empty()) {
                    Some(line) => format!("golangci-lint produced no output: {line}"),
                    None => "golangci-lint produced no output".to_string(),
                }
            })?
            .context("parsing golangci-lint output")?;
        out.extend(golangci_issues(parsed, &root));
    }
    Ok(out)
}

/// Kept separate from the run so the shape can be tested: `SuggestedFixes` and
/// the linter name are the two fields poly reports beyond position and text,
/// and both are silently absent if golangci-lint renames them.
fn golangci_issues(parsed: GolangciOutput, root: &Path) -> Vec<FileIssue> {
    parsed
        .issues
        .into_iter()
        .map(|i| {
            let file = PathBuf::from(&i.pos.filename);
            FileIssue {
                file: if file.is_absolute() {
                    file
                } else {
                    root.join(file)
                },
                issue: Issue {
                    line: i.pos.line.saturating_sub(1),
                    col: i.pos.column.saturating_sub(1),
                    end_line: i.pos.line.saturating_sub(1),
                    end_col: i.pos.column.max(1),
                    severity: Severity::Warning,
                    url: Some(golangci_url(&i.from_linter)),
                    code: i.from_linter,
                    message: i.text,
                    source: "golangci-lint",
                    // safe: golangci-lint offers no notion of a risky fix, so
                    // there is nothing to warn about. Only ruff makes that
                    // distinction, and inventing it here would be a claim the
                    // tool never made.
                    fix: i
                        .suggested_fixes
                        .into_iter()
                        .next()
                        .map(|f| Fix::Described {
                            what: f.message,
                            safe: true,
                        }),
                },
            }
        })
        .collect()
}

fn go_module_root(file: &Path) -> Option<PathBuf> {
    let start = std::path::absolute(file).ok()?;
    let mut dir = start.parent()?;
    loop {
        if dir.join("go.mod").is_file() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
}

// ── eslint (project-local) ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct EslintMessage {
    #[serde(rename = "ruleId")]
    rule_id: Option<String>,
    severity: u8,
    message: String,
    line: Option<u32>,
    column: Option<u32>,
    #[serde(rename = "endLine")]
    end_line: Option<u32>,
    #[serde(rename = "endColumn")]
    end_column: Option<u32>,
    /// The replacement `eslint --fix` would apply; absent when the rule has
    /// no fixer. Like shellcheck it never says what the change is in words.
    fix: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct EslintFile {
    #[serde(rename = "filePath")]
    file_path: String,
    messages: Vec<EslintMessage>,
}

pub fn eslint_files(cmd: &Path, files: &[PathBuf]) -> Result<Vec<FileIssue>> {
    eslint_parse(&run(cmd, &["--format", "json"], files, None)?)
}

/// Lint an unsaved buffer. eslint resolves its flat config from the *cwd*, so
/// the run happens in the project root -- `cmd` is
/// `<root>/node_modules/.bin/eslint`, which is how the caller found it.
pub fn eslint_stdin(cmd: &Path, path: &Path, text: &str) -> Result<Vec<Issue>> {
    let path_arg = path.to_string_lossy();
    let mut command = Command::new(cmd);
    command.args(["--stdin", "--stdin-filename", &path_arg, "--format", "json"]);
    if let Some(root) = crate::project::root_of(cmd) {
        command.current_dir(root);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("running {}", cmd.display()))?;
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(text.as_bytes())?;
    let out = child.wait_with_output()?;
    Ok(eslint_parse(&out.stdout)?
        .into_iter()
        .map(|f| f.issue)
        .collect())
}

// ── biome ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(untagged)]
enum BiomePath {
    /// biome 2.x
    Plain(String),
    /// biome 1.x
    File { file: String },
}

#[derive(Deserialize)]
struct BiomePoint {
    line: u32,
    column: u32,
}

#[derive(Deserialize)]
struct BiomeLocation {
    path: BiomePath,
    start: BiomePoint,
    end: BiomePoint,
}

#[derive(Deserialize)]
struct BiomeDiagnostic {
    severity: String,
    message: String,
    category: String,
    location: BiomeLocation,
}

#[derive(Deserialize)]
struct BiomeOutput {
    diagnostics: Vec<BiomeDiagnostic>,
}

/// A biome category is `lint/<group>/<camelCaseRule>`, and the rule pages are
/// keyed by the kebab-cased rule alone -- the group is presentational and does
/// not appear in the URL. Only lint categories get a page: `format`, `parse`
/// and `internalError/*` are not rules and have nothing to link to.
fn biome_url(category: &str) -> Option<String> {
    let mut parts = category.split('/');
    if parts.next()? != "lint" {
        return None;
    }
    let (_group, rule) = (parts.next()?, parts.next()?);
    if parts.next().is_some() || rule.is_empty() {
        return None;
    }
    let mut slug = String::with_capacity(rule.len() + 4);
    for c in rule.chars() {
        if c.is_ascii_uppercase() && !slug.is_empty() {
            slug.push('-');
        }
        slug.push(c.to_ascii_lowercase());
    }
    Some(format!("https://biomejs.dev/linter/rules/{slug}/"))
}

/// biome ignores `--reporter` in stdin mode (it echoes the content to stdout
/// and prints a human message to stderr), so lint always runs over real
/// files. That is fine for lint-on-save, where the buffer is already on disk.
pub fn biome_files(cmd: &Path, root: &Path, files: &[PathBuf]) -> Result<Vec<FileIssue>> {
    let stdout = run_in(cmd, root, &["lint", "--reporter=json"], files, None)?;
    biome_parse(&stdout, root)
}

fn biome_parse(stdout: &[u8], root: &Path) -> Result<Vec<FileIssue>> {
    let parsed: BiomeOutput = serde_json::from_slice(stdout).context("parsing biome output")?;
    Ok(parsed
        .diagnostics
        .into_iter()
        .map(|d| {
            let file = match d.location.path {
                BiomePath::Plain(p) => PathBuf::from(p),
                BiomePath::File { file } => PathBuf::from(file),
            };
            FileIssue {
                // Paths come back relative to the directory biome ran in.
                file: if file.is_absolute() {
                    file
                } else {
                    root.join(file)
                },
                issue: Issue {
                    line: d.location.start.line.saturating_sub(1),
                    col: d.location.start.column.saturating_sub(1),
                    end_line: d.location.end.line.saturating_sub(1),
                    end_col: d.location.end.column.saturating_sub(1),
                    severity: match d.severity.as_str() {
                        "error" | "fatal" => Severity::Error,
                        "warning" => Severity::Warning,
                        "information" => Severity::Info,
                        _ => Severity::Hint,
                    },
                    url: biome_url(&d.category),
                    code: d.category,
                    message: d.message,
                    source: "biome",
                    fix: None,
                },
            }
        })
        .collect())
}

fn eslint_parse(stdout: &[u8]) -> Result<Vec<FileIssue>> {
    let parsed: Vec<EslintFile> =
        serde_json::from_slice(stdout).context("parsing eslint output")?;
    let mut out = Vec::new();
    for f in parsed {
        for m in f.messages {
            let line = m.line.unwrap_or(1).saturating_sub(1);
            let col = m.column.unwrap_or(1).saturating_sub(1);
            out.push(FileIssue {
                file: PathBuf::from(&f.file_path),
                issue: Issue {
                    line,
                    col,
                    end_line: m.end_line.map_or(line, |l| l.saturating_sub(1)),
                    end_col: m.end_column.map_or(col + 1, |c| c.saturating_sub(1)),
                    severity: if m.severity >= 2 {
                        Severity::Error
                    } else {
                        Severity::Warning
                    },
                    code: m.rule_id.unwrap_or_else(|| "eslint".to_string()),
                    message: m.message,
                    source: "eslint",
                    fix: m.fix.is_some().then_some(Fix::Automatic),
                    url: None,
                },
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_shellcheck_json() {
        let raw = br#"[{"file":"a.sh","line":2,"endLine":2,"column":6,"endColumn":9,"level":"warning","code":2086,"message":"Double quote"}]"#;
        let issues = shellcheck_parse(raw).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].issue.code, "SC2086");
        assert_eq!(issues[0].issue.line, 1);
    }

    #[test]
    fn typos_paths_are_rebased_on_the_config_root() {
        // `poly check some/repo` from outside used to hand typos
        // "some/repo" with patterns written relative to some/repo/poly.toml,
        // so nothing matched and every excluded file got reported.
        let root = PathBuf::from("some/repo");
        let scoped = scope_to_root(
            &[root.clone(), root.join("cli"), PathBuf::from("/elsewhere")],
            Some(&root),
        );
        assert_eq!(
            scoped,
            vec![
                PathBuf::from("."),
                PathBuf::from("cli"),
                PathBuf::from("/elsewhere"),
            ]
        );
        // No config root: paths must stay exactly as the user typed them.
        let bare = [PathBuf::from("some/repo")];
        assert_eq!(scope_to_root(&bare, None), bare);
    }

    #[test]
    fn parses_typos_lines() {
        // typos_paths spawns a real binary; parse path exercised via the
        // line format contract here.
        let line = br#"{"type":"typo","path":"a.md","line_num":3,"byte_offset":4,"typo":"teh","corrections":["the"]}"#;
        let TyposRecord::Typo(item) = serde_json::from_slice(line).unwrap() else {
            panic!("expected a typo record");
        };
        assert_eq!(item.corrections, vec!["the"]);

        // Any repo with a binary file gets these interleaved; treating them as
        // typo records aborted the entire check run.
        let skipped = br#"{"type":"binary_file","path":"a.bin"}"#;
        assert!(matches!(
            serde_json::from_slice::<TyposRecord>(skipped).unwrap(),
            TyposRecord::Other
        ));

        // A typo in the file name is still type "typo" but carries no line.
        let in_name =
            br#"{"type":"typo","path":"varialbles.tf","byte_offset":0,"typo":"varialbles","corrections":["variables"]}"#;
        let TyposRecord::Typo(item) = serde_json::from_slice(in_name).unwrap() else {
            panic!("expected a typo record");
        };
        assert_eq!(item.line_num, None);
    }

    #[test]
    fn parses_selene_json2() {
        // json2 is already 0-based, and the Summary line must not become an
        // issue. Both the file and the stdin runner go through this.
        let raw = br#"{"type":"Diagnostic","severity":"Error","code":"undefined_variable","message":"`y` is not defined","primary_label":{"filename":"-","span":{"start":18,"start_line":1,"start_column":6,"end":19,"end_line":1,"end_column":7}},"notes":[],"secondary_labels":[]}
{"type":"Summary","errors":1,"warnings":0,"parse_errors":0}"#;
        let issues = selene_parse(raw).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].issue.line, 1);
        assert_eq!(issues[0].issue.col, 6);
        assert_eq!(issues[0].issue.severity, Severity::Error);
    }

    /// tflint is the one tool that hands over both halves itself: a
    /// version-pinned rule URL and whether `--fix` rewrites the finding.
    /// Sampled from tflint 0.64.0.
    #[test]
    fn tflint_reports_its_own_link_and_fixability() {
        let raw = br#"{"issues":[
          {"rule":{"name":"terraform_required_version","severity":"warning",
            "link":"https://github.com/terraform-linters/tflint-ruleset-terraform/blob/v0.15.0/docs/rules/terraform_required_version.md"},
           "message":"terraform \"required_version\" attribute is required",
           "range":{"filename":"main.tf","start":{"line":1,"column":1},"end":{"line":1,"column":1}},
           "callers":[],"fixable":true,"fixed":false},
          {"rule":{"name":"terraform_comment_syntax","severity":"notice","link":""},
           "message":"Single line comments should begin with #",
           "range":{"filename":"main.tf","start":{"line":9,"column":1},"end":{"line":9,"column":3}},
           "callers":[],"fixable":false,"fixed":false}
        ]}"#;
        let issues = tflint_parse(raw).unwrap();
        assert_eq!(issues[0].issue.fix, Some(Fix::Automatic));
        assert!(issues[0].issue.url.as_deref().unwrap().ends_with(
            "tflint-ruleset-terraform/blob/v0.15.0/docs/rules/terraform_required_version.md"
        ));
        // A rule with no link must not get an empty string dressed up as one.
        assert_eq!(issues[1].issue.fix, None);
        assert_eq!(issues[1].issue.url, None);
    }

    /// golangci-lint already computes the edit `--fix` would apply and
    /// describes it; poly reports the description without applying anything.
    /// Sampled from golangci-lint 2.13.1 (staticcheck).
    #[test]
    fn golangci_reports_the_suggested_fix_and_its_linter_docs() {
        let raw = br#"{"Issues":[
          {"FromLinter":"staticcheck",
           "Text":"ST1023: should omit type int from declaration; it will be inferred from the right-hand side",
           "Pos":{"Filename":"main.go","Offset":49,"Line":6,"Column":8},
           "SuggestedFixes":[{"Message":"Remove redundant type","TextEdits":[{"Pos":49,"End":52,"NewText":null}]}]},
          {"FromLinter":"staticcheck","Text":"SA9003: empty branch",
           "Pos":{"Filename":"main.go","Offset":77,"Line":8,"Column":2}}
        ]}"#;
        let parsed: GolangciOutput = serde_json::from_slice(raw).unwrap();
        let issues = golangci_issues(parsed, Path::new("/repo"));

        assert_eq!(issues[0].file, Path::new("/repo/main.go"));
        assert_eq!(
            issues[0].issue.fix,
            Some(Fix::Described {
                what: "Remove redundant type".to_string(),
                safe: true
            })
        );
        assert_eq!(
            issues[0].issue.url.as_deref(),
            Some("https://golangci-lint.run/docs/linters/configuration/#staticcheck")
        );
        // No SuggestedFixes key at all: still a valid issue, just no remedy.
        assert_eq!(issues[1].issue.fix, None);
        assert!(issues[1].issue.url.is_some());
    }

    #[test]
    fn ruff_notebook_rows_name_their_cell() {
        // Notebook rows are cell-relative, so line 1 of cell 2 is not line 1
        // of the .ipynb; the message has to say which cell.
        let raw = br#"[{"filename":"a.ipynb","code":"F401","message":"`os` imported but unused","location":{"row":1,"column":8},"end_location":{"row":1,"column":10},"cell":2}]"#;
        let issues = ruff_parse(raw).unwrap();
        assert_eq!(issues[0].issue.message, "cell 2: `os` imported but unused");

        // A .py file has no cell and must not gain a prefix.
        let plain = br#"[{"filename":"a.py","code":"F401","message":"unused","location":{"row":1,"column":1},"end_location":{"row":1,"column":2}}]"#;
        let issues = ruff_parse(plain).unwrap();
        assert_eq!(issues[0].issue.message, "unused");
    }

    #[test]
    fn parses_swiftlint_json() {
        // stdin mode reports file: null, so the caller's path fills in.
        let raw = br#"[{"character":7,"file":null,"line":4,"reason":"Variable name 'x' is too short","rule_id":"identifier_name","severity":"Error","type":"Identifier Name"}]"#;
        let issues = swiftlint_parse(raw, Path::new("/w/a.swift")).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].file, PathBuf::from("/w/a.swift"));
        assert_eq!(issues[0].issue.line, 3);
        assert_eq!(issues[0].issue.col, 6);
        assert_eq!(issues[0].issue.severity, Severity::Error);

        // A clean run prints nothing at all rather than "[]".
        assert!(swiftlint_parse(b"\n", Path::new("/w/a.swift"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn parses_biome_json() {
        // Positions are 1-based and paths come back relative to the run root.
        let raw = br#"{"summary":{},"diagnostics":[{"severity":"warning","message":"Unexpected any.","category":"lint/suspicious/noExplicitAny","location":{"path":"src/c.ts","start":{"line":1,"column":22},"end":{"line":1,"column":25}},"advices":[]}],"command":"lint"}"#;
        let issues = biome_parse(raw, Path::new("/w")).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].file, PathBuf::from("/w/src/c.ts"));
        assert_eq!(issues[0].issue.line, 0);
        assert_eq!(issues[0].issue.col, 21);
        assert_eq!(issues[0].issue.code, "lint/suspicious/noExplicitAny");

        // biome 1.x nested the path one level deeper.
        let old = br#"{"diagnostics":[{"severity":"error","message":"x","category":"lint/a/b","location":{"path":{"file":"/abs/a.ts"},"start":{"line":2,"column":1},"end":{"line":2,"column":2}}}]}"#;
        let issues = biome_parse(old, Path::new("/w")).unwrap();
        assert_eq!(issues[0].file, PathBuf::from("/abs/a.ts"));
        assert_eq!(issues[0].issue.severity, Severity::Error);
    }

    /// actionlint's reference lives inside the prose, so the docs slot is
    /// filled by moving it rather than by deriving anything. Sampled from
    /// actionlint 1.7.12.
    #[test]
    fn actionlint_moves_its_inline_reference_into_the_docs_slot() {
        let raw = br#"[{"message":"\"github.event.issue.title\" is potentially untrusted. avoid using it directly in inline scripts. see https://docs.github.com/en/actions/reference/security/secure-use#good-practices for more details","filepath":".github/workflows/w.yml","line":12,"column":15,"kind":"expression"},
          {"message":"the runner of \"actions/checkout@v1\" action is too old to run on GitHub Actions. update the action's version to fix this issue","filepath":".github/workflows/w.yml","line":9,"column":9,"kind":"action"}]"#;
        let issues = actionlint_parse(raw).unwrap();
        assert_eq!(
            issues[0].issue.url.as_deref(),
            Some("https://docs.github.com/en/actions/reference/security/secure-use#good-practices")
        );
        // The clause is moved, not copied: no URL survives in the message.
        assert!(
            issues[0].issue.message.ends_with("inline scripts."),
            "{:?}",
            issues[0].issue.message
        );
        // Most checks have no reference at all, and their prose is untouched.
        assert_eq!(issues[1].issue.url, None);
        assert!(issues[1].issue.message.ends_with("to fix this issue"));
    }

    /// These three tools name their rules well enough that the documentation
    /// URL falls out of the code, so poly derives it instead of shipping a
    /// table that would rot. Every scheme below was checked against the live
    /// sites: a real rule resolves and an invented one 404s, so a derivation
    /// that drifts shows up as a dead link rather than a wrong page.
    #[test]
    fn documentation_urls_are_derived_from_the_rule_code() {
        assert_eq!(
            selene_url("unused_variable").as_deref(),
            Some("https://kampfkarren.github.io/selene/lints/unused_variable.html")
        );
        // Invalid Lua is not a lint and has no page.
        assert_eq!(selene_url("parse_error"), None);

        assert_eq!(
            swiftlint_url("identifier_name"),
            "https://realm.github.io/SwiftLint/identifier_name.html"
        );

        // The group is dropped and the camelCase rule becomes the slug.
        assert_eq!(
            biome_url("lint/correctness/noUnusedVariables").as_deref(),
            Some("https://biomejs.dev/linter/rules/no-unused-variables/")
        );
        assert_eq!(
            biome_url("lint/style/useConst").as_deref(),
            Some("https://biomejs.dev/linter/rules/use-const/")
        );
        // Everything biome reports that is not a lint rule.
        assert_eq!(biome_url("format"), None);
        assert_eq!(biome_url("internalError/io"), None);
        assert_eq!(biome_url("assist/source/organizeImports"), None);
    }

    #[test]
    fn parses_eslint_json() {
        // Same shape from --stdin as from a file list, which is why both
        // runners share this parse.
        let raw = br#"[{"filePath":"/w/a.ts","messages":[{"ruleId":"no-var","severity":2,"message":"Unexpected var","line":1,"column":1,"endLine":1,"endColumn":10}]}]"#;
        let issues = eslint_parse(raw).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].issue.code, "no-var");
        assert_eq!(issues[0].issue.line, 0);
        assert_eq!(issues[0].issue.severity, Severity::Error);
    }
}

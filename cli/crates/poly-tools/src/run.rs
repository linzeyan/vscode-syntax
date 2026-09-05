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

fn run(cmd: &Path, args: &[&str], files: &[PathBuf], stdin: Option<&str>) -> Result<Vec<u8>> {
    run_impl(cmd, None, args, files, stdin, None)
}

/// Same, but rooted at `cwd` for tools that resolve config relative to it.
fn run_in(
    cmd: &Path,
    cwd: &Path,
    args: &[&str],
    files: &[PathBuf],
    stdin: Option<&str>,
) -> Result<Vec<u8>> {
    run_impl(cmd, Some(cwd), args, files, stdin, None)
}

fn run_impl(
    cmd: &Path,
    cwd: Option<&Path>,
    args: &[&str],
    files: &[PathBuf],
    stdin: Option<&str>,
    path: Option<std::ffi::OsString>,
) -> Result<Vec<u8>> {
    let mut command = Command::new(cmd);
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    // Only actionlint needs this: it is the one tool that shells out to
    // another tool poly resolves.
    if let Some(path) = path {
        command.env("PATH", path);
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

/// actionlint runs shellcheck over every `run:` block, but only if it finds
/// one on PATH -- and poly resolves shellcheck itself, into a cache directory
/// that is on nobody's PATH. Without this, poly's answer depends on whether
/// the developer happened to install shellcheck separately: this repo's own CI
/// reported two SC findings that no local run could reproduce, because GitHub
/// runners ship shellcheck and a laptop does not. Handing over the one poly
/// already manages is what makes the two agree.
fn with_shellcheck(shellcheck: Option<&Path>) -> Option<std::ffi::OsString> {
    let dir = shellcheck?.parent()?;
    let mut dirs = vec![dir.to_path_buf()];
    dirs.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    std::env::join_paths(dirs).ok()
}

pub fn actionlint_files(
    cmd: &Path,
    files: &[PathBuf],
    shellcheck: Option<&Path>,
) -> Result<Vec<FileIssue>> {
    let args = ["-format", "{{json .}}"];
    let out = run_impl(cmd, None, &args, files, None, with_shellcheck(shellcheck))?;
    actionlint_parse(&out)
}

pub fn actionlint_stdin(cmd: &Path, text: &str, shellcheck: Option<&Path>) -> Result<Vec<Issue>> {
    let args = ["-format", "{{json .}}", "-"];
    let out = run_impl(
        cmd,
        None,
        &args,
        &[],
        Some(text),
        with_shellcheck(shellcheck),
    )?;
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
    let stdout = run_impl(cmd, root, &args, &scoped, None, None)?;
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

// ── deadcode (whole-program reachability) ──────────────────────────────────

#[derive(Deserialize)]
struct DeadPosition {
    #[serde(rename = "File")]
    file: String,
    #[serde(rename = "Line")]
    line: u32,
    #[serde(rename = "Col")]
    col: u32,
}

#[derive(Deserialize)]
struct DeadFunc {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Position")]
    position: DeadPosition,
    /// Machine-written code, which nobody is going to delete by hand and which
    /// is unreachable in every generated stub that ships more than it uses.
    #[serde(rename = "Generated", default)]
    generated: bool,
}

#[derive(Deserialize)]
struct DeadPackage {
    #[serde(rename = "Funcs")]
    funcs: Vec<DeadFunc>,
}

/// Functions no path from `main` can reach, for one module.
///
/// A different question from golangci-lint's `unused`, which is why both exist:
/// `unused` asks "does anything in this package name it", so an exported
/// function is never unused to it — someone outside might call it. deadcode
/// builds the call graph from the entry points and asks "does anything actually
/// run it", which is the question you ask before deleting something. Tooltitude
/// answers it with an index of its own; this is the Go team's answer, in
/// golang.org/x/tools, and poly's job is to run it (R7).
///
/// Run in the module rather than pointed at it: deadcode reports paths relative
/// to its working directory, and joining them is exact. Same trade as
/// `tflint_dir`, learned the same way.
pub fn deadcode_module(cmd: &Path, root: &Path) -> Result<Vec<FileIssue>> {
    let patterns = deadcode_patterns(root)?;
    if patterns.is_empty() {
        return Ok(Vec::new());
    }
    let output = Command::new(cmd)
        .arg("-json")
        .args(&patterns)
        .current_dir(root)
        .stdout(Stdio::piped())
        // A module that will not build says so here and prints nothing to
        // stdout; without this the failure reads as "no dead code".
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("running {}", cmd.display()))?;
    if !output.status.success() {
        return Err(anyhow!(
            "deadcode: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    // `null`, not `[]`, is what it prints when it found nothing — and "nothing
    // unreachable" is the answer this command most wants to be able to give.
    let packages: Option<Vec<DeadPackage>> =
        serde_json::from_slice(&output.stdout).context("parsing deadcode output")?;
    Ok(packages
        .unwrap_or_default()
        .into_iter()
        .flat_map(|package| package.funcs)
        .filter(|found| !found.generated)
        .map(|found| FileIssue {
            file: root.join(&found.position.file),
            issue: Issue {
                line: found.position.line.saturating_sub(1),
                col: found.position.col.saturating_sub(1),
                end_line: found.position.line.saturating_sub(1),
                end_col: found.position.col.max(1),
                severity: Severity::Warning,
                code: "unreachable".to_string(),
                message: format!("func {} is never called", found.name),
                source: "deadcode",
                // Deleting it is the obvious remedy and often the wrong one:
                // the call may be in a test, behind a build tag, or in another
                // module. Saying "poly can fix this" about that would be a
                // claim poly cannot stand behind.
                fix: None,
                url: Some("https://pkg.go.dev/golang.org/x/tools/cmd/deadcode".to_string()),
            },
        })
        .collect())
}

// ── knip (unused files and exports, JS/TS) ─────────────────────────────────

/// One file's worth of knip findings. knip reports a dozen categories; these
/// are the three that mean "nothing reaches this code".
#[derive(Deserialize)]
struct KnipFile {
    file: String,
    #[serde(default)]
    files: Vec<KnipNamed>,
    #[serde(default)]
    exports: Vec<KnipExport>,
    #[serde(default)]
    types: Vec<KnipExport>,
}

#[derive(Deserialize)]
struct KnipNamed {
    #[allow(dead_code)]
    name: String,
}

#[derive(Deserialize)]
struct KnipExport {
    name: String,
    line: u32,
    col: u32,
}

#[derive(Deserialize)]
struct KnipOutput {
    issues: Vec<KnipFile>,
}

/// Files nothing imports and exports nothing imports, for a JS/TS project.
///
/// The same question `deadcode` answers for Go, asked the way JavaScript makes
/// it askable: knip starts from the entry points package.json already declares
/// and reports what no path from them reaches.
///
/// Only `files`, `exports` and `types` are reported. knip also finds unlisted
/// and unused *dependencies*, which is a real problem and a different one --
/// dependency hygiene is about package.json, not about code nothing runs, and
/// mixing them would make this command's answer impossible to act on in one
/// pass.
///
/// Run in the project rather than pointed at it: knip reports paths relative to
/// its working directory. Same trade as `tflint_dir`, learned the same way.
pub fn knip_project(cmd: &Path, root: &Path) -> Result<Vec<FileIssue>> {
    let output = Command::new(cmd)
        .args(["--reporter", "json"])
        .current_dir(root)
        .stdout(Stdio::piped())
        // A project knip cannot resolve entry points for says so here and
        // prints nothing usable to stdout.
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("running {}", cmd.display()))?;
    let text = String::from_utf8_lossy(&output.stdout);
    // knip exits non-zero *because* it found something, so the status says
    // nothing on its own; empty stdout is what means it never ran.
    let Some(start) = text.find('{') else {
        return Err(anyhow!(
            "knip: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    };
    let parsed: KnipOutput = serde_json::from_str(&text[start..]).context("parsing knip output")?;
    let mut found = Vec::new();
    for entry in parsed.issues {
        let file = root.join(&entry.file);
        // A whole unreachable file is reported at its first line: knip gives no
        // position for it, and there is nothing inside it to point at.
        for _ in &entry.files {
            found.push(FileIssue {
                file: file.clone(),
                issue: Issue {
                    line: 0,
                    col: 0,
                    end_line: 0,
                    end_col: 1,
                    severity: Severity::Warning,
                    code: "unused-file".to_string(),
                    message: format!("nothing imports {}", entry.file),
                    source: "knip",
                    fix: None,
                    url: Some("https://knip.dev/reference/issue-types".to_string()),
                },
            });
        }
        for (export, kind) in entry
            .exports
            .iter()
            .map(|e| (e, "unused-export"))
            .chain(entry.types.iter().map(|e| (e, "unused-type")))
        {
            found.push(FileIssue {
                file: file.clone(),
                issue: Issue {
                    line: export.line.saturating_sub(1),
                    col: export.col.saturating_sub(1),
                    end_line: export.line.saturating_sub(1),
                    end_col: export.col.saturating_sub(1) + export.name.len() as u32,
                    severity: Severity::Warning,
                    code: kind.to_string(),
                    message: format!("nothing imports {}", export.name),
                    source: "knip",
                    // Deleting it is the obvious remedy and often the wrong
                    // one: the import may be in code knip cannot see, and
                    // saying "poly can fix this" would be a claim poly cannot
                    // stand behind. Same reasoning as deadcode.
                    fix: None,
                    url: Some("https://knip.dev/reference/issue-types".to_string()),
                },
            });
        }
    }
    Ok(found)
}

// ── vulture (unused code, Python) ──────────────────────────────────────────

/// Python code nothing appears to use, across the files it is given.
///
/// A file list and not a directory, which is the whole difference between this
/// being usable and not. vulture walks a directory itself and has no idea what
/// a virtualenv is: pointed at a project root it reports on every module inside
/// `venv/`, which on the fixture that found this was 353KB of findings about
/// pip's vendored copy of six. poly already knows which files are the
/// project's -- the same walk `poly check` uses, honouring .gitignore and
/// `[lint] exclude` -- so it hands them over rather than hoping.
///
/// vulture has no machine-readable output, so this parses the one line per
/// finding it prints:
///
///   path/to/app.py:5: unused function 'never_called' (60% confidence)
///
/// The confidence is kept in the message rather than dropped or turned into a
/// severity. It is vulture's own hedge about a dynamically dispatched language
/// -- 60% means "this name is never written down again", which getattr and
/// Django's URL routing both make false -- and hiding it would turn a hint into
/// a verdict poly has no basis for.
pub fn vulture_files(cmd: &Path, files: &[PathBuf]) -> Result<Vec<FileIssue>> {
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let mut command = Command::new(cmd);
    command
        // Every other Python tool poly drives already skips these -- ruff has
        // them in its own defaults -- so this is poly restoring the norm rather
        // than inventing a rule. It is a second line of defence behind the
        // walk: a virtualenv that nobody put in .gitignore still reaches this
        // far, and one such directory is thousands of findings about somebody
        // else's vendored code.
        .args([
            "--exclude",
            "*/venv/*,*/.venv/*,*/site-packages/*,*/.tox/*,*/node_modules/*,*/__pypackages__/*",
        ])
        .args(files.iter().map(|p| p.as_os_str()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = command
        .output()
        .with_context(|| format!("running {}", cmd.display()))?;
    // vulture exits 3 when it found something and 1 when it could not parse a
    // file, so the status alone cannot tell a finding from a failure; an empty
    // stdout is what means it never got as far as reporting.
    let text = String::from_utf8_lossy(&output.stdout);
    if text.trim().is_empty() && !output.status.success() {
        return Err(anyhow!(
            "vulture: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let here = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    Ok(text
        .lines()
        .filter_map(|line| vulture_line(line, &here))
        .collect())
}

/// One reported line, or `None` if it is not one.
///
/// Split out so the shape can be tested: the format is prose, and prose is
/// what changes between releases without anyone calling it a breaking change.
fn vulture_line(line: &str, root: &Path) -> Option<FileIssue> {
    // From the right, because a Windows path starts with `C:` and splitting
    // from the left would take the drive letter for the line number.
    let (position, rest) = line.split_once(": ")?;
    let (file, number) = position.rsplit_once(':')?;
    let number: u32 = number.parse().ok()?;
    let message = rest.trim().to_string();
    // "unused function 'x' (60% confidence)" -> "unused-function". The kind is
    // the only part stable enough to silence a rule by in poly.toml.
    let code = message
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join("-");
    let path = PathBuf::from(file);
    Some(FileIssue {
        file: if path.is_absolute() {
            path
        } else {
            root.join(path)
        },
        issue: Issue {
            line: number.saturating_sub(1),
            col: 0,
            end_line: number.saturating_sub(1),
            end_col: 1,
            severity: Severity::Warning,
            code,
            message,
            source: "vulture",
            fix: None,
            url: Some(
                "https://github.com/jendrikseipp/vulture#handling-false-positives".to_string(),
            ),
        },
    })
}

/// One package pattern per module in the build list.
///
/// `./...` is not it. From a workspace root — a directory holding go.work and
/// nothing else — Go rejects it outright: "directory prefix . does not contain
/// modules listed in go.work". The modules have to be named, and `go list -m`
/// is what names them: inside a workspace it lists every module go.work uses,
/// inside a plain module it lists that one. Reading go.work directly would be
/// poly reimplementing a file format whose owner ships a query for it.
///
/// Relative where it can be, because deadcode reports positions relative to its
/// working directory and a relative pattern keeps them short and joinable. A
/// go.work may `use` a directory outside its own tree, which is the case the
/// absolute arm is for.
fn deadcode_patterns(root: &Path) -> Result<Vec<String>> {
    let output = Command::new("go")
        .args(["list", "-m", "-f", "{{.Dir}}"])
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .context("running go list")?;
    if !output.status.success() {
        return Err(anyhow!(
            "go list: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|dir| match Path::new(dir).strip_prefix(root) {
            Ok(inside) if inside.as_os_str().is_empty() => "./...".to_string(),
            Ok(inside) => format!("./{}/...", inside.display()),
            Err(_) => format!("{dir}/..."),
        })
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
/// dirs and run once per dir.
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
        out.extend(tflint_dir(cmd, &dir)?);
    }
    Ok(out)
}

/// One directory's findings.
///
/// Split out for the daemon for the same reason `golangci_module` is: it knows
/// the directory from the file that was saved, and reducing a file list to the
/// same directory a second time is a second place the grouping could drift.
///
/// Run *in* the directory rather than pointed at it with `--chdir`. Both
/// inspect the same files, but they report different filenames: `--chdir` maps
/// them back to the cwd tflint was started in, which for the daemon is wherever
/// the editor happened to launch poly, and a path relative to that is not a
/// document anyone can attach a diagnostic to. From inside, the report is
/// relative to the directory itself and joining is exact — the same shape
/// `golangci_issues` uses.
pub fn tflint_dir(cmd: &Path, dir: &Path) -> Result<Vec<FileIssue>> {
    let found = tflint_parse(&run_in(cmd, dir, &["--format", "json"], &[], None)?)?;
    Ok(found
        .into_iter()
        .map(|mut issue| {
            issue.file = dir.join(issue.file);
            issue
        })
        .collect())
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
        out.extend(golangci_module(cmd, &root)?);
    }
    Ok(out)
}

/// One module's findings.
///
/// Split out for the daemon, which already knows the root from the file that
/// was saved. Going back through a file list only to have it mapped to the same
/// root again is a second place the grouping could drift, and the editor and CI
/// disagreeing about which files belong together is exactly what A4 forbids.
pub fn golangci_module(cmd: &Path, root: &Path) -> Result<Vec<FileIssue>> {
    let output = Command::new(cmd)
        .args([
            "run",
            "--output.json.path",
            "stdout",
            "--path-mode",
            "abs",
            "./...",
        ])
        .current_dir(root)
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
    Ok(golangci_issues(parsed, root))
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

// ── cargo clippy (whole workspace) ─────────────────────────────────────────

/// One `--message-format=json` line. Only `compiler-message` carries findings;
/// the artifact and build-finished lines are progress, not output.
#[derive(Deserialize)]
struct CargoLine {
    reason: String,
    message: Option<RustcDiagnostic>,
}

#[derive(Deserialize)]
struct RustcDiagnostic {
    message: String,
    level: String,
    code: Option<RustcCode>,
    spans: Vec<RustcSpan>,
    #[serde(default)]
    children: Vec<RustcDiagnostic>,
}

#[derive(Deserialize)]
struct RustcCode {
    code: String,
}

#[derive(Deserialize)]
struct RustcSpan {
    file_name: String,
    line_start: u32,
    line_end: u32,
    column_start: u32,
    column_end: u32,
    #[serde(default)]
    is_primary: bool,
    suggested_replacement: Option<String>,
    suggestion_applicability: Option<String>,
}

/// Findings for the whole cargo workspace rooted at `root`.
///
/// The Go analogue is exact: `golangci-lint ./...` from the module root reads
/// every package in the module, and `cargo clippy --all-targets` from the
/// workspace root reads every crate in the workspace. Both include tests, and
/// both are what `poly check` runs, so the editor cannot answer differently.
///
/// `--target-dir target/poly` is not tidiness. Sharing the default `target/`
/// means poly holds cargo's build lock on every save, and the human who typed
/// `cargo test` in a terminal waits on the editor. rust-analyzer keeps its own
/// directory for that exact reason. The cost is one more build tree; cargo
/// still recompiles it from scratch the first time, which is why this is a
/// linter you notice starting up rather than one that answers instantly.
pub fn clippy_workspace(cargo: &Path, root: &Path) -> Result<Vec<FileIssue>> {
    let output = Command::new(cargo)
        .args([
            "clippy",
            "--all-targets",
            "--message-format=json",
            "--quiet",
            "--target-dir",
            "target/poly",
        ])
        .current_dir(root)
        .stdout(Stdio::piped())
        // A missing clippy component, an unparsable Cargo.toml and a locked
        // target directory all report here and nowhere else; without it the
        // failure reads as "no findings", which is the opposite of the truth.
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("running {}", cargo.display()))?;
    let text = String::from_utf8_lossy(&output.stdout);
    // Nothing on stdout at all means cargo never got as far as compiling.
    // Exit status alone cannot say so: clippy exits 0 with warnings and
    // non-zero with errors, and errors are findings poly wants to report.
    if text.trim().is_empty() && !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("no output");
        anyhow::bail!("cargo clippy produced no output: {reason}");
    }
    let mut found = Vec::new();
    for line in text.lines().filter(|l| l.starts_with('{')) {
        // A line poly cannot parse is a cargo message shape it does not know,
        // not a reason to throw away the findings around it.
        let Ok(parsed) = serde_json::from_str::<CargoLine>(line) else {
            continue;
        };
        if parsed.reason != "compiler-message" {
            continue;
        }
        if let Some(message) = parsed.message {
            found.extend(clippy_issues(message, root));
        }
    }
    Ok(dedup_findings(found))
}

/// Drop the repeats `--all-targets` produces.
///
/// Measured, not anticipated: a `main.rs` is compiled as a bin *and* as its own
/// test harness, so clippy reports every finding in it twice, and a lib with
/// unit tests does the same. golangci-lint has no equivalent because `./...` is
/// one compilation of each package. Two identical entries are one mistake
/// reported from two compilation units, so the second is noise -- and it is
/// noise the editor would show as two overlapping squiggles.
fn dedup_findings(found: Vec<FileIssue>) -> Vec<FileIssue> {
    let mut seen = std::collections::HashSet::new();
    found
        .into_iter()
        .filter(|f| {
            seen.insert((
                f.file.clone(),
                f.issue.line,
                f.issue.col,
                f.issue.end_line,
                f.issue.end_col,
                f.issue.code.clone(),
                f.issue.message.clone(),
            ))
        })
        .collect()
}

/// The URL for a rule, when the code says which fixer produced it.
///
/// Only clippy's own lints have a stable page; a plain rustc lint like
/// `unused_variables` has no per-lint URL, and inventing one would be a link
/// poly never verified.
fn clippy_url(code: &str) -> Option<String> {
    code.strip_prefix("clippy::")
        .map(|rule| format!("https://rust-lang.github.io/rust-clippy/master/index.html#{rule}"))
}

/// Kept separate from the run so the shape can be tested.
///
/// One diagnostic becomes at most one issue: rustc reports a finding once with
/// several spans (the expression, the `help` rewrite, the note), and turning
/// each span into its own entry would put three Problems on one mistake.
fn clippy_issues(diagnostic: RustcDiagnostic, root: &Path) -> Vec<FileIssue> {
    let severity = match diagnostic.level.as_str() {
        "error" | "error: internal compiler error" => Severity::Error,
        "warning" => Severity::Warning,
        // note/help arrive as children of something already reported, and a
        // top-level one is a summary line ("aborting due to 2 errors").
        _ => return Vec::new(),
    };
    let Some(span) = diagnostic.spans.iter().find(|s| s.is_primary) else {
        // No span means it is about the build rather than about a place in it.
        return Vec::new();
    };
    let code = diagnostic
        .code
        .as_ref()
        .map_or_else(|| diagnostic.level.clone(), |c| c.code.clone());
    // The child that carries a replacement is the one that says what the fix
    // does; its own message ("remove `return`") is already the description.
    let fix = diagnostic
        .children
        .iter()
        .find(|child| {
            child
                .spans
                .iter()
                .any(|s| s.suggested_replacement.is_some())
        })
        .map(|child| Fix::Described {
            what: child.message.clone(),
            // rustc's own word. MaybeIncorrect and HasPlaceholders both mean
            // the rewrite may not compile, which is exactly what ruff's
            // "unsafe" warns about, so it is passed on rather than softened.
            safe: child
                .spans
                .iter()
                .any(|s| s.suggestion_applicability.as_deref() == Some("MachineApplicable")),
        });
    vec![FileIssue {
        file: root.join(&span.file_name),
        issue: Issue {
            line: span.line_start.saturating_sub(1),
            col: span.column_start.saturating_sub(1),
            end_line: span.line_end.saturating_sub(1),
            end_col: span.column_end.saturating_sub(1),
            severity,
            url: clippy_url(&code),
            code,
            message: diagnostic.message,
            source: "clippy",
            fix,
        },
    }]
}

/// One run per workspace, for `poly check`.
pub fn clippy_files(cargo: &Path, files: &[PathBuf]) -> Result<Vec<FileIssue>> {
    let mut roots: Vec<PathBuf> = files
        .iter()
        .filter_map(|f| cargo_workspace_root(f))
        .collect();
    roots.sort();
    roots.dedup();
    let mut out = Vec::new();
    for root in roots {
        out.extend(clippy_workspace(cargo, &root)?);
    }
    Ok(out)
}

/// The directory whose `Cargo.toml` governs `file`, as cargo itself decides it.
///
/// The workspace root and not the nearest crate, because that is the scope
/// cargo actually operates on: `cargo clippy` from a member directory still
/// resolves the workspace, shares its target directory, and reads its lint
/// configuration. Running from the member would mean a different scope per
/// file in one workspace and a target directory per crate.
///
/// Read rather than shelled out to. `cargo locate-project --workspace` is the
/// authoritative answer, but it needs a toolchain to ask, and this has to give
/// the same answer inside `package_lint_scope` where there is nothing to ask
/// with. The rule is cargo's own: the outermost `Cargo.toml` declaring
/// `[workspace]`, or the nearest one when nothing does.
pub fn cargo_workspace_root(file: &Path) -> Option<PathBuf> {
    let start = std::path::absolute(file).ok()?;
    let mut dir = start.parent()?;
    let mut nearest = None;
    let mut workspace = None;
    loop {
        let manifest = dir.join("Cargo.toml");
        if manifest.is_file() {
            if nearest.is_none() {
                nearest = Some(dir.to_path_buf());
            }
            if std::fs::read_to_string(&manifest)
                .is_ok_and(|text| text.lines().any(|line| line.trim_end() == "[workspace]"))
            {
                workspace = Some(dir.to_path_buf());
            }
        }
        match dir.parent() {
            Some(up) => dir = up,
            None => break,
        }
    }
    workspace.or(nearest)
}

/// The directory whose `go.mod` governs `file`.
///
/// Public because the daemon needs the same answer the batch run uses: it lints
/// a whole module at a time, and "which module" has to mean the same thing on
/// both sides or the editor and `poly check` group files differently (A4).
pub fn go_module_root(file: &Path) -> Option<PathBuf> {
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

/// eslint.org documents core rules only, and a plugin's `ruleId` always names
/// the plugin before the rule (`@typescript-eslint/no-unused-vars`,
/// `react/jsx-key`). Deriving for those would produce a link that resolves --
/// to whichever core rule happens to share the name, or to a 404 -- for a rule
/// eslint.org never described, so the slash is the whole test. Plugins
/// document wherever they like and nothing in the JSON says where.
fn eslint_url(rule_id: Option<&str>) -> Option<String> {
    let rule = rule_id?;
    (!rule.contains('/')).then(|| format!("https://eslint.org/docs/latest/rules/{rule}"))
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
                    url: eslint_url(m.rule_id.as_deref()),
                    // No ruleId means eslint failed before any rule ran: a
                    // parse error or a broken config, not a violation.
                    code: m.rule_id.unwrap_or_else(|| "eslint".to_string()),
                    message: m.message,
                    source: "eslint",
                    fix: m.fix.is_some().then_some(Fix::Automatic),
                },
            });
        }
    }
    Ok(out)
}

/// Distinguishes concurrent `buf format` calls. See `buf_format`.
static FORMAT_SCRATCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Format a buffer by handing buf a file, because it will not read stdin.
///
/// `buf format -` reads `-` as a path to a binary image rather than as stdin,
/// and no flag changes that -- so unlike every other formatter poly
/// dispatches to, the text has to reach this one through the filesystem.
///
/// The scratch file gets a directory of its own, and both halves of that
/// matter. Not next to the original, because a stray `.proto` inside the
/// user's module is something `buf lint` and every glob in their build would
/// pick up. Not loose in the system temp directory either: buf is
/// module-oriented and reads the *directory* around whatever file it is given,
/// so on macOS it walks into `$TMPDIR` and fails on `TemporaryItems`, which no
/// process is allowed to open. A directory holding exactly one file is the
/// only input shape with no second file to trip over. Unique per call for the
/// same reason the tool installer's is -- files are formatted concurrently.
///
/// buf resolves nothing about a format from the module (there is no `format`
/// section in buf.yaml -- the style is fixed, like gofmt's), so a file
/// formatted in isolation comes back the same as one formatted in place.
pub fn buf_format(cmd: &Path, path: &Path, text: &str) -> Result<Option<String>> {
    let dir = std::env::temp_dir().join(format!(
        "poly-proto-{}-{}",
        std::process::id(),
        FORMAT_SCRATCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    // The real filename, so a message that escapes the rewrite below still
    // names something the user recognizes.
    let scratch = dir.join(path.file_name().unwrap_or("buffer.proto".as_ref()));
    let outcome = std::fs::write(&scratch, text)
        .with_context(|| format!("writing {}", scratch.display()))
        .and_then(|()| {
            Command::new(cmd)
                .arg("format")
                .arg(&scratch)
                .output()
                .with_context(|| format!("running {}", cmd.display()))
        });
    let _ = std::fs::remove_dir_all(&dir);

    let out = outcome?;
    if !out.status.success() {
        // buf names the file it was given in every line of a parse error, and
        // the file it was given is a scratch path that no longer exists.
        // Pointing the user at their own file is the difference between a
        // message they can act on and one that looks like a poly bug.
        anyhow::bail!(
            "buf failed: {}",
            String::from_utf8_lossy(&out.stderr)
                .trim()
                .replace(&*scratch.to_string_lossy(), &path.to_string_lossy())
        );
    }
    let formatted = String::from_utf8(out.stdout).context("buf output not UTF-8")?;
    Ok((formatted != text).then_some(formatted))
}

/// Lint `.proto` files, one invocation per buf module.
///
/// Grouped rather than batched because `buf lint` accepts exactly one input
/// and resolves the module by walking up from it. `--path` then narrows that
/// module to the files poly was asked about, so a module of two hundred
/// `.proto` files costs one invocation and one image build rather than two
/// hundred of each.
///
/// A file with no `buf.yaml` above it is skipped, loudly. That is not
/// squeamishness: with no module, buf falls back to treating the working
/// directory as the root, and `PACKAGE_DIRECTORY_MATCH` then fires on every
/// file whose package does not happen to match a path relative to wherever
/// poly was invoked from. Findings that move when the caller's cwd moves are
/// worse than no findings (R5/A4) -- and buf's own language server, running
/// against the same file, would report the same nothing.
pub fn buf_files(cmd: &Path, files: &[PathBuf]) -> Result<Vec<FileIssue>> {
    let mut modules: std::collections::BTreeMap<PathBuf, Vec<PathBuf>> = Default::default();
    let mut orphans = 0usize;
    for file in files {
        match poly_core::nearest_ancestor_file(file, "buf.yaml")
            .and_then(|c| c.parent().map(Path::to_path_buf))
        {
            Some(module) => modules.entry(module).or_default().push(file.clone()),
            None => orphans += 1,
        }
    }
    if orphans > 0 {
        eprintln!("[poly] buf: skipping {orphans} .proto files with no buf.yaml above them");
    }

    let mut issues = Vec::new();
    for (module, group) in modules {
        let mut args = vec![
            "lint".to_string(),
            module.to_string_lossy().into_owned(),
            "--error-format=json".to_string(),
        ];
        for file in &group {
            args.push("--path".to_string());
            // Absolute, because the module path already is. buf resolves a
            // relative --path against the *working directory* and then
            // re-expresses it relative to the input, so mixing the two bases
            // produces "../../../..: is outside the context directory" -- and
            // on macOS they differ by default, where /tmp resolves to
            // /private/tmp on the way to the module but not on the way to the
            // file.
            args.push(
                std::path::absolute(file)
                    .unwrap_or_else(|_| file.clone())
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        issues.extend(buf_parse(&buf_run(cmd, &args)?)?);
    }
    Ok(issues)
}

/// Run buf, telling "found violations" apart from "could not check".
///
/// The other linters here can be read off stdout alone, because anything they
/// could not check they still report on. buf exits 100 for violations and 1
/// for a module it refused to build -- and in the second case stdout is empty,
/// which is byte-for-byte what a clean module looks like. Swallowing that
/// would let a pipeline go green having checked nothing, which is the one
/// outcome A10 rules out. Its stderr is kept for the same reason: it is the
/// only place buf says what went wrong.
fn buf_run(cmd: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = Command::new(cmd)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("running {}", cmd.display()))?;
    if !out.status.success() && out.status.code() != Some(100) {
        anyhow::bail!("buf lint: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(out.stdout)
}

/// One page per rule, anchored by the lowercased rule id. Not derived by poly:
/// it is the same URL buf's own language server attaches to the same finding
/// as a `codeDescription`, and the CLI's JSON is the only output of the two
/// that leaves it out.
fn buf_url(rule: &str) -> String {
    format!(
        "https://buf.build/docs/lint/rules/#{}",
        rule.to_ascii_lowercase()
    )
}

/// buf emits one JSON object per line, 1-based, with no severity field: every
/// record is a lint violation. Its own language server reports them as
/// warnings, and poly says the same thing the editor would.
fn buf_parse(stdout: &[u8]) -> Result<Vec<FileIssue>> {
    let mut out = Vec::new();
    for line in stdout.split(|&b| b == b'\n').filter(|l| !l.is_empty()) {
        let item: BufViolation = serde_json::from_slice(line).context("parsing buf lint output")?;
        out.push(FileIssue {
            file: PathBuf::from(item.path),
            issue: Issue {
                line: item.start_line.saturating_sub(1),
                col: item.start_column.saturating_sub(1),
                end_line: item.end_line.saturating_sub(1),
                end_col: item.end_column.saturating_sub(1),
                url: Some(buf_url(&item.r#type)),
                code: item.r#type,
                message: item.message,
                severity: Severity::Warning,
                source: "buf",
                fix: None,
            },
        });
    }
    Ok(out)
}

#[derive(Deserialize)]
struct BufViolation {
    path: String,
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
    r#type: String,
    message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from `cargo clippy --message-format=json` (clippy 0.1.97), cut
    /// down to the fields poly reads. One diagnostic, several spans: the
    /// finding is the expression, and the rewrite lives on a `help` child.
    #[test]
    fn a_rustc_diagnostic_becomes_one_finding_with_the_child_s_fix() {
        let raw = r#"{"message":"unneeded `return` statement","level":"warning",
          "code":{"code":"clippy::needless_return"},
          "spans":[{"file_name":"src/main.rs","line_start":3,"line_end":3,
                    "column_start":5,"column_end":13,"is_primary":true,
                    "suggested_replacement":null,"suggestion_applicability":null}],
          "children":[
            {"level":"help","message":"for further information visit ...","spans":[]},
            {"level":"help","message":"remove `return`","spans":[
              {"file_name":"src/main.rs","line_start":3,"line_end":3,
               "column_start":5,"column_end":13,"is_primary":false,
               "suggested_replacement":"y","suggestion_applicability":"MachineApplicable"}]}]}"#;
        let parsed: RustcDiagnostic = serde_json::from_str(raw).expect("parse");
        let found = clippy_issues(parsed, Path::new("/w"));
        assert_eq!(
            found.len(),
            1,
            "one mistake is one Problem, not one per span"
        );
        assert_eq!(found[0].file, Path::new("/w/src/main.rs"));
        assert_eq!(found[0].issue.code, "clippy::needless_return");
        // 0-based, like every other position poly reports.
        assert_eq!((found[0].issue.line, found[0].issue.col), (2, 4));
        assert_eq!(found[0].issue.severity, Severity::Warning);
        assert_eq!(
            found[0].issue.fix,
            Some(Fix::Described {
                what: "remove `return`".to_string(),
                safe: true,
            })
        );
        // Only clippy's own lints have a page; a rustc lint has none, and
        // guessing one would be a link poly never checked.
        assert!(found[0]
            .issue
            .url
            .as_deref()
            .is_some_and(|u| u.ends_with("#needless_return")));
        assert_eq!(clippy_url("unused_variables"), None);
    }

    /// rustc says "aborting due to 2 previous errors" as a spanless diagnostic,
    /// and the notes attached to a real finding arrive at top level too. Both
    /// would become Problems pointing at nothing.
    #[test]
    fn a_diagnostic_about_the_build_is_not_a_finding() {
        let spanless = r#"{"message":"aborting due to 2 previous errors","level":"error",
          "code":null,"spans":[],"children":[]}"#;
        let parsed: RustcDiagnostic = serde_json::from_str(spanless).expect("parse");
        assert!(clippy_issues(parsed, Path::new("/w")).is_empty());

        let note = r#"{"message":"`#[warn(unused)]` on by default","level":"note",
          "code":null,"spans":[{"file_name":"a.rs","line_start":1,"line_end":1,
          "column_start":1,"column_end":2,"is_primary":true,
          "suggested_replacement":null,"suggestion_applicability":null}],"children":[]}"#;
        let parsed: RustcDiagnostic = serde_json::from_str(note).expect("parse");
        assert!(clippy_issues(parsed, Path::new("/w")).is_empty());
    }

    /// A rewrite rustc is not sure about is reported as unsafe, in ruff's
    /// wording, because it means the same thing: applying it may not compile.
    #[test]
    fn an_uncertain_rewrite_is_marked_unsafe() {
        let raw = r#"{"message":"unused variable: `x`","level":"warning",
          "code":{"code":"unused_variables"},
          "spans":[{"file_name":"a.rs","line_start":7,"line_end":7,
                    "column_start":9,"column_end":10,"is_primary":true,
                    "suggested_replacement":null,"suggestion_applicability":null}],
          "children":[{"level":"help","message":"prefix it with an underscore","spans":[
            {"file_name":"a.rs","line_start":7,"line_end":7,"column_start":9,
             "column_end":10,"is_primary":false,"suggested_replacement":"_x",
             "suggestion_applicability":"MaybeIncorrect"}]}]}"#;
        let parsed: RustcDiagnostic = serde_json::from_str(raw).expect("parse");
        let found = clippy_issues(parsed, Path::new("/w"));
        assert_eq!(
            found[0].issue.fix,
            Some(Fix::Described {
                what: "prefix it with an underscore".to_string(),
                safe: false,
            })
        );
    }

    /// vulture prints prose, and prose changes between releases without anyone
    /// calling it a breaking change. This is the shape as of vulture 2.16.
    #[test]
    fn a_vulture_line_is_a_position_and_a_sentence() {
        let root = Path::new("/w");
        let found = vulture_line(
            "pkg/app.py:5: unused function 'never_called' (60% confidence)",
            root,
        )
        .expect("a finding");
        assert_eq!(found.file, Path::new("/w/pkg/app.py"));
        // 0-based, like every other position poly reports.
        assert_eq!(found.issue.line, 4);
        // The kind is the part stable enough to silence in poly.toml; the
        // confidence stays in the message because it is vulture's own hedge.
        assert_eq!(found.issue.code, "unused-function");
        assert!(found.issue.message.contains("60% confidence"));

        // An absolute path is left alone rather than joined onto the root.
        let absolute = vulture_line(
            "/elsewhere/a.py:1: unused import 'os' (90% confidence)",
            root,
        )
        .expect("a finding");
        assert_eq!(absolute.file, Path::new("/elsewhere/a.py"));
        assert_eq!(absolute.issue.code, "unused-import");

        // Anything that is not a finding is not one: vulture prints its own
        // errors on stdout too, and a line without a position is one of them.
        assert!(vulture_line("", root).is_none());
        assert!(vulture_line("some unrelated sentence", root).is_none());
        assert!(vulture_line("pkg/app.py:notanumber: unused function 'x'", root).is_none());
    }

    /// Found by running it: `--all-targets` compiles a `main.rs` as a bin and
    /// again as its own test harness, so every finding in it arrives twice.
    /// Two overlapping squiggles on one mistake is what this stops.
    #[test]
    fn one_mistake_compiled_twice_is_still_one_finding() {
        let one = |message: &str, line: u32| FileIssue {
            file: PathBuf::from("/w/src/main.rs"),
            issue: Issue {
                line,
                col: 4,
                end_line: line,
                end_col: 12,
                severity: Severity::Warning,
                code: "clippy::needless_return".to_string(),
                message: message.to_string(),
                source: "clippy",
                fix: None,
                url: None,
            },
        };
        let found = dedup_findings(vec![
            one("unneeded `return` statement", 2),
            one("unneeded `return` statement", 2),
            // Same rule, different place: two mistakes, and both are real.
            one("unneeded `return` statement", 9),
        ]);
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].issue.line, found[1].issue.line), (2, 9));
    }

    /// The scope has to be the same one `poly check` groups by, or the editor
    /// and CI lint different sets of files (A4).
    #[test]
    fn a_cargo_scope_is_the_workspace_not_the_crate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("real path");
        std::fs::write(
            root.join("Cargo.toml"),
            "[workspace]\nmembers = [\"api\"]\n",
        )
        .expect("write workspace");
        let member = root.join("api");
        std::fs::create_dir_all(member.join("src")).expect("mkdir");
        std::fs::write(member.join("Cargo.toml"), "[package]\nname = \"api\"\n")
            .expect("write member");
        let source = member.join("src/lib.rs");
        std::fs::write(&source, "pub fn f() {}\n").expect("write lib.rs");
        assert_eq!(cargo_workspace_root(&source), Some(root.clone()));

        // A crate that belongs to no workspace is its own scope.
        let alone = root.join("alone");
        std::fs::create_dir_all(alone.join("src")).expect("mkdir");
        std::fs::write(alone.join("Cargo.toml"), "[package]\nname = \"alone\"\n")
            .expect("write alone");
        let inner = alone.join("src/main.rs");
        std::fs::write(&inner, "fn main() {}\n").expect("write main.rs");
        // ...unless one above it claims it, which is exactly what the walk is
        // for: cargo resolves upward and so does this.
        assert_eq!(cargo_workspace_root(&inner), Some(root));
    }

    #[test]
    fn parses_shellcheck_json() {
        let raw = br#"[{"file":"a.sh","line":2,"endLine":2,"column":6,"endColumn":9,"level":"warning","code":2086,"message":"Double quote"}]"#;
        let issues = shellcheck_parse(raw).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].issue.code, "SC2086");
        assert_eq!(issues[0].issue.line, 1);
    }

    #[test]
    fn parses_buf_lint_ndjson() {
        // One object per line, 1-based, and no severity field -- the shape the
        // parser has to keep agreeing with. The docs link is derived here and
        // handed over by buf's own language server for the same finding, so a
        // change in the anchor would make the two disagree about one rule.
        let raw = br#"{"path":"demo/v1/a.proto","start_line":3,"start_column":9,"end_line":3,"end_column":13,"type":"MESSAGE_PASCAL_CASE","message":"Message name \"ping\" should be PascalCase, such as \"Ping\"."}
{"path":"demo/v1/a.proto","start_line":4,"start_column":10,"end_line":4,"end_column":14,"type":"FIELD_LOWER_SNAKE_CASE","message":"Field name \"Name\" should be lower_snake_case, such as \"name\"."}"#;
        let issues = buf_parse(raw).unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].issue.code, "MESSAGE_PASCAL_CASE");
        assert_eq!((issues[0].issue.line, issues[0].issue.col), (2, 8));
        assert_eq!(
            issues[0].issue.url.as_deref(),
            Some("https://buf.build/docs/lint/rules/#message_pascal_case")
        );
        assert_eq!(issues[1].issue.severity, Severity::Warning);
    }

    /// A `.proto` with no `buf.yaml` above it must be skipped, not linted
    /// against whatever directory poly happens to have been invoked from --
    /// buf falls back to the cwd as the module root, and PACKAGE_DIRECTORY_MATCH
    /// then fires on a package that is perfectly correct.
    ///
    /// The binary path is deliberately one that cannot be spawned: if the skip
    /// ever regresses into an invocation, this fails with a spawn error rather
    /// than passing quietly. It is also what lets the test run with no buf
    /// installed.
    #[test]
    fn a_proto_outside_a_module_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("orphan.proto");
        std::fs::write(&file, "syntax = \"proto3\";\n").unwrap();

        let issues = buf_files(Path::new("/nonexistent/buf"), &[file]).unwrap();
        assert!(issues.is_empty(), "linted a file with no module");
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

    /// These tools name their rules well enough that the documentation URL
    /// falls out of the code, so poly derives it instead of shipping a table
    /// that would rot. Every scheme below was checked against the live sites:
    /// a real rule resolves and an invented one 404s, so a derivation that
    /// drifts shows up as a dead link rather than a wrong page.
    #[test]
    fn documentation_urls_are_derived_from_the_rule_code() {
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
        assert_eq!(
            issues[0].issue.url.as_deref(),
            Some("https://eslint.org/docs/latest/rules/no-var")
        );
    }

    /// eslint.org is a core-rule index, so the slash in a plugin's ruleId is
    /// the whole test. Getting this wrong is not a dead link -- it is a live
    /// link to a rule eslint.org describes and the plugin does not implement.
    #[test]
    fn only_eslint_core_rules_get_a_documentation_link() {
        assert_eq!(
            eslint_url(Some("eqeqeq")).as_deref(),
            Some("https://eslint.org/docs/latest/rules/eqeqeq")
        );
        assert_eq!(eslint_url(Some("react/jsx-key")), None);
        assert_eq!(eslint_url(Some("@typescript-eslint/no-unused-vars")), None);
        // A message with no rule is a parse error or a broken config.
        assert_eq!(eslint_url(None), None);
    }
}

//! poly CLI: `fmt` (batch, in-place, `--check` for CI), `check` (external +
//! embedded linters), `tools` (managed downloads), `bench`, `lsp`.
//!
//! Exit codes: 0 clean, 1 diffs/violations found, 2 errors.

mod batch;
mod fmt;
mod lsp;
mod usage;

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use poly_core::diag::{FailOn, Fix, Severity};
use poly_core::{Hidden, Ignores, Scope, Walk};
use poly_tools::run::FileIssue;
use rayon::prelude::*;

fn main() {
    let code = match run() {
        Ok(code) => code,
        Err(err) => {
            eprintln!("error: {err:#}");
            2
        }
    };
    std::process::exit(code);
}

fn run() -> Result<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Answered wherever they appear. Someone typing `poly fmt --help` is
    // asking the same question as `poly --help`, and split_flags rejecting it
    // as an unknown flag would be a joke at their expense.
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{}", usage::text(usage::detect()));
        return Ok(0);
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("poly {}", env!("CARGO_PKG_VERSION"));
        return Ok(0);
    }
    let cmd = args.first().cloned().unwrap_or_default();
    let rest: Vec<String> = args.into_iter().skip(1).collect();
    match cmd.as_str() {
        "fmt" => {
            let (paths, flags, fail_on) = split_flags("fmt", &rest)?;
            cmd_fmt(
                &paths,
                flags.contains(&"--check"),
                flags.contains(&"--strict"),
                flags.contains(&"--changed"),
                flags.contains(&"--compact"),
                walk_options(&flags),
                fail_on,
            )
        }
        "check" => {
            let (paths, flags, fail_on) = split_flags("check", &rest)?;
            cmd_check(
                &paths,
                flags.contains(&"--strict"),
                flags.contains(&"--changed"),
                flags.contains(&"--compact"),
                walk_options(&flags),
                fail_on,
            )
        }
        "tools" => cmd_tools(&rest),
        "bench" => {
            let path = rest.first().context("usage: poly bench <file> [iters]")?;
            let iters: usize = rest.get(1).map_or(Ok(50), |s| s.parse())?;
            bench(Path::new(path), iters)?;
            Ok(0)
        }
        "lsp" => {
            lsp::run()?;
            Ok(0)
        }
        // Usage is the answer here too, but this is a mistake rather than a
        // question: stderr and a non-zero exit, so a script that typo'd the
        // subcommand fails instead of quietly succeeding.
        other => {
            if !other.is_empty() {
                eprintln!("error: unknown command: {other}");
            }
            eprint!("{}", usage::text(usage::detect()));
            Ok(2)
        }
    }
}

/// Split `rest` into paths and the flags `cmd` actually reads.
///
/// `--check` only means anything to `fmt`, which used to accept it for `check`
/// too and ignore it. `poly check --check .` then looked like a dry run, did
/// the real thing, and exited 0 -- a flag that is spelled right and silently
/// does nothing is worse than one that is rejected.
fn split_flags<'a>(
    cmd: &str,
    rest: &'a [String],
) -> Result<(Vec<PathBuf>, Vec<&'a str>, Option<FailOn>)> {
    let mut paths = Vec::new();
    let mut flags = Vec::new();
    let mut fail_on = None;
    let mut expecting_severity = false;
    for arg in rest {
        // `--fail-on error` and `--fail-on=error` both work; the separated
        // form is what people type, the joined form is what scripts generate.
        if expecting_severity {
            fail_on = Some(FailOn::parse(arg).map_err(|e| anyhow::anyhow!(e))?);
            expecting_severity = false;
            continue;
        }
        let Some(flag) = arg.strip_prefix("--").map(|_| arg.as_str()) else {
            paths.push(PathBuf::from(arg));
            continue;
        };
        if let Some(value) = flag.strip_prefix("--fail-on=") {
            fail_on = Some(FailOn::parse(value).map_err(|e| anyhow::anyhow!(e))?);
            continue;
        }
        match flag {
            "--fail-on" => expecting_severity = true,
            "--strict" | "--changed" | "--compact" | "--no-ignore" | "--hidden" => flags.push(flag),
            "--check" if cmd == "fmt" => flags.push(flag),
            "--check" => bail!(
                "--check is a `poly fmt` flag: `poly check` never writes, so it is \
                 always a dry run"
            ),
            other => bail!("unknown flag: {other}"),
        }
    }
    if expecting_severity {
        bail!("--fail-on needs a severity: error, warning, info, hint or never");
    }
    if paths.is_empty() {
        paths.push(PathBuf::from("."));
    }
    Ok((paths, flags, fail_on))
}

/// `--no-ignore` and `--hidden` are spelled the way ripgrep and fd spell them,
/// and mean the same things here: walk the files git was told to leave alone,
/// and walk the dotted ones.
fn walk_options(flags: &[&str]) -> Walk {
    Walk {
        ignores: if flags.contains(&"--no-ignore") {
            Ignores::Disregard
        } else {
            Ignores::Respect
        },
        hidden: if flags.contains(&"--hidden") {
            Hidden::Include
        } else {
            Hidden::Skip
        },
    }
}

/// 4C machines keep one core for the editor (02 §3.5).
fn init_thread_pool() {
    let threads =
        std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(1).max(1));
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build_global();
}

/// `--changed`: swap the walk roots for the git-changed file list.
fn changed_scope(paths: &[PathBuf]) -> Result<Option<Vec<PathBuf>>> {
    let root = crate::batch::git_root(paths.first().unwrap())
        .context("--changed requires a git repository")?;
    let files = crate::batch::git_changed_files(&root)?;
    if files.is_empty() {
        eprintln!("no changed files");
        return Ok(None);
    }
    Ok(Some(files))
}

/// A file `--check` found unformatted, as an issue.
///
/// Not an editorialization: it is the same claim `poly check` makes about a
/// lint violation — this file, this position, this is wrong, here is the
/// remedy — and CI has no reason to parse it differently just because a
/// formatter rather than a linter found it. Line 1 column 1 because a diff has
/// no single position; the fix line names the command that resolves it.
fn unformatted(file: PathBuf) -> FileIssue {
    FileIssue {
        file,
        issue: poly_core::diag::Issue {
            line: 0,
            col: 0,
            end_line: 0,
            end_col: 0,
            severity: Severity::Warning,
            code: "unformatted".to_string(),
            message: "file is not formatted".to_string(),
            source: "poly",
            fix: Some(Fix::Reformat),
            url: None,
        },
    }
}

/// A file the formatter could not process. Placed where the parser stopped
/// when it said, line 1 otherwise (a missing tool, a rejected option) — the
/// message carries the rest either way.
fn format_failure(file: PathBuf, error: &str) -> FileIssue {
    let (line, col) = poly_core::diag::parse_position(error).unwrap_or((1, 1));
    FileIssue {
        file,
        issue: poly_core::diag::Issue {
            line: line - 1,
            col: col - 1,
            end_line: line - 1,
            end_col: col,
            severity: Severity::Error,
            code: "format".to_string(),
            message: error.to_string(),
            source: "poly",
            fix: None,
            url: None,
        },
    }
}

fn cmd_fmt(
    paths: &[PathBuf],
    check: bool,
    strict: bool,
    changed: bool,
    compact: bool,
    walk: Walk,
    fail_on: Option<FailOn>,
) -> Result<i32> {
    init_thread_pool();
    // The flag beats poly.toml: a policy belongs in the file so the editor and
    // CI share it, but one run wanting a different answer is why flags exist.
    let fail_on = match fail_on {
        Some(explicit) => explicit,
        None => poly_core::Config::discover(&paths[0])?.format_fail_on,
    };
    let paths: Vec<PathBuf> = if changed {
        match changed_scope(paths)? {
            Some(files) => files,
            None => return Ok(0),
        }
    } else {
        paths.to_vec()
    };
    let tally = crate::batch::format_paths(&paths, check, walk)?;

    let base = std::env::current_dir().and_then(|d| d.canonicalize()).ok();
    let shown = |path: &Path| match &base {
        Some(base) => relative_to_base(path, base),
        None => path.to_path_buf(),
    };
    for path in &tally.changed {
        if check {
            print!("{}", render_issue(&unformatted(shown(path)), compact));
        } else {
            // Not an issue: the file was fixed. A log line, and the only thing
            // on stdout that is not a record.
            println!("formatted {}", shown(path).display());
        }
    }
    for (path, err) in &tally.errors {
        print!(
            "{}",
            render_issue(&format_failure(shown(path), err), compact)
        );
    }
    let missing = crate::fmt::missing_formatters();
    eprintln!(
        "{} files: {} {}, {} unchanged, {} errors{}",
        tally.total,
        tally.changed.len(),
        if check {
            "need formatting"
        } else {
            "formatted"
        },
        tally.unchanged,
        tally.errors.len(),
        if missing.is_empty() {
            String::new()
        } else {
            format!(
                ", {} formatters missing ({})",
                missing.len(),
                missing.join(", ")
            )
        }
    );
    // Same rule as `check --strict`: an absent tool is a skipped file, and a
    // skipped file is the CI/editor split poly exists to close.
    if !tally.errors.is_empty() || (strict && !missing.is_empty()) {
        return Ok(2);
    }
    // An unformatted file is a warning, so fail-on decides whether it is
    // fatal. The files are still listed either way: the report is useful even
    // when the pipeline is gated on something stricter.
    let fatal = check && !tally.changed.is_empty() && fail_on.fails(Severity::Warning);
    Ok(if fatal { 1 } else { 0 })
}

fn is_workflow_file(path: &Path) -> bool {
    let mut comps = path.components().rev();
    let file_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e == "yml" || e == "yaml");
    comps.next(); // file name
    file_ok
        && comps.next().is_some_and(|c| c.as_os_str() == "workflows")
        && comps.next().is_some_and(|c| c.as_os_str() == ".github")
}

/// One path shape for every tool, anchored at `base`.
///
/// Each linter reports paths its own way — ruff absolutizes, shellcheck echoes
/// back the `./x` it was handed, typos prints a bare name — so a single run
/// printed three different shapes for files sitting in the same directory, and
/// anything parsing the output (CI annotations, editor terminal links) had to
/// cope with all of them. Applied before the sort, so issues for one file also
/// stay together instead of splitting by whichever tool found them.
///
/// `base` is the caller's canonicalized cwd: on macOS that reads as /tmp while
/// ruff reports /private/tmp, and comparing the two unresolved would match
/// nothing. Anything that fails to resolve (a stdin buffer, a file deleted
/// mid-run) keeps the form the tool gave, which still beats an empty path.
fn relative_to_base(file: &Path, base: &Path) -> PathBuf {
    let stripped = file.strip_prefix("./").unwrap_or(file);
    // A relative report is resolved against `base`, not the process cwd. The
    // two are the same directory in production; saying so explicitly is what
    // keeps this a pure function instead of one reading ambient state.
    let absolute = if stripped.is_absolute() {
        stripped.to_path_buf()
    } else {
        base.join(stripped)
    };
    match absolute.canonicalize() {
        Ok(abs) => abs
            .strip_prefix(base)
            .map_or(abs.clone(), Path::to_path_buf),
        Err(_) => stripped.to_path_buf(),
    }
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
fn render_issue(found: &FileIssue, compact: bool) -> String {
    let FileIssue { file, issue } = found;
    let severity = match issue.severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Info => "info",
        Severity::Hint => "hint",
    };
    let (head, detail) = issue
        .message
        .split_once('\n')
        .unwrap_or((&issue.message, ""));
    let mut out = format!(
        "{}:{}:{}: {severity} [{}/{}] {}\n",
        file.display(),
        issue.line + 1,
        issue.col + 1,
        issue.source,
        issue.code,
        head.trim_end()
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

fn cmd_check(
    paths: &[PathBuf],
    strict: bool,
    changed: bool,
    compact: bool,
    walk: Walk,
    fail_on: Option<FailOn>,
) -> Result<i32> {
    // Tool binaries resolve against the top-level config: one run invokes each
    // linter once over a batch, so there is no per-file choice to make.
    // Language mapping and excludes are per file (batch::resolve_targets).
    let config = poly_core::Config::discover(paths.first().unwrap())?;
    let fail_on = fail_on.unwrap_or(config.lint_fail_on);
    let scope: Vec<PathBuf> = if changed {
        match changed_scope(paths)? {
            Some(files) => files,
            None => return Ok(0),
        }
    } else {
        paths.to_vec()
    };
    let files = crate::batch::resolve_targets(&scope, Scope::Lint, walk, |_| true)?;

    // (tool, files-it-lints) groups; typos runs repo-wide over the roots.
    let group = |lang: &str| -> Vec<PathBuf> {
        files
            .iter()
            .filter(|(_, l, _)| l == lang)
            .map(|(p, _, _)| p.clone())
            .collect()
    };
    type Runner<'a> = Box<dyn Fn(&Path, &[PathBuf]) -> Result<Vec<FileIssue>> + 'a>;
    let jobs: Vec<(&str, Vec<PathBuf>, Runner)> = vec![
        (
            "shellcheck",
            group("shellscript"),
            Box::new(poly_tools::run::shellcheck_files),
        ),
        (
            "hadolint",
            group("dockerfile"),
            Box::new(poly_tools::run::hadolint_files),
        ),
        (
            "actionlint",
            files
                .iter()
                .map(|(p, _, _)| p)
                .filter(|p| is_workflow_file(p))
                .cloned()
                .collect(),
            // Resolved inside the closure so a repo with no workflows never
            // pays for a shellcheck download it will not use.
            Box::new(|cmd, files| {
                let shellcheck = poly_tools::resolve("shellcheck", &config, false);
                poly_tools::run::actionlint_files(cmd, files, shellcheck.command())
            }),
        ),
        (
            "ruff",
            // ruff lints notebooks natively, reporting cell-relative
            // positions; no separate job or tool needed.
            [group("python"), group("jupyter")].concat(),
            Box::new(poly_tools::run::ruff_files),
        ),
        (
            "selene",
            group("lua"),
            Box::new(poly_tools::run::selene_files),
        ),
        (
            "tflint",
            group("terraform"),
            Box::new(poly_tools::run::tflint_files),
        ),
        (
            "golangci-lint",
            group("go"),
            Box::new(poly_tools::run::golangci_files),
        ),
        (
            "swiftlint",
            group("swift"),
            Box::new(poly_tools::run::swiftlint_files),
        ),
        (
            "typos",
            paths.to_vec(),
            Box::new(|cmd: &Path, targets: &[PathBuf]| {
                poly_tools::run::typos_paths(
                    cmd,
                    targets,
                    &config.lint_exclude,
                    config.root.as_deref(),
                )
            }),
        ),
    ];

    let mut issues: Vec<FileIssue> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    // A linter that malfunctions (bad config, concurrent run, unbuildable
    // module) used to abort the whole command and throw away every other
    // tool's findings. Report it, keep going, and still exit 2 at the end --
    // "could not check" is not "clean".
    let mut failed: Vec<String> = Vec::new();
    let mut ran = 0usize;

    // Embedded engines (sqruff) linted only inside the daemon, so `poly check`
    // stayed silent on exactly the files the editor was flagging. R5/A4 wants
    // one answer, not two.
    let embedded: Vec<PathBuf> = files
        .iter()
        .filter(|(_, lang, _)| poly_engines::lint::supported(lang))
        .map(|(p, _, _)| p.clone())
        .collect();
    if !embedded.is_empty() {
        init_thread_pool();
        let results: Vec<Result<Vec<FileIssue>>> = files
            .par_iter()
            .filter(|(_, lang, _)| poly_engines::lint::supported(lang))
            .map(|(path, lang, _)| {
                let text = std::fs::read_to_string(path)
                    .with_context(|| format!("reading {}", path.display()))?;
                Ok(poly_engines::lint::lint(lang, path, &text)?
                    .into_iter()
                    .map(|issue| FileIssue {
                        file: path.clone(),
                        issue,
                    })
                    .collect())
            })
            .collect();
        let mut broken = 0usize;
        for result in results {
            match result {
                Ok(found) => issues.extend(found),
                Err(err) => {
                    eprintln!("embedded lint: failed — {err:#}");
                    broken += 1;
                }
            }
        }
        if broken > 0 {
            failed.push(format!("embedded lint ({broken} files)"));
        } else {
            ran += 1;
        }
    }

    // biome and eslint are project-local only: silence is correct for projects
    // without them, and a project may well run both (biome to format, eslint
    // for rules biome has no equivalent of), so neither excludes the other.
    let biome_targets: Vec<PathBuf> = poly_tools::project::BIOME_LANGUAGES
        .iter()
        .flat_map(|l| group(l))
        .collect();
    if let Some(first) = biome_targets.first() {
        if let Some(bin) = poly_tools::project::biome(first) {
            let root = poly_tools::project::root_of(&bin)
                .unwrap_or(Path::new("."))
                .to_path_buf();
            match poly_tools::run::biome_files(&bin, &root, &biome_targets) {
                Ok(found) => {
                    issues.extend(found);
                    ran += 1;
                }
                Err(err) => {
                    eprintln!("biome: failed — {err:#}");
                    failed.push("biome".to_string());
                }
            }
        }
    }
    let ts_files = group("typescript");
    if !ts_files.is_empty() {
        if let Some(eslint) = poly_tools::project::eslint(ts_files.first().unwrap()) {
            match poly_tools::run::eslint_files(&eslint, &ts_files) {
                Ok(found) => {
                    issues.extend(found);
                    ran += 1;
                }
                Err(err) => {
                    eprintln!("eslint: failed — {err:#}");
                    failed.push("eslint".to_string());
                }
            }
        }
    }
    for (name, targets, runner) in jobs {
        if targets.is_empty() {
            continue;
        }
        match poly_tools::resolve(name, &config, false) {
            resolved @ (poly_tools::Resolved::Managed(_)
            | poly_tools::Resolved::Path(_)
            | poly_tools::Resolved::Pinned(_)) => {
                let cmd = resolved.command().unwrap();
                match runner(cmd, &targets) {
                    Ok(found) => {
                        issues.extend(found);
                        ran += 1;
                    }
                    Err(err) => {
                        eprintln!("{name}: failed — {err:#}");
                        failed.push(name.to_string());
                    }
                }
            }
            poly_tools::Resolved::Disabled => {
                eprintln!("{name}: disabled in poly.toml");
            }
            poly_tools::Resolved::Missing(reason) => {
                eprintln!("{name}: skipped — {reason}");
                missing.push(name.to_string());
            }
        }
    }

    if let Ok(base) = std::env::current_dir().and_then(|d| d.canonicalize()) {
        for issue in &mut issues {
            issue.file = relative_to_base(&issue.file, &base);
        }
    }
    issues.sort_by(|a, b| {
        (&a.file, a.issue.line, a.issue.col).cmp(&(&b.file, b.issue.line, b.issue.col))
    });
    for issue in &issues {
        print!("{}", render_issue(issue, compact));
    }
    // Every issue is still printed; fail-on only decides the exit code. The
    // count of what is below the line is spelled out so a green run with
    // visible findings does not read as a bug.
    let fatal = issues
        .iter()
        .filter(|i| fail_on.fails(i.issue.severity))
        .count();
    eprintln!(
        "{} tools ran, {} issues{}{}{}",
        ran,
        issues.len(),
        if fatal == issues.len() {
            String::new()
        } else {
            format!(" ({} below fail-on)", issues.len() - fatal)
        },
        if missing.is_empty() {
            String::new()
        } else {
            format!(", {} tools missing", missing.len())
        },
        if failed.is_empty() {
            String::new()
        } else {
            format!(", {} tools failed", failed.len())
        }
    );
    if !failed.is_empty() || (strict && !missing.is_empty()) {
        return Ok(2);
    }
    Ok(if fatal == 0 { 0 } else { 1 })
}

fn cmd_tools(rest: &[String]) -> Result<i32> {
    let action = rest.first().map(String::as_str).unwrap_or("list");
    let config = poly_core::Config::discover(Path::new("."))?;
    match action {
        "list" => {
            for tool in poly_tools::TOOLS {
                // Offline: list reports state without triggering downloads.
                let state = match poly_tools::resolve(tool.name, &config, true) {
                    poly_tools::Resolved::Managed(p) => format!("managed {}", p.display()),
                    poly_tools::Resolved::Path(p) => format!("PATH {}", p.display()),
                    poly_tools::Resolved::Pinned(p) => format!("pinned {}", p.display()),
                    poly_tools::Resolved::Disabled => "disabled".to_string(),
                    poly_tools::Resolved::Missing(_) => "not installed".to_string(),
                };
                println!("{:<12} {:<8} {}", tool.name, tool.version, state);
            }
            Ok(0)
        }
        "install" => {
            let names: Vec<&str> = if rest.len() > 1 {
                rest[1..].iter().map(String::as_str).collect()
            } else {
                poly_tools::TOOLS.iter().map(|t| t.name).collect()
            };
            let mut failed = 0;
            for name in names {
                match poly_tools::resolve(name, &config, false) {
                    poly_tools::Resolved::Managed(p) => println!("{name}: {}", p.display()),
                    poly_tools::Resolved::Path(p) => {
                        println!(
                            "{name}: no managed build for this platform, PATH has {}",
                            p.display()
                        )
                    }
                    poly_tools::Resolved::Pinned(p) => println!("{name}: pinned {}", p.display()),
                    poly_tools::Resolved::Disabled => println!("{name}: disabled in poly.toml"),
                    poly_tools::Resolved::Missing(reason) => {
                        eprintln!("{name}: FAILED — {reason}");
                        failed += 1;
                    }
                }
            }
            Ok(if failed > 0 { 2 } else { 0 })
        }
        other => bail!("usage: poly tools <list|install> [tool...] (got {other:?})"),
    }
}

fn bench(path: &Path, iters: usize) -> Result<()> {
    let text = std::fs::read_to_string(path)?;
    // First call initializes engine config and warms caches; measured separately.
    let cold = Instant::now();
    poly_engines::format_file(path, &text)?;
    let cold_ms = cold.elapsed().as_secs_f64() * 1000.0;

    let mut samples: Vec<f64> = Vec::with_capacity(iters);
    for _ in 0..iters {
        let t = Instant::now();
        let out = poly_engines::format_file(path, &text)?;
        samples.push(t.elapsed().as_secs_f64() * 1000.0);
        std::hint::black_box(out);
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| samples[((samples.len() as f64 - 1.0) * p) as usize];
    println!(
        "file={} bytes={} iters={} cold_ms={:.1} min_ms={:.1} p50_ms={:.1} p95_ms={:.1}",
        path.display(),
        text.len(),
        iters,
        cold_ms,
        samples[0],
        pct(0.50),
        pct(0.95),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn issue_paths_collapse_to_one_shape() {
        // A real directory, because the normalization resolves symlinks; the
        // cwd stays untouched so this cannot race other tests in the process.
        let base = std::env::temp_dir()
            .join("poly-relpath-test")
            .canonicalize()
            .or_else(|_| {
                let d = std::env::temp_dir().join("poly-relpath-test");
                std::fs::create_dir_all(&d).and_then(|()| d.canonicalize())
            })
            .unwrap();
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("sub").join("a.py"), "").unwrap();

        // The three shapes real tools hand back for one and the same file.
        let want = PathBuf::from("sub/a.py");
        let abs = base.join("sub/a.py");
        assert_eq!(relative_to_base(&abs, &base), want, "ruff, absolute");
        let dotted = Path::new("./sub/a.py");
        assert_eq!(relative_to_base(dotted, &base), want, "shellcheck, ./x");
        let bare = Path::new("sub/a.py");
        assert_eq!(relative_to_base(bare, &base), want, "typos, bare");

        // Outside the base there is no relative form worth printing, and a path
        // that does not resolve keeps whatever the tool said minus the "./".
        let outside = base.parent().unwrap().to_path_buf();
        assert_eq!(relative_to_base(&outside, &base), outside);
        assert_eq!(
            relative_to_base(Path::new("./gone.py"), &base),
            PathBuf::from("gone.py")
        );
    }
}

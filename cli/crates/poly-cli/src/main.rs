//! poly CLI: `fmt` (batch, in-place, `--check` for CI), `check` (external +
//! embedded linters), `tools` (managed downloads), `bench`, `lsp`.
//!
//! Exit codes: 0 clean, 1 diffs/violations found, 2 errors.

mod batch;
mod fmt;
mod lsp;
mod proxy;
mod report;
mod settings;
mod usage;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use poly_core::diag::{FailOn, Fix, Severity};
use poly_core::{Hidden, Ignores, Scope, Walk};
use poly_tools::run::FileIssue;
use rayon::prelude::*;
use report::Format;

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
        "fmt" => cmd_fmt(&split_flags("fmt", &rest)?),
        "check" => cmd_check(&split_flags("check", &rest)?),
        "minify" => cmd_minify(&split_flags("minify", &rest)?),
        "tools" => cmd_tools(&rest),
        "config" => cmd_config(&rest),
        "deadcode" => cmd_deadcode(&rest),
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

/// One `poly fmt` or `poly check` invocation, after parsing.
struct Invocation<'a> {
    paths: Vec<PathBuf>,
    flags: Vec<&'a str>,
    /// `None` leaves the decision to poly.toml; the flag beats the file.
    fail_on: Option<FailOn>,
    format: Format,
}

impl Invocation<'_> {
    fn has(&self, flag: &str) -> bool {
        self.flags.contains(&flag)
    }

    /// `--no-ignore` and `--hidden` are spelled the way ripgrep and fd spell
    /// them, and mean the same things here: walk the files git was told to
    /// leave alone, and walk the dotted ones.
    fn walk(&self) -> Walk {
        Walk {
            ignores: if self.has("--no-ignore") {
                Ignores::Disregard
            } else {
                Ignores::Respect
            },
            hidden: if self.has("--hidden") {
                Hidden::Include
            } else {
                Hidden::Skip
            },
        }
    }
}

/// Split `rest` into paths and the flags `cmd` actually reads.
///
/// `--check` only means anything to `fmt`, which used to accept it for `check`
/// too and ignore it. `poly check --check .` then looked like a dry run, did
/// the real thing, and exited 0 -- a flag that is spelled right and silently
/// does nothing is worse than one that is rejected.
fn split_flags<'a>(cmd: &str, rest: &'a [String]) -> Result<Invocation<'a>> {
    let mut paths = Vec::new();
    let mut flags = Vec::new();
    let mut fail_on = None;
    let mut format = Format::default();
    // Which flag ate the previous argument, so the error names the one the
    // user typed rather than whichever check happens to run first.
    let mut expecting: Option<&str> = None;
    for arg in rest {
        // `--fail-on error` and `--fail-on=error` both work; the separated
        // form is what people type, the joined form is what scripts generate.
        match expecting.take() {
            Some("--fail-on") => {
                fail_on = Some(FailOn::parse(arg).map_err(|e| anyhow::anyhow!(e))?);
                continue;
            }
            Some("--format") => {
                format = Format::parse(arg)?;
                continue;
            }
            Some(other) => unreachable!("{other} takes no value"),
            None => {}
        }
        let Some(flag) = arg.strip_prefix("--").map(|_| arg.as_str()) else {
            paths.push(PathBuf::from(arg));
            continue;
        };
        // Before the `--flag=value` forms below, which would otherwise consume
        // these two without ever reaching the match.
        if cmd == "minify" && (flag.starts_with("--fail-on") || flag.starts_with("--format")) {
            bail!("{flag} does not apply to `poly minify`");
        }
        if let Some(value) = flag.strip_prefix("--fail-on=") {
            fail_on = Some(FailOn::parse(value).map_err(|e| anyhow::anyhow!(e))?);
            continue;
        }
        if let Some(value) = flag.strip_prefix("--format=") {
            format = Format::parse(value)?;
            continue;
        }
        match flag {
            // minify produces no findings to shape and runs entirely on
            // embedded engines, so there is nothing for these to act on. Same
            // reasoning as the `--compact` check below: a flag spelled right
            // that silently does nothing is worse than one that is rejected.
            "--fail-on" | "--format" | "--strict" | "--compact" if cmd == "minify" => {
                bail!("{flag} does not apply to `poly minify`")
            }
            "--fail-on" | "--format" => expecting = Some(flag),
            "--strict" | "--changed" | "--compact" | "--no-ignore" | "--hidden" => flags.push(flag),
            "--check" if cmd == "fmt" => flags.push(flag),
            "--check" => bail!(
                "--check is a `poly fmt` flag: `poly check` never writes, so it is \
                 always a dry run"
            ),
            other => bail!("unknown flag: {other}"),
        }
    }
    match expecting {
        Some("--fail-on") => {
            bail!("--fail-on needs a severity: error, warning, info, hint or never")
        }
        Some("--format") => bail!("--format needs a shape: text, json, table or table_markdown"),
        _ => {}
    }
    // Same reasoning as `poly check --check`: a flag that is spelled right and
    // silently does nothing is worse than one that is rejected. --compact
    // trims the text record; the other shapes have no record to trim.
    if flags.contains(&"--compact") && format != Format::Text {
        bail!("--compact shapes `--format text`: the other shapes carry every field already");
    }
    if paths.is_empty() {
        paths.push(PathBuf::from("."));
    }
    Ok(Invocation {
        paths,
        flags,
        fail_on,
        format,
    })
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
            severity: report::UNFORMATTED,
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

fn cmd_fmt(inv: &Invocation) -> Result<i32> {
    init_thread_pool();
    let (check, strict, compact) = (
        inv.has("--check"),
        inv.has("--strict"),
        inv.has("--compact"),
    );
    let config = poly_core::Config::discover(&inv.paths[0])?;
    settings::enforce(&config)?;
    // The flag beats poly.toml: a policy belongs in the file so the editor and
    // CI share it, but one run wanting a different answer is why flags exist.
    let fail_on = inv.fail_on.unwrap_or(config.format_fail_on);
    let paths: Vec<PathBuf> = if inv.has("--changed") {
        match changed_scope(&inv.paths)? {
            Some(files) => files,
            None => return Ok(0),
        }
    } else {
        inv.paths.clone()
    };
    let tally = crate::batch::format_paths(&paths, check, inv.walk())?;

    let base = std::env::current_dir().and_then(|d| d.canonicalize()).ok();
    let shown = |path: &Path| match &base {
        Some(base) => relative_to_base(path, base),
        None => path.to_path_buf(),
    };
    // Under --check an unformatted file is a finding; otherwise it was fixed,
    // which is a log line rather than something to report.
    let mut issues: Vec<FileIssue> = if check {
        tally
            .changed
            .iter()
            .map(|p| unformatted(shown(p)))
            .collect()
    } else {
        Vec::new()
    };
    issues.extend(
        tally
            .errors
            .iter()
            .map(|(path, err)| format_failure(shown(path), err)),
    );
    let formatted: Vec<String> = if check {
        Vec::new()
    } else {
        tally
            .changed
            .iter()
            .map(|p| shown(p).display().to_string())
            .collect()
    };
    let missing = crate::fmt::missing_formatters();
    print!(
        "{}",
        report::Fmt {
            issues: &issues,
            formatted: &formatted,
            fail_on,
            total: tally.total,
            unchanged: tally.unchanged,
            missing: &missing,
            check,
        }
        .render(inv.format, compact)
    );
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
    let fatal = check && !tally.changed.is_empty() && fail_on.fails(report::UNFORMATTED);
    Ok(if fatal { 1 } else { 0 })
}

/// `poly minify <paths>`: strip JSON down to what a machine needs.
///
/// Its own command rather than a `poly fmt` flag because the two have opposite
/// contracts -- `fmt` makes a file match the project's style, and nobody's
/// style is one 40KB line. Sharing the walk with `fmt` is what makes it worth
/// having in the CLI at all: the same paths, the same excludes, the same
/// answer as the editor command (R5/A4).
fn cmd_minify(inv: &Invocation) -> Result<i32> {
    init_thread_pool();
    let paths: Vec<PathBuf> = if inv.has("--changed") {
        match changed_scope(&inv.paths)? {
            Some(files) => files,
            None => return Ok(0),
        }
    } else {
        inv.paths.clone()
    };
    let tally = crate::batch::minify_paths(&paths, inv.walk())?;

    let base = std::env::current_dir().and_then(|d| d.canonicalize()).ok();
    let shown = |path: &Path| match &base {
        Some(base) => relative_to_base(path, base),
        None => path.to_path_buf(),
    };
    for path in &tally.changed {
        println!("minified {}", shown(path).display());
    }
    for (path, err) in &tally.errors {
        eprintln!("{}: {err}", shown(path).display());
    }
    eprintln!(
        "{} files: {} minified, {} unchanged, {} errors",
        tally.total,
        tally.changed.len(),
        tally.unchanged,
        tally.errors.len()
    );
    // A file that could not be parsed is the only failure here; "already
    // minified" is a normal outcome, not a finding.
    Ok(if tally.errors.is_empty() { 0 } else { 2 })
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
/// back the `./x` it was handed, and the embedded engines report the bare
/// relative path the walk found — so a single run printed three different
/// shapes for files sitting in the same directory, and anything parsing the
/// output (CI annotations, editor terminal links) had to cope with all of them.
/// Applied before the sort, so issues for one file also stay together instead
/// of splitting by whichever tool found them.
///
/// `base` is the caller's canonicalized cwd: on macOS that reads as /tmp while
/// ruff reports /private/tmp, and comparing the two unresolved would match
/// nothing. Anything that fails to resolve (a stdin buffer, a file deleted
/// mid-run) keeps the form the tool gave, which still beats an empty path.
fn relative_to_base(file: &Path, base: &Path) -> PathBuf {
    match resolve_report(file, base) {
        Some(abs) => abs
            .strip_prefix(base)
            .map_or(abs.clone(), Path::to_path_buf),
        None => file.strip_prefix("./").unwrap_or(file).to_path_buf(),
    }
}

/// The file a tool's report names, as an absolute path — the shape
/// `poly.toml` lookups and its patterns are both anchored against.
///
/// A relative report is resolved against `base`, not the process cwd. The two
/// are the same directory in production; saying so explicitly is what keeps
/// this a pure function instead of one reading ambient state. `None` when the
/// path does not resolve (a stdin buffer, a file deleted mid-run).
fn resolve_report(file: &Path, base: &Path) -> Option<PathBuf> {
    let stripped = file.strip_prefix("./").unwrap_or(file);
    let absolute = if stripped.is_absolute() {
        stripped.to_path_buf()
    } else {
        base.join(stripped)
    };
    absolute.canonicalize().ok()
}

fn cmd_check(inv: &Invocation) -> Result<i32> {
    let (strict, compact) = (inv.has("--strict"), inv.has("--compact"));
    let paths = &inv.paths;
    // Tool binaries resolve against the top-level config: one run invokes each
    // linter once over a batch, so there is no per-file choice to make.
    // Language mapping and excludes are per file (batch::resolve_targets).
    let config = poly_core::Config::discover(paths.first().unwrap())?;
    settings::enforce(&config)?;
    let fail_on = inv.fail_on.unwrap_or(config.lint_fail_on);
    let scope: Vec<PathBuf> = if inv.has("--changed") {
        match changed_scope(paths)? {
            Some(files) => files,
            None => return Ok(0),
        }
    } else {
        paths.clone()
    };
    // Every file the walk kept, and then the subset poly can name a language
    // for. Spelling wants the first list -- a LICENSE is worth reading and has
    // no language -- and every other linter wants the second.
    let walked = crate::batch::resolve_files(&scope, Scope::Lint, inv.walk())?;
    let files: Vec<(PathBuf, String, Arc<poly_core::Config>)> = walked
        .iter()
        .filter_map(|(path, config)| {
            Some((path.clone(), config.language(path)?, Arc::clone(config)))
        })
        .collect();

    // (tool, files-it-lints) groups.
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
            "cargo",
            group("rust"),
            Box::new(poly_tools::run::clippy_files),
        ),
        (
            "swiftlint",
            group("swift"),
            Box::new(poly_tools::run::swiftlint_files),
        ),
        (
            "buf",
            group("protobuf"),
            Box::new(poly_tools::run::buf_files),
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

    // Embedded engines (sqruff, selene, ruff, typos) linted only inside the
    // daemon, so `poly check` stayed silent on exactly the files the editor was
    // flagging. R5/A4 wants one answer, not two.
    //
    // Spelling runs over every walked file and the language-keyed linters over
    // the ones that have a language, in one pass, because the alternative is
    // two rayon passes over the same tree reading many of the same files twice.
    if !walked.is_empty() {
        init_thread_pool();
        let results: Vec<Result<Vec<FileIssue>>> = walked
            .par_iter()
            .map(|(path, config)| {
                let mut found = poly_engines::lint::spell(path)?;
                if let Some(lang) = config
                    .language(path)
                    .filter(|lang| poly_engines::lint::supported(lang))
                {
                    let text = std::fs::read_to_string(path)
                        .with_context(|| format!("reading {}", path.display()))?;
                    found.extend(poly_engines::lint::lint(&lang, path, &text)?);
                }
                Ok(found
                    .into_iter()
                    .map(|issue| FileIssue {
                        file: path.clone(),
                        issue,
                    })
                    .collect())
            })
            .collect();
        let mut broken = 0usize;
        // One broken config is one message. Every file under an unparsable
        // _typos.toml or ruff.toml fails with the same sentence, and a repo of
        // any size would bury every other finding under thousands of copies of
        // it -- which the repo-wide typos subprocess never did, because it read
        // the config once.
        let mut said: std::collections::HashSet<String> = std::collections::HashSet::new();
        for result in results {
            match result {
                Ok(found) => issues.extend(found),
                Err(err) => {
                    broken += 1;
                    let message = format!("{err:#}");
                    if said.insert(message.clone()) {
                        eprintln!("embedded lint: failed — {message}");
                    }
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

    // Both steps need the same thing — the absolute path behind whatever shape
    // the tool printed — so both live here. A cwd that cannot be read means a
    // relative report resolves to nothing, and the findings are reported as the
    // tool worded them rather than being silently dropped.
    if let Ok(base) = std::env::current_dir().and_then(|d| d.canonicalize()) {
        // The config governing each *file*, not the top-level one: a package's
        // poly.toml has to silence its own rules in `poly check` exactly as it
        // does in the editor, or the suppression is one more thing that only
        // works on one side (A4).
        let mut configs = poly_core::ConfigCache::new();
        issues.retain(|found| match resolve_report(&found.file, &base) {
            Some(path) => {
                !configs
                    .for_file(&path)
                    .lint_ignored(&path, found.issue.source, &found.issue.code)
            }
            None => true,
        });
        for issue in &mut issues {
            issue.file = relative_to_base(&issue.file, &base);
        }
    }
    issues.sort_by(|a, b| {
        (&a.file, a.issue.line, a.issue.col).cmp(&(&b.file, b.issue.line, b.issue.col))
    });
    let report = report::Check {
        issues: &issues,
        fail_on,
        ran,
        missing: &missing,
        failed: &failed,
    };
    print!("{}", report.render(inv.format, compact));
    // Every issue is still printed; fail-on only decides the exit code. The
    // count of what is below the line is spelled out so a green run with
    // visible findings does not read as a bug.
    let fatal = report.fatal();
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

/// Where a whole-program analysis of `from` has to start.
///
/// A `go.work` anywhere above beats the module it contains, and that is the
/// entire cross-module story: the workspace file is what puts several modules
/// into one build list, so a function called only from a sibling module is
/// reachable when the analysis starts there and dead when it starts one level
/// down. Tooltitude reaches the same answer with an index of its own; this
/// reaches it with the mechanism the Go team shipped for it.
///
/// Without a go.work the module is the whole program, which is the truth for a
/// single-module repository and an over-report for a library — see the caller.
fn go_analysis_root(from: &Path) -> Option<PathBuf> {
    let mut here = Some(from);
    let mut module = None;
    while let Some(dir) = here {
        if dir.join("go.work").is_file() {
            return Some(dir.to_path_buf());
        }
        // Kept rather than returned: a go.work further up is still the better
        // answer, and this is only what to fall back to.
        if module.is_none() && dir.join("go.mod").is_file() {
            module = Some(dir.to_path_buf());
        }
        here = dir.parent();
    }
    module
}

/// The project a JS/TS analysis would run over: whichever directory holds the
/// knip that will answer.
///
/// The tool's own location is the root because that is how npm projects are
/// laid out -- `node_modules/.bin` sits next to the package.json declaring the
/// entry points knip starts from. A nearer package.json in a monorepo package
/// has neither.
fn js_analysis_root(from: &Path) -> Option<PathBuf> {
    poly_tools::project::knip(from)
        .and_then(|bin| poly_tools::project::root_of(&bin).map(Path::to_path_buf))
}

/// The project a Python analysis would run over.
///
/// A marker file and not "the directory has .py in it": vulture takes any path
/// and will happily report on a lone script, but `poly deadcode .` in a
/// repository with no Python must find nothing to do rather than walk it.
fn python_analysis_root(from: &Path) -> Option<PathBuf> {
    const MARKERS: &[&str] = &["pyproject.toml", "setup.py", "setup.cfg"];
    let mut here = Some(from);
    while let Some(dir) = here {
        if MARKERS.iter().any(|name| dir.join(name).is_file()) {
            return Some(dir.to_path_buf());
        }
        here = dir.parent();
    }
    None
}

/// The project's own .py files, as `poly check` would find them.
///
/// The same walk and the same excludes, so "which files are this project's"
/// has one answer. vulture has no notion of a virtualenv and would otherwise
/// report on every module under `venv/`.
fn python_sources(root: &Path) -> Result<Vec<PathBuf>> {
    let walk = Walk {
        ignores: Ignores::Respect,
        hidden: Hidden::Skip,
    };
    Ok(
        batch::resolve_targets(&[root.to_path_buf()], Scope::Lint, walk, |_| true)?
            .into_iter()
            .filter(|(_, language, _)| language == "python")
            .map(|(path, _, _)| path)
            .collect(),
    )
}

/// `poly config export`: the annotated default poly.toml, on stdout.
///
/// Generated rather than kept as a file in the repo because the parts that
/// drift are exactly the parts poly already knows -- a pinned version, a tool
/// that became a library, the release number in "as of poly 0.1.0". Redirecting
/// this into poly.toml is a no-op by construction; `--self-test` is the gate's
/// non-vacuity check, since diffing the binary's output against a file the
/// binary wrote would otherwise pass forever on a generator that stopped
/// generating.
fn cmd_config(rest: &[String]) -> Result<i32> {
    match rest.first().map(String::as_str) {
        Some("export") => {
            if rest.iter().any(|a| a == "--self-test") {
                settings::self_test()?;
            } else {
                print!("{}", settings::export());
            }
            Ok(0)
        }
        other => bail!("usage: poly config export [--self-test] (got {other:?})"),
    }
}

/// The whole-program analysis tools `poly deadcode` dispatches to, and what to
/// say when one is not installed.
///
/// Every one comes from the language's own toolchain, so the instruction is
/// that toolchain's rather than a poly download. A table rather than three
/// literals inside `dead_code_jobs` because `[tools]` accepts these names too
/// (see `dead_code_tool`), and `settings` has to document and recognise exactly
/// the names that work.
pub(crate) const ANALYSIS_TOOLS: &[(&str, &str)] = &[
    (
        "deadcode",
        "It ships with the Go toolchain's own tools:\n  \
         go install golang.org/x/tools/cmd/deadcode@latest",
    ),
    (
        "knip",
        "It is a project dependency:\n  npm install --save-dev knip",
    ),
    (
        "vulture",
        "Install it into the project's environment:\n  pip install vulture",
    ),
];

/// What to say when `tool` is not installed.
fn install_hint(tool: &str) -> &'static str {
    ANALYSIS_TOOLS
        .iter()
        .find(|(name, _)| *name == tool)
        .map(|(_, hint)| *hint)
        .unwrap_or("")
}

/// One whole-program analysis to run, and where.
struct DeadCodeJob {
    /// The name `[tools]` resolves it under, and the name in the report.
    tool: &'static str,
    root: PathBuf,
}

/// Which analyses apply to `target`.
///
/// A file names its own language, so exactly one applies. A directory can hold
/// several projects, and running each is the same thing `poly check` does with
/// its per-language linters -- answering about one of three languages in a
/// monorepo would be a subset nobody asked for.
///
/// Every root is found by walking *up*. A marker below the target is not found,
/// which is the same limitation `go_analysis_root` always had: the question is
/// "which project is this path part of", and a project below it is a different
/// one.
fn dead_code_jobs(target: &Path, config: &poly_core::Config) -> Vec<DeadCodeJob> {
    let language = if target.is_dir() {
        None
    } else {
        config.language(target)
    };
    let wanted = |candidates: &[&str]| match &language {
        Some(found) => candidates.contains(&found.as_str()),
        None => true,
    };

    let mut jobs = Vec::new();
    if wanted(&["go"]) {
        if let Some(root) = go_analysis_root(target) {
            jobs.push(DeadCodeJob {
                tool: "deadcode",
                root,
            });
        }
    }
    if wanted(&["typescript", "javascript"]) {
        if let Some(root) = js_analysis_root(target) {
            jobs.push(DeadCodeJob { tool: "knip", root });
        }
    }
    if wanted(&["python"]) {
        if let Some(root) = python_analysis_root(target) {
            jobs.push(DeadCodeJob {
                tool: "vulture",
                root,
            });
        }
    }
    jobs
}

/// Code nothing reaches, for whichever projects the path belongs to.
///
/// Its own subcommand rather than another linter in `poly check`, and the line
/// between them is what each question is worth being wrong about. `unused` asks
/// whether anything in the package names a symbol, which is cheap and true or
/// false on its own; these tools build the reachability graph from every entry
/// point and ask whether anything runs it, which takes as long as a build and
/// is *false* for every exported symbol in a library — nothing in the project
/// calls it, and the callers are somebody else's repo. A gate that fails on
/// that would be a gate every library turns off, so this is a thing you run.
///
/// Three tools, one question. Go has `golang.org/x/tools/cmd/deadcode`, JS and
/// TS have knip, Python has vulture; poly runs whichever the path calls for and
/// implements none of them (R7, A6). None is managed: each has to match the
/// toolchain that builds the project, and a pinned download would be the wrong
/// version of the right tool.
fn cmd_deadcode(rest: &[String]) -> Result<i32> {
    let target = rest
        .iter()
        .find(|arg| !arg.starts_with('-'))
        .map_or_else(|| PathBuf::from("."), PathBuf::from);
    let target = target
        .canonicalize()
        .with_context(|| format!("{}", target.display()))?;
    let config =
        poly_core::Config::discover(&target).unwrap_or_else(|_| poly_core::Config::empty());
    let jobs = dead_code_jobs(&target, &config);
    if jobs.is_empty() {
        eprintln!(
            "nothing to analyse at {}: no go.mod or go.work above it, no knip in a \
             node_modules/.bin above it, no pyproject.toml, setup.py or setup.cfg above it",
            target.display()
        );
        return Ok(2);
    }

    let mut issues = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let mut ran = 0usize;
    for job in &jobs {
        let Some(cmd) = dead_code_tool(job, &config, &target) else {
            eprintln!("{} is not installed. {}", job.tool, install_hint(job.tool));
            missing.push(job.tool.to_string());
            continue;
        };
        // One tool failing is not a reason to throw away another's answer:
        // a monorepo where npm install has not been run still has a Go module
        // worth asking about. Same policy as `poly check`.
        let found = match job.tool {
            "deadcode" => poly_tools::run::deadcode_module(&cmd, &job.root),
            "knip" => poly_tools::run::knip_project(&cmd, &job.root),
            // The only one poly has to hand a file list to; see
            // `vulture_files` for what pointing it at a directory costs.
            "vulture" => python_sources(&job.root)
                .and_then(|files| poly_tools::run::vulture_files(&cmd, &files)),
            other => unreachable!("{other} has no runner"),
        };
        match found {
            Ok(found) => {
                issues.extend(found);
                ran += 1;
            }
            Err(err) => {
                eprintln!("{}: failed — {err:#}", job.tool);
                failed.push(job.tool.to_string());
            }
        }
    }

    if let Ok(base) = std::env::current_dir().and_then(|d| d.canonicalize()) {
        let mut configs = poly_core::ConfigCache::new();
        // The same two filters `poly check` applies, so a symbol silenced in
        // poly.toml stays silent here. Nothing else about this command is a
        // lint, but "which findings did I ask to stop seeing" is one question
        // with one answer.
        issues.retain(|found| {
            !configs.for_file(&found.file).lint_ignored(
                &found.file,
                found.issue.source,
                &found.issue.code,
            )
        });
        for issue in &mut issues {
            issue.file = relative_to_base(&issue.file, &base);
        }
    }
    issues.sort_by(|a, b| {
        (&a.file, a.issue.line, a.issue.col).cmp(&(&b.file, b.issue.line, b.issue.col))
    });
    let report = report::Check {
        issues: &issues,
        fail_on: FailOn::Severity(poly_core::diag::Severity::Warning),
        ran,
        missing: &missing,
        failed: &failed,
    };
    print!("{}", report.render(Format::Text, false));
    // "could not answer" is not "nothing to report", so a tool that was
    // missing or broke outranks a clean run.
    if ran == 0 || !failed.is_empty() {
        return Ok(2);
    }
    Ok(if issues.is_empty() { 0 } else { 1 })
}

/// The binary for one job: `[tools]` first, then wherever that tool lives.
///
/// knip is looked for in the project rather than on PATH because that is where
/// npm puts it; the other two are toolchain binaries and live on PATH.
fn dead_code_tool(job: &DeadCodeJob, config: &poly_core::Config, target: &Path) -> Option<PathBuf> {
    // A `[tools]` entry decides first, exactly as it does for a language
    // server, so a project pinning its own build is honoured.
    if config.tools.contains_key(job.tool) {
        return poly_tools::resolve(job.tool, config, false)
            .command()
            .map(Path::to_path_buf);
    }
    match job.tool {
        "knip" => poly_tools::project::knip(target),
        other => poly_tools::find_on_path(other),
    }
}

/// Was this tool one `poly tools install` was ever going to fetch here?
///
/// Naming a tool asks about that tool, so failing to resolve it is a failure.
/// A bare `poly tools install` is a sweep, and a tool with no managed build for
/// this platform is not a failed download -- it is one poly never downloads
/// anywhere (terraform, clang-format, swift-format, which must match the
/// project's own toolchain) or not on this one (swiftlint has no Linux build,
/// shellcheck no Windows one). Counting those made the sweep exit 2 on every
/// machine that had not installed all three by hand, which is most of them, and
/// it is why Tool Sync's download gate could never pass on a Linux runner.
///
/// Same policy as `batch::resolve_targets`: naming something beats the filter,
/// and the sweep's case is not that one.
fn installable(name: &str, explicit: bool) -> bool {
    explicit
        || poly_tools::tool(name)
            .and_then(|t| t.asset(t.version, poly_tools::current_platform()))
            .is_some()
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
            let explicit = rest.len() > 1;
            let names: Vec<&str> = if explicit {
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
                    poly_tools::Resolved::Missing(reason) if installable(name, explicit) => {
                        eprintln!("{name}: FAILED — {reason}");
                        failed += 1;
                    }
                    // Said out loud, because silence would read as installed.
                    poly_tools::Resolved::Missing(reason) => println!("{name}: skipped — {reason}"),
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

    #[test]
    fn a_sweep_does_not_fail_on_tools_poly_never_downloads() {
        // These three have to match the project's own toolchain, so no platform
        // has a managed build for them. Counting them made `poly tools install`
        // exit 2 on any machine missing one -- including every Linux runner,
        // which is what Tool Sync's download gate ran on.
        for name in ["terraform", "clang-format", "swift-format"] {
            assert!(!installable(name, false), "{name} in a sweep");
            assert!(installable(name, true), "{name} asked for by name");
        }
        // The gaps that are the platform's rather than the tool's read the same
        // way: swiftlint's Linux build would not run without a Swift toolchain,
        // so the registry ships none.
        assert_eq!(
            installable("swiftlint", false),
            poly_tools::current_platform().starts_with("darwin"),
        );
        // Non-vacuity: a predicate stuck at false would pass everything above.
        // actionlint because it is one of the few with a build on all six
        // platforms, so this cannot start depending on where it runs.
        assert!(installable("actionlint", false));
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
        assert_eq!(relative_to_base(bare, &base), want, "the walk, bare");

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

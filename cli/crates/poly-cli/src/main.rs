//! poly CLI: `fmt` (batch, in-place, `--check` for CI), `check` (external +
//! embedded linters), `tools` (managed downloads), `bench`, `lsp`.
//!
//! Exit codes: 0 clean, 1 diffs/violations found, 2 errors.

mod batch;
mod fmt;
mod lsp;

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use poly_core::diag::Severity;
use poly_core::Scope;
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
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_default();
    let rest: Vec<String> = args.collect();
    match cmd.as_str() {
        "fmt" => {
            let (paths, flags) = split_flags(&rest)?;
            cmd_fmt(
                &paths,
                flags.contains(&"--check"),
                flags.contains(&"--changed"),
            )
        }
        "check" => {
            let (paths, flags) = split_flags(&rest)?;
            cmd_check(
                &paths,
                flags.contains(&"--strict"),
                flags.contains(&"--changed"),
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
        _ => {
            bail!("usage: poly <fmt|check|tools|bench|lsp> [paths...] [--check|--strict|--changed]")
        }
    }
}

fn split_flags<'a>(rest: &'a [String]) -> Result<(Vec<PathBuf>, Vec<&'a str>)> {
    let mut paths = Vec::new();
    let mut flags = Vec::new();
    for arg in rest {
        if let Some(flag) = arg.strip_prefix("--").map(|_| arg.as_str()) {
            match flag {
                "--check" | "--strict" | "--changed" => flags.push(flag),
                other => bail!("unknown flag: {other}"),
            }
        } else {
            paths.push(PathBuf::from(arg));
        }
    }
    if paths.is_empty() {
        paths.push(PathBuf::from("."));
    }
    Ok((paths, flags))
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

fn cmd_fmt(paths: &[PathBuf], check: bool, changed: bool) -> Result<i32> {
    init_thread_pool();
    let paths: Vec<PathBuf> = if changed {
        match changed_scope(paths)? {
            Some(files) => files,
            None => return Ok(0),
        }
    } else {
        paths.to_vec()
    };
    let tally = crate::batch::format_paths(&paths, check)?;

    for path in &tally.changed {
        println!(
            "{} {}",
            if check { "would format" } else { "formatted" },
            path.display()
        );
    }
    for (path, err) in &tally.errors {
        eprintln!("error: {}: {err}", path.display());
    }
    eprintln!(
        "{} files: {} {}, {} unchanged, {} errors",
        tally.total,
        tally.changed.len(),
        if check {
            "need formatting"
        } else {
            "formatted"
        },
        tally.unchanged,
        tally.errors.len(),
    );
    if !tally.errors.is_empty() {
        return Ok(2);
    }
    Ok(if check && !tally.changed.is_empty() {
        1
    } else {
        0
    })
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

fn cmd_check(paths: &[PathBuf], strict: bool, changed: bool) -> Result<i32> {
    // Tool binaries resolve against the top-level config: one run invokes each
    // linter once over a batch, so there is no per-file choice to make.
    // Language mapping and excludes are per file (batch::resolve_targets).
    let config = poly_core::Config::discover(paths.first().unwrap())?;
    let scope: Vec<PathBuf> = if changed {
        match changed_scope(paths)? {
            Some(files) => files,
            None => return Ok(0),
        }
    } else {
        paths.to_vec()
    };
    let files = crate::batch::resolve_targets(&scope, Scope::Lint, |_| true)?;

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
            Box::new(poly_tools::run::actionlint_files),
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

    issues.sort_by(|a, b| {
        (&a.file, a.issue.line, a.issue.col).cmp(&(&b.file, b.issue.line, b.issue.col))
    });
    for FileIssue { file, issue } in &issues {
        let severity = match issue.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Info => "info",
            Severity::Hint => "hint",
        };
        println!(
            "{}:{}:{}: {severity} [{}/{}] {}",
            file.display(),
            issue.line + 1,
            issue.col + 1,
            issue.source,
            issue.code,
            issue.message
        );
    }
    eprintln!(
        "{} tools ran, {} issues{}{}",
        ran,
        issues.len(),
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
    Ok(if issues.is_empty() { 0 } else { 1 })
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

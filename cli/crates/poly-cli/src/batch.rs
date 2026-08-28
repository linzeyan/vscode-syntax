//! Batch formatting shared by `poly fmt` and the LSP daemon's
//! `poly.formatPaths` executeCommand, so editor batch commands and CI
//! behave identically. Dispatch goes through crate::fmt (project tools ->
//! embedded engines -> managed external).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use poly_core::{Config, ConfigCache, Scope};
use rayon::prelude::*;

#[derive(Debug, Default)]
pub struct FmtSummary {
    pub total: usize,
    pub changed: Vec<PathBuf>,
    pub unchanged: usize,
    pub errors: Vec<(PathBuf, String)>,
}

/// Walk `paths` and pair every file with the language and config that govern
/// it, dropping anything `keep` rejects.
///
/// The walk itself can only be pruned by one exclude list, so it uses the
/// config nearest the first path; a nested `poly.toml` is then consulted
/// per file. The consequence is that nested configs *add* excludes but cannot
/// un-exclude a directory an ancestor already pruned — undoing a prune would
/// mean walking everything and filtering afterwards, which is exactly the cost
/// `exclude` exists to avoid.
pub fn resolve_targets(
    paths: &[PathBuf],
    scope: Scope,
    keep: impl Fn(&str) -> bool,
) -> Result<Vec<(PathBuf, String, Arc<Config>)>> {
    let start = paths.first().context("no paths given")?;
    let top = Config::discover(start)?;
    let exclude = match scope {
        Scope::Format => &top.format_exclude,
        Scope::Lint => &top.lint_exclude,
    };
    let files = poly_core::walk_files(paths, exclude, top.root.as_deref())?;
    // Naming a file on the command line beats any exclude, same as the walk.
    let explicit: HashSet<&Path> = paths
        .iter()
        .filter(|p| p.is_file())
        .map(PathBuf::as_path)
        .collect();
    let mut cache = ConfigCache::new();
    Ok(files
        .into_iter()
        .filter_map(|p| {
            let config = cache.for_file(&p);
            if !explicit.contains(p.as_path()) && config.excluded(&p, scope) {
                return None;
            }
            let lang = config.language(&p)?;
            keep(&lang).then_some((p, lang, config))
        })
        .collect())
}

/// Walk `paths`, format every supported file in place (or dry-run with
/// `check`), honoring the poly.toml nearest each file. Parallelism uses the
/// caller's rayon pool configuration.
pub fn format_paths(paths: &[PathBuf], check: bool) -> Result<FmtSummary> {
    let targets = resolve_targets(paths, Scope::Format, crate::fmt::formattable)?;

    let mut summary = targets
        .par_iter()
        .map(|(path, lang, config)| {
            let mut s = FmtSummary::default();
            let attempt = std::fs::read_to_string(path)
                .map_err(anyhow::Error::from)
                .and_then(
                    |text| match crate::fmt::format_text(lang, path, &text, config)? {
                        Some(formatted) if !check => std::fs::write(path, formatted)
                            .map(|_| true)
                            .map_err(Into::into),
                        Some(_) => Ok(true),
                        None => Ok(false),
                    },
                );
            match attempt {
                Ok(true) => s.changed.push(path.clone()),
                Ok(false) => s.unchanged += 1,
                Err(e) => s.errors.push((path.clone(), format!("{e:#}"))),
            }
            s
        })
        .reduce(FmtSummary::default, |mut a, b| {
            a.changed.extend(b.changed);
            a.errors.extend(b.errors);
            a.unchanged += b.unchanged;
            a
        });
    summary.total = targets.len();
    summary.changed.sort();
    Ok(summary)
}

/// Files changed vs HEAD plus untracked (the "Git Changed Files" scope).
pub fn git_changed_files(root: &Path) -> Result<Vec<PathBuf>> {
    let run = |args: &[&str]| -> Result<Vec<PathBuf>> {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .context("running git")?;
        if !out.status.success() {
            anyhow::bail!(
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| root.join(l))
            .filter(|p| p.is_file()) // deletions show up in diff output
            .collect())
    };
    // Unborn HEAD (no commits yet): staged files are the diff.
    let mut files = run(&["diff", "--name-only", "HEAD"])
        .or_else(|_| run(&["diff", "--name-only", "--cached"]))?;
    files.extend(run(&["ls-files", "--others", "--exclude-standard"])?);
    files.sort();
    files.dedup();
    Ok(files)
}

/// Nearest ancestor containing .git (the "Git Repo" scope).
pub fn git_root(start: &Path) -> Option<PathBuf> {
    let mut dir = if start.is_dir() {
        start
    } else {
        start.parent()?
    };
    loop {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
}

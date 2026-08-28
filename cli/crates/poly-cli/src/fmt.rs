//! Unified format dispatch (02 §3.4): project-local tools win over embedded
//! engines (team CI agreement, A3), embedded engines over managed external
//! tools. Used by both the CLI batch path and the LSP daemon so editor
//! formatting and `poly fmt` always agree.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::Result;

/// Can `lang` be formatted at all (by any layer)? Batch filtering only; the
/// per-file dispatch below may still skip when a required tool is absent.
pub fn formattable(lang: &str) -> bool {
    poly_engines::supported_language(lang)
        || matches!(
            lang,
            "rust" | "shellscript" | "go" | "lua" | "c" | "cpp" | "terraform" | "swift" | "jupyter"
        )
}

/// Does this file use CRLF? Prettier's rule: whichever ending the *first* line
/// uses wins, so one stray ending in a large file does not flip the verdict.
fn is_crlf(text: &str) -> bool {
    match text.find('\n') {
        Some(i) => i > 0 && text.as_bytes()[i - 1] == b'\r',
        None => false,
    }
}

/// Format `text`, preserving its line-ending convention.
///
/// Every formatter we dispatch to emits LF. Git's Windows default
/// (`core.autocrlf=true`) checks files out as CRLF, so without this the same
/// commit is "clean" in CI and "65 files need formatting" on a Windows dev box,
/// and format-on-save rewrites every line of every file — R5/A4 wants one
/// answer regardless of platform.
pub fn format_text(
    lang: &str,
    path: &Path,
    text: &str,
    config: &poly_core::Config,
) -> Result<Option<String>> {
    if !is_crlf(text) {
        return dispatch(lang, path, text, config);
    }
    let lf = text.replace("\r\n", "\n");
    let Some(formatted) = dispatch(lang, path, &lf, config)? else {
        return Ok(None);
    };
    // Safe as a blanket replace: the formatter saw LF-only input, so any \n it
    // emitted is a bare one. Mixed-ending files get normalized to the dominant
    // ending, which is what git would do on the next commit anyway.
    let restored = formatted.replace('\n', "\r\n");
    Ok((restored != text).then_some(restored))
}

fn dispatch(
    lang: &str,
    path: &Path,
    text: &str,
    config: &poly_core::Config,
) -> Result<Option<String>> {
    // Layer 1: project-local tools. biome comes first because a biome.json is
    // an explicit choice, while a .prettierrc often outlives the migration
    // that replaced it — and a project that kept both still runs biome in CI.
    if poly_tools::project::BIOME_LANGUAGES.contains(&lang) {
        if let Some(bin) = cached_project_tool("biome", path) {
            let path_arg = format!("--stdin-file-path={}", path.display());
            return poly_tools::run::format_stdin(&bin, &["format", &path_arg], text);
        }
    }
    if poly_tools::project::PRETTIER_LANGUAGES.contains(&lang) {
        if let Some(bin) = cached_project_tool("prettier", path) {
            let path_arg = path.to_string_lossy();
            return poly_tools::run::format_stdin(&bin, &["--stdin-filepath", &path_arg], text);
        }
    }
    if lang == "rust" {
        // Project toolchain only — never auto-downloaded (spec §4.3).
        let Some(rustfmt) = poly_tools::project::rustfmt(path) else {
            note_missing("rustfmt");
            return Ok(None);
        };
        return poly_tools::run::format_stdin(
            &rustfmt.bin,
            &["--edition", &rustfmt.edition, "--emit", "stdout"],
            text,
        );
    }

    // Layer 2: embedded engines — the only layer `[format.<lang>]` reaches.
    // Layers 1 and 3 are other people's tools with their own config files, and
    // overriding those from poly.toml would put us in a fight with the repo's
    // .prettierrc / rustfmt.toml that the tool itself would win anyway.
    if poly_engines::supported_language(lang) {
        return poly_engines::format(lang, path, text, config.format_options(lang));
    }

    // Layer 3: managed external formatters (or toolchain-only ones resolved
    // from PATH — clang-format/terraform/swift-format are never downloaded).
    let path_arg = path.to_string_lossy();
    let (tool, args): (&str, Vec<&str>) = match lang {
        "shellscript" => ("shfmt", vec!["--filename", &path_arg]),
        // The embedded ruff formatter takes Python source; only the ruff
        // binary knows the notebook container, and it round-trips the whole
        // .ipynb through stdin.
        "jupyter" => ("ruff", vec!["format", "--stdin-filename", &path_arg, "-"]),
        "go" => ("gofumpt", vec![]),
        "lua" => ("stylua", vec!["-"]),
        "c" | "cpp" => ("clang-format", vec!["--assume-filename", &path_arg]),
        "terraform" => ("terraform", vec!["fmt", "-"]),
        "swift" => ("swift-format", vec![]),
        _ => return Ok(None),
    };
    let Some(bin) = cached_tool(tool, config) else {
        return Ok(None);
    };
    poly_tools::run::format_stdin(&bin, &args, text)
}

/// Project-tool detection walks directories upward; memoize per (tool, parent
/// dir) so a large batch doesn't re-stat the chain for every file.
pub fn cached_project_tool(tool: &str, path: &Path) -> Option<PathBuf> {
    /// (tool name, directory searched from) -> where it was found, if at all.
    type ProjectToolCache = HashMap<(String, PathBuf), Option<PathBuf>>;
    static CACHE: Mutex<Option<ProjectToolCache>> = Mutex::new(None);
    // A bare relative filename has an empty parent; that means "here".
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let key = (tool.to_string(), dir.clone());
    let mut cache = CACHE.lock().expect("project tool cache lock");
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some(hit) = cache.get(&key) {
        return hit.clone();
    }
    let found = match tool {
        "biome" => poly_tools::project::biome(&dir),
        "prettier" => poly_tools::project::prettier(&dir),
        "eslint" => poly_tools::project::eslint(&dir),
        other => panic!("unknown project tool {other}"),
    };
    cache.insert(key, found.clone());
    found
}

/// Formatters this run could not resolve. Skipping their files is the right
/// default -- almost no repo has every toolchain installed -- but the skip is
/// silent in the exit code, so a CI job can pass while leaving Go and Swift
/// unformatted. `--strict` reads this to fail instead, and it is collected
/// rather than raised per file so one absent formatter reports once, not once
/// for each of the two hundred files it would have handled.
static MISSING: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);

pub fn missing_formatters() -> Vec<String> {
    MISSING
        .lock()
        .expect("missing formatter lock")
        .clone()
        .map(|names| names.into_iter().collect())
        .unwrap_or_default()
}

/// Record a formatter this run could not resolve, and say so once. The set
/// dedups, so the first `.swift` file in a repo reports and the other two
/// hundred stay quiet.
fn note_missing(name: &str) {
    let mut guard = MISSING.lock().expect("missing formatter lock");
    if guard
        .get_or_insert_with(BTreeSet::new)
        .insert(name.to_string())
    {
        eprintln!("[poly] formatter {name}: unavailable, skipping its files");
    }
}

/// Managed-tool resolution can download; memoize for the process lifetime.
fn cached_tool(name: &str, config: &poly_core::Config) -> Option<PathBuf> {
    static CACHE: Mutex<Option<HashMap<String, Option<PathBuf>>>> = Mutex::new(None);
    let mut cache = CACHE.lock().expect("tool cache lock");
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some(hit) = cache.get(name) {
        return hit.clone();
    }
    let resolved = poly_tools::resolve(name, config, false);
    let path = resolved.command().map(Path::to_path_buf);
    if path.is_none() {
        note_missing(name);
    }
    cache.insert(name.to_string(), path.clone());
    path
}

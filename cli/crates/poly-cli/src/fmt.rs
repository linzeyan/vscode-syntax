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
            "rust"
                | "shellscript"
                | "zsh"
                | "go"
                | "c"
                | "cpp"
                | "terraform"
                | "swift"
                | "protobuf"
                | "r"
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
        // poly.toml over .editorconfig: an explicit setting beats an inherited
        // one. The inherited half is filtered to what this engine can act on
        // first, so a repo-wide `indent_size` does not make poly refuse to
        // format XML -- see `drop_unhonored`.
        let inherited = poly_engines::drop_unhonored(lang, poly_core::editorconfig_options(path));
        let opts = config.format_options(lang).over(inherited);
        return poly_engines::format(lang, path, text, opts);
    }

    // Layer 3: managed external formatters (or toolchain-only ones resolved
    // from PATH — clang-format/terraform/swift-format are never downloaded).

    // buf takes the whole call rather than a row in the table below: it is the
    // one formatter here that will not read stdin, so the buffer has to reach
    // it as a file. See `buf_format`.
    if lang == "protobuf" {
        let Some(bin) = cached_tool("buf", config) else {
            return Ok(None);
        };
        return poly_tools::run::buf_format(&bin, path, text);
    }

    // arity reads air.toml/arity.toml from the working directory, not from the
    // filename it is handed, so this one runs where the package is. Its own
    // call rather than a row in the table below for that reason alone -- see
    // `format_stdin_in`.
    if lang == "r" {
        // poly was contradicting itself on these files. `poly check` hands
        // arity paths and arity applies its own exclusions, so a generated file
        // reports nothing; `poly fmt` hands it a buffer, where
        // `--stdin-filename` picks the grammar and nothing else, so the same
        // file in the same run came back "not formatted" and got rewritten.
        //
        // The buffer says which it is, which is what makes this safe in the
        // editor: the copy on disk is the stale one poly must not consult (A4),
        // and the claim is in the text being formatted. Measured over 1,464
        // files from seven R packages -- arity skips 19, the 11 generated ones
        // all carry the line, and not one of the 1,445 it does format carries
        // it.
        //
        // The other eight are `revdep/` scripts, and poly formats those. They
        // are hand-written, arity skips them because they are not package
        // source, and a directory name is not a claim the file makes about
        // itself. Only R checks this, because R is where poly disagreed with
        // poly: gofumpt and the rest exclude nothing, so there is no second
        // answer to reconcile.
        if declares_itself_generated(text) {
            return Ok(None);
        }
        let Some(bin) = cached_tool("arity", config) else {
            return Ok(None);
        };
        let root = poly_tools::run::r_package_root(path);
        let path_arg = path.to_string_lossy();
        return poly_tools::run::format_stdin_in(
            &bin,
            &root,
            &["format", "--stdin-filename", &path_arg, "-"],
            text,
        );
    }

    let path_arg = path.to_string_lossy();
    let (tool, args): (&str, Vec<&str>) = match lang {
        // `--filename` is what carries the dialect: shfmt's `-ln=auto` reads
        // the extension, so a .zsh file is parsed as zsh rather than as the
        // bash poly's other shell id means. That is the whole reason zsh can
        // keep its formatter while losing its linter.
        "shellscript" | "zsh" => ("shfmt", vec!["--filename", &path_arg]),
        "go" => ("gofumpt", vec![]),
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

/// Whether the buffer opens by saying a generator owns it.
///
/// "do not edit" rather than "generated by", which was the other candidate and
/// is the looser of the two: every file arity excludes for this reason carries
/// the first phrase, and the second also appears in prose that is describing a
/// generator rather than declaring one. The same phrase is what Go's own
/// specified header says (`// Code generated ... DO NOT EDIT.`), so the day
/// another formatter needs this the phrase does not have to change -- only the
/// caller.
///
/// Eight lines because a generated file leads with the claim; further down it
/// would be a file discussing generated code rather than being one. It has to
/// be a comment for the same reason: the words in a string literal are the
/// program's data, not its own description.
fn declares_itself_generated(text: &str) -> bool {
    text.lines().take(8).any(|line| {
        let line = line.trim_start();
        line.starts_with('#') && line.to_ascii_lowercase().contains("do not edit")
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The four generators whose output arity excludes, in their own words.
    ///
    /// Copied from real files rather than paraphrased: this predicate is a
    /// string match, so a header written from memory would test the memory.
    /// The first is from `dplyr/R/import-standalone-obj-type.R` in the corpus
    /// the exclusion was measured on; the other three are the headers Rcpp,
    /// cpp11 and Go write, the last of which is a specified convention rather
    /// than a habit.
    #[test]
    fn a_file_that_says_it_is_generated_is_recognised() {
        for header in [
            "# Standalone file: do not edit by hand\n# Source: <https://example>\n\nx<-1\n",
            "# Compatibility file: do not edit by hand\n\nx<-1\n",
            "# Generated by using Rcpp::compileAttributes() -> do not edit by hand\n\nx<-1\n",
            "# Generated by cpp11: do not edit by hand\n\nx<-1\n",
            "# Code generated by protoc. DO NOT EDIT.\n\nx<-1\n",
        ] {
            assert!(declares_itself_generated(header), "{header:?}");
        }
    }

    /// And what it must not catch.
    ///
    /// The measurement behind this is the second half: of the 1,445 files in
    /// that corpus arity does format, not one is claimed here. The cases below
    /// are the ways a string match could have gone wrong anyway -- the words in
    /// running code rather than in a header, and the words far enough down that
    /// the file is discussing generated code rather than being it.
    #[test]
    fn a_file_that_merely_mentions_the_words_is_not() {
        for ordinary in [
            "x <- 1\n",
            // Data, not a description of the file.
            "warn(\"do not edit by hand\")\n",
            // A comment, but nine lines down: a file about generated files.
            &format!("{}# do not edit by hand\n", "x <- 1\n".repeat(9)),
            // The other candidate phrase, on its own, in prose.
            "# Helpers generated by hand over the years\n\nx <- 1\n",
        ] {
            assert!(!declares_itself_generated(ordinary), "{ordinary:?}");
        }
    }
}

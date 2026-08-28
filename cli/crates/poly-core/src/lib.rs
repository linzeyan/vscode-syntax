//! Language detection, poly.toml config, and file walking — shared by the CLI
//! and the LSP daemon so editor and CI behavior stay identical (R5/A4).

pub mod diag;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use globset::{Glob, GlobMatcher, GlobSet, GlobSetBuilder};
use serde::Deserialize;

/// Built-in extension -> language id table. Ids match VSCode language ids
/// where one exists so `[languages.map]` values read the same in both worlds.
const EXTENSIONS: &[(&str, &str)] = &[
    ("rs", "rust"),
    ("ts", "typescript"),
    ("tsx", "typescript"),
    ("js", "typescript"),
    ("jsx", "typescript"),
    ("mjs", "typescript"),
    ("cjs", "typescript"),
    ("mts", "typescript"),
    ("cts", "typescript"),
    ("json", "json"),
    ("jsonc", "json"),
    ("md", "markdown"),
    ("markdown", "markdown"),
    ("toml", "toml"),
    ("css", "css"),
    ("scss", "scss"),
    ("less", "less"),
    ("yaml", "yaml"),
    ("yml", "yaml"),
    ("py", "python"),
    ("pyi", "python"),
    // ruff reads and writes .ipynb directly; poly treats it as its own
    // language so the notebook never reaches the plain-Python engine.
    ("ipynb", "jupyter"),
    ("sql", "sql"),
    ("xml", "xml"),
    ("xsd", "xml"),
    ("xsl", "xml"),
    ("xslt", "xml"),
    ("svg", "xml"),
    ("html", "html"),
    ("htm", "html"),
    ("vue", "vue"),
    ("svelte", "svelte"),
    ("astro", "astro"),
    ("jinja", "jinja"),
    ("jinja2", "jinja"),
    ("j2", "jinja"),
    ("graphql", "graphql"),
    ("gql", "graphql"),
    ("graphqls", "graphql"),
    ("sh", "shellscript"),
    ("bash", "shellscript"),
    ("zsh", "shellscript"),
    ("go", "go"),
    ("lua", "lua"),
    ("swift", "swift"),
    ("c", "c"),
    ("h", "cpp"),
    ("cpp", "cpp"),
    ("cc", "cpp"),
    ("cxx", "cpp"),
    ("hpp", "cpp"),
    ("hh", "cpp"),
    ("tf", "terraform"),
    ("tfvars", "terraform"),
    ("hcl", "hcl"),
];

/// Detect by built-in rules only (no config). Filename rules run before
/// extension rules so `Dockerfile.dev` is dockerfile, not a "dev" extension.
pub fn builtin_language(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_str()?;
    if name == "Dockerfile" || name.starts_with("Dockerfile.") || name.ends_with(".dockerfile") {
        return Some("dockerfile");
    }
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    EXTENSIONS.iter().find(|(e, _)| *e == ext).map(|(_, l)| *l)
}

// ── poly.toml ──────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawConfig {
    languages: RawLanguages,
    format: RawFormat,
    lint: RawLint,
    tools: BTreeMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawLanguages {
    map: BTreeMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RawFormat {
    exclude: Vec<String>,
    // Per-language option tables: `[format.python]`, `[format.typescript]`, …
    // serde forbids pairing flatten with deny_unknown_fields, but FormatOptions
    // carries its own, so a typo'd key still fails the parse.
    #[serde(flatten)]
    languages: BTreeMap<String, FormatOptions>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawLint {
    exclude: Vec<String>,
}

/// Per-language formatter knobs from `[format.<lang>]`.
///
/// Deliberately only the three settings every formatter agrees on. Anything
/// engine-specific belongs in that engine's own config file, which the
/// project-local tool layer already defers to (02 §3.4) — re-exposing each
/// engine's full surface here would be a second, worse copy of it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "kebab-case")]
pub struct FormatOptions {
    pub line_width: Option<u16>,
    pub indent_width: Option<u8>,
    pub use_tabs: Option<bool>,
}

impl FormatOptions {
    /// Nothing set: engines can keep using their cached default configuration.
    pub fn is_default(&self) -> bool {
        *self == FormatOptions::default()
    }
}

pub struct Config {
    /// Compiled `[languages.map]`, in file order. Patterns match against the
    /// file name (`*.tpl`) or the full path when the pattern contains a `/`.
    map: Vec<(GlobMatcher, String)>,
    pub format_exclude: Vec<String>,
    pub lint_exclude: Vec<String>,
    format_exclude_set: GlobSet,
    lint_exclude_set: GlobSet,
    format_options: BTreeMap<String, FormatOptions>,
    pub tools: BTreeMap<String, String>,
    /// Directory of the nearest poly.toml (config root); None when no config.
    pub root: Option<PathBuf>,
}

/// Which `exclude` list to consult.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
    Format,
    Lint,
}

impl Config {
    /// Walk upward from `start` (a file or directory), collect every
    /// `poly.toml` on the way, and field-level-merge them with nearer files
    /// winning — monorepo subdirs override only what they declare.
    pub fn discover(start: &Path) -> Result<Config> {
        let mut dir = if start.is_dir() {
            start
        } else {
            start.parent().unwrap_or(start)
        };
        let mut chain: Vec<PathBuf> = Vec::new(); // nearest first
        loop {
            let candidate = dir.join("poly.toml");
            if candidate.is_file() {
                chain.push(candidate);
            }
            match dir.parent() {
                Some(parent) => dir = parent,
                None => break,
            }
        }
        let mut merged = toml::Value::Table(Default::default());
        for path in chain.iter().rev() {
            let text = std::fs::read_to_string(path)
                .with_context(|| format!("reading {}", path.display()))?;
            let value: toml::Value = text
                .parse()
                .with_context(|| format!("parsing {}", path.display()))?;
            merge(&mut merged, value);
        }
        let raw: RawConfig = merged
            .try_into()
            .with_context(|| format!("invalid poly.toml (chain from {})", start.display()))?;
        let mut map = Vec::new();
        for (pattern, lang) in &raw.languages.map {
            let glob = Glob::new(pattern)
                .with_context(|| format!("invalid [languages.map] pattern {pattern:?}"))?;
            map.push((glob.compile_matcher(), lang.clone()));
        }
        Ok(Config {
            map,
            format_exclude_set: compile_excludes(&raw.format.exclude)?,
            lint_exclude_set: compile_excludes(&raw.lint.exclude)?,
            format_exclude: raw.format.exclude,
            lint_exclude: raw.lint.exclude,
            format_options: raw.format.languages,
            tools: raw.tools,
            root: chain
                .first()
                .and_then(|p| p.parent())
                .map(Path::to_path_buf),
        })
    }

    pub fn empty() -> Config {
        Config {
            map: Vec::new(),
            format_exclude: Vec::new(),
            lint_exclude: Vec::new(),
            format_exclude_set: GlobSet::empty(),
            lint_exclude_set: GlobSet::empty(),
            format_options: BTreeMap::new(),
            tools: BTreeMap::new(),
            root: None,
        }
    }

    /// Does this config exclude `path`? Patterns are anchored at the config's
    /// own directory, the way a .gitignore in that directory would be, so a
    /// package-level `poly.toml` saying `generated/**` means its own
    /// `generated/`, not whichever directory the command was invoked from.
    pub fn excluded(&self, path: &Path, scope: Scope) -> bool {
        let set = match scope {
            Scope::Format => &self.format_exclude_set,
            Scope::Lint => &self.lint_exclude_set,
        };
        if set.is_empty() {
            return false;
        }
        let relative = match &self.root {
            Some(root) => path.strip_prefix(root).unwrap_or(path),
            None => path,
        };
        set.is_match(relative)
    }

    /// Formatter knobs for `lang`, from `[format.<lang>]`. Nested poly.toml
    /// files field-merge like everything else, so a package can override just
    /// `line-width` and keep the repo's `indent-width`.
    pub fn format_options(&self, lang: &str) -> FormatOptions {
        self.format_options.get(lang).copied().unwrap_or_default()
    }

    /// `[languages.map]` first (project truth), then built-in detection.
    pub fn language(&self, path: &Path) -> Option<String> {
        let name = path.file_name()?.to_str()?;
        for (matcher, lang) in &self.map {
            let candidate: &Path = if matcher.glob().glob().contains('/') {
                path
            } else {
                Path::new(name)
            };
            if matcher.is_match(candidate) {
                return Some(lang.clone());
            }
        }
        builtin_language(path).map(str::to_string)
    }
}

fn compile_excludes(patterns: &[String]) -> Result<GlobSet> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(
            Glob::new(pattern).with_context(|| format!("invalid exclude pattern {pattern:?}"))?,
        );
    }
    builder.build().context("building exclude matcher")
}

/// Resolves the config for each file in a batch, memoized per directory.
///
/// 02 §"設定分層" wants the nearest `poly.toml` above the *target file*, but a
/// batch run touches thousands of files across a handful of directories, and
/// re-walking the chain for each one would re-read the same TOML over and over.
#[derive(Default)]
pub struct ConfigCache {
    by_dir: HashMap<PathBuf, Arc<Config>>,
}

impl ConfigCache {
    pub fn new() -> ConfigCache {
        ConfigCache::default()
    }

    /// Config governing `path`. An unreadable or invalid `poly.toml` yields an
    /// empty config rather than failing the whole batch — the file itself is
    /// still worth formatting, and `poly check` reports the config error.
    pub fn for_file(&mut self, path: &Path) -> Arc<Config> {
        let dir = path.parent().unwrap_or(path).to_path_buf();
        if let Some(hit) = self.by_dir.get(&dir) {
            return Arc::clone(hit);
        }
        let config = Arc::new(Config::discover(path).unwrap_or_else(|_| Config::empty()));
        self.by_dir.insert(dir, Arc::clone(&config));
        config
    }
}

/// Deep-merge `incoming` into `base`: tables merge key-wise, everything else
/// (scalars, arrays) replaces wholesale.
fn merge(base: &mut toml::Value, incoming: toml::Value) {
    match (base, incoming) {
        (toml::Value::Table(b), toml::Value::Table(inc)) => {
            for (k, v) in inc {
                match b.get_mut(&k) {
                    Some(slot) => merge(slot, v),
                    None => {
                        b.insert(k, v);
                    }
                }
            }
        }
        (slot, v) => *slot = v,
    }
}

// ── file walking ───────────────────────────────────────────────────────────

/// Collect files under `paths`, respecting .gitignore plus `exclude` globs.
/// Explicit file arguments always pass through.
///
/// `anchor` is the directory the patterns are relative to — the config's own
/// root, so `vendor/**` in a repo-root `poly.toml` means the repo's `vendor/`
/// regardless of which subdirectory the command was pointed at. Falls back to
/// the walk root when there is no config (in which case there are no patterns
/// either).
pub fn walk_files(
    paths: &[PathBuf],
    exclude: &[String],
    anchor: Option<&Path>,
) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for root in paths {
        if root.is_file() {
            out.push(root.clone());
            continue;
        }
        let mut overrides = ignore::overrides::OverrideBuilder::new(anchor.unwrap_or(root));
        for pattern in exclude {
            // In OverrideBuilder, a "!" prefix means "ignore this glob".
            overrides
                .add(&format!("!{pattern}"))
                .with_context(|| format!("invalid exclude pattern {pattern:?}"))?;
        }
        let mut builder = ignore::WalkBuilder::new(root);
        // Hidden dirs are skipped wholesale, but .github matters (workflow
        // linting/formatting); walk it as an extra root.
        let github = root.join(".github");
        if github.is_dir() {
            builder.add(github);
        }
        let walker = builder.overrides(overrides.build()?).hidden(true).build();
        for entry in walker {
            let entry = entry?;
            if entry.file_type().is_some_and(|t| t.is_file()) {
                out.push(entry.into_path());
            }
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_detection() {
        let cases = [
            ("a/b.ts", Some("typescript")),
            ("b.yml", Some("yaml")),
            ("Dockerfile", Some("dockerfile")),
            ("Dockerfile.dev", Some("dockerfile")),
            ("base.dockerfile", Some("dockerfile")),
            ("noext", None),
            ("a.unknown", None),
        ];
        for (path, expected) in cases {
            assert_eq!(builtin_language(Path::new(path)), expected, "{path}");
        }
    }

    #[test]
    fn map_overrides_builtin_and_upward_merge() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("poly.toml"),
            "[languages.map]\n\"*.tpl\" = \"hcl\"\n\"*.yml\" = \"json\"\n[format]\nexclude = [\"vendor/**\"]\n",
        )
        .unwrap();
        let sub = root.join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(
            sub.join("poly.toml"),
            "[languages.map]\n\"*.yml\" = \"toml\"\n",
        )
        .unwrap();

        let cfg = Config::discover(&sub.join("x.txt")).unwrap();
        // Nearer file wins per key; unrelated keys inherit from the outer file.
        assert_eq!(cfg.language(Path::new("a.yml")).as_deref(), Some("toml"));
        assert_eq!(cfg.language(Path::new("a.tpl")).as_deref(), Some("hcl"));
        assert_eq!(
            cfg.language(Path::new("a.ts")).as_deref(),
            Some("typescript")
        );
        assert_eq!(cfg.format_exclude, vec!["vendor/**"]);
        assert_eq!(cfg.root.as_deref(), Some(sub.as_path()));

        let outer = Config::discover(root).unwrap();
        assert_eq!(outer.language(Path::new("a.yml")).as_deref(), Some("json"));
    }

    #[test]
    fn format_options_merge_field_wise_across_the_chain() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("poly.toml"),
            "[format.python]\nline-width = 100\nindent-width = 4\n[format.typescript]\nuse-tabs = true\n",
        )
        .unwrap();
        let pkg = root.join("pkg");
        std::fs::create_dir(&pkg).unwrap();
        // Overrides one key; the repo-wide indent-width must survive, or a
        // package could not tweak width without restating everything.
        std::fs::write(pkg.join("poly.toml"), "[format.python]\nline-width = 79\n").unwrap();

        let outer = Config::discover(root).unwrap();
        assert_eq!(outer.format_options("python").line_width, Some(100));
        assert_eq!(outer.format_options("typescript").use_tabs, Some(true));
        // A language with no table gets defaults, not an error.
        assert!(outer.format_options("json").is_default());

        let inner = Config::discover(&pkg).unwrap();
        assert_eq!(inner.format_options("python").line_width, Some(79));
        assert_eq!(inner.format_options("python").indent_width, Some(4));
        assert_eq!(inner.format_options("typescript").use_tabs, Some(true));
    }

    #[test]
    fn a_misspelled_format_option_fails_the_parse() {
        let dir = tempfile::tempdir().unwrap();
        // Silently ignoring this would mean poly.toml says one thing and the
        // output does another, with nothing to look at.
        std::fs::write(
            dir.path().join("poly.toml"),
            "[format.python]\nline_width = 100\n",
        )
        .unwrap();
        let err = match Config::discover(dir.path()) {
            Err(e) => format!("{e:#}"),
            Ok(_) => panic!("a misspelled option must not be silently ignored"),
        };
        assert!(err.contains("poly.toml"), "{err}");
    }

    #[test]
    fn nested_config_applies_per_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("poly.toml"),
            "[languages.map]\n\"*.tpl\" = \"hcl\"\n[format]\nexclude = [\"vendor/**\"]\n",
        )
        .unwrap();
        let pkg = root.join("pkg");
        std::fs::create_dir(&pkg).unwrap();
        std::fs::write(
            pkg.join("poly.toml"),
            "[languages.map]\n\"*.tpl\" = \"json\"\n[format]\nexclude = [\"generated/**\"]\n",
        )
        .unwrap();

        let mut cache = ConfigCache::new();
        // Same extension, two answers — which one depends on where the file is.
        let outer = cache.for_file(&root.join("a.tpl"));
        let inner = cache.for_file(&pkg.join("a.tpl"));
        assert_eq!(outer.language(Path::new("a.tpl")).as_deref(), Some("hcl"));
        assert_eq!(inner.language(Path::new("a.tpl")).as_deref(), Some("json"));

        // Each config's patterns are anchored at its own directory, so the
        // outer `vendor/**` does not reach into pkg/.
        assert!(outer.excluded(&root.join("vendor/x.tpl"), Scope::Format));
        assert!(!outer.excluded(&pkg.join("vendor/x.tpl"), Scope::Format));
        assert!(inner.excluded(&pkg.join("generated/x.tpl"), Scope::Format));
        // Arrays replace rather than merge, so pkg dropped the outer list.
        assert!(!inner.excluded(&pkg.join("vendor/x.tpl"), Scope::Format));
        // lint excludes are a separate list; neither file set one.
        assert!(!inner.excluded(&pkg.join("generated/x.tpl"), Scope::Lint));
    }

    #[test]
    fn walk_respects_gitignore_and_exclude() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("vendor")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join(".gitignore"), "ignored.ts\n").unwrap();
        std::fs::write(root.join("src/keep.ts"), "").unwrap();
        std::fs::write(root.join("ignored.ts"), "").unwrap();
        std::fs::write(root.join("vendor/skip.ts"), "").unwrap();
        // .gitignore matters even outside a git repo? `ignore` only honors it
        // inside a repo, so create the marker.
        std::fs::create_dir_all(root.join(".git")).unwrap();

        let files = walk_files(&[root.to_path_buf()], &["vendor/**".into()], None).unwrap();
        let names: Vec<_> = files
            .iter()
            .map(|p| p.strip_prefix(root).unwrap().to_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"src/keep.ts".to_string()), "{names:?}");
        assert!(!names.iter().any(|n| n.contains("ignored")), "{names:?}");
        assert!(!names.iter().any(|n| n.contains("vendor")), "{names:?}");
    }
}

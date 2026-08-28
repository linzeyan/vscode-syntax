//! Project-local tool detection (resolution layer 2, 02 §3.4): a project
//! that carries its own formatter wins over our embedded engines so poly
//! agrees with the team's CI (A3).

use std::path::{Path, PathBuf};

/// Languages prettier takes over when the project uses it.
pub const PRETTIER_LANGUAGES: &[&str] = &[
    "typescript",
    "json",
    "markdown",
    "css",
    "scss",
    "less",
    "yaml",
    "html",
    "vue",
];

/// Languages biome takes over when the project uses it.
pub const BIOME_LANGUAGES: &[&str] = &["typescript", "json", "css", "graphql"];

/// Walk upward from `start` for `node_modules/.bin/<bin>` next to a config
/// the tool recognizes. The binary alone is not enough: it turns up as a
/// transitive dependency in projects that never chose it, and formatting
/// someone's files with a tool their CI does not run is worse than not
/// formatting them (A3).
fn project_tool(start: &Path, bin: &str, configured: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    // Absolutize so upward walks from relative paths see the full chain.
    let start = std::path::absolute(start).unwrap_or_else(|_| start.to_path_buf());
    let start = start.as_path();
    let mut dir = if start.is_dir() {
        start
    } else {
        start.parent()?
    };
    let exe = if cfg!(windows) {
        format!("{bin}.cmd")
    } else {
        bin.to_string()
    };
    loop {
        let path = dir.join("node_modules").join(".bin").join(&exe);
        if path.is_file() && configured(dir) {
            return Some(path);
        }
        dir = dir.parent()?;
    }
}

fn has_any(dir: &Path, names: &[&str]) -> bool {
    names.iter().any(|c| dir.join(c).is_file())
}

/// The project root a `<root>/node_modules/.bin/<tool>` path came from.
/// biome and eslint both resolve their config relative to the cwd, so the
/// runner has to put them back where detection found them.
pub fn root_of(bin: &Path) -> Option<&Path> {
    bin.ancestors().nth(3)
}

/// Project-local prettier: the binary plus .prettierrc* or a "prettier" key
/// in package.json.
pub fn prettier(start: &Path) -> Option<PathBuf> {
    project_tool(start, "prettier", prettier_config_signal)
}

/// Project-local biome. Checked before prettier by callers: a biome.json is
/// an explicit choice, while a leftover .prettierrc often outlives the
/// migration that replaced it.
pub fn biome(start: &Path) -> Option<PathBuf> {
    project_tool(start, "biome", |dir| {
        has_any(dir, &["biome.json", "biome.jsonc"])
    })
}

fn prettier_config_signal(dir: &Path) -> bool {
    const CONFIGS: &[&str] = &[
        ".prettierrc",
        ".prettierrc.json",
        ".prettierrc.yml",
        ".prettierrc.yaml",
        ".prettierrc.js",
        ".prettierrc.cjs",
        ".prettierrc.mjs",
        ".prettierrc.toml",
        "prettier.config.js",
        "prettier.config.cjs",
        "prettier.config.mjs",
    ];
    if has_any(dir, CONFIGS) {
        return true;
    }
    std::fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|pkg| pkg.get("prettier").is_some())
}

/// Project-local eslint: the binary plus a flat config or legacy .eslintrc*.
pub fn eslint(start: &Path) -> Option<PathBuf> {
    const CONFIGS: &[&str] = &[
        "eslint.config.js",
        "eslint.config.mjs",
        "eslint.config.cjs",
        "eslint.config.ts",
        ".eslintrc",
        ".eslintrc.js",
        ".eslintrc.cjs",
        ".eslintrc.json",
        ".eslintrc.yml",
        ".eslintrc.yaml",
    ];
    project_tool(start, "eslint", |dir| has_any(dir, CONFIGS))
}

/// Rust projects format with their own toolchain (never auto-downloaded):
/// nearest Cargo.toml -> rustfmt from PATH with the crate's edition.
pub struct Rustfmt {
    pub bin: PathBuf,
    pub edition: String,
}

pub fn rustfmt(start: &Path) -> Option<Rustfmt> {
    let start = std::path::absolute(start).unwrap_or_else(|_| start.to_path_buf());
    let start = start.as_path();
    let mut dir = if start.is_dir() {
        start
    } else {
        start.parent()?
    };
    let manifest = loop {
        let candidate = dir.join("Cargo.toml");
        if candidate.is_file() {
            break candidate;
        }
        dir = dir.parent()?;
    };
    let bin = crate::find_on_path("rustfmt")?;
    let edition = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|t| t.parse::<toml::Table>().ok())
        .and_then(|t| {
            let read = |key: &str| {
                t.get(key)?
                    .get("edition")
                    .or_else(|| t.get(key)?.get("package")?.get("edition"))?
                    .as_str()
                    .map(str::to_string)
            };
            read("package").or_else(|| read("workspace"))
        })
        .unwrap_or_else(|| "2021".to_string());
    Some(Rustfmt { bin, edition })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prettier_requires_bin_and_config() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(prettier(root).is_none());

        let bin_dir = root.join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let bin_name = if cfg!(windows) {
            "prettier.cmd"
        } else {
            "prettier"
        };
        std::fs::write(bin_dir.join(bin_name), "").unwrap();
        // Binary without a config signal is not enough.
        assert!(prettier(root).is_none());

        std::fs::write(root.join(".prettierrc"), "{}").unwrap();
        assert!(prettier(root).is_some());

        // Detection walks upward from nested paths.
        let nested = root.join("src").join("deep");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(prettier(&nested).is_some());
    }

    #[test]
    fn rustfmt_edition_from_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"x\"\nedition = \"2018\"\n",
        )
        .unwrap();
        if let Some(r) = rustfmt(&root.join("src").join("lib.rs")) {
            assert_eq!(r.edition, "2018");
        } // rustfmt not on PATH in bare CI: detection returning None is fine.
    }
}

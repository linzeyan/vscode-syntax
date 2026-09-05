//! External tool management: pinned registry, resolution order (02 §3.4),
//! managed downloads with sha256 recorded in poly-tools.lock, and lint
//! runners producing poly_core::diag::Issue.
//!
//! Resolution per tool: poly.toml `[tools]` entry (version pin / "off" /
//! explicit path) -> managed download cache -> PATH. Project-local tool
//! detection (node_modules/.bin, rustfmt) is M4 backlog.

pub mod project;
pub mod run;

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use sha2::Digest;

// ── registry ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Raw,
    TarGz,
    Zip,
}

pub struct Asset {
    pub url: String,
    pub kind: Kind,
}

pub struct Tool {
    pub name: &'static str,
    pub version: &'static str,
    /// Repo-wide tools (typos) have no language; per-language linters list
    /// the poly-core language id they cover.
    pub language: Option<&'static str>,
    asset: fn(version: &str, platform: &str) -> Option<Asset>,
}

impl Tool {
    /// The download for `version` on `platform`, or None where upstream ships
    /// no build for it (each such gap is commented on the tool below).
    ///
    /// Public because the asset naming is only written here, and the sync
    /// pipeline needs the same URLs to look upstream digests up; see
    /// `examples/manifest.rs`.
    pub fn asset(&self, version: &str, platform: &str) -> Option<Asset> {
        (self.asset)(version, platform)
    }
}

/// Every platform key the registry knows. Shared with the tests and the sync
/// pipeline so a platform cannot be added to `current_platform` and forgotten
/// in the coverage check.
pub const PLATFORMS: &[&str] = &[
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win-x64",
    "win-arm64",
];

/// Platform keys: darwin-arm64, darwin-x64, linux-x64, linux-arm64,
/// win-x64, win-arm64.
pub fn current_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", _) => "darwin-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("linux", _) => "linux-x64",
        ("windows", "aarch64") => "win-arm64",
        _ => "win-x64",
    }
}

pub const TOOLS: &[Tool] = &[
    Tool {
        name: "shellcheck",
        version: "0.11.0",
        language: Some("shellscript"),
        // v0.11.0 dropped Windows builds entirely; Windows resolves via PATH.
        asset: |v, p| {
            let triple = match p {
                "darwin-arm64" => "darwin.aarch64",
                "darwin-x64" => "darwin.x86_64",
                "linux-arm64" => "linux.aarch64",
                "linux-x64" => "linux.x86_64",
                _ => return None,
            };
            Some(Asset {
                url: format!(
                    "https://github.com/koalaman/shellcheck/releases/download/v{v}/shellcheck-v{v}.{triple}.tar.gz"
                ),
                kind: Kind::TarGz,
            })
        },
    },
    Tool {
        name: "hadolint",
        version: "2.15.1",
        language: Some("dockerfile"),
        // Windows builds are x86_64-only; win-arm64 runs them via emulation.
        asset: |v, p| {
            let suffix = match p {
                "darwin-arm64" => "macos-arm64",
                "darwin-x64" => "macos-x86_64",
                "linux-arm64" => "linux-arm64",
                "linux-x64" => "linux-x86_64",
                "win-x64" | "win-arm64" => "windows-x86_64.exe",
                _ => return None,
            };
            Some(Asset {
                url: format!(
                    "https://github.com/hadolint/hadolint/releases/download/v{v}/hadolint-{suffix}"
                ),
                kind: Kind::Raw,
            })
        },
    },
    Tool {
        name: "actionlint",
        version: "1.7.12",
        language: Some("github-actions"),
        asset: |v, p| {
            let (suffix, kind) = match p {
                "darwin-arm64" => ("darwin_arm64.tar.gz", Kind::TarGz),
                "darwin-x64" => ("darwin_amd64.tar.gz", Kind::TarGz),
                "linux-arm64" => ("linux_arm64.tar.gz", Kind::TarGz),
                "linux-x64" => ("linux_amd64.tar.gz", Kind::TarGz),
                "win-x64" => ("windows_amd64.zip", Kind::Zip),
                "win-arm64" => ("windows_arm64.zip", Kind::Zip),
                _ => return None,
            };
            Some(Asset {
                url: format!(
                    "https://github.com/rhysd/actionlint/releases/download/v{v}/actionlint_{v}_{suffix}"
                ),
                kind,
            })
        },
    },
    Tool {
        name: "typos",
        version: "1.49.1",
        language: None,
        asset: |v, p| {
            let (triple, kind) = match p {
                "darwin-arm64" => ("aarch64-apple-darwin.tar.gz", Kind::TarGz),
                "darwin-x64" => ("x86_64-apple-darwin.tar.gz", Kind::TarGz),
                "linux-arm64" => ("aarch64-unknown-linux-musl.tar.gz", Kind::TarGz),
                "linux-x64" => ("x86_64-unknown-linux-musl.tar.gz", Kind::TarGz),
                "win-x64" | "win-arm64" => ("x86_64-pc-windows-msvc.zip", Kind::Zip),
                _ => return None,
            };
            Some(Asset {
                url: format!(
                    "https://github.com/crate-ci/typos/releases/download/v{v}/typos-v{v}-{triple}"
                ),
                kind,
            })
        },
    },
    Tool {
        name: "shfmt",
        version: "3.13.1",
        language: Some("shellscript"),
        // Bare binaries; Windows is amd64-only (arm64 emulates).
        asset: |v, p| {
            let suffix = match p {
                "darwin-arm64" => "darwin_arm64",
                "darwin-x64" => "darwin_amd64",
                "linux-arm64" => "linux_arm64",
                "linux-x64" => "linux_amd64",
                "win-x64" | "win-arm64" => "windows_amd64.exe",
                _ => return None,
            };
            Some(Asset {
                url: format!(
                    "https://github.com/mvdan/sh/releases/download/v{v}/shfmt_v{v}_{suffix}"
                ),
                kind: Kind::Raw,
            })
        },
    },
    Tool {
        name: "ruff",
        version: "0.16.5",
        language: Some("python"),
        asset: |v, p| {
            let (triple, kind) = match p {
                "darwin-arm64" => ("aarch64-apple-darwin.tar.gz", Kind::TarGz),
                "darwin-x64" => ("x86_64-apple-darwin.tar.gz", Kind::TarGz),
                "linux-arm64" => ("aarch64-unknown-linux-gnu.tar.gz", Kind::TarGz),
                "linux-x64" => ("x86_64-unknown-linux-gnu.tar.gz", Kind::TarGz),
                "win-x64" => ("x86_64-pc-windows-msvc.zip", Kind::Zip),
                "win-arm64" => ("aarch64-pc-windows-msvc.zip", Kind::Zip),
                _ => return None,
            };
            Some(Asset {
                url: format!(
                    "https://github.com/astral-sh/ruff/releases/download/{v}/ruff-{triple}"
                ),
                kind,
            })
        },
    },
    Tool {
        name: "tflint",
        version: "0.64.0",
        language: Some("terraform"),
        asset: |v, p| {
            let suffix = match p {
                "darwin-arm64" => "darwin_arm64",
                "darwin-x64" => "darwin_amd64",
                "linux-arm64" => "linux_arm64",
                "linux-x64" => "linux_amd64",
                "win-x64" | "win-arm64" => "windows_amd64",
                _ => return None,
            };
            Some(Asset {
                url: format!(
                    "https://github.com/terraform-linters/tflint/releases/download/v{v}/tflint_{suffix}.zip"
                ),
                kind: Kind::Zip,
            })
        },
    },
    Tool {
        name: "gofumpt",
        version: "0.11.0",
        language: Some("go"),
        asset: |v, p| {
            let suffix = match p {
                "darwin-arm64" => "darwin_arm64",
                "darwin-x64" => "darwin_amd64",
                "linux-arm64" => "linux_arm64",
                "linux-x64" => "linux_amd64",
                "win-x64" | "win-arm64" => "windows_amd64.exe",
                _ => return None,
            };
            Some(Asset {
                url: format!(
                    "https://github.com/mvdan/gofumpt/releases/download/v{v}/gofumpt_v{v}_{suffix}"
                ),
                kind: Kind::Raw,
            })
        },
    },
    Tool {
        name: "golangci-lint",
        version: "2.13.2",
        language: Some("go"),
        asset: |v, p| {
            let (suffix, kind) = match p {
                "darwin-arm64" => ("darwin-arm64.tar.gz", Kind::TarGz),
                "darwin-x64" => ("darwin-amd64.tar.gz", Kind::TarGz),
                "linux-arm64" => ("linux-arm64.tar.gz", Kind::TarGz),
                "linux-x64" => ("linux-amd64.tar.gz", Kind::TarGz),
                "win-x64" => ("windows-amd64.zip", Kind::Zip),
                "win-arm64" => ("windows-arm64.zip", Kind::Zip),
                _ => return None,
            };
            Some(Asset {
                url: format!(
                    "https://github.com/golangci/golangci-lint/releases/download/v{v}/golangci-lint-{v}-{suffix}"
                ),
                kind,
            })
        },
    },
    Tool {
        name: "swiftlint",
        version: "0.65.1",
        language: Some("swift"),
        // Only the macOS build stands alone (portable_swiftlint.zip, and the
        // Swift runtime ships with macOS). The Linux and Windows builds link
        // against a runtime that arrives with the Swift toolchain, so
        // downloading them would install something that cannot run; those
        // platforms resolve from PATH, which is where brew/mint/scoop put it
        // anyway. Same shape as shellcheck's missing Windows build.
        asset: |v, p| {
            if !matches!(p, "darwin-arm64" | "darwin-x64") {
                return None;
            }
            Some(Asset {
                url: format!(
                    "https://github.com/realm/SwiftLint/releases/download/{v}/portable_swiftlint.zip"
                ),
                kind: Kind::Zip,
            })
        },
    },
    // The only tool here that is also a language server (`buf lsp serve`).
    // Every other server poly proxies resolves from PATH because it has to
    // match the toolchain that built the project -- gopls reads the Go version
    // out of go.mod, rust-analyzer wants the rustc that compiled the crate,
    // clangd wants the compile database. A .proto file is a declaration with
    // no build behind it, so buf has nothing to match and poly can pin it like
    // any other formatter. That is what makes protobuf work out of the box
    // instead of only for people who already ran `brew install buf`.
    Tool {
        name: "buf",
        version: "1.72.0",
        language: Some("protobuf"),
        // Bare binaries on every platform poly knows, Windows included.
        asset: |v, p| {
            let suffix = match p {
                "darwin-arm64" => "Darwin-arm64",
                "darwin-x64" => "Darwin-x86_64",
                "linux-arm64" => "Linux-aarch64",
                "linux-x64" => "Linux-x86_64",
                "win-x64" => "Windows-x86_64.exe",
                "win-arm64" => "Windows-arm64.exe",
                _ => return None,
            };
            Some(Asset {
                url: format!("https://github.com/bufbuild/buf/releases/download/v{v}/buf-{suffix}"),
                kind: Kind::Raw,
            })
        },
    },
    // Toolchain-only tools (never downloaded, spec §4.3): registry entries so
    // poly.toml [tools] can still pin/disable them; resolution lands on PATH.
    Tool {
        name: "terraform",
        version: "system",
        language: Some("terraform"),
        asset: |_, _| None,
    },
    Tool {
        name: "clang-format",
        version: "system",
        language: Some("cpp"),
        asset: |_, _| None,
    },
    // `cargo clippy`, which is why the entry is named for cargo: clippy is a
    // subcommand, not a binary poly ever invokes directly. It has to come from
    // the project's own toolchain for the same reason rust-analyzer does --
    // clippy is built against one exact rustc, and a downloaded one would
    // disagree with the compiler that builds the crate.
    Tool {
        name: "cargo",
        version: "system",
        language: Some("rust"),
        asset: |_, _| None,
    },
    Tool {
        name: "swift-format",
        version: "system",
        language: Some("swift"),
        asset: |_, _| None,
    },
];

pub fn tool(name: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.name == name)
}

/// Tools that used to be here and are now compiled into poly.
///
/// Kept as data rather than dropped silently because a `[tools]` entry naming
/// one still parses: `selene = "off"` used to turn Lua lint off and would now
/// turn nothing off, and `stylua = "2.4.0"` would ask for a version poly has
/// no way to fetch. Both would be settings that read as working and do
/// nothing, which is the failure `split_flags` and poly.toml's
/// `deny_unknown_fields` already refuse to allow.
const EMBEDDED: &[&str] = &["selene", "stylua"];

/// Stop the run if `[tools]` configures something poly now answers for itself.
pub fn reject_embedded_tools(config: &poly_core::Config) -> Result<()> {
    let Some(name) = config.tools.keys().find(|n| EMBEDDED.contains(&n.as_str())) else {
        return Ok(());
    };
    bail!(
        "poly.toml [tools] {name}: there is no {name} binary to configure — poly \
         formats and lints Lua itself. Drop the line; `[format.lua]` sets the \
         layout and a selene.toml still configures the lints."
    )
}

// ── resolution ─────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub enum Resolved {
    /// Managed download (cache path).
    Managed(PathBuf),
    /// Found on PATH.
    Path(PathBuf),
    /// Explicit path from poly.toml.
    Pinned(PathBuf),
    /// poly.toml says "off".
    Disabled,
    /// Nowhere to get it (and how to fix that).
    Missing(String),
}

impl Resolved {
    pub fn command(&self) -> Option<&Path> {
        match self {
            Resolved::Managed(p) | Resolved::Path(p) | Resolved::Pinned(p) => Some(p),
            _ => None,
        }
    }
}

/// Resolve `name` per 02 §3.4. `offline` skips downloads (A10: report,
/// don't pretend).
pub fn resolve(name: &str, config: &poly_core::Config, offline: bool) -> Resolved {
    let setting = config.tools.get(name).map(String::as_str);
    match setting {
        Some("off") => return Resolved::Disabled,
        Some(s) if s.contains('/') || s.contains('\\') => {
            let p = PathBuf::from(s);
            let p = match (&config.root, p.is_absolute()) {
                (Some(root), false) => root.join(p),
                _ => p,
            };
            return if p.is_file() {
                Resolved::Pinned(p)
            } else {
                Resolved::Missing(format!(
                    "poly.toml points {name} at {} (not found)",
                    p.display()
                ))
            };
        }
        _ => {}
    }
    let Some(tool) = tool(name) else {
        return Resolved::Missing(format!("unknown tool {name:?}"));
    };
    // A version pin overrides the registry default.
    let version = setting.unwrap_or(tool.version);
    match ensure_installed(tool, version, config, offline) {
        Ok(Some(path)) => return Resolved::Managed(path),
        Ok(None) => {} // no asset for this platform: fall through to PATH
        Err(e) => {
            // Download failed (offline, checksum, ...): fall back to PATH but
            // remember why in case PATH misses too.
            if let Some(path) = find_on_path(name) {
                return Resolved::Path(path);
            }
            return Resolved::Missing(format!("{e:#}"));
        }
    }
    match find_on_path(name) {
        Some(path) => Resolved::Path(path),
        None => Resolved::Missing(format!(
            "{name} has no managed build for {} and is not on PATH",
            current_platform()
        )),
    }
}

/// Last resort of `resolve`, and the only route for the tools poly never
/// installs for you — rustfmt, clang-format, and the language servers the LSP
/// daemon proxies, all of which have to match the project's own toolchain.
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    std::env::var_os("PATH")?.to_str().map(|paths| {
        std::env::split_paths(paths)
            .map(|d| d.join(&exe))
            .find(|p| p.is_file())
    })?
}

// ── managed download ───────────────────────────────────────────────────────

pub fn cache_dir() -> PathBuf {
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("poly")
            .join("tools")
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
            .unwrap_or_else(std::env::temp_dir)
            .join("poly")
            .join("tools")
    }
}

fn lock_path(config: &poly_core::Config) -> PathBuf {
    config
        .root
        .clone()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("poly-tools.lock")
}

/// Download+verify+extract `tool` into the cache; returns None when the
/// platform has no asset. Already-cached binaries return immediately.
/// First download records the sha256 in poly-tools.lock (trust on first
/// use); later downloads must match it.
fn ensure_installed(
    tool: &Tool,
    version: &str,
    config: &poly_core::Config,
    offline: bool,
) -> Result<Option<PathBuf>> {
    let platform = current_platform();
    let Some(asset) = (tool.asset)(version, platform) else {
        return Ok(None);
    };
    let exe = if cfg!(windows) {
        format!("{}.exe", tool.name)
    } else {
        tool.name.to_string()
    };
    let target = cache_dir()
        .join(format!("{}-{}", tool.name, version))
        .join(&exe);
    if target.is_file() {
        return Ok(Some(target));
    }
    if offline {
        bail!(
            "{} {} not cached and downloads are disabled",
            tool.name,
            version
        );
    }

    eprintln!(
        "[poly] downloading {} {} for {platform}...",
        tool.name, version
    );
    let body = ureq::get(&asset.url)
        .call()
        .with_context(|| format!("downloading {}", asset.url))?
        .body_mut()
        .with_config()
        .limit(512 * 1024 * 1024)
        .read_to_vec()
        .context("reading download body")?;
    let digest = format!("{:x}", sha2::Sha256::digest(&body));

    let lock_file = lock_path(config);
    let mut lock: toml::Table = std::fs::read_to_string(&lock_file)
        .ok()
        .and_then(|t| t.parse().ok())
        .unwrap_or_default();
    let key = format!("{}-{}", version, platform);
    let entry = lock
        .entry(tool.name.to_string())
        .or_insert_with(|| toml::Value::Table(Default::default()));
    match entry.get(&key).and_then(|v| v.as_str()) {
        Some(expected) if expected != digest => bail!(
            "{} {} sha256 mismatch: lock has {expected}, download is {digest} — upstream re-tagged or download corrupted",
            tool.name,
            version
        ),
        Some(_) => {}
        None => {
            if let Some(table) = entry.as_table_mut() {
                table.insert(key, toml::Value::String(digest.clone()));
            }
            std::fs::write(&lock_file, toml::to_string_pretty(&lock)?)
                .with_context(|| format!("writing {}", lock_file.display()))?;
        }
    }

    extract(&body, asset.kind, tool.name, &target)?;
    Ok(Some(target))
}

/// Pull the tool binary out of the payload and land it at `target`
/// atomically (temp file + rename) so a crashed download never half-installs.
///
/// The scratch file is unique per installer, not just per tool. Sharing one
/// name looks safe because the rename is atomic, and is not: the loser of the
/// race is still holding a write handle on the inode the winner just renamed
/// into place, and Linux refuses to exec a file that is open for writing --
/// ETXTBSY, "Text file busy". Two poly processes with a cold cache is the
/// ordinary way to hit it, and so is one poly linting two files that need the
/// same missing tool, since files are linted concurrently.
fn extract(body: &[u8], kind: Kind, name: &str, target: &Path) -> Result<()> {
    let dir = target.parent().expect("cache target has parent");
    std::fs::create_dir_all(dir)?;
    let tmp = target.with_extension(format!(
        "tmp.{}.{}",
        std::process::id(),
        // The pid alone would still collide between threads of one poly.
        INSTALL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let outcome = unpack(body, kind, name, &tmp).and_then(|()| install(&tmp, target));
    if outcome.is_err() {
        // A unique name means a failure leaves litter rather than something
        // the next attempt overwrites, so this has to clean up after itself.
        let _ = std::fs::remove_file(&tmp);
    }
    outcome
}

/// Distinguishes concurrent installers within one process. See `extract`.
static INSTALL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Make `tmp` executable and move it into place, closing every handle first.
fn install(tmp: &Path, target: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(tmp, target)?;
    Ok(())
}

fn unpack(body: &[u8], kind: Kind, name: &str, tmp: &Path) -> Result<()> {
    let exe_names = [name.to_string(), format!("{name}.exe")];
    match kind {
        Kind::Raw => std::fs::write(tmp, body)?,
        Kind::TarGz => {
            let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(body));
            let mut found = false;
            for entry in archive.entries()? {
                let mut entry = entry?;
                let path = entry.path()?;
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if exe_names.iter().any(|n| n == file_name) {
                    entry.unpack(tmp)?;
                    found = true;
                    break;
                }
            }
            if !found {
                bail!("{name} not found inside tar.gz");
            }
        }
        Kind::Zip => {
            let mut archive = zip::ZipArchive::new(std::io::Cursor::new(body))?;
            let index = (0..archive.len())
                .find(|&i| {
                    let file = archive.by_index(i);
                    file.map(|f| {
                        let base = f
                            .name()
                            .rsplit(['/', '\\'])
                            .next()
                            .unwrap_or("")
                            .to_string();
                        exe_names.contains(&base)
                    })
                    .unwrap_or(false)
                })
                .ok_or_else(|| anyhow!("{name} not found inside zip"))?;
            let mut file = archive.by_index(index)?;
            let mut out = std::fs::File::create(tmp)?;
            std::io::copy(&mut file, &mut out)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two installers of the same tool must not share a scratch file.
    ///
    /// Found by CI, which is the only place this could show up: a cold tool
    /// cache plus `cargo test` running test binaries in parallel had two poly
    /// processes install typos at once, and the loser's still-open write
    /// handle made the winner's exec fail with ETXTBSY -- "Text file busy",
    /// which only Linux raises. macOS runs the binary regardless, so no amount
    /// of local testing would have found it.
    ///
    /// Threads rather than processes here, because a shared temp name collides
    /// the same way inside one poly: files are linted concurrently, and two of
    /// them wanting the same missing tool is the ordinary case. The payload is
    /// large on purpose -- a small one lands in a single write and the race is
    /// invisible.
    #[test]
    fn concurrent_installs_do_not_share_a_scratch_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("cache").join("typos");
        let body: Vec<u8> = (0..4 << 20).map(|i| (i % 251) as u8).collect();

        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| extract(&body, Kind::Raw, "typos", &target)))
                .collect();
            for handle in handles {
                handle.join().unwrap().expect("install failed");
            }
        });

        // Whichever installer renamed last, the file it left has to be whole:
        // a reader that finds a short or interleaved binary is the corruption
        // ETXTBSY was protecting against.
        assert_eq!(
            std::fs::read(&target).unwrap(),
            body,
            "installed a torn file"
        );
        assert!(
            std::fs::read_dir(target.parent().unwrap())
                .unwrap()
                .filter_map(Result::ok)
                .all(|entry| entry.path() == target),
            "left scratch files behind in the cache"
        );
    }

    fn config_with_tools(entries: &[(&str, &str)]) -> poly_core::Config {
        let dir = tempfile::tempdir().unwrap();
        let mut body = String::from("[tools]\n");
        for (k, v) in entries {
            body.push_str(&format!("{k} = \"{v}\"\n"));
        }
        std::fs::write(dir.path().join("poly.toml"), body).unwrap();
        let config = poly_core::Config::discover(dir.path()).unwrap();
        // Keep tempdir alive long enough; leak it (tests only).
        std::mem::forget(dir);
        config
    }

    #[test]
    fn off_disables() {
        let config = config_with_tools(&[("shellcheck", "off")]);
        assert_eq!(resolve("shellcheck", &config, true), Resolved::Disabled);
    }

    #[test]
    fn explicit_path_must_exist() {
        let config = config_with_tools(&[("shellcheck", "/nonexistent/bin/shellcheck")]);
        assert!(matches!(
            resolve("shellcheck", &config, true),
            Resolved::Missing(_)
        ));
    }

    /// Lua is formatted and linted in-process now, so there is no stylua or
    /// selene binary for `[tools]` to point at, pin or turn off. Accepting the
    /// line and ignoring it would leave someone believing they had disabled a
    /// linter that is still reporting.
    #[test]
    fn tools_entries_for_embedded_lua_stop_the_run() {
        for entry in [("selene", "off"), ("stylua", "2.4.0")] {
            let config = config_with_tools(&[entry]);
            let error = reject_embedded_tools(&config)
                .expect_err("an entry poly cannot honor must fail")
                .to_string();
            assert!(error.contains(entry.0), "{error}");
        }
        // Everything else is still a tool with a binary behind it.
        assert!(reject_embedded_tools(&config_with_tools(&[("shellcheck", "off")])).is_ok());
    }

    #[test]
    fn unknown_tool_is_missing() {
        let config = poly_core::Config::empty();
        assert!(matches!(
            resolve("nosuch", &config, true),
            Resolved::Missing(_)
        ));
    }

    #[test]
    fn offline_uncached_falls_back_to_path_or_missing() {
        let config = poly_core::Config::empty();
        // With offline=true and (presumably) no cache in CI, resolution must
        // not panic — it lands on Path (dev machines) or Missing (bare CI).
        match resolve("actionlint", &config, true) {
            Resolved::Managed(_) | Resolved::Path(_) | Resolved::Missing(_) => {}
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn registry_covers_all_platforms_or_declares_gap() {
        for tool in TOOLS {
            for platform in PLATFORMS {
                // Must not panic; None (documented gap) is acceptable.
                let _ = tool.asset(tool.version, platform);
            }
        }
    }
}

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
    /// The poly-core language id this linter covers. `None` would mean a tool
    /// that reads every file regardless; typos was the only one, and it is
    /// compiled in now (`poly_engines::lint::spell`).
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
/// Each entry carries the sentence that tells its user what to do instead,
/// because "this setting does nothing" is only half an answer -- the project
/// configured it for a reason, and the reason still has somewhere to go.
///
/// Public because it is one column of the table poly-cli checks `[tools]`
/// against and generates poly.example.toml from. An embedded name and a
/// misspelled one are the same mistake, so they are answered by one pass over
/// one table rather than by two mechanisms that could disagree.
pub const EMBEDDED: &[(&str, &str)] = &[
    ("selene", LUA_INSTEAD),
    ("stylua", LUA_INSTEAD),
    ("ruff", PYTHON_INSTEAD),
    ("typos", TYPOS_INSTEAD),
];

const LUA_INSTEAD: &str = "poly formats and lints Lua itself. Drop the line; \
     `[format.lua]` sets the layout and a selene.toml still configures the lints.";

const PYTHON_INSTEAD: &str = "poly formats and lints Python itself. Drop the line; \
     `[format.python]` sets the layout and a pyproject.toml or ruff.toml still \
     selects the rules.";

const TYPOS_INSTEAD: &str = "poly spell-checks every file itself. Drop the line; \
     a _typos.toml still holds `[default.extend-words]` and `[files] extend-exclude`, \
     and `[lint] per-file-ignores` can silence `typos/typo` per path.";

/// Registry tools poly does not run unless a project asks for them.
///
/// Not the same thing as `EMBEDDED`: those stopped being binaries, and an entry
/// naming one is a mistake. These are still real tools, still downloadable,
/// still pinned in poly-tools.lock -- `[tools] hadolint = "on"` gets the actual
/// thing. What changed is the default, and only because poly grew its own
/// answer for the same files.
///
/// hadolint is the only one. Measured over 256 real Dockerfiles, 23 of its 39
/// rules are a second opinion on a rule poly already has, its shellcheck half is
/// a subset of what poly's own shellcheck seam finds (65 findings against 534,
/// with no code hadolint has that poly does not), and the two disagree on
/// severity for 9 of the 23 -- which made `[lint] fail-on` depend on which of
/// the two spoke first. Running both printed 62 findings for 35 defects on the
/// audit fixture. Turning it off is how a Dockerfile gets one answer.
pub const DEFAULT_OFF: &[&str] = &["hadolint"];

/// Is `name` a tool poly leaves off until poly.toml says otherwise?
pub fn default_off(name: &str) -> bool {
    DEFAULT_OFF.contains(&name)
}

// ── resolution ─────────────────────────────────────────────────────────────

/// The binary a `[tools]` value points at, or None when the value is not a
/// path (`"off"`, or a version).
///
/// Relative paths resolve against the poly.toml that wrote them, not the
/// working directory, so a repo-root entry means the same thing whichever
/// subdirectory poly was invoked from. Shared with the validator in poly-cli:
/// "does this path exist" has to be asked of the same path `resolve` will use,
/// or the check would pass on a file the run then cannot find.
pub fn explicit_path(value: &str, config: &poly_core::Config) -> Option<PathBuf> {
    if !value.contains('/') && !value.contains('\\') {
        return None;
    }
    let path = PathBuf::from(value);
    Some(match (&config.root, path.is_absolute()) {
        (Some(root), false) => root.join(path),
        _ => path,
    })
}

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
    /// Off because poly does not run it unless asked, and poly.toml did not
    /// ask. See `DEFAULT_OFF`.
    ///
    /// Its own variant rather than `Disabled` because the callers print
    /// different things, and printing the wrong one is a lie either way: a
    /// project that never mentioned hadolint has no "disabled in poly.toml" to
    /// be told about, and would reasonably go looking for the line.
    OffByDefault,
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
///
/// A `[tools]` value is `"off"`, `"on"`, a version, or a path. `"on"` is the
/// counterpart of `"off"` and means the version poly pins -- for most tools
/// that is what happens anyway, and for a `DEFAULT_OFF` one it is how a project
/// asks for it. One grammar for every tool, rather than a value that only means
/// something for the tools that happen to be off today.
pub fn resolve(name: &str, config: &poly_core::Config, offline: bool) -> Resolved {
    let setting = config.tools.get(name).map(String::as_str);
    if setting == Some("off") {
        return Resolved::Disabled;
    }
    // Silence, not a download, and before the registry lookup: a repository
    // with a Dockerfile and no opinion about hadolint must not pay for fetching
    // it, which is most of the point of turning it off.
    if setting.is_none() && default_off(name) {
        return Resolved::OffByDefault;
    }
    if let Some(path) = setting.and_then(|s| explicit_path(s, config)) {
        return if path.is_file() {
            Resolved::Pinned(path)
        } else {
            Resolved::Missing(format!(
                "poly.toml points {name} at {} (not found)",
                path.display()
            ))
        };
    }
    let Some(tool) = tool(name) else {
        return Resolved::Missing(format!("unknown tool {name:?}"));
    };
    // A version pin overrides the registry default; `"on"` asks for exactly the
    // registry default, which is the only thing it can mean.
    let version = match setting {
        Some("on") | None => tool.version,
        Some(pinned) => pinned,
    };
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
    let body = download(&asset.url)?;
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

/// How many times one asset is fetched before poly calls it missing.
///
/// Four, because the failure this exists for is a single TCP reset from a
/// release CDN and the next attempt almost always survives it. The cost of
/// being wrong is paid by someone on a genuinely dead network, so it is capped:
/// with the backoff below, a hopeless download costs 1.75s of waiting before
/// the error prints, which is under the point where a human wonders if poly
/// hung.
const DOWNLOAD_ATTEMPTS: u32 = 4;

/// Delay before the second attempt; doubles from there (250ms, 500ms, 1s).
///
/// No jitter. Jitter exists to break up many clients retrying one server in
/// lockstep, and poly is one process on one developer's machine or one CI
/// runner -- there is no herd to spread out, so a PRNG here would buy a
/// dependency and a non-reproducible test and nothing else.
const DOWNLOAD_BACKOFF: std::time::Duration = std::time::Duration::from_millis(250);

/// GET `url` and return the body, retrying failures that could go differently.
///
/// One attempt covers the response *and* the body read, because a reset can
/// arrive after the headers and half a tarball is worth no more than none.
///
/// Everything past this function is deliberately outside the loop: the sha256
/// comparison against poly-tools.lock, extraction, and the write into the
/// cache. A digest that disagrees with the lock is a statement about the bytes
/// -- upstream re-tagged, or something in the middle rewrote them -- and
/// quietly downloading again until one passes is exactly how a tamper signal
/// turns into a flake.
fn download(url: &str) -> Result<Vec<u8>> {
    let mut attempt = 1u32;
    loop {
        let error = match ureq::get(url).call().and_then(|mut response| {
            response
                .body_mut()
                .with_config()
                .limit(512 * 1024 * 1024)
                .read_to_vec()
        }) {
            Ok(body) => return Ok(body),
            Err(error) => error,
        };
        if !is_transient(&error) || attempt == DOWNLOAD_ATTEMPTS {
            // The count goes in the message only once attempts were actually
            // spent: a real outage must not read like one unlucky packet, and
            // a 404 must not claim a persistence that never happened.
            let tried = if attempt > 1 {
                format!(", gave up after {attempt} attempts")
            } else {
                String::new()
            };
            return Err(anyhow::Error::new(error))
                .with_context(|| format!("downloading {url}{tried}"));
        }
        eprintln!("[poly] {url}: {error} — retrying ({attempt}/{DOWNLOAD_ATTEMPTS})");
        std::thread::sleep(DOWNLOAD_BACKOFF * 2u32.pow(attempt - 1));
        attempt += 1;
    }
}

/// Whether asking for the same URL again could plausibly answer differently.
///
/// The line is "no answer arrived, or the answer was about the server rather
/// than about this asset". Retrying anything else is worse than useless: a 404
/// for a release upstream never published would spend the whole backoff before
/// printing what the first attempt already knew.
fn is_transient(error: &ureq::Error) -> bool {
    match error {
        // 5xx is the origin saying "not now" and 429 is it saying "not this
        // fast". Every other 4xx is about the request, and poly sends a
        // byte-identical request every time.
        ureq::Error::StatusCode(code) => *code >= 500 || *code == 429,
        // The socket failures behind the CI log this exists for. UnexpectedEof
        // is how a reset *mid-body* surfaces: the headers already parsed, so
        // ureq reports a short read rather than a reset.
        ureq::Error::Io(e) => matches!(
            e.kind(),
            std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::ConnectionRefused
                | std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::UnexpectedEof
                | std::io::ErrorKind::NotConnected
                | std::io::ErrorKind::TimedOut
                | std::io::ErrorKind::Interrupted
        ),
        ureq::Error::Timeout(_) | ureq::Error::ConnectionFailed => true,
        // A truncated or otherwise malformed HTTP frame. Same class as the
        // short read above, reached when the transfer was chunked: the
        // connection died partway and ureq noticed at the framing layer first.
        ureq::Error::Protocol(_) => true,
        // Resolution failure, which ureq cannot tell apart from a hostname
        // that will never resolve. Retried anyway, because every URL the
        // registry builds is a literal in this file -- the realistic cause is
        // a resolver that is not up yet, in a container whose network is still
        // coming online or on a laptop that just woke.
        ureq::Error::HostNotFound => true,
        // Everything else is an answer rather than a gap: a bad URI, a TLS
        // chain that does not verify, a redirect loop, a body over the limit.
        // `ConnectProxyFailed` is in here on purpose -- an unreachable or
        // unauthenticated proxy is a configuration answer, and repeating the
        // CONNECT delays it without changing it.
        _ => false,
    }
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

    /// A `DEFAULT_OFF` tool is off with no poly.toml at all, and `"on"` is how
    /// a project asks for it back.
    ///
    /// The distinction from `Disabled` is what the callers print: nobody who
    /// never wrote a poly.toml should be told a tool is "disabled in poly.toml".
    /// And the offline resolve has to reach the answer without a download --
    /// most repositories with a Dockerfile will never want hadolint, and making
    /// them fetch it to find that out is most of what this change undoes.
    #[test]
    fn a_default_off_tool_stays_off_until_asked_for() {
        assert_eq!(
            resolve("hadolint", &poly_core::Config::empty(), true),
            Resolved::OffByDefault
        );
        // Explicitly off is still its own answer, because the reader of the
        // message wrote the line.
        assert_eq!(
            resolve("hadolint", &config_with_tools(&[("hadolint", "off")]), true),
            Resolved::Disabled
        );
        // "on" asks for the pinned version. Offline here, so it lands wherever
        // this machine already has one -- what must not happen is the tool
        // still reporting as off.
        let on = resolve("hadolint", &config_with_tools(&[("hadolint", "on")]), true);
        assert!(
            !matches!(on, Resolved::OffByDefault | Resolved::Disabled),
            "{on:?}"
        );
        // And "on" is a value every tool takes, meaning the same thing: the
        // version poly pins. A grammar with a value that only works for some
        // names is one more thing to look up.
        let on = resolve(
            "shellcheck",
            &config_with_tools(&[("shellcheck", "on")]),
            true,
        );
        assert!(
            !matches!(on, Resolved::OffByDefault | Resolved::Disabled),
            "{on:?}"
        );
        // "on" is not a path, so the poly.toml validator must not test it as
        // one -- see `a_tools_path_that_does_not_exist_is_fatal`.
        assert_eq!(explicit_path("on", &poly_core::Config::empty()), None);
        // Every name in DEFAULT_OFF is a real registry entry that can still be
        // downloaded. A typo here would turn a tool off and never say so.
        for name in DEFAULT_OFF {
            let entry = tool(name).unwrap_or_else(|| panic!("{name} is not in the registry"));
            assert_ne!(entry.version, "system", "{name} has nothing to download");
        }
    }

    #[test]
    fn explicit_path_must_exist() {
        let config = config_with_tools(&[("shellcheck", "/nonexistent/bin/shellcheck")]);
        assert!(matches!(
            resolve("shellcheck", &config, true),
            Resolved::Missing(_)
        ));
    }

    /// A relative `[tools]` path is the poly.toml's, not the caller's.
    ///
    /// The distinction only shows up when poly is run from a subdirectory, and
    /// then it decides whether the tool is found at all. Shared with the
    /// poly.toml validator so the file it checks for is the file `resolve`
    /// would run.
    #[test]
    fn an_explicit_path_is_anchored_at_the_config() {
        let config = config_with_tools(&[("shellcheck", "bin/shellcheck")]);
        let root = config.root.clone().expect("config root");
        assert_eq!(
            explicit_path("bin/shellcheck", &config),
            Some(root.join("bin/shellcheck"))
        );
        // Neither of the other two value shapes is a path.
        assert_eq!(explicit_path("off", &config), None);
        assert_eq!(explicit_path("0.11.0", &config), None);
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

    // ── downloads ──────────────────────────────────────────────────────────
    //
    // Every test below drives the real `download`/`ensure_installed` against a
    // TCP listener this process owns, rather than a mock of ureq. The bug being
    // fixed lives in how a socket failure reaches poly -- a mock that returns a
    // hand-made `ureq::Error` would be asserting on the classifier's input,
    // which is the one part that was never in doubt.

    /// What a fake origin does with the next connection it is handed.
    #[derive(Clone)]
    enum Reply {
        /// Read one byte of the request and close, leaving the rest queued:
        /// closing a socket with unread data is what makes the kernel send an
        /// RST instead of a FIN, which is the "Connection reset by peer" this
        /// whole path exists for. Should a platform send a FIN anyway, ureq
        /// reports a premature EOF, which is the same class and also retried.
        Reset,
        /// Answer with a status and an empty body.
        Status(u16),
        /// Answer 200 with these bytes.
        Body(Vec<u8>),
        /// Promise a body, send `usize` bytes of it, hang up. A reset that
        /// lands after the headers have already parsed.
        Truncated(usize),
    }

    /// A local origin answering a scripted sequence, plus the count of
    /// connections it was given. The last reply repeats once the script runs
    /// out, so a test asserting "this was not retried" still detects a retry
    /// instead of hanging on a closed port.
    ///
    /// Every answer carries `Connection: close`, which keeps ureq from pooling
    /// the socket and makes the connection count equal the attempt count.
    ///
    /// The thread is never joined: it owns the listener for as long as the test
    /// binary runs, and process exit is the only cleanup it needs.
    fn origin(script: Vec<Reply>) -> (u16, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(AtomicUsize::new(0));
        let counter = std::sync::Arc::clone(&seen);
        std::thread::spawn(move || {
            for (index, stream) in listener.incoming().flatten().enumerate() {
                counter.fetch_add(1, Ordering::SeqCst);
                let reply = script
                    .get(index)
                    .or_else(|| script.last())
                    .cloned()
                    .unwrap_or(Reply::Reset);
                serve(stream, reply);
            }
        });
        (port, seen)
    }

    fn serve(mut stream: std::net::TcpStream, reply: Reply) {
        use std::io::{Read, Write};
        let mut byte = [0u8; 1];
        if matches!(reply, Reply::Reset) {
            // Blocking on one byte proves the request arrived, so this is a
            // close-with-data-queued rather than a race with the client's
            // write -- and the queued remainder is what makes it an RST.
            let _ = stream.read(&mut byte);
            return;
        }
        // Every other reply has to drain the request first. Closing with any
        // of it unread sends an RST, which discards the response the client
        // has not read yet and turns every scripted answer into a reset.
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            match stream.read(&mut byte) {
                Ok(1) => head.push(byte[0]),
                _ => break,
            }
        }
        let mut write = |head: String, body: &[u8]| {
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body);
            let _ = stream.flush();
        };
        match reply {
            Reply::Reset => {}
            Reply::Status(code) => write(
                format!(
                    "HTTP/1.1 {code} Scripted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                ),
                &[],
            ),
            Reply::Body(body) => write(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                ),
                &body,
            ),
            Reply::Truncated(sent) => write(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    sent * 4
                ),
                &vec![b'x'; sent],
            ),
        }
    }

    fn asset_url(port: u16) -> String {
        format!("http://127.0.0.1:{port}/asset")
    }

    /// A reset says something about this moment, not about the asset. Poly has
    /// to ask again, and a download that succeeds on the second attempt is a
    /// download that succeeded -- not a missing tool and not a red CI step.
    #[test]
    fn a_reset_connection_is_retried_and_can_succeed() {
        use std::sync::atomic::Ordering;
        let payload = b"the tool bytes".to_vec();
        let (port, seen) = origin(vec![Reply::Reset, Reply::Body(payload.clone())]);
        let body = download(&asset_url(port)).expect("a reset must not end the download");
        assert_eq!(body, payload);
        assert_eq!(seen.load(Ordering::SeqCst), 2, "expected exactly one retry");
    }

    /// Same class one layer up: a release CDN answering 503 for a few seconds
    /// is the ordinary shape of a partial outage, and it clears by itself.
    #[test]
    fn a_5xx_is_retried_and_can_succeed() {
        use std::sync::atomic::Ordering;
        let payload = b"the tool bytes".to_vec();
        let (port, seen) = origin(vec![Reply::Status(503), Reply::Body(payload.clone())]);
        let body = download(&asset_url(port)).expect("a 503 must not end the download");
        assert_eq!(body, payload);
        assert_eq!(seen.load(Ordering::SeqCst), 2);
    }

    /// The retry has to wrap the body read, not just the connect: a cut that
    /// lands after the headers leaves poly holding half a tarball, which is
    /// worth exactly what none of it is worth.
    #[test]
    fn a_body_cut_short_is_retried_and_can_succeed() {
        use std::sync::atomic::Ordering;
        let payload = b"the tool bytes".to_vec();
        let (port, seen) = origin(vec![Reply::Truncated(8), Reply::Body(payload.clone())]);
        let body = download(&asset_url(port)).expect("a short body must not end the download");
        assert_eq!(body, payload);
        assert_eq!(seen.load(Ordering::SeqCst), 2);
    }

    /// A 404 is the server answering about this asset, and poly sends a
    /// byte-identical request every time. Retrying would spend the whole
    /// backoff before printing what the first attempt already knew.
    #[test]
    fn a_404_is_not_retried() {
        use std::sync::atomic::Ordering;
        let (port, seen) = origin(vec![Reply::Status(404)]);
        let error = download(&asset_url(port)).expect_err("404 is not a download");
        assert_eq!(seen.load(Ordering::SeqCst), 1, "a 404 was asked again");
        let error = format!("{error:#}");
        assert!(error.contains("404"), "{error}");
        // The count is reserved for downloads that actually spent attempts.
        assert!(!error.contains("attempts"), "{error}");
    }

    /// A real outage must not read like one unlucky packet. The CI log that
    /// prompted this said only "Connection reset by peer", which left no way to
    /// tell whether poly had tried at all.
    #[test]
    fn exhausting_the_attempts_names_the_count() {
        use std::sync::atomic::Ordering;
        let (port, seen) = origin(vec![Reply::Reset]);
        let error = download(&asset_url(port)).expect_err("nothing was ever served");
        assert_eq!(seen.load(Ordering::SeqCst), DOWNLOAD_ATTEMPTS as usize);
        let error = format!("{error:#}");
        assert!(
            error.contains(&format!("gave up after {DOWNLOAD_ATTEMPTS} attempts")),
            "{error}"
        );
    }

    /// The port has to reach the registry entry through a static: `Tool::asset`
    /// is a plain `fn` pointer and cannot capture one. A static per test keeps
    /// the two from racing.
    static MISMATCH_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
    static OFFLINE_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

    /// Names nothing real, so its cache directory cannot exist and the run
    /// cannot be short-circuited by a tool someone already installed.
    const PROBE_VERSION: &str = "0.0.0";

    fn mismatch_probe() -> Tool {
        Tool {
            name: "poly-mismatch-probe",
            version: PROBE_VERSION,
            language: None,
            asset: |_, _| {
                Some(Asset {
                    url: asset_url(*MISMATCH_PORT.get().expect("port published")),
                    kind: Kind::Raw,
                })
            },
        }
    }

    fn offline_probe() -> Tool {
        Tool {
            name: "poly-offline-probe",
            version: PROBE_VERSION,
            language: None,
            asset: |_, _| {
                Some(Asset {
                    url: asset_url(*OFFLINE_PORT.get().expect("port published")),
                    kind: Kind::Raw,
                })
            },
        }
    }

    /// A digest that disagrees with poly-tools.lock says the bytes are not the
    /// ones this project agreed to run -- upstream re-tagged, or something in
    /// the middle rewrote them. Fetching again until one passes is exactly how
    /// a tamper signal turns into a flake, so the retry must stop at the
    /// socket: one fetch, one verdict, said out loud.
    #[test]
    fn a_sha256_mismatch_is_not_retried() {
        use std::sync::atomic::Ordering;
        let tool = mismatch_probe();
        let (port, seen) = origin(vec![Reply::Body(b"not what the lock says".to_vec())]);
        MISMATCH_PORT.set(port).unwrap();

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("poly-tools.lock"),
            format!(
                "[{}]\n\"{PROBE_VERSION}-{}\" = \"{}\"\n",
                tool.name,
                current_platform(),
                "0".repeat(64)
            ),
        )
        .unwrap();
        let mut config = poly_core::Config::empty();
        config.root = Some(dir.path().to_path_buf());

        let error = ensure_installed(&tool, PROBE_VERSION, &config, false)
            .expect_err("a digest that disagrees with the lock is not an install");
        assert_eq!(
            seen.load(Ordering::SeqCst),
            1,
            "a bad digest was downloaded again"
        );
        let error = format!("{error:#}");
        assert!(error.contains("sha256 mismatch"), "{error}");
        assert!(!error.contains("attempts"), "{error}");
    }

    /// `offline` is a promise, not a preference. An air-gapped run must not
    /// open a socket at all, and adding retries is precisely the change that
    /// could turn one skipped request into four.
    #[test]
    fn offline_does_not_reach_the_network() {
        use std::sync::atomic::Ordering;
        let (port, seen) = origin(vec![Reply::Body(b"never served".to_vec())]);
        OFFLINE_PORT.set(port).unwrap();
        let config = poly_core::Config::empty();
        let error = ensure_installed(&offline_probe(), PROBE_VERSION, &config, true)
            .expect_err("nothing is cached, so offline has no answer");
        assert_eq!(
            seen.load(Ordering::SeqCst),
            0,
            "offline opened a connection"
        );
        assert!(
            format!("{error:#}").contains("downloads are disabled"),
            "{error:#}"
        );
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

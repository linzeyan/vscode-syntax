//! Dumps the pinned tool registry as JSON, for `tools/tool-sync.py`.
//!
//! Every tool names its assets differently (`v{v}` or bare `{v}` in the tag,
//! `darwin_arm64` or `macos-aarch64` or `aarch64-apple-darwin` in the file),
//! and that naming is written once, in the registry closures. The sync
//! pipeline needs the same URLs to look upstream digests up. Printing them
//! from the registry keeps one definition: a Python copy of the naming rules
//! would be a second, and the two would drift the first time an upstream
//! renames an asset -- silently, because a wrong URL and a platform with no
//! build both look like "nothing to pin here".
//!
//! Toolchain-only tools (terraform, clang-format, swift-format) return no
//! asset on any platform and so do not appear.
//!
//! cargo run -p poly-tools --example manifest

fn main() {
    let entries: Vec<_> = poly_tools::TOOLS
        .iter()
        .flat_map(|tool| {
            poly_tools::PLATFORMS.iter().filter_map(move |&platform| {
                let asset = tool.asset(tool.version, platform)?;
                Some(serde_json::json!({
                    "name": tool.name,
                    "version": tool.version,
                    "platform": platform,
                    "url": asset.url,
                }))
            })
        })
        .collect();
    println!(
        "{}",
        serde_json::to_string_pretty(&entries).expect("registry entries are plain strings")
    );
}

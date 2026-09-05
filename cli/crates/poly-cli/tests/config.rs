//! End-to-end `poly config export`, and the three map-shaped keys poly.toml's
//! `deny_unknown_fields` cannot reach.
//!
//! Driven through the binary because the interesting part is what a run *does*
//! with a mistake, not what the checker returns: a warning has to leave the
//! exit code alone and a false path has to take it away.

use std::path::{Path, PathBuf};
use std::process::Command;

fn poly(dir: &Path, args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_poly"))
        .args(args)
        .current_dir(dir)
        .output()
        .expect("spawn poly");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// The repo root, from this crate's manifest.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("cli/crates/poly-cli has three ancestors")
        .to_path_buf()
}

/// A project directory holding one poly.toml and nothing else to lint.
fn project(body: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("poly.toml"), body).unwrap();
    dir
}

/// The same gate `make config` runs, so a stale checked-in copy fails the test
/// suite as well as CI. The file is documentation people read in the repository
/// rather than by running the binary, which is the only reason it is committed
/// at all -- and a committed generated file that nobody regenerates is exactly
/// how the hand-written one drifted.
#[test]
fn the_committed_example_is_what_the_binary_generates() {
    let root = repo_root();
    let (code, stdout, stderr) = poly(&root, &["config", "export"]);
    assert_eq!(code, 0, "{stderr}");
    let committed = std::fs::read_to_string(root.join("poly.example.toml")).unwrap();
    assert_eq!(
        stdout, committed,
        "poly.example.toml is stale; run `poly config export > poly.example.toml`"
    );
}

/// The gate's own non-vacuity check: a generator that stopped substituting
/// would otherwise be diffed against a file it had already written.
#[test]
fn the_export_self_test_passes() {
    let (code, stdout, stderr) = poly(&repo_root(), &["config", "export", "--self-test"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("tools"), "{stdout}");
}

/// Saving the export unchanged has to be a no-op, and the run that proves it is
/// a run with it in place: clean, silent, exit 0.
#[test]
fn a_project_using_the_export_verbatim_is_unaffected_by_it() {
    let root = repo_root();
    let (_, exported, _) = poly(&root, &["config", "export"]);
    let dir = project(&exported);
    let (code, _, stderr) = poly(dir.path(), &["check", "."]);
    assert_eq!(code, 0, "{stderr}");
    assert!(!stderr.contains("warning"), "{stderr}");
}

/// All three keys whose names the project chooses. Each is a warning: the tool
/// you meant to turn off keeps reporting and the language you meant to
/// configure keeps formatting at its defaults, so you find out either way --
/// and stopping the run over it would be poly refusing to work because of a
/// typo in a line that changes nothing.
#[test]
fn an_unknown_name_warns_and_keeps_going() {
    let cases = [
        ("[tools]\nshelcheck = \"off\"\n", "shelcheck", "shellcheck"),
        ("[format.pythn]\nline-width = 100\n", "pythn", "python"),
        (
            "[languages.map]\n\"*.tpl\" = \"jinjaa\"\n",
            "jinjaa",
            "jinja",
        ),
    ];
    for (body, typo, meant) in cases {
        let dir = project(body);
        let (code, _, stderr) = poly(dir.path(), &["check", "."]);
        assert_eq!(code, 0, "a warning must not fail the run: {stderr}");
        assert!(stderr.contains(typo), "{stderr}");
        assert!(stderr.contains(meant), "no suggestion for {typo}: {stderr}");
        // serde's wording for the keys serde itself can check, so both halves
        // of poly.toml validation read as one system.
        assert!(stderr.contains("expected one of"), "{stderr}");
    }
}

/// The one case that stops the run, and the reason it differs: poly would
/// resolve the tool to "missing", skip every file it covers, and exit 0 --
/// a green build over files nothing checked, on the strength of a path the
/// project itself got wrong.
#[test]
fn a_tools_path_that_does_not_exist_stops_the_run() {
    let dir = project("[tools]\nshellcheck = \"bin/shellcheck\"\n");
    let (code, _, stderr) = poly(dir.path(), &["check", "."]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("no such file"), "{stderr}");
    // `poly fmt` reads the same file and has to agree about it.
    let (code, _, stderr) = poly(dir.path(), &["fmt", "--check", "."]);
    assert_eq!(code, 2, "{stderr}");
}

//! What `poly check` says about its own reach: which checkers looked at these
//! files, which did not, and why.
//!
//! Driven through the binary because the answer is assembled in three different
//! places -- an embedded engine's language table, a managed tool's resolution, a
//! project-local tool's absence -- and the property worth asserting is that one
//! run states all three in one vocabulary, on one exit code.
//!
//! Every fixture here is offline: nothing in it resolves a tool that has a
//! managed build, so a cold cache and a dead network give the same answers as a
//! warm one.

use std::path::Path;
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

/// The coverage row for `tool`, or a panic showing what was printed instead.
fn row<'a>(stderr: &'a str, tool: &str) -> &'a str {
    let prefix = format!("{tool} ");
    stderr
        .lines()
        .find(|line| line.trim_start().starts_with(&prefix))
        .unwrap_or_else(|| panic!("no coverage row for {tool} in:\n{stderr}"))
}

/// A checker that did not run says so on its own line, next to the one sentence
/// that would make it run.
///
/// The shell inside a Dockerfile `RUN` is the case this was built for: poly
/// resolves shellcheck for it, and used to say nothing whatsoever when the
/// resolution came back empty -- which is every Windows machine, where
/// shellcheck has no build at all. `= "off"` stands in for that here so the
/// fixture means the same thing on every platform.
#[test]
fn a_skipped_checker_is_named_with_its_reason() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("poly.toml"), "[tools]\nshellcheck = \"off\"\n").unwrap();
    std::fs::write(
        root.join("Dockerfile"),
        "FROM ubuntu:24.04\nRUN echo $UNQUOTED\n",
    )
    .unwrap();

    let (_, _, stderr) = poly(root, &["check", "--compact", "."]);
    // The rules that did look at the Dockerfile.
    assert!(row(&stderr, "poly/docker").ends_with("ran"), "{stderr}");
    // The one that did not, counting the file it would have read: the shell
    // lives in a file that is not a shell script, so a scope of zero here
    // would be the silence this replaces.
    let shellcheck = row(&stderr, "shellcheck");
    assert!(shellcheck.contains("1 file"), "{stderr}");
    assert!(
        shellcheck.ends_with("disabled — `shellcheck = \"off\"` under [tools] in poly.toml"),
        "{stderr}"
    );
    // A tool poly leaves off by default gets the sentence that turns it on --
    // not the one about a poly.toml line this project never wrote.
    assert!(
        row(&stderr, "hadolint")
            .ends_with("off-by-default — add `hadolint = \"on\"` under [tools] to run it as well"),
        "{stderr}"
    );
}

/// A checker with nothing to check here is not a row.
///
/// The non-vacuity half of the test above: the block answers for *these* files,
/// so a listing of the whole registry every run would bury the rows that matter
/// and would pass this suite while saying nothing true.
#[test]
fn a_checker_with_no_files_here_is_not_mentioned() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a.py"), "VALUE = 1\n").unwrap();

    let (code, _, stderr) = poly(root, &["check", "--compact", "."]);
    assert_eq!(code, 0, "{stderr}");
    assert!(row(&stderr, "ruff").ends_with("ran"), "{stderr}");
    // Spelling has no language, so it is the one checker every run has a row
    // for -- and it read the .py and the poly.toml alike.
    assert!(row(&stderr, "typos").ends_with("ran"), "{stderr}");
    for elsewhere in [
        "shellcheck",
        "hadolint",
        "actionlint",
        "poly/docker",
        "sqruff",
    ] {
        assert!(!stderr.contains(elsewhere), "{elsewhere} in:\n{stderr}");
    }
}

/// A tool poly cannot find is a hole in the run, and `--strict` is the flag
/// that calls a hole a failure. Off and absent are not holes: somebody chose
/// those, and a project that has to pass `--strict` should not have to install
/// a linter it turned off.
#[test]
fn strict_fails_on_a_missing_tool_and_not_on_a_disabled_one() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    // A PATH with nothing on it. cargo is a toolchain tool -- no platform has a
    // managed build for it -- so this makes it Missing without poly reaching
    // for the network, on any platform.
    let empty = root.join("nothing");
    std::fs::create_dir(&empty).unwrap();
    std::fs::write(root.join("a.rs"), "fn main() {}\n").unwrap();
    let run = |args: &[&str]| {
        let out = Command::new(env!("CARGO_BIN_EXE_poly"))
            .args(args)
            .current_dir(root)
            .env("PATH", &empty)
            .output()
            .expect("spawn poly");
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    };

    let (code, stderr) = run(&["check", "--compact", "."]);
    assert!(row(&stderr, "cargo").contains("missing — "), "{stderr}");
    // Findings are what decides an ordinary run; a tool nobody could find is
    // reported and leaves the exit code alone.
    assert_eq!(code, 0, "{stderr}");
    let (code, stderr) = run(&["check", "--compact", "--strict", "."]);
    assert_eq!(code, 2, "{stderr}");

    // The same run with the same empty PATH, and the same file: turning the
    // tool off is a decision, so there is no hole left for --strict to find.
    std::fs::write(root.join("poly.toml"), "[tools]\ncargo = \"off\"\n").unwrap();
    let (code, stderr) = run(&["check", "--compact", "--strict", "."]);
    assert!(row(&stderr, "cargo").contains("disabled"), "{stderr}");
    assert_eq!(code, 0, "{stderr}");
}

/// The same rows in `--format json`, because a pipeline deciding whether a
/// green run is worth trusting cannot parse the block on stderr.
#[test]
fn the_json_document_carries_the_same_rows() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a.ts"), "export const value: number = 1\n").unwrap();

    let (_, stdout, stderr) = poly(root, &["check", "--format", "json", "."]);
    let doc: serde_json::Value = serde_json::from_str(&stdout).expect("a json document");
    let rows = doc["summary"]["coverage"]
        .as_array()
        .expect("coverage rows");
    let eslint = rows
        .iter()
        .find(|row| row["tool"] == "eslint")
        .unwrap_or_else(|| panic!("no eslint row in {stdout}"));
    assert_eq!(eslint["status"], "absent");
    assert_eq!(eslint["files"], 1);
    // The reason restates what a project would have to do, in the terms
    // `project::eslint` actually looks for.
    assert!(
        eslint["reason"]
            .as_str()
            .expect("a reason")
            .contains("node_modules/.bin/eslint"),
        "{stdout}"
    );
    // stdout is the document and nothing else, so `| jq` still works: the block
    // is on stderr, where the summary line already lives.
    assert!(!stdout.contains("coverage:"), "{stdout}");
    assert!(stderr.contains("coverage:"), "{stderr}");
}

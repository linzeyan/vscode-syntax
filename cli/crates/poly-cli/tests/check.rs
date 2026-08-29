//! End-to-end `poly check`: `[lint.per-file-ignores]` silences one rule on one
//! path without taking the file out of linting the way `exclude` would.
//!
//! Driven with sqruff because it is embedded — no managed download, so the test
//! means the same thing offline and on every platform.

use std::path::Path;
use std::process::Command;

/// Trips two rules at once: LT01 on the missing space after the comma, CP01 on
/// the upper-case WHERE among lower-case keywords.
const TWO_FINDINGS: &str = "select a,b from t\nWHERE x = 1;\n";

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

#[test]
fn per_file_ignores_silence_one_rule_and_keep_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(
        root.join("poly.toml"),
        "[lint.per-file-ignores]\n\"legacy.sql\" = [\"sqruff/LT01\"]\n",
    )
    .unwrap();
    std::fs::write(root.join("legacy.sql"), TWO_FINDINGS).unwrap();
    std::fs::write(root.join("src/fresh.sql"), TWO_FINDINGS).unwrap();

    let (code, stdout, stderr) = poly(root, &["check", "--compact", "."]);
    // The named rule is gone from the named file; everything else it had to say
    // about that same file is still there, which is the whole difference
    // between this and `exclude`.
    assert!(!stdout.contains("legacy.sql:1:10"), "{stdout}");
    assert!(stdout.contains("legacy.sql:2:1"), "{stdout}");
    // A file the pattern does not name is untouched by it.
    assert!(stdout.contains("fresh.sql:1:10"), "{stdout}");
    assert!(stdout.contains("fresh.sql:2:1"), "{stdout}");
    // Still findings, so still a red build: suppressing one rule is not a way
    // to accidentally turn the check into a no-op.
    assert_eq!(code, 1, "{stderr}");

    // `tool/*` is the whole tool on that path. The file is still linted --
    // nothing else runs on .sql here, so this reads as clean rather than as
    // skipped, and the summary still counts the tool as having run.
    std::fs::write(
        root.join("poly.toml"),
        "[lint.per-file-ignores]\n\"legacy.sql\" = [\"sqruff/*\"]\n",
    )
    .unwrap();
    let (_, stdout, _) = poly(root, &["check", "--compact", "."]);
    assert!(!stdout.contains("legacy.sql"), "{stdout}");
    assert!(stdout.contains("fresh.sql"), "{stdout}");
}

/// Nested configs merge like everything else, so a package silences its own
/// rules without restating the repo's -- and the repo's still reach it.
#[test]
fn a_package_adds_its_own_ignores() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let pkg = root.join("pkg");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(
        root.join("poly.toml"),
        "[lint.per-file-ignores]\n\"**/*.sql\" = [\"sqruff/CP01\"]\n",
    )
    .unwrap();
    std::fs::write(
        pkg.join("poly.toml"),
        "[lint.per-file-ignores]\n\"q.sql\" = [\"sqruff/LT01\"]\n",
    )
    .unwrap();
    std::fs::write(root.join("q.sql"), TWO_FINDINGS).unwrap();
    std::fs::write(pkg.join("q.sql"), TWO_FINDINGS).unwrap();

    let (_, stdout, _) = poly(root, &["check", "--compact", "."]);
    // Root: only the repo-wide CP01 is silenced.
    assert!(stdout.contains("q.sql:1:10"), "{stdout}");
    // pkg: its own LT01 on top of the inherited CP01, so nothing is left.
    let pkg_lines: Vec<&str> = stdout
        .lines()
        .filter(|l| l.contains("pkg") && l.contains("q.sql"))
        .collect();
    assert!(pkg_lines.is_empty(), "{pkg_lines:?}");
    assert!(
        !stdout.contains(":2:1"),
        "CP01 silenced everywhere: {stdout}"
    );
}

/// A suppression that cannot match anything must stop the run rather than look
/// like it worked, for the same reason a misspelled key does.
#[test]
fn a_malformed_suppression_is_an_error_not_a_no_op() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(
        root.join("poly.toml"),
        "[lint.per-file-ignores]\n\"*.sql\" = [\"LT01\"]\n",
    )
    .unwrap();
    std::fs::write(root.join("q.sql"), TWO_FINDINGS).unwrap();

    let (code, _, stderr) = poly(root, &["check", "."]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("LT01"), "{stderr}");
    assert!(stderr.contains("tool/rule"), "{stderr}");
}

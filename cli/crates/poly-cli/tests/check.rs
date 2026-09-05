//! End-to-end `poly check`: the two ways to silence one rule without taking the
//! file out of linting the way `exclude` would — `[lint.per-file-ignores]` for a
//! path, and a `# poly: ignore` comment for a line.
//!
//! Driven with the embedded engines because they need no managed download, so
//! the test means the same thing offline and on every platform. The daemon's
//! half of each case is in `lsp.rs`'s own tests, against the same fixtures: a
//! suppression only one side honors is the editor/CI split A4 exists to
//! prevent, and the two are asserted separately because the daemon is a library
//! call here and a protocol elsewhere.

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

/// The line-level neighbour, in the same vocabulary: `[sqruff/LT01]` in the
/// output is `sqruff/LT01` in the comment, whichever of the two places it goes.
///
/// The editor's half of this fixture is
/// `lsp::tests::an_inline_comment_is_silent_in_the_editor_too`.
#[test]
fn an_inline_comment_silences_one_line() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    // Trailing, on the finding's own line.
    std::fs::write(
        root.join("trailing.sql"),
        "select a,b from t  -- poly: ignore sqruff/LT01\nWHERE x = 1;\n",
    )
    .unwrap();
    // On a line of its own, for the line below it -- the placement a long or
    // continued line needs, since it has nowhere to put a trailing comment.
    std::fs::write(
        root.join("above.sql"),
        "select a, b from t\n-- poly: ignore sqruff/CP01\nWHERE x = 1;\n",
    )
    .unwrap();
    // `tool/*`, and the reach of a comment: it stops at the line below, so the
    // LT01 two lines up is still reported.
    std::fs::write(
        root.join("star.sql"),
        "select a,b from t\n-- poly: ignore sqruff/*\nWHERE x = 1;\n",
    )
    .unwrap();

    let (code, stdout, stderr) = poly(root, &["check", "--compact", "."]);
    // The named rule is gone from the named line; the other finding in the same
    // file survives, which is the difference between this and `exclude`.
    assert!(!stdout.contains("trailing.sql:1:10"), "{stdout}");
    assert!(stdout.contains("trailing.sql:2:1"), "{stdout}");
    assert!(!stdout.contains("above.sql"), "{stdout}");
    assert!(stdout.contains("star.sql:1:10"), "{stdout}");
    assert!(!stdout.contains("star.sql:3:1"), "{stdout}");
    // Still findings, so still a red build.
    assert_eq!(code, 1, "{stderr}");
}

/// One syntax over every tool poly runs.
///
/// Filtering happens after collection, so the comment cannot tell an embedded
/// engine's finding from a downloaded tool's -- ruff and typos here because
/// they need no network, and `hadolint/DL3008` in this repo's own Dockerfile
/// for the downloaded half.
#[test]
fn an_inline_comment_covers_every_tools_findings() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    // `concat!` rather than one continued string literal, so each fixture line
    // is a line of Rust that can carry its own comment: this file is linted
    // too, and a deliberate misspelling in it is a finding about this file.
    std::fs::write(
        root.join("a.py"),
        concat!(
            "import os  # poly: ignore ruff/F401\n",
            "FIRST = \"helo\"  # poly: ignore typos/typo\n", // poly: ignore typos/typo
            "SECOND = \"wrold\"\n",                          // poly: ignore typos/typo
        ),
    )
    .unwrap();

    // Both suppressed codes are gone, and the same rule from the same tool one
    // line further down still reports: a line-level suppression, not a
    // file-level one.
    let (_, stdout, _) = poly(root, &["check", "--compact", "."]);
    assert!(!stdout.contains("F401"), "{stdout}");
    assert!(stdout.contains("a.py:3:11"), "{stdout}");
    assert!(!stdout.contains("helo"), "{stdout}"); // poly: ignore typos/typo
    assert!(stdout.contains("wrold"), "{stdout}"); // poly: ignore typos/typo
}

/// The hazard behind poly's one language-specific placement rule, pinned end to
/// end: `poly fmt` moves a trailing Dockerfile comment onto a line of its own,
/// where the line-above rule would hand it the *next* instruction.
///
/// The round trip is asserted rather than described, so if the Dockerfile
/// formatter ever stops relocating comments this fails here instead of leaving
/// `relocates_trailing_comments` giving advice that is no longer true.
#[test]
fn a_trailing_dockerfile_suppression_would_move() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    // hadolint has its own opinion about both instructions and would have to be
    // downloaded to give it; poly's own rules are compiled in.
    std::fs::write(root.join("poly.toml"), "[tools]\nhadolint = \"off\"\n").unwrap();
    let path = root.join("Dockerfile");
    std::fs::write(
        &path,
        "FROM ubuntu  # poly: ignore poly/docker-untagged-base\nRUN apt-get update\n",
    )
    .unwrap();

    let (_, stdout, _) = poly(root, &["check", "--compact", "."]);
    // Reported, and the finding it was aimed at is still there: nothing is
    // silenced, so nothing can later be silenced somewhere else.
    assert!(stdout.contains("[poly/ignore-syntax]"), "{stdout}");
    assert!(stdout.contains("poly fmt"), "{stdout}");
    assert!(stdout.contains("[poly/docker-untagged-base]"), "{stdout}");

    // The move itself. Two poly subcommands disagreeing about which line a
    // suppression governs is what the rule above exists to prevent.
    poly(root, &["fmt", "."]);
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "FROM ubuntu\n# poly: ignore poly/docker-untagged-base\nRUN apt-get update\n",
    );

    // And the placement poly asks for survives the same round trip.
    std::fs::write(
        &path,
        "# poly: ignore poly/docker-untagged-base\nFROM ubuntu\nRUN apt-get update\n",
    )
    .unwrap();
    let (_, stdout, _) = poly(root, &["check", "--compact", "."]);
    assert!(!stdout.contains("docker-untagged-base"), "{stdout}");
    assert!(!stdout.contains("ignore-syntax"), "{stdout}");
    poly(root, &["fmt", "."]);
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "# poly: ignore poly/docker-untagged-base\nFROM ubuntu\nRUN apt-get update\n",
    );
}

/// A comment poly cannot read is reported and the run goes on — the one place
/// this parts company with poly.toml, where the same mistake is fatal.
///
/// The finding it was aimed at is still printed, so nothing is hidden: what
/// would otherwise be silent is the comment doing nothing, and that is exactly
/// what this says out loud.
#[test]
fn a_malformed_inline_code_is_reported_not_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a.py"), "import os  # poly: ignore F401\n").unwrap();
    // A file nothing else reports on: the comment is still checked, because a
    // suppression silently silencing nothing is the whole failure mode here.
    std::fs::write(root.join("clean.py"), "# poly: ignore ruff\nOK = 1\n").unwrap();

    let (code, stdout, stderr) = poly(root, &["check", "--compact", "."]);
    // Reported, at the code it could not read rather than at the line.
    assert!(
        stdout.contains("a.py:1:27: warning [poly/ignore-syntax]"),
        "{stdout}"
    );
    assert!(
        stdout.contains("clean.py:1:16: warning [poly/ignore-syntax]"),
        "{stdout}"
    );
    assert!(stdout.contains("tool/rule"), "{stdout}");
    // Silences nothing, so the finding it was aimed at is still there.
    assert!(stdout.contains("[ruff/F401]"), "{stdout}");
    // 1, not 2: one comment in one file is not a reason to stop checking a repo.
    assert_eq!(code, 1, "{stderr}");
}

/// A language poly knows no comment syntax for gets no inline suppression, and
/// says nothing about it: `[lint.per-file-ignores]` still covers that file, and
/// the finding continuing to appear is how you find out.
#[test]
fn a_language_without_a_comment_syntax_stays_silent() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(
        root.join("notes.md"),
        "A deliberate typo: helo. <!-- poly: ignore typos/typo -->\n", // poly: ignore typos/typo
    )
    .unwrap();

    let (_, stdout, _) = poly(root, &["check", "--compact", "."]);
    assert!(stdout.contains("notes.md:1:20"), "{stdout}");
    // And no complaint about the comment either -- poly never recognised it.
    assert!(!stdout.contains("ignore-syntax"), "{stdout}");
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

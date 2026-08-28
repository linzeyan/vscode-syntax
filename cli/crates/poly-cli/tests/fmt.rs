//! End-to-end `poly fmt` over a fixture repo: poly.toml mapping changes
//! behavior (acceptance criterion 4), excludes and .gitignore are honored,
//! and --check round-trips to clean.

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

#[test]
fn fmt_fixture_repo() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join(".git")).unwrap(); // enable .gitignore handling
    std::fs::create_dir_all(root.join("vendor")).unwrap();
    std::fs::write(
        root.join("poly.toml"),
        "[languages.map]\n\"*.data\" = \"json\"\n[format]\nexclude = [\"vendor/**\"]\n",
    )
    .unwrap();
    std::fs::write(root.join(".gitignore"), "generated.ts\n").unwrap();
    std::fs::write(root.join("a.ts"), "const  x = {a:1};").unwrap();
    // json engine only runs on this file because of [languages.map]
    std::fs::write(root.join("b.data"), "{\"b\":1,  \"a\":2}").unwrap();
    std::fs::write(root.join("generated.ts"), "const  y = 1;").unwrap();
    std::fs::write(root.join("vendor/skip.ts"), "const  z = 1;").unwrap();

    let (code, stdout, _) = poly(root, &["fmt", "--check", "."]);
    assert_eq!(code, 1, "--check must fail on unformatted files");
    assert!(stdout.contains("a.ts"), "{stdout}");
    assert!(stdout.contains("b.data"), "mapped file missing: {stdout}");
    assert!(
        !stdout.contains("generated.ts"),
        ".gitignore ignored: {stdout}"
    );
    assert!(!stdout.contains("vendor"), "exclude ignored: {stdout}");

    let (code, _, stderr) = poly(root, &["fmt", "."]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        std::fs::read_to_string(root.join("b.data")).unwrap(),
        "{ \"b\": 1, \"a\": 2 }\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("vendor/skip.ts")).unwrap(),
        "const  z = 1;",
        "excluded file must be untouched"
    );

    let (code, stdout, _) = poly(root, &["fmt", "--check", "."]);
    assert_eq!(code, 0, "second --check must be clean: {stdout}");
}

/// A file the formatter choked on is reported in the same shape `poly check`
/// uses for a lint violation, and on the same stream: CI parses one format or
/// it parses none.
#[test]
fn fmt_reports_broken_files_and_exits_2() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("bad.json"), "{\n  \"a\": 1,\n  \"b\": ,\n}\n").unwrap();
    let (code, stdout, stderr) = poly(root, &["fmt", "."]);
    assert_eq!(code, 2, "{stderr}");
    let first = stdout.lines().next().unwrap_or_default();
    assert!(
        first.starts_with("bad.json:3:8: error [poly/format] "),
        "wrong shape or position: {stdout}"
    );
}

/// `--check` says the same thing about an unformatted file that a linter says
/// about a violation, so it reads and parses the same way — including the line
/// naming the command that resolves it.
#[test]
fn check_reports_unformatted_files_as_issues() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a.json"), "{\"b\":1,  \"a\":2}").unwrap();

    let (code, stdout, _) = poly(root, &["fmt", "--check", "."]);
    assert_eq!(code, 1, "{stdout}");
    assert_eq!(
        stdout,
        "a.json:1:1: warning [poly/unformatted] file is not formatted\n\
         \x20   fix   run `poly fmt`\n"
    );

    let (_, stdout, _) = poly(root, &["fmt", "--check", "--compact", "."]);
    assert_eq!(
        stdout,
        "a.json:1:1: warning [poly/unformatted] file is not formatted\n"
    );
}

/// Git's Windows default checks files out as CRLF; every formatter we dispatch
/// to emits LF. Without preservation, CI (Linux, LF) and a Windows dev box
/// disagree about the very same commit.
#[test]
fn fmt_preserves_crlf_line_endings() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a.json"), "{\"b\":1,\r\n  \"a\":2}").unwrap();
    // Already formatted, only the endings differ from the formatter's output.
    std::fs::write(root.join("clean.json"), "{ \"b\": 1, \"a\": 2 }\r\n").unwrap();

    let (code, stdout, _) = poly(root, &["fmt", "--check", "."]);
    assert_eq!(code, 1, "{stdout}");
    assert!(
        !stdout.contains("clean.json"),
        "CRLF alone must not count as unformatted: {stdout}"
    );

    let (code, _, stderr) = poly(root, &["fmt", "."]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        std::fs::read_to_string(root.join("a.json")).unwrap(),
        "{ \"b\": 1, \"a\": 2 }\r\n",
        "formatter must write back the file's own line ending"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("clean.json")).unwrap(),
        "{ \"b\": 1, \"a\": 2 }\r\n",
        "an already-formatted CRLF file must be left byte-identical"
    );
}

/// `[format.<lang>]` has to reach the embedded engines, or the setting is a
/// lie the user only discovers by diffing output.
#[test]
fn per_language_format_options_reach_the_engine() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("poly.toml"), "[format.json]\nline-width = 20\n").unwrap();
    // Comfortably under the 120-column default, so only a narrower width
    // splits it; that is the whole assertion.
    std::fs::write(root.join("a.json"), "{\"alpha\":1,\"beta\":2,\"gamma\":3}").unwrap();

    let (code, _, stderr) = poly(root, &["fmt", "."]);
    assert_eq!(code, 0, "{stderr}");
    let formatted = std::fs::read_to_string(root.join("a.json")).unwrap();
    assert!(
        formatted.lines().count() > 2,
        "line-width = 20 did not reach the json engine: {formatted:?}"
    );

    // A package can narrow further without restating the rest.
    let pkg = root.join("pkg");
    std::fs::create_dir(&pkg).unwrap();
    std::fs::write(pkg.join("poly.toml"), "[format.json]\nindent-width = 8\n").unwrap();
    std::fs::write(pkg.join("b.json"), "{\"alpha\":1,\"beta\":2,\"gamma\":3}").unwrap();
    let (code, _, stderr) = poly(root, &["fmt", "."]);
    assert_eq!(code, 0, "{stderr}");
    let nested = std::fs::read_to_string(pkg.join("b.json")).unwrap();
    assert!(nested.contains("\n        \"alpha\""), "{nested:?}");
}

/// Not every engine has all three knobs. Applying two of three and dropping
/// the rest silently is the worst outcome; say so and fail the run.
#[test]
fn an_option_the_engine_cannot_honor_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("poly.toml"), "[format.yaml]\nuse-tabs = true\n").unwrap();
    std::fs::write(root.join("a.yaml"), "a:   1\n").unwrap();

    let (code, stdout, stderr) = poly(root, &["fmt", "."]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stdout.contains("use-tabs"), "{stdout}");
    assert_eq!(
        std::fs::read_to_string(root.join("a.yaml")).unwrap(),
        "a:   1\n",
        "a rejected config must not half-format the file"
    );
}

/// poly.toml is optional. A repo that never writes one has to get a working
/// run out of the defaults alone — built-in language detection, .gitignore
/// honored, no "missing config" anywhere.
#[test]
fn a_repo_with_no_config_formats_on_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::write(root.join(".gitignore"), "generated.json\n").unwrap();
    std::fs::write(root.join("a.json"), "{\"b\":1,  \"a\":2}").unwrap();
    std::fs::write(root.join("generated.json"), "{\"b\":1,  \"a\":2}").unwrap();

    let (code, stdout, stderr) = poly(root, &["fmt", "."]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("a.json"), "{stdout}");
    assert_eq!(
        std::fs::read_to_string(root.join("generated.json")).unwrap(),
        "{\"b\":1,  \"a\":2}",
        "gitignored file must be untouched without any config saying so"
    );
}

/// The ignored file is sometimes the one you need to check — generated code, a
/// vendored tree, build output. poly.toml's own exclude is a different
/// statement and must survive the escape hatch.
#[test]
fn no_ignore_reaches_gitignored_files_but_not_excluded_ones() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::create_dir_all(root.join("vendor")).unwrap();
    std::fs::write(
        root.join("poly.toml"),
        "[format]\nexclude = [\"vendor/**\"]\n",
    )
    .unwrap();
    std::fs::write(root.join(".gitignore"), "generated.json\n").unwrap();
    std::fs::write(root.join("generated.json"), "{\"b\":1,  \"a\":2}").unwrap();
    std::fs::write(root.join("vendor/skip.json"), "{\"b\":1,  \"a\":2}").unwrap();

    let (code, stdout, _) = poly(root, &["fmt", "--check", "--no-ignore", "."]);
    assert_eq!(code, 1, "{stdout}");
    assert!(stdout.contains("generated.json"), "{stdout}");
    assert!(!stdout.contains("vendor"), "exclude must outrank: {stdout}");
}

/// Dotted files are skipped by default, and both ways of asking for them work:
/// the flag for a one-off run, the config for a project whose sources actually
/// live under a dot (which the editor has to agree with, so it cannot be a
/// flag).
#[test]
fn hidden_files_need_asking_for_by_flag_or_config() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join(".config")).unwrap();
    std::fs::write(root.join(".config/a.json"), "{\"b\":1,  \"a\":2}").unwrap();
    std::fs::write(root.join("plain.json"), "{\"b\":1,  \"a\":2}").unwrap();

    let (code, stdout, _) = poly(root, &["fmt", "--check", "."]);
    assert_eq!(code, 1, "{stdout}");
    assert!(!stdout.contains(".config"), "hidden by default: {stdout}");

    let (_, stdout, _) = poly(root, &["fmt", "--check", "--hidden", "."]);
    assert!(stdout.contains(".config/a.json"), "{stdout}");

    std::fs::write(root.join("poly.toml"), "[walk]\ninclude-hidden = true\n").unwrap();
    let (_, stdout, _) = poly(root, &["fmt", "--check", "."]);
    assert!(
        stdout.contains(".config/a.json"),
        "config ignored: {stdout}"
    );
}

/// poly.example.toml is documentation, and documentation about configuration
/// goes stale in the one way nobody notices: silently. Feeding it back through
/// the parser proves every key in it is still a key, and requiring each managed
/// tool to be named in it means a tool added to the registry cannot ship as a
/// setting no one knows exists.
#[test]
fn the_example_config_parses_and_names_every_tool() {
    let example = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../poly.example.toml");
    let text = std::fs::read_to_string(&example).expect("poly.example.toml at the repo root");

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("poly.toml"), &text).unwrap();
    std::fs::write(root.join("a.json"), "{ \"a\": 1 }\n").unwrap();

    let (code, stdout, stderr) = poly(root, &["fmt", "--check", "."]);
    assert_eq!(code, 0, "the example config was rejected: {stdout}{stderr}");

    for tool in poly_tools::TOOLS {
        assert!(
            text.contains(tool.name),
            "{} is in the registry but not in poly.example.toml",
            tool.name
        );
    }
}

#[test]
fn check_without_shell_files_is_clean() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.json"), "{}").unwrap();
    let (code, _, _) = poly(dir.path(), &["check", "."]);
    assert_eq!(code, 0);
}

/// A formatter poly cannot resolve means its files are silently skipped, and
/// the exit code says nothing: CI passes with Go left unformatted. `--strict`
/// is the same promise `poly check --strict` makes, applied to the half of the
/// product that writes files. `tools.gofumpt = "off"` stands in for the
/// tool being absent, because that is the same resolution outcome.
#[test]
fn strict_turns_an_unavailable_formatter_into_a_failure() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("poly.toml"), "[tools]\ngofumpt = \"off\"\n").unwrap();
    std::fs::write(root.join("a.go"), "package main\nfunc  main()  {}\n").unwrap();

    // The default stays a skip: a repo without every toolchain installed is
    // normal, and failing by default would make poly unusable in most of them.
    let (code, _, stderr) = poly(root, &["fmt", "--check", "."]);
    assert_eq!(code, 0, "default must not fail on a missing formatter");
    assert!(
        stderr.contains("gofumpt"),
        "the skip must still be said: {stderr}"
    );
    assert!(stderr.contains("1 formatters missing"), "{stderr}");

    let (code, _, stderr) = poly(root, &["fmt", "--check", "--strict", "."]);
    assert_eq!(code, 2, "--strict must fail: {stderr}");
    assert!(stderr.contains("gofumpt"), "{stderr}");
}

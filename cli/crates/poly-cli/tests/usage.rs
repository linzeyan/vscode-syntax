//! `--version`, `--help`, and which stream each of them lands on.
//!
//! The unit tests in `usage.rs` cover which language a locale resolves to.
//! These cover the part only a real process can show: exit codes and the
//! stdout/stderr split, which is what tells a script whether poly answered a
//! question or refused a command.

use std::process::Command;

fn poly(env: &[(&str, &str)], args: &[&str]) -> (i32, String, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_poly"));
    // The runner's own locale must not decide what these tests assert.
    cmd.env_remove("LC_ALL")
        .env_remove("LC_MESSAGES")
        .env_remove("LANG")
        .env_remove("POLY_LANG");
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd.args(args).output().expect("spawn poly");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// The version has to be greppable from a shell without parsing prose, which
/// is the entire reason someone runs it: to find out which poly is on PATH.
#[test]
fn version_is_one_line_on_stdout() {
    for args in [&["--version"][..], &["-V"][..], &["fmt", "--version"][..]] {
        let (code, stdout, stderr) = poly(&[], args);
        assert_eq!(code, 0, "{args:?}");
        assert_eq!(stdout.trim(), format!("poly {}", env!("CARGO_PKG_VERSION")));
        assert!(stderr.is_empty(), "{args:?} wrote to stderr: {stderr}");
    }
}

/// Asking for help is not an error: stdout, exit 0, so `poly --help | less`
/// works and a wrapper script does not abort on it.
#[test]
fn help_is_an_answer_and_goes_to_stdout() {
    for args in [&["--help"][..], &["-h"][..], &["check", "--help"][..]] {
        let (code, stdout, stderr) = poly(&[("POLY_LANG", "en")], args);
        assert_eq!(code, 0, "{args:?}");
        assert!(stdout.contains("usage:"), "{args:?} printed: {stdout}");
        assert!(stderr.is_empty(), "{args:?} wrote to stderr: {stderr}");
    }
}

/// A typo'd subcommand and a bare `poly` are mistakes, so the same text goes
/// to stderr with exit 2. A script that misspells `fmt` must fail rather than
/// silently do nothing and report success.
#[test]
fn a_wrong_command_prints_usage_to_stderr_and_fails() {
    let (code, stdout, stderr) = poly(&[("POLY_LANG", "en")], &["fmtt", "."]);
    assert_eq!(code, 2);
    assert!(stdout.is_empty(), "usage leaked to stdout: {stdout}");
    assert!(stderr.contains("unknown command: fmtt"), "{stderr}");
    assert!(stderr.contains("usage:"), "{stderr}");

    let (code, _, stderr) = poly(&[("POLY_LANG", "en")], &[]);
    assert_eq!(code, 2, "bare `poly` must not report success");
    assert!(stderr.contains("usage:"), "{stderr}");
}

/// `poly check --check .` used to look like a dry run, do the real thing, and
/// exit 0. A flag that is spelled right and silently does nothing is worse
/// than one that is rejected, because nothing tells the reader it was ignored.
#[test]
fn check_rejects_the_fmt_only_flag() {
    let (code, stdout, stderr) = poly(&[], &["check", "--check", "."]);
    assert_eq!(code, 2, "silently accepting it is the bug being fixed");
    assert!(stdout.is_empty(), "{stdout}");
    assert!(stderr.contains("--check is a `poly fmt` flag"), "{stderr}");

    // --strict is not the same case: fmt now implements it, so both take it.
    for cmd in ["fmt", "check"] {
        let (_, _, stderr) = poly(&[], &[cmd, "--strict", "--help"]);
        assert!(
            stderr.is_empty(),
            "poly {cmd} --strict was rejected: {stderr}"
        );
    }
}

/// POLY_LANG has to beat the ambient locale, or a CI job on a zh_TW runner
/// could not pin its logs to one language.
#[test]
fn poly_lang_overrides_the_system_locale() {
    let (_, zh, _) = poly(&[("LANG", "en_US.UTF-8"), ("POLY_LANG", "zh-TW")], &["-h"]);
    assert!(zh.contains("用法："), "{zh}");

    let (_, en, _) = poly(&[("LANG", "zh_TW.UTF-8"), ("POLY_LANG", "en")], &["-h"]);
    assert!(en.contains("usage:"), "{en}");

    // With no override the locale decides.
    let (_, zh, _) = poly(&[("LANG", "zh_TW.UTF-8")], &["-h"]);
    assert!(zh.contains("用法："), "{zh}");
}

/// Poly used to exit 1 on any finding at all, so a repo with one `info`
/// spelling suggestion could not have a green pipeline without excluding the
/// file. The findings still print either way -- fail-on decides the exit code,
/// not what gets reported.
#[test]
fn fail_on_sets_the_severity_floor_for_the_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a.md"), "# teh titel\n").unwrap();
    let at = |args: &[&str]| {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_poly"))
            .args(args)
            .current_dir(root)
            .output()
            .expect("spawn poly");
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    };

    // Default is unchanged: an info-level typo still fails.
    let (code, stdout, _) = at(&["check", "."]);
    assert_eq!(code, 1, "default must keep failing on info");
    assert!(stdout.contains("info [typos/typo]"), "{stdout}");

    // Raised above info: reported, counted, not fatal.
    let (code, stdout, stderr) = at(&["check", "--fail-on", "warning", "."]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stdout.contains("info [typos/typo]"),
        "still reported: {stdout}"
    );
    assert!(stderr.contains("below fail-on"), "{stderr}");

    // --fail-on=x and --fail-on x are the same flag.
    assert_eq!(at(&["check", "--fail-on=warning", "."]).0, 0);
    assert_eq!(at(&["check", "--fail-on", "never", "."]).0, 0);
    assert_eq!(at(&["check", "--fail-on", "hint", "."]).0, 1);

    // A misspelled severity fails the run: the silent fallback would be "fail
    // on everything", which looks exactly like the flag having no effect.
    let (code, _, stderr) = at(&["check", "--fail-on", "warnings", "."]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("unknown fail-on value"), "{stderr}");
    let (code, _, stderr) = at(&["check", "--fail-on"]);
    assert_eq!(code, 2);
    assert!(stderr.contains("needs a severity"), "{stderr}");
}

/// `--format` decides the shape of stdout, and stdout only. Whatever the shape,
/// the exit code and the stderr summary say the same thing -- a pipeline that
/// switches format to get better annotations must not also change its verdict.
#[test]
fn every_format_reports_the_same_run() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a.md"), "# teh titel\n").unwrap();
    let at = |args: &[&str]| {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_poly"))
            .args(args)
            .current_dir(root)
            .output()
            .expect("spawn poly");
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    };

    // The text run is the reference; the others have to agree with it on
    // everything except the bytes on stdout.
    let (want_code, _, want_summary) = at(&["check", "--format", "text", "."]);
    assert_eq!(want_code, 1, "the fixture has to produce findings");
    for shape in ["json", "table", "table_markdown"] {
        let (code, stdout, stderr) = at(&["check", "--format", shape, "."]);
        assert_eq!(code, want_code, "{shape} changed the verdict: {stderr}");
        assert_eq!(stderr, want_summary, "{shape} changed the summary");
        assert!(
            stdout.contains("typo"),
            "{shape} lost the finding: {stdout}"
        );
    }

    // stdout is the document and nothing else, or `poly check --format json |
    // jq` breaks the moment a tool is missing and says so.
    let (_, stdout, _) = at(&["check", "--format=json", "."]);
    let doc: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout is one JSON document");
    assert_eq!(doc["issues"][0]["tool"], "typos");
    assert_eq!(doc["issues"][0]["fatal"], true);

    // The markdown table is pasted into a PR or a job summary, so its first
    // line has to be the header row rather than anything conversational.
    let (_, stdout, _) = at(&["check", "--format", "table_markdown", "."]);
    assert!(stdout.starts_with("| File |"), "{stdout}");

    // A misspelled shape fails rather than silently falling back to text,
    // which would look exactly like the flag having no effect.
    let (code, _, stderr) = at(&["check", "--format", "yaml", "."]);
    assert_eq!(code, 2);
    assert!(stderr.contains("unknown --format value"), "{stderr}");
    let (code, _, stderr) = at(&["check", "--format"]);
    assert_eq!(code, 2);
    assert!(stderr.contains("needs a shape"), "{stderr}");

    // --compact trims the text record; there is no record to trim in the
    // others, so accepting it there would be accepting a no-op.
    let (code, _, stderr) = at(&["check", "--compact", "--format", "json", "."]);
    assert_eq!(code, 2);
    assert!(stderr.contains("--compact shapes"), "{stderr}");
    assert_eq!(at(&["check", "--compact", "."]).0, 1, "still fine on text");
}

/// The same floor applies to formatting, and separately: "unformatted files
/// fail the build, spelling suggestions do not" is a coherent policy.
#[test]
fn fail_on_applies_to_unformatted_files_too() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a.ts"), "const  x = 1;\n").unwrap();
    let at = |args: &[&str]| {
        std::process::Command::new(env!("CARGO_BIN_EXE_poly"))
            .args(args)
            .current_dir(root)
            .output()
            .expect("spawn poly")
    };
    assert_eq!(at(&["fmt", "--check", "."]).status.code(), Some(1));
    // Unformatted is a warning, so a floor of error lets it through.
    let out = at(&["fmt", "--check", "--fail-on", "error", "."]);
    assert_eq!(out.status.code(), Some(0));
    // And the file is still named, which is the point of reporting it.
    assert!(String::from_utf8_lossy(&out.stdout).contains("poly/unformatted"));
}

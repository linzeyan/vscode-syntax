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

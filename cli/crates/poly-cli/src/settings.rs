//! poly.toml as a document: exporting the annotated default, and reporting
//! what a project's own copy asks for that poly cannot honour.
//!
//! One module for both because they answer the same question from two sides.
//! `poly.example.toml` used to be hand-maintained and drifted exactly where it
//! restated something the code already knew -- a pinned version, a tool that
//! had become a library, the release number in "as of poly 0.1.0". Everything
//! derivable is now read out of the registry, the language table and the
//! engines, and the prose that surrounds it lives in `poly.example.toml.in`
//! where it can be read and reviewed as prose.
//!
//! The same table then answers `[tools] shelcheck = "off"`. Three places in
//! poly.toml are maps whose keys the project chooses -- `[tools]`,
//! `[format.<lang>]` and the right-hand side of `[languages.map]` -- so
//! serde's `deny_unknown_fields`, which catches every other misspelling, has
//! nothing to match them against. It is the same list either way: a name worth
//! documenting is a name worth recognising, and a suggestion is only as good
//! as the list it is drawn from.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::sync::Mutex;

use anyhow::{bail, Result};
use poly_core::Config;

const TEMPLATE: &str = include_str!("poly.example.toml.in");

/// How poly gets hold of one `[tools]` name, which is also what an entry for it
/// may say.
#[derive(Clone, Copy)]
enum Source {
    /// poly pins the version and downloads it on first use.
    Pinned(&'static str),
    /// Never downloaded: it has to match the project's own toolchain.
    Toolchain,
    /// A language server `poly lsp` starts, from PATH for the same reason.
    Server,
    /// A whole-program analysis `poly deadcode` runs.
    Analysis,
    /// Compiled into poly. An entry for it is a mistake, and the string is the
    /// sentence saying where the setting went instead.
    Embedded(&'static str),
}

/// One name `[tools]` recognises.
struct Known {
    name: &'static str,
    source: Source,
}

/// Every name `[tools]` recognises, sorted.
///
/// Assembled from the four places that each own part of the answer rather than
/// written out again here, because a fifth copy is what this whole module
/// exists to remove. It drives all three uses -- the exported documentation,
/// the unknown-name warning, and the nearest match that warning suggests -- so
/// a tool cannot be added to poly and stay undocumented, or documented and stay
/// unrecognised.
fn known_tools() -> Vec<Known> {
    let mut names: Vec<Known> = poly_tools::TOOLS
        .iter()
        .map(|tool| Known {
            name: tool.name,
            // The registry spells "poly never downloads this" as the version
            // string `system`; see the toolchain-only entries in poly-tools.
            source: if tool.version == "system" {
                Source::Toolchain
            } else {
                Source::Pinned(tool.version)
            },
        })
        .collect();
    names.extend(
        crate::lsp::LANGUAGE_SERVERS
            .iter()
            // buf is in both lists -- it is a formatter poly pins that also
            // serves protobuf -- and the registry entry is the fuller answer.
            .filter(|(_, server)| poly_tools::tool(server).is_none())
            .map(|(_, server)| Known {
                name: server,
                source: Source::Server,
            }),
    );
    names.extend(crate::ANALYSIS_TOOLS.iter().map(|(name, _)| Known {
        name,
        source: Source::Analysis,
    }));
    names.extend(poly_tools::EMBEDDED.iter().map(|(name, instead)| Known {
        name,
        source: Source::Embedded(instead),
    }));
    names.sort_by_key(|known| known.name);
    names.dedup_by_key(|known| known.name);
    names
}

// ── validation ─────────────────────────────────────────────────────────────

/// What this poly.toml asks for that poly cannot do.
///
/// Warnings come back in the `Ok`; the run continues. That is the rule poly
/// already applies to `[lint.per-file-ignores]`: an unknown rule code is left
/// alone because the finding it was meant to silence keeps being printed, and
/// you find out without being stopped. The three cases here are the same shape
/// -- the tool you meant to disable keeps reporting, the language you meant to
/// configure keeps formatting at its defaults, the files you meant to remap
/// keep being skipped.
///
/// `Err` is reserved for the opposite: poly would silently do *less*, with
/// nothing in the output to say so. A `[tools]` path that does not exist is
/// that case. Without this it resolved to "tool missing", which `poly check`
/// prints and then exits 0 over -- a green build across files nothing checked,
/// on the strength of a path the project itself got wrong.
pub fn check(config: &Config) -> Result<Vec<String>> {
    let known = known_tools();
    let names: Vec<&str> = known.iter().map(|k| k.name).collect();
    let mut warnings = Vec::new();

    for (name, value) in &config.tools {
        match known.iter().find(|k| k.name == name) {
            None => warnings.push(unknown("[tools]", "tool", name, &names)),
            Some(Known {
                source: Source::Embedded(instead),
                ..
            }) => warnings.push(format!(
                "[tools] `{name}`: there is no {name} binary to configure — {instead}"
            )),
            Some(_) => {
                if let Some(path) = poly_tools::explicit_path(value, config) {
                    if !path.is_file() {
                        bail!(
                            "[tools] `{name}` = {value:?}: no such file ({}) — poly would skip \
                             {name} and report a clean run over the files it never checked",
                            path.display()
                        );
                    }
                }
            }
        }
    }

    let languages = poly_core::builtin_languages();
    for lang in config.format_languages() {
        if !languages.contains(&lang) {
            warnings.push(unknown("[format]", "language", lang, &languages));
        }
    }
    for (pattern, lang) in config.language_map() {
        if !languages.contains(&lang) {
            warnings.push(unknown(
                &format!("[languages.map] {pattern:?}"),
                "language",
                lang,
                &languages,
            ));
        }
    }
    Ok(warnings)
}

/// Serde's wording, for the keys serde structurally cannot check.
///
/// `deny_unknown_fields` already answers a misspelled `[lint]` key with
/// "unknown field `...`, expected one of `exclude`, `fail-on`,
/// `per-file-ignores`". These three maps are the holes in that, and reading as
/// one system matters more than being terse: whichever half of poly.toml
/// validation catches your typo, it says the same thing about it.
fn unknown(section: &str, what: &str, name: &str, known: &[&str]) -> String {
    let suggestion = match nearest(name, known) {
        Some(near) => format!(", did you mean `{near}`?"),
        None => String::new(),
    };
    let expected = known
        .iter()
        .map(|k| format!("`{k}`"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{section}: unknown {what} `{name}`{suggestion} — expected one of {expected}")
}

/// The closest name in `known`, when one is close enough to be worth naming.
///
/// The budget is one edit per four characters typed, capped at three: a longer
/// name has more places to go wrong, and a short one has almost none. What the
/// cap buys is silence -- a name that is nobody's misspelling of anything
/// (`nosuchlanguage`) gets no guess rather than the least-distant of thirty
/// unrelated ids, which would be noise dressed as help.
fn nearest<'a>(name: &str, known: &[&'a str]) -> Option<&'a str> {
    let budget = (name.chars().count() / 4 + 1).min(3);
    known
        .iter()
        .map(|&candidate| (distance(name, candidate), candidate))
        .filter(|(d, _)| *d <= budget)
        .min_by_key(|(d, candidate)| (*d, *candidate))
        .map(|(_, candidate)| candidate)
}

/// Levenshtein distance, two rows at a time.
fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0; b.len() + 1];
    for (i, ca) in a.chars().enumerate() {
        current[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let substitute = previous[j] + usize::from(ca != *cb);
            current[j + 1] = substitute.min(previous[j + 1] + 1).min(current[j] + 1);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[b.len()]
}

/// `check`, for a command that can refuse to start. Warnings on stderr, the
/// fatal case propagated.
pub fn enforce(config: &Config) -> Result<()> {
    for warning in check(config)? {
        eprintln!("warning: poly.toml {warning}");
    }
    Ok(())
}

/// `check`, for the daemon, which cannot refuse to start.
///
/// A session that stopped because one `[tools]` line names a file this machine
/// does not have would take every other language's features down with it, so
/// even the fatal case is reported here rather than raised. stderr is the
/// daemon's output channel: the editor's poly log is where these land.
///
/// Said at most once per process, because the daemon rediscovers the config on
/// every keystroke and an unconditional print would bury the log in copies of
/// one sentence. Same reasoning as `poly check`'s one-message-per-broken-config
/// rule, and as `fmt::note_missing`.
pub fn report(config: &Config) {
    static SAID: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    let lines = match check(config) {
        Ok(warnings) => warnings,
        Err(e) => vec![format!("{e:#}")],
    };
    let mut said = SAID.lock().expect("config warning memo");
    let said = said.get_or_insert_with(HashSet::new);
    for line in lines {
        if said.insert(line.clone()) {
            eprintln!("[poly] poly.toml {line}");
        }
    }
}

// ── export ─────────────────────────────────────────────────────────────────

/// poly.example.toml: the prose from the template, the facts from the binary.
pub fn export() -> String {
    let known = known_tools();
    let languages = poly_core::builtin_languages();
    // Formatted by an external tool rather than an embedded engine, which is
    // exactly the set `[format.<lang>]` does not reach. Derived because the
    // hand-written list still named lua and jupyter after both were embedded.
    let external: Vec<&str> = languages
        .iter()
        .copied()
        .filter(|lang| crate::fmt::formattable(lang) && !poly_engines::supported_language(lang))
        .collect();

    let mut tools = String::new();
    for tool in &known {
        let (version, note) = match tool.source {
            Source::Pinned(v) => (v, "downloaded on first use"),
            Source::Toolchain => ("system", "from the project's toolchain, on PATH"),
            Source::Server => ("-", "language server, from PATH"),
            Source::Analysis => ("-", "whole-program analysis (`poly deadcode`)"),
            Source::Embedded(_) => ("-", "compiled into poly; remove the entry"),
        };
        let _ = writeln!(tools, "#   {:<20}{:<9}{}", tool.name, version, note);
    }

    let embedded: Vec<&str> = poly_tools::EMBEDDED.iter().map(|(n, _)| *n).collect();

    TEMPLATE
        .replace("{{version}}", env!("CARGO_PKG_VERSION"))
        .replace("{{languages}}", &wrapped(&languages))
        .replace("{{external_format_languages}}", &wrapped(&external))
        .replace("{{tools}}", tools.trim_end())
        .replace("{{embedded}}", &listed(&embedded))
}

/// A comma-separated list of names as indented comment lines.
fn wrapped(names: &[&str]) -> String {
    let mut lines = vec![String::from("#   ")];
    for (i, name) in names.iter().enumerate() {
        let last = i + 1 == names.len();
        let piece = if last {
            (*name).to_string()
        } else {
            format!("{name}, ")
        };
        let line = lines.last_mut().expect("one line to start with");
        // 76 keeps the widest line inside the 80 columns the rest of the file
        // wraps at, comment marker and indent included.
        if line.chars().count() + piece.trim_end().chars().count() > 76 {
            lines.push(format!("#   {piece}"));
        } else {
            line.push_str(&piece);
        }
    }
    // Trailing space is invisible here and loud in a diff, and poly's own
    // formatter would strip it out from under the generator.
    lines
        .iter()
        .map(|line| line.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `a, b and c` -- prose, not a list.
fn listed(names: &[&str]) -> String {
    match names.split_last() {
        None => String::new(),
        Some((last, [])) => (*last).to_string(),
        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
    }
}

/// The generator's own check, run by `make config` before the diff.
///
/// A gate that stops working is worse than no gate: `poly config export |
/// diff` compares the binary against a file the binary wrote, so a placeholder
/// that quietly expanded to nothing would be regenerated into the committed
/// copy and pass forever after. These assert the derived blocks actually
/// carry what they are for.
pub fn self_test() -> Result<()> {
    let text = export();
    let languages = poly_core::builtin_languages();
    let mut problems: Vec<String> = Vec::new();
    if text.contains("{{") {
        problems.push("a placeholder was left unsubstituted".to_string());
    }
    if !text.contains(&wrapped(&languages)) {
        problems.push("the language list is not the one detection produces".to_string());
    }
    for tool in known_tools() {
        if !text.contains(&format!("#   {:<20}", tool.name)) {
            problems.push(format!("{} has no row in the [tools] table", tool.name));
        }
    }
    // The one block the template still spells out by hand, because the numbers
    // are each engine's own default rather than something poly states. Its
    // failure mode is a language landing in poly and never reaching the table
    // -- which is how handlebars went two releases undocumented -- so what is
    // checked is coverage, inside the table rather than anywhere in the file.
    match defaults_table(&text) {
        None => problems.push("the [format.<lang>] defaults table has moved".to_string()),
        Some(table) => {
            for lang in languages
                .iter()
                .filter(|l| poly_engines::supported_language(l))
            {
                if !table.contains(lang) {
                    problems.push(format!("{lang} has no row in the [format.<lang>] table"));
                }
            }
        }
    }
    if !problems.is_empty() {
        bail!(
            "poly config export is not producing what it claims:\n  {}",
            problems.join("\n  ")
        );
    }
    println!(
        "poly config export: {} tools, {} languages, {} lines",
        known_tools().len(),
        languages.len(),
        text.lines().count()
    );
    Ok(())
}

/// The rows of the `[format.<lang>]` defaults table, by the header above them
/// and the sentence below.
fn defaults_table(text: &str) -> Option<&str> {
    let (_, rest) = text.split_once("line-width  indent-width  use-tabs")?;
    let (table, _) = rest.split_once("# sql is sqruff's")?;
    Some(table)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_from(body: &str) -> (tempfile::TempDir, Config) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("poly.toml"), body).unwrap();
        let config = Config::discover(dir.path()).unwrap();
        (dir, config)
    }

    /// The export is only worth generating if saving it back is a no-op. Every
    /// live key has to be poly's own default and every illustrative value has
    /// to be commented out, or "copy this file and delete what you do not
    /// need" would change the build for whoever copied it.
    #[test]
    fn saving_the_export_unchanged_changes_nothing() {
        let (_dir, config) = config_from(&export());
        let empty = Config::empty();
        assert_eq!(config.format_exclude, empty.format_exclude);
        assert_eq!(config.lint_exclude, empty.lint_exclude);
        assert_eq!(config.format_fail_on, empty.format_fail_on);
        assert_eq!(config.lint_fail_on, empty.lint_fail_on);
        assert_eq!(config.include_hidden, empty.include_hidden);
        assert!(config.tools.is_empty(), "{:?}", config.tools);
        assert_eq!(config.format_languages().count(), 0);
        assert_eq!(config.language_map().count(), 0);
        // And nothing in it is a setting poly would then complain about.
        assert_eq!(check(&config).unwrap(), Vec::<String>::new());
    }

    /// Each of the three map-shaped holes names the key it could not place and,
    /// where the name is a near miss, what it probably meant.
    #[test]
    fn unknown_names_warn_and_suggest() {
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
            let (_dir, config) = config_from(body);
            let warnings = check(&config).expect("a near miss is not fatal");
            let joined = warnings.join("\n");
            assert!(joined.contains(typo), "{joined}");
            assert!(joined.contains(meant), "did not suggest {meant}: {joined}");
            // serde's wording, so both halves of the check read alike.
            assert!(joined.contains("expected one of"), "{joined}");
        }
    }

    /// A name nobody misspelled that way gets no guess -- the least-distant of
    /// thirty unrelated ids would be noise dressed as help.
    #[test]
    fn a_name_that_is_nobodys_typo_gets_no_suggestion() {
        let (_dir, config) = config_from("[languages.map]\n\"*.x\" = \"nosuchlanguage\"\n");
        let warnings = check(&config).unwrap();
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(!warnings[0].contains("did you mean"), "{}", warnings[0]);
    }

    /// The four names that stopped being binaries. Asserted on the message
    /// rather than on the exit code, which is what changed: an unactionable
    /// `[tools]` key is now stepped over, and what must not change is that the
    /// reader is told where the setting went.
    #[test]
    fn embedded_tools_name_where_the_setting_went() {
        for (name, value) in [
            ("selene", "off"),
            ("stylua", "2.4.0"),
            ("ruff", "0.16.5"),
            ("typos", "1.49.1"),
        ] {
            let (_dir, config) = config_from(&format!("[tools]\n{name} = \"{value}\"\n"));
            let warnings = check(&config).expect("an embedded name is not fatal");
            assert_eq!(warnings.len(), 1, "{warnings:?}");
            assert!(warnings[0].contains(name), "{}", warnings[0]);
        }
        // Someone who pinned ruff did it to control the rules and someone who
        // pinned typos did it to control the dictionary; ruff.toml and
        // _typos.toml are where those live now.
        for (name, instead) in [("ruff", "ruff.toml"), ("typos", "_typos.toml")] {
            let (_dir, config) = config_from(&format!("[tools]\n{name} = \"off\"\n"));
            let warnings = check(&config).unwrap();
            assert!(warnings[0].contains(instead), "{}", warnings[0]);
        }
        // Everything else is still a tool with a binary behind it.
        let (_dir, config) = config_from("[tools]\nshellcheck = \"off\"\n");
        assert!(check(&config).unwrap().is_empty());
    }

    /// The one case that stops the run. Nothing downstream would reveal it:
    /// poly resolves the tool to "missing", skips every file it would have
    /// checked, and exits 0.
    #[test]
    fn a_tools_path_that_does_not_exist_is_fatal() {
        let (_dir, config) = config_from("[tools]\nshellcheck = \"bin/shellcheck\"\n");
        let error = format!("{:#}", check(&config).expect_err("a false path must stop"));
        assert!(error.contains("shellcheck"), "{error}");
        assert!(error.contains("no such file"), "{error}");

        // A version pin and "off" are not paths and must not be tested as one.
        for value in ["off", "0.11.0"] {
            let (_dir, config) = config_from(&format!("[tools]\nshellcheck = \"{value}\"\n"));
            assert!(check(&config).is_ok(), "{value}");
        }
    }

    /// The export is documentation, so the interesting property is that the
    /// facts in it came from the binary rather than from a previous edit of the
    /// file.
    #[test]
    fn the_export_carries_the_binarys_own_facts() {
        let text = export();
        assert!(text.contains(env!("CARGO_PKG_VERSION")));
        for tool in poly_tools::TOOLS {
            assert!(text.contains(tool.name), "{} missing", tool.name);
            assert!(
                text.contains(tool.version),
                "{} {} missing",
                tool.name,
                tool.version
            );
        }
        // The names that are no longer binaries are still listed, marked as
        // what they became -- silence would read as "not a name poly knows".
        for (name, _) in poly_tools::EMBEDDED {
            assert!(text.contains(name), "{name} missing");
        }
        assert!(self_test().is_ok());
    }
}

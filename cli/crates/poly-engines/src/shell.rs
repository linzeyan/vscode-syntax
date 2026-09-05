//! Shell embedded in another language: lift it out, and put the checker's
//! findings back where they came from.
//!
//! Two producers, one shape. A Dockerfile `RUN` and a workflow `run:` are both
//! a shell script written inside a file that is not one, and both were until
//! now checked by nobody: poly's own Dockerfile and workflow rules stop at the
//! shell (see `lint::DOCKER_RULES` and `workflow::RULES`), hadolint and
//! actionlint each shell out to shellcheck, and poly could only pass those
//! findings through under the other tool's name and the other tool's position.
//!
//! What lives here is the half that can: the extraction and the *position map*.
//! Running shellcheck is not here and cannot be -- this crate depends on
//! poly-core alone, so it can neither resolve a tool nor spawn one. poly-cli
//! sees both crates and does that, exactly as it already hands actionlint the
//! shellcheck binary poly resolved.
//!
//! The deliverable is the map, not the extraction. A finding on the wrong line
//! is worse than no finding, and every construct here moves positions: a YAML
//! block scalar strips indentation from every line, a folded one joins lines so
//! the snippet has fewer of them than the file does, a `RUN` continued over `\`
//! is one command spanning many lines, and a `${{ }}` is not shell at all. So a
//! snippet is not a string -- it is a string plus the byte ranges it was copied
//! out of, and `Snippet::relocate` is the whole point of the module.

use std::ops::Range;
use std::path::Path;

use poly_core::diag::Issue;

/// The shells shellcheck can be told to read a script as.
///
/// A closed set on purpose: it is the answer to "may this text be handed to
/// shellcheck at all", and everything a host file can name that is *not* in it
/// -- pwsh, powershell, cmd, python, a custom `command {0}` template -- has to
/// come back as `None` rather than be checked as something it is not. Findings
/// from reading PowerShell as bash would all be wrong, and wrong findings cost
/// more than the silence they replace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    Sh,
    Bash,
    Dash,
    Ksh,
}

impl Shell {
    /// The name shellcheck's `-s` takes.
    ///
    /// Passed explicitly rather than left to shellcheck's shebang detection: an
    /// embedded snippet has no shebang, and the SC3xxx family is precisely the
    /// set of findings that depend on which dialect it is being read as. A
    /// `RUN` body under Alpine's `/bin/sh` and the same text under a
    /// `SHELL ["/bin/bash", "-c"]` get different answers, correctly.
    pub fn as_str(self) -> &'static str {
        match self {
            Shell::Sh => "sh",
            Shell::Bash => "bash",
            Shell::Dash => "dash",
            Shell::Ksh => "ksh",
        }
    }

    /// The dialect a shell *command* names, or `None` when it is not one
    /// shellcheck reads.
    ///
    /// Takes a whole command line, not a name: a Dockerfile writes
    /// `SHELL ["/bin/bash", "-o", "pipefail", "-c"]` and a workflow writes
    /// `shell: bash --noprofile --norc -eo pipefail {0}`, and in both the
    /// dialect is the first word's basename. `ash` is Alpine's `/bin/sh` and is
    /// POSIX; busybox's own dialect is not one shellcheck 0.11 accepts under
    /// `-s`, so it is read as `sh`.
    pub(crate) fn named(command: &str) -> Option<Shell> {
        let word = command.split_whitespace().next()?;
        let name = word.rsplit(['/', '\\']).next()?;
        match name {
            "sh" | "ash" | "busybox" => Some(Shell::Sh),
            "bash" => Some(Shell::Bash),
            "dash" => Some(Shell::Dash),
            "ksh" => Some(Shell::Ksh),
            _ => None,
        }
    }
}

/// A run of the snippet copied byte for byte out of the host file.
///
/// Byte ranges rather than lines because none of the three constructs preserves
/// lines: a folded scalar puts several host lines on one snippet line, a `RUN`
/// continuation puts several host lines on one snippet line too, and a block
/// scalar keeps the count but moves every column. Offsets survive all three.
#[derive(Debug)]
struct Segment {
    /// Byte offset into the snippet.
    snippet: usize,
    /// Byte offset into the host file the same text sits at.
    host: usize,
    len: usize,
}

/// Checks an embedded snippet cannot answer, whatever it is embedded in.
///
/// Not a list of rules poly disagrees with. Each of these needs input that is
/// definitionally outside the text being checked, so the answer is wrong rather
/// than merely unwanted:
///
/// - SC1090/SC1091 cannot follow a `source`, because the file being sourced is
///   inside the image or on the runner, never beside the Dockerfile.
/// - SC2153/SC2154 say a variable is never assigned, and the assignment is an
///   `ARG`, an `ENV`, a workflow `env:` or an earlier step's `$GITHUB_ENV`.
///
/// Excluded by handing shellcheck `-e` rather than by dropping findings after
/// the fact, so a `# shellcheck disable=` inside the snippet keeps working and
/// so the list is one thing a reader can check against shellcheck's own docs.
///
/// Measured, not copied: over the 1366 workflows these are, to the code, the
/// findings actionlint's own shellcheck integration does not report either.
const UNANSWERABLE: &[&str] = &["SC1090", "SC1091", "SC2153", "SC2154"];

/// The same, and what a workflow adds to it.
///
/// - SC2050/SC2157/SC2194 say an expression is constant, and it is only
///   constant because poly replaced a `${{ }}` with a stand-in. GitHub
///   substitutes a value there before the shell starts.
/// - SC2164/SC2103 want `cd x || exit`, and GitHub runs the built-in `bash` and
///   `sh` shells with `-e`, so a `cd` that fails already ends the step. (A
///   custom `command {0}` template that drops `-e` is the case this gives up
///   on, and it is rare enough to be worth the 77 false positives it saves.)
const UNANSWERABLE_IN_A_WORKFLOW: &[&str] = &[
    "SC1090", "SC1091", "SC2153", "SC2154", "SC2050", "SC2157", "SC2194", "SC2164", "SC2103",
];

/// One shell script lifted out of a host file, with the map back.
#[derive(Debug)]
pub struct Snippet {
    script: String,
    shell: Shell,
    excluded: &'static [&'static str],
    /// In ascending `snippet` order, and never overlapping. The gaps between
    /// them are text the host does not contain -- the newline that joins two
    /// halves of a folded scalar, the `\` that continues a `RUN`, the stand-in
    /// for a `${{ }}` -- and an offset landing in one maps to where the segment
    /// before it ended, which is the nearest place in the file that is real.
    segments: Vec<Segment>,
}

impl Snippet {
    /// The script, ready for shellcheck's stdin.
    pub fn script(&self) -> &str {
        &self.script
    }

    /// The dialect to check it as, for shellcheck's `-s`.
    pub fn shell(&self) -> &'static str {
        self.shell.as_str()
    }

    /// The codes this snippet's host makes unanswerable, for shellcheck's `-e`.
    /// See `UNANSWERABLE`.
    pub fn excluded(&self) -> &'static [&'static str] {
        self.excluded
    }

    /// Move a finding reported against `script()` onto `host`'s coordinates.
    ///
    /// In place rather than returning a new `Issue` because everything else
    /// about the finding -- code, message, severity, the fix flag, the wiki
    /// link -- is shellcheck's answer and travels unchanged. Only the position
    /// was ever about the snippet.
    ///
    /// The end is mapped too, and falls back to one character past the start
    /// when it maps to another line -- which happens exactly when a folded
    /// scalar's single snippet line is several lines of the file. That is the
    /// same clamp `lint::docker_issue` and `workflow::issue` apply, and for the
    /// same reason: a squiggle spanning the rest of the file is not a position.
    pub fn relocate(&self, host: &str, issue: &mut Issue) {
        let start = self.host_offset(offset_of(&self.script, issue.line, issue.col));
        let end = self.host_offset(offset_of(&self.script, issue.end_line, issue.end_col));
        let (line, col) = crate::lint::line_col(host, start);
        let (end_line, end_col) = crate::lint::line_col(host, end);
        issue.line = line;
        issue.col = col;
        if end > start && end_line == line {
            issue.end_line = end_line;
            issue.end_col = end_col;
        } else {
            issue.end_line = line;
            issue.end_col = col + 1;
        }
    }

    /// Where a snippet offset came from in the host file.
    fn host_offset(&self, at: usize) -> usize {
        let after = self.segments.partition_point(|s| s.snippet <= at);
        let Some(segment) = after.checked_sub(1).map(|i| &self.segments[i]) else {
            // Before the first segment: the leading filler of a snippet that
            // starts with one. The first thing the file really contains is the
            // closest true answer.
            return self.segments.first().map_or(0, |s| s.host);
        };
        segment.host + (at - segment.snippet).min(segment.len)
    }
}

/// Can a file of this kind carry embedded shell at all?
///
/// The pairing `lint::supported` uses, for the reason it uses it: a workflow is
/// YAML and a repository of Kubernetes manifests is thousands of files that are
/// not. Asked before any file is read, so a repository with neither never pays
/// for resolving -- or downloading -- a shellcheck it has no use for.
pub fn hosts_shell(lang: &str, path: &Path) -> bool {
    match lang {
        "dockerfile" => true,
        "yaml" => poly_core::is_workflow_file(path),
        _ => false,
    }
}

/// Every shell script embedded in `text`, whatever kind of file it is.
///
/// The signature is `lint::lint`'s, and deliberately: the caller resolves one
/// shellcheck and runs it over whatever comes back, without ever learning
/// whether it was reading a Dockerfile or a workflow.
pub fn embedded(lang: &str, path: &Path, text: &str) -> Vec<Snippet> {
    if !hosts_shell(lang, path) {
        return Vec::new();
    }
    match lang {
        "dockerfile" => dockerfile(text),
        _ => crate::workflow::shell_snippets(text),
    }
}

/// Assembles a snippet and its map together, so the two cannot drift.
///
/// Every byte of the script arrives through exactly one of two doors: `copy`,
/// which records where it came from, and `filler`, which says out loud that it
/// came from nowhere. There is no third way to append, which is what makes the
/// map complete by construction rather than by review.
#[derive(Default)]
pub(crate) struct Builder {
    script: String,
    segments: Vec<Segment>,
    /// A `${{` whose `}}` has not been seen yet. Carried between `sanitized`
    /// calls because a block scalar is copied a line at a time and an
    /// expression may be written across two of them.
    in_expression: bool,
}

impl Builder {
    /// Copy `host[range]` in, byte for byte, remembering where it was.
    pub(crate) fn copy(&mut self, host: &str, range: Range<usize>) {
        let Some(slice) = host.get(range.clone()) else {
            return;
        };
        if slice.is_empty() {
            return;
        }
        self.segments.push(Segment {
            snippet: self.script.len(),
            host: range.start,
            len: slice.len(),
        });
        self.script.push_str(slice);
    }

    /// Copy `host[range]` in with every `${{ }}` replaced by a stand-in.
    ///
    /// A workflow expression is not shell and shellcheck says so three times
    /// over: `${{ x }}` alone draws SC2296, SC1083 and an SC2086 about the
    /// nothing it expands to. Every one of those is about a construct GitHub
    /// substitutes before the shell ever runs, so all three are noise, and
    /// noise from a tool teaches people to stop reading it.
    ///
    /// One `_` per character, so a column after an expression still lines up
    /// with the file. Where it does not -- a multi-byte character inside the
    /// expression -- the stand-in is a gap in the map, and a finding inside it
    /// lands on the `${{`, which is the honest answer.
    pub(crate) fn sanitized(&mut self, host: &str, range: Range<usize>) {
        let Some(slice) = host.get(range.clone()) else {
            return;
        };
        let mut at = 0usize;
        while at < slice.len() {
            if self.in_expression {
                let Some(close) = slice[at..].find("}}") else {
                    self.filler(&"_".repeat(slice[at..].chars().count()));
                    return;
                };
                self.filler(&"_".repeat(slice[at..at + close + 2].chars().count()));
                at += close + 2;
                self.in_expression = false;
                continue;
            }
            let Some(open) = slice[at..].find("${{") else {
                self.copy(host, range.start + at..range.end);
                return;
            };
            self.copy(host, range.start + at..range.start + at + open);
            at += open;
            self.in_expression = true;
        }
    }

    /// Text the host file does not contain: a separator, or a stand-in.
    pub(crate) fn filler(&mut self, text: &str) {
        self.script.push_str(text);
    }

    /// Trim trailing newlines down to `keep` of them, at most.
    fn chomp(&mut self, keep: usize) {
        let body = self.script.trim_end_matches('\n').len();
        let newlines = self.script.len() - body;
        self.script.truncate(body + newlines.min(keep));
    }

    /// The finished snippet, or `None` when there is no shell in it.
    ///
    /// A `run: ""`, a `RUN` that is nothing but a comment, or a block scalar
    /// whose body did not parse all produce an empty script, and handing
    /// shellcheck an empty file costs a process to be told nothing.
    pub(crate) fn finish(self, shell: Shell, excluded: &'static [&'static str]) -> Option<Snippet> {
        if self.script.trim().is_empty() {
            return None;
        }
        Some(Snippet {
            script: self.script,
            shell,
            excluded,
            segments: self.segments,
        })
    }
}

/// Where shellcheck's 0-based line and column land in `text`, as a byte offset.
///
/// Not the inverse of `lint::line_col`, because shellcheck does not count the
/// same thing it does: a tab advances to the next multiple of eight rather than
/// by one, so `\t\techo $A` puts the `$` at shellcheck's column 22 and at
/// character 8. Both are "the column", and the one poly reports everywhere else
/// is the character -- so the tab stops are undone here, once, where the two
/// conventions meet. Left in, every finding on a tab-indented `RUN` -- which is
/// how a great many Dockerfiles are written -- lands fourteen columns to the
/// right of what it is about.
fn offset_of(text: &str, line: u32, col: u32) -> usize {
    let mut start = 0usize;
    for _ in 0..line {
        match text[start..].find('\n') {
            Some(i) => start += i + 1,
            None => return text.len(),
        }
    }
    let rest = &text[start..];
    let line_text = rest.split('\n').next().unwrap_or(rest);
    let mut column = 0usize;
    for (offset, character) in line_text.char_indices() {
        if column >= col as usize {
            return start + offset;
        }
        column = match character {
            '\t' => column / TAB_STOP * TAB_STOP + TAB_STOP,
            _ => column + 1,
        };
    }
    start + line_text.len()
}

/// shellcheck's tab width, and not configurable there either.
const TAB_STOP: usize = 8;

// ── dockerfile ─────────────────────────────────────────────────────────────

/// Every `RUN` body in a Dockerfile that runs through a shell.
///
/// Exec form (`RUN ["a", "b"]`) is excluded because it is not shell at all --
/// Docker execs the array directly, no shell is involved, and `$HOME` in it is
/// four characters rather than an expansion. `ONBUILD RUN` is excluded for the
/// reason `lint_dockerfile` excludes `ONBUILD` whole: it runs in a build that
/// this file does not describe.
fn dockerfile(text: &str) -> Vec<Snippet> {
    use dprint_plugin_dockerfile::ast::{
        BreakableStringComponent as Component, Dockerfile, Instruction, ShellOrExecExpr,
    };

    let Ok(file) = Dockerfile::parse(text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    // `/bin/sh -c` until a `SHELL` says otherwise, and only until the next
    // `FROM`: a stage begins with none of the previous one's `SHELL`, the same
    // scoping `DockerStage` gives `pipefail`.
    let mut shell = Some(Shell::Sh);

    for instruction in &file.instructions {
        // A heredoc wraps the instruction that opened it; the wrapper is
        // unwrapped here exactly as `lint_dockerfile` unwraps it.
        let (instruction, heredoc) = match instruction {
            Instruction::Heredoc(h) => (h.instruction.as_ref(), Some(h)),
            other => (other, None),
        };
        match instruction {
            Instruction::From(_) => shell = Some(Shell::Sh),
            Instruction::Shell(set) => shell = docker_shell(&set.expr),
            Instruction::Run(run) => {
                let (Some(shell), ShellOrExecExpr::Shell(body)) = (shell, &run.expr) else {
                    continue;
                };
                let mut builder = Builder::default();
                // `RUN <<EOF` with nothing else on the line is Docker's own
                // form: it writes the body to a file and runs *that* with the
                // default shell, so the body is the whole script and the
                // redirection was never shell at all. Handing shellcheck the
                // `<<EOF` line as well draws SC2188 -- a redirection with no
                // command -- and, worse, makes the body heredoc data rather
                // than the code it is, so every real finding in it is lost.
                // `RUN python3 <<EOF` is the other case and is ordinary shell:
                // the first line is a command that reads its stdin, which is
                // exactly what shellcheck already understands a heredoc to be.
                let bare = heredoc.is_some() && docker_bare_heredoc(&body.components);
                if !bare {
                    let mut wrote = false;
                    for component in &body.components {
                        // A comment line inside a `RUN` is dropped rather than
                        // copied: Docker removes it before the shell sees
                        // anything, so passing it through would let the `#`
                        // swallow the continuation that follows it.
                        //
                        // Which is also why a `# shellcheck disable=` cannot
                        // work inside a `RUN` -- it never reaches shellcheck
                        // because it never reaches the shell either. In a
                        // workflow `run:` it does, because a block scalar is
                        // copied line for line. The way to silence one of these
                        // in a Dockerfile is `# poly: ignore shellcheck/SC2086`
                        // on the line above the instruction.
                        let Component::String(part) = component else {
                            continue;
                        };
                        let mut start = part.span.start;
                        if !wrote {
                            start += docker_run_flags(&text[start..part.span.end]);
                        }
                        if start >= part.span.end {
                            continue;
                        }
                        if wrote {
                            // The continuation Docker removed, put back. `\`
                            // before a newline means the same thing to the
                            // shell as it does to Docker, so the snippet keeps
                            // the file's line structure instead of collapsing
                            // to one long line.
                            builder.filler("\\\n");
                        }
                        builder.copy(text, start..part.span.end);
                        wrote = true;
                    }
                }
                if let Some(heredoc) = heredoc {
                    // The body is a slice of `text` ending where the
                    // instruction does, so its start is the one thing the span
                    // does not say outright. Its last line is the closing
                    // delimiter, which is part of the redirection and not part
                    // of the script it delimits.
                    let start = heredoc.span.end.saturating_sub(heredoc.body.len());
                    let end = match bare {
                        true => start + heredoc.body.rfind('\n').unwrap_or(heredoc.body.len()),
                        false => heredoc.span.end,
                    };
                    if !bare {
                        builder.filler("\n");
                    }
                    builder.copy(text, start..end);
                }
                out.extend(builder.finish(shell, UNANSWERABLE));
            }
            _ => {}
        }
    }
    out
}

/// How much of a `RUN` body is Docker's own flags rather than shell.
///
/// `RUN --mount=type=cache,target=/root/.cache cmd` gives the build a mount;
/// the shell is handed `cmd` alone. The parser keeps the flags in the body
/// because only `FROM` and `COPY` have a flags field, so they are dropped here
/// -- left in, shellcheck reads `--mount=...` as the command name and says so
/// (SC2215) on every `RUN` that uses one, which was 25 findings over the 256
/// Dockerfiles measured and every one of them wrong.
///
/// A shell command never begins with `--`, so the prefix is unambiguous.
fn docker_run_flags(text: &str) -> usize {
    let mut at = text.len() - text.trim_start().len();
    while text[at..].starts_with("--") {
        at += text[at..]
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .len();
        at += text[at..].len() - text[at..].trim_start().len();
    }
    at
}

/// Is this `RUN` nothing but heredoc redirections?
///
/// Docker treats `RUN <<EOF` as "run the body", and anything else on the line
/// as a command the body is fed to. Written over the parsed components rather
/// than over the raw line because a `RUN` may be continued, and a comment line
/// inside it is not part of what the shell would see.
fn docker_bare_heredoc(
    components: &[dprint_plugin_dockerfile::ast::BreakableStringComponent<'_>],
) -> bool {
    use dprint_plugin_dockerfile::ast::BreakableStringComponent as Component;
    let mut words = components
        .iter()
        .filter_map(|component| match component {
            Component::String(part) => Some(part.content.as_ref()),
            Component::Comment(_) => None,
        })
        .flat_map(str::split_whitespace)
        .peekable();
    words.peek().is_some() && words.all(|word| word.starts_with("<<"))
}

/// The dialect a `SHELL` instruction selects, or `None` when it is not one
/// shellcheck reads.
///
/// A shell-form `SHELL` is not valid Docker -- the instruction takes a JSON
/// array -- so rather than guess what was meant, every `RUN` after it goes
/// unchecked until the next `FROM`.
fn docker_shell(expr: &dprint_plugin_dockerfile::ast::ShellOrExecExpr<'_>) -> Option<Shell> {
    use dprint_plugin_dockerfile::ast::ShellOrExecExpr;
    match expr {
        ShellOrExecExpr::Exec(array) => Shell::named(array.elements.first()?.content.as_ref()),
        ShellOrExecExpr::Shell(_) => None,
    }
}

// ── yaml scalars ───────────────────────────────────────────────────────────

/// The style of a block scalar header, and what it does to line breaks.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Block {
    /// `|` -- every line break is a line break.
    Literal,
    /// `>` -- a break between two equally-indented lines becomes a space.
    Folded,
}

/// A workflow `run:` value as a shell script, with the map back to the file.
///
/// `at`..`end` is the value node's own byte range and `key_col` the column the
/// `run` key starts at, which is the only thing an explicit indentation
/// indicator (`run: |2`) can be measured against -- YAML counts it from the
/// parent node, and the parent of a mapping's value is the mapping.
///
/// `None` for anything whose text poly cannot place character for character.
/// A quoted scalar carrying escapes is the case that reaches it: resolving
/// `\"` shortens the value by one, every column after it shifts, and a shifted
/// column is exactly the failure this module exists to avoid.
pub(crate) fn yaml_run(
    host: &str,
    at: usize,
    end: usize,
    key_col: usize,
    shell: Shell,
) -> Option<Snippet> {
    let end = end.min(host.len());
    let slice = host.get(at..end)?;
    let mut builder = Builder::default();
    match slice.as_bytes().first()? {
        b'|' => yaml_block(&mut builder, host, at, end, key_col, Block::Literal),
        b'>' => yaml_block(&mut builder, host, at, end, key_col, Block::Folded),
        b'\'' | b'"' => yaml_quoted(&mut builder, host, at, end)?,
        _ => yaml_flow(&mut builder, host, at, end, false),
    }
    builder.finish(shell, UNANSWERABLE_IN_A_WORKFLOW)
}

/// A block scalar (`run: |`, `>-`, `|2`), unindented into a script.
fn yaml_block(
    builder: &mut Builder,
    host: &str,
    at: usize,
    end: usize,
    key_col: usize,
    style: Block,
) {
    let slice = &host[at..end];
    // The header is the indicators, then anything up to the first line break:
    // a trailing comment is legal there and is not part of the body.
    let header: String = slice[1..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '+' || *c == '-')
        .collect();
    let Some(newline) = slice.find('\n') else {
        return;
    };
    let body_at = at + newline + 1;
    let keep = match header.chars().find(|c| *c == '+' || *c == '-') {
        // `+` keeps every trailing line break, `-` strips them all, and the
        // default clips to one. None of the three changes a column, so this is
        // only about not handing shellcheck a file with a hundred blank lines.
        Some('+') => usize::MAX,
        Some('-') => 0,
        _ => 1,
    };
    let explicit: Option<usize> = header.chars().find(char::is_ascii_digit).map(|c| {
        // An indentation indicator counts from the parent node's indentation,
        // which for a mapping value is the column of its key.
        key_col + (c as usize - '0' as usize)
    });

    let lines: Vec<Range<usize>> = line_ranges(host, body_at, end);
    let indent = explicit.unwrap_or_else(|| {
        lines
            .iter()
            .find(|line| !host[(*line).clone()].trim().is_empty())
            .map_or(0, |line| leading_spaces(&host[line.clone()]))
    });

    let mut previous: Option<bool> = None;
    let mut blanks = 0usize;
    for line in lines {
        let text = &host[line.clone()];
        // A line indented less than the block ends it. The parser bounds the
        // node already, so this only catches the trailing blank lines it keeps.
        let content = line.start + leading_spaces(text).min(indent)..line.end;
        if host[content.clone()].trim().is_empty() {
            match style {
                // A blank line inside a literal block is a blank line.
                Block::Literal => builder.filler("\n"),
                // Inside a folded one it is the break that stops the folding:
                // n blank lines between two pieces of text are n line breaks.
                Block::Folded => blanks += usize::from(previous.is_some()),
            }
            continue;
        }
        // More-indented lines are not folded, and neither are the breaks
        // either side of them -- which is how a folded scalar carries a
        // command whose arguments are laid out over several lines.
        let deeper = host[content.clone()].starts_with([' ', '\t']);
        match style {
            Block::Literal => {}
            Block::Folded => {
                if let Some(above) = previous {
                    if blanks > 0 {
                        builder.filler(&"\n".repeat(blanks));
                    } else if deeper || above {
                        builder.filler("\n");
                    } else {
                        builder.filler(" ");
                    }
                }
                blanks = 0;
                previous = Some(deeper);
            }
        }
        builder.sanitized(host, content.start..strip_cr(host, content.end));
        if style == Block::Literal {
            builder.filler("\n");
        }
    }
    if style == Block::Folded {
        builder.filler("\n");
    }
    builder.chomp(keep);
}

/// A plain scalar (`run: echo hi`), folded the way YAML folds it.
///
/// The same folding `workflow::fold_plain` applies to every other value in the
/// file, so a `run:` written over two lines reads here as the one line the
/// shell is handed. `quoted` says the first and last character are the quotes
/// and are not part of it.
fn yaml_flow(builder: &mut Builder, host: &str, at: usize, end: usize, quoted: bool) {
    let (at, end) = if quoted { (at + 1, end - 1) } else { (at, end) };
    let mut first = true;
    let mut blanks = 0usize;
    for line in line_ranges(host, at, end) {
        let trimmed = trim_range(host, line);
        if trimmed.is_empty() {
            blanks += usize::from(!first);
            continue;
        }
        if !std::mem::take(&mut first) {
            builder.filler(if blanks > 0 { "\n" } else { " " });
        }
        blanks = 0;
        builder.sanitized(host, trimmed);
    }
    builder.filler("\n");
}

/// A quoted scalar, or `None` when unquoting it would move a column.
///
/// `''` inside a single-quoted scalar is one apostrophe and `\"` inside a
/// double-quoted one is one quote; both shorten the value, and every column
/// after one is then a column this module would report wrongly. They are rare
/// enough in a `run:` that declining is cheaper than a second unescaper whose
/// mistakes would be invisible.
fn yaml_quoted(builder: &mut Builder, host: &str, at: usize, end: usize) -> Option<()> {
    let slice = host.get(at..end)?;
    if slice.len() < 2 {
        return None;
    }
    let inner = &slice[1..slice.len() - 1];
    let escaped = match slice.as_bytes()[0] {
        b'\'' => inner.contains('\''),
        _ => inner.contains('\\'),
    };
    if escaped {
        return None;
    }
    yaml_flow(builder, host, at, end, true);
    Some(())
}

/// The byte range of every line between two offsets, line terminators excluded.
fn line_ranges(host: &str, at: usize, end: usize) -> Vec<Range<usize>> {
    if at >= end {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut start = at;
    while start < end {
        let stop = host[start..end].find('\n').map_or(end, |i| start + i);
        out.push(start..stop);
        start = stop + 1;
    }
    out
}

fn leading_spaces(text: &str) -> usize {
    text.bytes().take_while(|b| *b == b' ').count()
}

/// `end`, moved back off a `\r` that only belongs to the line terminator.
///
/// A CRLF workflow would otherwise put a carriage return inside the script and
/// draw SC1017 on every line of it -- a finding about the file's line endings,
/// reported once per command, in the middle of the shell.
fn strip_cr(host: &str, end: usize) -> usize {
    match host[..end].ends_with('\r') {
        true => end - 1,
        false => end,
    }
}

/// `line` with the whitespace at both ends dropped.
fn trim_range(host: &str, line: Range<usize>) -> Range<usize> {
    let text = &host[line.clone()];
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return line.start..line.start;
    }
    let start = line.start + (text.len() - text.trim_start().len());
    start..start + trimmed.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use poly_core::diag::Severity;
    use std::path::PathBuf;

    fn workflow(text: &str) -> Vec<Snippet> {
        embedded("yaml", &PathBuf::from(".github/workflows/ci.yml"), text)
    }

    fn one(text: &str) -> Snippet {
        let mut all = workflow(text);
        assert_eq!(all.len(), 1, "expected one snippet: {all:?}");
        all.remove(0)
    }

    fn docker(text: &str) -> Vec<Snippet> {
        embedded("dockerfile", &PathBuf::from("Dockerfile"), text)
    }

    /// A finding shaped like shellcheck's, at a 0-based snippet position.
    fn finding(line: u32, col: u32, width: u32) -> Issue {
        Issue {
            line,
            col,
            end_line: line,
            end_col: col + width,
            severity: Severity::Info,
            code: "SC2086".to_string(),
            message: "probe".to_string(),
            source: "shellcheck",
            fix: None,
            url: None,
        }
    }

    /// Assert that a finding on `needle`, wherever it sits in the snippet,
    /// lands on `line`:`col` of the *host* file -- and that `needle` really is
    /// written there.
    ///
    /// The second half is what makes these tests about the map rather than
    /// about the arithmetic: an expected position copied out of a failing run
    /// would still satisfy the first assertion.
    #[track_caller]
    fn lands(snippet: &Snippet, host: &str, needle: &str, line: u32, col: u32) {
        let at = snippet
            .script()
            .find(needle)
            .unwrap_or_else(|| panic!("{needle:?} not in snippet {:?}", snippet.script()));
        let (from_line, from_col) = crate::lint::line_col(snippet.script(), at);
        let mut issue = finding(from_line, from_col, needle.chars().count() as u32);
        snippet.relocate(host, &mut issue);
        assert_eq!(
            (issue.line, issue.col),
            (line, col),
            "{needle:?} from snippet {from_line}:{from_col}"
        );
        let text = host.lines().nth(line as usize).expect("host line");
        let at: String = text.chars().skip(col as usize).collect();
        assert!(
            at.starts_with(needle),
            "host {line}:{col} is {at:?}, not {needle:?}"
        );
    }

    // ── yaml block scalars ─────────────────────────────────────────────────

    /// `run: |` strips the block's indentation, so every column moves.
    #[test]
    fn literal_block_gives_back_the_columns_it_stripped() {
        let host = "\
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo $ONE
          echo $TWO
";
        let snippet = one(host);
        assert_eq!(snippet.script(), "echo $ONE\necho $TWO\n");
        lands(&snippet, host, "$ONE", 5, 15);
        lands(&snippet, host, "$TWO", 6, 15);
    }

    /// `|-` and `|+` only change the trailing newlines, never a position.
    ///
    /// `+` and the default coincide here rather than differing by the two
    /// blank lines below: the YAML parser does not extend a block scalar node
    /// over trailing empty lines, so there is nothing for `+` to keep. Pinned
    /// because it is a property of the parser, not of this module.
    #[test]
    fn chomping_indicators_do_not_move_anything() {
        for (indicator, tail) in [("|", "\n"), ("|-", ""), ("|+", "\n")] {
            let host = format!(
                "jobs:\n  j:\n    steps:\n      - run: {indicator}\n          echo $A\n\n\n"
            );
            let snippet = one(&host);
            assert_eq!(snippet.script(), format!("echo $A{tail}"), "{indicator}");
            lands(&snippet, &host, "$A", 4, 15);
        }
    }

    /// A folded scalar joins lines, so a snippet line is several file lines and
    /// only the offset map knows which.
    #[test]
    fn folded_block_reports_on_the_line_the_text_is_on() {
        let host = "\
jobs:
  j:
    steps:
      - run: >
          echo $ONE
          && echo $TWO
";
        let snippet = one(host);
        assert_eq!(snippet.script(), "echo $ONE && echo $TWO\n");
        // Both are on snippet line 0; they are on different lines of the file.
        lands(&snippet, host, "$ONE", 4, 15);
        lands(&snippet, host, "$TWO", 5, 18);
    }

    /// A more-indented line inside a folded scalar keeps its break, and a blank
    /// line is a break the folding does not eat.
    #[test]
    fn folded_block_keeps_the_breaks_yaml_keeps() {
        let host = "\
jobs:
  j:
    steps:
      - run: >
          echo $ONE

          echo $TWO
            echo $THREE
          echo $FOUR
";
        let snippet = one(host);
        assert_eq!(
            snippet.script(),
            "echo $ONE\necho $TWO\n  echo $THREE\necho $FOUR\n"
        );
        lands(&snippet, host, "$ONE", 4, 15);
        lands(&snippet, host, "$TWO", 6, 15);
        lands(&snippet, host, "$THREE", 7, 17);
        lands(&snippet, host, "$FOUR", 8, 15);
    }

    /// An explicit indentation indicator counts from the parent node, so the
    /// body's own indentation is not the answer.
    #[test]
    fn explicit_indentation_indicator_is_measured_from_the_key() {
        // `run` starts at column 8, so `|2` means the block is indented to 10
        // and the two leading spaces of the body are part of the script.
        let host = "\
jobs:
  j:
    steps:
      - run: |2
            echo $A
";
        let snippet = one(host);
        assert_eq!(snippet.script(), "  echo $A\n");
        lands(&snippet, host, "$A", 4, 17);
    }

    /// Without the indicator the first non-empty line sets the indentation,
    /// which is the same block read differently.
    #[test]
    fn without_the_indicator_the_first_line_sets_the_indentation() {
        let host = "\
jobs:
  j:
    steps:
      - run: |
            echo $A
";
        let snippet = one(host);
        assert_eq!(snippet.script(), "echo $A\n");
        lands(&snippet, host, "$A", 4, 17);
    }

    /// shellcheck counts a tab as a jump to the next multiple of eight and poly
    /// reports characters, so a tab-indented `RUN` -- which is how a great many
    /// Dockerfiles are written -- is where the two conventions have to be
    /// reconciled. `\t\techo ` puts the `$` at shellcheck's column 22 and at
    /// character 8, and the finding belongs on character 8.
    #[test]
    fn shellchecks_tab_stops_are_undone() {
        let host = "FROM debian:12\nRUN echo a; \\\n\t\techo $A\n";
        let all = docker(host);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].script(), "echo a; \\\n\t\techo $A");
        // shellcheck's column 22 on snippet line 1, as a 0-based 21.
        let mut issue = finding(1, 21, 2);
        all[0].relocate(host, &mut issue);
        assert_eq!((issue.line, issue.col), (2, 7));
        assert_eq!(
            host.lines().nth(2).unwrap().chars().nth(7),
            Some('$'),
            "the reported column is the `$`"
        );
    }

    /// Columns are characters, as everywhere else in poly, so a multi-byte
    /// comment above and beside the finding must not move it.
    #[test]
    fn columns_are_characters_not_bytes() {
        let host = "\
jobs:
  j:
    steps:
      - run: |
          # 這是一個註釋
          echo 「$A」
";
        let snippet = one(host);
        lands(&snippet, host, "$A", 5, 16);
    }

    /// A `\\r\\n` file must not put a carriage return in the script: SC1017 on
    /// every line would be a finding about the file, repeated per command.
    #[test]
    fn carriage_returns_stay_out_of_the_script() {
        let host = "jobs:\r\n  j:\r\n    steps:\r\n      - run: |\r\n          echo $A\r\n";
        let snippet = one(host);
        assert_eq!(snippet.script(), "echo $A\n");
        assert!(!snippet.script().contains('\r'));
    }

    // ── ${{ }} ─────────────────────────────────────────────────────────────

    /// An expression is not shell. Left in, `${{ x }}` alone draws SC2296,
    /// SC1083 and an SC2086 -- three findings about a construct GitHub
    /// substitutes before the shell starts.
    #[test]
    fn expressions_become_stand_ins_that_keep_the_columns() {
        let host = "\
jobs:
  j:
    steps:
      - run: |
          echo ${{ github.sha }} $AFTER
";
        let snippet = one(host);
        assert_eq!(snippet.script(), "echo _________________ $AFTER\n");
        lands(&snippet, host, "$AFTER", 4, 33);
    }

    /// A finding inside the stand-in lands on the `${{` it stands for, which
    /// is the nearest thing in the file that is real.
    #[test]
    fn a_finding_inside_a_stand_in_lands_on_the_expression() {
        let host = "jobs:\n  j:\n    steps:\n      - run: echo ${{ x }}\n";
        let snippet = one(host);
        let mut issue = finding(0, 7, 2);
        snippet.relocate(host, &mut issue);
        assert_eq!((issue.line, issue.col), (3, 18));
    }

    /// An expression written over two lines of a block scalar is still one
    /// expression: the scanner has to carry the `${{` across the copy.
    #[test]
    fn an_expression_spanning_lines_is_still_one_expression() {
        let host = "\
jobs:
  j:
    steps:
      - run: |
          echo ${{
            github.sha }} $AFTER
";
        let snippet = one(host);
        assert!(!snippet.script().contains("${{"), "{:?}", snippet.script());
        assert!(!snippet.script().contains("}}"), "{:?}", snippet.script());
        lands(&snippet, host, "$AFTER", 5, 26);
    }

    // ── plain and quoted scalars ───────────────────────────────────────────

    #[test]
    fn a_one_line_run_is_the_line_it_is_written_on() {
        let host = "jobs:\n  j:\n    steps:\n      - run: echo $A\n";
        let snippet = one(host);
        assert_eq!(snippet.script(), "echo $A\n");
        lands(&snippet, host, "$A", 3, 18);
    }

    /// A plain scalar continued over two lines is one value with a space in
    /// the middle, exactly as `fold_plain` reads every other value in the file.
    #[test]
    fn a_plain_scalar_folds_the_way_the_rest_of_the_file_does() {
        let host = "jobs:\n  j:\n    steps:\n      - run: echo $A\n          $B\n";
        let snippet = one(host);
        assert_eq!(snippet.script(), "echo $A $B\n");
        lands(&snippet, host, "$A", 3, 18);
        lands(&snippet, host, "$B", 4, 10);
    }

    #[test]
    fn a_quoted_run_drops_its_quotes_and_keeps_its_columns() {
        for quote in ['\'', '"'] {
            let host = format!("jobs:\n  j:\n    steps:\n      - run: {quote}echo $A{quote}\n");
            let snippet = one(&host);
            assert_eq!(snippet.script(), "echo $A\n");
            lands(&snippet, &host, "$A", 3, 19);
        }
    }

    /// An escape shortens the value, so every column after it would be wrong.
    /// Reporting nothing is the only honest answer left.
    #[test]
    fn a_quoted_run_carrying_escapes_is_declined() {
        let host = "jobs:\n  j:\n    steps:\n      - run: \"echo \\\"$A\\\"\"\n";
        assert!(workflow(host).is_empty());
    }

    // ── which run: is shell ────────────────────────────────────────────────

    /// The step's own `shell:`, then the job's `defaults`, then the workflow's.
    #[test]
    fn the_nearest_shell_declaration_wins() {
        let host = "\
defaults:
  run:
    shell: pwsh
jobs:
  a:
    steps:
      - run: echo $A
  b:
    defaults:
      run:
        shell: bash
    steps:
      - run: echo $B
      - run: echo $C
        shell: python
      - run: echo $D
        shell: sh
";
        let all = workflow(host);
        let scripts: Vec<&str> = all.iter().map(Snippet::script).collect();
        assert_eq!(scripts, ["echo $B\n", "echo $D\n"]);
        let shells: Vec<&str> = all.iter().map(Snippet::shell).collect();
        assert_eq!(shells, ["bash", "sh"]);
    }

    /// A custom `command {0}` template is read by its first word, so
    /// `bash --noprofile ... {0}` is still bash and `perl {0}` is still not
    /// anything shellcheck reads.
    #[test]
    fn a_custom_shell_template_is_read_by_its_command() {
        let host = "\
jobs:
  j:
    steps:
      - run: echo $A
        shell: bash --noprofile --norc -eo pipefail {0}
      - run: print 1
        shell: perl {0}
";
        let all = workflow(host);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].shell(), "bash");
    }

    /// A Windows runner's undeclared shell is pwsh, so the script is
    /// PowerShell and shellcheck has nothing to say about it. An explicit
    /// `shell: bash` on the same runner is bash, and does.
    #[test]
    fn a_windows_runner_defaults_to_a_shell_shellcheck_does_not_read() {
        let host = "\
jobs:
  j:
    runs-on: windows-latest
    steps:
      - run: Write-Host $A
      - run: echo $B
        shell: bash
";
        let all = workflow(host);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].script(), "echo $B\n");
    }

    /// `runs-on: ${{ matrix.os }}` puts the label in the matrix. A matrix that
    /// can produce Windows makes the same script both bash and PowerShell, so
    /// poly reads it as neither; one that cannot is an ordinary bash job.
    #[test]
    fn an_unresolved_runner_is_answered_from_the_matrix() {
        let template = "\
jobs:
  j:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, OS]
    steps:
      - run: echo $A
";
        assert!(workflow(&template.replace("OS", "windows-latest")).is_empty());
        assert_eq!(workflow(&template.replace("OS", "macos-latest")).len(), 1);
    }

    /// A `runs-on:` poly cannot resolve leaves the runner's OS unknown, and
    /// with it the default shell. Silence rather than a guess: a reusable
    /// workflow whose `inputs.os` is a Windows label would otherwise have every
    /// PowerShell line read as bash. An explicit `shell:` still decides.
    #[test]
    fn an_unresolvable_runner_leaves_the_shell_unknown() {
        let host = "\
jobs:
  j:
    runs-on: ${{ inputs.os }}
    steps:
      - run: echo $A
      - run: echo $B
        shell: bash
";
        let all = workflow(host);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].script(), "echo $B\n");
    }

    /// A value the matrix only reaches through `include` still schedules a job,
    /// so it still decides the shell. The runner rule declines a declared list
    /// an `exclude` touches; this must not, because declining here means
    /// reading PowerShell as bash rather than saying nothing.
    #[test]
    fn a_matrix_value_reached_only_through_include_still_counts() {
        let host = "\
jobs:
  j:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
        exclude:
          - os: ubuntu-latest
            go: '1.21'
        include:
          - os: windows-latest
    steps:
      - run: echo $A
";
        assert!(workflow(host).is_empty());
    }

    /// A step that names an action runs no shell, and a `run:` with nothing
    /// under it is not a script -- its node covers the key.
    #[test]
    fn steps_without_a_script_produce_nothing() {
        let host = "\
jobs:
  j:
    steps:
      - uses: actions/checkout@v4
      - run:
      - name: nothing
";
        assert!(workflow(host).is_empty());
    }

    /// The path decides, not the language: a Kubernetes manifest is YAML too.
    #[test]
    fn only_workflows_are_read_as_workflows() {
        let host = "jobs:\n  j:\n    steps:\n      - run: echo $A\n";
        assert!(embedded("yaml", &PathBuf::from("k8s/deploy.yaml"), host).is_empty());
    }

    // ── dockerfile ─────────────────────────────────────────────────────────

    /// A `RUN` continued over `\` is one command over many lines. The snippet
    /// keeps the continuations so the file's line structure survives.
    #[test]
    fn a_continued_run_keeps_the_lines_it_was_written_on() {
        let host = "\
FROM debian:12
RUN echo $ONE \\
  && echo $TWO \\
  && echo $THREE
";
        let all = docker(host);
        assert_eq!(all.len(), 1);
        lands(&all[0], host, "$ONE", 1, 9);
        lands(&all[0], host, "$TWO", 2, 10);
        lands(&all[0], host, "$THREE", 3, 10);
    }

    /// `# escape=` moves the continuation character. The snippet always uses
    /// `\`, because that is what the shell reads -- only the file changed.
    #[test]
    fn a_custom_escape_character_still_continues_the_run() {
        let host = "\
# escape=`
FROM debian:12
RUN echo $ONE `
  && echo $TWO
";
        let all = docker(host);
        assert_eq!(all.len(), 1);
        assert!(!all[0].script().contains('`'), "{:?}", all[0].script());
        lands(&all[0], host, "$ONE", 2, 9);
        lands(&all[0], host, "$TWO", 3, 10);
    }

    /// A comment inside a `RUN` is removed by Docker before the shell sees
    /// anything, so passing it through would let the `#` swallow the line
    /// after it.
    #[test]
    fn a_comment_inside_a_run_is_dropped_not_commented_out() {
        let host = "\
FROM debian:12
RUN echo $ONE \\
# a note
  && echo $TWO
";
        let all = docker(host);
        assert_eq!(all.len(), 1);
        assert!(!all[0].script().contains("a note"), "{:?}", all[0].script());
        lands(&all[0], host, "$ONE", 1, 9);
        lands(&all[0], host, "$TWO", 3, 10);
    }

    /// `RUN <<EOF` runs the body, so the body is the script -- the redirection
    /// and its closing delimiter are not part of it. Left in, shellcheck reports
    /// SC2188 on a redirection with no command and reads the body as data
    /// rather than as the code it is.
    #[test]
    fn a_bare_heredoc_body_is_the_whole_script() {
        let host = "\
FROM debian:12
RUN <<EOF
echo $ONE
echo $TWO
EOF
";
        let all = docker(host);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].script(), "echo $ONE\necho $TWO");
        lands(&all[0], host, "$ONE", 2, 5);
        lands(&all[0], host, "$TWO", 3, 5);
    }

    /// A heredoc fed to a command is ordinary shell, and the command is the
    /// line that reads it -- so the whole thing goes through, which is the one
    /// shape where the body may not be shell at all.
    #[test]
    fn a_heredoc_with_a_command_keeps_its_redirection() {
        let host = "\
FROM debian:12
RUN python3 - <<EOF
print($ONE)
EOF
";
        let all = docker(host);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].script(), "python3 - <<EOF\nprint($ONE)\nEOF");
        lands(&all[0], host, "$ONE", 2, 6);
    }

    /// `RUN --mount=...` gives the build a mount; the shell is handed the
    /// command after it. Left in, shellcheck reads the flag as the command
    /// name and reports SC2215 on every `RUN` that uses one.
    #[test]
    fn dockers_own_run_flags_never_reach_the_shell() {
        let host = "\
FROM debian:12
RUN --mount=type=cache,target=/root/.cache --network=none echo $ONE
RUN --mount=type=cache,target=/root/.cache \\
  echo $TWO
";
        let all = docker(host);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].script(), "echo $ONE");
        lands(&all[0], host, "$ONE", 1, 63);
        assert_eq!(all[1].script(), "echo $TWO");
        lands(&all[1], host, "$TWO", 3, 7);
    }

    /// Exec form is not shell: Docker execs the array, no shell is involved,
    /// and `$HOME` in it is five characters.
    #[test]
    fn exec_form_is_not_shell() {
        assert!(docker("FROM debian:12\nRUN [\"echo\", \"$HOME\"]\n").is_empty());
    }

    /// `SHELL` decides the dialect of every `RUN` after it, and a `FROM`
    /// starts a stage that never saw one.
    #[test]
    fn shell_selects_the_dialect_until_the_next_from() {
        let host = "\
FROM debian:12
RUN echo a
SHELL [\"/bin/bash\", \"-o\", \"pipefail\", \"-c\"]
RUN echo b
FROM debian:12
RUN echo c
";
        let shells: Vec<&str> = docker(host).iter().map(Snippet::shell).collect();
        assert_eq!(shells, ["sh", "bash", "sh"]);
    }

    /// A `SHELL` naming something shellcheck does not read silences the
    /// `RUN`s under it rather than having them read as bash.
    #[test]
    fn a_non_posix_shell_silences_the_runs_under_it() {
        let host = "\
FROM mcr.microsoft.com/windows/servercore:ltsc2022
SHELL [\"powershell\", \"-Command\"]
RUN Write-Host $A
FROM debian:12
RUN echo $B
";
        let all = docker(host);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].script(), "echo $B");
    }

    /// `ONBUILD RUN` runs in somebody else's build, against a base image this
    /// file does not describe -- the same reason `lint_dockerfile` skips it.
    #[test]
    fn onbuild_is_somebody_elses_build() {
        assert!(docker("FROM debian:12\nONBUILD RUN echo $A\n").is_empty());
    }

    // ── the map itself ─────────────────────────────────────────────────────

    /// An end that maps onto another line of the file is clamped to one
    /// character, the same clamp poly's own rules apply: a squiggle over the
    /// rest of the file is not a position.
    #[test]
    fn an_end_on_another_line_is_clamped() {
        let host = "jobs:\n  j:\n    steps:\n      - run: >\n          echo $A\n          $B\n";
        let snippet = one(host);
        assert_eq!(snippet.script(), "echo $A $B\n");
        // A finding covering `$A $B` starts on file line 4 and ends on line 5.
        let mut issue = finding(0, 5, 5);
        snippet.relocate(host, &mut issue);
        assert_eq!((issue.line, issue.col), (4, 15));
        assert_eq!((issue.end_line, issue.end_col), (4, 16));
    }

    /// An end inside the same segment is kept, because it is a real span.
    #[test]
    fn an_end_on_the_same_line_is_kept() {
        let host = "jobs:\n  j:\n    steps:\n      - run: |\n          echo $ABC\n";
        let snippet = one(host);
        let mut issue = finding(0, 5, 4);
        snippet.relocate(host, &mut issue);
        assert_eq!((issue.line, issue.col), (4, 15));
        assert_eq!((issue.end_line, issue.end_col), (4, 19));
    }

    /// A position past the end of the script still lands somewhere in the
    /// file: shellcheck reports an unterminated quote at the end of input, and
    /// that is a finding worth keeping.
    #[test]
    fn a_position_past_the_script_lands_in_the_file() {
        let host = "jobs:\n  j:\n    steps:\n      - run: |\n          echo \"$A\n";
        let snippet = one(host);
        let mut issue = finding(9, 9, 1);
        snippet.relocate(host, &mut issue);
        assert_eq!(issue.line, 4);
    }

    /// Only the position changes. Everything else is shellcheck's answer.
    #[test]
    fn relocating_touches_nothing_but_the_position() {
        let host = "jobs:\n  j:\n    steps:\n      - run: echo $A\n";
        let snippet = one(host);
        let mut issue = finding(0, 5, 2);
        issue.url = Some("https://www.shellcheck.net/wiki/SC2086".to_string());
        snippet.relocate(host, &mut issue);
        assert_eq!(issue.source, "shellcheck");
        assert_eq!(issue.code, "SC2086");
        assert_eq!(
            issue.url.as_deref(),
            Some("https://www.shellcheck.net/wiki/SC2086")
        );
    }

    /// A workflow turns off more than a Dockerfile does, and only where the
    /// reason differs: a `${{ }}` stand-in makes an expression look constant,
    /// and GitHub's own `bash -e` makes a bare `cd` fatal already. In a
    /// Dockerfile neither is true, so both stay on.
    #[test]
    fn each_host_turns_off_what_it_alone_makes_unanswerable() {
        let workflow_shell = one("jobs:\n  j:\n    steps:\n      - run: echo $A\n");
        let docker_shell = &docker("FROM debian:12\nRUN echo $A\n")[0];
        for code in ["SC1090", "SC1091", "SC2153", "SC2154"] {
            assert!(workflow_shell.excluded().contains(&code), "{code}");
            assert!(docker_shell.excluded().contains(&code), "{code}");
        }
        for code in ["SC2050", "SC2157", "SC2194", "SC2164", "SC2103"] {
            assert!(workflow_shell.excluded().contains(&code), "{code}");
            assert!(!docker_shell.excluded().contains(&code), "{code}");
        }
        // Nothing about the finding poly is here to keep is turned off.
        assert!(!workflow_shell.excluded().contains(&"SC2086"));
    }

    #[test]
    fn a_language_with_no_embedded_shell_is_silent() {
        assert!(embedded("rust", &PathBuf::from("a.rs"), "fn main() {}").is_empty());
        assert!(embedded("shellscript", &PathBuf::from("a.sh"), "echo $A").is_empty());
    }
}

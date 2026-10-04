//! `poly git`: the questions Git History asks a repository, answered without
//! git installed.
//!
//! Git History talks to git as a command line -- arguments in, text out -- and
//! parses what comes back. Where the editor finds no git, it runs this instead
//! with the same arguments, so the parsing it does is the one it always does
//! and there is no second reader to drift. Only the argument lists Git History
//! actually sends are understood, each spelled exactly; anything else is an
//! error rather than a guess, so a new question asked on the editor side fails
//! the differential check (tools/git-embed-check.js) instead of being answered
//! with something plausible.
//!
//! Reads only. Everything that changes a repository still goes through git:
//! hooks, commit signing and credential helpers belong to the user's git, and
//! a library that skips them changes the repository differently from the way
//! the user's own git would.
//!
//! Written from git's documentation and its observable output, not its source:
//! git is GPL-2.0-only and poly is MIT. Where git's answer is itself a
//! heuristic, gix's stands in for it: how a large rewrite's lines split into
//! added and deleted (the net is exact), and which renames are found among
//! similar files -- one near the 50% threshold, or one of several near copies.
//! Also not followed: reftable repositories, textconv drivers, and commit
//! messages in an encoding other than UTF-8, which are shown as stored.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap, HashMap};
use std::io::Write;
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use gix::bstr::{BStr, BString, ByteSlice, ByteVec};
use gix::object::tree::EntryKind;
use gix::ObjectId;

/// Runs one `poly git ...` invocation and returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    // Accepted and ignored: gix takes no lock to read, which is what the flag
    // asks of git.
    let args: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|arg| *arg != "--no-optional-locks")
        .collect();
    match answer(&args) {
        Ok(Some(out)) => {
            let mut stdout = std::io::stdout().lock();
            if stdout
                .write_all(&out)
                .and_then(|()| stdout.flush())
                .is_err()
            {
                return 128;
            }
            0
        }
        // git's quiet "no such thing": `rev-parse --verify -q` on an unborn
        // branch, `symbolic-ref -q` on a detached HEAD, an unset config key.
        Ok(None) => 1,
        Err(error) => {
            eprintln!("fatal: {error:#}");
            128
        }
    }
}

fn answer(args: &[&str]) -> Result<Option<Vec<u8>>> {
    let cwd = std::env::current_dir()?;
    let mut repo =
        gix::discover(&cwd).with_context(|| format!("not a git repository: {}", cwd.display()))?;
    repo.object_cache_size_if_unset(64 << 20);
    match args {
        ["rev-parse", "--verify", "-q", spec] => Ok(repo
            .rev_parse_single(*spec)
            .ok()
            .map(|id| format!("{id}\n").into_bytes())),
        ["symbolic-ref", "--short", "-q", "HEAD"] => Ok(repo
            .head_name()?
            .map(|name| [name.shorten().as_bytes(), b"\n"].concat())),
        ["remote"] => Ok(Some(
            repo.remote_names()
                .iter()
                .flat_map(|name| [name.as_bytes(), b"\n"].concat())
                .collect(),
        )),
        ["config", "--get", key] => Ok(repo
            .config_snapshot()
            .string(*key)
            .map(|value| [value.as_slice(), b"\n"].concat())),
        ["config", "--get-regexp", r"^remote\..*\.(url|pushurl)$"] => remote_urls(&repo),
        ["for-each-ref", rest @ ..] => for_each_ref(&repo, rest).map(Some),
        ["log", rest @ ..] => log(&repo, rest).map(Some),
        ["stash", "list", format] => stash_list(&repo, format).map(Some),
        ["status", rest @ ..] => status(&repo, rest).map(Some),
        ["diff-tree", rest @ ..] => diff(repo, rest, true).map(Some),
        ["diff", rest @ ..] => diff(repo, rest, false).map(Some),
        ["show", "-s", format, rev] => {
            let format = format
                .strip_prefix("--format=")
                .ok_or_else(|| unsupported(args))?;
            let commit = repo.rev_parse_single(*rev)?.object()?.peel_to_commit()?;
            let mut out = expand_commit(&Format::parse(format)?, &commit, None)?;
            out.push(b'\n');
            Ok(Some(out))
        }
        // A file as it is in a revision, for the poly-git: diff sides.
        ["show", spec] if spec.contains(':') => {
            let object = repo.rev_parse_single(*spec)?.object()?;
            if object.kind != gix::object::Kind::Blob {
                bail!("{spec} is not a file");
            }
            Ok(Some(object.detach().data))
        }
        _ => Err(unsupported(args)),
    }
}

fn unsupported(args: &[&str]) -> anyhow::Error {
    anyhow!(
        "poly git does not answer `git {}`; Git History asked something new",
        args.join(" ")
    )
}

/// `remote.<name>.url` and `.pushurl`, as `git config --get-regexp` lists them.
fn remote_urls(repo: &gix::Repository) -> Result<Option<Vec<u8>>> {
    let config = repo.config_snapshot();
    let mut out = Vec::new();
    for section in config
        .plumbing()
        .sections_by_name("remote")
        .into_iter()
        .flatten()
    {
        let Some(name) = section.header().subsection_name() else {
            continue;
        };
        for key in ["url", "pushurl"] {
            for value in section.values(key) {
                out.extend_from_slice(b"remote.");
                out.extend_from_slice(name);
                out.extend_from_slice(format!(".{key} ").as_bytes());
                out.extend_from_slice(&value);
                out.push(b'\n');
            }
        }
    }
    Ok((!out.is_empty()).then_some(out))
}

// ------------------------------------------------------------------ formats

/// A `--format=` string cut into literal text and placeholders, so each
/// commit or ref is expanded without parsing the format again.
struct Format(Vec<Piece>);

enum Piece {
    Text(String),
    Field(String),
}

impl Format {
    /// `%H`-style placeholders for commits (`%gd` included), `%(atom)` for refs.
    fn parse(format: &str) -> Result<Format> {
        let mut pieces = Vec::new();
        let mut text = String::new();
        let mut rest = format;
        while let Some(at) = rest.find('%') {
            text.push_str(&rest[..at]);
            rest = &rest[at + 1..];
            let field = if let Some(atom) = rest.strip_prefix('(') {
                let end = atom
                    .find(')')
                    .ok_or_else(|| anyhow!("unclosed %( in {format:?}"))?;
                rest = &atom[end + 1..];
                format!("({})", &atom[..end])
            } else if rest.starts_with('%') {
                rest = &rest[1..];
                text.push('%');
                continue;
            } else {
                let len = ["an", "ae", "at", "cn", "ce", "ct", "gd"]
                    .iter()
                    .find(|two| rest.starts_with(**two))
                    .map_or(1, |_| 2);
                let len = len.min(rest.len());
                let field = rest[..len].to_string();
                rest = &rest[len..];
                field
            };
            if !text.is_empty() {
                pieces.push(Piece::Text(std::mem::take(&mut text)));
            }
            pieces.push(Piece::Field(field));
        }
        text.push_str(rest);
        if !text.is_empty() {
            pieces.push(Piece::Text(text));
        }
        Ok(Format(pieces))
    }
}

/// The subject as `%s` prints it: the message's first paragraph, its lines
/// joined with single spaces.
fn subject(message: &BStr) -> BString {
    let mut lines = message
        .lines()
        .map(|line| line.trim_end())
        .skip_while(|line| line.is_empty());
    let mut out = BString::default();
    for line in lines.by_ref() {
        if line.is_empty() {
            break;
        }
        if !out.is_empty() {
            out.push(b' ');
        }
        out.push_str(line);
    }
    out
}

/// One commit through a `log`/`show`/`stash list` format. `selector` is the
/// `%gd` of a stash entry.
fn expand_commit(
    format: &Format,
    commit: &gix::Commit<'_>,
    selector: Option<&str>,
) -> Result<Vec<u8>> {
    let decoded = commit.decode()?;
    let author = decoded.author()?;
    let committer = decoded.committer()?;
    let mut out = Vec::new();
    for piece in &format.0 {
        match piece {
            Piece::Text(text) => out.extend_from_slice(text.as_bytes()),
            Piece::Field(field) => match field.as_str() {
                "H" => out.extend_from_slice(commit.id.to_string().as_bytes()),
                // A shallow clone's boundary commits show none: their
                // parents were never fetched.
                "P" if commit
                    .repo
                    .shallow_commits()?
                    .is_some_and(|ids| ids.contains(&commit.id)) => {}
                "P" => {
                    let parents: Vec<String> = decoded.parents().map(|id| id.to_string()).collect();
                    out.extend_from_slice(parents.join(" ").as_bytes());
                }
                "an" => out.extend_from_slice(author.name),
                "ae" => out.extend_from_slice(author.email),
                "at" => out.extend_from_slice(author.seconds().to_string().as_bytes()),
                "cn" => out.extend_from_slice(committer.name),
                "ce" => out.extend_from_slice(committer.email),
                "ct" => out.extend_from_slice(committer.seconds().to_string().as_bytes()),
                "s" => out.extend_from_slice(&subject(decoded.message)),
                "B" => out.extend_from_slice(decoded.message),
                "gd" => out.extend_from_slice(selector.unwrap_or_default().as_bytes()),
                other => bail!("poly git does not expand %{other}"),
            },
        }
    }
    Ok(out)
}

// ------------------------------------------------------------- for-each-ref

struct Ref {
    name: BString,
    id: ObjectId,
}

fn for_each_ref(repo: &gix::Repository, args: &[&str]) -> Result<Vec<u8>> {
    let mut format = None;
    let mut by_date = false;
    let mut patterns = Vec::new();
    for arg in args {
        if let Some(value) = arg.strip_prefix("--format=") {
            format = Some(Format::parse(value)?);
        } else if *arg == "--sort=-committerdate" {
            by_date = true;
        } else if arg.starts_with('-') {
            bail!("poly git for-each-ref does not take {arg}");
        } else {
            patterns.push(*arg);
        }
    }
    let format = format.context("poly git for-each-ref needs --format")?;
    let mut refs = Vec::new();
    for reference in repo.references()?.all()? {
        let mut reference = reference.map_err(|error| anyhow!("{error}"))?;
        let name = reference.name().as_bstr().to_owned();
        let matches = patterns.is_empty()
            || patterns.iter().any(|pattern| {
                name == pattern.as_bytes()
                    || name.starts_with(pattern.as_bytes())
                        && name.get(pattern.len()) == Some(&b'/')
            });
        if !matches {
            continue;
        }
        // A symbolic ref (refs/remotes/origin/HEAD) lists as what it points at.
        let Ok(id) = reference.follow_to_object() else {
            continue;
        };
        refs.push(Ref {
            name,
            id: id.detach(),
        });
    }
    refs.sort_by(|a, b| a.name.cmp(&b.name));
    if by_date {
        let date = |id: ObjectId| {
            repo.find_commit(id)
                .ok()
                .and_then(|commit| commit.time().ok())
                .map_or(0, |time| time.seconds)
        };
        let dates: HashMap<ObjectId, i64> = refs.iter().map(|r| (r.id, date(r.id))).collect();
        // Stable, so equal dates keep the name order they were sorted into.
        refs.sort_by_key(|r| Reverse(dates[&r.id]));
    }
    let mut out = Vec::new();
    for r in &refs {
        expand_ref(&mut out, repo, &format, r)?;
        out.push(b'\n');
    }
    Ok(out)
}

fn expand_ref(out: &mut Vec<u8>, repo: &gix::Repository, format: &Format, r: &Ref) -> Result<()> {
    let object = repo.find_object(r.id)?;
    let tag = (object.kind == gix::object::Kind::Tag).then(|| object.clone().into_tag());
    let decoded = tag.as_ref().map(|tag| tag.decode()).transpose()?;
    let tagger = decoded.as_ref().and_then(|tag| tag.tagger().ok().flatten());
    for piece in &format.0 {
        match piece {
            Piece::Text(text) => out.extend_from_slice(text.as_bytes()),
            Piece::Field(field) => match field.as_str() {
                "(objectname)" => out.extend_from_slice(r.id.to_string().as_bytes()),
                // What an annotated tag points at; nothing for anything else.
                "(*objectname)" => {
                    if let Some(tag) = &decoded {
                        out.extend_from_slice(tag.target().to_string().as_bytes());
                    }
                }
                "(refname)" => out.extend_from_slice(&r.name),
                "(taggername)" => out.extend_from_slice(tagger.map(|t| t.name).unwrap_or_default()),
                "(taggeremail)" => {
                    if let Some(tagger) = tagger {
                        out.push(b'<');
                        out.extend_from_slice(tagger.email);
                        out.push(b'>');
                    }
                }
                "(taggerdate:unix)" => {
                    if let Some(tagger) = tagger {
                        out.extend_from_slice(tagger.seconds().to_string().as_bytes());
                    }
                }
                // The whole message, a tag's signature included, as stored:
                // everything after the headers' blank line. (Continuation
                // lines of a commit's signature header start with a space,
                // so the first blank line is the end of the headers.)
                "(contents)" => {
                    if matches!(
                        object.kind,
                        gix::object::Kind::Tag | gix::object::Kind::Commit
                    ) {
                        if let Some(at) = object.data.find(b"\n\n") {
                            out.extend_from_slice(&object.data[at + 2..]);
                        }
                    }
                }
                other => bail!("poly git does not expand %{other}"),
            },
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------- log

#[derive(Clone, Copy)]
enum Order {
    Date,
    AuthorDate,
    Topo,
}

fn log(repo: &gix::Repository, args: &[&str]) -> Result<Vec<u8>> {
    let mut max = usize::MAX;
    let mut format = None;
    let mut nul = false;
    let mut order = Order::Date;
    let mut first_parent = false;
    let mut tips: Vec<ObjectId> = Vec::new();
    let add = |id: ObjectId, tips: &mut Vec<ObjectId>| {
        if !tips.contains(&id) {
            tips.push(id);
        }
    };
    for arg in args {
        match *arg {
            "-z" => nul = true,
            "--date-order" => order = Order::Date,
            "--author-date-order" => order = Order::AuthorDate,
            "--topo-order" => order = Order::Topo,
            "--first-parent" => first_parent = true,
            "--" => break,
            "--branches" | "--tags" | "--remotes" => {
                let prefix = match *arg {
                    "--branches" => "refs/heads/",
                    "--tags" => "refs/tags/",
                    _ => "refs/remotes/",
                };
                let mut found: Vec<(BString, ObjectId)> = Vec::new();
                for reference in repo.references()?.prefixed(prefix)? {
                    let reference = reference.map_err(|error| anyhow!("{error}"))?;
                    let name = reference.name().as_bstr().to_owned();
                    let Ok(id) = reference.into_fully_peeled_id() else {
                        continue;
                    };
                    // Tags of trees and blobs are not history; git skips them too.
                    if id.object()?.kind == gix::object::Kind::Commit {
                        found.push((name, id.detach()));
                    }
                }
                found.sort();
                for (_, id) in found {
                    add(id, &mut tips);
                }
            }
            other => {
                if let Some(value) = other.strip_prefix("--max-count=") {
                    max = value.parse()?;
                } else if let Some(value) = other.strip_prefix("--format=") {
                    format = Some(Format::parse(value)?);
                } else if other.starts_with('-') {
                    bail!("poly git log does not take {other}");
                } else {
                    let id = repo.rev_parse_single(other)?.object()?.peel_to_commit()?.id;
                    add(id, &mut tips);
                }
            }
        }
    }
    let format = format.context("poly git log needs --format")?;
    let mut out = Vec::new();
    for id in ordered(repo, &tips, order, first_parent, max)? {
        out.extend(expand_commit(&format, &repo.find_commit(id)?, None)?);
        out.push(if nul { b'\0' } else { b'\n' });
    }
    Ok(out)
}

/// The commits reachable from `tips`, none before all of its children, in one
/// of `log`'s three orders: newest committer date first, newest author date
/// first, or (topo) one line of history at a time, the line most recently
/// reached first. Ties go to whichever commit became ready first.
///
/// ponytail: reads every reachable commit before the first is printed, as git
/// does without a commit-graph; generation numbers would let it stop at `max`.
fn ordered(
    repo: &gix::Repository,
    tips: &[ObjectId],
    order: Order,
    first_parent: bool,
    max: usize,
) -> Result<Vec<ObjectId>> {
    let shallow = repo.shallow_commits()?;
    let mut parents: HashMap<ObjectId, Vec<ObjectId>> = HashMap::new();
    let mut dates: HashMap<ObjectId, i64> = HashMap::new();
    let mut children: HashMap<ObjectId, usize> = HashMap::new();
    let mut pending: Vec<ObjectId> = tips.to_vec();
    while let Some(id) = pending.pop() {
        if parents.contains_key(&id) {
            continue;
        }
        let commit = repo.find_commit(id)?;
        let decoded = commit.decode()?;
        let own: Vec<ObjectId> = if shallow.as_ref().is_some_and(|ids| ids.contains(&id)) {
            Vec::new()
        } else {
            decoded.parents().collect()
        };
        let date = match order {
            Order::AuthorDate => decoded.author()?.seconds(),
            Order::Date | Order::Topo => decoded.committer()?.seconds(),
        };
        dates.insert(id, date);
        pending.extend(own.iter().take(if first_parent { 1 } else { usize::MAX }));
        parents.insert(id, own);
    }
    // Under --first-parent, git orders two ways depending on whether the
    // repository has a commit-graph. Without one, a listed branch tip that a
    // listed merge took in as a later parent waits for that merge; with one,
    // git's incremental walk follows first parents for this too.
    let edges = if first_parent && repo.commit_graph_if_enabled()?.is_some() {
        1
    } else {
        usize::MAX
    };
    for own in parents.values() {
        for parent in own
            .iter()
            .take(edges)
            .filter(|parent| parents.contains_key(*parent))
        {
            *children.entry(*parent).or_default() += 1;
        }
    }
    let mut ready: Vec<ObjectId> = tips
        .iter()
        .copied()
        .filter(|tip| children.get(tip).copied().unwrap_or(0) == 0)
        .collect();
    let mut out = Vec::new();
    // Shows `id` and returns the parents that were waiting only on it.
    let mut show = |id: ObjectId, out: &mut Vec<ObjectId>| {
        out.push(id);
        parents[&id]
            .iter()
            .take(edges)
            .copied()
            .filter(|parent| {
                children.get_mut(parent).is_some_and(|left| {
                    *left -= 1;
                    *left == 0
                })
            })
            .collect::<Vec<_>>()
    };
    if let Order::Topo = order {
        // Newest tip first, then depth first: the last parent made ready is
        // the next one shown, so a merged line is shown whole before the
        // history it was merged into resumes.
        ready.sort_by_key(|tip| Reverse(dates[tip]));
        ready.reverse();
        while out.len() < max {
            let Some(id) = ready.pop() else { break };
            ready.extend(show(id, &mut out));
        }
    } else {
        let mut queue = BinaryHeap::new();
        let mut reached = 0usize;
        let mut push = |queue: &mut BinaryHeap<_>, id: ObjectId| {
            queue.push((dates[&id], Reverse(reached), id));
            reached += 1;
        };
        for tip in ready {
            push(&mut queue, tip);
        }
        while out.len() < max {
            let Some((_, _, id)) = queue.pop() else { break };
            for parent in show(id, &mut out) {
                push(&mut queue, parent);
            }
        }
    }
    Ok(out)
}

fn stash_list(repo: &gix::Repository, format: &str) -> Result<Vec<u8>> {
    let format = Format::parse(
        format
            .strip_prefix("--format=")
            .context("poly git stash list needs --format")?,
    )?;
    let mut out = Vec::new();
    let Ok(stash) = repo.find_reference("refs/stash") else {
        return Ok(out);
    };
    let mut log = stash.log_iter();
    let Some(entries) = log.rev()? else {
        return Ok(out);
    };
    for (index, entry) in entries.enumerate() {
        let entry = entry?;
        let commit = repo.find_commit(entry.new_oid)?;
        out.extend(expand_commit(
            &format,
            &commit,
            Some(&format!("stash@{{{index}}}")),
        )?);
        out.push(b'\n');
    }
    Ok(out)
}

// ------------------------------------------------------------------- status

/// `status --porcelain`: one `XY path` line per changed path, renames in the
/// index on one line, then the untracked files.
fn status(repo: &gix::Repository, args: &[&str]) -> Result<Vec<u8>> {
    let nul = match args {
        ["--porcelain", "--untracked-files=all"] => false,
        ["-z", "--porcelain", "--untracked-files=all"] => true,
        _ => bail!("poly git status does not take {}", args.join(" ")),
    };
    // Path -> (X, Y, the path it was renamed from).
    let mut tracked: BTreeMap<BString, (u8, u8, Option<BString>)> = BTreeMap::new();
    let mut untracked: Vec<BString> = Vec::new();
    let items = repo
        .status(gix::progress::Discard)?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .index_worktree_rewrites(None)
        .into_iter(None)?;
    for item in items {
        match item? {
            gix::status::Item::TreeIndex(change) => {
                use gix::diff::index::Change;
                let (path, code, from) = match &change {
                    Change::Addition { location, .. } => (location.as_ref().to_owned(), b'A', None),
                    Change::Deletion { location, .. } => (location.as_ref().to_owned(), b'D', None),
                    Change::Modification { location, .. } => {
                        (location.as_ref().to_owned(), b'M', None)
                    }
                    Change::Rewrite {
                        source_location,
                        location,
                        copy,
                        ..
                    } => (
                        location.as_ref().to_owned(),
                        if *copy { b'C' } else { b'R' },
                        Some(source_location.as_ref().to_owned()),
                    ),
                };
                let entry = tracked.entry(path).or_insert((b' ', b' ', None));
                entry.0 = code;
                entry.2 = from;
            }
            gix::status::Item::IndexWorktree(item) => {
                use gix::status::index_worktree::Item;
                use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};
                match item {
                    Item::Modification {
                        rela_path, status, ..
                    } => {
                        let code = match status {
                            EntryStatus::Change(Change::Removed) => b'D',
                            EntryStatus::Change(Change::Type { .. }) => b'T',
                            EntryStatus::Change(_) => b'M',
                            EntryStatus::Conflict { .. } => b'U',
                            EntryStatus::IntentToAdd => b'A',
                            EntryStatus::NeedsUpdate(_) => continue,
                        };
                        tracked.entry(rela_path).or_insert((b' ', b' ', None)).1 = code;
                    }
                    Item::DirectoryContents { entry, .. } => {
                        if entry.status == gix::dir::entry::Status::Untracked {
                            let mut path = entry.rela_path;
                            if entry.disk_kind == Some(gix::dir::entry::Kind::Repository) {
                                path.push(b'/');
                            }
                            untracked.push(path);
                        }
                    }
                    Item::Rewrite { .. } => {}
                }
            }
        }
    }
    let end = if nul { b'\0' } else { b'\n' };
    let mut out = Vec::new();
    for (path, (x, y, from)) in tracked {
        out.extend_from_slice(&[x, y, b' ']);
        match (from, nul) {
            // `new NUL old` with -z, `old -> new` without, as git spells them.
            (Some(from), true) => out.extend([&path[..], b"\0", &from].concat()),
            (Some(from), false) => out.extend([&from[..], b" -> ", &path].concat()),
            (None, _) => out.extend_from_slice(&path),
        }
        out.push(end);
    }
    untracked.sort();
    for path in untracked {
        out.extend_from_slice(b"?? ");
        out.extend_from_slice(&path);
        out.push(end);
    }
    Ok(out)
}

// --------------------------------------------------------------------- diff

/// `diff-tree` between two commits (or from nothing with `--root`), and `diff`
/// from a commit to another or to the working tree: as `--name-status` or as
/// `--numstat`, renames found, type changes and copies left out.
fn diff(repo: gix::Repository, args: &[&str], tree_only: bool) -> Result<Vec<u8>> {
    let mut numstat = None;
    let mut root = false;
    let mut revs = Vec::new();
    for arg in args {
        match *arg {
            "-z" | "-M" | "-r" | "--diff-filter=AMDR" | "--no-commit-id" => {}
            "--name-status" => numstat = Some(false),
            "--numstat" => numstat = Some(true),
            "--root" if tree_only => root = true,
            other if other.starts_with('-') => bail!("poly git diff does not take {other}"),
            other => revs.push(other),
        }
    }
    // Asked for with exactly these flags every time; anything else is not a
    // question this answers.
    if !args.contains(&"-z") || !args.contains(&"-M") || !args.contains(&"--diff-filter=AMDR") {
        bail!("poly git diff answers only -z -M --diff-filter=AMDR");
    }
    let numstat = numstat.context("poly git diff needs --name-status or --numstat")?;
    // Writes stay in memory: the working tree's state is built as a tree here
    // so that it diffs the way two commits do, and none of it reaches disk.
    let repo = repo.with_object_memory();
    let tree_of = |rev: &str| -> Result<ObjectId> {
        Ok(repo.rev_parse_single(rev)?.object()?.peel_to_tree()?.id)
    };
    let (old, new) = match (root, revs.as_slice()) {
        (true, [rev]) => (ObjectId::empty_tree(repo.object_hash()), tree_of(rev)?),
        (false, [from, to]) => (tree_of(from)?, tree_of(to)?),
        (false, [from]) if !tree_only => (tree_of(from)?, worktree_tree(&repo)?),
        _ => bail!("poly git diff takes two revisions, or one and the working tree"),
    };
    let old = repo.find_tree(old)?;
    let new = repo.find_tree(new)?;
    let mut options = gix::diff::Options::default();
    // git's limit of 1000 bounds each side of the search; gix's bounds the
    // number of pairs. 630 files added beside 29 removed must still pair up.
    options
        .track_path()
        .track_rewrites(Some(gix::diff::Rewrites {
            limit: 1000 * 1000,
            ..Default::default()
        }));
    let changes = repo.diff_tree_to_tree(&old, &new, options)?;
    let mut cache = repo.diff_resource_cache_for_tree_diff()?;

    let mut entries: Vec<(BString, Vec<u8>)> = Vec::new();
    for change in changes {
        use gix::object::tree::diff::ChangeDetached as Change;
        // `score` is a rename's similarity as gix measures it, which is not
        // git's measure; Git History reads only the letter in front of it.
        let (code, path, from, old_side, new_side, score) = match &change {
            Change::Addition {
                location,
                entry_mode,
                id,
                ..
            } => (
                b'A',
                location.clone(),
                None,
                None,
                Some((*id, entry_mode.kind())),
                0,
            ),
            Change::Deletion {
                location,
                entry_mode,
                id,
                ..
            } => (
                b'D',
                location.clone(),
                None,
                Some((*id, entry_mode.kind())),
                None,
                0,
            ),
            Change::Modification {
                location,
                previous_entry_mode,
                previous_id,
                entry_mode,
                id,
            } => {
                // A file that became a link or a submodule is a type change,
                // which --diff-filter=AMDR leaves out.
                if previous_entry_mode.kind() != entry_mode.kind()
                    && !(blob(previous_entry_mode.kind()) && blob(entry_mode.kind()))
                {
                    continue;
                }
                (
                    b'M',
                    location.clone(),
                    None,
                    Some((*previous_id, previous_entry_mode.kind())),
                    Some((*id, entry_mode.kind())),
                    0,
                )
            }
            Change::Rewrite {
                source_location,
                source_entry_mode,
                source_id,
                diff,
                entry_mode,
                id,
                location,
                copy,
                ..
            } => {
                if *copy {
                    continue;
                }
                (
                    b'R',
                    location.clone(),
                    Some(source_location.clone()),
                    Some((*source_id, source_entry_mode.kind())),
                    Some((*id, entry_mode.kind())),
                    diff.map_or(100, |stats| (stats.similarity * 100.0).round() as u32),
                )
            }
        };
        let kind = new_side.or(old_side).map(|(_, kind)| kind);
        if kind == Some(EntryKind::Tree) {
            continue;
        }
        let mut line = Vec::new();
        if numstat {
            match line_counts(
                &repo,
                &mut cache,
                old_side,
                new_side,
                from.as_ref().unwrap_or(&path).as_ref(),
            )? {
                Some((added, deleted)) => line.extend(format!("{added}\t{deleted}\t").bytes()),
                None => line.extend_from_slice(b"-\t-\t"),
            }
            match &from {
                // A rename leaves the path empty and names both after it.
                Some(from) => {
                    line.push(b'\0');
                    line.extend_from_slice(from);
                    line.push(b'\0');
                    line.extend_from_slice(&path);
                }
                None => line.extend_from_slice(&path),
            }
        } else {
            line.push(code);
            if code == b'R' {
                line.extend(format!("{score:03}").bytes());
            }
            line.push(b'\0');
            if let Some(from) = &from {
                line.extend_from_slice(from);
                line.push(b'\0');
            }
            line.extend_from_slice(&path);
        }
        line.push(b'\0');
        entries.push((path, line));
    }
    // By path, renames by where they went, as git orders them.
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries.into_iter().flat_map(|(_, line)| line).collect())
}

/// A regular file, executable or not: the one change of mode that is still a
/// modification rather than a change of type.
fn blob(kind: EntryKind) -> bool {
    matches!(kind, EntryKind::Blob | EntryKind::BlobExecutable)
}

/// Lines added and deleted between two sides, or `None` where either is binary.
fn line_counts(
    repo: &gix::Repository,
    cache: &mut gix::diff::blob::Platform,
    old: Option<(ObjectId, EntryKind)>,
    new: Option<(ObjectId, EntryKind)>,
    path: &BStr,
) -> Result<Option<(u32, u32)>> {
    // A submodule's side is the line naming its commit.
    let commit =
        |side: Option<(ObjectId, EntryKind)>| side.map(|(_, kind)| kind == EntryKind::Commit);
    if commit(old) == Some(true) || commit(new) == Some(true) {
        return Ok(Some((u32::from(new.is_some()), u32::from(old.is_some()))));
    }
    let Some(diff) = blob_diff(repo, cache, old, new, path)? else {
        return Ok(None);
    };
    Ok(Some((diff.count_additions(), diff.count_removals())))
}

fn blob_diff(
    repo: &gix::Repository,
    cache: &mut gix::diff::blob::Platform,
    old: Option<(ObjectId, EntryKind)>,
    new: Option<(ObjectId, EntryKind)>,
    path: &BStr,
) -> Result<Option<gix::diff::blob::Diff>> {
    use gix::diff::blob::platform::prepare_diff::Operation;
    use gix::diff::blob::ResourceKind;
    let null = ObjectId::null(repo.object_hash());
    for (side, kind) in [
        (old, ResourceKind::OldOrSource),
        (new, ResourceKind::NewOrDestination),
    ] {
        let (id, mode) = side.unwrap_or((null, EntryKind::Blob));
        cache
            .set_resource(id, mode, path, kind, &repo.objects)
            .map_err(|error| anyhow!("{error:?}"))?;
    }
    let prepared = cache.prepare_diff().map_err(|error| anyhow!("{error:?}"))?;
    let Operation::InternalDiff { algorithm } = prepared.operation else {
        return Ok(None);
    };
    // Lines keep their terminators, as git compares them: a last line gaining
    // the newline it lacked is a line changed, not one left alone.
    let input = gix::diff::blob::InternedInput::new(
        prepared.old.intern_source(),
        prepared.new.intern_source(),
    );
    Ok(Some(gix::diff::blob::Diff::compute(algorithm, &input)))
}

/// The working tree as a tree object, kept in memory: each file the index
/// tracks, as it is on disk now, and none it does not. Diffing a commit's tree
/// against it is `git diff <commit>`.
fn worktree_tree(repo: &gix::Repository) -> Result<ObjectId> {
    let workdir = repo
        .workdir()
        .context("a bare repository has no working tree")?
        .to_owned();
    let index = repo.index_or_empty()?;
    // Which tracked files differ from the index on disk, cheaply: stat first,
    // content only where the stat says it may have changed.
    let mut changed: HashMap<BString, bool> = HashMap::new();
    let items = repo
        .status(gix::progress::Discard)?
        .untracked_files(gix::status::UntrackedFiles::None)
        .index_worktree_rewrites(None)
        .into_index_worktree_iter(None)?;
    for item in items {
        use gix::status::index_worktree::Item;
        use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};
        if let Item::Modification {
            rela_path, status, ..
        } = item?
        {
            match status {
                EntryStatus::Change(Change::Removed) => {
                    changed.insert(rela_path, false);
                }
                EntryStatus::NeedsUpdate(_) => {}
                _ => {
                    changed.insert(rela_path, true);
                }
            }
        }
    }
    let mut pipeline = repo.filter_pipeline(None)?.0;
    let mut editor = repo.edit_tree(ObjectId::empty_tree(repo.object_hash()))?;
    let mut seen = std::collections::HashSet::new();
    for entry in index.entries() {
        let path = entry.path(&index);
        // A conflicted file has up to three entries and one file on disk.
        if !seen.insert(path) {
            continue;
        }
        if entry.stage_raw() != 0 {
            changed.insert(path.to_owned(), true);
        }
        let (id, kind) = match changed.get(path) {
            Some(false) => continue,
            Some(true) => match on_disk(repo, &mut pipeline, &index, &workdir, path)? {
                Some(side) => side,
                None => continue,
            },
            None => (
                entry.id,
                entry
                    .mode
                    .to_tree_entry_mode()
                    .map_or(EntryKind::Blob, |mode| mode.kind()),
            ),
        };
        editor.upsert(path.to_str_lossy().as_ref(), kind, id)?;
    }
    Ok(editor.write()?.detach())
}

/// A tracked file as it is on disk, converted the way `git add` would store
/// it (line endings, clean filters), and written to the in-memory database.
fn on_disk(
    repo: &gix::Repository,
    pipeline: &mut gix::filter::Pipeline<'_>,
    index: &gix::index::State,
    workdir: &Path,
    path: &BStr,
) -> Result<Option<(ObjectId, EntryKind)>> {
    let file = workdir.join(gix::path::from_bstr(path));
    let Ok(meta) = std::fs::symlink_metadata(&file) else {
        return Ok(None);
    };
    if meta.is_dir() {
        // A submodule's checkout: what it has checked out is its commit.
        let Ok(sub) = gix::open(&file) else {
            return Ok(None);
        };
        return Ok(sub
            .head_id()
            .ok()
            .map(|id| (id.detach(), EntryKind::Commit)));
    }
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(&file)?;
        let id = repo
            .write_blob(gix::path::into_bstr(target).as_ref())?
            .detach();
        return Ok(Some((id, EntryKind::Link)));
    }
    let mut data = Vec::new();
    let mut converted = pipeline
        .convert_to_git(
            std::fs::File::open(&file)?,
            gix::path::from_bstr(path).as_ref(),
            index,
        )
        .map_err(|error| anyhow!("{error:?}"))?;
    std::io::Read::read_to_end(&mut converted, &mut data)?;
    let id = repo.write_blob(&data)?.detach();
    Ok(Some((
        id,
        if executable(&meta) {
            EntryKind::BlobExecutable
        } else {
            EntryKind::Blob
        },
    )))
}

#[cfg(unix)]
fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_meta: &std::fs::Metadata) -> bool {
    false
}

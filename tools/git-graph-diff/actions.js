// poly's Git Graph actions against mhutchie.git-graph's, each on its own copy
// of the fixture.
//
// Usage: node tools/git-graph-diff/actions.js
//
// Every action is run with the options Git Graph's dialogs open with, once
// through Git Graph's data layer and once through poly's, on two fresh copies
// of the same repository (and of its remote), with the clock stopped so the
// commits either side makes get the same hashes. Then the two repositories are
// compared: every ref, HEAD, the index, the working tree, the stashes, and the
// remote's refs. The git commands each side ran are printed alongside, which
// is how a difference is traced back to its cause.
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const LSP = path.join(ROOT, "extensions", "lsp");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "poly-git-graph-actions-"));
const FIXTURES = path.join(SCRATCH, "fixtures");

// The clock stops for both sides: commits made by a merge, a revert or a
// stash then hash the same when they are the same.
process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = "@1790000000 +0800";
process.env.GIT_CONFIG_GLOBAL = path.join(SCRATCH, "gitconfig");
fs.writeFileSync(
  process.env.GIT_CONFIG_GLOBAL,
  "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n[gc]\n\tauto = 0\n[pull]\n\trebase = false\n",
);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * A fresh copy of the fixture and its remote; `clean` drops its uncommitted
 * changes first. Always at the same path: a pull's merge commit names the
 * remote's path in its message, so two paths would be two different commits.
 */
function copy(clean) {
  const dir = path.join(SCRATCH, "work");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(FIXTURES, "graph"), path.join(dir, "graph"), { recursive: true });
  fs.cpSync(path.join(FIXTURES, "graph-origin.git"), path.join(dir, "graph-origin.git"), { recursive: true });
  const repo = path.join(dir, "graph");
  git(repo, "remote", "set-url", "origin", path.join(dir, "graph-origin.git"));
  if (clean) {
    git(repo, "reset", "-q", "--hard");
    git(repo, "clean", "-fdq");
  }
  return repo;
}

/**
 * Everything an action could have changed, in a form two copies can be
 * compared by. `byContent` names each commit by its tree, subject and author
 * rather than its hash, for an action that dates its commits "now" whatever
 * the environment says (`rebase --ignore-date`).
 */
function state(repo, byContent) {
  const origin = path.join(repo, "..", "graph-origin.git");
  const show = (cwd, ...args) => {
    try {
      return git(cwd, ...args).trim();
    } catch (error) {
      return `(${String(error.stderr).trim()})`;
    }
  };
  const name = (ref) =>
    byContent
      ? require("crypto").createHash("sha1").update(show(repo, "log", "--format=%T %ae %s", ref)).digest("hex")
      : show(repo, "rev-parse", ref);
  return {
    head: show(repo, "symbolic-ref", "-q", "HEAD") + " " + name("HEAD"),
    refs: show(repo, "for-each-ref", "--format=%(refname)").split("\n").map((ref) => `${ref} ${name(ref)}`),
    stashes: show(repo, "stash", "list", "--format=%gd %H %s").split("\n"),
    index: show(repo, "ls-files", "-s").split("\n"),
    status: show(repo, "status", "--porcelain", "--untracked-files=all").split("\n"),
    worktree: show(repo, "diff", "HEAD"),
    config: show(repo, "config", "--local", "--list").split("\n").filter((line) =>
      !line.startsWith("remote.origin.url=")
    ),
    origin: show(origin, "for-each-ref", "--format=%(refname) %(objectname)").split("\n"),
    files: fs.readdirSync(path.join(repo, "..")).filter((f) => !["graph", "graph-origin.git"].includes(f)),
  };
}

/** Git Graph's data layer with `git` replaced by a script that logs each command first. */
function theirs(log) {
  const wrapper = path.join(SCRATCH, "git-logged");
  fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "git $*" >> "$POLY_GIT_LOG"\nexec git "$@"\n`, { mode: 0o755 });
  process.env.POLY_GIT_LOG = log;
  const { load } = require("./oracle");
  const { source } = load();
  source.setGitExecutable({ path: wrapper, version: source.gitExecutable.version });
  return source;
}

function poly() {
  const out = path.join(SCRATCH, "gitGraphActions.cjs");
  execFileSync(path.join(LSP, "node_modules", ".bin", "esbuild"), [
    path.join(LSP, "src", "editor", "gitGraphActions.ts"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${out}`,
    "--log-level=warning",
  ]);
  return require(out);
}

/** The hash of the newest commit whose subject starts with `subject`. */
const at = (repo, subject) => git(repo, "rev-parse", `:/^${subject}`).trim();

// Each scenario: whether the tree starts clean, then the same action through
// Git Graph (with its dialogs' default options) and through poly.
const SCENARIOS = [
  [
    "checkout a local branch",
    true,
    (g, r) => g.checkoutBranch(r, "hotfix", null),
    (p, run) => p.checkoutBranch(run, "hotfix"),
  ],
  [
    "checkout a remote branch as a new local one",
    true,
    (g, r) => g.checkoutBranch(r, "remote-only", "origin/remote-only"),
    (p, run) => p.checkoutRemoteBranch(run, "origin/remote-only", "remote-only"),
  ],
  [
    "checkout a commit",
    true,
    (g, r) => g.checkoutCommit(r, at(r, "Rename login")),
    (p, run, r) => p.checkoutCommit(run, at(r, "Rename login")),
  ],
  [
    "create a branch",
    true,
    (g, r) => g.createBranch(r, "new-branch", at(r, "Add app"), false, false),
    (p, run, r) => p.createBranch(run, "new-branch", at(r, "Add app"), false),
  ],
  [
    "create a branch and check it out",
    true,
    (g, r) => g.createBranch(r, "new-branch", at(r, "Add app"), true, false),
    (p, run, r) => p.createBranch(run, "new-branch", at(r, "Add app"), true),
  ],
  [
    "delete a merged branch",
    true,
    (g, r) => g.deleteBranch(r, "oct-a", false),
    (p, run) => p.deleteBranch(run, "oct-a", false),
  ],
  [
    "delete an unmerged branch, forced",
    true,
    (g, r) => g.deleteBranch(r, "backdated", true),
    (p, run) => p.deleteBranch(run, "backdated", true),
  ],
  [
    "delete an unmerged branch, not forced",
    true,
    (g, r) => g.deleteBranch(r, "backdated", false),
    (p, run) => p.deleteBranch(run, "backdated", false),
  ],
  [
    "rename a branch",
    true,
    (g, r) => g.renameBranch(r, "hotfix", "hotfix-2"),
    (p, run) => p.renameBranch(run, "hotfix", "hotfix-2"),
  ],
  [
    "delete a remote branch",
    true,
    (g, r) => g.deleteRemoteBranch(r, "remote-only", "origin"),
    (p, run) => p.deleteRemoteBranch(run, "origin", "remote-only"),
  ],
  [
    "fetch a remote branch into a local one",
    true,
    (g, r) => g.fetchIntoLocalBranch(r, "origin", "remote-only", "hotfix", false),
    (p, run) => p.fetchIntoLocalBranch(run, "origin", "remote-only", "hotfix", false),
  ],
  [
    "fetch a remote branch into a local one, forced",
    true,
    (g, r) => g.fetchIntoLocalBranch(r, "origin", "remote-only", "hotfix", true),
    (p, run) => p.fetchIntoLocalBranch(run, "origin", "remote-only", "hotfix", true),
  ],
  [
    "pull a remote branch into the current one",
    true,
    (g, r) => g.pullBranch(r, "remote-only", "origin", false, false),
    (p, run) => p.pullBranch(run, "origin", "remote-only", "merge"),
  ],
  [
    "pull, squashed",
    true,
    (g, r) => g.pullBranch(r, "remote-only", "origin", false, true),
    (p, run) => p.pullBranch(run, "origin", "remote-only", "squash"),
  ],
  [
    "merge a branch",
    true,
    (g, r) => g.merge(r, "backdated", "Branch", true, false, false),
    (p, run) => p.merge(run, "backdated", "branch", "no-ff"),
  ],
  [
    "merge a branch, fast-forward allowed",
    true,
    (g, r) => g.merge(r, "backdated", "Branch", false, false, false),
    (p, run) => p.merge(run, "backdated", "branch", "ff"),
  ],
  [
    "merge a branch, squashed",
    true,
    (g, r) => g.merge(r, "backdated", "Branch", true, true, false),
    (p, run) => p.merge(run, "backdated", "branch", "squash"),
  ],
  [
    "merge a branch, not committed",
    true,
    (g, r) => g.merge(r, "backdated", "Branch", true, false, true),
    (p, run) => p.merge(run, "backdated", "branch", "no-commit"),
  ],
  [
    "merge a remote branch",
    true,
    (g, r) => g.merge(r, "origin/remote-only", "Remote Branch", true, false, false),
    (p, run) => p.merge(run, "origin/remote-only", "remote branch", "no-ff"),
  ],
  [
    "merge a commit, squashed",
    true,
    (g, r) => g.merge(r, at(r, "Backdated one"), "Commit", true, true, false),
    (p, run, r) => p.merge(run, at(r, "Backdated one"), "commit", "squash"),
  ],
  [
    "rebase on a branch",
    true,
    (g, r) => g.rebase(r, "backdated", "Branch", true, false),
    (p, run) => p.rebase(run, "backdated"),
    true,
  ],
  [
    "rebase on a commit",
    true,
    (g, r) => g.rebase(r, at(r, "Backdated one"), "Commit", true, false),
    (p, run, r) => p.rebase(run, at(r, "Backdated one")),
    true,
  ],
  [
    "cherry-pick a commit",
    true,
    (g, r) => g.cherrypickCommit(r, at(r, "Backdated one"), 0, false, false),
    (p, run, r) => p.cherryPick(run, at(r, "Backdated one"), 0, { recordOrigin: false, noCommit: false }),
  ],
  [
    "cherry-pick, recording the origin",
    true,
    (g, r) => g.cherrypickCommit(r, at(r, "Backdated one"), 0, true, false),
    (p, run, r) => p.cherryPick(run, at(r, "Backdated one"), 0, { recordOrigin: true, noCommit: false }),
  ],
  [
    "cherry-pick, not committed",
    true,
    (g, r) => g.cherrypickCommit(r, at(r, "Backdated one"), 0, false, true),
    (p, run, r) => p.cherryPick(run, at(r, "Backdated one"), 0, { recordOrigin: false, noCommit: true }),
  ],
  [
    "revert a commit",
    true,
    (g, r) => g.revertCommit(r, at(r, "Make app executable"), 0),
    (p, run, r) => p.revert(run, at(r, "Make app executable"), 0),
  ],
  [
    "revert a merge against its first parent",
    true,
    (g, r) => g.revertCommit(r, at(r, "Octopus merge"), 1),
    (p, run, r) => p.revert(run, at(r, "Octopus merge"), 1),
  ],
  [
    "drop a commit",
    true,
    (g, r) => g.dropCommit(r, at(r, "Empty commit")),
    (p, run, r) => p.drop(run, at(r, "Empty commit")),
  ],
  [
    "reset to a commit, mixed",
    true,
    (g, r) => g.resetToCommit(r, at(r, "Add binary"), "mixed"),
    (p, run, r) => p.reset(run, at(r, "Add binary"), "mixed"),
  ],
  [
    "reset to a commit, hard",
    true,
    (g, r) => g.resetToCommit(r, at(r, "Add binary"), "hard"),
    (p, run, r) => p.reset(run, at(r, "Add binary"), "hard"),
  ],
  [
    "add an annotated tag",
    true,
    (g, r) => g.addTag(r, "v2.0", at(r, "Add app"), 0, "Release 2.0", false),
    (p, run, r) => p.addTag(run, "v2.0", at(r, "Add app"), "Release 2.0"),
  ],
  [
    "add a lightweight tag",
    true,
    (g, r) => g.addTag(r, "v2.0", at(r, "Add app"), 1, "", false),
    (p, run, r) => p.addTag(run, "v2.0", at(r, "Add app"), undefined),
  ],
  ["delete a tag", true, (g, r) => g.deleteTag(r, "v1.0", null), (p, run) => p.deleteTag(run, "v1.0")],
  ["delete a tag on the remote too", true, async (g, r) => {
    await g.pushTag(r, "v1.1", "origin");
    return g.deleteTag(r, "v1.1", "origin");
  }, async (p, run) => {
    await p.pushTag(run, "origin", "v1.1");
    return p.deleteTag(run, "v1.1", "origin");
  }],
  ["push a tag", true, (g, r) => g.pushTag(r, "v1.1", "origin"), (p, run) => p.pushTag(run, "origin", "v1.1")],
  [
    "push a branch, setting its upstream",
    true,
    (g, r) => g.pushBranch(r, "hotfix", "origin", true, ""),
    (p, run) => p.pushBranch(run, "origin", "hotfix", { setUpstream: true, force: "" }),
  ],
  [
    "push a branch with force-with-lease",
    true,
    (g, r) => g.pushBranch(r, "main", "origin", true, "force-with-lease"),
    (p, run) => p.pushBranch(run, "origin", "main", { setUpstream: true, force: "force-with-lease" }),
  ],
  [
    "fetch from all remotes",
    true,
    (g, r) => g.fetch(r, null, false, false),
    (p, run) => p.fetch(run, undefined, { prune: false, pruneTags: false }),
  ],
  [
    "fetch one remote, pruning",
    true,
    (g, r) => g.fetch(r, "origin", true, true),
    (p, run) => p.fetch(run, "origin", { prune: true, pruneTags: true }),
  ],
  [
    "archive a branch",
    true,
    (g, r) => g.archive(r, "main", path.join(r, "..", "main.zip"), "zip"),
    (p, run, r) => p.archive(run, "main", path.join(r, "..", "main.zip"), "zip"),
  ],
  [
    "apply a stash",
    true,
    (g, r) => g.applyStash(r, "refs/stash@{1}", false),
    (p, run) => p.applyStash(run, "stash@{1}", false),
  ],
  [
    "apply a stash, reinstating its index",
    true,
    (g, r) => g.applyStash(r, "refs/stash@{0}", true),
    (p, run) => p.applyStash(run, "stash@{0}", true),
  ],
  [
    "pop a stash",
    true,
    (g, r) => g.popStash(r, "refs/stash@{1}", false),
    (p, run) => p.popStash(run, "stash@{1}", false),
  ],
  ["drop a stash", true, (g, r) => g.dropStash(r, "refs/stash@{0}"), (p, run) => p.dropStash(run, "stash@{0}")],
  [
    "branch from a stash",
    true,
    (g, r) => g.branchFromStash(r, "refs/stash@{1}", "from-stash"),
    (p, run) => p.branchFromStash(run, "stash@{1}", "from-stash"),
  ],
  [
    "stash uncommitted changes",
    false,
    (g, r) => g.pushStash(r, "Saved", true),
    (p, run) => p.pushStash(run, "Saved", true),
  ],
  [
    "stash uncommitted changes, tracked only",
    false,
    (g, r) => g.pushStash(r, "", false),
    (p, run) => p.pushStash(run, "", false),
  ],
  [
    "reset uncommitted changes, mixed",
    false,
    (g, r) => g.resetToCommit(r, "HEAD", "mixed"),
    (p, run) => p.reset(run, "HEAD", "mixed"),
  ],
  [
    "reset uncommitted changes, hard",
    false,
    (g, r) => g.resetToCommit(r, "HEAD", "hard"),
    (p, run) => p.reset(run, "HEAD", "hard"),
  ],
  [
    "clean untracked files and directories",
    false,
    (g, r) => g.cleanUntrackedFiles(r, true),
    (p, run) => p.cleanUntracked(run, true),
  ],
  [
    "clean untracked files only",
    false,
    (g, r) => g.cleanUntrackedFiles(r, false),
    (p, run) => p.cleanUntracked(run, false),
  ],
  [
    "add a remote",
    true,
    (g, r) => g.addRemote(r, "upstream", "https://example.com/u.git", null, false),
    (p, run) => p.addRemote(run, "upstream", "https://example.com/u.git", undefined),
  ],
  [
    "add a remote with a push URL",
    true,
    (g, r) => g.addRemote(r, "upstream", "https://example.com/u.git", "git@example.com:u.git", false),
    (p, run) => p.addRemote(run, "upstream", "https://example.com/u.git", "git@example.com:u.git"),
  ],
  [
    "rename a remote and change its URLs",
    true,
    (g, r) =>
      g.editRemote(
        r,
        "origin",
        "mirror",
        git(r, "remote", "get-url", "origin").trim(),
        "https://example.com/m.git",
        null,
        "git@example.com:m.git",
      ),
    (p, run, r) =>
      p.editRemote(run, { name: "origin", url: git(r, "remote", "get-url", "origin").trim() }, {
        name: "mirror",
        url: "https://example.com/m.git",
        pushUrl: "git@example.com:m.git",
      }),
  ],
  ["delete a remote", true, (g, r) => g.deleteRemote(r, "origin"), (p, run) => p.deleteRemote(run, "origin")],
  ["prune a remote", true, (g, r) => g.pruneRemote(r, "origin"), (p, run) => p.pruneRemote(run, "origin")],
];

(async () => {
  execFileSync("bash", [path.join(__dirname, "fixture.sh"), FIXTURES], { stdio: "ignore" });
  const log = path.join(SCRATCH, "git-graph.log");
  const source = theirs(log);
  let ours;
  try {
    ours = poly();
  } catch (error) {
    console.log(`poly's actions did not build; showing Git Graph's commands only\n${error.stderr ?? error}\n`);
  }
  const only = process.argv[2];
  let different = 0;
  let count = 0;
  // Git Graph answers null, or a list of them, when nothing went wrong.
  const errorOf = (result) => {
    const errors = (Array.isArray(result) ? result : [result]).filter((e) => e !== null && e !== undefined && e !== "");
    return errors.length > 0 ? errors.map(String).join("\n") : null;
  };
  for (const [name, clean, theirsAction, oursAction, byContent] of SCENARIOS) {
    if (only && !name.includes(only)) continue;
    count++;
    const a = copy(clean);
    fs.writeFileSync(log, "");
    const theirsError = errorOf(await theirsAction(source, a));
    const theirsCommands = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    if (!ours) {
      console.log(
        `${name}\n  git-graph: ${theirsCommands.join("\n             ")}${
          theirsError ? `\n  error: ${theirsError.split("\n")[0]}` : ""
        }`,
      );
      continue;
    }
    const sa = state(a, byContent);
    const b = copy(clean);
    const oursCommands = [];
    const runner = ours.gitIn("git", b);
    const run = (args) => {
      oursCommands.push(`git ${args.join(" ")}`);
      return runner(args);
    };
    const oursError = await oursAction(ours, run, b).then(() => null, (error) => String(error.message ?? error));
    const sb = state(b, byContent);
    const failed = (theirsError === null) !== (oursError === null);
    const diffs = Object.keys(sa).filter((key) => JSON.stringify(sa[key]) !== JSON.stringify(sb[key]));
    if (diffs.length === 0 && !failed) {
      console.log(`same       ${name}${theirsError ? "  (both refused)" : ""}`);
      continue;
    }
    different++;
    console.log(`DIFFERENT  ${name}`);
    if (failed) console.log(`  git-graph error: ${theirsError ?? "none"}\n  poly error:      ${oursError ?? "none"}`);
    for (const key of diffs) {
      console.log(`  ${key}:\n    poly      ${JSON.stringify(sb[key])}\n    git-graph ${JSON.stringify(sa[key])}`);
    }
    console.log(`  git-graph ran: ${theirsCommands.join(" ; ")}\n  poly ran:      ${oursCommands.join(" ; ")}`);
  }
  source.dispose();
  if (ours) {
    console.log(
      different === 0
        ? `\nall ${count} actions leave the same repository`
        : `\n${different} of ${count} actions differ`,
    );
  }
  process.exit(different === 0 ? 0 : 1);
})();

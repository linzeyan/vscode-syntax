/**
 * What mhutchie.git-graph 1.30.0 reads from git: the commits and the references
 * on them, stashes, uncommitted changes, and what a commit, a stash or a pair
 * of commits changed.
 *
 * Its behaviour is modelled on Git Graph's: tools/git-graph-diff runs this
 * and Git Graph's own data layer over the same repositories and reports every
 * difference, which is what "the same as Git Graph" means here.
 *
 * Kept apart from `vscode` so the unit tests and that comparison can load it.
 */
import { execFile } from "child_process";

import {
  type ChangeType,
  type CommitDetails,
  type FileChange,
  type Graph,
  type GraphCommit,
  type Remote,
  type TagDetails,
  UNCOMMITTED,
  type ViewOptions,
} from "./gitGraphProtocol";

/** Runs git in one repository and resolves with what it printed. */
export type Git = (args: string[]) => Promise<string>;

export class GitError extends Error {}

const F = "\x1f";

/** `lead` goes before git's own arguments: `["git"]` when poly answers in git's place. */
export function gitIn(executable: string, cwd: string, lead: string[] = []): Git {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        executable,
        // Reading must not take the index lock: a refresh racing the user's own
        // `git commit` would make theirs fail.
        [...lead, "--no-optional-locks", ...args],
        // Nothing can answer a credential prompt from here; failing at once
        // beats a fetch that hangs until the user gives up on it.
        { cwd, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        (error, stdout, stderr) => (error ? reject(new GitError(stderr.trim() || error.message)) : resolve(stdout)),
      );
    });
}

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

const ORDER: Record<ViewOptions["order"], string> = {
  date: "--date-order",
  "author-date": "--author-date-order",
  topo: "--topo-order",
};

interface Labels {
  heads: string[];
  tags: { name: string; annotated: boolean }[];
  remotes: { name: string; remote: string }[];
}

/** The remote a remote-tracking ref belongs to; remote names may themselves contain `/`. */
function remoteOf(name: string, remotes: string[]): string {
  const owner = remotes.filter((remote) => name.startsWith(`${remote}/`)).sort((a, b) => b.length - a.length)[0];
  return owner ?? name.slice(0, name.indexOf("/"));
}

async function labels(run: Git, remotes: string[]): Promise<Map<string, Labels>> {
  const out = await run([
    "for-each-ref",
    `--format=%(objectname)${F}%(*objectname)${F}%(refname)`,
    "refs/heads",
    "refs/tags",
    "refs/remotes",
  ]);
  const byCommit = new Map<string, Labels>();
  for (const line of lines(out)) {
    const [object, peeled, ref] = line.split(F);
    const hash = peeled || object;
    const entry = byCommit.get(hash) ?? { heads: [], tags: [], remotes: [] };
    byCommit.set(hash, entry);
    if (ref.startsWith("refs/heads/")) {
      entry.heads.push(ref.slice("refs/heads/".length));
    } else if (ref.startsWith("refs/tags/")) {
      entry.tags.push({ name: ref.slice("refs/tags/".length), annotated: peeled !== "" });
    } else {
      const name = ref.slice("refs/remotes/".length);
      entry.remotes.push({ name, remote: remoteOf(name, remotes) });
    }
  }
  return byCommit;
}

function parseCommit(record: string): GraphCommit {
  const [hash, parents, author, email, date, subject] = record.split(F);
  return {
    hash,
    parents: parents ? parents.split(" ") : [],
    author,
    email,
    date: Number(date),
    subject,
    heads: [],
    tags: [],
    remotes: [],
  };
}

/** The first `max` commits as Git Graph lists them, with stashes and uncommitted changes in their places. */
export async function loadGraph(run: Git, view: ViewOptions, max: number): Promise<Graph> {
  const [head, headBranch, remotes] = await Promise.all([
    run(["rev-parse", "--verify", "-q", "HEAD"]).then((out) => out.trim(), () => undefined),
    run(["symbolic-ref", "--short", "-q", "HEAD"]).then((out) => out.trim() || undefined, () => undefined),
    run(["remote"]).then(lines),
  ]);
  const branchRefs = view.showRemoteBranches ? ["refs/heads", "refs/remotes"] : ["refs/heads"];
  const [byCommit, branches] = await Promise.all([
    labels(run, remotes),
    run(["for-each-ref", "--sort=-committerdate", "--format=%(refname)", ...branchRefs]).then((out) =>
      lines(out).map((ref) =>
        ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref.slice("refs/".length)
      )
    ),
  ]);

  const revisions = view.branches.length > 0
    ? view.branches
    : [
      "--branches",
      ...view.showTags ? ["--tags"] : [],
      ...view.showRemoteBranches ? ["--remotes"] : [],
      ...head ? ["HEAD"] : [],
    ];
  const log = await run([
    "log",
    `--max-count=${max + 1}`,
    `--format=%H${F}%P${F}%an${F}%ae${F}%at${F}%s`,
    "-z",
    ORDER[view.order],
    ...view.firstParent ? ["--first-parent"] : [],
    ...revisions,
    "--",
  ]);
  const listed = log.split("\0").map((record) => record.replace(/^\n/, "")).filter((record) => record !== "");
  const commits = listed.slice(0, max).map(parseCommit);
  for (const commit of commits) {
    const found = byCommit.get(commit.hash);
    if (found) {
      commit.heads = found.heads;
      commit.tags = view.showTags ? found.tags : [];
      commit.remotes = view.showRemoteBranches ? found.remotes : [];
    }
  }

  if (view.showStashes) {
    // Each stash sits directly above the commit it was made on, newest first,
    // drawn as a branch off it; one whose base is not listed is not shown.
    const stashes = lines(await run(["stash", "list", `--format=%H${F}%P${F}%gd${F}%an${F}%ae${F}%at${F}%s`]));
    for (const stash of stashes.reverse()) {
      const [hash, parents, selector, author, email, date, subject] = stash.split(F);
      const [base, , untracked] = parents.split(" ");
      const at = commits.findIndex((commit) => commit.hash === base);
      if (at === -1) {
        continue;
      }
      commits.splice(at, 0, {
        hash,
        parents: [base],
        author,
        email,
        date: Number(date),
        subject,
        heads: [],
        tags: [],
        remotes: [],
        stash: { selector, base, ...untracked ? { untracked } : {} },
      });
    }
  }

  if (view.showUncommitted && head && commits.some((commit) => commit.hash === head)) {
    const count = lines(await run(["status", "--porcelain", "--untracked-files=all"])).length;
    if (count > 0) {
      commits.unshift({
        hash: UNCOMMITTED,
        parents: [head],
        author: "*",
        email: "",
        date: Math.round(Date.now() / 1000),
        subject: `Uncommitted Changes (${count})`,
        heads: [],
        tags: [],
        remotes: [],
      });
    }
  }

  // The checked-out branch heads the list whatever its date: it is the one
  // the branch filter is most often narrowed to.
  if (head && headBranch && branches.includes(headBranch)) {
    branches.splice(branches.indexOf(headBranch), 1);
    branches.unshift(headBranch);
  }

  return {
    commits,
    // An unborn branch is not reported: until it has a commit there is
    // nothing of it to show, and Git Graph does not report one either.
    ...head ? { head } : {},
    ...head && headBranch ? { headBranch } : {},
    branches,
    remotes,
    more: listed.length > max,
  };
}

/**
 * The files a diff touches, with their line counts. `args` is a `diff` or
 * `diff-tree` command without its output format.
 */
async function changedFiles(run: Git, args: string[]): Promise<FileChange[]> {
  const common = ["-z", "-M", "--diff-filter=AMDR"];
  const [status, numbers] = await Promise.all([
    run([args[0], ...common, "--name-status", ...args.slice(1)]),
    run([args[0], ...common, "--numstat", ...args.slice(1)]),
  ]);
  const counts = new Map<string, [number | null, number | null]>();
  const numberTokens = numbers.split("\0");
  for (let i = 0; i < numberTokens.length; i++) {
    const [added, deleted, path] = numberTokens[i].split("\t");
    if (deleted === undefined) {
      continue;
    }
    const count = (text: string) => (text === "-" ? null : Number(text));
    // A rename leaves the path empty and gives the old and new paths as the next two fields.
    const key = path === "" ? numberTokens[i += 2] : path;
    counts.set(key, [count(added), count(deleted.replace(/^\n/, ""))]);
  }
  const files: FileChange[] = [];
  const tokens = status.split("\0");
  for (let i = 0; i + 1 < tokens.length;) {
    const code = tokens[i].replace(/^\n/, "");
    const type = code[0] as ChangeType;
    const oldPath = tokens[i + 1];
    const newPath = type === "R" ? tokens[i + 2] : oldPath;
    i += type === "R" ? 3 : 2;
    const [additions, deletions] = counts.get(newPath) ?? [null, null];
    files.push({ oldPath, newPath, type, additions, deletions });
  }
  return files;
}

async function metadata(run: Git, hash: string): Promise<Omit<CommitDetails, "files">> {
  const out = await run(["show", "-s", `--format=%H${F}%P${F}%an${F}%ae${F}%at${F}%cn${F}%ce${F}%ct${F}%B`, hash]);
  const [full, parents, author, authorEmail, authorDate, committer, committerEmail, committerDate, ...body] = out.split(
    F,
  );
  return {
    hash: full,
    parents: parents ? parents.split(" ") : [],
    author,
    authorEmail,
    authorDate: Number(authorDate),
    committer,
    committerEmail,
    committerDate: Number(committerDate),
    body: body.join(F).trimEnd(),
  };
}

/** A commit and what it changed from its first parent, or from nothing for a root. */
export async function commitDetails(run: Git, hash: string): Promise<CommitDetails> {
  const details = await metadata(run, hash);
  const files = await changedFiles(
    run,
    details.parents.length > 0
      ? ["diff-tree", "-r", details.parents[0], details.hash]
      : ["diff-tree", "-r", "--root", "--no-commit-id", details.hash],
  );
  return { ...details, files };
}

/** A stash: what it changed from its base, then the untracked files it took. */
export async function stashDetails(run: Git, hash: string, base: string, untracked?: string): Promise<CommitDetails> {
  const details = await metadata(run, hash);
  const files = await changedFiles(run, ["diff-tree", "-r", base, hash]);
  if (untracked) {
    const taken = await changedFiles(run, ["diff-tree", "-r", "--root", "--no-commit-id", untracked]);
    files.push(...taken.map((file) => ({ ...file, type: "U" as const })));
  }
  return { ...details, files };
}

/** The working tree against HEAD, staged and not alike, then each untracked file. */
export async function uncommittedChanges(run: Git): Promise<FileChange[]> {
  const [files, status] = await Promise.all([
    changedFiles(run, ["diff", "HEAD"]),
    run(["status", "-z", "--porcelain", "--untracked-files=all"]),
  ]);
  for (const entry of status.split("\0")) {
    if (entry.startsWith("?? ")) {
      const path = entry.slice(3);
      files.push({ oldPath: path, newPath: path, type: "U", additions: null, deletions: null });
    }
  }
  return files;
}

/** What changed from one commit to another, or to the working tree (untracked files aside). */
export function comparison(run: Git, from: string, to: string): Promise<FileChange[]> {
  return changedFiles(run, ["diff", from, ...to === UNCOMMITTED ? [] : [to]]);
}

/** An annotated tag's tagger and message. */
export async function tagDetails(run: Git, name: string): Promise<TagDetails> {
  const out = await run([
    "for-each-ref",
    `--format=%(objectname)${F}%(taggername)${F}%(taggeremail)${F}%(taggerdate:unix)${F}%(contents)`,
    `refs/tags/${name}`,
  ]);
  const [hash, tagger, email, date, ...message] = out.split(F);
  return {
    hash,
    tagger,
    email: email.replace(/^<|>$/g, ""),
    date: Number(date),
    message: message.join(F).trimEnd(),
  };
}

export async function remotesOf(run: Git): Promise<Remote[]> {
  const out = await run(["config", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"]).catch(() => "");
  const found = new Map<string, Remote>();
  for (const line of lines(out)) {
    const space = line.indexOf(" ");
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    const dot = key.lastIndexOf(".");
    const name = key.slice("remote.".length, dot);
    const remote = found.get(name) ?? { name, url: "" };
    found.set(name, remote);
    if (key.slice(dot + 1) === "url") {
      remote.url = value;
    } else {
      remote.pushUrl = value;
    }
  }
  // By name, as `git remote` lists them, not in the order they were added.
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// poly's Git Graph against mhutchie.git-graph's, over the same repositories.
//
// Usage: node tools/git-graph-diff/run.js [repo...]
//
// With no arguments it builds the fixtures (fixture.sh) and compares those;
// any repositories named are compared too, read-only. Every view option the
// toolbar has is tried against the matching Git Graph setting, then every
// listed commit's details, each stash, the uncommitted changes, comparisons
// between commits and with the working tree, annotated tags and remotes.
// Exits 1 on the first repository with any difference, after printing all of
// that repository's differences.
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { load } = require("./oracle");

const ROOT = path.join(__dirname, "..", "..");
const LSP = path.join(ROOT, "extensions", "lsp");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "poly-git-graph-diff-"));

function poly() {
  const out = path.join(SCRATCH, "gitGraphData.cjs");
  execFileSync(
    path.join(LSP, "node_modules", ".bin", "esbuild"),
    [
      path.join(LSP, "src", "editor", "gitGraphData.ts"),
      "--bundle",
      "--platform=node",
      "--format=cjs",
      `--outfile=${out}`,
      "--log-level=warning",
    ],
  );
  return require(out);
}

const DEFAULT_VIEW = {
  branches: [],
  showRemoteBranches: true,
  showTags: true,
  showStashes: true,
  showUncommitted: true,
  firstParent: false,
  order: "date",
};

/** Views to try: Git Graph's defaults, then each option the toolbar changes. */
function views(repo) {
  const branches = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\n").filter(Boolean);
  return [
    ["defaults", DEFAULT_VIEW],
    ["no remote branches", { ...DEFAULT_VIEW, showRemoteBranches: false }],
    ["no tags", { ...DEFAULT_VIEW, showTags: false }],
    ["no stashes", { ...DEFAULT_VIEW, showStashes: false }],
    ["no uncommitted", { ...DEFAULT_VIEW, showUncommitted: false }],
    ["first parent", { ...DEFAULT_VIEW, firstParent: true }],
    ["topo order", { ...DEFAULT_VIEW, order: "topo" }],
    ["author-date order", { ...DEFAULT_VIEW, order: "author-date" }],
    ...branches.slice(0, 2).map((branch) => [`only ${branch}`, { ...DEFAULT_VIEW, branches: [branch] }]),
    ...branches.length > 2
      ? [[`only ${branches.slice(-2).join(" + ")}`, { ...DEFAULT_VIEW, branches: branches.slice(-2) }]]
      : [],
  ];
}

function normalCommit(commit) {
  return {
    hash: commit.hash,
    parents: commit.parents,
    author: commit.author,
    email: commit.email,
    // The uncommitted row is dated "now", which the two calls see differently.
    date: commit.hash === "*" ? 0 : commit.date,
    subject: commit.subject ?? commit.message,
    heads: commit.heads,
    tags: commit.tags,
    remotes: commit.remotes,
    stash: commit.stash
      ? {
        selector: commit.stash.selector.replace(/^refs\//, ""),
        base: commit.stash.base ?? commit.stash.baseHash,
        untracked: commit.stash.untracked ?? commit.stash.untrackedFilesHash ?? undefined,
      }
      : undefined,
  };
}

const normalFile = (file) => ({
  oldPath: file.oldPath ?? file.oldFilePath,
  newPath: file.newPath ?? file.newFilePath,
  type: file.type,
  additions: file.additions,
  deletions: file.deletions,
});

function normalDetails(details) {
  return {
    hash: details.hash,
    parents: details.parents,
    author: details.author,
    authorEmail: details.authorEmail,
    authorDate: details.authorDate,
    committer: details.committer,
    committerEmail: details.committerEmail,
    committerDate: details.committerDate,
    body: details.body,
    files: (details.files ?? details.fileChanges).map(normalFile),
  };
}

/** Every path at which `a` and `b` differ, as `path: a ≠ b`. */
function differences(a, b, at = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    const found = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) found.push(...differences(a[i], b[i], `${at}[${i}]`));
    return found;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const found = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      found.push(...differences(a[key], b[key], `${at}.${key}`));
    }
    return found;
  }
  return [`${at}: poly ${JSON.stringify(a)} ≠ git-graph ${JSON.stringify(b)}`];
}

async function compareRepo(repo, ours, theirs) {
  const git = ours.gitIn("git", repo);
  const run = (args) =>
    git(args).catch((error) => {
      throw new Error(`poly's git ${args.join(" ")} failed in ${repo}: ${error.message}`);
    });
  const report = [];
  const check = (what, a, b) => {
    const found = differences(a, b);
    report.push(
      found.length === 0
        ? `  same       ${what}`
        : `  DIFFERENT  ${what}\n${found.slice(0, 12).map((d) => `             ${d}`).join("\n")}${
          found.length > 12 ? `\n             … ${found.length - 12} more` : ""
        }`,
    );
    return found.length === 0;
  };
  let same = true;
  const max = 300;

  let listed = [];
  let stashes = [];
  for (const [name, view] of views(repo)) {
    const info = await theirs.getRepoInfo(repo, view.showRemoteBranches, view.showStashes, []);
    const commits = await theirs.getCommits(
      repo,
      view.branches.length > 0 ? view.branches : null,
      max,
      view.showTags,
      view.showRemoteBranches,
      false,
      view.firstParent,
      view.order,
      info.remotes,
      [],
      info.stashes,
    );
    const graph = await ours.loadGraph(run, view, max).catch((error) => ({ error: String(error) }));
    // Two of Git Graph's answers poly does not give, on purpose; each is
    // reported rather than silently passed:
    // - In a repository with no commits it reports `git log`'s "bad revision
    //   'HEAD'" as an error; there is simply nothing to list yet.
    // - With HEAD detached it lists `git branch`'s "(HEAD detached at …)" line,
    //   in the user's language, as a branch to filter by and as the current one.
    const realHeads = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
      cwd: repo,
      encoding: "utf8",
    })
      .split("\n").filter(Boolean);
    const detached = (name) => typeof name === "string" && !name.startsWith("remotes/") && !realHeads.includes(name);
    if (/bad revision 'HEAD'/.test(commits.error ?? "") && commits.commits.length === 0) {
      if (name === "defaults") {
        report.push("  on purpose no commits yet is an empty graph, not Git Graph's \"bad revision 'HEAD'\"");
      }
      commits.error = null;
    }
    if (detached(info.head)) {
      if (name === "defaults") {
        report.push(`  on purpose detached HEAD is no branch, not Git Graph's ${JSON.stringify(info.head)}`);
      }
      info.branches = info.branches.filter((branch) => !detached(branch));
      info.head = null;
    }
    const theirsGraph = {
      error: commits.error ?? info.error ?? undefined,
      commits: commits.commits.filter((c) => view.showUncommitted || c.hash !== "*").map(normalCommit),
      head: commits.head ?? undefined,
      headBranch: info.head ?? undefined,
      branches: info.branches,
      remotes: info.remotes,
      more: commits.moreCommitsAvailable,
    };
    const oursGraph = graph.error
      ? { error: graph.error }
      : {
        error: undefined,
        commits: graph.commits.map(normalCommit),
        head: graph.head,
        headBranch: graph.headBranch,
        branches: graph.branches,
        remotes: graph.remotes,
        more: graph.more,
      };
    same = check(`graph, ${name} (${theirsGraph.commits?.length ?? 0} commits)`, oursGraph, theirsGraph) && same;
    if (name === "defaults") {
      listed = graph.commits ?? [];
      stashes = info.stashes;
    }
  }

  const commits = listed.filter((c) => c.hash !== "*" && !c.stash);
  for (const commit of commits.slice(0, 80)) {
    const theirsDetails = await theirs.getCommitDetails(repo, commit.hash, commit.parents.length > 0);
    const oursDetails = await ours.commitDetails(run, commit.hash);
    same = check(
      `details ${commit.hash.slice(0, 8)} ${commit.subject}`,
      normalDetails(oursDetails),
      normalDetails(theirsDetails.commitDetails),
    ) && same;
  }
  for (const stash of stashes) {
    const theirsDetails = await theirs.getStashDetails(repo, stash.hash, stash);
    const oursDetails = await ours.stashDetails(run, stash.hash, stash.baseHash, stash.untrackedFilesHash ?? undefined);
    same = check(`stash ${stash.selector}`, normalDetails(oursDetails), normalDetails(theirsDetails.commitDetails))
      && same;
  }
  if (listed[0]?.hash === "*") {
    const theirsDetails = await theirs.getUncommittedDetails(repo);
    same = check(
      "uncommitted changes",
      (await ours.uncommittedChanges(run)).map(normalFile),
      theirsDetails.commitDetails.fileChanges.map(normalFile),
    ) && same;
  }
  const pairs = [];
  if (commits.length > 1) {
    pairs.push([commits[commits.length - 1].hash, commits[0].hash], [
      commits[Math.floor(commits.length / 2)].hash,
      commits[0].hash,
    ]);
  }
  if (commits.length > 0 && listed[0]?.hash === "*") pairs.push([commits[Math.min(3, commits.length - 1)].hash, "*"]);
  for (const [from, to] of pairs) {
    const theirsFiles = await theirs.getCommitComparison(repo, from, to === "*" ? "" : to);
    same = check(
      `compare ${from.slice(0, 8)}..${to.slice(0, 8)}`,
      (await ours.comparison(run, from, to)).map(normalFile),
      theirsFiles.fileChanges.map(normalFile),
    ) && same;
  }
  const annotated = [...new Set(listed.flatMap((c) => c.tags.filter((t) => t.annotated).map((t) => t.name)))];
  for (const tag of annotated) {
    const t = await theirs.getTagDetails(repo, tag);
    const o = await ours.tagDetails(run, tag);
    same = check(`tag ${tag}`, o, { hash: t.tagHash, tagger: t.name, email: t.email, date: t.date, message: t.message })
      && same;
  }
  const config = await theirs.getConfig(repo, (await theirs.getRepoInfo(repo, true, false, [])).remotes);
  same = check(
    "remotes",
    await ours.remotesOf(run),
    (config.config?.remotes ?? []).map((r) => ({
      name: r.name,
      url: r.url,
      ...r.pushUrl ? { pushUrl: r.pushUrl } : {},
    })),
  ) && same;
  return { same, report };
}

(async () => {
  const repos = process.argv.slice(2);
  if (repos.length === 0) {
    const fixtures = path.join(SCRATCH, "fixtures");
    execFileSync("bash", [path.join(__dirname, "fixture.sh"), fixtures], { stdio: "ignore" });
    repos.push(...["graph", "detached", "empty", "long"].map((name) => path.join(fixtures, name)));
  }
  const ours = poly();
  const { source, version } = load();
  console.log(`poly vs ${version}, git ${execFileSync("git", ["--version"], { encoding: "utf8" }).trim()}\n`);
  let failed = 0;
  for (const repo of repos) {
    const { same, report } = await compareRepo(path.resolve(repo), ours, source);
    console.log(`${same ? "SAME" : "DIFFERENT"}  ${repo}\n${report.join("\n")}\n`);
    if (!same) failed++;
  }
  source.dispose();
  console.log(
    failed === 0 ? `all ${repos.length} repositories match` : `${failed} of ${repos.length} repositories differ`,
  );
  process.exit(failed === 0 ? 0 : 1);
})();

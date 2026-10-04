// Git History read through `poly git` against the same read through git.
//
// Usage: node tools/git-embed-check.js [repo...]
//
// Where the editor finds no git, Git History hands the same argument lists to
// `poly git` (cli/crates/poly-cli/src/git.rs) and parses what comes back the
// same way. This holds the two to each other where it matters -- in what Git
// History ends up showing: every view option, every listed commit's details,
// the stashes, the uncommitted changes, comparisons, annotated tags, remotes
// and a file as it was in a revision. Byte-level differences that no view
// reads (a rename's similarity score) are left alone, and file lists that
// differ only in git's heuristics are reported as "near" (see filesAlike); any
// other difference is a failure.
//
// With no arguments it builds tools/git-graph-diff's fixtures, plus a shallow
// clone, and checks those and this checkout; any repositories named are
// checked too, read-only. POLY_BIN names the binary, as for the other tools.
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const LSP = path.join(ROOT, "extensions", "lsp");
const POLY = process.env.POLY_BIN ?? path.join(ROOT, "cli", "target", "release", "poly");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "poly-git-embed-"));

function data() {
  const out = path.join(SCRATCH, "gitGraphData.cjs");
  execFileSync(path.join(LSP, "node_modules", ".bin", "esbuild"), [
    path.join(LSP, "src", "editor", "gitGraphData.ts"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${out}`,
    "--log-level=warning",
  ]);
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

function views(git) {
  const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean);
  const remote = git(["for-each-ref", "--format=%(refname)", "refs/remotes"]).split("\n").filter(Boolean)
    .map((ref) => ref.slice("refs/".length));
  return [
    ["defaults", DEFAULT_VIEW],
    ["no remote branches", { ...DEFAULT_VIEW, showRemoteBranches: false }],
    ["no tags", { ...DEFAULT_VIEW, showTags: false }],
    ["no stashes", { ...DEFAULT_VIEW, showStashes: false }],
    ["no uncommitted", { ...DEFAULT_VIEW, showUncommitted: false }],
    ["first parent", { ...DEFAULT_VIEW, firstParent: true }],
    ["topo order", { ...DEFAULT_VIEW, order: "topo" }],
    ["author-date order", { ...DEFAULT_VIEW, order: "author-date" }],
    ["author-date, first parent", { ...DEFAULT_VIEW, order: "author-date", firstParent: true }],
    ...branches.slice(0, 2).map((branch) => [`only ${branch}`, { ...DEFAULT_VIEW, branches: [branch] }]),
    ...remote.slice(0, 1).map((branch) => [`only ${branch}`, { ...DEFAULT_VIEW, branches: [branch] }]),
  ];
}

/** The uncommitted row is dated "now", which two calls a moment apart see differently. */
const undate = (graph) =>
  graph.commits ? { ...graph, commits: graph.commits.map((c) => (c.hash === "*" ? { ...c, date: 0 } : c)) } : graph;

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
  return [`${at}: poly ${JSON.stringify(a)} ≠ git ${JSON.stringify(b)}`];
}

const isFiles = (list) => Array.isArray(list) && list.every((f) => f && typeof f === "object" && "newPath" in f);

/**
 * Two file lists that differ only where git's own answer is a heuristic: how a
 * large rewrite's lines split into added and deleted (xdiff's Myers and
 * imara-diff's each give up on the minimal diff, at different points; the net
 * is exact either way), and which renames are found among similar files (git
 * and gix measure similarity differently, so a pair near the 50% threshold, or
 * one of several near-identical files, can go either way). Every path must
 * still be listed on both sides, and anything not involved in a rename must
 * match, net count included.
 */
function filesAlike(ours, theirs) {
  const paths = (list) => [...new Set(list.flatMap((f) => [f.oldPath, f.newPath]))].sort().join("\0");
  if (paths(ours) !== paths(theirs)) return false;
  const key = (f) => `${f.type}\0${f.oldPath}\0${f.newPath}`;
  const net = (f) => (f.additions === null ? null : f.additions - f.deletions);
  const pairedElsewhere = (one, other) => {
    const byKey = new Map(other.map((f) => [key(f), f]));
    const renamedTo = new Set(other.filter((f) => f.type === "R").map((f) => f.newPath));
    const renamedFrom = new Set(other.filter((f) => f.type === "R").map((f) => f.oldPath));
    return one.every((f) => {
      const match = byKey.get(key(f));
      if (match) return net(match) === net(f);
      return f.type === "R" || (f.type === "A" && renamedTo.has(f.newPath))
        || (f.type === "D" && renamedFrom.has(f.oldPath));
    });
  };
  return pairedElsewhere(ours, theirs) && pairedElsewhere(theirs, ours);
}

/** What a call returned, or what it threw: a failure on one side only is a difference too. */
const settle = (promise) =>
  promise.then((value) => ({ value }), (error) => ({ error: String(error.message ?? error) }));

/** `tolerant`: real history, where git's heuristics meet cases the fixtures are built to avoid. */
async function checkRepo(repo, lib, tolerant) {
  const viaGit = lib.gitIn("git", repo);
  const viaPoly = lib.gitIn(POLY, repo, ["git"]);
  const plain = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const report = [];
  let same = true;
  const check = async (what, call, normal = (v) => v) => {
    const [ours, theirs] = await Promise.all([settle(call(viaPoly)), settle(call(viaGit))]);
    // Failing alike is agreement; the message itself is each tool's own.
    const found = ours.error !== undefined && theirs.error !== undefined
      ? []
      : differences(
        ours.error ?? normal(ours.value),
        theirs.error ?? normal(theirs.value),
      );
    const files = (value) => (isFiles(value) ? value : value?.files);
    const rest = (value) => (isFiles(value) ? [] : { ...value, files: [] });
    const near = tolerant && found.length > 0 && isFiles(files(ours.value)) && isFiles(files(theirs.value))
      && differences(rest(ours.value), rest(theirs.value)).length === 0
      && filesAlike(files(ours.value), files(theirs.value));
    const label = found.length === 0 ? "same     " : near ? "near     " : "DIFFERENT";
    report.push(
      `  ${label}  ${what}${found.slice(0, near ? 4 : 12).map((d) => `\n             ${d}`).join("")}${
        found.length > (near ? 4 : 12) ? `\n             … ${found.length - (near ? 4 : 12)} more` : ""
      }`,
    );
    same = same && (found.length === 0 || near);
    return theirs.value;
  };

  let listed = [];
  for (const [name, view] of views(plain)) {
    const graph = await check(`graph, ${name}`, (run) => lib.loadGraph(run, view, 300), undate);
    if (name === "defaults") listed = graph?.commits ?? [];
  }
  const commits = listed.filter((c) => c.hash !== "*" && !c.stash);
  for (const commit of commits.slice(0, 80)) {
    const details = await check(
      `details ${commit.hash.slice(0, 8)} ${commit.subject}`,
      (run) => lib.commitDetails(run, commit.hash),
    );
    // A file as it was, for the diff sides: the first one each commit touched.
    const file = details?.files.find((f) => f.type !== "D");
    if (file) {
      await check(
        `content ${commit.hash.slice(0, 8)}:${file.newPath}`,
        (run) => run(["show", `${commit.hash}:${file.newPath}`]),
      );
    }
  }
  for (const stash of listed.filter((c) => c.stash)) {
    await check(
      `stash ${stash.stash.selector}`,
      (run) => lib.stashDetails(run, stash.hash, stash.stash.base, stash.stash.untracked),
    );
  }
  if (listed[0]?.hash === "*") await check("uncommitted changes", (run) => lib.uncommittedChanges(run));
  const pairs = [];
  if (commits.length > 1) {
    pairs.push([commits[commits.length - 1].hash, commits[0].hash], [
      commits[Math.floor(commits.length / 2)].hash,
      commits[0].hash,
    ]);
  }
  if (commits.length > 0) pairs.push([commits[Math.min(3, commits.length - 1)].hash, "*"]);
  for (const [from, to] of pairs) {
    await check(`compare ${from.slice(0, 8)}..${to.slice(0, 8)}`, (run) => lib.comparison(run, from, to));
  }
  const annotated = [...new Set(listed.flatMap((c) => c.tags.filter((t) => t.annotated).map((t) => t.name)))];
  for (const tag of annotated) await check(`tag ${tag}`, (run) => lib.tagDetails(run, tag));
  await check("remotes", (run) => lib.remotesOf(run));
  await check("diff tool", (run) => run(["config", "--get", "diff.tool"]));
  return { same, report };
}

/**
 * tools/git-graph-diff's fixtures, each also with a commit-graph (git orders
 * --first-parent differently with one), and a shallow clone: what CI's
 * checkout is.
 */
function fixtures() {
  const root = path.join(SCRATCH, "fixtures");
  execFileSync("bash", [path.join(__dirname, "git-graph-diff", "fixture.sh"), root], { stdio: "ignore" });
  const repos = ["graph", "detached", "long"].map((name) => path.join(root, name));
  const graphed = repos.map((repo) => {
    fs.cpSync(repo, `${repo}-commit-graph`, { recursive: true });
    execFileSync("git", ["commit-graph", "write", "--reachable"], { cwd: `${repo}-commit-graph` });
    return `${repo}-commit-graph`;
  });
  const shallow = path.join(root, "shallow");
  execFileSync("git", ["clone", "-q", "--depth", "3", `file://${path.join(root, "graph-origin.git")}`, shallow]);
  return [...repos, ...graphed, path.join(root, "empty"), shallow];
}

(async () => {
  if (!fs.existsSync(POLY)) throw new Error(`no poly at ${POLY}: build it, or set POLY_BIN`);
  const repos = process.argv.length > 2
    ? process.argv.slice(2).map((repo) => [path.resolve(repo), true])
    : [...fixtures().map((repo) => [repo, false]), [ROOT, true]];
  const lib = data();
  console.log(
    `${execFileSync(POLY, ["--version"], { encoding: "utf8" }).trim()} vs ${
      execFileSync("git", ["--version"], { encoding: "utf8" }).trim()
    }\n`,
  );
  let failed = 0;
  for (const [repo, tolerant] of repos) {
    const { same, report } = await checkRepo(repo, lib, tolerant);
    console.log(`${same ? "SAME" : "DIFFERENT"}  ${repo}\n${report.join("\n")}\n`);
    if (!same) failed++;
  }
  console.log(
    failed === 0
      ? `all ${repos.length} repositories read the same`
      : `${failed} of ${repos.length} repositories differ`,
  );
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});

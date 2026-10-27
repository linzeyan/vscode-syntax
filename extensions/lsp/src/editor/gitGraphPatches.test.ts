import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { gitIn, PATCH_LINES, pathPatches, uncommittedPatches } from "./gitGraphData";

// The Changes tab is `git log -p -- <path>` drawn as a page, so what it reads
// is held to what git itself prints for the same path.
const repo = mkdtempSync(join(tmpdir(), "poly-git-patches-"));
after(() => {
  for (const entry of readdirSync(repo, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) chmodSync(join(entry.parentPath, entry.name), 0o666);
  }
  rmSync(repo, { recursive: true, force: true });
});

let clock = 1_700_000_000;
const git = (...args: string[]) =>
  execFileSync("git", [
    "-c",
    "user.name=Ada",
    "-c",
    "user.email=ada@example.com",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock++} +0000` },
  });
const write = (file: string, text: string | Buffer) => writeFileSync(join(repo, file), text);
const commit = (message: string, ...files: [string, string | Buffer][]) => {
  for (const [file, text] of files) write(file, text);
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD").trim();
};
const numbered = (count: number, tag: string) => Array.from({ length: count }, (_, i) => `${tag} ${i}\n`).join("");

git("init", "-q", "-b", "main");
mkdirSync(join(repo, "docs"));
mkdirSync(join(repo, "src"));
const created = commit("Create", ["docs/old name.md", "one\ntwo\nthree\n"], ["src/main.c", "int main;\n"]);
const outside = commit("Outside docs", ["src/main.c", "int main(void);\n"]);
write("docs/old name.md", "one\ntwo\nthree\nfour\n");
git("mv", "docs/old name.md", "docs/新 名.md");
const renamed = commit("Rename and edit");
const binary = commit("Binary", ["docs/logo.bin", Buffer.from([0, 1, 2, 3])]);
const big = commit("Big", ["docs/big.txt", numbered(PATCH_LINES + 40, "line")]);
for (let i = 0; i < 4; i++) commit(`Page ${i}`, ["docs/page.txt", `${i}\n`]);
write("docs/新 名.md", "one\ntwo\nthree\nfour\nfive\n");
write("src/main.c", "int main(int argc);\n");

const run = gitIn("git", repo);

test("a folder's patches are the commits git log -p lists for it, newest first, with the same lines", async () => {
  const { commits } = await pathPatches(run, "docs", false, 0, 100);
  const expected = git("log", "--format=%s", "HEAD", "--", "docs").trim().split("\n");
  assert.deepEqual(commits.map((c) => c.subject), expected);
  assert.equal(commits.some((c) => c.hash === outside), false, "a commit outside docs is not in its history");
  // The added line as git prints it, read back out of the parsed hunks.
  const edit = commits.find((c) => c.hash === renamed)!.files[0];
  assert.deepEqual(edit.lines.filter((line) => line.startsWith("+")), ["+four"]);
  assert.equal(edit.additions, 1);
  assert.equal(edit.deletions, 0);
});

test("a renamed file, with a space and CJK in its name, keeps both names", async () => {
  // Unquoted (core.quotePath=false), the name reads as itself; the rename's
  // old name comes from its `rename from` line, as `diff --git` cannot be
  // split where a name has a space in it.
  const { commits } = await pathPatches(run, "docs", false, 0, 100);
  const file = commits.find((c) => c.hash === renamed)!.files[0];
  assert.equal(file.type, "R");
  assert.equal(file.oldPath, "docs/old name.md");
  assert.equal(file.newPath, "docs/新 名.md");
  const first = commits.find((c) => c.hash === created)!.files.find((f) => f.newPath === "docs/old name.md")!;
  assert.equal(first.type, "A");
});

test("one file's patches follow it back past its rename", async () => {
  // Without --follow the history of the new name begins at the rename and
  // what came before it, under the old name, is lost.
  const followed = await pathPatches(run, "docs/新 名.md", true, 0, 100);
  assert.deepEqual(followed.commits.map((c) => c.hash), [renamed, created]);
  const unfollowed = await pathPatches(run, "docs/新 名.md", false, 0, 100);
  assert.deepEqual(unfollowed.commits.map((c) => c.hash), [renamed]);
});

test("a binary file has no lines and no counts, rather than garbage", async () => {
  const { commits } = await pathPatches(run, "docs/logo.bin", true, 0, 100);
  assert.deepEqual(commits.map((c) => c.hash), [binary]);
  const file = commits[0].files[0];
  assert.equal(file.additions, null);
  assert.deepEqual(file.lines, []);
});

test("a long diff is cut for the page, but its counts are the whole file's", async () => {
  const { commits } = await pathPatches(run, "docs/big.txt", true, 0, 100);
  assert.deepEqual(commits.map((c) => c.hash), [big]);
  const file = commits[0].files[0];
  assert.equal(file.lines.length, PATCH_LINES);
  // The hunk header plus every added line.
  assert.equal(file.lines.length + file.omitted, PATCH_LINES + 41);
  assert.equal(file.additions, PATCH_LINES + 40);
});

test("pages follow on from each other without a gap or a repeat", async () => {
  const all = (await pathPatches(run, "docs", false, 0, 100)).commits.map((c) => c.hash);
  const first = await pathPatches(run, "docs", false, 0, 3);
  const second = await pathPatches(run, "docs", false, 3, 3);
  const rest = await pathPatches(run, "docs", false, 6, 100);
  assert.equal(first.more, true);
  assert.equal(rest.more, false);
  assert.deepEqual([...first.commits, ...second.commits, ...rest.commits].map((c) => c.hash), all);
});

test("uncommitted patches are only the path's", async () => {
  const docs = await uncommittedPatches(run, "docs");
  assert.deepEqual(docs.map((f) => f.newPath), ["docs/新 名.md"]);
  assert.deepEqual(docs[0].lines.filter((line) => line.startsWith("+")), ["+five"]);
  assert.deepEqual((await uncommittedPatches(run)).map((f) => f.newPath).sort(), ["docs/新 名.md", "src/main.c"]);
});

test("a repository with no commits has no patches rather than an error", async () => {
  const empty = mkdtempSync(join(tmpdir(), "poly-git-empty-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: empty });
    const { commits, more } = await pathPatches(gitIn("git", empty), "", false, 0, 20);
    assert.deepEqual(commits, []);
    assert.equal(more, false);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

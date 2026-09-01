import * as assert from "node:assert/strict";
import { test } from "node:test";

import { nextChangedFile } from "./changes";

const FILES = ["src/b.ts", "src/a.ts", "README.md"];

test("walks in path order, not in the order git reported", () => {
  assert.equal(nextChangedFile(FILES, "README.md", 1), "src/a.ts");
  assert.equal(nextChangedFile(FILES, "src/a.ts", 1), "src/b.ts");
  assert.equal(nextChangedFile(FILES, "src/b.ts", -1), "src/a.ts");
});

test("both ends wrap, so the key never stops working", () => {
  assert.equal(nextChangedFile(FILES, "src/b.ts", 1), "README.md");
  assert.equal(nextChangedFile(FILES, "README.md", -1), "src/b.ts");
});

test("a file with no changes lands on its neighbour, not on the first entry", () => {
  // Starting a review from an untouched file is the normal case, and jumping
  // back to the top of the list would lose the reader's place in the tree.
  assert.equal(nextChangedFile(FILES, "src/a2.ts", 1), "src/b.ts");
  assert.equal(nextChangedFile(FILES, "src/a2.ts", -1), "src/a.ts");
});

test("an unchanged file outside the list wraps like a changed one would", () => {
  assert.equal(nextChangedFile(FILES, "zzz.ts", 1), "README.md");
  assert.equal(nextChangedFile(FILES, "AAA.ts", -1), "src/b.ts");
});

test("staged and unstaged versions of one file are one stop", () => {
  // The git API reports the same path in workingTreeChanges and indexChanges,
  // and pressing next twice to get past one file would look like a bug.
  const both = ["src/a.ts", "src/a.ts", "src/b.ts"];
  assert.equal(nextChangedFile(both, "src/a.ts", 1), "src/b.ts");
  assert.equal(nextChangedFile(both, "src/b.ts", 1), "src/a.ts");
});

test("with a single changed file, next stays in it", () => {
  assert.equal(nextChangedFile(["src/a.ts"], "src/a.ts", 1), "src/a.ts");
  assert.equal(nextChangedFile(["src/a.ts"], "other.ts", -1), "src/a.ts");
});

test("nothing changed means nowhere to go", () => {
  assert.equal(nextChangedFile([], "src/a.ts", 1), undefined);
  assert.equal(nextChangedFile([], undefined, -1), undefined);
});

test("no open editor starts at the appropriate end", () => {
  assert.equal(nextChangedFile(FILES, undefined, 1), "README.md");
  assert.equal(nextChangedFile(FILES, undefined, -1), "src/b.ts");
});

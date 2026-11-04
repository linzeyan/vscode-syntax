import * as assert from "node:assert/strict";
import { test } from "node:test";

import { changeAnchor, nextChangedFile } from "./changes";

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

// What VSCode's diff editor and quick diff both do from a cursor line (read
// off workbench.desktop.main.js 1.138): the first change starting strictly
// after it, or the last strictly before it, wrapping at either end.
function walk(starts: number[], cursor: number, direction: 1 | -1): number {
  return direction === 1
    ? starts.find((start) => start > cursor) ?? starts[0]
    : [...starts].reverse().find((start) => start < cursor) ?? starts[starts.length - 1];
}
function press(starts: number[], cursor: number, visible: [number, number][], lines: number, direction: 1 | -1) {
  return walk(starts, changeAnchor(cursor, visible, lines, direction) ?? cursor, direction);
}

const STARTS = [10, 120, 250, 400];

test("scrolled away from the cursor, next and previous start from the screen", () => {
  // The reported case: cursor left at the top, the diff scrolled to line 200.
  assert.equal(press(STARTS, 0, [[200, 260]], 500, 1), 250);
  assert.equal(press(STARTS, 0, [[200, 260]], 500, -1), 250);
  assert.equal(press(STARTS, 0, [[270, 330]], 500, -1), 250);
});

test("a change starting on the screen's top line is the next one", () => {
  assert.equal(press(STARTS, 0, [[250, 300]], 500, 1), 250);
  assert.equal(press(STARTS, 499, [[200, 250]], 500, -1), 250);
});

test("a cursor on screen keeps VSCode's own walk", () => {
  assert.equal(changeAnchor(220, [[200, 260]], 500, 1), undefined);
  assert.equal(press(STARTS, 255, [[200, 260]], 500, 1), 400);
  assert.equal(press(STARTS, 255, [[200, 260]], 500, -1), 250);
});

test("at the file's top or bottom the walk still reaches the change there", () => {
  // No line above the first one to stand on; a change on line 0 must not be skipped.
  assert.equal(press([0, 120], 300, [[0, 40]], 500, 1), 0);
  assert.equal(press([120, 499], 0, [[460, 499]], 500, -1), 499);
});

test("folded regions split the screen; only the outer edges matter", () => {
  assert.equal(press(STARTS, 0, [[100, 130], [240, 260]], 500, 1), 120);
  assert.equal(press(STARTS, 0, [[100, 130], [240, 260]], 500, -1), 250);
});

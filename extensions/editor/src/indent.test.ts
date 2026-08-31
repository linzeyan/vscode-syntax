import * as assert from "node:assert/strict";
import { test } from "node:test";

import { indentSpans } from "./indent";

const levels = (line: string, tabSize = 4) =>
  indentSpans(line, tabSize).map((s) => `${s.start}-${s.end}:${s.level}${s.partial ? "?" : ""}`);

test("each filled level is one span, counted outward", () => {
  assert.deepEqual(levels("    x"), ["0-4:0"]);
  assert.deepEqual(levels("        x"), ["0-4:0", "4-8:1"]);
  assert.deepEqual(levels("x"), []);
});

test("a tab advances to the next stop rather than by one character", () => {
  assert.deepEqual(levels("\tx"), ["0-1:0"]);
  // Two spaces then a tab is one level, not one and a bit: the tab finishes
  // the level the spaces started. This is the case a reader cannot see.
  assert.deepEqual(levels("  \tx"), ["0-3:0"]);
  assert.deepEqual(levels("\t\tx"), ["0-1:0", "1-2:1"]);
});

test("whitespace that does not fill a level is marked, not dropped", () => {
  assert.deepEqual(levels("      x"), ["0-4:0", "4-6:1?"]);
  assert.deepEqual(levels("  x"), ["0-2:0?"]);
});

test("a blank line has no indent to colour", () => {
  assert.deepEqual(levels(""), []);
  assert.deepEqual(levels("        "), []);
  assert.deepEqual(levels("\t\t"), []);
});

test("a two-space project gets two-space levels", () => {
  assert.deepEqual(levels("    x", 2), ["0-2:0", "2-4:1"]);
  // tabSize is whatever the editor resolved, so guard the value rather than
  // dividing by zero on a setting nobody expected.
  assert.deepEqual(levels("  x", 0), ["0-1:0", "1-2:1"]);
});

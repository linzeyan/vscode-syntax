import * as assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_TAGS, findTodos } from "./todos";

const find = (source: string, tags: readonly string[] = DEFAULT_TAGS) =>
  findTodos(source, tags).map((t) => `${t.line}:${t.tag}:${t.text}`);

test("a marker is found whatever comment it lives in", () => {
  const source = [
    "// TODO: wire this up",
    "# FIXME the parser",
    "/* HACK: works for now */",
    "<!-- XXX: drop before release -->",
    "  -- BUG missing index",
  ].join("\n");
  assert.deepEqual(find(source), [
    "0:TODO:wire this up",
    "1:FIXME:the parser",
    "2:HACK:works for now",
    "3:XXX:drop before release",
    "4:BUG:missing index",
  ]);
});

test("lowercase prose is not a marker", () => {
  // "todo" appears in ordinary writing constantly; the uppercase convention is
  // what makes the list worth reading.
  assert.deepEqual(find("a todo list and things to fixme later"), []);
});

test("a tag inside a longer word is a different word", () => {
  assert.deepEqual(find("const TODOS = []"), []);
  assert.deepEqual(find("XXXL"), []);
});

test("a marker with nothing after it still counts", () => {
  assert.deepEqual(find("// TODO"), ["0:TODO:"]);
  assert.deepEqual(find("// TODO:"), ["0:TODO:"]);
});

test("the tag list is configurable, and junk in it cannot break the scan", () => {
  assert.deepEqual(find("// REVIEW: look here", ["REVIEW"]), ["0:REVIEW:look here"]);
  // A tag of `.*` would otherwise match every line in the workspace.
  assert.deepEqual(find("anything at all", [".*", "("]), []);
  assert.deepEqual(find("// TODO: x", []), []);
});

test("column points at the tag, so opening the file lands on it", () => {
  const [todo] = findTodos("    // TODO: here", DEFAULT_TAGS);
  assert.equal(todo.column, 7);
});

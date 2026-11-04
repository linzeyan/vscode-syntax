import * as assert from "node:assert/strict";
import { test } from "node:test";

import { ansiLines, DifftJson, difftView } from "./gitGraphViewers";

// What difft 0.69 printed for these two files, `--display json`.
const CJK: DifftJson = {
  aligned_lines: [[0, 0], [1, 1], [2, 2]],
  chunks: [[
    {
      lhs: { line_number: 0, changes: [{ start: 10, end: 21, content: "\"中文字\"", highlight: "string" }] },
      rhs: { line_number: 0, changes: [{ start: 10, end: 27, content: "\"中文字變了\"", highlight: "string" }] },
    },
    {
      lhs: { line_number: 1, changes: [{ start: 8, end: 9, content: "1", highlight: "normal" }] },
      rhs: { line_number: 1, changes: [{ start: 8, end: 9, content: "2", highlight: "normal" }] },
    },
  ]],
  language: "TypeScript",
  status: "changed",
};

test("difftastic's byte offsets land on the changed token in a line with CJK text", () => {
  const view = difftView(CJK, "const s = \"中文字\";\nlet x = 1;\n", "const s = \"中文字變了\";\nlet x = 2;\n");
  const [first, second] = view.hunks[0];
  assert.deepEqual(first.left?.runs, [["const s = "], ["\"中文字\"", "string"], [";"]]);
  assert.deepEqual(first.right?.runs, [["const s = "], ["\"中文字變了\"", "string"], [";"]]);
  assert.deepEqual(second.right?.runs, [["let x = "], ["2", "normal"], [";"]]);
  assert.equal(first.left?.n, 1, "line numbers are 1-based, as a diff shows them");
});

test("only changed lines and their context are shown, in separate hunks", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const changedAt = (n: number) => ({
    lhs: { line_number: n, changes: [{ start: 0, end: 4, content: "line", highlight: "normal" }] },
    rhs: { line_number: n, changes: [{ start: 0, end: 4, content: "line", highlight: "normal" }] },
  });
  const json: DifftJson = {
    status: "changed",
    language: "Text",
    aligned_lines: lines.map((_, i) => [i, i]),
    chunks: [[changedAt(2)], [changedAt(20)]],
  };
  const view = difftView(json, lines.join("\n"), lines.join("\n"), 3);
  assert.deepEqual(view.hunks.map((hunk) => hunk.map((row) => row.left?.n)), [
    [1, 2, 3, 4, 5, 6],
    [18, 19, 20, 21, 22, 23, 24],
  ]);
});

test("a line with no counterpart shows on its side alone", () => {
  const json: DifftJson = {
    aligned_lines: [[0, 0], [1, 1], [2, 2], [null, 3], [3, 4]],
    chunks: [[{
      rhs: { line_number: 3, changes: [{ start: 0, end: 1, content: "d", highlight: "normal" }] },
    }]],
    language: "Text",
    status: "changed",
  };
  const view = difftView(json, "a\nb\nc\ne\n", "a\nb\nc\nd\ne\n", 0);
  assert.deepEqual(view.hunks, [[{ left: undefined, right: { n: 4, runs: [["d", "normal"]] } }]]);
});

test("a reformat difftastic finds no change in has nothing to show", () => {
  const view = difftView({ status: "unchanged", language: "TypeScript" }, "f(a,b)\n", "f(a, b)\n");
  assert.deepEqual(view.hunks, []);
});

test("a created file is all change, cut at the row limit like any other", () => {
  const view = difftView({ status: "created", language: "Text" }, "", "a\nb\nc\n", 3, 2);
  assert.deepEqual(view.hunks, [[{ right: { n: 1, runs: [["a", "normal"]] } }, {
    right: { n: 2, runs: [["b", "normal"]] },
  }]]);
  assert.equal(view.omitted, 1);
});

test("delta's colours survive, its hyperlinks and cursor moves do not", () => {
  // Shapes delta 0.19 wrote with side-by-side, line-numbers and hyperlinks on.
  const out = "\x1b[34m│\x1b[0m\x1b]8;;vscode://file/b.ts:1\x1b\\\x1b[34m1\x1b[0m\x1b]8;;\x1b\\:"
    + "\x1b[48;2;63;0;1;38;2;102;217;239mconst\x1b[0m\x1b[K\n\x1b[38;5;88m 2\x1b[0m";
  assert.deepEqual(ansiLines(out), [
    [
      ["│", { fg: "var(--vscode-terminal-ansiBlue)" }],
      ["1", { fg: "var(--vscode-terminal-ansiBlue)" }],
      [":", {}],
      ["const", { bg: "rgb(63, 0, 1)", fg: "rgb(102, 217, 239)" }],
    ],
    [[" 2", { fg: "rgb(135, 0, 0)" }]],
  ]);
});

test("a reset clears every attribute, and an attribute's own off code clears only it", () => {
  const [line] = ansiLines("\x1b[1;3;31ma\x1b[22mb\x1b[mc");
  assert.deepEqual(line, [
    ["a", { bold: true, italic: true, fg: "var(--vscode-terminal-ansiRed)" }],
    ["b", { bold: undefined, dim: undefined, italic: true, fg: "var(--vscode-terminal-ansiRed)" }],
    ["c", {}],
  ]);
});

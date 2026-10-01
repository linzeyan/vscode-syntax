import * as assert from "node:assert";
import { test } from "node:test";

import { type Layout, layout } from "./gitGraphLayout";

// tools/git-graph-diff/layout.js holds the layout to the graph Git Graph itself
// draws, over whole repositories. These pin the rules that comparison found,
// small enough to read, so a change that breaks one says which.

/** Each row gap's segments as `from>to:colour`, sorted: what is drawn. */
function gaps(result: Layout, rows: number): string[][] {
  const found: string[][] = Array.from({ length: rows }, () => []);
  for (const line of result.lines) {
    for (let i = 1; i < line.points.length; i++) {
      const [p, q] = [line.points[i - 1], line.points[i]];
      assert.strictEqual(q.row, p.row + 1, "a line has a point in every row it crosses");
      found[p.row].push(`${p.col}>${q.col}:${line.uncommitted ? "grey" : line.colour}`);
    }
  }
  return found.map((segments) => [...new Set(segments)].sort());
}

const c = (hash: string, ...parents: string[]) => ({ hash, parents });
const cols = (result: Layout) => result.nodes.map((node) => node.col);

test("a line of commits stays in one column with one colour", () => {
  const result = layout([c("c", "b"), c("b", "a"), c("a")], false);
  assert.deepStrictEqual(result.nodes, [{ col: 0, colour: 0 }, { col: 0, colour: 0 }, { col: 0, colour: 0 }]);
  assert.deepStrictEqual(gaps(result, 3), [["0>0:0"], ["0>0:0"], []]);
  assert.strictEqual(result.width, 1);
});

test("a merged branch keeps a column and a colour of its own from the merge to its fork point", () => {
  // The first-parent line is drawn first and keeps column 0 throughout, so the
  // branch everyone works on never shifts sideways; the merged branch bends
  // out of the merge and back into the commit it forked from.
  const result = layout([c("M", "A", "F2"), c("F2", "F1"), c("A", "B"), c("F1", "B"), c("B")], false);
  assert.deepStrictEqual(cols(result), [0, 1, 0, 1, 0]);
  assert.deepStrictEqual(gaps(result, 5), [["0>0:0", "0>1:1"], ["0>0:0", "1>1:1"], ["0>0:0", "1>1:1"], [
    "0>0:0",
    "1>0:1",
  ], []]);
});

test("an octopus merge opens one column and colour per merged parent", () => {
  const result = layout([c("O", "A", "X", "Y", "Z"), c("X", "A"), c("Y", "A"), c("Z", "A"), c("A")], false);
  assert.deepStrictEqual(cols(result), [0, 1, 2, 3, 0]);
  assert.deepStrictEqual(gaps(result, 5)[0], ["0>0:0", "0>1:1", "0>2:2", "0>3:3"]);
  assert.strictEqual(result.width, 4);
});

test("uncommitted changes lend HEAD their line, grey only up to HEAD", () => {
  // Git Graph draws the checked-out branch in the first colour because the
  // line that starts at the uncommitted changes carries on through HEAD; a
  // layout that started HEAD's line afresh would give it the next free colour
  // instead, and every other colour on the page would shift with it.
  const result = layout([c("*", "H"), c("S", "H"), c("H", "P"), c("P")], false);
  assert.deepStrictEqual(cols(result), [0, 1, 0, 0]);
  assert.strictEqual(result.nodes[2].colour, 0, "HEAD has the first colour");
  assert.deepStrictEqual(gaps(result, 4), [["0>0:grey"], ["0>0:grey", "1>0:1"], ["0>0:0"], []]);
});

test("a parent not loaded gets a line to the bottom, unless first-parent mode leaves it out", () => {
  // The line says there is more history below; it also holds its column, so
  // the commits beside it are where Git Graph puts them.
  const result = layout([c("A", "X"), c("B", "Y"), c("C")], false);
  assert.deepStrictEqual(cols(result), [0, 1, 2]);
  assert.deepStrictEqual(gaps(result, 3), [["0>0:0"], ["0>0:0", "1>1:1"], []]);
  assert.deepStrictEqual(gaps(layout([c("M", "A", "X"), c("A")], false), 2)[0], ["0>0:0", "0>1:1"]);
  assert.deepStrictEqual(gaps(layout([c("M", "A", "X"), c("A")], true), 2)[0], ["0>0:0"]);
});

test("a line moves left into the first column free in each row", () => {
  // Columns are handed out row by row in the order lines reach the row, so a
  // line that started far right drifts left as the lines beside it end.
  // P's line (an orphan root's, to the bottom) is in column 2 while C's line
  // holds column 1, and takes column 1 in the row after C's line has ended.
  const result = layout([c("A", "D"), c("B", "C"), c("P"), c("C", "D"), c("D")], false);
  assert.deepStrictEqual(cols(result), [0, 1, 2, 1, 0]);
  assert.deepStrictEqual(gaps(result, 5), [
    ["0>0:0"],
    ["0>0:0", "1>1:1"],
    ["0>0:0", "1>1:1", "2>2:2"],
    ["0>0:0", "1>0:1", "2>1:2"],
    [],
  ]);
});

test("a colour is free again below the row where its line ended", () => {
  // Without reuse every branch ever seen would take a new colour and the
  // twelve would cycle, making unrelated branches look alike.
  const result = layout([c("B1", "M1"), c("M2", "M1"), c("M1", "M0"), c("B2", "M0"), c("M0")], false);
  assert.deepStrictEqual(cols(result), [0, 1, 0, 1, 0]);
  assert.strictEqual(result.width, 2);
  assert.strictEqual(result.nodes[3].colour, result.nodes[1].colour, "B2 takes the colour M2's line gave back");
});

test("an orphan root above the last row runs a line to the bottom", () => {
  // Git Graph's own drawing, kept so the columns of everything below match it.
  const result = layout([c("A", "B"), c("P"), c("B")], false);
  assert.deepStrictEqual(cols(result), [0, 1, 0]);
  assert.deepStrictEqual(gaps(result, 3), [["0>0:0"], ["0>0:0", "1>1:1"], []]);
});

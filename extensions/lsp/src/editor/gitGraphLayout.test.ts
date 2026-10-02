import * as assert from "node:assert";
import { test } from "node:test";

import {
  colorRegistry,
  getHistoryItemColor,
  getHistoryItemIndex,
  historyItemRefColor,
  type ISCMHistoryItemGraphNode,
  layout,
} from "./gitGraphLayout";
import { UNCOMMITTED } from "./gitGraphProtocol";

// The lanes are VS Code's (see gitGraphLayout.ts); these pin what a reader of
// the graph relies on, so a change to the port that breaks one says which.

const c = (hash: string, ...parents: string[]) => ({ hash, parents });
const ids = (lanes: ISCMHistoryItemGraphNode[]) => lanes.map((lane) => lane.id);

test("a line of commits stays in one lane and one colour", () => {
  const rows = layout([c("c", "b"), c("b", "a"), c("a")], false);
  assert.deepStrictEqual(rows.map(getHistoryItemIndex), [0, 0, 0]);
  assert.strictEqual(new Set(rows.map(getHistoryItemColor)).size, 1);
  assert.deepStrictEqual(ids(rows[2].outputSwimlanes), [], "nothing runs on below the root");
});

test("a merged branch has a lane of its own from the merge down to where it forked", () => {
  const rows = layout([c("M", "A", "F2"), c("F2", "F1"), c("A", "B"), c("F1", "B"), c("B", "R"), c("R")], false);
  const [merge, f2, a, f1, fork] = rows;
  assert.deepStrictEqual(ids(merge.outputSwimlanes), ["A", "F2"], "the merge opens a lane to each parent");
  const [mainline, branch] = merge.outputSwimlanes.map((lane) => lane.color);
  assert.notStrictEqual(branch, mainline, "the merged branch stands out from the line it was merged into");

  // A commit sits on its first child's lane when it continues it, in that
  // lane's colour: the branch's commits on the branch's lane, the mainline's
  // on the mainline's.
  assert.deepStrictEqual([f2, f1].map(getHistoryItemIndex), [1, 1]);
  assert.deepStrictEqual([f2, f1].map(getHistoryItemColor), [branch, branch]);
  assert.deepStrictEqual([merge, a, fork].map(getHistoryItemIndex), [0, 0, 0]);
  assert.deepStrictEqual([merge, a, fork].map(getHistoryItemColor), [mainline, mainline, mainline]);

  // Both lanes end in the fork point's circle, and one lane leaves it.
  assert.deepStrictEqual(ids(fork.inputSwimlanes), ["B", "B"]);
  assert.deepStrictEqual(ids(fork.outputSwimlanes), ["R"]);
});

test("an octopus merge opens one lane and colour per merged parent, which all end at the base", () => {
  const rows = layout([c("O", "A", "X", "Y", "Z"), c("X", "A"), c("Y", "A"), c("Z", "A"), c("A")], false);
  assert.deepStrictEqual(ids(rows[0].outputSwimlanes), ["A", "X", "Y", "Z"]);
  assert.strictEqual(new Set(rows[0].outputSwimlanes.map((lane) => lane.color)).size, 4);
  assert.deepStrictEqual(rows.slice(1, 4).map(getHistoryItemIndex), [1, 2, 3]);
  assert.deepStrictEqual(ids(rows[4].inputSwimlanes), ["A", "A", "A", "A"]);
  assert.strictEqual(getHistoryItemIndex(rows[4]), 0);
});

test("a parent not loaded keeps its lane open past the last row, towards the commits below", () => {
  // The lane says there is more history than is listed; ending it at the
  // last row would draw the commit as a root.
  const rows = layout([c("A", "X"), c("B", "Y")], false);
  assert.deepStrictEqual(ids(rows[0].outputSwimlanes), ["X"]);
  assert.deepStrictEqual(ids(rows[1].outputSwimlanes), ["X", "Y"], "A's lane runs on past B");
});

test("first-parent mode leaves out the merged parents not listed, and keeps those listed", () => {
  // git log --first-parent still names every parent of a merge; one it did not
  // list would hold a lane open to the bottom for a commit that is not there.
  const unlisted = [c("M", "A", "X"), c("A")];
  assert.deepStrictEqual(ids(layout(unlisted, false)[0].outputSwimlanes), ["A", "X"]);
  assert.deepStrictEqual(ids(layout(unlisted, true)[0].outputSwimlanes), ["A"]);
  assert.deepStrictEqual(ids(layout(unlisted, true)[1].outputSwimlanes), [], "no lane to X below A");

  const listed = [c("M", "A", "F"), c("F", "A"), c("A")];
  assert.deepStrictEqual(ids(layout(listed, true)[0].outputSwimlanes), ["A", "F"]);
});

test("uncommitted changes and the checked-out commit share the current-branch colour", () => {
  // The uncommitted changes stand where VS Code's outgoing changes node does,
  // in its colour; HEAD carries the colour on, so the checked-out branch reads
  // as one line from the working tree down. A stash beside it is another
  // line, in a colour of its own.
  const rows = layout([c(UNCOMMITTED, "H"), c("S", "H"), c("H", "P"), c("P")], false, "H");
  const [uncommitted, stash, headRow, parent] = rows;
  assert.deepStrictEqual(rows.map((row) => row.kind), ["uncommitted-changes", "node", "HEAD", "node"]);
  assert.strictEqual(getHistoryItemIndex(headRow), 0, "HEAD sits on the line from the uncommitted changes");
  assert.deepStrictEqual(
    [uncommitted, headRow, parent].map(getHistoryItemColor),
    [historyItemRefColor, historyItemRefColor, historyItemRefColor],
  );
  assert.strictEqual(getHistoryItemIndex(stash), 1);
  assert.notStrictEqual(getHistoryItemColor(stash), historyItemRefColor);
});

test("the checked-out commit's line is the current-branch colour below it, whatever leads into it", () => {
  const rows = layout([c("B", "H"), c("H", "P"), c("P")], false, "H");
  assert.notStrictEqual(rows[0].outputSwimlanes[0].color, historyItemRefColor, "B's own lane into HEAD");
  assert.strictEqual(getHistoryItemColor(rows[1]), historyItemRefColor);
  assert.strictEqual(getHistoryItemColor(rows[2]), historyItemRefColor);
});

test("colours run through VS Code's five in turn, and a lane keeps its colour to its end", () => {
  // Five colours, as VS Code's graph has: the sixth branch reuses the first's,
  // and the checked-out branch's own colour does not use one up.
  const tips = ["T1", "T2", "T3", "T4", "T5", "T6"];
  const rows = layout([...tips.map((tip) => c(tip, "R")), c("R")], false, "T1");
  const colours = rows.slice(0, 6).map(getHistoryItemColor);
  assert.strictEqual(colours[0], historyItemRefColor);
  assert.deepStrictEqual(colours.slice(1), colorRegistry);

  const more = layout([...tips.map((tip) => c(tip, "R")), c("R")], false);
  assert.strictEqual(getHistoryItemColor(more[5]), getHistoryItemColor(more[0]));
  assert.deepStrictEqual(
    more[6].inputSwimlanes.map((lane) => lane.color),
    more.slice(0, 6).map(getHistoryItemColor),
    "each lane reaches R in the colour it started in",
  );
});

test("a lane moves left once the lanes to its left have ended", () => {
  // The graph is only as wide as the lanes alive at each row.
  const rows = layout(
    [c("X", "Z"), c("Y", "C"), c("V", "W"), c("C", "Z"), c("Z", "R"), c("W", "R"), c("R")],
    false,
  );
  const z = rows[4];
  assert.deepStrictEqual(ids(z.inputSwimlanes), ["Z", "Z", "W"]);
  assert.deepStrictEqual(ids(z.outputSwimlanes), ["R", "W"]);
  assert.strictEqual(getHistoryItemIndex(rows[5]), 1, "W is drawn in the lane it moved to");
});

test("a root mid-graph ends its own lane and leaves the lanes beside it running", () => {
  // An orphan branch, or a history merged in with --allow-unrelated-histories:
  // its root sits among the other lines, which must not stop at it.
  const rows = layout([c("O", "P"), c("A", "B"), c("P"), c("B")], false);
  const root = rows[2];
  assert.deepStrictEqual(ids(root.inputSwimlanes), ["P", "B"]);
  assert.deepStrictEqual(ids(root.outputSwimlanes), ["B"]);
  assert.strictEqual(
    getHistoryItemColor(root),
    rows[0].outputSwimlanes[0].color,
    "the root is in its own lane's colour",
  );
  assert.strictEqual(getHistoryItemIndex(rows[3]), 0);
  assert.strictEqual(getHistoryItemColor(rows[3]), getHistoryItemColor(rows[1]), "B continues A's lane");
});

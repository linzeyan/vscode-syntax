/**
 * Where each commit of the Git Graph sits and how the lines between them run,
 * placed as mhutchie.git-graph 1.30.0 places them: tools/git-graph-diff/layout.js
 * reads both graphs off the screen and compares them row by row.
 *
 * The rules, as observed. Commits are taken newest first, and each one not yet
 * on a line starts one, which then follows first parents down until it reaches
 * a commit already on a line. Every row hands out its columns left to right in
 * the order lines arrive at it, so a line moves left as soon as the lines to
 * its left have ended. A merge's other parents each get either a new line, if
 * they are on none yet, or a short one in the colour of the line they are on,
 * which joins it at the first row where that line is heading for them. A
 * colour is free again below the row where its line ended.
 *
 * Two things follow that look odd but are what Git Graph draws, so they are
 * kept: the line from uncommitted changes carries on as HEAD's own line, in
 * the first colour, and a root commit that is not the last row -- an orphan
 * branch -- has a line running from it to the bottom of the graph.
 *
 * Pure, so the page and the unit tests run the same code.
 */

export interface Point {
  row: number;
  col: number;
}

export interface Line {
  /** An index into the palette: the page takes it modulo the palette's length. */
  colour: number;
  /** The part of a line that leaves the uncommitted changes, which is drawn grey. */
  uncommitted: boolean;
  /**
   * One point per row, from where the line starts to where it ends. A segment
   * that changes column bends next to its upper end when `bendFirst` is set
   * on its lower point, next to its lower end otherwise -- which only shows
   * when a commit's details open in between and the gap is tall.
   */
  points: (Point & { bendFirst: boolean })[];
}

export interface Layout {
  nodes: { col: number; colour: number }[];
  lines: Line[];
  /** The most columns any row uses. */
  width: number;
}

/** A parent that is not listed: more commits follow that were not loaded. */
const BELOW = -1;

/**
 * Lays out `commits`, newest first. A parent that is not among them is drawn
 * as a line to the bottom, towards the commits not loaded -- except, in
 * first-parent mode, the other parents of a merge, which are left out.
 */
export function layout(
  commits: { hash: string; parents: string[] }[],
  firstParent: boolean,
  uncommitted = "*",
): Layout {
  const n = commits.length;
  const rowOf = new Map(commits.map((commit, row) => [commit.hash, row]));
  const parents = commits.map((commit) =>
    commit.parents.flatMap((parent, index) => {
      const row = rowOf.get(parent);
      return row !== undefined ? [row] : !firstParent || index === 0 ? [BELOW] : [];
    })
  );

  /** Per row: the next column to hand out, and what each handed-out column is a line to. */
  const nextCol = new Array<number>(n).fill(0);
  const heading: { to: number | undefined; branch: number }[][] = commits.map(() => []);
  /** Per row: the column of the commit itself and the branch -- the line of first parents -- it is on, once it is on one. */
  const col = new Array<number>(n);
  const branchOf = new Array<number>(n);
  const branchColour: number[] = [];
  const parentsDone = new Array<number>(n).fill(0);
  /** Per colour: the row its last line ended at. */
  const colourEnded: number[] = [];
  const lines: Line[] = [];

  const take = (row: number, at: number, to: number | undefined, branch: number) => {
    if (at === nextCol[row]) {
      nextCol[row] = at + 1;
      heading[row][at] = { to, branch };
    }
  };
  const nextParent = (row: number) => parents[row][parentsDone[row]];
  const freeColour = (start: number) => {
    const reused = colourEnded.findIndex((ended) => start > ended);
    if (reused !== -1) return reused;
    colourEnded.push(n);
    return colourEnded.length - 1;
  };
  const startLine = (lineColour: number, from: Point, isUncommitted: boolean): Line => {
    const line = { colour: lineColour, uncommitted: isUncommitted, points: [{ ...from, bendFirst: false }] };
    lines.push(line);
    return line;
  };

  /** Draws the line from `start` towards its next parent not yet drawn to. */
  const draw = (start: number) => {
    let commit = start;
    let parent = nextParent(commit);
    let last: Point = { row: start, col: col[start] ?? nextCol[start] };

    if (
      parent !== undefined && parent !== BELOW && parents[start].length > 1 && col[start] !== undefined
      && col[parent] !== undefined
    ) {
      // Both ends are already on lines: a short line in the parent's colour,
      // into the first row where the parent's line is on its way to it.
      const branch = branchOf[parent];
      const line = startLine(branchColour[branch], last, false);
      for (let row = start + 1; row < n; row++) {
        const joining = heading[row].findIndex((h) => h?.to === parent && h.branch === branch);
        const at = joining === -1 ? nextCol[row] : joining;
        line.points.push({ row, col: at, bendFirst: joining === -1 && row !== parent ? last.col < at : true });
        take(row, at, parent, branch);
        last = { row, col: at };
        if (joining !== -1) {
          parentsDone[start]++;
          break;
        }
      }
      return;
    }

    const lineColour = freeColour(start);
    const branch = branchColour.push(lineColour) - 1;
    if (col[start] === undefined) {
      col[start] = last.col;
      branchOf[start] = branch;
    }
    take(start, last.col, start, branch);
    let line = startLine(lineColour, last, commits[start].hash === uncommitted);
    let row = start + 1;
    for (; row < n; row++) {
      const reached = row === parent;
      const at = reached && col[row] !== undefined ? col[row] : nextCol[row];
      line.points.push({ row, col: at, bendFirst: last.col < at });
      take(row, at, parent, branch);
      last = { row, col: at };
      if (reached) {
        parentsDone[commit]++;
        const wasOnALine = col[row] !== undefined;
        if (!wasOnALine) {
          col[row] = at;
          branchOf[row] = branch;
        }
        commit = row;
        parent = nextParent(commit);
        if (parent === undefined || wasOnALine) break;
        if (line.uncommitted) line = startLine(lineColour, last, false);
      }
    }
    // Ran off the bottom towards a parent not loaded, which is then as done
    // as it will get. (Git Graph only does this for a parent that is not
    // listed; one that is listed is always below, and so always reached.)
    if (row === n && parent !== undefined) parentsDone[commit]++;
    colourEnded[lineColour] = row;
  };

  for (let row = 0; row < n; row++) {
    while (col[row] === undefined || nextParent(row) !== undefined) draw(row);
  }

  const nodes = commits.map((_, row) => ({ col: col[row], colour: branchColour[branchOf[row]] }));
  const width = Math.max(
    0,
    ...nodes.map((node) => node.col + 1),
    ...lines.flatMap((line) => line.points.map((p) => p.col + 1)),
  );
  return { nodes, lines, width };
}

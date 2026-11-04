/**
 * The Changes tab's diff viewers besides git's own: difftastic, read through
 * its JSON output, and delta, read as the terminal output it writes.
 *
 * Both are programs the user installs; poly runs whichever the
 * `poly.gitHistory.diffViewer` setting names and draws what it says. Kept free
 * of the DOM and of node so the host (which runs the tools) and the page
 * (which draws delta's colours) share it, and the tests can reach it.
 */

export type DiffViewer = "builtin" | "difftastic" | "delta";

// ---------------------------------------------------------------- difftastic

/** One side of a difftastic chunk entry: a 0-based line and the changed tokens on it. */
interface DifftSide {
  line_number: number;
  changes: { start: number; end: number; content: string; highlight: string }[];
}

/**
 * `difft --display json` (behind `DFT_UNSTABLE=yes`), as 0.69 writes it.
 * A created or deleted file comes with neither `aligned_lines` nor `chunks`.
 */
export interface DifftJson {
  status: "changed" | "unchanged" | "created" | "deleted";
  language: string;
  aligned_lines?: [number | null, number | null][];
  chunks?: { lhs?: DifftSide; rhs?: DifftSide }[][];
}

/** A run of a line's text; `highlight` marks one difftastic found changed, with its syntax class. */
export type Run = [text: string, highlight?: string];

export interface SideLine {
  /** 1-based, as a diff shows line numbers. */
  n: number;
  runs: Run[];
}

/** One row of the side-by-side view; a side is missing where the other has a line with no counterpart. */
export interface DifftRow {
  left?: SideLine;
  right?: SideLine;
}

export interface DifftView {
  language: string;
  /** Groups of rows with unchanged lines between them left out, as a patch's hunks are. */
  hunks: DifftRow[][];
  /** Rows past `maxRows`, the rest of the diff being a click away in the diff editor. */
  omitted: number;
}

const encoder = new TextEncoder();

/**
 * The line cut at difftastic's changes. Its offsets count UTF-8 bytes, not
 * characters: measured, `"中文字"` spans 10..21. Read as characters, every
 * change on a line with CJK text lands in the wrong place.
 */
function runsOf(text: string, changes: DifftSide["changes"] | undefined): Run[] {
  if (!changes?.length) return [[text]];
  // Byte offset → string index, for every character boundary.
  const index = new Map<number, number>();
  let bytes = 0;
  let at = 0;
  for (const char of text) {
    index.set(bytes, at);
    bytes += encoder.encode(char).length;
    at += char.length;
  }
  index.set(bytes, at);
  const toIndex = (offset: number) => index.get(offset) ?? Math.min(offset, text.length);

  const runs: Run[] = [];
  let done = 0;
  for (const change of [...changes].sort((a, b) => a.start - b.start)) {
    const start = Math.max(toIndex(change.start), done);
    const end = toIndex(change.end);
    if (end <= start) continue;
    if (start > done) runs.push([text.slice(done, start)]);
    runs.push([text.slice(start, end), change.highlight]);
    done = end;
  }
  if (done < text.length) runs.push([text.slice(done)]);
  return runs;
}

const linesOf = (text: string) => {
  const lines = text.split(/\r?\n/);
  // A final newline ends the last line rather than starting another.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/**
 * What difftastic found, laid out as rows the page draws side by side: the
 * lines with changes on them, `context` unchanged rows around each, and the
 * file's full text filling in what the JSON leaves out -- it names only the
 * changed tokens, never the lines around them.
 */
export function difftView(
  json: DifftJson,
  oldText: string,
  newText: string,
  context = 3,
  maxRows = 500,
): DifftView {
  const before = oldText === "" ? [] : linesOf(oldText);
  const after = newText === "" ? [] : linesOf(newText);
  // A whole file come or gone is all change; difftastic says so in its status alone.
  if (json.status === "created" || json.status === "deleted") {
    const created = json.status === "created";
    const lines = created ? after : before;
    const rows = lines.slice(0, maxRows).map((text, i): DifftRow => {
      const side = { n: i + 1, runs: [[text, "normal"]] as Run[] };
      return created ? { right: side } : { left: side };
    });
    return { language: json.language, hunks: rows.length ? [rows] : [], omitted: lines.length - rows.length };
  }
  const left = new Map<number, DifftSide["changes"]>();
  const right = new Map<number, DifftSide["changes"]>();
  for (const entry of (json.chunks ?? []).flat()) {
    if (entry.lhs) left.set(entry.lhs.line_number, [...left.get(entry.lhs.line_number) ?? [], ...entry.lhs.changes]);
    if (entry.rhs) right.set(entry.rhs.line_number, [...right.get(entry.rhs.line_number) ?? [], ...entry.rhs.changes]);
  }
  const aligned = json.aligned_lines ?? [];
  // Only lines with changes count: a line with no counterpart but nothing new
  // on it is difftastic aligning a reformatted expression, which is not a change.
  const changed = aligned.flatMap(([l, r], i) =>
    (l !== null && left.has(l)) || (r !== null && right.has(r)) ? [i] : []
  );

  const ranges: [number, number][] = [];
  for (const i of changed) {
    const from = Math.max(0, i - context);
    const to = Math.min(aligned.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  const hunks: DifftRow[][] = [];
  let rows = 0;
  let omitted = 0;
  for (const [from, to] of ranges) {
    const hunk: DifftRow[] = [];
    for (let i = from; i <= to; i++) {
      if (rows >= maxRows) {
        omitted++;
        continue;
      }
      const [l, r] = aligned[i];
      hunk.push({
        left: l === null ? undefined : { n: l + 1, runs: runsOf(before[l] ?? "", left.get(l)) },
        right: r === null ? undefined : { n: r + 1, runs: runsOf(after[r] ?? "", right.get(r)) },
      });
      rows++;
    }
    if (hunk.length) hunks.push(hunk);
  }
  return { language: json.language, hunks, omitted };
}

// ---------------------------------------------------------------- delta

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export type AnsiRun = [text: string, style: AnsiStyle];

const NAMES = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];

/**
 * The 16 basic colours as the theme's terminal colours, so delta's plain
 * `34m` is the blue the integrated terminal would show, not a fixed one.
 */
function basic(index: number): string {
  const name = `${index >= 8 ? "Bright" : ""}${NAMES[index % 8]}`;
  return `var(--vscode-terminal-ansi${name})`;
}

function palette(n: number): string {
  if (n < 16) return basic(n);
  if (n < 232) {
    const level = [0, 95, 135, 175, 215, 255];
    const k = n - 16;
    return `rgb(${level[Math.floor(k / 36)]}, ${level[Math.floor(k / 6) % 6]}, ${level[k % 6]})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

/** Applies one SGR sequence's parameters to `style`, in place. */
function apply(style: AnsiStyle, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) {
      for (const key of Object.keys(style) as (keyof AnsiStyle)[]) delete style[key];
    } else if (p === 1) style.bold = true;
    else if (p === 2) style.dim = true;
    else if (p === 3) style.italic = true;
    else if (p === 4) style.underline = true;
    else if (p === 7) style.inverse = true;
    else if (p === 22) style.bold = style.dim = undefined;
    else if (p === 23) style.italic = undefined;
    else if (p === 24) style.underline = undefined;
    else if (p === 27) style.inverse = undefined;
    else if (p >= 30 && p <= 37) style.fg = basic(p - 30);
    else if (p >= 90 && p <= 97) style.fg = basic(p - 90 + 8);
    else if (p >= 40 && p <= 47) style.bg = basic(p - 40);
    else if (p >= 100 && p <= 107) style.bg = basic(p - 100 + 8);
    else if (p === 39) style.fg = undefined;
    else if (p === 49) style.bg = undefined;
    else if (p === 38 || p === 48) {
      // Extended colours take the following parameters: 5;n or 2;r;g;b.
      let color: string | undefined;
      if (params[i + 1] === 5) {
        color = palette(params[i + 2] ?? 0);
        i += 2;
      } else if (params[i + 1] === 2) {
        color = `rgb(${params[i + 2] ?? 0}, ${params[i + 3] ?? 0}, ${params[i + 4] ?? 0})`;
        i += 4;
      }
      if (p === 38) style.fg = color;
      else style.bg = color;
    }
  }
}

/**
 * Terminal output as lines of styled runs. Only colours and text attributes
 * are kept: OSC sequences (delta's `hyperlinks` writes OSC 8 file links) and
 * any CSI other than SGR are dropped, as a page has no cursor to move.
 */
export function ansiLines(text: string): AnsiRun[][] {
  const lines: AnsiRun[][] = [[]];
  const style: AnsiStyle = {};
  // ESC ] ... (BEL | ESC \): OSC. ESC [ params final: CSI.
  // poly: ignore deno_lint/no-control-regex
  const pattern = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[([0-9;]*)([A-Za-z])|\n/g;
  let last = 0;
  const push = (chunk: string) => {
    // poly: ignore deno_lint/no-control-regex
    const clean = chunk.replace(/[\r\x00-\x08\x0b-\x1f\x7f]/g, "");
    if (clean) lines[lines.length - 1].push([clean, { ...style }]);
  };
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    push(text.slice(last, match.index));
    last = pattern.lastIndex;
    if (match[0] === "\n") lines.push([]);
    else if (match[2] === "m") apply(style, (match[1] || "0").split(";").map((n) => Number(n) || 0));
  }
  push(text.slice(last));
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

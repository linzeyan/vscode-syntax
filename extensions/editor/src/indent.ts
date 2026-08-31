/**
 * Leading whitespace, split into the levels a reader sees.
 *
 * VSCode's own `editor.guides.indentation` draws a line per level, which
 * answers "where does this block start" but not "how deep am I" at a glance --
 * the question that gets asked in deeply nested YAML and Python. Tinting the
 * whitespace itself answers the second one without covering the code.
 */

export interface IndentSpan {
  /** Character offsets into the line, not columns: ranges are built from these. */
  start: number;
  end: number;
  /** 0 for the first level, counting outward. */
  level: number;
  /**
   * Whitespace that did not fill a level. Worth its own colour: it is what a
   * half-applied indent looks like, and it is invisible in every other way.
   */
  partial: boolean;
}

/**
 * The indent spans of `line`, or none if the line has no code to indent.
 *
 * Columns rather than characters decide where a level ends, because a tab
 * advances to the next multiple of `tabSize` rather than by one -- mixing tabs
 * and spaces is exactly the case a reader cannot see and this can.
 */
export function indentSpans(line: string, tabSize: number): IndentSpan[] {
  const width = Math.max(1, Math.floor(tabSize));
  const spans: IndentSpan[] = [];
  let column = 0;
  let start = 0;
  let level = 0;

  for (let i = 0; i < line.length; i++) {
    const character = line[i];
    if (character !== " " && character !== "\t") {
      if (i > start) {
        spans.push({ start, end: i, level, partial: true });
      }
      return spans;
    }
    column = character === "\t"
      ? (Math.floor(column / width) + 1) * width
      : column + 1;
    if (column % width === 0) {
      spans.push({ start, end: i + 1, level, partial: false });
      start = i + 1;
      level++;
    }
  }
  // Nothing but whitespace: there is no indent, only a blank line, and
  // colouring it draws the eye to a line that says nothing.
  return [];
}

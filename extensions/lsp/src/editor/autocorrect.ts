/**
 * AutoCorrect's findings as edits to a document: what huacnlee.autocorrect
 * did -- spaces between CJK and Latin text, full- and half-width punctuation --
 * done by poly-lsp once `poly.autocorrect.enabled` is on.
 *
 * The engine is that extension's own (huacnlee/autocorrect compiled to
 * WebAssembly, autocorrectEngine.ts); this file is the part between it and the
 * editor, with no `vscode` import, so the node test runner can exercise it.
 */

/**
 * One finding as the engine reports it: a 1-based line, a 1-based column
 * counted in characters, the text found there and the text it should be.
 * Severity 1 is a rule set to error in `.autocorrectrc`, 2 one set to warning.
 */
export interface Finding {
  l: number;
  c: number;
  old: string;
  new: string;
  severity: number;
}

/** A finding placed in a document, in the editor's terms: 0-based, UTF-16. */
export interface Correction {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  replacement: string;
  /** Severity 2, which the extension showed as "Spellcheck" at Information. */
  spelling: boolean;
}

/**
 * Where each finding sits in `text`, or nothing for one that is not there.
 *
 * The engine counts columns in characters and the editor in UTF-16 code units,
 * and they part ways at the first character outside the BMP: an emoji earlier
 * on the line puts the extension's range one unit early per emoji, so its
 * quick fix overwrote the wrong text. A finding whose text is not where it
 * says is dropped rather than trusted, because a quick fix applies blind.
 */
export function corrections(text: string, findings: readonly Finding[]): Correction[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  return findings.flatMap((finding) => {
    const line = finding.l - 1;
    if (line < 0 || line >= starts.length) {
      return [];
    }
    const lineText = text.slice(starts[line], starts[line + 1] ?? text.length);
    const character = [...lineText].slice(0, finding.c - 1).join("").length;
    const start = starts[line] + character;
    if (text.slice(start, start + finding.old.length) !== finding.old) {
      return [];
    }
    const rows = finding.old.split("\n");
    return [{
      line,
      character,
      endLine: line + rows.length - 1,
      endCharacter: rows.length === 1 ? character + finding.old.length : rows[rows.length - 1].length,
      replacement: finding.new,
      spelling: finding.severity === 2,
    }];
  });
}

/**
 * The lines `after` changes in `before`, each as its new text, or `null` when
 * the two do not have the same lines to compare.
 *
 * Fix on save replaces changed lines rather than the whole document: a
 * whole-document edit moves the cursor, scrolls, and drops folds and
 * breakpoints in every line it did not need to touch. AutoCorrect only ever
 * changes text within a line, so the line counts match; `null` is the case
 * where they somehow do not, and the caller replaces everything.
 */
export function lineEdits(before: string, after: string): { line: number; text: string }[] | null {
  const was = before.split(/\r?\n/);
  const now = after.split(/\r?\n/);
  if (was.length !== now.length) {
    return null;
  }
  return was.flatMap((text, line) => (text === now[line] ? [] : [{ line, text: now[line] }]));
}

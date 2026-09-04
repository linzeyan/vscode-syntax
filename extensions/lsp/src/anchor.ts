/**
 * Where a file-level CodeLens goes.
 *
 * Not line 0. The top of a source file is where the things that are not code
 * live: a shebang, a licence header, a `//go:build` constraint, a block comment
 * with the copyright in it. A lens anchored above those sits in a region the
 * reader is already skipping, and — worse — a lens anchored to a line that is
 * not there at all silently stops rendering, which looks exactly like a feature
 * that was never wired up.
 *
 * This started as "find the `package` clause", which was right for Go and only
 * for Go. The general rule is the one Go's case was an instance of: the first
 * line that is actually code.
 */

/** Line-comment markers, by the languages poly puts a file-level lens on. */
const LINE_COMMENT: Readonly<Record<string, readonly string[]>> = {
  go: ["//"],
  rust: ["//"],
  typescript: ["//"],
  typescriptreact: ["//"],
  javascript: ["//"],
  javascriptreact: ["//"],
  python: ["#"],
  lua: ["--"],
};

/** Languages whose block comments this has to step over. */
const BLOCK = new Set([
  "go",
  "rust",
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
]);

/** As much of `vscode.TextDocument` as the scan below reads. */
export interface Lines {
  readonly languageId: string;
  readonly lineCount: number;
  lineAt(line: number): { readonly text: string };
}

/**
 * How far down to look before giving up.
 *
 * A file whose first 200 lines are all header is not one this needs to get
 * right, and scanning a 40k-line generated file to find that out is work for
 * nothing.
 */
const LIMIT = 200;

/**
 * The first line of `document` that is code, or `undefined` if there is none.
 *
 * Blank lines, shebangs, line comments and block comments are stepped over. A
 * language this does not know gets its first non-blank line, which is the
 * honest answer: without a comment marker there is nothing to skip.
 */
export function firstCodeLine(document: Lines): number | undefined {
  const markers = LINE_COMMENT[document.languageId] ?? [];
  const blocks = BLOCK.has(document.languageId);
  const limit = Math.min(document.lineCount, LIMIT);
  let inBlock = false;
  for (let line = 0; line < limit; line++) {
    const text = document.lineAt(line).text.trim();
    if (inBlock) {
      // The terminator can share a line with code, but a lens is per line, so
      // the line the comment ends on is close enough to be the wrong place to
      // stop: take the next one.
      if (text.includes("*/")) {
        inBlock = false;
      }
      continue;
    }
    if (text === "") {
      continue;
    }
    // Only on line 0, because `#!` is a comment nowhere else and a `#!` in the
    // middle of a Python file is an expression.
    if (line === 0 && text.startsWith("#!")) {
      continue;
    }
    if (markers.some((marker) => text.startsWith(marker))) {
      continue;
    }
    if (blocks && text.startsWith("/*")) {
      // A one-line `/* ... */` opens and closes here; anything else runs on.
      if (!text.slice(2).includes("*/")) {
        inBlock = true;
      }
      continue;
    }
    return line;
  }
  return undefined;
}

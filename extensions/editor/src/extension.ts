import * as path from "path";
import * as vscode from "vscode";

import { toc, TOC_END, TOC_START } from "./markdown";

/**
 * A `path:line` reference, in the shape poly's diagnostics already print.
 *
 * VSCode's own Copy Relative Path stops at the path; the line is the whole
 * delta. It matters because the result is not prose -- `src/lib.rs:42` is what
 * rg prints, what a CI annotation links to, and what a terminal turns into a
 * clickable jump. A reference that agrees with those is one the reader can act
 * on without translating it first.
 *
 * A multi-line selection becomes `path:42-51`; anything else is the cursor's
 * own line. Forward slashes on every platform, because the consumers above are
 * the same tools on Windows.
 */
function reference(editor: vscode.TextEditor): string {
  const uri = editor.document.uri;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const relative = folder
    ? path.relative(folder.uri.fsPath, uri.fsPath)
    : uri.fsPath;
  const file = relative.split(path.sep).join("/");

  const selection = editor.selection;
  const start = selection.start.line + 1;
  // A selection that ends at column 0 stopped at the line break rather than
  // reaching into that line, so the line the user dragged past is not part of
  // what they selected.
  const last = selection.end.character === 0 && selection.end.line > selection.start.line
    ? selection.end.line
    : selection.end.line + 1;
  return start === last ? `${file}:${start}` : `${file}:${start}-${last}`;
}

/** Is `text` its own pair of markers, rather than one empty pair? */
function wrapped(text: string, marker: string): boolean {
  return text.length > marker.length * 2
    && text.startsWith(marker)
    && text.endsWith(marker);
}

/**
 * The range including the markers that already surround `range`, if they do.
 *
 * Toggling off has to work on the selection someone actually makes, and after
 * a previous toggle that is usually the text *between* the markers rather than
 * the markers with it.
 */
function surrounding(
  document: vscode.TextDocument,
  range: vscode.Range,
  marker: string,
): vscode.Range | undefined {
  const start = document.offsetAt(range.start) - marker.length;
  if (start < 0) {
    return undefined;
  }
  const end = document.offsetAt(range.end) + marker.length;
  const outer = new vscode.Range(document.positionAt(start), document.positionAt(end));
  const text = document.getText(outer);
  // positionAt clamps at the end of the document, so a short result means the
  // closing marker would have run past it and is not there.
  const complete = text.length === document.getText(range).length + marker.length * 2;
  return complete && text.startsWith(marker) && text.endsWith(marker)
    ? outer
    : undefined;
}

/**
 * Wrap or unwrap every selection with `marker`.
 *
 * `**` for strong and `_` for emphasis, which is what `poly fmt` normalizes
 * markdown to -- a toggle that produced the other spelling would be undone by
 * the next save, and the two commands would be quietly fighting each other.
 */
async function toggleEmphasis(
  editor: vscode.TextEditor,
  marker: string,
): Promise<void> {
  const document = editor.document;
  const targets = editor.selections.map((selection) =>
    selection.isEmpty
      // An empty selection means the word the cursor is in, which is what
      // anyone who hits the shortcut mid-word meant by it.
      ? document.getWordRangeAtPosition(selection.active)
        ?? new vscode.Range(selection.active, selection.active)
      : new vscode.Range(selection.start, selection.end)
  );

  await editor.edit((builder) => {
    for (const range of targets) {
      const text = document.getText(range);
      if (wrapped(text, marker)) {
        builder.replace(range, text.slice(marker.length, text.length - marker.length));
        continue;
      }
      const outer = surrounding(document, range, marker);
      if (outer) {
        builder.replace(outer, text);
        continue;
      }
      builder.replace(range, `${marker}${text}${marker}`);
    }
  });
}

/** The block a previous run wrote, or why there is no usable one. */
function tocRange(
  document: vscode.TextDocument,
): vscode.Range | "unterminated" | undefined {
  const text = document.getText();
  const start = text.indexOf(TOC_START);
  if (start < 0) {
    return undefined;
  }
  const end = text.indexOf(TOC_END, start + TOC_START.length);
  return end < 0
    ? "unterminated"
    : new vscode.Range(
      document.positionAt(start),
      document.positionAt(end + TOC_END.length),
    );
}

async function insertToc(editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  if (document.languageId !== "markdown") {
    vscode.window.showWarningMessage(
      `Poly: Insert Table of Contents needs a markdown file (this one is ${document.languageId})`,
    );
    return;
  }
  const lines = toc(document.getText());
  if (lines.length === 0) {
    vscode.window.showWarningMessage(
      "Poly: this document has no headings below its title, so there is nothing to list",
    );
    return;
  }
  const existing = tocRange(document);
  if (existing === "unterminated") {
    // Guessing where the block ends would mean overwriting whatever follows.
    vscode.window.showWarningMessage(
      `Poly: found ${TOC_START} with no ${TOC_END}; add the closing marker or delete the opening one`,
    );
    return;
  }
  const block = [TOC_START, ...lines, TOC_END].join("\n");
  await editor.edit((builder) => {
    if (existing) {
      builder.replace(existing, block);
    } else {
      builder.insert(editor.selection.active, `${block}\n`);
    }
  });
}

/** Run `action` against the active editor, or say why it cannot run. */
function withEditor(
  what: string,
  action: (editor: vscode.TextEditor) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      // Said out loud rather than swallowed: every command here is in the
      // palette, so each can be invoked with no editor at all, and silence
      // reads as a broken command rather than an inapplicable one.
      vscode.window.showWarningMessage(`Poly: ${what} needs an open editor`);
      return;
    }
    await action(editor);
  };
}

export function activate(context: vscode.ExtensionContext) {
  const commands: [string, () => Promise<void>][] = [
    [
      "poly.copyPathWithLine",
      withEditor("Copy Path with Line Numbers", async (editor) => {
        const text = reference(editor);
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage(`Copied ${text}`, 3000);
      }),
    ],
    [
      "poly.insertTableOfContents",
      withEditor("Insert Table of Contents", insertToc),
    ],
    [
      "poly.toggleBold",
      withEditor("Toggle Bold", (editor) => toggleEmphasis(editor, "**")),
    ],
    [
      "poly.toggleItalic",
      withEditor("Toggle Italic", (editor) => toggleEmphasis(editor, "_")),
    ],
  ];
  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }
}

export function deactivate() {}

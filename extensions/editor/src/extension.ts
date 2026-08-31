import * as path from "path";
import * as vscode from "vscode";

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

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("poly.copyPathWithLine", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        // Said out loud rather than swallowed: the command is in the palette,
        // so it can be invoked with no editor at all, and a clipboard that
        // silently keeps its old contents is worse than a refusal.
        vscode.window.showWarningMessage(
          "Poly: Copy Path with Line Numbers needs an open editor",
        );
        return;
      }
      const text = reference(editor);
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage(`Copied ${text}`, 3000);
    }),
  );
}

export function deactivate() {}

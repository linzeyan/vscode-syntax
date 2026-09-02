import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { nextChangedFile } from "./changes";
import { imageReferences } from "./images";
import { indentSpans } from "./indent";
import { toc, TOC_END, TOC_START } from "./markdown";
import { countReferences, lensTargets, refLabel } from "./references";
import { registerTodoTree } from "./todoTree";

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

/**
 * Indent tinting, wired to the editor.
 *
 * Only the visible lines are decorated. A decoration per indent level over a
 * whole file is thousands of ranges that nobody is looking at, and the events
 * that change what is visible are the same ones that would have to invalidate
 * a cache anyway.
 */
function tintIndentation(context: vscode.ExtensionContext): void {
  const tints = [1, 2, 3, 4].map((n) =>
    vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor(`poly.indentLevel${n}`),
    })
  );
  const partial = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("poly.indentPartial"),
  });
  context.subscriptions.push(partial, ...tints);

  const paint = (editor: vscode.TextEditor) => {
    const byLevel: vscode.Range[][] = tints.map(() => []);
    const odd: vscode.Range[] = [];
    const on = vscode.workspace
      .getConfiguration("poly")
      .get<boolean>("indentTint.enabled", true);
    if (on) {
      // `editor.options.tabSize` is what the editor resolved -- from the
      // language, the file, or `editor.detectIndentation` -- so this follows
      // the same width the reader is actually looking at.
      const tabSize = typeof editor.options.tabSize === "number"
        ? editor.options.tabSize
        : 4;
      for (const visible of editor.visibleRanges) {
        for (let line = visible.start.line; line <= visible.end.line; line++) {
          for (const span of indentSpans(editor.document.lineAt(line).text, tabSize)) {
            const range = new vscode.Range(line, span.start, line, span.end);
            if (span.partial) {
              odd.push(range);
            } else {
              byLevel[span.level % byLevel.length].push(range);
            }
          }
        }
      }
    }
    tints.forEach((tint, i) => editor.setDecorations(tint, byLevel[i]));
    editor.setDecorations(partial, odd);
  };

  // Typing produces a change event per keystroke, and repainting on each one
  // is work thrown away by the next. One frame of lag is not visible; the
  // repaints are.
  let pending: NodeJS.Timeout | undefined;
  const repaintAll = () => {
    clearTimeout(pending);
    pending = setTimeout(() => vscode.window.visibleTextEditors.forEach(paint), 50);
  };
  context.subscriptions.push({ dispose: () => clearTimeout(pending) });

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(repaintAll),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => paint(event.textEditor)),
    vscode.window.onDidChangeTextEditorOptions((event) => paint(event.textEditor)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.visibleTextEditors.some((e) => e.document === event.document)) {
        repaintAll();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.indentTint")) {
        repaintAll();
      }
    }),
  );
  vscode.window.visibleTextEditors.forEach(paint);
}

/**
 * The image a line refers to, if exactly one of its candidates is a real file.
 *
 * Resolved against the document's own directory first and the workspace root
 * second, which covers both `./logo.png` next to the file and `/assets/logo.png`
 * written the way a web server will serve it.
 */
function imageOnLine(document: vscode.TextDocument, text: string): string | undefined {
  const here = path.dirname(document.uri.fsPath);
  const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
  for (const reference of imageReferences(text)) {
    const bases = path.isAbsolute(reference.path)
      // An absolute path in source is usually server-absolute, not disk-
      // absolute, so the workspace root is the more useful reading of it --
      // but try the literal one too, because sometimes it is just a path.
      ? [root, undefined]
      : [here, root];
    for (const base of bases) {
      const file = base === undefined
        ? reference.path
        : path.join(base, reference.path.replace(/^[/\\]+/, ""));
      try {
        if (fs.statSync(file).isFile()) {
          return file;
        }
      } catch {
        // Not there. That is the filter, not an error.
      }
    }
  }
  return undefined;
}

/**
 * A thumbnail in the gutter for every visible line that names an image.
 *
 * `gutterIconPath` belongs to the decoration *type*, not to a range, so there
 * has to be one type per distinct image. They are cached across repaints and
 * disposed with the extension; the cache is bounded because a file only has so
 * many visible lines.
 */
function previewImages(context: vscode.ExtensionContext): void {
  const types = new Map<string, vscode.TextEditorDecorationType>();
  context.subscriptions.push({
    dispose: () => types.forEach((type) => type.dispose()),
  });

  const paint = (editor: vscode.TextEditor) => {
    const shown = new Map<string, vscode.Range[]>();
    const on = vscode.workspace
      .getConfiguration("poly")
      .get<boolean>("imagePreview.enabled", true);
    if (on && editor.document.uri.scheme === "file") {
      for (const visible of editor.visibleRanges) {
        for (let line = visible.start.line; line <= visible.end.line; line++) {
          const file = imageOnLine(editor.document, editor.document.lineAt(line).text);
          if (!file) {
            continue;
          }
          if (!types.has(file)) {
            types.set(
              file,
              vscode.window.createTextEditorDecorationType({
                gutterIconPath: vscode.Uri.file(file),
                gutterIconSize: "contain",
              }),
            );
          }
          const ranges = shown.get(file) ?? [];
          ranges.push(new vscode.Range(line, 0, line, 0));
          shown.set(file, ranges);
        }
      }
    }
    // Every known type is set on this editor, including to nothing: a type
    // left alone keeps whatever it was showing the last time this editor
    // scrolled past that line.
    for (const [file, type] of types) {
      editor.setDecorations(type, shown.get(file) ?? []);
    }
  };

  let pending: NodeJS.Timeout | undefined;
  const repaintAll = () => {
    clearTimeout(pending);
    // Slower than the indent repaint on purpose: this one stats files, and
    // nobody needs a thumbnail to keep up with typing.
    pending = setTimeout(() => vscode.window.visibleTextEditors.forEach(paint), 250);
  };
  context.subscriptions.push({ dispose: () => clearTimeout(pending) });

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(repaintAll),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => paint(event.textEditor)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.visibleTextEditors.some((e) => e.document === event.document)) {
        repaintAll();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.imagePreview")) {
        repaintAll();
      }
    }),
  );
  vscode.window.visibleTextEditors.forEach(paint);
}

/**
 * A lens that remembers which declaration it is counting.
 *
 * `vscode.CodeLens` carries only a range, and resolution happens later and out
 * of order; the editor hands back the same object, so the uri rides on it.
 */
class ReferenceLens extends vscode.CodeLens {
  constructor(readonly uri: vscode.Uri, range: vscode.Range) {
    super(range);
  }
}

/**
 * How many declarations in one file may carry a lens.
 *
 * A generated protobuf stub is thousands of symbols and a lens each is a wall
 * of grey above code nobody reads. It caps the list, not the cost: the editor
 * resolves only the lenses on screen, which is what keeps this to one reference
 * query per visible declaration rather than one per declaration in the file.
 */
const MAX_LENSES = 300;

/**
 * `N refs` over every declaration, for any language that can answer.
 *
 * The count comes from `vscode.executeReferenceProvider`, which is to say from
 * whichever provider is registered — for Go that is poly-lsp's proxy in front
 * of gopls. poly analyses nothing here; see `references.ts`.
 */
function countReferencesInGutter(context: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<void>();
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,

    async provideCodeLenses(document) {
      const config = vscode.workspace.getConfiguration("poly");
      if (!config.get<boolean>("referencesCodeLens.enabled", true)) {
        return [];
      }
      const languages = config.get<string[]>("referencesCodeLens.languages", []);
      if (!languages.includes(document.languageId)) {
        return [];
      }
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >("vscode.executeDocumentSymbolProvider", document.uri);
      // No symbol provider, or one that has not finished loading the project.
      // Either way there is nothing to hang a count on yet.
      if (!symbols) {
        return [];
      }
      return lensTargets(symbols, MAX_LENSES).map(
        (symbol) => new ReferenceLens(document.uri, symbol.selectionRange),
      );
    },

    async resolveCodeLens(lens) {
      const at = (lens as ReferenceLens).uri;
      const start = lens.range.start;
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        at,
        start,
      );
      const count = countReferences(
        (locations ?? []).map((location) => ({
          uri: location.uri.toString(),
          line: location.range.start.line,
        })),
        { uri: at.toString(), line: start.line },
      );
      lens.command = {
        title: refLabel(count),
        // The built-in references-view activates on this command and shows its
        // tree instead of the peek when `references.preferredLocation` is
        // "view", so the user's own setting decides which one opens rather than
        // poly picking for them. It is the command VSCode's own TypeScript
        // reference lens uses, and that setting exists to steer exactly this.
        // Nothing to open when nothing refers to it, so the lens is text.
        command: count > 0 ? "editor.action.showReferences" : "",
        arguments: [at, start, locations ?? []],
      };
      return lens;
    },
  };

  context.subscriptions.push(
    changed,
    // Every file scheme, filtered by language inside: the setting is a list of
    // language ids, and a selector built from it at registration time would go
    // stale the moment it changed.
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.referencesCodeLens")) {
        changed.fire();
      }
    }),
  );
}

/**
 * As much of the built-in git extension's API as the two commands below need.
 *
 * Declared here rather than pulled in from `@types/vscode.git`: this is four
 * fields, and the alternative is a dependency whose whole job is to describe an
 * extension that may not even be enabled.
 */
interface GitChange {
  readonly uri: vscode.Uri;
}
interface GitRepository {
  readonly state: {
    readonly workingTreeChanges: readonly GitChange[];
    readonly indexChanges: readonly GitChange[];
  };
}
interface GitExtension {
  getAPI(version: 1): { readonly repositories: readonly GitRepository[] };
}

/** Every path git reports as changed, across all open repositories. */
async function changedFiles(): Promise<string[] | undefined> {
  const git = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!git) {
    return undefined;
  }
  const exports = git.isActive ? git.exports : await git.activate();
  return exports.getAPI(1).repositories.flatMap((repo) =>
    [...repo.state.workingTreeChanges, ...repo.state.indexChanges]
      // Staged deletions and merge conflicts show up here too; a path with no
      // file behind it would open an empty editor.
      .filter((change) => change.uri.scheme === "file")
      .map((change) => change.uri.fsPath)
  );
}

/**
 * Open the next (or previous) file with changes and land on a change in it.
 *
 * VSCode has next/previous change within a file and a list of changed files in
 * the SCM view; what it has no command for is the step between two files, which
 * is the one a review pass makes most often.
 */
async function stepChangedFile(direction: 1 | -1): Promise<void> {
  const files = await changedFiles();
  if (files === undefined) {
    vscode.window.showWarningMessage(
      "Poly: the built-in git extension is disabled, so there are no changes to walk",
    );
    return;
  }
  const here = vscode.window.activeTextEditor?.document.uri;
  const target = nextChangedFile(
    files,
    here?.scheme === "file" ? here.fsPath : undefined,
    direction,
  );
  if (target === undefined) {
    vscode.window.setStatusBarMessage("Poly: no changed files", 3000);
    return;
  }

  const editor = await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument(target),
  );
  // The quick diff for a file that was not open yet is computed asynchronously,
  // and the built-in navigation does nothing while it has no changes -- so a
  // single call would leave the cursor at the top of the file it just opened,
  // which is the one place we know the change is not. Retry briefly instead of
  // guessing a delay long enough to always work.
  const command = direction === 1
    ? "workbench.action.editor.nextChange"
    : "workbench.action.editor.previousChange";
  const before = editor.selection.active;
  for (let attempt = 0; attempt < 10; attempt++) {
    await vscode.commands.executeCommand(command);
    if (!editor.selection.active.isEqual(before)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function activate(context: vscode.ExtensionContext) {
  tintIndentation(context);
  previewImages(context);
  countReferencesInGutter(context);
  registerTodoTree(context);

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
    ["poly.nextChangedFile", () => stepChangedFile(1)],
    ["poly.previousChangedFile", () => stepChangedFile(-1)],
    [
      "poly.revertAndSave",
      withEditor("Revert and Save", async () => {
        // Both halves are built in; what is missing is that they are one
        // gesture. Reverting a hunk and leaving the file dirty means the next
        // save is what actually decides, so the undo is only half done until a
        // second keystroke -- and the file on disk disagrees with the editor in
        // between.
        await vscode.commands.executeCommand("git.revertSelectedRanges");
        await vscode.commands.executeCommand("workbench.action.files.save");
      }),
    ],
  ];
  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }
}

export function deactivate() {}

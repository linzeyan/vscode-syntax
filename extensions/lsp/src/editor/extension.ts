import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { nextChangedFile } from "./changes";
import { Binding, YIELDING, yieldKey, yieldsTo } from "./chords";
import { imageReferences } from "./images";
import { indentSpans } from "./indent";
import {
  Dialect,
  enterAction,
  indentTarget,
  listItem,
  movedWith,
  outdentTarget,
  renumberedAfterMove,
  renumberedTail,
  Rewrite,
} from "./list";
import { toc, TOC_END, TOC_START } from "./markdown";
import { mermaidPlugin } from "./markdownIt";
import { methodLabel, methodsByType } from "./methods";
import { describe, EXPR_MARK, POSTFIX_LANGUAGES, postfixesFor, postfixTarget } from "./postfix";
import { generatedFiles, goLinksFor, goServerMethod, protoPackage } from "./protobuf";
import { refactorChoices, Refactoring, REFACTORINGS } from "./refactors";
import {
  Answered,
  declarationKeys,
  Direction,
  elsewhere,
  implLabel,
  LensTarget,
  lensTargets,
  nameStart,
  refLabel,
} from "./references";
import { ReferenceTree, registerReferenceTree } from "./referenceTree";
import { cacheDir, RefStore } from "./refStore";
import { entryLine, entryPoints, findsEntryInText, runLine } from "./runnable";
import { colorSheet, scopesIn } from "./scopes";
import { offerMessage, serverToOffer } from "./servers";
import { registerTodoTree } from "./todoTree";
import { drawsNothing, explain, findSuspects, label, Level, levelOf, Suspect, SUSPECTS } from "./unicode";

/** Languages already offered a server this session — see `offerServer`. */
const offered = new Set<string>();

/**
 * The editor features' own log, "Poly Editor" in the Output panel -- apart
 * from "Poly", which is the daemon's and too busy to find a lens decision in.
 *
 * There was none until 0.18.1: a lens that decided to draw nothing said so to
 * nobody, and an exception in one landed in the extension host's log where no
 * one looking for poly would find it. A `LogOutputChannel`, so the lens's
 * per-file decisions can sit at debug level -- invisible until someone chasing
 * a missing lens turns them on with "Developer: Set Log Level".
 */
let log: vscode.LogOutputChannel | undefined;

/**
 * Say why a lens that is switched on is drawing nothing, once.
 *
 * Called only where a provider has already been asked and come back empty, so
 * this never fires for someone whose official extension is answering happily.
 * Silent unless `poly.languageServers` is off: it is the only setting this can
 * offer, and offering to change one that is already on would be advice that
 * does nothing.
 */
async function offerServer(what: string, languageId: string): Promise<void> {
  const server = serverToOffer(languageId, offered);
  if (!server) {
    return;
  }
  const config = vscode.workspace.getConfiguration("poly");
  if (config.get<boolean>("languageServers", false)) {
    return;
  }
  offered.add(languageId);
  const pick = await vscode.window.showInformationMessage(
    offerMessage(what, languageId, server),
    "Enable and Reload",
    "Not now",
  );
  if (pick === "Enable and Reload") {
    // The daemon reads this when it spawns, so a running one keeps the answer
    // it started with -- which is why the offer says "and reload" rather than
    // leaving the user to discover that it changed nothing.
    await config.update("languageServers", true, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

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

/** One replacement, and how far it moves a cursor that was inside it. */
interface Emphasis {
  start: number;
  end: number;
  text: string;
  /** Markers added before the caret shift it right; removed ones, left. */
  inner: number;
}

/** What toggling `marker` does to `range`, as offsets into the document. */
function emphasisEdit(
  document: vscode.TextDocument,
  range: vscode.Range,
  marker: string,
): Emphasis {
  const text = document.getText(range);
  const start = document.offsetAt(range.start);
  if (wrapped(text, marker)) {
    return {
      start,
      end: document.offsetAt(range.end),
      text: text.slice(marker.length, text.length - marker.length),
      inner: -marker.length,
    };
  }
  const outer = surrounding(document, range, marker);
  if (outer) {
    return {
      start: document.offsetAt(outer.start),
      end: document.offsetAt(outer.end),
      text,
      inner: -marker.length,
    };
  }
  return {
    start,
    end: document.offsetAt(range.end),
    text: `${marker}${text}${marker}`,
    inner: marker.length,
  };
}

/**
 * Where `offset` ends up once every edit has been applied.
 *
 * A caret inside the text being wrapped has to travel with the character it was
 * on, or bolding a word leaves the caret two columns from where its owner put
 * it and the next keystroke lands in the wrong place. Boundaries deliberately
 * do not travel: a selection of the whole word still contains the whole word,
 * markers and all.
 */
function movedBy(offset: number, edits: Emphasis[]): number {
  let shift = 0;
  for (const edit of edits) {
    // An edit with nothing between its ends is a pair of markers opened where
    // the caret was -- Ctrl+B on an empty line. Both rules below claim that
    // offset, and "after the edit" is the wrong winner: it leaves the caret
    // past the closing marker, so the word it was about to bold is not bolded.
    if (edit.start === edit.end && offset === edit.start) {
      return offset + edit.inner + shift;
    }
    if (offset >= edit.end) {
      shift += edit.text.length - (edit.end - edit.start);
    } else if (offset > edit.start) {
      const inside = Math.min(
        Math.max(offset + edit.inner, edit.start),
        edit.start + edit.text.length,
      );
      return inside + shift;
    }
  }
  return offset + shift;
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
  const edits = targets
    .map((range) => emphasisEdit(document, range, marker))
    .sort((a, b) => a.start - b.start);
  // Captured as offsets before the edit, because the Position objects are about
  // to describe a document that no longer exists.
  const carets = editor.selections.map((selection) => ({
    anchor: document.offsetAt(selection.anchor),
    active: document.offsetAt(selection.active),
  }));

  await editor.edit((builder) => {
    for (const edit of edits) {
      builder.replace(
        new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
        edit.text,
      );
    }
  });

  editor.selections = carets.map(({ anchor, active }) =>
    new vscode.Selection(
      document.positionAt(movedBy(anchor, edits)),
      document.positionAt(movedBy(active, edits)),
    )
  );
}

/**
 * The language ids that are markdown, whatever VSCode calls them.
 *
 * `prompt-basics` takes `SKILL.md`, `*.prompt.md`, `*.instructions.md`,
 * `.claude/rules/**`, `.claude/agents/**` and friends away from the `markdown`
 * id, and it contributes no list behaviour of its own. Anything keyed on
 * `markdown` alone silently stops working in exactly the files that are most
 * often edited as markdown. The same list is spelled out in the `when` clauses
 * in package.json, which cannot read this one.
 */
const MARKDOWN_LANGUAGES = new Set([
  "markdown",
  "prompt",
  "instructions",
  "chatagent",
  "skill",
]);

/**
 * The list dialect each language id speaks.
 *
 * The markdown family shares one. yaml is its own: `>` opens a folded block
 * scalar there and `1.` is just a string, so continuing either the way
 * markdown does would corrupt the file.
 */
const DIALECTS = new Map<string, Dialect>([
  ...[...MARKDOWN_LANGUAGES].map((id): [string, Dialect] => [id, "markdown"]),
  ["yaml", "yaml"],
]);

/**
 * Enter inside a list item.
 *
 * Bound to Enter, so -- like the Tab commands -- every path it does not handle
 * forwards to what the key already did, and the `when` clause keeps it away
 * from the widgets that own Enter (suggestions, snippets, inline suggestions).
 *
 * It exists because a language-configuration `onEnterRules` can only append a
 * fixed string: it cannot count an ordered list up, and it cannot end one. A
 * side effect worth having is that this does not depend on tokenization, while
 * `onEnterRules` is skipped outright until the line has been tokenized -- which
 * is why continuation used to fail for the first moment after a large file
 * opened.
 */
async function continueList(editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  const cursor = editor.selection.active;
  const line = document.lineAt(cursor.line);
  const dialect = DIALECTS.get(document.languageId);
  const item = dialect ? listItem(line.text, dialect) : undefined;
  // Left of the content there is no item to continue yet, only a marker being
  // typed -- and inserting one there would push the marker into its own line.
  const lines = document.getText().split(/\r?\n/);
  const action = dialect && item && editor.selection.isEmpty
      && cursor.character >= item.contentColumn
    ? enterAction(lines, cursor.line, dialect, cursor.character)
    : undefined;
  if (!action) {
    await vscode.commands.executeCommand("type", { text: "\n" });
    return;
  }
  // Every range below is a position in the document as it is now, because a
  // single edit() applies them all against that one snapshot -- which is why
  // the renumbering is computed from the same `lines` the action was.
  const rewrites = action.kind === "continue" && dialect
    ? [...action.also, ...renumberedTail(lines, cursor.line, dialect)]
    : action.also;
  await editor.edit((builder) => {
    if (action.kind === "continue") {
      builder.insert(cursor, `\n${action.text}`);
    } else {
      builder.replace(line.range, action.text);
    }
    apply(builder, rewrites);
  });
}

/** Every span, as ranges in the document the edit is being built against. */
function apply(builder: vscode.TextEditorEdit, rewrites: readonly Rewrite[]): void {
  for (const rewrite of rewrites) {
    builder.replace(
      new vscode.Range(rewrite.line, rewrite.start, rewrite.line, rewrite.end),
      rewrite.text,
    );
  }
}

/**
 * Tab and Shift+Tab over a list item.
 *
 * Bound to Tab, so every case this does not handle has to behave exactly as if
 * it were not bound at all -- hence the fallback to the built-in command
 * rather than an early return. It takes over only while the cursor is still at
 * or left of the item's content: once there is text being typed past the
 * marker, Tab belongs to typing.
 */
async function shiftListItem(
  editor: vscode.TextEditor,
  direction: "indent" | "outdent",
): Promise<void> {
  const fallback = direction === "indent" ? "tab" : "outdent";
  const document = editor.document;
  const cursor = editor.selection.active;
  const item = MARKDOWN_LANGUAGES.has(document.languageId) && editor.selection.isEmpty
    ? listItem(document.lineAt(cursor.line).text)
    : undefined;
  // Read once and only when the key is this command's to take: every other Tab
  // press in a markdown file reaches here too, and splitting the document to
  // decide it is not is work nobody asked for.
  const mine = item !== undefined && cursor.character <= item.contentColumn;
  const lines = mine ? document.getText().split(/\r?\n/) : [];
  const target = mine
    ? (direction === "indent" ? indentTarget : outdentTarget)(lines, cursor.line)
    : undefined;
  if (target === undefined || !item) {
    await vscode.commands.executeCommand(fallback);
    return;
  }
  // Moving an item between two levels leaves both of the ordered lists it
  // touched counting wrong, and takes the item's own content with it -- its
  // wrapped paragraph and its child lists, which mean nothing at the column
  // they were left at. All of it in the same edit, so the whole move is one undo.
  const renumbers = [
    ...renumberedAfterMove(lines, cursor.line, target),
    ...movedWith(lines, cursor.line, target),
  ];
  await editor.edit((builder) => {
    builder.replace(
      new vscode.Range(cursor.line, 0, cursor.line, item.indent.length),
      target,
    );
    apply(builder, renumbers);
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
  if (!MARKDOWN_LANGUAGES.has(document.languageId)) {
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
      .get<boolean>("indentTint.enabled", false);
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

const UNICODE_COLORS: Readonly<Record<Level, string>> = {
  error: "poly.unicodeError",
  warning: "poly.unicodeWarning",
  info: "poly.unicodeInfo",
};

/**
 * The unicode highlight, wired to the editor: gremlins' drawing over poly's
 * table.
 *
 * The whole document rather than the visible lines, unlike the indent tint.
 * The overview ruler is the point of it -- a zero-width space three screens
 * down is found by its tick in the scrollbar or not at all.
 */
function highlightUnicode(context: vscode.ExtensionContext): void {
  const on = () =>
    vscode.workspace
      .getConfiguration("poly")
      .get<boolean>("unicodeHighlight.enabled", false);
  const types = new Map<string, vscode.TextEditorDecorationType>();
  const typeOf = (level: Level, outline: boolean) => {
    const key = `${level}:${outline}`;
    let type = types.get(key);
    if (!type) {
      const color = new vscode.ThemeColor(UNICODE_COLORS[level]);
      type = vscode.window.createTextEditorDecorationType({
        gutterIconPath: context.asAbsolutePath(`media/unicode-${level}.svg`),
        gutterIconSize: "contain",
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        ...(outline
          ? { borderWidth: "1px", borderStyle: "solid", borderColor: color }
          : { backgroundColor: color }),
      });
      types.set(key, type);
    }
    return type;
  };
  context.subscriptions.push({ dispose: () => types.forEach((type) => type.dispose()) });
  // The name goes at the end of the line rather than beside the character: a
  // name is several words, and inline it would push the rest of the line aside
  // at every curly quote in a paragraph. The mark says where, this says what,
  // and it is muted like a code lens because the mark is what should catch the
  // eye. Italic, or in the same monospace as the line it reads as part of the
  // file. Styled per instance, since the text is.
  const names = vscode.window.createTextEditorDecorationType({});
  context.subscriptions.push(names);
  const nameColor = new vscode.ThemeColor("editorCodeLens.foreground");

  const paint = (editor: vscode.TextEditor) => {
    const ranges = new Map<vscode.TextEditorDecorationType, vscode.Range[]>(
      [...types.values()].map((type) => [type, []]),
    );
    const tags: vscode.DecorationOptions[] = [];
    if (on()) {
      const { document } = editor;
      const lines = new Map<number, Suspect[]>();
      for (const { offset, suspect } of findSuspects(document.getText())) {
        const start = document.positionAt(offset);
        const type = typeOf(levelOf(suspect), drawsNothing(suspect));
        const list = ranges.get(type) ?? [];
        list.push(new vscode.Range(start, start.translate(0, 1)));
        ranges.set(type, list);
        const onLine = lines.get(start.line) ?? [];
        onLine.push(suspect);
        lines.set(start.line, onLine);
      }
      lines.forEach((suspects, line) => {
        const end = document.lineAt(line).range.end;
        tags.push({
          range: new vscode.Range(end, end),
          renderOptions: {
            after: { contentText: label(suspects), color: nameColor, fontStyle: "italic", margin: "0 0 0 2ch" },
          },
        });
      });
    }
    // Every type, including the ones with nothing to draw now: setting an
    // empty list is the only way to clear what the last paint left.
    ranges.forEach((list, type) => editor.setDecorations(type, list));
    editor.setDecorations(names, tags);
  };

  // Same debounce as the indent tint, for the same reason.
  let pending: NodeJS.Timeout | undefined;
  const repaintAll = () => {
    clearTimeout(pending);
    pending = setTimeout(() => vscode.window.visibleTextEditors.forEach(paint), 50);
  };
  context.subscriptions.push({ dispose: () => clearTimeout(pending) });

  const code = (d: vscode.Diagnostic) => String(typeof d.code === "object" ? d.code.value : d.code);
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(repaintAll),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.visibleTextEditors.some((e) => e.document === event.document)) {
        repaintAll();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.unicodeHighlight")) {
        repaintAll();
      }
    }),
    // A provider rather than a `hoverMessage` on each range: the text is built
    // for the one character under the pointer instead of for every character
    // in the file on every keystroke.
    vscode.languages.registerHoverProvider("*", {
      provideHover(document, position) {
        if (!on()) {
          return undefined;
        }
        const text = document.lineAt(position.line).text;
        const at = (character: number) => {
          const suspect = SUSPECTS.get(text.charCodeAt(character));
          const bom = suspect?.codePoint === 0xfeff && position.line === 0 && character === 0;
          return suspect && !bom ? { suspect, character } : undefined;
        };
        // The character under the pointer, or a zero-width one just before
        // it: something with no width has no glyph to point at.
        const before = at(position.character - 1);
        const hit = at(position.character) ?? (before && drawsNothing(before.suspect) ? before : undefined);
        if (!hit) {
          return undefined;
        }
        const range = new vscode.Range(position.line, hit.character, position.line, hit.character + 1);
        // Once the daemon has reported the character, its Problems entry is in
        // this same hover already, and a second paragraph saying it again reads
        // like two findings.
        const reported = vscode.languages.getDiagnostics(document.uri).some(
          (d) => d.source === "poly" && code(d).startsWith("unicode-") && d.range.contains(range.start),
        );
        return reported ? undefined : new vscode.Hover(explain(hit.suspect), range);
      },
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
 * has to be one type per distinct image. A type is kept while some editor is
 * showing it and disposed once none is, which is what bounds the cache by what
 * is on screen rather than by every image the session has scrolled past.
 */
function previewImages(context: vscode.ExtensionContext): void {
  const types = new Map<string, vscode.TextEditorDecorationType>();
  // Decorations are cleared per editor and only a repaint of that editor can
  // clear them, so its last paint is the only record of what its gutter still
  // holds -- and the only way to tell whether an image is still on screen.
  const painted = new Map<vscode.TextEditor, Set<string>>();
  context.subscriptions.push({
    dispose: () => types.forEach((type) => type.dispose()),
  });

  const onScreen = (file: string) => [...painted.values()].some((files) => files.has(file));

  const paint = (editor: vscode.TextEditor) => {
    const shown = new Map<string, vscode.Range[]>();
    const on = vscode.workspace
      .getConfiguration("poly")
      .get<boolean>("imagePreview.enabled", false);
    if (on && editor.document.uri.scheme === "file") {
      for (const visible of editor.visibleRanges) {
        for (let line = visible.start.line; line <= visible.end.line; line++) {
          const file = imageOnLine(editor.document, editor.document.lineAt(line).text);
          if (!file) {
            continue;
          }
          const ranges = shown.get(file) ?? [];
          ranges.push(new vscode.Range(line, 0, line, 0));
          shown.set(file, ranges);
        }
      }
    }
    const before = painted.get(editor) ?? new Set<string>();
    painted.set(editor, new Set(shown.keys()));
    for (const [file, ranges] of shown) {
      let type = types.get(file);
      if (!type) {
        type = vscode.window.createTextEditorDecorationType({
          gutterIconPath: vscode.Uri.file(file),
          gutterIconSize: "contain",
        });
        types.set(file, type);
      }
      editor.setDecorations(type, ranges);
    }
    // A type left alone keeps whatever it was showing the last time this
    // editor scrolled past that line, so a line this editor has moved off has
    // to be set to nothing by name -- unless no editor is showing that image
    // at all, where disposing clears it everywhere and retires the type with
    // the same call.
    for (const [file, type] of types) {
      if (shown.has(file)) {
        continue;
      }
      if (!onScreen(file)) {
        type.dispose();
        types.delete(file);
      } else if (before.has(file)) {
        editor.setDecorations(type, []);
      }
    }
  };

  let pending: NodeJS.Timeout | undefined;
  const repaintAll = () => {
    clearTimeout(pending);
    // Slower than the indent repaint on purpose: this one stats files, and
    // nobody needs a thumbnail to keep up with typing.
    pending = setTimeout(() => {
      // An editor that is gone is never painted again, so its last paint has
      // to stop counting as something on screen or it pins those types for the
      // rest of the session.
      const open = new Set(vscode.window.visibleTextEditors);
      for (const editor of painted.keys()) {
        if (!open.has(editor)) {
          painted.delete(editor);
        }
      }
      vscode.window.visibleTextEditors.forEach(paint);
    }, 250);
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
 * A lens that remembers which declaration it is counting, and what about it.
 *
 * `vscode.CodeLens` carries only a range, and resolution happens later and out
 * of order; the editor hands back the same object, so the uri rides on it.
 *
 * One lens counts one thing, so `N refs | N impls` over a declaration is two of
 * these sharing a range. The editor renders same-range lenses in the order they
 * were provided, which is what puts refs first.
 */
class ReferenceLens extends vscode.CodeLens {
  constructor(
    readonly uri: vscode.Uri,
    /** References, or which way the implementation question points. */
    readonly counts: "refs" | Direction,
    /** The declaration, as `declarationKeys` names it -- what `Answered` keys on. */
    readonly key: string,
    range: vscode.Range,
  ) {
    super(range);
  }
}

/** A lens target, with where its name is and what its count is filed under. */
type Anchored = LensTarget<vscode.DocumentSymbol> & {
  /** The name's range, which is where every question about it is asked. */
  readonly at: vscode.Range;
  readonly key: string;
};

/**
 * The range to ask about, for a symbol whose provider may not have said where
 * its name is -- see `nameStart`.
 *
 * Only the flat shape is searched. A provider that sends `DocumentSymbol` gave
 * a name range of its own, and second-guessing it with a text search would be
 * wrong for every name that is not spelled on its declaration's first line
 * (gopls reports `(Circle).Area`).
 */
function anchorOf(document: vscode.TextDocument, symbol: vscode.DocumentSymbol): vscode.Range {
  const { range, selectionRange } = symbol;
  if (!selectionRange.isEqual(range)) {
    return selectionRange;
  }
  const line = selectionRange.start.line;
  const found = nameStart(document.lineAt(line).text, symbol.name, selectionRange.start.character);
  return found === undefined
    ? selectionRange
    : new vscode.Range(line, found, line, found + symbol.name.length);
}

/** How long a count is reused before it is asked again; see `Answered`. */
const REUSE_MS = 10_000;

/** How long an implementation direction nobody answered stays unasked. */
const DECLINED_MS = 60_000;

/**
 * When to look again at a file that had nothing to count yet.
 *
 * A lens is asked for once when the file opens, and the daemon starts a file's
 * language server on that same open -- so the first answer can come from a
 * server that is not up yet, and until 0.18.1 that empty answer was final:
 * nothing but a settings change asked again. The editor has no event for "a
 * provider just registered", so the only way to notice is to ask again: three
 * times, further apart each time, and then stop rather than poll a language
 * nothing will ever answer for.
 */
const RETRY_MS = [2_000, 5_000, 15_000];

/**
 * The tree every lens fills in, once `activate` has made it.
 *
 * Module state rather than a parameter because `present` is reached from
 * commands, and the editor decides a command's arguments.
 */
let referenceTree: ReferenceTree | undefined;

/**
 * What each lens calls its result set, in the view's title.
 *
 * Different questions whose answers look identical once they are rows in a
 * tree, so the title is the only thing left saying which one was asked. The two
 * directions are `implLabel`'s two readings of one provider: `down` is who
 * satisfies this declaration, `up` is what this one satisfies.
 */
const ASKED: Readonly<Record<"refs" | Direction, string>> = {
  refs: "References",
  down: "Implementations",
  up: "Interfaces",
};

/**
 * Where a click on any of poly's lenses lands, whichever lens it was.
 *
 * "N refs" is three gestures wearing one label. Nothing refers to it: there is
 * nowhere to go, and the lens stays text. One thing does: go there -- a list
 * with a single entry in it is a widget's worth of ceremony around a jump the
 * user has already decided on. More than one: the tree, which is the only kind
 * of list that survives being read, since a peek closes the moment the editor
 * is touched.
 *
 * The same rule for `N methods` and `go type` since 0.18.1. They used to open a
 * quick pick, on the grounds that a method list is not a reference search --
 * true, and beside the point: to the person clicking, every one of these lenses
 * is "show me where", and three lenses answering in two widgets was reported as
 * the thing that felt broken. The quick pick also showed a name and nothing
 * else, where the tree has a line number and a file.
 */
async function present(title: string, locations: readonly vscode.Location[]): Promise<void> {
  const only = locations.length === 1 ? locations[0] : undefined;
  if (only) {
    await vscode.window.showTextDocument(only.uri, { selection: only.range });
    return;
  }
  if (locations.length === 0) {
    return;
  }
  // poly's own tree rather than `references-view`'s, and the whole difference
  // is two columns: the line number and the symbol each hit sits inside. That
  // cannot be added to the built-in one -- a TreeDataProvider owns its rows --
  // so the list is built here instead of handing the cursor over.
  await referenceTree?.show(title, locations);
  await vscode.commands.executeCommand("polyReferences.focus");
}

/**
 * A reference or implementation lens's click: ask again, then present.
 *
 * Asked again rather than carried from the count, because the count may be a
 * reused one (`Answered`) and the click is the one moment the answer has to be
 * current -- a list of lines that moved since is a list of wrong jumps. It is
 * one query per click, which is not where the cost ever was.
 *
 * `position` is where the question is asked, and it is not always in the file
 * the lens is in: an rpc's implementations are asked of the generated Go
 * interface method. The editor stays where it was either way. Until 0.18.1
 * this opened `uri`, which on a .proto meant a click on an rpc threw the reader
 * out of the file they were reading and into a generated one.
 */
async function showReferences(
  uri: vscode.Uri,
  position: vscode.Position,
  counts: "refs" | Direction,
): Promise<void> {
  const others = await othersAt(uri, position, counts);
  await present(ASKED[counts], others);
}

/**
 * What a reference or implementation provider says about the declaration at
 * `position`, minus the declaration itself -- see `elsewhere`.
 */
async function othersAt(
  uri: vscode.Uri,
  position: vscode.Position,
  counts: "refs" | Direction,
): Promise<vscode.Location[]> {
  return (await answerAt(uri, position, counts)) ?? [];
}

/**
 * `othersAt`, or `undefined` when no provider said anything at all -- which
 * for references is no provider rather than no references, since a provider
 * that answers includes the declaration (see `REFERENCE_PROBES`). Only a
 * count kept across sessions needs the difference: it must not be replaced by
 * the silence of a server that is still loading.
 */
async function answerAt(
  uri: vscode.Uri,
  position: vscode.Position,
  counts: "refs" | Direction,
): Promise<vscode.Location[] | undefined> {
  const found = await vscode.commands.executeCommand<
    (vscode.Location | vscode.LocationLink)[]
  >(
    counts === "refs" ? "vscode.executeReferenceProvider" : "vscode.executeImplementationProvider",
    uri,
    position,
  );
  if (!found || found.length === 0) {
    return undefined;
  }
  // A reference provider answers in `Location`s, an implementation provider
  // may answer in `LocationLink`s, and everything below only understands the
  // first.
  const locations = found.map((one) =>
    "targetUri" in one
      ? new vscode.Location(one.targetUri, one.targetSelectionRange ?? one.targetRange)
      : one
  );
  return elsewhere(
    locations,
    { uri: uri.toString(), line: position.line },
    (location) => ({ uri: location.uri.toString(), line: location.range.start.line }),
  );
}

/**
 * The grammar registered for a language, and which extension registered it.
 *
 * Asked of every installed extension rather than of poly's own, because the
 * question is "what is painting this file", and for a language poly does not
 * ship a grammar for the answer is somebody else's -- which is still the answer
 * worth printing. Poly's is preferred when both are there, since poly's is the
 * one in effect: a grammar contributed later wins the language id.
 */
function grammarFor(languageId: string): { path: string; from: string } | undefined {
  const found: { path: string; from: string }[] = [];
  for (const extension of vscode.extensions.all) {
    const grammars = extension.packageJSON?.contributes?.grammars;
    if (!Array.isArray(grammars)) {
      continue;
    }
    for (const grammar of grammars) {
      if (grammar?.language === languageId && typeof grammar.path === "string") {
        found.push({
          path: path.join(extension.extensionPath, grammar.path),
          from: extension.id,
        });
      }
    }
  }
  return found.find((one) => one.from === "ricky.poly-syntax-highlight") ?? found[0];
}

/**
 * Open a sheet of every scope the current file's grammar can produce.
 *
 * The answer to "let me set the highlight colours", which VSCode already
 * supports and nobody can use: `editor.tokenColorCustomizations.textMateRules`
 * addresses tokens by scope name, and the only way to learn a scope name is to
 * put the cursor on a token and run the built-in inspector, once per token.
 */
async function showSyntaxColors(editor: vscode.TextEditor): Promise<void> {
  const languageId = editor.document.languageId;
  const grammar = grammarFor(languageId);
  if (!grammar) {
    vscode.window.showWarningMessage(
      `Poly: no grammar is registered for ${languageId}, so it has no scopes to colour`,
    );
    return;
  }
  let scopes: string[];
  try {
    scopes = scopesIn(JSON.parse(fs.readFileSync(grammar.path, "utf8")));
  } catch (error) {
    // A grammar can be a plist rather than JSON -- poly converts those at sync
    // time, but another extension may ship one as it came.
    vscode.window.showWarningMessage(
      `Poly: could not read the ${languageId} grammar at ${grammar.path}: ${error}`,
    );
    return;
  }
  const sheet = await vscode.workspace.openTextDocument({
    language: "jsonc",
    content: colorSheet(languageId, `${grammar.from} — ${grammar.path}`, scopes),
  });
  await vscode.window.showTextDocument(sheet);
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
 * How many copies of one generated file to consider.
 *
 * A workspace with two `greet.pb.go` in it is a monorepo with two modules
 * generating from the same proto, and offering both is right. A workspace with
 * twenty is a vendor directory, and a quick pick of twenty identical names is
 * not a choice anyone can make.
 */
const MAX_GENERATED = 4;

/**
 * How many declarations to ask about before deciding nothing can answer.
 *
 * `executeReferenceProvider` asks with `includeDeclaration: true`, so a
 * provider that answers at all answers with at least the declaration itself.
 * Zero locations therefore means "nobody is registered for this language",
 * which is a different thing from "nothing refers to this" -- and the
 * difference is the whole point, because the second one is worth a `no refs`
 * lens and the first one is worth silence.
 *
 * More than one, because the first declaration in a file can legitimately be a
 * position no provider considers a symbol. Three, because this runs on every
 * file that has declarations at all and the answer is the same every time.
 */
const REFERENCE_PROBES = 3;

/**
 * Does anything answer reference queries for this document?
 *
 * This is what replaced the list of language ids this lens used to be limited
 * to (2026-09-04). A list is a guess about somebody else's installed
 * extensions: it left out python, typescript, java and everything else with a
 * perfectly good reference provider, and it would have gone on being wrong as
 * the user's extensions changed. Asking costs one query per file and is right
 * by construction.
 */
async function answersReferences(
  document: vscode.TextDocument,
  targets: readonly Anchored[],
  known: Set<string>,
  token: vscode.CancellationToken,
): Promise<boolean> {
  // A yes is remembered for the session, per language: a provider that has
  // answered once is registered, and asking again on every edit was one
  // reference search per keystroke burst for a fact that cannot change back.
  // A no is not, because it is also what a server that is still starting says.
  if (known.has(document.languageId)) {
    return true;
  }
  for (const target of targets.slice(0, REFERENCE_PROBES)) {
    if (token.isCancellationRequested) {
      return false;
    }
    const found = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      document.uri,
      target.at.start,
    );
    if (found && found.length > 0) {
      known.add(document.languageId);
      return true;
    }
  }
  return false;
}

/**
 * Does this language's implementation provider answer in this direction?
 *
 * The question is not rhetorical in either direction, and the answer differs
 * per server. Measured 2026-09-21: gopls asked at `type Circle struct` answers
 * `Shape`, while TypeScript asked at `class Circle implements Shape` answers
 * nothing at all -- it only reads the relation downward. `buf lsp serve` reads
 * it neither way: it declares no implementation provider, and a `.proto` file
 * carried a `no impls` over every service and every rpc in it.
 *
 * Drawing regardless is what made both of those noise. `no impls` over an
 * interface nothing implements is worth a word; over an rpc, in a language
 * where nothing can ever answer, it is a permanent grey lie.
 *
 * So each direction is earned per language rather than declared: the first file
 * that proves a provider answers turns that direction on for that language id,
 * and nothing ever turns it off. A yes is remembered for good. A no is
 * remembered for a minute and no longer, because it is also what a file of
 * unimplemented interfaces looks like, and keeping it would keep the lens off a
 * project that grows an implementation later. Not remembering it at all was the
 * other extreme: TypeScript never answers upward, so every edit to a file with
 * a class in it cost three implementation queries that were certain to fail.
 */
async function answersImplementations(
  document: vscode.TextDocument,
  targets: readonly Anchored[],
  direction: Direction,
  known: Map<string, Set<Direction>>,
  declined: Map<string, number>,
  token: vscode.CancellationToken,
): Promise<boolean> {
  const seen = known.get(document.languageId);
  if (seen?.has(direction)) {
    return true;
  }
  const key = `${document.languageId}:${direction}`;
  if (Date.now() - (declined.get(key) ?? -Infinity) < DECLINED_MS) {
    return false;
  }
  const asking = targets.filter((target) => target.implementation === direction);
  if (asking.length === 0) {
    return false;
  }
  for (const target of asking.slice(0, REFERENCE_PROBES)) {
    if (token.isCancellationRequested) {
      // Not a no: nobody answered because nobody was asked.
      return false;
    }
    const start = target.at.start;
    const found = await vscode.commands.executeCommand<
      (vscode.Location | vscode.LocationLink)[]
    >("vscode.executeImplementationProvider", document.uri, start);
    // Not `length > 0`: a server that answers with the declaration itself has
    // said nothing, and would otherwise switch the lens on for a whole language
    // on the strength of an echo.
    const others = elsewhere(
      found ?? [],
      { uri: document.uri.toString(), line: start.line },
      (one) =>
        "targetUri" in one
          ? {
            uri: one.targetUri.toString(),
            line: (one.targetSelectionRange ?? one.targetRange).start.line,
          }
          : { uri: one.uri.toString(), line: one.range.start.line },
    );
    if (others.length > 0) {
      known.set(document.languageId, (seen ?? new Set()).add(direction));
      return true;
    }
  }
  declined.set(key, Date.now());
  return false;
}

/**
 * `N refs` over every declaration and `N impls` over every interface, in every
 * language whose provider can answer.
 *
 * The counts come from `vscode.executeReferenceProvider` and
 * `vscode.executeImplementationProvider`, which is to say from whichever
 * providers are registered — for Go that is poly-lsp's proxy in front of gopls,
 * for TypeScript the built-in server, for Python whatever the user installed.
 * poly analyses nothing here; see `references.ts`.
 *
 * TypeScript and JavaScript used to be held out on the grounds that VSCode
 * ships its own reference lens for them. It does, and it is off by default
 * (`typescript.referencesCodeLens.enabled`), so holding them out meant most
 * people got no lens at all. Someone who turns the built-in one on now gets two
 * counts; that is visible and fixable, unlike the silence it replaced.
 */
function countReferencesInGutter(context: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<void>();
  /** Which implementation directions each language's provider has answered. */
  const answered = new Map<string, Set<Direction>>();
  /** When each language's direction last went unanswered; see `DECLINED_MS`. */
  const declined = new Map<string, number>();
  /** Languages whose reference provider has answered at least once. */
  const refsAnswer = new Set<string>();
  const counted = new Answered(REUSE_MS);
  /** Retries already spent per document; see `RETRY_MS`. */
  const retried = new Map<string, number>();
  /** Counts from earlier sessions; see refStore.ts. */
  const store = new RefStore(cacheDir());

  /** Nothing to count yet: ask again later, a bounded number of times. */
  const askAgainLater = (uri: vscode.Uri, why: string) => {
    const key = uri.toString();
    const spent = retried.get(key) ?? 0;
    if (spent >= RETRY_MS.length) {
      return;
    }
    retried.set(key, spent + 1);
    log?.debug(
      `refs: ${why} for ${vscode.workspace.asRelativePath(uri)}, asking again in ${RETRY_MS[spent]}ms`,
    );
    const timer = setTimeout(() => changed.fire(), RETRY_MS[spent]);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  };

  /** Where a file's counts are kept: inside a workspace folder, or nowhere. */
  const placeOf = (uri: vscode.Uri) => {
    const folder = uri.scheme === "file" ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
    return folder && { folder: folder.uri.fsPath, file: path.relative(folder.uri.fsPath, uri.fsPath) };
  };

  // Throttled rather than debounced, both of them: answers trickle in for as
  // long as a server takes to load, and a debounce would hold every redraw
  // back until the last one.
  let saving: NodeJS.Timeout | undefined;
  const saveSoon = () => {
    saving ??= setTimeout(() => {
      saving = undefined;
      store.save();
    }, 2_000);
  };
  let redrawing: NodeJS.Timeout | undefined;
  const redrawSoon = () => {
    redrawing ??= setTimeout(() => {
      redrawing = undefined;
      changed.fire();
    }, 250);
  };
  context.subscriptions.push({
    dispose: () => {
      clearTimeout(saving);
      clearTimeout(redrawing);
      store.save();
    },
  });

  /** An answer: reused for `REUSE_MS`, and kept for the next session. */
  const settle = (at: vscode.Uri, id: string, count: number) => {
    counted.set(at.toString(), id, count);
    retried.delete(at.toString());
    const place = placeOf(at);
    if (place) {
      store.set(place.folder, place.file, id, count);
      saveSoon();
    }
  };

  /** Lenses whose kept count is being asked again, so one lens asks once. */
  const refreshing = new Set<string>();
  const refresh = (at: vscode.Uri, start: vscode.Position, counts: "refs" | Direction, id: string, shown: number) => {
    const flight = `${at.toString()}|${id}`;
    if (refreshing.has(flight)) {
      return;
    }
    refreshing.add(flight);
    void answerAt(at, start, counts)
      .then((others) => {
        // A server still loading says nothing, and the kept count stays up
        // until it can answer rather than turning into a `no refs` that is
        // only a guess.
        if (!others && counts === "refs") {
          askAgainLater(at, "no reference provider answered");
          return;
        }
        const count = others?.length ?? 0;
        settle(at, id, count);
        if (count !== shown) {
          redrawSoon();
        }
      }, () => undefined)
      .finally(() => refreshing.delete(flight));
  };

  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,

    async provideCodeLenses(document, token) {
      const config = vscode.workspace.getConfiguration("poly");
      if (!config.get<boolean>("referencesCodeLens.enabled", false)) {
        return [];
      }
      // A server may answer in either symbol shape and this reads only one of
      // them -- see `registerFlatProvider` in tools/ref-lens-check for why that
      // is safe, and for the check that says it stays safe.
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >("vscode.executeDocumentSymbolProvider", document.uri);
      // Superseded by a newer version of the document while waiting. Every
      // question below would be about text that no longer exists, and each
      // one is a query some language server has to run to completion.
      if (token.isCancellationRequested) {
        return [];
      }
      // No symbol provider, or one that has not finished loading the project.
      // Either way there is nothing to hang a count on yet.
      if (!symbols) {
        void offerServer("the outline", document.languageId);
        askAgainLater(document.uri, "no outline");
        return [];
      }
      const found = lensTargets(symbols, MAX_LENSES);
      const keys = declarationKeys(found.map((target) => target.symbol));
      const targets: Anchored[] = found.map((target, index) => ({
        ...target,
        at: anchorOf(document, target.symbol),
        key: keys[index],
      }));
      // Before any lens is drawn, because a file full of `no refs` over a
      // language nothing can answer for is worse than no lens: it reads as an
      // answer. JSON and markdown never reach here (their symbols are not the
      // kinds this counts); CSS and YAML do, and this is what decides them.
      if (targets.length === 0) {
        return [];
      }
      const place = placeOf(document.uri);
      const remembered = place ? store.answered(place.folder, document.languageId) : [];
      if (remembered.includes("refs")) {
        // Answered in an earlier session. Drawn now, from the counts kept
        // then, each asked again behind the drawing (`resolveCodeLens`): the
        // probe would wait on a server that may still be loading, and that
        // wait is what the store is for.
      } else if (await answersReferences(document, targets, refsAnswer, token)) {
        retried.delete(document.uri.toString());
        if (place) {
          store.answer(place.folder, document.languageId, "refs");
        }
      } else {
        if (token.isCancellationRequested) {
          return [];
        }
        // There are declarations and nothing will say who uses them. For a
        // shell function that is the whole feature missing, and it was
        // reported as one.
        void offerServer("references", document.languageId);
        askAgainLater(document.uri, "no reference provider answered");
        return [];
      }
      const answersDirection = async (direction: Direction) => {
        if (remembered.includes(direction)) {
          return true;
        }
        const yes = await answersImplementations(document, targets, direction, answered, declined, token);
        if (yes && place) {
          store.answer(place.folder, document.languageId, direction);
        }
        return yes;
      };
      const answers = { down: await answersDirection("down"), up: await answersDirection("up") };
      if (token.isCancellationRequested) {
        return [];
      }
      const methods = methodsByType(symbols);
      const lenses = targets.flatMap((target) => {
        const range = target.at;
        const lenses: vscode.CodeLens[] = [
          new ReferenceLens(document.uri, "refs", target.key, range),
        ];
        const direction = target.implementation;
        if (direction && answers[direction]) {
          lenses.push(new ReferenceLens(document.uri, direction, target.key, range));
        }
        // Already resolved, and the only lens here that is: the count is in the
        // symbol tree that has already been fetched, so there is nothing to ask
        // anybody and nothing to defer. No lens at all when there are none --
        // see `methods.ts` for why zero is not worth a word here when it is
        // over an interface nothing implements.
        const mine = methods.get(target.symbol.name) ?? [];
        if (mine.length > 0) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: methodLabel(mine.length),
              command: "poly.showLocations",
              arguments: [
                "Methods",
                mine.map((method) => new vscode.Location(document.uri, method.selectionRange)),
              ],
            }),
          );
        }
        return lenses;
      });
      if (place) {
        const drawn = lenses.filter((lens) => lens instanceof ReferenceLens);
        store.retain(place.folder, place.file, new Set(drawn.map((lens) => `${lens.counts}|${lens.key}`)));
        saveSoon();
      }
      return lenses;
    },

    async resolveCodeLens(lens, token) {
      const { uri: at, counts, key } = lens as ReferenceLens;
      const start = lens.range.start;
      const id = `${counts}|${key}`;
      let count = counted.get(at.toString(), id);
      const place = count === undefined ? placeOf(at) : undefined;
      const kept = place && store.get(place.folder, place.file, id);
      if (count === undefined && kept !== undefined) {
        // Drawn now from the last answer, and asked again behind it; a count
        // that moved is redrawn when the answer lands. See refStore.ts.
        count = kept;
        refresh(at, start, counts, id, kept);
      } else if (count === undefined) {
        // Scrolled past or superseded before it was drawn. The editor asks
        // again for any lens that is still on screen, so leaving this one
        // unresolved costs nothing and saves a search nobody will read.
        if (token.isCancellationRequested) {
          return lens;
        }
        const others = await answerAt(at, start, counts);
        // Nothing answered: not a count, and not worth a `no refs` that the
        // store would then keep. Left unresolved, and asked again shortly.
        if (!others && counts === "refs") {
          askAgainLater(at, "no reference provider answered");
          return lens;
        }
        count = others?.length ?? 0;
        settle(at, id, count);
      }
      lens.command = {
        title: counts === "refs" ? refLabel(count) : implLabel(count, counts),
        // Nothing to open when nothing refers to it, so the lens is text.
        command: count > 0 ? "poly.showReferences" : "",
        arguments: [at, start, counts],
      };
      return lens;
    },
  };

  context.subscriptions.push(
    changed,
    // Not in the command table below: that one is for commands a user invokes,
    // and this is the lens's own click. It takes the lens's arguments, so it
    // has nothing to offer the palette and is deliberately not contributed.
    vscode.commands.registerCommand("poly.showReferences", showReferences),
    // Every file scheme, filtered by language inside: the setting is a list of
    // language ids, and a selector built from it at registration time would go
    // stale the moment it changed.
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.referencesCodeLens")) {
        changed.fire();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      counted.forget(document.uri.toString());
      retried.delete(document.uri.toString());
    }),
  );
}

/**
 * `run | debug` over a program's entry point.
 *
 * The two do different things, which they did not until now: `run` executes
 * the file in a terminal and `debug` is `workbench.action.debug.start`, the
 * editor's own F5. Both used to be debug commands -- `workbench.action.debug
 * .run` is "Start Without Debugging", which still wants a launch configuration
 * and still raises the debug toolbar -- so the pair was one behaviour wearing
 * two labels. See `runnable.ts` for what poly had to learn to fix that.
 *
 * `run` appears only where poly knows the command. Go, Rust, Python and shell
 * have one; C, C++, Java and C# have an entry point and no one-line way to
 * run it, so they get `debug` alone rather than a button that opens a terminal
 * and prints an error.
 */
/**
 * The terminal `run` uses, and the directory it was opened in.
 *
 * Both, because the command lines are relative -- `go run .` means the
 * directory the shell is in. Reusing a terminal opened somewhere else would
 * run a different program and say nothing about it.
 */
let runTerminal: { terminal: vscode.Terminal; cwd: string } | undefined;

/**
 * Run one file, in a terminal the user can read, scroll and kill.
 *
 * A terminal rather than a task or a child process: a task needs a
 * tasks.json-shaped problem matcher to be worth anything and hides its output
 * behind a panel switch, and a child process would put the program's stdout in
 * an output channel with no stdin and no ^C. The point of the button is "show
 * me this running", and a terminal is the thing that does that.
 *
 * One terminal, reused. The alternative is a new tab per press, and the press
 * people repeat most is the one after an edit.
 */
async function runFile(uri?: vscode.Uri, line?: string): Promise<void> {
  // The lens passes both; the command palette passes neither, and means the
  // file being looked at. Worth supporting rather than hiding the command,
  // because a keyboard route to "run this" is the half a lens cannot give.
  const document = uri
    ? vscode.workspace.textDocuments.find((open) => open.uri.toString() === uri.toString())
    : vscode.window.activeTextEditor?.document;
  if (!document || document.uri.scheme !== "file") {
    return;
  }
  const command = line
    ?? runLine(
      document.languageId,
      path.basename(document.uri.fsPath),
      document.getText(),
      process.platform === "win32",
    );
  if (!command) {
    vscode.window.showWarningMessage(
      `Poly: no way to run a ${document.languageId} file from a shell`,
    );
    return;
  }
  // Saved first, or the run is of the last version the user happened to save
  // -- which looks exactly like a change that did not work.
  if (document.isDirty) {
    await document.save();
  }
  const cwd = path.dirname(document.uri.fsPath);
  if (runTerminal && (runTerminal.terminal.exitStatus !== undefined || runTerminal.cwd !== cwd)) {
    runTerminal.terminal.dispose();
    runTerminal = undefined;
  }
  if (!runTerminal) {
    runTerminal = { terminal: vscode.window.createTerminal({ name: "Poly Run", cwd }), cwd };
  }
  // Not stealing focus: the useful thing is watching the output, and a cursor
  // that jumps out of the editor after every run is a cursor put back by hand.
  runTerminal.terminal.show(true);
  runTerminal.terminal.sendText(command);
}

function runFromGutter(context: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<void>();
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,

    async provideCodeLenses(document) {
      const on = vscode.workspace
        .getConfiguration("poly")
        .get<boolean>("runCodeLens.enabled", false);
      if (!on) {
        return [];
      }
      const runs = runLine(
        document.languageId,
        path.basename(document.uri.fsPath),
        document.getText(),
        process.platform === "win32",
      );
      const buttons = (range: vscode.Range) =>
        [
          ...(runs
            ? [{ title: "run", command: "poly.runFile", arguments: [document.uri, runs] }]
            : []),
          { title: "debug", command: "workbench.action.debug.start", arguments: [] },
        ].map((command) => new vscode.CodeLens(range, command));

      // Python and shell have no declaration to sit on, and asking their
      // symbol provider first would cost a request whose answer is discarded.
      if (findsEntryInText(document.languageId)) {
        const line = entryLine(document.languageId, document.getText());
        return line === undefined ? [] : buttons(document.lineAt(line).range);
      }
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >("vscode.executeDocumentSymbolProvider", document.uri);
      return entryPoints(symbols ?? []).flatMap((symbol) => buttons(symbol.selectionRange));
    },
  };

  context.subscriptions.push(
    changed,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, provider),
    vscode.commands.registerCommand("poly.runFile", runFile),
    // The terminal outlives the lens that opened it, so it is disposed with
    // the extension rather than left behind on reload.
    { dispose: () => runTerminal?.terminal.dispose() },
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.runCodeLens")) {
        changed.fire();
      }
    }),
  );
}

/**
 * An rpc's `N impls`, which are Go's and not the .proto's.
 *
 * It carries where the question has to be asked rather than where the answer
 * is drawn: the lens sits on the rpc, and the implementation query runs at the
 * generated `GreeterServer.SayHello` that gopls knows about.
 */
class ProtoImplLens extends vscode.CodeLens {
  constructor(readonly generated: vscode.Location, range: vscode.Range) {
    super(range);
  }
}

/**
 * `go type`, `go server`, `go client` over a .proto declaration.
 *
 * The generated file is found by name and read once, and every lens in the
 * file is matched against that one symbol list -- not one workspace query per
 * message, which on a .proto with thirty of them would be thirty fuzzy
 * searches of the whole workspace for an answer that is always in the same two
 * files. See `protobuf.ts` for why the names are predictable at all.
 *
 * A declaration with nothing generated for it gets no lens rather than a dead
 * one: the symbols are in hand before any lens is made, so "not generated yet"
 * and "generated elsewhere" both come out as silence instead of a word that
 * does nothing when pressed.
 */
function linkGeneratedGo(context: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<void>();
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,

    async provideCodeLenses(document) {
      const on = vscode.workspace
        .getConfiguration("poly")
        .get<boolean>("protobufCodeLens.enabled", false);
      if (!on) {
        return [];
      }
      const files = (await Promise.all(
        generatedFiles(document.uri.path).map((name) =>
          vscode.workspace.findFiles(`**/${name}`, "**/node_modules/**", MAX_GENERATED)
        ),
      )).flat();
      if (files.length === 0) {
        return [];
      }
      // One symbol list per generated file, keyed by name. A workspace with two
      // `greet.pb.go` in it keeps both, and the click asks which. Interface
      // members are keyed `GreeterServer.SayHello`, because an rpc's answer is
      // a method inside a generated interface rather than a top-level type.
      const generated = new Map<string, vscode.Location[]>();
      for (const file of files) {
        const symbols = await vscode.commands.executeCommand<
          vscode.DocumentSymbol[]
        >("vscode.executeDocumentSymbolProvider", file);
        const keep = (key: string, range: vscode.Range) => {
          const at = new vscode.Location(file, range);
          generated.set(key, [...(generated.get(key) ?? []), at]);
        };
        for (const symbol of symbols ?? []) {
          keep(symbol.name, symbol.selectionRange);
          for (const member of symbol.children ?? []) {
            keep(`${symbol.name}.${member.name}`, member.selectionRange);
          }
        }
      }

      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >("vscode.executeDocumentSymbolProvider", document.uri);
      // The generated Go is right there and the .proto side is blank, which
      // means nothing is reading the .proto. This is the one place that can
      // tell the difference between "not generated yet" -- handled above, by
      // returning early -- and "generated, but poly is not running buf".
      if (!symbols || symbols.length === 0) {
        void offerServer("the .proto outline", document.languageId);
        return [];
      }
      const pkg = protoPackage(document.getText());
      return symbols.flatMap((symbol) => {
        const links = goLinksFor(symbol.name, symbol.kind, pkg).flatMap((link) => {
          const found = generated.get(link.name);
          return found
            ? [
              new vscode.CodeLens(symbol.selectionRange, {
                title: link.label,
                command: "poly.showLocations",
                arguments: ["Generated Go", found],
              }),
            ]
            : [];
        });
        // The rpc's own lens, and the one thing on a .proto that has to stay
        // lazy: the count is an implementation query against the generated
        // interface method, not something already in hand.
        const method = goServerMethod(symbol.name, pkg);
        const at = method ? generated.get(method)?.[0] : undefined;
        return at
          ? [...links, new ProtoImplLens(at, symbol.selectionRange)]
          : links;
      });
    },

    async resolveCodeLens(lens, token) {
      if (token.isCancellationRequested) {
        return lens;
      }
      const { generated } = lens as ProtoImplLens;
      // The generated interface declares the method; it does not implement it,
      // and `othersAt` subtracts it for that reason.
      const count = (await othersAt(generated.uri, generated.range.start, "down")).length;
      lens.command = {
        title: implLabel(count, "down"),
        command: count > 0 ? "poly.showReferences" : "",
        arguments: [generated.uri, generated.range.start, "down"],
      };
      return lens;
    },
  };

  context.subscriptions.push(
    changed,
    vscode.languages.registerCodeLensProvider({ language: "protobuf" }, provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.protobufCodeLens")) {
        changed.fire();
      }
    }),
  );
}

/**
 * A snippet built from a template, with the user's text escaped into it.
 *
 * The two halves go in differently on purpose: the template's `$0` and
 * `${1:name}` are ours and must stay live, while the expression came off the
 * user's line and a `$` or `}` in it must not become snippet syntax.
 */
function postfixSnippet(template: string, expression: string): vscode.SnippetString {
  const snippet = new vscode.SnippetString();
  template.split(EXPR_MARK).forEach((chunk, index) => {
    if (index > 0) {
      snippet.appendText(expression);
    }
    snippet.value += chunk;
  });
  return snippet;
}

/**
 * `err.if` → `if err != nil { }`, in every language that has statements.
 *
 * See `postfix.ts` for the templates and for why a text rearrangement is not
 * the language feature 01 A6 rules out. Nothing here asks anything of a
 * language server: it is the characters left of the dot and a table.
 */
function completePostfixes(context: vscode.ExtensionContext): void {
  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(document, position) {
      const on = vscode.workspace
        .getConfiguration("poly")
        .get<boolean>("postfixCompletion.enabled", false);
      const postfixes = on ? postfixesFor(document.languageId) : undefined;
      if (!postfixes) {
        return undefined;
      }
      const line = document.lineAt(position.line).text;
      const target = postfixTarget(line, position.character);
      if (!target) {
        return undefined;
      }
      // From the start of the expression, because the expansion moves it: the
      // item replaces `resp.Body.if`, not just the `if`.
      const range = new vscode.Range(
        position.line,
        target.start,
        position.line,
        position.character,
      );
      return postfixes.map((postfix) => {
        const item = new vscode.CompletionItem(
          postfix.name,
          vscode.CompletionItemKind.Snippet,
        );
        item.range = range;
        item.insertText = postfixSnippet(postfix.template, target.expression);
        item.detail = describe(postfix.template, target.expression);
        // The editor filters against the text the range covers, which is
        // `resp.Body.if` and not `if` -- without this the item disappears the
        // moment the user types the first letter of its own name.
        item.filterText = `${target.expression}.${postfix.name}`;
        // After whatever the language server offered. A member named `iffy`
        // is a real answer about the program; this is a template, and the
        // template only wins once the user has typed something no member
        // matches.
        item.sortText = `zzz${postfix.name}`;
        return item;
      });
    },
  };

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      POSTFIX_LANGUAGES.map((language) => ({ scheme: "file", language })),
      provider,
      ".",
    ),
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

/**
 * How many of the offered actions to have the provider resolve.
 *
 * `executeCodeActionProvider` hands back unresolved actions unless it is given
 * a count, and an unresolved action has no `edit` -- rust-analyzer in
 * particular computes edits only on resolve, because computing all of them up
 * front is the expensive thing. The cap keeps that from being unbounded; with
 * an `only` filter this narrow, no server measured offers close to it.
 */
const MAX_RESOLVED = 32;

/**
 * Run the extract- or inline-variable refactoring, without the menu.
 *
 * The work is the language server's; see `refactors.ts` for why choosing among
 * its answers is a thing poly may do. Applying is in two halves because an
 * action may carry an edit, a command, or both, and VSCode's own code-action
 * runner applies them in that order -- a server that returns both means the
 * command to run *after* the edit lands.
 */
async function runRefactor(
  editor: vscode.TextEditor,
  want: Refactoring,
): Promise<void> {
  const wanted = REFACTORINGS[want];
  // An empty selection is the common case for inline (the cursor is on the
  // binding) and a mistake for extract, but the word under the cursor is a
  // legal expression to extract and is what `editor.action.refactor` would
  // have offered from the same position. Guessing wider than one word would be
  // poly deciding where an expression begins, which is the language's job.
  const range = editor.selection.isEmpty
    ? editor.document.getWordRangeAtPosition(editor.selection.active)
      ?? editor.selection
    : editor.selection;

  const offered = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    editor.document.uri,
    range,
    wanted.kind,
    MAX_RESOLVED,
  );
  const choices = refactorChoices(
    (offered ?? []).map((action) => ({
      action,
      title: action.title,
      kind: action.kind?.value,
    })),
    want,
  );
  if (choices.length === 0) {
    // Named rather than generic: "nothing here" and "this language server does
    // not do this" look identical from the outside, and the position is the
    // half the user can change.
    vscode.window.showWarningMessage(
      `Poly: nothing to ${wanted.title.toLowerCase()} here — ${wanted.hint}, or this language's server has none.`,
    );
    return;
  }
  const chosen = choices.length === 1
    ? choices[0]
    : await vscode.window.showQuickPick(
      choices.map((one) => ({ label: one.action.title, one })),
      { title: `Poly: ${wanted.title}`, placeHolder: "More than one applies here" },
    ).then((picked) => picked?.one);
  if (!chosen) {
    return;
  }
  if (chosen.action.edit) {
    await vscode.workspace.applyEdit(chosen.action.edit);
  }
  if (chosen.action.command) {
    await vscode.commands.executeCommand(
      chosen.action.command.command,
      ...(chosen.action.command.arguments ?? []),
    );
  }
}

/**
 * VSCode's own mermaid renderer, which has existed since 1.135.
 *
 * Asked for by id rather than compared against `vscode.version`: the question
 * is "is something else already drawing these fences", and an extension that
 * is present answers it whether it arrived as a built-in, as a later rename, or
 * as bierner.markdown-mermaid — the upstream all three share. Two renderers on
 * one fence is not twice as good; the first one to replace the element wins and
 * the second one draws into a node nobody is looking at.
 */
const BUILT_IN_MERMAID = "vscode.mermaid-markdown-features";

/**
 * Whether poly draws the diagrams in this preview.
 *
 * Asked per render rather than once, for two reasons: the setting can be turned
 * off while a preview is open, and the built-in this stands down for can be
 * enabled or disabled without the extension host restarting.
 */
function rendersMermaid(): boolean {
  return vscode.workspace
    .getConfiguration("poly")
    .get<boolean>("markdownMermaid.enabled", false)
    && vscode.extensions.getExtension(BUILT_IN_MERMAID) === undefined;
}

/**
 * The preview's markdown-it instance, taught both diagram shapes.
 *
 * Returned from `activate` because that is the only way in;
 * `contributes["markdown.markdownItPlugins"]` is what makes the preview ask.
 */
const extendMarkdownIt = mermaidPlugin(rendersMermaid);

/**
 * Hands Extract/Inline Variable's keys to an installed extension that binds
 * them too (see chords.ts). Re-checked when extensions come and go, so
 * uninstalling the other one gives the key back without a reload.
 */
function yieldChords(context: vscode.ExtensionContext) {
  // `keybindings` may be one object rather than an array; VSCode takes both.
  const bindings = (e: vscode.Extension<unknown>): Binding[] => [e.packageJSON.contributes?.keybindings ?? []].flat();
  const own = bindings(context.extension);
  const check = () => {
    const others = vscode.extensions.all
      .filter((e) => !e.packageJSON.isBuiltin && e.id !== context.extension.id)
      .map((e) => ({ id: e.id, bindings: bindings(e) }));
    const taken = yieldsTo(own, others, process.platform);
    for (const command of YIELDING) {
      const taker = taken.get(command);
      void vscode.commands.executeCommand("setContext", yieldKey(command), taker !== undefined);
      if (taker) {
        log?.info(`${command} leaves its key to ${taker}; bind it in keybindings.json to take it back`);
      }
    }
  };
  check();
  context.subscriptions.push(vscode.extensions.onDidChange(check));
}

export function activate(context: vscode.ExtensionContext) {
  tintIndentation(context);
  highlightUnicode(context);
  previewImages(context);
  log = vscode.window.createOutputChannel("Poly Editor", { log: true });
  // Two providers draw lenses that navigate to a list of places, so the
  // command they share is registered here rather than inside either of them --
  // registering it twice throws, and registering it in one means the other
  // silently depends on that one having been set up first.
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand("poly.showLocations", present),
  );
  yieldChords(context);
  countReferencesInGutter(context);
  runFromGutter(context);
  linkGeneratedGo(context);
  completePostfixes(context);
  registerTodoTree(context);
  referenceTree = registerReferenceTree(context);

  // The fence rule reads the setting on every render, so turning the diagrams
  // off only has to reach previews that are already open. Same command the
  // built-in uses for its own settings.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.markdownMermaid")) {
        void vscode.commands.executeCommand("markdown.preview.refresh");
      }
    }),
  );

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
    // One entry per refactoring, so the command id and the table cannot drift:
    // `poly.changeSignature` is `REFACTORINGS.changeSignature` by construction.
    ...(Object.keys(REFACTORINGS) as Refactoring[]).map(
      (want): [string, () => Promise<void>] => [
        `poly.${want}`,
        withEditor(REFACTORINGS[want].title, (editor) => runRefactor(editor, want)),
      ],
    ),
    [
      "poly.continueList",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await continueList(editor);
        }
      },
    ],
    [
      "poly.indentListItem",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await shiftListItem(editor, "indent");
        }
      },
    ],
    [
      "poly.outdentListItem",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await shiftListItem(editor, "outdent");
        }
      },
    ],
    [
      "poly.syntaxColors",
      withEditor("Syntax Colors", showSyntaxColors),
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

  // The markdown preview reads this off the activation result; there is no
  // `register…` call for it.
  return { extendMarkdownIt };
}

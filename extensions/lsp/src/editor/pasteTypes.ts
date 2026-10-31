/**
 * Paste as Types: JSON, YAML or TOML on the clipboard pasted as types in the
 * language being edited, by quicktype -- see `quicktype.ts`.
 *
 * Two ways in. A plain paste into a language quicktype writes offers it in
 * the editor's paste widget, beside the text and never instead of it: JSON
 * pasted into a Go test as a fixture is the commoner paste, so text stays the
 * default and the types are one click away. And two commands, for an editor
 * older than the paste API (1.85 has no `registerDocumentPasteEditProvider`)
 * and for a language the widget does not offer, which pick from all of them.
 */
import * as path from "path";
import * as vscode from "vscode";

import { LANGUAGE_TARGETS, looksLikeToml, mightBeData, placeGo } from "./pasteTypesOps";
import type { Source, Target } from "./quicktype";

let quick: typeof import("./quicktype") | undefined;
const load = () => quick ??= require(path.join(__dirname, "quicktype.js")) as typeof import("./quicktype");

/** transform's TOML reader, for text that looks enough like TOML to pay for its wasm. */
const toml = (text: string): unknown => {
  if (!looksLikeToml(text)) return undefined;
  const engine = require(path.join(__dirname, "transformEngine.js")) as typeof import("./transformEngine");
  return JSON.parse(engine.transform_format("TOML", "JSON", text));
};

const zh = () => /^zh-(tw|hant)/.test(vscode.env.language.toLowerCase());
const say = (en: string, zhText: string) => (zh() ? zhText : en);
const enabled = () => vscode.workspace.getConfiguration("poly").get<boolean>("toolbox.enabled", true);

function title(target: Target, typesOnly: boolean): string {
  if (!target.typesOnly) return say(`Paste as ${target.label}`, `貼上為 ${target.label}`);
  return typesOnly
    ? say(`Paste as ${target.label} Types`, `貼上為 ${target.label} 型別`)
    : say(`Paste as ${target.label} Code`, `貼上為 ${target.label} 程式碼`);
}

/** The document's indentation, which quicktype writes in rather than its own. */
function indentation(document: vscode.TextDocument): string {
  const options = vscode.window.visibleTextEditors.find((editor) => editor.document === document)?.options;
  return options?.insertSpaces === false ? "\t" : " ".repeat(Number(options?.tabSize) || 4);
}

/** `source` as `target` at `range`, as one edit: Go's imports go up top in the same undo step. */
async function pasteEdit(
  document: vscode.TextDocument,
  range: vscode.Range,
  source: Source,
  target: string,
  typesOnly: boolean,
): Promise<vscode.WorkspaceEdit> {
  const output = await load().generate(source, target, typesOnly, indentation(document));
  const edit = new vscode.WorkspaceEdit();
  if (target === "go") {
    const placed = placeGo(output, document.getText());
    edit.replace(document.uri, range, placed.body);
    if (placed.imports) edit.insert(document.uri, new vscode.Position(placed.imports.line, 0), placed.imports.text);
  } else {
    edit.replace(document.uri, range, `${output}\n`);
  }
  return edit;
}

/** What an offered edit needs to be resolved, kept beside it rather than in a subclass. */
interface Offer {
  readonly document: vscode.TextDocument;
  readonly range: vscode.Range;
  readonly text: string;
  readonly source: Source;
  readonly target: Target;
  readonly typesOnly: boolean;
}

/**
 * Not a subclass of `DocumentPasteEdit`: a class extending it is evaluated
 * when this bundle loads, and before 1.97 there is nothing to extend -- the
 * whole extension would fail to activate on the editors the commands are for.
 */
const offers = new WeakMap<vscode.DocumentPasteEdit, Offer>();

function registerPasteProvider(context: vscode.ExtensionContext) {
  const kind = vscode.DocumentDropOrPasteEditKind.Empty.append("poly", "types");
  const provider: vscode.DocumentPasteEditProvider = {
    async provideDocumentPasteEdits(document, ranges, dataTransfer, _context, token) {
      const targets = LANGUAGE_TARGETS[document.languageId];
      if (!targets || !enabled() || ranges.length !== 1) return undefined;
      const text = await dataTransfer.get("text/plain")?.asString();
      if (!text || !mightBeData(text) || token.isCancellationRequested) return undefined;
      const source = load().sourceOf(text, toml);
      if (!source) return undefined;
      return targets.flatMap((name) => {
        const target = load().TARGETS.find((one) => one.name === name);
        if (!target) return [];
        const modes = target.typesOnly ? [true, false] : [false];
        return modes.map((typesOnly) => {
          const edit = new vscode.DocumentPasteEdit(
            "",
            title(target, typesOnly),
            kind.append(target.name.replace(/\W/g, ""), typesOnly ? "types" : "code"),
          );
          // After plain text, so a paste stays a paste until the widget says otherwise.
          edit.yieldTo = [vscode.DocumentDropOrPasteEditKind.Text];
          offers.set(edit, { document, range: ranges[0], text, source, target, typesOnly });
          return edit;
        });
      });
    },
    async resolveDocumentPasteEdit(edit) {
      const offer = offers.get(edit);
      if (!offer) return edit;
      const { document, range, text, source, target, typesOnly } = offer;
      try {
        // Everything goes in `additionalEdit`: Go's imports land elsewhere in
        // the file, and splitting the edit would put them in another undo step.
        edit.additionalEdit = await pasteEdit(document, range, source, target.name, typesOnly);
      } catch (error) {
        // Still a paste: the text, and the reason it is not types.
        edit.insertText = text;
        void vscode.window.showErrorMessage(`quicktype: ${error instanceof Error ? error.message : String(error)}`);
      }
      return edit;
    },
  };
  context.subscriptions.push(
    vscode.languages.registerDocumentPasteEditProvider(
      Object.keys(LANGUAGE_TARGETS).map((language) => ({ language })),
      provider,
      { providedPasteEditKinds: [kind], pasteMimeTypes: ["text/plain"] },
    ),
  );
}

/** The command: the clipboard at the selection, in the document's language or one picked from all. */
async function pasteCommand(typesOnly: boolean, wanted?: unknown) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const source = load().sourceOf(await vscode.env.clipboard.readText(), toml);
  if (!source) {
    void vscode.window.showWarningMessage(
      say(
        "The clipboard holds no JSON, YAML or TOML object or array.",
        "剪貼簿裡沒有 JSON、YAML 或 TOML 的物件或陣列。",
      ),
    );
    return;
  }
  const targets = load().TARGETS;
  const own = LANGUAGE_TARGETS[editor.document.languageId]?.[0];
  let target = targets.find((one) => one.name === (typeof wanted === "string" ? wanted : own));
  if (!target) {
    const picked = await vscode.window.showQuickPick(
      [...targets].sort((a, b) => a.label.localeCompare(b.label)).map((one) => ({ label: one.label, target: one })),
      { placeHolder: say("Paste as which language?", "要貼上成哪個語言？") },
    );
    if (!picked) return;
    target = picked.target;
  }
  try {
    await vscode.workspace.applyEdit(
      await pasteEdit(editor.document, editor.selection, source, target.name, typesOnly),
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `quicktype: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function registerPasteTypes(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("poly.pasteAsTypes", (target?: unknown) => pasteCommand(true, target)),
    vscode.commands.registerCommand("poly.pasteAsCode", (target?: unknown) => pasteCommand(false, target)),
  );
  if ("registerDocumentPasteEditProvider" in vscode.languages && "DocumentDropOrPasteEditKind" in vscode) {
    registerPasteProvider(context);
  }
}

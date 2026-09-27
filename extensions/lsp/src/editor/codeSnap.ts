/**
 * adpyke.codesnap 1.3.4: a picture of the selected code, framed as a window.
 *
 * The page is upstream's own (codeSnap/, laid out in `dist/codesnap/` by the
 * build); this is its `extension.js`. The page gets the code in the editor's
 * colors by pasting what "Copy With Syntax Highlighting" put on the clipboard,
 * the one way an extension can have them. So, as with upstream, each selection
 * made while the page is open replaces what is on the clipboard.
 */
import { promises as fs } from "fs";
import { homedir } from "os";
import * as path from "path";
import * as vscode from "vscode";

const ROOT = path.join(__dirname, "codesnap");

/**
 * The extension this stands in for. When it is installed, its entry is already
 * in the editor's context menu, and a second with the same name only confuses.
 */
const ADPYKE = "adpyke.codesnap";

const SETTINGS = [
  "backgroundColor",
  "boxShadow",
  "containerPadding",
  "roundedCorners",
  "showWindowControls",
  "showWindowTitle",
  "showLineNumbers",
  "realLineNumbers",
  "transparentBackground",
  "target",
  "shutterAction",
];

/** `keys` under `section`, each from the editor language's block first, as upstream reads them. */
function settings(section: string, keys: string[]): Record<string, unknown> {
  const all = vscode.workspace.getConfiguration(section, null);
  const language = vscode.window.activeTextEditor?.document.languageId;
  const overrides = language
    ? vscode.workspace.getConfiguration(undefined, null).get<Record<string, unknown>>(`[${language}]`)
    : undefined;
  return Object.fromEntries(keys.map((key) => [key, overrides?.[`${section}.${key}`] ?? all.get(key)]));
}

function pageConfig() {
  const editor = vscode.window.activeTextEditor;
  const editorSettings = settings("editor", ["fontLigatures", "tabSize"]);
  if (editor) editorSettings.tabSize = editor.options.tabSize;
  const own = settings("poly.codeSnap", SETTINGS);
  const startLine = own.realLineNumbers ? editor?.selection.start.line ?? 0 : 0;
  const windowTitle = editor && own.showWindowTitle
    ? `${vscode.workspace.name} - ${editor.document.uri.path.split("/").pop()}`
    : "";
  return { ...editorSettings, ...own, startLine, windowTitle };
}

/** Where the save dialog starts: where the last picture went. */
let lastSaved = vscode.Uri.file(path.join(homedir(), "Desktop", "code.png"));

async function save(data: string) {
  const uri = await vscode.window.showSaveDialog({ filters: { Images: ["png"] }, defaultUri: lastSaved });
  // Upstream keeps a cancelled dialog's answer too, and the next dialog then
  // starts in no folder of the user's choosing.
  if (!uri) return;
  lastSaved = uri;
  try {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(data, "base64"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`CodeSnap 📸: could not save ${uri.fsPath}: ${reason}`);
  }
}

async function open(): Promise<vscode.WebviewPanel> {
  const panel = vscode.window.createWebviewPanel(
    "poly.codeSnap",
    "CodeSnap 📸",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, localResourceRoots: [vscode.Uri.file(ROOT)] },
  );
  const page = path.join(ROOT, "index.html");
  panel.webview.html = (await fs.readFile(page, "utf8"))
    .replace(/%CSP_SOURCE%/gu, panel.webview.cspSource)
    .replace(
      /(src|href)="([^"]*)"/gu,
      (_all, attribute: string, src: string) =>
        `${attribute}="${panel.webview.asWebviewUri(vscode.Uri.file(path.resolve(page, "..", src)))}"`,
    );
  return panel;
}

async function snap() {
  const panel = await open();
  const update = async () => {
    await vscode.commands.executeCommand("editor.action.clipboardCopyWithSyntaxHighlightingAction");
    void panel.webview.postMessage({ type: "update", ...pageConfig() });
  };
  panel.webview.onDidReceiveMessage(async ({ type, data }: { type: string; data: string }) => {
    if (type === "save") {
      void panel.webview.postMessage({ type: "flash" });
      await save(data);
    } else {
      void vscode.window.showErrorMessage(`CodeSnap 📸: Unknown shutterAction "${type}"`);
    }
  });
  const oneSelection = (selections: readonly vscode.Selection[]) => selections.length === 1 && !selections[0].isEmpty;
  const selection = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (oneSelection(event.selections)) void update();
  });
  panel.onDidDispose(() => selection.dispose());
  const editor = vscode.window.activeTextEditor;
  if (editor && oneSelection(editor.selections)) void update();
}

export function registerCodeSnap(context: vscode.ExtensionContext) {
  const standDown = () =>
    void vscode.commands.executeCommand(
      "setContext",
      "poly.yield.codeSnap",
      vscode.extensions.getExtension(ADPYKE) !== undefined,
    );
  standDown();
  context.subscriptions.push(
    vscode.extensions.onDidChange(standDown),
    vscode.commands.registerCommand("poly.codeSnap", snap),
  );
}

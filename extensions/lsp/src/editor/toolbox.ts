/**
 * The Toolbox: linzeyan/transform's tools, DevToys-style. A tree on the
 * activity bar lists them; each opens transform's own page in an editor tab.
 *
 * The page is transform's release, laid out in `dist/transform/` by
 * tools/transform-assets.js, in its embed mode: `<html class="embed">` hides
 * its sidebar and maps its colours onto the theme's, `#/<tool-id>` picks the
 * tool, and since a webview cannot download, saving posts `transform.save`
 * here instead. Open Selection in Toolbox hands the page the selected text
 * (`transform.input`, once the page says `transform.ready`), and the page's
 * Replace Selection posts the result back (`transform.replace`). The interface
 * is transform's `embed-mode.md`.
 */
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { registerToolboxCommands } from "./toolboxCommands";
import { textFormatOf } from "./toolboxOps";

const ROOT = path.join(__dirname, "transform");
const VIEW_TYPE = "poly.toolbox";

interface Tool {
  id: string;
  icon: string;
  en: string;
  zh: string;
  enHint: string;
  zhHint: string;
  /** The page can be opened with text in it: `embedFields` in transform's main.js. */
  input?: boolean;
}

interface Group {
  en: string;
  zh: string;
  tools: Tool[];
}

/** What the page keeps with `setState`, for the tab to come back after a reload. */
interface State {
  tool: string;
}

/** Text a tab was opened with, and the place in the file its result goes back to. */
interface Selection {
  text: string;
  /** transform's name for the text's format, for the converter's From. */
  format?: string;
  uri: vscode.Uri;
  range: vscode.Range;
  /** The document's version when the text was taken: an edit since moves the range. */
  version: number;
  sent?: boolean;
}

// The tree's order and labels, and which of transform's routes poly offers:
// not Browser Fingerprint, which would measure VSCode's Electron, nor Text
// Diff, which the built-in compare does. tools/transform-assets.js fails the
// build when the page no longer has one of these routes.
const GROUPS: Group[] = require("./toolbox.json");

const zh = () => /^zh-(tw|hant)/.test(vscode.env.language.toLowerCase());
const say = (en: string, zhText: string) => (zh() ? zhText : en);
const label = (item: Group | Tool) => (zh() ? item.zh : item.en);
const TOOLS = GROUPS.flatMap((group) => group.tools);

class Tree implements vscode.TreeDataProvider<Group | Tool> {
  getChildren(group?: Group): (Group | Tool)[] {
    return group ? group.tools : GROUPS;
  }

  getTreeItem(item: Group | Tool): vscode.TreeItem {
    if ("tools" in item) return new vscode.TreeItem(label(item), vscode.TreeItemCollapsibleState.Expanded);
    const tree = new vscode.TreeItem(label(item));
    tree.iconPath = new vscode.ThemeIcon(item.icon);
    tree.tooltip = zh() ? item.zhHint : item.enHint;
    tree.command = { command: "poly.toolbox.open", title: label(item), arguments: [item.id] };
    return tree;
  }
}

const panels = new Map<string, vscode.WebviewPanel>();
/** Tabs whose page said `transform.ready`: before it, text would meet a page still loading its wasm. */
const ready = new WeakSet<vscode.WebviewPanel>();
/** Each tab's latest selection: sent once the page is ready, and replaced by its result on request. */
const selections = new WeakMap<vscode.WebviewPanel, Selection>();
let template: string | undefined;
// One save dialog at a time: a batch (Encrypt / Decrypt's files) posts its
// messages 100 ms apart, and each would otherwise open a dialog over the last.
let saving = Promise.resolve();

async function html(webview: vscode.Webview, tool: string): Promise<string> {
  template ??= await fs.readFile(path.join(ROOT, "index.html"), "utf8");
  const nonce = randomBytes(16).toString("base64");
  const root = webview.asWebviewUri(vscode.Uri.file(ROOT)).toString();
  const csp = [
    "default-src 'none'",
    // Image tools preview through blob: and data: URLs.
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    // The wasm is compiled from fetched bytes, which CSP counts as eval.
    `script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `connect-src ${webview.cspSource}`,
  ].join("; ");
  // Before transform's module script, which reads the route at start-up and
  // asks for the API itself: a page may acquire it only once, so the one
  // acquired here to keep the tool is the one it gets.
  const boot = `
    location.hash = ${JSON.stringify(`#/${tool}`)};
    const api = acquireVsCodeApi();
    api.setState(${JSON.stringify({ tool } satisfies State)});
    window.acquireVsCodeApi = () => api;`;
  return (
    template
      .replace("<html ", "<html class=\"embed\" ")
      .replace(
        "<head>",
        `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<script nonce="${nonce}">${boot}</script>`,
      )
      // The page's own files, which it names relative to itself.
      .replace(/ (href|src)="(?!#|[a-z]+:)([^"]+)"/g, (_, attribute, file) => ` ${attribute}="${root}/${file}"`)
  );
}

async function save(message: { name?: unknown; bytes?: unknown }) {
  const name = typeof message.name === "string" ? path.basename(message.name) : "download";
  const bytes = message.bytes instanceof Uint8Array
    ? message.bytes
    : message.bytes instanceof ArrayBuffer
    ? new Uint8Array(message.bytes)
    : undefined;
  if (!bytes) {
    void vscode.window.showErrorMessage(`Toolbox: ${name} arrived without its contents.`);
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, name) });
  if (target) await vscode.workspace.fs.writeFile(target, bytes);
}

/** Hand the tab's selection to its page, once, when there is one and the page can take it. */
function send(panel: vscode.WebviewPanel) {
  const selection = selections.get(panel);
  if (!selection || selection.sent || !ready.has(panel)) return;
  selection.sent = true;
  void panel.webview.postMessage({
    type: "transform.input",
    text: selection.text,
    format: selection.format,
    replace: true,
  });
}

/** The page's result for the selection it was opened with, written over that selection. */
async function replace(panel: vscode.WebviewPanel, text: unknown) {
  const selection = selections.get(panel);
  if (typeof text !== "string" || !selection) return;
  const document = vscode.workspace.textDocuments.find((one) => one.uri.toString() === selection.uri.toString());
  // A range taken before an edit may now cut through other text; asking again
  // is cheaper than undoing a replacement in the wrong place.
  if (!document || document.version !== selection.version) {
    void vscode.window.showWarningMessage(
      say(
        "The file changed after its text was sent to the Toolbox. Select the text and open it again.",
        "文字送進工具箱之後，檔案又改過了。請重新選取再開啟一次。",
      ),
    );
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, selection.range, text);
  if (await vscode.workspace.applyEdit(edit)) selections.delete(panel);
}

function show(tool: string, panel?: vscode.WebviewPanel, selection?: Selection) {
  const entry = TOOLS.find((one) => one.id === tool);
  if (!entry) {
    panel?.dispose();
    return;
  }
  const open = panels.get(tool);
  if (open && !panel) {
    if (selection) {
      selections.set(open, selection);
      send(open);
    }
    open.reveal();
    return;
  }
  const options = { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(ROOT)] };
  if (panel) {
    // A restored panel keeps the options it was saved with, and with them
    // the folder of whichever poly version drew it last.
    panel.webview.options = options;
  } else {
    // Beside the text it was opened with, whose selection it may write back to.
    const column = selection ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    panel = vscode.window.createWebviewPanel(VIEW_TYPE, label(entry), column, options);
  }
  if (selection) selections.set(panel, selection);
  panel.title = label(entry);
  panel.iconPath = vscode.Uri.file(path.join(ROOT, "favicon.svg"));
  panels.set(tool, panel);
  const shown = panel;
  const disposables = [
    panel.webview.onDidReceiveMessage((message) => {
      switch (message?.type) {
        case "transform.save":
          saving = saving
            .then(() => save(message))
            .catch((error) =>
              void vscode.window.showErrorMessage(`Toolbox: ${error instanceof Error ? error.message : error}`)
            );
          break;
        case "transform.ready":
          ready.add(shown);
          send(shown);
          break;
        case "transform.replace":
          void replace(shown, message.text);
          break;
      }
    }),
  ];
  panel.onDidDispose(() => {
    if (panels.get(tool) === panel) panels.delete(tool);
    for (const one of disposables) one.dispose();
  });
  void html(panel.webview, tool).then((page) => (panel!.webview.html = page));
}

/** The tree as a list to type into, keeping the tools `offered` and the groups that still have one. */
async function pick(offered: (tool: Tool) => boolean, placeHolder?: string): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    GROUPS.flatMap((group) => {
      const tools = group.tools.filter(offered);
      return tools.length
        ? [
          { label: label(group), kind: vscode.QuickPickItemKind.Separator },
          ...tools.map((one) => ({
            label: `$(${one.icon}) ${label(one)}`,
            detail: zh() ? one.zhHint : one.enHint,
            id: one.id,
          })),
        ]
        : [];
    }),
    { matchOnDetail: true, placeHolder },
  );
  return picked && "id" in picked ? picked.id : undefined;
}

export function registerToolbox(context: vscode.ExtensionContext) {
  registerToolboxCommands(context);
  context.subscriptions.push(
    vscode.window.createTreeView("polyToolbox", { treeDataProvider: new Tree() }),
    vscode.commands.registerCommand("poly.toolbox.open", async (tool: unknown) => {
      const id = typeof tool === "string" ? tool : await pick(() => true);
      if (id) show(id);
    }),
    vscode.commands.registerCommand("poly.toolbox.openSelection", async (tool: unknown) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showInformationMessage(
          say("Select the text to open in the Toolbox first.", "請先選取要在工具箱開啟的文字。"),
        );
        return;
      }
      const takes = (one: Tool) => one.input === true;
      const id = TOOLS.some((one) => one.id === tool && takes(one))
        ? (tool as string)
        : await pick(takes, say("Open the selection in", "以這個工具開啟選取範圍"));
      if (!id) return;
      const { document, selection } = editor;
      show(id, undefined, {
        text: document.getText(selection),
        format: textFormatOf(document.languageId),
        uri: document.uri,
        range: selection,
        version: document.version,
      });
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel, state?: State) {
        // Switched off, a restored tab would be the feature appearing anyway.
        if (!state?.tool || !vscode.workspace.getConfiguration("poly.toolbox").get("enabled", true)) {
          panel.dispose();
        } else {
          show(state.tool, panel);
        }
        return Promise.resolve();
      },
    }),
  );
}

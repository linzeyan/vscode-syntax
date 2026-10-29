/**
 * The Toolbox: linzeyan/transform's tools, DevToys-style. A tree on the
 * activity bar lists them; each opens transform's own page in an editor tab.
 *
 * The page is transform's release, laid out in `dist/transform/` by
 * tools/transform-assets.js, in its embed mode: `<html class="embed">` hides
 * its sidebar and maps its colours onto the theme's, `#/<tool-id>` picks the
 * tool, and since a webview cannot download, saving posts `transform.save`
 * here instead. The interface is transform's `embed-mode.md`.
 */
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { registerToolboxCommands } from "./toolboxCommands";

const ROOT = path.join(__dirname, "transform");
const VIEW_TYPE = "poly.toolbox";

interface Tool {
  id: string;
  icon: string;
  en: string;
  zh: string;
  enHint: string;
  zhHint: string;
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

// The tree's order and labels, and which of transform's routes poly offers:
// not Browser Fingerprint, which would measure VSCode's Electron, nor Text
// Diff, which the built-in compare does. tools/transform-assets.js fails the
// build when the page no longer has one of these routes.
const GROUPS: Group[] = require("./toolbox.json");

const zh = () => /^zh-(tw|hant)/.test(vscode.env.language.toLowerCase());
const label = (item: Group | Tool) => (zh() ? item.zh : item.en);

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
      .replace("<html ", '<html class="embed" ')
      .replace("<head>", `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<script nonce="${nonce}">${boot}</script>`)
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

function show(tool: string, panel?: vscode.WebviewPanel) {
  const entry = GROUPS.flatMap((group) => group.tools).find((one) => one.id === tool);
  if (!entry) {
    panel?.dispose();
    return;
  }
  const open = panels.get(tool);
  if (open && !panel) {
    open.reveal();
    return;
  }
  const options = { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(ROOT)] };
  if (panel) {
    // A restored panel keeps the options it was saved with, and with them
    // the folder of whichever poly version drew it last.
    panel.webview.options = options;
  } else {
    panel = vscode.window.createWebviewPanel(VIEW_TYPE, label(entry), vscode.ViewColumn.Active, options);
  }
  panel.title = label(entry);
  panel.iconPath = vscode.Uri.file(path.join(ROOT, "favicon.svg"));
  panels.set(tool, panel);
  const disposables = [
    panel.webview.onDidReceiveMessage((message) => {
      if (message?.type !== "transform.save") return;
      saving = saving
        .then(() => save(message))
        .catch((error) => void vscode.window.showErrorMessage(`Toolbox: ${error instanceof Error ? error.message : error}`));
    }),
  ];
  panel.onDidDispose(() => {
    if (panels.get(tool) === panel) panels.delete(tool);
    for (const one of disposables) one.dispose();
  });
  void html(panel.webview, tool).then((page) => (panel!.webview.html = page));
}

export function registerToolbox(context: vscode.ExtensionContext) {
  registerToolboxCommands(context);
  context.subscriptions.push(
    vscode.window.createTreeView("polyToolbox", { treeDataProvider: new Tree() }),
    vscode.commands.registerCommand("poly.toolbox.open", async (tool: unknown) => {
      if (typeof tool === "string") return show(tool);
      // From the palette, the tree as a list to type into.
      const picked = await vscode.window.showQuickPick(
        GROUPS.flatMap((group) => [
          { label: label(group), kind: vscode.QuickPickItemKind.Separator },
          ...group.tools.map((one) => ({ label: `$(${one.icon}) ${label(one)}`, detail: zh() ? one.zhHint : one.enHint, id: one.id })),
        ]),
        { matchOnDetail: true },
      );
      if (picked && "id" in picked) show(picked.id);
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state?: State) {
        // Switched off, a restored tab would be the feature appearing anyway.
        if (!state?.tool || !vscode.workspace.getConfiguration("poly.toolbox").get("enabled", true)) {
          panel.dispose();
          return;
        }
        show(state.tool, panel);
      },
    }),
  );
}

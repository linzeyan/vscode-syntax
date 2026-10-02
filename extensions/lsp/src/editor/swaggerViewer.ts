/**
 * arjun.swagger-viewer 3.2.0: Swagger UI for the Swagger or OpenAPI file being
 * edited, updating as it is typed, plus a list of the workspace's specs and
 * their validation.
 *
 * This is upstream's `src/preview/client.ts`. As there, the preview is a page
 * served from localhost (swaggerPreview.ts, loaded on the first preview) and
 * framed in a webview, which is what lets `previewInBrowser` open the very same
 * page in a browser instead. The page is upstream's own (swaggerViewer/, laid
 * out in `dist/swagger/` by the build).
 */
import { readFileSync } from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import * as vscode from "vscode";

const ROOT = path.join(__dirname, "swagger");

/**
 * The extension this stands in for. When it is installed, its entries are
 * already in the menus and its list in the explorer, and its schemas already
 * go to redhat.vscode-yaml.
 */
const ARJUN = "arjun.swagger-viewer";

let server: typeof import("./swaggerPreview") | undefined;
const load = () => server ??= require(path.join(__dirname, "swaggerPreview.js")) as typeof import("./swaggerPreview");

const config = () => vscode.workspace.getConfiguration("poly.swaggerViewer");

let statusBarItem: vscode.StatusBarItem | undefined;

function inline(previewUrl: string, filename: string) {
  const panel = vscode.window.createWebviewPanel(
    "poly.swaggerPreview",
    `Swagger Preview - ${config().get("showOnlyFileName") ? path.basename(filename) : filename}`,
    vscode.ViewColumn.Two,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
      enableCommandUris: true,
      enableFindWidget: true,
    },
  );
  const zoomStyle = `zoom: ${config().get<number>("zoomLevel") || 100}%`;
  panel.webview.html = `
			<!DOCTYPE html>
			<html>
				<head>
					<meta charset="UTF-8">
					<meta name="viewport" content="width=device-width, initial-scale=1.0">
				</head>
				<body style="margin:0px;padding:0px;overflow:hidden;${zoomStyle}">
					<div style="position:fixed;height:100%;width:100%;">
					<iframe src="${previewUrl}" frameborder="0" style="overflow:hidden;height:100%;width:100%" height="100%" width="100%"></iframe>
					</div>
				</body>
			</html>
		`;
}

/** Serves the spec and opens its page, framed or in the browser. */
async function show(context: vscode.ExtensionContext, filename: string, content: unknown) {
  const preview = load();
  await preview.update(filename, content);
  const previewUrl = (await vscode.env.asExternalUri(vscode.Uri.parse(preview.url(filename)))).toString();
  if (config().get("previewInBrowser")) {
    void vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(previewUrl));
  } else {
    inline(previewUrl, filename);
  }
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
    statusBarItem.command = "poly.swaggerStop";
    statusBarItem.text = "Swagger Viewer";
    statusBarItem.tooltip = "Stop Swagger Preview Server";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
  }
}

/** The server, listening where the settings say; they are read each time it starts. */
function start() {
  return load().start(config().get("defaultHost") || "localhost", config().get("defaultPort") || 18512);
}

function previewFile(context: vscode.ExtensionContext, uri?: vscode.Uri) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Starting Swagger Preview" },
    async (progress) => {
      progress.report({ increment: 0 });
      await start();
      const preview = load();
      let filename: string;
      let content: unknown;
      if (uri) {
        filename = uri.fsPath;
        // Upstream compares the extension to "json", which `extname` never
        // returns, and so reads a JSON file as YAML.
        content = preview.parse(
          readFileSync(filename).toString(),
          path.extname(filename) === ".json" ? "json" : "yaml",
        );
      } else {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          void vscode.window.showErrorMessage("No active editor found. Please open a Swagger/OpenAPI file.");
          return;
        }
        filename = editor.document.fileName;
        content = preview.parse(editor.document.getText(), editor.document.languageId);
        if (!content) {
          void vscode.window.showErrorMessage("Failed to parse file. Please ensure it's a valid JSON or YAML file.");
          return;
        }
      }
      await show(context, filename, content);
    },
  );
}

function fetchFromUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

async function previewFromUrl(context: vscode.ExtensionContext) {
  const url = await vscode.window.showInputBox({
    prompt: "Enter the URL of the Swagger/OpenAPI file",
    placeHolder: "https://example.com/api/swagger.json",
    validateInput: (value) => {
      if (!value) return "URL cannot be empty";
      if (!value.startsWith("http://") && !value.startsWith("https://")) {
        return "URL must start with http:// or https://";
      }
      return null;
    },
  });
  if (!url) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fetching Swagger from ${url}` },
    async (progress) => {
      try {
        progress.report({ increment: 30 });
        const content = await fetchFromUrl(url);
        progress.report({ increment: 60 });
        await start();
        const languageId = url.endsWith(".json") || content.trim().startsWith("{") ? "json" : "yaml";
        const parsed = load().parse(content, languageId);
        if (!parsed) {
          void vscode.window.showErrorMessage(
            "Failed to parse content from URL. Please ensure it's a valid Swagger/OpenAPI file.",
          );
          return;
        }
        await show(context, url, parsed);
        void vscode.window.showInformationMessage(`Successfully loaded Swagger from ${url}`);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to fetch Swagger from URL: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}

/** Upstream's "Swagger/OpenAPI Files": each spec in the workspace, opening its preview. */
class SwaggerFiles implements vscode.TreeDataProvider<vscode.TreeItem> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh() {
    this.changed.fire();
  }

  getTreeItem(item: vscode.TreeItem) {
    return item;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    if (!vscode.workspace.workspaceFolders) {
      void vscode.window.showInformationMessage("No workspace folder open");
      return [];
    }
    const files = await vscode.workspace.findFiles("**/*.{json,yaml,yml}", "**/node_modules/**");
    const items: vscode.TreeItem[] = [];
    for (const file of files) {
      if (!await load().isSpec(file.fsPath)) continue;
      const item = new vscode.TreeItem(vscode.workspace.asRelativePath(file), vscode.TreeItemCollapsibleState.None);
      item.resourceUri = file;
      item.tooltip = file.fsPath;
      item.command = { command: "poly.swaggerPreview", title: "Preview Swagger", arguments: [file] };
      item.contextValue = "swaggerFile";
      items.push(item);
    }
    return items;
  }
}

/**
 * Hands redhat.vscode-yaml the two schemas for YAML specs, as upstream's
 * contributor does. That means activating it, which starts its language
 * server, so it waits for the first YAML file: redhat activates on one anyway.
 */
function contributeSchemas(context: vscode.ExtensionContext) {
  const contribute = async () => {
    const redhat = vscode.extensions.getExtension("redhat.vscode-yaml");
    if (!redhat || vscode.extensions.getExtension(ARJUN)) return;
    const api = redhat.isActive ? redhat.exports : await redhat.activate();
    const schema = (name: string) => readFileSync(path.join(ROOT, "schemas", name), "utf8");
    try {
      api.registerContributor(
        "swaggerviewer",
        // Asked per document, so the switch is read here rather than when
        // registering: redhat offers no way to take a contributor back.
        (uri: string) => {
          if (!vscode.workspace.getConfiguration("poly.swaggerViewer").get("enabled", true)) return null;
          const document = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri);
          return document ? load().schemaOf(document.getText()) : null;
        },
        (uri: string) =>
          uri === "swaggerviewer:swagger"
            ? schema("swagger.json")
            : uri === "swaggerviewer:openapi"
            ? schema("openapi.json")
            : null,
      );
    } catch (error) {
      console.error("Error registering YAML contributor:", error);
    }
  };
  const isYaml = (document: vscode.TextDocument) => document.languageId === "yaml";
  if (vscode.workspace.textDocuments.some(isYaml)) {
    void contribute();
    return;
  }
  const opened = vscode.workspace.onDidOpenTextDocument((document) => {
    if (!isYaml(document)) return;
    opened.dispose();
    void contribute();
  });
  context.subscriptions.push(opened);
}

export function registerSwaggerViewer(context: vscode.ExtensionContext) {
  const standDown = () =>
    void vscode.commands.executeCommand(
      "setContext",
      "poly.yield.swaggerViewer",
      vscode.extensions.getExtension(ARJUN) !== undefined,
    );
  standDown();
  const files = new SwaggerFiles();
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{json,yaml,yml}");
  context.subscriptions.push(
    vscode.extensions.onDidChange(standDown),
    vscode.commands.registerCommand("poly.swaggerPreview", (uri?: vscode.Uri) => previewFile(context, uri)),
    vscode.commands.registerCommand("poly.swaggerPreviewFromUrl", () => previewFromUrl(context)),
    vscode.commands.registerCommand("poly.swaggerStop", () => {
      server?.stop();
      statusBarItem?.dispose();
      statusBarItem = undefined;
    }),
    // Upstream sends the active editor's text on every edit, and again when
    // any JSON or YAML file changes on disk, since the spec may `$ref` it; it
    // bundles the text even when no preview was ever opened. Only a file whose
    // preview was opened has a page to send it to.
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (document !== vscode.window.activeTextEditor?.document || !server?.previewed(document.fileName)) return;
      void server.update(document.fileName, server.parse(document.getText(), document.languageId));
    }),
    vscode.window.createTreeView("polySwaggerFiles", { treeDataProvider: files }),
    watcher,
    watcher.onDidCreate(() => files.refresh()),
    watcher.onDidDelete(() => files.refresh()),
    watcher.onDidChange(() => {
      files.refresh();
      const document = vscode.window.activeTextEditor?.document;
      if (!document || !server?.previewed(document.fileName)) return;
      const content = server.parse(document.getText(), document.languageId);
      if (content) void server.update(document.fileName, content);
    }),
    { dispose: () => server?.stop() },
  );
  contributeSchemas(context);
}

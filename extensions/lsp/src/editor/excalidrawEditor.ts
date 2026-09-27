/**
 * Excalidraw in the editor, as pomdtr.excalidraw-editor offers it: the custom
 * editor for `.excalidraw` and the SVG and PNG scenes, its library, its
 * commands and the link libraries.excalidraw.com sends a library back with.
 *
 * pomdtr's editor.ts, document.ts and commands.ts, rewritten here; its page is
 * rebuilt from source under preview/excalidraw. Where this differs it is one
 * of pomdtr's bugs, each marked where it was.
 */
import { randomBytes } from "crypto";
import * as vscode from "vscode";

import { BinaryDocument, BinaryEditorProvider } from "./binaryDocument";
import { contentTypeOf, excalidrawHtml, imageParams, ImageSetting, isScene, LANGUAGES, sceneName } from "./excalidraw";

const VIEW_TYPE = "poly.excalidraw";
const SETTINGS = "poly.excalidraw";

/** Library changes, shared by every open editor so they all show the same one. */
const libraryChanged = new vscode.EventEmitter<string>();
/** A library the browser sent back through the URI handler. */
const libraryImported = new vscode.EventEmitter<string>();

class Provider extends BinaryEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {
    super(new TextEncoder().encode(JSON.stringify({ type: "excalidraw", elements: [] })));
  }

  async resolveCustomEditor(document: BinaryDocument, panel: vscode.WebviewPanel) {
    const disposable = await setUp(this.context, document, panel.webview);
    panel.onDidDispose(() => disposable.dispose());
  }
}

function settings() {
  return vscode.workspace.getConfiguration(SETTINGS);
}

function language(): string | undefined {
  return settings().get<string>("language") || LANGUAGES[vscode.env.language];
}

/**
 * The file `poly.excalidraw.workspaceLibraryPath` names in the drawing's
 * workspace folder, or undefined for the library kept in VSCode's storage.
 * pomdtr found the folder by splitting the path on the OS separator, which
 * never matched a URI's path on Windows.
 */
function libraryUri(document: vscode.Uri): vscode.Uri | undefined {
  const file = settings().get<string>("workspaceLibraryPath");
  const folder = vscode.workspace.getWorkspaceFolder(document);
  return file && folder ? vscode.Uri.joinPath(folder.uri, file) : undefined;
}

async function loadLibrary(context: vscode.ExtensionContext, uri: vscode.Uri | undefined) {
  if (uri) {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to load library: ${error}`);
    }
  }
  return context.globalState.get<string>("library");
}

async function saveLibrary(context: vscode.ExtensionContext, library: string, uri: vscode.Uri | undefined) {
  if (!uri) {
    return context.globalState.update("library", library);
  }
  try {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(library));
  } catch (error) {
    await vscode.window.showErrorMessage(`Failed to save library: ${error}`);
  }
}

async function setUp(context: vscode.ExtensionContext, document: BinaryDocument, webview: vscode.Webview) {
  webview.options = { enableScripts: true };
  let library = libraryUri(document.uri);
  const affects = (event: vscode.ConfigurationChangeEvent, key: string) =>
    event.affectsConfiguration(`${SETTINGS}.${key}`, document.uri);

  const render = async () => {
    const dist = vscode.Uri.joinPath(context.extensionUri, "dist", "excalidraw");
    webview.html = excalidrawHtml({
      config: {
        content: Array.from(document.content),
        contentType: contentTypeOf(document.uri.path),
        library: await loadLibrary(context, library),
        // Read-only where there is nothing to save to: the old side of a diff.
        viewModeEnabled: ["git", "conflictResolution"].includes(document.uri.scheme) || undefined,
        theme: settings().get("theme", "light"),
        imageParams: imageParams(settings().get<ImageSetting>("image")),
        langCode: language(),
        name: sceneName(document.uri.path),
        libraryReturnUrl: `${vscode.env.uriScheme}://${context.extension.id}/importLib`,
      },
      script: webview.asWebviewUri(vscode.Uri.joinPath(dist, "main.js")).toString(),
      style: webview.asWebviewUri(vscode.Uri.joinPath(dist, "main.css")).toString(),
      assets: `${webview.asWebviewUri(dist)}/`,
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString("base64"),
    });
  };
  await render();

  return vscode.Disposable.from(
    document.onDidRevert(render),
    webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "library-change":
          await saveLibrary(context, message.library, library);
          libraryChanged.fire(message.library);
          break;
        case "change":
          document.update(new Uint8Array(message.content));
          break;
        case "link-open":
          await openLink(vscode.Uri.parse(message.url), document.uri);
          break;
        case "error":
          vscode.window.showErrorMessage(message.content);
          break;
        case "info":
          vscode.window.showInformationMessage(message.content);
          break;
      }
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (affects(event, "theme")) {
        webview.postMessage({ type: "theme-change", theme: settings().get("theme", "light") });
      }
      if (affects(event, "language")) {
        webview.postMessage({ type: "language-change", langCode: language() });
      }
      if (affects(event, "image")) {
        webview.postMessage({
          type: "image-params-change",
          imageParams: imageParams(settings().get<ImageSetting>("image")),
        });
      }
      if (affects(event, "workspaceLibraryPath")) {
        library = libraryUri(document.uri);
        webview.postMessage({ type: "library-change", library: await loadLibrary(context, library), merge: false });
      }
    }),
    libraryImported.event((imported) =>
      webview.postMessage({ type: "library-change", library: imported, merge: true })
    ),
    libraryChanged.event((changed) => webview.postMessage({ type: "library-change", library: changed, merge: false })),
  );
}

/**
 * A link on a shape. Scenes open in this editor, other files in a text
 * editor, both relative to the drawing; anything else goes to the browser.
 */
async function openLink(uri: vscode.Uri, source: vscode.Uri) {
  if (uri.scheme !== "file") {
    await vscode.env.openExternal(uri);
    return;
  }
  const target = vscode.Uri.joinPath(source, "..", uri.path);
  try {
    if ((await vscode.workspace.fs.stat(target)).type !== vscode.FileType.File) {
      throw new Error(`${target.fsPath} is not a file`);
    }
  } catch {
    await vscode.env.openExternal(uri);
    return;
  }
  if (isScene(target.path)) {
    await showEditor(target);
  } else {
    await vscode.window.showTextDocument(target, { preview: true });
  }
}

function showEditor(uri: vscode.Uri, column?: vscode.ViewColumn) {
  return vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE, column);
}

function showSource(uri: vscode.Uri, column?: vscode.ViewColumn) {
  return vscode.window.showTextDocument(uri, { viewColumn: column });
}

function showImage(uri: vscode.Uri, column?: vscode.ViewColumn) {
  return vscode.commands.executeCommand("vscode.openWith", uri, "imagePreview.previewEditor", column);
}

let untitled = 0;

/** An untitled scene, in the workspace so that saving it offers a folder there. */
async function newFile() {
  untitled += 1;
  const editor = vscode.window.activeTextEditor;
  const folder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri))
    ?? vscode.workspace.workspaceFolders?.[0];
  const name = `Untitled-${untitled}.excalidraw`;
  const uri = folder
    ? vscode.Uri.joinPath(folder.uri, name).with({ scheme: "untitled" })
    : vscode.Uri.parse(`untitled:${name}`);
  try {
    await showEditor(uri);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to create new file: ${error}`);
  }
}

/**
 * The theme, previewed as the pick moves and put back if it is dismissed.
 * Written where it is set now, so a workspace's choice stays the workspace's.
 */
function pickTheme() {
  const config = settings();
  const initial = config.get<string>("theme");
  const inspect = config.inspect("theme");
  const target = inspect?.workspaceFolderValue
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : inspect?.workspaceValue
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  const set = (theme: string | undefined) => config.update("theme", theme, target);

  const pick = vscode.window.createQuickPick();
  pick.items = [
    { label: "light", description: "Always use light theme" },
    { label: "dark", description: "Always use dark theme" },
    { label: "auto", description: "Sync theme with VSCode" },
  ];
  pick.activeItems = pick.items.filter((item) => item.label === initial);
  let accepted = false;
  pick.onDidChangeActive((active) => active.length > 0 && set(active[0].label));
  pick.onDidAccept(() => {
    accepted = true;
    set(pick.activeItems[0]?.label ?? initial);
    pick.hide();
  });
  pick.onDidHide(() => accepted || set(initial));
  pick.show();
}

/**
 * The title bar passes the file; the palette passes nothing, and means the
 * one in the active tab. pomdtr kept these out of the palette instead.
 */
function onFile(open: (uri: vscode.Uri, column?: vscode.ViewColumn) => unknown, column?: vscode.ViewColumn) {
  return (uri?: vscode.Uri) => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const file = uri
      ?? (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText ? input.uri : undefined);
    return file && open(file, column);
  };
}

export function registerExcalidraw(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new Provider(context), {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        const url = new URLSearchParams(uri.fragment).get("addLibrary");
        if (!url) {
          vscode.window.showErrorMessage("Invalid URL!");
          return;
        }
        libraryImported.fire(await (await fetch(url)).text());
      },
    }),
    vscode.commands.registerCommand("poly.excalidrawNewFile", newFile),
    vscode.commands.registerCommand("poly.excalidrawTheme", pickTheme),
    vscode.commands.registerCommand("poly.excalidrawShowSource", onFile(showSource)),
    vscode.commands.registerCommand("poly.excalidrawShowSourceToSide", onFile(showSource, vscode.ViewColumn.Beside)),
    vscode.commands.registerCommand("poly.excalidrawShowEditor", onFile(showEditor)),
    vscode.commands.registerCommand("poly.excalidrawShowEditorToSide", onFile(showEditor, vscode.ViewColumn.Beside)),
    vscode.commands.registerCommand("poly.excalidrawShowImage", onFile(showImage)),
    vscode.commands.registerCommand("poly.excalidrawShowImageToSide", onFile(showImage, vscode.ViewColumn.Beside)),
    // Bound to undo and redo in the editor: the page undoes on its own, and
    // VSCode's undo would reach past it.
    vscode.commands.registerCommand("poly.excalidrawPreventDefault", () => undefined),
  );
}

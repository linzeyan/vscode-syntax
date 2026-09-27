/**
 * draw.io in the editor, as hediet.vscode-drawio offers it: the diagram in
 * draw.io's own web app, kept in step with the file.
 *
 * The XML and the SVG stay TextDocuments and the page is one view of them:
 * draw.io's autosave replaces the text, and an edit made anywhere else -- the
 * XML open beside it, a checkout -- is merged into the drawing. Dirty state,
 * saving and hot exit are VSCode's, as for any text. A PNG is bytes, kept by
 * binaryDocument.ts. Either image is written from draw.io's own export, with
 * the diagram inside.
 */
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { posix } from "path";
import * as vscode from "vscode";

import { BinaryDocument, BinaryEditorProvider } from "./binaryDocument";
import {
  Appearance,
  appearanceOf,
  CodeLink,
  ColorThemeKind,
  CustomLibrary,
  DRAWIO_KINDS,
  drawioConfig,
  drawioHtml,
  DrawioKind,
  drawioKind,
  drawioLanguage,
  drawioOnlineHtml,
  DrawioSettings,
  exportFormat,
  fromDataUri,
  libraryEntries,
  LINK_PREFIX,
  linkAttributes,
  linkOf,
  passThroughCommand,
  pngDataUri,
  pretty,
  urlParams,
} from "./drawio";

const TEXT_VIEW_TYPE = "poly.drawio";
const PNG_VIEW_TYPE = "poly.drawio.png";
const SETTINGS = "poly.drawio";

const COLOR_THEMES: Record<vscode.ColorThemeKind, ColorThemeKind> = {
  [vscode.ColorThemeKind.Light]: "light",
  [vscode.ColorThemeKind.Dark]: "dark",
  [vscode.ColorThemeKind.HighContrast]: "high-contrast",
  [vscode.ColorThemeKind.HighContrastLight]: "high-contrast-light",
};

/** What draw.io posts: an `event`, and what goes with it. */
interface DrawioMessage {
  event: string;
  xml?: string;
  data?: string;
  command?: unknown;
  /** An export's request, sent back with it. */
  message?: { request?: unknown };
  /** A node double-clicked while code links are on: its label's text, and its attributes. */
  label?: string;
  attributes?: Record<string, string>;
  /** Whether a link was written: there was a node selected to write it to. */
  linked?: boolean;
}

/** A draw.io editor open, as the commands reach it. */
interface DrawioView {
  uri: vscode.Uri;
  panel: vscode.WebviewPanel;
  /** The drawing as draw.io exports it: `data` in `format`, and the diagram's XML. */
  exportAs(format: "xml" | "xmlsvg" | "xmlpng"): Promise<{ data?: string; xml: string }>;
  /** `attributes` written to the node selected, in place of its link; false if none is selected. */
  link(attributes: [string, string][]): Promise<boolean>;
}

const views = new Set<DrawioView>();
/** The draw.io editor last in front: the code in front is linked to its node. */
let lastView: DrawioView | undefined;

const codeLinksOn = () => vscode.workspace.getConfiguration(SETTINGS).get("codeLinkActivated", false);

/** The code link switch, in the status bar while a draw.io editor is open. */
let codeLinkStatus: vscode.StatusBarItem | undefined;

function showCodeLinkStatus() {
  if (!codeLinkStatus) {
    return;
  }
  const on = codeLinksOn();
  codeLinkStatus.text = `$(link) $(${on ? "circle-filled" : "circle-outline"}) Code Link`;
  codeLinkStatus.tooltip = `draw.io code links are ${on ? "on" : "off"}: double-clicking a node `
    + `${on ? "goes to the code it is linked with" : "edits its label"}`;
  if (views.size > 0) {
    codeLinkStatus.show();
  } else {
    codeLinkStatus.hide();
  }
}

/** One of `poly.drawio.knownPlugins`: the user's answer for a plugin as it was. */
interface KnownPlugin {
  pluginId: string;
  fingerprint: string;
  allowed: boolean;
}

/**
 * The sources of the plugins in `files` the user allows, asking about any
 * not yet answered, as hediet asks: a plugin is its file and a fingerprint of
 * its content, so a plugin that changed is asked about again. The answers are
 * kept in the user's settings alone -- the setting is application-scoped --
 * so that a workspace cannot allow its own plugins.
 */
async function allowedPlugins(files: string[]): Promise<string[]> {
  const sources: string[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      void vscode.window.showWarningMessage(
        `Poly: the draw.io plugin "${file}" is left out: ${(error as Error).message}`,
      );
      continue;
    }
    const pluginId = vscode.Uri.file(file).toString();
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    const known = vscode.workspace.getConfiguration(SETTINGS).inspect<KnownPlugin[]>("knownPlugins")?.globalValue ?? [];
    let allowed = known.find((one) => one.pluginId === pluginId && one.fingerprint === fingerprint)?.allowed;
    if (allowed === undefined) {
      const answer = await vscode.window.showWarningMessage(
        `Poly: run the draw.io plugin "${file}" in the draw.io editor? A plugin runs code of its own; `
          + "you will be asked again if the file changes.",
        "Allow",
        "Disallow",
      );
      // Dismissed, it is not run, and asked about again next time.
      if (answer === undefined) {
        continue;
      }
      allowed = answer === "Allow";
      await vscode.workspace.getConfiguration(SETTINGS).update(
        "knownPlugins",
        [...known, { pluginId, fingerprint, allowed }],
        vscode.ConfigurationTarget.Global,
      );
    }
    if (allowed) {
      sources.push(bytes.toString("utf8"));
    }
  }
  return sources;
}

/**
 * Starts draw.io in `panel` and answers what it asks the same way for any
 * file: its configuration, the file to show, VSCode's keys. What it says about
 * the drawing goes to `onDrawing`. A change to the settings, or to VSCode's
 * color theme when draw.io follows it, starts it again: draw.io reads both
 * only on start, and the file is what it shows, so nothing is lost but its
 * undo history.
 */
function startDrawio(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  uri: vscode.Uri,
  load: () => string,
  onDrawing: (message: DrawioMessage) => Promise<void>,
): vscode.Disposable {
  const webview = panel.webview;
  // A command's export is told from the editor's own saves by the request
  // draw.io sends back with it.
  let requests = 0;
  const exports = new Map<number, (message: DrawioMessage) => void>();
  const view: DrawioView = {
    uri,
    panel,
    exportAs: (format) =>
      new Promise((resolve) => {
        const request = ++requests;
        exports.set(request, (message) => resolve({ data: message.data, xml: message.xml ?? "" }));
        void webview.postMessage({ action: "export", format, request });
      }),
    link: (attributes) =>
      new Promise((resolve) => {
        linked = resolve;
        void webview.postMessage({ action: "poly.link", prefix: LINK_PREFIX, attributes });
      }),
  };
  let linked: ((linked: boolean) => void) | undefined;
  views.add(view);
  lastView = view;
  showCodeLinkStatus();
  const dist = vscode.Uri.joinPath(context.extensionUri, "dist");
  const settings = () => vscode.workspace.getConfiguration(SETTINGS, uri);
  // Code links are poly's own part of the page; the copy on the web is
  // another origin, which it cannot reach into.
  const tellCodeLinks = async () => {
    if (settings().get("offline", true)) {
      await webview.postMessage({ action: "poly.codeLinks", on: codeLinksOn() });
    }
  };
  // What the page was started with, bar the code link switch, which it is
  // told of as it is: turning that restarts nothing.
  const startedWith = () => JSON.stringify({ ...settings(), codeLinkActivated: undefined });
  let started = "";
  const start = () => {
    started = startedWith();
    const look = appearanceOf(
      settings().get<Appearance>("appearance", "light"),
      COLOR_THEMES[vscode.window.activeColorTheme.kind],
    );
    const lang = drawioLanguage(
      vscode.env.language,
      (code) => existsSync(vscode.Uri.joinPath(dist, "drawio", "resources", `dia_${code}.txt`).fsPath),
    );
    const params = urlParams({ theme: settings().get("theme", "kennedy"), ...look, lang });
    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    webview.html = settings().get("offline", true)
      ? drawioHtml({
        base: webview.asWebviewUri(vscode.Uri.joinPath(dist, "drawio")).toString(),
        bridge: webview.asWebviewUri(vscode.Uri.joinPath(dist, "drawioPage.js")).toString(),
        cspSource: webview.cspSource,
        params,
        resizeImages: settings().get<boolean | null>("resizeImages", null),
      })
      : drawioOnlineHtml({
        url: settings().get("online-url", "https://embed.diagrams.net/"),
        bridge: webview.asWebviewUri(vscode.Uri.joinPath(dist, "drawioOnline.js")).toString(),
        cspSource: webview.cspSource,
        params,
      });
  };
  start();
  return vscode.Disposable.from(
    {
      dispose: () => {
        views.delete(view);
        lastView = lastView === view ? [...views].pop() : lastView;
        showCodeLinkStatus();
      },
    },
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        lastView = view;
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SETTINGS}.codeLinkActivated`)) {
        void tellCodeLinks();
      }
      if (event.affectsConfiguration(SETTINGS, uri) && startedWith() !== started) {
        start();
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      if (settings().get("appearance") === "automatic") {
        start();
      }
    }),
    webview.onDidReceiveMessage(async (message: DrawioMessage) => {
      const request = message.message?.request;
      if (message.event === "export" && typeof request === "number") {
        exports.get(request)?.(message);
        exports.delete(request);
        return;
      }
      switch (message.event) {
        case "configure": {
          const folder = (vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0])?.uri
            .fsPath;
          const local = (file: string) => (folder === undefined ? file : file.replaceAll("${workspaceFolder}", folder));
          const { entries, problems } = libraryEntries(
            settings().get<CustomLibrary[]>("customLibraries", []),
            (file) => readFileSync(local(file), "utf8"),
          );
          for (const problem of problems) {
            void vscode.window.showWarningMessage(`Poly: ${problem}`);
          }
          // The copy on the web is another origin: there is nowhere to run them.
          const plugins = settings().get("offline", true)
            ? await allowedPlugins(settings().get<{ file: string }[]>("plugins", []).map((one) => local(one.file)))
            : [];
          await webview.postMessage({
            action: "configure",
            config: drawioConfig(settings() as DrawioSettings, entries),
            plugins,
          });
          await tellCodeLinks();
          break;
        }
        case "init":
          await webview.postMessage({ action: "load", xml: load(), autosave: 1 });
          break;
        case "shortcut": {
          const command = passThroughCommand(message.command);
          if (command) {
            await vscode.commands.executeCommand(command);
          }
          break;
        }
        case "poly.doubleClick":
          await follow(view, message.label ?? "", message.attributes ?? {});
          break;
        case "poly.linked":
          linked?.(message.linked === true);
          linked = undefined;
          break;
        default:
          await onDrawing(message);
      }
    }),
  );
}

class TextProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const webview = panel.webview;
    const image = exportFormat(document.uri.path);

    // The text the page last wrote. Writing it is itself a document change,
    // and merging that back into the drawing it came from would be an echo.
    let written = document.getText();
    const write = async (text: string) => {
      if (text === document.getText()) {
        return;
      }
      written = text;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)), text);
      await vscode.workspace.applyEdit(edit);
    };
    let saveExported = false;
    let merged = Promise.resolve();

    const disposable = vscode.Disposable.from(
      startDrawio(this.context, panel, document.uri, () => document.getText(), async (message) => {
        switch (message.event) {
          case "autosave":
          case "save":
            if (image) {
              // The SVG is draw.io's picture of the drawing, with the XML in
              // it; only draw.io can draw it.
              saveExported ||= message.event === "save";
              await webview.postMessage({ action: "export", format: image });
              break;
            }
            await write(pretty(message.xml ?? ""));
            if (message.event === "save") {
              await document.save();
            }
            break;
          case "export":
            await write(pretty(new TextDecoder().decode(fromDataUri(message.data ?? ""))));
            if (saveExported) {
              saveExported = false;
              await document.save();
            }
            break;
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document !== document || event.contentChanges.length === 0) {
          return;
        }
        const text = document.getText();
        if (text === written) {
          return;
        }
        written = text;
        // Text that is the file's again -- a revert, or the file replaced on
        // disk -- is loaded whole. draw.io merges an edit against the drawing
        // as it was loaded, so a merge would keep every shape drawn since,
        // which the revert threw away. Compared with the file, not read off
        // isDirty: VSCode updates that only after this event.
        merged = merged.then(async () => {
          const file = await vscode.workspace.fs.readFile(document.uri).then(
            (bytes) => new TextDecoder().decode(bytes),
            () => undefined,
          );
          if (document.getText() === text) {
            await webview.postMessage({ action: file === text ? "load" : "merge", xml: text, autosave: 1 });
          }
        });
      }),
    );
    panel.onDidDispose(() => disposable.dispose());
  }
}

class PngProvider extends BinaryEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {
    super(new Uint8Array());
  }

  resolveCustomEditor(document: BinaryDocument, panel: vscode.WebviewPanel) {
    const webview = panel.webview;
    let saveExported = false;
    const disposable = vscode.Disposable.from(
      startDrawio(this.context, panel, document.uri, () => pngDataUri(document.content), async (message) => {
        switch (message.event) {
          case "autosave":
          case "save":
            saveExported ||= message.event === "save";
            await webview.postMessage({ action: "export", format: "xmlpng" });
            break;
          case "export":
            document.update(fromDataUri(message.data ?? ""));
            if (saveExported) {
              saveExported = false;
              await vscode.commands.executeCommand("workbench.action.files.save");
            }
            break;
        }
      }),
      document.onDidRevert(() =>
        webview.postMessage({ action: "load", xml: pngDataUri(document.content), autosave: 1 })
      ),
    );
    panel.onDidDispose(() => disposable.dispose());
  }
}

/** The draw.io editor in front, if one is. */
function activeView(action: string): DrawioView | undefined {
  const view = [...views].find((one) => one.panel.active);
  if (!view) {
    void vscode.window.showInformationMessage(`Poly: open a diagram in the draw.io editor to ${action} it`);
  }
  return view;
}

/**
 * The drawing in `view` as a file of `kind` holds it: the XML as the editor
 * writes it, a picture as draw.io exports it, as hediet writes both.
 */
async function contentOf(view: DrawioView, kind: DrawioKind | ".svg" | ".png"): Promise<Uint8Array> {
  if (kind === ".drawio") {
    return new TextEncoder().encode(pretty((await view.exportAs("xml")).xml));
  }
  return fromDataUri((await view.exportAs(kind.endsWith(".svg") ? "xmlsvg" : "xmlpng")).data ?? "");
}

const exists = (uri: vscode.Uri) => vscode.workspace.fs.stat(uri).then(() => true, () => false);

/**
 * The diagram in front as another kind of draw.io file, in its place: the new
 * file is written from the drawing, changes not yet saved included, and the
 * old one is deleted, as hediet converts.
 */
async function convert() {
  const view = activeView("convert");
  const from = view && drawioKind(view.uri.path);
  if (!view || !from) {
    return;
  }
  const picked = await vscode.window.showQuickPick(
    DRAWIO_KINDS.filter((one) => one !== from.kind).map((label) => ({ label, description: CONVERTS_TO[label] })),
    { placeHolder: "Convert the diagram to" },
  );
  if (!picked) {
    return;
  }
  const kind = picked.label;
  const target = view.uri.with({ path: from.stem + kind });
  const name = target.path.slice(target.path.lastIndexOf("/") + 1);
  if (
    await exists(target) && await vscode.window.showWarningMessage(
        `Poly: ${name} already exists. Replace it?`,
        { modal: true },
        "Replace",
      ) !== "Replace"
  ) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, await contentOf(view, kind));
  // Reverted, so that closing does not ask to save what is in the new file.
  view.panel.reveal();
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  await vscode.workspace.fs.delete(view.uri);
  await vscode.commands.executeCommand(
    "vscode.openWith",
    target,
    kind === ".drawio.png" ? PNG_VIEW_TYPE : TEXT_VIEW_TYPE,
  );
}

/** What each kind of file a diagram converts to is. */
const CONVERTS_TO: Record<DrawioKind, string> = {
  ".drawio": "XML, which diffs line by line",
  ".drawio.svg": "An SVG picture that stays editable here",
  ".drawio.png": "A PNG picture that stays editable here",
};

/** What each file a diagram exports to is; the diagram is inside each. */
const EXPORTS = {
  ".svg": "An SVG picture of the diagram",
  ".png": "A PNG picture of the diagram",
  ".drawio": "A copy of the diagram",
} as const;

/** The diagram in front, exported to a picture beside it, where the user saves it. */
async function exportDiagram() {
  const view = activeView("export");
  const from = view && drawioKind(view.uri.path);
  if (!view || !from) {
    return;
  }
  const picked = await vscode.window.showQuickPick(
    Object.entries(EXPORTS).map(([label, description]) => ({ label: label as keyof typeof EXPORTS, description })),
    { placeHolder: "Export the diagram to" },
  );
  if (!picked) {
    return;
  }
  const target = await vscode.window.showSaveDialog({ defaultUri: view.uri.with({ path: from.stem + picked.label }) });
  if (target) {
    await vscode.workspace.fs.writeFile(target, await contentOf(view, picked.label));
  }
}

/**
 * draw.io's look for every diagram, a theme and whether it is light or dark
 * picked as one, as hediet offers them: written to the user's settings, the
 * current theme first.
 */
async function changeTheme() {
  const settings = vscode.workspace.getConfiguration(SETTINGS);
  const theme = settings.get<string>("theme", "kennedy");
  const appearance = settings.get<string>("appearance", "light");
  const themes = ["auto", "kennedy", "min", "simple", "sketch"].sort((a, b) =>
    Number(b === theme) - Number(a === theme)
  );
  const picked = await vscode.window.showQuickPick(
    ["light", "automatic", "dark"].flatMap((look) =>
      themes.map((one) => ({
        label: `${one} - ${look}`,
        description: one === theme && look === appearance
          ? "current"
          : look === "automatic"
          ? "light or dark as VSCode's color theme is"
          : undefined,
        theme: one,
        appearance: look,
      }))
    ),
    { placeHolder: "draw.io theme" },
  );
  if (picked) {
    await settings.update("theme", picked.theme, vscode.ConfigurationTarget.Global);
    await settings.update("appearance", picked.appearance, vscode.ConfigurationTarget.Global);
  }
}

/** A new, empty diagram where the user saves it, open in the draw.io editor to be drawn. */
async function newFile() {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    filters: { "draw.io": ["drawio"] },
  });
  if (!target) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, new Uint8Array());
  await vscode.commands.executeCommand("vscode.openWith", target, TEXT_VIEW_TYPE);
}

/** A symbol, where it is named. */
interface Found {
  name: string;
  uri: vscode.Uri;
  at: vscode.Position;
}

/** The symbols in `uri`, each before those inside it, as its language's extension finds them. */
async function documentSymbols(uri: vscode.Uri): Promise<Found[]> {
  const flat = (symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): Found[] =>
    symbols.flatMap((one) =>
      "children" in one
        ? [{ name: one.name, uri, at: one.selectionRange.start }, ...flat(one.children)]
        : [{ name: one.name, uri: one.location.uri, at: one.location.range.start }]
    );
  return flat(
    await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>(
      "vscode.executeDocumentSymbolProvider",
      uri,
    ) ?? [],
  );
}

/** The symbols in the workspace `query` finds, as the language extensions match it. */
async function workspaceSymbols(query: string): Promise<Found[]> {
  const found = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
    "vscode.executeWorkspaceSymbolProvider",
    query,
  ) ?? [];
  return found.map((one) => ({ name: one.name, uri: one.location.uri, at: one.location.range.start }));
}

const nameOf = (uri: vscode.Uri) => posix.basename(uri.path);

/**
 * The code a double-clicked node links to, opened: its range, its symbol or
 * the file, or -- for a node labelled `#Name` and linked with nothing -- the
 * workspace symbol `Name`, one named exactly that first (TypeScript names a
 * function `name()` there). Opened beside the diagram, where code already is
 * if it is.
 */
async function follow(view: DrawioView, label: string, attributes: Record<string, string>) {
  const link = linkOf(attributes) ?? (label.startsWith("#") ? { symbol: label.slice(1).trim() } : undefined);
  if (!link) {
    return;
  }
  let uri = link.path === undefined ? undefined : vscode.Uri.joinPath(view.uri, link.path);
  let selection: vscode.Range | undefined;
  if (link.symbol !== undefined) {
    const symbols = uri ? await documentSymbols(uri) : await workspaceSymbols(link.symbol);
    const found = symbols.find((one) => one.name.replace(/\(.*\)$/, "") === link.symbol)
      ?? (uri ? undefined : symbols[0]);
    if (!found) {
      void vscode.window.showInformationMessage(
        `Poly: there is no symbol "${link.symbol}" in ${uri ? nameOf(uri) : "the workspace"}`,
      );
      return;
    }
    uri = found.uri;
    selection = new vscode.Range(found.at, found.at);
  } else if (link.start && link.end) {
    selection = new vscode.Range(link.start.line, link.start.col, link.end.line, link.end.col);
  }
  const column = vscode.window.visibleTextEditors.find((one) => one.viewColumn !== view.panel.viewColumn)?.viewColumn
    ?? vscode.ViewColumn.Beside;
  await vscode.window.showTextDocument(uri as vscode.Uri, { viewColumn: column, selection }).then(
    undefined,
    (error) =>
      vscode.window.showWarningMessage(
        `Poly: the code this node links to cannot be opened: ${(error as Error).message}`,
      ),
  );
}

/** The draw.io editor code is linked to, if one is open and can take a link. */
function linkTarget(): DrawioView | undefined {
  if (!lastView) {
    void vscode.window.showInformationMessage("Poly: open a diagram in the draw.io editor to link code with its nodes");
    return undefined;
  }
  if (!vscode.workspace.getConfiguration(SETTINGS, lastView.uri).get("offline", true)) {
    void vscode.window.showInformationMessage(
      "Poly: code links need the draw.io that ships with Poly (poly.drawio.offline)",
    );
    return undefined;
  }
  return lastView;
}

/** `link` written to the node selected in `view`, its path made relative to the diagram. */
async function linkNode(view: DrawioView, uri: vscode.Uri | undefined, link: Omit<CodeLink, "path">) {
  const path = uri && posix.relative(view.uri.path, uri.path);
  if (!await view.link(linkAttributes({ path, ...link }))) {
    void vscode.window.showInformationMessage(`Poly: select a node in ${nameOf(view.uri)} to link it`);
  }
}

/** The code selected, linked by its range. */
async function linkCode() {
  const editor = vscode.window.activeTextEditor;
  const view = editor && linkTarget();
  if (!editor || !view) {
    return;
  }
  const { start, end } = editor.selection;
  await linkNode(view, editor.document.uri, {
    start: { col: start.character, line: start.line },
    end: { col: end.character, line: end.line },
  });
}

/** A file, from the explorer or, from the palette, the one in front, linked whole. */
async function linkFile(uri = vscode.window.activeTextEditor?.document.uri) {
  const view = uri && linkTarget();
  if (uri && view) {
    await linkNode(view, uri, {});
  }
}

/**
 * A symbol of the file in front picked -- those named with the selected text,
 * if there is any -- and linked by its name: kept with the file's path, or,
 * `workspace`, alone, and found again wherever in the workspace it goes.
 */
async function linkSymbol(workspace: boolean) {
  const editor = vscode.window.activeTextEditor;
  const view = editor && linkTarget();
  if (!editor || !view) {
    return;
  }
  const selected = editor.document.getText(editor.selection);
  const picked = await vscode.window.showQuickPick(
    (await documentSymbols(editor.document.uri))
      .filter((one) => one.name.includes(selected))
      .map((one) => ({ label: one.name })),
    { placeHolder: `Choose symbol from ${nameOf(editor.document.uri)}` },
  );
  if (picked) {
    await linkNode(view, workspace ? undefined : editor.document.uri, { symbol: picked.label });
  }
}

async function toggleCodeLinks() {
  await vscode.workspace.getConfiguration(SETTINGS).update(
    "codeLinkActivated",
    !codeLinksOn(),
    vscode.ConfigurationTarget.Global,
  );
}

export function registerDrawio(context: vscode.ExtensionContext) {
  const options = { webviewOptions: { retainContextWhenHidden: true } };
  codeLinkStatus = vscode.window.createStatusBarItem("poly.drawioCodeLink", vscode.StatusBarAlignment.Left);
  codeLinkStatus.name = "draw.io Code Link";
  codeLinkStatus.command = "poly.drawioToggleCodeLink";
  showCodeLinkStatus();
  context.subscriptions.push(
    codeLinkStatus,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SETTINGS}.codeLinkActivated`)) {
        showCodeLinkStatus();
      }
    }),
    vscode.window.registerCustomEditorProvider(TEXT_VIEW_TYPE, new TextProvider(context), options),
    vscode.window.registerCustomEditorProvider(PNG_VIEW_TYPE, new PngProvider(context), options),
    vscode.commands.registerCommand("poly.drawioConvert", convert),
    vscode.commands.registerCommand("poly.drawioExport", exportDiagram),
    vscode.commands.registerCommand("poly.drawioTheme", changeTheme),
    vscode.commands.registerCommand("poly.drawioNewFile", newFile),
    vscode.commands.registerCommand("poly.drawioToggleCodeLink", toggleCodeLinks),
    vscode.commands.registerCommand("poly.drawioLinkCode", linkCode),
    vscode.commands.registerCommand("poly.drawioLinkFile", linkFile),
    vscode.commands.registerCommand("poly.drawioLinkSymbol", () => linkSymbol(false)),
    vscode.commands.registerCommand("poly.drawioLinkWorkspaceSymbol", () => linkSymbol(true)),
  );
}

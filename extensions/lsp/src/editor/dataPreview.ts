/**
 * RandomFractalsInc.vscode-data-preview 2.3.0: JSON, YAML, CSV, Markdown
 * tables, properties files, Excel, Arrow, Avro and Parquet as a grid or a
 * chart, in Perspective.
 *
 * The page is upstream's own (dataPreview/, laid out in `dist/data-preview/`
 * by the build, with Perspective beside it from tools/perspective-assets.js);
 * this is its `extension.js` and `data.preview.js`. The readers are
 * dataPreviewData.ts, bundled apart and loaded on the first preview.
 */
import { existsSync, promises as fs, statSync } from "fs";
import * as path from "path";
import * as vscode from "vscode";

import type { Loaded } from "./dataPreviewData";

const ROOT = path.join(__dirname, "data-preview");
const VIEW_TYPE = "poly.dataPreview";

/** The extension this stands in for. When it is installed, its buttons and menu entries are already there. */
const RANDOM_FRACTALS = "RandomFractalsInc.vscode-data-preview";

let data: typeof import("./dataPreviewData") | undefined;
const load = () => data ??= require(path.join(__dirname, "dataPreview.js")) as typeof import("./dataPreviewData");

const config = () => vscode.workspace.getConfiguration("poly.dataPreview");

/** The open dialog's file types, as upstream lists them. */
const FILTERS = {
  JSON: ["json", "jsonl", "json5", "hjson", "ndjson"],
  "CSV/TSV": ["csv", "tsv", "tab", "txt"],
  Excel: ["dif", "ods", "xls", "xlsb", "xlsx", "xlsm", "xml", "html"],
  Arrow: ["arrow"],
  Avro: ["avro"],
  Config: ["config"],
  Markdown: ["md"],
  Properties: ["env", "ini", "properties"],
  YAML: ["yml"],
};

/**
 * `poly.dataPreview.theme` as a Perspective stylesheet. Upstream sent `light`
 * and `dense.light` through as file names, `light.css` and `dense.light.css`,
 * which Perspective does not have: the grid came out unstyled.
 */
function themeOf(setting: string | undefined): string {
  if (setting === "vaporwave") return setting;
  const family = setting?.startsWith("dense") ? "material-dense" : "material";
  return setting?.endsWith("dark") ? `${family}.dark` : family;
}

type ViewConfig = Record<string, unknown>;

/** What the page saves with `vscode.setState`, for the panel to come back after a reload. */
interface State {
  uri: string;
  table: string;
  config: ViewConfig;
  views: Record<string, ViewConfig>;
  theme: string;
}

let template: string | undefined;
let status: vscode.StatusBarItem;
const previews: Preview[] = [];

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const LABELS = ["bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

function formatBytes(bytes: number, decimals: number): string {
  let remainder = bytes;
  let i = 0;
  for (; remainder > 1024; i++) remainder /= 1024;
  return `${parseFloat(remainder.toFixed(decimals))} ${LABELS[i]}`;
}

class Preview {
  readonly panel: vscode.WebviewPanel;
  readonly dataUrl: string;
  private readonly remote: boolean;
  private readonly fileName: string;
  private readonly disposables: vscode.Disposable[] = [];
  private theme: string;
  private schema: Loaded["schema"] = null;
  private tableNames: string[] = [];
  private columns: unknown;
  private rowCount = 0;
  private fileSize: number | undefined;
  private readonly loadStart = new Date();
  private loadEnd = new Date(this.loadStart.getTime());

  constructor(
    readonly uri: vscode.Uri,
    private table: string,
    private viewConfig: ViewConfig,
    private views: Record<string, ViewConfig>,
    viewColumn: vscode.ViewColumn,
    theme?: string,
    panel?: vscode.WebviewPanel,
  ) {
    this.dataUrl = uri.toString(true);
    this.remote = load().isRemote(this.dataUrl);
    this.fileName = path.basename(uri.fsPath);
    this.theme = theme || themeOf(config().get("theme"));
    this.parseConfig(viewConfig);
    const options = { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(ROOT)] };
    if (panel) {
      // A restored panel keeps the options it was saved with, and with them
      // the folder of whichever poly version drew it last.
      panel.webview.options = options;
      this.panel = panel;
    } else {
      this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, this.fileName, viewColumn, options);
    }
    this.panel.iconPath = vscode.Uri.file(path.join(ROOT, "images", "data-preview.svg"));
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(
      ({ webviewPanel }) => {
        if (!webviewPanel.visible) {
          status.hide();
          return;
        }
        status.show();
        status.tooltip = `Data Stats for: ${this.fileName}`;
        this.updateStats(this.columns, this.rowCount);
      },
      null,
      this.disposables,
    );
    this.panel.webview.onDidReceiveMessage((message) => this.receive(message), null, this.disposables);
    this.configure();
  }

  /** Draws the page; it asks for the data itself once it has loaded. */
  configure() {
    const webview = this.panel.webview;
    const values: Record<string, string> = {
      cspSource: webview.cspSource,
      // Upstream put the file name in as it was, and the page runs inline
      // handlers: a file named like an <img onerror> ran script in it.
      title: escapeHtml(this.fileName),
      scripts: webview.asWebviewUri(vscode.Uri.file(path.join(ROOT, "scripts"))).toString(true),
      styles: webview.asWebviewUri(vscode.Uri.file(path.join(ROOT, "styles"))).toString(true),
      theme: this.theme,
      themeColor: this.theme.endsWith(".dark") ? "#2f3136" : "none",
      // Highcharts is not free for commercial use, so d3fc draws every chart.
      charts: "d3fc",
    };
    webview.html = template!.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);
  }

  /** The theme setting changed: the page is drawn again in the new one. */
  retheme() {
    this.theme = themeOf(config().get("theme"));
    this.configure();
  }

  private receive(message: Record<string, unknown>) {
    switch (message.command) {
      case "getDataInfo":
        this.postDataInfo();
        break;
      case "refresh":
        void this.refresh((message.table as string | undefined) ?? "");
        break;
      case "config":
        this.updateConfig(message.config as ViewConfig, message.table as string);
        break;
      case "stats":
        this.updateStats(message.columns, message.rowCount as number);
        break;
      case "saveData":
        void this.saveData(message.data, message.fileType as string);
        break;
      case "openFile":
        void this.openFile();
        break;
      case "loadView":
        void this.loadView(message.viewName as string, message.uri as string);
        break;
      case "loadConfig":
        void this.loadConfig();
        break;
    }
  }

  private post(message: unknown) {
    void this.panel.webview.postMessage(message);
  }

  private get info() {
    return {
      fileName: this.fileName,
      uri: this.dataUrl,
      theme: this.theme,
      config: this.viewConfig,
      schema: this.schema,
      tableNames: this.tableNames,
      views: this.views,
      table: this.table,
      // Upstream's `log.level`, which only ever changed its own console output.
      logLevel: "info",
    };
  }

  private postDataInfo() {
    this.post({ command: "dataInfo", ...this.info });
  }

  private updateStats(columns: unknown, rowCount: number) {
    this.columns = columns;
    this.rowCount = rowCount;
    // Upstream threw here when the panel was shown before its first load, the
    // file size not being known yet, and left the status as it was.
    if (!this.remote && this.fileSize === undefined) return;
    let stats = `Rows: ${rowCount.toLocaleString()}\tColumns: ${
      (columns as unknown[] | undefined)?.length.toLocaleString()
    }`;
    if (this.tableNames.length > 0) stats = `Tables: ${this.tableNames.length.toLocaleString()}\t${stats}`;
    if (this.loadStart.getTime() === this.loadEnd.getTime()) this.loadEnd = new Date();
    const seconds = Math.round((this.loadEnd.getTime() - this.loadStart.getTime()) / 1000);
    const size = this.remote ? "" : `\tFileSize: ${formatBytes(this.fileSize!, 2)}`;
    status.text = `🈸 ${stats}${size}\tLoadTime: ${seconds.toLocaleString()} sec`;
  }

  /** Reads the data again and hands it to the page: on the page's asking, a save, or another table. */
  async refresh(dataTable = "") {
    this.panel.reveal(this.panel.viewColumn, true);
    status.show();
    status.text = "🈸 Loading data...";
    if (dataTable.length > 0) this.table = dataTable;
    const dataUrl = this.remote ? this.dataUrl : this.uri.fsPath;
    let loaded: Loaded;
    try {
      loaded = await load().getData(dataUrl, {
        dataTable: this.table,
        createJsonFiles: config().get("create.json.files", false),
        createJsonSchema: config().get("create.json.schema", true),
      });
    } catch (error) {
      // Upstream's binary readers had no handler at all, so a file they could
      // not read left the page empty and said nothing.
      void vscode.window.showErrorMessage(`Unable to parse data file: '${dataUrl}'. \n\t Error: ${message(error)}`);
      return;
    }
    for (const error of loaded.errors) void vscode.window.showErrorMessage(error);
    this.tableNames = loaded.tableNames;
    this.schema = loaded.schema;
    const rows = loaded.data;
    if (rows.length > 0) {
      if (rows instanceof Uint8Array) {
        this.postDataInfo();
        this.post(Array.from(rows));
      } else {
        this.post({ command: "refresh", ...this.info, data: rows });
      }
    }
    try {
      this.fileSize = statSync(this.uri.fsPath).size;
    } catch {
      this.fileSize = -1;
    }
    this.updateStats(this.columns, typeof rows === "string" ? rows.split("\n").length : rows.length);
  }

  /** Upstream's config clean-up: `view` becomes `plugin`, and JSON in strings is parsed. */
  private parseConfig(viewConfig: ViewConfig): ViewConfig {
    if (Object.hasOwn(viewConfig, "view")) viewConfig.plugin = viewConfig.view;
    const parsed: ViewConfig = {};
    for (const [key, value] of Object.entries(viewConfig)) {
      parsed[key] = typeof value === "string" && (value.startsWith("{") || value.startsWith("["))
        ? JSON.parse(value)
        : value;
    }
    this.columns = parsed.columns;
    return parsed;
  }

  private updateConfig(viewConfig: ViewConfig, dataTable: string) {
    if (this.table !== dataTable && Object.hasOwn(this.views, dataTable)) {
      this.viewConfig = this.views[dataTable];
    } else if (Object.hasOwn(viewConfig, "view") && JSON.stringify(this.viewConfig) !== JSON.stringify(viewConfig)) {
      this.viewConfig = this.parseConfig(viewConfig);
      if (this.table.length > 0) this.views[this.table] = this.viewConfig;
    }
  }

  private async openFile() {
    const folders = vscode.workspace.workspaceFolders;
    const selected = await vscode.window.showOpenDialog({
      defaultUri: folders?.length ? folders[0].uri : vscode.Uri.parse(this.dataUrl).with({ scheme: "file" }),
      canSelectMany: false,
      canSelectFolders: false,
      filters: FILTERS,
    });
    if (selected?.length) await this.loadView("data.preview", selected[0].toString(true));
  }

  /**
   * Opens what the page asks for: another preview, or a file or page in the
   * editor. Upstream ran whatever command the page named.
   */
  private async loadView(viewName: string, url: string) {
    const command = viewName === "vscode.open" ? viewName : viewName === "data.preview" ? VIEW_TYPE : undefined;
    if (!command) return;
    try {
      const fileUri = vscode.Uri.parse(url);
      if (url.startsWith("http://") || url.startsWith("https://") || existsSync(fileUri.fsPath)) {
        await vscode.commands.executeCommand(command, fileUri);
        return;
      }
      const files = await vscode.workspace.findFiles(`**/${url}`);
      if (files.length > 0) await vscode.commands.executeCommand(command, files[0]);
      else void vscode.window.showErrorMessage(`No '**/${url}' file(s) found in this workspace!`);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Failed to load '${viewName}' for document: '${url}'! Error:\n${message(error)}`,
      );
    }
  }

  private async loadConfig() {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      defaultUri: vscode.Uri.file(this.uri.fsPath.slice(0, -path.extname(this.fileName).length || undefined)),
      filters: { Config: ["config"] },
    });
    if (!files?.length) return;
    try {
      const saved = JSON.parse(await fs.readFile(files[0].fsPath, "utf8"));
      if (this.uri.fsPath.includes(saved.dataFileName)) {
        this.viewConfig = this.parseConfig(saved.config);
        this.table = saved.dataTable ?? "";
        await this.refresh(this.table);
      } else {
        void vscode.window.showErrorMessage(
          `Config data file '${saved.dataFileName}' doesn't match '${this.fileName}'!`,
        );
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to load ${files[0].fsPath}: ${message(error)}`);
    }
  }

  /** Saves what the page sent -- its view config, or the data as filtered -- where the user picks. */
  private async saveData(fileData: unknown, fileType: string) {
    let name = path.basename(this.fileName, path.extname(this.fileName));
    if (this.table.length > 0) name += `-${this.table}`;
    let folder = path.dirname(this.uri.fsPath);
    const folders = vscode.workspace.workspaceFolders;
    if (this.remote && folders?.length) folder = folders[0].uri.fsPath;
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(folder, name + fileType)) });
    if (!uri) return;
    const { NotSaved, saveData } = load();
    try {
      if ((await saveData(uri.fsPath, fileData, this.table)) && config().get("openSavedFileEditor", true)) {
        await vscode.commands.executeCommand("vscode.open", uri);
      }
    } catch (error) {
      if (error instanceof NotSaved) void vscode.window.showWarningMessage(error.message);
      else {void vscode.window.showErrorMessage(
          `Unable to save data file: '${uri.fsPath}'. \n\t Error: ${message(error)}`,
        );}
    }
  }

  dispose() {
    status.text = "";
    const at = previews.indexOf(this);
    if (at >= 0) previews.splice(at, 1);
    this.panel.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

async function open(uri: vscode.Uri, viewColumn: vscode.ViewColumn, state?: State, panel?: vscode.WebviewPanel) {
  template ??= await fs.readFile(path.join(ROOT, "data.view.html"), "utf8");
  previews.push(
    new Preview(uri, state?.table ?? "", state?.config ?? {}, state?.views ?? {}, viewColumn, state?.theme, panel),
  );
}

function preview(uri: unknown, onSide: boolean) {
  const editor = vscode.window.activeTextEditor;
  const resource = uri instanceof vscode.Uri ? uri : editor?.document.uri;
  if (!resource) {
    void vscode.window.showInformationMessage("Open a Data file to Preview.");
    return;
  }
  return open(resource, (editor?.viewColumn ?? vscode.ViewColumn.One) + (onSide ? 1 : 0));
}

export function registerDataPreview(context: vscode.ExtensionContext) {
  const standDown = () =>
    void vscode.commands.executeCommand(
      "setContext",
      "poly.yield.dataPreview",
      vscode.extensions.getExtension(RANDOM_FRACTALS) !== undefined,
    );
  standDown();
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 300);
  context.subscriptions.push(
    status,
    vscode.extensions.onDidChange(standDown),
    vscode.commands.registerCommand(VIEW_TYPE, (uri?: unknown) => preview(uri, false)),
    vscode.commands.registerCommand("poly.dataPreviewOnSide", (uri?: unknown) => preview(uri, true)),
    vscode.commands.registerCommand("poly.dataPreviewRemote", async () => {
      const url = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        placeHolder: "https://",
        prompt: "Enter remote data url",
      });
      if (url) await vscode.commands.executeCommand(VIEW_TYPE, vscode.Uri.parse(url));
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state?: State) {
        // The page saves its state only once its view config changes; upstream
        // then threw on the missing state and left an empty tab behind.
        // Switched off, a restored tab would be the feature appearing anyway.
        if (!state?.uri || !vscode.workspace.getConfiguration("poly.dataPreview").get("enabled", true)) {
          panel.dispose();
          return;
        }
        status.text = "🈸 Restoring data preview...";
        await open(vscode.Uri.parse(state.uri), panel.viewColumn ?? vscode.ViewColumn.One, state, panel);
      },
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const url = document.uri.toString(true);
      for (const one of previews.filter((one) => one.dataUrl === url)) void one.refresh();
    }),
    // Upstream set every preview's html again on any setting's change: the
    // same html, which the webview ignores, so a new theme showed only in a
    // new preview.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.dataPreview.theme")) { for (const one of previews) one.retheme(); }
    }),
  );
}

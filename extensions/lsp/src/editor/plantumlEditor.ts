/**
 * PlantUML in the editor, as jebbs.plantuml offers it: the preview panel,
 * exports, server URLs, source extraction, the markdown fences, completion,
 * signature help, the outline and lint.
 *
 * plantuml.ts decides what a document means; this file runs Java, talks to a
 * server and draws. The jar is poly's managed download, or whatever
 * `plantuml` in the poly.tools setting or poly.toml's `[tools]` points at, so
 * it is pinned the way every other tool is. Java is the user's: poly does not
 * ship a JVM.
 */
import * as cp from "child_process";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { escapeHtml } from "./mermaid";
import {
  Diagram,
  diagramAt,
  diagramOfSource,
  diagramsOf,
  diagramUrl,
  ExportLayout,
  exportPath,
  extensionsGlob,
  fileBase,
  includePath,
  jarOf,
  JavaRun,
  languageWords,
  lint,
  LOCAL_FORMATS,
  macroCallAt,
  macroDetail,
  macrosOf,
  metadataArgs,
  pageFile,
  parseLanguage,
  previewImages,
  renderArgs,
  SERVER_FORMATS,
  serverError,
  serverOf,
  signatureLabel,
  stderrError,
  variablesOf,
  withIncludes,
  Word,
  WordKind,
} from "./plantuml";
import { toolsEnv } from "./toolsEnv";

/** The extension this stands in for. Installed, it does all of this itself. */
const JEBBS = "jebbs.plantuml";

/**
 * PlantUML files by name as well as by id: the id comes from
 * poly-syntax-highlight, and poly-lsp has to work installed on its own.
 */
const EXTENSIONS = /\.(wsd|pu|puml|plantuml|iuml)$/i;
const PATTERN = "**/*.{wsd,pu,puml,plantuml,iuml}";

const NO_SERVER = "No PlantUML server, specify one with \"poly.plantuml.server\".";

export function isPlantumlDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "plantuml" || EXTENSIONS.test(document.fileName);
}

/**
 * Two sets of completions, outlines and warnings are not better than one. The
 * switch goes through here too, so everything that already steps aside for
 * jebbs steps aside for it without a second check at each site.
 */
function standsDown(): boolean {
  return vscode.extensions.getExtension(JEBBS) !== undefined
    || !vscode.workspace.getConfiguration("poly.plantuml").get<boolean>("enabled", true);
}

function settings(uri: vscode.Uri | undefined): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("poly.plantuml", uri);
}

function folderOf(uri: vscode.Uri | undefined): string | undefined {
  return uri ? vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath : undefined;
}

function linesOf(document: vscode.TextDocument): string[] {
  return Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);
}

function diagramsIn(document: vscode.TextDocument): Diagram[] {
  return diagramsOf(linesOf(document), isPlantumlDocument(document), fileBase(document.fileName));
}

function diagramOn(document: vscode.TextDocument, line: number): Diagram | undefined {
  return diagramAt(linesOf(document), line, isPlantumlDocument(document), fileBase(document.fileName));
}

/** The diagram under the cursor, which is what jebbs's "current" means. */
function current(editor: vscode.TextEditor): Diagram | undefined {
  return diagramOn(editor.document, editor.selection.anchor.line);
}

/** Where a diagram comes from, for settings, poly.toml and `!include`. */
interface Origin {
  readonly uri: vscode.Uri | undefined;
  /** The file on disk; none for a document that was never saved. */
  readonly file: string | undefined;
}

function originOf(uri: vscode.Uri | undefined): Origin {
  return { uri, file: uri?.scheme === "file" ? uri.fsPath : undefined };
}

function layoutOf(uri: vscode.Uri): ExportLayout {
  const config = settings(uri);
  return {
    folder: folderOf(uri),
    outDir: config.get<string>("exportOutDir", "out"),
    diagramsRoot: config.get<string>("diagramsRoot", ""),
    includeHierarchy: config.get<boolean>("exportIncludeFolderHierarchy", true),
    subFolder: config.get<boolean>("exportSubFolder", true),
  };
}

function usesServer(uri: vscode.Uri | undefined): boolean {
  return settings(uri).get<string>("render") === "PlantUMLServer";
}

/** A failed render: PlantUML's message, and the picture of it when it drew one. */
class RenderError extends Error {
  constructor(message: string, readonly out: Buffer = Buffer.alloc(0)) {
    super(message);
  }
}

/** A server that answered with neither a picture nor a PlantUML error. */
class ResponseError extends RenderError {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * At most `limit()` tasks at once; the rest wait their turn. A JVM is a few
 * hundred megabytes, and a document with twenty diagrams is not a reason to
 * start twenty.
 */
function limiter(limit: () => number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    while (running >= Math.max(1, limit())) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/** One JVM: `input` on stdin, the picture from stdout, stderr as the verdict. */
function runJava(java: string, args: string[], input: string, procs?: cp.ChildProcess[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(java, args);
    procs?.push(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on(
      "error",
      (error) =>
        reject(
          new RenderError(`Cannot run Java ("${java}"): ${error.message}. Install a JDK, or set poly.plantuml.java.`),
        ),
    );
    child.on("close", () => {
      const stdout = Buffer.concat(out);
      const error = stderrError(Buffer.concat(err).toString());
      if (error) {
        reject(new RenderError(error, stdout));
      } else {
        resolve(stdout);
      }
    });
    // A JVM that exits before reading its input closes the pipe under us.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** Servers that answered a POST with something else than a diagram; jebbs asks those by GET from then on. */
const getOnly = new Set<string>();
const postWorks = new Set<string>();

async function request(url: string, init: RequestInit, shown: string, one: Diagram): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new RenderError(`${messageOf(error)}\n\n${init.method} ${shown}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (response.status === 200) {
    return body;
  }
  const error = response.headers.get("x-plantuml-diagram-error");
  if (error) {
    const line = Number(response.headers.get("x-plantuml-diagram-error-line"));
    const description = response.headers.get("x-plantuml-diagram-description") ?? "";
    throw new RenderError(serverError(error, line, description, one), body);
  }
  throw new ResponseError(`${response.status} ${response.statusText}\n\n${init.method} ${shown}`);
}

/** One page from a server: POST first, since a GET URL grows with the diagram. */
async function fromServer(server: string, format: string, page: number, text: string, one: Diagram): Promise<Buffer> {
  const shown = [server, format, page, "..."].join("/");
  if (!getOnly.has(server)) {
    try {
      // "om80" steps around the server's paging bug with POST (plantuml-server#74).
      const body = await request(
        [server, format, page, "om80"].join("/"),
        { method: "POST", body: text, headers: { "Content-Type": "text/plain; charset=utf-8" } },
        shown,
        one,
      );
      postWorks.add(server);
      return body;
    } catch (error) {
      if (!(error instanceof ResponseError) || postWorks.has(server)) {
        throw error;
      }
      getOnly.add(server);
    }
  }
  return request(diagramUrl(server, format, page, text), { method: "GET" }, shown, one);
}

/** Java, the jar, and the two renderers, shared by every feature below. */
class Renderer {
  private readonly jars = new Map<string, Promise<string>>();

  constructor(private readonly poly: string) {}

  /** Asked again after poly.toml or the settings change. */
  forget(): void {
    this.jars.clear();
  }

  /**
   * The jar for `origin`: poly resolves it from the poly.toml above the
   * workspace folder, so a `[tools] plantuml` pin there applies, and
   * downloads it the first time.
   */
  private jar(origin: Origin): Promise<string> {
    const cwd = folderOf(origin.uri) ?? (origin.file ? path.dirname(origin.file) : os.homedir());
    let jar = this.jars.get(cwd);
    if (!jar) {
      jar = Promise.resolve(vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Poly: preparing PlantUML…" },
        () =>
          new Promise<string>((resolve, reject) => {
            const env = { ...process.env, ...toolsEnv() };
            cp.execFile(this.poly, ["tools", "install", "plantuml"], { cwd, env }, (error, stdout, stderr) => {
              const found = jarOf(stdout);
              if (found) {
                resolve(found);
              } else {
                const said = `${stdout}${stderr}`.trim() || error?.message;
                reject(new RenderError(`poly tools install plantuml: ${said}`));
              }
            });
          }),
      ));
      // Not remembered when it fails: the next render asks again, after the
      // network came back or poly.toml was fixed.
      jar.catch(() => this.jars.delete(cwd));
      this.jars.set(cwd, jar);
    }
    return jar;
  }

  private includePathOf(origin: Origin, file: string | undefined): string {
    const config = settings(origin.uri);
    const folder = folderOf(origin.uri);
    const root = folder ? path.join(folder, config.get<string>("diagramsRoot", "")) : undefined;
    return includePath(file ? path.dirname(file) : undefined, config.get<string[]>("includepaths", []), folder, root);
  }

  async java(origin: Origin): Promise<{ java: string; run: JavaRun }> {
    const config = settings(origin.uri);
    return {
      java: config.get<string>("java", "java") || "java",
      run: {
        jar: await this.jar(origin),
        commandArgs: config.get<string[]>("commandArgs", []),
        jarArgs: config.get<string[]>("jarArgs", []),
        includePath: this.includePathOf(origin, origin.file),
      },
    };
  }

  /** The diagram as a server gets it: it cannot read this machine's files. */
  included(one: Diagram, origin: Origin): string {
    const paths = (file: string | undefined) =>
      this.includePathOf(origin, file).split(path.delimiter).filter((dir) => dir);
    return withIncludes(one.lines, origin.file, paths);
  }

  /**
   * Each page of `one` in `format`, or each page's image map, all started at
   * once and answered in page order. `procs` collects the JVMs, so that a
   * newer render can stop an older one.
   */
  pages(one: Diagram, origin: Origin, format: string, map: boolean, procs?: cp.ChildProcess[]): Promise<Buffer>[] {
    const pages = [...Array(one.pageCount).keys()];
    if (usesServer(origin.uri)) {
      const server = serverOf(settings(origin.uri).get<string>("server", ""));
      if (!server) {
        return pages.map(() => Promise.reject(new RenderError(NO_SERVER)));
      }
      const text = this.included(one, origin);
      return pages.map((page) => fromServer(server, map ? "map" : format, page, text, one));
    }
    const java = this.java(origin);
    return pages.map(async (page) => {
      const { java: command, run } = await java;
      const args = renderArgs(run, page, map ? "-pipemap" : "-pipe", map ? undefined : format, origin.file);
      try {
        return await runJava(command, args, one.content, procs);
      } catch (error) {
        const out = error instanceof RenderError ? error.out : undefined;
        throw new RenderError(`Error found in diagram ${one.name}\n${messageOf(error)}`, out);
      }
    });
  }

  render(one: Diagram, origin: Origin, format: string, map: boolean, procs?: cp.ChildProcess[]): Promise<Buffer[]> {
    return Promise.all(this.pages(one, origin, format, map, procs));
  }
}

// ── preview ─────────────────────────────────────────────────────────────────

/**
 * The preview panel: jebbs's page, its zoom and paging included, redrawn
 * whenever the diagram under the cursor or its text changes.
 */
class Preview {
  private panel: vscode.WebviewPanel | undefined;
  private template: string | undefined;
  private shown: { uri: string; startLine: number } | undefined;
  /** What the page reported of its zoom and page, handed back on redraw. */
  private status = "";
  private images = "";
  private error = "";
  private imageError = "";
  private procs: cp.ChildProcess[] = [];
  /** Which update is the newest; an older one finishing late is dropped. */
  private generation = 0;
  private watching: vscode.Disposable[] = [];

  constructor(private readonly renderer: Renderer, private readonly media: vscode.Uri) {}

  open(editor: vscode.TextEditor): void {
    if (diagramsIn(editor.document).length === 0) {
      vscode.window.showWarningMessage("Poly: this document has no PlantUML diagram to preview");
      return;
    }
    // Started over, so a command run between two diagrams does not keep
    // showing the last one's error.
    this.shown = undefined;
    this.status = "";
    this.targetChanged();
    this.update(true);
    this.panel?.reveal(this.panel.viewColumn, true);
  }

  private targetChanged(): boolean {
    const editor = vscode.window.activeTextEditor;
    const one = editor && current(editor);
    if (!editor || !one) {
      return false;
    }
    const target = { uri: editor.document.uri.toString(), startLine: one.startLine };
    if (this.shown?.uri === target.uri && this.shown.startLine === target.startLine) {
      return false;
    }
    this.shown = target;
    this.status = "";
    this.images = "";
    this.error = "";
    this.imageError = "";
    return true;
  }

  private update(processing: boolean): void {
    for (const proc of this.procs) {
      proc.kill();
    }
    const procs: cp.ChildProcess[] = (this.procs = []);
    const generation = ++this.generation;
    const editor = vscode.window.activeTextEditor;
    const one = editor && current(editor);
    if (!editor || !one) {
      this.images = "";
      this.error = "No valid diagram found here!";
      this.draw(false);
      return;
    }
    if (processing) {
      this.draw(true, this.lastExport(editor.document, one));
    }
    const origin = originOf(editor.document.uri);
    Promise.all([
      this.renderer.render(one, origin, "svg", false, procs),
      // A map that fails costs the links, not the picture (jebbs #579).
      this.renderer.render(one, origin, "svg", true, procs).catch(() => []),
    ]).then(
      ([pages, maps]) => {
        if (generation !== this.generation) {
          return;
        }
        this.images = previewImages([...pages, ...maps]);
        this.error = "";
        this.imageError = "";
        this.draw(false);
      },
      (error: unknown) => {
        if (generation !== this.generation) {
          return;
        }
        // The last good picture stays, with the error over it.
        this.error = messageOf(error);
        const out = error instanceof RenderError ? error.out : Buffer.alloc(0);
        this.imageError = out.length ? `data:image/svg+xml;base64,${out.toString("base64")}` : "";
        this.draw(false);
      },
    );
  }

  /** While rendering, jebbs shows the diagram's last export if there is one. */
  private lastExport(document: vscode.TextDocument, one: Diagram): string {
    if (document.uri.scheme !== "file") {
      return "";
    }
    for (const format of ["svg", "png"]) {
      const file = pageFile(exportPath(document.uri.fsPath, one, format, layoutOf(document.uri)), 0, one.pageCount);
      if (fs.existsSync(file)) {
        return previewImages([fs.readFileSync(file)]);
      }
    }
    return "";
  }

  private draw(processing: boolean, images = this.images): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "poly.plantumlPreview",
        "PlantUML Preview",
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
        {
          enableScripts: true,
          enableCommandUris: false,
          retainContextWhenHidden: true,
          localResourceRoots: [this.media],
        },
      );
      this.panel.webview.onDidReceiveMessage((message) => this.receive(message));
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.generation++;
        for (const proc of this.procs) {
          proc.kill();
        }
        for (const one of this.watching) {
          one.dispose();
        }
        this.watching = [];
      });
      this.watch();
    }
    const webview = this.panel.webview;
    this.template ??= fs.readFileSync(path.join(this.media.fsPath, "preview.html"), "utf8");
    const config = settings(undefined);
    const values: Record<string, string> = {
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString("base64"),
      base: webview.asWebviewUri(this.media).toString(),
      images,
      error: escapeHtml(this.error).replace(/\n/g, "<br />"),
      imageError: this.imageError,
      status: escapeHtml(this.status),
      settings: escapeHtml(JSON.stringify({
        zoomUpperLimit: false,
        showSpinner: processing,
        showSnapIndicators: config.get<boolean>("previewSnapIndicators", false),
        swapMouseButtons: config.get<boolean>("previewSwapMouseButtons", false),
      })),
    };
    webview.html = this.template.replace(/\$\{(\w+)\}/g, (placeholder, key: string) => values[key] ?? placeholder);
  }

  private receive(message: { action?: string; href?: string }): void {
    if (message?.action === "openExternalLink") {
      // The map's links are the diagram author's; only web links leave.
      const href = String(message.href ?? "");
      if (/^(https?|mailto):/i.test(href)) {
        void vscode.env.openExternal(vscode.Uri.parse(href));
      }
      return;
    }
    this.status = JSON.stringify(message);
  }

  /**
   * jebbs's timing: half a second after the typing or the cursor stops. The
   * two are timed apart, because typing moves the cursor too, and a cursor
   * that stays in its diagram must not cancel the redraw the typing asked for.
   */
  private watch(): void {
    let typed: NodeJS.Timeout | undefined;
    let moved: NodeJS.Timeout | undefined;
    const autoUpdate = () => settings(undefined).get<boolean>("previewAutoUpdate", true);
    this.watching = [
      vscode.workspace.onDidChangeTextDocument((event) => {
        // The active editor's document only: an output channel streaming a
        // log is a document too, and would redraw the preview on every line.
        if (!autoUpdate() || event.document !== vscode.window.activeTextEditor?.document) {
          return;
        }
        clearTimeout(typed);
        typed = setTimeout(() => {
          const editor = vscode.window.activeTextEditor;
          if (editor && current(editor)) {
            this.update(false);
          }
        }, 500);
      }),
      vscode.window.onDidChangeTextEditorSelection(() => {
        if (!autoUpdate()) {
          return;
        }
        clearTimeout(moved);
        moved = setTimeout(() => {
          if (this.targetChanged()) {
            this.update(true);
          }
        }, 500);
      }),
      { dispose: () => [typed, moved].forEach(clearTimeout) },
    ];
  }
}

// ── markdown ────────────────────────────────────────────────────────────────

/**
 * PlantUML fences in the markdown preview.
 *
 * With a server configured, jebbs's markup: an `<img>` per page pointing at
 * the server. Without one jebbs shows a warning; poly renders with the local
 * jar instead. markdown-it renders synchronously and a JVM does not, so a
 * fence shows its source (or its last picture) until the render lands, and
 * the preview is refreshed once nothing is pending.
 */
class Fences {
  private readonly done = new Map<string, string>();
  /** What each fence last showed, so an edit does not flash back to source. */
  private readonly last = new Map<string, string>();
  private readonly pending = new Set<string>();
  private readonly limit = limiter(() => settings(undefined).get<number>("exportConcurrency", 3));

  constructor(private readonly renderer: Renderer) {}

  forget(): void {
    this.done.clear();
  }

  draw(source: string, env: unknown, line: number | undefined): string {
    const document = (env as { currentDocument?: vscode.Uri } | undefined)?.currentDocument;
    const origin = originOf(document);
    const one = diagramOfSource(source);
    // Ditaa draws nothing but PNG.
    const png = one.type === "ditaa";
    const server = serverOf(settings(document).get<string>("server", ""));
    if (server) {
      const text = this.renderer.included(one, origin);
      return [...Array(one.pageCount).keys()]
        .map((page) =>
          `\n<img style="background-color:#FFF;" src="${diagramUrl(server, png ? "png" : "svg", page, text)}">`
        )
        .join("");
    }
    const key = `${origin.file ?? ""}\n${source}`;
    const slot = `${document?.toString()}#${line}`;
    const done = this.done.get(key);
    if (done !== undefined) {
      this.last.set(slot, done);
      return done;
    }
    if (!this.pending.has(key)) {
      this.pending.add(key);
      void this.limit(() => this.renderer.render(one, origin, png ? "png" : "svg", false)).then(
        (pages) =>
          pages
            .map((page) =>
              `\n<img style="background-color:#FFF;" src="data:image/${png ? "png" : "svg+xml"};base64,${
                page.toString("base64")
              }">`
            )
            .join(""),
        (error: unknown) => {
          const out = error instanceof RenderError ? error.out : Buffer.alloc(0);
          return out.length
            ? `\n<img style="background-color:#FFF;" src="data:image/${png ? "png" : "svg+xml"};base64,${
              out.toString("base64")
            }">`
            : `\n<pre><code>⚠️${escapeHtml(messageOf(error))}</code></pre>`;
        },
      ).then((html) => {
        // Failures are kept too: otherwise every refresh would ask again, and
        // each answer would refresh the preview once more.
        this.done.set(key, html);
        if (this.done.size > 200) {
          this.done.delete(this.done.keys().next().value!);
        }
        this.pending.delete(key);
        if (this.pending.size === 0) {
          void vscode.commands.executeCommand("markdown.preview.refresh");
        }
      });
    }
    return this.last.get(slot) ?? `<pre><code>${escapeHtml(source)}</code></pre>`;
  }
}

// ── export, URLs, extraction ──────────────────────────────────────────────────

function formatsOf(uri: vscode.Uri | undefined): readonly string[] {
  return usesServer(uri) ? SERVER_FORMATS : LOCAL_FORMATS;
}

interface Exported {
  /** Per diagram, the files written. */
  readonly files: string[][];
  readonly errors: string[];
}

class Exporter {
  constructor(private readonly renderer: Renderer, private readonly report: vscode.OutputChannel) {}

  private show(text: string): void {
    this.report.clear();
    this.report.appendLine(text);
    this.report.show();
  }

  private async exportDiagrams(
    document: vscode.TextDocument,
    diagrams: readonly Diagram[],
    format: string,
    progress: vscode.Progress<{ message?: string }>,
  ): Promise<Exported> {
    const uri = document.uri;
    const origin = originOf(uri);
    const config = settings(uri);
    const layout = layoutOf(uri);
    const extension = format.split(":")[0];
    const mapFile = config.get<boolean>("exportMapFile", false);
    // A server takes as many as it is sent; JVMs are this machine's memory.
    const limit = limiter(() => usesServer(uri) ? Infinity : config.get<number>("exportConcurrency", 3));
    const errors: string[] = [];
    const local = !usesServer(uri);
    const files = await Promise.all(diagrams.map((one) =>
      limit(async () => {
        progress.report({ message: `${one.name}.${extension}` });
        const target = exportPath(uri.fsPath, one, extension, layout);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const map = target.slice(0, target.length - path.extname(target).length) + ".cmapx";
        const written: string[] = [];
        const procs: cp.ChildProcess[] = [];
        const runs: [Promise<Buffer>[], string][] = [[this.renderer.pages(one, origin, format, false, procs), target]];
        if (mapFile) {
          runs.push([this.renderer.pages(one, origin, format, true, procs), map]);
        }
        // The picture and its map are separate chains, as in jebbs: a diagram
        // that fails still gets the map PlantUML drew of its error page.
        const failures = await Promise.all(runs.map(async ([pages, file]) => {
          for (const [index, page] of pages.entries()) {
            let out: Buffer;
            try {
              out = await page;
            } catch (error) {
              // As jebbs exports locally: the picture PlantUML drew of the
              // error is written where the diagram would have gone, and the
              // pages after it are not.
              if (local && error instanceof RenderError && error.out.length) {
                fs.writeFileSync(pageFile(file, index, pages.length), error.out);
              }
              pages.slice(index + 1).forEach((rest) => rest.catch(() => undefined));
              return error;
            }
            if (out.length) {
              fs.writeFileSync(pageFile(file, index, pages.length), out);
              written.push(pageFile(file, index, pages.length));
            }
          }
          return undefined;
        }));
        const failed = failures.find((error) => error !== undefined);
        if (failed === undefined) return written;
        procs.forEach((proc) => proc.kill());
        errors.push(messageOf(failed));
        return [];
      })
    ));
    return { files, errors };
  }

  private withProgress<T>(task: (progress: vscode.Progress<{ message?: string }>) => Promise<T>): Thenable<T> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "PlantUML Exporting" }, task);
  }

  async exportDocument(editor: vscode.TextEditor, all: boolean): Promise<void> {
    const document = editor.document;
    if (!path.isAbsolute(document.fileName) || document.uri.scheme !== "file") {
      vscode.window.showInformationMessage("Poly: save the file before you export its diagrams");
      return;
    }
    const format = settings(document.uri).get<string>("exportFormat")
      || await vscode.window.showQuickPick([...formatsOf(document.uri)]);
    if (!format) {
      return;
    }
    let diagrams: Diagram[];
    if (all) {
      diagrams = diagramsIn(document);
      if (diagrams.length === 0) {
        vscode.window.showInformationMessage("Poly: no diagram to export");
        return;
      }
    } else {
      const one = current(editor);
      if (!one) {
        vscode.window.showInformationMessage("Poly: no valid diagram found here");
        return;
      }
      diagrams = [one];
      editor.selections = [
        new vscode.Selection(one.startLine, 0, one.endLine, document.lineAt(one.endLine).text.length),
      ];
    }
    const started = Date.now();
    const result = await this.withProgress((progress) => this.exportDiagrams(document, diagrams, format, progress));
    if (result.errors.length) {
      this.show(result.errors.join("\n"));
      return;
    }
    const files = result.files.flat();
    const pick = await vscode.window.showInformationMessage("Poly: exported the diagrams", "View Report");
    if (pick) {
      const seconds = (Date.now() - started) / 1000;
      this.show(
        `${diagrams.length} diagrams, ${files.length} files exported in ${seconds} seconds:\n${files.join("\n")}`,
      );
    }
  }

  /** The files under `uris` (or every folder's diagrams root) with the extensions asked for. */
  private async filesUnder(uris: readonly vscode.Uri[] | undefined): Promise<vscode.Uri[]> {
    if (!uris) {
      const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
        vscode.Uri.file(path.join(folder.uri.fsPath, settings(folder.uri).get<string>("diagramsRoot", "")))
      );
      return this.filesUnder(roots);
    }
    const found: vscode.Uri[] = [];
    for (const uri of uris) {
      if (!fs.existsSync(uri.fsPath) || !fs.statSync(uri.fsPath).isDirectory()) {
        found.push(uri);
        continue;
      }
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) {
        continue;
      }
      const glob = extensionsGlob(settings(uri).get<string>("fileExtensions", ""));
      const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
      found.push(
        ...await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, `${relative ? `${relative}/` : ""}**/*${glob}`),
        ),
      );
    }
    return found;
  }

  async exportWorkspace(target: vscode.Uri | undefined, selected: vscode.Uri[] | undefined): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
      return;
    }
    let uris: vscode.Uri[];
    try {
      uris = await this.filesUnder(selected?.length ? selected : target ? [target] : undefined);
    } catch (error) {
      vscode.window.showErrorMessage(`Poly: ${messageOf(error)}`);
      return;
    }
    if (uris.length === 0) {
      vscode.window.showInformationMessage("Poly: no file to export");
      return;
    }
    const files = uris.map((uri) => ({ uri, format: settings(uri).get<string>("exportFormat", "") }));
    if (files.some((file) => !file.format)) {
      const pick = await vscode.window.showQuickPick([...formatsOf(files[0].uri)], {
        placeHolder: "Select a default format, applied to no export format configured diagrams.",
      });
      if (!pick) {
        return;
      }
      for (const file of files) {
        file.format ||= pick;
      }
    }
    const started = Date.now();
    const results: string[][][] = [];
    const errors: string[] = [];
    await this.withProgress(async (progress) => {
      for (const file of files) {
        const document = await vscode.workspace.openTextDocument(file.uri);
        const diagrams = diagramsIn(document);
        if (diagrams.length === 0) {
          continue;
        }
        const result = await this.exportDiagrams(document, diagrams, file.format, progress);
        if (result.errors.length) {
          errors.push(`\n${result.errors.length} errors found in file ${file.uri.fsPath}`, ...result.errors);
        }
        if (result.files.some((one) => one.length)) {
          results.push(result.files);
        }
      }
    });
    const showReport = () => {
      const diagrams = results.reduce((sum, one) => sum + one.length, 0);
      const written = results.flat(2);
      const seconds = (Date.now() - started) / 1000;
      this.show(
        `${results.length} documents, ${diagrams} diagrams, ${written.length} files exported in ${seconds} seconds:\n`
          + written.join("\n")
          + (errors.length ? `\n${errors.join("\n")}` : ""),
      );
    };
    if (results.length === 0) {
      if (errors.length === 0) {
        vscode.window.showInformationMessage("Poly: no diagram exported");
      } else if (await vscode.window.showInformationMessage("Poly: no diagram exported", "View Report")) {
        showReport();
      }
      return;
    }
    const message = errors.length
      ? `Poly: exported ${results.length} file(s), with errors`
      : `Poly: exported ${results.length} file(s)`;
    if (await vscode.window.showInformationMessage(message, "View Report")) {
      showReport();
    }
  }

  async url(editor: vscode.TextEditor, all: boolean): Promise<void> {
    const document = editor.document;
    const config = settings(document.uri);
    const server = serverOf(config.get<string>("server", ""));
    if (!server) {
      vscode.window.showWarningMessage(`Poly: ${NO_SERVER}`);
      return;
    }
    const format = config.get<string>("urlFormat") || await vscode.window.showQuickPick([...SERVER_FORMATS]);
    if (!format) {
      return;
    }
    let diagrams: Diagram[];
    if (all) {
      diagrams = diagramsIn(document);
      if (diagrams.length === 0) {
        vscode.window.showWarningMessage("Poly: no valid diagram found");
        return;
      }
    } else {
      const one = current(editor);
      if (!one) {
        vscode.window.showWarningMessage("Poly: no valid diagram found here");
        return;
      }
      diagrams = [one];
      editor.selections = [
        new vscode.Selection(one.startLine, 0, one.endLine, document.lineAt(one.endLine).text.length),
      ];
    }
    const origin = originOf(document.uri);
    const markdown = config.get<string>("urlResult", "MarkDown") !== "SimpleURL";
    this.report.clear();
    for (const one of diagrams) {
      const text = this.renderer.included(one, origin);
      this.report.appendLine(one.name);
      for (const page of Array(one.pageCount).keys()) {
        const url = diagramUrl(server, format, page, text);
        this.report.appendLine(markdown ? `\n![${one.name}](${url} "${one.name}")` : url);
      }
      this.report.appendLine("");
    }
    this.report.show();
  }

  /** The source PlantUML writes into every PNG it exports, back out of it. */
  async extractSource(): Promise<void> {
    const images = await vscode.window.showOpenDialog({
      openLabel: "Select to Extract...",
      canSelectMany: true,
      filters: { Images: ["png"] },
    });
    if (!images?.length) {
      return;
    }
    let java: { java: string; run: JavaRun };
    try {
      java = await this.renderer.java(originOf(images[0]));
    } catch (error) {
      vscode.window.showErrorMessage(`Poly: ${messageOf(error)}`);
      return;
    }
    const sources = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "PlantUML" },
      async (progress) => {
        const found: string[] = [];
        for (const [index, image] of images.entries()) {
          progress.report({ message: `Extracting (${index + 1}/${images.length}): ${path.basename(image.fsPath)}` });
          if (!fs.existsSync(image.fsPath)) {
            found.push(`File not found: ${image.fsPath}`);
            continue;
          }
          try {
            found.push((await runJava(java.java, metadataArgs(java.run, image.fsPath), "")).toString());
          } catch (error) {
            found.push(messageOf(error));
          }
        }
        return found;
      },
    );
    const known = await vscode.languages.getLanguages();
    const document = await vscode.workspace.openTextDocument({
      language: known.includes("plantuml") ? "plantuml" : "plaintext",
      content: sources.join("\n"),
    });
    await vscode.window.showTextDocument(document);
  }
}

// ── language features ─────────────────────────────────────────────────────────

const KINDS: Record<WordKind, vscode.CompletionItemKind> = {
  type: vscode.CompletionItemKind.Struct,
  keyword: vscode.CompletionItemKind.Keyword,
  preprocessor: vscode.CompletionItemKind.Function,
  skinparameter: vscode.CompletionItemKind.Field,
  color: vscode.CompletionItemKind.Color,
};

/**
 * The languages jebbs outlines diagrams in: `@startuml` blocks are written in
 * comments and docs as often as in their own files.
 */
const OUTLINED = [
  "plantuml",
  "markdown",
  "c",
  "csharp",
  "cpp",
  "clojure",
  "coffeescript",
  "fsharp",
  "go",
  "groovy",
  "java",
  "javascript",
  "javascriptreact",
  "lua",
  "objective-c",
  "objective-cpp",
  "php",
  "perl",
  "perl6",
  "python",
  "ruby",
  "rust",
  "swift",
  "typescript",
  "typescriptreact",
  "vb",
  "plaintext",
];

function registerLanguage(context: vscode.ExtensionContext, renderer: Renderer): void {
  const own: vscode.DocumentSelector = [
    { scheme: "file", language: "plantuml" },
    { scheme: "untitled", language: "plantuml" },
    { scheme: "file", pattern: PATTERN },
  ];

  // The jar's own word list, asked once: a JVM per keystroke is not an option.
  let words: Promise<Word[]> | undefined;
  const vocabulary = (document: vscode.TextDocument): Promise<Word[]> => {
    words ??= (async () => {
      const origin = originOf(document.uri);
      if (usesServer(origin.uri)) {
        return languageWords([]);
      }
      try {
        const { java, run } = await renderer.java(origin);
        const args = [...run.commandArgs, "-Djava.awt.headless=true", "-jar", run.jar, "-language"];
        return languageWords(parseLanguage((await runJava(java, args, "")).toString()));
      } catch {
        return languageWords([]);
      }
    })();
    return words;
  };

  const diagnostics = vscode.languages.createDiagnosticCollection("poly-plantuml");
  const diagnose = (document: vscode.TextDocument) => {
    if (!isPlantumlDocument(document) || standsDown()) {
      diagnostics.delete(document.uri);
      return;
    }
    const unnamed = settings(document.uri).get<boolean>("lintDiagramNoName", true);
    diagnostics.set(
      document.uri,
      lint(diagramsIn(document), unnamed).map((finding) => {
        const diagnostic = new vscode.Diagnostic(
          document.lineAt(finding.line).range,
          finding.message,
          finding.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = "poly";
        return diagnostic;
      }),
    );
  };
  vscode.workspace.textDocuments.forEach(diagnose);

  context.subscriptions.push(
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(diagnose),
    vscode.workspace.onDidChangeTextDocument((event) => diagnose(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.plantuml")) {
        words = undefined;
        vscode.workspace.textDocuments.forEach(diagnose);
      }
    }),
    vscode.languages.registerCompletionItemProvider(own, {
      async provideCompletionItems(document, position) {
        if (standsDown()) {
          return [];
        }
        const all = await vocabulary(document);
        const one = diagramOn(document, position.line);
        const items: vscode.CompletionItem[] = [];
        for (const macro of one ? macrosOf(one.lines) : []) {
          const item = new vscode.CompletionItem(macro.name, vscode.CompletionItemKind.Method);
          item.detail = macroDetail(macro);
          items.push(item);
        }
        for (const word of all) {
          const item = new vscode.CompletionItem(word.label, KINDS[word.kind]);
          item.insertText = word.name;
          items.push(item);
        }
        if (one) {
          const known = new Set(all.map((word) => word.name));
          for (const name of variablesOf(one.lines, position.line - one.startLine, known)) {
            items.push(new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable));
          }
        }
        return items;
      },
    }),
    vscode.languages.registerSignatureHelpProvider(
      own,
      {
        provideSignatureHelp(document, position) {
          const call = standsDown() ? undefined : macroCallAt(document.lineAt(position.line).text, position.character);
          const one = call && diagramOn(document, position.line);
          const macro = one && macrosOf(one.lines).find((candidate) => candidate.name === call.name);
          if (!call || !macro) {
            return undefined;
          }
          const help = new vscode.SignatureHelp();
          help.signatures = macro.signatures.map((params) => {
            const signature = new vscode.SignatureInformation(signatureLabel(macro.name, params));
            signature.parameters = params.map((param) => new vscode.ParameterInformation(param));
            return signature;
          });
          help.activeSignature = Math.max(
            0,
            help.signatures.findIndex((one) => one.parameters.length === call.available),
          );
          help.activeParameter = call.active;
          return help;
        },
      },
      "(",
      ",",
    ),
    vscode.languages.registerDocumentSymbolProvider(
      [
        ...OUTLINED.flatMap((language) => [{ scheme: "file", language }, { scheme: "untitled", language }]),
        { scheme: "file", pattern: PATTERN },
      ],
      {
        provideDocumentSymbols(document) {
          if (standsDown()) {
            return [];
          }
          return diagramsIn(document).map((one) =>
            new vscode.SymbolInformation(
              one.name,
              vscode.SymbolKind.Object,
              "",
              new vscode.Location(
                document.uri,
                new vscode.Range(one.startLine, 0, one.endLine, document.lineAt(one.endLine).text.length),
              ),
            )
          );
        },
      },
    ),
  );
}

// ── wiring ────────────────────────────────────────────────────────────────────

/**
 * Registers everything and returns what the markdown preview's plugin asks:
 * the HTML for one fence, or undefined to leave it a code block.
 */
export function registerPlantuml(
  context: vscode.ExtensionContext,
  poly: string,
): (source: string, env: unknown, line: number | undefined) => string | undefined {
  const renderer = new Renderer(poly);
  const report = vscode.window.createOutputChannel("Poly PlantUML");
  const preview = new Preview(renderer, vscode.Uri.joinPath(context.extensionUri, "media", "plantuml"));
  const exporter = new Exporter(renderer, report);
  const fences = new Fences(renderer);

  const withEditor = (action: (editor: vscode.TextEditor) => unknown) => () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Poly: this needs an open editor");
      return;
    }
    return action(editor);
  };

  context.subscriptions.push(
    report,
    vscode.commands.registerCommand("poly.plantumlPreview", withEditor((editor) => preview.open(editor))),
    vscode.commands.registerCommand(
      "poly.plantumlExportCurrent",
      withEditor((editor) => exporter.exportDocument(editor, false)),
    ),
    vscode.commands.registerCommand(
      "poly.plantumlExportDocument",
      withEditor((editor) => exporter.exportDocument(editor, true)),
    ),
    vscode.commands.registerCommand(
      "poly.plantumlExportWorkspace",
      (target?: vscode.Uri, selected?: vscode.Uri[]) => exporter.exportWorkspace(target, selected),
    ),
    vscode.commands.registerCommand("poly.plantumlUrlCurrent", withEditor((editor) => exporter.url(editor, false))),
    vscode.commands.registerCommand("poly.plantumlUrlDocument", withEditor((editor) => exporter.url(editor, true))),
    vscode.commands.registerCommand("poly.plantumlExtractSource", () => exporter.extractSource()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.plantuml") || event.affectsConfiguration("poly.tools")) {
        renderer.forget();
        fences.forget();
        void vscode.commands.executeCommand("markdown.preview.refresh");
      }
    }),
    // A `[tools] plantuml` edit changes which jar runs.
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (path.basename(document.fileName) === "poly.toml") {
        renderer.forget();
        fences.forget();
      }
    }),
  );
  registerLanguage(context, renderer);

  return (source, env, line) => {
    const draws = vscode.workspace.getConfiguration("poly").get<boolean>("markdownDiagrams.enabled", false)
      && !standsDown();
    return draws ? fences.draw(source, env, line) : undefined;
  };
}

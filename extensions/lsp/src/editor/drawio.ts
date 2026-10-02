/**
 * draw.io's editor, as hediet.vscode-drawio offers it. This file is the part
 * that needs no VSCode: which files it opens, what draw.io is told on start,
 * and the page. drawioEditor.ts is the rest.
 *
 * hediet's extension is GPL-3.0, and its code is not here: the page loads
 * draw.io's own web app (Apache-2.0) and speaks draw.io's documented embed
 * protocol. Two tables are taken from it, for interoperability with that
 * protocol and so that a drawing behaves the same in either editor:
 * PASS_THROUGH is hediet's VSCODE_PASSTHROUGH_KEYS, and urlParams are the
 * embed parameters its page starts draw.io with (compared with
 * tools/drawio-diff).
 */

import format from "xml-formatter";

/** The files the text editor opens: the XML, and SVG with the XML inside. */
export const TEXT_FILES = [".drawio", ".dio", ".drawio.svg", ".dio.svg"];
/** The files the binary editor opens: PNG with the XML inside. */
export const PNG_FILES = [".drawio.png", ".dio.png"];

/**
 * What draw.io exports the drawing as for a file of this name -- an image with
 * the diagram inside -- or undefined for the XML, which it hands over as is.
 */
export function exportFormat(path: string): "xmlsvg" | "xmlpng" | undefined {
  const name = path.toLowerCase();
  if (name.endsWith(".drawio.svg") || name.endsWith(".dio.svg")) {
    return "xmlsvg";
  }
  if (name.endsWith(".drawio.png") || name.endsWith(".dio.png")) {
    return "xmlpng";
  }
  return undefined;
}

/** The bytes of the `data:...;base64,` URI draw.io exports an image as. */
export function fromDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  if (!uri.startsWith("data:") || !uri.slice(0, comma).endsWith(";base64")) {
    throw new Error(`draw.io exported something other than a base64 data URI: ${uri.slice(0, 40)}`);
  }
  return Buffer.from(uri.slice(comma + 1), "base64");
}

/**
 * A PNG as draw.io loads one, which it reads the diagram out of; an empty
 * file, a new drawing, as nothing.
 */
export function pngDataUri(bytes: Uint8Array): string {
  return bytes.length === 0 ? "" : `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * What draw.io is started with. The values are hediet's, so that the editor
 * looks and behaves the same: embedded, configured by the host, speaking JSON,
 * with no Exit -- the tab is closed as any other -- and a Save that asks the
 * host to save.
 */
export function urlParams(look: { theme: string; dark: boolean | "auto"; highContrast: boolean; lang: string }) {
  return {
    embed: "1",
    configure: "1",
    proto: "json",
    ui: look.theme,
    dark: look.dark === "auto" ? "auto" : look.dark ? "1" : "0",
    "high-contrast": look.highContrast ? "1" : "0",
    lang: look.lang,
    noSaveBtn: "0",
    noExitBtn: "1",
    chrome: "1",
    "svg-warning": "1",
  };
}

/**
 * The diagram as it is written to the file. draw.io sends it on one line;
 * hediet writes it through xml-formatter, indented four spaces, and so does
 * this -- a file saved by one diffs against the other by what changed in the
 * drawing, and a `.drawio` in a pull request reads line by line.
 */
export function pretty(xml: string): string {
  return format(xml, { indentation: "    ", lineSeparator: "\n" });
}

export type Appearance = "automatic" | "light" | "dark" | "high-contrast-light" | "high-contrast";
export type ColorThemeKind = "light" | "dark" | "high-contrast" | "high-contrast-light";

/**
 * Dark and high contrast as draw.io takes them. `automatic` leaves dark to
 * draw.io, which follows the webview's color scheme and so VSCode's, as it
 * changes; high contrast is VSCode's color theme's.
 */
export function appearanceOf(appearance: Appearance, colorTheme: ColorThemeKind) {
  if (appearance === "automatic") {
    return { dark: "auto" as const, highContrast: colorTheme.startsWith("high-contrast") };
  }
  return {
    dark: appearance === "dark" || appearance === "high-contrast",
    highContrast: appearance.startsWith("high-contrast"),
  };
}

/**
 * draw.io's language for VSCode's display language: the same code where
 * draw.io has it, else the language without its region (`zh-cn` is draw.io's
 * `zh`), else English. `has` says whether draw.io ships a code.
 */
export function drawioLanguage(language: string, has: (code: string) => boolean): string {
  const code = language.toLowerCase();
  if (has(code)) {
    return code;
  }
  const primary = code.split("-")[0];
  return has(primary) ? primary : "en";
}

/**
 * VSCode's keys that draw.io would take for itself: draw.io swallows each and
 * tells the host (a `shortcut` event), which runs the command. hediet's list.
 * Shift+Alt+S has no command: it is only kept from draw.io.
 */
const PASS_THROUGH = [
  {
    key: "Tab",
    ctrl: true,
    shift: false,
    alt: false,
    command: "workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup",
  },
  { key: "P", ctrl: true, shift: true, alt: false, command: "workbench.action.showCommands" },
  { key: "p", ctrl: true, shift: false, alt: false, command: "workbench.action.quickOpen" },
  { key: "S", ctrl: false, shift: true, alt: true, command: null },
  { key: "s", ctrl: true, shift: false, alt: false, command: "workbench.action.files.save" },
  { key: "S", ctrl: true, shift: true, alt: false, command: "workbench.action.files.saveAs" },
  { key: "F1", ctrl: false, shift: false, alt: false, command: "workbench.action.showCommands" },
];

/**
 * The command a `shortcut` event may run: one of the list above, and nothing
 * else. The page shows a diagram from anywhere, so a message from it is not
 * trusted to name a command.
 */
export function passThroughCommand(command: unknown): string | undefined {
  return PASS_THROUGH.find((key) => key.command !== null && key.command === command)?.command ?? undefined;
}

/** The draw.io settings poly exposes, as `poly.drawio.*` spells them. */
export interface DrawioSettings {
  showTooltipIcons?: boolean;
  showLinkIcons?: boolean;
  showConnectHandle?: boolean;
  customFonts?: string[];
  presetColors?: string[] | null;
  customColorSchemes?: unknown[] | null;
  styles?: unknown[] | null;
  defaultVertexStyle?: Record<string, string> | null;
  defaultEdgeStyle?: Record<string, string> | null;
  colorNames?: Record<string, string> | null;
  simpleLabels?: boolean;
  zoomFactor?: number;
  globalVars?: Record<string, unknown> | null;
}

/** One of `poly.drawio.customLibraries`: a palette of shapes, given one of four ways. */
export interface CustomLibrary {
  entryId: string;
  libName: string;
  /** A library file draw.io downloads itself. */
  url?: string;
  /** A library file's content. */
  xml?: string;
  /** The shapes' JSON, as text or as the array itself. */
  json?: unknown;
  /** A library file on this machine. */
  file?: string;
}

/** A palette as draw.io's `libraries` configuration takes it. */
export interface Library {
  title: { main: string };
  url?: string;
  data?: unknown[];
}

/** The palettes under one `entryId`, which draw.io's More Shapes turns on and off together. */
export interface LibraryEntry {
  title: { main: string };
  id: string;
  libs: Library[];
}

const XML_ESCAPES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

/**
 * The shapes in a library file, read as draw.io reads one: the JSON is the
 * `<mxlibrary>` element's text, so its escapes are decoded first. draw.io
 * writes a shape uncompressed, `<` as `&lt;`; hediet parses the text as it
 * stands, which breaks every such shape.
 */
export function libraryShapes(xml: string): unknown {
  const text = /<mxlibrary\b[^>]*>([\s\S]*)<\/mxlibrary>/.exec(xml)?.[1];
  if (text === undefined) {
    throw new Error("it is not a draw.io library: there is no <mxlibrary> element");
  }
  return JSON.parse(
    text.replace(
      /&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g,
      (_, name: string) =>
        XML_ESCAPES[name]
          ?? String.fromCodePoint(name[1] === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1))),
    ),
  );
}

function shapesOf(library: CustomLibrary, read: (file: string) => string): unknown[] {
  const shapes = library.json !== undefined
    ? typeof library.json === "string" ? JSON.parse(library.json) : library.json
    : library.xml !== undefined
    ? libraryShapes(library.xml)
    : library.file !== undefined
    ? libraryShapes(read(library.file))
    : undefined;
  if (!Array.isArray(shapes)) {
    throw new Error(shapes === undefined ? "it gives no url, xml, json or file" : "its shapes are not a JSON array");
  }
  return shapes;
}

/**
 * `poly.drawio.customLibraries` as draw.io's library entries, as hediet passes
 * them: one entry per `entryId`, titled by it, in the order the setting first
 * names each. `read` gives a `file`'s content. A library that cannot be read
 * is left out, and why is in `problems`: hediet's editor does not open at all.
 */
export function libraryEntries(libraries: CustomLibrary[], read: (file: string) => string) {
  const entries: LibraryEntry[] = [];
  const problems: string[] = [];
  for (const library of libraries) {
    const title = { main: library.libName };
    let lib: Library;
    try {
      lib = library.url !== undefined ? { title, url: library.url } : { title, data: shapesOf(library, read) };
    } catch (error) {
      problems.push(`the draw.io library "${library.libName}" is left out: ${(error as Error).message}`);
      continue;
    }
    let entry = entries.find((one) => one.id === library.entryId);
    if (!entry) {
      entry = { title: { main: library.entryId }, id: library.entryId, libs: [] };
      entries.push(entry);
    }
    entry.libs.push(lib);
  }
  return { entries, problems };
}

/** The kinds of draw.io file, by the suffix each is written with. */
export const DRAWIO_KINDS = [".drawio", ".drawio.svg", ".drawio.png"] as const;
export type DrawioKind = (typeof DRAWIO_KINDS)[number];

/**
 * A draw.io file's path as its stem and its kind: `a/flow.dio.svg` is
 * `a/flow` and `.drawio.svg`, the `.dio` spellings being the same kinds.
 */
export function drawioKind(path: string): { stem: string; kind: DrawioKind } | undefined {
  const match = /^(.*)\.(?:drawio|dio)(\.svg|\.png)?$/i.exec(path);
  return match ? { stem: match[1], kind: `.drawio${(match[2] ?? "").toLowerCase()}` as DrawioKind } : undefined;
}

/**
 * Code a node is linked with: a file, a range in it, a symbol in it, or a
 * symbol found anywhere in the workspace. The path is relative to the
 * diagram's own path, as though that were a folder (`../code.ts` for a file
 * beside it), and a position counts from 0, as VSCode's do -- both as hediet
 * writes them.
 */
export interface CodeLink {
  path?: string;
  start?: { col: number; line: number };
  end?: { col: number; line: number };
  symbol?: string;
}

/** What begins the name of each attribute a link is kept in on its node. */
export const LINK_PREFIX = "hedietLinkedDataV1_";

/**
 * `link` as the node's attributes, named and ordered as hediet writes them, so
 * that a diagram linked in either editor follows its links in the other, and
 * relinked in either diffs by what changed.
 */
export function linkAttributes(link: CodeLink): [string, string][] {
  const attributes: [string, string][] = [];
  if (link.path !== undefined) {
    attributes.push([`${LINK_PREFIX}path`, link.path]);
  }
  for (const end of ["start", "end"] as const) {
    const at = link[end];
    if (at) {
      attributes.push([`${LINK_PREFIX}${end}_col_x-num`, String(at.col)], [
        `${LINK_PREFIX}${end}_line_x-num`,
        String(at.line),
      ]);
    }
  }
  if (link.symbol !== undefined) {
    attributes.push([`${LINK_PREFIX}symbol`, link.symbol]);
  }
  return attributes;
}

/** The link a node's attributes hold, if they hold one. */
export function linkOf(attributes: Record<string, string>): CodeLink | undefined {
  const at = (end: string) => {
    const col = Number(attributes[`${LINK_PREFIX}${end}_col_x-num`]);
    const line = Number(attributes[`${LINK_PREFIX}${end}_line_x-num`]);
    return Number.isInteger(col) && Number.isInteger(line) ? { col, line } : undefined;
  };
  const link: CodeLink = {
    path: attributes[`${LINK_PREFIX}path`],
    start: at("start"),
    end: at("end"),
    symbol: attributes[`${LINK_PREFIX}symbol`],
  };
  return link.path || link.symbol ? link : undefined;
}

/**
 * The answer to draw.io's `configure` event: its `Editor.configure` object.
 * `compressXml` is off so that a `.drawio` file diffs as XML. The rest is
 * hediet's frame around the drawing: no windows or popups of draw.io's own, no
 * focus taken on open, and no menu entries for what the host does instead --
 * exporting, printing, plugins, languages, help, exiting.
 */
export function drawioConfig(settings: DrawioSettings, libraries: LibraryEntry[] = []) {
  return {
    compressXml: false,
    customFonts: settings.customFonts ?? [],
    presetColors: settings.presetColors ?? [],
    customColorSchemes: settings.customColorSchemes ?? [],
    styles: settings.styles ?? [],
    defaultVertexStyle: settings.defaultVertexStyle ?? {},
    defaultEdgeStyle: settings.defaultEdgeStyle ?? {},
    colorNames: settings.colorNames ?? {},
    simpleLabels: settings.simpleLabels ?? false,
    defaultLibraries: "general",
    libraries: [{ title: { main: "Custom Libraries" }, entries: libraries }],
    zoomFactor: settings.zoomFactor ?? 1.2,
    globalVars: settings.globalVars ?? {},
    passThroughKeys: PASS_THROUGH,
    suppressNewWindows: true,
    compact: true,
    noAutoFocus: true,
    hideMenuItems: ["exportAs", "importFrom", "print", "saveAndExit", "plugins", "exit"],
    hideMenus: ["language", "help"],
    // draw.io's own default is off for each; only on is passed.
    ...(settings.showTooltipIcons ? { showTooltipIcons: true } : {}),
    ...(settings.showLinkIcons ? { showLinkIcons: true } : {}),
    ...(settings.showConnectHandle ? { showConnectHandle: true } : {}),
  };
}

/**
 * The page: draw.io's web app under `base`, started by `bridge`, which also
 * carries messages between it and the extension. draw.io's own index.html is
 * not used -- it is diagrams.net's site page -- so this is the part of it the
 * app needs: its stylesheets, the body class it lays out under, and the
 * element it clears on start.
 *
 * The policy allows scripts from the extension only, with eval: draw.io's
 * shape styles and plugins are evaluated. Pictures, fonts and libraries a
 * diagram names may come from the web, as they do in draw.io anywhere.
 */
export function drawioHtml(page: {
  base: string;
  bridge: string;
  cspSource: string;
  params: Record<string, string>;
  /** Whether to shrink a large picture dropped in; unset, draw.io asks. */
  resizeImages?: boolean | null;
}): string {
  const { cspSource } = page;
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} data: blob: https:`,
    `font-src ${cspSource} data: https:`,
    `style-src ${cspSource} 'unsafe-inline' https:`,
    `script-src ${cspSource} 'unsafe-eval'`,
    `connect-src ${cspSource} https: data: blob:`,
    `worker-src ${cspSource} blob:`,
    `frame-src ${cspSource} https:`,
  ].join("; ");
  const params = Buffer.from(JSON.stringify(page.params)).toString("base64");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base href="${page.base}/">
<link rel="stylesheet" href="styles/grapheditor.css">
<link rel="stylesheet" media="(forced-colors: active)" href="styles/high-contrast.css" id="high-contrast-stylesheet">
<style>body { overflow: hidden; }</style>
<script src="${page.bridge}" data-params="${params}" data-resize-images="${page.resizeImages ?? null}"></script>
<script src="js/PreConfig.js"></script>
<script src="js/app.min.js"></script>
</head>
<body class="geEditor">
<div id="geInfo"></div>
</body>
</html>`;
}

/**
 * The page when draw.io is not the copy poly ships but one on the web, at
 * `url`: draw.io in a frame of its own, started with the same parameters,
 * and `bridge` carrying messages between it and the extension. It is
 * another origin, so nothing of draw.io's is reached into: plugins and the
 * resize answer, set in the shipped copy's own window, are not given.
 */
export function drawioOnlineHtml(
  page: { url: string; bridge: string; cspSource: string; params: Record<string, string> },
) {
  const src = new URL(page.url);
  for (const [key, value] of Object.entries(page.params)) {
    src.searchParams.set(key, value);
  }
  const csp = [
    "default-src 'none'",
    `script-src ${page.cspSource}`,
    "style-src 'unsafe-inline'",
    `frame-src ${src.origin}`,
  ].join("; ");
  const attribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html, body, iframe { margin: 0; border: 0; width: 100%; height: 100%; display: block; overflow: hidden; }</style>
</head>
<body>
<iframe src="${attribute(src.toString())}"></iframe>
<script src="${page.bridge}"></script>
</body>
</html>`;
}

/**
 * PlantUML documents the way jebbs.plantuml reads them, without vscode.
 *
 * Ported from qjebbs/vscode-plantuml (MIT, media/plantuml/LICENSE) and held to
 * its rules on purpose: which lines are "the diagram under the cursor", what a
 * diagram is called, where its export lands and how its server URL is spelled
 * are all things a user of that extension has files, links and habits built
 * on. poly stands in for it, so the same document has to give the same
 * answers. Where this departs from it, the comment at that spot says why.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";

export const START = /@start(\w+)/i;
export const END = /@end(\w+)/i;

export type DiagramType = "uml" | "ditaa" | "dot" | "gantt" | "salt";

export interface Diagram {
  /** The `@start` line through the `@end` line, or the whole file. */
  readonly content: string;
  readonly lines: readonly string[];
  /** Zero-based and inclusive, in document lines. */
  readonly startLine: number;
  readonly endLine: number;
  /** How many `@start` lines come before this one in its document. */
  readonly index: number;
  /** What follows `@startuml` when the diagram names itself. */
  readonly nameRaw: string | undefined;
  /** What its exports and its outline entry are called. */
  readonly name: string;
  readonly pageCount: number;
  readonly type: DiagramType;
}

/**
 * The diagram `line` is in, or undefined when it is in none.
 *
 * `whole` is "this is a PlantUML file": there, text with no `@start`/`@end`
 * pair is still one diagram, the way PlantUML itself reads a bare file. In a
 * markdown or source file it is not, or every line of prose would be a
 * diagram. A line between two diagrams is in neither, even in a PlantUML file.
 */
export function diagramAt(
  lines: readonly string[],
  line: number,
  whole: boolean,
  fileBase: string,
): Diagram | undefined {
  let start: number | undefined;
  let end: number | undefined;
  for (let i = line; i >= 0; i--) {
    if (START.test(lines[i])) {
      start = i;
      break;
    }
    if (i !== line && END.test(lines[i])) {
      return undefined;
    }
  }
  for (let i = line; i < lines.length; i++) {
    if (END.test(lines[i])) {
      end = i;
      break;
    }
    if (i !== line && START.test(lines[i])) {
      return undefined;
    }
  }
  if ((start === undefined || end === undefined) && whole && lines.join("\n").trim()) {
    start = 0;
    end = lines.length - 1;
  }
  if (start === undefined || end === undefined) {
    return undefined;
  }
  return diagram(lines, start, end, fileBase);
}

/** Every diagram in a document, in order; see `diagramAt` for `whole`. */
export function diagramsOf(lines: readonly string[], whole: boolean, fileBase: string): Diagram[] {
  const found: Diagram[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (START.test(lines[i])) {
      const one = diagramAt(lines, i, whole, fileBase);
      if (one) {
        found.push(one);
      }
    }
  }
  if (found.length === 0) {
    const one = diagramAt(lines, 0, whole, fileBase);
    if (one) {
      found.push(one);
    }
  }
  return found;
}

/** A diagram with no document around it: a markdown fence. */
export function diagramOfSource(source: string): Diagram {
  const lines = source.replace(/\r\n|\r/g, "\n").split("\n");
  const one = diagram(lines, 0, lines.length - 1, "");
  // jebbs names a document-less diagram nothing unless it names itself.
  return one.nameRaw === undefined ? { ...one, name: "" } : one;
}

function diagram(all: readonly string[], startLine: number, endLine: number, fileBase: string): Diagram {
  const lines = all.slice(startLine, endLine + 1);
  let index = 0;
  for (let i = 0; i < startLine; i++) {
    if (START.test(all[i])) {
      index++;
    }
  }
  const named = /@start(\w+)\s+(.+?)\s*$/i.exec(lines[0]);
  const nameRaw = named?.[2];
  return {
    content: lines.join("\n"),
    lines,
    startLine,
    endLine,
    index,
    nameRaw,
    name: nameRaw !== undefined ? cleanTitle(nameRaw) : index ? `${fileBase}-${index}` : fileBase,
    pageCount: 1 + lines.filter((text) => /^\s*newpage\b/i.test(text)).length,
    type: typeOf(lines),
  };
}

function typeOf(lines: readonly string[]): DiagramType {
  const match = START.exec(lines[0]);
  if (!match) {
    return "uml";
  }
  const kind = match[1].toLowerCase();
  if (kind === "ditaa" || kind === "dot" || kind === "gantt" || kind === "salt") {
    return kind;
  }
  // `@startuml` followed by another diagram's own opening line is that diagram.
  const second = lines[1] ?? "";
  if (/^\s*salt\s*/i.test(second)) {
    return "salt";
  }
  if (/^\s*ditaa/i.test(second)) {
    return "ditaa";
  }
  if (/^\s*digraph\s+[0-9a-z_]+\s*\{\s*/i.test(second)) {
    return "dot";
  }
  return "uml";
}

/** Creole markup and path-hostile characters, out of a name meant for a file. */
const TITLE_RULES: [RegExp, string][] = [
  [/\s*[*#=|]*\s*(.+?)\s*$/gm, "$1"],
  [/([^\\])\\[tn]/g, "$1"],
  [/\\\\/g, "\\"],
  [/\|(\s*[*#=|]*)?\s*/g, " "],
  [/\|\s*$/g, ""],
  [/\*{2}(.+)\*{2}/g, "$1"],
  [/_{2}(.+)_{2}/g, "$1"],
  [/\/{2}(.+)\/{2}/g, "$1"],
  [/"{2}(.+)"{2}/g, "$1"],
  [/-{2}(.+)-{2}/g, "$1"],
  [/~{2}(.+)~{2}/g, "$1"],
  [/[\\/:*?"<>|]/g, " "],
];

export function cleanTitle(raw: string): string {
  return TITLE_RULES.reduce((title, [find, replace]) => title.replace(find, replace).trim(), raw);
}

/** The file name without its last extension, the way jebbs names exports. */
export function fileBase(file: string): string {
  const name = path.basename(file);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(0, dot) : name;
}

// ── export ──────────────────────────────────────────────────────────────────

export const LOCAL_FORMATS = [
  "png",
  "svg",
  "eps",
  "pdf",
  "vdx",
  "xmi",
  "scxml",
  "html",
  "txt",
  "utxt",
  "latex",
  "latex:nopreamble",
] as const;

export const SERVER_FORMATS = ["png", "svg", "txt", "pdf"] as const;

export interface ExportLayout {
  /** The workspace folder the document is in, if any. */
  readonly folder: string | undefined;
  /** The settings, as written: relative to `folder`. */
  readonly outDir: string;
  readonly diagramsRoot: string;
  readonly includeHierarchy: boolean;
  readonly subFolder: boolean;
}

export function isSubPath(from: string, to: string): boolean {
  const rel = path.relative(to, from);
  return !(path.isAbsolute(rel) || rel.startsWith(".."));
}

/**
 * Where `diagram` of `file` exports to, for `format` without its `:option`.
 *
 * A file outside every workspace folder exports beside itself. jebbs does that
 * only when the folder hierarchy is kept, and throws otherwise.
 */
export function exportPath(file: string, one: Diagram, format: string, layout: ExportLayout): string {
  const dir = path.dirname(file);
  let exportDir = dir;
  if (layout.folder) {
    const outDir = path.join(layout.folder, layout.outDir || "out");
    if (!layout.includeHierarchy) {
      exportDir = outDir;
    } else {
      const root = path.join(layout.folder, layout.diagramsRoot);
      exportDir = isSubPath(file, root)
        ? path.join(outDir, path.relative(root, dir))
        : path.join(outDir, "__WorkspaceFolder__", path.relative(layout.folder, dir));
    }
  }
  if (layout.subFolder) {
    exportDir = path.join(exportDir, fileBase(file));
  }
  return path.join(exportDir, `${one.name}.${format}`);
}

/** Page `index` of a `count`-page export: `name-page2.svg`, and `name.svg` alone. */
export function pageFile(file: string, index: number, count: number): string {
  if (count === 1) {
    return file;
  }
  const ext = path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, ext)}-page${index + 1}${ext}`);
}

/**
 * `plantuml.fileExtensions` as the glob tail jebbs builds from it.
 *
 * Throws on a value that is not a list of extensions: the glob would otherwise
 * match something nobody asked for, and exporting the wrong files is worse
 * than exporting none.
 */
export function extensionsGlob(setting: string): string {
  const read = setting.replace(/\s/g, "");
  let exts = read || ".*";
  if (exts.indexOf(",") > 0) {
    exts = `{${exts}}`;
  }
  if (!/^(.\*|\.\w+|\{\.\w+(,\.\w+)*\})$/.test(exts)) {
    throw new Error(`Invalid file extension config:\n${read}\nConfig examples:\n.*\n.wsd\n.wsd,.java\n`);
  }
  return exts;
}

// ── running the jar ────────────────────────────────────────────────────────

export interface JavaRun {
  readonly jar: string;
  readonly commandArgs: readonly string[];
  readonly jarArgs: readonly string[];
  readonly includePath: string;
}

/**
 * `-Dplantuml.include.path`: the document's folder, the configured include
 * paths, then the diagrams root, in jebbs's order and with its separators --
 * an `!include` has to find the same file here that it found there.
 *
 * A relative include path outside a workspace is skipped; jebbs throws.
 */
export function includePath(
  dir: string | undefined,
  includepaths: readonly string[],
  folder: string | undefined,
  diagramsRoot: string | undefined,
): string {
  let result = dir && path.isAbsolute(dir) ? dir : "";
  for (const one of includepaths) {
    if (!one) {
      continue;
    }
    if (path.isAbsolute(one)) {
      result += path.delimiter + one;
    } else if (folder) {
      result += path.delimiter + path.join(folder, one);
    }
  }
  if (diagramsRoot) {
    result += path.delimiter + diagramsRoot;
  }
  return result;
}

/** One page, one JVM: the arguments jebbs passes, in its order. */
export function renderArgs(
  run: JavaRun,
  page: number,
  mode: "-pipe" | "-pipemap",
  format: string | undefined,
  file: string | undefined,
): string[] {
  return [
    ...run.commandArgs,
    `-Dplantuml.include.path=${run.includePath}`,
    "-Djava.awt.headless=true",
    "-jar",
    run.jar,
    "-pipeimageindex",
    String(page),
    "-charset",
    "utf-8",
    mode,
    ...(format ? [`-t${format}`] : []),
    ...(file ? ["-filename", path.basename(file)] : []),
    ...run.jarArgs,
  ];
}

/** `-metadata`: the source PlantUML embeds in a PNG, read back out of it. */
export function metadataArgs(run: JavaRun, image: string): string[] {
  return [...run.commandArgs, "-Djava.awt.headless=true", "-jar", run.jar, ...run.jarArgs, "-metadata", image];
}

/**
 * What of a run's stderr is an error. PlantUML exits 0 with a picture of the
 * error on stdout, so stderr is the only signal; a JVM that echoes
 * JAVA_TOOL_OPTIONS there would otherwise fail every render.
 */
export function stderrError(stderr: string): string {
  return stderr.replace(/^Picked up .*$/gm, "").trim();
}

/**
 * The jar `poly tools install plantuml` reports: the managed download, or the
 * path poly.toml pins under `[tools]`. Anything else is not a jar to run --
 * "disabled in poly.toml", or a PATH hit, which for PlantUML is a launcher
 * script rather than the jar.
 */
export function jarOf(output: string): string | undefined {
  const line = output.split(/\r?\n/).find((one) => one.startsWith("plantuml: "));
  const found = line?.slice("plantuml: ".length).replace(/^pinned /, "");
  return found && path.isAbsolute(found) ? found : undefined;
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * A render's outputs as the preview page takes them: a picture becomes an
 * `<img>`, a `-pipemap` output stays the `<map>` it is, with its links sent out
 * of the page. Told apart by content, as jebbs does -- pages and maps arrive in
 * one list, and the page pairs them by order.
 */
export function previewImages(outputs: readonly Buffer[]): string {
  return outputs
    .map((out) => {
      const png = out.subarray(0, PNG.length).equals(PNG);
      if (png || out.subarray(0, 256).includes("<svg")) {
        return `<img src="data:image/${png ? "png" : "svg+xml"};base64,${out.toString("base64")}">`;
      }
      const map = out.toString();
      return map.trim() ? map.replaceAll("<area ", "<area target=\"_blank\" ") : "<map></map>";
    })
    .join("");
}

// ── server URLs ─────────────────────────────────────────────────────────────

export function serverOf(setting: string): string {
  return setting.trim().replace(/\/+$/g, "");
}

/** PlantUML's text encoding: raw deflate, then its own base64 alphabet. */
export function encodeSource(text: string): string {
  const bytes = deflateRawSync(Buffer.from(text), { level: 9 });
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    out += append3(bytes[i], bytes[i + 1] ?? 0, bytes[i + 2] ?? 0);
  }
  return out;
}

function append3(b1: number, b2: number, b3: number): string {
  return [b1 >> 2, ((b1 & 0x3) << 4) | (b2 >> 4), ((b2 & 0xf) << 2) | (b3 >> 6), b3 & 0x3f]
    .map((six) => encode6(six & 0x3f))
    .join("");
}

function encode6(b: number): string {
  if (b < 10) {
    return String.fromCharCode(48 + b);
  }
  if (b < 36) {
    return String.fromCharCode(65 + b - 10);
  }
  if (b < 62) {
    return String.fromCharCode(97 + b - 36);
  }
  return b === 62 ? "-" : "_";
}

/**
 * A server's `X-PlantUML-Diagram-Error` headers, worded as jebbs words them.
 * The server counts lines from the first after `@startuml`, and skips blank
 * lines at the top; the file line is what a user can jump to.
 */
export function serverError(error: string, line: number, description: string, one: Diagram): string {
  const diagramLine = START.test(one.lines[0]) ? line + 1 : line;
  let blank = 0;
  for (let i = 1; i < one.lines.length && !one.lines[i].trim(); i++) {
    blank++;
  }
  const inDiagram = diagramLine + blank;
  return `${error} (@ Diagram Line ${diagramLine}, File Line ${inDiagram + one.startLine})\n`
    + `"${one.lines[inDiagram - 1]}"\n${description}\n`;
}

/** The page is left out when it is the first, which is what kroki accepts. */
export function diagramUrl(server: string, format: string, page: number, text: string): string {
  const parts = [server.replace(/^\/|\/$/g, ""), format];
  if (page !== 0) {
    parts.push(String(page));
  }
  parts.push(encodeSource(text));
  return parts.join("/");
}

// ── !include, for what leaves the machine ──────────────────────────────────

const INCLUDE = /^\s*!(include(?:sub)?)\s+(.+?)(?:!(\w+))?$/i;
const STARTSUB = /^\s*!startsub\s+(\w+)/i;
const ENDSUB = /^\s*!endsub\b/i;
const START_DIAGRAM = /(^|\r?\n)\s*@start.*\r?\n/i;
const END_DIAGRAM = /\r?\n\s*@end.*(\r?\n|$)(?!.*\r?\n\s*@end.*(\r?\n|$))/i;

/**
 * The diagram with its local `!include`s inlined, for a server and a URL: a
 * server cannot read this machine's files, and the local renderer is given the
 * include path instead. What cannot be found stays as written, so the server
 * gets the chance to resolve it (`!include <C4/C4_Context>` is its own
 * library).
 *
 * `searchPaths` answers per file, because an included file's own includes are
 * relative to it.
 *
 * A missing `!includesub` block is left as written; jebbs throws on it.
 */
export function withIncludes(
  lines: readonly string[],
  file: string | undefined,
  searchPaths: (file: string | undefined) => string[],
): string {
  const included = new Set<string>();
  const route: string[] = file ? [file] : [];

  const resolve = (content: readonly string[], paths: string[]): string =>
    content
      .map((line) =>
        line.replace(INCLUDE, (match: string, action: string, target: string, sub: string | undefined) => {
          const wanted = target.trim();
          const found = path.isAbsolute(wanted) ? wanted : paths.map((dir) => path.join(dir, wanted)).find(exists);
          const result = action.toLowerCase() === "include" ? includeFile(found) : includeSub(found, sub);
          return result === undefined ? match : result;
        })
      )
      .join("\n");

  const includeFile = (found: string | undefined): string | undefined => {
    if (!found || !exists(found) || !fs.statSync(found).isFile()) {
      return undefined;
    }
    if (included.has(found)) {
      return "";
    }
    route.push(found);
    included.add(found);
    const result = resolve(splitLines(fs.readFileSync(found, "utf8")), searchPaths(found));
    route.pop();
    return result.replace(START_DIAGRAM, "$1").replace(END_DIAGRAM, "$1");
  };

  const includeSub = (found: string | undefined, sub: string | undefined): string | undefined => {
    if (!found || !sub || !exists(found)) {
      return undefined;
    }
    const id = `${found}!${sub}`;
    const loop = route.indexOf(id);
    if (loop >= 0) {
      throw new Error(`Include loop detected!\n\n${loopInfo(route, loop)}`);
    }
    const block = subBlocks(fs.readFileSync(found, "utf8"))[sub];
    if (!block) {
      return undefined;
    }
    route.push(id);
    const result = resolve(block, searchPaths(found));
    route.pop();
    return result;
  };

  return resolve(lines, searchPaths(file));
}

function exists(file: string): boolean {
  return fs.existsSync(file);
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n|\r/g, "\n").split("\n");
}

function subBlocks(text: string): Record<string, string[]> {
  const blocks: Record<string, string[]> = {};
  let name = "";
  for (const line of text.split("\n")) {
    const start = STARTSUB.exec(line);
    if (start) {
      name = start[1];
    } else if (ENDSUB.test(line)) {
      name = "";
    } else if (name) {
      (blocks[name] ??= []).push(line);
    }
  }
  return blocks;
}

function loopInfo(route: readonly string[], loop: number): string {
  return [
    ...route.slice(0, loop),
    `|-> ${route[loop]}`,
    ...route.slice(loop + 1, -1).map((one) => `|   ${one}`),
    `|<- ${route[route.length - 1]}`,
  ].join("\n");
}

// ── markdown ────────────────────────────────────────────────────────────────

/**
 * jebbs's fence names, matched as it matches them: the first space-separated
 * word, exact case. `{plantuml}` is the pandoc-style spelling some documents
 * use; MarkNote's one name, `plantuml`, is among these.
 */
const FENCES = new Set(["plantuml", "puml", "uml", "{plantuml}", "{puml}", "{uml}"]);

export function isPlantumlFence(info: string): boolean {
  return FENCES.has(info.split(" ")[0]);
}

// ── diagnostics ─────────────────────────────────────────────────────────────

export interface Finding {
  readonly line: number;
  readonly message: string;
  readonly severity: "warning" | "error";
}

/**
 * Two diagrams with one name export to one file, and the second overwrites the
 * first without a word -- hence an error. An unnamed one is a warning, and only
 * when asked for, because naming is a habit rather than a mistake.
 */
export function lint(diagrams: readonly Diagram[], unnamed: boolean): Finding[] {
  const findings: Finding[] = [];
  const names = new Set<string>();
  for (const one of diagrams) {
    if (unnamed && one.nameRaw === undefined) {
      findings.push({ line: one.startLine, message: `Diagram unnamed. Try "@startuml name"`, severity: "warning" });
    }
    if (names.has(one.name)) {
      findings.push({ line: one.startLine, message: `Duplicate diagram name "${one.name}".`, severity: "error" });
    } else {
      names.add(one.name);
    }
  }
  return findings;
}

// ── completion ──────────────────────────────────────────────────────────────

const MACRO_DEF = /!(?:define|definelong) (\w+)(?:\(((?:,? *(?:\w)+ *(?:= *".+")?)+)\))?/i;
const MACRO_CALL = /(!(?:define|definelong) )?(\w+)\(([\w, "]*)\)?/gi;

export interface Macro {
  readonly name: string;
  /** Parameter lists, shortest first. */
  readonly signatures: string[][];
}

export function macrosOf(lines: readonly string[]): Macro[] {
  const macros: Macro[] = [];
  for (const line of lines) {
    const match = MACRO_DEF.exec(line);
    if (!match) {
      continue;
    }
    const params = (match[2] ?? "").split(",").map((one) => one.trim()).filter((one) => one);
    let macro = macros.find((one) => one.name === match[1]);
    if (!macro) {
      macro = { name: match[1], signatures: [] };
      macros.push(macro);
    }
    macro.signatures.push(params);
    macro.signatures.sort((a, b) => a.length - b.length);
  }
  return macros;
}

export function signatureLabel(name: string, params: readonly string[]): string {
  return params.length > 0 ? `${name}(${params.join(", ")})` : name;
}

export function macroDetail(macro: Macro): string {
  const others = macro.signatures.length - 1;
  const overloads = others === 1 ? " (+1 overload)" : others > 1 ? ` (+${others} overloads)` : "";
  return signatureLabel(macro.name, macro.signatures[0]) + overloads;
}

export interface MacroCall {
  readonly name: string;
  /** Arguments written so far, and the one the cursor is in (zero-based). */
  readonly available: number;
  readonly active: number;
}

/** The macro call around `character`, not counting a definition's own line. */
export function macroCallAt(text: string, character: number): MacroCall | undefined {
  MACRO_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  let start = 0;
  while ((match = MACRO_CALL.exec(text))) {
    start = match.index;
    if (start <= character && character <= start + match[0].length) {
      break;
    }
  }
  if (!match || match[1]) {
    return undefined;
  }
  return {
    name: match[2],
    available: match[3].split(",").length,
    active: text.substring(start, character).split(",").length - 1,
  };
}

const VARIABLE = /[0-9a-z_]+/gi;

/**
 * Every word in the diagram that is not a PlantUML word, as a candidate name:
 * participants, aliases, classes. Directive lines are skipped, and so is the
 * cursor's own line -- the half-typed word there is not a name yet.
 */
export function variablesOf(lines: readonly string[], skip: number, words: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  lines.forEach((line, i) => {
    if (i === skip || /^\s*(!|@)/i.test(line)) {
      return;
    }
    for (const [word] of line.matchAll(VARIABLE)) {
      if (!words.has(word)) {
        found.add(word);
      }
    }
  });
  return [...found];
}

export type WordKind = "type" | "keyword" | "preprocessor" | "skinparameter" | "color";

export interface Word {
  /** What the list shows; `name` is what it inserts. */
  readonly label: string;
  readonly name: string;
  readonly kind: WordKind;
}

const CLEAN_LABEL = /[^0-9a-z_]/gi;
const KINDS = new Set<string>(["type", "keyword", "preprocessor", "skinparameter", "color"]);

/** `java -jar plantuml.jar -language`: `;kind` headers, one word per line. */
export function parseLanguage(output: string): Word[] {
  const words: Word[] = [];
  let kind: WordKind | undefined;
  for (const raw of output.split("\n")) {
    const word = raw.trim();
    const label = word.replace(CLEAN_LABEL, "");
    if (!label) {
      continue;
    }
    if (word.startsWith(";")) {
      // Other `;` lines are counts (`;29`) and `;EOF`, and they sit inside a
      // section: the kind carries on across them.
      if (KINDS.has(word.slice(1))) {
        kind = word.slice(1) as WordKind;
      }
      continue;
    }
    if (kind) {
      words.push({ label, name: word, kind });
    }
  }
  return words;
}

/**
 * The jar's own list first, then jebbs's built-in one for what it lacks: an
 * older jar knows fewer words, and no Java at all still gets these.
 */
export function languageWords(generated: readonly Word[]): Word[] {
  const words = [...generated];
  for (const [kind, names] of Object.entries(PREDEFINED) as [WordKind, readonly string[]][]) {
    for (const name of names) {
      if (!words.some((one) => one.name === name && one.kind === kind)) {
        words.push({ label: name.replace(CLEAN_LABEL, ""), name, kind });
      }
    }
  }
  return words;
}

const PREDEFINED: Record<WordKind, readonly string[]> = {
  type: [
    "abstract",
    "actor",
    "agent",
    "archimate",
    "artifact",
    "boundary",
    "card",
    "class",
    "cloud",
    "component",
    "control",
    "database",
    "diamond",
    "entity",
    "enum",
    "file",
    "folder",
    "frame",
    "interface",
    "node",
    "object",
    "package",
    "participant",
    "queue",
    "rectangle",
    "stack",
    "state",
    "storage",
    "usecase",
  ],
  keyword: [
    "@enddot",
    "@endsalt",
    "@enduml",
    "@startdot",
    "@startsalt",
    "@startuml",
    "activate",
    "again",
    "allow_mixing",
    "allowmixing",
    "also",
    "alt",
    "as",
    "autonumber",
    "bold",
    "bottom",
    "box",
    "break",
    "caption",
    "center",
    "circle",
    "create",
    "critical",
    "deactivate",
    "description",
    "destroy",
    "down",
    "else",
    "elseif",
    "empty",
    "end",
    "endif",
    "endwhile",
    "false",
    "footbox",
    "footer",
    "fork",
    "group",
    "header",
    "hide",
    "hnote",
    "if",
    "is",
    "italic",
    "kill",
    "left",
    "legend",
    "link",
    "loop",
    "members",
    "namespace",
    "newpage",
    "note",
    "of",
    "on",
    "opt",
    "order",
    "over",
    "package",
    "page",
    "par",
    "partition",
    "plain",
    "ref",
    "repeat",
    "return",
    "right",
    "rnote",
    "rotate",
    "show",
    "skin",
    "skinparam",
    "start",
    "stop",
    "strictuml",
    "title",
    "top",
    "top to bottom direction",
    "true",
    "up",
    "while",
  ],
  preprocessor: [
    "!define",
    "!definelong",
    "!else",
    "!enddefinelong",
    "!endif",
    "!exit",
    "!if",
    "!ifdef",
    "!ifndef",
    "!include",
    "!pragma",
    "!undef",
  ],
  skinparameter: skinparams(),
  color: colors(),
};

// jebbs's lists, verbatim; long enough that one word per line would bury the
// module, and data rather than anything to read.
function skinparams(): string[] {
  return (
    "ActivityBackgroundColor ActivityBarColor ActivityBorderColor ActivityBorderThickness "
    + "ActivityDiamondBackgroundColor ActivityDiamondBorderColor ActivityDiamondFontColor "
    + "ActivityDiamondFontName ActivityDiamondFontSize ActivityDiamondFontStyle ActivityEndColor "
    + "ActivityFontColor ActivityFontName ActivityFontSize ActivityFontStyle ActivityStartColor "
    + "ActorBackgroundColor ActorBorderColor ActorFontColor ActorFontName ActorFontSize ActorFontStyle "
    + "ActorStereotypeFontColor ActorStereotypeFontName ActorStereotypeFontSize ActorStereotypeFontStyle "
    + "AgentBackgroundColor AgentBorderColor AgentBorderThickness AgentFontColor AgentFontName "
    + "AgentFontSize AgentFontStyle AgentStereotypeFontColor AgentStereotypeFontName "
    + "AgentStereotypeFontSize AgentStereotypeFontStyle ArrowColor ArrowFontColor ArrowFontName "
    + "ArrowFontSize ArrowFontStyle ArrowLollipopColor ArrowMessageAlignment ArrowThickness "
    + "ArtifactBackgroundColor ArtifactBorderColor ArtifactFontColor ArtifactFontName ArtifactFontSize "
    + "ArtifactFontStyle ArtifactStereotypeFontColor ArtifactStereotypeFontName "
    + "ArtifactStereotypeFontSize ArtifactStereotypeFontStyle BackgroundColor BiddableBackgroundColor "
    + "BiddableBorderColor BoundaryBackgroundColor BoundaryBorderColor BoundaryFontColor "
    + "BoundaryFontName BoundaryFontSize BoundaryFontStyle BoundaryStereotypeFontColor "
    + "BoundaryStereotypeFontName BoundaryStereotypeFontSize BoundaryStereotypeFontStyle BoxPadding "
    + "CaptionFontColor CaptionFontName CaptionFontSize CaptionFontStyle CardBackgroundColor "
    + "CardBorderColor CardBorderThickness CardFontColor CardFontName CardFontSize CardFontStyle "
    + "CardStereotypeFontColor CardStereotypeFontName CardStereotypeFontSize CardStereotypeFontStyle "
    + "CircledCharacterFontColor CircledCharacterFontName CircledCharacterFontSize "
    + "CircledCharacterFontStyle CircledCharacterRadius ClassAttributeFontColor "
    + "ClassAttributeFontName ClassAttributeFontSize ClassAttributeFontStyle ClassAttributeIconSize "
    + "ClassBackgroundColor ClassBorderColor ClassBorderThickness ClassFontColor ClassFontName "
    + "ClassFontSize ClassFontStyle ClassHeaderBackgroundColor ClassStereotypeFontColor "
    + "ClassStereotypeFontName ClassStereotypeFontSize ClassStereotypeFontStyle CloudBackgroundColor "
    + "CloudBorderColor CloudFontColor CloudFontName CloudFontSize CloudFontStyle "
    + "CloudStereotypeFontColor CloudStereotypeFontName CloudStereotypeFontSize "
    + "CloudStereotypeFontStyle CollectionsBackgroundColor CollectionsBorderColor "
    + "ColorArrowSeparationSpace ComponentBackgroundColor ComponentBorderColor "
    + "ComponentBorderThickness ComponentFontColor ComponentFontName ComponentFontSize "
    + "ComponentFontStyle ComponentStereotypeFontColor ComponentStereotypeFontName "
    + "ComponentStereotypeFontSize ComponentStereotypeFontStyle ComponentStyle ConditionStyle "
    + "ControlBackgroundColor ControlBorderColor ControlFontColor ControlFontName ControlFontSize "
    + "ControlFontStyle ControlStereotypeFontColor ControlStereotypeFontName "
    + "ControlStereotypeFontSize ControlStereotypeFontStyle DatabaseBackgroundColor "
    + "DatabaseBorderColor DatabaseFontColor DatabaseFontName DatabaseFontSize DatabaseFontStyle "
    + "DatabaseStereotypeFontColor DatabaseStereotypeFontName DatabaseStereotypeFontSize "
    + "DatabaseStereotypeFontStyle DefaultFontColor DefaultFontName DefaultFontSize "
    + "DefaultFontStyle DefaultMonospacedFontName DefaultTextAlignment DesignedBackgroundColor "
    + "DesignedBorderColor DesignedDomainBorderThickness DesignedDomainFontColor "
    + "DesignedDomainFontName DesignedDomainFontSize DesignedDomainFontStyle "
    + "DesignedDomainStereotypeFontColor DesignedDomainStereotypeFontName "
    + "DesignedDomainStereotypeFontSize DesignedDomainStereotypeFontStyle DiagramBorderColor "
    + "DiagramBorderThickness DomainBackgroundColor DomainBorderColor DomainBorderThickness "
    + "DomainFontColor DomainFontName DomainFontSize DomainFontStyle DomainStereotypeFontColor "
    + "DomainStereotypeFontName DomainStereotypeFontSize DomainStereotypeFontStyle Dpi "
    + "EntityBackgroundColor EntityBorderColor EntityFontColor EntityFontName EntityFontSize "
    + "EntityFontStyle EntityStereotypeFontColor EntityStereotypeFontName EntityStereotypeFontSize "
    + "EntityStereotypeFontStyle FileBackgroundColor FileBorderColor FileFontColor FileFontName "
    + "FileFontSize FileFontStyle FileStereotypeFontColor FileStereotypeFontName "
    + "FileStereotypeFontSize FileStereotypeFontStyle FolderBackgroundColor FolderBorderColor "
    + "FolderFontColor FolderFontName FolderFontSize FolderFontStyle FolderStereotypeFontColor "
    + "FolderStereotypeFontName FolderStereotypeFontSize FolderStereotypeFontStyle FooterFontColor "
    + "FooterFontName FooterFontSize FooterFontStyle FrameBackgroundColor FrameBorderColor "
    + "FrameFontColor FrameFontName FrameFontSize FrameFontStyle FrameStereotypeFontColor "
    + "FrameStereotypeFontName FrameStereotypeFontSize FrameStereotypeFontStyle GenericDisplay "
    + "Guillemet Handwritten HeaderFontColor HeaderFontName HeaderFontSize HeaderFontStyle "
    + "HyperlinkColor HyperlinkUnderline IconIEMandatoryColor IconPackageBackgroundColor "
    + "IconPackageColor IconPrivateBackgroundColor IconPrivateColor IconProtectedBackgroundColor "
    + "IconProtectedColor IconPublicBackgroundColor IconPublicColor InterfaceBackgroundColor "
    + "InterfaceBorderColor InterfaceFontColor InterfaceFontName InterfaceFontSize "
    + "InterfaceFontStyle InterfaceStereotypeFontColor InterfaceStereotypeFontName "
    + "InterfaceStereotypeFontSize InterfaceStereotypeFontStyle LegendBackgroundColor "
    + "LegendBorderColor LegendBorderThickness LegendFontColor LegendFontName LegendFontSize "
    + "LegendFontStyle LexicalBackgroundColor LexicalBorderColor Linetype MachineBackgroundColor "
    + "MachineBorderColor MachineBorderThickness MachineFontColor MachineFontName MachineFontSize "
    + "MachineFontStyle MachineStereotypeFontColor MachineStereotypeFontName "
    + "MachineStereotypeFontSize MachineStereotypeFontStyle MaxAsciiMessageLength MaxMessageSize "
    + "MinClassWidth Monochrome NodeBackgroundColor NodeBorderColor NodeFontColor NodeFontName "
    + "NodeFontSize NodeFontStyle NodeStereotypeFontColor NodeStereotypeFontName "
    + "NodeStereotypeFontSize NodeStereotypeFontStyle Nodesep NoteBackgroundColor NoteBorderColor "
    + "NoteBorderThickness NoteFontColor NoteFontName NoteFontSize NoteFontStyle NoteShadowing "
    + "NoteTextAlignment ObjectAttributeFontColor ObjectAttributeFontName ObjectAttributeFontSize "
    + "ObjectAttributeFontStyle ObjectBackgroundColor ObjectBorderColor ObjectBorderThickness "
    + "ObjectFontColor ObjectFontName ObjectFontSize ObjectFontStyle ObjectStereotypeFontColor "
    + "ObjectStereotypeFontName ObjectStereotypeFontSize ObjectStereotypeFontStyle "
    + "PackageBackgroundColor PackageBorderColor PackageBorderThickness PackageFontColor "
    + "PackageFontName PackageFontSize PackageFontStyle PackageStereotypeFontColor "
    + "PackageStereotypeFontName PackageStereotypeFontSize PackageStereotypeFontStyle PackageStyle "
    + "PackageTitleAlignment Padding PageBorderColor PageExternalColor PageMargin "
    + "ParticipantBackgroundColor ParticipantBorderColor ParticipantFontColor ParticipantFontName "
    + "ParticipantFontSize ParticipantFontStyle ParticipantPadding PartitionBackgroundColor "
    + "PartitionBorderColor PartitionBorderThickness PartitionFontColor PartitionFontName "
    + "PartitionFontSize PartitionFontStyle PathHoverColor QueueBackgroundColor QueueBorderColor "
    + "QueueFontColor QueueFontName QueueFontSize QueueFontStyle QueueStereotypeFontColor "
    + "QueueStereotypeFontName QueueStereotypeFontSize QueueStereotypeFontStyle Ranksep "
    + "RectangleBackgroundColor RectangleBorderColor RectangleBorderThickness RectangleFontColor "
    + "RectangleFontName RectangleFontSize RectangleFontStyle RectangleStereotypeFontColor "
    + "RectangleStereotypeFontName RectangleStereotypeFontSize RectangleStereotypeFontStyle "
    + "RequirementBackgroundColor RequirementBorderColor RequirementBorderThickness "
    + "RequirementFontColor RequirementFontName RequirementFontSize RequirementFontStyle "
    + "RequirementStereotypeFontColor RequirementStereotypeFontName "
    + "RequirementStereotypeFontSize RequirementStereotypeFontStyle ResponseMessageBelowArrow "
    + "RoundCorner SameClassWidth SequenceActorBorderThickness SequenceArrowThickness "
    + "SequenceBoxBackgroundColor SequenceBoxBorderColor SequenceBoxFontColor SequenceBoxFontName "
    + "SequenceBoxFontSize SequenceBoxFontStyle SequenceDelayFontColor SequenceDelayFontName "
    + "SequenceDelayFontSize SequenceDelayFontStyle SequenceDividerBackgroundColor "
    + "SequenceDividerBorderColor SequenceDividerBorderThickness SequenceDividerFontColor "
    + "SequenceDividerFontName SequenceDividerFontSize SequenceDividerFontStyle "
    + "SequenceGroupBackgroundColor SequenceGroupBodyBackgroundColor SequenceGroupBorderColor "
    + "SequenceGroupBorderThickness SequenceGroupFontColor SequenceGroupFontName "
    + "SequenceGroupFontSize SequenceGroupFontStyle SequenceGroupHeaderFontColor "
    + "SequenceGroupHeaderFontName SequenceGroupHeaderFontSize SequenceGroupHeaderFontStyle "
    + "SequenceLifeLineBackgroundColor SequenceLifeLineBorderColor SequenceLifeLineBorderThickness "
    + "SequenceMessageAlignment SequenceMessageTextAlignment SequenceNewpageSeparatorColor "
    + "SequenceParticipant SequenceParticipantBorderThickness SequenceReferenceAlignment "
    + "SequenceReferenceBackgroundColor SequenceReferenceBorderColor SequenceReferenceBorderThickness "
    + "SequenceReferenceFontColor SequenceReferenceFontName SequenceReferenceFontSize "
    + "SequenceReferenceFontStyle SequenceReferenceHeaderBackgroundColor SequenceStereotypeFontColor "
    + "SequenceStereotypeFontName SequenceStereotypeFontSize SequenceStereotypeFontStyle "
    + "SequenceTitleFontColor SequenceTitleFontName SequenceTitleFontSize SequenceTitleFontStyle "
    + "Shadowing StackBackgroundColor StackBorderColor StackFontColor StackFontName StackFontSize "
    + "StackFontStyle StackStereotypeFontColor StackStereotypeFontName StackStereotypeFontSize "
    + "StackStereotypeFontStyle StateAttributeFontColor StateAttributeFontName "
    + "StateAttributeFontSize StateAttributeFontStyle StateBackgroundColor StateBorderColor "
    + "StateEndColor StateFontColor StateFontName StateFontSize StateFontStyle StateStartColor "
    + "StereotypeABackgroundColor StereotypeABorderColor StereotypeCBackgroundColor "
    + "StereotypeCBorderColor StereotypeEBackgroundColor StereotypeEBorderColor "
    + "StereotypeIBackgroundColor StereotypeIBorderColor StereotypeNBackgroundColor "
    + "StereotypeNBorderColor StereotypePosition StorageBackgroundColor StorageBorderColor "
    + "StorageFontColor StorageFontName StorageFontSize StorageFontStyle StorageStereotypeFontColor "
    + "StorageStereotypeFontName StorageStereotypeFontSize StorageStereotypeFontStyle Style "
    + "SvglinkTarget SwimlaneBorderColor SwimlaneBorderThickness SwimlaneTitleFontColor "
    + "SwimlaneTitleFontName SwimlaneTitleFontSize SwimlaneTitleFontStyle SwimlaneWidth "
    + "SwimlaneWrapTitleWidth TabSize TitleBackgroundColor TitleBorderColor TitleBorderRoundCorner "
    + "TitleBorderThickness TitleFontColor TitleFontName TitleFontSize TitleFontStyle "
    + "UsecaseBackgroundColor UsecaseBorderColor UsecaseBorderThickness UsecaseFontColor "
    + "UsecaseFontName UsecaseFontSize UsecaseFontStyle UsecaseStereotypeFontColor "
    + "UsecaseStereotypeFontName UsecaseStereotypeFontSize UsecaseStereotypeFontStyle WrapWidth"
  ).split(" ");
}

function colors(): string[] {
  return (
    "APPLICATION AliceBlue AntiqueWhite Aqua Aquamarine Azure BUSINESS Beige Bisque Black "
    + "BlanchedAlmond Blue BlueViolet Brown BurlyWood CadetBlue Chartreuse Chocolate Coral "
    + "CornflowerBlue Cornsilk Crimson Cyan DarkBlue DarkCyan DarkGoldenRod DarkGray DarkGreen "
    + "DarkGrey DarkKhaki DarkMagenta DarkOliveGreen DarkOrchid DarkRed DarkSalmon DarkSeaGreen "
    + "DarkSlateBlue DarkSlateGray DarkSlateGrey DarkTurquoise DarkViolet Darkorange DeepPink "
    + "DeepSkyBlue DimGray DimGrey DodgerBlue FireBrick FloralWhite ForestGreen Fuchsia Gainsboro "
    + "GhostWhite Gold GoldenRod Gray Green GreenYellow Grey HoneyDew HotPink IMPLEMENTATION "
    + "IndianRed Indigo Ivory Khaki Lavender LavenderBlush LawnGreen LemonChiffon LightBlue "
    + "LightCoral LightCyan LightGoldenRodYellow LightGray LightGreen LightGrey LightPink "
    + "LightSalmon LightSeaGreen LightSkyBlue LightSlateGray LightSlateGrey LightSteelBlue "
    + "LightYellow Lime LimeGreen Linen MOTIVATION Magenta Maroon MediumAquaMarine MediumBlue "
    + "MediumOrchid MediumPurple MediumSeaGreen MediumSlateBlue MediumSpringGreen MediumTurquoise "
    + "MediumVioletRed MidnightBlue MintCream MistyRose Moccasin NavajoWhite Navy OldLace Olive "
    + "OliveDrab Orange OrangeRed Orchid PHYSICAL PaleGoldenRod PaleGreen PaleTurquoise "
    + "PaleVioletRed PapayaWhip PeachPuff Peru Pink Plum PowderBlue Purple Red RosyBrown RoyalBlue "
    + "STRATEGY SaddleBrown Salmon SandyBrown SeaGreen SeaShell Sienna Silver SkyBlue SlateBlue "
    + "SlateGray SlateGrey Snow SpringGreen SteelBlue TECHNOLOGY Tan Teal Thistle Tomato Turquoise "
    + "Violet Wheat White WhiteSmoke Yellow YellowGreen"
  ).split(" ");
}

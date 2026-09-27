import * as assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  diagramAt,
  diagramOfSource,
  diagramsOf,
  diagramUrl,
  encodeSource,
  type ExportLayout,
  exportPath,
  extensionsGlob,
  includePath,
  isPlantumlFence,
  jarOf,
  languageWords,
  lint,
  macroCallAt,
  macroDetail,
  macrosOf,
  metadataArgs,
  pageFile,
  parseLanguage,
  previewImages,
  renderArgs,
  serverError,
  serverOf,
  stderrError,
  variablesOf,
  withIncludes,
} from "./plantuml";

const TWO = [
  "' header comment",
  "@startuml",
  "A -> B",
  "@enduml",
  "",
  "@startuml second",
  "B -> C",
  "newpage",
  "C -> D",
  "@enduml",
];

test("the cursor picks the diagram it is in, and nothing between two", () => {
  // Preview and Export Current act on this, so a wrong answer renders or
  // overwrites the wrong diagram.
  const second = diagramAt(TWO, 6, true, "flow");
  assert.equal(second?.startLine, 5);
  assert.equal(second?.endLine, 9);
  assert.equal(second?.index, 1);
  assert.equal(diagramAt(TWO, 4, true, "flow"), undefined);
});

test("a PlantUML file with no markers is one diagram; prose is not", () => {
  const bare = ["A -> B", "B -> C"];
  assert.equal(diagramAt(bare, 1, true, "bare")?.content, "A -> B\nB -> C");
  assert.equal(diagramAt(bare, 1, false, "notes"), undefined);
  assert.deepEqual(diagramsOf(bare, false, "notes"), []);
});

test("names are what exports are called: the file for the first, -N after", () => {
  const all = diagramsOf(TWO, true, "flow");
  assert.deepEqual(all.map((one) => one.name), ["flow", "second"]);
  const unnamed = diagramsOf(["@startuml", "@enduml", "@startuml", "@enduml"], true, "f");
  assert.deepEqual(unnamed.map((one) => one.name), ["f", "f-1"]);
  // A name is a file name too: markup and path characters cannot survive.
  assert.equal(diagramOfSource("@startuml **Order/Flow**\nA -> B\n@enduml").name, "Order Flow");
  assert.equal(diagramOfSource("@startuml\nA -> B\n@enduml").name, "");
});

test("pages and types drive how many files and which format", () => {
  assert.equal(diagramsOf(TWO, true, "flow")[1].pageCount, 2);
  assert.equal(diagramOfSource("@startuml\nditaa\n+--+\n@enduml").type, "ditaa");
  assert.equal(diagramOfSource("@startditaa\n+--+\n@endditaa").type, "ditaa");
  assert.equal(diagramOfSource("@startuml\nA -> B\n@enduml").type, "uml");
});

const LAYOUT: ExportLayout = {
  folder: "/w",
  outDir: "",
  diagramsRoot: "",
  includeHierarchy: true,
  subFolder: true,
};

test("exports land where jebbs put them, so existing out/ trees keep matching", () => {
  const one = diagramOfSource("@startuml seq\n@enduml");
  assert.equal(exportPath("/w/docs/a.puml", one, "svg", LAYOUT), "/w/out/docs/a/seq.svg");
  const rooted = { ...LAYOUT, diagramsRoot: "docs" };
  assert.equal(exportPath("/w/docs/x/a.puml", one, "svg", rooted), "/w/out/x/a/seq.svg");
  assert.equal(exportPath("/w/other/b.puml", one, "png", rooted), "/w/out/__WorkspaceFolder__/other/b/seq.png");
  assert.equal(exportPath("/w/docs/a.puml", one, "svg", { ...LAYOUT, includeHierarchy: false }), "/w/out/a/seq.svg");
  assert.equal(exportPath("/w/docs/a.puml", one, "svg", { ...LAYOUT, subFolder: false }), "/w/out/docs/seq.svg");
  // Outside every folder there is no out/ to use.
  assert.equal(exportPath("/tmp/a.puml", one, "svg", { ...LAYOUT, folder: undefined }), "/tmp/a/seq.svg");
});

test("multi-page exports number their pages; one page keeps the plain name", () => {
  assert.equal(pageFile("/o/seq.svg", 0, 1), "/o/seq.svg");
  assert.equal(pageFile("/o/seq.svg", 1, 3), "/o/seq-page2.svg");
});

test("the JVM gets jebbs's arguments in jebbs's order", () => {
  // jarArgs last and commandArgs first is what lets a user override either.
  const run = {
    jar: "/j/plantuml.jar",
    commandArgs: ["-Xmx1g"],
    jarArgs: ["-DPLANTUML_LIMIT_SIZE=8192"],
    includePath: "/d",
  };
  assert.deepEqual(renderArgs(run, 1, "-pipe", "svg", "/d/a.puml"), [
    "-Xmx1g",
    "-Dplantuml.include.path=/d",
    "-Djava.awt.headless=true",
    "-jar",
    "/j/plantuml.jar",
    "-pipeimageindex",
    "1",
    "-charset",
    "utf-8",
    "-pipe",
    "-tsvg",
    "-filename",
    "a.puml",
    "-DPLANTUML_LIMIT_SIZE=8192",
  ]);
  assert.deepEqual(renderArgs(run, 0, "-pipemap", undefined, undefined).slice(-2), [
    "-pipemap",
    "-DPLANTUML_LIMIT_SIZE=8192",
  ]);
  // Extraction has no include path: the image is the whole input.
  assert.deepEqual(metadataArgs(run, "/d/a.png"), [
    "-Xmx1g",
    "-Djava.awt.headless=true",
    "-jar",
    "/j/plantuml.jar",
    "-DPLANTUML_LIMIT_SIZE=8192",
    "-metadata",
    "/d/a.png",
  ]);
});

test("!include searches the document's folder, then the settings, then the root", () => {
  const sep = path.delimiter;
  assert.equal(includePath("/w/d", ["inc", "/abs"], "/w", "/w"), `/w/d${sep}/w/inc${sep}/abs${sep}/w`);
  assert.equal(includePath(undefined, ["inc"], undefined, undefined), "");
});

test("stderr noise from the JVM is not an error, a PlantUML message is", () => {
  assert.equal(stderrError("Picked up JAVA_TOOL_OPTIONS: -Xss4m\n"), "");
  assert.equal(stderrError("Picked up _JAVA_OPTIONS: x\nERROR\n3\nSyntax Error?"), "ERROR\n3\nSyntax Error?");
});

test("URLs are the ones PlantUML servers decode", () => {
  // Expected value from the plantuml-encoder package, an independent
  // implementation; `java -jar plantuml.jar -decodeurl` reads it back too.
  assert.equal(
    encodeSource("@startuml\nBob -> Alice : hello\n@enduml"),
    "SoWkIImgAStDuNBAJrBGjLDmpCbCJbMmKiX8pSd9vt98pKifpSq10000",
  );
  assert.equal(diagramUrl(serverOf(" https://s/plantuml// "), "svg", 0, "a"), "https://s/plantuml/svg/ImG0");
  assert.equal(diagramUrl("https://s", "png", 2, "a"), "https://s/png/2/ImG0");
});

test("local includes are inlined for a server, unknown ones left for it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "puml-"));
  writeFileSync(path.join(dir, "style.iuml"), "@startuml\nskinparam monochrome true\n@enduml\n");
  writeFileSync(path.join(dir, "parts.iuml"), "!startsub A\nclass A\n!endsub\n!startsub B\nclass B\n!endsub\n");
  writeFileSync(path.join(dir, "loop.iuml"), "!startsub L\n!includesub loop.iuml!L\n!endsub\n");
  const paths = () => [dir];
  const out = withIncludes(
    [
      "@startuml",
      "!include style.iuml",
      "!include style.iuml",
      "!includesub parts.iuml!B",
      "!include <C4/C4_Context>",
      "@enduml",
    ],
    path.join(dir, "main.puml"),
    paths,
  );
  // The included file's own @start/@end would end the diagram early.
  assert.equal(out, "@startuml\nskinparam monochrome true\n\n\nclass B\n!include <C4/C4_Context>\n@enduml");
  assert.throws(() => withIncludes(["!includesub loop.iuml!L"], path.join(dir, "main.puml"), paths), /Include loop/);
});

test("fences are jebbs's names, exact case, first word only", () => {
  for (const info of ["plantuml", "puml", "uml", "{plantuml}", "{uml}", "plantuml width=\"800px\""]) {
    assert.ok(isPlantumlFence(info), info);
  }
  for (const info of ["PlantUML", "plantumlx", "mermaid", ""]) {
    assert.ok(!isPlantumlFence(info), info);
  }
});

test("a repeated name is an error because the exports overwrite each other", () => {
  const all = diagramsOf(["@startuml x", "@enduml", "@startuml x", "@enduml", "@startuml", "@enduml"], true, "f");
  assert.deepEqual(lint(all, false), [{ line: 2, message: "Duplicate diagram name \"x\".", severity: "error" }]);
  assert.deepEqual(lint(all, true).map((one) => one.severity), ["error", "warning"]);
});

test("macro help counts the arguments typed and knows every overload", () => {
  const macros = macrosOf(["!define BOX(a, b) rectangle a", "!define BOX(a) rectangle a", "!define PLAIN x"]);
  assert.deepEqual(macros.map((one) => one.signatures), [[["a"], ["a", "b"]], [[]]]);
  assert.equal(macroDetail(macros[0]), "BOX(a) (+1 overload)");
  assert.deepEqual(macroCallAt("BOX(one, tw", 10), { name: "BOX", available: 2, active: 1 });
  // The definition is not a call to help with.
  assert.equal(macroCallAt("!define BOX(a) x", 12), undefined);
});

test("variables are the diagram's own words, not PlantUML's or the half-typed one", () => {
  const words = new Set(["participant", "as"]);
  assert.deepEqual(variablesOf(["participant Alice as A", "!define X", "Ali"], 2, words), ["Alice", "A"]);
});

test("the jar's word list comes first and the built-in list fills the gaps", () => {
  const generated = parseLanguage(";type\n;29\nactor\nnewthing\n;keyword\n@startuml\n;EOF\n");
  assert.deepEqual(generated.slice(0, 2), [
    { label: "actor", name: "actor", kind: "type" },
    { label: "newthing", name: "newthing", kind: "type" },
  ]);
  const all = languageWords(generated);
  assert.equal(all.filter((one) => one.name === "actor").length, 1);
  assert.ok(all.some((one) => one.name === "skinparam" && one.kind === "keyword"));
});

test("the jar is what poly installed or pinned, never a launcher on PATH", () => {
  assert.equal(jarOf("[poly] downloading\nplantuml: /c/plantuml-1/plantuml\n"), "/c/plantuml-1/plantuml");
  assert.equal(jarOf("plantuml: pinned /w/tools/plantuml.jar\n"), "/w/tools/plantuml.jar");
  // `java -jar` on a shell script fails with a message about zip files, which
  // is a worse answer than saying there is no jar.
  assert.equal(jarOf("plantuml: no managed build for this platform, PATH has /usr/bin/plantuml"), undefined);
  assert.equal(jarOf("plantuml: disabled in poly.toml"), undefined);
});

test("the preview gets every page and its map, links opening outside", () => {
  const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const map = Buffer.from("<map id=\"m\">\n<area shape=\"rect\" href=\"https://x\"/>\n</map>\n");
  const html = previewImages([svg, png, map, Buffer.from("\n")]);
  assert.ok(html.startsWith("<img src=\"data:image/svg+xml;base64,"));
  assert.ok(html.includes("<img src=\"data:image/png;base64,iVBORw0KGgoA\">"));
  assert.ok(html.includes("<area target=\"_blank\" shape=\"rect\" href=\"https://x\"/>"));
  // A page with no links still needs its (empty) map, or page 2 gets page 1's.
  assert.ok(html.endsWith("<map></map>"));
});

test("a server's error names the line in the file, not in the request", () => {
  const all = diagramsOf(["text", "@startuml", "", "A -> ", "@enduml"], false, "f");
  assert.equal(
    serverError("Syntax Error?", 1, "no arrow end", all[0]),
    "Syntax Error? (@ Diagram Line 2, File Line 4)\n\"A -> \"\nno arrow end\n",
  );
});

test("fileExtensions becomes a glob, and a malformed one is refused", () => {
  assert.equal(extensionsGlob(".wsd, .puml"), "{.wsd,.puml}");
  assert.equal(extensionsGlob(""), ".*");
  assert.throws(() => extensionsGlob("wsd"), /Invalid file extension/);
});

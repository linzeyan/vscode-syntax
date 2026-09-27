import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import {
  appearanceOf,
  drawioConfig,
  drawioHtml,
  drawioKind,
  drawioLanguage,
  drawioOnlineHtml,
  exportFormat,
  fromDataUri,
  libraryEntries,
  linkAttributes,
  linkOf,
  passThroughCommand,
  PNG_FILES,
  pngDataUri,
  pretty,
  TEXT_FILES,
  urlParams,
} from "./drawio";

const ROOT = path.join(__dirname, "..", "..");

test("a diagram is written as hediet writes it, labels untouched", () => {
  // Byte for byte what hediet.vscode-drawio saves (tools/drawio-diff), so a
  // team split between the two editors diffs by what changed in the drawing.
  // The escapes stay escapes: `&#xa;` is the line break inside a label, and
  // `&lt;b&gt;` is text the user typed, not markup.
  const cell = "<mxCell id=\"2\" value=\"first&#xa;line &amp; &lt;b&gt;\" vertex=\"1\" parent=\"1\">";
  const xml =
    `<mxfile><diagram id="a"><mxGraphModel><root><mxCell id="0"/>${cell}<mxGeometry as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;
  assert.equal(
    pretty(xml),
    [
      "<mxfile>",
      "    <diagram id=\"a\">",
      "        <mxGraphModel>",
      "            <root>",
      "                <mxCell id=\"0\"/>",
      `                ${cell}`,
      "                    <mxGeometry as=\"geometry\"/>",
      "                </mxCell>",
      "            </root>",
      "        </mxGraphModel>",
      "    </diagram>",
      "</mxfile>",
    ].join("\n"),
  );
});

test("each editor opens exactly the files the manifest gives it", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const selected = (viewType: string) =>
    pkg.contributes.customEditors
      .find((e: { viewType: string }) => e.viewType === viewType)
      .selector.map((s: { filenamePattern: string }) => s.filenamePattern.replace(/^\*/, ""));
  assert.deepEqual(selected("poly.drawio"), TEXT_FILES);
  assert.deepEqual(selected("poly.drawio.png"), PNG_FILES);
});

test("an image is written as the image its name says, the XML as XML", () => {
  // Written as XML, a `.drawio.svg` would still open in the editor and be
  // broken everywhere else it is shown: a README, a pull request.
  assert.equal(exportFormat("docs/Flow.DRAWIO.SVG"), "xmlsvg");
  assert.equal(exportFormat("flow.dio.svg"), "xmlsvg");
  assert.equal(exportFormat("C:\\docs\\flow.drawio.png"), "xmlpng");
  assert.equal(exportFormat("flow.drawio"), undefined);
  assert.equal(exportFormat("drawio.svg"), undefined);
});

test("an exported image reaches the file byte for byte", () => {
  // draw.io encodes the SVG's UTF-8 before base64: a label in any script has
  // to come back as it was typed.
  const svg = "<svg><text>繁體 &amp; \"quoted\"</text></svg>";
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  assert.equal(new TextDecoder().decode(fromDataUri(uri)), svg);
  assert.throws(() => fromDataUri("data:image/svg+xml;utf8,<svg/>"));
  // A PNG goes in as the data URI draw.io reads the diagram out of; an empty
  // file is a new drawing, not a broken image.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual([...fromDataUri(pngDataUri(png))], [...png]);
  assert.equal(pngDataUri(new Uint8Array()), "");
});

test("draw.io leaves saving and closing to VSCode and keeps the file as XML", () => {
  // Exit, or Save and Exit, would leave a dead page in the tab.
  const params = urlParams({ theme: "kennedy", dark: true, highContrast: false, lang: "zh-tw" });
  assert.equal(params.noExitBtn, "1");
  assert.equal(params.dark, "1");
  const config = drawioConfig({});
  assert.ok(config.hideMenuItems.includes("saveAndExit") && config.hideMenuItems.includes("exit"));
  // Ctrl+S in the drawing is VSCode's save, which runs the save participants.
  assert.equal(passThroughCommand("workbench.action.files.save"), "workbench.action.files.save");
  // Compressed, a `.drawio` is one base64 line and every change a whole-file diff.
  assert.equal(drawioConfig({}).compressXml, false);
  assert.equal(drawioConfig({ zoomFactor: 1.5 }).zoomFactor, 1.5);
  assert.deepEqual(drawioConfig({ presetColors: null }).presetColors, []);
});

test("the appearance setting reaches draw.io, following VSCode when automatic", () => {
  assert.deepEqual(appearanceOf("light", "dark"), { dark: false, highContrast: false });
  assert.deepEqual(appearanceOf("high-contrast-light", "dark"), { dark: false, highContrast: true });
  assert.deepEqual(appearanceOf("high-contrast", "light"), { dark: true, highContrast: true });
  // draw.io follows the color scheme itself, and so a theme switch, as hediet
  // leaves it to.
  assert.deepEqual(appearanceOf("automatic", "dark"), { dark: "auto", highContrast: false });
  assert.deepEqual(appearanceOf("automatic", "high-contrast-light"), { dark: "auto", highContrast: true });
  assert.equal(urlParams({ theme: "kennedy", ...appearanceOf("automatic", "light"), lang: "en" }).dark, "auto");
});

test("draw.io speaks VSCode's language wherever it has it", () => {
  // Every code draw.io ships, read off its resources, so that a language it
  // has is never passed over for English.
  const shipped = new Set(
    fs.readdirSync(path.join(ROOT, "dist", "drawio", "resources"))
      .map((file) => /^dia_(.+)\.txt$/.exec(file)?.[1])
      .filter(Boolean),
  );
  const has = (code: string) => shipped.has(code);
  assert.equal(drawioLanguage("zh-tw", has), "zh-tw");
  assert.equal(drawioLanguage("zh-cn", has), "zh");
  assert.equal(drawioLanguage("pt-BR", has), "pt-br");
  assert.equal(drawioLanguage("ja", has), "ja");
  assert.equal(drawioLanguage("en", has), "en");
  assert.equal(drawioLanguage("tlh", has), "en");
});

test("only the icons switched on are passed, as hediet passes them", () => {
  const config = drawioConfig({ showLinkIcons: true, showTooltipIcons: false });
  assert.equal(config.showLinkIcons, true);
  assert.ok(!("showTooltipIcons" in config) && !("showConnectHandle" in config));
});

test("custom libraries reach the sidebar in every form, a broken one costing only itself", () => {
  const shape = { xml: "<mxGraphModel><root><mxCell id=\"0\"/></root></mxGraphModel>", w: 40, h: 40, title: "a & b" };
  // As draw.io saves a library: its shapes uncompressed, and their JSON the
  // element's text, escaped. hediet reads it unescaped and every shape breaks.
  const saved = `<?xml version="1.0"?>\n<mxlibrary>${
    JSON.stringify([shape], null, 2).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }</mxlibrary>`;
  const read = (file: string) => {
    if (file !== "/team/lib.xml") throw new Error(`ENOENT: ${file}`);
    return saved;
  };
  const { entries, problems } = libraryEntries([
    { entryId: "team", libName: "Text", json: JSON.stringify([shape]) },
    { entryId: "web", libName: "Web", url: "https://example.com/lib.xml" },
    { entryId: "team", libName: "Array", json: [shape] },
    { entryId: "team", libName: "Inline", xml: saved },
    { entryId: "team", libName: "File", file: "/team/lib.xml" },
    { entryId: "team", libName: "Missing", file: "/team/gone.xml" },
    { entryId: "team", libName: "A diagram", xml: "<mxfile/>" },
    { entryId: "team", libName: "An object", json: "{}" },
    { entryId: "team", libName: "Nothing" },
  ], read);
  // One entry per entryId, titled by it, in the order first named: More
  // Shapes turns each on and off as a whole.
  assert.deepEqual(entries.map((entry) => [entry.id, entry.title.main, entry.libs.map((lib) => lib.title.main)]), [
    ["team", "team", ["Text", "Array", "Inline", "File"]],
    ["web", "web", ["Web"]],
  ]);
  for (const lib of entries[0].libs) assert.deepEqual(lib.data, [shape]);
  // draw.io fetches a URL itself, under the page's policy.
  assert.deepEqual(entries[1].libs, [{ title: { main: "Web" }, url: "https://example.com/lib.xml" }]);
  assert.deepEqual(problems.map((problem) => /"([^"]+)"/.exec(problem)?.[1]), [
    "Missing",
    "A diagram",
    "An object",
    "Nothing",
  ]);
  assert.match(problems[0], /ENOENT: \/team\/gone\.xml/);
  assert.deepEqual(drawioConfig({}, entries).libraries, [{ title: { main: "Custom Libraries" }, entries }]);
});

test("a workspace cannot allow its own draw.io plugins", () => {
  // A plugin runs code in the editor. Were the answers readable from a
  // workspace's settings, a repository could ship a plugin already allowed.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const properties = [pkg.contributes.configuration].flat()
    .reduce(
      (all: Record<string, { scope?: string }>, one: { properties: object }) => ({ ...all, ...one.properties }),
      {},
    );
  assert.equal(properties["poly.drawio.knownPlugins"].scope, "application");
  assert.equal(properties["poly.drawio.plugins"].scope, undefined);
});

test("the page runs only the commands the host handed it", () => {
  // The page shows a diagram from anywhere; a message naming any other
  // command, or none, runs nothing.
  assert.equal(passThroughCommand("workbench.action.terminal.sendSequence"), undefined);
  assert.equal(passThroughCommand(null), undefined);
  assert.equal(passThroughCommand(undefined), undefined);
});

test("the page runs under its policy", () => {
  const params = urlParams({ theme: "dark", dark: true, highContrast: true, lang: "en" });
  const html = drawioHtml({
    base: "https://x/dist/drawio",
    bridge: "https://x/dist/drawioPage.js",
    cspSource: "https://x",
    params,
  });
  // The policy allows no inline script: one would be refused, and draw.io
  // never started.
  const scripts = html.match(/<script[^>]*>/g) ?? [];
  assert.equal(scripts.length, 3);
  assert.ok(scripts.every((tag) => / src="/.test(tag)), scripts.join("\n"));
  assert.doesNotMatch(html.match(/script-src [^;]*/)?.[0] ?? "", /unsafe-inline/);
  // draw.io's relative paths -- its resources, images and scripts -- resolve
  // against the base; without the trailing slash they would miss `drawio/`.
  assert.match(html, /<base href="https:\/\/x\/dist\/drawio\/">/);
  const attribute = /data-params="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.deepEqual(JSON.parse(Buffer.from(attribute, "base64").toString("utf8")), params);
  // Set, the page answers draw.io's "resize large images?"; unset, it
  // passes no answer, so that draw.io asks, whatever it answered before.
  assert.match(html, /data-resize-images="null"/);
  const page = { base: "b", bridge: "p.js", cspSource: "c", params };
  assert.match(drawioHtml({ ...page, resizeImages: false }), /data-resize-images="false"/);
  assert.match(drawioHtml({ ...page, resizeImages: null }), /data-resize-images="null"/);
});

test("draw.io from the web starts as the shipped copy does, in a frame of its own", () => {
  const params = urlParams({ theme: "kennedy", dark: false, highContrast: false, lang: "zh-tw" });
  const html = drawioOnlineHtml({
    url: "https://drawio.example.com/app/?stealth=1",
    bridge: "https://x/dist/drawioOnline.js",
    cspSource: "https://x",
    params,
  });
  const src = new URL((/<iframe src="([^"]*)"/.exec(html)?.[1] ?? "").replace(/&amp;/g, "&"));
  // A server of one's own is named with a path and parameters of its own;
  // both are kept, and draw.io's added.
  assert.equal(`${src.origin}${src.pathname}`, "https://drawio.example.com/app/");
  assert.equal(src.searchParams.get("stealth"), "1");
  assert.deepEqual(Object.fromEntries([...src.searchParams].filter(([key]) => key !== "stealth")), params);
  // That server's frames alone, and the extension's scripts alone.
  assert.match(html, /frame-src https:\/\/drawio\.example\.com(;|")/);
  const scripts = html.match(/<script[^>]*>/g) ?? [];
  assert.ok(scripts.length === 1 && / src="https:\/\/x\//.test(scripts[0]), scripts.join("\n"));
  assert.doesNotMatch(html, /unsafe-inline'[^;"]*script|script-src[^;"]*unsafe/);
});

test("a diagram converts under its own name, whichever spelling it had", () => {
  assert.deepEqual(drawioKind("/w/docs/Flow.drawio"), { stem: "/w/docs/Flow", kind: ".drawio" });
  assert.deepEqual(drawioKind("/w/flow.dio.svg"), { stem: "/w/flow", kind: ".drawio.svg" });
  assert.deepEqual(drawioKind("/w/flow.DRAWIO.PNG"), { stem: "/w/flow", kind: ".drawio.png" });
  // A dot in the name is the name's, not a kind.
  assert.deepEqual(drawioKind("/w/v1.2.drawio"), { stem: "/w/v1.2", kind: ".drawio" });
  assert.equal(drawioKind("/w/flow.svg"), undefined);
});

test("a code link is kept in the node as hediet keeps it", () => {
  // Each as hediet.vscode-drawio wrote it (tools/drawio-diff): a diagram
  // linked in one editor follows its links in the other, and a link made in
  // poly writes the same attributes, in the same order, as hediet's would.
  const written = (element: string) =>
    Object.fromEntries(
      [...element.matchAll(/ (hedietLinkedDataV1_[^=]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
    );
  const hediet = {
    code: "<object label=\"plain\" hedietLinkedDataV1_path=\"../code.ts\" hedietLinkedDataV1_start_col_x-num=\"16\" "
      + "hedietLinkedDataV1_start_line_x-num=\"4\" hedietLinkedDataV1_end_col_x-num=\"22\" hedietLinkedDataV1_end_line_x-num=\"4\"/>",
    file: "<object label=\"file\" hedietLinkedDataV1_path=\"../code.ts\"/>",
    symbol: "<object label=\"symbol\" hedietLinkedDataV1_path=\"../code.ts\" hedietLinkedDataV1_symbol=\"MyClass\"/>",
    workspace: "<object label=\"workspace\" hedietLinkedDataV1_symbol=\"helper\"/>",
  };
  const links = {
    code: { path: "../code.ts", start: { col: 16, line: 4 }, end: { col: 22, line: 4 } },
    file: { path: "../code.ts" },
    symbol: { path: "../code.ts", symbol: "MyClass" },
    workspace: { symbol: "helper" },
  };
  for (const [kind, link] of Object.entries(links)) {
    const attributes = written(hediet[kind as keyof typeof hediet]);
    assert.deepEqual(linkAttributes(link), Object.entries(attributes), kind);
    assert.deepEqual(JSON.parse(JSON.stringify(linkOf(attributes))), link, kind);
  }
  // A node that names no code is not a link, whatever else it holds.
  assert.equal(linkOf({ label: "#MyClass", tooltip: "x" }), undefined);
  // A range half written is no range; the file is still followed.
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(linkOf({ "hedietLinkedDataV1_path": "a.ts", "hedietLinkedDataV1_start_col_x-num": "3" })),
    ),
    { path: "a.ts" },
  );
});

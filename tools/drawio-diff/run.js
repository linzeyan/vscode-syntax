#!/usr/bin/env node
// poly's draw.io editor against hediet.vscode-drawio, the extension it
// replaces.
//
// Two extension hosts over two copies of one workspace: one with hediet
// 1.11.260924036 installed from the marketplace, one with poly-lsp. Both load
// draw.io 31.5.2, the same files but for hediet's own `js/extensions.min.js`,
// so what is compared is what the extension around it does. The suite drives draw.io itself over the DevTools protocol
// -- the same edit on both sides -- and records:
//
//   * the text each side puts in the document after the edit, and the bytes
//     it saves;
//   * what the drawing shows after the file's text is edited from VSCode;
//   * how much of a drawing made of library shapes and pictures is drawn --
//     draw.io fetches some of them, and poly ships its files, not hediet's;
//   * what draw.io was started with (its URL parameters, configuration and
//     look) under the default settings and under seven sets of others, and
//     the palettes it drew for the shape libraries they name.
//
// hediet's side is observed from outside only: its manifest, its document,
// and draw.io's state in its page. None of its code is read; it is GPL-3.0
// and poly is not.
//
// Not in `gates`: it downloads hediet's VSIX. Exits 1 on any difference.
//
// Usage: node tools/drawio-diff/run.js
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { crc32, gunzipSync, inflateRawSync, inflateSync } = require("node:zlib");

const { POLY_COMMANDS } = require("./names");

const ROOT = resolve(__dirname, "..", "..");
const LSP = join(ROOT, "extensions", "lsp");
const POLY = process.env.POLY_BIN ?? join(ROOT, "cli", "target", "release", "poly");
const testElectron = require(join(LSP, "node_modules", "@vscode", "test-electron"));

const SCRATCH = join(tmpdir(), "poly-drawio-diff");
const CACHE = join(LSP, ".vscode-test");
const OUT = join(ROOT, ".logs", "audit", "drawio-diff.json");
const HEDIET = "1.11.260924036";
const HEDIET_VSIX = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/hediet/"
  + `vsextensions/vscode-drawio/${HEDIET}/vspackage`;

/** One vertex, written compact, as a hand-made or another tool's file would be. */
const ONE = "<mxfile host=\"x\"><diagram id=\"d1\" name=\"Page-1\"><mxGraphModel dx=\"800\" dy=\"600\" grid=\"1\" "
  + "gridSize=\"10\" guides=\"1\" tooltips=\"1\" connect=\"1\" arrows=\"1\" fold=\"1\" page=\"1\" pageScale=\"1\" "
  + "pageWidth=\"827\" pageHeight=\"1169\" math=\"0\" shadow=\"0\"><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>"
  + "<mxCell id=\"a\" value=\"first&#xa;line &amp; &lt;b&gt;\" style=\"rounded=1;whiteSpace=wrap;html=1;\" "
  + "vertex=\"1\" parent=\"1\"><mxGeometry x=\"40\" y=\"40\" width=\"120\" height=\"60\" as=\"geometry\"/></mxCell>"
  + "</root></mxGraphModel></diagram></mxfile>";

/** Shapes from draw.io's libraries -- AWS, Cisco, basic -- and a picture from its image library. */
const LIBRARIES = "<mxfile><diagram id=\"d2\" name=\"Page-1\"><mxGraphModel><root><mxCell id=\"0\"/>"
  + "<mxCell id=\"1\" parent=\"0\"/>"
  + "<mxCell id=\"aws\" value=\"\" style=\"outlineConnect=0;gradientColor=#F78E04;gradientDirection=north;"
  + "fillColor=#D05C17;strokeColor=#ffffff;html=1;aspect=fixed;shape=mxgraph.aws4.resourceIcon;"
  + "resIcon=mxgraph.aws4.lambda;\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"40\" y=\"40\" width=\"78\" height=\"78\" "
  + "as=\"geometry\"/></mxCell>"
  + "<mxCell id=\"cisco\" value=\"\" style=\"shape=mxgraph.cisco.routers.router;html=1;\" vertex=\"1\" parent=\"1\">"
  + "<mxGeometry x=\"160\" y=\"40\" width=\"78\" height=\"53\" as=\"geometry\"/></mxCell>"
  + "<mxCell id=\"star\" value=\"\" style=\"shape=mxgraph.basic.star;html=1;\" vertex=\"1\" parent=\"1\">"
  + "<mxGeometry x=\"280\" y=\"40\" width=\"60\" height=\"60\" as=\"geometry\"/></mxCell>"
  + "<mxCell id=\"azure\" value=\"\" style=\"image;aspect=fixed;html=1;image=img/lib/azure2/compute/Function_Apps.svg;\" "
  + "vertex=\"1\" parent=\"1\"><mxGeometry x=\"380\" y=\"40\" width=\"68\" height=\"60\" as=\"geometry\"/></mxCell>"
  + "</root></mxGraphModel></diagram></mxfile>";

/** The diagram inside an SVG, as draw.io reads it from the root's `content`. */
const ONE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="161" height="101" content="${
  ONE.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}"><rect x="0.5" y="0.5" width="120" height="60" rx="9" fill="#fff" stroke="#000"/></svg>`;

/** A 1x1 PNG with the diagram in a `tEXt mxfile` chunk, where draw.io reads it from. */
function onePng() {
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const body = Buffer.concat([Buffer.from("tEXt"), Buffer.from(`mxfile\0${encodeURIComponent(ONE)}`, "latin1")]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(body.length - 4, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), body.length + 4);
  const ihdrEnd = 8 + 25;
  return Buffer.concat([pixel.subarray(0, ihdrEnd), chunk, pixel.subarray(ihdrEnd)]);
}

const xmlText = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The shape in the suite's library file. */
const FILE_SHAPE = "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/><mxCell id=\"2\" value=\"\" "
  + "style=\"ellipse;\" vertex=\"1\" parent=\"1\"><mxGeometry width=\"40\" height=\"40\" as=\"geometry\"/></mxCell>"
  + "</root></mxGraphModel>";

function fixtures() {
  return {
    "empty.drawio": "",
    "one.drawio": ONE,
    "one.dio": ONE,
    "libraries.drawio": LIBRARIES,
    "empty.drawio.svg": "",
    "one.drawio.svg": ONE_SVG,
    "one.dio.svg": ONE_SVG,
    "empty.drawio.png": Buffer.alloc(0),
    "one.drawio.png": onePng(),
    // Code for the suite's code links to reach, and a diagram to link it from.
    "code.ts": "export class MyClass {\n  run() {}\n}\n\nexport function helper() {\n  return 1;\n}\n",
    "link.drawio":
      "<mxfile><diagram id=\"d3\" name=\"Page-1\"><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>"
      + ["#MyClass", "plain", "file", "symbol", "workspace"].map((label, i) =>
        `<mxCell id="n${i}" value="${label}" `
        + `style="rounded=1;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="${
          40 + i * 80
        }" width="120" height="60" `
        + "as=\"geometry\"/></mxCell>"
      ).join("")
      + "</root></mxGraphModel></diagram></mxfile>",
    // draw.io fences in markdown: a diagram, the same with the inline
    // editor's attributes, and one that is no diagram.
    "fence.md": `# Fences\n\n\`\`\`drawio\n${ONE}\n\`\`\`\n\n\`\`\`drawio locked height=300\n${ONE}\n\`\`\`\n\n`
      + `\`\`\`drawio\n${LIBRARIES}\n\`\`\`\n\n`
      + "```drawio\nnot a diagram\n```\n",
    // A plugin that counts its runs where the suite reads them.
    "plugin.js": "Draw.loadPlugin(function () { window.__pluginRuns = (window.__pluginRuns || 0) + 1; });\n",
    // As draw.io saves a library: the shapes uncompressed, their JSON the
    // element's text, escaped.
    "lib.xml": `<mxlibrary>${
      xmlText(JSON.stringify([{ xml: FILE_SHAPE, w: 40, h: 40, title: "file circle" }], null, 2))
    }</mxlibrary>`,
  };
}

/** The newest VSCode in the e2e cache, ordered by version rather than name. */
function vscodeExecutable() {
  if (existsSync(CACHE)) {
    const builds = readdirSync(CACHE)
      .map((name) => ({ name, v: /(\d+)\.(\d+)\.(\d+)$/.exec(name) }))
      .filter((b) => b.name.startsWith("vscode-") && b.v)
      .sort((a, b) => a.v[1] - b.v[1] || a.v[2] - b.v[2] || a.v[3] - b.v[3]);
    const build = builds.pop();
    if (build) {
      const macos = join(CACHE, build.name, "Visual Studio Code.app", "Contents", "MacOS");
      if (existsSync(macos)) return join(macos, readdirSync(macos)[0]);
    }
  }
  return testElectron.downloadAndUnzipVSCode({ cachePath: CACHE });
}

async function installHediet(executable, extensionsDir) {
  const vsix = join(SCRATCH, `hediet-${HEDIET}.vsix`);
  if (!existsSync(vsix)) {
    // 50 MB from a gallery that drops long transfers: retried rather than
    // failing the run on the first reset.
    let bytes;
    for (let attempt = 1; !bytes; attempt++) {
      try {
        const response = await fetch(HEDIET_VSIX);
        if (!response.ok) throw new Error(`marketplace answered ${response.status} for hediet's VSIX`);
        bytes = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        if (attempt === 5) throw error;
      }
    }
    // The gallery serves the package gzipped whatever it was asked for.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    writeFileSync(vsix, bytes);
  }
  const [cli, ...args] = testElectron.resolveCliArgsFromVSCodeExecutablePath(executable);
  execFileSync(cli, [...args, "--extensions-dir", extensionsDir, "--install-extension", vsix, "--force"], {
    stdio: "inherit",
  });
}

async function measure(side, executable, port, settings) {
  const dir = join(SCRATCH, `ws-${side}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".vscode"), { recursive: true });
  for (const [file, content] of Object.entries(fixtures())) writeFileSync(join(dir, file), content);
  writeFileSync(join(dir, ".vscode", "settings.json"), JSON.stringify(settings, null, 2));
  // Left on, the gallery replaces hediet with its newest release partway
  // through the run, reloading the page being measured.
  const user = join(SCRATCH, `user-data-${side}`, "User");
  mkdirSync(user, { recursive: true });
  writeFileSync(
    join(user, "settings.json"),
    JSON.stringify({
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "update.mode": "none",
      // Drawn in the workbench, where the suite can read and answer them.
      "window.dialogStyle": "custom",
      "files.simpleDialog.enable": true,
    }),
  );
  const out = join(SCRATCH, `${side}.json`);
  rmSync(out, { force: true });
  await testElectron.runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: [LSP],
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: {
      POLY_DRAWIO_OUT: out,
      POLY_DRAWIO_SIDE: side,
      POLY_DRAWIO_PORT: String(port),
    },
    launchArgs: [
      `--folder-uri=${pathToFileURL(dir).toString()}`,
      `--user-data-dir=${join(SCRATCH, `user-data-${side}`)}`,
      `--extensions-dir=${join(SCRATCH, `ext-${side}`)}`,
      `--remote-debugging-port=${port}`,
      "--disable-workspace-trust",
    ],
  });
  return JSON.parse(readFileSync(out, "utf8"));
}

/**
 * What is the same diagram however it was saved: the `host` attribute each
 * side writes (hediet a value of its own, poly none) and the save's own stamp
 * set aside, the page ids draw.io draws at random for a new diagram, and a
 * page draw.io compressed inflated.
 */
function comparableXml(xml) {
  return xml
    // First, so that what follows reaches into a compressed page as well.
    .replace(/(<diagram[^>]*>)([^<]+)(<\/diagram>)/g, (all, open, body, close) => {
      try {
        return open + decodeURIComponent(inflateRawSync(Buffer.from(body, "base64")).toString("latin1")) + close;
      } catch {
        return all;
      }
    })
    .replace(/ (host|modified|etag)="[^"]*"/g, "")
    // Where the view was scrolled when draw.io wrote it, which follows the window's size.
    .replace(/ d[xy]="[^"]*"/g, "")
    // The id draw.io gives an exported SVG's root, drawn at random.
    .replace(/ge-svg-[\w-]+/g, "ge-svg-(random)")
    .replace(/<diagram id="[^"]*"/g, "<diagram id=\"(random)\"");
}

const unescaped = (text) =>
  text.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#\d+);/gi, (_all, name) => {
    const named = { lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&" }[name.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(
      name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1)),
    );
  });

/** An SVG as its picture and, apart, the diagram in its `content`. */
function comparableSvg(svg) {
  const content = /\scontent="([^"]*)"/.exec(svg)?.[1];
  return {
    picture: comparableXml(svg.replace(/\scontent="[^"]*"/, " content=\"(below)\"")),
    diagram: content === undefined ? undefined : comparableXml(unescaped(content)),
  };
}

/** A PNG as its chunks, its pixels and the diagram in its `mxfile` text chunk. */
function comparablePng(base64) {
  const bytes = Buffer.from(base64, "base64");
  const chunks = [];
  const pixels = createHash("sha256");
  let diagram;
  let size;
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    chunks.push(type);
    if (type === "IHDR") size = `${data.readUInt32BE(0)}x${data.readUInt32BE(4)}`;
    if (type === "IDAT") pixels.update(data);
    if (type === "tEXt" || type === "zTXt") {
      const nul = data.indexOf(0);
      if (data.toString("latin1", 0, nul) === "mxfile") {
        const text = type === "zTXt" ? inflateSync(data.subarray(nul + 2)) : data.subarray(nul + 1);
        diagram = comparableXml(decodeURIComponent(text.toString("latin1")));
      }
    }
    at += 12 + length;
  }
  return { chunks: chunks.join(" "), size, pixels: pixels.digest("hex"), diagram };
}

function comparable(value, key) {
  if (key === "savedPng") return value ? comparablePng(value) : value;
  if (typeof value !== "string") return value;
  return value.trimStart().startsWith("<svg") ? comparableSvg(value) : comparableXml(value);
}

/**
 * Where poly differs from hediet on purpose, by path: a hediet bug, or a
 * message poly words its own way. The difference has to be exactly this one
 * -- a value, or a string a pattern matches -- or it is a problem like any
 * other.
 */
const DEPARTURES = [
  {
    path: /\.revertKeeps$/,
    hediet: true,
    poly: false,
    why: "hediet merges the reverted text into the drawing, which keeps the shape the revert threw away",
  },
  {
    path: /^variants\.libraryFile\.config\.libraries\.0\.entries\.0\.libs\.0\.data\.0\.xml$/,
    hediet: xmlText(FILE_SHAPE),
    poly: FILE_SHAPE,
    why: "hediet reads a library file's JSON without decoding the XML around it, so a shape draw.io saved "
      + "uncompressed reaches draw.io still escaped",
  },
  {
    path: /^variants\.libraryFile\.libraries\.From a file$/,
    hediet: "(no palette)",
    poly: 1,
    why: "the same library: draw.io cannot read the escaped shape, and shows no palette for it",
  },
  {
    path: /^variants\.libraryFile\.drawn$/,
    hediet: 0,
    poly: 2,
    why: "the same library: draw.io's start stops before it loads the file, so the diagram is not drawn at all",
  },
  {
    path: /^variants\.libraryFile\.body$/,
    hediet: "geEditor vscode-dark geEmbed",
    poly: "geEditor vscode-dark geEmbed geCompactMode",
    why: "the same library: draw.io's start stops at it, so the steps after the sidebar -- compact mode "
      + "among them -- never run",
  },
  {
    path: /^plugins\.(first|changed)\.prompt\.message$/,
    hediet: /^Found unknown plugin "\(workspace\)\/plugin\.js" with fingerprint "[0-9a-f]{64}"$/,
    poly: /^Poly: run the draw\.io plugin "\(workspace\)\/plugin\.js" in the draw\.io editor\? /,
    why: "hediet's names the file's URI and hash, and not what Allow does: run the file's code",
  },
  ...[["statusInText|statusOff", "outline", "off: double-clicking a node edits its label"], [
    "toggle\\.status",
    "filled",
    "on: double-clicking a node goes to the code it is linked with",
  ]]
    .map(([step, circle, tooltip]) => ({
      path: new RegExp(`^codeLink\\.(${step})\\.0$`),
      hediet: `link   circle-${circle}  Code Link (left)`,
      poly: `link   circle-${circle}  Code Link, draw.io code links are ${tooltip} (left)`,
      why: "poly's switch says what it does, in a tooltip, which the status bar reads out with it",
    })),
  // Where VSCode's cursor is after each double click, from the end of code.ts.
  ...Object.entries({ Hash: "1:1", Code: "5:23", File: "8:1", Symbol: "1:14", WorkspaceSymbol: "5:1" })
    .flatMap(([step, at]) =>
      [
        [`place`, step === "Hash" ? "code.ts:8:1" : null, `code.ts:${at}`],
        [`editors\\.0`, "code.ts:8:1 in 1", `code.ts:${at} in 1`],
      ].map(([field, hediet, poly]) => ({
        path: new RegExp(`^codeLink\\.doubleClick${step}\\.${field}$`),
        hediet,
        poly,
        why: "hediet 1.11 takes the double click from label editing and goes nowhere; poly goes where hediet's "
          + "README says: to the code the node links to, or to the workspace symbol a `#Name` label names",
      }))
    ),
  ...[
    [/^markdownPreview\.refused$/, true, false],
    [
      /^markdownPreview\.log\.\d+$/,
      /^security: (Loading the script|Connecting to) 'https:\/\/viewer\.diagrams\.net\//,
      undefined,
    ],
    // The AWS, Cisco and star shapes, which hediet draws as empty boxes, of
    // another width.
    [/^markdownPreview\.blocks\.2\.shapes$/, 4, 6],
    [/^markdownPreview\.blocks\.2\.size\.0$/, 410, 409],
  ].map(([path, hediet, poly]) => ({
    path,
    hediet,
    poly,
    why: "hediet's viewer fetches MathJax, and each set of shapes as it is drawn, from draw.io's site, which the "
      + "preview's policy refuses: the preview says content was disabled, and such a shape is an empty box; poly "
      + "loads the web app's own copies, as draw.io's offline editor does",
  })),
  {
    path: /^markdownPreview\.blocks\.3\.text$/,
    hediet: "Diagram render error: Not a diagram file",
    poly: "not a diagram Not a diagram file",
    why: "a fence poly cannot draw keeps its source, with draw.io's message under it, as poly's other diagram "
      + "fences do",
  },
];

/** What of hediet's manifest poly leaves out, by the start of its name, and why. */
const LEFT_OUT = {
  "hediet.vscode-drawio.local-storage": "hediet's copy of draw.io's browser storage, which poly's page leaves where "
    + "draw.io keeps it",
  "hediet.vscode-drawio.editDiagramAsText": "experimental, and off unless hediet's experimental features are on",
  "drawio-inline-editor.": "the inline editor, which needs the experimental Markdown editor of VSCode Insiders",
};

/**
 * What hediet's manifest offers that poly's does not: a setting, under poly's
 * prefix, with hediet's default; a command, by POLY_COMMANDS; a key or menu
 * entry for one -- save what LEFT_OUT names.
 */
function manifestGaps() {
  const extensions = join(SCRATCH, "ext-hediet");
  const dir = readdirSync(extensions).find((name) => name.startsWith("hediet.vscode-drawio-"));
  const hediet = JSON.parse(readFileSync(join(extensions, dir, "package.json"), "utf8")).contributes;
  const poly = JSON.parse(readFileSync(join(LSP, "package.json"), "utf8")).contributes;
  const settings = (manifest) =>
    Object.assign({}, ...[].concat(manifest.configuration).map((one) => one.properties ?? {}));
  const polySettings = settings(poly);
  const leftOut = (name) => Object.keys(LEFT_OUT).some((start) => name.startsWith(start));
  const ours = (command) => POLY_COMMANDS[command.replace(/^hediet\.vscode-drawio\./, "")];
  const gaps = [];
  for (const [key, setting] of Object.entries(settings(hediet)).filter(([key]) => !leftOut(key))) {
    const mine = polySettings[key.replace(/^hediet\.vscode-drawio\./, "poly.drawio.")];
    if (!mine) {
      gaps.push(`manifest: poly has no setting for ${key}`);
    } else if (JSON.stringify(mine.default) !== JSON.stringify(setting.default)) {
      gaps.push(
        `manifest: ${key} defaults to ${JSON.stringify(setting.default)}, poly's to ${JSON.stringify(mine.default)}`,
      );
    }
  }
  const polyCommands = new Set(poly.commands.map((one) => one.command));
  for (const { command } of hediet.commands.filter((one) => !leftOut(one.command))) {
    if (!polyCommands.has(ours(command))) gaps.push(`manifest: poly has no command for ${command}`);
  }
  for (const { command, key, when } of (hediet.keybindings ?? []).filter((one) => !leftOut(one.command))) {
    if (
      !poly.keybindings.some((one) =>
        one.command === ours(command) && one.key.toLowerCase() === key.toLowerCase()
        && one.when === when
      )
    ) {
      gaps.push(`manifest: poly binds no ${key} (when ${when}) to ${command}`);
    }
  }
  for (const [menu, entries] of Object.entries(hediet.menus ?? {})) {
    // A command hediet hides from the palette offers nothing there; poly's e2e
    // holds every command of its own to being in the palette.
    const offered = (one) => !leftOut(one.command) && !(menu === "commandPalette" && one.when === "false");
    for (const { command } of entries.filter(offered)) {
      if (!(poly.menus[menu] ?? []).some((one) => one.command === ours(command))) {
        gaps.push(`manifest: poly's ${menu} has no entry for ${command}`);
      }
    }
  }
  return gaps;
}

/** Field-by-field difference of two plain values, as dotted paths. */
function diff(a, b, path = "", out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diff(a[key], b[key], path ? `${path}.${key}` : key, out);
    }
    return out;
  }
  out.push({ path, a, b });
  return out;
}

/**
 * URL parameters as draw.io reads them: one at draw.io's default is the same
 * as none, and one it does not read is nothing. hediet passes draw.io on the
 * web a set of its own; poly passes one set to both copies.
 */
const DRAWIO_DEFAULTS = { chrome: "1", "svg-warning": "1", "high-contrast": "0" };
// draw.io takes simpleLabels from its configuration alone.
const UNREAD = new Set(["simpleLabels"]);
const asRead = (params) =>
  Object.fromEntries(
    Object.entries(params).filter(([key, value]) => DRAWIO_DEFAULTS[key] !== value && !UNREAD.has(key)),
  );

function normalised(side) {
  const files = {};
  for (const [file, seen] of Object.entries(side.files)) {
    files[file] = Object.fromEntries(Object.entries(seen).map(([key, value]) => [key, comparable(value, key)]));
  }
  const variants = Object.fromEntries(
    Object.entries(side.variants)
      .map(([variant, started]) => [variant, { ...started, urlParams: asRead(started.urlParams) }]),
  );
  // A file a command made, compared as the drawing it holds; and what it
  // asked by the choices it gave, the words around them being each side's own.
  const commands = Object.fromEntries(
    Object.entries(side.commands ?? {}).map(([command, seen]) => [command, {
      ...seen,
      asked: seen.asked?.map(({ placeholder: _placeholder, ...asked }) => ({
        ...asked,
        items: asked.items?.map((item) => item?.label ?? item),
      })),
      created: seen.created && Object.fromEntries(
        Object.entries(seen.created)
          .map(([name, content]) => [name, /\.png$/.test(name) ? comparablePng(content) : comparable(content)]),
      ),
    }]),
  );
  const codeLink = side.codeLink && { ...side.codeLink, text: side.codeLink.text && comparableXml(side.codeLink.text) };
  return { variants, files, plugins: side.plugins, commands, codeLink, markdownPreview: side.markdownPreview };
}

async function main() {
  // A prompt nobody answers holds the suite forever; a normal run takes ten
  // minutes.
  setTimeout(() => {
    console.error("timed out after 30 minutes: the suite is stuck, most likely on a prompt");
    process.exit(1);
  }, 30 * 60_000).unref();
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VSCODE_")) delete process.env[key];
  }
  for (const dir of ["ext-hediet", "ext-poly"]) mkdirSync(join(SCRATCH, dir), { recursive: true });
  mkdirSync(join(ROOT, ".logs", "audit"), { recursive: true });

  execFileSync("pnpm", ["run", "build"], { cwd: LSP, stdio: "inherit" });
  const executable = await vscodeExecutable();
  await installHediet(executable, join(SCRATCH, "ext-hediet"));
  const shared = { "poly.serverPath": POLY, "poly.updateCheck.enabled": false };
  // hediet's side carries poly-lsp too, so both claim the files; the suite
  // opens each with the editor it is measuring.
  const theirs = await measure("hediet", executable, 9561, shared);
  const ours = await measure("poly", executable, 9562, shared);

  // A parameter that throws when read after start (hediet's `svg-warning` is
  // a getter over its page) cannot be observed, so it is compared on neither.
  for (const [variant, started] of Object.entries(theirs.variants)) {
    for (const [key, value] of Object.entries(started.urlParams)) {
      if (String(value).startsWith("(throws:")) {
        delete started.urlParams[key];
        delete ours.variants[variant]?.urlParams[key];
      }
    }
  }
  const departures = [];
  const problems = manifestGaps();
  for (const row of diff(normalised(theirs), normalised(ours))) {
    const line = `${row.path}: hediet ${JSON.stringify(row.a)} poly ${JSON.stringify(row.b)}`;
    const same = (want, got) =>
      want instanceof RegExp ? typeof got === "string" && want.test(got) : JSON.stringify(want) === JSON.stringify(got);
    const departure = DEPARTURES.find((one) =>
      one.path.test(row.path) && same(one.hediet, row.a) && same(one.poly, row.b)
    );
    if (departure) {
      departures.push(`${line} -- ${departure.why}`);
    } else {
      problems.push(line);
    }
  }
  // The page's own complaints, whether or not hediet's has the same: a
  // shared one is still a picture missing from poly's editor. The webview
  // URLs differ by side, so they are compared by path under draw.io's root.
  const where = (line) => line.replace(/\S*\/(dist\/drawio|drawio\/src\/main\/webapp)\//g, "drawio/");
  const theirsSeen = new Set(theirs.violations.map(where));
  for (const violation of ours.violations) {
    problems.push(`poly's page${theirsSeen.has(where(violation)) ? " (hediet's too)" : ""}: ${violation}`);
  }
  writeFileSync(OUT, `${JSON.stringify({ theirs, ours, problems, departures }, null, 2)}\n`);
  for (const departure of departures) console.log(`departs on purpose: ${departure}`);
  if (problems.length === 0) {
    console.log("no differences");
  } else {
    console.log(`${problems.length} differences:`);
    for (const problem of problems.slice(0, 80)) console.log(`  ${problem.slice(0, 600)}`);
  }
  console.log(`full report: ${OUT.replace(`${ROOT}/`, "")}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});

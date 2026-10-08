#!/usr/bin/env node
// poly's Excalidraw editor against pomdtr.excalidraw-editor, the extension it
// replaces.
//
// Two extension hosts over two copies of one workspace: one with pomdtr 3.9.3
// installed from the marketplace, one with poly-lsp. Both pages are the same
// source on the same Excalidraw (0.18.1), so what is compared is what the
// extension around it does:
//
//   * the bytes each side saves for the files the page rewrites on open: an
//     empty `.excalidraw`, and a scene saved under `.excalidraw.svg` and
//     `.excalidraw.png` names -- with the scene each embeds decoded, and its
//     `source` (each extension's own URL) set aside;
//   * that a scene as Excalidraw saves it opens clean, and that Open Image
//     lands on the image preview;
//   * the manifest: settings, the editor's file patterns, its keys, its title
//     bar buttons and the commands behind them.
//
// poly-lsp is loaded on pomdtr's side too, to see which editor VSCode opens
// when both claim the file.
//
// Not in `gates`: it downloads pomdtr's VSIX. Exits 1 on any difference.
//
// Usage: node tools/excalidraw-diff/run.js
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { gunzipSync, inflateSync } = require("node:zlib");
const { settingsOf } = require("../ext-diff/settings");

const ROOT = resolve(__dirname, "..", "..");
const LSP = join(ROOT, "extensions", "lsp");
const POLY = process.env.POLY_BIN ?? join(ROOT, "cli", "target", "release", "poly");
const testElectron = require(join(LSP, "node_modules", "@vscode", "test-electron"));

const SCRATCH = join(tmpdir(), "poly-excalidraw-diff");
const CACHE = join(LSP, ".vscode-test");
const OUT = join(ROOT, ".logs", "audit", "excalidraw-diff.json");
const POMDTR_VSIX = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/pomdtr/"
  + "vsextensions/excalidraw-editor/3.9.3/vspackage";

/** Fields every element carries, fixed so that neither side rolls its own. */
function element(id, index, fields) {
  return {
    id,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index,
    roundness: null,
    seed: 1000 + index.charCodeAt(1),
    version: 1,
    versionNonce: 2000 + index.charCodeAt(1),
    isDeleted: false,
    boundElements: null,
    updated: 1700000000000,
    link: null,
    locked: false,
    ...fields,
  };
}

function text(id, index, x, y, value) {
  return element(id, index, {
    type: "text",
    x,
    y,
    width: 200,
    height: 25,
    text: value,
    originalText: value,
    fontSize: 20,
    fontFamily: 5,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
  });
}

/** A rectangle, an arrow, and text in Excalifont with CJK in it for Xiaolai. */
const SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements: [
    element("rect", "a0", {
      type: "rectangle",
      x: 0,
      y: 0,
      width: 160,
      height: 80,
      backgroundColor: "#a5d8ff",
      fillStyle: "hachure",
      roundness: { type: 3 },
    }),
    element("arrow", "a1", {
      type: "arrow",
      x: 170,
      y: 40,
      width: 120,
      height: 0,
      points: [[0, 0], [120, 0]],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    }),
    text("latin", "a2", 0, 100, "poly draws this"),
    text("cjk", "a3", 0, 140, "繁體中文"),
  ],
  appState: { gridSize: 20, viewBackgroundColor: "#ffffff" },
  files: {},
});

const CLEAN = JSON.stringify(
  { ...JSON.parse(SCENE), elements: JSON.parse(SCENE).elements.slice(0, 1), source: "https://excalidraw.com" },
  null,
  2,
);

function fixtures() {
  return {
    "empty.excalidraw": "",
    // The name says SVG and PNG; the bytes are the scene's JSON. The page
    // reads it, and writes it back in the format the name asks for.
    "scene.excalidraw.svg": SCENE,
    "scene.excalidraw.png": SCENE,
    "clean.excalidraw": CLEAN,
    "both.excalidraw": CLEAN,
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

async function installPomdtr(executable, extensionsDir) {
  const vsix = join(SCRATCH, "pomdtr.vsix");
  if (!existsSync(vsix)) {
    const response = await fetch(POMDTR_VSIX);
    if (!response.ok) throw new Error(`marketplace answered ${response.status} for pomdtr's VSIX`);
    let bytes = Buffer.from(await response.arrayBuffer());
    // The gallery serves the package gzipped whatever it was asked for.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    writeFileSync(vsix, bytes);
  }
  const [cli, ...args] = testElectron.resolveCliArgsFromVSCodeExecutablePath(executable);
  execFileSync(cli, [...args, "--extensions-dir", extensionsDir, "--install-extension", vsix, "--force"], {
    stdio: "inherit",
  });
}

async function measure(side, executable, settings) {
  const dir = join(SCRATCH, `ws-${side}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".vscode"), { recursive: true });
  for (const [file, content] of Object.entries(fixtures())) writeFileSync(join(dir, file), content);
  writeFileSync(join(dir, ".vscode", "settings.json"), JSON.stringify(settings, null, 2));
  const out = join(SCRATCH, `${side}.json`);
  rmSync(out, { force: true });
  await testElectron.runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: [LSP],
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: { POLY_EXCALIDRAW_OUT: out, POLY_EXCALIDRAW_SIDE: side },
    launchArgs: [
      `--folder-uri=${pathToFileURL(dir).toString()}`,
      `--user-data-dir=${join(SCRATCH, `user-data-${side}`)}`,
      `--extensions-dir=${join(SCRATCH, `ext-${side}`)}`,
      "--disable-workspace-trust",
    ],
  });
  return JSON.parse(readFileSync(out, "utf8"));
}

/** Excalidraw's embedded scene: base64 JSON around a deflated byte string. */
function decodeScene(json) {
  const wrapper = JSON.parse(json);
  const bytes = Buffer.from(wrapper.encoded, "latin1");
  const scene = JSON.parse(wrapper.compressed ? inflateSync(bytes).toString("utf8") : bytes.toString("utf8"));
  // Each extension's own URL, the one difference meant to be there.
  scene.source = "(source)";
  return scene;
}

/** What a saved file says, with the scene inside it decoded for comparison. */
function readable(file, base64) {
  const bytes = Buffer.from(base64, "base64");
  if (file.endsWith(".svg")) {
    const svg = bytes.toString("utf8");
    const payload = /<!-- payload-start -->\s*(.+?)\s*<!-- payload-end -->/s.exec(svg);
    return {
      svg: payload ? svg.replace(payload[1], "(scene)") : svg,
      // A byte string, base64-encoded byte for byte: latin1, not UTF-8.
      scene: payload && decodeScene(Buffer.from(payload[1], "base64").toString("latin1")),
    };
  }
  if (file.endsWith(".png")) {
    // Chunk by chunk: the picture's chunks compared as bytes, the tEXt chunk
    // Excalidraw keeps the scene in decoded.
    const chunks = [];
    let scene = null;
    for (let at = 8; at < bytes.length;) {
      const length = bytes.readUInt32BE(at);
      const type = bytes.toString("latin1", at + 4, at + 8);
      const data = bytes.subarray(at + 8, at + 8 + length);
      if (type === "tEXt") {
        const nul = data.indexOf(0);
        scene = decodeScene(data.subarray(nul + 1).toString("latin1"));
        chunks.push(`tEXt ${data.subarray(0, nul).toString("latin1")}`);
      } else {
        chunks.push(`${type} ${createHash("sha256").update(data).digest("hex").slice(0, 16)}`);
      }
      at += 12 + length;
    }
    return { chunks, scene };
  }
  const scene = bytes.length ? JSON.parse(bytes.toString("utf8")) : null;
  if (scene) scene.source = "(source)";
  return { scene };
}

/**
 * pomdtr's manifest against poly's: settings (type, default, and every
 * value pomdtr allows), the file patterns, the keys, the title bar and the
 * commands, with `excalidraw.` read as `poly.excalidraw`.
 */
function manifestProblems(extensions) {
  const dir = readdirSync(extensions).find((one) => one.startsWith("pomdtr.excalidraw-editor-"));
  const theirs = JSON.parse(readFileSync(join(extensions, dir, "package.json"), "utf8")).contributes;
  const ours = JSON.parse(readFileSync(join(LSP, "package.json"), "utf8")).contributes;
  const polySettings = settingsOf(ours);
  const problems = [];
  const show = (value) => JSON.stringify(value);

  const settings = Object.assign({}, ...[theirs.configuration].flat().map((one) => one.properties));
  // A setting with no default reads as its type's empty value, which VSCode
  // fills in for pomdtr's and poly's one `poly` object has to spell out.
  const EMPTY = { string: "", object: {}, array: [], boolean: false, number: 0, integer: 0 };
  for (const [key, spec] of Object.entries(settings)) {
    const mine = polySettings[`poly.${key}`];
    if (!mine) {
      problems.push(`setting ${key}: poly has none`);
      continue;
    }
    const read = { ...spec, default: spec.default ?? EMPTY[[spec.type].flat()[0]] ?? null };
    for (const field of ["type", "default"]) {
      if (show(read[field]) !== show(mine[field])) {
        problems.push(`setting ${key} ${field}: pomdtr ${show(read[field])} poly ${show(mine[field])}`);
      }
    }
    // poly offers Excalidraw 0.18.1's whole language menu; pomdtr's is older.
    const missing = (spec.enum ?? []).filter((value) => !(mine.enum ?? []).includes(value));
    if (missing.length) problems.push(`setting ${key}: poly does not allow ${show(missing)}`);
    for (const [sub, subSpec] of Object.entries(spec.properties ?? {})) {
      for (const field of ["type", "default", "enum"]) {
        if (show(subSpec[field]) !== show(mine.properties?.[sub]?.[field])) {
          problems.push(
            `setting ${key}.${sub} ${field}: pomdtr ${show(subSpec[field])} poly ${
              show(mine.properties?.[sub]?.[field])
            }`,
          );
        }
      }
    }
  }

  const editor = (list, viewType) => list.find((one) => one.viewType === viewType);
  const [theirEditor, ourEditor] = [
    editor(theirs.customEditors, "editor.excalidraw"),
    editor(ours.customEditors, "poly.excalidraw"),
  ];
  for (const field of ["selector", "priority"]) {
    if (show(theirEditor[field]) !== show(ourEditor?.[field])) {
      problems.push(`customEditor ${field}: pomdtr ${show(theirEditor[field])} poly ${show(ourEditor?.[field])}`);
    }
  }
  for (const language of theirs.languages) {
    if (!ours.languages.some((one) => one.id === language.id && show(one.extensions) === show(language.extensions))) {
      problems.push(`language ${show(language)}: poly has none`);
    }
  }

  // pomdtr's command ids as poly spells them; its two New File commands are one.
  const command = (id) =>
    `poly.excalidraw${
      { updateTheme: "Theme", newSceneFile: "NewFile" }[id.slice("excalidraw.".length)]
        ?? id.slice("excalidraw.".length).replace(/^./, (c) => c.toUpperCase())
    }`;
  const commands = new Set(ours.commands.map((one) => one.command));
  for (const one of theirs.commands) {
    if (!commands.has(command(one.command))) {
      problems.push(`command ${one.command}: poly has no ${command(one.command)}`);
    }
  }
  // A `when` compared by what it does: the editor it asks about, and which of
  // these names its filename pattern takes.
  const NAMES = ["a.excalidraw", "a.excalidraw.json", "a.excalidraw.svg", "a.excalidraw.png", "a.svg", "a.png"];
  const meaning = (when) => {
    const pattern = /resourceFilename =~ \/(.+)\/$/.exec(when ?? "")?.[1];
    return {
      editor: /activeCustomEditorId ([!=]=)/.exec(when ?? "")?.[1],
      names: pattern ? NAMES.filter((name) => new RegExp(pattern).test(name)) : null,
    };
  };
  for (const one of theirs.keybindings) {
    const match = ours.keybindings.find((mine) =>
      mine.command === command(one.command) && mine.key === one.key && mine.mac === one.mac
      && show(meaning(mine.when)) === show(meaning(one.when))
    );
    if (!match) problems.push(`keybinding ${show(one)}: poly has none alike`);
  }
  for (const [menu, entries] of Object.entries(theirs.menus)) {
    if (menu === "commandPalette") continue;
    for (const one of entries) {
      const match = (ours.menus[menu] ?? []).find((mine) =>
        mine.command === command(one.command) && mine.group === one.group
        && (one.alt === undefined || mine.alt === command(one.alt))
        && show(meaning(mine.when)) === show(meaning(one.when))
      );
      if (!match) problems.push(`menu ${menu} ${show(one)}: poly has none alike`);
    }
  }
  return problems;
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

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VSCODE_")) delete process.env[key];
  }
  for (const dir of ["ext-pomdtr", "ext-poly"]) mkdirSync(join(SCRATCH, dir), { recursive: true });
  mkdirSync(join(ROOT, ".logs", "audit"), { recursive: true });

  execFileSync("pnpm", ["run", "build"], { cwd: LSP, stdio: "inherit" });
  const executable = await vscodeExecutable();
  await installPomdtr(executable, join(SCRATCH, "ext-pomdtr"));
  // Not the defaults, so that the setting is seen to reach the picture.
  const image = { exportScale: 2, exportWithBackground: true, exportWithDarkMode: true };
  const shared = { "poly.serverPath": POLY, "poly.updateCheck.enabled": false };
  const theirs = await measure("pomdtr", executable, { ...shared, "excalidraw.image": image });
  const ours = await measure("poly", executable, { ...shared, "poly.excalidraw.image": image });

  const problems = manifestProblems(join(SCRATCH, "ext-pomdtr"));
  for (const [file, saved] of Object.entries(theirs.saved)) {
    if (!saved.dirty) problems.push(`${file}: pomdtr's page did not rewrite it`);
    const [a, b] = [readable(file, saved.bytes), readable(file, ours.saved[file]?.bytes ?? "")];
    for (const row of diff({ dirty: saved.dirty, ...a }, { dirty: ours.saved[file]?.dirty, ...b })) {
      problems.push(`${file} ${row.path}: pomdtr ${JSON.stringify(row.a)} poly ${JSON.stringify(row.b)}`);
    }
  }
  for (const key of ["cleanStaysClean", "showImage"]) {
    if (JSON.stringify(theirs[key]) !== JSON.stringify(ours[key])) {
      problems.push(`${key}: pomdtr ${JSON.stringify(theirs[key])} poly ${JSON.stringify(ours[key])}`);
    }
  }
  writeFileSync(OUT, `${JSON.stringify({ theirs, ours, problems }, null, 2)}\n`);
  console.log(`\nwith both installed, a plain open picks ${theirs.bothInstalled}`);
  if (problems.length === 0) {
    console.log("no differences");
  } else {
    console.log(`${problems.length} differences:`);
    for (const problem of problems.slice(0, 80)) console.log(`  ${problem.slice(0, 400)}`);
  }
  console.log(`full report: ${OUT.replace(`${ROOT}/`, "")}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});

#!/usr/bin/env node
// poly's Paste Image against mushan.vscode-paste-image 1.0.4, the extension it
// replaces.
//
// Two extension hosts, one after the other, over the same workspace folder,
// recreated in between: one with mushan.vscode-paste-image installed from the
// marketplace, one with poly-lsp. Each pastes a PNG from the clipboard under
// each of its settings, into markdown, plain text and a prompt file, by
// command and by chord, through the file name box, over an existing image,
// and with no image to paste. Compared: the text typed into the editor, the
// files and folders the paste left behind, and what the user was told. Then
// the manifests: settings, command and chord.
//
// Differences that are poly's on purpose are listed in DEPARTURES; one that
// stops differing is reported too, so the list cannot go stale.
//
// Not in `gates`: it downloads upstream's VSIX, and both sides read the
// clipboard with osascript, so macOS only. The clipboard is saved first and
// put back at the end, every type of every item, and left in
// `$TMPDIR/poly-paste-image-diff/clipboard.json` should the run die between.
// Exits 1 on any difference.
//
// Usage: node tools/paste-image-diff/run.js
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { gunzipSync } = require("node:zlib");

const ROOT = resolve(__dirname, "..", "..");
const LSP = join(ROOT, "extensions", "lsp");
const POLY = process.env.POLY_BIN ?? join(ROOT, "cli", "target", "release", "poly");
const testElectron = require(join(LSP, "node_modules", "@vscode", "test-electron"));

const SCRATCH = join(tmpdir(), "poly-paste-image-diff");
const WS = join(SCRATCH, "ws");
const CACHE = join(LSP, ".vscode-test");
const OUT = join(ROOT, ".logs", "audit", "paste-image-diff.json");
const CLIPBOARD = join(SCRATCH, "clipboard.json");
const VSIX = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/mushan/vsextensions/"
  + "vscode-paste-image/1.0.4/vspackage";

const FIXTURES = {
  "docs/guide.md": "# Guide\n\nlogin screen\n\ncafé shot\n\na:b\n\n",
  "notes.txt": "notes\n\n",
  "agent.prompt.md": "---\nmode: agent\n---\n\n",
};

const REWORDED = "poly's messages are its own wording, and name poly's settings";
/** Records one side has and the other has differently, and why. Every one must still differ. */
const DEPARTURES = {
  "manifest.keybinding.key": "Extract Variable keeps ctrl+alt+v; Paste Image moves to ctrl+alt+shift+i",
  "manifest.keybinding.mac": "Extract Variable keeps cmd+alt+v; Paste Image moves to cmd+alt+shift+i",
  "manifest.keybinding.when": "poly's chord does not paste into a read-only editor, and yields to another "
    + "extension that binds it",
  "prompt.text": "poly writes markdown's image syntax in the markdown-like files VSCode gives other ids, "
    + "a prompt file among them; upstream only in `markdown`",
  "untitled.toasts": REWORDED,
  "invalidSelection.toasts": REWORDED,
  "badPath.toasts": REWORDED,
  "exists.asked": REWORDED,
  "noImage.toasts": REWORDED,
};

// What upstream's own scripts read the clipboard with; poly's are the same.
const SAVE = `ObjC.import("AppKit");
function run() {
  const items = $.NSPasteboard.generalPasteboard.pasteboardItems;
  const saved = [];
  for (let i = 0; i < items.count; i++) {
    const item = items.objectAtIndex(i);
    const types = item.types;
    const entry = {};
    for (let j = 0; j < types.count; j++) {
      const type = types.objectAtIndex(j);
      const data = item.dataForType(type);
      if (!data.isNil()) entry[type.js] = data.base64EncodedStringWithOptions(0).js;
    }
    saved.push(entry);
  }
  return JSON.stringify(saved);
}`;
const RESTORE = `ObjC.import("AppKit");
function run(argv) {
  const saved = JSON.parse($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null).js);
  const board = $.NSPasteboard.generalPasteboard;
  board.clearContents;
  const items = $.NSMutableArray.array;
  for (const entry of saved) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const [type, data] of Object.entries(entry)) {
      item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(data, 0), type);
    }
    items.addObject(item);
  }
  if (saved.length) board.writeObjects(items);
  return String(saved.length);
}`;
const jxa = (script, ...args) =>
  execFileSync("osascript", ["-l", "JavaScript", "-e", script, ...args], { encoding: "utf8", maxBuffer: 1 << 30 });

async function download(url, to, tries = 3) {
  if (existsSync(to)) return;
  let bytes;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    // The gallery drops a connection now and then, mid-body.
    if (tries > 1) return download(url, to, tries - 1);
    throw error;
  }
  // The gallery serves the package gzipped whatever it was asked for.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  writeFileSync(to, bytes);
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

async function measure(side, executable, port) {
  rmSync(WS, { recursive: true, force: true });
  mkdirSync(join(WS, ".vscode"), { recursive: true });
  for (const [file, text] of Object.entries(FIXTURES)) {
    mkdirSync(dirname(join(WS, file)), { recursive: true });
    writeFileSync(join(WS, file), text);
  }
  writeFileSync(
    join(WS, ".vscode", "settings.json"),
    JSON.stringify({ "poly.serverPath": POLY, "poly.updateCheck.enabled": false }, null, 2),
  );
  const user = join(SCRATCH, `user-data-${side}`, "User");
  rmSync(user, { recursive: true, force: true });
  mkdirSync(user, { recursive: true });
  writeFileSync(
    join(user, "settings.json"),
    JSON.stringify({
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "update.mode": "none",
      "workbench.startupEditor": "none",
      "workbench.enableExperiments": false,
    }),
  );
  const out = join(SCRATCH, `${side}.json`);
  rmSync(out, { force: true });
  await testElectron.runTests({
    vscodeExecutablePath: executable,
    // upstream's side loads nothing of poly's.
    extensionDevelopmentPath: side === "upstream" ? [join(SCRATCH, "empty")] : [LSP],
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: {
      POLY_PASTE_OUT: out,
      POLY_PASTE_SIDE: side,
      POLY_PASTE_PORT: String(port),
      POLY_PASTE_PNG: join(LSP, "media", "excalidraw", "menu-icon-light.png"),
    },
    launchArgs: [
      `--folder-uri=${pathToFileURL(WS).toString()}`,
      `--user-data-dir=${join(SCRATCH, `user-data-${side}`)}`,
      `--extensions-dir=${join(SCRATCH, `ext-${side}`)}`,
      `--remote-debugging-port=${port}`,
      "--disable-workspace-trust",
    ],
  });
  return JSON.parse(readFileSync(out, "utf8"));
}

/** A manifest's settings, command and chord, in names both sides share. */
function manifestRecord(contributes, prefix, command) {
  const settings = {};
  for (
    const [key, spec] of Object.entries(
      Object.assign({}, ...[contributes.configuration].flat().map((one) => one.properties)),
    )
  ) {
    if (!key.startsWith(prefix)) continue;
    settings[key.slice(prefix.length)] = Object.fromEntries(
      ["type", "default", "enum", "minimum", "maximum", "scope"].map((field) => [field, spec[field] ?? null]),
    );
  }
  const binding = [contributes.keybindings].flat().find((one) => one.command === command) ?? {};
  return {
    settings,
    command: contributes.commands.some((one) => one.command === command),
    keybinding: { key: binding.key ?? null, mac: binding.mac ?? null, when: binding.when ?? null },
  };
}

/** `record`'s leaves, by dotted path. */
function leaves(record, at = "", into = {}) {
  for (const [key, value] of Object.entries(record)) {
    const path = at ? `${at}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) leaves(value, path, into);
    else into[path] = JSON.stringify(value);
  }
  return into;
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VSCODE_")) delete process.env[key];
  }
  mkdirSync(join(SCRATCH, "empty"), { recursive: true });
  // The test runner wants an extension under development; this one does nothing.
  writeFileSync(
    join(SCRATCH, "empty", "package.json"),
    JSON.stringify({ name: "empty", publisher: "poly", version: "0.0.0", engines: { vscode: "*" } }),
  );
  mkdirSync(join(ROOT, ".logs", "audit"), { recursive: true });

  execFileSync("pnpm", ["run", "build"], { cwd: LSP, stdio: "inherit" });
  const executable = await vscodeExecutable();
  const [cli, ...args] = testElectron.resolveCliArgsFromVSCodeExecutablePath(executable);
  const vsix = join(SCRATCH, "vscode-paste-image-1.0.4.vsix");
  await download(VSIX, vsix);
  rmSync(join(SCRATCH, "ext-upstream"), { recursive: true, force: true });
  execFileSync(cli, [...args, "--extensions-dir", join(SCRATCH, "ext-upstream"), "--install-extension", vsix], {
    stdio: "inherit",
  });

  writeFileSync(CLIPBOARD, jxa(SAVE));
  let theirs;
  let ours;
  try {
    theirs = await measure("upstream", executable, 9371);
    ours = await measure("poly", executable, 9372);
  } finally {
    jxa(RESTORE, CLIPBOARD);
    console.log("clipboard put back as it was");
  }

  const dir = readdirSync(join(SCRATCH, "ext-upstream")).find((one) => one.startsWith("mushan.vscode-paste-image-"));
  const upstreamManifest = JSON.parse(readFileSync(join(SCRATCH, "ext-upstream", dir, "package.json"), "utf8"));
  const polyManifest = JSON.parse(readFileSync(join(LSP, "package.json"), "utf8"));
  theirs.seen.manifest = manifestRecord(upstreamManifest.contributes, "pasteImage.", "extension.pasteImage");
  ours.seen.manifest = manifestRecord(polyManifest.contributes, "poly.pasteImage.", "poly.pasteImage");

  const problems = [...theirs.errors, ...ours.errors];
  const [a, b] = [leaves(theirs.seen), leaves(ours.seen)];
  const departed = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (key in DEPARTURES) {
      if (a[key] === b[key]) problems.push(`${key}: listed as a departure, and the same on both sides`);
      else departed.push(`${key}: ${DEPARTURES[key]} (upstream ${a[key]}, poly ${b[key]})`);
    } else if (a[key] !== b[key]) {
      const short = (value) => (value?.length > 160 ? `${value.slice(0, 160)}…` : value);
      problems.push(`${key}: upstream ${short(a[key]) ?? "(none)"} poly ${short(b[key]) ?? "(none)"}`);
    }
  }
  for (const key of Object.keys(DEPARTURES)) {
    if (!(key in a) && !(key in b)) problems.push(`${key}: a departure neither side recorded`);
  }
  writeFileSync(OUT, `${JSON.stringify({ theirs, ours, departed, problems }, null, 2)}\n`);
  console.log(`\n${Object.keys(a).length} records from upstream, ${Object.keys(b).length} from poly`);
  console.log(`${departed.length} departures:`);
  for (const one of departed) console.log(`  ${one}`);
  if (problems.length === 0) {
    console.log("no differences");
  } else {
    console.log(`${problems.length} differences:`);
    for (const problem of problems.slice(0, 80)) console.log(`  ${problem}`);
  }
  console.log(`full report: ${OUT.replace(`${ROOT}/`, "")}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});

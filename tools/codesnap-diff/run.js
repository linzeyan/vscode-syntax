#!/usr/bin/env node
// poly's CodeSnap against adpyke.codesnap 1.3.4, the extension it replaces.
//
// Two extension hosts, one after the other, over the same workspace folder,
// recreated in between so that the paths either side writes are the same: one
// with adpyke.codesnap installed from the marketplace, one with poly-lsp. Both
// windows are drawn at one size (tools/ext-diff/cdp.js), so the page is as
// wide on both and long lines wrap alike. Compared:
//
//   * every picture, byte for byte: saved through VSCode's save dialog, and
//     copied to the clipboard by the shutter and by copying in the page;
//   * what the page shows before the shutter: the code as pasted, the
//     window's frame and title, and the style variables the settings set;
//   * where the save dialog starts, first and after a save;
//   * the settings: type, default and allowed values.
//
// Scenarios cover the defaults, every setting changed, a language's own
// settings block, tab-indented and indented code, and the page following the
// selection. One difference is poly's on purpose, listed in DEPARTURES: after a
// cancelled save, the dialog starts where the last picture went. A departure
// that stops differing is reported too, so the list cannot go stale.
//
// Not in `gates`: it downloads upstream's VSIX, and reads the clipboard with
// osascript, so macOS only. It replaces what is on the clipboard. Exits 1 on
// any difference.
//
// Usage: node tools/codesnap-diff/run.js
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require(
  "node:fs",
);
const { tmpdir } = require("node:os");
const { join, relative, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { gunzipSync } = require("node:zlib");
const { settingsOf } = require("../ext-diff/settings");

const ROOT = resolve(__dirname, "..", "..");
const LSP = join(ROOT, "extensions", "lsp");
const POLY = process.env.POLY_BIN ?? join(ROOT, "cli", "target", "release", "poly");
const testElectron = require(join(LSP, "node_modules", "@vscode", "test-electron"));

const SCRATCH = join(tmpdir(), "poly-codesnap-diff");
const WS = join(SCRATCH, "ws");
const CACHE = join(LSP, ".vscode-test");
const OUT = join(ROOT, ".logs", "audit", "codesnap-diff.json");
const VSIX = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/adpyke/"
  + "vsextensions/codesnap/1.3.4/vspackage";

const FIXTURES = {
  "snap.ts": [
    "export function greet(name: string): string {",
    "  // A comment, and then a line long enough to wrap in a page half the window wide, which is where it opens.",
    "  const message = `Hello, ${name}!`;",
    "",
    "  return message.length > 0 ? message : \"nobody\";",
    "}",
    "",
  ].join("\n"),
  "indented.py": [
    "class Greeter:",
    "    def greet(self, name):",
    "        if name:",
    "            return f\"Hello, {name}!\"",
    "        return None",
    "",
  ].join("\n"),
  "tabs.go": "package main\n\nfunc main() {\n\tfor i := 0; i < 3; i++ {\n\t\tprintln(i)\n\t}\n}\n",
};

/** Records one side has and the other has differently, and why. Every one must still differ. */
const DEPARTURES = {
  "dialog.afterCancel": "after a cancelled save, poly's dialog starts where the last picture went; upstream's starts "
    + "wherever VSCode puts a dialog with no default",
};

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

/** Every file under `dir`, relative to it. */
function files(dir) {
  const found = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(relative(dir, full));
    }
  };
  walk(dir);
  return found.sort();
}

async function measure(side, executable, port) {
  rmSync(WS, { recursive: true, force: true });
  mkdirSync(join(WS, "out"), { recursive: true });
  mkdirSync(join(WS, ".vscode"));
  for (const [file, text] of Object.entries(FIXTURES)) writeFileSync(join(WS, file), text);
  writeFileSync(
    join(WS, ".vscode", "settings.json"),
    JSON.stringify({ "poly.serverPath": POLY, "poly.updateCheck.enabled": false }, null, 2),
  );
  const user = join(SCRATCH, `user-data-${side}`, "User");
  mkdirSync(user, { recursive: true });
  writeFileSync(
    join(user, "settings.json"),
    JSON.stringify({
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "update.mode": "none",
      "workbench.startupEditor": "none",
      // Drawn in the workbench, where the suite can read and answer it.
      "window.dialogStyle": "custom",
      "files.simpleDialog.enable": true,
      // TypeScript's semantic colors arrive a moment after the file opens, and
      // whether a copy lands before or after them would decide the picture.
      "editor.semanticHighlighting.enabled": false,
      // Named, and experiments off: left to VSCode, the first run started one
      // side in its default theme and the other in Abyss.
      "workbench.colorTheme": "Default Dark Modern",
      "workbench.enableExperiments": false,
    }),
  );
  const out = join(SCRATCH, `${side}.json`);
  rmSync(out, { force: true });
  await testElectron.runTests({
    vscodeExecutablePath: executable,
    // upstream's side loads nothing of poly's.
    extensionDevelopmentPath: side === "codesnap" ? [join(SCRATCH, "empty")] : [LSP],
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: { POLY_CODESNAP_OUT: out, POLY_CODESNAP_SIDE: side, POLY_CODESNAP_PORT: String(port) },
    launchArgs: [
      `--folder-uri=${pathToFileURL(WS).toString()}`,
      `--user-data-dir=${join(SCRATCH, `user-data-${side}`)}`,
      `--extensions-dir=${join(SCRATCH, `ext-${side}`)}`,
      `--remote-debugging-port=${port}`,
      "--disable-workspace-trust",
    ],
  });
  const report = JSON.parse(readFileSync(out, "utf8"));
  // Kept for looking at, since the next side reuses the folder.
  const kept = join(SCRATCH, `written-${side}`);
  rmSync(kept, { recursive: true, force: true });
  cpSync(join(WS, "out"), kept, { recursive: true });
  report.files = Object.fromEntries(
    files(join(WS, "out")).map((file) => [
      file,
      createHash("sha256").update(readFileSync(join(WS, "out", file))).digest("hex").slice(0, 16),
    ]),
  );
  return report;
}

/** upstream's settings against poly's: type, default and allowed values. */
function manifestProblems(extensions) {
  const dir = readdirSync(extensions).find((one) => one.startsWith("adpyke.codesnap-"));
  const theirs = JSON.parse(readFileSync(join(extensions, dir, "package.json"), "utf8")).contributes;
  const ours = JSON.parse(readFileSync(join(LSP, "package.json"), "utf8")).contributes;
  const polySettings = settingsOf(ours);
  const problems = [];
  const mine = Object.keys(polySettings).filter((key) => key.startsWith("poly.codeSnap."));
  if (mine.length !== Object.keys(theirs.configuration.properties).length) {
    problems.push(`settings: upstream ${Object.keys(theirs.configuration.properties).length} poly ${mine.length}`);
  }
  for (const [key, spec] of Object.entries(theirs.configuration.properties)) {
    const own = polySettings[key.replace(/^codesnap\./, "poly.codeSnap.")];
    if (!own) {
      problems.push(`setting ${key}: poly has none`);
      continue;
    }
    for (const field of ["type", "default", "enum"]) {
      if (JSON.stringify(spec[field]) !== JSON.stringify(own[field])) {
        problems.push(
          `setting ${key} ${field}: upstream ${JSON.stringify(spec[field])} poly ${JSON.stringify(own[field])}`,
        );
      }
    }
  }
  const count = (all) => all.filter((one) => /^(codesnap\.start|poly\.codeSnap)$/.test(one.command)).length;
  for (
    const [where, a, b] of [
      ["commands", theirs.commands, ours.commands],
      ["editor/context", theirs.menus["editor/context"], ours.menus["editor/context"]],
    ]
  ) {
    if (count(a) !== count(b)) problems.push(`${where}: upstream ${count(a)} poly ${count(b)}`);
  }
  return problems;
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
  for (const dir of ["ext-codesnap", "ext-poly", "empty"]) mkdirSync(join(SCRATCH, dir), { recursive: true });
  // The test runner wants an extension under development; this one does nothing.
  writeFileSync(
    join(SCRATCH, "empty", "package.json"),
    JSON.stringify({ name: "empty", publisher: "poly", version: "0.0.0", engines: { vscode: "*" } }),
  );
  mkdirSync(join(ROOT, ".logs", "audit"), { recursive: true });

  execFileSync("pnpm", ["run", "build"], { cwd: LSP, stdio: "inherit" });
  const executable = await vscodeExecutable();
  const vsix = join(SCRATCH, "codesnap-1.3.4.vsix");
  await download(VSIX, vsix);
  const [cli, ...args] = testElectron.resolveCliArgsFromVSCodeExecutablePath(executable);
  execFileSync(cli, [
    ...args,
    "--extensions-dir",
    join(SCRATCH, "ext-codesnap"),
    "--install-extension",
    vsix,
    "--force",
  ], {
    stdio: "inherit",
  });

  const theirs = await measure("codesnap", executable, 9341);
  const ours = await measure("poly", executable, 9342);

  const problems = [...manifestProblems(join(SCRATCH, "ext-codesnap")), ...theirs.errors, ...ours.errors];
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
  for (const file of [...new Set([...Object.keys(theirs.files), ...Object.keys(ours.files)])].sort()) {
    if (theirs.files[file] !== ours.files[file]) {
      problems.push(`out/${file}: upstream ${theirs.files[file] ?? "(none)"} poly ${ours.files[file] ?? "(none)"}`);
    }
  }
  writeFileSync(OUT, `${JSON.stringify({ theirs, ours, departed, problems }, null, 2)}\n`);
  console.log(
    `\n${Object.keys(theirs.files).length} pictures from upstream, ${Object.keys(ours.files).length} from poly; `
      + `${Object.keys(a).length} other records`,
  );
  console.log(`${departed.length} departures:`);
  for (const one of departed) console.log(`  ${one}`);
  if (problems.length === 0) {
    console.log("no differences");
  } else {
    console.log(`${problems.length} differences:`);
    for (const problem of problems.slice(0, 80)) console.log(`  ${problem}`);
  }
  console.log(`full report: ${OUT.replace(`${ROOT}/`, "")}; pictures: ${SCRATCH}/written-*`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});

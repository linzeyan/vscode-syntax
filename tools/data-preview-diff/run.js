#!/usr/bin/env node
// poly's Data Preview against RandomFractalsInc.vscode-data-preview 2.3.0, the
// extension it replaces.
//
// Two extension hosts, one after the other, over the same workspace folder,
// recreated in between: one with vscode-data-preview installed from the
// marketplace, one with poly-lsp. Each previews a file of every format it
// reads, a remote one through its URL box and over plain HTTP, and files it
// cannot read; then saves, reloads a saved view, opens another file and
// follows the page's links the way the page's toolbar asks the host to.
// Compared: every message the host posted to the page, what the page drew,
// the status bar, what the user was told, and the files written. Then the
// manifests: settings, commands, menus and chords.
//
// Differences that are poly's on purpose are listed in DEPARTURES; one that
// stops differing is reported too, so the list cannot go stale.
//
// Not in `gates`: it downloads upstream's VSIX, and upstream's page loads a
// script from unpkg. Exits 1 on any difference.
//
// Usage: node tools/data-preview-diff/run.js
const { execFileSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { gunzipSync } = require("node:zlib");
const { settingsOf } = require("../ext-diff/settings");

const ROOT = resolve(__dirname, "..", "..");
const LSP = join(ROOT, "extensions", "lsp");
const POLY = process.env.POLY_BIN ?? join(ROOT, "cli", "target", "release", "poly");
const testElectron = require(join(LSP, "node_modules", "@vscode", "test-electron"));
const lib = (name) => require(join(LSP, "node_modules", name));

// Short: the window's IPC socket goes in the user data folder, and macOS caps a
// socket's path at 103 bytes.
const SCRATCH = join(tmpdir(), "poly-dp-diff");
const WS = join(SCRATCH, "ws");
const FIXTURES = join(SCRATCH, "fixtures");
const CACHE = join(LSP, ".vscode-test");
const OUT = join(ROOT, ".logs", "audit", "data-preview-diff.json");
const VSIX = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/RandomFractalsInc/vsextensions/"
  + "vscode-data-preview/2.3.0/vspackage";

/** Records one side has and the other has differently, and why. `*` is one segment of the path. Every one must still differ. */
const BLANK = "VSCode's webview host sends some pages an empty string before any data, and upstream's page loads "
  + "it as an Arrow file: that grid stays blank. poly's page drops a message that is not bytes";
const MENUS = "poly's menus match the extension anchored -- upstream's pattern put Data Preview on `vite.config.ts` "
  + "and `x.mdx` -- and stand down when upstream is installed";
const DEPARTURES = {
  "rows.json.page.rows": BLANK,
  "rows.json.page.columns": BLANK,
  "rows.json.status": `${BLANK}, so upstream never learns its columns`,
  "openFile.opened.page.rows": BLANK,
  "openFile.opened.page.columns": BLANK,
  "server.json.messages.1.data": "poly keeps an object's false, 0 and empty values; upstream dropped them",
  "server.json.page.rows": "poly keeps an object's false, 0 and empty values; upstream dropped them",
  "server.json.status": "poly keeps an object's false, 0 and empty values; upstream dropped them",
  "vite.config.ts.toasts": "poly does not read `vite.config.ts`; upstream's unanchored pattern took it for a .config "
    + "file and read TypeScript as JSON",
  "theme.messages.*.theme": "`light` is Perspective's `material`; upstream asked for a `light.css` there is none of",
  "denseTheme.messages.*.theme": "`dense.light` is Perspective's `material-dense`; upstream asked for a "
    + "`dense.light.css` there is none of",
  "themeChange.changed.messages.*.*": "poly redraws an open preview in a new theme; upstream only a new preview",
  "otherCommand.ran.tabs": "poly's page can open a preview or a file; upstream's ran any command the page named",
  "manifest.settings.charts.plugin.*": "Highcharts is not free for commercial use: poly's charts are d3fc's",
  "manifest.settings.log.level.*": "upstream's log level only changed its own console output",
  "manifest.keybindings.*": "poly binds no chord: upstream's ctrl+shift+r is VSCode's Refactor, and its "
    + "ctrl+shift+d the Run and Debug view on Windows and Linux",
  "manifest.keybindings.*.*": "poly binds no chord",
  "manifest.menus.commandPalette.*": "poly's commands leave the palette when upstream is installed",
  "manifest.menus.commandPalette.*.*": "poly's commands leave the palette when upstream is installed",
  "manifest.menus.*.*.when": MENUS,
};

const TEXT = {
  "rows.json": JSON.stringify(
    [
      { id: 1, name: "tea", origin: { country: "TW", organic: true } },
      { id: 2, name: "coffee", origin: { country: "ET", organic: false } },
    ],
    null,
    2,
  ),
  "server.json":
    "{\n  // settings, not rows\n  \"server\": { \"host\": \"a\", \"tls\": false, \"port\": 0 },\n  \"name\": \"\",\n}\n",
  "broken.json": "{\"a\": }\n",
  "rows.jsonl": "{\"id\": 1, \"name\": \"tea\"}\n{\"id\": 2, \"name\": \"coffee\"}\n",
  "broken.jsonl": "{\"id\": 1}\n{\"id\": \n",
  "rows.json5": "[{id: 1, name: 'tea',}, {id: 2, name: 'coffee'}]\n",
  "rows.hjson": "[\n  {\n    id: 1\n    name: tea\n  }\n]\n",
  "rows.yaml": "- id: 1\n  name: tea\n- id: 2\n  name: coffee\n",
  "rows.csv": "id,name\n1,tea\n2,coffee\n",
  "rows.tsv": "id\tname\n1\ttea\n",
  "tables.md":
    "# Prices\n\n| item | price |\n| ---- | ----: |\n| tea, green | 3 |\n\n# Stock\n\n| item | count |\n|------|-------|\n| tea | 10 |\n\n",
  "app.properties": "a=1\nb=two words\n",
  "app.ini": "; comment\n[server]\nhost=a\nport=80\n",
  "app.env": "# comment\nHOST=a\nPORT=80\n",
  "view.config": "{\"dataFileName\": \"rows.csv\", \"config\": {\"view\": \"grid\"}}\n",
  "vite.config.ts": "export default {};\n",
};

async function fixtures() {
  rmSync(FIXTURES, { recursive: true, force: true });
  mkdirSync(FIXTURES, { recursive: true });
  for (const [name, text] of Object.entries(TEXT)) writeFileSync(join(FIXTURES, name), text);

  const xlsx = lib("xlsx");
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, xlsx.utils.json_to_sheet([{ id: 1, name: "tea" }]), "First");
  xlsx.utils.book_append_sheet(book, xlsx.utils.json_to_sheet([{ id: 2, name: "coffee" }]), "Second");
  writeFileSync(join(FIXTURES, "book.xlsx"), xlsx.write(book, { type: "buffer", bookType: "xlsx" }));

  const { Int32Vector, Table, Utf8Vector } = lib("apache-arrow");
  const table = Table.new({ id: Int32Vector.from([1, 2]), name: Utf8Vector.from(["tea", "coffee"]) });
  writeFileSync(join(FIXTURES, "table.arrow"), table.serialize());

  const avro = lib("avsc");
  await new Promise((done, fail) => {
    const encoder = avro.createFileEncoder(join(FIXTURES, "events.avro"), {
      type: "record",
      name: "Event",
      fields: [{ name: "id", type: "int" }, { name: "name", type: "string" }],
      // A fixed sync marker, so that both sides read the same bytes run to run.
    }, { syncMarker: Buffer.alloc(16, 7) }).on("finish", done).on("error", fail);
    encoder.write({ id: 1, name: "tea" });
    encoder.end();
  });

  const { ParquetSchema, ParquetWriter } = lib("parquets");
  const writer = await ParquetWriter.openFile(
    new ParquetSchema({ id: { type: "INT32" }, name: { type: "UTF8" } }),
    join(FIXTURES, "metrics.parquet"),
  );
  await writer.appendRow({ id: 1, name: "tea" });
  await writer.close();
}

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

async function measure(side, executable, port, remote) {
  rmSync(WS, { recursive: true, force: true });
  cpSync(FIXTURES, WS, { recursive: true });
  mkdirSync(join(WS, ".vscode"), { recursive: true });
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
      // Save and open dialogs as quick inputs the suite can type a path into.
      "files.simpleDialog.enable": true,
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
      POLY_DATA_OUT: out,
      POLY_DATA_SIDE: side,
      POLY_DATA_PORT: String(port),
      POLY_DATA_REMOTE: remote,
      POLY_DATA_LSP: LSP,
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

/** A manifest's settings, commands, menus, chords and restore event, in names both sides share. */
function manifestRecord(manifest, nls, prefix, commands, viewType) {
  const text = (value) => (typeof value === "string" ? value.replace(/^%(.+)%$/, (_, key) => nls[key]) : value);
  const { contributes } = manifest;
  const settings = {};
  for (
    const [key, spec] of Object.entries(settingsOf(contributes))
  ) {
    if (!key.startsWith(prefix)) continue;
    settings[key.slice(prefix.length)] = Object.fromEntries(
      ["type", "default", "enum"].map((field) => [field, spec[field] ?? null]),
    );
  }
  const record = { settings, commands: {}, menus: {}, keybindings: {} };
  for (const [role, id] of Object.entries(commands)) {
    const command = contributes.commands.find((one) => one.command === id);
    record.commands[role] = command ? { title: text(command.title), icon: !!command.icon } : null;
    for (const where of ["explorer/context", "editor/title", "editor/title/context", "commandPalette"]) {
      const item = (contributes.menus[where] ?? []).find((one) => one.command === id);
      record.menus[`${where}.${role}`] = item ? { when: item.when ?? null, group: item.group ?? null } : null;
    }
    const binding = (contributes.keybindings ?? []).find((one) => one.command === id);
    record.keybindings[role] = binding ? { key: binding.key, mac: binding.mac ?? null } : null;
  }
  record.restores = manifest.activationEvents.includes(`onWebviewPanel:${viewType}`);
  return record;
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

const departure = (key) =>
  Object.keys(DEPARTURES).find((one) =>
    new RegExp(
      `^${
        one.split(".").map((part) => (part === "*" ? "[^.]+" : part.replace(/[\\^$+?()[\]{}|]/g, "\\$&"))).join("\\.")
      }$`,
    )
      .test(key)
  );

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
  await fixtures();
  const executable = await vscodeExecutable();
  const [cli, ...args] = testElectron.resolveCliArgsFromVSCodeExecutablePath(executable);
  const vsix = join(SCRATCH, "vscode-data-preview-2.3.0.vsix");
  await download(VSIX, vsix);
  rmSync(join(SCRATCH, "ext-upstream"), { recursive: true, force: true });
  execFileSync(cli, [...args, "--extensions-dir", join(SCRATCH, "ext-upstream"), "--install-extension", vsix], {
    stdio: "inherit",
  });

  // The remote files: the fixtures, over plain HTTP, and a 404 for the rest.
  const server = createServer((request, response) => {
    const file = join(FIXTURES, decodeURIComponent(new URL(request.url, "http://x").pathname));
    if (file.startsWith(FIXTURES) && existsSync(file)) response.end(readFileSync(file));
    else response.writeHead(404, "Not Found").end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const remote = `http://127.0.0.1:${server.address().port}`;
  let theirs;
  let ours;
  try {
    theirs = await measure("upstream", executable, 9381, remote);
    ours = await measure("poly", executable, 9382, remote);
  } finally {
    server.close();
  }

  const dir = readdirSync(join(SCRATCH, "ext-upstream")).find((one) =>
    one.startsWith("randomfractalsinc.vscode-data-preview-")
  );
  const upstreamManifest = JSON.parse(readFileSync(join(SCRATCH, "ext-upstream", dir, "package.json"), "utf8"));
  theirs.seen.manifest = manifestRecord(
    upstreamManifest,
    {},
    "data.preview.",
    { preview: "data.preview", side: "data.preview.on.side", remote: "data.preview.remote" },
    "data.preview",
  );
  ours.seen.manifest = manifestRecord(
    JSON.parse(readFileSync(join(LSP, "package.json"), "utf8")),
    JSON.parse(readFileSync(join(LSP, "package.nls.json"), "utf8")),
    "poly.dataPreview.",
    { preview: "poly.dataPreview", side: "poly.dataPreviewOnSide", remote: "poly.dataPreviewRemote" },
    "poly.dataPreview",
  );

  const problems = [...theirs.errors, ...ours.errors];
  const [a, b] = [leaves(theirs.seen), leaves(ours.seen)];
  const departed = [];
  const used = new Set();
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const listed = departure(key);
    if (listed) {
      used.add(listed);
      if (a[key] === b[key]) problems.push(`${key}: listed as a departure (${listed}), and the same on both sides`);
      else departed.push(`${key}: ${DEPARTURES[listed]}`);
    } else if (a[key] !== b[key]) {
      const short = (value) => (value?.length > 200 ? `${value.slice(0, 200)}…` : value);
      problems.push(`${key}: upstream ${short(a[key]) ?? "(none)"} poly ${short(b[key]) ?? "(none)"}`);
    }
  }
  for (const key of Object.keys(DEPARTURES)) {
    if (!used.has(key)) problems.push(`${key}: a departure neither side recorded`);
  }
  writeFileSync(OUT, `${JSON.stringify({ theirs, ours, departed, problems }, null, 2)}\n`);
  console.log(`\n${Object.keys(a).length} records from upstream, ${Object.keys(b).length} from poly`);
  console.log(`${departed.length} departures`);
  if (problems.length === 0) {
    console.log("no differences");
  } else {
    console.log(`${problems.length} differences:`);
    for (const problem of problems.slice(0, 120)) console.log(`  ${problem}`);
  }
  console.log(`full report: ${OUT.replace(`${ROOT}/`, "")}`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});

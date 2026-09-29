#!/usr/bin/env node
// poly's Marp against marp-team.marp-vscode 3.6.1, the extension it replaces.
//
// Three extension hosts, one after the other, over the same workspace folder,
// recreated in between: one with marp-vscode installed from the marketplace,
// one with poly-lsp, and one with both. Compared, between the first two:
//
//   * the preview's HTML, and the slides as the preview drew them;
//   * what the directive checks report, and the fixes they offer;
//   * hovers, completions, the outline, and the marking of directive keys;
//   * the new-file, toggle, quick-pick and export commands, and the chat tool;
//   * every export format, as far as a file can be read without a parser;
//   * the settings, custom themes included, by what they change;
//   * the manifest: settings, commands, menus, color, icon and chat tool.
//
// The third host is compared with the first, record for record and with no
// departures: installed alongside marp-vscode, poly has to stand down so
// completely that nothing is doubled -- no second diagnostic, hover or
// completion, and no second preview script defining the same elements.
//
// Differences that are poly's on purpose are listed in DEPARTURES; one that
// stops differing is reported too, so the list cannot go stale.
//
// Not in `gates`: it downloads marp-vscode from the marketplace, and exports
// through whatever Chrome is installed. Exits 1 on any difference.
//
// Usage: node tools/marp-diff/run.js
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

const SCRATCH = join(tmpdir(), "poly-marp-diff");
const WS = join(SCRATCH, "ws");
const CACHE = join(LSP, ".vscode-test");
const OUT = join(ROOT, ".logs", "audit", "marp-diff.json");
const VSIX = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/marp-team/vsextensions/"
  + "marp-vscode/3.6.1/vspackage";

const DECK = `---
marp: true
theme: gaia
paginate: true
header: Header text
footer: Footer text
math: katex
---

# Title slide

- one
- two

<!-- A presenter note -->

---

<!-- _class: lead -->

## Code

\`\`\`js
const a = 1
\`\`\`

$$
E = mc^2
$$

---

![bg right](./img.png)

## Image

Line one
line two

* fragment
* list
`;

const FIXTURES = {
  "deck.md": DECK,
  "plain.md": "# Plain\n\n---\n\n# Two\n",
  "notmarp.md": "---\nmarp: false\ntheme: gaia\n---\n\n# Not Marp\n",
  "diag.md": "---\nmarp: true\ntheme: nonexistent\nsize: 5:5\n$theme: gaia\n---\n\n# Diag\n\n![](red)\n\n"
    + "![bg](#fff)\n\nInline $E=mc^2$ math.\n\n<!-- theme: default -->\n",
  "complete.md": "---\nmarp: true\ntheme: \npaginate: \nmath: \nsize: \ntransition: \n\n---\n\n<!--  -->\n\nBody\n",
  "custom.md": "---\nmarp: true\ntheme: custom\nsize: wide\n---\n\n# Custom\n",
  "themes/custom.css": "/* @theme custom */\n/* @size wide 1600px 900px */\n\n"
    + "section { background: #123456; width: 1280px; height: 720px; }\n",
  "overflow.md": `---\nmarp: true\n---\n\n# Overflow\n\n${
    Array.from({ length: 40 }, (_, i) => `- item ${i + 1}`).join("\n")
  }\n`,
  "settings.md": "---\nmarp: true\nmath: katex\n---\n\n# Settings\n\nFirst line\nsecond line\n\n"
    + "<div class=\"raw\">raw <b>html</b></div>\n\n<span style=\"color:red\">span</span>\n\n$x^2$\n",
  "ignored.md": "---\nmarp: true\nmath: katex\n---\n\n$x$\n",
  "toggle.md": "# Toggle\n\nText\n",
  "frontmatter.md": "---\ntitle: Hello\n---\n\n# Front\n",
  "second.md": "---\nmarp: true\n---\n\n# Second\n",
  "img.png": Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
};

/** Records one side has and the other has differently, and why. Every one must still differ. */
const DEPARTURES = {
  quickPick: "poly's commands say Marp in their titles, since they sit among poly's own in the palette",
};

/** The same, between upstream alone and both installed. */
const BOTH_DEPARTURES = {
  "preview.slides.stylesheets": "a preview stylesheet is contributed in the manifest, so poly's stays on the page "
    + "when it stands down; it is upstream's file byte for byte, so the second copy changes nothing",
};

/** Settings upstream keeps only for users of its old releases. */
const DROPPED = ["markdown.marp.enableHtml", "markdown.marp.chromePath"];

/** poly's names for upstream's: what is renamed so that both can be installed at once. */
const renamed = (text) =>
  text.replaceAll("markdown.marp.", "poly.marp.").replaceAll(
    "marp.directiveKeyForeground",
    "poly.marpDirectiveKeyForeground",
  );

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
  for (const [file, content] of Object.entries(FIXTURES)) {
    mkdirSync(dirname(join(WS, file)), { recursive: true });
    writeFileSync(join(WS, file), content);
  }
  // Outside the workspace: a theme path that climbs out of it is refused.
  writeFileSync(join(WS, "..", "outside.css"), "/* @theme outside */\n");
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
      "workbench.colorTheme": "Default Dark Modern",
      "workbench.enableExperiments": false,
      // The save dialog as a quick input, which the suite can type into.
      "files.simpleDialog.enable": true,
    }),
  );
  const out = join(SCRATCH, `${side}.json`);
  rmSync(out, { force: true });
  await testElectron.runTests({
    vscodeExecutablePath: executable,
    // upstream's side loads nothing of poly's.
    extensionDevelopmentPath: side === "theirs" ? [join(SCRATCH, "empty")] : [LSP],
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: { POLY_MARP_OUT: out, POLY_MARP_SIDE: side, POLY_MARP_PORT: String(port) },
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

/** upstream's manifest against poly's, entry by entry. */
function manifestProblems(extensions) {
  const dir = join(extensions, readdirSync(extensions).find((one) => one.startsWith("marp-team.marp-vscode-")));
  const theirs = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).contributes;
  const ours = JSON.parse(readFileSync(join(LSP, "package.json"), "utf8")).contributes;
  const polySettings = Object.assign({}, ...ours.configuration.map((one) => one.properties));
  const problems = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const mine = Object.keys(polySettings).filter((key) => key.startsWith("poly.marp."));
  const kept = Object.keys(theirs.configuration.properties).filter((key) => !DROPPED.includes(key));
  if (mine.length !== kept.length) problems.push(`settings: upstream ${kept.length} poly ${mine.length}`);
  for (const key of DROPPED) {
    if (!theirs.configuration.properties[key]) problems.push(`setting ${key}: upstream no longer has it`);
    if (polySettings[renamed(key)]) problems.push(`setting ${key}: poly has it`);
  }
  for (const key of kept) {
    const spec = theirs.configuration.properties[key];
    const setting = polySettings[renamed(key)];
    if (!setting) {
      problems.push(`setting ${key}: poly has none`);
      continue;
    }
    for (const field of ["type", "default", "enum", "items", "tags", "scope", "minimum", "maximum"]) {
      if (!same(spec[field], setting[field])) {
        problems.push(
          `setting ${key} ${field}: upstream ${JSON.stringify(spec[field])} poly ${JSON.stringify(setting[field])}`,
        );
      }
    }
    // A markdown description renders its links; a plain one prints them.
    for (
      const [plain, markdown] of [["description", "markdownDescription"], [
        "enumDescriptions",
        "markdownEnumDescriptions",
      ]]
    ) {
      const kind = (one) => (one[markdown] ? markdown : one[plain] ? plain : null);
      if (kind(spec) !== kind(setting)) problems.push(`setting ${key}: upstream ${kind(spec)} poly ${kind(setting)}`);
    }
  }
  for (const upstream of theirs.commands) {
    const command = ours.commands.find((one) => one.command === renamed(upstream.command));
    if (!command) problems.push(`command ${upstream.command}: poly has none`);
    else if (!!command.shortTitle !== !!upstream.shortTitle || !!command.icon !== !!upstream.icon) {
      problems.push(`command ${upstream.command}: shortTitle or icon differs`);
    }
  }
  for (const [menu, entries] of Object.entries(theirs.menus)) {
    for (const entry of entries) {
      const found = ours.menus[menu]?.find((one) => one.command === renamed(entry.command));
      const when = found?.when?.replace(/^!poly\.yield\.marp$/, "").replace(/ && !poly\.yield\.marp$/, "") || undefined;
      if (!found || found.group !== entry.group || when !== entry.when) {
        problems.push(`menu ${menu} ${entry.command}: upstream ${JSON.stringify(entry)} poly ${JSON.stringify(found)}`);
      }
    }
  }
  const color = ours.colors.find((one) => one.id === renamed(theirs.colors[0].id));
  if (!same(color?.defaults, theirs.colors[0].defaults)) problems.push(`color: poly ${JSON.stringify(color)}`);
  const [upIcon] = Object.values(theirs.icons);
  const [myIcon] = Object.values(ours.icons ?? {});
  if (myIcon?.default.fontCharacter !== upIcon.default.fontCharacter) problems.push("icon: fontCharacter differs");
  const bytes = (path) => (existsSync(path) ? readFileSync(path).toString("base64") : null);
  if (bytes(join(dir, upIcon.default.fontPath)) !== bytes(join(LSP, myIcon?.default.fontPath ?? "-"))) {
    problems.push("icon: font file differs");
  }
  const [upTool] = theirs.languageModelTools;
  const tool = ours.languageModelTools?.find((one) => one.name === "poly_export_marp");
  for (const field of ["modelDescription", "inputSchema", "tags", "when", "canBeReferencedInPrompt"]) {
    if (!same(upTool[field], tool?.[field])) problems.push(`languageModelTools ${field} differs`);
  }
  if (!ours["markdown.markdownItPlugins"]) problems.push("markdown.markdownItPlugins: poly has none");
  const style = ours["markdown.previewStyles"].find((one) => one.endsWith("/marp-vscode.css"));
  if (!style || bytes(join(LSP, style)) !== bytes(join(dir, theirs["markdown.previewStyles"][0]))) {
    problems.push(`markdown.previewStyles: poly ${style} is not upstream's stylesheet`);
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

/** Where two long values part, with a little of each around it. */
function contrast(a = "(none)", b = "(none)") {
  if (a.length <= 160 && b.length <= 160) return `upstream ${a} poly ${b}`;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const around = (value) => value.slice(Math.max(0, i - 60), i + 100);
  return `part at ${i} of ${a.length}/${b.length}: upstream …${around(a)}… poly …${around(b)}…`;
}

function compare(a, b, departures, label) {
  const problems = [];
  const departed = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (key in departures) {
      if (a[key] === b[key]) problems.push(`${label}${key}: listed as a departure, and the same on both sides`);
      else departed.push(`${key}: ${departures[key]}`);
    } else if (a[key] !== b[key]) {
      problems.push(`${label}${key}: ${contrast(a[key], b[key])}`);
    }
  }
  for (const key of Object.keys(departures)) {
    if (!(key in a) && !(key in b)) problems.push(`${label}${key}: a departure neither side recorded`);
  }
  return { problems, departed };
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
  const vsix = join(SCRATCH, "marp-vscode-3.6.1.vsix");
  await download(VSIX, vsix);
  for (const [side, installs] of [["theirs", [vsix]], ["ours", []], ["both", [vsix]]]) {
    // Fresh each run: a leftover from another version would be the one loaded.
    rmSync(join(SCRATCH, `ext-${side}`), { recursive: true, force: true });
    mkdirSync(join(SCRATCH, `ext-${side}`), { recursive: true });
    for (const one of installs) {
      execFileSync(cli, [...args, "--extensions-dir", join(SCRATCH, `ext-${side}`), "--install-extension", one], {
        stdio: "inherit",
      });
    }
  }

  const theirs = await measure("theirs", executable, 9371);
  const ours = await measure("ours", executable, 9372);
  const both = await measure("both", executable, 9373);

  const upstream = leaves(theirs.seen);
  const mine = compare(
    Object.fromEntries(Object.entries(upstream).map(([key, value]) => [key, renamed(value)])),
    leaves(ours.seen),
    DEPARTURES,
    "",
  );
  const together = compare(upstream, leaves(both.seen), BOTH_DEPARTURES, "both: ");
  const problems = [
    ...manifestProblems(join(SCRATCH, "ext-theirs")),
    ...theirs.errors,
    ...ours.errors,
    ...both.errors,
    ...mine.problems,
    ...together.problems,
  ];
  const departed = [...mine.departed, ...together.departed.map((one) => `both: ${one}`)];
  writeFileSync(OUT, `${JSON.stringify({ theirs, ours, both, departed, problems }, null, 2)}\n`);
  console.log(
    `\n${Object.keys(upstream).length} records from upstream, ${Object.keys(leaves(ours.seen)).length} from poly`,
  );
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

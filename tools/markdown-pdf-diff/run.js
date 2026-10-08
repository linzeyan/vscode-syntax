#!/usr/bin/env node
// poly's markdown export against yzane.markdown-pdf 2.2.0, the extension it
// replaces.
//
// Two extension hosts, one after the other, over the same workspace folder,
// recreated in between so that every file:// path either side writes is the
// same: one with yzane.markdown-pdf installed from the marketplace, one with
// poly-lsp. Both print with this machine's Chrome, load mermaid from the same
// local file and send PlantUML to a server that is never reached, so any
// difference is the extension's. Compared:
//
//   * every file each side writes, byte for byte: HTML, PDF (less its two
//     timestamps), PNG and JPEG. The fixtures are upstream's own integration
//     fixtures at 2.2.0 plus poly's, exported once with the defaults and twice
//     more with every setting that shows in the output changed;
//   * convert-on-save, with a file its exclusion skips;
//   * the settings: type, default and allowed values.
//
// Emoji are poly's one intended difference in what a page shows: upstream
// draws each as a picture, poly as the character. The HTML is compared with
// upstream's pictures put back as characters, and the images of a page with
// emoji on it are listed in DEPARTURES. So are the files upstream names wrong
// when a folder's name has `.md` in it. A departure that stops differing is
// reported too, so the list cannot go stale.
//
// The default PDF header prints the UTC date, so a run that crosses midnight
// UTC between the two sides fails and says so; run it again.
//
// Not in `gates`: it downloads upstream's VSIX and fixtures, and needs Chrome
// installed. Exits 1 on any difference.
//
// Usage: node tools/markdown-pdf-diff/run.js
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require(
  "node:fs",
);
const { tmpdir } = require("node:os");
const { dirname, join, relative, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { gunzipSync } = require("node:zlib");
const { settingsOf } = require("../ext-diff/settings");

const ROOT = resolve(__dirname, "..", "..");
const LSP = join(ROOT, "extensions", "lsp");
const POLY = process.env.POLY_BIN ?? join(ROOT, "cli", "target", "release", "poly");
const testElectron = require(join(LSP, "node_modules", "@vscode", "test-electron"));

const SCRATCH = join(tmpdir(), "poly-markdown-pdf-diff");
const WS = join(SCRATCH, "ws");
const CACHE = join(LSP, ".vscode-test");
const OUT = join(ROOT, ".logs", "audit", "markdown-pdf-diff.json");
const TAG = "2.2.0";
const VSIX = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/yzane/"
  + `vsextensions/markdown-pdf/${TAG}/vspackage`;
const FIXTURES = `https://raw.githubusercontent.com/yzane/vscode-markdown-pdf/${TAG}/test/integration/fixtures`;

/** Upstream's integration fixtures, exported with every format. */
const UPSTREAM = [
  "plantuml",
  "syntax-highlighting",
  "emoji",
  "checkbox",
  "container",
  "include",
  "include-missing",
  "mermaid",
  "plantuml-custom-marker",
  "plantuml-fence",
  "frontmatter-breaks",
  "frontmatter-no-emoji",
  "breaks",
  "image",
  "include-codeblock",
  "math",
  "math-disabled",
  "page-break",
];

/** poly's fixtures, besides upstream's. */
const OWN = {
  "poly/kitchen.md": [
    "---",
    "math:",
    "  katex:",
    "    macros:",
    "      \"\\\\ZZ\": \"\\\\mathbb{Z}\"",
    "---",
    "# Kitchen sink",
    "",
    "One line",
    "and the next.",
    "",
    "<style>h1 { color: rebeccapurple; }</style>",
    "",
    "<script>document.title = 'scripted'</script>",
    "",
    "<iframe src=\"https://example.com\"></iframe>",
    "",
    "- [x] done",
    "- [ ] open",
    "",
    "::: warning",
    "A container.",
    ":::",
    "",
    "Inline $\\RR \\subset \\ZZ$ and a block:",
    "",
    "$$",
    "\\int_0^1 x\\,dx",
    "$$",
    "",
    "```math",
    "E = mc^2",
    "```",
    "",
    "```js",
    "const x = 1; // highlighted",
    "```",
    "",
    "@begin",
    "Alice -> Bob",
    "@end",
    "",
    "```plantuml",
    "A -> B",
    "```",
    "",
    "```mermaid",
    "graph TD; A-->B;",
    "```",
    "",
    ":smile: and :) stay text with emoji off.",
    "",
    "![local](../fixtures/test.png)",
    "",
    ":[part](part.md)",
    "",
    "## A heading twice",
    "",
    "## A heading twice",
    "",
  ].join("\n"),
  "poly/part.md": "Included **part**.\n",
  "poly/extra.css": "body { font-family: serif; }\nh1 { border-bottom: 2px solid teal; }\n",
  "poly/shortcuts.md": "# Shortcuts\n\n:) <3 :+1: :octocat: :u5272: :shipit:\n",
  "poly/nested.md.d/inner.md": "# Inner\n",
  "poly/save-me.md": "# Save me\n",
  "poly/skip-me.md": "# Skip me\n",
};

/**
 * Files one side writes and the other writes differently or not at all, and
 * why. Every one must still differ.
 */
const DEPARTURES = {
  "fixtures/emoji.pdf": "emoji are characters, not upstream's pictures",
  "fixtures/emoji.png": "emoji are characters, not upstream's pictures",
  "fixtures/emoji.jpeg": "emoji are characters, not upstream's pictures",
  "poly/nested.md.d/inner.html": "upstream replaces the first `.md` in the path, the folder's, and cannot write",
  // With an output folder set, the same rename leaves the name `inner.md`, and
  // each format is written over the last under it.
  "poly/nested.md.d/out/inner.md": "upstream names every format `inner.md`",
  "poly/nested.md.d/out/inner.html": "upstream names every format `inner.md`",
  "poly/nested.md.d/out/inner.pdf": "upstream names every format `inner.md`",
  "poly/nested.md.d/out/inner.png": "upstream names every format `inner.md`",
  "poly/nested.md.d/out/inner.jpeg": "upstream names every format `inner.md`",
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
  if (url === VSIX && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
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

/** The same workspace for both sides, under the same path. */
function workspace(prefix, fixtures) {
  rmSync(WS, { recursive: true, force: true });
  cpSync(fixtures, join(WS, "fixtures"), { recursive: true });
  for (const [file, text] of Object.entries(OWN)) {
    mkdirSync(dirname(join(WS, file)), { recursive: true });
    writeFileSync(join(WS, file), text);
  }
  const mermaid = pathToFileURL(join(LSP, "node_modules", "mermaid", "dist", "mermaid.min.js")).toString();
  const settings = {
    "poly.serverPath": POLY,
    "poly.updateCheck.enabled": false,
    // Read once at activation by upstream, so set before it starts.
    [`${prefix}.convertOnSave`]: true,
    [`${prefix}.convertOnSaveExclude`]: ["^skip"],
    [`${prefix}.plantumlServer`]: "http://127.0.0.1:9/plantuml",
    [`${prefix}.mermaidServer`]: mermaid,
  };
  mkdirSync(join(WS, ".vscode"));
  writeFileSync(join(WS, ".vscode", "settings.json"), JSON.stringify(settings, null, 2));
  return new Set(files(WS));
}

async function measure(side, executable, fixtures) {
  const prefix = side === "yzane" ? "markdown-pdf" : "poly.markdownPdf";
  const inputs = workspace(prefix, fixtures);
  const out = join(SCRATCH, `${side}.json`);
  rmSync(out, { force: true });
  await testElectron.runTests({
    vscodeExecutablePath: executable,
    // yzane's side loads nothing of poly's: poly stands down in the menus only,
    // and its exports would write the very files being compared.
    extensionDevelopmentPath: side === "yzane" ? [join(SCRATCH, "empty")] : [LSP],
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: { POLY_MDPDF_OUT: out, POLY_MDPDF_SIDE: side, POLY_MDPDF_UPSTREAM: JSON.stringify(UPSTREAM) },
    launchArgs: [
      `--folder-uri=${pathToFileURL(WS).toString()}`,
      `--user-data-dir=${join(SCRATCH, `user-data-${side}`)}`,
      `--extensions-dir=${join(SCRATCH, `ext-${side}`)}`,
      "--disable-workspace-trust",
    ],
  });
  const report = JSON.parse(readFileSync(out, "utf8"));
  // Kept for looking at, since the next side reuses the folder.
  const kept = join(SCRATCH, `written-${side}`);
  rmSync(kept, { recursive: true, force: true });
  report.files = {};
  for (const file of files(WS)) {
    if (inputs.has(file) || file.startsWith(".vscode")) continue;
    cpSync(join(WS, file), join(kept, file));
    report.files[file] = digest(file, readFileSync(join(WS, file)), side);
  }
  return report;
}

let emojiChars;

/**
 * A file's bytes as compared. A PDF has its creation and modification times
 * blanked. Upstream's HTML has each emoji picture put back as the character
 * poly draws, or as the `:name:` poly leaves when there is none.
 */
function digest(file, bytes, side) {
  let text;
  if (file.endsWith(".pdf")) {
    text = bytes.toString("latin1").replace(/\/(CreationDate|ModDate) \(D:[^)]*\)/g, "/$1 ()");
    bytes = Buffer.from(text, "latin1");
  } else if (file.endsWith(".html") && side === "yzane") {
    text = bytes.toString("utf8").replace(
      /<img class="emoji" alt="([^"]+)" src="data:image\/png;base64,[^"]*" \/>/g,
      (_img, name) => emojiChars[name] ?? `:${name}:`,
    );
    bytes = Buffer.from(text, "utf8");
  }
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** yzane's settings against poly's: type, default and allowed values. */
function manifestProblems(extensions) {
  const dir = readdirSync(extensions).find((one) => one.startsWith("yzane.markdown-pdf-"));
  const theirs = JSON.parse(readFileSync(join(extensions, dir, "package.json"), "utf8")).contributes;
  const ours = JSON.parse(readFileSync(join(LSP, "package.json"), "utf8")).contributes;
  const polySettings = settingsOf(ours);
  const problems = [];
  for (const [key, spec] of Object.entries(theirs.configuration.properties)) {
    const mine = polySettings[`poly.${key.replace(/^markdown-pdf\./, "markdownPdf.")}`];
    if (!mine) {
      problems.push(`setting ${key}: poly has none`);
      continue;
    }
    for (const field of ["type", "default", "enum", "items", "additionalProperties"]) {
      if (JSON.stringify(spec[field]) !== JSON.stringify(mine[field])) {
        problems.push(
          `setting ${key} ${field}: yzane ${JSON.stringify(spec[field])} poly ${JSON.stringify(mine[field])}`,
        );
      }
    }
  }
  const count = (all) => all.filter((one) => /^(extension\.markdown-pdf\.|poly\.markdownExport)/.test(one.command));
  for (const where of ["commands", "editor/context"]) {
    const [a, b] = where === "commands"
      ? [count(theirs.commands), count(ours.commands)]
      : [count(theirs.menus[where]), count(ours.menus[where])];
    if (a.length !== b.length) problems.push(`${where}: yzane ${a.length} poly ${b.length}`);
  }
  return problems;
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VSCODE_")) delete process.env[key];
  }
  for (const dir of ["ext-yzane", "ext-poly", "empty"]) mkdirSync(join(SCRATCH, dir), { recursive: true });
  // The test runner wants an extension under development; this one does nothing.
  writeFileSync(
    join(SCRATCH, "empty", "package.json"),
    JSON.stringify({ name: "empty", publisher: "poly", version: "0.0.0", engines: { vscode: "*" } }),
  );
  mkdirSync(join(ROOT, ".logs", "audit"), { recursive: true });
  const { default: full } = await import(
    pathToFileURL(join(LSP, "node_modules", "markdown-it-emoji", "lib", "data", "full.mjs"))
  );
  emojiChars = full;

  execFileSync("pnpm", ["run", "build"], { cwd: LSP, stdio: "inherit" });
  const executable = await vscodeExecutable();

  // What UPSTREAM's fixtures include and embed, besides themselves.
  const fixtures = join(SCRATCH, `fixtures-${TAG}`);
  mkdirSync(fixtures, { recursive: true });
  for (const file of [...UPSTREAM.map((name) => `${name}.md`), "include-target.md", "test.png"]) {
    await download(`${FIXTURES}/${file}`, join(fixtures, file));
  }

  const vsix = join(SCRATCH, `yzane-${TAG}.vsix`);
  await download(VSIX, vsix);
  const [cli, ...args] = testElectron.resolveCliArgsFromVSCodeExecutablePath(executable);
  execFileSync(cli, [...args, "--extensions-dir", join(SCRATCH, "ext-yzane"), "--install-extension", vsix, "--force"], {
    stdio: "inherit",
  });

  const theirs = await measure("yzane", executable, fixtures);
  const ours = await measure("poly", executable, fixtures);

  const problems = manifestProblems(join(SCRATCH, "ext-yzane"));
  const dates = new Set([...theirs.dates, ...ours.dates]);
  if (dates.size > 1) {
    problems.push(`the run crossed midnight UTC (${[...dates].join(", ")}): every default header differs; run again`);
  }
  if (!theirs.active) problems.push("yzane.markdown-pdf was not active on its side");
  if (ours.active) problems.push("yzane.markdown-pdf leaked into poly's side");
  const departed = [];
  for (const file of [...new Set([...Object.keys(theirs.files), ...Object.keys(ours.files)])].sort()) {
    const [a, b] = [theirs.files[file], ours.files[file]];
    if (file in DEPARTURES) {
      if (a === b) problems.push(`${file}: listed as a departure, and the same on both sides`);
      else departed.push(`${file}: ${DEPARTURES[file]}`);
    } else if (a !== b) {
      problems.push(`${file}: yzane ${a ?? "(none)"} poly ${b ?? "(none)"}`);
    }
  }
  for (const file of Object.keys(DEPARTURES)) {
    if (!(file in theirs.files) && !(file in ours.files)) problems.push(`${file}: a departure neither side wrote`);
  }
  writeFileSync(OUT, `${JSON.stringify({ theirs, ours, departed, problems }, null, 2)}\n`);
  const written = Object.keys(theirs.files);
  const kinds = ["html", "pdf", "png", "jpeg"].map((ext) =>
    `${written.filter((f) => f.endsWith(`.${ext}`)).length} ${ext}`
  );
  console.log(
    `\n${written.length} files from yzane (${kinds.join(", ")}), ${Object.keys(ours.files).length} from poly`,
  );
  console.log(`${departed.length} departures:`);
  for (const one of departed) console.log(`  ${one}`);
  if (problems.length === 0) {
    console.log("no differences");
  } else {
    console.log(`${problems.length} differences:`);
    for (const problem of problems.slice(0, 80)) console.log(`  ${problem}`);
  }
  console.log(`full report: ${OUT.replace(`${ROOT}/`, "")}; files: ${SCRATCH}/written-*`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});

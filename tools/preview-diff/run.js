#!/usr/bin/env node
// poly's markdown preview additions against what they replace.
//
// Two references, one per feature:
//
//   * GitHub styling against bierner.markdown-preview-github-styles itself,
//     installed into one of two extension hosts. Every setting combination it
//     offers is rendered on both sides and compared as computed style, in four
//     themes. The same run checks the two properties only poly has: with the
//     setting off its stylesheets change nothing, and with bierner installed it
//     stands down rather than wrap the page twice.
//   * The diagram fences against MarkNote's render path (reference.js), the
//     same library calls with MarkNote's options, drawn in the same page. What
//     differs is everything poly puts around the call: the fence rule, the
//     escaping, the lazy loader and its nonce, the sanitizer.
//
// Not in `gates`: it downloads bierner's VSIX from the marketplace and reads
// MarkNote's README from a checkout. Exits 1 on any difference.
//
// Usage: node tools/preview-diff/run.js
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { gunzipSync } = require("node:zlib");

const ROOT = resolve(__dirname, "..", "..");
const LSP = join(ROOT, "extensions", "lsp");
const testElectron = require(join(LSP, "node_modules", "@vscode", "test-electron"));
const esbuild = require(join(LSP, "node_modules", "esbuild"));

const SCRATCH = join(tmpdir(), "poly-preview-diff");
const CACHE = join(LSP, ".vscode-test");
const OUT = join(ROOT, ".logs", "audit", "preview-diff.json");
const BIERNER_VSIX = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/bierner/"
  + "vsextensions/markdown-preview-github-styles/2.1.0/vspackage";

const THEMES = ["Default Dark Modern", "Default Light Modern", "Default High Contrast", "Default High Contrast Light"];

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

async function installBierner(executable, extensionsDir) {
  const vsix = join(SCRATCH, "bierner.vsix");
  if (!existsSync(vsix)) {
    const response = await fetch(BIERNER_VSIX);
    if (!response.ok) throw new Error(`marketplace answered ${response.status} for bierner's VSIX`);
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

async function measure(executable, extensionsDir, out) {
  await testElectron.runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: LSP,
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: {
      POLY_PREVIEW_OUT: out,
      POLY_PREVIEW_SCRATCH: SCRATCH,
      POLY_PREVIEW_THEMES: THEMES.join(","),
    },
    launchArgs: [
      `--folder-uri=${pathToFileURL(join(SCRATCH, "workspace")).toString()}`,
      `--user-data-dir=${join(SCRATCH, `user-data-${out.endsWith("bierner.json") ? "b" : "p"}`)}`,
      `--extensions-dir=${extensionsDir}`,
      "--disable-workspace-trust",
    ],
  });
  return JSON.parse(readFileSync(out, "utf8"));
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * A webview page, re-rendered by Chrome from the DOM it posted back.
 *
 * Its stylesheet links point into the webview's own scheme; they are mapped
 * back onto the files they came from. Skipped, and said so, without Chrome.
 */
function screenshot(name, html) {
  if (!existsSync(CHROME)) {
    console.log(`no screenshot of ${name}: ${CHROME} is not installed`);
    return null;
  }
  const local = html
    .replace(
      /https:\/\/file(?:\+|%2B)\.vscode-resource\.vscode-cdn\.net(\/[^"]+)/gi,
      (_, path) => pathToFileURL(decodeURIComponent(path)).href,
    )
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    // Already drawn; run again outside the webview they would only throw.
    .replace(/<script[\s\S]*?<\/script>/g, "")
    // The editor paints a webview's background outside it, so the page itself
    // is transparent; put the editor's colour back under it.
    .replace("</head>", "<style>html { background: var(--vscode-editor-background); }</style></head>");
  const slug = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const page = join(SCRATCH, `${slug}.html`);
  const png = join(ROOT, ".logs", "audit", `preview-${slug}.png`);
  writeFileSync(page, `<!DOCTYPE html>\n${local}`);
  execFileSync(CHROME, [
    "--headless",
    "--disable-gpu",
    `--screenshot=${png}`,
    "--window-size=1000,4000",
    "--allow-file-access-from-files",
    pathToFileURL(page).href,
  ], { stdio: "ignore" });
  return png;
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

function pageProblems(label, page) {
  const problems = [];
  if (!page || page.timedOut) problems.push(`${label}: the page never reported`);
  else if (!page.result) problems.push(`${label}: measured nothing (${page.errors.join(" | ")})`);
  else if (page.errors.length > 0) problems.push(`${label}: page errors: ${page.errors.slice(0, 3).join(" | ")}`);
  return problems;
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VSCODE_")) delete process.env[key];
  }
  for (const dir of ["workspace", "ext-bierner", "ext-poly"]) mkdirSync(join(SCRATCH, dir), { recursive: true });
  mkdirSync(join(ROOT, ".logs", "audit"), { recursive: true });

  execFileSync("pnpm", ["run", "build"], { cwd: LSP, stdio: "inherit" });
  esbuild.buildSync({
    entryPoints: [join(__dirname, "reference.js")],
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile: join(SCRATCH, "reference.js"),
    nodePaths: [join(LSP, "node_modules")],
    external: ["fs", "path"],
    alias: { "@babel/polyfill": join(LSP, "src", "editor", "preview", "diagram", "empty.ts") },
    // Excalidraw's production build, the one poly's own build picks.
    conditions: ["production"],
    logLevel: "error",
  });

  const executable = await vscodeExecutable();
  // POLY_PREVIEW_ONLY=diagrams skips bierner's side and the style pages, for
  // iterating on the diagrams without two extension hosts per run.
  const diagramsOnly = process.env.POLY_PREVIEW_ONLY === "diagrams";
  if (!diagramsOnly) await installBierner(executable, join(SCRATCH, "ext-bierner"));
  const theirs = diagramsOnly
    ? { side: "bierner", wrappers: {}, styles: {} }
    : await measure(executable, join(SCRATCH, "ext-bierner"), join(SCRATCH, "bierner.json"));
  const ours = await measure(executable, join(SCRATCH, "ext-poly"), join(SCRATCH, "poly.json"));

  const problems = [];
  if (theirs.side !== "bierner") problems.push("bierner's extension was not active on the reference side");
  if (ours.side !== "poly") problems.push("bierner's extension leaked into poly's side");

  // One wrapper per render on both sides. On bierner's side poly's setting is
  // on too, so a second wrapper there is poly failing to stand down.
  for (const report of [theirs, ours]) {
    for (const [combo, count] of Object.entries(report.wrappers)) {
      if (count !== 1) problems.push(`${report.side}/${combo}: ${count} wrappers`);
    }
  }

  const seen = new Map();
  for (const theme of diagramsOnly ? [] : THEMES) {
    const a = theirs.styles[theme];
    const b = ours.styles[theme];
    problems.push(...pageProblems(`bierner ${theme}`, a), ...pageProblems(`poly ${theme}`, b));
    if (!a?.result || !b?.result) continue;
    // Four themes that drew under one body class compare equal four times and
    // prove one theme.
    if (seen.has(a.bodyClass)) problems.push(`${theme} and ${seen.get(a.bodyClass)} drew under one theme class`);
    seen.set(a.bodyClass, theme);
    const sections = Object.keys(a.result.sections);
    if (sections.length === 0) problems.push(`${theme}: no sections measured`);
    for (const row of diff(a.result, b.result)) {
      problems.push(`styles ${theme} ${row.path}: bierner ${JSON.stringify(row.a)} poly ${JSON.stringify(row.b)}`);
    }
    const inert = ours.inert[theme];
    problems.push(
      ...pageProblems(`inert ${theme}`, inert?.withPoly),
      ...pageProblems(`plain ${theme}`, inert?.without),
    );
    if (inert?.withPoly?.result && inert?.without?.result) {
      for (const row of diff(inert.without.result, inert.withPoly.result)) {
        problems.push(
          `off ${theme} ${row.path}: plain ${JSON.stringify(row.a)} with poly's css ${JSON.stringify(row.b)}`,
        );
      }
    }
  }

  for (const [name, one] of Object.entries(ours.info)) {
    if (one.claimed !== one.emitted) problems.push(`fence ${name}: claimed ${one.emitted}, should be ${one.claimed}`);
  }

  for (const [theme, page] of Object.entries(ours.diagrams)) {
    const refs = ours.references[theme];
    problems.push(...pageProblems(`diagrams ${theme}`, page), ...pageProblems(`reference ${theme}`, refs));
    if (!page?.result || !refs?.result) continue;
    if (page.xss !== null) problems.push(`diagrams ${theme}: markup in a label ran script`);
    // Not script-src-attr: the markup cases carry an onerror on purpose, and
    // refusing it is the policy doing its job.
    for (const violation of new Set((page.violations ?? []).filter((one) => !one.startsWith("script-src-attr")))) {
      problems.push(`diagrams ${theme}: the policy refused ${violation}, and the preview says content was disabled`);
    }
    if (!page.frames || !refs.frames) {
      problems.push(
        `diagrams ${theme}: the webview got no animation frames (window covered?); markmap cannot draw there, so its rows below say nothing about poly -- rerun with the test window in front`,
      );
    }
    for (const [name, mine] of Object.entries(page.result)) {
      const one = { ...mine, reference: refs.result[name]?.reference };
      if (one.markup > 0) problems.push(`diagram ${name}: ${one.markup} unsanitized elements`);
      if (one.leftAsSource > 0) problems.push(`diagram ${name}: still source after the page settled`);
      // The preview cannot fetch, so Excalidraw names its CDN copy of every
      // font; poly points the ones it ships at its own files.
      if (/esm\.sh[^)]*\/fonts\/(Cascadia|ComicShanns|Excalifont|Lilita|Nunito|Virgil)\//.test(one.poly.markup ?? "")) {
        problems.push(`diagram ${name}: a font poly ships is fetched from esm.sh`);
      }
      const broken = name.endsWith("-broken");
      if (broken) {
        if (!one.poly.failed) problems.push(`diagram ${name}: a broken source drew or vanished`);
        continue;
      }
      if (!one.reference?.svgs) {
        problems.push(`diagram ${name}: the reference drew nothing (${one.reference?.message})`);
      }
      // Geometry is left out: a light card adds padding around poly's drawing,
      // so the box differs by design. Everything inside the SVG must not.
      const { width: _w1, height: _h1, markup: _m1, ...ref } = one.reference ?? {};
      const { width: _w2, height: _h2, markup: _m2, ...drawn } = one.poly;
      for (const row of diff(ref, drawn)) {
        problems.push(
          `diagram ${theme} ${name} ${row.path}: marknote ${JSON.stringify(row.a)} poly ${JSON.stringify(row.b)}`,
        );
      }
    }
  }

  // A picture of each diagram page and one style page, for the eye: nothing
  // above can say whether a light card on a dark preview looks right.
  const shots = [];
  const pages = [
    ...Object.entries(ours.diagrams).map(([theme, page]) => [`diagrams-${theme}`, page]),
    ...Object.entries(ours.styles).slice(0, 2).map(([theme, page]) => [`styles-${theme}`, page]),
  ];
  for (const [name, page] of pages) {
    if (page?.snapshot) shots.push(screenshot(name, page.snapshot));
  }
  for (const report of [theirs, ours]) {
    for (
      const page of [
        ...Object.values(report.styles ?? {}),
        ...Object.values(report.diagrams ?? {}),
        ...Object.values(report.references ?? {}),
      ]
    ) {
      if (page) delete page.snapshot;
    }
    for (const one of Object.values(report.inert ?? {})) {
      delete one.withPoly?.snapshot;
      delete one.without?.snapshot;
    }
  }
  writeFileSync(OUT, `${JSON.stringify({ theirs, ours, problems }, null, 2)}\n`);
  for (const shot of shots.filter(Boolean)) console.log(`screenshot: ${shot.replace(`${ROOT}/`, "")}`);
  const combos = Object.keys(ours.wrappers).length;
  const diagrams = Object.keys(Object.values(ours.diagrams)[0]?.result ?? {}).length;
  console.log(
    `\n${combos} style combinations x ${THEMES.length} themes, ${diagrams} diagrams x ${
      Object.keys(ours.diagrams).length
    } themes`,
  );
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

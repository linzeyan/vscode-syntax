#!/usr/bin/env node
// poly's PlantUML support against jebbs.plantuml, the extension it replaces.
//
// Two extension hosts over two copies of one workspace: one with jebbs 2.18.1
// installed from the marketplace, one with poly-lsp and poly-syntax-highlight.
// Both run the same MIT jar (poly's managed download, which jebbs is pointed
// at) with the same Java, so any difference is the extension's. Compared:
//
//   * exports: every file each side writes -- names, folders, pages, image
//     maps, and bytes -- for Export Document, Export Current and Export
//     Workspace, including a diagram that does not compile;
//   * the outline, the diagnostics, completion and signature help;
//   * the markdown preview's fences with a server set, which is jebbs's only
//     way of drawing them, as HTML.
//
// poly-lsp is loaded on jebbs's side too, so that side also proves poly
// stands down there: one outline entry per diagram, not two.
//
// Not in `gates`: it downloads jebbs's VSIX and needs Java (POLY_JAVA, or
// `java` on PATH). Exits 1 on any difference.
//
// Usage: node tools/plantuml-diff/run.js
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, relative, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { gunzipSync } = require("node:zlib");
const { settingsOf } = require("../ext-diff/settings");

const ROOT = resolve(__dirname, "..", "..");
const LSP = join(ROOT, "extensions", "lsp");
const SYNTAX = join(ROOT, "extensions", "syntax");
const POLY = process.env.POLY_BIN ?? join(ROOT, "cli", "target", "release", "poly");
const testElectron = require(join(LSP, "node_modules", "@vscode", "test-electron"));

const SCRATCH = join(tmpdir(), "poly-plantuml-diff");
const CACHE = join(LSP, ".vscode-test");
const OUT = join(ROOT, ".logs", "audit", "plantuml-diff.json");
const JEBBS_VSIX = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/jebbs/"
  + "vsextensions/plantuml/2.18.1/vspackage";

/** The workspace both sides get, file by file. */
function fixtures(shared) {
  return {
    "diagrams/seq.puml": [
      "@startuml sequence",
      "!define BOX(a) participant a",
      "!define BOX(a, b) participant a as b",
      "actor User",
      "participant \"Web App\" as Web",
      "User -> Web : login [[https://example.com/login]]",
      "Web --> User : ok",
      "BOX(one, two)",
      "",
      "@enduml",
      "",
      "@startuml",
      "Alice -> Bob : hi",
      "@enduml",
      "",
    ].join("\n"),
    "diagrams/multi.puml": [
      "@startuml flow",
      "Alice -> Bob : one",
      "newpage",
      "Bob -> Alice : two",
      "@enduml",
      "",
      "@startuml flow",
      "Bob -> Alice",
      "@enduml",
      "",
      "@startuml",
      "class Unnamed",
      "@enduml",
      "",
    ].join("\n"),
    "diagrams/sub/bare.puml": "Bob -> Alice : bare\n",
    "diagrams/inc.puml": [
      "@startuml included",
      "!include style.iuml",
      "!include common.iuml",
      "HELLO -> Bob",
      "@enduml",
      "",
    ].join("\n"),
    "diagrams/style.iuml": "@startuml\nskinparam monochrome true\n@enduml\n",
    "shared/common.iuml": "!define HELLO Alice\n",
    "diagrams/salt.puml": [
      "@startsalt",
      "{",
      "  Login | \"MyName   \"",
      "  Password | \"****     \"",
      "  [Cancel] | [  OK   ]",
      "}",
      "@endsalt",
      "",
    ].join("\n"),
    "diagrams/broken.puml": "@startuml broken\nfoo bar baz\n@enduml\n",
    "code.java": [
      "/**",
      " * @startuml java-flow",
      " * Alice -> Bob",
      " * @enduml",
      " */",
      "class Code {}",
      "",
    ].join("\n"),
    "notes.md": [
      "# Diagrams",
      "",
      "```plantuml",
      "@startuml",
      "Alice -> Bob",
      "@enduml",
      "```",
      "",
      "```puml",
      "Bob -> Alice",
      "```",
      "",
      "```uml",
      "@startuml",
      "A -> B",
      "newpage",
      "B -> C",
      "@enduml",
      "```",
      "",
      // Absolute: a fence has no document to jebbs, so a relative include
      // resolves against nothing there. poly also searches the markdown
      // file's folder and the include paths; that half is not compared.
      "```{plantuml}",
      "@startuml",
      `!include ${join(shared, "common.iuml")}`,
      "HELLO -> World",
      "@enduml",
      "```",
      "",
      "```plantuml width=\"800px\"",
      "@startditaa",
      "+--+",
      "@endditaa",
      "```",
      "",
      "```PlantUML",
      "not a fence to either",
      "```",
      "",
    ].join("\n"),
  };
}

/** Where to ask for completion and signature help, per file: [line, character]. */
const PROBES = {
  completion: ["diagrams/seq.puml", 8, 0],
  signature: ["diagrams/seq.puml", 7, 10],
};

function javaPath() {
  if (process.env.POLY_JAVA) return process.env.POLY_JAVA;
  const mise = join(process.env.HOME ?? "", ".local", "share", "mise", "installs", "java");
  if (existsSync(mise)) {
    for (const one of readdirSync(mise).sort().reverse()) {
      const java = join(mise, one, "bin", "java");
      if (existsSync(java)) return java;
    }
  }
  return "java";
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

async function installJebbs(executable, extensionsDir) {
  const vsix = join(SCRATCH, "jebbs.vsix");
  if (!existsSync(vsix)) {
    const response = await fetch(JEBBS_VSIX);
    if (!response.ok) throw new Error(`marketplace answered ${response.status} for jebbs's VSIX`);
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

function workspace(side, settings) {
  const dir = join(SCRATCH, `ws-${side}`);
  rmSync(dir, { recursive: true, force: true });
  for (const [file, text] of Object.entries(fixtures(join(dir, "shared")))) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  mkdirSync(join(dir, ".vscode"));
  writeFileSync(join(dir, ".vscode", "settings.json"), JSON.stringify(settings, null, 2));
  return dir;
}

async function measure(side, executable, settings) {
  const dir = workspace(side, settings);
  const out = join(SCRATCH, `${side}.json`);
  rmSync(out, { force: true });
  const logs = join(SCRATCH, `user-data-${side}`, "logs");
  rmSync(logs, { recursive: true, force: true });
  await testElectron.runTests({
    vscodeExecutablePath: executable,
    // jebbs's side loads poly-lsp too, to see it stand down; poly's side adds
    // poly-syntax-highlight, which is where the `plantuml` language id and
    // the snippets come from, as jebbs's own package brings them on its side.
    extensionDevelopmentPath: side === "jebbs" ? [LSP] : [LSP, SYNTAX],
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: {
      POLY_PLANTUML_OUT: out,
      POLY_PLANTUML_SIDE: side,
      POLY_PLANTUML_PROBES: JSON.stringify(PROBES),
    },
    launchArgs: [
      `--folder-uri=${pathToFileURL(dir).toString()}`,
      `--user-data-dir=${join(SCRATCH, `user-data-${side}`)}`,
      `--extensions-dir=${join(SCRATCH, `ext-${side}`)}`,
      "--disable-workspace-trust",
    ],
  });
  const report = JSON.parse(readFileSync(out, "utf8"));
  report.files = tree(dir);
  // The report channel, as the editor logged it: URLs, and the errors the
  // exports showed. Each side's own channel; the other one's stays empty.
  const channel = side === "jebbs" ? "-PlantUML.log" : "-Poly PlantUML.log";
  const found = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(channel) && /^\d+-/.test(name)) found.push(full);
    }
  };
  walk(logs);
  report.channel = found.length === 1 ? readFileSync(found[0], "utf8").split("\n") : `${found.length} logs found`;
  return report;
}

/**
 * Every file an export wrote, by path under the workspace, with its digest.
 * broken.puml's are only named: PlantUML adds a donation banner to its error
 * page on some minutes of the hour (PSystemError reads the clock), so its
 * picture and map change with when each side happened to export.
 */
function tree(dir) {
  const files = {};
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.startsWith("broken.")) files[relative(dir, full)] = "written";
      else files[relative(dir, full)] = createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16);
    }
  };
  for (const root of ["out", "out-ws"]) if (existsSync(join(dir, root))) walk(join(dir, root));
  return files;
}

/**
 * jebbs's settings against poly's: type, default and allowed values.
 */
function manifestProblems(extensions) {
  const dir = readdirSync(extensions).find((one) => one.startsWith("jebbs.plantuml-"));
  const theirs = JSON.parse(readFileSync(join(extensions, dir, "package.json"), "utf8"))
    .contributes.configuration.properties;
  const ours = settingsOf(JSON.parse(readFileSync(join(LSP, "package.json"), "utf8")).contributes);
  // jebbs's misspelling is not carried over, and `jar` is poly.toml's [tools].
  // poly: ignore typos/typo
  const renamed = { exportIncludeFolderHeirarchy: "exportIncludeFolderHierarchy" };
  // jebbs ships "", outside its own enum, and reads it as `|| "Local"`.
  const defaults = { render: "Local" };
  const problems = [];
  for (const [key, spec] of Object.entries(theirs)) {
    const name = key.slice("plantuml.".length);
    if (name === "jar") continue;
    const mine = ours[`poly.plantuml.${renamed[name] ?? name}`];
    if (!mine) {
      problems.push(`setting ${key}: poly has none`);
      continue;
    }
    const expected = { ...spec, default: name in defaults ? defaults[name] : spec.default };
    for (const field of ["type", "default", "enum"]) {
      if (JSON.stringify(expected[field]) !== JSON.stringify(mine[field])) {
        problems.push(
          `setting ${key} ${field}: jebbs ${JSON.stringify(expected[field])} poly ${JSON.stringify(mine[field])}`,
        );
      }
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
  for (const dir of ["ext-jebbs", "ext-poly"]) mkdirSync(join(SCRATCH, dir), { recursive: true });
  mkdirSync(join(ROOT, ".logs", "audit"), { recursive: true });

  execFileSync("pnpm", ["run", "build"], { cwd: LSP, stdio: "inherit" });
  const install = execFileSync(POLY, ["tools", "install", "plantuml"], { cwd: SCRATCH, encoding: "utf8" });
  const jar = /^plantuml: (.+)$/m.exec(install)?.[1];
  if (!jar || !existsSync(jar)) throw new Error(`no jar from poly tools install plantuml:\n${install}`);
  const java = javaPath();
  execFileSync(java, ["-version"], { stdio: "ignore" });

  const executable = await vscodeExecutable();
  await installJebbs(executable, join(SCRATCH, "ext-jebbs"));
  // Everything the fixtures touch, set alike on both sides. Relative include
  // paths on purpose: that is how a project writes them, and both local
  // renderers resolve them against the workspace folder.
  const common = {
    java,
    includepaths: ["shared"],
    diagramsRoot: "diagrams",
    exportFormat: "svg",
    exportMapFile: true,
    exportConcurrency: 2,
    lintDiagramNoName: true,
  };
  const prefixed = (prefix) => Object.fromEntries(Object.entries(common).map(([k, v]) => [`${prefix}.${k}`, v]));
  const shared = { "poly.serverPath": POLY, "poly.updateCheck.enabled": false, "poly.markdownDiagrams.enabled": true };
  const theirs = await measure("jebbs", executable, { ...shared, ...prefixed("plantuml"), "plantuml.jar": jar });
  const ours = await measure("poly", executable, { ...shared, ...prefixed("poly.plantuml") });

  const problems = manifestProblems(join(SCRATCH, "ext-jebbs"));
  if (!theirs.jebbsActive) problems.push("jebbs.plantuml was not active on its side");
  if (ours.jebbsActive) problems.push("jebbs.plantuml leaked into poly's side");
  if (Object.keys(theirs.files).length === 0) problems.push("jebbs exported nothing");
  for (const row of diff(theirs.files, ours.files)) {
    problems.push(`file ${row.path}: jebbs ${row.a ?? "(none)"} poly ${row.b ?? "(none)"}`);
  }
  for (const section of ["symbols", "diagnostics", "completion", "signature", "markdown", "channel"]) {
    for (const row of diff(theirs[section], ours[section])) {
      problems.push(`${section} ${row.path}: jebbs ${JSON.stringify(row.a)} poly ${JSON.stringify(row.b)}`);
    }
  }
  writeFileSync(OUT, `${JSON.stringify({ theirs, ours, problems }, null, 2)}\n`);
  console.log(
    `\n${Object.keys(theirs.files).length} exported files, ${Object.keys(theirs.symbols).length} outlines, `
      + `${theirs.completion.length} completion items`,
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

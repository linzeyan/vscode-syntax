#!/usr/bin/env node
// poly's Swagger preview against arjun.swagger-viewer 3.2.0, the extension it
// replaces.
//
// Two extension hosts, one after the other, over the same workspace folder,
// recreated in between: one with arjun.swagger-viewer installed from the
// marketplace, one with poly-lsp. Both have redhat.vscode-yaml, which is what
// validates a YAML spec. Compared:
//
//   * the page, as Swagger UI drew it and with the spec it was handed, opened
//     by the chord, from the explorer, and from a URL;
//   * the page after an edit, after a file the spec refers to changes on disk,
//     and after the server is stopped from the status bar;
//   * the webview around it: its tab, column, zoom and the port it points at;
//   * the list of specs in the explorer;
//   * what JSON and YAML specs are told is wrong with them;
//   * the manifest: settings, commands, chord, menus, view and validation.
//
// Differences that are poly's on purpose are listed in DEPARTURES; one that
// stops differing is reported too, so the list cannot go stale.
//
// Not in `gates`: it downloads both extensions from the marketplace. Exits 1
// on any difference.
//
// Usage: node tools/swagger-diff/run.js
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

const SCRATCH = join(tmpdir(), "poly-swagger-diff");
const WS = join(SCRATCH, "ws");
const CACHE = join(LSP, ".vscode-test");
const OUT = join(ROOT, ".logs", "audit", "swagger-diff.json");
const GALLERY = "https://marketplace.visualstudio.com/_apis/public/gallery/publishers";
const VSIX = {
  swagger: `${GALLERY}/Arjun/vsextensions/swagger-viewer/3.2.0/vspackage`,
  yaml: `${GALLERY}/redhat/vsextensions/vscode-yaml/1.24.0/vspackage`,
};

const PETSTORE = `openapi: 3.0.3
info:
  title: Petstore
  version: 1.0.0
paths:
  /pets:
    get:
      summary: List pets
      responses:
        '200':
          description: The pets
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Pet'
    post:
      summary: Add a pet
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Pet'
      responses:
        '201':
          description: Added
  /pets/{id}:
    get:
      summary: One pet
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: The pet
components:
  schemas:
    Pet:
      $ref: './pet.yaml'
`;

const FIXTURES = {
  "petstore.yaml": PETSTORE,
  "pet.yaml": "type: object\nrequired: [name]\nproperties:\n  name:\n    type: string\n  tag:\n    type: string\n",
  "swagger.json": JSON.stringify(
    {
      swagger: "2.0",
      info: { title: "Store", version: "2" },
      basePath: "/v2",
      paths: {
        "/orders": { get: { summary: "Orders", responses: { 200: { description: "ok" } } } },
        "/orders/{id}": {
          delete: {
            parameters: [{ name: "id", in: "path", required: true, type: "integer" }],
            responses: { 204: { description: "gone" } },
          },
        },
      },
      definitions: { Order: { type: "object", properties: { id: { type: "integer" } } } },
    },
    null,
    2,
  ),
  "invalid.json": JSON.stringify(
    { swagger: "2.0", info: { title: "Bad", version: 1 }, paths: {}, bogus: true },
    null,
    2,
  ),
  "invalid.yaml": "openapi: 3.0.0\ninfo:\n  title: Bad\npaths: {}\nbogus: true\n",
  "v31.yaml": "openapi: 3.1.0\ninfo:\n  title: Hooks\n  version: '1'\nwebhooks: {}\n",
  "nested/api.yml": "swagger: '2.0'\ninfo:\n  title: Nested\n  version: '1'\npaths: {}\n",
  "notspec.json": "{\"name\": \"not a spec\"}\n",
  "multi.yaml": "openapi: 3.0.0\n---\nopenapi: 3.0.0\n",
  "number.yaml": "openapi: 3.0\ninfo:\n  title: Number\n  version: '1'\npaths: {}\n",
  "node_modules/dep/api.yaml": "openapi: 3.0.0\ninfo:\n  title: Dependency\n  version: '1'\npaths: {}\n",
};

// upstream calls `bundle` on a module namespace (`import * as`), which is no
// constructor, so every call throws "Class is not a constructor" and the spec
// goes out as typed: its README's "$ref with hot reload" never happens.
const BUNDLED = "poly pulls the files a spec refers to into it, as upstream means to; upstream's own call to do so "
  + "always throws, and Swagger UI then fetches `./pet.yaml` from the page's server";

/** Records one side has and the other has differently, and why. Every one must still differ. */
const DEPARTURES = {
  "chord.page.pet": BUNDLED,
  "edit.page.pet": BUNDLED,
  "refChanged.page.pet": BUNDLED,
  "refChanged.changed": "the page follows a change to a file the spec refers to, which needs the files pulled in: "
    + BUNDLED,
  "restart.port": "poly reads defaultPort each time the server starts; upstream reads it once, when it activates",
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
      "workbench.colorTheme": "Default Dark Modern",
      "workbench.enableExperiments": false,
      "redhat.telemetry.enabled": false,
    }),
  );
  const out = join(SCRATCH, `${side}.json`);
  rmSync(out, { force: true });
  await testElectron.runTests({
    vscodeExecutablePath: executable,
    // upstream's side loads nothing of poly's.
    extensionDevelopmentPath: side === "swagger" ? [join(SCRATCH, "empty")] : [LSP],
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: { POLY_SWAGGER_OUT: out, POLY_SWAGGER_SIDE: side, POLY_SWAGGER_PORT: String(port) },
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
  const dir = readdirSync(extensions).find((one) => one.startsWith("arjun.swagger-viewer-"));
  const theirs = JSON.parse(readFileSync(join(extensions, dir, "package.json"), "utf8")).contributes;
  const ours = JSON.parse(readFileSync(join(LSP, "package.json"), "utf8")).contributes;
  const polySettings = Object.assign({}, ...ours.configuration.map((one) => one.properties));
  const problems = [];
  const own = (id) => id.replace(/^swagger\.(\w)/, (_, c) => `poly.swagger${c.toUpperCase()}`);
  const mine = Object.keys(polySettings).filter((key) => key.startsWith("poly.swaggerViewer."));
  if (mine.length !== Object.keys(theirs.configuration.properties).length) {
    problems.push(`settings: upstream ${Object.keys(theirs.configuration.properties).length} poly ${mine.length}`);
  }
  for (const [key, spec] of Object.entries(theirs.configuration.properties)) {
    const setting = polySettings[`poly.${key}`];
    if (!setting) {
      problems.push(`setting ${key}: poly has none`);
      continue;
    }
    for (const field of ["type", "default", "enum", "minimum", "maximum", "scope"]) {
      if (JSON.stringify(spec[field]) !== JSON.stringify(setting[field])) {
        problems.push(
          `setting ${key} ${field}: upstream ${JSON.stringify(spec[field])} poly ${JSON.stringify(setting[field])}`,
        );
      }
    }
  }
  for (const { command } of theirs.commands) {
    if (!ours.commands.some((one) => one.command === own(command))) problems.push(`command ${command}: poly has none`);
  }
  for (const binding of theirs.keybindings) {
    const mineToo = ours.keybindings.find((one) => one.command === own(binding.command));
    if (mineToo?.key !== binding.key) problems.push(`keybinding ${binding.command}: poly ${mineToo?.key}`);
    else if (mineToo.when.replace(/ && !poly\.yield\.\w+$/, "") !== binding.when) {
      problems.push(`keybinding ${binding.command} when: upstream ${binding.when} poly ${mineToo.when}`);
    }
  }
  const menu = ours.menus["explorer/context"].find((one) => one.command === "poly.swaggerPreview");
  for (const entry of theirs.menus["explorer/context"]) {
    const language = /^resourceLangId == (\w+)$/.exec(entry.when)?.[1];
    // `yml` is no language id VSCode has: upstream's third entry never shows.
    if (language === "yml") continue;
    if (!menu?.when.includes(`resourceLangId == ${language}`) || menu.group !== entry.group) {
      problems.push(`explorer/context ${entry.when}: poly ${JSON.stringify(menu)}`);
    }
  }
  const view = ours.views.explorer.find((one) => one.id === "polySwaggerFiles");
  if (!view) problems.push("view swaggerFiles: poly has none");
  const welcome = ours.viewsWelcome?.find((one) => one.view === "polySwaggerFiles");
  if (!welcome) problems.push("viewsWelcome swaggerFiles: poly has none");
  const validation = ours.jsonValidation?.map((one) => one.fileMatch);
  if (JSON.stringify(validation) !== JSON.stringify(theirs.jsonValidation.map((one) => one.fileMatch))) {
    problems.push(`jsonValidation: poly ${JSON.stringify(validation)}`);
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
  for (const dir of ["empty"]) mkdirSync(join(SCRATCH, dir), { recursive: true });
  // The test runner wants an extension under development; this one does nothing.
  writeFileSync(
    join(SCRATCH, "empty", "package.json"),
    JSON.stringify({ name: "empty", publisher: "poly", version: "0.0.0", engines: { vscode: "*" } }),
  );
  mkdirSync(join(ROOT, ".logs", "audit"), { recursive: true });

  execFileSync("pnpm", ["run", "build"], { cwd: LSP, stdio: "inherit" });
  const executable = await vscodeExecutable();
  const [cli, ...args] = testElectron.resolveCliArgsFromVSCodeExecutablePath(executable);
  const vsix = {};
  for (const [name, url] of Object.entries(VSIX)) {
    vsix[name] = join(SCRATCH, `${name}-${/\/([\d.]+)\/vspackage$/.exec(url)[1]}.vsix`);
    await download(url, vsix[name]);
  }
  for (const [side, installs] of [["swagger", [vsix.swagger, vsix.yaml]], ["poly", [vsix.yaml]]]) {
    // Fresh each run: a leftover from another version would be the one loaded.
    rmSync(join(SCRATCH, `ext-${side}`), { recursive: true, force: true });
    for (const one of installs) {
      execFileSync(cli, [...args, "--extensions-dir", join(SCRATCH, `ext-${side}`), "--install-extension", one], {
        stdio: "inherit",
      });
    }
  }

  const theirs = await measure("swagger", executable, 9361);
  const ours = await measure("poly", executable, 9362);

  const problems = [...manifestProblems(join(SCRATCH, "ext-swagger")), ...theirs.errors, ...ours.errors];
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

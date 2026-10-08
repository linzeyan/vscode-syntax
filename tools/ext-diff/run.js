#!/usr/bin/env node
// poly against the marketplace extensions people used before it, feature by
// feature, with a picture of each side.
//
// Every other test in this repo asks poly what it thinks. The ones that ask
// something else ask the editor's own built-ins (ref-lens, toc-fuzz,
// mermaid-diff) or two extensions poly's editor features replaced
// (editor-diff). None of them asks the extensions poly was installed *instead
// of*, and that is where "it exists in code but works badly" was found: in use,
// next to the habit the old extension left behind.
//
// Each case set is two launches of one VSCode build on one fixture workspace:
// once with the original installed and poly absent, once with poly loaded from
// this checkout's source and the original disabled. One launch per side so one
// side's decorations never appear in the other's screenshots. Each side writes
// results.json and its PNG screenshots; this script then pairs them into diff.json and an
// index.html a person can read.
//
// An audit, not a gate: it downloads software this repo does not ship, and a
// disagreement is a finding to read rather than a failure. It exits non-zero
// only when a side could not be measured, which is the one outcome that makes
// every row it wrote meaningless.
//
// Usage: node tools/ext-diff/run.js [path/to/poly]
//        POLY_EXT_DIFF_SETS=unicode,format node tools/ext-diff/run.js
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { createServer } = require("node:net");
const { tmpdir } = require("node:os");
const { join, resolve, sep } = require("node:path");
const { Writable } = require("node:stream");
const { pathToFileURL } = require("node:url");

const ROOT = resolve(__dirname, "..", "..");
const LSP = join(ROOT, "extensions", "lsp");
const SYNTAX = join(ROOT, "extensions", "syntax");
const CACHE = join(LSP, ".vscode-test");
const { runTests } = require(join(LSP, "node_modules", "@vscode", "test-electron"));
const { render } = require("./report");

/** In the order they were written, which is also the order they are cheapest. */
const SETS = ["unicode", "format", "refview"].map((id) => require(`./sets/${id}.js`));

const POLY_IDS = ["ricky.poly-lsp", "ricky.poly-syntax-highlight"];

/**
 * Keyed by checkout, for the reason ref-lens-check/runnable.js gives: two
 * worktrees running this at once would otherwise share one profile and one
 * fixture workspace, and read each other's files.
 */
const SCRATCH = join(
  tmpdir(),
  `poly-ext-diff-${createHash("sha1").update(ROOT).digest("hex").slice(0, 8)}`,
);

/**
 * Settings both sides get, so the pictures differ only where the extensions do.
 *
 * Mostly the editor's own furniture turned off: a chat panel, a welcome page
 * or an update toast in one picture and not the other reads as a difference
 * that neither side made.
 */
const COMMON_SETTINGS = {
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.disableAIFeatures": true,
  "window.restoreWindows": "none",
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "extensions.ignoreRecommendations": true,
  "telemetry.telemetryLevel": "off",
  "editor.minimap.enabled": false,
  "security.workspace.trust.enabled": false,
};

function stamp() {
  const now = new Date();
  const two = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-`
    + `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

/**
 * Where a VSCode build has already been downloaded: this checkout's cache, or
 * -- from a linked worktree -- the main checkout's.
 *
 * A worktree starts without one, and the alternative is a fresh 200MB download
 * per worktree of a build that is only ever read. A symlink in the worktree
 * would do the same job and show up as an untracked file, because the
 * .gitignore entry for the cache matches a directory and a link is not one.
 */
function vscodeCaches() {
  const caches = [CACHE];
  const dotGit = join(ROOT, ".git");
  if (existsSync(dotGit) && !statSync(dotGit).isDirectory()) {
    const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1] ?? "";
    const main = gitdir.split(`${sep}.git${sep}worktrees${sep}`)[0];
    if (main && main !== gitdir) caches.push(join(main, "extensions", "lsp", ".vscode-test"));
  }
  return caches.filter((dir) => existsSync(dir));
}

/** The newest VSCode already downloaded, by version and not by name -- see mermaid-diff. */
function cachedVSCode() {
  const cache = vscodeCaches().find((dir) => readdirSync(dir).some((name) => /^vscode-.*\d+\.\d+\.\d+$/.test(name)));
  if (!cache) return null;
  const build = readdirSync(cache)
    .map((name) => ({ name, version: /(\d+)\.(\d+)\.(\d+)$/.exec(name) }))
    .filter((one) => one.name.startsWith("vscode-") && one.version)
    .sort((a, b) =>
      Number(a.version[1]) - Number(b.version[1])
      || Number(a.version[2]) - Number(b.version[2])
      || Number(a.version[3]) - Number(b.version[3])
    )
    .pop();
  if (!build) return null;
  const macos = join(cache, build.name, "Visual Studio Code.app", "Contents", "MacOS");
  return existsSync(macos) ? join(macos, readdirSync(macos)[0]) : null;
}

/** Install one marketplace extension into the shared scratch directory. */
function install(publisher, name) {
  const vsix = join(SCRATCH, `${name}.vsix`);
  const extensions = join(SCRATCH, "extensions");
  const target = join(extensions, `${publisher}.${name}`);
  // Same guard as editor-diff: TMPDIR is pruned by file age and the directory
  // survives its own contents, so ask for the manifest rather than the folder.
  if (existsSync(target) && !existsSync(join(target, "package.json"))) {
    rmSync(target, { recursive: true, force: true });
    rmSync(vsix, { force: true });
  }
  if (!existsSync(vsix)) {
    const url = "https://marketplace.visualstudio.com/_apis/public/gallery/"
      + `publishers/${publisher}/vsextensions/${name}/latest/vspackage`;
    // -f so an error page is a failed download rather than a .vsix that
    // unzip later calls corrupt.
    try {
      execFileSync("curl", ["-fsSL", "--compressed", "-A", "poly-ext-diff", "-o", vsix, url]);
    } catch (error) {
      rmSync(vsix, { force: true });
      throw error;
    }
  }
  if (!existsSync(target)) {
    const staging = mkdtempSync(join(SCRATCH, "unzip-"));
    execFileSync("unzip", ["-q", vsix, "extension/*", "-d", staging]);
    mkdirSync(extensions, { recursive: true });
    execFileSync("mv", [join(staging, "extension"), target]);
    rmSync(staging, { recursive: true, force: true });
    // VSCode lists what is installed from extensions.json rather than by
    // scanning, so a folder unpacked beside an existing list is invisible and
    // lands in `.obsolete`. Dropping both makes the next launch rescan.
    for (const stale of ["extensions.json", ".obsolete"]) {
      rmSync(join(extensions, stale), { force: true });
    }
  }
  return target;
}

/**
 * A development extension with nothing in it, for the side with no poly.
 *
 * The test runner has to be handed at least one extension to develop, and
 * handing it poly's and then disabling them would leave the question of
 * whether a disabled development extension is really gone to a flag. Not
 * loading them at all leaves nothing to ask.
 */
function harness() {
  const dir = join(SCRATCH, "harness");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${
      JSON.stringify({
        name: "ext-diff-harness",
        publisher: "poly",
        version: "0.0.0",
        engines: { vscode: "^1.85.0" },
      })
    }\n`,
  );
  return dir;
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function main() {
  // Same reason as the other harnesses: a VSCode terminal exports its own
  // bootstrap variables and the test instance would inherit them.
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VSCODE_")) delete process.env[key];
  }

  const polyBin = resolve(process.argv[2] ?? join(ROOT, "cli", "target", "release", "poly"));
  if (!existsSync(polyBin)) {
    throw new Error(`no poly binary at ${polyBin}; build one or pass its path as the first argument`);
  }
  const executable = cachedVSCode();
  if (!executable) {
    throw new Error(`no VSCode build under ${vscodeCaches().join(" or ") || CACHE}; \`make e2e\` downloads one`);
  }
  const wanted = (process.env.POLY_EXT_DIFF_SETS ?? "").split(",").filter(Boolean);
  const sets = wanted.length ? SETS.filter((set) => wanted.includes(set.id)) : SETS;

  const run = join(ROOT, ".logs", `ext-diff-${stamp()}`);
  mkdirSync(run, { recursive: true });
  const logFile = createWriteStream(join(run, "run.log"));
  const tee = (stream) =>
    new Writable({
      write(chunk, _encoding, done) {
        stream.write(chunk);
        logFile.write(chunk);
        done();
      },
    });
  const stdout = tee(process.stdout);
  const stderr = tee(process.stderr);
  const say = (line) => stdout.write(`${line}\n`);

  mkdirSync(SCRATCH, { recursive: true });
  // A set whose original cannot be had is skipped and named, not fatal: the
  // other sets still answer, and the report says which one did not and why.
  const originals = {};
  const skipped = {};
  for (const set of sets.filter((one) => one.original)) {
    const [publisher, name] = set.original;
    try {
      originals[set.id] = install(publisher, name);
      say(`installed ${originals[set.id]}`);
    } catch (error) {
      skipped[set.id] = `${publisher}.${name} could not be installed: ${String(error.message ?? error).split("\n")[0]}`;
      say(`!! ${skipped[set.id]}`);
    }
  }

  // Loaded from source, so the bundles are built from source first. Chained by
  // hand: this machine runs npm and pnpm with lifecycle scripts off, and a
  // stale dist/ would measure the last build rather than this tree.
  for (const dir of [LSP]) {
    execFileSync("pnpm", ["run", "build"], { cwd: dir, stdio: ["ignore", "inherit", "inherit"] });
  }
  const polyVersion = execFileSync(polyBin, ["--version"], { encoding: "utf8" }).trim();
  say(`VSCode ${executable}\n${polyVersion} at ${polyBin}\nwriting to ${run}`);

  const summary = { run, vscode: executable, poly: { path: polyBin, version: polyVersion }, skipped, launches: [] };
  // Marketplace originals only: a built-in reference is part of the editor on
  // both sides, which is also how a user has it.
  const allOriginalIds = sets.filter((set) => set.original).map((set) => set.original.join("."));
  for (const set of sets.filter((one) => !skipped[one.id])) {
    const setDir = join(run, set.id);
    const env = { ROOT, polyBin, original: originals[set.id], scratch: SCRATCH };
    let manifest;
    for (const side of ["original", "poly"]) {
      const out = join(setDir, side);
      mkdirSync(out, { recursive: true });
      // A fresh workspace and a fresh profile per launch: the format set writes
      // settings and rewrites files, and whatever one launch leaves behind is
      // not something the next one should start from. Named for the set on
      // both sides, so the two pictures carry the same folder name.
      const workspace = join(SCRATCH, "ws", side, set.id);
      // Under /tmp and not TMPDIR, and named short: the editor puts its IPC
      // socket inside this directory, a Unix socket path has 103 bytes, and
      // macOS's TMPDIR spends 49 of them before this script adds anything.
      // `unicode-original` was the first name to go over, and the launch died
      // in `claimInstance` with `listen EINVAL`.
      const userData = join("/tmp", `ped-${SCRATCH.slice(-8)}`, `${set.id}-${side}`);
      rmSync(workspace, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
      mkdirSync(workspace, { recursive: true });
      mkdirSync(join(userData, "User"), { recursive: true });
      manifest = set.fixture(workspace, env);
      writeFileSync(join(setDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      // The scratch profile's settings.json is the "User" scope: everything a
      // case set writes at Global scope lands here and nowhere near the real
      // user's settings.
      writeFileSync(
        join(userData, "User", "settings.json"),
        `${
          JSON.stringify(
            {
              ...COMMON_SETTINGS,
              ...(side === "poly" ? { "poly.serverPath": polyBin, "poly.updateCheck.enabled": false } : {}),
              ...set.settings(side, env),
            },
            null,
            2,
          )
        }\n`,
      );
      const mine = set.original ? set.original.join(".") : set.builtin;
      const disabled = side === "poly" ? allOriginalIds : allOriginalIds.filter((id) => id !== mine);
      const port = await freePort();
      const started = Date.now();
      say(`\n== ${set.id} / ${side} ==`);
      let code = 0;
      let failure;
      try {
        await runTests({
          extensionDevelopmentPath: side === "poly" ? [LSP, SYNTAX] : [harness()],
          extensionTestsPath: resolve(__dirname, "suite.js"),
          extensionTestsEnv: {
            POLY_EXT_DIFF_SET: set.id,
            POLY_EXT_DIFF_SIDE: side,
            POLY_EXT_DIFF_OUT: out,
            POLY_EXT_DIFF_CDP: String(port),
            // So a case set can read back the settings file itself, not only
            // what the configuration API says about it.
            POLY_EXT_DIFF_USER_DATA: userData,
            POLY_EXT_DIFF_EXPECT: JSON.stringify(
              side === "poly"
                ? { present: ["ricky.poly-lsp"], absent: allOriginalIds }
                : { present: [mine], absent: POLY_IDS },
            ),
            ...(set.launchEnv ? set.launchEnv(side, env) : {}),
          },
          vscodeExecutablePath: executable,
          stdout,
          stderr,
          launchArgs: [
            `--folder-uri=${pathToFileURL(workspace).toString()}`,
            `--extensions-dir=${join(SCRATCH, "extensions")}`,
            `--user-data-dir=${userData}`,
            "--disable-workspace-trust",
            // Launched by a script rather than a shell, the editor would ask
            // the login shell for its environment and lay that over this one
            // -- PATH included, which is how the shell set hands poly-lsp its
            // language server. The environment this script was given is the
            // one a terminal-launched `code` would have.
            "--force-disable-user-env",
            `--remote-debugging-port=${port}`,
            // Chromium refuses a DevTools socket whose Origin it was not told
            // to expect; the suite's WebSocket may send one.
            "--remote-allow-origins=*",
            // The window opens on a desktop somebody is using. Covered by
            // another window, Chromium stops painting it and the next
            // screenshot waits forever -- the first run of this hung for ten
            // minutes on exactly that. These keep it painting.
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "--disable-background-timer-throttling",
            ...disabled.flatMap((id) => ["--disable-extension", id]),
          ],
        });
      } catch (error) {
        code = error.code ?? 1;
        failure = String(error.message ?? error);
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      const written = existsSync(join(out, "results.json"));
      summary.launches.push({ set: set.id, side, exit: code, seconds, results: written, failure });
      say(`== ${set.id} / ${side}: exit ${code}, ${seconds}s${written ? "" : ", no results.json"}`);
    }
  }

  const { problems } = render(run, sets, skipped);
  summary.problems = problems;
  writeFileSync(join(run, "run.json"), `${JSON.stringify(summary, null, 2)}\n`);

  say("\nlaunch                     exit  secs  results");
  for (const one of summary.launches) {
    say(
      `${`${one.set}/${one.side}`.padEnd(26)} ${String(one.exit).padStart(4)} ${String(one.seconds).padStart(5)}  `
        + `${one.results ? "yes" : "NO"}`,
    );
  }
  for (const problem of problems) say(`!! ${problem}`);
  say(`\nreport: ${join(run, "index.html")}`);
  logFile.end();
  const failed = summary.launches.filter((one) => one.exit !== 0 || !one.results).length;
  process.exitCode = failed > 0 || problems.length > 0 || Object.keys(skipped).length > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? error);
  process.exit(1);
});

// poly's Git Graph drawing against the graph mhutchie.git-graph draws, both
// read off their pages in a real VSCode.
//
// Usage: node tools/git-graph-diff/layout.js [repo...]
//
// run.js holds the data to Git Graph's; this holds the drawing to it. Git
// Graph's layout lives in its page, so the oracle is the page itself: a VSCode
// with Git Graph and this checkout's poly-lsp opens each repository in both
// panels, and the SVG each renders is read over the DevTools protocol -- each
// row's dot, and each line as the row gaps it crosses, in which column and
// colour. gitGraphLayout's own output is held to the same answer, so a
// difference says whether the layout or the page drew it. Nothing is clicked
// and nothing is captured from the screen, so it runs beside other windows.
//
// It runs poly's built bundles: build first (`make build`, or `pnpm run build`
// in extensions/lsp); it refuses bundles older than their sources. With no
// arguments it builds the fixtures (fixture.sh) and compares those. Exits 1 if
// any repository differs.
"use strict";
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { installed } = require("./oracle");

const ROOT = path.join(__dirname, "..", "..");
const LSP = path.join(ROOT, "extensions", "lsp");
const SCRATCH = fs.mkdtempSync(path.join("/tmp", "poly-gg-layout-"));
const PORT = 9300 + Math.floor(Math.random() * 600);
const PALETTE = [
  "#0085d9",
  "#d9008f",
  "#00d90a",
  "#d98500",
  "#a300d9",
  "#ff0000",
  "#00d9cc",
  "#e138e8",
  "#85d900",
  "#dc5b23",
  "#6f24d6",
  "#ffcc00",
];
const GREY = "#808080";
const DEFAULT_VIEW = {
  branches: [],
  showRemoteBranches: true,
  showTags: true,
  showStashes: true,
  showUncommitted: true,
  firstParent: false,
  order: "date",
};

function poly() {
  const entry = path.join(SCRATCH, "entry.ts");
  fs.writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(path.join(LSP, "src", "editor", "gitGraphData"))};`,
      `export * from ${JSON.stringify(path.join(LSP, "src", "editor", "gitGraphLayout"))};`,
    ].join("\n"),
  );
  const out = path.join(SCRATCH, "poly.cjs");
  execFileSync(
    path.join(LSP, "node_modules", ".bin", "esbuild"),
    [entry, "--bundle", "--platform=node", "--format=cjs", `--outfile=${out}`, "--log-level=warning"],
  );
  return require(out);
}

/** What poly draws: each row's dot, and each row gap's segments as `from>to colour`. */
async function ours(lib, repo) {
  const graph = await lib.loadGraph(lib.gitIn("git", repo), DEFAULT_VIEW, 300);
  const result = lib.layout(graph.commits, false);
  const hex = (colour) => PALETTE[colour % PALETTE.length];
  const gaps = graph.commits.map(() => new Set());
  for (const line of result.lines) {
    for (let i = 1; i < line.points.length; i++) {
      const [p, q] = [line.points[i - 1], line.points[i]];
      gaps[p.row].add(`${p.col}>${q.col} ${line.uncommitted ? GREY : hex(line.colour)}`);
    }
  }
  return {
    hashes: graph.commits.map((commit) => (commit.hash === "*" ? "*" : commit.hash.slice(0, 8))),
    nodes: graph.commits.map((commit, row) =>
      `${result.nodes[row].col} ${commit.hash === "*" ? GREY : hex(result.nodes[row].colour)}`
    ),
    gaps: gaps.map((set) => [...set].sort()),
  };
}

/** Each page: the command that opens it, where it keeps its rows and graph, and where column 0 is. */
const PAGES = {
  "Git Graph": {
    command: "git-graph.view",
    rows: "#commitTable tr.commit",
    hash: "td:last-child",
    svg: "#commitGraph svg",
    x0: 16,
  },
  poly: {
    command: "poly.gitGraph.view",
    rows: "table.commits tr.commit",
    hash: "td.commit-hash",
    svg: "svg.graph",
    x0: 12,
  },
};

/** Read inside a page: its rows, dots and lines, in its own pixels. */
function readPage(page) {
  const rows = [...document.querySelectorAll(page.rows)].map((row) => row.querySelector(page.hash).textContent.trim());
  const circles = [...document.querySelectorAll(`${page.svg} circle`)].map((c) => ({
    x: +c.getAttribute("cx"),
    y: +c.getAttribute("cy"),
    r: +c.getAttribute("r"),
    cls: c.getAttribute("class") ?? "",
    stroke: c.getAttribute("stroke"),
    fill: c.getAttribute("fill"),
  }));
  const paths = [...document.querySelectorAll(`${page.svg} path.line`)].map((p) => ({
    d: p.getAttribute("d"),
    stroke: p.getAttribute("stroke"),
  }));
  return { rows, circles, paths };
}

/** A page's pixels as rows and columns. */
function drawn(page, x0) {
  // Every row has a dot, so the distinct dot heights are the row centres; a
  // line's ends are snapped to the nearest one.
  const centres = [...new Set(page.circles.map((c) => c.y))].sort((a, b) => a - b);
  const rowAt = (y) => centres.reduce((best, c, i) => (Math.abs(c - y) < Math.abs(centres[best] - y) ? i : best), 0);
  const colAt = (x) => Math.round((x - x0) / 16);
  const nodes = centres.map(() => undefined);
  for (const c of page.circles) {
    // A stash is a ring with a dot inside: the ring says the colour.
    const row = rowAt(c.y);
    if (nodes[row] !== undefined && c.r < 4) continue;
    const colour = c.stroke && c.stroke !== "none" ? c.stroke : c.fill;
    nodes[row] = `${colAt(c.x)} ${colour.toLowerCase()}`;
  }
  const gaps = centres.map(() => new Set());
  for (const { d, stroke } of page.paths) {
    const tokens = d.match(/[MLC][^MLC]*/g);
    let at;
    for (const token of tokens) {
      const numbers = token.slice(1).trim().split(/[\s,]+/).map(Number);
      const point = { col: colAt(numbers[numbers.length - 2]), row: rowAt(numbers[numbers.length - 1]) };
      if (token[0] !== "M") {
        if (token[0] === "C" && point.row !== at.row + 1) {
          throw new Error(`a bend across ${point.row - at.row} rows: ${d}`);
        }
        for (let row = at.row; row < point.row; row++) {
          gaps[row].add(`${row === at.row ? at.col : point.col}>${point.col} ${stroke.toLowerCase()}`);
        }
      }
      at = point;
    }
  }
  return { hashes: page.rows, nodes, gaps: gaps.map((set) => [...set].sort()) };
}

function compare(label, a, b) {
  const problems = [];
  if (a.hashes.join() !== b.hashes.join()) {
    problems.push(`${label}: rows differ: ${a.hashes.length} against Git Graph's ${b.hashes.length}`);
    return problems;
  }
  for (let row = 0; row < a.hashes.length; row++) {
    if (a.nodes[row] !== b.nodes[row]) {
      problems.push(`${label}: row ${row} (${a.hashes[row]}) dot ${a.nodes[row]}, Git Graph ${b.nodes[row]}`);
    }
    if (a.gaps[row].join() !== b.gaps[row].join()) {
      problems.push(
        `${label}: below row ${row} (${a.hashes[row]}) [${a.gaps[row].join(", ")}], Git Graph [${
          b.gaps[row].join(", ")
        }]`,
      );
    }
  }
  return problems;
}

/** Fails unless the bundles the extension host will load are at least as new as their sources. */
function requireFreshBuild() {
  const newest = (files) => Math.max(...files.map((file) => fs.statSync(file).mtimeMs));
  const sources = fs.readdirSync(path.join(LSP, "src", "editor"))
    .filter((name) => name.startsWith("gitGraph") && !name.endsWith(".test.ts"))
    .map((name) => path.join(LSP, "src", "editor", name))
    .concat(["gitGraph.ts", "gitGraph.css"].map((name) => path.join(LSP, "src", "editor", "preview", name)));
  const bundles = ["gitGraph.js", "extension.js", "git-graph/gitGraph.js", "git-graph/gitGraph.css"].map((name) =>
    path.join(LSP, "dist", name)
  );
  if (
    bundles.some((bundle) => !fs.existsSync(bundle))
    || Math.min(...bundles.map((b) => fs.statSync(b).mtimeMs)) < newest(sources)
  ) {
    throw new Error("poly's Git Graph bundles are missing or older than src/editor: run `make build` first");
  }
}

/** A VSCode with Git Graph and poly-lsp, every repository a workspace folder, and a file to say what to show. */
async function launch(repos) {
  const { downloadAndUnzipVSCode } = require(path.join(LSP, "node_modules", "@vscode", "test-electron"));
  const executable = await downloadAndUnzipVSCode({ cachePath: path.join(LSP, ".vscode-test") });
  const userData = path.join(SCRATCH, "ud");
  const extensions = path.join(SCRATCH, "ext");
  const opener = path.join(SCRATCH, "opener");
  const control = path.join(SCRATCH, "show");
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.mkdirSync(extensions);
  fs.mkdirSync(opener);
  fs.symlinkSync(installed(), path.join(extensions, path.basename(installed())));
  fs.writeFileSync(
    path.join(userData, "User", "settings.json"),
    JSON.stringify({
      "chat.disableAIFeatures": true,
      "security.workspace.trust.enabled": false,
      "workbench.startupEditor": "none",
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "telemetry.telemetryLevel": "off",
      "window.restoreWindows": "none",
    }),
  );
  fs.writeFileSync(
    path.join(opener, "package.json"),
    JSON.stringify({
      name: "git-graph-layout-opener",
      publisher: "poly",
      version: "0.0.0",
      engines: { vscode: "^1.85.0" },
      main: "./extension.js",
      activationEvents: ["onStartupFinished"],
    }),
  );
  // Runs the command named in the control file, on the repository named
  // after it, whenever the file changes.
  fs.writeFileSync(
    path.join(opener, "extension.js"),
    `
    const fs = require("fs");
    const vscode = require("vscode");
    exports.activate = () => {
      let shown = "";
      setInterval(() => {
        let wanted = "";
        try { wanted = fs.readFileSync(${JSON.stringify(control)}, "utf8"); } catch {}
        if (wanted && wanted !== shown) {
          shown = wanted;
          const [command, repo] = wanted.split("\\n");
          vscode.commands.executeCommand(command, { rootUri: vscode.Uri.file(repo) });
        }
      }, 300);
    };
  `,
  );
  const workspace = path.join(SCRATCH, "all.code-workspace");
  fs.writeFileSync(workspace, JSON.stringify({ folders: repos.map((repo) => ({ path: repo })) }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const child = spawn(executable, [
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensions}`,
    `--extensionDevelopmentPath=${opener}`,
    `--extensionDevelopmentPath=${LSP}`,
    `--remote-debugging-port=${PORT}`,
    "--new-window",
    workspace,
  ], { env, stdio: "ignore", detached: true });
  child.unref();
  return { userData, control };
}

async function connect() {
  const puppeteer = require(path.join(LSP, "node_modules", "puppeteer-core"));
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${PORT}`,
        defaultViewport: null,
        protocolTimeout: 60000,
      });
      for (const page of await browser.pages()) {
        if ((await page.title()).includes("Extension Development Host")) return { browser, page };
      }
      await browser.disconnect();
    } catch {
      // Not listening yet: VSCode is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("the VSCode window never came up");
}

/** One page's drawing of `repo`, once it shows exactly the commits `expected` lists. */
async function read(page, control, which, repo, expected) {
  const spec = PAGES[which];
  fs.writeFileSync(control, `${spec.command}\n${repo}`);
  let last = "";
  for (let attempt = 0; attempt < 120; attempt++) {
    for (const frame of page.frames()) {
      let found;
      try {
        found = await frame.evaluate(`(${readPage})(${JSON.stringify(spec)})`);
      } catch {
        continue;
      }
      if (found.rows.join() === expected.join() && found.circles.length >= found.rows.length) {
        // Read twice, a beat apart: the graph is drawn after the rows.
        const now = JSON.stringify(found);
        if (now === last) return found;
        last = now;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${which} never showed ${repo} as poly's data lists it`);
}

async function main() {
  const repos = process.argv.slice(2).map((repo) => path.resolve(repo));
  if (repos.length === 0) {
    const fixtures = path.join(SCRATCH, "fixtures");
    execFileSync("bash", [path.join(__dirname, "fixture.sh"), fixtures], { stdio: "inherit" });
    repos.push(...["graph", "detached", "long"].map((name) => path.join(fixtures, name)));
  }
  requireFreshBuild();
  const lib = poly();
  const { userData, control } = await launch(repos);
  let failed = 0;
  let browser;
  try {
    let page;
    ({ browser, page } = await connect());
    for (const repo of repos) {
      const mine = await ours(lib, repo);
      const theirs = drawn(await read(page, control, "Git Graph", repo, mine.hashes), PAGES["Git Graph"].x0);
      const shown = drawn(await read(page, control, "poly", repo, mine.hashes), PAGES.poly.x0);
      const problems = [...compare("layout", mine, theirs), ...compare("page", shown, theirs)];
      console.log(`${problems.length === 0 ? "same" : "DIFFERENT"}  ${repo}  (${mine.hashes.length} rows)`);
      for (const problem of problems.slice(0, 30)) console.log(`    ${problem}`);
      if (problems.length > 30) console.log(`    ... and ${problems.length - 30} more`);
      if (problems.length > 0) failed++;
    }
  } finally {
    // Closed over the protocol, which quits the whole app; the launcher's own
    // process is long gone by then, so killing it would leave the window up.
    await browser?.close().catch(() => {});
    try {
      execFileSync("pkill", ["-f", userData]);
    } catch {
      // Nothing left to kill.
    }
  }
  console.log(failed === 0 ? `all ${repos.length} graphs match` : `${failed} of ${repos.length} graphs differ`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

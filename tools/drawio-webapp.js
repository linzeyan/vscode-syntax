#!/usr/bin/env node
// Unpacks draw.io's web app into extensions/lsp/dist/drawio, for the draw.io
// editor to load.
//
// The source is the release's draw.war, pinned by version and digest: draw.io
// publishes no npm package, and the war is what the project itself calls the
// packaged client. Dropped from it: the servlet side (WEB-INF, META-INF); the
// top-level files, which are diagrams.net's own pages and service worker --
// poly writes the one page it needs; and `stencils/` and `shapes/`, 46 MB of
// sources the app has minified into `js/`. What is left is the set
// hediet.vscode-drawio ships, file for file, but for its own
// `js/extensions.min.js`.
//
// Idempotent and quiet when the output already matches the pin, so it can sit
// in every build. The download is cached under node_modules/.cache.
//
// Usage: node tools/drawio-webapp.js
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..");
const LSP = join(ROOT, "extensions", "lsp");
const JSZip = require(join(LSP, "node_modules", "jszip"));

// The version hediet.vscode-drawio 1.11.260924036 ships, so that the two
// editors can be diffed on the same app (tools/drawio-diff).
const VERSION = "31.5.2";
const SHA256 = "abd58ad15baef57f43acb79a56350ba8900a8b6fabe94391d8906148fe64e264";
const DROPPED = new Set(["WEB-INF", "META-INF", "stencils", "shapes"]);
const URL = `https://github.com/jgraph/drawio/releases/download/v${VERSION}/draw.war`;

const OUT = join(LSP, "dist", "drawio");
const STAMP = join(OUT, "VERSION");
const CACHE = join(LSP, "node_modules", ".cache", "drawio", `draw-${VERSION}.war`);

async function war() {
  if (!existsSync(CACHE)) {
    const res = await fetch(URL);
    if (!res.ok) {
      throw new Error(`${URL}: ${res.status}`);
    }
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = readFileSync(CACHE);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== SHA256) {
    // Deleted so the next build downloads again rather than failing forever
    // on a truncated file.
    rmSync(CACHE);
    throw new Error(`draw.war ${VERSION}: sha256 ${digest}, pinned ${SHA256}`);
  }
  return bytes;
}

async function main() {
  if (existsSync(STAMP) && readFileSync(STAMP, "utf8") === VERSION) {
    return;
  }
  const zip = await JSZip.loadAsync(await war());
  rmSync(OUT, { recursive: true, force: true });
  let count = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !entry.name.includes("/") || DROPPED.has(entry.name.split("/")[0])) {
      continue;
    }
    const target = join(OUT, entry.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await entry.async("nodebuffer"));
    count++;
  }
  // Last, so an interrupted unpack is redone rather than taken as current.
  writeFileSync(STAMP, VERSION);
  console.log(`draw.io ${VERSION}: ${count} files in ${OUT}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

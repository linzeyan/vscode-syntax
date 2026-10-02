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
// Also dropped: libavoid (LGPL-2.1, `js/libavoid-js/`) and draw.io's ELK build
// (EPL-2.0, `js/elk/`), both as files and as the copies concatenated into
// `js/extensions.min.js`, and `js/integrate.min.js`, which bundles both again
// and which nothing on poly's page loads. Both licenses make whoever ships the
// object code offer its complete source, and the source of these builds is in
// jgraph's private drawio-libavoid and drawio-elk repositories, so poly could
// not honour the offer. What goes with them: Orthogonal Routing (libavoid) is
// not offered, the ELK layouts report that they are unavailable, and Mermaid
// import lays out with dagre, its own fallback when ELK is missing.
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
const DROPPED = ["WEB-INF", "META-INF", "stencils", "shapes", "js/libavoid-js", "js/elk", "js/integrate.min.js"];
// The two libraries as they sit inside js/extensions.min.js: each is the whole
// of its standalone file, concatenated verbatim.
const CUT = ["js/libavoid-js/libavoid.min.js", "js/elk/drawio-elk.min.js"];
const URL = `https://github.com/jgraph/drawio/releases/download/v${VERSION}/draw.war`;

const OUT = join(LSP, "dist", "drawio");
const STAMP = join(OUT, "VERSION");
// Not the bare version, so that an unpack made before the cut is redone.
const STAMPED = `${VERSION} without libavoid and ELK`;
const MODIFIED =
  "/* Modified by poly: libavoid (LGPL-2.1) and draw.io's ELK build (EPL-2.0) were removed from this file,\n"
  + " * and LibavoidRouting is left undefined so the editor does not offer the routing they provided.\n"
  + " * See tools/drawio-webapp.js. */\n";

/** js/extensions.min.js with the libraries in CUT taken out, or an error if it is not as expected. */
async function extensions(zip) {
  let text = await zip.file("js/extensions.min.js").async("string");
  for (const name of CUT) {
    const library = (await zip.file(name).async("string")).trim();
    const at = text.indexOf(library);
    // Exactly once, or a new release has changed how it bundles them and the
    // cut would leave a copy behind or take the wrong bytes.
    if (at < 0 || text.indexOf(library, at + 1) >= 0) {
      throw new Error(`draw.io ${VERSION}: ${name} is not in js/extensions.min.js exactly once`);
    }
    text = text.slice(0, at) + text.slice(at + library.length);
  }
  for (const marker of ["initAvoidModule", "@drawio/elk"]) {
    if (text.includes(marker)) {
      throw new Error(`draw.io ${VERSION}: js/extensions.min.js still contains ${marker}`);
    }
  }
  // draw.io guards every use of libavoid with `typeof LibavoidRouting`; its
  // glue, which is draw.io's own, stays but must not claim a solver it lacks.
  return `${MODIFIED}${text}\nLibavoidRouting=void 0;\n`;
}
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
  if (!existsSync(STAMP) || readFileSync(STAMP, "utf8") !== STAMPED) {
    await unpack();
  }
  // The fonts the app ships, with the license and the copyright lines their
  // files carry; the war has neither beside them. Every build rather than
  // with the unpack, since it is poly's file and changes without the pin.
  writeFileSync(join(OUT, "FONTS.md"), readFileSync(join(LSP, "media", "drawio", "FONTS.md")));
}

async function unpack() {
  const zip = await JSZip.loadAsync(await war());
  rmSync(OUT, { recursive: true, force: true });
  let count = 0;
  for (const entry of Object.values(zip.files)) {
    const dropped = DROPPED.some((path) => entry.name === path || entry.name.startsWith(`${path}/`));
    if (entry.dir || !entry.name.includes("/") || dropped) {
      continue;
    }
    const target = join(OUT, entry.name);
    mkdirSync(dirname(target), { recursive: true });
    const bytes = entry.name === "js/extensions.min.js" ? await extensions(zip) : await entry.async("nodebuffer");
    writeFileSync(target, bytes);
    count++;
  }
  // Last, so an interrupted unpack is redone rather than taken as current.
  writeFileSync(STAMP, STAMPED);
  console.log(`draw.io ${VERSION}: ${count} files in ${OUT}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

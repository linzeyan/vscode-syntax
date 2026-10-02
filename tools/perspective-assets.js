#!/usr/bin/env node
// Lays out Perspective 0.4.0 -- the grid and charts Data Preview draws with --
// in extensions/lsp/dist/data-preview, beside the page the build copied there
// from src/editor/dataPreview.
//
// The files are the npm packages' `dist/umd`, the same bytes
// RandomFractalsInc.vscode-data-preview 2.3.0 ships (its page loads
// perspective-viewer.js from unpkg; here it is local). They are not
// dependencies in package.json: the four packages' own dependency trees carry
// advisories poly would then answer for, and all the page needs is these
// eleven prebuilt files. Each tarball is pinned by the integrity the registry
// publishes for it. perspective-viewer-highcharts is left out: Highcharts is
// not free for commercial use.
//
// One line is changed, in perspective.wasm.worker.js: the float pattern of the
// papaparse 4 bundled into it, which backtracks without end on a long enough
// run of digits (CVE-2020-36649), so that a crafted CSV would hang the
// preview's worker. It becomes papaparse 5.2's pattern, which accepts the same
// strings; 5.2 also dropped the `i` flag, and with it `1E5` as a number, which
// is kept here.
//
// The downloads are cached under node_modules/.cache, so a build after the
// first needs no network.
//
// Usage: node tools/perspective-assets.js
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { gunzipSync } = require("node:zlib");

const ROOT = resolve(__dirname, "..");
const LSP = join(ROOT, "extensions", "lsp");
const OUT = join(LSP, "dist", "data-preview");
const CACHE = join(LSP, "node_modules", ".cache", "perspective");

const PACKAGES = {
  perspective: {
    integrity: "sha512-1hbfGSnjpRUUDGR2cf3okI9axJyrx2vp+Js/OJWF7b2PGQgaPBw4gJzoqArEUYDhB2WnGFIkEFiV+RANmxr7AQ==",
    files: {
      "perspective.js": "scripts/perspective.js",
      "perspective.wasm.worker.js": "scripts/perspective.wasm.worker.js",
      "psp.async.wasm": "scripts/psp.async.wasm",
    },
  },
  "perspective-viewer": {
    integrity: "sha512-gkgQxcHPhkt96f7T5EglUra1yCT40/wvuJruRnpycCSXEzL6bpjjNFrDl+r0PmQNJ9aa+A4YN7uCAAbt7Du+vg==",
    files: {
      "perspective-viewer.js": "scripts/perspective-viewer.js",
      "material.css": "styles/perspective-viewer/material.css",
      "material.dark.css": "styles/perspective-viewer/material.dark.css",
      "material-dense.css": "styles/perspective-viewer/material-dense.css",
      "material-dense.dark.css": "styles/perspective-viewer/material-dense.dark.css",
      "vaporwave.css": "styles/perspective-viewer/vaporwave.css",
    },
  },
  "perspective-viewer-hypergrid": {
    integrity: "sha512-0yfsOTZ19lUURkQsimPdZboxHsnlIxS9gzMxM2wcXB3HLjGppQdyDZAeAPqpRyA0FG4QDQ730n5NWxlwGpmslg==",
    files: { "perspective-viewer-hypergrid.js": "scripts/perspective-viewer-hypergrid.js" },
  },
  "perspective-viewer-d3fc": {
    integrity: "sha512-wo2vWCp1yZbqeIo2gMSrZZDDw/Kn+zI9BQHBQEJFYKUnoMKDtELH3G5YlESN2vxq49zK2EfhZ8TrpK+kXzG+zw==",
    files: { "perspective-viewer-d3fc.js": "scripts/perspective-viewer-d3fc.js" },
  },
};

const FLOAT = String.raw`/^\s*-?(\d*\.?\d+|\d+\.?\d*)(e[-+]?\d+)?\s*$/i`;
const FLOAT_FIXED = String.raw`/^\s*-?(\d+\.?|\.\d+|\d+\.\d+)(e[-+]?\d+)?\s*$/i`;

async function tarball(name, integrity) {
  const cached = join(CACHE, `${name}-0.4.0.tgz`);
  if (!existsSync(cached)) {
    const url = `https://registry.npmjs.org/@finos/${name}/-/${name}-0.4.0.tgz`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = readFileSync(cached);
  const digest = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (digest !== integrity) {
    // Deleted so the next build downloads again rather than failing forever
    // on a truncated file.
    rmSync(cached);
    throw new Error(`@finos/${name} 0.4.0: ${digest}, pinned ${integrity}`);
  }
  return bytes;
}

/** The regular files of a tar archive, by name. npm's are plain ustar. */
function untar(bytes) {
  const files = new Map();
  for (let at = 0; at + 512 <= bytes.length;) {
    const header = bytes.subarray(at, at + 512);
    const field = (start, length) => header.subarray(start, start + length).toString("latin1").replace(/\0.*$/s, "");
    const name = field(0, 100);
    if (!name) break;
    const size = parseInt(field(124, 12).trim(), 8);
    const prefix = field(345, 155);
    const type = field(156, 1);
    if (type === "0" || type === "") {
      files.set(prefix ? `${prefix}/${name}` : name, bytes.subarray(at + 512, at + 512 + size));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function main() {
  let count = 0;
  for (const [name, { integrity, files }] of Object.entries(PACKAGES)) {
    const archive = untar(gunzipSync(await tarball(name, integrity)));
    for (const [from, to] of Object.entries(files)) {
      let content = archive.get(`package/dist/umd/${from}`);
      if (!content) throw new Error(`@finos/${name} 0.4.0 has no dist/umd/${from}`);
      if (from === "perspective.wasm.worker.js") {
        // As bytes, so that nothing else in the file can change on the way.
        const at = content.indexOf(FLOAT);
        if (at < 0 || content.indexOf(FLOAT, at + 1) >= 0) {
          throw new Error(`${from}: papaparse's float pattern is not there exactly once`);
        }
        content = Buffer.concat([
          // Apache-2.0 §4(b): a modified file says so.
          Buffer.from(
            "/* Modified by poly: papaparse's float pattern is replaced by papaparse 5.2's. See tools/perspective-assets.js. */\n",
          ),
          content.subarray(0, at),
          Buffer.from(FLOAT_FIXED),
          content.subarray(at + FLOAT.length),
        ]);
      }
      mkdirSync(dirname(join(OUT, to)), { recursive: true });
      writeFileSync(join(OUT, to), content);
      count++;
    }
  }
  console.log(`Perspective 0.4.0: ${count} files in ${OUT}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

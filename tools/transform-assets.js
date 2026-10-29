#!/usr/bin/env node
// Lays out linzeyan/transform's built page -- the Toolbox's tools -- in
// extensions/lsp/dist/transform.
//
// The page is transform's release asset as its CI built it: index.html, the
// scripts and styles, and the wasm with its wasm-bindgen glue. Taken built
// rather than compiled here because the wasm needs Rust's wasm32 target, LLVM
// for zstd's C and a wasm-bindgen CLI matching the crate exactly, on each of
// the three machines that package a VSIX; and because the wasm and the glue
// that arrive together are a pair that cannot drift. The asset is pinned by
// tools/transform-pin.json, whose tag third-party-notices.py reads too: the
// crates linked into the wasm are listed in THIRD-PARTY-NOTICES-transform.md.
//
// The download is cached under node_modules/.cache, so a build after the first
// needs no network.
//
// Usage: node tools/transform-assets.js
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { gunzipSync } = require("node:zlib");

const untar = require("./untar");

const ROOT = resolve(__dirname, "..");
const LSP = join(ROOT, "extensions", "lsp");
const OUT = join(LSP, "dist", "transform");
const CACHE = join(LSP, "node_modules", ".cache", "transform");
const { tag, sha256 } = JSON.parse(readFileSync(join(__dirname, "transform-pin.json"), "utf8"));

// What the Toolbox loads by name; an asset without one is not the page.
const REQUIRED = ["index.html", "main.js", "css/main.css", "pkg/wasm_core.js", "pkg/wasm_core_bg.wasm", "LICENSE"];

async function asset() {
  const cached = join(CACHE, `transform-www-${tag}.tar.gz`);
  if (!existsSync(cached)) {
    const url = `https://github.com/linzeyan/transform/releases/download/${tag}/transform-www.tar.gz`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = readFileSync(cached);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256) {
    // Deleted so the next build downloads again rather than failing forever
    // on a truncated file.
    rmSync(cached);
    throw new Error(`transform ${tag}: sha256 ${digest}, pinned ${sha256}`);
  }
  return bytes;
}

async function main() {
  const files = untar(gunzipSync(await asset()));
  rmSync(OUT, { recursive: true, force: true });
  for (const [entry, content] of files) {
    const name = entry.replace(/^\.\//, "");
    if (name.split("/").includes("..")) throw new Error(`transform ${tag}: ${entry} leaves the folder`);
    mkdirSync(dirname(join(OUT, name)), { recursive: true });
    writeFileSync(join(OUT, name), content);
  }
  const missing = REQUIRED.filter((name) => !existsSync(join(OUT, name)));
  if (missing.length) throw new Error(`transform ${tag} has no ${missing.join(", ")}`);
  // The Toolbox's tree names tools by the page's route ids. A route the page
  // dropped or renamed opens its default tool under the old label instead,
  // which nobody would notice from a passing build.
  const page = readFileSync(join(OUT, "main.js"), "utf8");
  const routes = /const implementedTools = new Set\(\[([^\]]*)\]\)/.exec(page);
  if (!routes) throw new Error(`transform ${tag}: main.js no longer lists implementedTools`);
  const known = new Set([...routes[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const tools = JSON.parse(readFileSync(join(LSP, "src", "editor", "toolbox.json"), "utf8")).flatMap((g) => g.tools);
  const stale = tools.map((t) => t.id).filter((id) => !known.has(id));
  if (stale.length) throw new Error(`transform ${tag} has no tool ${stale.join(", ")}; see src/editor/toolbox.json`);
  // Likewise the tools Open Selection in Toolbox offers: one the page cannot
  // fill would open empty, with the selection silently dropped.
  const fields = /const embedFields = \{\n([\s\S]*?)\n\};/.exec(page);
  if (!fields) throw new Error(`transform ${tag}: main.js no longer lists embedFields`);
  const fillable = new Set([...fields[1].matchAll(/^ {4}'?([\w-]+)'?:/gm)].map((m) => m[1]));
  const unfilled = tools.filter((t) => t.input && !fillable.has(t.id)).map((t) => t.id);
  if (unfilled.length) {
    throw new Error(`transform ${tag} cannot fill ${unfilled.join(", ")}; see "input" in src/editor/toolbox.json`);
  }
  console.log(`transform ${tag}: ${files.size} files in ${OUT}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

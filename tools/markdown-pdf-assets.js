#!/usr/bin/env node
// Lays out the files markdown export reads at run time in
// extensions/lsp/dist/markdown-pdf, the way yzane.markdown-pdf's VSIX lays
// them out: upstream's styles, template, emoji names and license, KaTeX's
// stylesheet and fonts (inlined into any page that has math), and
// highlight.js's themes (`poly.markdownPdf.highlightStyle` names one of them).
//
// Copied rather than committed, because two of the three sources are npm
// packages the lockfile already pins.
//
// Usage: node tools/markdown-pdf-assets.js
const { cpSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const LSP = resolve(__dirname, "..", "extensions", "lsp");
const OUT = join(LSP, "dist", "markdown-pdf");
// Each package's license goes beside what is taken from it: the copies are
// files a reader finds on their own, away from the package they came from.
const copies = [
  ["src/editor/markdownPdf/styles", "styles"],
  ["src/editor/markdownPdf/template", "template"],
  ["src/editor/markdownPdf/data", "data"],
  ["src/editor/markdownPdf/LICENSE.txt", "LICENSE.txt"],
  ["node_modules/katex/dist/katex.min.css", "styles/katex/katex.min.css"],
  ["node_modules/katex/LICENSE", "styles/katex/LICENSE"],
  ["node_modules/katex/dist/fonts", "styles/katex/fonts"],
  // The fonts are OFL-1.1, not katex's MIT; their copyright lines are in
  // their name tables, which this file writes out.
  ["src/editor/markdownPdf/FONTS.md", "styles/katex/fonts/FONTS.md"],
  ["node_modules/highlight.js/styles", "highlight.js/styles"],
  ["node_modules/highlight.js/LICENSE", "highlight.js/LICENSE"],
];

// Cleared first, so a file dropped upstream does not linger from the last build.
rmSync(OUT, { recursive: true, force: true });
for (const [from, to] of copies) {
  cpSync(join(LSP, from), join(OUT, to), { recursive: true });
}

// highlight.js's kimbie and nnfx themes are CC-BY-SA-4.0, not its BSD-3-Clause.
// Kept rather than filtered out, as a recorded exception: all eight files are
// values of the `poly.markdownPdf.highlightStyle` enum, so dropping them takes
// away settings users can choose, and CC-BY-SA asks only for attribution and
// that the files stay under it, which shipping them unchanged does. nnfx's
// minified files keep their `/*!` header; kimbie's lose theirs to the
// minifier, so the source file's header is put back on top.
for (const name of ["kimbie-dark", "kimbie-light"]) {
  const styles = join(OUT, "highlight.js", "styles");
  const header = readFileSync(join(styles, `${name}.css`), "utf8").match(/\/\*[^*]*License:[\s\S]*?\*\//);
  if (!header) {
    throw new Error(`highlight.js ${name}.css: no license header to carry into ${name}.min.css`);
  }
  const minified = join(styles, `${name}.min.css`);
  writeFileSync(minified, `${header[0]}\n${readFileSync(minified, "utf8")}`);
}

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
const { cpSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");

const LSP = resolve(__dirname, "..", "extensions", "lsp");
const OUT = join(LSP, "dist", "markdown-pdf");
const copies = [
  ["src/editor/markdownPdf/styles", "styles"],
  ["src/editor/markdownPdf/template", "template"],
  ["src/editor/markdownPdf/data", "data"],
  ["src/editor/markdownPdf/LICENSE.txt", "LICENSE.txt"],
  ["node_modules/katex/dist/katex.min.css", "styles/katex/katex.min.css"],
  ["node_modules/katex/dist/fonts", "styles/katex/fonts"],
  ["node_modules/highlight.js/styles", "highlight.js/styles"],
];

// Cleared first, so a file dropped upstream does not linger from the last build.
rmSync(OUT, { recursive: true, force: true });
for (const [from, to] of copies) {
  cpSync(join(LSP, from), join(OUT, to), { recursive: true });
}

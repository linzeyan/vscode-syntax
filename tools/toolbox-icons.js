#!/usr/bin/env node
// Writes the codicon of each Toolbox tool as a light and a dark SVG into
// extensions/lsp/dist/toolbox-icons, for the tool's editor tab.
//
// A WebviewPanel's iconPath takes image files, not a ThemeIcon, so the codicon
// the tree shows beside a tool cannot simply be named for its tab. The codicon
// sources draw in currentColor, which an icon loaded as an image never
// inherits, so each is written twice in the colours of VSCode's default
// icon.foreground. An icon toolbox.json names that codicons lacks fails the
// build rather than leaving a tab without one.
//
// Usage: node tools/toolbox-icons.js
const { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const LSP = resolve(__dirname, "..", "extensions", "lsp");
const CODICONS = join(LSP, "node_modules", "@vscode", "codicons");
const OUT = join(LSP, "dist", "toolbox-icons");
const COLOURS = { light: "#424242", dark: "#C5C5C5" };

const groups = JSON.parse(readFileSync(join(LSP, "src", "editor", "toolbox.json"), "utf8"));
const icons = new Set(groups.flatMap((group) => group.tools.map((tool) => tool.icon)));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const icon of icons) {
  const svg = readFileSync(join(CODICONS, "src", "icons", `${icon}.svg`), "utf8");
  for (const [theme, colour] of Object.entries(COLOURS)) {
    writeFileSync(join(OUT, `${icon}-${theme}.svg`), svg.replaceAll("currentColor", colour));
  }
}
cpSync(join(CODICONS, "LICENSE"), join(OUT, "LICENSE"));

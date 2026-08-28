#!/usr/bin/env node
// Large-CSV tokenization cost for the rainbow grammar (M1: "large files must
// not stall the UI"). The rainbow grammar is one regex with 16 optional
// capture groups, which is exactly the shape that backtracks badly if it is
// going to backtrack at all — hence the unbalanced-quote case below.
//
// The number that decides whether the UI stalls is per-line cost, not total:
// VSCode tokenizes the viewport synchronously and the rest in background
// chunks, and above 20MB `editor.largeFileOptimizations` skips tokenization
// entirely. A ~100-line viewport at p50 is the budget to compare against one
// 16.7ms frame.
//
// Usage: node tools/csv-tokenize-bench.mjs <node_modules_dir> [extension_dir]
// On Windows the VM has no node; VSCode's own Electron will do:
//   ELECTRON_RUN_AS_NODE=1 "…/Code.exe" tools/csv-tokenize-bench.mjs …
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NM = process.argv[2];
const EXT = process.argv[3]
  ?? join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "syntax");

const vsctm = (await import(pathToFileURL(join(NM, "vscode-textmate", "release", "main.js")))).default;
const oniguruma = (await import(pathToFileURL(join(NM, "vscode-oniguruma", "release", "main.js")))).default;
const wasm = readFileSync(join(NM, "vscode-oniguruma", "release", "onig.wasm"));

const pkg = JSON.parse(readFileSync(join(EXT, "package.json"), "utf8"));
const byScope = new Map(pkg.contributes.grammars.map((g) => [g.scopeName, join(EXT, g.path)]));
const registry = new vsctm.Registry({
  onigLib: oniguruma.loadWASM(wasm.buffer).then(() => ({
    createOnigScanner: (s) => new oniguruma.OnigScanner(s),
    createOnigString: (s) => new oniguruma.OnigString(s),
  })),
  loadGrammar: async (s) => {
    const path = byScope.get(s);
    return path ? vsctm.parseRawGrammar(readFileSync(path, "utf8"), path) : null;
  },
});
const grammar = await registry.loadGrammar("source.csv");

function run(name, lines) {
  // Warm the JIT and oniguruma's scanner cache the way a real session does.
  for (let i = 0; i < Math.min(200, lines.length); i++) {
    grammar.tokenizeLine(lines[i], vsctm.INITIAL);
  }
  const per = [];
  let tokens = 0;
  const start = process.hrtime.bigint();
  for (const line of lines) {
    const t0 = process.hrtime.bigint();
    tokens += grammar.tokenizeLine(line, vsctm.INITIAL).tokens.length;
    per.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const total = Number(process.hrtime.bigint() - start) / 1e6;
  per.sort((a, b) => a - b);
  const bytes = lines.reduce((n, l) => n + l.length + 1, 0);
  console.log(
    `${name.padEnd(34)} lines=${String(lines.length).padStart(7)} ${(bytes / 1048576).toFixed(1)}MB `
      + `total=${total.toFixed(0)}ms p50=${per[per.length >> 1].toFixed(3)}ms `
      + `p95=${per[Math.floor(per.length * 0.95)].toFixed(3)}ms max=${per[per.length - 1].toFixed(3)}ms `
      + `tokens=${tokens}`,
  );
}

const cell = (row, col) => `value-${row}-${col}`;
const rows = (n, cols) =>
  Array.from({ length: n }, (_, r) => Array.from({ length: cols }, (_, c) => cell(r, c)).join(","));

run("100k rows x 16 cols", rows(100_000, 16));
run("100k rows x 64 cols (past rainbow)", rows(100_000, 64));
run("20k rows x 400 cols (very wide)", rows(20_000, 400));
run(
  "50k quoted rows x 16 cols",
  Array.from({ length: 50_000 }, (_, r) => Array.from({ length: 16 }, (_, c) => `"a,b ${r}-${c} ""q"""`).join(",")),
);
// The alternation's failure path: the field regex tries the quoted branch,
// fails, and falls back. This is where a badly written rainbow grammar dies.
run(
  "20k rows, one unclosed quote each",
  Array.from({ length: 20_000 }, (_, r) =>
    `"unclosed ${"x".repeat(200)},`
    + Array.from({ length: 15 }, (_, c) => cell(r, c)).join(",")),
);

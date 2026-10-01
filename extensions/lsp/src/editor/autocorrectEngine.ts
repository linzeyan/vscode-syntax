/**
 * The AutoCorrect engine: huacnlee/autocorrect compiled to WebAssembly, the
 * same build its VSCode extension runs.
 *
 * Bundled on its own (`dist/autocorrect.js`, the wasm copied beside it) and
 * loaded only once `poly.autocorrect.enabled` is on: 3 MB to compile that
 * nobody who never turns it on should pay for.
 *
 * The package is wasm-pack's bundler build, which leaves
 * `import * as wasm from "./autocorrect_bg.wasm"` for the bundler to wire up.
 * esbuild does not, so it is wired here, the way wasm-pack's own glue does it.
 *
 * Every evaluation of this module is a new instance with the default
 * configuration. That is what autocorrectEditor.ts uses it for: `loadConfig`
 * only ever merges into an instance, with no way to take a rule back out.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

import type { Finding } from "./autocorrect";

declare const WebAssembly: {
  Module: new(bytes: Uint8Array) => object;
  Instance: new(module: object, imports: object) => { exports: Record<string, unknown> };
};

// `require` with a type written here: the package is ESM and its glue file has
// no typings, and a CommonJS module may not import it.
const glue = require("@huacnlee/autocorrect/autocorrect_bg.js") as {
  __wbg_set_wasm(exports: object): void;
  lintFor(raw: string, filenameOrExtension: string): { lines: Finding[]; error: string };
  formatFor(raw: string, filenameOrExtension: string): { out: string; error: string };
  loadConfig(config: string): unknown;
};

const instance = new WebAssembly.Instance(
  new WebAssembly.Module(readFileSync(path.join(__dirname, "autocorrect_bg.wasm"))),
  { "./autocorrect_bg.js": glue },
);
glue.__wbg_set_wasm(instance.exports);
(instance.exports.__wbindgen_start as () => void)();

export const { lintFor, formatFor, loadConfig } = glue;

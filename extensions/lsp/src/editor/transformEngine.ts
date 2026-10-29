/**
 * transform's wasm in the extension host, for the Toolbox's editor commands:
 * the same `dist/transform/pkg` the Toolbox's tabs load, so a command and a
 * tab never disagree about an answer.
 *
 * Bundled on its own (`dist/transformEngine.js`) and loaded on the first
 * command: 17 MB of wasm that the tree and the tabs do not need here. The
 * glue is wasm-bindgen's `--target web` ES module, which esbuild turns into
 * CommonJS; `initSync` takes the bytes, so its `fetch` path never runs.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

// `require` with a type written here: the glue is generated, ships without
// its typings, and only exists once tools/transform-assets.js has run.
const glue = require("../../dist/transform/pkg/wasm_core.js") as {
  initSync(input: { module: Uint8Array }): unknown;
  encode_content(input: string): unknown;
  decode_content(kind: string, input: string): string;
  hash_content(input: string): unknown;
  url_encode(input: string): string;
  url_decode(input: string): string;
  jwt_decode(token: string): unknown;
  convert_number_base(base: string, value: string): unknown;
  convert_timestamp(source: string, value: string): unknown;
  transform_format(from: string, to: string, input: string): string;
  convert_tabular_format(from: string, to: string, data: Uint8Array): { bytes: Uint8Array; row_count: bigint };
  convert_image_format(from: string, to: string, bytes: Uint8Array, options: object): { data_base64: string };
};

glue.initSync({ module: readFileSync(path.join(__dirname, "transform", "pkg", "wasm_core_bg.wasm")) });

export const {
  encode_content,
  decode_content,
  hash_content,
  url_encode,
  url_decode,
  jwt_decode,
  convert_number_base,
  convert_timestamp,
  transform_format,
  convert_tabular_format,
  convert_image_format,
} = glue;

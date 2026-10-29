/**
 * What the Toolbox's editor commands decide before they call transform's wasm:
 * how a selected number or timestamp is written, which of transform's formats
 * a document or file is, and what a converted file is called. Apart from
 * toolbox.ts so node's own runner tests it without VSCode or the wasm.
 */
import * as path from "path";

export type Base = "binary" | "octal" | "decimal" | "hex";

/**
 * The base a number is written in. Prefixes decide, and a hex digit with no
 * prefix still means hex: `ff` is not a decimal number with a typo in it.
 * transform strips the prefix itself.
 */
export function numberBase(text: string): Base {
  const digits = text.trim().replace(/^[-+]/, "");
  if (/^0[bB]/.test(digits)) return "binary";
  if (/^0[oO]/.test(digits)) return "octal";
  if (/^0[xX]/.test(digits) || /[a-fA-F]/.test(digits)) return "hex";
  return "decimal";
}

/**
 * transform's name for how a timestamp is written. An epoch's unit is read off
 * its length -- seconds have had 10 digits since 2001 and will until 2286,
 * and each finer unit adds three -- with one digit of slack either side.
 * Anything else goes to transform's text parser, which tries the usual date
 * formats in turn.
 */
export function timestampSource(text: string): string {
  const value = text.trim();
  if (!/^-?\d+$/.test(value)) return "text";
  const digits = value.replace("-", "").length;
  if (digits <= 11) return "timestamp_seconds";
  if (digits <= 14) return "timestamp_milliseconds";
  if (digits <= 17) return "timestamp_microseconds";
  return "timestamp_nanoseconds";
}

/** transform's text formats, and the language a result in each opens as. */
export const TEXT_FORMATS: { id: string; language: string; from: string[] }[] = [
  { id: "JSON", language: "json", from: ["json", "jsonc"] },
  { id: "YAML", language: "yaml", from: ["yaml", "dockercompose", "github-actions-workflow"] },
  { id: "TOML", language: "toml", from: ["toml"] },
  { id: "XML", language: "xml", from: ["xml"] },
  { id: "GraphQL Schema", language: "graphql", from: ["graphql"] },
  { id: "Protobuf", language: "protobuf", from: ["protobuf", "proto3"] },
  // Written from data, never read from a document: their sources are not data.
  { id: "JSON Schema", language: "json", from: [] },
  { id: "Go Struct", language: "go", from: [] },
  { id: "TOON", language: "plaintext", from: [] },
  { id: "MsgPack", language: "plaintext", from: [] },
];

/** The format a document in `language` is read as, if transform reads it. */
export function textFormatOf(language: string): string | undefined {
  return TEXT_FORMATS.find((format) => format.from.includes(language))?.id;
}

/** transform's tabular readers by extension. Feather is Arrow IPC's file format. */
const DATA_SOURCES: Record<string, string> = {
  csv: "csv",
  tsv: "tsv",
  json: "json",
  jsonl: "json",
  ndjson: "json",
  parquet: "parquet",
  avro: "avro",
  arrow: "arrow",
  feather: "feather",
};

/** What a data file can become, as transform names it, with the extension it writes. */
export const DATA_TARGETS: { id: string; label: string; extension: string }[] = [
  { id: "csv", label: "CSV", extension: "csv" },
  { id: "tsv", label: "TSV", extension: "tsv" },
  { id: "json", label: "JSON", extension: "json" },
  { id: "parquet", label: "Parquet", extension: "parquet" },
  { id: "avro", label: "Avro", extension: "avro" },
  { id: "arrow", label: "Arrow IPC", extension: "arrow" },
];

/** transform decodes these; it encodes AVIF too, but cannot read one back. */
const IMAGE_SOURCES: Record<string, string> = { png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp" };

export const IMAGE_TARGETS: { id: string; label: string; extension: string }[] = [
  { id: "png", label: "PNG", extension: "png" },
  { id: "jpg", label: "JPEG", extension: "jpg" },
  { id: "webp", label: "WebP", extension: "webp" },
  { id: "avif", label: "AVIF", extension: "avif" },
];

export type FileKind = { kind: "data" | "image"; from: string; targets: typeof DATA_TARGETS };

/** What a file is to transform, and what it can be converted to: every target but its own format. */
export function fileKind(file: string): FileKind | undefined {
  const extension = path.extname(file).slice(1).toLowerCase();
  const data = DATA_SOURCES[extension];
  if (data) {
    const own = data === "feather" ? "arrow" : data;
    return { kind: "data", from: data, targets: DATA_TARGETS.filter((target) => target.id !== own) };
  }
  const image = IMAGE_SOURCES[extension];
  if (image) return { kind: "image", from: image, targets: IMAGE_TARGETS.filter((target) => target.id !== image) };
  return undefined;
}

/** `report.csv` becomes `report.parquet`. A name only: the caller puts it beside the source, whose path may be a remote one. */
export function convertedName(name: string, extension: string): string {
  return `${name.slice(0, name.length - path.extname(name).length)}.${extension}`;
}

/**
 * serde-wasm-bindgen hands a Rust map over as a JS `Map` and a struct as an
 * object; the commands want one shape for either.
 */
export function entries(value: unknown): [string, string][] {
  const pairs = value instanceof Map ? [...value.entries()] : Object.entries(value ?? {});
  return pairs.filter((pair): pair is [string, string] => typeof pair[1] === "string");
}

const ENCODINGS: Record<string, string> = {
  base32_standard: "Base32",
  base32_standard_no_padding: "Base32, no padding",
  base32_hex: "Base32hex",
  base32_hex_no_padding: "Base32hex, no padding",
  base64_standard: "Base64",
  base64_raw_standard: "Base64, no padding",
  base64_url: "Base64 URL",
  base64_raw_url: "Base64 URL, no padding",
  base85_ascii85: "Ascii85",
  base91: "Base91",
  hex_upper: "Hex",
};

/**
 * How a result's name reads in a list: transform's keys are identifiers
 * (`sha512_256`, `browser_rfc2822`), and "browser" there means the local time
 * zone, which is what it is in an editor.
 */
export function labelOf(key: string): string {
  if (ENCODINGS[key]) return ENCODINGS[key];
  const sha = /^sha(3_)?(\d+)(?:_(\d+))?$/.exec(key);
  if (sha) return `SHA${sha[1] ? "3" : ""}-${sha[2]}${sha[3] ? `/${sha[3]}` : ""}`;
  return key
    .replace(/^browser_/, "local ")
    .replace(/_/g, " ")
    .replace(/\b(md|crc|fnv|adler|iso|rfc|sql)(\d*)/g, (word) => word.toUpperCase());
}

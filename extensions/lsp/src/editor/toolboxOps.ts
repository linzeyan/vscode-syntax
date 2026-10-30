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

/** What transform's `read_timestamp` made of a text (wasm_core/src/timestamp.rs). */
export interface Reading {
  label: string;
  /** False when the text named no offset: `seconds` is then its wall-clock time counted as UTC. */
  zoned: boolean;
  /** An i64 as text: a JS number loses precision past 2^53. */
  seconds: string;
  nanos: number;
  relative: boolean;
}

type Text = Record<"iso8601" | "rfc3339" | "rfc2822" | "iso9075" | "sql_datetime" | "sql_date", string>;

/** What transform's `format_timestamp` writes an instant as. */
export interface Written {
  unix: Record<"seconds" | "milliseconds" | "microseconds" | "nanoseconds", string>;
  utc: Text;
  http: string;
  local: Text;
}

/**
 * The instant a reading names, and the editor's UTC offset at that instant.
 * Zones by name are left to the host's Intl, which the wasm does not carry, so
 * text without an offset is a wall-clock time here in the local zone; the
 * second guess settles the hours around a daylight-saving change.
 */
export function placeLocally(reading: Reading): { seconds: string; offset: number } {
  const offsetAt = (ms: number) => {
    const minutes = new Date(ms).getTimezoneOffset();
    // Past Date's ±275,760 years there is no zone data: write it as UTC.
    return Number.isFinite(minutes) ? -minutes * 60 : 0;
  };
  const wall = Number(reading.seconds) * 1000;
  if (reading.zoned) return { seconds: reading.seconds, offset: offsetAt(wall) };
  const offset = offsetAt(wall - offsetAt(wall) * 1000);
  return { seconds: (BigInt(reading.seconds) - BigInt(offset)).toString(), offset };
}

/** Every form an instant is written in, named for labelOf. */
export function timestampEntries(written: Written): [string, string][] {
  return [
    ...Object.entries(written.unix).map(([key, value]): [string, string] => [`unix_${key}`, value]),
    ...Object.entries(written.utc).map(([key, value]): [string, string] => [`utc_${key}`, value]),
    ["http_date", written.http],
    ...Object.entries(written.local).map(([key, value]): [string, string] => [`local_${key}`, value]),
  ];
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

/** How a result's name reads in a list: transform's keys are identifiers (`sha512_256`, `local_rfc2822`). */
export function labelOf(key: string): string {
  if (ENCODINGS[key]) return ENCODINGS[key];
  const sha = /^sha(3_)?(\d+)(?:_(\d+))?$/.exec(key);
  if (sha) return `SHA${sha[1] ? "3" : ""}-${sha[2]}${sha[3] ? `/${sha[3]}` : ""}`;
  return key
    .replace(/_/g, " ")
    .replace(/\b(md|crc|fnv|adler|iso|rfc|sql|utc|http)(\d*)\b/g, (word) => word.toUpperCase());
}

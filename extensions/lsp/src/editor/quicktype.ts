/**
 * quicktype in the extension host: data on the clipboard into types in the
 * language being edited -- what quicktype.quicktype's Paste JSON as Types and
 * Paste JSON as Code did before it was uninstalled.
 *
 * transform's own `Go Struct` covers one language; quicktype-core is the
 * engine that extension ran on and writes 27, so every target it had is kept
 * by using it rather than re-implementing it in transform.
 *
 * Bundled on its own (`dist/quicktype.js`) and loaded on the first paste that
 * looks like data: quicktype-core is megabytes the rest of poly never needs.
 */
import {
  defaultTargetLanguages,
  InputData,
  isLanguageName,
  jsonInputForTargetLanguage,
  JSONSchemaInput,
  languageNamed,
  quicktype,
} from "quicktype-core";
import { parse as parseYaml } from "yaml";

/** What quicktype reads: a sample of the data, or a JSON Schema describing it. */
export interface Source {
  readonly kind: "json" | "schema";
  readonly json: string;
}

/** A language quicktype writes, by the name `generate` takes. */
export interface Target {
  readonly name: string;
  readonly label: string;
  /** Has a types-only mode; without one its output is always types plus (de)serialization. */
  readonly typesOnly: boolean;
}

export const TARGETS: readonly Target[] = defaultTargetLanguages.map((lang) => ({
  name: lang.names[0],
  label: lang.displayName,
  typesOnly: lang.optionDefinitions.some((option) => option.name === "just-types"),
}));

/** Past this a paste is a file, not a sample, and parsing it on every paste is the cost. */
const MAX_SOURCE = 1 << 20;

const isData = (value: unknown): value is object => typeof value === "object" && value !== null;

/**
 * A JSON Schema is JSON too, and read as a sample it becomes types describing
 * the schema's own keywords. quicktype had a separate command for each; here
 * the shape decides, and only by keys a data sample is unlikely to carry.
 */
function isSchema(value: object): boolean {
  if (Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return "$schema" in object || (object.type === "object" && isData(object.properties));
}

/**
 * The clipboard as quicktype input, or undefined when it is not data.
 *
 * JSON first, then YAML, then TOML: YAML reads JSON, and TOML's `key = value`
 * is a plain string to YAML rather than an error, so the order keeps each
 * reader to what the earlier ones refused. A scalar is not data -- a YAML
 * reader turns most pasted prose into one. `toml` is transform's reader,
 * passed in because it lives in another bundle and costs a 17 MB wasm; it
 * returns undefined for text it does not want to pay that for.
 */
export function sourceOf(text: string, toml?: (text: string) => unknown): Source | undefined {
  if (text.length > MAX_SOURCE) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    try {
      value = parseYaml(text);
    } catch {
      value = undefined;
    }
    if (!isData(value) && toml) {
      try {
        value = toml(text);
      } catch {
        value = undefined;
      }
    }
  }
  if (!isData(value)) return undefined;
  return { kind: isSchema(value) ? "schema" : "json", json: JSON.stringify(value) };
}

/** `source` as `target` source code: types only, or types and the code that reads and writes them. */
export async function generate(
  source: Source,
  target: string,
  typesOnly: boolean,
  indentation: string,
  name = "TopLevel",
): Promise<string> {
  if (!isLanguageName(target)) throw new Error(`quicktype writes no language called ${target}`);
  const lang = languageNamed(target);
  const inputData = new InputData();
  if (source.kind === "schema") {
    await inputData.addSource("schema", { name, schema: source.json }, () => new JSONSchemaInput(undefined));
  } else {
    await inputData.addSource("json", { name, samples: [source.json] }, () => jsonInputForTargetLanguage(lang));
  }
  const canOmit = lang.optionDefinitions.some((option) => option.name === "just-types");
  const result = await quicktype({
    lang,
    inputData,
    indentation,
    rendererOptions: typesOnly && canOmit ? { "just-types": "true" } : {},
  });
  return result.lines.join("\n");
}

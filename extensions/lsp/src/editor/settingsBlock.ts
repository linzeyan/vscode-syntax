// The `poly` block in the user's settings.json, as text.
//
// One object setting rather than 249 dotted keys, written by poly rather than
// by the editor: VSCode's own writer re-serialises an object value whole and
// would drop every comment in it, and the comments are the point -- each key
// says what it does, what it accepts and what it defaults to, so the block is
// its own reference. A key nobody set stays a commented-out default, which is
// also what lets a changed default reach everyone who never chose the old one.
//
// No vscode import, so node's test runner covers it (settingsBlock.test.ts).
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree } from "jsonc-parser";

export interface Schema {
  type?: string | string[];
  description?: string;
  markdownDescription?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  properties?: Record<string, Schema>;
}

/** The manifest's `poly` setting: every key's schema, and all defaults in one object. */
export interface PolySchema extends Schema {
  properties: Record<string, Schema>;
  default: Record<string, unknown>;
}

/** A key with a description of its own, as opposed to a group of keys. */
export function isSetting(node: Schema): boolean {
  return node.description !== undefined || node.markdownDescription !== undefined;
}

/** Every setting by its dotted name under `poly` (`format.enabled`), with its default. */
export function settingsOf(poly: PolySchema): Map<string, { schema: Schema; default: unknown }> {
  const found = new Map<string, { schema: Schema; default: unknown }>();
  const walk = (props: Record<string, Schema>, defaults: unknown, prefix: string) => {
    for (const [name, node] of Object.entries(props)) {
      const fallback = isObject(defaults) ? defaults[name] : undefined;
      if (isSetting(node)) {
        found.set(prefix + name, { schema: node, default: fallback });
      } else {
        walk(node.properties ?? {}, fallback, `${prefix}${name}.`);
      }
    }
  };
  walk(poly.properties, poly.default, "");
  return found;
}

export interface Words {
  header: string;
  purpose: string;
  choices: (allowed: string, fallback: string) => string;
  unset: string;
  below: string;
  unknown: string;
  sep: string;
  or: string;
  types: Record<string, string>;
}

export const WORDS: Record<"en" | "zh", Words> = {
  en: {
    header: "Maintained by Poly, which rewrites these comments and defaults for the version installed. "
      + "A commented-out key is unset and shows its default: uncomment it and change the value to set it. "
      + "Values you set are kept.",
    purpose: "",
    choices: (allowed, fallback) => `Allowed: ${allowed}. Default: ${fallback}.`,
    unset: "unset",
    below: "the commented-out value below",
    unknown: "Poly does not know this key and never reads it.",
    sep: " | ",
    or: " or ",
    types: { string: "string", number: "number", integer: "integer", array: "array", object: "object" },
  },
  zh: {
    header: "這個區塊由 Poly 維護：每次啟用都依安裝的版本重寫註解與預設值。被註解掉的鍵是沒設定，"
      + "後面列的就是預設值；取消註解再改值就會生效。設定過的值都會保留。",
    purpose: "用途：",
    choices: (allowed, fallback) => `可選：${allowed}；預設：${fallback}`,
    unset: "未設",
    below: "見下方註解掉的值",
    unknown: "Poly 不認得這個鍵，也不會讀它。",
    sep: "｜",
    or: "或",
    types: { string: "字串", number: "數字", integer: "整數", array: "陣列", object: "物件" },
  },
};

/** Comment lines are wrapped here, counting a CJK character as two columns. */
const WIDTH = 100;

/** The widest default the `可選` line names inline. */
const SHORT = 40;

interface Context {
  unit: string;
  eol: string;
  words: Words;
  strings: Record<string, string>;
}

/**
 * `text` with the `poly` property replaced by a freshly written block, or
 * added when there is none. Everything outside it is left byte for byte.
 *
 * `change` sets one dotted key (`format.enabled`) first; `undefined` unsets it,
 * which writes it back as a commented-out default.
 */
export function rewrite(
  text: string,
  poly: PolySchema,
  strings: Record<string, string>,
  words: Words,
  change?: { key: string; value: unknown },
): string {
  const tree = parseTree(text);
  const node = tree ? findNodeAtLocation(tree, ["poly"]) : undefined;
  const current: unknown = node ? getNodeValue(node) : undefined;
  const user = change ? withValue(current, change.key.split("."), change.value) : current;
  const unit = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = blockText(poly, user, { unit, eol, words, strings });
  if (node) {
    return text.slice(0, node.offset) + block + text.slice(node.offset + node.length);
  }
  const marker = "\u0000poly\u0000";
  const added = applyEdits(
    text,
    modify(text, ["poly"], marker, {
      formattingOptions: { insertSpaces: !unit.includes("\t"), tabSize: unit.length, eol },
    }),
  );
  // A function, not a string: the block is full of `$` (`$fileName`), which a
  // replacement string would read as patterns.
  return added.replace(JSON.stringify(marker), () => block);
}

function blockText(poly: PolySchema, user: unknown, ctx: Context): string {
  return [
    "{",
    ...comment(ctx.words.header, ctx.unit.repeat(2)),
    ...entries(poly.properties, poly.default, user, 2, ctx),
    `${ctx.unit}}`,
  ].join(ctx.eol);
}

function entries(
  props: Record<string, Schema>,
  defaults: unknown,
  user: unknown,
  level: number,
  ctx: Context,
): string[] {
  const pad = ctx.unit.repeat(level);
  const lines: string[] = [];
  for (const [name, node] of Object.entries(props)) {
    const mine = isObject(user) ? user[name] : undefined;
    const fallback = isObject(defaults) ? defaults[name] : undefined;
    if (!isSetting(node)) {
      lines.push(
        `${pad}${JSON.stringify(name)}: {`,
        ...entries(node.properties ?? {}, fallback, mine, level + 1, ctx),
        `${pad}},`,
      );
      continue;
    }
    const described = ctx.strings[ref(node.markdownDescription ?? node.description ?? "")]
      ?? node.markdownDescription ?? node.description ?? "";
    // A long default (`codeRunner.executorMap` is 2 KB) is shown once, as the
    // commented-out value, rather than squeezed into the line above it -- and
    // shown even when the key is set, or nothing would say what it was.
    const short = fallback === undefined || columns(compact(fallback)) <= SHORT;
    const shown = fallback === undefined ? ctx.words.unset : short ? compact(fallback) : ctx.words.below;
    lines.push(
      ...comment(ctx.words.purpose + plain(described), pad),
      ...comment(ctx.words.choices(allowed(node, ctx.words), shown), pad),
      ...(mine === undefined || !short ? valueLines(name, fallback, pad, "// ", ctx) : []),
      ...(mine !== undefined ? valueLines(name, mine, pad, "", ctx) : []),
    );
  }
  for (const [name, value] of Object.entries(isObject(user) ? user : {})) {
    if (!(name in props)) {
      lines.push(...comment(ctx.words.unknown, pad), ...valueLines(name, value, pad, "", ctx));
    }
  }
  return lines;
}

/**
 * One key and its value. Every entry ends in a comma, the commented-out ones
 * included: uncommenting any line then leaves valid JSONC wherever it sits,
 * and settings.json accepts the trailing one.
 */
function valueLines(name: string, value: unknown, pad: string, mark: string, ctx: Context): string[] {
  const key = `${pad}${mark}${JSON.stringify(name)}: `;
  const one = `${key}${compact(value)},`;
  const container = isObject(value) ? Object.keys(value).length > 0 : Array.isArray(value) && value.length > 0;
  // A live container is always laid out a line per entry: poly's own JSON
  // formatter keeps an expanded object expanded, so this text is already what
  // format-on-save would leave, and the next rewrite finds nothing to change.
  if (!container || (mark !== "" && columns(one) <= WIDTH)) {
    return [one];
  }
  const pretty = JSON.stringify(value, null, ctx.unit).split("\n");
  return pretty.map((line, i) => `${i === 0 ? key : pad + mark}${line}${i === pretty.length - 1 ? "," : ""}`);
}

function allowed(node: Schema, words: Words): string {
  if (node.enum) {
    return node.enum.map(compact).join(words.sep);
  }
  return [node.type ?? "object"].flat().map((type) => {
    if (type === "boolean") {
      return `true${words.sep}false`;
    }
    const word = words.types[type] ?? type;
    const { minimum: min, maximum: max } = node;
    return min === undefined && max === undefined
      ? word
      : `${word} ${
        min !== undefined && max !== undefined ? `${min}-${max}` : min !== undefined ? `≥ ${min}` : `≤ ${max}`
      }`;
  }).join(words.or);
}

/** JSON on one line, spaced the way poly's formatter spaces an inline value. */
function compact(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(compact).join(", ")}]`;
  }
  if (isObject(value)) {
    const pairs = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${compact(v)}`);
    return pairs.length === 0 ? "{}" : `{ ${pairs.join(", ")} }`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A manifest description as comment prose: setting links and markdown links unwrapped. */
function plain(text: string): string {
  return text
    .replace(/#(poly\.[\w.]+)#/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

function ref(value: string): string {
  return /^%(.+)%$/.exec(value)?.[1] ?? "";
}

/** `text` as `//` lines no wider than WIDTH, breaking at spaces or between CJK characters. */
function comment(text: string, pad: string): string[] {
  const room = Math.max(40, WIDTH - pad.length - 3);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const token of paragraph.match(/[\u2e80-\uffff]|[^\s\u2e80-\uffff]+|\s+/g) ?? []) {
      if (line.trim() !== "" && columns(line + token) > room && !CLOSING.includes(token)) {
        lines.push(line.trimEnd());
        line = token.trim() === "" ? "" : token;
      } else {
        line += token;
      }
    }
    if (line.trim() !== "") {
      lines.push(line.trimEnd());
    }
  }
  return lines.map((line) => `${pad}// ${line}`);
}

/** Punctuation a line must not start with, so it stays on the line before. */
const CLOSING = "，。、；：！？）」』】》";

function columns(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch)
      ? 2
      : 1;
  }
  return width;
}

export function withValue(current: unknown, path: string[], value: unknown): Record<string, unknown> {
  const root: Record<string, unknown> = isObject(current) ? structuredClone(current) : {};
  let node = root;
  for (const segment of path.slice(0, -1)) {
    const next = node[segment];
    node = node[segment] = isObject(next) ? next : {};
  }
  const last = path[path.length - 1];
  if (value === undefined) {
    delete node[last];
  } else {
    node[last] = value;
  }
  return root;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

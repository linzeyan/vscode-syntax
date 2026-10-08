import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { parse, type ParseError } from "jsonc-parser";

import { PolySchema, rewrite, settingsOf, WORDS } from "./settingsBlock";

// The real manifest and its Chinese strings: the block is generated from them,
// so a key added there is a key these tests generate.
const root = path.join(__dirname, "..", "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const POLY: PolySchema = manifest.contributes.configuration.properties.poly;
const STRINGS = {
  ...JSON.parse(readFileSync(path.join(root, "package.nls.json"), "utf8")),
  ...JSON.parse(readFileSync(path.join(root, "package.nls.zh-tw.json"), "utf8")),
};
const write = (text: string, change?: { key: string; value: unknown }) =>
  rewrite(text, POLY, STRINGS, WORDS.zh, change);

const USER = `{
  // Someone else's comment, which has to survive.
  "editor.tabSize": 2,
  "files.eol": "\\n"
}
`;

function jsonc(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  assert.deepEqual(errors, [], "the rewritten file has to parse");
  return value;
}

/** Every leaf the user set, by dotted name: the block's groups alone set nothing. */
function setKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([k, v]) =>
    v !== null && typeof v === "object" && !Array.isArray(v) && !settingsOf(POLY).has(prefix + k)
      ? setKeys(v, `${prefix}${k}.`)
      : [prefix + k]
  );
}

test("every setting has a default in the one object VSCode reads them from", () => {
  // A key the manifest left without one used to get the editor's type default;
  // inside an object setting it gets nothing, and the vendored code reads whole
  // sections expecting every key to be there.
  const missing = [...settingsOf(POLY)].filter(([, { default: value }]) => value === undefined).map(([key]) => key);
  assert.deepEqual(missing, []);
});

test("a fresh block names every setting, sets none of them, and leaves the rest of the file alone", () => {
  const out = write(USER);
  assert.ok(out.startsWith(USER.slice(0, USER.indexOf("\"files.eol\""))), out.slice(0, 200));
  const parsed = jsonc(out);
  assert.equal(parsed["files.eol"], "\n");
  assert.deepEqual(setKeys(parsed.poly), [], "an unset key must stay a comment, not a pinned default");
  for (const key of settingsOf(POLY).keys()) {
    const name = key.split(".").pop()!;
    assert.ok(out.includes(`"${name}": `), `${key} is missing from the block`);
  }
});

test("rewriting is a fixed point, so activation never touches a file that is already current", () => {
  const once = write(USER);
  assert.equal(write(once), once);
  const set = write(once, { key: "format.enabled", value: false });
  assert.equal(write(set), set);
});

test("a value set through the block is live, kept on rewrite, and unsetting it restores the comment", () => {
  const fresh = write(USER);
  const set = write(fresh, { key: "format.enabled", value: false });
  assert.deepEqual(setKeys(jsonc(set).poly), ["format.enabled"]);
  // An object value keeps its shape too.
  const tools = write(set, { key: "tools", value: { ruff: "off" } });
  assert.deepEqual((jsonc(tools).poly as { tools: unknown }).tools, { ruff: "off" });
  assert.equal(
    write(write(tools, { key: "tools", value: undefined }), { key: "format.enabled", value: undefined }),
    fresh,
  );
});

// A setting an older version had, or a misspelled one: either way the user
// wrote it, and only they can tell which.
test("a key poly does not know is kept, not silently dropped", () => {
  const retired = write(USER).replace("\"poly\": {", "\"poly\": {\n    \"languageServers\": true,");
  const out = write(retired);
  assert.equal((jsonc(out).poly as Record<string, unknown>).languageServers, true);
  assert.ok(out.includes(WORDS.zh.unknown));
});

test("uncommenting any one-line default gives valid settings that set exactly that key", () => {
  const out = write(USER);
  const lines = out.split("\n");
  let tried = 0;
  lines.forEach((line, i) => {
    const match = /^(\s*)\/\/ ("[^"]+": .*,)$/.exec(line);
    if (!match) {
      return;
    }
    tried += 1;
    const edited = [...lines.slice(0, i), match[1] + match[2], ...lines.slice(i + 1)].join("\n");
    assert.equal(setKeys(jsonc(edited).poly).length, 1, line);
  });
  assert.ok(tried > 200, `only ${tried} commented-out keys found`);
});

test("a Windows file stays CRLF", () => {
  const out = write(USER.replace(/\n/g, "\r\n"));
  assert.ok(!/[^\r]\n/.test(out), "a bare LF was mixed in");
});

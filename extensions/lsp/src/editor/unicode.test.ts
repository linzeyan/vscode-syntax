import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { drawsNothing, explain, findSuspects, label, levelOf, Rule, SUSPECTS } from "./unicode";

/** The four tables `unicode::check` reads, parsed out of the Rust source. */
function rustTables(): string[] {
  const source = readFileSync(
    path.resolve(__dirname, "../../../../cli/crates/poly-engines/src/unicode.rs"),
    "utf8",
  );
  const rules: Record<string, Rule> = {
    INVISIBLE: "invisible",
    BIDI: "bidi",
    SPACES: "space",
    LOOKALIKE: "lookalike",
  };
  const rows: string[] = [];
  for (const [table, rule] of Object.entries(rules)) {
    const block = new RegExp(`const ${table}: &\\[[^=]*= &\\[([\\s\\S]*?)\\n\\];`).exec(source);
    assert.ok(block, `unicode.rs no longer has a ${table} table in the shape this reads`);
    const entry = /'\\u\{([0-9A-Fa-f]+)\}'(?:, '(\\'|.)')?\)?,\s*\/\/ (.+)$/gm;
    for (const [, hex, ascii, name] of block[1].matchAll(entry)) {
      rows.push(`${parseInt(hex, 16)} ${rule} ${ascii?.replace("\\'", "'") ?? ""} ${name.trim()}`);
    }
  }
  return rows.sort();
}

test("the table is unicode.rs's, so the highlight and the lint name the same characters", () => {
  const ours = [...SUSPECTS.values()]
    .map((s) => `${s.codePoint} ${s.rule} ${s.ascii ?? ""} ${s.name}`)
    .sort();
  const theirs = rustTables();
  // A parse that read nothing would make the comparison vacuous.
  assert.ok(theirs.length >= 50, `read only ${theirs.length} rows out of unicode.rs`);
  assert.deepEqual(ours, theirs);
});

/**
 * gremlins 0.26.0's default list, with its level and its `zeroWidth`. Someone
 * who uninstalls gremlins for poly should find every one of these still
 * marked, in the colour they learned it by, and still visible when it has no
 * width to fill.
 */
const GREMLINS: readonly [number, string, boolean][] = [
  [0x2013, "warning", false],
  [0x2018, "warning", false],
  [0x2019, "warning", false],
  [0x2029, "error", true],
  [0x0003, "warning", false],
  [0x000b, "warning", false],
  [0x00a0, "info", false],
  [0x00ad, "info", false],
  [0x200b, "error", true],
  [0x200c, "warning", true],
  [0x200e, "error", true],
  [0x201c, "warning", false],
  [0x201d, "warning", false],
  [0x202c, "error", true],
  [0x202d, "error", true],
  [0x202e, "error", true],
  [0xfffc, "error", true],
];

test("every gremlins default is marked at gremlins' level", () => {
  for (const [codePoint, level, zeroWidth] of GREMLINS) {
    const suspect = SUSPECTS.get(codePoint);
    const hex = codePoint.toString(16);
    assert.ok(suspect, `U+${hex} is in gremlins' defaults and not in the table`);
    assert.equal(levelOf(suspect), level, `U+${hex}`);
    if (zeroWidth) {
      assert.ok(drawsNothing(suspect), `U+${hex} has no width, so a background would not show`);
    }
  }
});

test("the Trojan Source isolates are errors, like the overrides beside them", () => {
  for (const codePoint of [0x2066, 0x2067, 0x2068, 0x2069]) {
    assert.equal(levelOf(SUSPECTS.get(codePoint)!), "error");
  }
});

test("offsets are UTF-16, so they land where positionAt puts them", () => {
  // The emoji is two UTF-16 units, which is the case a code-point count gets
  // wrong by one.
  const found = findSuspects("\u{1F600}a\u200bb\u2013c\n\u2028");
  assert.deepEqual(
    found.map((f) => [f.offset, f.suspect.codePoint]),
    [[3, 0x200b], [5, 0x2013], [8, 0x2028]],
  );
});

test("a byte order mark is exempt only as the first character", () => {
  assert.deepEqual(findSuspects("\ufeffx"), []);
  assert.deepEqual(findSuspects("x\ufeff").map((f) => f.offset), [1]);
});

test("an em dash is prose, not a lookalike", () => {
  assert.deepEqual(findSuspects("a\u2014b"), []);
});

test("a line's label names each character once, in the order they appear", () => {
  // Two quoted words, a zero-width space inside the first: five suspects,
  // three characters. Naming a quote twice would say nothing the fill does not.
  const suspects = findSuspects("\u201ca\u200bb\u201d \u201cc\u201d").map((f) => f.suspect);
  assert.equal(suspects.length, 5);
  assert.equal(
    label(suspects),
    "U+201C LEFT DOUBLE QUOTATION MARK · U+200B ZERO WIDTH SPACE · U+201D RIGHT DOUBLE QUOTATION MARK",
  );
});

test("the hover names the character and what it stands in for", () => {
  assert.equal(
    explain(SUSPECTS.get(0x2019)!),
    "U+2019 RIGHT SINGLE QUOTATION MARK reads as `'` and is not `'`",
  );
  assert.equal(explain(SUSPECTS.get(0x200b)!), "U+200B ZERO WIDTH SPACE does not render as what it is");
});

import * as assert from "node:assert";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { type Correction, corrections, lineEdits } from "./autocorrect";

/** `text` with every correction applied, last first so offsets hold. */
function applied(text: string, found: Correction[]): string {
  const lines = text.split("\n");
  for (const one of [...found].reverse()) {
    assert.strictEqual(one.line, one.endLine, "a fixture finding spans lines");
    const line = lines[one.line];
    lines[one.line] = line.slice(0, one.character) + one.replacement + line.slice(one.endCharacter);
  }
  return lines.join("\n");
}

test("a column after an emoji lands on the text it names", () => {
  // The engine's column counts characters and the editor's counts UTF-16
  // units; two emoji earlier on the line put them two apart. Taken as-is, the
  // quick fix would start two units early, on the `= ` before the string, and
  // leave the string's last two characters behind.
  const text = "const e = \"😀😀\"; const a = \"字符串string\";\n";
  const found = corrections(text, [
    { l: 1, c: 27, old: "\"字符串string\"", new: "\"字符串 string\"", severity: 1 },
  ]);
  assert.deepStrictEqual(found.map(({ character, endCharacter }) => [character, endCharacter]), [[28, 39]]);
  assert.strictEqual(applied(text, found), "const e = \"😀😀\"; const a = \"字符串 string\";\n");
});

test("a finding that is not where it says is dropped, not applied", () => {
  // A quick fix replaces its range without looking. If the document moved on
  // since the engine read it, the range holds other text now, and replacing
  // that is how a correction becomes a corruption.
  const text = "第一行\n测试test文本\n";
  assert.deepStrictEqual(corrections(text, [{ l: 2, c: 3, old: "测试test", new: "测试 test", severity: 1 }]), []);
  assert.deepStrictEqual(corrections(text, [{ l: 9, c: 1, old: "测试", new: "测", severity: 1 }]), []);
  assert.strictEqual(corrections(text, [{ l: 2, c: 1, old: "测试test", new: "测试 test", severity: 1 }]).length, 1);
});

test("a rule set to warning is the extension's Spellcheck, the rest are AutoCorrect", () => {
  const text = "测试test\n";
  const [error] = corrections(text, [{ l: 1, c: 1, old: "测试test", new: "测试 test", severity: 1 }]);
  const [warning] = corrections(text, [{ l: 1, c: 1, old: "测试test", new: "测试 test", severity: 2 }]);
  assert.strictEqual(error.spelling, false);
  assert.strictEqual(warning.spelling, true);
});

test("fix on save touches only the lines it changes, whatever the line endings", () => {
  // Replacing the whole document would move the cursor and drop every fold;
  // the lines that did not change should not be edited at all.
  assert.deepStrictEqual(lineEdits("a\r\n测试test\r\nb\r\n", "a\r\n测试 test\r\nb\r\n"), [
    { line: 1, text: "测试 test" },
  ]);
  assert.deepStrictEqual(lineEdits("same\n", "same\n"), []);
  assert.strictEqual(lineEdits("one\n", "one\ntwo\n"), null);
});

test("every quick fix applied gives what fix on save gives", () => {
  // The two paths ask the engine different questions -- lint for the quick
  // fixes, format for the save -- and a user who fixes each finding by hand
  // has to end up with the file a save would have written. This runs the real
  // engine, through the same wiring the extension bundles.
  copyFileSync(require.resolve("@huacnlee/autocorrect/autocorrect_bg.wasm"), join(__dirname, "autocorrect_bg.wasm"));
  const engine: typeof import("./autocorrectEngine") = require("./autocorrectEngine");
  const files: [string, string][] = [
    ["notes.md", "# 标题title\n\n测试test文本，😀emoji中文abc。\n\n```js\n// 代码code\n```\n"],
    ["app.ts", "const e = \"😀😀\"; const a = \"字符串string\";\n// 注释comment\n"],
    ["tool.py", "# 说明note\nprint(\"你好world\")\n"],
  ];
  for (const [name, text] of files) {
    const lint = engine.lintFor(text, name);
    assert.strictEqual(lint.error, "", name);
    const found = corrections(text, lint.lines);
    assert.strictEqual(found.length, lint.lines.length, `${name}: a finding did not land`);
    assert.ok(found.length > 0, `${name}: the fixture has nothing to correct`);
    assert.strictEqual(applied(text, found), engine.formatFor(text, name).out, name);
  }
});

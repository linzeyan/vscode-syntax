import * as assert from "node:assert";
import { test } from "node:test";

import { convert } from "./chinese";

test("the Taiwan pair rewrites vocabulary and the plain pair does not", () => {
  // The difference between the two pairs is the reason there are four
  // commands: 鼠标/软件 is 鼠標/軟件 character for character and 滑鼠/軟體 in
  // Taiwan. A phrase dictionary in the plain pair, or none in the Taiwan one,
  // and two of the commands become the same command.
  assert.strictEqual(convert("toTraditionalChinese", "鼠标里的软件"), "鼠標裡的軟件");
  assert.strictEqual(convert("toTraditionalChineseTaiwan", "鼠标里的软件"), "滑鼠裡的軟體");
  assert.strictEqual(convert("toSimplifiedChinese", "滑鼠裡的軟體"), "滑鼠里的软体");
  assert.strictEqual(convert("toSimplifiedChineseTaiwan", "滑鼠裡的軟體"), "鼠标里的软件");
});

test("traditional means Taiwan's character forms", () => {
  // OpenCC's own traditional writes 裏 and 着, which is not what someone in
  // Taiwan converting a document wants back.
  assert.strictEqual(convert("toTraditionalChinese", "里面很着急"), "裡面很著急");
});

test("everything that is not Chinese comes back as it went in", () => {
  // The command converts a whole file when nothing is selected, and a file is
  // mostly code: identifiers, punctuation and line endings must survive it.
  const code = "const label = \"软件\"; // TODO: 着急\r\n\tif (a < b) { return `${x}`; }\n";
  assert.strictEqual(
    convert("toTraditionalChineseTaiwan", code),
    "const label = \"軟體\"; // TODO: 著急\r\n\tif (a < b) { return `${x}`; }\n",
  );
});

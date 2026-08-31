import * as assert from "node:assert/strict";
import { test } from "node:test";

import { imageReferences } from "./images";

const paths = (line: string) => imageReferences(line).map((r) => r.path);

test("a path is found however the language spells it", () => {
  assert.deepEqual(paths("![alt](img/a.png)"), ["img/a.png"]);
  assert.deepEqual(paths("<img src=\"../assets/b.JPG\" />"), ["../assets/b.JPG"]);
  assert.deepEqual(paths("background: url(./c.svg) no-repeat;"), ["./c.svg"]);
  assert.deepEqual(paths("const icon = \"assets/icon.ico\";"), ["assets/icon.ico"]);
  assert.deepEqual(paths("two: a.gif and b.webp"), ["a.gif", "b.webp"]);
});

test("an extension that only starts like an image is not one", () => {
  assert.deepEqual(paths("a.pngx"), []);
  assert.deepEqual(paths("notes.txt"), []);
  assert.deepEqual(paths("no extension here"), []);
});

test("a URL contributes its path, which simply will not resolve on disk", () => {
  // Cheaper than teaching the pattern about schemes: the file check that
  // follows rejects it, and rejecting it there costs one stat.
  assert.deepEqual(paths("https://example.com/logo.png"), [
    "//example.com/logo.png",
  ]);
});

test("offsets point at the path, not the syntax around it", () => {
  const [ref] = imageReferences("![alt](img/a.png)");
  assert.equal(ref.start, 7);
  assert.equal("![alt](img/a.png)".slice(ref.start, ref.end), "img/a.png");
});

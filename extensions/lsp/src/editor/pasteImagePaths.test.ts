import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { expand, imageFileName, imagePath, insertion, Settings } from "./pasteImagePaths";

// The manifest's defaults, so that a default changed there is a default
// changed here.
const manifest = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
const DEFAULTS = Object.fromEntries(
  Object.entries(manifest.contributes.configuration.properties as Record<string, { default: unknown }>)
    .filter(([key]) => key.startsWith("poly.pasteImage."))
    .map(([key, { default: value }]) => [key.slice("poly.pasteImage.".length), value]),
) as unknown as Settings;

const FILE = "/work/docs/guide.md";
const ROOT = "/work";
const NOW = new Date(2026, 8, 28, 9, 5, 7);

function paste(overrides: Partial<Settings>, selection = "", markup: "markdown" | "asciidoc" | undefined = "markdown") {
  const settings = expand({ ...DEFAULTS, ...overrides }, FILE, ROOT);
  const image = imagePath(settings, FILE, imageFileName(settings, selection, NOW));
  return { image, text: insertion(settings, markup, image) };
}

test("by default the image goes beside the file, named for the time, and the link is just its name", () => {
  assert.deepEqual(paste({}), {
    image: "/work/docs/2026-09-28-09-05-07.png",
    text: "![](2026-09-28-09-05-07.png)",
  });
});

test("selected text names the image, and a relative folder is from the file's", () => {
  assert.deepEqual(paste({ path: "images" }, "login screen"), {
    image: "/work/docs/images/login screen.png",
    // A space would end a markdown link's destination.
    text: "![](images/login%20screen.png)",
  });
});

test("the variables reach the folder, the name and the base path", () => {
  const { image, text } = paste({
    path: "${projectRoot}/assets/${currentFileNameWithoutExt}",
    basePath: "${projectRoot}",
    namePrefix: "${currentFileNameWithoutExt}-",
    prefix: "/",
  }, "fig");
  assert.equal(image, "/work/assets/guide/guide-fig.png");
  assert.equal(text, "![](/assets/guide/guide-fig.png)");
});

// Upstream's reason for escaping them: a file whose name is made of moment
// tokens would otherwise be pasted under a date.
test("a file name in defaultName is not read as a date format", () => {
  const settings = expand({ ...DEFAULTS, defaultName: "${currentFileNameWithoutExt}-HH" }, "/w/MMMM.md", ROOT);
  assert.equal(imageFileName(settings, "", NOW), "MMMM-09.png");
});

test("a `$` in a folder name stays as written", () => {
  const settings = expand({ ...DEFAULTS, path: "${currentFileDir}/img" }, "/w/$&dir/a.md", ROOT);
  assert.equal(settings.path, "/w/$&dir/img");
});

test("an empty basePath inserts the absolute path, and urlEncode encodes more than spaces", () => {
  assert.equal(paste({ basePath: "", encodePath: "urlEncode" }, "café").text, "![](/work/docs/caf%C3%A9.png)");
  assert.equal(paste({ basePath: "", encodePath: "none" }, "a b").text, "![](/work/docs/a b.png)");
});

test("AsciiDoc gets its own image syntax, and other files the bare path", () => {
  assert.equal(paste({}, "x", "asciidoc").text, "image::x.png[]");
  assert.equal(insertion(expand(DEFAULTS, FILE, ROOT), undefined, "/work/docs/x.png"), "x.png");
});

test("insertPattern can name the parts of the path", () => {
  const pattern = "<img src=\"${imageFilePath}\" alt=\"${imageFileNameWithoutExt}\"> ${imageFileName} ${unknown}";
  assert.equal(
    paste({ insertPattern: pattern, path: "img" }, "a b").text,
    "<img src=\"img/a%20b.png\" alt=\"a b\"> a b.png ${unknown}",
  );
});

test("a folder setting with a space at an end is refused, not guessed at", () => {
  assert.throws(() => expand({ ...DEFAULTS, path: "images " }, FILE, ROOT), /poly\.pasteImage\.path/);
  assert.throws(() => expand({ ...DEFAULTS, basePath: " /x" }, FILE, ROOT), /poly\.pasteImage\.basePath/);
});

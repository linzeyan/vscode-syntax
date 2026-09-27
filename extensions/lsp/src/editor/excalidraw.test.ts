import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { contentTypeOf, excalidrawHtml, imageParams, isScene, LANGUAGES, sceneName, SCENES } from "./excalidraw";

const ROOT = path.join(__dirname, "..", "..");

test("a scene is saved back in the format its name says", () => {
  // The page writes what it was told it read: SVG to an SVG, a PNG to a PNG.
  // JSON in a `.excalidraw.svg` would open, and then be saved as an SVG.
  assert.equal(contentTypeOf("docs/flow.excalidraw.svg"), "image/svg+xml");
  assert.equal(contentTypeOf("C:\\docs\\FLOW.EXCALIDRAW.PNG"), "image/png");
  assert.equal(contentTypeOf("flow.excalidraw"), "application/json");
  assert.equal(contentTypeOf("flow.excalidraw.json"), "application/json");
});

test("the name offered on export is the drawing's, not the file's", () => {
  assert.equal(sceneName("/docs/flow.excalidraw.svg"), "flow");
  assert.equal(sceneName("C:\\docs\\flow.excalidraw"), "flow");
  assert.equal(sceneName("/docs/v1.2.excalidraw.json"), "v1.2");
});

test("the editor opens exactly the files the manifest gives it", () => {
  // A link to a scene opens in the editor; a scene the manifest does not
  // select would open in a text editor from a link and nowhere else.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const editor = pkg.contributes.customEditors.find((e: { viewType: string }) => e.viewType === "poly.excalidraw");
  const selected = editor.selector.map((s: { filenamePattern: string }) => s.filenamePattern.replace(/^\*/, ""));
  assert.deepEqual(selected, SCENES);
  assert.ok(isScene("a/B.Excalidraw.SVG"));
  assert.ok(!isScene("a/excalidraw.svg"));
});

test("every display language maps to a language Excalidraw has", () => {
  // Excalidraw ships a file per language and falls back to English for a code
  // it has none for, silently: pomdtr's ja-JA gave Japanese users English.
  const locales = fs
    .readdirSync(path.join(ROOT, "node_modules/@excalidraw/excalidraw/dist/prod/locales"))
    .map((file) => file.replace(/-[A-Z0-9]{8}\.js$/, ""));
  for (const [display, code] of Object.entries(LANGUAGES)) {
    assert.ok(code === "en" || locales.includes(code), `${display} -> ${code}`);
  }
});

test("the background switch reaches the export", () => {
  // Excalidraw reads exportBackground; the setting is called
  // exportWithBackground, and passed through as it was it did nothing.
  assert.equal(imageParams({ exportWithBackground: false }).exportBackground, false);
  assert.deepEqual(imageParams(undefined), { exportScale: 1, exportBackground: true, exportWithDarkMode: false });
});

test("the scene reaches the page intact", () => {
  // It goes in an attribute: a quote in a label must not end it, and the page
  // decodes UTF-8, so a label in any script must come back the same.
  const config = { name: "say \"繁體\"", content: [1, 2, 3] };
  const html = excalidrawHtml({
    config,
    script: "s.js",
    style: "s.css",
    assets: "https://x/",
    cspSource: "vscode-resource:",
    nonce: "abc",
  });
  const attribute = /data-excalidraw-config="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.deepEqual(JSON.parse(Buffer.from(attribute, "base64").toString("utf8")), config);
  // Both scripts run under the CSP: a nonce missing from either is a blank page.
  assert.equal(html.match(/<script nonce="abc"/g)?.length, 2);
});

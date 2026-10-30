import * as assert from "node:assert/strict";
import { test } from "node:test";

import { generate, sourceOf } from "./quicktype";
import { LANGUAGE_TARGETS, looksLikeToml, mightBeData, placeGo } from "./pasteTypesOps";
import { TARGETS } from "./quicktype";

const FILE = `package api

import (
\t"encoding/json"
\t"fmt"
)

func existing() {}
`;

// quicktype's Go is a whole file. Pasted under other declarations as is, its
// package clause and imports are syntax errors, which is the one way this
// feature can leave the user worse off than a plain paste.
test("Go output loses its package clause and its imports join the file's", () => {
  const output = `// header\n\npackage main\n\nimport "time"\n\nimport "encoding/json"\n\ntype TopLevel struct {\n\tAt time.Time\n}\n`;
  const placed = placeGo(output, FILE);
  assert.ok(!/^package /m.test(placed.body));
  assert.ok(!/^import /m.test(placed.body));
  assert.match(placed.body, /^\/\/ header\n\ntype TopLevel struct/);
  // encoding/json is already imported; time is not, and goes after the block.
  assert.deepEqual(placed.imports, { line: 6, text: `import "time"\n` });
});

test("an import block in quicktype's output is read too", () => {
  const placed = placeGo(`import (\n\t"time"\n\t"fmt"\n)\n\ntype T struct{}\n`, FILE);
  assert.deepEqual(placed.imports, { line: 6, text: `import "time"\n` });
  assert.equal(placed.body, "type T struct{}\n");
});

test("a file with no imports gets them under its package clause, a blank line apart", () => {
  const placed = placeGo(`import "time"\n\ntype T struct{}\n`, "// doc\npackage api\n\nfunc f() {}\n");
  assert.deepEqual(placed.imports, { line: 2, text: `\nimport "time"\n` });
});

test("nothing to import, nothing added", () => {
  assert.equal(placeGo("type T struct{}\n", FILE).imports, undefined);
});

test("into an empty file the output goes whole: it is the file", () => {
  const output = `package main\n\nimport "time"\n\ntype T struct{ At time.Time }\n`;
  assert.deepEqual(placeGo(output, ""), { body: output });
});

// The TOML reader is a 17 MB wasm; a pasted Go assignment must not load it.
test("TOML is told by its first line: a table, or a key given a literal", () => {
  assert.ok(looksLikeToml("[server]\nport = 8080\n"));
  assert.ok(looksLikeToml("# config\n\n[[items]]\nname = \"a\"\n"));
  assert.ok(looksLikeToml("title = \"poly\"\n"));
  assert.ok(looksLikeToml("port = 8080\n"));
  assert.ok(looksLikeToml("enabled = true\n"));
  assert.ok(!looksLikeToml("x = foo()\n"));
  assert.ok(!looksLikeToml("err = nil\n"));
  assert.ok(!looksLikeToml("name: poly\n"));
  assert.ok(!looksLikeToml(""));
});

test("only text that could be data loads quicktype", () => {
  assert.ok(mightBeData(`{"a": 1}`));
  assert.ok(mightBeData("  [1, 2]"));
  assert.ok(mightBeData("name: poly\nport: 1\n"));
  assert.ok(mightBeData("[server]\nport = 1\n"));
  assert.ok(!mightBeData("fmt.Println(x)\n"));
  assert.ok(!mightBeData("if err != nil {\n\treturn err\n}\n"));
});

test("every language offered in the paste widget is one quicktype writes", () => {
  const names = new Set(TARGETS.map((target) => target.name));
  for (const [language, targets] of Object.entries(LANGUAGE_TARGETS)) {
    for (const target of targets) assert.ok(names.has(target), `${language} offers ${target}`);
  }
});

test("JSON, YAML and TOML are read as the same data", () => {
  const json = sourceOf(`{"name": "poly", "port": 8080}`);
  assert.deepEqual(json, { kind: "json", json: `{"name":"poly","port":8080}` });
  assert.deepEqual(sourceOf("name: poly\nport: 8080\n"), json);
  // TOML through the reader passed in, and only once YAML has refused.
  const toml = (text: string) => (text.includes("=") ? { name: "poly", port: 8080 } : undefined);
  assert.deepEqual(sourceOf(`name = "poly"\nport = 8080\n`, toml), json);
});

test("prose, a scalar or code is not data", () => {
  assert.equal(sourceOf("just a sentence"), undefined);
  assert.equal(sourceOf("42"), undefined);
  assert.equal(sourceOf("x := 1\nfmt.Println(x)"), undefined);
});

// Read as a sample, a schema becomes types describing `type` and `properties`.
test("a JSON Schema is read as a schema", () => {
  assert.equal(sourceOf(`{"$schema": "https://json-schema.org/draft/2020-12/schema"}`)?.kind, "schema");
  assert.equal(sourceOf(`{"type": "object", "properties": {"a": {"type": "string"}}}`)?.kind, "schema");
  assert.equal(sourceOf(`{"type": "object", "properties": 3}`)?.kind, "json");
});

test("Go types from a sample, pasted into a file, keep the file compiling", async () => {
  const source = sourceOf(`{"id": 1, "created_at": "2024-01-01T00:00:00Z", "owner": {"email": "a@b.c"}}`)!;
  const types = await generate(source, "go", true, "\t");
  assert.match(types, /type TopLevel struct \{/);
  assert.match(types, /type Owner struct \{/);
  assert.match(types, /CreatedAt time\.Time/);
  const placed = placeGo(await generate(source, "go", false, "\t"), FILE);
  assert.match(placed.body, /func UnmarshalTopLevel/);
  assert.ok(!/^(package|import) /m.test(placed.body));
  assert.deepEqual(placed.imports, { line: 6, text: `import "time"\n` });
});

test("a language without a types-only mode still writes its types", async () => {
  const source = sourceOf(`{"id": 1}`)!;
  assert.match(await generate(source, "rust", true, "    "), /pub struct TopLevel/);
  assert.match(await generate(source, "typescript", true, "  "), /export interface TopLevel \{\n {2}id: number;/);
});

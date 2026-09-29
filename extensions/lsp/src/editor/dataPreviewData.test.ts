import { Int32Vector, Table, Utf8Vector } from "apache-arrow";
import * as avro from "avsc";
import * as assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ParquetSchema, ParquetWriter } from "parquets";
import * as xlsx from "xlsx";

import { convertJsonData, csvToMarkdownTable, getData, markdownToCsv, NotSaved, saveData } from "./dataPreviewData";

const OPTIONS = { dataTable: "", createJsonFiles: false, createJsonSchema: false };

const scratch = () => mkdtempSync(path.join(tmpdir(), "poly-data-preview-"));

const arrowBytes = () => Table.new({ id: Int32Vector.from([1, 2]), name: Utf8Vector.from(["a", "b"]) }).serialize();

test("an object's false, 0 and empty values are rows, not dropped", () => {
  // Upstream kept only truthy leaves, so a settings file showed no row for
  // any switch that was off.
  assert.deepEqual(convertJsonData({ server: { tls: false, retries: 0 }, name: "", gone: null }), [
    { key: "server.tls", value: "false" },
    { key: "server.retries", value: "0" },
    { key: "name", value: "" },
  ]);
});

test("an array's nested fields are spread into columns", () => {
  assert.deepEqual(convertJsonData([{ id: 1, owner: { name: "a" } }]), [{ id: 1, "owner.name": "a" }]);
});

const TWO_TABLES = `# Prices

| item | price |
| ---- | ----: |
| tea, green | 3 |
| "house" blend | 4 |

# Stock

| item | count |
|------|-------|
| tea | 10 |

`;

test("each Markdown table is named for its section, and the first is loaded", () => {
  const { csv, tableNames } = markdownToCsv(TWO_TABLES, "");
  assert.deepEqual(tableNames, ["Prices", "Stock"]);
  // A comma or a quote in a cell must not split it or end it.
  assert.equal(csv, "item,price\n\"tea, green\",3\n\"\"\"house\"\" blend\",4\n");
});

test("a Markdown table is picked by its name, and one table alone is not listed", () => {
  assert.equal(markdownToCsv(TWO_TABLES, "Stock").csv, "item,count\ntea,10\n");
  assert.deepEqual(markdownToCsv(TWO_TABLES.split("# Stock")[0], "").tableNames, []);
});

test("CSV saved as Markdown lines up its columns under a header", () => {
  assert.equal(
    csvToMarkdownTable("name,note\ntea,\"a, b\""),
    "| name | note | \n|------|------| \n| tea  | a, b | \n",
  );
});

test("a file the preview does not read is refused, however much of its name looks like one", async () => {
  // Upstream's unanchored pattern took `vite.config.ts` for a .config file.
  const dir = scratch();
  const file = path.join(dir, "vite.config.ts");
  writeFileSync(file, "export default {}");
  const { data, errors } = await getData(file, OPTIONS);
  assert.deepEqual(data, []);
  assert.deepEqual(errors, [`${file} is not a supported data file for Data Preview!`]);
});

test("nothing is written beside a remote file", async () => {
  // A URL is not a folder: upstream's attempt failed without a word, and
  // poly's own would have been an error toast on every remote Arrow file.
  const server = createServer((_, response) => response.end(arrowBytes()));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const { port } = server.address() as AddressInfo;
    const loaded = await getData(`http://127.0.0.1:${port}/rows.arrow`, { ...OPTIONS, createJsonSchema: true });
    assert.deepEqual([loaded.schema, loaded.errors], [{ id: "integer", name: "string" }, []]);
  } finally {
    server.close();
  }
});

test("JSON with comments and trailing commas loads, and a broken file says where", async () => {
  const dir = scratch();
  const good = path.join(dir, "good.json");
  writeFileSync(good, "[{\"a\": 1,}, // one\n{\"a\": 2}]");
  assert.deepEqual(await getData(good, OPTIONS), {
    data: [{ a: 1 }, { a: 2 }],
    tableNames: [],
    schema: null,
    errors: [],
  });
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, "{\"a\": }");
  assert.match((await getData(bad, OPTIONS)).errors[0], /ValueExpected at 6 of 1 length/);
});

test("properties are saved one per line, a line break in a value continuing it", async () => {
  const file = path.join(scratch(), "app.properties");
  assert.equal(await saveData(file, [{ key: "a", value: "1" }, { key: "b", value: "x\ny" }], ""), true);
  assert.equal(readFileSync(file, "utf8"), "a=1\nb=x\\\ny\n");
  // The break is a continuation, so the file does not grow a key `y`.
  assert.deepEqual((await getData(file, OPTIONS)).data, [{ key: "a", value: "1" }, { key: "b", value: "xy" }]);
});

test("rows that are not key/value pairs are not saved as properties", async () => {
  const file = path.join(scratch(), "app.properties");
  await assert.rejects(saveData(file, [{ id: 1 }], ""), NotSaved);
  assert.equal(existsSync(file), false);
});

test("a workbook lists its sheets and loads the one asked for; what it saves reads back", async () => {
  const dir = scratch();
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, xlsx.utils.json_to_sheet([{ a: 1 }]), "First");
  xlsx.utils.book_append_sheet(book, xlsx.utils.json_to_sheet([{ b: "x" }]), "Second");
  const file = path.join(dir, "book.xlsx");
  writeFileSync(file, xlsx.write(book, { type: "buffer", bookType: "xlsx" }));
  const first = await getData(file, OPTIONS);
  assert.deepEqual([first.tableNames, first.data], [["First", "Second"], [{ a: 1 }]]);
  assert.deepEqual((await getData(file, { ...OPTIONS, dataTable: "Second" })).data, [{ b: "x" }]);

  const saved = path.join(dir, "saved.xlsx");
  assert.equal(await saveData(saved, [{ c: 2 }], "Filtered"), true);
  const again = await getData(saved, OPTIONS);
  assert.deepEqual([again.tableNames, again.data], [[], [{ c: 2 }]]);
});

test("an Arrow file goes to the page as its own bytes, with its columns typed for Perspective", async () => {
  const dir = scratch();
  const file = path.join(dir, "rows.arrow");
  const bytes = arrowBytes();
  writeFileSync(file, bytes);
  const loaded = await getData(file, { ...OPTIONS, createJsonSchema: true });
  assert.deepEqual(loaded.data, bytes);
  assert.deepEqual(loaded.schema, { id: "integer", name: "string" });
  assert.equal(existsSync(path.join(dir, "rows.schema.json")), true);
  // A schema file already there is the user's; it is not written over.
  writeFileSync(path.join(dir, "rows.schema.json"), "mine");
  await getData(file, { ...OPTIONS, createJsonSchema: true });
  assert.equal(readFileSync(path.join(dir, "rows.schema.json"), "utf8"), "mine");
});

test("an Avro file's records are rows, and its schema is written beside it", async () => {
  const dir = scratch();
  const file = path.join(dir, "rows.avro");
  const schema: avro.Schema = {
    type: "record",
    name: "Row",
    fields: [{ name: "id", type: "int" }, {
      name: "tag",
      type: { type: "record", name: "Tag", fields: [{ name: "v", type: "string" }] },
    }],
  };
  await new Promise((resolve, reject) => {
    const encoder = avro.createFileEncoder(file, schema).on("finish", resolve).on("error", reject);
    encoder.write({ id: 1, tag: { v: "x" } });
    encoder.end();
  });
  const loaded = await getData(file, { ...OPTIONS, createJsonSchema: true });
  assert.deepEqual(loaded.data, [{ id: "1", v: "x" }]);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "rows.schema.json"), "utf8")).name, "Row");
});

test("a Parquet file reads through the thrift the lockfile overrides to", async () => {
  // parquets asks for thrift ^0.12.0; pnpm-workspace.yaml puts 0.24 under it
  // for the advisories. Reading a file is what would break if that were wrong.
  const file = path.join(scratch(), "rows.parquet");
  const writer = await ParquetWriter.openFile(
    new ParquetSchema({ id: { type: "INT32" }, name: { type: "UTF8" } }),
    file,
  );
  await writer.appendRow({ id: 1, name: "a" });
  await writer.appendRow({ id: 2, name: "b" });
  await writer.close();
  assert.deepEqual((await getData(file, OPTIONS)).data, [{ id: 1, name: "a" }, { id: 2, name: "b" }]);
});

import * as assert from "node:assert/strict";
import { test } from "node:test";

import { convertedName, entries, fileKind, labelOf, numberBase, textFormatOf, timestampSource } from "./toolboxOps";

// A hex number written without its prefix is still hex: reading `ff` as
// decimal would be an error message, and `10` as hex would be a wrong answer
// nobody notices, so only a letter digit switches.
test("a number's base is read off its prefix, or its digits when it has none", () => {
  assert.equal(numberBase("0b1010"), "binary");
  assert.equal(numberBase("0o17"), "octal");
  assert.equal(numberBase("0xFF"), "hex");
  assert.equal(numberBase("-0x1f"), "hex");
  assert.equal(numberBase("deadbeef"), "hex");
  assert.equal(numberBase("255"), "decimal");
  assert.equal(numberBase(" 10 "), "decimal");
});

// The unit decides the date by a factor of a thousand: a millisecond epoch
// read as seconds lands some 50,000 years from now.
test("an epoch's unit follows its length, and text goes to the date parser", () => {
  assert.equal(timestampSource("1761696000"), "timestamp_seconds");
  assert.equal(timestampSource("0"), "timestamp_seconds");
  assert.equal(timestampSource("1761696000123"), "timestamp_milliseconds");
  assert.equal(timestampSource("1761696000123456"), "timestamp_microseconds");
  assert.equal(timestampSource("1761696000123456789"), "timestamp_nanoseconds");
  assert.equal(timestampSource("-86400"), "timestamp_seconds");
  assert.equal(timestampSource("2026-10-29T08:00:00Z"), "text");
});

test("a document's format comes from its language, and only for the ones transform reads", () => {
  assert.equal(textFormatOf("jsonc"), "JSON");
  assert.equal(textFormatOf("dockercompose"), "YAML");
  assert.equal(textFormatOf("protobuf"), "Protobuf");
  // Go Struct is something transform writes; a Go file is not data to read.
  assert.equal(textFormatOf("go"), undefined);
  assert.equal(textFormatOf("plaintext"), undefined);
});

// Offering a file its own format back would write over the file it came from.
test("a file is offered every target but its own format", () => {
  const csv = fileKind("/w/report.CSV");
  assert.equal(csv?.kind, "data");
  assert.equal(csv?.from, "csv");
  assert.ok(!csv?.targets.some((target) => target.extension === "csv"));
  // Feather is written back as Arrow IPC, which is the same file format.
  assert.ok(!fileKind("/w/t.feather")?.targets.some((target) => target.extension === "arrow"));
  assert.deepEqual(fileKind("/w/photo.jpeg")?.targets.map((target) => target.id), ["png", "webp", "avif"]);
  // transform writes AVIF but cannot decode one.
  assert.equal(fileKind("/w/photo.avif"), undefined);
  assert.equal(fileKind("/w/notes.txt"), undefined);
});

test("a converted file keeps its name and changes only the last extension", () => {
  assert.equal(convertedName("report.v2.csv", "parquet"), "report.v2.parquet");
  assert.equal(convertedName("Makefile", "json"), "Makefile.json");
});

test("a map from the wasm reads the same whether it came as a Map or an object", () => {
  const expected = [["hex", "ff"], ["decimal", "255"]];
  assert.deepEqual(entries(new Map(expected as [string, string][])), expected);
  assert.deepEqual(entries({ hex: "ff", decimal: "255", rows: 2 }), expected);
});

test("a result's name reads as the encoding, digest or format it is", () => {
  assert.equal(labelOf("base64_raw_url"), "Base64 URL, no padding");
  assert.equal(labelOf("sha1"), "SHA-1");
  assert.equal(labelOf("sha512_256"), "SHA-512/256");
  assert.equal(labelOf("sha3_224"), "SHA3-224");
  assert.equal(labelOf("crc32_ieee"), "CRC32 ieee");
  assert.equal(labelOf("md5"), "MD5");
  assert.equal(labelOf("browser_rfc2822"), "local RFC2822");
  assert.equal(labelOf("timestamp_seconds"), "timestamp seconds");
  assert.equal(labelOf("hex"), "hex");
});

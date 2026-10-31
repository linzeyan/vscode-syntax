import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  convertedName,
  entries,
  fileKind,
  labelOf,
  numberBase,
  placeLocally,
  textFormatOf,
  timestampEntries,
} from "./toolboxOps";

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

// A selected "2026-01-02 11:04" means 11:04 where the editor is, not in UTC;
// getting the offset wrong moves the answer by hours and still looks plausible.
test("a time without an offset is placed in the editor's zone, an instant keeps its own", () => {
  const zone = process.env.TZ;
  const reading = (seconds: number, zoned: boolean) => ({
    label: "",
    zoned,
    seconds: String(seconds),
    nanos: 0,
    relative: false,
  });
  const wall = Date.UTC(2026, 0, 2, 11, 4) / 1000;
  try {
    process.env.TZ = "Asia/Taipei";
    assert.deepEqual(placeLocally(reading(wall, false)), { seconds: String(wall - 8 * 3600), offset: 8 * 3600 });
    assert.deepEqual(placeLocally(reading(wall, true)), { seconds: String(wall), offset: 8 * 3600 });
    // 03:30 on 2026-03-08 is already daylight time in New York (the clocks
    // jumped from 02:00), though a first guess from 03:30 UTC says standard.
    process.env.TZ = "America/New_York";
    const spring = Date.UTC(2026, 2, 8, 3, 30) / 1000;
    assert.deepEqual(placeLocally(reading(spring, false)), { seconds: String(spring + 4 * 3600), offset: -4 * 3600 });
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("every written form of an instant is offered under a name that says which", () => {
  const text = { iso8601: "a", rfc3339: "b", rfc2822: "c", iso9075: "d", sql_datetime: "e", sql_date: "f" };
  const names = timestampEntries({
    unix: { seconds: "1", milliseconds: "2", microseconds: "3", nanoseconds: "4" },
    utc: text,
    http: "h",
    local: text,
  }).map(([name]) => labelOf(name));
  assert.deepEqual(names.slice(0, 2), ["unix seconds", "unix milliseconds"]);
  assert.ok(names.includes("UTC ISO8601") && names.includes("local SQL datetime") && names.includes("HTTP date"));
  assert.equal(new Set(names).size, names.length);
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
  assert.equal(labelOf("local_rfc2822"), "local RFC2822");
  assert.equal(labelOf("unix_seconds"), "unix seconds");
  assert.equal(labelOf("hex"), "hex");
});

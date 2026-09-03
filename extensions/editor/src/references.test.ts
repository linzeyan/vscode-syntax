import * as assert from "node:assert/strict";
import { test } from "node:test";

import { countElsewhere, implLabel, lensTargets, refLabel } from "./references";

// vscode.SymbolKind, by the numbers the provider actually hands over.
const FUNCTION = 11;
const STRUCT = 22;
const METHOD = 5;
const VARIABLE = 12;
const FIELD = 7;
const INTERFACE = 10;

interface TestSymbol {
  name: string;
  kind: number;
  children: TestSymbol[];
}

const symbol = (
  name: string,
  kind: number,
  children: TestSymbol[] = [],
): TestSymbol => ({ name, kind, children });

test("a file's declarations and the methods on them get a lens", () => {
  const file = [
    symbol("imageBaseURL", VARIABLE),
    symbol("imageURL", FUNCTION),
    symbol("Scraper", STRUCT, [symbol("Fetch", METHOD)]),
  ];
  assert.deepEqual(
    lensTargets(file, 100).map((t) => t.symbol.name),
    ["imageBaseURL", "imageURL", "Scraper", "Fetch"],
  );
});

test("a local inside a function gets nothing", () => {
  // Its references are already on screen, and a lens per local would bury the
  // ones worth reading.
  const file = [
    symbol("main", FUNCTION, [
      symbol("out", VARIABLE, [symbol("deeper", VARIABLE)]),
    ]),
  ];
  assert.deepEqual(lensTargets(file, 100).map((t) => t.symbol.name), ["main", "out"]);
});

test("fields are not counted", () => {
  // "who writes this field" is a different question from the one a count above
  // a declaration answers.
  const file = [symbol("Config", STRUCT, [symbol("Timeout", FIELD)])];
  assert.deepEqual(lensTargets(file, 100).map((t) => t.symbol.name), ["Config"]);
});

test("the cap holds, so a generated stub is not a wall of grey", () => {
  const many = Array.from({ length: 50 }, (_, i) => symbol(`f${i}`, FUNCTION));
  assert.equal(lensTargets(many, 10).length, 10);
  assert.deepEqual(lensTargets([], 10), []);
});

test("the declaration itself is not one of its references", () => {
  // executeReferenceProvider asks with includeDeclaration: true, so leaving it
  // in would put "1 ref" over something nothing uses -- the exact case the
  // count exists to make visible.
  const declaration = { uri: "file:///p/naming.go", line: 9 };
  const locations = [
    declaration,
    { uri: "file:///p/naming.go", line: 16 },
    { uri: "file:///p/scraper_test.go", line: 42 },
  ];
  assert.equal(countElsewhere(locations, declaration), 2);
  assert.equal(countElsewhere([declaration], declaration), 0);
  // Same line number in a different file is a different place.
  assert.equal(
    countElsewhere([{ uri: "file:///p/other.go", line: 9 }], declaration),
    1,
  );
});

test("the label says what the number means", () => {
  assert.equal(refLabel(0), "no refs");
  assert.equal(refLabel(1), "1 ref");
  assert.equal(refLabel(11), "11 refs");
  assert.equal(implLabel(0), "no impls");
  assert.equal(implLabel(1), "1 impl");
  assert.equal(implLabel(3), "3 impls");
});

test("only an interface and its methods are asked for implementations", () => {
  // Asking a plain function "how many types satisfy this" has no answer, so a
  // second lens over every declaration in the file would read `no impls` all
  // the way down and say nothing.
  const file = [
    symbol("Store", INTERFACE, [symbol("Get", METHOD)]),
    symbol("memStore", STRUCT, [symbol("Get", METHOD)]),
    symbol("New", FUNCTION),
  ];
  assert.deepEqual(
    lensTargets(file, 100).map((t) => [t.symbol.name, t.implementable]),
    [
      ["Store", true],
      ["Get", true],
      ["memStore", false],
      ["Get", false],
      ["New", false],
    ],
  );
});

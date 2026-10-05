import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  Answered,
  At,
  declarationKeys,
  elsewhere,
  implLabel,
  lensTargets,
  luaDeclarations,
  nameStart,
  refLabel,
} from "./references";

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
  assert.deepEqual(lensTargets(file, 100).map((t) => t.symbol.name), ["main"]);
});

test("a local inside an arrow function gets nothing either", () => {
  // TypeScript reports `export const arrow = (n) => { const inner = ... }` as a
  // Variable holding a Variable, so "do not descend into functions" by kind
  // would let `inner` through -- which is why descent is an allow-list of the
  // kinds that hold declarations rather than a deny-list of the ones that hold
  // code.
  const file = [symbol("arrow", VARIABLE, [symbol("inner", VARIABLE)])];
  assert.deepEqual(lensTargets(file, 100).map((t) => t.symbol.name), ["arrow"]);
});

test("a method still gets one, whichever kind its type is spelled as", () => {
  // The other half of the same change: an allow-list that forgot a language's
  // container would silently take the lens off every method in it. `Object` is
  // rust-analyzer's `impl` block -- descended into, and not itself counted,
  // because "how many references does `impl Scraper` have" is not a question.
  const OBJECT = 18;
  const CLASS = 4;
  const file = [
    symbol("impl Scraper", OBJECT, [symbol("fetch", METHOD)]),
    symbol("Config", CLASS, [symbol("load", METHOD)]),
  ];
  assert.deepEqual(lensTargets(file, 100).map((t) => t.symbol.name), [
    "fetch",
    "Config",
    "load",
  ]);
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
  const itself = (one: At) => one;
  const declaration = { uri: "file:///p/naming.go", line: 9 };
  const locations = [
    declaration,
    { uri: "file:///p/naming.go", line: 16 },
    { uri: "file:///p/scraper_test.go", line: 42 },
  ];
  assert.deepEqual(elsewhere(locations, declaration, itself), locations.slice(1));
  assert.deepEqual(elsewhere([declaration], declaration, itself), []);
  // Same line number in a different file is a different place.
  const other = { uri: "file:///p/other.go", line: 9 };
  assert.deepEqual(elsewhere([other], declaration, itself), [other]);
});

test("what survives the filter is what a click navigates to", () => {
  // Not just how many: a lens over a declaration with exactly one reference
  // jumps straight there, so the surviving entry has to be the reference and
  // never the declaration -- jumping to the line the user is already on is the
  // one outcome worse than opening a list of one.
  const declaration = { uri: "file:///p/naming.go", line: 9 };
  const use = { uri: "file:///p/scraper.go", line: 3 };
  assert.deepEqual(
    elsewhere([declaration, use], declaration, (one) => one),
    [use],
  );
});

test("the label says what the number means", () => {
  assert.equal(refLabel(0), "no refs");
  assert.equal(refLabel(1), "1 ref");
  assert.equal(refLabel(11), "11 refs");
  assert.equal(implLabel(0, "down"), "no impls");
  assert.equal(implLabel(1, "down"), "1 impl");
  assert.equal(implLabel(3, "down"), "3 impls");
  // The same query read the other way round. "2 impls" over a struct would
  // claim the struct has implementations, which is not a thing.
  assert.equal(implLabel(0, "up"), "no interfaces");
  assert.equal(implLabel(1, "up"), "1 interface");
  assert.equal(implLabel(2, "up"), "2 interfaces");
});

test("each declaration is asked the implementation question its kind has", () => {
  // Both readings of `textDocument/implementation`: an interface is asked who
  // satisfies it, a concrete type and its methods what they satisfy, and a free
  // function is asked nothing -- a second grey word over every function in the
  // file would say the same nothing on every line.
  const file = [
    symbol("Store", INTERFACE, [symbol("Get", METHOD)]),
    symbol("memStore", STRUCT, [symbol("Get", METHOD)]),
    symbol("New", FUNCTION),
  ];
  assert.deepEqual(
    lensTargets(file, 100).map((t) => [t.symbol.name, t.implementation]),
    [
      ["Store", "down"],
      ["Get", "down"],
      ["memStore", "up"],
      ["Get", "up"],
      ["New", undefined],
    ],
  );
});

test("a Go method is asked too, though it is nobody's child", () => {
  // gopls reports a method at the top level as `(Circle).Area` rather than as a
  // child of `Circle` -- measured 2026-09-21. Deciding the direction from the
  // parent would have left every Go method without the lens that says which
  // interface it satisfies, which is most of what the lens is for in Go.
  const file = [
    symbol("Circle", STRUCT, [symbol("Radius", FIELD)]),
    symbol("(Circle).Area", METHOD),
  ];
  assert.deepEqual(
    lensTargets(file, 100).map((t) => [t.symbol.name, t.implementation]),
    [["Circle", "up"], ["(Circle).Area", "up"]],
  );
});

// bash-language-server gives a shell function one range, the whole definition,
// and the editor copies it into `selectionRange`. Asked at that range's start,
// `function greet {` is asked at a keyword and answers nothing -- which is how
// shell functions written that way came to read `no refs`.
test("a flat symbol is asked about at its name, not its keyword", () => {
  assert.equal(nameStart("function greet {", "greet", 0), 9);
  assert.equal(nameStart("function greet() {", "greet", 0), 9);
  // The other spelling already started at the name, and must not move.
  assert.equal(nameStart("greet() {", "greet", 0), 0);
  // From the declaration's column, not the line's: an indented definition.
  assert.equal(nameStart("  function greet {", "greet", 2), 11);
});

test("a name is found whole, not inside a longer one", () => {
  assert.equal(nameStart("function rerun { run; }", "run", 0), 17);
  assert.equal(nameStart("function run_all {", "run", 0), undefined);
  assert.equal(nameStart("x", "", 0), undefined);
});

test("a declaration keeps its key while lines move around it", () => {
  const before = declarationKeys([
    { name: "area", kind: INTERFACE },
    { name: "area", kind: METHOD },
    { name: "area", kind: METHOD },
  ]);
  // Same names, same order: typing above them changes no key, and two methods
  // of one name stay apart -- neither may show the other's count.
  assert.deepEqual(before, ["10:area#0", "5:area#0", "5:area#1"]);
  assert.equal(new Set(before).size, 3);
});

test("a count is reused for a while and then asked again", () => {
  let now = 1_000;
  const answered = new Answered(10_000, () => now);
  answered.set("file:///a.go", "22:Circle#0", 4);
  now += 9_999;
  assert.equal(answered.get("file:///a.go", "22:Circle#0"), 4, "typing must not re-ask");
  now += 1;
  assert.equal(answered.get("file:///a.go", "22:Circle#0"), undefined, "a stale count is asked again");
  // Another file's declaration of the same name is a different question.
  answered.set("file:///a.go", "22:Circle#0", 4);
  assert.equal(answered.get("file:///b.go", "22:Circle#0"), undefined);
  answered.forget("file:///a.go");
  assert.equal(answered.get("file:///a.go", "22:Circle#0"), undefined);
});

test("a Lua file's declarations get a lens, and its assignments do not", () => {
  // lua-language-server's outline of one file, as it answered on 2026-10-05
  // (LSP kinds minus one): it names a kind after the value, so the module table
  // is an Object and a literal a String or Number, and it repeats a name for
  // every assignment to it.
  const STRING = 14;
  const NUMBER = 15;
  const BOOLEAN = 16;
  const ARRAY = 17;
  const OBJECT = 18;
  const file = [
    symbol("NAME", STRING), // local NAME = "x"
    symbol("enabled", BOOLEAN), // local enabled = true
    symbol("list", ARRAY, [symbol("[1]", NUMBER)]), // local list = { 1 }
    symbol("obj", VARIABLE), // local obj = setmetatable({}, {})
    symbol("uninit", VARIABLE), // local uninit
    symbol("GLOBAL", NUMBER), // GLOBAL = 1
    symbol("Class", OBJECT), // local Class = {}
    symbol("Class.__index", VARIABLE), // Class.__index = Class
    symbol("Class.new", FUNCTION), // function Class.new() ... end
    symbol("Class:method", METHOD), // function Class:method() ... end
    symbol("t", OBJECT, [symbol("field", NUMBER), symbol("fn", FUNCTION)]),
    symbol("outer", FUNCTION, [symbol("inner", NUMBER)]), // its local
    symbol("uninit", NUMBER), // uninit = 2
  ];
  assert.deepEqual(
    lensTargets(luaDeclarations(file), 100).map((t) => t.symbol.name),
    ["NAME", "enabled", "list", "obj", "uninit", "GLOBAL", "Class", "Class.new", "Class:method", "t", "outer"],
  );
  // Nothing here implements anything, so no Lua declaration asks that question.
  assert.ok(lensTargets(luaDeclarations(file), 100).every((t) => t.implementation === undefined));
});

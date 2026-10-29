import * as assert from "node:assert/strict";
import { test } from "node:test";

import { goTests } from "./goTests";

/** What `go test` would run in `body`, by name, in a test file. */
const found = (body: string, imports = `import "testing"\n`): string[] =>
  goTests("pkg/thing_test.go", `package thing\n\n${imports}\n${body}`).map((one) => one.name);

test("only a _test.go file holds tests", () => {
  // `go test` compiles test functions from _test.go files alone; the same
  // function anywhere else is ordinary code, and a lens there runs nothing.
  const text = `package thing\n\nimport "testing"\n\nfunc TestFoo(t *testing.T) {}\n`;
  assert.deepEqual(goTests("pkg/thing_test.go", text).map((one) => one.name), ["TestFoo"]);
  assert.deepEqual(goTests("pkg/thing.go", text), []);
  assert.deepEqual(goTests("pkg/test.go", text), []);
});

test("a method is not a test, whatever it is called", () => {
  assert.deepEqual(found("func TestFoo(t *testing.T) {}\n"), ["TestFoo"]);
  assert.deepEqual(found("type S struct{}\n\nfunc (s *S) TestFoo(t *testing.T) {}\n"), []);
});

test("a generic function is not a test", () => {
  // go test refuses a type-parameterised test outright: there is no type to
  // instantiate it with.
  assert.deepEqual(found("func TestFoo(t *testing.T) {}\n"), ["TestFoo"]);
  assert.deepEqual(found("func TestFoo[T any](t *testing.T) {}\n"), []);
});

test("the prefix alone, or one followed by anything but a lower-case letter", () => {
  const body = [
    "func Test(t *testing.T) {}",
    "func TestFoo(t *testing.T) {}",
    "func Test_foo(t *testing.T) {}",
    "func Test1(t *testing.T) {}",
    "func TestÉté(t *testing.T) {}",
    "",
  ].join("\n");
  assert.deepEqual(found(body), ["Test", "TestFoo", "Test_foo", "Test1", "TestÉté"]);
  // `Testfoo` is a helper that happens to start with the word; go test does
  // not run it, and neither does a lower-case letter outside ASCII.
  assert.deepEqual(found("func Testfoo(t *testing.T) {}\nfunc Testé(t *testing.T) {}\n"), []);
  assert.deepEqual(found("func Benchmarkfoo(b *testing.B) {}\nfunc Fuzzfoo(f *testing.F) {}\n"), []);
  assert.deepEqual(found("func Examplefoo() {}\n"), []);
});

test("each kind is told by its prefix and its parameter together", () => {
  const body = [
    "func TestA(t *testing.T) {}",
    "func BenchmarkA(b *testing.B) {}",
    "func FuzzA(f *testing.F) {}",
    "func ExampleA() {}",
    "",
  ].join("\n");
  assert.deepEqual(
    goTests("x_test.go", `package x\n\nimport "testing"\n\n${body}`).map((one) => [one.name, one.kind]),
    [["TestA", "test"], ["BenchmarkA", "benchmark"], ["FuzzA", "fuzz"], ["ExampleA", "example"]],
  );
  // The right shape under the wrong prefix: a benchmark run as a test would
  // hand go test a function it refuses to compile.
  const crossed = [
    "func TestB(b *testing.B) {}",
    "func BenchmarkT(t *testing.T) {}",
    "func FuzzT(t *testing.T) {}",
    "func TestF(f *testing.F) {}",
    "",
  ].join("\n");
  assert.deepEqual(found(crossed), []);
});

test("a test takes exactly one *testing.T", () => {
  assert.deepEqual(found("func TestFoo(t *testing.T) {}\n"), ["TestFoo"]);
  assert.deepEqual(found("func TestFoo(x int) {}\n"), []);
  assert.deepEqual(found("func TestFoo() {}\n"), []);
  // Two parameters sharing one type are still two.
  assert.deepEqual(found("func TestFoo(a, b *testing.T) {}\n"), []);
  assert.deepEqual(found("func TestFoo(t *testing.T, n int) {}\n"), []);
  // The value, not the pointer, is a different type.
  assert.deepEqual(found("func TestFoo(t testing.T) {}\n"), []);
  assert.deepEqual(found("func TestFoo(t ...*testing.T) {}\n"), []);
  assert.deepEqual(found("func TestFoo(t *testing.M) {}\n"), []);
});

test("the parameter may be named anything, blank, or not at all", () => {
  const body = [
    "func TestNamed(tt *testing.T) {}",
    "func TestBlank(_ *testing.T) {}",
    "func TestUnnamed(*testing.T) {}",
    "",
  ].join("\n");
  assert.deepEqual(found(body), ["TestNamed", "TestBlank", "TestUnnamed"]);
});

test("testing is whatever the file imports it as", () => {
  assert.deepEqual(found("func TestFoo(t *tt.T) {}\n", `import tt "testing"\n`), ["TestFoo"]);
  // Imported under another name, `testing.T` names a package the file does
  // not have.
  assert.deepEqual(found("func TestFoo(t *testing.T) {}\n", `import tt "testing"\n`), []);
  // And `tt.T` means nothing when testing was not imported as `tt`.
  assert.deepEqual(found("func TestFoo(t *tt.T) {}\n"), []);
  const grouped = `import (\n\t"fmt"\n\tt2 "testing"\n)\n`;
  assert.deepEqual(found("func TestFoo(t *t2.T) {}\n", grouped), ["TestFoo"]);
  assert.deepEqual(found("func TestFoo(t *T) {}\n", `import . "testing"\n`), ["TestFoo"]);
  assert.deepEqual(found("func TestFoo(t *T) {}\n"), []);
});

test("without testing imported there is no test", () => {
  assert.deepEqual(found("func TestFoo(t *testing.T) {}\n", ""), []);
  assert.deepEqual(found("func TestFoo(t *testing.T) {}\n", `import "github.com/x/testing/fake"\n`), []);
  // Blank-imported, its names are out of reach.
  assert.deepEqual(found("func TestFoo(t *testing.T) {}\n", `import _ "testing"\n`), []);
});

test("a test returns nothing", () => {
  assert.deepEqual(found("func TestFoo(t *testing.T) {}\n"), ["TestFoo"]);
  assert.deepEqual(found("func TestFoo(t *testing.T) error { return nil }\n"), []);
  assert.deepEqual(found("func TestFoo(t *testing.T) (err error) { return }\n"), []);
});

test("an example takes nothing and returns nothing, and needs no testing", () => {
  // The usual example_test.go imports fmt and the package under test only.
  assert.deepEqual(found("func ExampleFoo() {}\nfunc Example() {}\n", `import "fmt"\n`), [
    "ExampleFoo",
    "Example",
  ]);
  assert.deepEqual(found("func ExampleFoo(t *testing.T) {}\n"), []);
  assert.deepEqual(found("func ExampleFoo() string { return \"\" }\n"), []);
});

test("TestMain is the harness, not a test", () => {
  // TestMain(*testing.M) runs the others; go test never runs it by name. With
  // a *testing.T it is an ordinary test, which is what go test makes of it.
  assert.deepEqual(found("func TestMain(m *testing.M) {}\n"), []);
  assert.deepEqual(found("func TestMain(t *testing.T) {}\n"), ["TestMain"]);
});

test("a parameter list over several lines, with a trailing comma", () => {
  const body = "func TestFoo(\n\tt *testing.T,\n) {\n}\n\nfunc TestBar(t *testing.T,) {}\n";
  assert.deepEqual(found(body), ["TestFoo", "TestBar"]);
});

test("comments and strings are not code", () => {
  const body = [
    "// func TestLine(t *testing.T) {}",
    "/*",
    "func TestBlock(t *testing.T) {}",
    "*/",
    "var s = \"func TestString(t *testing.T) {}\"",
    "var r = `",
    "func TestRaw(t *testing.T) {}",
    "`",
    "func /* a test */ TestReal(t /* it */ *testing.T) /* nothing */ {",
    "\t_ = \"}\" // )",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(found(body), ["TestReal"]);
});

test("a function value is not a declaration", () => {
  const body = [
    "var TestVar = func(t *testing.T) {}",
    "type TestType func(t *testing.T)",
    "func TestReal(t *testing.T) {",
    "\tTestLocal := func(t *testing.T) {}",
    "\t_ = TestLocal",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(found(body), ["TestReal"]);
});

test("the lens line is the func keyword's", () => {
  const text =
    "package x\n\nimport \"testing\"\n\n// TestFoo checks.\nfunc TestFoo(t *testing.T) {\n}\n\n/* a\nb */\nfunc BenchmarkFoo(b *testing.B) {}\n";
  assert.deepEqual(
    goTests("x_test.go", text).map((one) => [one.name, one.line]),
    [["TestFoo", 5], ["BenchmarkFoo", 10]],
  );
  // A raw string's lines count too.
  const raw = "package x\n\nimport \"testing\"\n\nvar s = `\n\n\n`\n\nfunc TestFoo(t *testing.T) {}\n";
  assert.deepEqual(goTests("x_test.go", raw).map((one) => one.line), [9]);
});

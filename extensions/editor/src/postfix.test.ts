import * as assert from "node:assert/strict";
import { test } from "node:test";

import { describe, EXPR_MARK, expressionStart, POSTFIX_LANGUAGES, postfixesFor, postfixTarget } from "./postfix";

/** The expression `line` would expand, for a cursor at the end of it. */
const target = (line: string) => postfixTarget(line, line.length)?.expression;

test("a member chain is taken whole", () => {
  assert.equal(target("resp.Body.Close().if"), "resp.Body.Close()");
});

test("a call's arguments do not end the expression", () => {
  // The comma and the space inside the parentheses are exactly the characters
  // that stop the scan when they are not bracketed.
  assert.equal(target("foo(a, b).if"), "foo(a, b)");
  assert.equal(target("m[key(a)][0].if"), "m[key(a)][0]");
});

test("an operator in front of it is not part of it", () => {
  assert.equal(target("x + y.if"), "y");
  assert.equal(target("return !ok.if"), "ok");
  assert.equal(target("f(a, b.if"), "b");
});

test("a string literal is an expression", () => {
  assert.equal(target("\"a, b\".if"), "\"a, b\"");
  assert.equal(target("'it\\'s'.if"), "'it\\'s'");
});

test("nothing to the left of the dot means no postfix", () => {
  assert.equal(target(".if"), undefined);
  assert.equal(target("  .if"), undefined);
  // No dot at all: this is a plain identifier being typed.
  assert.equal(target("if"), undefined);
  assert.equal(target(""), undefined);
});

test("the name being typed is not part of the expression", () => {
  // Right after the dot, before anything is typed: everything still offered.
  assert.deepEqual(postfixTarget("err.", 4), { start: 0, expression: "err" });
  // Mid-word, and with the cursor before the rest of the line.
  assert.deepEqual(postfixTarget("err.wh ", 6), { start: 0, expression: "err" });
});

test("an unbalanced bracket stops the scan rather than running off the line", () => {
  assert.equal(target("foo).if"), undefined);
  assert.equal(target("\".if"), undefined);
});

test("the replacement starts at the expression, not at the dot", () => {
  const found = postfixTarget("\tif resp.Body.if", 16);
  assert.equal(found?.start, 4);
  assert.equal(found?.expression, "resp.Body");
});

test("every language poly runs a server for has postfixes", () => {
  // Not the data formats: `if` has nothing to expand into inside JSON. These
  // are the language ids with statements.
  for (const language of ["go", "rust", "swift", "python", "lua", "c", "cpp", "typescript"]) {
    assert.ok(postfixesFor(language), `${language} has no postfixes`);
  }
  assert.equal(postfixesFor("json"), undefined);
  assert.equal(postfixesFor("markdown"), undefined);
});

test("the selector and the table cannot drift apart", () => {
  for (const language of POSTFIX_LANGUAGES) {
    assert.ok(postfixesFor(language), `${language} is selected but has no postfixes`);
  }
});

test("every template names the expression exactly once", () => {
  // Twice would substitute the user's text twice, which is a bug in the table
  // rather than in the code -- and it only shows up in the one language that
  // has it wrong.
  for (const language of POSTFIX_LANGUAGES) {
    for (const one of postfixesFor(language)!) {
      const uses = one.template.split(EXPR_MARK).length - 1;
      assert.equal(uses, 1, `${language}.${one.name} uses the expression ${uses} times`);
    }
  }
});

test("the description says what this language actually writes", () => {
  const go = postfixesFor("go")!.find((one) => one.name === "if")!;
  assert.equal(describe(go.template, "ok"), "if ok { …");

  const python = postfixesFor("python")!.find((one) => one.name === "if")!;
  assert.equal(describe(python.template, "ok"), "if ok: …");

  const lua = postfixesFor("lua")!.find((one) => one.name === "if")!;
  assert.equal(describe(lua.template, "ok"), "if ok then …");

  // Placeholders read as their default text rather than as snippet syntax.
  const rust = postfixesFor("rust")!.find((one) => one.name === "var")!;
  assert.equal(describe(rust.template, "n"), "let name = n;");
});

test("the expression start is a column, not a length", () => {
  assert.equal(expressionStart("abc.", 3), 0);
  assert.equal(expressionStart("  abc.", 5), 2);
  assert.equal(expressionStart("  .", 2), undefined);
});

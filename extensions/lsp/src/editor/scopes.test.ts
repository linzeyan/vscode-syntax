import * as assert from "node:assert";
import { test } from "node:test";

import { colorSheet, parseStyle, recoloured, scopesIn, styleOf } from "./scopes";

/** A grammar shaped like a real one: nested patterns, a repository, captures. */
const GRAMMAR = {
  name: "Solidity",
  scopeName: "source.solidity",
  patterns: [
    { include: "#comments" },
    {
      begin: "\\b(contract)\\s+([A-Z]\\w*)",
      beginCaptures: {
        "1": { name: "storage.type.contract.solidity" },
        "2": { name: "entity.name.type.contract.solidity" },
      },
      end: "\\}",
      patterns: [{ match: "\\b(public|private)\\b", name: "storage.modifier.solidity" }],
    },
  ],
  repository: {
    comments: {
      patterns: [
        {
          begin: "/\\*",
          end: "\\*/",
          name: "comment.block.solidity",
          contentName: "meta.embedded.comment.solidity",
        },
      ],
    },
  },
};

test("every scope in the grammar is on the sheet, however deep it sits", () => {
  // The three depths a real grammar uses: a top-level pattern's own captures, a
  // pattern nested inside a begin/end rule, and a rule reached through the
  // repository. Missing any of them makes the sheet a partial list, which is
  // worse than none -- a scope that is not on it looks like a scope that does
  // not exist.
  const scopes = scopesIn(GRAMMAR);
  assert.ok(scopes.includes("entity.name.type.contract.solidity"));
  assert.ok(scopes.includes("storage.modifier.solidity"));
  assert.ok(scopes.includes("comment.block.solidity"));
  assert.ok(scopes.includes("meta.embedded.comment.solidity"));
});

test("the root scope is on the sheet and the display name is not", () => {
  // `scopeName` is what a theme rule uses to say "everything in this language".
  // The grammar's own `name` is the word in the language picker, and a rule
  // targeting "Solidity" would match nothing at all.
  const scopes = scopesIn(GRAMMAR);
  assert.ok(scopes.includes("source.solidity"));
  assert.ok(!scopes.includes("Solidity"));
});

test("a templated scope is left off", () => {
  // `entity.name.tag.$2.html` is filled in from a capture group. What it
  // expands to cannot be known without tokenizing a file, and the literal text
  // matches nothing, so a rule written against it is a rule that never fires.
  const scopes = scopesIn({
    scopeName: "text.html.basic",
    patterns: [{ match: "<(\\w+)", name: "entity.name.tag.$1.html" }],
  });
  assert.deepStrictEqual(scopes, ["text.html.basic"]);
});

test("several scopes in one name are several scopes", () => {
  // TextMate allows a space-separated list, and a theme addresses each part.
  assert.deepStrictEqual(
    scopesIn({ patterns: [{ match: "x", name: "meta.tag.html entity.name.tag.html" }] }),
    ["entity.name.tag.html", "meta.tag.html"],
  );
});

test("the same scope named twice appears once, and the list is sorted", () => {
  assert.deepStrictEqual(
    scopesIn({
      patterns: [
        { match: "a", name: "keyword.control" },
        { match: "b", name: "comment.line" },
        { match: "c", name: "keyword.control" },
      ],
    }),
    ["comment.line", "keyword.control"],
  );
});

test("nothing recognisable is an empty sheet rather than a throw", () => {
  // A grammar poly did not sync could be any shape at all.
  assert.deepStrictEqual(scopesIn(null), []);
  assert.deepStrictEqual(scopesIn("not a grammar"), []);
  assert.deepStrictEqual(scopesIn({}), []);
});

test("the sheet's placeholder is not a colour", () => {
  // Pasted unedited, every rule is ignored. That is the failure mode worth
  // having: the alternative is a default that quietly recolours something.
  const sheet = colorSheet("solidity", "ricky.poly-syntax-highlight", [
    "comment.block.solidity",
  ]);
  assert.ok(sheet.includes(`"foreground": "#RRGGBB"`));
  assert.ok(!/#[0-9a-fA-F]{6}/.test(sheet));
});

test("the sheet is a settings fragment, not prose about one", () => {
  // It is meant to be copied from. A JSON parse of the body is the only way to
  // find out that the rules were written wrong, since nothing else reads it.
  const sheet = colorSheet("go", "ricky.poly-syntax-highlight", [
    "keyword.control.go",
    "string.quoted.double.go",
  ]);
  const body = sheet.split("\n").filter((line) => !line.startsWith("//")).join("\n");
  const parsed = JSON.parse(body);
  assert.deepStrictEqual(
    parsed["editor.tokenColorCustomizations"].textMateRules.map((
      rule: { scope: string },
    ) => rule.scope),
    ["keyword.control.go", "string.quoted.double.go"],
  );
});

test("a typed style is a colour, some font styles, or both", () => {
  assert.deepStrictEqual(parseStyle("#C586C0"), { foreground: "#C586C0" });
  assert.deepStrictEqual(parseStyle(" #c586c0  Italic bold "), {
    foreground: "#c586c0",
    fontStyle: "italic bold",
  });
  assert.deepStrictEqual(parseStyle("underline"), { fontStyle: "underline" });
  // The short and alpha forms are colours the editor accepts too.
  assert.deepStrictEqual(parseStyle("#fff"), { foreground: "#fff" });
  assert.deepStrictEqual(parseStyle("#C586C080"), { foreground: "#C586C080" });
});

test("an empty answer takes the rule away, and a wrong one says what is wrong", () => {
  assert.strictEqual(parseStyle("   "), null);
  // Not written, not guessed at: a colour name or a typo in the hex would be
  // a rule the editor ignores, so the input box has to refuse it instead.
  for (const wrong of ["red", "#C586C", "C586C0", "#C586C0 #FFFFFF", "#C586C0 italics"]) {
    assert.strictEqual(typeof parseStyle(wrong), "string", wrong);
  }
});

test("recolouring one scope leaves the rest of the setting as it was", () => {
  // The user's own rules, shorthands and per-theme blocks are theirs; the
  // command owns one rule and nothing else.
  const before = {
    comments: "#888888",
    "[Dark+]": { textMateRules: [{ scope: "keyword.control.go", settings: { foreground: "#111111" } }] },
    textMateRules: [
      { scope: "string.quoted.double.go", settings: { foreground: "#CE9178" } },
      { scope: "keyword.control.go", settings: { foreground: "#000000" } },
      { scope: ["keyword.control.go", "keyword.other.go"], settings: { fontStyle: "bold" } },
    ],
  };
  const after = recoloured(before, "keyword.control.go", { foreground: "#C586C0" });
  assert.deepStrictEqual(after, {
    comments: "#888888",
    "[Dark+]": before["[Dark+]"],
    textMateRules: [
      before.textMateRules[0],
      // Hand-written for several scopes at once: kept, and outranked by the
      // new rule for this one because the new rule comes last.
      before.textMateRules[2],
      { scope: "keyword.control.go", settings: { foreground: "#C586C0" } },
    ],
  });
  assert.strictEqual(styleOf(after, "keyword.control.go"), "#C586C0");
});

test("taking a rule away removes it and nothing else", () => {
  const before = {
    textMateRules: [
      { scope: "comment.line.go", settings: { foreground: "#6A9955", fontStyle: "italic" } },
      { scope: "string.quoted.double.go", settings: { foreground: "#CE9178" } },
    ],
  };
  assert.strictEqual(styleOf(before, "comment.line.go"), "#6A9955 italic");
  const after = recoloured(before, "comment.line.go", null);
  assert.deepStrictEqual(after, { textMateRules: [before.textMateRules[1]] });
  assert.strictEqual(styleOf(after, "comment.line.go"), "");
});

test("a setting that is missing or malformed is a fresh start, not a throw", () => {
  const rule = { scope: "comment", settings: { foreground: "#6A9955" } };
  for (const nothing of [undefined, null, "oops", [], { textMateRules: "oops" }]) {
    assert.deepStrictEqual(recoloured(nothing, "comment", { foreground: "#6A9955" }).textMateRules, [rule]);
    assert.strictEqual(styleOf(nothing, "comment"), "");
  }
});

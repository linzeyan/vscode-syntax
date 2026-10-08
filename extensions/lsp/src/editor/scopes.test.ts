import * as assert from "node:assert";
import { test } from "node:test";

import { colorSheet, parseStyle, scopesIn, styleText, SYNTAX_COLORS_RULE, withSyntaxColors } from "./scopes";

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
  // Pasted unedited, every entry is ignored. That is the failure mode worth
  // having: the alternative is a default that quietly recolours something.
  const sheet = colorSheet("solidity", "ricky.poly-syntax-highlight", [
    "comment.block.solidity",
  ]);
  assert.ok(sheet.includes(`"comment.block.solidity": "#RRGGBB"`));
  assert.ok(!/#[0-9a-fA-F]{6}/.test(sheet));
  assert.strictEqual(withSyntaxColors(undefined, { "comment.block.solidity": "#RRGGBB" }), undefined);
});

test("the sheet is a settings fragment, not prose about one", () => {
  // It is meant to be copied from. A JSON parse of the body is the only way to
  // find out that the entries were written wrong, since nothing else reads it.
  const sheet = colorSheet("go", "ricky.poly-syntax-highlight", [
    "keyword.control.go",
    "string.quoted.double.go",
  ]);
  const body = sheet.split("\n").filter((line) => !line.startsWith("//")).join("\n");
  const parsed = JSON.parse(body);
  assert.deepStrictEqual(Object.keys(parsed["poly.syntaxColors"]), [
    "keyword.control.go",
    "string.quoted.double.go",
  ]);
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
  // What the command writes back reads back as the same style.
  assert.strictEqual(styleText({ foreground: "#c586c0", fontStyle: "italic bold" }), "#c586c0 italic bold");
});

test("an empty answer takes the rule away, and a wrong one says what is wrong", () => {
  assert.strictEqual(parseStyle("   "), null);
  // Not written, not guessed at: a colour name or a typo in the hex would be
  // a rule the editor ignores, so the input box has to refuse it instead.
  for (const wrong of ["red", "#C586C", "C586C0", "#C586C0 #FFFFFF", "#C586C0 italics"]) {
    assert.strictEqual(typeof parseStyle(wrong), "string", wrong);
  }
});

test("the setting becomes rules named after it, after everything that was already there", () => {
  // The user's own rules, shorthands and per-theme blocks are theirs; the
  // mirror owns the rules carrying its name and nothing else. Last, so that
  // for the same scope the setting wins over a rule written by hand.
  const before = {
    comments: "#888888",
    "[Dark+]": { textMateRules: [{ scope: "keyword.control.go", settings: { foreground: "#111111" } }] },
    textMateRules: [
      { scope: "keyword.control.go", settings: { foreground: "#000000" } },
      { name: SYNTAX_COLORS_RULE, scope: "comment", settings: { foreground: "#6A9955" } },
    ],
  };
  const after = withSyntaxColors(before, { "keyword.control.go": "#C586C0 bold", comment: "italic" });
  assert.deepStrictEqual(after, {
    comments: "#888888",
    "[Dark+]": before["[Dark+]"],
    textMateRules: [
      before.textMateRules[0],
      { name: SYNTAX_COLORS_RULE, scope: "keyword.control.go", settings: { foreground: "#C586C0", fontStyle: "bold" } },
      { name: SYNTAX_COLORS_RULE, scope: "comment", settings: { fontStyle: "italic" } },
    ],
  });
});

test("an entry taken out of the setting takes its rule with it, and nothing else", () => {
  // Removing a key is the only way the setting has to say "back to the
  // theme's", so the rule it made has to go -- by name, because the scope
  // alone cannot tell it from the user's own rule for the same scope.
  const mine = { scope: "comment", settings: { foreground: "#FF0000" } };
  const before = {
    textMateRules: [mine, { name: SYNTAX_COLORS_RULE, scope: "comment", settings: { foreground: "#6A9955" } }],
  };
  assert.deepStrictEqual(withSyntaxColors(before, {}), { textMateRules: [mine] });
});

test("a setting already mirrored writes nothing", () => {
  // Every window mirrors on activation and on every change. Without this,
  // each would rewrite settings.json for nothing, and each write is another
  // change event in every other window.
  const colors = { comment: "#6A9955 italic" };
  const once = withSyntaxColors(undefined, colors);
  assert.ok(once);
  assert.strictEqual(withSyntaxColors(once, colors), undefined);
  assert.strictEqual(withSyntaxColors(undefined, {}), undefined);
});

test("a value that is not a style is left out rather than guessed at", () => {
  const after = withSyntaxColors(undefined, { comment: "red", string: "#CE9178", keyword: 42 });
  assert.deepStrictEqual(after?.textMateRules, [
    { name: SYNTAX_COLORS_RULE, scope: "string", settings: { foreground: "#CE9178" } },
  ]);
});

test("a customization that is missing or malformed is a fresh start, not a throw", () => {
  const rule = { name: SYNTAX_COLORS_RULE, scope: "comment", settings: { foreground: "#6A9955" } };
  for (const nothing of [undefined, null, "oops", [], { textMateRules: "oops" }]) {
    assert.deepStrictEqual(withSyntaxColors(nothing, { comment: "#6A9955" })?.textMateRules, [rule]);
  }
});

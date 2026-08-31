import * as assert from "node:assert/strict";
import { test } from "node:test";

import { headings, slug, toc } from "./markdown";

test("a # is not a heading inside front matter or a fence", () => {
  const source = [
    "---",
    "# not a heading, a YAML comment",
    "title: x",
    "---",
    "# Title",
    "",
    "````md",
    "```",
    "## still inside the outer fence",
    "```",
    "````",
    "",
    "~~~",
    "### tilde-fenced",
    "~~~",
    "",
    "## Real",
    "### Closed ###",
  ].join("\n");

  assert.deepEqual(headings(source), [
    { level: 1, text: "Title" },
    { level: 2, text: "Real" },
    // The trailing run of # closes the heading; it is not part of the text.
    { level: 3, text: "Closed" },
  ]);
});

test("anchors follow VSCode's slugifier, including where it is surprising", () => {
  // Punctuation goes, emphasis markers go with it, a link contributes its
  // label, spaces become hyphens, and CJK survives.
  assert.equal(slug("Hello, World!"), "hello-world");
  assert.equal(slug("**bold** and `code`"), "bold-and-code");
  assert.equal(slug("see [the docs](https://example.com/x)"), "see-the-docs");
  assert.equal(slug("設定系統"), "設定系統");
  assert.equal(slug("3.4 工具解析順序"), "34-工具解析順序");
  // Underscores survive as themselves, so emphasis written with them has to
  // be unwrapped before the rule that keeps snake_case sees it.
  assert.equal(slug("snake_case-and-dash"), "snake_case-and-dash");
  assert.equal(slug("_stressed_ and __very__"), "stressed-and-very");
  // Whitespace collapses first and punctuation is dropped after, so a run of
  // spaces is one hyphen while a dropped em dash between two leaves two.
  assert.equal(slug("spaced    out"), "spaced-out");
  assert.equal(slug("poly-lsp — the client"), "poly-lsp--the-client");
  // Full-width punctuation is on VSCode's list; ASCII parentheses are too.
  assert.equal(slug("3. CLI（Rust）"), "3-clirust");
  assert.equal(slug("a (b) c"), "a-b-c");
  // Leading and trailing hyphens are trimmed, which is what makes a heading
  // that opens with punctuation resolve at all.
  assert.equal(slug("— dash first"), "dash-first");
  assert.equal(slug("trailing …"), "trailing");
});

// VSCode numbers a repeat by re-slugging `${base}-${n}` and keying the counter
// on the base, so the second occurrence is -1 and the third is -2.
test("repeated headings get numbered anchors, counting the H1 too", () => {
  const source = ["# Same", "## Same", "## Same", ""].join("\n");
  // The H1 is not listed but it took the bare anchor, so the first listed
  // entry is already -1. Skipping it in the count would link both entries to
  // the title.
  assert.deepEqual(toc(source), [
    "- [Same](#same-1)",
    "- [Same](#same-2)",
  ]);
});

test("nesting is relative to the shallowest heading listed", () => {
  const source = [
    "# Title",
    "## A",
    "### A.1",
    "#### A.1.a",
    "## B",
    "",
  ].join("\n");
  assert.deepEqual(toc(source), [
    "- [A](#a)",
    "  - [A.1](#a1)",
    "    - [A.1.a](#a1a)",
    "- [B](#b)",
  ]);

  // Same document without the H2s: the H3s start the list, so they are not
  // indented at all.
  const deep = ["# Title", "### A.1", "#### A.1.a", ""].join("\n");
  assert.deepEqual(toc(deep), [
    "- [A.1](#a1)",
    "  - [A.1.a](#a1a)",
  ]);
});

test("a document with nothing to list says so with an empty result", () => {
  assert.deepEqual(toc("# Only a title\n\ntext\n"), []);
  assert.deepEqual(toc(""), []);
});

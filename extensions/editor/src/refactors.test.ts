import * as assert from "node:assert/strict";
import { test } from "node:test";

import { REFACTOR_KIND, refactorChoices } from "./refactors";

const action = (title: string, kind?: string) => ({ title, kind });

test("a command named after a variable does not offer to extract a function", () => {
  // gopls, verbatim: both are refactor.extract and only one of them is what
  // Extract Variable promised.
  const offered = [
    action("Extract function", "refactor.extract"),
    action("Extract variable", "refactor.extract"),
    action("Extract method", "refactor.extract"),
  ];
  assert.deepEqual(refactorChoices(offered, "extract"), [
    action("Extract variable", "refactor.extract"),
  ]);
});

test("a sub-kind counts as its parent kind", () => {
  // TypeScript tags its own, and the title says "constant" rather than
  // "variable" because that is the only word it has for a local binding.
  const offered = [
    action("Extract to function in module scope", "refactor.extract.function"),
    action("Extract to constant in enclosing scope", "refactor.extract.constant"),
  ];
  assert.deepEqual(refactorChoices(offered, "extract"), [
    action("Extract to constant in enclosing scope", "refactor.extract.constant"),
  ]);
});

test("wording nobody has measured costs a menu, not the feature", () => {
  // The fallback matters more than the filter: a server this file has never
  // seen still has to be usable, and the user can read three titles.
  const offered = [
    action("Introduce binding", "refactor.extract"),
    action("Hoist subexpression", "refactor.extract"),
  ];
  assert.deepEqual(refactorChoices(offered, "extract"), offered);
});

test("inline and extract do not see each other's actions", () => {
  const offered = [
    action("Inline variable", "refactor.inline"),
    action("Extract into variable", "refactor.extract"),
  ];
  assert.deepEqual(refactorChoices(offered, "inline"), [
    action("Inline variable", "refactor.inline"),
  ]);
  assert.deepEqual(refactorChoices(offered, "extract"), [
    action("Extract into variable", "refactor.extract"),
  ]);
});

test("a quick fix that arrived uninvited is not a refactoring", () => {
  // Providers are allowed to answer with more than they were asked for, and an
  // organize-imports action applied by Extract Variable would be a surprise
  // the user has no way to connect to what they pressed.
  const offered = [
    action("Organize imports", "source.organizeImports"),
    action("Add missing import", "quickfix"),
    action("Refactor everything", "refactorial"),
    action("Unclassified"),
  ];
  assert.deepEqual(refactorChoices(offered, "extract"), []);
});

test("the kinds asked for are the ones the protocol names", () => {
  assert.equal(REFACTOR_KIND.extract, "refactor.extract");
  assert.equal(REFACTOR_KIND.inline, "refactor.inline");
});

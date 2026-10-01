import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { pullRequestUrl, refNameProblem } from "./gitGraphActions";

test("a branch or tag name is refused exactly when git would refuse it", () => {
  // The dialog says why while the name is typed; a rule looser than git's
  // lets the name through to fail afterwards as an error toast, and a
  // stricter one refuses a name git takes. git itself is the reference.
  const names = [
    "main",
    "feature/login",
    "v1.0",
    "fix-1",
    "a.b",
    "中文",
    "x@y",
    "a{b}",
    "UPPER",
    "",
    " ",
    "a b",
    "a..b",
    "-x",
    "/x",
    "x/",
    ".x",
    "x.",
    "x/.y",
    "x.lock",
    "x.lock/y",
    "a@{b",
    "a//b",
    "a~b",
    "a^b",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    "a\tb",
    "a\x7fb",
  ];
  const accepts = (name: string) => {
    try {
      execFileSync("git", ["check-ref-format", "--branch", name], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  for (const name of names) {
    assert.strictEqual(refNameProblem(name) === undefined, accepts(name), JSON.stringify(name));
  }
  // `@` alone passes the check only because it is read as HEAD's name.
  assert.notStrictEqual(refNameProblem("@"), undefined);
});

test("a pull request opens on the three hosts that need no setup, from the branch asked for", () => {
  const remote = (url: string) => ({ name: "origin", url });
  // Every way a clone URL is written reaches the same project.
  for (
    const url of [
      "https://github.com/ada/engine.git",
      "git@github.com:ada/engine.git",
      "ssh://git@github.com/ada/engine",
      "https://ada@github.com/ada/engine/",
    ]
  ) {
    assert.strictEqual(
      pullRequestUrl(remote(url), "feature/login"),
      "https://github.com/ada/engine/compare/feature%2Flogin?expand=1",
      url,
    );
  }
  assert.strictEqual(
    pullRequestUrl(remote("git@gitlab.com:group/sub/engine.git"), "fix"),
    "https://gitlab.com/group/sub/engine/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix",
  );
  assert.strictEqual(
    pullRequestUrl(remote("https://bitbucket.org/ada/engine.git"), "fix"),
    "https://bitbucket.org/ada/engine/pull-requests/new?source=fix",
  );
  // Anywhere else the menu item is not offered at all, rather than opening a guess.
  assert.strictEqual(pullRequestUrl(remote("https://git.example.com/ada/engine.git"), "fix"), undefined);
  assert.strictEqual(pullRequestUrl(remote("/srv/git/engine.git"), "fix"), undefined);
});

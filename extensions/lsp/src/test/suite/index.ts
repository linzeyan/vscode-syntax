import { resolve } from "node:path";

import Mocha from "mocha";

/** The launches after the first (runTest.ts), each for the one test that needs its editor. */
const ONLY: Record<string, string> = {
  "code-runner-yield": "Code Runner beside formulahendry.code-runner",
  "no-git": "Git History without git",
};

export function run(): Promise<void> {
  // runTest.ts launches the editor once for everything, then once per entry in
  // ONLY: beside a stand-in for formulahendry.code-runner, and without vscode.git.
  const suite = process.env.POLY_E2E_SUITE;
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    timeout: 60_000,
    grep: suite ? ONLY[suite] : Object.values(ONLY).join("|"),
    invert: !suite,
  });
  mocha.addFile(resolve(__dirname, "extension.test.js"));
  return new Promise((done, fail) => {
    // A green run has to mean tests ran. CI job logs are not readable without a
    // token, so an empty suite would otherwise be indistinguishable from a
    // passing one — exit 0, nothing to see.
    const runner = mocha.run((failures) => {
      if (failures > 0) {
        fail(new Error(`${failures} test(s) failed`));
      } else if (runner.stats?.tests === 0) {
        fail(new Error("the suite registered no tests"));
      } else {
        done();
      }
    });
  });
}

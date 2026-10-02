import { resolve } from "node:path";

import Mocha from "mocha";

export function run(): Promise<void> {
  // runTest.ts launches the editor twice: once for everything, and once beside
  // a stand-in for formulahendry.code-runner for the one suite about that.
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    timeout: 60_000,
    grep: "Code Runner beside formulahendry.code-runner",
    invert: process.env.POLY_E2E_SUITE !== "code-runner-yield",
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

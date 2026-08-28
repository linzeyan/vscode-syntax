import { resolve } from "node:path";

import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 60_000 });
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

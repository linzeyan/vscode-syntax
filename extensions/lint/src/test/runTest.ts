// Editor-side E2E (M3 backlog). tools/lsp-smoke.py already proves the daemon
// speaks the protocol; what it cannot prove is that VSCode actually routes a
// document to it — activation events, the client's documentSelector and the
// contributed commands all live outside the protocol, and both times we broke
// them the protocol tests stayed green.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runTests } from "@vscode/test-electron";

/// A VSCode integrated terminal exports its own bootstrap variables, and the
/// test instance inherits them: `VSCODE_ESM_ENTRYPOINT` makes the fresh copy
/// boot as an extension host and `ELECTRON_RUN_AS_NODE` makes it boot as plain
/// node, both of which fail with an unrelated-looking "bad option" dump. Which
/// terminal you happen to run the tests from should not decide whether they
/// work.
function stripHostEnvironment(): void {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VSCODE_")) {
      delete process.env[key];
    }
  }
}

async function main(): Promise<void> {
  stripHostEnvironment();
  // Compiled to out/runTest.js, so one level up is the extension root.
  const extensionDevelopmentPath = resolve(__dirname, "..");
  const extensionTestsPath = resolve(__dirname, "suite", "index");
  const repo = resolve(extensionDevelopmentPath, "..", "..");
  const serverPath = process.env.POLY_BIN
    ?? join(repo, "cli", "target", "release", "poly");

  // A throwaway workspace rather than the repo: the tests write files and run
  // batch formatting, and pointing those at the checkout would rewrite it.
  const workspace = mkdtempSync(join(tmpdir(), "poly-e2e-"));
  mkdirSync(join(workspace, ".vscode"));
  writeFileSync(
    join(workspace, ".vscode", "settings.json"),
    JSON.stringify(
      {
        "poly.serverPath": serverPath,
        // Both would pop modal-ish UI that nothing in a headless run dismisses.
        "poly.promptFormatOnSave": false,
        "poly.updateCheck.enabled": false,
      },
      null,
      2,
    ),
  );

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // --folder-uri, not a bare path: launchArgs are prepended, and Electron
    // reads a leading positional as the app to run rather than as a workspace.
    // Built-in extensions stay on — they own the `sql` and `python` language
    // ids the tests rely on.
    launchArgs: [`--folder-uri=${pathToFileURL(workspace).toString()}`],
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

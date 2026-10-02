// Editor-side E2E (M3 backlog). tools/lsp-smoke.py already proves the daemon
// speaks the protocol; what it cannot prove is that VSCode actually routes a
// document to it — activation events, the client's documentSelector and the
// contributed commands all live outside the protocol, and both times we broke
// them the protocol tests stayed green.
import { createHash } from "node:crypto";
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

/// Where this checkout's editor state goes, kept short on purpose.
///
/// VSCode puts its IPC socket inside the user-data directory, and a unix
/// socket path cannot exceed 103 characters. The default sits under the
/// checkout — extensions/lsp/.vscode-test/user-data — which fits for a clone in
/// ~/git and does not for a worktree a few directories below one, so `make e2e`
/// only ran where the checkout happened to be shallow enough, and failed
/// elsewhere with an ENAMETOOLONG that named neither the limit nor the path.
/// `/tmp` rather than os.tmpdir() because macOS's is a 48-character per-user
/// path: half the budget spent before the name.
///
/// Keyed by the checkout rather than by the run, so that two worktrees can
/// test at once — a shared user-data directory means the second editor to
/// start finds the first one's state — and so that repeated runs reuse it.
function userDataDir(repo: string): string {
  const key = createHash("sha1").update(repo).digest("hex").slice(0, 8);
  const root = process.platform === "win32" ? tmpdir() : "/tmp";
  return join(root, `poly-e2e-${key}`, "user-data");
}

async function main(): Promise<void> {
  stripHostEnvironment();
  // Compiled to out/test/runTest.js, so two levels up is the extension root.
  const extensionDevelopmentPath = resolve(__dirname, "..", "..");
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
        // Would pop modal-ish UI that nothing in a headless run dismisses.
        "poly.updateCheck.enabled": false,
        // Off for real users until they ask for it; on here, because the
        // proxy is exactly the part no protocol test can prove -- whether
        // VSCode acts on a capability registered after initialize.
        "poly.languageServers": true,
        // Same: every poly feature that is not formatting or linting now ships
        // off, so a suite that exercises one has to say so. Inheriting the
        // default would turn the dead-code lens tests into a 45-second wait
        // for a lens nobody asked for, reported as a timeout.
        "poly.deadCodeCodeLens.enabled": true,
      },
      null,
      2,
    ),
  );
  // gopls refuses to resolve anything outside a module, so the throwaway
  // workspace needs to be one before it can answer a single question.
  writeFileSync(join(workspace, "go.mod"), "module polye2e\n\ngo 1.21\n");
  // Its own, so that the log test finds this run's files and no other's.
  const logs = mkdtempSync(join(tmpdir(), "poly-e2e-logs-"));

  await runTests({
    // The second one ships only a language default; see its description.
    extensionDevelopmentPath: [
      extensionDevelopmentPath,
      resolve(extensionDevelopmentPath, "src", "test", "fixture-defaults"),
    ],
    extensionTestsPath,
    // --folder-uri, not a bare path: launchArgs are prepended, and Electron
    // reads a leading positional as the app to run rather than as a workspace.
    // Built-in extensions stay on — they own the `sql` and `python` language
    // ids the tests rely on.
    launchArgs: [
      `--folder-uri=${pathToFileURL(workspace).toString()}`,
      `--user-data-dir=${userDataDir(repo)}`,
      `--logsPath=${logs}`,
    ],
    extensionTestsEnv: { POLY_E2E_LOGS: logs },
  });

  // Code Runner stands aside while formulahendry.code-runner is installed,
  // which only shows with it installed -- and every test above has to run
  // without it. So a second editor, beside a stand-in with its id, runs the
  // one suite about that (see suite/index.ts).
  const beside = mkdtempSync(join(tmpdir(), "poly-e2e-"));
  mkdirSync(join(beside, ".vscode"));
  writeFileSync(
    join(beside, ".vscode", "settings.json"),
    JSON.stringify(
      {
        "poly.serverPath": serverPath,
        "poly.updateCheck.enabled": false,
        // On, so that standing aside is the only thing left to stop Run Code.
        "poly.codeRunner.enabled": true,
        "poly.runCodeLens.enabled": true,
      },
      null,
      2,
    ),
  );
  await runTests({
    extensionDevelopmentPath: [
      extensionDevelopmentPath,
      resolve(extensionDevelopmentPath, "src", "test", "fixture-code-runner"),
    ],
    extensionTestsPath,
    launchArgs: [
      `--folder-uri=${pathToFileURL(beside).toString()}`,
      `--user-data-dir=${userDataDir(repo)}`,
    ],
    extensionTestsEnv: { POLY_E2E_SUITE: "code-runner-yield" },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

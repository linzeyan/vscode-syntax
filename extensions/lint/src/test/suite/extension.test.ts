import * as assert from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as vscode from "vscode";

const EXTENSION_ID = "ricky.poly-lint";

const COMMANDS = [
  "poly.formatFile",
  "poly.formatPath",
  "poly.formatWorkspace",
  "poly.formatGitRepo",
  "poly.formatGitChanged",
  "poly.lintPath",
  "poly.checkForUpdates",
  "poly.showOutput",
];

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the test host opened no workspace folder");
  return folder.uri.fsPath;
}

function writeFile(name: string, content: string): vscode.Uri {
  const file = join(workspaceRoot(), name);
  writeFileSync(file, content);
  return vscode.Uri.file(file);
}

/// Diagnostics and formatter registration both arrive asynchronously after the
/// client connects; poll rather than sleeping a guessed interval.
async function eventually<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

/// Format through the editor and return the resulting text. Asserting on the
/// raw edits would be brittle: VSCode minimizes a whole-document replacement
/// into a handful of one-character splices before handing it back.
async function formatted(uri: vscode.Uri): Promise<string> {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const edits = await eventually(
    `a formatter for ${document.languageId}`,
    async () => {
      const found = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        "vscode.executeFormatDocumentProvider",
        uri,
        { tabSize: 2, insertSpaces: true },
      );
      return found && found.length > 0 ? found : undefined;
    },
  );
  const edit = new vscode.WorkspaceEdit();
  edit.set(uri, edits);
  assert.ok(await vscode.workspace.applyEdit(edit), "applyEdit was rejected");
  return document.getText();
}

suite("poly-lint in a real editor", () => {
  suiteSetup(async function() {
    this.timeout(120_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
    // Opening a supported file is what a user does; if the activation events
    // are wrong this never resolves and the whole suite fails loudly.
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(
        writeFile("activation.sql", "select 1\n"),
      ),
    );
    await eventually("the extension to activate", () => extension.isActive || undefined);
  });

  test("contributes every command it declares", async () => {
    const registered = await vscode.commands.getCommands(true);
    const missing = COMMANDS.filter((id) => !registered.includes(id));
    assert.deepStrictEqual(missing, [], "declared but never registered");
  });

  // VSCode ships no formatter for either language, so any edit at all can only
  // have come from poly's client — which is exactly the registration that
  // broke twice while the protocol tests stayed green.
  test("registers a formatter for sql", async () => {
    const text = await formatted(writeFile("messy.sql", "select a,b from t\n"));
    assert.strictEqual(text, "select a, b from t\n");
  });

  test("registers a formatter for python", async () => {
    const text = await formatted(
      writeFile("messy.py", "def  f( a,b ):\n    return a+b\n"),
    );
    assert.strictEqual(text, "def f(a, b):\n    return a + b\n");
  });

  test("publishes sqruff diagnostics into the Problems panel", async () => {
    const uri = writeFile("bad.sql", "select a,b from t\n");
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
    );
    const diagnostics = await eventually("sqruff diagnostics", () => {
      const found = vscode.languages
        .getDiagnostics(uri)
        .filter((d) => d.source === "sqruff");
      return found.length > 0 ? found : undefined;
    });
    assert.ok(diagnostics[0].message.length > 0, "empty diagnostic message");
  });

  // A parse failure used to come back as an LSP error, which VSCode shows as a
  // toast that names no line and cannot be clicked. Only the real editor can
  // prove it now lands in Problems instead.
  test("reports a parse failure as a diagnostic, not a popup", async () => {
    const uri = writeFile("broken.yaml", "a: 1\n  b: 2\n");
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand(
      "vscode.executeFormatDocumentProvider",
      uri,
      { tabSize: 2, insertSpaces: true },
    );
    const diagnostic = await eventually(
      "the format error",
      () => vscode.languages.getDiagnostics(uri).find((d) => d.source === "poly"),
    );
    assert.strictEqual(diagnostic.range.start.line, 1, "points at line 2");
    assert.ok(
      diagnostic.range.end.character > diagnostic.range.start.character,
      "a zero-width range draws no squiggle",
    );
  });

  // The batch commands go through workspace/executeCommand rather than the
  // document APIs, so they exercise a path no formatting test touches.
  test("Format Folder rewrites files on disk", async () => {
    const folder = join(workspaceRoot(), "batch");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "b.json");
    writeFileSync(file, "{\"b\":1,  \"a\":2}");

    await vscode.commands.executeCommand(
      "poly.formatPath",
      vscode.Uri.file(folder),
    );
    assert.strictEqual(readFileSync(file, "utf8"), "{ \"b\": 1, \"a\": 2 }\n");
  });
});

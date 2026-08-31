import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as vscode from "vscode";

const EXTENSION_ID = "ricky.poly-lsp";

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

suite("poly-lsp in a real editor", () => {
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

  // The VSIX ships one binary with one extension and versions them together,
  // so the pair the test host just wired up has to agree. A mismatch here is
  // the same defect a user would see as a warning badge, caught before release
  // rather than by whoever installs it.
  test("the binary it talks to is its own version", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const serverPath = vscode.workspace
      .getConfiguration("poly")
      .get<string>("serverPath");
    assert.ok(serverPath, "the test host was given no poly.serverPath");
    const reported = execFileSync(serverPath, ["--version"], {
      encoding: "utf8",
    }).trim();
    assert.strictEqual(
      reported,
      `poly ${extension?.packageJSON.version}`,
      "binary and extension versions have drifted",
    );
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

    // Problems has to carry the remedy the terminal carries, in the same
    // words (A4). `select a,b` trips LT01, which sqruff marks fixable, so a
    // diagnostic without the fix line means the CLI and the editor disagree
    // about the same violation.
    assert.ok(
      diagnostics.some((d) => d.message.includes("fix: run `poly fmt`")),
      `no fix line: ${diagnostics.map((d) => d.message).join(" | ")}`,
    );
  });

  // sqruff has no documentation site, so its findings carry no link and the
  // prose compiled into the binary is the only answer to "why is this a rule".
  // The server advertises hoverProvider and the client registers it from that
  // alone -- no extension code is involved, which is exactly why only the real
  // editor can prove the hover arrives.
  test("hovering a sqruff finding shows its rule documentation", async () => {
    const uri = writeFile("hover.sql", "select a,b from t\n");
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
    );
    const flagged = await eventually(
      "a sqruff diagnostic to hover",
      () => vscode.languages.getDiagnostics(uri).find((d) => d.source === "sqruff"),
    );

    const hovers = await eventually("the rule hover", async () => {
      const found = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        uri,
        flagged.range.start,
      );
      return found?.length ? found : undefined;
    });
    const text = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === "string" ? c : c.value))
      .join("\n");
    assert.ok(text.includes("**sqruff/"), `no rule heading: ${text}`);
    // sqruff's own section headings: if these are gone the hover has stopped
    // being the tool's documentation and become poly's paraphrase of it.
    assert.ok(text.includes("Best practice"), `not the rule docs: ${text}`);
  });

  // poly declares no definition provider at initialize -- it cannot, because an
  // LSP capability is server-wide and poly speaks for 29 languages while gopls
  // answers for one. It registers dynamically once gopls is up, scoped to Go,
  // and whether VSCode acts on a registration that arrives after initialize is
  // precisely what no protocol test can tell us.
  test("routes go-to-definition for Go to gopls", async function() {
    this.timeout(60_000);
    try {
      execFileSync("gopls", ["version"], { stdio: "ignore" });
    } catch {
      // Loudly, not silently: poly never installs a language server, so a
      // machine without one genuinely cannot run this.
      console.log("      skipped: gopls is not on PATH");
      this.skip();
    }
    const uri = writeFile(
      "greet.go",
      `package main

func Greet(name string) string {
\treturn "hello " + name
}

func main() {
\tprintln(Greet("world"))
}
`,
    );
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri),
    );
    // Position is inside `Greet` at the call site on line 8; the definition is
    // on line 3. gopls needs a moment to load the package, so poll.
    const locations = await eventually("gopls to resolve the definition", async () => {
      const found = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeDefinitionProvider",
        uri,
        new vscode.Position(7, 10),
      );
      return found?.length ? found : undefined;
    });
    assert.strictEqual(
      locations[0].range.start.line,
      2,
      "definition did not land on the declaration",
    );
    assert.ok(locations[0].uri.fsPath.endsWith("greet.go"), locations[0].uri.fsPath);
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

  // Format-on-save used to need a notification the user had to catch: the
  // "already asked" flag was written before the toast was even shown, so one
  // that faded out unanswered left the feature off forever with nothing in the
  // UI able to turn it on. Found on the Win11 VM, where settings.json had no
  // language section at all. It is now declared in configurationDefaults, which
  // needs no click and touches no user file -- but only the real editor can say
  // whether VSCode honours it.
  //
  // This reads a user setting when there is one, so it only proves anything on
  // a clean profile. The old prompt did write one, and .vscode-test/user-data
  // survives between runs: a stale copy naming the pre-rename extension id sat
  // there passing this test for the wrong reason. Delete that directory if this
  // ever disagrees with package.json.
  test("format-on-save is on for a poly language out of the box", async () => {
    const uri = writeFile("defaults.py", "x = 1\n");
    const editor = vscode.workspace.getConfiguration("editor", {
      uri,
      languageId: "python",
    });
    assert.strictEqual(editor.get<boolean>("formatOnSave"), true);
    assert.strictEqual(editor.get<string>("defaultFormatter"), EXTENSION_ID);
  });

  // The test above runs on a profile that never turned format-on-save off, so
  // it cannot see the case A8 actually has to survive: a user with
  // `"editor.formatOnSave": false` globally. That is not hypothetical -- the
  // machine this was written on has exactly that, plus ~25 language blocks
  // switching it back on one at a time, and whether those blocks are load
  // bearing or redundant is the same question. Nothing in the manifest answers
  // it; only the editor does.
  //
  // Set at workspace scope, which outranks user scope: if a declared default
  // survives this, it survives the weaker case too. Restored in `finally`
  // because everything after it in this file formats on save.
  test("a declared language default outranks a global formatOnSave: false", async () => {
    const uri = writeFile("global-off.py", "x = 1\n");
    const config = vscode.workspace.getConfiguration();
    await config.update(
      "editor.formatOnSave",
      false,
      vscode.ConfigurationTarget.Workspace,
    );
    try {
      assert.strictEqual(
        vscode.workspace
          .getConfiguration("editor", { uri, languageId: "python" })
          .get<boolean>("formatOnSave"),
        true,
      );
      // The control: with no language in scope the user's false is what stands,
      // or this would pass just as well against a setting that never applied.
      assert.strictEqual(
        vscode.workspace.getConfiguration("editor", uri).get<boolean>(
          "formatOnSave",
        ),
        false,
      );
    } finally {
      await config.update(
        "editor.formatOnSave",
        undefined,
        vscode.ConfigurationTarget.Workspace,
      );
    }
  });

  // The toolchain languages were held back on the theory that rust-analyzer,
  // gopls and clangd own them. poly formats rust, c, cpp, swift and terraform
  // by calling the same binary those servers call, so the output is identical,
  // and holding them back meant a .rs file in an editor with no rust-analyzer
  // never formatted at all -- which is how this was reported.
  test("format-on-save covers the toolchain languages too", () => {
    for (const languageId of ["rust", "go", "c", "cpp", "swift", "terraform"]) {
      const editor = vscode.workspace.getConfiguration("editor", {
        uri: vscode.Uri.file(join(workspaceRoot(), `x.${languageId}`)),
        languageId,
      });
      assert.strictEqual(
        editor.get<string>("defaultFormatter"),
        EXTENSION_ID,
        `${languageId} should format with poly`,
      );
      assert.strictEqual(editor.get<boolean>("formatOnSave"), true, languageId);
    }
  });

  // .editorconfig is resolved by the daemon and applied here, and neither half
  // is observable outside a real editor: `editor.options` exists only on a live
  // TextEditor, and an onWillSaveTextDocument participant only runs inside a
  // real save. An .ini is deliberately the subject -- poly does not format it,
  // so this is the whole of what poly does for the file, and it is the case an
  // editor-side EditorConfig extension was there for.
  function writeEditorConfig(): void {
    writeFile(
      ".editorconfig",
      "root = true\n\n[*.ini]\nindent_style = space\nindent_size = 3\n"
        + "trim_trailing_whitespace = true\ninsert_final_newline = true\n",
    );
  }

  test("applies .editorconfig indentation to a file poly does not format", async () => {
    writeEditorConfig();
    const document = await vscode.workspace.openTextDocument(
      writeFile("indent.ini", "[section]\n"),
    );
    const editor = await vscode.window.showTextDocument(document);
    // 3 is a width nothing arrives at by accident: editor.detectIndentation
    // guesses from the file, and this file has no indentation to guess from.
    await eventually(
      "the .editorconfig indent width",
      () => (editor.options.tabSize === 3 ? true : undefined),
    );
    assert.strictEqual(editor.options.insertSpaces, true);
  });

  test("applies .editorconfig save fixes to a file poly does not format", async () => {
    writeEditorConfig();
    const uri = writeFile("save.ini", "[section]\n");
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    // Dirty the buffer first: saving a clean document runs no participants, so
    // writing the trailing whitespace straight to disk would prove nothing.
    await editor.edit((builder) => builder.insert(new vscode.Position(1, 0), "key = value   "));
    assert.ok(await document.save(), "the save was rejected");
    assert.strictEqual(
      readFileSync(uri.fsPath, "utf8"),
      "[section]\nkey = value\n",
      "trailing whitespace trimmed and the file terminated",
    );
  });

  // Two lists in package.json describe the same set of languages, and nothing
  // else notices when one grows without the other: a language added to
  // activationEvents but not to configurationDefaults activates poly and then
  // silently never formats on save.
  test("configurationDefaults covers every activated language", () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON;
    const activated = (pkg.activationEvents as string[])
      .filter((event) => event.startsWith("onLanguage:"))
      .map((event) => event.slice("onLanguage:".length));
    const declared = Object.keys(pkg.contributes.configurationDefaults)
      .map((section) => section.slice(1, -1));
    assert.deepStrictEqual(
      activated.filter((language) => !declared.includes(language)),
      [],
      "activated but never gets format-on-save",
    );
    assert.deepStrictEqual(
      declared.filter((language) => !activated.includes(language)),
      [],
      "given format-on-save but never activates poly",
    );
  });
});

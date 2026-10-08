import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findNodeAtLocation, parseTree } from "jsonc-parser";
import * as vscode from "vscode";

import { cacheDir, RefStore } from "../../editor/refStore";
import { lineOf, rewrite, withValue, WORDS } from "../../editor/settingsBlock";
import { commonRoot, useLines } from "../../gowork";
import { knownNewer, revalidates, updateDue } from "../../update";

const EXTENSION_ID = "ricky.poly-lsp";

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

/// Set a key inside `poly` at one scope, or unset it with `undefined`. `poly`
/// is a single object setting, so the editor's writer takes the whole object at
/// that scope -- as a hand edit of settings.json would leave it.
async function setPoly(key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const seen = config.inspect("poly");
  const current = target === vscode.ConfigurationTarget.Global
    ? seen?.globalValue
    : target === vscode.ConfigurationTarget.Workspace
    ? seen?.workspaceValue
    : seen?.workspaceFolderValue;
  await config.update("poly", withValue(current, key.split("."), value), target);
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

/// A script for Code Runner that says `said` and leaves `marker` behind, so a
/// run is seen both in the output panel and on disk. A shebang, so that it
/// runs under the interpreter it names and needs nothing on PATH.
function runnable(name: string, marker: string, said: string): vscode.Uri {
  rmSync(marker, { force: true });
  return writeFile(name, `#!/bin/sh\necho ${said}\n: > "${marker}"\n`);
}

/// The text of the output panel that says `text`, once one does.
function outputSaying(text: string): string | undefined {
  return vscode.workspace.textDocuments
    .find((one) => one.uri.scheme === "output" && one.getText().includes(text))
    ?.getText();
}

/// Long enough for a run of `runnable`'s script to have left its marker, had
/// one started: the command has resolved by then, and the process takes
/// milliseconds.
async function notRun(marker: string, why: string): Promise<void> {
  await new Promise((done) => setTimeout(done, 2_000));
  assert.ok(!existsSync(marker), why);
}

/// The `run` lens on `uri`, invoked the way a click does.
async function clickRunLens(uri: vscode.Uri): Promise<void> {
  const run = await eventually("the run lens", async () => {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri, 10);
    return lenses?.find((lens) => lens.command?.title === "run")?.command;
  });
  assert.strictEqual(run.command, "poly.runFile");
  await vscode.commands.executeCommand(run.command, ...(run.arguments ?? []));
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
    // Activation finds the user's settings.json by opening it, which a test
    // that opens a file of its own meanwhile could be caught up in.
    await eventually(
      "the poly block in the user's settings.json",
      () => vscode.workspace.getConfiguration().inspect("poly")?.globalValue !== undefined || undefined,
    );
  });

  // The VSIX ships one binary with one extension and versions them together,
  // so the pair the test host just wired up has to agree. A mismatch here is
  // the same defect a user would see as a warning badge, caught before release
  // rather than by whoever installs it.
  test("the binary it talks to is its own version", () => {
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

  // Read off the manifest: a hand-kept list is the one place a new command is
  // guaranteed to be missing from.
  test("contributes every command it declares", async () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON;
    const declared = (pkg.contributes.commands as { command: string }[]).map((entry) => entry.command);
    const registered = await vscode.commands.getCommands(true);
    const missing = declared.filter((id) => !registered.includes(id));
    assert.deepStrictEqual(missing, [], "declared but never registered");
  });

  // A command with a title is in the palette; a command with a keybinding is
  // also in the Keyboard Shortcuts editor, which is the only place a user
  // discovers the shortcut without reading the README. Minify had the first
  // and not the second, so it was reachable and unfindable.
  //
  // Read off the manifest rather than by pressing the keys: what a keystroke
  // resolves to depends on the user's own keybindings.json, which the test
  // host has none of and a real machine may have anything in.
  test("every command is in the palette, and minify and format have shortcuts", () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON;
    const bindings = pkg.contributes.keybindings as { command: string; key: string }[];
    // The one exception is a command that is a keystroke rather than an action:
    // continuing a list is what Enter does, and run from the palette it would
    // act on whatever line the cursor was left on. Undo and redo in the
    // Excalidraw editor are the same: a key kept from VSCode, not an action.
    const keystrokes = new Set(
      bindings.filter((binding) => ["enter", "tab", "shift+tab", "ctrl+z", "ctrl+y"].includes(binding.key)).map((
        binding,
      ) => binding.command),
    );
    // So is a command on a webview's context menu: it acts on the commit,
    // branch or file right-clicked, and from the palette it would have nothing
    // to act on. It is found where it applies, which is what the rule is for.
    const onAThing = new Set(
      (pkg.contributes.menus?.["webview/context"] ?? []).map((entry: { command: string }) => entry.command),
    );
    const hidden = (pkg.contributes.menus?.commandPalette ?? [])
      .filter((entry: { when?: string }) => entry.when === "false")
      .map((entry: { command: string }) => entry.command)
      .filter((id: string) => !keystrokes.has(id) && !onAThing.has(id));
    assert.deepStrictEqual(hidden, [], "declared but kept out of the palette");

    for (const command of ["poly.minify", "poly.formatDocument"]) {
      const keys = bindings.filter((binding) => binding.command === command);
      assert.strictEqual(keys.length, 1, `${command} has no keybinding to show`);
    }
  });

  // VSCode ships no formatter for either language, so any edit at all can only
  // have come from poly's client — which is exactly the registration that
  // broke twice while the protocol tests stayed green.
  // The go.work command's own body needs a modal answer and two real modules,
  // neither of which a test host can supply. What it can pin down is the part
  // that decides where the file lands -- and landing it in the wrong directory
  // is the failure mode that matters, because that directory is usually
  // outside every folder the window has open.
  // The lens is the only entry point most people will ever see for
  // `poly deadcode`, and the thing that breaks it is invisible from a unit
  // test: headers push the first real line well off line 0, and a lens
  // anchored to the wrong line silently stops rendering.
  async function deadCodeLenses(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const lenses = await eventually("the dead code lens", async () => {
      const found = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        uri,
        10,
      );
      return found && found.length > 0 ? found : undefined;
    });
    return lenses.filter((lens) => lens.command?.command === "poly.analyzeDeadCode");
  }

  test("a Go file's lens lands past its build tag and licence header", async () => {
    const mine = await deadCodeLenses(
      writeFile(
        "buildtagged.go",
        "//go:build linux\n\n// Copyright somebody.\n\npackage main\n\nfunc main() {}\n",
      ),
    );
    assert.strictEqual(mine.length, 1, "expected exactly one dead code lens");
    assert.strictEqual(mine[0].range.start.line, 4, "lens is not on the package clause");
  });

  // Every language `poly deadcode` can answer about gets the same lens, and
  // each one hides its first real line behind something different: a shebang
  // in Python, a block comment in TypeScript.
  test("a Python file's lens lands past its shebang and header comment", async () => {
    const mine = await deadCodeLenses(
      writeFile(
        "headed.py",
        "#!/usr/bin/env python3\n# Copyright somebody.\n\nimport os\n\nprint(os.name)\n",
      ),
    );
    assert.strictEqual(mine.length, 1, "expected exactly one dead code lens");
    assert.strictEqual(mine[0].range.start.line, 3, "lens is not on the first statement");
  });

  test("a TypeScript file's lens lands past its block comment", async () => {
    const mine = await deadCodeLenses(
      writeFile(
        "headed.ts",
        "/*\n * Copyright somebody.\n */\n\nexport const answer = 42;\n",
      ),
    );
    assert.strictEqual(mine.length, 1, "expected exactly one dead code lens");
    assert.strictEqual(mine[0].range.start.line, 4, "lens is not on the first statement");
  });

  // Rust has no whole-program dead code analysis to dispatch to, so the lens
  // must not appear: an entry point to a command that answers "nothing to
  // analyse" is worse than no entry point.
  test("a language with no dead code analysis gets no lens", async () => {
    const uri = writeFile("plain.rs", "pub fn f() {}\n");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const found = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      uri,
      10,
    );
    const mine = (found ?? []).filter(
      (lens) => lens.command?.command === "poly.analyzeDeadCode",
    );
    assert.deepStrictEqual(mine, [], "Rust has no deadcode tool to offer");
  });

  test("a go.work goes to the deepest directory covering every module", () => {
    const root = commonRoot([join("/a", "liba"), join("/a", "appb")]);
    assert.strictEqual(root, "/a");
    assert.deepStrictEqual(useLines(root!, [join("/a", "liba"), join("/a", "appb")]), [
      "./appb",
      "./liba",
    ]);

    // A module at the root itself is `.`, which is what go writes.
    assert.deepStrictEqual(useLines("/a", ["/a", join("/a", "sub")]), [".", "./sub"]);

    // One module is its own root; nested modules resolve to the outer one.
    assert.strictEqual(commonRoot([join("/a", "one")]), join("/a", "one"));
    assert.strictEqual(commonRoot([join("/a", "one"), join("/a", "one", "in")]), join("/a", "one"));

    // Nothing to cover, and nothing in common: both have to say so rather than
    // return a root that would put the file somewhere arbitrary.
    assert.strictEqual(commonRoot([]), undefined);
  });

  // A release that was announced is not a release that was installed. The
  // check used to revalidate its cached answer regardless, so once one prompt
  // was dismissed -- or faded into the notification centre unread -- every
  // later check got a 304, read it as "nothing new", and a machine sat on
  // 0.11.0 through seven releases without hearing of any of them.
  test("an announced but uninstalled release is asked for in full again", () => {
    assert.strictEqual(knownNewer("v0.18.0", "0.11.0"), true);
    assert.strictEqual(
      revalidates("W/\"etag\"", "v0.18.0", "0.11.0"),
      false,
      "a 304 has no asset list, so it cannot answer a pending update",
    );
  });

  test("an install that is up to date still saves the round trip", () => {
    assert.strictEqual(revalidates("W/\"etag\"", "v0.18.0", "0.18.0"), true);
    assert.strictEqual(knownNewer("v0.18.0", "0.18.0"), false);
    // Nothing cached is nothing to revalidate against.
    assert.strictEqual(revalidates(undefined, "v0.18.0", "0.18.0"), false);
    assert.strictEqual(revalidates("W/\"etag\"", undefined, "0.18.0"), false);
  });

  // What an interval setting promises -- a check at most every N days, 0 being
  // every start -- and the one thing allowed to override it: a newer release
  // already on record that is not installed yet, which is an install that
  // failed and has to be retried at the next start rather than a week later.
  // Both extensions ask this with their own section's numbers, so it is the
  // whole of what poly.syntax.updateCheck.intervalDays means.
  test("an update check is due by its own interval, sooner for a release not yet installed", () => {
    const day = 86_400_000;
    const now = 100 * day;
    const memento = (values: Record<string, unknown>) =>
      ({
        keys: () => Object.keys(values),
        get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
        update: async () => {},
      }) as unknown as vscode.Memento;
    const checkedYesterday = memento({ "updateCheck.lastCheck": now - day });
    assert.strictEqual(updateDue(checkedYesterday, "0.18.3", 7, now), false);
    assert.strictEqual(updateDue(checkedYesterday, "0.18.3", 1, now), true);
    assert.strictEqual(updateDue(checkedYesterday, "0.18.3", 0, now), true, "0 is every start");
    const unacted = { "updateCheck.lastCheck": now - day, "updateCheck.cachedTag": "v0.18.4" };
    assert.strictEqual(updateDue(memento(unacted), "0.18.3", 7, now), true);
    assert.strictEqual(updateDue(memento(unacted), "0.18.4", 7, now), false, "installed since");
  });

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

  // A buffer that was never saved is outside the client's selector, so the
  // formatter for it is the extension's own and the text travels with the
  // request. Before it, a new markdown note had no formatter at all -- the
  // format shortcut and Format Document both did nothing.
  test("formats a buffer that was never saved", async () => {
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: "#  Title\n\n\n\ntext\n",
    });
    assert.strictEqual(await formatted(document.uri), "# Title\n\ntext\n");
  });

  // The user's settings.json is `vscode-userdata:`, and `[jsonc]` names poly
  // as its formatter -- so before this, the one JSONC file everybody edits had
  // no formatter at all. Comments and the trailing comma are the claim: a JSON
  // formatter that dropped either would ruin the file it was asked to tidy.
  test("formats the user's settings.json, comments and all", async () => {
    await vscode.commands.executeCommand("workbench.action.openSettingsJson");
    const editor = await eventually("the user settings editor", () => {
      const active = vscode.window.activeTextEditor;
      return active?.document.uri.scheme === "vscode-userdata" ? active : undefined;
    });
    try {
      const { document } = editor;
      const whole = new vscode.Range(0, 0, document.lineCount, 0);
      await editor.edit((edit) => edit.replace(whole, "{\n    // kept\n  \"a\":   1,\n}\n"));
      assert.strictEqual(await formatted(document.uri), "{\n  // kept\n  \"a\": 1,\n}\n");
    } finally {
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
  });

  // The block's text is unit-tested; what only a host shows is that poly finds
  // the file at all -- no API says where it is -- and that a switch written
  // into it keeps the comments, where the editor's own writer re-serialises the
  // whole object without them.
  test("the user's settings.json carries the poly block, and a switch keeps its comments", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
    const schema = extension.packageJSON.contributes.configuration.properties.poly;
    const strings = JSON.parse(readFileSync(join(extension.extensionPath, "package.nls.json"), "utf8"));
    const blockIn = (text: string) => {
      const node = findNodeAtLocation(parseTree(text)!, ["poly"]);
      assert.ok(node, "no poly block in the user's settings.json");
      return text.slice(node.offset, node.offset + node.length);
    };
    const written = (text: string, change?: { key: string; value: unknown }) =>
      blockIn(rewrite(text, schema, strings, WORDS.en, change));
    await vscode.commands.executeCommand("workbench.action.openSettingsJson");
    const editor = await eventually("the user settings editor", () => {
      const active = vscode.window.activeTextEditor;
      return active?.document.uri.scheme === "vscode-userdata" ? active : undefined;
    });
    try {
      const before = editor.document.getText();
      assert.strictEqual(blockIn(before), written(before), "the block is not the one this version writes");
      await vscode.commands.executeCommand("poly.toggleFormat");
      assert.strictEqual(blockIn(editor.document.getText()), written(before, { key: "format.enabled", value: false }));
      await vscode.commands.executeCommand("poly.toggleFormat");
      assert.strictEqual(blockIn(editor.document.getText()), blockIn(before), "the way back left the block changed");
    } finally {
      await switchedOn("poly.toggleFormat", "poly.format.enabled");
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
  });

  // The Settings UI's row per key, for the object setting it cannot draw. The
  // list is the real one, its row selected and poly's accept handler run --
  // not Enter, which reaches the list only while this window has the
  // foreground. The value is answered in place of the box. What only a host
  // shows: the choice lands in the block as poly writes it, comments kept, and
  // choosing the default takes the line out again rather than pinning a value
  // the next release cannot change.
  test("Poly: Settings sets a key from a list or a box, and choosing its default unsets it", async () => {
    type Row = vscode.QuickPickItem & { key?: string };
    const window = vscode.window as unknown as Record<string, unknown>;
    const { createQuickPick, showQuickPick, showInputBox } = vscode.window;
    const lists: { pick: vscode.QuickPick<Row>; accept: () => void }[] = [];
    const answers: unknown[] = [];
    window.createQuickPick = () => {
      const pick = createQuickPick<Row>();
      const list = { pick, accept: () => {} };
      const onDidAccept = pick.onDidAccept;
      Object.defineProperty(pick, "onDidAccept", {
        value: (listener: () => void) => {
          list.accept = listener;
          return onDidAccept(listener);
        },
      });
      lists.push(list);
      return pick;
    };
    window.showQuickPick = async (items: Thenable<{ choice: unknown }[]> | { choice: unknown }[]) => {
      const answer = answers.shift();
      return (await items).find((item) => item.choice === answer);
    };
    window.showInputBox = () => Promise.resolve(answers.shift());
    const user = (key: string) => vscode.workspace.getConfiguration("poly").inspect(key)?.globalValue;
    let used = 0;
    const nextList = () =>
      eventually("the settings list", () => (lists[used]?.pick.items.length ? lists[used++] : undefined));
    const choose = async (key: string, answer: unknown) => {
      const { pick, accept } = await nextList();
      answers.push(answer);
      pick.selectedItems = pick.items.filter((item) => item.key === key);
      accept();
    };
    const menu = vscode.commands.executeCommand("poly.openSettings");
    try {
      await choose("codeSnap.shutterAction", "copy");
      await eventually("the chosen value", () => user("codeSnap.shutterAction") === "copy" || undefined);
      await choose("swaggerViewer.defaultPort", "18600");
      await eventually("the typed value", () => user("swaggerViewer.defaultPort") === 18600 || undefined);
      const settings = vscode.workspace.textDocuments.find((doc) =>
        doc.uri.scheme === "vscode-userdata" && doc.uri.path.endsWith("/settings.json")
      )!;
      const text = settings.getText();
      assert.ok(text.includes(WORDS.en.header.slice(0, 40)), "the block lost its comments");
      assert.match(text.split("\n")[lineOf(text, "codeSnap.shutterAction")!], /^\s+"shutterAction": "copy",$/);
      await choose("codeSnap.shutterAction", "save");
      await choose("swaggerViewer.defaultPort", "");
      await eventually(
        "both keys unset",
        () =>
          user("codeSnap.shutterAction") === undefined && user("swaggerViewer.defaultPort") === undefined || undefined,
      );
      assert.match(settings.getText().split("\n")[lineOf(settings.getText(), "codeSnap.shutterAction")!], /^\s+\/\/ /);
      await nextList();
      await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
      await menu;
    } finally {
      Object.assign(window, { createQuickPick, showQuickPick, showInputBox });
      await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
    }
  });

  // The suspend switch lives in the client's middleware, so nothing in the
  // protocol tests can see it: the daemon is asked the same question and gives
  // the same answer, and the whole feature is the client deciding not to ask.
  //
  // Two files, not one. Formatting the control leaves it formatted, so a
  // second pass over the same document returns no edits whether the switch is
  // on or off -- which is exactly the shape of a test that passes against a
  // broken switch.
  test("suspending formatting stops poly rewriting a file", async () => {
    const messy = "select a,b from t\n";
    assert.strictEqual(await formatted(writeFile("resumed.sql", messy)), "select a, b from t\n");

    await setPoly("format.enabled", false, vscode.ConfigurationTarget.Workspace);
    try {
      const uri = writeFile("suspended.sql", messy);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        "vscode.executeFormatDocumentProvider",
        uri,
        { tabSize: 2, insertSpaces: true },
      );
      assert.deepStrictEqual(edits ?? [], [], "poly formatted a file while suspended");
    } finally {
      await setPoly("format.enabled", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  // The switch stops everything that formats on its own, and the shortcut is
  // the one thing it must not stop: a key pressed to format this file now is
  // not a save. Run through the command the keybinding runs, because the hole
  // is in the client -- the provider asked directly still refuses, which the
  // test above holds down.
  test("the format shortcut formats a file while formatting is stopped", async () => {
    const messy = "select a,b from t\n";
    await setPoly("format.enabled", false, vscode.ConfigurationTarget.Workspace);
    try {
      const document = await vscode.workspace.openTextDocument(writeFile("shortcut.sql", messy));
      await vscode.window.showTextDocument(document);
      const text = await eventually("the shortcut to format the file", async () => {
        await vscode.commands.executeCommand("poly.formatDocument");
        return document.getText() === messy ? undefined : document.getText();
      });
      assert.strictEqual(text, "select a, b from t\n");
    } finally {
      await setPoly("format.enabled", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  // What the highlight exists for, and the two things the daemon's unicode
  // rules cannot do: a file type they are never sent, and a character nobody
  // has saved yet.
  test("the unicode highlight names a character typed into a plain-text file", async () => {
    await setPoly("unicodeHighlight.enabled", true, vscode.ConfigurationTarget.Workspace);
    try {
      const document = await vscode.workspace.openTextDocument(writeFile("gremlin.txt", "plain line\n"));
      const editor = await vscode.window.showTextDocument(document);
      await editor.edit((edit) => edit.insert(new vscode.Position(0, 5), "\u200b"));
      const said = await eventually("a hover on the typed character", async () => {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          "vscode.executeHoverProvider",
          document.uri,
          new vscode.Position(0, 5),
        );
        const text = hovers
          .flatMap((hover) => hover.contents)
          .map((part) => (typeof part === "string" ? part : part.value))
          .find((value) => value.startsWith("U+200B"));
        return text;
      });
      assert.strictEqual(said, "U+200B ZERO WIDTH SPACE does not render as what it is");
      assert.ok(document.isDirty, "the file was saved, so this no longer shows the unsaved case");
    } finally {
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      await setPoly("unicodeHighlight.enabled", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  // What the kept counts are for: a number on screen before the language
  // server has said anything -- here a deliberately wrong one, so that where
  // it came from is not in doubt -- and the server's own once it has.
  test("a reference count kept from last session is drawn at once, then corrected", async () => {
    const uri = writeFile("kept.ts", "export function kept(): number {\n  return 1;\n}\n");
    const folder = workspaceRoot();
    const store = new RefStore(cacheDir());
    store.set(folder, "kept.ts", `refs|${vscode.SymbolKind.Function}:kept#0`, 42);
    store.save();
    await setPoly("referencesCodeLens.enabled", true, vscode.ConfigurationTarget.Workspace);
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      const titles = async () => {
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
          "vscode.executeCodeLensProvider",
          uri,
          10,
        );
        // The reference lens alone: the dead-code lens is on in this suite
        // and sits on the same line.
        const said = lenses.flatMap((lens) => lens.command?.title ?? []).filter((title) => / refs?$/.test(title));
        return said.length > 0 ? said : undefined;
      };
      assert.deepStrictEqual(await eventually("a lens", titles), ["42 refs"]);
      const corrected = await eventually("the server's count", async () => {
        const said = await titles();
        return said && !said.includes("42 refs") ? said : undefined;
      });
      assert.deepStrictEqual(corrected, ["no refs"]);
    } finally {
      await setPoly("referencesCodeLens.enabled", undefined, vscode.ConfigurationTarget.Workspace);
      rmSync(store.fileFor(folder), { force: true });
    }
  });

  // R's symbols came from arity through poly's relay, which is gone: the lens
  // now stands on whatever R extension answers, and none is installed here.
  // So nothing is drawn until something answers, and then the count is drawn
  // over the first assignment -- the test plays the R extension.
  test("an R file gets reference lenses from whichever extension answers for R", async () => {
    const uri = writeFile("lens.R", "add <- function(a, b) a + b\nadd(1, 2)\n");
    const document = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(document.languageId, "r");
    await setPoly("referencesCodeLens.enabled", true, vscode.ConfigurationTarget.Workspace);
    const subscriptions: vscode.Disposable[] = [];
    const titles = async () => {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri, 10);
      return lenses.flatMap((lens) => lens.command?.title ?? []).filter((title) => / refs?$/.test(title));
    };
    try {
      await vscode.window.showTextDocument(document);
      assert.deepStrictEqual(await titles(), [], "a lens over R with nothing answering for R");
      const declared = new vscode.Range(0, 0, 0, 3);
      subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider({ language: "r" }, {
          provideDocumentSymbols: () => [
            new vscode.DocumentSymbol(
              "add",
              "",
              vscode.SymbolKind.Function,
              new vscode.Range(0, 0, 0, 27),
              declared,
            ),
          ],
        }),
        vscode.languages.registerReferenceProvider({ language: "r" }, {
          provideReferences: () => [
            new vscode.Location(uri, declared),
            new vscode.Location(uri, new vscode.Range(1, 0, 1, 3)),
          ],
        }),
      );
      const drawn = await eventually("the R lens", async () => {
        const said = await titles();
        return said.length > 0 && !said.includes("no refs") ? said : undefined;
      });
      assert.deepStrictEqual(drawn, ["1 ref"]);
    } finally {
      subscriptions.forEach((one) => one.dispose());
      await setPoly("referencesCodeLens.enabled", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test("the toggle command flips the switch both ways", async () => {
    const value = () => vscode.workspace.getConfiguration("poly").get<boolean>("format.enabled");
    assert.strictEqual(value(), true, "the switch did not start on");
    try {
      await vscode.commands.executeCommand("poly.toggleFormat");
      assert.strictEqual(value(), false);
      await vscode.commands.executeCommand("poly.toggleFormat");
      assert.strictEqual(value(), true);
      // Back where it started, which is no line in settings.json at all. A
      // left-behind `true` looks like a choice and outlives a changed default.
      const written = vscode.workspace.getConfiguration("poly").inspect<boolean>("format.enabled");
      assert.strictEqual(written?.globalValue, undefined, "toggling back left a user setting behind");
    } finally {
      await setPoly("format.enabled", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  // The switches reach other extensions' settings, which is only worth having
  // if the way back is exact: they write the user's settings.json, and a
  // switch that leaves it different from how it found it is one nobody clicks
  // twice. These run the real commands against real settings, so each one
  // puts the switch back on and removes what it set, whatever happens.
  const root = () => vscode.workspace.getConfiguration();
  const inLanguage = (languageId: string) => vscode.workspace.getConfiguration(undefined, { languageId });
  const Global = vscode.ConfigurationTarget.Global;
  async function switchedOn(command: string, key: string): Promise<void> {
    if (root().get(key) === false) {
      await vscode.commands.executeCommand(command);
    }
  }

  // The case that made a global-only toggle useless: golang.go ships `[go]`
  // format-on-save as a language default, and a language default outranks a
  // global `false`. The fixture extension ships the same shape for `[bat]`.
  // `[json]` is the other way a language gets its own value: the user's block,
  // here with an `explicit` organizeImports, which still runs on every Cmd+S.
  test("stopping formatting reaches a language's own default, and resuming puts back exactly what was there", async () => {
    assert.strictEqual(
      inLanguage("bat").get("editor.formatOnSave"),
      true,
      "the fixture's language default is not in effect",
    );
    await root().update("editor.formatOnType", true, Global);
    await inLanguage("json").update("editor.formatOnPaste", true, Global, true);
    await root().update("editor.codeActionsOnSave", { "source.fixAll": "always" }, Global);
    const explicit = { "source.organizeImports": "explicit" };
    await inLanguage("json").update("editor.codeActionsOnSave", explicit, Global, true);
    try {
      await vscode.commands.executeCommand("poly.toggleFormat");
      assert.strictEqual(root().get("poly.format.enabled"), false);
      assert.strictEqual(
        inLanguage("bat").get("editor.formatOnSave"),
        false,
        "a language default outranked the switch",
      );
      assert.strictEqual(root().get("editor.formatOnType"), false);
      assert.strictEqual(
        inLanguage("json").get("editor.formatOnPaste"),
        false,
        "a user's [json] block outranked the switch",
      );
      for (const scope of [root(), inLanguage("bat"), inLanguage("json")]) {
        const actions = scope.get<Record<string, unknown>>("editor.codeActionsOnSave") ?? {};
        assert.ok(Object.values(actions).every((one) => one === "never"), JSON.stringify(actions));
      }

      await vscode.commands.executeCommand("poly.toggleFormat");
      assert.strictEqual(root().inspect("poly.format.enabled")?.globalValue, undefined);
      assert.strictEqual(
        inLanguage("bat").inspect("editor.formatOnSave")?.globalLanguageValue,
        undefined,
        "resuming left a [bat] line in settings.json",
      );
      assert.strictEqual(inLanguage("bat").get("editor.formatOnSave"), true);
      assert.strictEqual(root().inspect("editor.formatOnType")?.globalValue, true);
      assert.strictEqual(inLanguage("json").inspect("editor.formatOnPaste")?.globalLanguageValue, true);
      assert.deepStrictEqual(root().inspect("editor.codeActionsOnSave")?.globalValue, { "source.fixAll": "always" });
      assert.strictEqual(
        inLanguage("bat").inspect("editor.codeActionsOnSave")?.globalLanguageValue,
        undefined,
        "resuming left a [bat] organizeImports line in settings.json",
      );
      assert.deepStrictEqual(inLanguage("json").inspect("editor.codeActionsOnSave")?.globalLanguageValue, explicit);
    } finally {
      await switchedOn("poly.toggleFormat", "poly.format.enabled");
      await root().update("editor.formatOnType", undefined, Global);
      await inLanguage("json").update("editor.formatOnPaste", undefined, Global, true);
      await root().update("editor.codeActionsOnSave", undefined, Global);
      await inLanguage("json").update("editor.codeActionsOnSave", undefined, Global, true);
    }
  });

  test("a setting changed while formatting was stopped is not undone by resuming", async () => {
    await root().update("files.trimTrailingWhitespace", true, Global);
    try {
      await vscode.commands.executeCommand("poly.toggleFormat");
      assert.strictEqual(root().get("files.trimTrailingWhitespace"), false);
      // A decision made while stopped: the default after all. It is later
      // than the snapshot, so it wins over the snapshot.
      await root().update("files.trimTrailingWhitespace", undefined, Global);
      await vscode.commands.executeCommand("poly.toggleFormat");
      assert.strictEqual(
        root().inspect("files.trimTrailingWhitespace")?.globalValue,
        undefined,
        "resuming overwrote a setting changed while stopped",
      );
    } finally {
      await switchedOn("poly.toggleFormat", "poly.format.enabled");
      await root().update("files.trimTrailingWhitespace", undefined, Global);
    }
  });

  // The other half of the rule above, and the one that left a user's synced
  // settings.json full of `"never"`: a value that is still off is poly's, even
  // when something reshaped it while stopped, and resuming has to take it back.
  test("a value still off when formatting resumes is put back, whatever its shape", async () => {
    await root().update("editor.codeActionsOnSave", { "source.fixAll": "always" }, Global);
    try {
      await vscode.commands.executeCommand("poly.toggleFormat");
      assert.deepStrictEqual(root().inspect("editor.codeActionsOnSave")?.globalValue, { "source.fixAll": "never" });
      await root().update(
        "editor.codeActionsOnSave",
        { "source.fixAll": "never", "source.organizeImports": "never" },
        Global,
      );
      await vscode.commands.executeCommand("poly.toggleFormat");
      assert.deepStrictEqual(
        root().inspect("editor.codeActionsOnSave")?.globalValue,
        { "source.fixAll": "always" },
        "resuming left an off value behind",
      );
    } finally {
      await switchedOn("poly.toggleFormat", "poly.format.enabled");
      await root().update("editor.codeActionsOnSave", undefined, Global);
    }
  });

  // Asserted on the screen rather than on the setting: the daemon read the
  // setting once at spawn, so a switch that only wrote it would leave every
  // finding in place until the next reload -- and look like it did nothing.
  test("stopping lint takes poly's findings off the file at once, and resuming brings them back", async () => {
    const uri = writeFile("quiet.css", ".a\u200bb { color: red; }\n");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const mine = () => vscode.languages.getDiagnostics(uri).filter((one) => one.source === "poly");
    await eventually("poly's findings before stopping", () => mine().length > 0 || undefined);
    try {
      await vscode.commands.executeCommand("poly.toggleLint");
      assert.strictEqual(root().get("poly.lintOnSave"), false);
      await eventually("poly's findings to go", () => mine().length === 0 || undefined, 20_000);
    } finally {
      await switchedOn("poly.toggleLint", "poly.lintOnSave");
    }
    assert.strictEqual(root().inspect("poly.lintOnSave")?.globalValue, undefined);
    await eventually("poly's findings to come back", () => mine().length > 0 || undefined);
  });

  // The list of languages minify offers itself for exists twice -- MINIFIABLE
  // in the client, `minifiable_language` in the daemon -- and neither copy can
  // check the other. This is what keeps them in step, and it does it by
  // behaviour rather than by comparing lists: every language the client claims
  // has to come back with a collapsed buffer.
  //
  // Asserted on the buffer and not on a returned value, because the command
  // applies the edits itself and returns nothing. A version that fetched edits
  // and quietly dropped them would pass any test that only read the response.
  test("minify collapses a buffer in every language poly claims", async () => {
    const cases = [
      ["min.json", "{\n  \"b\": 1,\n  \"a\": 2\n}\n", "{\"b\":1,\"a\":2}"],
      ["min.css", "/* gone */\n.a .b {\n  color: red;\n}\n", ".a .b{color:red}"],
      // The spaces around <em> are the claim: they are whitespace the renderer
      // draws, and an HTML minifier that collapsed them would change the page.
      ["min.html", "<p>\n  a <em>b</em> c\n</p>\n", "<p>a <em>b</em> c</p>"],
      ["min.xml", "<a>\n  <b>c</b>\n</a>\n", "<a><b>c</b></a>"],
      ["min.js", "// gone\nexport const n = 1;\n", "export const n=1;"],
    ];
    for (const [name, before, after] of cases) {
      const uri = writeFile(name, before);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("poly.minify");
      assert.strictEqual(document.getText(), after, name);
    }
  });

  // The other half of the same claim, and the one a list-comparison test could
  // never make: a language poly formats and refuses to minify has to come back
  // untouched rather than collapsed.
  test("minify leaves a whitespace-significant file alone", async () => {
    const text = "a:\n  - 1\n";
    const uri = writeFile("min.yaml", text);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("poly.minify");
    assert.strictEqual(document.getText(), text, "minify rewrote a YAML file");
  });

  // CSS on purpose: poly formats it and has no linter for it, so `lint_engine`
  // answers None and a squiggle here cannot have come from an engine. That is
  // the claim -- the unicode pass runs beside the per-language ones rather than
  // inside them, and a version that dispatched it through the engine table
  // would leave this file silent.
  //
  // Written with an escape rather than the character, so this file does not
  // itself contain a zero-width space. `make dogfood` lints this repository
  // with this very rule, and a fixture that trips it is a fixture that has to
  // be excused on every run.
  test("underlines a zero-width space in a language with no linter", async () => {
    const uri = writeFile("gremlin.css", ".a\u200bb { color: red; }\n");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const diagnostics = await eventually("unicode diagnostics", () => {
      const found = vscode.languages
        .getDiagnostics(uri)
        .filter((d) => d.source === "poly" && String(d.code).startsWith("unicode-"));
      return found.length > 0 ? found : undefined;
    });
    assert.strictEqual(diagnostics.length, 1, "more than the zero-width space");
    assert.strictEqual(diagnostics[0].code, "unicode-invisible");
    // The position is load-bearing: the daemon reads this one from the buffer
    // rather than from disk, and a version that read the file would still find
    // a zero-width space -- just not necessarily this one.
    assert.strictEqual(diagnostics[0].range.start.line, 0);
    assert.strictEqual(diagnostics[0].range.start.character, 2);
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

  // The other half of the test above. YAML has no poly rule that reports a
  // parse failure, so there the formatter's error is the only report of it;
  // TypeScript has one, and a broken .ts used to draw two squiggles over the
  // same character -- `typescript/syntax` from the linter on change and
  // `poly/format` from the formatter on save, same line, same column, the same
  // sentence. Only the real editor can show which of them the Problems panel
  // ends up with, because the merge happens on the way out of the server.
  //
  // TypeScript rather than TOML, which is where this test started: the host
  // runs poly-lsp alone, and the `toml` language id comes from poly-highlight,
  // so a .toml file is plaintext here and never reaches the document selector.
  test("a file that does not parse reports it once", async () => {
    const uri = writeFile("broken.ts", "const = 1\n");
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    await eventually(
      "the syntax finding",
      () => vscode.languages.getDiagnostics(uri).find((d) => d.source === "typescript"),
    );
    // The server publishes before it answers this request and the client
    // handles messages in order, so anything the formatter had to say has
    // arrived by the time this resolves -- no sleep, and no false pass.
    await vscode.commands.executeCommand(
      "vscode.executeFormatDocumentProvider",
      uri,
      { tabSize: 2, insertSpaces: true },
    );
    // `ts` is the built-in TypeScript service, entitled to its own opinion
    // about the same file. `poly` is the formatter's copy of the linter's, and
    // it is the only source this test is about.
    const sources = vscode.languages.getDiagnostics(uri).map((d) => d.source);
    assert.ok(sources.includes("typescript"), `lost the syntax finding: ${sources}`);
    assert.ok(
      !sources.includes("poly"),
      `the formatter repeated a parse failure the linter already reported: ${sources}`,
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

  // The conversions are unit-tested; what only a real host shows is the wiring
  // around them -- the lazy bundle found beside dist/extension.js, and the
  // output landing where the save dialog said. The simple dialog turns the
  // native one into a quick input, so both prompts accept the same way: the
  // first dialect, then the proposed path. The file is plaintext here (the
  // host has no poly-syntax-highlight), which is the extension check's case.
  test("DBML to SQL writes the file the save dialog proposes", async () => {
    await vscode.workspace
      .getConfiguration("files")
      .update("simpleDialog.enable", true, vscode.ConfigurationTarget.Global);
    const target = join(workspaceRoot(), "schema.sql");
    rmSync(target, { force: true });
    const uri = writeFile("schema.dbml", "Table users {\n  id int [pk]\n}\n");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const running = vscode.commands.executeCommand("poly.dbmlToSql");
    await eventually("the converted file", async () => {
      await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
      try {
        return readFileSync(target, "utf8");
      } catch {
        return undefined;
      }
    });
    await running;
    assert.match(readFileSync(target, "utf8"), /CREATE TABLE "users"/);
  });

  // What only a host shows: that a colour set in poly.syntaxColors reaches the
  // one setting a theme reads. The merge is unit-tested; this is the write into
  // the user's settings.json, which fails silently with the wrong target.
  test("a syntax colour set in poly.syntaxColors reaches the theme, and goes when the entry does", async () => {
    const rules = () =>
      (vscode.workspace.getConfiguration("editor").inspect<{ textMateRules?: unknown[] }>(
        "tokenColorCustomizations",
      )?.globalValue?.textMateRules ?? []) as { name?: string; scope?: string; settings?: object }[];
    try {
      await setPoly("syntaxColors", { comment: "#6A9955 italic" }, vscode.ConfigurationTarget.Global);
      const rule = await eventually("the mirrored rule", () => rules().find((one) => one.name === "poly.syntaxColors"));
      assert.deepStrictEqual(rule, {
        name: "poly.syntaxColors",
        scope: "comment",
        settings: { foreground: "#6A9955", fontStyle: "italic" },
      });
      await setPoly("syntaxColors", undefined, vscode.ConfigurationTarget.Global);
      await eventually("the rule to go", () => rules().length === 0 ? true : undefined);
    } finally {
      await setPoly("syntaxColors", undefined, vscode.ConfigurationTarget.Global);
      await vscode.workspace
        .getConfiguration("editor")
        .update("tokenColorCustomizations", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  // A remote window's case, made here: a file whose grammar poly cannot see,
  // because a remote host sees none of the local side's. Refusing there left
  // no way to colour anything; the scope is typed instead and lands like one
  // picked from the list.
  test("Set Syntax Color takes a typed scope when the file's grammar is out of sight", async () => {
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument({ language: "plaintext", content: "x\n" }),
    );
    assert.ok(
      !vscode.extensions.all.some((one) =>
        (one.packageJSON?.contributes?.grammars ?? []).some((grammar: { language?: string }) =>
          grammar.language === "plaintext"
        )
      ),
      "plaintext has a grammar now, so this no longer reaches the typed path",
    );
    const window = vscode.window as unknown as Record<string, unknown>;
    const { showInputBox } = vscode.window;
    const answers = ["comment", "#6A9955 italic"];
    window.showInputBox = () => Promise.resolve(answers.shift());
    try {
      await vscode.commands.executeCommand("poly.setSyntaxColor");
      assert.deepStrictEqual(answers, [], "the command stopped before asking for both");
      await eventually(
        "the typed scope in poly.syntaxColors",
        () =>
          vscode.workspace.getConfiguration("poly").inspect<Record<string, string>>("syntaxColors")?.globalValue
              ?.comment === "#6A9955 italic" || undefined,
      );
    } finally {
      window.showInputBox = showInputBox;
      await setPoly("syntaxColors", undefined, vscode.ConfigurationTarget.Global);
      await vscode.workspace
        .getConfiguration("editor")
        .update("tokenColorCustomizations", undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
  });

  // The conversion is unit-tested against OpenCC; this is the bundle found
  // beside dist/extension.js and the edit landing in every selection.
  test("Chinese conversion rewrites each selection, and the whole file when there is none", async () => {
    const editor = await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument({ content: "鼠标\n软件\n里面\n" }),
    );
    editor.selections = [
      new vscode.Selection(0, 0, 0, 2),
      new vscode.Selection(1, 0, 1, 2),
    ];
    await vscode.commands.executeCommand("poly.toTraditionalChineseTaiwan");
    assert.strictEqual(editor.document.getText(), "滑鼠\n軟體\n里面\n");
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand("poly.toSimplifiedChineseTaiwan");
    assert.strictEqual(editor.document.getText(), "鼠标\n软件\n里面\n");
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  });

  // The engine and the ranges are unit-tested; this is what only a host shows:
  // the switch, the bundle and its wasm found beside dist/extension.js, a
  // quick fix, a manual save, and `.autocorrectrc` followed both ways. The
  // second way is the one the extension got wrong -- its engine only merges a
  // configuration in, so a rule taken back out stayed off until a reload.
  test("AutoCorrect reports, fixes, corrects on save, and follows .autocorrectrc both ways", async () => {
    const rc = join(workspaceRoot(), ".autocorrectrc");
    const uri = writeFile("autocorrect.md", "测试test文本\n第二行hello世界\n");
    const findings = () => vscode.languages.getDiagnostics(uri).filter((one) => one.source === "AutoCorrect");
    const said = (message: string) => () => findings().some((one) => one.message === message) ? true : undefined;
    try {
      await setPoly("autocorrect.enabled", true, vscode.ConfigurationTarget.Global);
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      await eventually("a finding on each line", () => findings().length === 2 ? true : undefined);

      const first = findings().find((one) => one.range.start.line === 0);
      assert.ok(first);
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        "vscode.executeCodeActionProvider",
        uri,
        first.range,
      );
      const fix = actions.find((action) => action.title === "AutoCorrect: 测试 test 文本");
      assert.ok(fix?.edit, `no quick fix among ${actions.map((action) => action.title)}`);
      await vscode.workspace.applyEdit(fix.edit);
      assert.strictEqual(editor.document.lineAt(0).text, "测试 test 文本");

      await vscode.commands.executeCommand("workbench.action.files.save");
      assert.strictEqual(readFileSync(uri.fsPath, "utf8"), "测试 test 文本\n第二行 hello 世界\n");

      // Comma between CJK is a second rule, so each answer is a finding that
      // says which rules were in force -- never just an absence of findings.
      writeFileSync(rc, "rules:\n  space-word: 0\n");
      await editor.edit((edit) => edit.replace(editor.document.lineAt(0).range, "测试test文本,中文"));
      await eventually("space-word off", said("测试test文本，中文"));
      rmSync(rc);
      await editor.edit((edit) => edit.insert(editor.document.lineAt(1).range.end, " "));
      await eventually("space-word back on", said("测试 test 文本，中文"));
    } finally {
      rmSync(rc, { force: true });
      await setPoly("autocorrect.enabled", undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
  });

  // What it draws is upstream's and unit-tested against a stub; what only a
  // host shows is the wiring. Off by default; hidden from the palette only
  // while usernamehw.errorlens runs instead; a command run while it is off
  // loading the bundle beside dist/extension.js and acting; and drawing on a
  // real editor without throwing once switched on.
  test("Error Lens is off until switched on, and its commands work either way", async () => {
    const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON;
    const errorLens = () => vscode.workspace.getConfiguration("poly.errorLens");
    assert.strictEqual(errorLens().inspect("enabled")?.defaultValue, false);
    const commands = (pkg.contributes.commands as { command: string }[])
      .map((entry) => entry.command)
      .filter((id) => id.startsWith("poly.errorLens."));
    const palette = pkg.contributes.menus.commandPalette as { command: string; when?: string }[];
    for (const command of commands) {
      const entry = palette.find((one) => one.command === command);
      assert.strictEqual(entry?.when, "!poly.yield.errorLens", command);
    }

    const uri = writeFile("errorLens.txt", "first\nsecond line\n");
    const planted = vscode.languages.createDiagnosticCollection("errorLens-test");
    try {
      const problem = new vscode.Diagnostic(
        new vscode.Range(1, 7, 1, 11),
        "a planted problem",
        vscode.DiagnosticSeverity.Warning,
      );
      planted.set(uri, [problem]);
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      await vscode.commands.executeCommand("poly.errorLens.selectProblem");
      assert.deepStrictEqual(
        [editor.selection.start.line, editor.selection.start.character, editor.selection.end.character],
        [1, 7, 11],
      );

      // The toggle writes the setting without waiting for it, hence the polls.
      await vscode.commands.executeCommand("poly.errorLens.toggle");
      await eventually("Error Lens switched on", () => errorLens().get("enabled") === true || undefined);
      await vscode.commands.executeCommand("poly.errorLens.updateEverything");
      await vscode.commands.executeCommand("poly.errorLens.toggle");
      await eventually("Error Lens switched off", () => errorLens().get("enabled") === false || undefined);
    } finally {
      planted.dispose();
      await setPoly("errorLens.enabled", undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
  });

  // The PlantUML logic is unit-tested and measured against jebbs.plantuml
  // (tools/plantuml-diff); what only a host shows is the wiring: that the jar
  // poly.toml pins is the one run, by the configured Java, and that the export
  // and the markdown fence both land. The "Java" is a script that records its
  // arguments and answers with a fixed picture, so neither a JVM nor a
  // download is part of the test.
  test("PlantUML runs the jar poly.toml pins with the configured Java", async () => {
    const root = workspaceRoot();
    const log = join(root, "java-args.txt");
    const java = join(root, "fake-java");
    const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>poly-e2e</text></svg>";
    writeFileSync(java, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\ncat >/dev/null\nprintf '%s' '${svg}'\n`, {
      mode: 0o755,
    });
    writeFileSync(join(root, "fake-plantuml.jar"), "not a jar");
    writeFileSync(join(root, "poly.toml"), "[tools]\nplantuml = \"./fake-plantuml.jar\"\n");
    const settings: [string, unknown][] = [
      ["plantuml.java", java],
      ["plantuml.exportFormat", "svg"],
      ["markdownDiagrams.enabled", true],
    ];
    try {
      for (const [key, value] of settings) {
        await setPoly(key, value, vscode.ConfigurationTarget.Workspace);
      }
      const uri = writeFile("flow.puml", "@startuml flow\nA -> B\n@enduml\n");
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      // Not awaited: it resolves when its report message is dismissed.
      void vscode.commands.executeCommand("poly.plantumlExportDocument");
      const exported = join(root, "out", "flow", "flow.svg");
      await eventually("the export", () => {
        try {
          return readFileSync(exported, "utf8");
        } catch {
          return undefined;
        }
      });
      assert.strictEqual(readFileSync(exported, "utf8"), svg);
      const args = readFileSync(log, "utf8").split("\n");
      // Compared as files: poly reports the pin under the real temp directory
      // (/private/var on macOS), the workspace URI names it by its symlink.
      const jar = args[args.indexOf("-jar") + 1];
      assert.ok(
        args.includes("-jar") && realpathSync(jar) === realpathSync(join(root, "fake-plantuml.jar")),
        `not the pinned jar: ${args.join(" ")}`,
      );
      assert.ok(args.includes("-pipeimageindex") && args.includes("-tsvg"), args.join(" "));

      const notes = await vscode.workspace.openTextDocument(writeFile("notes-puml.md", "```plantuml\nA -> B\n```\n"));
      // The first render shows the source while Java runs; the picture comes
      // with the refresh after it.
      await eventually("the fence's picture", async () => {
        const html = await vscode.commands.executeCommand<string>("markdown.api.render", notes);
        return html.includes(Buffer.from(svg).toString("base64")) ? html : undefined;
      });
    } finally {
      for (const [key] of settings) {
        await setPoly(key, undefined, vscode.ConfigurationTarget.Workspace);
      }
      rmSync(join(root, "poly.toml"), { force: true });
    }
  });

  // The page is pomdtr's, rebuilt and measured against it by
  // tools/excalidraw-diff; what only a host shows is that it loads under its
  // CSP and saves through the document. An empty file is the one the page
  // writes to untouched, so a scene arriving on disk means the bundle ran.
  test("an empty Excalidraw file opens in the editor and saves a scene", async () => {
    const uri = writeFile("sketch.excalidraw", "");
    await vscode.commands.executeCommand("vscode.open", uri);
    const active = () => vscode.window.tabGroups.activeTabGroup.activeTab;
    await eventually("the Excalidraw editor", () => {
      const input = active()?.input;
      return input instanceof vscode.TabInputCustom && input.viewType === "poly.excalidraw" ? input : undefined;
    });
    await eventually("the page's first change", () => active()?.isDirty || undefined);
    await vscode.commands.executeCommand("workbench.action.files.save");
    const scene = JSON.parse(readFileSync(uri.fsPath, "utf8"));
    assert.strictEqual(scene.type, "excalidraw");
    assert.strictEqual(scene.source, "https://github.com/linzeyan/vscode-syntax");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  // pomdtr's revert put back the file and left the page drawing what was
  // thrown away; the next edit then saved all of it. The page reloads here,
  // and an empty file shows that it did: reloaded, it writes to it again.
  test("reverting an Excalidraw file reloads the page", async () => {
    const uri = writeFile("reverted.excalidraw", "");
    await vscode.commands.executeCommand("vscode.open", uri);
    const dirty = () => vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty;
    await eventually("the page's first change", () => dirty() || undefined);
    await vscode.commands.executeCommand("workbench.action.files.revert");
    assert.strictEqual(dirty(), false, "revert left the document dirty");
    await eventually("the reloaded page's change", () => dirty() || undefined, 15_000);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  });

  // The converter is yzane.markdown-pdf's, and everything it writes is measured
  // against that extension by tools/markdown-pdf-diff. What only a host shows
  // is the wiring: the lazy bundle found beside dist/extension.js, with the
  // styles and KaTeX fonts the build lays out in dist/markdown-pdf. Also what
  // poly does differently in the HTML: emoji as characters, and a folder named
  // `*.md.d` kept in the path, where upstream's rename writes into a folder that
  // does not exist.
  test("markdown exports HTML beside the file, with its styles and emoji as characters", async () => {
    const folder = join(workspaceRoot(), "notes.md.d");
    mkdirSync(folder, { recursive: true });
    const source = join(folder, "page.md");
    writeFileSync(source, "# Page\n\n- [x] done\n\n:smile: and $x^2$\n\n```js\nlet a = 1;\n```\n");
    const target = join(folder, "page.html");
    rmSync(target, { force: true });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source));
    await vscode.commands.executeCommand("poly.markdownExportHtml");
    const html = readFileSync(target, "utf8");
    assert.ok(html.includes("<p>😄 and <span class=\"katex\">"), "emoji or math not rendered");
    assert.ok(
      html.includes("<input type=\"checkbox\" id=\"checkbox0\" checked=\"true\"><label for=\"checkbox0\">done"),
    );
    assert.match(html, /\.hljs-keyword/, "no highlight.js theme: dist/markdown-pdf/styles is missing");
    assert.match(html, /url\(data:font\/woff2;base64,/, "no KaTeX fonts: dist/markdown-pdf/styles/katex is missing");
  });

  // Upstream converts whichever editor is in front when anything is saved, so
  // Save All or a save from the explorer exports the wrong file.
  test("convert-on-save exports the file saved, not the one in front", async () => {
    const settings: [string, unknown][] = [
      ["markdownPdf.convertOnSave", true],
      ["markdownPdf.type", ["html"]],
    ];
    const saved = join(workspaceRoot(), "saved.md");
    const front = join(workspaceRoot(), "front.md");
    try {
      for (const [key, value] of settings) {
        await setPoly(key, value, vscode.ConfigurationTarget.Workspace);
      }
      writeFileSync(saved, "# Saved\n");
      writeFileSync(front, "# Front\n");
      for (const file of [saved, front]) {
        rmSync(file.replace(/\.md$/, ".html"), { force: true });
      }
      const document = await vscode.workspace.openTextDocument(saved);
      await vscode.window.showTextDocument(document);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, new vscode.Position(1, 0), "\nMore.\n");
      await vscode.workspace.applyEdit(edit);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(front));
      await document.save();
      const html = await eventually("the saved file's export", () => {
        try {
          // Hundreds of KB with the styles and fonts inlined: read once it is
          // whole, not while it is being written.
          const text = readFileSync(saved.replace(/\.md$/, ".html"), "utf8");
          return text.includes("</html>") ? text : undefined;
        } catch {
          return undefined;
        }
      });
      assert.ok(html.includes("<p>More.</p>"), "exported before the save, or from the old text");
      assert.throws(() => readFileSync(front.replace(/\.md$/, ".html")), "the editor in front was exported");
    } finally {
      for (const [key] of settings) {
        await setPoly(key, undefined, vscode.ConfigurationTarget.Workspace);
      }
    }
  });

  // The page and the picture it takes are adpyke.codesnap's, measured against
  // it by tools/codesnap-diff. What only a host shows is the wiring: the page
  // read from dist/codesnap, opened beside the code without taking the focus
  // from it, and each selection handed over -- by way of the clipboard, which
  // is where the page pastes the colored code from.
  test("CodeSnap opens beside the code and follows the selection", async () => {
    const document = await vscode.workspace.openTextDocument(
      writeFile("snap.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n"),
    );
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const page = () =>
      vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith("poly.codeSnap")
      );
    await vscode.env.clipboard.writeText("before");
    try {
      editor.selection = new vscode.Selection(0, 0, 1, 12);
      await vscode.commands.executeCommand("poly.codeSnap");
      const tab = await eventually("the CodeSnap page", page);
      assert.notStrictEqual(tab.group.viewColumn, vscode.ViewColumn.One, "the page did not open beside the code");
      assert.strictEqual(vscode.window.activeTextEditor?.document, document, "the page took the focus");
      await eventually(
        "the selection handed over",
        async () => await vscode.env.clipboard.readText() === "const a = 1;\nconst b = 2;" || undefined,
      );
      editor.selection = new vscode.Selection(2, 0, 2, 12);
      await eventually(
        "the new selection handed over",
        async () => await vscode.env.clipboard.readText() === "const c = 3;" || undefined,
      );
    } finally {
      const tab = page();
      if (tab) await vscode.window.tabGroups.close(tab);
    }
  });

  // The preview is a page served from localhost out of dist/swagger, framed in
  // a webview; a JSON spec is validated by the schema `jsonValidation` names,
  // which refers to the two beside it. A layout the build or the manifest gets
  // wrong shows a blank frame or validates nothing, and fails nowhere else.
  test("Swagger Preview serves the spec beside it, and a JSON spec is validated", async () => {
    const uri = writeFile(
      "api.json",
      JSON.stringify({ swagger: "2.0", info: { title: "Pets", version: "1" }, paths: {}, bogus: 1 }, null, 2),
    );
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    const page = () =>
      vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith("poly.swaggerPreview")
      );
    try {
      await vscode.commands.executeCommand("poly.swaggerPreview");
      const tab = await eventually("the Swagger preview", page);
      assert.strictEqual(tab.label, `Swagger Preview - ${document.fileName}`);
      assert.strictEqual(tab.group.viewColumn, vscode.ViewColumn.Two);

      // The extension's own instance of the server: require shares it.
      const root = vscode.extensions.getExtension(EXTENSION_ID)!.extensionPath;
      const server: typeof import("../../editor/swaggerPreview") = require(
        join(root, "dist", "swaggerPreview.js"),
      );
      const address = server.url(document.fileName);
      const html = await (await fetch(address)).text();
      assert.match(html, /EventSource\('events\/' \+ fileHash\)/);
      const bundle = await fetch(new URL("node_modules/swagger-ui-dist/swagger-ui-bundle.js", address));
      assert.strictEqual(bundle.status, 200);
      const events = await fetch(address.replace(/\/([^/]+)$/, "/events/$1"));
      const reader = events.body!.getReader();
      const { value } = await reader.read();
      await reader.cancel();
      const spec = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ""));
      assert.strictEqual(spec.info.title, "Pets");

      await eventually(
        "the schema's complaint about the stray property",
        () => vscode.languages.getDiagnostics(uri).find((one) => one.message.includes("bogus")),
      );
    } finally {
      const tab = page();
      if (tab) await vscode.window.tabGroups.close(tab);
      await vscode.commands.executeCommand("poly.swaggerStop");
    }
  });

  // Marp is three bundles loaded on demand, and each link only shows in a
  // running editor: the preview has to hand a `marp: true` document to Marp's
  // markdown-it and every other one to the usual chain; the directive checks
  // have to be registered once the Markdown arrives; and the export has to
  // find marp-cli, and the template script marp-cli reads from beside itself.
  // HTML is the export that needs no browser, so it is the one checked here.
  test("Marp renders a marp: true deck as slides, checks its directives and exports it", async () => {
    const deck = writeFile("deck.md", "---\nmarp: true\ntheme: nonexistent\n---\n\n# One\n\n---\n\n# Two\n");
    const document = await vscode.workspace.openTextDocument(deck);
    await vscode.window.showTextDocument(document);

    const slides: string = await vscode.commands.executeCommand("markdown.api.render", document);
    assert.match(slides, /<style id="__marp-vscode-style">/);
    assert.strictEqual(slides.match(/data-marp-vscode-slide-wrapper/g)?.length, 2);
    const plain: string = await vscode.commands.executeCommand(
      "markdown.api.render",
      await vscode.workspace.openTextDocument(writeFile("plain.md", "# One\n\n---\n\n# Two\n")),
    );
    assert.doesNotMatch(plain, /__marp-vscode/);

    const unknown = await eventually(
      "the unknown theme to be reported",
      () => vscode.languages.getDiagnostics(deck).find((one) => one.code === "unknown-theme"),
    );
    assert.strictEqual(unknown.source, "marp-vscode");
    assert.strictEqual(unknown.range.start.line, 2);

    const exported = join(workspaceRoot(), "deck.html");
    const result = await vscode.lm.invokeTool("poly_export_marp", {
      input: { inputFilePath: deck.fsPath, outputFilePath: exported },
      toolInvocationToken: undefined,
    });
    const said = result.content.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : "")).join(
      "",
    );
    assert.match(said, /successfully exported/);
    const html = readFileSync(exported, "utf8");
    assert.match(html, /<h1[^>]*>One<\/h1>/);
    assert.match(html, /bespoke/);
  });

  // The data and what each action does to a repository are held to
  // mhutchie.git-graph's own by tools/git-graph-diff, the graph's lanes by
  // gitGraphLayout's unit tests. What only a host shows is the wiring: every
  // command the manifest declares reaching a handler in the half loaded on
  // first use, the panel opening on the repository it was asked for, a menu
  // command acting on the context the page puts on what was right-clicked, and
  // a diff side read out of a revision by the poly-git: scheme, which has to be
  // registered before any of that has loaded.
  test("Git History opens on a repository, and its commands act on what was right-clicked", async () => {
    const repo = join(workspaceRoot(), "graph-repo");
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", [
        "-c",
        "user.name=Ada",
        "-c",
        "user.email=ada@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "first\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "First");
    const hash = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "a.txt"), "changed\n");

    const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
    const host: typeof import("../../editor/gitGraphPanel") = require(
      join(extension.extensionPath, "dist", "gitGraph.js"),
    );
    const declared = (extension.packageJSON.contributes.commands as { command: string }[])
      .map((entry) => entry.command)
      .filter((id) => id.startsWith("poly.gitGraph."))
      .map((id) => id.slice("poly.gitGraph.".length));
    assert.deepStrictEqual([...host.handled].sort(), declared.sort(), "declared commands and handlers differ");
    // Without git the page drops polyGit, and only the reads may stay in its menus.
    const menus = (extension.packageJSON.contributes.menus["webview/context"] as { command: string; when: string }[])
      .filter((entry) => entry.command.startsWith("poly.gitGraph."));
    for (const { command, when } of menus) {
      const read = host.READS.has(command.slice("poly.gitGraph.".length));
      assert.strictEqual(/&& polyGit\b/.test(when), !read, `${command}: polyGit in its menu ≠ needing git`);
    }

    const gitExtension = vscode.extensions.getExtension<
      { getAPI(version: 1): { openRepository(root: vscode.Uri): Promise<unknown> } }
    >(
      "vscode.git",
    )!;
    await (await gitExtension.activate()).getAPI(1).openRepository(vscode.Uri.file(repo));
    const page = () =>
      vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith("poly.gitGraph")
      );
    try {
      // From the Source Control title the argument is the repository itself.
      await vscode.commands.executeCommand("poly.gitGraph.view", { rootUri: vscode.Uri.file(repo) });
      assert.strictEqual((await eventually("the Git History panel", page)).label, "Git History");

      await vscode.env.clipboard.writeText("before");
      await vscode.commands.executeCommand("poly.gitGraph.copyHash", { repo, hash });
      assert.strictEqual(await vscode.env.clipboard.readText(), hash);

      const side = vscode.Uri.file(join(repo, "a.txt")).with({
        scheme: "poly-git",
        query: JSON.stringify({ repo, ref: hash, path: "a.txt" }),
      });
      assert.strictEqual(
        (await vscode.workspace.openTextDocument(side)).getText(),
        "first\n",
        "not the file as committed",
      );
    } finally {
      const tab = page();
      if (tab) await vscode.window.tabGroups.close(tab);
    }
  });

  // Run only in the launch that disables vscode.git (runTest.ts), which is how
  // a machine without git looks to Git History. What poly reads is held to git
  // by tools/git-embed-check.js; what only a host shows is the switch: the
  // repository found without vscode.git, a revision read through poly, and a
  // command that would change the repository refused rather than run.
  test("Git History without git reads through poly and changes nothing", async () => {
    assert.strictEqual(vscode.extensions.getExtension("vscode.git"), undefined, "vscode.git is enabled here");
    const repo = join(workspaceRoot(), "graph-repo");
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", [
        "-c",
        "user.name=Ada",
        "-c",
        "user.email=ada@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "first\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "First");
    git("branch", "other");
    const hash = git("rev-parse", "HEAD");

    const page = () =>
      vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith("poly.gitGraph")
      );
    try {
      await vscode.commands.executeCommand("poly.gitGraph.view");
      assert.strictEqual((await eventually("the Git History panel", page)).label, "Git History");

      await vscode.commands.executeCommand("poly.gitGraph.checkoutBranch", { repo, branch: "other" });
      assert.strictEqual(git("symbolic-ref", "--short", "HEAD"), "main", "a checkout ran without git");

      await vscode.env.clipboard.writeText("before");
      await vscode.commands.executeCommand("poly.gitGraph.copyHash", { repo, hash });
      assert.strictEqual(await vscode.env.clipboard.readText(), hash);

      const side = vscode.Uri.file(join(repo, "a.txt")).with({
        scheme: "poly-git",
        query: JSON.stringify({ repo, ref: hash, path: "a.txt" }),
      });
      assert.strictEqual((await vscode.workspace.openTextDocument(side)).getText(), "first\n", "poly did not read it");
    } finally {
      const tab = page();
      if (tab) await vscode.window.tabGroups.close(tab);
    }
  });

  // Which command runs a file, and how it is spelled, is held to upstream's by
  // codeRunner.test.ts. What only a host shows is the switch reaching the
  // command -- a key bound in keybindings.json gets past every `when` -- and a
  // process actually started, with what it says landing in Code Runner's panel.
  test("Code Runner does nothing until switched on, then runs the file into its output panel", async () => {
    const config = vscode.workspace.getConfiguration("poly");
    assert.strictEqual(config.get("codeRunner.enabled"), false, "Code Runner ships switched on");
    const marker = join(workspaceRoot(), "code-runner.ran");
    const script = runnable("code-runner.sh", marker, "poly-code-runner-says-hello");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(script));

    await vscode.commands.executeCommand("poly.codeRunner.run");
    await notRun(marker, "Run Code ran with Code Runner switched off");

    await setPoly("codeRunner.enabled", true, vscode.ConfigurationTarget.Workspace);
    try {
      await vscode.commands.executeCommand("poly.codeRunner.run");
      await eventually("the script to run", () => existsSync(marker) || undefined);
      const output = await eventually("the run in the output panel", () => outputSaying("poly-code-runner-says-hello"));
      // The line upstream prints first: the command it ran, shebang and all.
      assert.match(output, /\[Running\] \/bin\/sh ".*code-runner\.sh"/);
      // Finished, so the lens test below is not told "Code is already running!".
      await eventually("the run to end", () => outputSaying("[Done] exited with code=0"));
    } finally {
      await setPoly("codeRunner.enabled", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  // The lens has one switch of its own, and Code Runner's is not it: a lens
  // that vanished, or a click that did nothing, because a different feature
  // was off would read as broken.
  test("the run lens runs its file through Code Runner, with Code Runner switched off", async () => {
    const config = vscode.workspace.getConfiguration("poly");
    assert.strictEqual(config.get("codeRunner.enabled"), false);
    await setPoly("runCodeLens.enabled", true, vscode.ConfigurationTarget.Workspace);
    try {
      const marker = join(workspaceRoot(), "run-lens.ran");
      const script = runnable("run-lens.sh", marker, "poly-run-lens-says-hello");
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(script));
      await clickRunLens(script);
      await eventually("the script to run", () => existsSync(marker) || undefined);
      await eventually("the run in the output panel", () => outputSaying("poly-run-lens-says-hello"));
    } finally {
      await setPoly("runCodeLens.enabled", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  // poly claims the formatter slot and stops there. It used to also declare
  // `editor.formatOnSave: true` for all 39 activated languages, which outranks
  // the user's own global setting -- so a user who had deliberately turned
  // format-on-save off got it back on for most of the files they open, by
  // installing a formatter. Deciding *who* formats is poly's business;
  // deciding *when* is the user's, and poly.format.enabled is the switch for
  // suspending it without touching either.
  //
  // Asserted against the manifest as well as against the editor: the editor
  // half reads a user setting when there is one, so on a profile that already
  // turned format-on-save on it would pass no matter what poly declares.
  test("poly claims the formatter slot without switching format-on-save on", () => {
    const uri = writeFile("defaults.py", "x = 1\n");
    const editor = vscode.workspace.getConfiguration("editor", {
      uri,
      languageId: "python",
    });
    assert.strictEqual(editor.get<string>("defaultFormatter"), EXTENSION_ID);

    const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON;
    const forced = Object.entries(
      pkg.contributes.configurationDefaults as Record<string, Record<string, unknown>>,
    ).filter(([, declared]) => "editor.formatOnSave" in declared);
    assert.deepStrictEqual(forced.map(([language]) => language), []);
  });

  // The toolchain languages were held back on the theory that rust-analyzer,
  // gopls and clangd own them. poly formats rust, c, cpp, swift and terraform
  // by calling the same binary those servers call, so the output is identical,
  // and holding them back meant a .rs file in an editor with no rust-analyzer
  // never formatted at all -- which is how this was reported.
  test("poly is the formatter for the toolchain languages too", () => {
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
  // leaves Format Document pointing at whatever else is installed.
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
      "activated but poly never claims the formatter slot",
    );
    assert.deepStrictEqual(
      declared.filter((language) => !activated.includes(language)),
      [],
      "claims the formatter slot but never activates poly",
    );
  });

  // Last, so that the tests above have had the daemon write to stderr. The log
  // someone attaches to a report is the file in the extension's logs folder;
  // a plain channel put it in a numbered file elsewhere, and a log channel fed
  // the pipe's chunks as they come stamps some lines and runs others on.
  test("the daemon's log is Poly.log in the extension's logs folder, a line to an entry", async () => {
    const logs = process.env.POLY_E2E_LOGS;
    assert.ok(logs, "the test host was given no logs folder");
    const name = readdirSync(logs, { recursive: true, encoding: "utf8" })
      .find((one) => one.endsWith(join(EXTENSION_ID, "Poly.log")));
    assert.ok(name, `no ${EXTENSION_ID}/Poly.log under ${logs}`);
    // The daemon times every request it answers.
    const stderr = /^\S+ \S+ \[info\] \[poly\] textDocument\/formatting [\d.]+ms$/m;
    const text = await eventually("a line of the daemon's stderr", () => {
      const read = readFileSync(join(logs, name), "utf8");
      return stderr.test(read) ? read : undefined;
    });
    assert.match(text, /^\S+ \S+ \[info\] \[poly\] binary .* reports /m, "poly's own lines are not in it");
    assert.doesNotMatch(text, /^\[poly\]/m, "a line of stderr ran on from the one before, without its own stamp");
  });
});

// Run in a launch of its own, beside a stand-in with formulahendry.code-runner's
// id (src/test/fixture-code-runner) and with Code Runner and the run lens
// switched on in that workspace; index.ts picks this suite out by its title.
// Every other test has to run without the stand-in, since poly would stand
// aside in all of them.
suite("Code Runner beside formulahendry.code-runner", () => {
  suiteSetup(async function() {
    this.timeout(120_000);
    assert.ok(vscode.extensions.getExtension("formulahendry.code-runner"), "the stand-in is not installed");
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  // Both installed and both answering ctrl+alt+n would run the file twice. The
  // lens is poly's alone, so it stays.
  test("poly's Run Code stands aside, switched on or not, and the run lens still runs", async () => {
    const config = vscode.workspace.getConfiguration("poly");
    assert.strictEqual(config.get("codeRunner.enabled"), true, "the workspace did not switch Code Runner on");
    const marker = join(workspaceRoot(), "yield.ran");
    const script = runnable("yield.sh", marker, "poly-yield-says-hello");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(script));

    await vscode.commands.executeCommand("poly.codeRunner.run");
    await notRun(marker, "Run Code ran beside formulahendry.code-runner");

    await clickRunLens(script);
    await eventually("the script to run", () => existsSync(marker) || undefined);
    await eventually("the run in the output panel", () => outputSaying("poly-yield-says-hello"));
  });
});

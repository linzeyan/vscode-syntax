// Runs inside each extension host of tools/paste-image-diff/run.js. It pastes
// the way each scenario says and writes what came of it -- the text typed,
// the files left behind, what the user was told -- as JSON for run.js to
// compare.
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, relative } = require("node:path");
const vscode = require("vscode");

const { connect } = require("../ext-diff/cdp");

const SIDE = process.env.POLY_PASTE_SIDE;
const PORT = Number(process.env.POLY_PASTE_PORT);
const PNG = process.env.POLY_PASTE_PNG;
// CDP's modifier bits: 1 alt, 4 meta, 8 shift.
const { command: COMMAND, prefix: PREFIX, chord: CHORD } = {
  upstream: { command: "extension.pasteImage", prefix: "pasteImage", chord: ["V", 86, 1 | 4] },
  poly: { command: "poly.pasteImage", prefix: "poly.pasteImage", chord: ["I", 73, 1 | 4 | 8] },
}[SIDE];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, check, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

const folder = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
/** The workspace folder and the time of the paste written as words, so that both sides' records compare. */
const where = (text) =>
  text?.replaceAll(folder(), "(workspace)").replace(/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/g, "(time)");

const osascript = (script) => execFileSync("osascript", ["-e", script]);
// poly: ignore typos/typo
const PNG_TYPE = "PNGf";
const imageOnClipboard = () => osascript(`set the clipboard to (read (POSIX file "${PNG}") as «class ${PNG_TYPE}»)`);
const textOnClipboard = () => osascript("set the clipboard to \"not an image\"");

/** Every file and folder in the workspace but `.vscode`, each file with a digest. */
function tree(dir = folder(), into = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".vscode") continue;
    const full = join(dir, entry.name);
    const name = relative(folder(), full);
    if (entry.isDirectory()) {
      into[`${name}/`] = "folder";
      tree(full, into);
    } else {
      into[name] = createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 12);
    }
  }
  return into;
}

const TOASTS = `[...document.querySelectorAll(".notifications-toasts .notification-list-item-message")]
  .map((one) => one.textContent)`;
const REPLACE = `(() => {
  const button = [...document.querySelectorAll(".notifications-toasts .monaco-button")]
    .find((one) => one.textContent === "Replace");
  button?.click();
  return !!button;
})()`;
const BOX = `(() => {
  const widget = document.querySelector(".quick-input-widget");
  if (!widget || widget.style.display === "none") return null;
  return {
    value: widget.querySelector("input")?.value ?? null,
    message: widget.querySelector(".quick-input-message")?.textContent ?? null,
  };
})()`;

async function key(desk, name, code, modifiers = 0) {
  for (const type of ["keyDown", "keyUp"]) {
    await desk.send("Input.dispatchKeyEvent", {
      type,
      modifiers,
      key: name,
      code: name.length === 1 ? `Key${name}` : name,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    });
  }
}

module.exports.run = async function() {
  const report = { side: SIDE, seen: {}, errors: [] };
  const desk = await connect(PORT);
  const target = vscode.ConfigurationTarget.Workspace;

  /**
   * One paste. `open` is the file pasted into, `select` the text selected
   * first; `answer` is typed into the file name box, or `null` to take what
   * it offers; `existing` is an image already where this one goes.
   */
  async function scenario(name, options) {
    const { open = "docs/guide.md", select, settings = {}, image = true, chord = false, answer, existing } = options;
    const pastes = options.pastes ?? true;
    const config = vscode.workspace.getConfiguration();
    let editor;
    let before = tree();
    try {
      for (const [key, value] of Object.entries(settings)) await config.update(`${PREFIX}.${key}`, value, target);
      if (image) imageOnClipboard();
      else textOnClipboard();
      if (existing) {
        copyFileSync(PNG, join(folder(), existing));
        before = tree();
      }
      const document = open === "untitled"
        ? await vscode.workspace.openTextDocument({ language: "markdown", content: "# Untitled\n\n" })
        : await vscode.workspace.openTextDocument(vscode.Uri.file(join(folder(), open)));
      editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      const text = document.getText();
      if (select) {
        const start = text.indexOf(select);
        editor.selection = new vscode.Selection(
          document.positionAt(start),
          document.positionAt(start + select.length),
        );
      } else {
        const end = document.positionAt(text.length);
        editor.selection = new vscode.Selection(end, end);
      }
      await vscode.commands.executeCommand("notifications.clearAll");
      await sleep(300);

      let done = Promise.resolve();
      if (chord) await key(desk, ...CHORD);
      else done = Promise.resolve(vscode.commands.executeCommand(COMMAND)).catch((error) => error);
      const found = { language: document.languageId };
      if (answer !== undefined) {
        const box = await until("the file name box", () => desk.evaluate(BOX));
        found.box = { value: where(box.value), message: box.message };
        if (answer !== null) {
          await key(desk, "A", 65, 4);
          await desk.insertText(answer);
          await sleep(200);
        }
        await key(desk, "Enter", 13);
      }
      if (existing) {
        // Read before the click, which takes the question away with it.
        found.asked = (await until("the question", async () => {
          const toasts = await desk.evaluate(TOASTS);
          return toasts.length > 0 && toasts;
        })).map(where);
        await until("the Replace button", () => desk.evaluate(REPLACE));
      }
      if (pastes) await until("the pasted text", () => document.getText() !== text);
      else await until("a notification", async () => (await desk.evaluate(TOASTS)).length > 0);
      await Promise.race([done, sleep(3000)]);
      await sleep(500);

      const after = tree();
      found.text = where(document.getText());
      found.files = Object.fromEntries(
        Object.entries(after).filter(([path, digest]) => before[path] !== digest).map(([path, digest]) => [
          where(path),
          // What the script wrote is whatever the clipboard held as PNG,
          // which both sides read the same way: whether it was written is
          // the record, not its bytes, which macOS re-encodes.
          digest === "folder" ? "folder" : "file",
        ]),
      );
      found.toasts = (await desk.evaluate(TOASTS)).map(where);
      report.seen[name] = found;
    } catch (error) {
      report.errors.push(`${SIDE} ${name}: ${error.message}`);
    } finally {
      if (editor) {
        await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
        await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      }
      const now = tree();
      for (const path of Object.keys(now).filter((one) => !(one in before)).reverse()) {
        rmSync(join(folder(), path), { recursive: true, force: true });
      }
      if (existing) rmSync(join(folder(), existing), { force: true });
      for (const key of Object.keys(settings)) await config.update(`${PREFIX}.${key}`, undefined, target);
      await vscode.commands.executeCommand("notifications.clearAll");
    }
  }

  try {
    await scenario("default", {});
    await scenario("selection", { select: "login screen" });
    await scenario("variables", {
      select: "café shot",
      settings: {
        path: "${projectRoot}/assets/${currentFileNameWithoutExt}",
        basePath: "${projectRoot}",
        prefix: "/",
        suffix: "?raw",
        namePrefix: "${currentFileNameWithoutExt}-",
        nameSuffix: "-x",
        encodePath: "urlEncode",
        insertPattern:
          "<img src=\"${imageFilePath}\" alt=\"${imageFileNameWithoutExt}\" title=\"${imageOriginalFilePath} ${imageFileName}\">",
      },
    });
    await scenario("absolute", {
      select: "login screen",
      settings: { basePath: "", encodePath: "none", forceUnixStyleSeparator: false },
    });
    await scenario("defaultName", { settings: { defaultName: "[shot]-YYYY-${currentFileNameWithoutExt}" } });
    await scenario("plaintext", { open: "notes.txt" });
    await scenario("prompt", { open: "agent.prompt.md" });
    await scenario("chord", { select: "login screen", chord: true });
    await scenario("inputName", {
      settings: { showFilePathConfirmInputBox: true, filePathConfirmInputBoxMode: "onlyName" },
      answer: "typed",
    });
    await scenario("inputFull", { settings: { showFilePathConfirmInputBox: true }, answer: null });
    await scenario("exists", { select: "login screen", existing: "docs/login screen.png" });
    await scenario("noImage", { image: false, settings: { path: "new-folder" }, pastes: false });
    await scenario("untitled", { open: "untitled", pastes: false });
    await scenario("invalidSelection", { select: "a:b", pastes: false });
    await scenario("badPath", { settings: { path: "images " }, pastes: false });
  } finally {
    desk.close();
  }
  writeFileSync(process.env.POLY_PASTE_OUT, `${JSON.stringify(report, null, 2)}\n`);
};

// Runs inside each extension host of tools/codesnap-diff/run.js. It drives the
// CodeSnap page over the DevTools protocol -- its shutter, the copy event, and
// VSCode's save dialog drawn in the workbench -- and writes what it saw as JSON
// for run.js to compare. Pictures are written to the workspace's `out/`.
const { execFileSync } = require("node:child_process");
const { existsSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const vscode = require("vscode");

const { connect } = require("../ext-diff/cdp");
const { update } = require("../ext-diff/settings");

const SIDE = process.env.POLY_CODESNAP_SIDE;
const PORT = Number(process.env.POLY_CODESNAP_PORT);
const { prefix: PREFIX, command: COMMAND, page: PAGE } = {
  codesnap: { prefix: "codesnap", command: "codesnap.start", page: "extensionId=adpyke.codesnap" },
  poly: { prefix: "poly.codeSnap", command: "poly.codeSnap", page: "extensionId=ricky.poly-lsp" },
}[SIDE];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, check, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

const folder = () => vscode.workspace.workspaceFolders[0].uri.fsPath;

/** A DevTools session with the CodeSnap page opened after `known` ids, evaluating in its frame as `w`. */
async function page(known) {
  const target = await until("the CodeSnap page", async () => {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return targets.find((one) => one.url.includes(PAGE) && !known.has(one.id));
  });
  known.add(target.id);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("DevTools socket failed to open")), { once: true });
  });
  let next = 1;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await send("Runtime.enable");
  return {
    exceptions,
    async evaluate(expression) {
      const { result, exceptionDetails } = await send("Runtime.evaluate", {
        expression: `(async () => { const w = document.getElementById("active-frame")?.contentWindow;
          if (!w) throw new Error("no such frame"); return (${expression}); })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails) {
        throw new Error(`evaluate: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
      }
      return result.value;
    },
    close: () => socket.close(),
  };
}

/** What the page shows before the shutter, besides the picture. */
const SHOWN = `(() => {
  const d = w.document;
  const shown = (id) => !d.getElementById(id).hidden;
  return {
    variables: d.body.getAttribute("style"),
    navbar: shown("navbar"),
    controls: shown("window-controls"),
    title: shown("window-title") ? d.getElementById("window-title").textContent : null,
    lines: d.querySelectorAll("#snippet .line").length,
    snippet: d.getElementById("snippet").outerHTML,
  };
})()`;

/** The save dialog's path while it is open, drawn in the workbench. */
const DIALOG = `(() => {
  const widget = document.querySelector(".quick-input-widget");
  if (!widget || widget.style.display === "none") return null;
  return { value: widget.querySelector(".quick-input-box input").value };
})()`;

const CLICK = "w.document.getElementById(\"save\").dispatchEvent(new w.MouseEvent(\"click\", { bubbles: true }))";

/** The workspace folder written as `(workspace)`, so that both sides' records compare. */
const where = (text) => text?.replaceAll(folder(), "(workspace)");

async function key(desk, name, code) {
  for (const type of ["keyDown", "keyUp"]) {
    await desk.send("Input.dispatchKeyEvent", {
      type,
      key: name,
      code: name,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    });
  }
}

/**
 * The shutter pressed with `save`: where the dialog starts, and, given `to`,
 * the picture saved there. Without `to` the dialog is cancelled.
 */
async function shoot(desk, snap, to) {
  await snap.evaluate(CLICK);
  // Read once it holds still: the dialog can show one path while it fills in
  // the one it was given.
  let last;
  const asked = await until("the save dialog to settle", async () => {
    const now = (await desk.evaluate(DIALOG))?.value;
    const settled = now !== undefined && now === last ? now : undefined;
    last = now;
    await sleep(500);
    return settled;
  });
  if (!to) {
    await key(desk, "Escape", 27);
    await until("the dialog to close", async () => !(await desk.evaluate(DIALOG)));
    return where(asked);
  }
  const path = join(folder(), "out", to);
  // The dialog opens with the name selected; everything is replaced instead,
  // so that nothing is ever saved where the dialog happened to start.
  await desk.evaluate("document.querySelector(\".quick-input-widget .quick-input-box input\").select()");
  await desk.insertText(path);
  await sleep(500);
  const typed = (await desk.evaluate(DIALOG))?.value;
  if (typed !== path) {
    await key(desk, "Escape", 27);
    throw new Error(`the save dialog holds ${typed}, not ${path}`);
  }
  await key(desk, "Enter", 13);
  let size = -1;
  await until(`${to} written`, () => {
    const now = existsSync(path) ? statSync(path).size : -1;
    const done = now > 0 && now === size;
    size = now;
    return done;
  });
  // A second dialog after the save would be cancelled by the next shutter, and
  // upstream forgets the folder on a cancel: better reported here than there.
  await sleep(1500);
  if (await desk.evaluate(DIALOG)) {
    await key(desk, "Escape", 27);
    throw new Error(`a second save dialog opened after ${to}`);
  }
  return where(asked);
}

/** AppleScript's type code for PNG data. */
// poly: ignore typos/typo
const PNG_TYPE = "PNGf";

/** The PNG on the macOS clipboard, if there is one. */
function clipboardPng() {
  try {
    const out = execFileSync("osascript", ["-e", `the clipboard as «class ${PNG_TYPE}»`], { encoding: "utf8" });
    const hex = new RegExp(`«data ${PNG_TYPE}([0-9A-F]+)»`).exec(out)?.[1];
    return hex ? Buffer.from(hex, "hex") : undefined;
  } catch {
    return undefined;
  }
}

/** A picture copied by `copy`, written to `out/` as `to` for run.js to compare; whether there was one. */
async function copied(snap, copy, to) {
  // Writing to the clipboard needs the page focused, as it is once clicked.
  // Emulating focus on its target does not reach the frame the page runs in,
  // and the group takes a moment to hand it on: waited for, not slept on.
  await vscode.commands.executeCommand("workbench.action.focusSecondEditorGroup");
  await until("the page to have the focus", () => snap.evaluate("w.document.hasFocus()"), 5000);
  execFileSync("osascript", ["-e", "set the clipboard to \"\""]);
  await copy();
  const png = await until(`${to} on the clipboard`, clipboardPng, 10_000).catch(() => undefined);
  if (png) writeFileSync(join(folder(), "out", to), png);
  return !!png;
}

/**
 * The page opened over `file` with `select` selected: what it shows, then what
 * `act` does with it. `settings` are CodeSnap's, by upstream's name, and
 * `language` a block of settings for the file's language; both are cleared
 * after.
 */
async function scenario(known, { file, select, lines, settings = {}, language, tabSize, act }) {
  const config = vscode.workspace.getConfiguration();
  const target = vscode.ConfigurationTarget.Workspace;
  const document = await vscode.workspace.openTextDocument(join(folder(), file));
  const own = (key) => key.startsWith("editor.") ? key : `${PREFIX}.${key}`;
  let snap;
  try {
    for (const [name, value] of Object.entries(settings)) await update(vscode, own(name), value, target);
    if (language) {
      await config.update(
        `[${document.languageId}]`,
        Object.fromEntries(Object.entries(language).map(([name, value]) => [own(name), value])),
        target,
      );
    }
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    if (tabSize) editor.options = { tabSize };
    editor.selections = select.map((range) => new vscode.Selection(...range));
    // Colored by the grammar before it is copied.
    await sleep(1500);
    await vscode.commands.executeCommand(COMMAND);
    snap = await page(known);
    await until("the page to load", () => snap.evaluate("!!w.document.getElementById(\"snippet\")").catch(() => false));
    await until(`${lines} lines on the page`, async () => (await snap.evaluate(SHOWN)).lines === lines);
    await sleep(500);
    const seen = { shown: await snap.evaluate(SHOWN) };
    Object.assign(seen, await act({ snap, editor }));
    // The first line only: the stack names where each side is installed.
    seen.exceptions = snap.exceptions.map((one) => (one.exception?.description ?? one.text).split("\n")[0]);
    return seen;
  } finally {
    snap?.close();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const name of Object.keys(settings)) await update(vscode, own(name), undefined, target);
    if (language) await config.update(`[${document.languageId}]`, undefined, target);
  }
}

const WHOLE = [[0, 0, 5, 1]];

module.exports.run = async function() {
  const report = { side: SIDE, seen: {}, errors: [] };
  const desk = await connect(PORT);
  const known = new Set();
  // Each grammar loaded before anything is copied: the first run's first copy
  // came before TypeScript's, uncolored on both sides.
  for (const file of ["snap.ts", "indented.py", "tabs.go"]) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(join(folder(), file)));
  }
  await sleep(5000);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  const scenarios = {
    // The whole function, with the defaults.
    default: {
      file: "snap.ts",
      select: WHOLE,
      lines: 6,
      act: async ({ snap }) => ({ asked: await shoot(desk, snap, "default.png") }),
    },
    // Every setting that shows, changed; numbered from where the selection starts.
    frame: {
      file: "snap.ts",
      select: [[2, 0, 4, 49]],
      lines: 3,
      settings: {
        backgroundColor: "#224466",
        boxShadow: "rgba(255, 0, 0, 0.8) 4px 4px 0px",
        containerPadding: "12px",
        roundedCorners: false,
        showWindowControls: false,
        showWindowTitle: true,
        realLineNumbers: true,
        transparentBackground: true,
      },
      act: async ({ snap }) => ({ asked: await shoot(desk, snap, "frame.png") }),
    },
    window: {
      file: "snap.ts",
      select: WHOLE,
      lines: 6,
      settings: { target: "window", showLineNumbers: false, showWindowTitle: true },
      act: async ({ snap }) => ({ asked: await shoot(desk, snap, "window.png") }),
    },
    // A language's own block, read before the settings themselves; the lines
    // all indented, which the page strips.
    language: {
      file: "indented.py",
      select: [[1, 0, 4, 19]],
      lines: 4,
      language: { backgroundColor: "#ff8800", showWindowControls: false, "editor.fontLigatures": "'ss01'" },
      act: async ({ snap }) => ({ asked: await shoot(desk, snap, "language.png") }),
    },
    tabs: {
      file: "tabs.go",
      select: [[2, 0, 6, 1]],
      lines: 5,
      tabSize: 8,
      act: async ({ snap }) => ({ asked: await shoot(desk, snap, "tabs.png") }),
    },
    copy: {
      file: "snap.ts",
      select: WHOLE,
      lines: 6,
      settings: { shutterAction: "copy" },
      act: async ({ snap }) => ({
        shutter: await copied(snap, () => snap.evaluate(CLICK), "copy-shutter.png"),
        copyEvent: await copied(
          snap,
          () => snap.evaluate("w.document.dispatchEvent(new w.ClipboardEvent(\"copy\"))"),
          "copy-event.png",
        ),
      }),
    },
    // Opened with nothing selected, then following the selection; two
    // selections at once are not followed.
    follow: {
      file: "snap.ts",
      select: [[0, 0, 0, 0]],
      lines: 0,
      act: async ({ snap, editor }) => {
        editor.selections = [new vscode.Selection(0, 0, 2, 35)];
        await until("the selection on the page", async () => (await snap.evaluate(SHOWN)).lines === 3);
        await sleep(500);
        editor.selections = [new vscode.Selection(4, 0, 4, 10), new vscode.Selection(5, 0, 5, 1)];
        await sleep(1500);
        return { followed: await snap.evaluate(SHOWN), asked: await shoot(desk, snap, "follow.png") };
      },
    },
    // Where the dialog starts after a save, and after a cancelled one.
    dialog: {
      file: "snap.ts",
      select: WHOLE,
      lines: 6,
      act: async ({ snap }) => {
        await shoot(desk, snap, "dialog.png");
        const afterSave = await shoot(desk, snap);
        const afterCancel = await shoot(desk, snap);
        return { afterSave, afterCancel };
      },
    },
  };
  try {
    for (const [name, spec] of Object.entries(scenarios)) {
      try {
        report.seen[name] = await scenario(known, spec);
      } catch (error) {
        report.errors.push(`${SIDE} ${name}: ${error.message}`);
      }
    }
  } finally {
    desk.close();
  }
  writeFileSync(process.env.POLY_CODESNAP_OUT, `${JSON.stringify(report, null, 2)}\n`);
};

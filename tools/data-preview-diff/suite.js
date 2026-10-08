// Runs inside each extension host of tools/data-preview-diff/run.js. It
// previews each file the way a scenario says, acts as the page's toolbar would,
// and writes what came of it -- the host's messages to the page, what the page
// drew, the status bar, what the user was told, the files written -- as JSON
// for run.js to compare.
const { createHash } = require("node:crypto");
const { readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join, relative } = require("node:path");
const vscode = require("vscode");

const { connect } = require("../ext-diff/cdp");

const SIDE = process.env.POLY_DATA_SIDE;
const PORT = Number(process.env.POLY_DATA_PORT);
const REMOTE = process.env.POLY_DATA_REMOTE;
const xlsx = require(join(process.env.POLY_DATA_LSP, "node_modules", "xlsx"));
const { update } = require("../ext-diff/settings");
const { command: COMMAND, remote: REMOTE_COMMAND, prefix: PREFIX, extension: EXTENSION } = {
  upstream: {
    command: "data.preview",
    remote: "data.preview.remote",
    prefix: "data.preview",
    extension: "randomfractalsinc.vscode-data-preview",
  },
  poly: {
    command: "poly.dataPreview",
    remote: "poly.dataPreviewRemote",
    prefix: "poly.dataPreview",
    extension: "ricky.poly-lsp",
  },
}[SIDE];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, check, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

const folder = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const file = (name) => vscode.Uri.file(join(folder(), name));
/** The workspace folder and the HTTP server's port written as words, so that both sides' records compare. */
const where = (text) =>
  text?.replaceAll(vscode.Uri.file(folder()).toString(true), "(workspace)")
    .replaceAll(folder(), "(workspace)")
    .replaceAll(REMOTE, "(remote)");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

const TEXT_FILES = /\.(json|jsonl|json5|hjson|ndjson|config|env|properties|ini|yaml|yml|md|csv|tsv|txt|tab|html|xml)$/;
const WORKBOOKS = /\.(ods|xls|xlsb|xlsm|xlsx)$/;

/**
 * A workbook as its container and its sheets' rows. Its bytes are not the
 * record: each side's SheetJS stamps and compresses them its own way.
 */
function workbook(bytes) {
  const book = xlsx.read(bytes);
  return JSON.stringify({
    container: bytes.subarray(0, 4).toString("hex"),
    sheets: Object.fromEntries(book.SheetNames.map((name) => [name, xlsx.utils.sheet_to_json(book.Sheets[name])])),
  });
}

/** Every file in the workspace but `.vscode`: text as text, a workbook as its rows, the rest as a digest. */
function tree(dir = folder(), into = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".vscode") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tree(full, into);
    else {
      const bytes = readFileSync(full);
      into[relative(folder(), full)] = TEXT_FILES.test(entry.name)
        ? where(bytes.toString("utf8"))
        : WORKBOOKS.test(entry.name)
        ? workbook(bytes)
        : sha(bytes);
    }
  }
  return into;
}

const TOASTS = `[...document.querySelectorAll(".notifications-toasts .notification-list-item")]
  .map((one) => ({
    severity: [...one.querySelectorAll(".codicon")].map((icon) => [...icon.classList].find((c) => /^codicon-(error|warning|info)$/.test(c))).find(Boolean) ?? null,
    message: one.querySelector(".notification-list-item-message")?.textContent ?? "",
  }))`;
const STATUS =
  `[...document.querySelectorAll(".statusbar-item")].map((one) => one.textContent).find((one) => one.includes("🈸")) ?? null`;
const BOX = `(() => {
  const widget = document.querySelector(".quick-input-widget");
  if (!widget || widget.style.display === "none") return null;
  const input = widget.querySelector("input");
  return { value: input?.value ?? null, placeholder: input?.placeholder ?? null, focused: document.activeElement === input };
})()`;
const TABS = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => where(tab.label)));

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

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ids = async () => new Set((await targets()).map((one) => one.id));

/** A DevTools session on the first Data Preview page not in `before`; expressions see the page as `w`. */
async function attachPage(before) {
  const target = await until(
    "the preview's page",
    async () =>
      (await targets()).find((one) =>
        !before.has(one.id) && one.url.toLowerCase().includes(`extensionid=${EXTENSION}`)
      ),
  );
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("DevTools socket failed to open")), { once: true });
  });
  let next = 1;
  const pending = new Map();
  const problems = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    // Runtime.enable replays what was thrown and logged before it, so a
    // session opened after the page loaded still hears about its loading.
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      problems.push(`thrown: ${(details.exception?.description ?? details.text).split("\n")[0]}`);
    } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      problems.push(
        `console: ${message.params.args.map((one) => one.value ?? one.description).join(" ").split("\n")[0]}`,
      );
    }
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
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression: `(async () => { const w = document.getElementById("active-frame")?.contentWindow;
        if (!w || !w.document.querySelector("perspective-viewer")) return undefined; return (${expression}); })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(`evaluate: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    }
    return result.value;
  };
  return {
    problems,
    evaluate,
    /** Posts `message` to the host as the page's own script would. */
    async post(message) {
      await until("the page's script", () => evaluate(`w.eval("typeof vscode") === "object"`));
      await evaluate(`w.eval(${JSON.stringify(`vscode.postMessage(${JSON.stringify(message)})`)})`);
    },
    close: () => socket.close(),
  };
}

module.exports.run = async function() {
  const report = { side: SIDE, seen: {}, errors: [], problems: {} };
  const desk = await connect(PORT);
  const target = vscode.ConfigurationTarget.Workspace;

  // Every message either extension's preview posts to its page goes through
  // the one webview class the extension host hands out, so a wrapper on it
  // hears both sides the same way.
  const probe = vscode.window.createWebviewPanel("probe", "probe", vscode.ViewColumn.One, {});
  const webview = Object.getPrototypeOf(probe.webview);
  probe.dispose();
  const posted = [];
  const postMessage = webview.postMessage;
  webview.postMessage = function(message) {
    posted.push(message);
    return postMessage.call(this, message);
  };
  const isData = (message) => Array.isArray(message) || message?.command === "refresh";
  /** The messages since `from`, keyed by their order, bytes as their size and digest. */
  const messages = (from = 0) =>
    Object.fromEntries(
      posted.slice(from).map((message, index) => [
        index,
        Array.isArray(message)
          ? { bytes: message.length, sha: sha(Buffer.from(message)) }
          : JSON.parse(where(JSON.stringify(message))),
      ]),
    );
  const toasts = async () => (await desk.evaluate(TOASTS)).map((one) => ({ ...one, message: where(one.message) }));
  const status = async () =>
    where(await desk.evaluate(STATUS))?.replace(/\s+/g, " ").replace(/LoadTime: \d+/, "LoadTime: (n)") ?? null;

  /**
   * Answers a save or open dialog, which `files.simpleDialog.enable` makes a
   * quick input, with `path`. The dialog shows up before it has read its
   * folder and fills its path in after, so it is read once it has focus and the
   * same path twice running, and Enter waits for the path typed to be there.
   */
  async function answer(path) {
    let last;
    const box = await until("the dialog", async () => {
      const now = await desk.evaluate(BOX);
      const settled = now?.focused && now.value === last?.value;
      last = now;
      return settled && now;
    });
    await key(desk, "A", 65, 4);
    await desk.insertText(path);
    await until("the path typed", async () => (await desk.evaluate(BOX))?.value === path);
    await key(desk, "Enter", 13);
    return where(box.value);
  }

  /** What the page drew: its rows once it has any, or what it has after a while. */
  async function drawn(page) {
    let rows;
    try {
      rows = await until(
        "the page's rows",
        () => page.evaluate(`w.eval("viewer && viewer.view ? viewer.view.num_rows() : null")`),
        8000,
      );
    } catch {
      rows = null;
    }
    const columns = rows === null ? null : await page.evaluate(`w.eval("viewer.columns")`);
    return { rows, columns: columns ?? null };
  }

  /**
   * One preview. `open` is a workspace file or a URL; `box` opens it through
   * the remote command's URL box instead. `act` then does what the page's
   * toolbar would, adding to the record.
   */
  async function scenario(name, { open, box = false, settings = {}, act }) {
    const found = {};
    const before = tree();
    const pages = await ids();
    let page;
    try {
      for (const [key, value] of Object.entries(settings)) await update(vscode, `${PREFIX}.${key}`, value, target);
      await vscode.commands.executeCommand("notifications.clearAll");
      posted.length = 0;
      const uri = open.startsWith("http") ? vscode.Uri.parse(open) : file(open);
      if (box) {
        void vscode.commands.executeCommand(REMOTE_COMMAND);
        found.box = await until("the URL box", () => desk.evaluate(BOX));
        await desk.insertText(open);
        await key(desk, "Enter", 13);
      } else {
        void vscode.commands.executeCommand(COMMAND, uri);
      }
      await until("the data or a notification", async () => posted.some(isData) || (await toasts()).length > 0);
      page = await attachPage(pages);
      found.page = await drawn(page);
      // Kept out of what is compared: VSCode's own webview host throws now and
      // then while a page loads, and not on the same runs on both sides.
      report.problems[name] = page.problems.map(where);
      await sleep(1000);
      found.messages = messages();
      found.status = await status();
      found.toasts = await toasts();
      found.tabs = TABS();
      if (act) await act({ page, found });
      const after = tree();
      found.files = Object.fromEntries(Object.entries(after).filter(([path, value]) => before[path] !== value));
    } catch (error) {
      report.errors.push(`${SIDE} ${name}: ${error.message}`);
    } finally {
      page?.close();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      for (const path of Object.keys(tree()).filter((one) => !(one in before))) {
        rmSync(join(folder(), path), { force: true });
      }
      for (const [path, text] of Object.entries(before)) {
        if (TEXT_FILES.test(path) && readFileSync(join(folder(), path), "utf8") !== text) {
          writeFileSync(join(folder(), path), text.replaceAll("(workspace)", folder()));
        }
      }
      for (const key of Object.keys(settings)) await update(vscode, `${PREFIX}.${key}`, undefined, target);
      await vscode.commands.executeCommand("notifications.clearAll");
      await sleep(300);
      report.seen[name] = found;
    }
  }

  /** The page asks to save `data` as `fileType`; the dialog is answered with `out`. */
  const save = (data, fileType, out) => async ({ page, found }) => {
    const from = posted.length;
    await vscode.commands.executeCommand("notifications.clearAll");
    await page.post({ command: "saveData", data, fileType });
    found.saveDialog = await answer(join(folder(), out));
    await until("the file or a notification", async () => tree()[out] !== undefined || (await toasts()).length > 0)
      .catch(() => {});
    await sleep(1500);
    found.saved = { toasts: await toasts(), tabs: TABS(), messages: messages(from) };
  };

  const ROWS = [{ id: 1, name: "tea" }, { id: 2, name: "coffee" }];

  try {
    for (
      const one of [
        "rows.json",
        "server.json",
        "broken.json",
        "rows.jsonl",
        "broken.jsonl",
        "rows.json5",
        "rows.hjson",
        "rows.yaml",
        "rows.csv",
        "rows.tsv",
        "tables.md",
        "app.properties",
        "app.ini",
        "app.env",
        "view.config",
        "book.xlsx",
        "table.arrow",
        "events.avro",
        "metrics.parquet",
        "vite.config.ts",
      ]
    ) {
      await scenario(one, { open: one });
    }
    await scenario("jsonFiles", { open: "book.xlsx", settings: { "create.json.files": true } });
    await scenario("jsonFilesArrow", {
      open: "table.arrow",
      settings: { "create.json.files": true, "create.json.schema": false },
    });
    await scenario("theme", { open: "rows.csv", settings: { theme: "light" } });
    await scenario("denseTheme", { open: "rows.csv", settings: { theme: "dense.light" } });
    await scenario("remote", { open: `${REMOTE}/rows.csv`, box: true });
    await scenario("remoteArrow", { open: `${REMOTE}/table.arrow` });
    await scenario("remoteMissing", { open: `${REMOTE}/missing.csv` });

    await scenario("sheet", {
      open: "book.xlsx",
      act: async ({ page, found }) => {
        const from = posted.length;
        await page.post({ command: "refresh", table: "Second" });
        await until("the second sheet", () => posted.slice(from).some(isData));
        await sleep(1000);
        found.second = { messages: messages(from), status: await status() };
      },
    });
    await scenario("markdownTable", {
      open: "tables.md",
      act: async ({ page, found }) => {
        const from = posted.length;
        await page.post({ command: "refresh", table: "Stock" });
        await until("the second table", () => posted.slice(from).some(isData));
        found.second = { messages: messages(from) };
      },
    });

    await scenario("saveProperties", {
      open: "app.properties",
      act: save([{ key: "a", value: "1" }, { key: "b", value: "x\ny" }], ".properties", "out.properties"),
    });
    await scenario("saveNotProperties", { open: "rows.csv", act: save(ROWS, ".properties", "out.properties") });
    await scenario("saveCsv", { open: "rows.csv", act: save("id,name\n1,tea\n", ".csv", "out.csv") });
    await scenario("saveMarkdown", { open: "rows.csv", act: save("id,note\n1,\"a, b\"\n", ".md", "out.md") });
    await scenario("saveYaml", { open: "rows.csv", act: save(ROWS, ".yml", "out.yml") });
    await scenario("saveJson5", { open: "rows.csv", act: save(ROWS, ".json5", "out.json5") });
    await scenario("saveHjson", { open: "rows.csv", act: save(ROWS, ".hjson", "out.hjson") });
    await scenario("saveJson", { open: "rows.csv", act: save(ROWS, ".json", "out.json") });
    await scenario("saveXlsx", { open: "book.xlsx", act: save(ROWS, ".xlsx", "out.xlsx") });
    await scenario("saveXlsb", { open: "book.xlsx", act: save(ROWS, ".xlsb", "out.xlsb") });
    await scenario("saveArrow", {
      open: "table.arrow",
      act: async (context) => {
        const bytes = [...readFileSync(join(folder(), "table.arrow"))];
        await save(bytes, ".arrow", "out.arrow")(context);
      },
    });
    await scenario("saveNoEditor", {
      open: "rows.csv",
      settings: { openSavedFileEditor: false },
      act: save("id\n1\n", ".csv", "out.csv"),
    });
    await scenario("saveConfigAndLoad", {
      open: "rows.csv",
      act: async (context) => {
        const { page, found } = context;
        await save(
          { dataFileName: "rows.csv", dataTable: "", config: { view: "grid", columns: "[\"name\"]" } },
          ".config",
          "saved.config",
        )(context);
        const from = posted.length;
        await page.post({ command: "loadConfig" });
        found.loadDialog = await answer(join(folder(), "saved.config"));
        await until("the view config", () => posted.slice(from).some(isData)).catch(() => {});
        await sleep(1000);
        found.loaded = { messages: messages(from), toasts: await toasts() };
      },
    });
    await scenario("loadWrongConfig", {
      open: "rows.json",
      act: async ({ page, found }) => {
        const from = posted.length;
        await page.post({ command: "loadConfig" });
        found.loadDialog = await answer(join(folder(), "view.config"));
        await until("a notification", async () => (await toasts()).length > 0).catch(() => {});
        found.loaded = { messages: messages(from), toasts: await toasts() };
      },
    });
    await scenario("openFile", {
      open: "rows.csv",
      act: async ({ page, found }) => {
        const pages = await ids();
        const from = posted.length;
        await page.post({ command: "openFile" });
        found.openDialog = await answer(join(folder(), "rows.json"));
        await until("the other preview", () => posted.slice(from).some(isData));
        const other = await attachPage(pages);
        found.opened = { page: await drawn(other), messages: messages(from), tabs: TABS() };
        report.problems["openFile.opened"] = other.problems.map(where);
        other.close();
      },
    });
    await scenario("viewSource", {
      open: "rows.csv",
      act: async ({ page, found }) => {
        await page.post({ command: "loadView", viewName: "vscode.open", uri: file("rows.csv").toString(true) });
        await sleep(1500);
        found.opened = { tabs: TABS(), active: where(vscode.window.activeTextEditor?.document.uri.fsPath ?? null) };
      },
    });
    await scenario("loadByName", {
      open: "rows.csv",
      act: async ({ page, found }) => {
        const from = posted.length;
        await page.post({ command: "loadView", viewName: "data.preview", uri: "rows.yaml" });
        await until("the other preview", () => posted.slice(from).some(isData)).catch(() => {});
        await sleep(1000);
        found.opened = { tabs: TABS(), messages: messages(from), toasts: await toasts() };
      },
    });
    await scenario("otherCommand", {
      open: "rows.csv",
      act: async ({ page, found }) => {
        await page.post({
          command: "loadView",
          viewName: "workbench.action.files.newUntitledFile",
          uri: file("rows.csv").toString(true),
        });
        await sleep(1500);
        found.ran = { tabs: TABS() };
      },
    });
    await scenario("savedRefresh", {
      open: "rows.csv",
      act: async ({ found }) => {
        const document = await vscode.workspace.openTextDocument(file("rows.csv"));
        const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
        const from = posted.length;
        await editor.edit((edit) => edit.insert(document.positionAt(document.getText().length), "3,water\n"));
        await document.save();
        await until("the refresh", () => posted.slice(from).some(isData)).catch(() => {});
        await sleep(1000);
        found.saved = { messages: messages(from), status: await status() };
      },
    });
    await scenario("themeChange", {
      open: "rows.csv",
      act: async ({ found }) => {
        const from = posted.length;
        await update(vscode, `${PREFIX}.theme`, "vaporwave", target);
        await sleep(4000);
        found.changed = { messages: messages(from) };
        await update(vscode, `${PREFIX}.theme`, undefined, target);
      },
    });
  } finally {
    webview.postMessage = postMessage;
    desk.close();
  }
  writeFileSync(process.env.POLY_DATA_OUT, `${JSON.stringify(report, null, 2)}\n`);
};

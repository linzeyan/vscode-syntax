// Runs inside each extension host of tools/swagger-diff/run.js. It opens the
// preview every way there is, reads the page Swagger UI drew and the webview
// around it over the DevTools protocol, and writes what it saw as JSON for
// run.js to compare.
const { writeFileSync } = require("node:fs");
const http = require("node:http");
const { join } = require("node:path");
const vscode = require("vscode");

const { connect } = require("../ext-diff/cdp");

const SIDE = process.env.POLY_SWAGGER_SIDE;
const PORT = Number(process.env.POLY_SWAGGER_PORT);
const { command: COMMAND, fromUrl: FROM_URL, view: VIEW, prefix: PREFIX, extension: EXTENSION } = {
  swagger: {
    command: "swagger.preview",
    fromUrl: "swagger.previewFromUrl",
    view: "swaggerFiles",
    prefix: "swaggerViewer",
    extension: "arjun.swagger-viewer",
  },
  poly: {
    command: "poly.swaggerPreview",
    fromUrl: "poly.swaggerPreviewFromUrl",
    view: "polySwaggerFiles",
    prefix: "poly.swaggerViewer",
    extension: "ricky.poly-lsp",
  },
}[SIDE];
const REMOTE_PORT = 9363;
const REMOTE = "openapi: 3.1.0\ninfo:\n  title: Remote\n  version: '3'\npaths:\n  /status:\n    get:\n"
  + "      responses:\n        '200':\n          description: up\n";

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
const file = (name) => vscode.Uri.file(join(folder(), name));
/** The workspace folder written as `(workspace)`, so that both sides' records compare. */
const where = (text) => text?.replaceAll(folder(), "(workspace)");

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ids = async () => new Set((await targets()).map((one) => one.id));

/**
 * A DevTools session with the first target `matches` accepts that was not in
 * `before`. With `frame`, expressions run in a webview's inner frame as `w`.
 */
async function attach(what, before, matches, frame = false) {
  const target = await until(what, async () => (await targets()).find((one) => !before.has(one.id) && matches(one)));
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
    url: target.url,
    exceptions,
    async evaluate(expression) {
      const wrapped = frame
        ? `(async () => { const w = document.getElementById("active-frame")?.contentWindow;
            if (!w) throw new Error("no such frame"); return (${expression}); })()`
        : expression;
      const { result, exceptionDetails } = await send("Runtime.evaluate", {
        expression: wrapped,
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

const isWebview = (one) => one.url.toLowerCase().includes(`extensionid=${EXTENSION}`);
const isPage = (one) => /^http:\/\/localhost:\d+\//.test(one.url);

/** What Swagger UI drew, and the spec it was handed. */
const PAGE = `(() => {
  const d = document;
  const ui = window.ui;
  return {
    title: d.title,
    info: d.querySelector(".info .title")?.innerText ?? null,
    operations: [...d.querySelectorAll(".opblock")].map((op) =>
      op.querySelector(".opblock-summary-method")?.textContent + " "
        + op.querySelector(".opblock-summary-path")?.getAttribute("data-path")),
    models: [...d.querySelectorAll(".models .model-container")].map((one) => one.getAttribute("data-name")),
    errors: d.querySelector(".errors-wrapper")?.innerText ?? null,
    highlight: ui?.getConfigs().syntaxHighlight ?? null,
    spec: (() => {
      const spec = ui?.specSelectors.specJson().toJS() ?? null;
      if (spec?.components?.schemas) delete spec.components.schemas.Pet;
      return spec;
    })(),
    pet: JSON.stringify(ui?.specSelectors.specJson().toJS()?.components?.schemas?.Pet ?? null),
    styles: [...d.querySelectorAll("link[rel=stylesheet]")].map((one) => one.getAttribute("href")),
  };
})()`;
const DRAWN = "!!document.querySelector('.info .title') || !!document.querySelector('.errors-wrapper')";

/** The webview around the page; the page's path differs by design, its host and port do not. */
const WRAPPER = `(() => {
  const frame = w.document.querySelector("iframe");
  const src = new URL(frame.src);
  return {
    body: w.document.body.getAttribute("style"),
    frame: frame.getAttribute("style"),
    host: src.hostname,
    port: src.port,
  };
})()`;

const STATUS = `(() => {
  const item = [...document.querySelectorAll(".statusbar-item")].find((one) => one.textContent.trim() === "Swagger Viewer");
  return item ? { text: item.textContent.trim(), label: item.querySelector("a")?.getAttribute("aria-label") ?? null } : null;
})()`;
const STOP =
  `[...document.querySelectorAll(".statusbar-item")].find((one) => one.textContent.trim() === "Swagger Viewer")
  .querySelector("a").click()`;

const TOASTS = `[...document.querySelectorAll(".notifications-toasts .notification-list-item-message")]
  .map((one) => one.textContent)`;

const QUICK_INPUT = `(() => {
  const widget = document.querySelector(".quick-input-widget");
  return !!widget && widget.style.display !== "none";
})()`;

/** The list of specs: whether it started open, and its rows. */
const TREE = `(() => {
  const pane = [...document.querySelectorAll(".pane")].find((one) =>
    one.querySelector(".pane-header .title")?.textContent === "Swagger/OpenAPI Files");
  if (!pane) return null;
  return {
    expanded: pane.querySelector(".pane-header").getAttribute("aria-expanded"),
    rows: [...pane.querySelectorAll(".pane-body .monaco-list-row")].map((row) => row.getAttribute("aria-label")),
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

const previewTab = (label) =>
  vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) =>
    tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith("swaggerPreview")
    && (!label || tab.label.endsWith(label))
  );
const tabRecord = (tab) => ({ label: where(tab.label), column: tab.group.viewColumn });

/** Diagnostics once they have held still for three seconds, or whatever there is after thirty. */
async function settledDiagnostics(uri) {
  const read = () =>
    JSON.stringify(
      vscode.languages.getDiagnostics(uri).map((one) => ({
        message: one.message,
        range: [one.range.start.line, one.range.start.character, one.range.end.line, one.range.end.character],
        severity: one.severity,
        source: one.source ?? null,
      })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
  const deadline = Date.now() + 30_000;
  let last;
  let since = Date.now();
  for (;;) {
    const now = read();
    if (now !== last) {
      last = now;
      since = Date.now();
    }
    if ((now !== "[]" && Date.now() - since >= 3000) || Date.now() > deadline) return JSON.parse(now);
    await sleep(250);
  }
}

/** Replaces a line with the editor in front: upstream only follows the active editor. */
async function edit(editor, line, text) {
  const shown = await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
  await shown.edit((builder) => builder.replace(shown.document.lineAt(line).range, text));
}

module.exports.run = async function() {
  const report = { side: SIDE, seen: {}, errors: [] };
  const seen = report.seen;
  const desk = await connect(PORT);
  const config = () => vscode.workspace.getConfiguration();
  const target = vscode.ConfigurationTarget.Workspace;
  const remote = http.createServer((_request, response) => response.end(REMOTE)).listen(REMOTE_PORT, "127.0.0.1");
  const step = async (name, act) => {
    try {
      seen[name] = await act();
    } catch (error) {
      report.errors.push(`${SIDE} ${name}: ${error.message}`);
    }
  };
  let page;
  let editor;
  try {
    // First, before anything else opens a YAML file: poly hands the YAML
    // schemas over on the first one, and this is that one.
    await step("validation", async () => {
      const found = {};
      for (const name of ["invalid.yaml", "invalid.json", "v31.yaml"]) {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file(name)));
        found[name] = await settledDiagnostics(file(name));
      }
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      return found;
    });

    await step("tree", async () => {
      await vscode.commands.executeCommand("workbench.view.explorer");
      await sleep(2000);
      const start = await desk.evaluate(TREE);
      await vscode.commands.executeCommand(`${VIEW}.focus`);
      let last;
      const rows = await until("the list of specs to settle", async () => {
        const now = JSON.stringify((await desk.evaluate(TREE))?.rows ?? []);
        const settled = now !== "[]" && now === last ? now : undefined;
        last = now;
        await sleep(1000);
        return settled;
      });
      // In the order the workspace search found them, which is no order.
      return { expandedAtStart: start?.expanded ?? null, rows: JSON.parse(rows).map(where).sort() };
    });

    await step("chord", async () => {
      editor = await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(file("petstore.yaml")),
        vscode.ViewColumn.One,
      );
      await sleep(1000);
      const before = await ids();
      // shift+alt+p.
      await key(desk, "P", 80, 1 | 8);
      const tab = await until("the preview", () => previewTab());
      const view = await attach("the preview's webview", before, isWebview, true);
      page = await attach("the page", before, isPage);
      await until("the page drawn", () => page.evaluate(DRAWN));
      await sleep(1000);
      const found = {
        tab: tabRecord(tab),
        wrapper: await view.evaluate(WRAPPER),
        page: await page.evaluate(PAGE),
        status: await desk.evaluate(STATUS),
      };
      view.close();
      return found;
    });

    await step("edit", async () => {
      await edit(editor, 2, "  title: Petstore edited");
      const edited = "document.querySelector('.info .title')?.innerText.includes('edited')";
      await until("the edit on the page", () => page.evaluate(edited));
      await sleep(500);
      const found = { page: await page.evaluate(PAGE) };
      await editor.document.save();
      return found;
    });

    await step("refChanged", async () => {
      await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
      writeFileSync(
        join(folder(), "pet.yaml"),
        "type: object\nrequired: [name]\nproperties:\n  name:\n    type: string\n  age:\n    type: integer\n",
      );
      const changed = await until(
        "the changed file on the page",
        () => page.evaluate("JSON.stringify(window.ui.specSelectors.specJson().toJS()).includes('\"age\"')"),
        10_000,
      ).catch(() => false);
      await sleep(500);
      return { changed, page: await page.evaluate(PAGE) };
    });

    await step("explorer", async () => {
      const before = await ids();
      await vscode.commands.executeCommand(COMMAND, file("swagger.json"));
      const tab = await until("the preview", () => previewTab("swagger.json"));
      const opened = await attach("the page", before, isPage);
      await until("the page drawn", () => opened.evaluate(DRAWN));
      await sleep(1000);
      const found = { tab: tabRecord(tab), page: await opened.evaluate(PAGE) };
      opened.close();
      return found;
    });

    await step("url", async () => {
      const before = await ids();
      const address = `http://127.0.0.1:${REMOTE_PORT}/remote.yaml`;
      const done = vscode.commands.executeCommand(FROM_URL);
      await until("the input box", () => desk.evaluate(QUICK_INPUT));
      await desk.insertText(address);
      await sleep(300);
      await key(desk, "Enter", 13);
      await done;
      const tab = await until("the preview", () => previewTab("remote.yaml"));
      const opened = await attach("the page", before, isPage);
      await until("the page drawn", () => opened.evaluate(DRAWN));
      await sleep(1000);
      const found = {
        tab: tabRecord(tab),
        page: await opened.evaluate(PAGE),
        toasts: (await desk.evaluate(TOASTS)).filter((one) => one.includes("Swagger")),
      };
      opened.close();
      return found;
    });

    await step("settings", async () => {
      await config().update(`${PREFIX}.showOnlyFileName`, true, target);
      await config().update(`${PREFIX}.zoomLevel`, 150, target);
      try {
        await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
        const before = await ids();
        await vscode.commands.executeCommand(COMMAND);
        const tab = await until("the preview", () => previewTab("- petstore.yaml"));
        const view = await attach("the preview's webview", before, isWebview, true);
        const found = { tab: tabRecord(tab), wrapper: await view.evaluate(WRAPPER) };
        view.close();
        return found;
      } finally {
        await config().update(`${PREFIX}.showOnlyFileName`, undefined, target);
        await config().update(`${PREFIX}.zoomLevel`, undefined, target);
      }
    });

    await step("stop", async () => {
      const origin = new URL(page.url).origin;
      await desk.evaluate(STOP);
      const statusAfter = await until("the status bar item to go", async () => !(await desk.evaluate(STATUS)))
        .then(() => null, () => "still there");
      const refused = await fetch(`${origin}/`).then(() => false, () => true);
      await edit(editor, 2, "  title: Petstore stopped");
      const openPageUpdates = await until(
        "the edit on the page",
        () => page.evaluate("document.querySelector('.info .title')?.innerText.includes('stopped')"),
        5000,
      ).catch(() => false);
      await editor.document.save();
      return { statusAfter, refused, openPageUpdates };
    });

    await step("restart", async () => {
      await config().update(`${PREFIX}.defaultPort`, 18600, target);
      try {
        await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
        const before = await ids();
        await vscode.commands.executeCommand(COMMAND);
        const view = await attach("the preview's webview", before, isWebview, true);
        const opened = await attach("the page", before, isPage);
        await until("the page drawn", () => opened.evaluate(DRAWN));
        const found = {
          port: (await view.evaluate(WRAPPER)).port,
          info: await opened.evaluate("document.querySelector('.info .title')?.innerText"),
          status: await desk.evaluate(STATUS),
        };
        view.close();
        opened.close();
        await desk.evaluate(STOP);
        return found;
      } finally {
        await config().update(`${PREFIX}.defaultPort`, undefined, target);
      }
    });

    seen.exceptions = page?.exceptions.map((one) => (one.exception?.description ?? one.text).split("\n")[0]) ?? [];
  } finally {
    page?.close();
    desk.close();
    remote.close();
  }
  writeFileSync(process.env.POLY_SWAGGER_OUT, `${JSON.stringify(report, null, 2)}\n`);
};

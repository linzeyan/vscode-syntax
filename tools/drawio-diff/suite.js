// Runs inside each extension host of tools/drawio-diff/run.js. It drives
// draw.io in the editor's webview over the DevTools protocol, and writes what
// it saw as JSON for run.js to compare.
const { writeFileSync } = require("node:fs");
const { deflateRawSync } = require("node:zlib");
const vscode = require("vscode");

const { POLY_COMMANDS } = require("./names");

const SIDE = process.env.POLY_DRAWIO_SIDE;
const PORT = Number(process.env.POLY_DRAWIO_PORT);
const EDITOR = {
  hediet: {
    viewType: "hediet.vscode-drawio-text",
    pngViewType: "hediet.vscode-drawio",
    page: "extensionId=hediet.vscode-drawio",
  },
  poly: { viewType: "poly.drawio", pngViewType: "poly.drawio.png", page: "extensionId=ricky.poly-lsp" },
}[SIDE];

/** The settings are hediet's; poly's have the same names under its own prefix. */
const PREFIX = { hediet: "hediet.vscode-drawio", poly: "poly.drawio" }[SIDE];

/** The commands, by hediet's name for each, which is its own under its prefix. */
const COMMANDS = {
  hediet: Object.fromEntries(Object.keys(POLY_COMMANDS).map((name) => [name, `hediet.vscode-drawio.${name}`])),
  poly: POLY_COMMANDS,
}[SIDE];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** A shape as a library holds it: a graph model, here uncompressed. */
const LIBRARY_SHAPE = "<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>"
  + "<mxCell id=\"2\" value=\"\" style=\"rounded=1;\" vertex=\"1\" parent=\"1\"><mxGeometry width=\"40\" height=\"40\" "
  + "as=\"geometry\"/></mxCell></root></mxGraphModel>";

/** A shape compressed as draw.io's `Graph.compress` does it. */
const compressed = (xml) => deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString("base64");

/** Settings to start draw.io under, each set on its own. */
const VARIANTS = {
  default: {},
  minDark: { theme: "min", appearance: "dark" },
  sketchHighContrast: { theme: "sketch", appearance: "high-contrast" },
  simpleHighContrastLight: { theme: "simple", appearance: "high-contrast-light" },
  auto: { theme: "auto", appearance: "automatic" },
  drawing: {
    simpleLabels: true,
    zoomFactor: 1.5,
    globalVars: { team: "poly" },
    styles: [{ commonStyle: { fontColor: "#111111" }, graph: { background: "#eeeeee" } }],
    defaultVertexStyle: { fillColor: "#ff0000" },
    defaultEdgeStyle: { strokeColor: "#00ff00" },
    colorNames: { FF0000: "Poly Red" },
    presetColors: ["FF0000"],
    customColorSchemes: [[{ title: "red", fill: "#FF0000" }]],
    customFonts: ["Courier New"],
    resizeImages: false,
    showTooltipIcons: true,
    showLinkIcons: true,
    showConnectHandle: true,
  },
  // A library in each form hediet reads right, two under one entry. The
  // shape in `xml` is compressed, which leaves nothing in it to escape.
  libraries: {
    customLibraries: [
      {
        entryId: "poly",
        libName: "Inline JSON",
        // A string: hediet parses it, and an array stops its editor opening.
        json: JSON.stringify([{ xml: LIBRARY_SHAPE, w: 40, h: 40, title: "json box", aspect: "fixed" }]),
      },
      {
        entryId: "poly",
        libName: "Inline XML",
        xml: `<mxlibrary>${
          JSON.stringify([{ xml: compressed(LIBRARY_SHAPE), w: 40, h: 40, title: "xml box" }])
        }</mxlibrary>`,
      },
      {
        entryId: "url",
        libName: "From a URL",
        url: "https://raw.githubusercontent.com/jgraph/drawio-libs/master/libs/arista.xml",
      },
    ],
  },
  // draw.io from the web, from where each names by default. Not from
  // app.diagrams.net: it refuses to be framed.
  online: { offline: false },
  // A library file as draw.io saves one; run.js writes it.
  libraryFile: { customLibraries: [{ entryId: "file", libName: "From a file", file: "${workspaceFolder}/lib.xml" }] },
};

async function until(what, check, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** The DevTools session of the editor's webview, opened after `known` ids. */
async function webview(known) {
  const target = await until("the editor's webview", async () => {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return targets.find((one) => one.url.includes(EDITOR.page) && !known.has(one.id));
  });
  known.add(target.id);
  return devtools(target, `document.getElementById("active-frame")?.contentWindow`);
}

/** draw.io from the web at `url`: another origin, and so a target of its own. */
async function onlineFrame(known, url) {
  const target = await until("draw.io's frame", async () => {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return targets.find((one) => one.url.startsWith(url) && !known.has(one.id));
  }, 60_000);
  known.add(target.id);
  return devtools(target, "window");
}

/** The workbench's own page, where VSCode draws its dialogs and notifications. */
async function workbench() {
  const target = await until("the workbench", async () => {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return targets.find((one) => one.type === "page" && one.url.includes("workbench.html"));
  });
  return devtools(target, "window");
}

/** A DevTools session with `target`, evaluating with `w` as the window `frame` names. */
async function devtools(target, frame) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("DevTools socket failed to open")), { once: true });
  });
  let next = 1;
  const pending = new Map();
  const events = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method) {
      events.push(message);
      return;
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
  return {
    send,
    events,
    async evaluate(expression) {
      const { result, exceptionDetails } = await send("Runtime.evaluate", {
        expression: `(async () => { const w = ${frame};
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

/**
 * draw.io's graph, found without a reference to it: every draw.io method a
 * key press reaches is briefly wrapped to note its `this`. The same on both
 * sides, since both run the same draw.io.
 */
const GRAPH = `(() => {
  if (w.__graph) return true;
  const hooks = ["fireMouseEvent", "isEnabled", "isEditing", "getModel", "getSelectionCells"];
  const saved = [];
  for (const proto of [w.mxGraph.prototype, w.Graph.prototype]) {
    for (const hook of hooks) {
      if (!Object.prototype.hasOwnProperty.call(proto, hook)) continue;
      const original = proto[hook];
      saved.push([proto, hook, original]);
      proto[hook] = function () { w.__graph = w.__graph || this; return original.apply(this, arguments); };
    }
  }
  w.document.body.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Shift", keyCode: 16, bubbles: true }));
  for (const [proto, hook, original] of saved) proto[hook] = original;
  return !!w.__graph;
})()`;

async function scenario(uri, known) {
  const seen = {};
  // A PNG opens in the binary editor and has no text; its state is the tab's,
  // and its content what is saved.
  const png = uri.path.endsWith(".png");
  const viewType = png ? EDITOR.pngViewType : EDITOR.viewType;
  const document = () => vscode.workspace.textDocuments.find((one) => one.uri.toString() === uri.toString());
  const tab = () => vscode.window.tabGroups.activeTabGroup.activeTab;
  await vscode.commands.executeCommand("vscode.openWith", uri, viewType);
  const page = await webview(known);
  const ready = () =>
    page.evaluate("!!(w.App && w.document.querySelector(\".geDiagramContainer\"))").catch(() => false);
  await until("draw.io to start", ready, 60_000);
  // Watched from the first request: the page is reloaded with the log on.
  await page.send("Log.enable");
  await page.send("Runtime.enable");
  await vscode.commands.executeCommand("workbench.action.webview.reloadWebviewAction");
  await sleep(1000);
  await until("draw.io to start again", ready, 60_000);
  await sleep(2000);
  seen.openedInEditor = tab()?.input?.viewType === viewType;
  seen.openedDirty = tab()?.isDirty;
  seen.openedText = document()?.getText();
  seen.pictures = await page.evaluate(`[...w.document.querySelectorAll(".geDiagramContainer svg image")]
    .map((image) => (image.getAttribute("xlink:href") ?? image.getAttribute("href") ?? "").replace(/^.*?\\/(img\\/)/, "$1"))`);
  seen.drawn = await page.evaluate(
    "w.document.querySelectorAll(\":is(path, rect, ellipse, image)\", w.document.querySelector(\".geDiagramContainer svg\")).length",
  );

  const before = document()?.getText();
  seen.graph = await page.evaluate(GRAPH);
  await page.evaluate(`(() => {
    const graph = w.__graph;
    graph.getModel().beginUpdate();
    try { graph.insertVertex(graph.getDefaultParent(), "v1", "poly", 200, 40, 120, 60); }
    finally { graph.getModel().endUpdate(); }
  })()`);
  await until("the page to write the edit", () => (png ? tab()?.isDirty : document()?.getText() !== before))
    .catch(() => undefined);
  await sleep(1000);
  seen.editedDirty = tab()?.isDirty;
  seen.editedText = document()?.getText();

  await vscode.commands.executeCommand("workbench.action.files.save");
  await sleep(500);
  const saved = Buffer.from(await vscode.workspace.fs.readFile(uri));
  seen[png ? "savedPng" : "saved"] = saved.toString(png ? "base64" : "utf8");
  seen.savedDirty = tab()?.isDirty;

  // An edit to the text, as the XML open beside it would make.
  const text = document()?.getText() ?? "";
  const at = text.indexOf("value=\"poly\"");
  if (at >= 0) {
    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(document().positionAt(at), document().positionAt(at + "value=\"poly\"".length));
    edit.replace(uri, range, "value=\"edited\"");
    await vscode.workspace.applyEdit(edit);
    await sleep(3000);
    seen.mergedLabel = await page.evaluate("w.__graph.getModel().getCell(\"v1\")?.value ?? \"(no cell)\"");
    seen.mergedText = document()?.getText();
  } else {
    seen.mergedLabel = "(the edit was not in the text)";
  }
  // The same for a shape the file had when it was opened: draw.io merges a
  // text edit against the drawing as it was loaded, so this is the case that
  // reaches the drawing, and the one above the case that does not.
  const now = document()?.getText() ?? "";
  const first = now.indexOf("value=\"first");
  if (first >= 0) {
    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(document().positionAt(first), document().positionAt(first + "value=\"first".length));
    edit.replace(uri, range, "value=\"second");
    await vscode.workspace.applyEdit(edit);
    await sleep(3000);
    seen.mergedOriginal = await page.evaluate("w.__graph.getModel().getCell(\"a\")?.value ?? \"(no cell)\"");
  }

  // A shape drawn and then reverted away: it has to leave the drawing too,
  // or the next autosave puts it back in the file.
  await page.evaluate(`(() => {
    const graph = w.__graph;
    graph.getModel().beginUpdate();
    try { graph.insertVertex(graph.getDefaultParent(), "v2", "reverted", 200, 140, 120, 60); }
    finally { graph.getModel().endUpdate(); }
  })()`);
  await until("the page to write the shape", () => tab()?.isDirty).catch(() => undefined);
  await sleep(1000);
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await sleep(3000);
  seen.revertKeeps = await page.evaluate("!!w.__graph.getModel().getCell(\"v2\")");

  page.close();
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  await sleep(500);
  return { seen, page };
}

/** What VSCode is asking, in a dialog or in a notification about a plugin; `null` if nothing. */
const PROMPT = `(() => {
  const text = (root, selector) => root.querySelector(selector)?.textContent.trim();
  const labels = (root, selector) => [...root.querySelectorAll(selector)].map((button) => button.textContent.trim());
  const dialog = w.document.querySelector(".monaco-dialog-box");
  if (dialog) {
    return { kind: "dialog", message: text(dialog, ".dialog-message-text"), detail: text(dialog, ".dialog-message-detail"),
      buttons: labels(dialog, ".dialog-buttons .monaco-button") };
  }
  const toast = [...w.document.querySelectorAll(".notification-toast")].find((one) => /plug-?in/i.test(one.textContent));
  if (toast) {
    const icon = toast.querySelector(".notification-list-item-icon")?.className ?? "";
    return { kind: "notification", severity: /codicon-(info|warning|error)/.exec(icon)?.[1],
      message: text(toast, ".notification-list-item-message"),
      buttons: labels(toast, ".notification-list-item-buttons-container .monaco-button") };
  }
  return null;
})()`;

/**
 * A plugin in the workspace's settings, from its first opening to its file
 * changing: what VSCode asks, what the answer leaves in the user's settings,
 * and whether draw.io ran it.
 */
async function plugins(folder, known) {
  const desk = await workbench();
  const settings = () => vscode.workspace.getConfiguration(PREFIX);
  const file = vscode.Uri.joinPath(folder, "plugin.js");
  const original = await vscode.workspace.fs.readFile(file);
  // The workspace's path differs by side; it is set aside.
  const where = (value) =>
    JSON.parse(
      [folder.toString(), folder.fsPath, `/private${folder.fsPath}`]
        .reduce((text, path) => text.replaceAll(path, "(workspace)"), JSON.stringify(value ?? null)),
    );
  const open = async (answer) => {
    // Not awaited: hediet opens the editor only once the prompt is answered.
    const opened = vscode.commands.executeCommand(
      "vscode.openWith",
      vscode.Uri.joinPath(folder, "one.drawio"),
      EDITOR.viewType,
    );
    const prompt = await until("a prompt", () => desk.evaluate(PROMPT), 10_000).catch(() => null);
    const pressed = prompt && answer ? prompt.buttons.find((label) => answer.test(label)) : undefined;
    if (pressed) {
      await desk.evaluate(
        `[...w.document.querySelectorAll(".monaco-dialog-box .monaco-button, .notification-toast .monaco-button")]
        .find((button) => button.textContent.trim() === ${JSON.stringify(pressed)})?.click()`,
      );
    }
    await Promise.race([opened, sleep(10_000)]);
    let page;
    try {
      page = await webview(known);
      await until(
        "draw.io to start",
        () =>
          page.evaluate("!!(w.App && w.document.querySelector(\".geDiagramContainer\"))")
            .catch(() => false),
        30_000,
      ).catch(() => undefined);
      await sleep(2000);
      const runs = await page.evaluate("w.__pluginRuns ?? 0").catch((error) => `(${error.message})`);
      return where({ prompt, pressed, runs, knownPlugins: settings().inspect("knownPlugins")?.globalValue });
    } catch (error) {
      // What was asked, so that an editor that never showed says why.
      throw new Error(`${error.message}; asked ${JSON.stringify(prompt)}, pressed ${pressed}`);
    } finally {
      // Closed either way: a tab left open is in every part after this one.
      page?.close();
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      await sleep(1000);
    }
  };
  const seen = {};
  try {
    await settings().update(
      "plugins",
      [{ file: "${workspaceFolder}/plugin.js" }],
      vscode.ConfigurationTarget.Workspace,
    );
    seen.first = await open(/^(allow|yes|load|enable|trust)/i);
    seen.again = await open(null);
    await vscode.workspace.fs.writeFile(file, Buffer.concat([original, Buffer.from("// changed\n")]));
    seen.changed = await open(/^(deny|disallow|no\b|block|don't|do not)/i);
    seen.denied = await open(null);
  } finally {
    await vscode.workspace.fs.writeFile(file, original);
    await settings().update("plugins", undefined, vscode.ConfigurationTarget.Workspace).catch(() => undefined);
    await settings().update("knownPlugins", undefined, vscode.ConfigurationTarget.Global).catch(() => undefined);
    desk.close();
  }
  return seen;
}

/** What the workbench is asking over the editor: a quick pick or input, or a dialog; `null` if nothing. */
const ASKING = `(() => {
  const widget = w.document.querySelector(".quick-input-widget");
  if (widget && widget.style.display !== "none") {
    const input = widget.querySelector(".quick-input-box input");
    return {
      kind: "quick input",
      title: widget.querySelector(".quick-input-title")?.textContent.trim() || undefined,
      placeholder: input?.getAttribute("placeholder") || undefined,
      value: input?.value || undefined,
      items: [...widget.querySelectorAll(".quick-input-list .monaco-list-row")].map((row) => {
        const label = row.querySelector(".label-name")?.textContent.trim();
        const description = row.querySelector(".label-description")?.textContent.trim() || undefined;
        return label === undefined ? row.getAttribute("aria-label") : { label, description };
      }),
    };
  }
  const dialog = w.document.querySelector(".monaco-dialog-box");
  if (dialog) {
    return { kind: "dialog", message: dialog.querySelector(".dialog-message-text")?.textContent.trim(),
      buttons: [...dialog.querySelectorAll(".dialog-buttons .monaco-button")].map((button) => button.textContent.trim()) };
  }
  return null;
})()`;

/**
 * Each of `answers` typed into what the workbench asks in turn, as keys, and
 * entered; what it asked, each read once its list has been drawn.
 */
async function answer(desk, answers) {
  const key = (name, code) =>
    Promise.all(
      ["keyDown", "keyUp"].map((type) =>
        desk.send("Input.dispatchKeyEvent", {
          type,
          key: name,
          code: name,
          windowsVirtualKeyCode: code,
          nativeVirtualKeyCode: code,
        })
      ),
    );
  const asked = [];
  for (const text of answers) {
    if (!await until("a question", () => desk.evaluate(ASKING), 10_000).catch(() => null)) break;
    await sleep(1000);
    asked.push(await desk.evaluate(ASKING));
    if (text) await desk.send("Input.insertText", { text });
    await sleep(500);
    await key("Enter", 13);
    await sleep(1500);
  }
  return { asked, escape: () => key("Escape", 27) };
}

/**
 * The commands of the draw.io editor, each run from a drawing open in it as
 * a user would, from the palette: what each asks and how it is answered --
 * typed, as keys, into what VSCode shows -- and what it leaves behind: files
 * made and removed, the editor open after, the settings it wrote.
 */
async function commands(folder, known) {
  const desk = await workbench();
  const settings = () => vscode.workspace.getConfiguration(PREFIX);
  const listing = async () =>
    new Map(
      await Promise.all(
        (await vscode.workspace.fs.readDirectory(folder))
          .filter(([, type]) => type === vscode.FileType.File)
          .map(async (
            [name],
          ) => [name, Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, name)))]),
      ),
    );
  const where = (value) =>
    JSON.parse(
      [folder.toString(), folder.fsPath, `/private${folder.fsPath}`]
        .reduce((text, path) => text.replaceAll(path, "(workspace)"), JSON.stringify(value ?? null)),
    );
  const editorOf = (input) =>
    input?.viewType === EDITOR.viewType
      ? "draw.io"
      : input?.viewType === EDITOR.pngViewType
      ? "draw.io png"
      : input instanceof vscode.TabInputText
      ? "text"
      : input?.viewType;

  /** `command` run over `file`, open in the draw.io editor, each of `answers` typed in turn and entered. */
  const run = async (file, command, answers) => {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(folder, file),
      await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(folder, "one.drawio"),
      ),
    );
    await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.joinPath(folder, file), EDITOR.viewType);
    const page = await webview(known);
    await until(
      "draw.io to start",
      () =>
        page.evaluate("!!(w.App && w.document.querySelector(\".geDiagramContainer\"))")
          .catch(() => false),
      60_000,
    );
    await sleep(1000);
    const before = await listing();
    const seen = {};
    const done = vscode.commands.executeCommand(COMMANDS[command]).then(
      () => "done",
      (error) => `failed: ${error.message}`,
    );
    const { asked, escape } = await answer(desk, answers);
    seen.asked = asked;
    seen.result = await Promise.race([done, sleep(10_000).then(() => "(still running)")]);
    seen.left = await desk.evaluate(ASKING);
    if (seen.left) await escape();
    await sleep(3000);
    const after = await listing();
    seen.created = Object.fromEntries(
      [...after].filter(([name, bytes]) => !before.has(name) || !before.get(name).equals(bytes))
        .map(([name, bytes]) => [name, /\.png$/.test(name) ? bytes.toString("base64") : bytes.toString("utf8")]),
    );
    seen.removed = [...before.keys()].filter((name) => !after.has(name));
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    seen.active = { label: tab?.label, editor: editorOf(tab?.input) };
    seen.tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      .map((one) => `${one.label} (${editorOf(one.input)}${one.isDirty ? ", dirty" : ""})`);
    page.close();
    // Reverted first: closing a changed or untitled editor asks whether to save.
    for (let open = 0; open < 10 && vscode.window.tabGroups.activeTabGroup.activeTab; open++) {
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
    for (const name of [...after.keys()].filter((name) => !before.has(name) || name === file)) {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder, name)).catch(() => undefined);
    }
    await sleep(500);
    return where(seen);
  };

  const seen = {};
  try {
    seen.convert = await run("convert.drawio", "convert", ["svg", ""]);
    seen.export = await run("export.drawio", "export", ["svg", ""]);
    seen.changeTheme = await run("theme.drawio", "changeTheme", ["min"]);
    for (const key of ["theme", "appearance"]) {
      const { globalValue, workspaceValue, workspaceFolderValue } = settings().inspect(key);
      seen.changeTheme[key] = { globalValue, workspaceValue, workspaceFolderValue };
      await settings().update(key, undefined, vscode.ConfigurationTarget.Global).catch(() => undefined);
    }
    // Typed after the folder the dialog starts in.
    seen.newDiagram = await run("new.drawio", "newDiagram", ["made.drawio", ""]);
  } finally {
    desk.close();
  }
  return seen;
}

/** Where VSCode's cursor is in `editor`, the one in front unless given: the file, and the line and column. */
function place(editor = vscode.window.activeTextEditor) {
  const at = editor?.selection.active;
  return editor ? `${editor.document.uri.path.split("/").pop()}:${at.line + 1}:${at.character + 1}` : null;
}

/**
 * Code links, from a diagram beside code.ts: the status bar's switch, a double
 * click on a node -- labelled `#Symbol`, or linked -- before and after it, and
 * each way of linking code to the node selected. Recorded by where VSCode goes
 * and what a link leaves in the node.
 */
async function codeLink(folder, known) {
  const desk = await workbench();
  const settings = () => vscode.workspace.getConfiguration(PREFIX);
  const codeUri = vscode.Uri.joinPath(folder, "code.ts");
  const diagramUri = vscode.Uri.joinPath(folder, "link.drawio");
  const seen = {};
  const step = async (name, action) => {
    try {
      seen[name] = await action();
    } catch (error) {
      seen[name] = { error: error.message };
    }
  };
  // The code link switch, and the side of the status bar it is on.
  const status = () =>
    desk.evaluate(`[...w.document.querySelectorAll(".statusbar-item")]
    .map((item) => [(item.getAttribute("aria-label") || item.textContent || "").trim(),
      item.closest(".left-items") ? "left" : "right"])
    .filter(([text]) => /link/i.test(text)).map(([text, side]) => text + " (" + side + ")")`);
  await vscode.window.showTextDocument(codeUri, { viewColumn: vscode.ViewColumn.One });
  await vscode.commands.executeCommand("vscode.openWith", diagramUri, EDITOR.viewType, vscode.ViewColumn.Two);
  const page = await webview(known);
  try {
    await until(
      "draw.io to start",
      () =>
        page.evaluate("!!(w.App && w.document.querySelector(\".geDiagramContainer\"))")
          .catch(() => false),
      60_000,
    );
    await sleep(1500);
    await page.evaluate(GRAPH);
    // A workspace symbol search waits for TypeScript to have started on the file.
    await until(
      "TypeScript's symbols",
      async () =>
        ((await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", "MyClass")) ?? []).length > 0,
      60_000,
    ).catch(() => undefined);
    const cell = (id) =>
      page.evaluate(`(() => {
      const cell = w.__graph.getModel().getCell(${JSON.stringify(id)});
      const value = cell.value?.nodeType ? new w.XMLSerializer().serializeToString(cell.value) : cell.value;
      return { value, style: cell.style };
    })()`);
    const select = (id) =>
      page.evaluate(`w.__graph.setSelectionCell(w.__graph.getModel().getCell(${JSON.stringify(id)}))`);
    const focusDiagram = () =>
      vscode.commands.executeCommand("vscode.openWith", diagramUri, EDITOR.viewType, vscode.ViewColumn.Two);
    // A real double click, as the mouse makes it, on the node's middle: from
    // the end of code.ts, so that a jump shows.
    const doubleClick = async (id) => {
      const editor = await vscode.window.showTextDocument(codeUri, { viewColumn: vscode.ViewColumn.One });
      editor.selection = new vscode.Selection(7, 0, 7, 0);
      const [x, y] = await page.evaluate(`(() => {
        const graph = w.__graph;
        const state = graph.view.getState(graph.getModel().getCell(${JSON.stringify(id)}));
        const box = graph.container.getBoundingClientRect();
        const frame = w.frameElement.getBoundingClientRect();
        return [frame.left + box.left + state.getCenterX() - graph.container.scrollLeft,
          frame.top + box.top + state.getCenterY() - graph.container.scrollTop];
      })()`);
      for (const clickCount of [1, 2]) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount });
        }
      }
      await sleep(3000);
      // A double click not taken starts editing the label.
      const editing = await page.evaluate("w.__graph.isEditing()");
      await page.evaluate("w.__graph.stopEditing(true)");
      // Every editor, not the active one alone: code may be shown without the focus.
      const editors = vscode.window.visibleTextEditors.map((one) => `${place(one)} in ${one.viewColumn}`);
      const tabs = vscode.window.tabGroups.all.map((group) => `${group.viewColumn}: ${group.activeTab?.label}`);
      const shown = { place: place(), editors, tabs, editing };
      await focusDiagram();
      return shown;
    };
    // Code selected, `helper`'s name unless `at` says otherwise.
    const link = async (command, id, argument, answers = [], at = new vscode.Selection(4, 16, 4, 22)) => {
      await select(id);
      const editor = await vscode.window.showTextDocument(codeUri, { viewColumn: vscode.ViewColumn.One });
      editor.selection = at;
      const done = vscode.commands.executeCommand(COMMANDS[command], ...(argument ? [argument] : []))
        .then(() => "done", (error) => `failed: ${error.message}`);
      const { asked } = await answer(desk, answers);
      const result = await Promise.race([done, sleep(10_000).then(() => "(still running)")]);
      await sleep(2000);
      return { asked, result, cell: await cell(id) };
    };

    seen.statusInText = await status();
    await focusDiagram();
    seen.statusOff = await status();
    await step("doubleClickOff", () => doubleClick("n0"));
    await step("toggle", async () => {
      await focusDiagram();
      await vscode.commands.executeCommand(COMMANDS.toggleCodeLinkActivation);
      await sleep(1000);
      const { globalValue, workspaceValue, workspaceFolderValue } = settings().inspect("codeLinkActivated");
      return { globalValue, workspaceValue, workspaceFolderValue, status: await status() };
    });
    await step("doubleClickHash", () => doubleClick("n0"));
    await step("linkCode", () => link("linkCodeWithSelectedNode", "n1"));
    await step("doubleClickCode", () => doubleClick("n1"));
    await step("linkFile", () => link("linkFileWithSelectedNode", "n2", codeUri));
    await step("doubleClickFile", () => doubleClick("n2"));
    // From inside MyClass, the first symbol offered.
    await step(
      "linkSymbol",
      () => link("linkSymbolWithSelectedNode", "n3", undefined, [""], new vscode.Selection(1, 3, 1, 3)),
    );
    await step("doubleClickSymbol", () => doubleClick("n3"));
    // What each symbol command offers for a selection inside `helper` that names no symbol, and for none.
    const offered = async (command, at) => {
      const editor = await vscode.window.showTextDocument(codeUri, { viewColumn: vscode.ViewColumn.One });
      editor.selection = at;
      void vscode.commands.executeCommand(COMMANDS[command]).then(undefined, () => undefined);
      const asked = await until("a question", () => desk.evaluate(ASKING), 10_000).catch(() => null);
      await sleep(1000);
      const shown = asked && await desk.evaluate(ASKING);
      if (shown) await answer(desk, []).then(({ escape }) => escape());
      await sleep(500);
      return shown;
    };
    await step("symbolsInBody", () => offered("linkSymbolWithSelectedNode", new vscode.Selection(5, 2, 5, 8)));
    await step(
      "workspaceSymbolsUnselected",
      () => offered("linkWsSymbolWithSelectedNode", new vscode.Selection(1, 3, 1, 3)),
    );
    await step("linkWorkspaceSymbol", () => link("linkWsSymbolWithSelectedNode", "n4", undefined, ["helper"]));
    await step("doubleClickWorkspaceSymbol", () => doubleClick("n4"));
    seen.text = vscode.workspace.textDocuments.find((one) => one.uri.toString() === diagramUri.toString())?.getText();
  } finally {
    page.close();
    desk.close();
    for (let open = 0; open < 10 && vscode.window.tabGroups.activeTabGroup.activeTab; open++) {
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const key of ["codeLinkActivated"]) {
      await settings().update(key, undefined, vscode.ConfigurationTarget.Global).catch(() => undefined);
      await settings().update(key, undefined, vscode.ConfigurationTarget.Workspace).catch(() => undefined);
    }
  }
  return seen;
}

/**
 * draw.io fences in the markdown preview: what the preview drew of fence.md,
 * fence by fence, and whether it refused anything on the way. Each side's
 * markup around a drawing is its own, and not compared.
 */
async function markdownPreview(folder, known) {
  const uri = vscode.Uri.joinPath(folder, "fence.md");
  const config = vscode.workspace.getConfiguration("poly");
  if (SIDE === "poly") await config.update("markdownDiagrams.enabled", true, vscode.ConfigurationTarget.Workspace);
  try {
    const seen = {};
    await vscode.commands.executeCommand("markdown.showPreview", uri);
    const target = await until("the markdown preview", async () => {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      return targets.find((one) =>
        one.url.includes("extensionId=vscode.markdown-language-features") && !known.has(one.id)
      );
    });
    known.add(target.id);
    const page = await devtools(target, `document.getElementById("active-frame")?.contentWindow`);
    try {
      const ready = () => page.evaluate("!!w.document.querySelector('h1')").catch(() => false);
      await until("the preview's content", ready, 30_000);
      // Watched from its first request: reloaded with the log on.
      await page.send("Log.enable");
      await page.send("Runtime.enable");
      await vscode.commands.executeCommand("workbench.action.webview.reloadWebviewAction");
      await sleep(1000);
      await until("the preview's content again", ready, 30_000);
      await sleep(10_000);
      Object.assign(
        seen,
        await page.evaluate(`({
        refused: !!w.document.querySelector("#code-csp-warning"),
        // Each fence as the preview left it, whatever holds it: what it drew,
        // its labels' text (or the error it shows), and the picture's size.
        blocks: [...w.document.querySelector(".markdown-body").children]
          .filter((one) => !["H1", "SPAN", "SCRIPT"].includes(one.tagName) && one.getBoundingClientRect().height > 0)
          .map((one) => {
            const svg = one.querySelector("svg")?.getBoundingClientRect();
            return {
              shapes: one.querySelectorAll("svg :is(path, rect, ellipse, image)").length,
              // As shown: not an exported picture's fallback text, which a
              // browser that draws its labels never shows.
              text: one.innerText.replace(/\\s+/g, " ").trim().slice(0, 80),
              size: svg ? [Math.round(svg.width), Math.round(svg.height)] : null,
            };
          }),
      })`),
      );
      // A picture of it, to look at: the workbench's, the preview composited in.
      const desk = await workbench();
      const { data } = await desk.send("Page.captureScreenshot", { format: "png" });
      desk.close();
      require("fs").writeFileSync(
        process.env.POLY_DRAWIO_OUT.replace(/\.json$/, "-preview.png"),
        Buffer.from(data, "base64"),
      );
      seen.log = page.events.filter((event) =>
        event.method === "Log.entryAdded"
        && ["error", "warning"].includes(event.params.entry.level)
        && !/\/index\.html\?id=/.test(event.params.entry.url ?? "")
      )
        .map((event) => `${event.params.entry.source}: ${event.params.entry.text}`.slice(0, 300));
    } finally {
      page.close();
    }
    return seen;
  } finally {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await config.update("markdownDiagrams.enabled", undefined, vscode.ConfigurationTarget.Workspace);
  }
}

exports.run = async function run() {
  const out = process.env.POLY_DRAWIO_OUT;
  const report = { side: SIDE, files: {}, violations: [] };
  const known = new Set();
  try {
    const folder = vscode.workspace.workspaceFolders[0].uri;
    // Some parts alone, to work on them: POLY_DRAWIO_ONLY=codeLink or =plugins,commands.
    const only = (part) => !process.env.POLY_DRAWIO_ONLY || process.env.POLY_DRAWIO_ONLY.split(",").includes(part);
    const files = !only("files")
      ? []
      : [
        "empty.drawio",
        "one.drawio",
        "one.dio",
        "libraries.drawio",
        "empty.drawio.svg",
        "one.drawio.svg",
        "one.dio.svg",
        "empty.drawio.png",
        "one.drawio.png",
      ];
    for (const file of files) {
      const { seen, page } = await scenario(vscode.Uri.joinPath(folder, file), known);
      report.files[file] = seen;
      for (const event of page.events) {
        const entry = event.params?.entry;
        // VSCode's webview host page (its index.html) logs its own warnings
        // into the same session; they are not the editor's.
        const host = /\/index\.html\?id=/.test(entry?.url ?? "");
        if (event.method === "Log.entryAdded" && ["error", "warning"].includes(entry.level) && !host) {
          report.violations.push(`${file} ${entry.source}: ${entry.text}${entry.url ? ` ${entry.url}` : ""}`);
        }
        if (event.method === "Runtime.exceptionThrown") {
          report.violations.push(`${file} exception: ${
            event.params.exceptionDetails.exception?.description
              ?? event.params.exceptionDetails.text
          }`);
        }
      }
    }
    // What draw.io was started with under each set of settings, read from a
    // fresh editor.
    report.variants = {};
    for (const [variant, settings] of Object.entries(only("variants") ? VARIANTS : {})) {
      const config = vscode.workspace.getConfiguration(PREFIX);
      for (const [key, value] of Object.entries(settings)) {
        await config.update(key, value, vscode.ConfigurationTarget.Workspace);
      }
      await vscode.commands.executeCommand(
        "vscode.openWith",
        vscode.Uri.joinPath(folder, "one.drawio"),
        EDITOR.viewType,
      );
      const page = await webview(known);
      const online = settings.offline === false;
      if (!online) {
        await page.send("Log.enable");
        await page.send("Runtime.enable");
        await vscode.commands.executeCommand("workbench.action.webview.reloadWebviewAction");
        await sleep(1000);
      }
      const drawio = online ? await onlineFrame(known, settings["online-url"] ?? "https://embed.diagrams.net/") : page;
      try {
        await until(
          "draw.io to start",
          () => drawio.evaluate("!!(w.App && w.Editor.config)").catch(() => false),
          60_000,
        );
      } catch (error) {
        const seen = page.events
          .filter((event) => event.method === "Runtime.exceptionThrown" || event.method === "Log.entryAdded")
          .map((event) => event.params.exceptionDetails?.exception?.description ?? event.params.entry?.text);
        throw new Error(`${variant}: ${error.message}\n${seen.join("\n")}`);
      }
      await sleep(2000);
      // draw.io folds a library's palette and fills it on the first click;
      // opened here, so what is compared is the shapes it drew.
      const libraries = (settings.customLibraries ?? []).map((library) => library.libName);
      await drawio.evaluate(`[...w.document.querySelectorAll(".geSidebarContainer .geTitle")]
        .filter((title) => ${JSON.stringify(libraries)}.includes(title.textContent))
        .forEach((title) => {
          title.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
          // draw.io fills it once it scrolls into view, which a window not
          // painted in the background never does.
          title.nextElementSibling.firstElementChild.initPaletteFn?.();
        })`);
      await sleep(libraries.length ? 5000 : 0);
      // Stringified in the page, and a key at a time: hediet's configuration
      // carries functions, which DevTools cannot return by value, and some of
      // its parameters are getters that throw once draw.io has started.
      report.variants[variant] = JSON.parse(
        await drawio.evaluate(`(() => {
        const plain = (o) => Object.fromEntries(Object.keys(o).map((k) => {
          try { return [k, o[k]]; } catch (e) { return [k, "(throws: " + e.message + ")"]; }
        }));
        return JSON.stringify({
          urlParams: plain(w.urlParams),
          config: w.Editor.config,
          dark: w.Editor.isDarkMode(),
          theme: w.Editor.currentTheme,
          sketch: w.Editor.sketchMode,
          // Unset is draw.io asking, whichever of the two it is.
          resizeImages: w.mxSettings.getResizeImages() ?? "ask",
          body: w.document.body.className,
          // The page's size: draw.io writes where its view was scrolled, which follows it.
          size: [w.innerWidth, w.innerHeight],
          // The file's diagram, drawn: it reached draw.io, whichever copy.
          drawn: w.document.querySelectorAll(":is(path, rect, ellipse)",
            w.document.querySelector(".geDiagramContainer svg")).length,
          // The libraries' palettes, with how many shapes each drew.
          libraries: Object.fromEntries(${JSON.stringify(libraries)}.map((name) => {
            const title = [...w.document.querySelectorAll(".geSidebarContainer .geTitle")]
              .find((one) => one.textContent === name);
            return [name, title ? title.nextElementSibling.querySelectorAll(".geItem").length : "(no palette)"];
          })),
        }, (key, value) => (typeof value === "function" ? "(function)" : value));
      })()`),
      );
      if (online) drawio.close();
      page.close();
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      for (const key of Object.keys(settings)) {
        await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
      }
      await sleep(500);
    }
    if (only("plugins")) report.plugins = await plugins(folder, known).catch((error) => ({ error: error.message }));
    if (only("commands")) report.commands = await commands(folder, known).catch((error) => ({ error: error.stack }));
    if (only("codeLink")) report.codeLink = await codeLink(folder, known).catch((error) => ({ error: error.stack }));
    if (only("markdownPreview")) {
      report.markdownPreview = await markdownPreview(folder, known).catch((error) => ({ error: error.stack }));
    }
  } catch (error) {
    report.error = String(error.stack ?? error);
  } finally {
    writeFileSync(out, JSON.stringify(report, null, 2));
  }
  if (report.error) throw new Error(report.error);
};

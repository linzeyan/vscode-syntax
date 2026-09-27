// Runs inside each extension host of tools/marp-diff/run.js. It drives Marp
// every way a user does -- the preview, the directive checks and their fixes,
// hovers, completions, the highlighting of directive keys, the commands, the
// exports -- and writes what it saw as JSON for run.js to compare.
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { constants, inflateSync } = require("node:zlib");
const vscode = require("vscode");

const { connect } = require("../ext-diff/cdp");

const SIDE = process.env.POLY_MARP_SIDE;
const PORT = Number(process.env.POLY_MARP_PORT);
// With both installed poly stands down, so that side is driven through
// upstream's names and has to come out exactly as upstream alone does.
const { prefix: PREFIX, tool: TOOL } = SIDE === "ours"
  ? { prefix: "poly.marp", tool: "poly_export_marp" }
  : { prefix: "markdown.marp", tool: "export_marp" };
const command = (name) => `${PREFIX}.${name}`;

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
const where = (text) =>
  text?.replaceAll(vscode.Uri.file(folder()).toString(), "(workspace)").replaceAll(folder(), "(workspace)");
const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ids = async () => new Set((await targets()).map((one) => one.id));

/** A DevTools session on the first markdown preview that was not in `before`; expressions see its page as `w`. */
async function attachPreview(before) {
  const target = await until(
    "the preview's webview",
    async () =>
      (await targets()).find((one) =>
        !before.has(one.id) && one.url.toLowerCase().includes("extensionid=vscode.markdown-language-features")
      ),
  );
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
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      exceptions.push((details.exception?.description ?? details.text).split("\n")[0]);
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
  return {
    exceptions,
    async evaluate(expression) {
      const { result, exceptionDetails } = await send("Runtime.evaluate", {
        expression: `(async () => { const w = document.getElementById("active-frame")?.contentWindow;
          if (!w) return null; return (${expression}); })()`,
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

/** The slides as the preview drew them. */
const SLIDES = `(() => {
  const d = w.document;
  const root = d.getElementById("__marp-vscode");
  if (!root) return null;
  const sections = [...root.querySelectorAll("section")];
  const style = (one) => {
    const s = w.getComputedStyle(one);
    return { bg: s.backgroundColor, color: s.color, font: s.fontFamily, width: s.width, height: s.height };
  };
  return {
    body: d.body.classList.contains("marp-vscode"),
    slides: sections.length,
    svgs: root.querySelectorAll("svg[data-marpit-svg]").length,
    pagination: sections.map((one) => one.getAttribute("data-marpit-pagination")),
    classes: sections.map((one) => one.className),
    first: sections[0] ? style(sections[0]) : null,
    headings: [...root.querySelectorAll("h1, h2")].map((one) => one.textContent),
    katex: root.querySelectorAll(".katex").length,
    code: root.querySelectorAll("marp-pre").length,
    scaled: root.querySelectorAll("marp-auto-scaling").length,
    elements: ["marp-auto-scaling", "marp-pre", "marp-h1", "marp-h2"].map((one) => !!w.customElements.get(one)),
    stylesheets: [...d.querySelectorAll("link[rel=stylesheet][href]")].map((one) => one.getAttribute("href").split("/").pop()),
    silenced: d.querySelectorAll("style[data-marp-vscode-body]").length > 0,
    lines: [...root.querySelectorAll("[data-marp-vscode-slide-wrapper]")].map((one) => one.getAttribute("data-line")),
    // What the overflow check reports through; upstream borrows it from VSCode's preview.
    channel: !!(w.cspAlerter?._messaging?.postMessage || w.styleLoadingMonitor?._poster?.postMessage),
  };
})()`;

/** Bold and italic runs in the editor in front: how directive keys are marked. */
const MARKED = `(() => {
  const lines = document.querySelector(".editor-group-container.active .monaco-editor .view-lines");
  if (!lines) return null;
  const out = [];
  for (const span of lines.querySelectorAll(".view-line span span")) {
    const s = getComputedStyle(span);
    const bold = s.fontWeight === "700" || s.fontWeight === "bold";
    const italic = s.fontStyle === "italic";
    if (bold || italic) out.push({ text: span.textContent, bold, italic, color: s.color });
  }
  return out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
})()`;

const QUICK_INPUT = `(() => {
  const widget = document.querySelector(".quick-input-widget");
  return !!widget && widget.style.display !== "none";
})()`;
const QUICK_ROWS =
  `[...document.querySelectorAll(".quick-input-list .monaco-list-row")].map((one) => one.getAttribute("aria-label"))`;
const TOASTS = `[...document.querySelectorAll(".notifications-toasts .notification-list-item-message")]
  .map((one) => one.textContent)`;

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

const range = (r) => [r.start.line, r.start.character, r.end.line, r.end.character];
const text = (value) => (typeof value === "string" ? value : value?.value ?? null);

// Marp's alone: poly lints Markdown on its own account, deck or not.
const diagnosticsOf = (uri) =>
  vscode.languages.getDiagnostics(uri).filter((one) => one.source === "marp-vscode").map((one) => ({
    message: one.message,
    range: range(one.range),
    severity: one.severity,
    source: one.source ?? null,
    code: one.code ?? null,
    tags: one.tags ?? [],
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** Diagnostics once they have held still for three seconds, or whatever there is after `ms`. */
async function settledDiagnostics(uri, ms = 15_000) {
  const deadline = Date.now() + ms;
  let last;
  let since = Date.now();
  for (;;) {
    const now = JSON.stringify(diagnosticsOf(uri));
    if (now !== last) {
      last = now;
      since = Date.now();
    }
    if ((now !== "[]" && Date.now() - since >= 3000) || Date.now() > deadline) return JSON.parse(now);
    await sleep(250);
  }
}

async function open(name, column = vscode.ViewColumn.One) {
  return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file(name)), column);
}

async function render(name) {
  const html = await vscode.commands.executeCommand(
    "markdown.api.render",
    await vscode.workspace.openTextDocument(file(name)),
  );
  return where(html);
}

const at = (document, needle, offset = 0) => {
  const index = document.getText().indexOf(needle);
  if (index < 0) throw new Error(`no ${JSON.stringify(needle)} in ${document.fileName}`);
  return document.positionAt(index + offset);
};

async function completions(document, position) {
  const list = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", document.uri, position);
  return list.items.map((one) => ({
    label: typeof one.label === "string" ? one.label : one.label.label,
    kind: one.kind ?? null,
    detail: one.detail ?? null,
    documentation: text(one.documentation),
    insertText: text(one.insertText),
    sortText: one.sortText ?? null,
    command: one.command?.command ?? null,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function hovers(document, position) {
  const found = await vscode.commands.executeCommand("vscode.executeHoverProvider", document.uri, position);
  return found.map((one) => ({ contents: one.contents.map(text), range: one.range ? range(one.range) : null }));
}

async function fixes(uri) {
  const out = [];
  for (const diagnostic of vscode.languages.getDiagnostics(uri).filter((one) => one.source === "marp-vscode")) {
    const actions = await vscode.commands.executeCommand(
      "vscode.executeCodeActionProvider",
      uri,
      diagnostic.range,
      vscode.CodeActionKind.QuickFix.value,
    );
    for (const action of actions) {
      out.push({
        fixes: action.diagnostics?.map((one) => one.code) ?? null,
        for: diagnostic.code,
        title: action.title,
        kind: action.kind?.value ?? null,
        preferred: action.isPreferred ?? null,
        edits: (action.edit?.entries() ?? []).flatMap(([, edits]) =>
          edits.map((one) => ({ range: range(one.range), newText: one.newText }))
        ),
        command: action.command?.command ?? null,
      });
    }
  }
  return out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function symbols(list) {
  return (list ?? []).map((one) => ({
    name: one.name,
    kind: one.kind,
    range: one.range ? range(one.range) : range(one.location.range),
    children: symbols(one.children),
  }));
}

/** What an exported file holds, as far as it can be read without a parser. */
function exported(path) {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  const latin = bytes.toString("latin1");
  if (path.endsWith(".html")) return { bytes: bytes.length, sha: sha(where(bytes.toString("utf8"))) };
  if (path.endsWith(".txt")) return { text: bytes.toString("utf8") };
  if (path.endsWith(".png")) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (path.endsWith(".pdf")) {
    // Chrome and pdf-lib both pack the page tree into compressed streams.
    let plain = latin;
    for (const [, body] of latin.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
      try {
        plain += inflateSync(Buffer.from(body, "latin1"), { finishFlush: constants.Z_SYNC_FLUSH }).toString("latin1");
      } catch {
        // Not deflated: an image, or a font.
      }
    }
    return {
      header: latin.slice(0, 5),
      pages: (plain.match(/\/Type\s*\/Page(?!s)/g) ?? []).length,
      outlines: plain.includes("/Outlines"),
      notes: (plain.match(/\/Subtype\s*\/Text/g) ?? []).length,
    };
  }
  if (path.endsWith(".pptx")) return { slides: [...new Set(latin.match(/ppt\/slides\/slide\d+\.xml/g))].sort() };
  return { bytes: bytes.length };
}

async function exportWithTool(input, output) {
  rmSync(output, { force: true });
  const result = await vscode.lm.invokeTool(TOOL, {
    input: { inputFilePath: input, outputFilePath: output },
    toolInvocationToken: undefined,
  });
  const said = result.content.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : "")).join("");
  return { said: where(said), file: exported(output) };
}

module.exports.run = async function() {
  const report = { side: SIDE, seen: {}, errors: [] };
  const seen = report.seen;
  const desk = await connect(PORT);
  const config = () => vscode.workspace.getConfiguration();
  const target = vscode.ConfigurationTarget.Workspace;
  const set = async (key, value) => {
    await config().update(`${PREFIX}.${key}`, value, target);
    // Upstream drops its cached options when it hears of the change, which is
    // after `update` settles.
    await sleep(500);
  };
  const step = async (name, act) => {
    try {
      seen[name] = await act();
    } catch (error) {
      report.errors.push(`${SIDE} ${name}: ${error.message}`);
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  };
  try {
    // First, before any Markdown is open: poly has loaded nothing of Marp's
    // yet, and the command has to bring it in.
    await step("newFile", async () => {
      await vscode.commands.executeCommand(command("newMarpMarkdown"));
      const editor = await until("the new document", () => vscode.window.activeTextEditor);
      const found = {
        language: editor.document.languageId,
        untitled: editor.document.isUntitled,
        text: editor.document.getText(),
        cursor: [editor.selection.active.line, editor.selection.active.character],
      };
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      return found;
    });

    await step("render", async () => ({
      deck: await render("deck.md"),
      plain: (await render("plain.md")).includes("__marp-vscode"),
      notMarp: (await render("notmarp.md")).includes("__marp-vscode"),
    }));

    await step("diagnostics", async () => {
      const found = {};
      for (const name of ["diag.md", "deck.md", "notmarp.md"]) {
        await open(name);
        found[name] = await settledDiagnostics(file(name), name === "diag.md" ? 15_000 : 5000);
      }
      await open("diag.md");
      found.fixes = await fixes(file("diag.md"));
      return found;
    });

    await step("hover", async () => {
      const { document } = await open("deck.md");
      const found = {};
      for (
        const [name, needle, offset] of [
          ["theme", "theme:", 1],
          ["paginate", "paginate:", 1],
          ["math", "math:", 1],
          ["class", "_class:", 2],
          ["value", "gaia", 1],
          ["heading", "# Title", 3],
        ]
      ) {
        found[name] = await hovers(document, at(document, needle, offset));
      }
      return found;
    });

    await step("completion", async () => {
      const { document } = await open("complete.md");
      await sleep(1000);
      const found = {};
      for (
        const [name, needle, offset] of [
          ["theme", "theme: ", 7],
          ["paginate", "paginate: ", 10],
          ["math", "math: ", 6],
          ["size", "size: ", 6],
          ["transition", "transition: ", 12],
          ["frontMatter", "\n\n---", 1],
          ["comment", "<!--  -->", 5],
          ["body", "Body", 0],
        ]
      ) {
        found[name] = await completions(document, at(document, needle, offset));
      }
      return found;
    });

    await step("outline", async () => {
      const { document } = await open("deck.md");
      await sleep(1000);
      const folding = await vscode.commands.executeCommand("vscode.executeFoldingRangeProvider", document.uri);
      return {
        symbols: symbols(await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri)),
        folding: (folding ?? []).map((one) => [one.start, one.end, one.kind ?? null]),
      };
    });

    await step("marked", async () => {
      await open("deck.md");
      await sleep(1500);
      const deck = await desk.evaluate(MARKED);
      await open("notmarp.md");
      await sleep(1500);
      return { deck, notMarp: await desk.evaluate(MARKED) };
    });

    await step("toggle", async () => {
      const found = {};
      for (const name of ["toggle.md", "frontmatter.md"]) {
        const editor = await open(name);
        const texts = [];
        for (let i = 0; i < 3; i++) {
          await vscode.commands.executeCommand(command("toggleMarpFeature"));
          await sleep(300);
          texts.push(editor.document.getText());
        }
        found[name] = texts;
        await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      }
      return found;
    });

    await step("quickPick", async () => {
      await open("deck.md");
      const done = vscode.commands.executeCommand(command("showQuickPick"));
      await until("the quick pick", () => desk.evaluate(QUICK_INPUT));
      await sleep(500);
      const rows = await desk.evaluate(QUICK_ROWS);
      await key(desk, "Escape", 27);
      await done;
      return rows;
    });

    await step("preview", async () => {
      await open("deck.md");
      const before = await ids();
      await vscode.commands.executeCommand("markdown.showPreviewToSide");
      const page = await attachPreview(before);
      try {
        await until("the slides", () => page.evaluate("!!w.document.getElementById('__marp-vscode')"));
        await sleep(1500);
        // The scripts ran before the session could listen, so the page is
        // drawn once more with it listening: a preview setting redraws it
        // from scratch, scripts and all.
        await config().update("markdown.preview.fontSize", 15, target);
        await sleep(3000);
        await until("the slides again", () => page.evaluate("!!w.document.getElementById('__marp-vscode')"));
        await sleep(1500);
        return { slides: await page.evaluate(SLIDES), exceptions: page.exceptions };
      } finally {
        await config().update("markdown.preview.fontSize", undefined, target);
        page.close();
      }
    });

    await step("overflow", async () => {
      await set("diagnostics.slideContentOverflow", true);
      try {
        await open("overflow.md");
        await vscode.commands.executeCommand("markdown.showPreviewToSide");
        const reported = await until(
          "the overflow to be reported",
          () => diagnosticsOf(file("overflow.md")).find((one) => one.code === "slide-content-overflow") && true,
        ).catch(() => false);
        await sleep(1000);
        const found = { reported, diagnostics: diagnosticsOf(file("overflow.md")) };
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await sleep(1000);
        found.afterClose = diagnosticsOf(file("overflow.md")).filter((one) => one.code === "slide-content-overflow");
        return found;
      } finally {
        await set("diagnostics.slideContentOverflow", undefined);
      }
    });

    await step("themes", async () => {
      await set("themes", ["./themes/custom.css", "../outside.css"]);
      try {
        // The first parse only starts loading the theme, and asks the preview
        // to refresh once it is in.
        await render("custom.md");
        await sleep(2000);
        const html = await render("custom.md");
        const { document: custom } = await open("custom.md");
        const diagnostics = await settledDiagnostics(file("custom.md"), 5000);
        const sizes = (await completions(custom, at(custom, "size: ", 6))).map((one) => one.label);
        const { document } = await open("complete.md");
        await sleep(1000);
        return {
          applied: html.includes("#123456"),
          sha: sha(html),
          diagnostics,
          themes: (await completions(document, at(document, "theme: ", 7))).map((one) => [one.label, one.detail]),
          sizes,
        };
      } finally {
        await set("themes", undefined);
      }
    });

    await step("settings", async () => {
      const found = {};
      for (
        const [name, key, value] of [
          ["breaksOff", "breaks", "off"],
          ["breaksInherit", "breaks", "inherit"],
          ["htmlAll", "html", "all"],
          ["htmlOff", "html", "off"],
          ["mathjax", "mathTypesetting", "mathjax"],
          ["outlineOff", "outlineExtension", false],
        ]
      ) {
        await set(key, value);
        try {
          const html = await render("settings.md");
          found[name] = { sha: sha(html), length: html.length };
          if (name === "outlineOff") {
            const { document } = await open("deck.md");
            await sleep(1000);
            found[name].symbols = symbols(
              await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri),
            ).length;
          }
        } finally {
          await set(key, undefined);
        }
      }
      found.default = { sha: sha(await render("settings.md")) };
      await set("mathTypesetting", "off");
      try {
        await open("ignored.md");
        found.ignoredMath = await settledDiagnostics(file("ignored.md"), 8000);
        found.ignoredFixes = await fixes(file("ignored.md"));
      } finally {
        await set("mathTypesetting", undefined);
      }
      return found;
    });

    await step("export", async () => {
      const found = {};
      const input = join(folder(), "deck.md");
      for (const type of ["html", "pdf", "png", "pptx", "txt"]) {
        found[type] = await exportWithTool(input, join(folder(), "out", `deck.${type}`));
      }
      await set("pdf.outlines", "both");
      await set("pdf.noteAnnotations", true);
      try {
        found.pdfOutlines = await exportWithTool(input, join(folder(), "out", "outlined.pdf"));
      } finally {
        await set("pdf.outlines", undefined);
        await set("pdf.noteAnnotations", undefined);
      }
      // Edge is the one browser marp-cli knows that this machine lacks.
      await set("browser", "edge");
      try {
        found.noBrowser = await exportWithTool(input, join(folder(), "out", "missing.pdf"));
      } finally {
        await set("browser", undefined);
      }
      return found;
    });

    await step("exportCommand", async () => {
      await set("exportAutoOpen", false);
      try {
        await open("second.md");
        const output = join(folder(), "second.pdf");
        rmSync(output, { force: true });
        const done = vscode.commands.executeCommand(command("export"));
        await until("the save dialog", () => desk.evaluate(QUICK_INPUT));
        await sleep(1000);
        const offered = await desk.evaluate(`document.querySelector(".quick-input-box input")?.value ?? null`);
        await key(desk, "Enter", 13);
        await done;
        const toast = await until(
          "the export to finish",
          async () => (await desk.evaluate(TOASTS)).find((one) => one.includes("exported")),
          60_000,
        );
        return { offered: where(offered), toast: where(toast), file: exported(output) };
      } finally {
        await set("exportAutoOpen", undefined);
      }
    });
  } finally {
    desk.close();
  }
  writeFileSync(process.env.POLY_MARP_OUT, `${JSON.stringify(report, null, 2)}\n`);
};

// One side of the preview differential, inside a real extension host.
//
// Which side it is depends on what is installed: with
// bierner.markdown-preview-github-styles present poly must stand down and the
// wrapper and stylesheets are bierner's; without it they are poly's. run.js
// launches this twice and compares.
//
// Pages are built from `markdown.api.render` -- the preview's own markdown-it,
// with every extension's plugins -- and loaded into a webview with the preview's
// content security policy and the stylesheets each side contributes, because a
// webview panel cannot be pointed at the real preview's DOM.
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const vscode = require("vscode");

const { diagramCases, INFO_CASES, STYLE_DOC } = require("./cases.js");

const BIERNER = "bierner.markdown-preview-github-styles";
const POLY = "ricky.poly-lsp";
const GLOBAL = vscode.ConfigurationTarget.Global;

const PALETTES = [
  "light",
  "light_high_contrast",
  "light_colorblind",
  "light_tritanopia",
  "dark",
  "dark_high_contrast",
  "dark_colorblind",
  "dark_tritanopia",
  "dark_dimmed",
];

/** Every setting combination bierner offers, each rendered as its own section. */
const COMBOS = [
  { name: "auto", mode: "auto", light: "light", dark: "dark" },
  { name: "system", mode: "system", light: "light", dark: "dark" },
  { name: "auto-custom", mode: "auto", light: "light_high_contrast", dark: "dark_dimmed" },
  ...PALETTES.map((one) => ({ name: `light-${one}`, mode: "light", light: one, dark: "dark" })),
  ...PALETTES.map((one) => ({ name: `dark-${one}`, mode: "dark", light: "light", dark: one })),
];

const THEMES = (process.env.POLY_PREVIEW_THEMES ?? "Default Dark Modern").split(",");
const DIAGRAM_THEMES = THEMES.slice(0, 2);

async function render(markdown) {
  const document = await vscode.workspace.openTextDocument({ language: "markdown", content: markdown });
  return vscode.commands.executeCommand("markdown.api.render", document);
}

/**
 * Both extensions' settings to one combination. bierner's only where it is
 * installed: the editor refuses to write a setting nobody registered.
 */
async function applyStyle(combo, polyEnabled, bierner) {
  const config = vscode.workspace.getConfiguration();
  await config.update("poly.markdownGithubStyle.enabled", polyEnabled, GLOBAL);
  const values = { colorTheme: combo.mode, lightTheme: combo.light, darkTheme: combo.dark };
  for (const [key, value] of Object.entries(values)) {
    await config.update(`poly.markdownGithubStyle.${key}`, value, GLOBAL);
    if (bierner) {
      await config.update(`markdown-preview-github-styles.${key}`, value, GLOBAL);
    }
  }
}

/** The stylesheets an extension contributes to the preview, as webview URIs. */
function stylesOf(extension, webview) {
  return (extension.packageJSON.contributes["markdown.previewStyles"] ?? []).map((path) =>
    webview.asWebviewUri(vscode.Uri.file(join(extension.extensionPath, path))).toString()
  );
}

const MEASURE_STYLES = `
  const SELECTORS = [".github-markdown-body", ".github-markdown-content", "h1", "h2", "p", "a", "p code",
    "pre", "pre code", "blockquote", "th", "td", "tr:nth-child(2n) td", "hr", "li", "kbd", "table"];
  const PROPS = ["color", "background-color", "font-family", "font-size", "font-weight", "line-height",
    "padding-top", "padding-left", "padding-bottom", "margin-top", "margin-bottom", "border-top-color",
    "border-bottom-color", "border-left-color", "border-bottom-width", "border-left-width", "max-width",
    "width", "color-scheme"];
  const pick = (el) => {
    if (!el) return null;
    const style = getComputedStyle(el);
    return Object.fromEntries(PROPS.map((prop) => [prop, style.getPropertyValue(prop)]));
  };
  function measureStyles() {
    const sections = {};
    for (const section of document.querySelectorAll("section[data-case]")) {
      sections[section.dataset.case] = Object.fromEntries(
        SELECTORS.map((selector) => [selector, pick(section.querySelector(selector))]),
      );
    }
    return {
      sections,
      page: { html: pick(document.documentElement), body: pick(document.body) },
    };
  }
`;

const MEASURE_DIAGRAMS = `
  const clean = (text) => (text ?? "").replace(/\\s+/g, " ").trim();
  function shape(root) {
    const svg = root.querySelector("svg");
    const error = root.querySelector(".poly-diagram-message, .ref-error");
    if (!svg) return { svgs: 0, failed: Boolean(error), message: clean(error?.textContent) };
    const count = (selector) => svg.querySelectorAll(selector).length;
    const box = svg.getBoundingClientRect();
    return {
      svgs: root.querySelectorAll("svg").length,
      failed: Boolean(error),
      labels: [...new Set(
        Array.from(svg.querySelectorAll("text, tspan, foreignObject div, foreignObject span"), (el) => clean(el.textContent))
          .filter(Boolean),
      )].sort(),
      paths: count("path"),
      rects: count("rect"),
      texts: count("text"),
      groups: count("g"),
      foreign: count("foreignObject"),
      styles: count("style"),
      width: Math.round(box.width),
      height: Math.round(box.height),
      markup: svg.outerHTML,
    };
  }
  async function measureDiagrams() {
    const out = {};
    for (const section of document.querySelectorAll("section[data-case]")) {
      const ref = section.querySelector(".ref");
      const poly = section.querySelector(".poly");
      if (ref) {
        try {
          // A case that never settles fails alone rather than taking the page
          // down with it: the report then names it.
          ref.innerHTML = await Promise.race([
            window.reference(ref.dataset.kind, ref.dataset.source.trim()),
            new Promise((_, reject) => setTimeout(() => reject(new Error("reference timed out")), 20000)),
          ]);
        } catch (error) {
          ref.innerHTML = "";
          const note = document.createElement("div");
          note.className = "ref-error";
          note.textContent = String(error?.message ?? error);
          ref.append(note);
        }
      }
      out[section.dataset.case] = ref
        ? { reference: shape(ref) }
        : {
          poly: shape(poly),
          leftAsSource: poly.querySelectorAll("pre.poly-diagram:not(.poly-diagram-error)").length,
          // Not img: markmap puts markdown images in its nodes on purpose. What
          // must not survive is a way to run script.
          markup: poly.querySelectorAll(".poly-diagram script, .poly-diagram [onerror], .poly-diagram [onload]").length,
        };
    }
    return out;
  }
`;

/**
 * One webview page, measured and posted back.
 *
 * The policy is the markdown preview's own: scripts by nonce and nothing else.
 * That is the point for the diagrams -- the loader adds renderer scripts after
 * the page loads, and only a nonce it carried over lets them run.
 */
async function measurePage(title, { sections, styles, scripts, mode, roots, evaluates = false }) {
  const panel = vscode.window.createWebviewPanel("polyPreviewDiff", title, vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: roots.map((root) => vscode.Uri.file(root)),
    retainContextWhenHidden: true,
  });
  const nonce = "preview-diff-nonce";
  const source = panel.webview.cspSource;
  const csp = `default-src 'none'; img-src 'self' ${source} https: data:; media-src 'self' ${source} https: data:; `
    + `script-src 'nonce-${nonce}'${
      evaluates ? " 'unsafe-eval'" : ""
    }; style-src 'self' ${source} 'unsafe-inline' https: data:; `
    + `font-src 'self' ${source} https: data:;`;
  const links = styles(panel.webview).map((href) => `<link rel="stylesheet" href="${href}">`).join("\n");
  const tags = scripts(panel.webview)
    .map((src) => `<script async src="${src}" nonce="${nonce}" charset="UTF-8"></script>`)
    .join("\n");
  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
${links}
<script nonce="${nonce}">
  // First, before any renderer: the real preview answers a violation with
  // "Some content has been disabled in this document".
  const violations = [];
  document.addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective + " " + e.blockedURI));
</script>
</head>
<body class="vscode-body scrollBeyondLastLine wordWrap showEditorSelection">
${sections}
${tags}
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason?.message ?? e.reason)));
  ${mode === "styles" ? MEASURE_STYLES : MEASURE_DIAGRAMS}
  // Done when no block is left waiting to be drawn, and the page has then
  // stayed put for a second. "Stopped changing" alone is not enough: fetching
  // an 800 KB renderer changes nothing on the page for seconds at a time.
  const waiting = () => Array.from(document.querySelectorAll("pre.poly-diagram:not(.poly-diagram-error)"))
    .filter((el) => (el.textContent ?? "").trim() !== "").length;
  const started = Date.now();
  let settled = 0;
  let last = "";
  const timer = setInterval(async () => {
    const now = document.querySelectorAll("svg").length + ":" + waiting();
    settled = now === last && waiting() === 0 ? settled + 1 : 0;
    last = now;
    if (settled < 4 && Date.now() - started < 120000) return;
    clearInterval(timer);
    let result = null;
    try {
      result = ${mode === "styles" ? "measureStyles()" : "await measureDiagrams()"};
    } catch (error) {
      errors.push("measuring: " + String(error?.message ?? error));
    }
    // The page as drawn, theme variables included (the editor sets them as
    // inline style on the root), for run.js to turn into a screenshot: a
    // webview cannot be captured from here, and the OS will not capture it
    // without a permission this process may not have.
    const snapshot = document.documentElement.outerHTML;
    // Whether this webview was painting at all. A covered window gets no
    // animation frames, and markmap waits for one: without this a timeout
    // there reads as poly's defect rather than as the window's position.
    const frames = await Promise.race([
      new Promise((done) => requestAnimationFrame(() => done(true))),
      new Promise((done) => setTimeout(() => done(false), 2000)),
    ]);
    api.postMessage({ result, errors, violations, bodyClass: document.body.className, xss: window.__xss ?? null, snapshot, frames });
  }, 250);
</script>
</body>
</html>`;
  const measured = await new Promise((resolve) => {
    panel.webview.onDidReceiveMessage(resolve);
    setTimeout(() => resolve({ timedOut: true }), 180000);
  });
  panel.dispose();
  return measured;
}

async function setTheme(theme) {
  await vscode.workspace.getConfiguration("workbench").update("colorTheme", theme, GLOBAL);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

const escapeAttr = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

exports.run = async function run() {
  const bierner = vscode.extensions.getExtension(BIERNER);
  const poly = vscode.extensions.getExtension(POLY);
  const builtIn = vscode.extensions.getExtension("vscode.markdown-language-features");
  await poly.activate();
  await bierner?.activate();
  const side = bierner ? "bierner" : "poly";
  const owner = bierner ?? poly;
  // The preview's own stylesheet under both sides, since that is what the
  // GitHub one is layered over in a real preview.
  const builtInStyles = (webview) =>
    ["markdown.css", "highlight.css"].map((name) =>
      webview.asWebviewUri(vscode.Uri.file(join(builtIn.extensionPath, "media", name))).toString()
    );
  const roots = [poly.extensionPath, builtIn.extensionPath, process.env.POLY_PREVIEW_SCRATCH];
  if (bierner) roots.push(bierner.extensionPath);

  const report = {
    side,
    vscode: vscode.version,
    styles: {},
    wrappers: {},
    inert: {},
    diagrams: {},
    references: {},
    info: {},
  };

  // Rendered once per combination, outside the theme loop: the wrapper does
  // not depend on the editor's colours, only the stylesheets' answer does.
  const rendered = [];
  for (const combo of COMBOS) {
    await applyStyle(combo, true, bierner);
    const html = await render(STYLE_DOC);
    report.wrappers[combo.name] = (html.match(/class="github-markdown-body"/g) ?? []).length;
    rendered.push(`<section data-case="${combo.name}">\n${html}\n</section>`);
  }
  await applyStyle(COMBOS[0], false, bierner);
  const plain = `<section data-case="off">\n${await render(STYLE_DOC)}\n</section>`;

  for (const theme of process.env.POLY_PREVIEW_ONLY === "diagrams" ? [] : THEMES) {
    await setTheme(theme);
    report.styles[theme] = await measurePage(`styles ${side}`, {
      sections: rendered.join("\n"),
      styles: (webview) => [...builtInStyles(webview), ...stylesOf(owner, webview)],
      scripts: () => [],
      mode: "styles",
      roots,
    });
    if (side === "poly") {
      // The setting off, with and without poly's stylesheets on the page: they
      // are contributed unconditionally, so off has to mean they change
      // nothing -- including on the page around the document.
      const withPoly = await measurePage("inert with", {
        sections: plain,
        styles: (webview) => [...builtInStyles(webview), ...stylesOf(poly, webview)],
        scripts: () => [],
        mode: "styles",
        roots,
      });
      const without = await measurePage("inert without", {
        sections: plain,
        styles: builtInStyles,
        scripts: () => [],
        mode: "styles",
        roots,
      });
      report.inert[theme] = { withPoly, without };
    }
  }

  if (side === "poly") {
    await vscode.workspace.getConfiguration().update("poly.markdownDiagrams.enabled", true, GLOBAL);
    for (const one of INFO_CASES) {
      const html = await render(one.markdown);
      report.info[one.name] = { claimed: one.claimed, emitted: html.includes("poly-diagram") };
    }
    const polySections = [];
    const refSections = [];
    for (const one of diagramCases()) {
      const html = await render(one.markdown);
      polySections.push(`<section data-case="${one.name}"><div class="poly">${html}</div></section>`);
      refSections.push(
        `<section data-case="${one.name}"><div class="ref" data-kind="${one.kind}" `
          + `data-source="${escapeAttr(one.source)}"></div></section>`,
      );
    }
    const script = (webview, ...path) => webview.asWebviewUri(vscode.Uri.file(join(...path))).toString();
    for (const theme of DIAGRAM_THEMES) {
      await setTheme(theme);
      report.diagrams[theme] = await measurePage("diagrams", {
        sections: polySections.join("\n"),
        styles: (webview) => [...builtInStyles(webview), ...stylesOf(poly, webview)],
        scripts: (webview) => [script(webview, poly.extensionPath, "dist", "diagrams.js")],
        mode: "diagrams",
        roots,
      });
      // MarkNote runs where eval is allowed, and vega's expression compiler
      // needs it; the reference gets its own page so poly's keeps the
      // preview's policy.
      report.references[theme] = await measurePage("reference", {
        sections: refSections.join("\n"),
        styles: builtInStyles,
        scripts: (webview) => [script(webview, process.env.POLY_PREVIEW_SCRATCH, "reference.js")],
        mode: "diagrams",
        roots,
        evaluates: true,
      });
    }
  }

  writeFileSync(process.env.POLY_PREVIEW_OUT, `${JSON.stringify(report, null, 2)}\n`);
};

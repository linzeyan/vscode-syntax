// One side of the markdown export differential, inside a real extension host.
//
// Which side it is comes from POLY_MDPDF_SIDE: yzane's commands and settings
// on one, poly's on the other, over the same workspace. run.js launches this
// twice and compares what each wrote.
const { existsSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const vscode = require("vscode");

const SIDE = process.env.POLY_MDPDF_SIDE;
const PREFIX = SIDE === "yzane" ? "markdown-pdf" : "poly.markdownPdf";
const COMMAND = SIDE === "yzane"
  ? (type) => `extension.markdown-pdf.${type}`
  : (type) => `poly.markdownExport${type === "settings" ? "" : type[0].toUpperCase() + type.slice(1)}`;
const UPSTREAM = JSON.parse(process.env.POLY_MDPDF_UPSTREAM);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Every setting that shows in what is written, away from its default. */
const CHANGED = {
  type: ["html", "pdf", "png", "jpeg"],
  outputDirectory: "out",
  outputDirectoryRelativePathFile: true,
  sanitize: "gfm-allow-style",
  styles: ["extra.css"],
  stylesRelativePathFile: true,
  highlightStyle: "github.css",
  breaks: true,
  emoji: false,
  executablePath: CHROME,
  scale: 0.8,
  headerTemplate: "<div style=\"font-size: 8px; margin-left: 1cm;\"><span class='title'></span></div>",
  footerTemplate: "<div style=\"font-size: 8px; margin: 0 auto;\"><span class='pageNumber'></span></div>",
  printBackground: false,
  orientation: "landscape",
  pageRanges: "1",
  format: "A5",
  "margin.top": "2cm",
  "margin.bottom": "2cm",
  "margin.right": "1.5cm",
  "margin.left": "1.5cm",
  quality: 60,
  "clip.x": 10,
  "clip.y": 20,
  "clip.width": 300,
  "clip.height": 200,
  omitBackground: true,
  plantumlOpenMarker: "@begin",
  plantumlCloseMarker: "@end",
  "markdown-it-include.enable": false,
  "math.katex.macros": { "\\RR": "\\mathbb{R}" },
};

/** And the ones CHANGED leaves at their defaults, or that it sets and hides. */
const CHANGED_AGAIN = {
  type: ["html", "pdf"],
  outputDirectory: "out3",
  outputDirectoryRelativePathFile: false,
  sanitize: "none",
  includeDefaultStyles: false,
  highlight: false,
  displayHeaderFooter: false,
  width: "15cm",
  height: "20cm",
  "math.enabled": false,
};

const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const uriOf = (file) => vscode.Uri.file(join(root(), file));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every file in the workspace with its size, as one string to compare. */
function snapshot() {
  const rows = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else rows.push(`${full}:${stat.size}`);
    }
  };
  if (existsSync(root())) walk(root());
  return rows.sort().join("\n");
}

/**
 * Until the workspace has been quiet for `quiet` ms, or `idle` ms have passed
 * with no change at all -- a skipped file writes nothing, and that is an
 * answer too.
 */
async function settled(before, quiet, idle) {
  const started = Date.now();
  let last = before;
  let since = Date.now();
  for (;;) {
    const now = snapshot();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (now !== before ? Date.now() - since > quiet : Date.now() - started > idle) {
      return;
    }
    await sleep(250);
  }
}

async function show(file) {
  return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uriOf(file)));
}

/**
 * Both sides' commands resolve once PDF, PNG and JPEG are written; upstream's
 * HTML write is the one it does not wait for, hence the short settle after.
 */
async function exportFile(type, file) {
  await show(file);
  const before = snapshot();
  try {
    await vscode.commands.executeCommand(COMMAND(type));
  } catch (error) {
    console.error(`${COMMAND(type)} on ${file}: ${error}`);
  }
  await settled(before, 1500, 1500);
}

/**
 * A settings write saves settings.json, and upstream exports whichever
 * markdown editor is in front on any save at all. A stylesheet in front keeps
 * that from exporting a fixture with half the settings written.
 */
async function configure(settings) {
  await show("poly/extra.css");
  const config = vscode.workspace.getConfiguration();
  for (const [key, value] of Object.entries(settings)) {
    await config.update(`${PREFIX}.${key}`, value, vscode.ConfigurationTarget.Workspace);
  }
}

/** Nothing is awaited on a save, so the disk is the only signal. */
async function editAndSave(file) {
  const editor = await show(file);
  await editor.edit((edit) => edit.insert(new vscode.Position(1, 0), "\nSaved.\n"));
  const before = snapshot();
  await editor.document.save();
  await settled(before, 5000, 20_000);
}

const today = () => new Date().toISOString().slice(0, 10);

module.exports.run = async function() {
  // The default header prints %%ISO-DATE%%, a UTC date: run.js checks that
  // both sides ran on the same one.
  const report = { side: SIDE, dates: [today()] };
  await vscode.extensions.getExtension("yzane.markdown-pdf")?.activate();
  report.active = vscode.extensions.getExtension("yzane.markdown-pdf")?.isActive ?? false;

  for (const name of UPSTREAM) {
    await exportFile("all", `fixtures/${name}.md`);
  }
  await exportFile("html", "poly/shortcuts.md");
  await exportFile("html", "poly/nested.md.d/inner.md");

  await configure(CHANGED);
  for (
    const file of [
      "poly/kitchen.md",
      "fixtures/math.md",
      "fixtures/syntax-highlighting.md",
      "fixtures/emoji.md",
      "poly/nested.md.d/inner.md",
    ]
  ) {
    await exportFile("settings", file);
  }
  await editAndSave("poly/save-me.md");
  await editAndSave("poly/skip-me.md");

  await configure(CHANGED_AGAIN);
  await exportFile("settings", "poly/kitchen.md");

  report.dates.push(today());
  writeFileSync(process.env.POLY_MDPDF_OUT, `${JSON.stringify(report, null, 2)}\n`);
};

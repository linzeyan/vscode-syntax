// One side of the PlantUML differential, inside a real extension host.
//
// Which side it is comes from POLY_PLANTUML_SIDE: jebbs's commands and
// settings on one, poly's on the other, against identical workspaces. run.js
// launches this twice and compares what each wrote and answered.
const { existsSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const vscode = require("vscode");
const { update } = require("../ext-diff/settings");

const SIDE = process.env.POLY_PLANTUML_SIDE;
const PREFIX = SIDE === "jebbs" ? "plantuml" : "poly.plantuml";
const COMMANDS = SIDE === "jebbs"
  ? { document: "plantuml.exportDocument", current: "plantuml.exportCurrent", workspace: "plantuml.exportWorkspace" }
  : {
    document: "poly.plantumlExportDocument",
    current: "poly.plantumlExportCurrent",
    workspace: "poly.plantumlExportWorkspace",
  };
const PROBES = JSON.parse(process.env.POLY_PLANTUML_PROBES);
const DIAGRAMS = [
  "diagrams/seq.puml",
  "diagrams/multi.puml",
  "diagrams/sub/bare.puml",
  "diagrams/inc.puml",
  "diagrams/salt.puml",
  "diagrams/broken.puml",
];

const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const uriOf = (file) => vscode.Uri.file(join(root(), file));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Workspace-wide, except the settings both extensions scope to the application. */
async function setting(key, value) {
  const target = key === "urlFormat" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
  await update(vscode, `${PREFIX}.${key}`, value, target);
}

async function show(file, line = 0) {
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uriOf(file)));
  editor.selection = new vscode.Selection(line, 0, line, 0);
  return editor;
}

/** Every file under `dir` with its size, as one string to compare. */
function snapshot(dir) {
  const rows = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else rows.push(`${full}:${stat.size}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return rows.sort().join("\n");
}

/**
 * Until `dir` has stopped changing: three quiet seconds after a change, or
 * twenty with none at all -- an export that writes nothing is an answer too,
 * and the file comparison is where it shows. Neither side's command resolves
 * when its files are written (jebbs's returns at once, poly's when its report
 * message is dismissed), so the disk is the only signal both give.
 */
async function settled(dir, before) {
  const started = Date.now();
  let last = before;
  let since = Date.now();
  for (;;) {
    const now = snapshot(dir);
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (now !== before ? Date.now() - since > 3000 : Date.now() - started > 20_000) {
      return;
    }
    await sleep(250);
  }
}

/**
 * One command against one file, finished before the next starts. jebbs shows
 * its output channel when an export fails, which takes focus: a second
 * command started meanwhile would find that channel as the active editor.
 */
async function runOn(command, file, line, dir) {
  await show(file, line);
  const before = snapshot(dir);
  // Not awaited, for the reason above; a rejection is still reported.
  vscode.commands.executeCommand(command).then(undefined, (error) => console.error(`${command}: ${error}`));
  await settled(dir, before);
}

const range = (r) => [r.start.line, r.start.character, r.end.line, r.end.character];

module.exports.run = async function() {
  const report = { side: SIDE };

  // jebbs lints on open, and the document that activates it opens before its
  // listener exists: that file would go unlinted. Wake it first, so what is
  // compared is its steady state.
  await vscode.extensions.getExtension("jebbs.plantuml")?.activate();
  await show("diagrams/seq.puml");
  await sleep(3000);
  report.jebbsActive = vscode.extensions.getExtension("jebbs.plantuml")?.isActive ?? false;

  report.symbols = {};
  for (const file of [...DIAGRAMS, "code.java", "notes.md"]) {
    const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uriOf(file)) ?? [];
    // Markdown's own headings come from the built-in on both sides.
    report.symbols[file] = symbols
      .filter((one) => one.kind === vscode.SymbolKind.Object)
      .map((one) => [one.name, ...range(one.location?.range ?? one.range)]);
  }

  for (const file of DIAGRAMS) {
    await vscode.workspace.openTextDocument(uriOf(file));
  }
  await sleep(2000);
  report.diagnostics = {};
  for (const file of DIAGRAMS) {
    report.diagnostics[file] = vscode.languages
      .getDiagnostics(uriOf(file))
      .map((one) => [...range(one.range), one.severity, one.message]);
  }

  const [completionFile, cLine, cChar] = PROBES.completion;
  const list = await vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider",
    uriOf(completionFile),
    new vscode.Position(cLine, cChar),
  );
  report.completion = list.items
    .map((item) => [
      typeof item.label === "string" ? item.label : item.label.label,
      item.kind,
      typeof item.insertText === "string" ? item.insertText : item.insertText?.value,
      // VSCode ends a snippet's detail with the name of the extension that
      // ships it, which is the one thing the two sides must differ in.
      item.kind === vscode.CompletionItemKind.Snippet
        ? item.detail?.replace(/ \((PlantUML|Poly Syntax Highlight)\)$/, "")
        : item.detail,
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const [signatureFile, sLine, sChar] = PROBES.signature;
  const help = await vscode.commands.executeCommand(
    "vscode.executeSignatureHelpProvider",
    uriOf(signatureFile),
    new vscode.Position(sLine, sChar),
    ",",
  );
  report.signature = help && {
    signatures: help.signatures.map((one) => [one.label, one.parameters.map((param) => param.label)]),
    activeSignature: help.activeSignature,
    activeParameter: help.activeParameter,
  };

  // A server that is never contacted: the fences only become URLs.
  await setting("server", "http://127.0.0.1:9/plantuml");
  const markdown = await vscode.workspace.openTextDocument(uriOf("notes.md"));
  report.markdown = await vscode.commands.executeCommand("markdown.api.render", markdown);
  await setting("server", undefined);

  const out = join(root(), "out");
  for (const file of DIAGRAMS) {
    await runOn(COMMANDS.document, file, 0, out);
  }
  // The second diagram of seq.puml, as a PNG.
  await setting("exportFormat", "png");
  await runOn(COMMANDS.current, "diagrams/seq.puml", 12, out);

  await setting("exportFormat", "svg");
  await setting("exportOutDir", "out-ws");
  await setting("exportMapFile", false);
  await runOn(COMMANDS.workspace, "diagrams/seq.puml", 0, join(root(), "out-ws"));

  // URLs go to the report channel, which run.js reads from the logs.
  await setting("server", "http://127.0.0.1:9/plantuml");
  await setting("urlFormat", "svg");
  const urls = SIDE === "jebbs"
    ? { document: "plantuml.URLDocument", current: "plantuml.URLCurrent" }
    : { document: "poly.plantumlUrlDocument", current: "poly.plantumlUrlCurrent" };
  for (
    const [command, file, line] of [[urls.document, "diagrams/multi.puml", 0], [urls.current, "diagrams/inc.puml", 2]]
  ) {
    await show(file, line);
    await vscode.commands.executeCommand(command);
    await sleep(500);
  }

  writeFileSync(process.env.POLY_PLANTUML_OUT, `${JSON.stringify(report, null, 2)}\n`);
};

// One side of the Excalidraw differential, inside a real extension host.
//
// Which side it is comes from POLY_EXCALIDRAW_SIDE: pomdtr's editor on one,
// poly's on the other, against identical workspaces. run.js launches this
// twice and compares what each saved.
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const vscode = require("vscode");

const SIDE = process.env.POLY_EXCALIDRAW_SIDE;
const VIEW_TYPE = SIDE === "pomdtr" ? "editor.excalidraw" : "poly.excalidraw";
const SHOW_IMAGE = SIDE === "pomdtr" ? "excalidraw.showImage" : "poly.excalidrawShowImage";

const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const uriOf = (file) => vscode.Uri.file(join(root(), file));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;

/** Until `probe` answers, or undefined after `ms`. */
async function until(probe, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await sleep(100);
  }
  return undefined;
}

/**
 * Opens `file` in this side's editor and saves whatever the page changed.
 * pomdtr's save resolves before its write lands, so the disk is what is
 * waited on: changed, then quiet for a second.
 */
async function openAndSave(file) {
  const before = readFileSync(uriOf(file).fsPath);
  await vscode.commands.executeCommand("vscode.openWith", uriOf(file), VIEW_TYPE);
  const dirty = await until(() => activeTab()?.isDirty || undefined, 20_000);
  if (dirty) await vscode.commands.executeCommand("workbench.action.files.save");
  let last = before;
  let since = Date.now();
  await until(() => {
    const now = readFileSync(uriOf(file).fsPath);
    if (!now.equals(last)) {
      last = now;
      since = Date.now();
    }
    return !now.equals(before) && Date.now() - since > 1000 ? true : undefined;
  }, dirty ? 20_000 : 0);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  return { dirty: dirty ?? false, bytes: last.toString("base64") };
}

module.exports.run = async function() {
  const report = { side: SIDE, saved: {} };
  for (const file of ["empty.excalidraw", "scene.excalidraw.svg", "scene.excalidraw.png"]) {
    report.saved[file] = await openAndSave(file);
  }
  // A scene exactly as Excalidraw saves it: opening it must not dirty it.
  await vscode.commands.executeCommand("vscode.openWith", uriOf("clean.excalidraw"), VIEW_TYPE);
  await sleep(4000);
  report.cleanStaysClean = !activeTab()?.isDirty;
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");

  // The title bar's button on a PNG scene opens the picture itself.
  await vscode.commands.executeCommand("vscode.openWith", uriOf("scene.excalidraw.png"), VIEW_TYPE);
  await sleep(2000);
  await vscode.commands.executeCommand(SHOW_IMAGE, uriOf("scene.excalidraw.png"));
  report.showImage = await until(() => {
    const input = activeTab()?.input;
    return input instanceof vscode.TabInputCustom && input.viewType !== VIEW_TYPE ? input.viewType : undefined;
  }, 10_000);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");

  // Only pomdtr's side has both editors installed: which one does a plain
  // open pick when two claim the file as their default?
  if (SIDE === "pomdtr") {
    await vscode.commands.executeCommand("vscode.open", uriOf("both.excalidraw"));
    report.bothInstalled = await until(() => {
      const input = activeTab()?.input;
      return input instanceof vscode.TabInputCustom ? input.viewType : undefined;
    }, 10_000) ?? `not a custom editor: ${activeTab()?.label}`;
  }

  writeFileSync(process.env.POLY_EXCALIDRAW_OUT, `${JSON.stringify(report, null, 2)}\n`);
};

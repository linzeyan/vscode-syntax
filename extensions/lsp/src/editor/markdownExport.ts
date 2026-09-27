/**
 * yzane.markdown-pdf's commands and its convert-on-save.
 *
 * The converting lives in markdownPdf.ts, which is bundled on its own
 * (`dist/markdownPdf.js`) and loaded on the first export. puppeteer, KaTeX and
 * highlight.js add up to megabytes, and nobody who never exports should have
 * to load them.
 */
import * as path from "path";
import * as vscode from "vscode";

/**
 * The extension this stands in for. When it is installed, its six entries are
 * already in the editor's context menu, and six more with the same names would
 * only make the menu longer.
 */
const YZANE = "yzane.markdown-pdf";

const EXPORTS: [command: string, type: string][] = [
  ["poly.markdownExport", "settings"],
  ["poly.markdownExportPdf", "pdf"],
  ["poly.markdownExportHtml", "html"],
  ["poly.markdownExportPng", "png"],
  ["poly.markdownExportJpeg", "jpeg"],
  ["poly.markdownExportAll", "all"],
];

export function registerMarkdownExport(
  context: vscode.ExtensionContext,
  isMarkdown: (languageId: string) => boolean,
) {
  const converter = (): typeof import("./markdownPdf") => require(path.join(__dirname, "markdownPdf.js"));
  const standDown = () =>
    void vscode.commands.executeCommand(
      "setContext",
      "poly.yield.markdownExport",
      vscode.extensions.getExtension(YZANE) !== undefined,
    );
  standDown();
  context.subscriptions.push(
    vscode.extensions.onDidChange(standDown),
    ...EXPORTS.map(([command, type]) =>
      vscode.commands.registerCommand(
        command,
        () => converter().exportMarkdown(context, type, vscode.window.activeTextEditor?.document, isMarkdown),
      )
    ),
    vscode.commands.registerCommand("poly.markdownExportDiagnostics", () => converter().outputDiagnostics(context)),
    // The setting is read on every save, not at activation, so turning it on
    // takes effect without the restart that upstream asks for.
    vscode.workspace.onDidSaveTextDocument((document) => {
      const convertOnSave = vscode.workspace.getConfiguration("poly.markdownPdf", document.uri).get("convertOnSave");
      if (convertOnSave && isMarkdown(document.languageId)) {
        void converter().exportMarkdown(context, "settings", document, isMarkdown, true);
      }
    }),
  );
}

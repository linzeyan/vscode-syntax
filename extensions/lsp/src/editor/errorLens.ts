import * as path from "path";
import * as vscode from "vscode";

/**
 * usernamehw.errorlens, vendored in ./errorLens and bundled to dist/errorLens:
 * each problem's message at the end of its line, the line tinted by severity,
 * and the gutter icons, status bar items, hovers and code lenses around them,
 * behind `poly.errorLens.enabled`. Installed, the original is the one that
 * runs: two copies would write every message twice on the same line.
 */
const ORIGINAL = "usernamehw.errorlens";

/** Upstream's own entry point, with poly's one addition (see ./errorLens/README.md). */
interface ErrorLens {
  activate(context: vscode.ExtensionContext, standAside: () => boolean): () => void;
}

/** Sets Error Lens up to load once it is switched on or one of its commands is run. */
export function registerErrorLens(context: vscode.ExtensionContext): void {
  // `getExtension` sees only enabled extensions, so the original installed but
  // disabled leaves this one running, which is the point of disabling it.
  const yielded = () => vscode.extensions.getExtension(ORIGINAL) !== undefined;
  const enabled = () => vscode.workspace.getConfiguration("poly.errorLens").get<boolean>("enabled", false);

  // Off, nothing of it loads: poly is activated at startup, and the bundle is
  // only worth its load time to someone who uses it. Its commands still work
  // while it is off, as upstream's do, so each has a stand-in that loads the
  // real one and hands over -- the list is the manifest's, so it cannot drift.
  let refresh: (() => void) | undefined;
  const declared: { command: string }[] = context.extension.packageJSON.contributes.commands;
  const standIns = declared
    .filter(({ command }) => command.startsWith("poly.errorLens."))
    .map(({ command }) =>
      vscode.commands.registerCommand(command, (...args: unknown[]) => {
        if (yielded()) {
          return undefined;
        }
        load();
        return vscode.commands.executeCommand(command, ...args);
      })
    );
  const load = () => {
    if (!refresh) {
      standIns.forEach((standIn) => standIn.dispose());
      refresh = (require(path.join(__dirname, "errorLens", "extension.js")) as ErrorLens).activate(context, yielded);
    }
  };
  // Once loaded, upstream follows its own settings; what it cannot see is the
  // original coming and going, and its refresh asks `yielded` again.
  const update = () => {
    void vscode.commands.executeCommand("setContext", "poly.yield.errorLens", yielded());
    if (refresh) {
      refresh();
    } else if (enabled() && !yielded()) {
      load();
    }
  };
  update();
  context.subscriptions.push(
    ...standIns,
    vscode.extensions.onDidChange(update),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!refresh && event.affectsConfiguration("poly.errorLens.enabled")) {
        update();
      }
    }),
  );
}

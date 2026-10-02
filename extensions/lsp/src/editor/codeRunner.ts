/**
 * formulahendry.code-runner, behind `poly.codeRunner.enabled`: Run Code, Run
 * Custom Command, Run By Language and Stop Code Run, with its keys, menus and
 * settings under poly's names. The engine is ./codeRunner, vendored.
 *
 * The engine is registered whether or not the switch is on, because the run
 * lens runs through it too: the switch is for these commands, their menus and
 * their keys, and `poly.runCodeLens.enabled` is the lens's. Stop is not behind
 * either -- a run the lens started with no way to end it would be a process
 * left running until the window closed.
 *
 * While Code Runner itself is installed and enabled, these stand aside, so one
 * key or one ▶ does not run the file twice.
 */
import * as vscode from "vscode";

import { CodeManager } from "./codeRunner/codeManager";

const ORIGINAL = "formulahendry.code-runner";

export function registerCodeRunner(context: vscode.ExtensionContext): CodeManager {
  const manager = new CodeManager();
  const yielding = () => vscode.extensions.getExtension(ORIGINAL) !== undefined;
  const standDown = () => void vscode.commands.executeCommand("setContext", "poly.yield.codeRunner", yielding());
  standDown();

  // The manifest's `when` clauses already keep these out of the palette, the
  // menus and the keys. This is for a key bound to one in keybindings.json,
  // which no `when` of poly's reaches.
  const gated = <A extends unknown[]>(run: (...args: A) => unknown) => (...args: A) => {
    if (yielding()) {
      vscode.window.showInformationMessage(`Poly: ${ORIGINAL} is installed, so poly's Code Runner stands aside`);
      return;
    }
    if (!vscode.workspace.getConfiguration("poly.codeRunner").get<boolean>("enabled", false)) {
      vscode.window.showInformationMessage("Poly: Code Runner is off; turn on poly.codeRunner.enabled to use it");
      return;
    }
    return run(...args);
  };

  context.subscriptions.push(
    manager,
    vscode.window.onDidCloseTerminal((terminal) => manager.onDidCloseTerminal(terminal)),
    vscode.commands.registerCommand(
      "poly.codeRunner.run",
      gated((fileUri?: vscode.Uri) => manager.run(null, fileUri)),
    ),
    vscode.commands.registerCommand("poly.codeRunner.runCustomCommand", gated(() => manager.runCustomCommand())),
    vscode.commands.registerCommand("poly.codeRunner.runByLanguage", gated(() => manager.runByLanguage())),
    vscode.commands.registerCommand("poly.codeRunner.stop", () => manager.stop()),
    vscode.extensions.onDidChange(standDown),
  );
  return manager;
}

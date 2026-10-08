/**
 * huacnlee.autocorrect, behind `poly.autocorrect.enabled`: findings as you
 * open and type, a quick fix on each, the whole file corrected on a manual
 * save, a command to do that by hand, and `.autocorrectrc` /
 * `.autocorrectignore` read the way it read them.
 *
 * Where it departs, it is because the extension's behaviour was a defect:
 * - Each folder of a multi-root workspace gets its own configuration, and an
 *   edit to `.autocorrectrc` takes effect whole. The engine can only merge a
 *   configuration in, so the extension kept every rule any folder had ever
 *   loaded until the window was reloaded.
 * - Ranges are in the editor's units (see `corrections`), so a quick fix on a
 *   line with an emoji in it no longer overwrites the wrong text.
 * - Fix on save edits the document being saved, through `waitUntil`. The
 *   extension edited whichever editor was active and then saved again.
 * - Typing in one file no longer cancels the pending lint of another.
 * - Files open before the window finished starting are linted too.
 *
 * The two status bar switches cover it: Toggle Linting is `poly.lintOnSave`
 * and Toggle Formatting is `poly.format.enabled`, which it reads, as the
 * switches already wrote the extension's own keys. While the extension itself
 * is installed this stands aside, so nothing is reported or fixed twice.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { affects } from "../settings";
import { corrections, lineEdits } from "./autocorrect";

import ignore = require("ignore");

type Engine = typeof import("./autocorrectEngine");

const ORIGINAL = "huacnlee.autocorrect";
const SOURCES = new Set(["AutoCorrect", "Spellcheck"]);
/** What the configuration of one folder is read from. */
const CONFIG_FILES = [".autocorrectrc", ".autocorrectignore", ".gitignore"];

/** One folder's engine and ignore list, and the file times they were made from. */
interface Folder {
  stamp: string;
  engine: Engine;
  ignores(file: string): boolean;
}

/**
 * An engine that has never been given a configuration.
 *
 * Evaluating the bundle again is what makes one: the wasm glue holds its
 * instance in module state, so a second instance needs a second copy of the
 * module, and the require cache is the only thing standing in the way.
 */
function freshEngine(): Engine {
  const bundle = path.join(__dirname, "autocorrect.js");
  delete require.cache[bundle];
  return require(bundle) as Engine;
}

export function registerAutocorrect(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("AutoCorrect");
  const folders = new Map<string, Folder>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let saidStandingAside = false;

  const config = () => vscode.workspace.getConfiguration("poly");
  const on = () => config().get<boolean>("autocorrect.enabled", false) && !vscode.extensions.getExtension(ORIGINAL);
  const linting = () => on() && config().get("autocorrect.enableLint", true) && config().get("lintOnSave", true);
  const fixing = () => on() && config().get("autocorrect.formatOnSave", true) && config().get("format.enabled", true);
  // A file or a buffer never saved; not output panels, diff sides or git's
  // copies, which the extension linted too.
  const eligible = (document: vscode.TextDocument) => ["file", "untitled"].includes(document.uri.scheme);
  // The engine picks a file type off the name, and an untitled buffer has
  // none -- but its language id is one of the names it knows (`markdown`).
  const nameOf = (document: vscode.TextDocument) => document.isUntitled ? document.languageId : document.fileName;

  /** The folder `document` takes its configuration from, made again if a file it read has changed. */
  async function folderOf(document: vscode.TextDocument): Promise<Folder> {
    const dir = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
      ?? (document.isUntitled ? undefined : path.dirname(document.uri.fsPath));
    const files = dir === undefined ? [] : CONFIG_FILES.map((name) => path.join(dir, name));
    const stamp = (await Promise.all(files.map((file) => fs.stat(file).then((s) => s.mtimeMs, () => 0)))).join();
    const known = folders.get(dir ?? "");
    if (known?.stamp === stamp) {
      return known;
    }
    const [rc = "", ignoreFile = "", gitignore = ""] = await Promise.all(
      files.map((file) => fs.readFile(file, "utf8").catch(() => "")),
    );
    const engine = freshEngine();
    if (rc) {
      try {
        engine.loadConfig(rc);
      } catch (error) {
        log.warn(`AutoCorrect: ${files[0]} was not loaded, so the defaults apply: ${error}`);
      }
    }
    const matcher = ignore({ allowRelativePaths: true }).add(gitignore).add(ignoreFile);
    const made: Folder = {
      stamp,
      engine,
      ignores: (file) => dir !== undefined && matcher.ignores(path.relative(dir, file)),
    };
    folders.set(dir ?? "", made);
    return made;
  }

  async function lint(document: vscode.TextDocument): Promise<void> {
    if (!linting() || !eligible(document)) {
      diagnostics.delete(document.uri);
      return;
    }
    const folder = await folderOf(document);
    if (document.isClosed || folder.ignores(document.uri.fsPath)) {
      diagnostics.delete(document.uri);
      return;
    }
    const text = document.getText();
    const result = folder.engine.lintFor(text, nameOf(document));
    if (result.error) {
      log.warn(`AutoCorrect: ${document.uri.fsPath}: ${result.error}`);
      return;
    }
    diagnostics.set(
      document.uri,
      corrections(text, result.lines).map((found) => {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(found.line, found.character, found.endLine, found.endCharacter),
          found.replacement,
          found.spelling ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = found.spelling ? "Spellcheck" : "AutoCorrect";
        return diagnostic;
      }),
    );
  }

  /** The edits that correct all of `document`; none when it is ignored or already correct. */
  async function fixes(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
    const folder = await folderOf(document);
    if (folder.ignores(document.uri.fsPath)) {
      return [];
    }
    const before = document.getText();
    const result = folder.engine.formatFor(before, nameOf(document));
    // An empty answer for a file that is not empty is the engine failing, not
    // a correction -- the extension guarded against the same thing.
    if (result.error || result.out === before || (result.out.trim() === "" && before.trim() !== "")) {
      return [];
    }
    const lines = lineEdits(before, result.out);
    return lines
      ? lines.map(({ line, text }) => vscode.TextEdit.replace(document.lineAt(line).range, text))
      : [
        vscode.TextEdit.replace(
          new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end),
          result.out,
        ),
      ];
  }

  function relintAll(): void {
    const standingAside = config().get("autocorrect.enabled", false)
      && vscode.extensions.getExtension(ORIGINAL) !== undefined;
    if (standingAside && !saidStandingAside) {
      log.info(`AutoCorrect: ${ORIGINAL} is installed, so poly's AutoCorrect stands aside`);
    }
    saidStandingAside = standingAside;
    for (const document of vscode.workspace.textDocuments) {
      void lint(document);
    }
  }

  context.subscriptions.push(
    diagnostics,
    vscode.workspace.onDidOpenTextDocument((document) => void lint(document)),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      const key = document.uri.toString();
      clearTimeout(pending.get(key));
      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key);
          void lint(document);
        }, 500),
      );
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      clearTimeout(pending.get(document.uri.toString()));
      diagnostics.delete(document.uri);
    }),
    // An edit to the configuration does not change the files it applies to,
    // so nothing else would show its effect until each of them is touched.
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (CONFIG_FILES.includes(path.basename(document.fileName))) {
        relintAll();
      }
    }),
    vscode.workspace.onWillSaveTextDocument((event) => {
      // Manual saves only, as the extension did: an auto-save fires while
      // typing, and rewriting the line under the cursor then is a fight.
      if (event.reason === vscode.TextDocumentSaveReason.Manual && fixing() && eligible(event.document)) {
        event.waitUntil(fixes(event.document));
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (["poly.autocorrect", "poly.lintOnSave"].some((section) => affects(event, section))) {
        relintAll();
      }
    }),
    vscode.extensions.onDidChange(relintAll),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, quickFixes(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.languages.registerCodeActionsProvider({ scheme: "untitled" }, quickFixes(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.commands.registerCommand("poly.autocorrectDocument", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("Poly: AutoCorrect needs an open editor");
        return;
      }
      const edits = await fixes(editor.document);
      await editor.edit((builder) => edits.forEach((edit) => builder.replace(edit.range, edit.newText)));
    }),
  );
  relintAll();

  function quickFixes(): vscode.CodeActionProvider {
    return {
      provideCodeActions(document, _range, context) {
        // Off, the diagnostics with these sources are the extension's, and it
        // offers its own fix for them.
        if (!on()) {
          return [];
        }
        return context.diagnostics
          .filter((diagnostic) => diagnostic.source && SOURCES.has(diagnostic.source))
          .map((diagnostic) => {
            const action = new vscode.CodeAction(
              `${diagnostic.source}: ${diagnostic.message}`,
              vscode.CodeActionKind.QuickFix,
            );
            action.diagnostics = [diagnostic];
            action.isPreferred = true;
            action.edit = new vscode.WorkspaceEdit();
            action.edit.replace(document.uri, diagnostic.range, diagnostic.message);
            return action;
          });
      },
    };
  }
}

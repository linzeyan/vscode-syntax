// The `poly` setting: one object in the user's settings.json that poly keeps
// written out in full, with every key's comments (editor/settingsBlock.ts has
// the text), and the two things a single object setting takes away from the
// editor's API.
//
// `config.update("poly.format.enabled")` is refused -- only `poly` is a
// registered key -- and `update("poly", …)` rewrites the object without its
// comments, so poly's own writes go through `setPoly`. And a change anywhere
// in the object is reported as a change to `poly` alone:
// `affectsConfiguration("poly.lintOnSave")` is false even when lintOnSave is
// what changed, so listeners ask `affects` instead.
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";

import * as vscode from "vscode";

import { PolySchema, rewrite, withValue, WORDS, Words } from "./editor/settingsBlock";

let context: vscode.ExtensionContext | undefined;
let log: (line: string) => void = () => {};

/** This profile's user settings.json, once found; see `locate`. */
const LOCATION = "settings.location";

export function initSettings(extension: vscode.ExtensionContext, logLine: (line: string) => void): void {
  context = extension;
  log = logLine;
  seen = current();
}

// ── affects ────────────────────────────────────────────────────────────────

let seen: unknown;
const changes = new WeakMap<vscode.ConfigurationChangeEvent, string[]>();

function current(): unknown {
  // A copy: the next snapshot is compared with this one after the editor has
  // moved on, and what `get` hands out is a view, not a value.
  return JSON.parse(JSON.stringify(vscode.workspace.getConfiguration().get("poly") ?? null));
}

/**
 * `event.affectsConfiguration(section)`, also for keys inside `poly`.
 *
 * Diffed against the values last seen, once per event however many listeners
 * ask -- every listener is handed the same event object.
 */
export function affects(
  event: vscode.ConfigurationChangeEvent,
  section: string,
  scope?: vscode.ConfigurationScope,
): boolean {
  if (!section.startsWith("poly.")) {
    return event.affectsConfiguration(section, scope);
  }
  if (!event.affectsConfiguration("poly")) {
    return false;
  }
  let changed = changes.get(event);
  if (changed === undefined) {
    const now = current();
    changed = differences(seen, now, "poly");
    seen = now;
    changes.set(event, changed);
  }
  return changed.some((key) => key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`));
}

function differences(before: unknown, after: unknown, at: string): string[] {
  if (isObject(before) && isObject(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .flatMap((key) => differences(before[key], after[key], `${at}.${key}`));
  }
  return isDeepStrictEqual(before, after) ? [] : [at];
}

// ── writing ────────────────────────────────────────────────────────────────

/**
 * Write the block: every key, with this version's comments and defaults.
 * Called on activation, and a no-op when the file already says it.
 */
export async function keepBlock(): Promise<void> {
  const document = await settingsDocument();
  if (document === undefined) {
    return;
  }
  if (document.isDirty) {
    // Saving it would save the user's half-made edit along with poly's.
    log("[settings] settings.json has unsaved changes; the poly block is rewritten next time");
    return;
  }
  await edit(document, rewrite(document.getText(), schema(), strings(), words(), undefined, indentOf(document)));
}

/**
 * Set one key inside `poly` -- `format.enabled` or `poly.format.enabled` -- or
 * unset it with `undefined`, and return once the editor reads it back.
 */
export async function setPoly(
  key: string,
  value: unknown,
  target = vscode.ConfigurationTarget.Global,
): Promise<void> {
  const name = key.replace(/^poly\./, "");
  if (target !== vscode.ConfigurationTarget.Global) {
    // A workspace's settings file is the team's and carries no block, so the
    // editor's own writer, given the whole object at that scope.
    const config = vscode.workspace.getConfiguration();
    const seen = config.inspect("poly");
    const scoped = target === vscode.ConfigurationTarget.Workspace ? seen?.workspaceValue : seen?.workspaceFolderValue;
    await config.update("poly", withValue(scoped, name.split("."), value), target);
    return;
  }
  const document = await settingsDocument();
  if (document?.isDirty) {
    throw new Error("settings.json has unsaved changes: save it, then try again");
  }
  if (document === undefined) {
    // No file found to edit. The editor's own writer still sets the value; it
    // drops the block's comments, and the next activation writes them back.
    const global = vscode.workspace.getConfiguration().inspect("poly")?.globalValue;
    await vscode.workspace.getConfiguration().update(
      "poly",
      withValue(global, name.split("."), value),
      vscode.ConfigurationTarget.Global,
    );
  } else {
    await edit(
      document,
      rewrite(document.getText(), schema(), strings(), words(), { key: name, value }, indentOf(document)),
    );
  }
  await settled(name, value);
}

/** Resolves once the configuration says `value` for `name`, as `update` does. */
async function settled(name: string, value: unknown): Promise<void> {
  const done = () => isDeepStrictEqual(vscode.workspace.getConfiguration("poly").inspect(name)?.globalValue, value);
  if (done()) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      log(`[settings] poly.${name} was written but not read back within 5s`);
      resolve();
    }, 5000);
    const subscription = vscode.workspace.onDidChangeConfiguration(() => {
      if (done()) {
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      }
    });
  });
}

/**
 * The indentation the editor's own writer uses in this file when the file has
 * none to detect: its settings for it. That writer counts levels in its tab
 * size, so a two-space block under a tab size of four has every key it adds
 * afterwards -- a Settings UI change, the format switch -- land at the margin.
 */
function indentOf(document: vscode.TextDocument): string {
  const editor = vscode.workspace.getConfiguration("editor", document);
  return editor.get<boolean>("insertSpaces", true) ? " ".repeat(editor.get<number>("tabSize", 4)) : "\t";
}

/** Replace only what differs, so an open editor keeps its cursor and undo history. */
async function edit(document: vscode.TextDocument, next: string): Promise<void> {
  const text = document.getText();
  if (next === text) {
    return;
  }
  let start = 0;
  while (start < text.length && start < next.length && text[start] === next[start]) {
    start += 1;
  }
  let end = 0;
  while (
    end < text.length - start && end < next.length - start
    && text[text.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end += 1;
  }
  const change = new vscode.WorkspaceEdit();
  change.replace(
    document.uri,
    new vscode.Range(document.positionAt(start), document.positionAt(text.length - end)),
    next.slice(start, next.length - end),
  );
  if (!(await vscode.workspace.applyEdit(change)) || !(await document.save())) {
    throw new Error(`could not write ${document.uri.toString()}`);
  }
}

async function settingsDocument(): Promise<vscode.TextDocument | undefined> {
  const known = context?.globalState.get<string>(LOCATION);
  if (known) {
    try {
      return await vscode.workspace.openTextDocument(vscode.Uri.parse(known));
    } catch {
      // Moved or deleted: found again below.
    }
  }
  const found = await locate();
  if (found === undefined) {
    return undefined;
  }
  await context?.globalState.update(LOCATION, found.toString());
  // Opened again rather than handed over by `locate`: closing its tab closed it.
  return vscode.workspace.openTextDocument(found);
}

/**
 * Open the user settings.json the way Preferences: Open User Settings (JSON)
 * does, and note where it was.
 *
 * There is no API for its path: it moves with the profile, and in a remote
 * window it is on the local machine under a scheme of its own. So this runs
 * once per profile -- globalState is per profile -- and closes the tab again
 * unless it was already open.
 */
async function locate(): Promise<vscode.Uri | undefined> {
  const tabs = () =>
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputText);
  const uriOf = (tab: vscode.Tab) => (tab.input as vscode.TabInputText).uri.toString();
  const open = new Set(tabs().map(uriOf));
  await vscode.commands.executeCommand("workbench.action.openSettingsJson");
  for (let waited = 0; waited < 3000; waited += 50) {
    const document = vscode.window.activeTextEditor?.document;
    // The scheme, not the name: a workspace's .vscode/settings.json that was
    // active a moment ago is also called settings.json.
    if (document?.uri.scheme === "vscode-userdata") {
      const uri = document.uri.toString();
      // Its own tab, not the active one: whatever the user opened since is
      // not poly's to close.
      const tab = open.has(uri) ? undefined : tabs().find((one) => uriOf(one) === uri);
      if (tab) {
        await vscode.window.tabGroups.close(tab);
      }
      return document.uri;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  log("[settings] could not find the user settings.json");
  return undefined;
}

function schema(): PolySchema {
  return context!.extension.packageJSON.contributes.configuration.properties.poly;
}

/** The manifest's strings in the editor's language, English underneath. */
function strings(): Record<string, string> {
  const read = (name: string): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(path.join(context!.extensionPath, name), "utf8"));
    } catch {
      return {};
    }
  };
  return { ...read("package.nls.json"), ...read(`package.nls.${vscode.env.language.toLowerCase()}.json`) };
}

function words(): Words {
  return /^zh-(tw|hant)/.test(vscode.env.language.toLowerCase()) ? WORDS.zh : WORDS.en;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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

import {
  choicesOf,
  isTyped,
  lineOf,
  parseTyped,
  PolySchema,
  prose,
  rewrite,
  Schema,
  settingsOf,
  shown,
  withValue,
  WORDS,
  Words,
} from "./editor/settingsBlock";

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
  const uriOf = (tab: vscode.Tab) => (tab.input as vscode.TabInputText).uri;
  const open = new Set(tabs().map((tab) => uriOf(tab).toString()));
  await vscode.commands.executeCommand("workbench.action.openSettingsJson");
  for (let waited = 0; waited < 3000; waited += 50) {
    // Its tab, not the active editor: a file opened meanwhile -- an editor
    // restored at startup, the one that activated poly -- can take the focus
    // back before this looks. The scheme as well as the name: a workspace's
    // .vscode/settings.json is also called settings.json.
    const tab = tabs().find((one) =>
      uriOf(one).scheme === "vscode-userdata" && uriOf(one).path.endsWith("/settings.json")
    );
    if (tab) {
      // Closed only if this opened it: one the user had open stays theirs.
      if (!open.has(uriOf(tab).toString())) {
        await vscode.window.tabGroups.close(tab);
      }
      return uriOf(tab);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  log("[settings] could not find the user settings.json");
  return undefined;
}

// ── Poly: Settings ─────────────────────────────────────────────────────────

type Picked = { key: string; action: "edit" | "reset" | "show" };

/**
 * A row per key with its value, picked from a list or typed, which the
 * Settings UI cannot draw for an object setting this deep. Written through
 * `setPoly`, so the block keeps its comments; an array or an object is edited
 * in the file, where the block already shows its shape. Back to the list after
 * each change, as the Settings UI stays open.
 */
export async function openSettingsMenu(): Promise<void> {
  const all = settingsOf(schema());
  let focus: string | undefined;
  for (;;) {
    const picked = await pickSetting(all, focus);
    if (picked === undefined) {
      return;
    }
    focus = picked.key;
    const { schema: node, default: fallback } = all.get(picked.key)!;
    try {
      if (picked.action === "reset") {
        await setPoly(picked.key, undefined);
      } else if (picked.action === "show" || !(choicesOf(node) || isTyped(node))) {
        return await showInFile(picked.key);
      } else {
        await editValue(picked.key, node, fallback);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Poly: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function pickSetting(
  all: Map<string, { schema: Schema }>,
  focus: string | undefined,
): Promise<Picked | undefined> {
  const w = words();
  const text = strings();
  const config = vscode.workspace.getConfiguration("poly");
  const reset = { iconPath: new vscode.ThemeIcon("discard"), tooltip: w.reset };
  const show = { iconPath: new vscode.ThemeIcon("go-to-file"), tooltip: w.show };
  type Item = vscode.QuickPickItem & { key?: string };
  const items: Item[] = [];
  let group: string | undefined;
  // Keys outside any group first, under one heading of their own.
  for (
    const [key, { schema: node }] of [...all].sort(([a], [b]) => Number(a.includes(".")) - Number(b.includes(".")))
  ) {
    const heading = key.includes(".") ? key.slice(0, key.indexOf(".")) : w.general;
    if (heading !== group) {
      items.push({ label: heading, kind: vscode.QuickPickItemKind.Separator });
      group = heading;
    }
    const seen = config.inspect(key);
    const set = seen?.globalValue !== undefined;
    const elsewhere = seen?.workspaceValue !== undefined || seen?.workspaceFolderValue !== undefined;
    items.push({
      key,
      label: key,
      description: [shown(config.get(key)), set ? w.set : "", elsewhere ? w.workspace : ""].filter(Boolean).join(" · "),
      detail: prose(node.markdownDescription ?? node.description ?? "", text).replace(/\s+/g, " "),
      buttons: set ? [reset, show] : [show],
    });
  }
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<Item>();
    pick.title = w.menuTitle;
    pick.placeholder = w.menuFilter;
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    pick.items = items;
    pick.activeItems = items.filter((item) => item.key === focus);
    pick.onDidAccept(() => {
      const key = pick.selectedItems[0]?.key;
      if (key) {
        resolve({ key, action: "edit" });
      }
      pick.hide();
    });
    pick.onDidTriggerItemButton(({ item, button }) => {
      resolve({ key: item.key!, action: button === reset ? "reset" : "show" });
      pick.hide();
    });
    pick.onDidHide(() => {
      pick.dispose();
      resolve(undefined);
    });
    pick.show();
  });
}

/** One key's value, from its choices or typed. Picking the default unsets the key. */
async function editValue(key: string, node: Schema, fallback: unknown): Promise<void> {
  const w = words();
  const text = strings();
  const now = vscode.workspace.getConfiguration("poly").get(key);
  const purpose = prose(node.markdownDescription ?? node.description ?? "", text);
  let value: unknown;
  const choices = choicesOf(node);
  if (choices) {
    const notes = node.markdownEnumDescriptions ?? node.enumDescriptions ?? [];
    const picked = await vscode.window.showQuickPick(
      choices.map((choice, i) => ({
        choice,
        label: shown(choice),
        description: [
          isDeepStrictEqual(choice, now) ? w.current : "",
          isDeepStrictEqual(choice, fallback) ? w.byDefault : "",
        ].filter(Boolean).join(" · "),
        detail: notes[i] === undefined ? undefined : prose(notes[i], text),
      })),
      { title: key, placeHolder: purpose },
    );
    if (picked === undefined) {
      return;
    }
    value = picked.choice;
  } else {
    const typed = await vscode.window.showInputBox({
      title: key,
      prompt: purpose,
      value: now === undefined || now === null ? "" : String(now),
      placeHolder: fallback === undefined || fallback === null ? undefined : String(fallback),
      validateInput: (input) => {
        const parsed = parseTyped(node, input, w);
        return typeof parsed === "string" ? parsed : undefined;
      },
    });
    if (typed === undefined) {
      return;
    }
    value = (parseTyped(node, typed, w) as { value: unknown }).value;
  }
  await setPoly(key, isDeepStrictEqual(value, fallback) ? undefined : value);
}

/** The user's settings.json at `key`'s line. */
async function showInFile(key: string): Promise<void> {
  const document = await settingsDocument();
  if (document === undefined) {
    await vscode.commands.executeCommand("workbench.action.openSettingsJson");
    return;
  }
  const line = lineOf(document.getText(), key) ?? 0;
  const at = new vscode.Position(line, document.lineAt(line).firstNonWhitespaceCharacterIndex);
  await vscode.window.showTextDocument(document, { selection: new vscode.Range(at, at) });
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

// The two status bar switches: stop every automatic format, or every linter,
// in the editor -- not only poly's.
//
// A switch that stops only poly was measured against the ones people install
// for this (tools/ext-diff, format set) and neither did what its label says.
// The popular status-bar toggle writes the global `editor.formatOnSave` and
// nothing else, and a language's own default outranks a global value: golang.go
// ships `[go]` format-on-save and Pylance `[python]` format-on-type, so Go
// still formatted on every save with the toggle "off". poly's switch stopped
// poly and nobody else.
//
// So a switch here is a set of settings, written at user scope and put back
// exactly. What is written, and why each one:
//
// - The editor's own keys, and for each of them every language whose value on
//   the user's side (their `[lang]` block, or an extension's `[lang]` default)
//   would outrank the global one. Which languages is asked of `inspect`, not
//   listed here, so an extension installed tomorrow is covered the same way.
// - Other extensions' own switches, for the linters and the one formatter that
//   run on save by themselves rather than through `editor.formatOnSave`. Each
//   was read off that extension's manifest (2026-09-23), and each is written
//   only while the extension is installed: an unregistered key is refused.
//
// Never written: a workspace's `.vscode/settings.json`. That file belongs to
// a team and git would show it modified; a workspace value that still turns
// something on is named in the switch's tooltip and the log instead.
//
// Not stopped, deliberately: another extension's formatter when Format
// Document is run by hand (that is asking for it), compile and type errors
// (gopls, Pylance, rust-analyzer's own diagnostics -- not lint), and
// markdownlint and gremlins, which have no off switch to write.
import { isDeepStrictEqual } from "node:util";

import * as vscode from "vscode";

import { setPoly } from "./settings";

export type Quiet = "format" | "lint";

/** `editor.codeActionsOnSave` is off when every kind in it is `never`. */
const EVERY_KIND_NEVER = Symbol("every kind never");

interface Setting {
  /** Whose key it is; absent for the editor's and poly's own. */
  readonly extension?: string;
  readonly key: string;
  readonly off: boolean | string | typeof EVERY_KIND_NEVER;
  /** A `[lang]` value can outrank the global one. */
  readonly perLanguage?: boolean;
}

const SETTINGS: Record<Quiet, readonly Setting[]> = {
  format: [
    // First, so poly is quiet before the slower writes below land.
    { key: "poly.format.enabled", off: false },
    { key: "editor.formatOnSave", off: false, perLanguage: true },
    { key: "editor.formatOnType", off: false, perLanguage: true },
    { key: "editor.formatOnPaste", off: false, perLanguage: true },
    // organizeImports and fixAll rewrite a file on save exactly as a
    // formatter does, and golang.go turns organizeImports on for Go.
    { key: "editor.codeActionsOnSave", off: EVERY_KIND_NEVER, perLanguage: true },
    { key: "files.trimTrailingWhitespace", off: false, perLanguage: true },
    { key: "files.insertFinalNewline", off: false, perLanguage: true },
    { key: "files.trimFinalNewlines", off: false, perLanguage: true },
    { extension: "huacnlee.autocorrect", key: "autocorrect.formatOnSave", off: false },
  ],
  lint: [
    { key: "poly.lintOnSave", off: false },
    // Not a lint, but gremlins' replacement, and gremlins is the one linter
    // this switch cannot reach -- leaving poly's copy of it drawing would
    // keep exactly the marks the switch was pressed to clear.
    { key: "poly.unicodeHighlight.enabled", off: false },
    { extension: "charliermarsh.ruff", key: "ruff.lint.enable", off: false },
    { extension: "golang.go", key: "go.lintOnSave", off: "off" },
    { extension: "golang.go", key: "go.vetOnSave", off: "off" },
    // cargo check or clippy on save; rust-analyzer's own diagnostics stay.
    { extension: "rust-lang.rust-analyzer", key: "rust-analyzer.checkOnSave", off: false },
    { extension: "streetsidesoftware.code-spell-checker", key: "cSpell.enabled", off: false },
    { extension: "huacnlee.autocorrect", key: "autocorrect.enableLint", off: false },
    { extension: "dbaeumer.vscode-eslint", key: "eslint.enable", off: false },
    { extension: "timonwong.shellcheck", key: "shellcheck.enable", off: false },
    { extension: "stylelint.vscode-stylelint", key: "stylelint.enable", off: false },
    { extension: "ms-python.pylint", key: "pylint.enabled", off: false },
    { extension: "ms-python.flake8", key: "flake8.enabled", off: false },
  ],
};

/** The key whose value is the switch's own state. */
const OWN: Record<Quiet, string> = { format: "poly.format.enabled", lint: "poly.lintOnSave" };

/** One user-scope write, and what to put back. */
interface Written {
  readonly key: string;
  readonly language?: string;
  /** `undefined` means there was no line, and restoring removes ours. */
  readonly had: unknown;
  readonly wrote: unknown;
}

function stateKey(which: Quiet): string {
  return `quiet.${which}`;
}

function offValue(setting: Setting, seen: readonly unknown[]): unknown {
  if (setting.off !== EVERY_KIND_NEVER) {
    return setting.off;
  }
  // Every kind any scope names, so the value is off whether the editor merges
  // this object across scopes or lets the narrowest one win.
  const kinds = new Set<string>();
  for (const value of seen) {
    if (Array.isArray(value)) {
      value.filter((kind) => typeof kind === "string").forEach((kind) => kinds.add(kind));
    } else if (value && typeof value === "object") {
      Object.keys(value).forEach((kind) => kinds.add(kind));
    }
  }
  return Object.fromEntries([...kinds].sort().map((kind) => [kind, "never"]));
}

function isOff(setting: Setting, value: unknown): boolean {
  return isDeepStrictEqual(value, offValue(setting, [value]));
}

function installed(setting: Setting): boolean {
  return setting.extension === undefined || vscode.extensions.getExtension(setting.extension) !== undefined;
}

/** A user-scope write. poly's own keys live in the `poly` block; see settings.ts. */
async function put(key: string, value: unknown, language?: string): Promise<void> {
  if (key.startsWith("poly.")) {
    await setPoly(key, value);
  } else {
    await scoped(language).update(key, value, vscode.ConfigurationTarget.Global, language !== undefined);
  }
}

function scoped(language?: string): vscode.WorkspaceConfiguration {
  return language === undefined
    ? vscode.workspace.getConfiguration()
    : vscode.workspace.getConfiguration(undefined, { languageId: language });
}

/** Everything any scope says about `key` for `language`, for `offValue`. */
function everything(seen: ReturnType<vscode.WorkspaceConfiguration["inspect"]>): unknown[] {
  return seen
    ? [
      seen.defaultValue,
      seen.globalValue,
      seen.workspaceValue,
      seen.workspaceFolderValue,
      seen.defaultLanguageValue,
      seen.globalLanguageValue,
      seen.workspaceLanguageValue,
      seen.workspaceFolderLanguageValue,
    ]
    : [];
}

/**
 * Switch every setting of `which` off, and remember what was there.
 *
 * Only what is on gets written: a key already off stays out of settings.json,
 * so switching back on leaves the file as it was rather than one line longer.
 */
async function stop(which: Quiet, state: vscode.Memento, log: (line: string) => void): Promise<void> {
  const written: Written[] = [];
  const write = async (setting: Setting, language: string | undefined, had: unknown, wrote: unknown) => {
    try {
      await put(setting.key, wrote, language);
      written.push({ key: setting.key, language, had, wrote });
    } catch (err) {
      // One extension refusing a value is not a reason to leave the rest on.
      log(`[quiet] could not write ${label(setting.key, language)}: ${err}`);
    }
  };
  for (const setting of SETTINGS[which].filter(installed)) {
    const seen = scoped().inspect(setting.key);
    if (!seen) {
      continue;
    }
    const mine = seen.globalValue ?? seen.defaultValue;
    if (!isOff(setting, mine)) {
      await write(setting, undefined, seen.globalValue, offValue(setting, everything(seen)));
    }
    if (!setting.perLanguage) {
      continue;
    }
    for (const language of seen.languageIds ?? []) {
      const here = scoped(language).inspect(setting.key);
      const theirs = here?.globalLanguageValue ?? here?.defaultLanguageValue;
      if (theirs === undefined || isOff(setting, theirs)) {
        continue;
      }
      await write(setting, language, here?.globalLanguageValue, offValue(setting, everything(here)));
    }
  }
  // Saved before anything else can go wrong: a snapshot is what makes the way
  // back exact, and a window closed now must not lose it.
  await state.update(stateKey(which), written);
  log(`[quiet] ${which} stopped: ${written.map((w) => label(w.key, w.language)).join(", ") || "nothing was on"}`);
}

/**
 * Put back what `stop` wrote.
 *
 * Whatever is still off goes back, even when it is no longer byte for byte
 * what was written: an off value left behind is a `"never"` the user did not
 * write and cannot tell from one they did. Equality was the old test, and a
 * `[go]` block that had picked up a kind elsewhere stayed `never` for good.
 * Only a value somebody turned back on while the switch was off -- or removed,
 * which is turning it back to the default -- is a later decision, and that
 * one wins over the snapshot.
 */
async function resume(which: Quiet, state: vscode.Memento, log: (line: string) => void): Promise<void> {
  const written = state.get<Written[]>(stateKey(which)) ?? [];
  const kept: string[] = [];
  for (const one of written) {
    const seen = scoped(one.language).inspect(one.key);
    const now = one.language === undefined ? seen?.globalValue : seen?.globalLanguageValue;
    const setting = SETTINGS[which].find((s) => s.key === one.key);
    if (now === undefined || (setting !== undefined && !isOff(setting, now))) {
      kept.push(label(one.key, one.language));
      continue;
    }
    try {
      await put(one.key, one.had, one.language);
    } catch (err) {
      log(`[quiet] could not restore ${label(one.key, one.language)}: ${err}`);
    }
  }
  // Off with no snapshot: set by hand, or by poly before these switches
  // reached other extensions. On is on either way.
  if (scoped().get(OWN[which]) === false) {
    await put(OWN[which], undefined);
  }
  await state.update(stateKey(which), undefined);
  log(
    `[quiet] ${which} resumed${kept.length > 0 ? `; left as changed while stopped: ${kept.join(", ")}` : ""}`,
  );
}

/** Is the switch on? Its own key says, so every window agrees. */
export function isOn(which: Quiet): boolean {
  return scoped().get<boolean>(OWN[which], true);
}

/**
 * What a workspace's own settings still turn on while `which` is off.
 *
 * Read rather than written -- see the file header -- so the tooltip can name
 * why a file still formatted with the switch off.
 */
export function stillOn(which: Quiet): string[] {
  const found: string[] = [];
  for (const setting of SETTINGS[which].filter(installed)) {
    const seen = scoped().inspect(setting.key);
    for (const value of [seen?.workspaceValue, seen?.workspaceFolderValue]) {
      if (value !== undefined && !isOff(setting, value)) {
        found.push(label(setting.key));
      }
    }
    for (const language of setting.perLanguage ? seen?.languageIds ?? [] : []) {
      const here = scoped(language).inspect(setting.key);
      for (const value of [here?.workspaceLanguageValue, here?.workspaceFolderLanguageValue]) {
        if (value !== undefined && !isOff(setting, value)) {
          found.push(label(setting.key, language));
        }
      }
    }
  }
  return [...new Set(found)];
}

function label(key: string, language?: string): string {
  return language === undefined ? key : `[${language}] ${key}`;
}

/**
 * Let the snapshots travel with Settings Sync.
 *
 * The switch's state is a setting, so it syncs; the snapshot was machine-local
 * memento, so stopping on one machine and resuming on another found nothing to
 * put back and left every `never` in the synced file.
 */
export function syncSnapshots(state: vscode.Memento & { setKeysForSync(keys: readonly string[]): void }): void {
  state.setKeysForSync([stateKey("format"), stateKey("lint")]);
}

/** The command behind a switch: stop if on, resume if off. */
export function toggler(
  which: Quiet,
  state: vscode.Memento,
  log: (line: string) => void,
): () => Promise<void> {
  // A second click while forty settings are still being written would take a
  // snapshot of a half-written state and restore that later.
  let busy = false;
  return async () => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      await (isOn(which) ? stop(which, state, log) : resume(which, state, log));
    } finally {
      busy = false;
    }
  };
}

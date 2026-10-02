import * as assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { buildSync } from "esbuild";

// usernamehw.errorlens, vendored in ./errorLens, is bundled the way the build
// bundles it and run against a stub of the slice of the API it touches. Built
// here rather than read from dist/: `pnpm run unit` builds nothing first, and a
// stale bundle would test yesterday's code.

const LSP = resolve(__dirname, "..", "..");
const manifest = JSON.parse(readFileSync(join(LSP, "package.json"), "utf8"));

// --- the editor, as much of it as Error Lens touches -------------------------

type Listener = (event: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
function event(name: string) {
  return (listener: Listener) => {
    const set = listeners.get(name) ?? new Set();
    listeners.set(name, set.add(listener));
    return { dispose: () => set.delete(listener) };
  };
}
function fire(name: string, value: unknown): void {
  for (const listener of [...(listeners.get(name) ?? [])]) listener(value);
}

class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}
class Range {
  start: Position;
  end: Position;
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
}
class Uri {
  constructor(private readonly value: string) {}
  static parse(value: string): Uri {
    return new Uri(value);
  }
  toString(): string {
    return this.value;
  }
}
const painted = new Set<string>();
class ThemeColor {
  constructor(id: string) {
    painted.add(id);
  }
}

interface Diagnostic {
  message: string;
  severity: number;
  range: Range;
  source?: string;
  code?: string;
}
const problems = new Map<string, Diagnostic[]>();

/** Decoration types and status bar items not yet disposed: what is on screen. */
const live = new Set<object>();
function shown<T extends object>(thing: T): T & { dispose(): void } {
  live.add(thing);
  return Object.assign(thing, { show() {}, hide() {}, dispose: () => live.delete(thing) });
}

const registered: string[] = [];
let overrides: Record<string, unknown> = {};
const declared: Record<string, { default?: unknown; type: string }> = manifest.contributes.configuration.find(
  (group: { title: string }) => group.title === "Error Lens",
).properties;
/** VSCode's default for a setting that declares none, as `light` does. */
const EMPTY: Record<string, unknown> = { object: {}, array: [], string: "", boolean: false, number: 0, integer: 0 };
/** What `workspace.getConfiguration().get("poly.errorLens")` gives: the manifest's defaults, then the test's. */
function settings(): Record<string, unknown> {
  const defaults = Object.entries(declared).map(([key, schema]) => [
    key.slice("poly.errorLens.".length),
    schema.default ?? EMPTY[schema.type],
  ]);
  return { ...Object.fromEntries(defaults), ...overrides };
}

/** A namespace that fails loudly on what the stub lacks, so a new API call shows up here rather than as `undefined`. */
function namespace(name: string, members: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(members, {
    get(target, key) {
      if (typeof key !== "string" || key in target) return target[key as string];
      if (/^on(Did|Will)/.test(key)) return event(`${name}.${key}`);
      throw new Error(`the stub has no vscode.${name}.${key}`);
    },
  });
}

const vscode = {
  Position,
  Range,
  Uri,
  ThemeColor,
  MarkdownString: class {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
  window: namespace("window", {
    visibleTextEditors: [],
    activeTextEditor: undefined,
    createTextEditorDecorationType: (options: object) => shown({ options }),
    createStatusBarItem: () => shown({}),
  }),
  workspace: namespace("workspace", {
    getConfiguration: (section?: string) => ({
      get: (key: string) => (section === undefined && key === "poly.errorLens" ? settings() : undefined),
    }),
  }),
  languages: namespace("languages", {
    getDiagnostics: (uri?: Uri) =>
      uri ? (problems.get(uri.toString()) ?? []) : [...problems].map(([one, found]) => [Uri.parse(one), found]),
  }),
  commands: namespace("commands", {
    registerCommand: (id: string) => {
      registered.push(id);
      return { dispose() {} };
    },
    registerTextEditorCommand: (id: string) => {
      registered.push(id);
      return { dispose() {} };
    },
  }),
  debug: namespace("debug", { breakpoints: [] }),
};

// --- the bundle ---------------------------------------------------------------

interface ErrorLens {
  activate(context: object, standAside: () => boolean): () => void;
  $state: { statusBarIcons: { updateText(): void } };
  extUtils: {
    diagnosticToInlineMessage(template: string, diagnostic: Diagnostic, count: number): string;
    shouldExcludeDiagnostic(diagnostic: Diagnostic): boolean;
    groupDiagnosticsByLine(diagnostics: Diagnostic[]): Record<string, Diagnostic[]>;
  };
  getGutterStyles(context: object): Record<string, unknown>;
}

const SRC = "./src/editor/errorLens/src";
const built = buildSync({
  stdin: {
    contents: [
      "export * from \"src/extension\";",
      "export { extUtils } from \"src/utils/extUtils\";",
      "export { getGutterStyles } from \"src/gutter\";",
    ].join("\n"),
    resolveDir: join(LSP, SRC),
    loader: "ts",
  },
  absWorkingDir: LSP,
  alias: { src: SRC, lodash: "lodash-es" },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  external: ["vscode"],
  logLevel: "silent",
});
const bundlePath = join(mkdtempSync(join(tmpdir(), "poly-errorlens-")), "extension.js");
writeFileSync(bundlePath, built.outputFiles[0].text);

// The bundle's `require("vscode")` gets the stub; everything else loads as usual.
const loader: { _load(request: string, ...rest: unknown[]): unknown } = require("node:module");
const load = loader._load;
loader._load = function(this: unknown, request: string, ...rest: unknown[]) {
  return request === "vscode" ? vscode : load.call(this, request, ...rest);
};
const errorLens: ErrorLens = require(bundlePath);

const context = { subscriptions: [], asAbsolutePath: (path: string) => join(LSP, path) };
let standAside = false;
// What poly's errorLens.ts does: activate once, then refresh whenever the
// settings change or the original extension comes or goes.
const refresh = errorLens.activate(context, () => standAside);
function configure(next: Record<string, unknown>): void {
  overrides = { enabled: true, ...next };
  refresh();
}

function problem(message: string, severity: number, line: number, source?: string, code?: string): Diagnostic {
  return { message, severity, range: new Range(line, 0, line, 1), source, code };
}

// --- poly's part ---------------------------------------------------------------

test("standing aside, it takes down what it drew and draws nothing more", () => {
  // usernamehw.errorlens installed and enabled draws the same messages on the
  // same lines; two copies would show every problem twice.
  configure({ statusBarIconsEnabled: true });
  assert.ok(live.size > 0, "switched on, it draws");
  standAside = true;
  refresh();
  assert.strictEqual(live.size, 0);
  configure({ statusBarIconsEnabled: true, gutterIconsEnabled: true });
  assert.strictEqual(live.size, 0, "a settings change does not bring it back");
  standAside = false;
  refresh();
  assert.ok(live.size > 0, "the original gone, it draws again");
});

test("switched off, it draws nothing", () => {
  configure({ enabled: false, statusBarIconsEnabled: true });
  assert.strictEqual(live.size, 0);
});

test("every command the manifest declares is one it registers, and every one it registers is poly's", () => {
  // poly's stand-ins load the bundle and run the command again by id: a
  // declared id the bundle never registers would fail, and an upstream id left
  // unrenamed would collide with usernamehw.errorlens's.
  const contributed = manifest.contributes.commands
    .map(({ command }: { command: string }) => command)
    .filter((command: string) => command.startsWith("poly.errorLens."));
  assert.ok(contributed.length > 0);
  for (const command of contributed) assert.ok(registered.includes(command), `${command} is not registered`);
  for (const command of registered) assert.ok(command.startsWith("poly.errorLens."), `${command} is not renamed`);
});

test("every color it paints with is one poly declares", () => {
  configure({ statusBarIconsEnabled: true, problemRangeDecorationEnabled: true });
  const colors = manifest.contributes.colors.map(({ id }: { id: string }) => id);
  const own = [...painted].filter((id) => /errorLens/i.test(id));
  assert.ok(own.length > 0);
  for (const id of own) assert.ok(colors.includes(id), `${id} is not declared`);
});

test("every gutter icon set drawn from a file has its files", () => {
  for (const iconSet of ["default", "defaultOutline", "borderless"]) {
    configure({ gutterIconSet: iconSet });
    const paths = Object.values(errorLens.getGutterStyles(context)).filter(
      (one): one is string => typeof one === "string" && one.endsWith(".svg"),
    );
    assert.strictEqual(paths.length, 8, iconSet);
    for (const path of paths) assert.ok(existsSync(path), path);
  }
});

// --- upstream's, as poly ships it ------------------------------------------------

test("an absent source, code or count goes with what is attached to it", () => {
  // The templates people write wrap these in brackets; a problem without a
  // source should not end in `()`.
  configure({});
  const { diagnosticToInlineMessage } = errorLens.extUtils;
  const bare = problem("Missing semicolon", 0, 3);
  const full = problem("Missing semicolon", 0, 3, "eslint", "semi");
  assert.strictEqual(diagnosticToInlineMessage("$message ($source)", full, 1), "Missing semicolon (eslint)");
  assert.strictEqual(diagnosticToInlineMessage("$message ($source)", bare, 1), "Missing semicolon ");
  assert.strictEqual(diagnosticToInlineMessage("$severity $message [$code]", bare, 1), "⛔ Missing semicolon ");
  assert.strictEqual(diagnosticToInlineMessage("$message $count", full, 1), "Missing semicolon ");
  assert.strictEqual(diagnosticToInlineMessage("$message $count", full, 2), "Missing semicolon 2");
  assert.strictEqual(diagnosticToInlineMessage("$lineStart: $message", full, 1), "4: Missing semicolon");
});

test("replace rewrites the whole message from the first matcher that matches", () => {
  configure({
    replace: [
      { matcher: "never (\\w+)", message: "unused: $1" },
      { matcher: "never", message: "second matcher" },
    ],
  });
  const message = errorLens.extUtils.diagnosticToInlineMessage(
    "$message",
    problem("'x' is declared but its value is never read.", 1, 0),
    1,
  );
  assert.strictEqual(message, "unused: read");
});

test("excluded problems are left out by source, source and code, or message", () => {
  configure({
    excludeBySource: ["cSpell", "eslint(no-console)"],
    excludeByMessage: ["trailing", { regex: "^unused \\w+$" }],
  });
  const { shouldExcludeDiagnostic } = errorLens.extUtils;
  assert.ok(shouldExcludeDiagnostic(problem("Unknown word", 2, 0, "cSpell", "x")));
  assert.ok(shouldExcludeDiagnostic(problem("Unexpected console", 1, 0, "eslint", "no-console")));
  assert.ok(!shouldExcludeDiagnostic(problem("Missing semicolon", 1, 0, "eslint", "semi")));
  assert.ok(shouldExcludeDiagnostic(problem("Trailing spaces", 1, 0, "other")));
  assert.ok(shouldExcludeDiagnostic(problem("unused import", 1, 0)));
  assert.ok(!shouldExcludeDiagnostic(problem("an unused import", 1, 0)));
});

test("transmute changes a problem's severity before the line picks the one it shows", () => {
  // A line shows its most severe problem; demoting a noisy one has to let the
  // next one through rather than only recolouring it.
  configure({ transmute: { quiet: { target: { source: "ts", code: "6133" }, severity: "hint" } } });
  const grouped = errorLens.extUtils.groupDiagnosticsByLine([
    problem("'x' is declared but its value is never read.", 0, 5, "ts", "6133"),
    problem("Missing semicolon", 1, 5, "eslint", "semi"),
  ]);
  assert.deepStrictEqual(
    grouped[5].map(({ source, severity }) => [source, severity]),
    [["eslint", 1], ["ts", 3]],
  );
});

test("with the old delay, a new problem waits at least 500 ms and a fixed one goes at once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  configure({ delay: 100, delayMode: "old" });
  let updates = 0;
  errorLens.$state.statusBarIcons.updateText = () => {
    updates += 1;
  };
  const uri = "file:///a.ts";
  const first = problem("Missing semicolon", 1, 0);
  const second = problem("Unexpected any", 1, 2);
  const changed = () => fire("languages.onDidChangeDiagnostics", { uris: [Uri.parse(uri)] });

  problems.set(uri, [first]);
  changed();
  assert.strictEqual(updates, 1, "a file seen for the first time is drawn at once");
  t.mock.timers.tick(1000);

  problems.set(uri, [first, second]);
  changed();
  t.mock.timers.tick(499);
  assert.strictEqual(updates, 1, "100 ms counts as 500");
  t.mock.timers.tick(1);
  assert.strictEqual(updates, 2);
  t.mock.timers.tick(1000);

  problems.set(uri, [second]);
  changed();
  assert.strictEqual(updates, 3, "a fixed problem is not delayed");
  problems.clear();
});

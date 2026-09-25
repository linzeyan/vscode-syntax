#!/usr/bin/env node
// Does the gutter image cache stay the size of what is on screen?
//
// One decoration type per distinct image is unavoidable -- `gutterIconPath`
// belongs to the type -- so the only question is when a type goes away. Nothing
// in a unit test can ask it: the answer lives in `previewImages`, which is
// editor glue, and the cost it guards against is a session-long scroll that no
// assertion about a pure function can reach. So this drives the real
// `previewImages` against a stub of the slice of the API it uses, and counts
// the two things that were once unbounded -- types kept alive, and
// `setDecorations` calls per repaint.
//
// It is a gate and not a benchmark: the numbers it prints are counts, they are
// exact, and the bounds it asserts are what is visible rather than a threshold
// somebody picked.
//
// Usage: node tools/gutter-cache-check.js
const Module = require("node:module");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..");
const LSP = join(ROOT, "extensions", "lsp");
const esbuild = require(join(LSP, "node_modules", "esbuild"));

const SCRATCH = join(tmpdir(), "poly-gutter-cache");
const WORKSPACE = join(SCRATCH, "workspace");

/** Lines scrolled through, each naming an image no other line names. */
const IMAGES = 400;
/** Lines on screen at once, which is what the cache is allowed to cost. */
const WINDOW = 20;

// --- the editor, as much of it as `activate` touches -----------------------

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(a, b, c, d) {
    const ends = a instanceof Position ? [a, b] : [new Position(a, b), new Position(c, d)];
    this.start = ends[0];
    this.end = ends[1];
  }
}

class Uri {
  constructor(fsPath) {
    this.scheme = "file";
    this.fsPath = fsPath;
    this.path = fsPath;
  }
  static file(fsPath) {
    return new Uri(fsPath);
  }
  toString() {
    return `file://${this.fsPath}`;
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(value) {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

const handlers = new Map();
const on = (name) => (listener) => {
  const list = handlers.get(name) ?? [];
  list.push(listener);
  handlers.set(name, list);
  return { dispose: () => list.splice(list.indexOf(listener), 1) };
};
const fire = (name, argument) => {
  for (const listener of [...(handlers.get(name) ?? [])]) listener(argument);
};

/** Every decoration type ever made, and the ones not yet disposed. */
const alive = new Set();
let ever = 0;
const createTextEditorDecorationType = (options) => {
  const type = {
    key: `decoration-${ever++}`,
    options,
    dispose() {
      alive.delete(type);
      // What the API promises: "remove this decoration type and all
      // decorations on all text editors using it".
      for (const editor of editors) editor.painted.delete(type);
    },
  };
  alive.add(type);
  return type;
};
/** The image types alone: indent tinting owns five more that never grow. */
const gutterTypes = () => [...alive].filter((type) => type.options.gutterIconPath);

const editors = [];
let visible = [];

const openDocument = (file, lines) => ({
  uri: Uri.file(file),
  fileName: file,
  languageId: "markdown",
  lineCount: lines.length,
  lineAt: (line) => ({ text: lines[line], lineNumber: line }),
  getText: () => lines.join("\n"),
});

const openEditor = (document, from, to) => {
  const editor = {
    document,
    visibleRanges: [new Range(from, 0, to, 0)],
    options: { tabSize: 4, insertSpaces: true },
    /** What the editor is showing, type by type, as VSCode would hold it. */
    painted: new Map(),
    gutterCalls: 0,
    setDecorations(type, ranges) {
      if (type.options.gutterIconPath) editor.gutterCalls++;
      if (ranges.length === 0) editor.painted.delete(type);
      else editor.painted.set(type, ranges);
    },
  };
  editors.push(editor);
  return editor;
};

const nothing = { dispose() {} };
const vscode = {
  Position,
  Range,
  Uri,
  EventEmitter,
  Selection: class extends Range {},
  Location: class {
    constructor(uri, range) {
      this.uri = uri;
      this.range = range;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  ThemeIcon: class {
    static File = "file";
    constructor(id) {
      this.id = id;
    }
  },
  CodeLens: class {
    constructor(range, command) {
      this.range = range;
      this.command = command;
    }
  },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  SnippetString: class {
    constructor(value) {
      this.value = value;
    }
  },
  CompletionItem: class {
    constructor(label, kind) {
      this.label = label;
      this.kind = kind;
    }
  },
  CodeAction: class {
    constructor(title, kind) {
      this.title = title;
      this.kind = kind;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  OverviewRulerLane: { Right: 4 },
  CompletionItemKind: { Snippet: 14 },
  CodeActionKind: { Refactor: "refactor", QuickFix: "quickfix" },
  SymbolKind: new Proxy({}, { get: () => 0 }),
  version: "stub",
  window: {
    get visibleTextEditors() {
      return visible;
    },
    activeTextEditor: undefined,
    createTextEditorDecorationType,
    onDidChangeVisibleTextEditors: on("visibleEditors"),
    onDidChangeTextEditorVisibleRanges: on("visibleRanges"),
    onDidChangeTextEditorOptions: on("editorOptions"),
    onDidChangeActiveTextEditor: on("activeEditor"),
    onDidChangeTextEditorSelection: on("selection"),
    createTreeView: () => ({ ...nothing, onDidChangeVisibility: on("treeVisibility"), visible: false }),
    registerTreeDataProvider: () => nothing,
    showWarningMessage: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    setStatusBarMessage: () => nothing,
    // The "Poly Editor" log channel. Nothing here reads what it says.
    createOutputChannel: () => ({
      ...nothing,
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      appendLine() {},
    }),
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(WORKSPACE), name: "workspace", index: 0 }],
    // The image gutter ships off, and this check is about what it does while
    // on. Naming the setting rather than returning the code's own fallback:
    // that fallback is `false` now, and a stub that inherited it would measure
    // a feature doing nothing and report a flawless cache.
    getConfiguration: () => ({
      get: (setting, fallback) => (setting === "imagePreview.enabled" ? true : fallback),
    }),
    getWorkspaceFolder: () => ({ uri: Uri.file(WORKSPACE), name: "workspace", index: 0 }),
    asRelativePath: (uri) => String(uri.fsPath ?? uri),
    findFiles: () => Promise.resolve([]),
    fs: {
      stat: () => Promise.resolve({ size: 0 }),
      readFile: () => Promise.resolve(new Uint8Array()),
    },
    onDidChangeTextDocument: on("changeDocument"),
    onDidChangeConfiguration: on("changeConfiguration"),
    onDidSaveTextDocument: on("saveDocument"),
    onDidOpenTextDocument: on("openDocument"),
    onDidCloseTextDocument: on("closeDocument"),
    onDidCreateFiles: on("createFiles"),
    onDidDeleteFiles: on("deleteFiles"),
    onDidRenameFiles: on("renameFiles"),
  },
  commands: {
    registerCommand: () => nothing,
    registerTextEditorCommand: () => nothing,
    executeCommand: () => Promise.resolve(undefined),
  },
  languages: {
    registerCodeLensProvider: () => nothing,
    registerCompletionItemProvider: () => nothing,
    registerCodeActionsProvider: () => nothing,
    registerHoverProvider: () => nothing,
  },
  extensions: { all: [], getExtension: () => undefined, onDidChange: on("extensions") },
  env: { clipboard: { writeText: async () => {} } },
};

// --- the drive --------------------------------------------------------------

const name = (index) => `img/${String(index).padStart(3, "0")}.png`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The images one editor is showing, by the file each type was made from. */
function showing(editor) {
  return [...editor.painted.keys()]
    .map((type) => type.options.gutterIconPath.fsPath.slice(WORKSPACE.length + 1))
    .sort();
}

function fixture() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(WORKSPACE, "img"), { recursive: true });
  // Empty is enough: what decides whether a reference is real is `statSync`,
  // and nothing in this harness renders a thumbnail.
  for (let i = 0; i < IMAGES; i++) writeFileSync(join(WORKSPACE, name(i)), "");

  const scroll = [];
  for (let i = 0; i < IMAGES; i++) scroll.push(`![line ${i}](${name(i)})`);
  writeFileSync(join(WORKSPACE, "scroll.md"), `${scroll.join("\n")}\n`);
  // A second editor showing two of the same images, which is the case that
  // says whether a type is retired because *this* editor stopped showing it or
  // because nothing is.
  const pinned = [`![zero](${name(0)})`, `![one](${name(1)})`];
  writeFileSync(join(WORKSPACE, "pinned.md"), `${pinned.join("\n")}\n`);
  return { scroll, pinned };
}

function load() {
  const bundle = join(SCRATCH, "extension.cjs");
  esbuild.buildSync({
    entryPoints: [join(LSP, "src", "editor", "extension.ts")],
    bundle: true,
    outfile: bundle,
    external: ["vscode"],
    format: "cjs",
    platform: "node",
  });
  const real = Module._load;
  Module._load = function(request, ...rest) {
    return request === "vscode" ? vscode : real.call(this, request, ...rest);
  };
  try {
    return require(bundle);
  } finally {
    Module._load = real;
  }
}

async function main() {
  const lines = fixture();
  const extension = load();

  const scroller = openEditor(openDocument(join(WORKSPACE, "scroll.md"), lines.scroll), 0, WINDOW - 1);
  const pinned = openEditor(openDocument(join(WORKSPACE, "pinned.md"), lines.pinned), 0, 1);
  visible = [scroller, pinned];

  extension.activate({
    subscriptions: [],
    extensionUri: Uri.file(LSP),
    extension: { id: "ricky.poly-lsp", packageJSON: {} },
  });

  const steps = [];
  for (let top = 0; top + WINDOW <= IMAGES; top += WINDOW) {
    scroller.visibleRanges = [new Range(top, 0, top + WINDOW - 1, 0)];
    const before = scroller.gutterCalls;
    fire("visibleRanges", { textEditor: scroller, visibleRanges: scroller.visibleRanges });
    steps.push({ top, kept: gutterTypes().length, calls: scroller.gutterCalls - before });
  }

  // Read before the editor closes, because closing it is allowed to take its
  // thumbnails down with it -- what is being asked here is whether they
  // survived the other editor scrolling the whole file past them.
  const untouched = showing(pinned);

  // The editor goes away. Nothing will ever repaint it, so whatever it was the
  // only one showing can only be retired here.
  visible = [scroller];
  fire("visibleEditors", visible);
  await sleep(400);

  const last = steps[steps.length - 1];
  console.log(`scrolled ${IMAGES} distinct images past a ${WINDOW}-line window, two editors open\n`);
  console.log(`  ${"top line".padStart(8)}  ${"types kept".padStart(10)}  setDecorations this repaint`);
  for (const step of steps) {
    if (step.top % (WINDOW * 4) !== 0 && step !== last) continue;
    console.log(
      `  ${String(step.top).padStart(8)}  ${String(step.kept).padStart(10)}  ${step.calls}`,
    );
  }
  console.log(`\n  types kept after the second editor closed: ${gutterTypes().length}`);

  const problems = [];
  // The cache: what is on screen is `WINDOW` in the scroller plus the two the
  // pinned editor holds, and a type nothing shows has nothing left to paint.
  if (last.kept > WINDOW + lines.pinned.length) {
    problems.push(
      `the cache grew past what is on screen: ${last.kept} types kept for `
        + `${WINDOW + lines.pinned.length} visible images`,
    );
  }
  // The repaint: setting every type ever made, most of them to nothing, is
  // work that grows with the session rather than with the window.
  if (last.calls > WINDOW * 2) {
    problems.push(
      `a repaint costs more than the window: ${last.calls} setDecorations calls for ${WINDOW} lines`,
    );
  }
  // Both of the above are true of a feature that has simply stopped working,
  // so what it draws is checked in the same breath.
  const want = [];
  for (let i = last.top; i < last.top + WINDOW; i++) want.push(name(i));
  if (showing(scroller).join() !== want.sort().join()) {
    problems.push(
      `the scrolled editor shows ${JSON.stringify(showing(scroller))}, wanted the ${WINDOW} on screen`,
    );
  }
  // A type left alone keeps painting: the pinned editor is never repainted
  // while the other one scrolls, so whatever it holds must survive that.
  if (untouched.join() !== [name(0), name(1)].join()) {
    problems.push(`the untouched editor lost its thumbnails: shows ${JSON.stringify(untouched)}`);
  }
  if (gutterTypes().length !== WINDOW) {
    problems.push(
      `closing the second editor left ${gutterTypes().length} types, wanted the ${WINDOW} still on screen`,
    );
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log("\nthe cache is the size of the screen, and still paints it");
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});

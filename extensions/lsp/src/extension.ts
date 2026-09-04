import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { LanguageClient, State, TransportKind } from "vscode-languageclient/node";
import { commonRoot, useLines } from "./gowork";
import { checkForUpdates, scheduleUpdateCheck } from "./update";

// Everything the extension does goes through the daemon, so a daemon that
// never started must be visible and actionable rather than a silent no-op.
const TROUBLESHOOTING = "https://github.com/linzeyan/vscode-syntax/blob/main/extensions/lsp/README.md#疑難排解";

// Language ids the daemon can format or lint (poly-core ids + VSCode
// aliases). Drives the documentSelector, so this is also the set that gets
// lint-on-save diagnostics.
const LANGUAGES = [
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "json",
  "jsonc",
  "markdown",
  "toml",
  "css",
  "scss",
  "less",
  "yaml",
  "python",
  "sql",
  "xml",
  "html",
  "vue",
  "svelte",
  "astro",
  "graphql",
  "dockerfile",
  "shellscript",
  "rust",
  "go",
  "lua",
  "c",
  "cpp",
  "terraform",
  "swift",
  "protobuf",
  // Built-in id; poly only adds the formatter (markup_fmt's Mustache parser).
  "handlebars",
  // Neither id is poly's, and neither is guaranteed to exist -- they arrive
  // with ms-azuretools.vscode-docker and github.vscode-github-actions. Listing
  // an id nothing declares costs nothing (the selector simply never matches),
  // and leaving them out costs the A4 guarantee: the files are `.yml`, so
  // `poly fmt` formats them from the CLI while the editor hands them to
  // whichever extension contributed the specialised id.
  "dockercompose",
  "github-actions-workflow",
];

// `.bats` and `.azcli` are in this extension's `contributes.languages` as well
// as poly-syntax-highlight's, which is the one place the three extensions
// deliberately repeat each other. VSCode's built-in shellscript claims neither,
// so without the mapping the file opens as plain text and no formatter is bound
// to it -- and the three extensions are independent, so someone running only
// poly-lsp would get nothing. VSCode merges identical language contributions,
// and a Rust test compares the two manifests.
//
// Format-on-save is declared, not written: contributes.configurationDefaults
// in package.json covers every language in this list. Adding one here means
// adding it there too, and a test compares the two.
//
// That includes the toolchain languages. They were held back on the theory
// that rust-analyzer, gopls and clangd already own them, but poly formats
// rust, c, cpp, swift and terraform by calling the very same binary those
// servers call, so the output is identical -- and holding them back meant a
// .rs file in an editor with no rust-analyzer simply never formatted.
//
// go is the one real trade-off, taken deliberately: poly formats it with
// gofumpt where gopls uses gofmt. gofumpt is a strict superset, so a repo
// whose CI checks gofmt still passes, but a diff will show edits gofmt would
// not have made.

let client: LanguageClient | undefined;
let status: vscode.StatusBarItem | undefined;
let health: "starting" | "ready" | "failed" = "starting";

// The binary and the extension ship in one VSIX and are versioned together, so
// a mismatch means something replaced one of them: a `poly.serverPath` aimed at
// a stale local build (which is exactly how this repo is set up for
// development), or a different poly earlier on PATH. The daemon still works, so
// this is not a failure -- it is the reason a feature the extension advertises
// appears to do nothing, and the only way to notice used to be to guess.
let versionWarning: string | undefined;

/// `poly --version` prints one line, `poly <version>`. Anything else -- a
/// non-zero exit, no output, a hang -- means the binary is older than 0.3.0,
/// which is itself the mismatch worth reporting rather than an error to raise.
async function binaryVersion(serverPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(serverPath, ["--version"], { timeout: 5000 }, (err, stdout) => {
      const version = stdout.trim().split(/\s+/).pop();
      resolve(err || !version ? undefined : version);
    });
  });
}

/// Show the item while starting, on failure, and whenever the active file is
/// one Poly actually handles — a permanent idle badge is just clutter.
function refreshStatus(): void {
  if (!status) {
    return;
  }
  const language = vscode.window.activeTextEditor?.document.languageId;
  // A version mismatch stays on screen whatever the active file is: it is a
  // broken installation, not a per-file state, and it will not fix itself.
  const relevant = health !== "ready" || versionWarning !== undefined
    || (language !== undefined && LANGUAGES.includes(language));
  if (!relevant) {
    status.hide();
    return;
  }
  if (health === "failed") {
    status.text = "$(error) Poly";
    status.tooltip = "Poly daemon is not running — click for the log";
    status.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground",
    );
  } else if (health === "starting") {
    status.text = "$(sync~spin) Poly";
    status.tooltip = "Starting the Poly daemon…";
    status.backgroundColor = undefined;
  } else if (versionWarning) {
    status.text = "$(warning) Poly";
    status.tooltip = `Poly ${versionWarning} — click for the log`;
    status.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
  } else {
    status.text = "$(check) Poly";
    status.tooltip = "Poly is formatting and linting this file — click for the log";
    status.backgroundColor = undefined;
  }
  status.show();
}

async function reportDaemonFailure(detail: string): Promise<void> {
  const pick = await vscode.window.showErrorMessage(
    `Poly: the daemon is not running (${detail}). Formatting and diagnostics are unavailable.`,
    "Show Log",
    "Troubleshooting",
  );
  if (pick === "Show Log") {
    client?.outputChannel.show();
  } else if (pick === "Troubleshooting") {
    await vscode.env.openExternal(vscode.Uri.parse(TROUBLESHOOTING));
  }
}

function resolveServerPath(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace
    .getConfiguration("poly")
    .get<string>("serverPath");
  if (configured) {
    if (path.isAbsolute(configured)) {
      return configured;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.join(root, configured) : configured;
  }
  // Platform VSIX bundles the binary; fall back to PATH for dev installs.
  const exe = process.platform === "win32" ? "poly.exe" : "poly";
  const bundled = path.join(context.extensionPath, "bin", exe);
  return fs.existsSync(bundled) ? bundled : "poly";
}

async function runBatchFormat(
  mode: "paths" | "gitRepo" | "gitChanged",
  paths: string[],
): Promise<void> {
  if (!client || health !== "ready") {
    await reportDaemonFailure(health);
    return;
  }
  await vscode.workspace.saveAll();
  try {
    // A workspace-wide run takes seconds; without progress it reads as a
    // command that did nothing.
    const summary = (await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: "Poly: formatting…",
      },
      () =>
        client!.sendRequest("workspace/executeCommand", {
          command: "poly.formatPaths",
          arguments: [{ mode, paths }],
        }),
    )) as {
      total: number;
      changed: string[];
      unchanged: number;
      errors: { path: string; error: string }[];
    };
    const message = `Poly: formatted ${summary.changed.length} of ${summary.total} files`;
    if (summary.errors.length > 0) {
      client.outputChannel.appendLine(`[batch] ${message}, errors:`);
      for (const e of summary.errors) {
        client.outputChannel.appendLine(`  ${e.path}: ${e.error}`);
      }
      const pick = await vscode.window.showWarningMessage(
        `${message}, ${summary.errors.length} errors`,
        "Show Log",
      );
      if (pick === "Show Log") {
        client.outputChannel.show();
      }
    } else {
      vscode.window.setStatusBarMessage(message, 5000);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Poly: batch format failed: ${err}`);
  }
}

function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

// ── .editorconfig ──────────────────────────────────────────────────────────
//
// The daemon resolves it, this side applies it. Not a division of labour for
// its own sake: poly already reads .editorconfig for the three knobs it formats
// with, and a second parser here would be a second answer to the same question
// — one the editor obeys while typing, one the formatter obeys on save. They
// would agree on simple files and part company on the projects with enough
// config to have needed one.
//
// `null` means the file said nothing about that property, which is not the same
// as saying the default: the user's own settings have to survive a
// .editorconfig that only mentions indent_size.
//
// `workspaceContains:.editorconfig` is in the manifest for this: the files
// these properties matter most for are the ones poly does not format -- an
// .ini, a Makefile -- and none of them fire an onLanguage event. Root only
// rather than `**/.editorconfig`, because VSCode searches the workspace for
// those patterns and a project with a nested one has a poly language in it
// somewhere anyway.
type EditorConfig = {
  insertSpaces: boolean | null;
  tabSize: number | null;
  trimTrailingWhitespace: boolean | null;
  insertFinalNewline: boolean | null;
  endOfLine: "\n" | "\r\n" | null;
  // Whether poly formats this file, which decides who trims it on save.
  formatted: boolean;
};

async function editorConfig(
  uri: vscode.Uri,
): Promise<EditorConfig | undefined> {
  if (!client || health !== "ready" || uri.scheme !== "file") {
    return undefined;
  }
  try {
    return (await client.sendRequest("workspace/executeCommand", {
      command: "poly.editorConfig",
      arguments: [{ uri: uri.toString() }],
    })) as EditorConfig;
  } catch (err) {
    // A settings lookup is not worth a modal. It fails the same way for every
    // file, so the log is where someone would look after noticing indentation
    // is not being applied at all.
    client.outputChannel.appendLine(`[editorconfig] ${uri.fsPath}: ${err}`);
    return undefined;
  }
}

/// Indentation, applied per editor rather than per setting.
///
/// `editor.options` is the only per-file surface VSCode offers for this;
/// `editor.tabSize` is a setting, and honouring .editorconfig by writing to the
/// user's settings.json would be a cure worse than the disease. This is also
/// the half `editor.detectIndentation` guesses at — it reads the file and is
/// usually right, which is exactly why being wrong on a new or empty file is so
/// hard to notice.
async function applyIndentation(editor: vscode.TextEditor): Promise<void> {
  const config = await editorConfig(editor.document.uri);
  if (!config) {
    return;
  }
  const options: vscode.TextEditorOptions = {};
  if (config.insertSpaces !== null) {
    options.insertSpaces = config.insertSpaces;
  }
  if (config.tabSize !== null) {
    options.tabSize = config.tabSize;
  }
  if (options.insertSpaces !== undefined || options.tabSize !== undefined) {
    editor.options = options;
  }
}

function applyIndentationToVisible(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    void applyIndentation(editor);
  }
}

/// Trailing whitespace, a final newline, and line endings, at save time.
///
/// Returned as edits for `onWillSaveTextDocument` rather than done with a
/// WorkspaceEdit, so they land inside the save the user asked for instead of
/// dirtying the file again immediately after it.
///
/// Nothing happens unless .editorconfig asked for it. `insert_final_newline =
/// false` does not mean "remove the one that is there" — the property that
/// means that is `trim_final_newlines`, and it is a different property.
function saveEdits(
  document: vscode.TextDocument,
  config: EditorConfig,
): vscode.TextEdit[] {
  const edits: vscode.TextEdit[] = [];
  // poly's formatters already trim every line and terminate every file they
  // touch, so for a document poly formats there is nothing here to add — and
  // trying would mean two participants rewriting one save.
  if (!config.formatted) {
    // `files.*` are settings, not per-file options, so a .editorconfig saying
    // "off" cannot switch one off — the extension this replaces cannot either,
    // it prints the same warning. Saying so matters most for markdown, where
    // the two trailing spaces that make a hard line break are the whole reason
    // anyone writes `trim_trailing_whitespace = false`.
    for (
      const [property, setting] of [
        ["trimTrailingWhitespace", config.trimTrailingWhitespace],
        ["insertFinalNewline", config.insertFinalNewline],
      ] as const
    ) {
      const on = vscode.workspace
        .getConfiguration("files", document.uri)
        .get<boolean>(property, false);
      if (setting === false && on) {
        client?.outputChannel.appendLine(
          `[editorconfig] ${document.uri.fsPath}: files.${property} is on and overrides .editorconfig`,
        );
      }
    }
    if (config.trimTrailingWhitespace) {
      for (let line = 0; line < document.lineCount; line++) {
        const { text } = document.lineAt(line);
        const trimmed = text.replace(/[ \t]+$/, "");
        if (trimmed.length !== text.length) {
          edits.push(
            vscode.TextEdit.delete(
              new vscode.Range(line, trimmed.length, line, text.length),
            ),
          );
        }
      }
    }
    const last = document.lineAt(document.lineCount - 1);
    // A document whose last line is empty already ends in a newline.
    if (config.insertFinalNewline && last.text.length > 0) {
      const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
      edits.push(vscode.TextEdit.insert(last.range.end, eol));
    }
  }
  // Line endings are not covered by the formatter: poly round-trips whatever
  // the file already had, deliberately, so a repo that wrote `end_of_line = lf`
  // and has a CRLF file gets no help from `poly fmt`. This is the one place it
  // can be honoured.
  const wanted = config.endOfLine === "\r\n"
    ? vscode.EndOfLine.CRLF
    : vscode.EndOfLine.LF;
  if (config.endOfLine !== null && document.eol !== wanted) {
    edits.push(vscode.TextEdit.setEndOfLine(wanted));
  }
  return edits;
}

/// Scope for git commands: the folder of the active file, else the workspace.
function gitBase(): string[] {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file") {
    return [path.dirname(active.fsPath)];
  }
  return workspacePaths().slice(0, 1);
}

/// Record which binary answered and whether it is the one this extension was
/// built against. The path goes in the log unconditionally -- "which poly is
/// this?" is the first question of every support thread -- and only a mismatch
/// reaches the status bar.
async function reportVersionSkew(
  serverPath: string,
  expected: string,
): Promise<void> {
  const actual = await binaryVersion(serverPath);
  client?.outputChannel.appendLine(
    `[poly] binary ${serverPath} reports ${actual ?? "no version"}, extension is ${expected}`,
  );
  if (actual === expected) {
    return;
  }
  versionWarning = actual
    ? `binary is ${actual} but the extension is ${expected}`
    : `binary at ${serverPath} is older than the extension (${expected})`;
  refreshStatus();
}

/// Tie every Go module in this window into one build, so references cross
/// between them.
///
/// Two projects side by side is the case this exists for, and it is the case
/// gopls answers nothing for on its own: it builds a view per module and a
/// reference search stays inside it, `replace` directive or not (see
/// `gowork.ts` for the measurement). A go.work is what makes them one build,
/// and it works from the common parent — gopls walks up to find it.
///
/// Confirmed before writing, and the dialog names the exact path, because that
/// parent is usually *outside* every folder the window has open. Restarting
/// afterwards rather than waiting for a watcher is for the same reason: a file
/// outside the workspace is a file the editor is not watching.
async function createGoWork(): Promise<void> {
  const found = await vscode.workspace.findFiles(
    "**/go.mod",
    "**/{vendor,node_modules,testdata}/**",
  );
  const dirs = [
    ...new Set(
      found
        .filter((uri) => uri.scheme === "file")
        .map((uri) => path.dirname(uri.fsPath)),
    ),
  ].sort();
  if (dirs.length < 2) {
    vscode.window.showInformationMessage(
      dirs.length === 1
        ? "Poly: only one Go module is open, so a go.work would tie it to nothing."
        : "Poly: no go.mod in this window.",
    );
    return;
  }
  const root = commonRoot(dirs);
  if (!root) {
    vscode.window.showWarningMessage(
      "Poly: these modules share no parent directory, so one go.work cannot cover them.",
    );
    return;
  }
  const target = path.join(root, "go.work");
  const existing = fs.existsSync(target);
  const verb = existing ? "Update" : "Create";
  const choice = await vscode.window.showWarningMessage(
    `${verb} ${target}?`,
    {
      modal: true,
      detail: `${dirs.length} modules become one build, so gopls can resolve `
        + `references between them:\n\n${useLines(root, dirs).join("\n")}`,
    },
    verb,
  );
  if (choice !== verb) {
    return;
  }
  // `go work` writes the file, including the `go` directive poly would only be
  // guessing at. Requiring the toolchain costs nothing: gopls shells out to
  // `go list`, so a machine without go has no cross-module references to fix.
  const written = await new Promise<boolean>((resolve) => {
    execFile(
      "go",
      ["work", existing ? "use" : "init", ...dirs],
      { cwd: root },
      (error, _stdout, stderr) => {
        if (error) {
          vscode.window.showErrorMessage(
            `Poly: go work failed — ${stderr.trim() || error.message}`,
          );
        }
        resolve(!error);
      },
    );
  });
  if (!written) {
    return;
  }
  vscode.window.showInformationMessage(
    `Poly: wrote ${target}; restarting the language server so gopls picks it up.`,
  );
  await client?.restart();
}

/**
 * The line a Go file's `package` clause is on.
 *
 * Not always line 0: a license header, a `//go:build` constraint and a blank
 * line before it are all normal. Bounded because a file with no package clause
 * at all is not a Go file, and scanning all of it to find that out is work for
 * nothing. A `package` at column 0 inside a raw string would match first, but
 * a real Go file has its clause before any literal, so the first match is it.
 */
function packageClauseLine(document: vscode.TextDocument): number | undefined {
  const limit = Math.min(document.lineCount, 200);
  for (let line = 0; line < limit; line++) {
    if (/^package\s+\w/.test(document.lineAt(line).text)) {
      return line;
    }
  }
  return undefined;
}

/**
 * One `analyze dead code` lens per Go file, on its package clause.
 *
 * The command is in the palette already; a lens is what makes it something you
 * notice while reading the code you suspect. It is the entry point Tooltitude
 * puts on every declaration (`analyze unused in file/path/workspace`) and this
 * is deliberately one per file instead: the analysis is whole-program, so a
 * lens per function would be N entry points to the same answer.
 *
 * The scope is not the file. `poly deadcode` walks up to the go.work — or the
 * go.mod when there is none — so this lens asks about the whole build list,
 * which is exactly the cross-module question the file's own package cannot
 * answer.
 */
function analyzeDeadCodeLens(context: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<void>();
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,
    provideCodeLenses(document) {
      const on = vscode.workspace
        .getConfiguration("poly")
        .get<boolean>("deadCodeCodeLens.enabled", true);
      const line = on ? packageClauseLine(document) : undefined;
      if (line === undefined) {
        return [];
      }
      // Resolved on the spot: there is nothing to compute, and an unresolved
      // lens is a spinner over every Go file for no reason.
      return [
        new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: "analyze dead code",
          tooltip: "Run poly deadcode over this file's module, or its whole go.work build list",
          command: "poly.analyzeDeadCode",
          arguments: [document.uri],
        }),
      ];
    },
  };
  context.subscriptions.push(
    changed,
    vscode.languages.registerCodeLensProvider(
      { scheme: "file", language: "go" },
      provider,
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.deadCodeCodeLens")) {
        changed.fire();
      }
    }),
  );
}

export async function activate(context: vscode.ExtensionContext) {
  const serverPath = resolveServerPath(context);
  client = new LanguageClient(
    "poly",
    "Poly",
    {
      command: serverPath,
      args: ["lsp"],
      transport: TransportKind.stdio,
    },
    {
      documentSelector: LANGUAGES.map((language) => ({
        scheme: "file",
        language,
      })),
      initializationOptions: {
        lintOnSave: vscode.workspace
          .getConfiguration("poly")
          .get<boolean>("lintOnSave", true),
        // Read once at startup, like lintOnSave: the daemon acts on it when it
        // spawns a downstream server, and a server already running cannot be
        // un-started by a settings change. Toggling it takes a reload, which
        // is what the setting description says.
        languageServers: vscode.workspace
          .getConfiguration("poly")
          .get<boolean>("languageServers", false),
        // Same deal: it becomes a command-line argument at spawn time, so a
        // server already running keeps the verbosity it started with.
        languageServerLogs: vscode.workspace
          .getConfiguration("poly")
          .get<boolean>("languageServerLogs", true),
      },
    },
  );

  status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  status.command = "poly.showOutput";
  // State changes cover crashes and restarts too, not just the initial start.
  client.onDidChangeState((event) => {
    health = event.newState === State.Running
      ? "ready"
      : event.newState === State.Starting
      ? "starting"
      : "failed";
    refreshStatus();
  });

  context.subscriptions.push(
    status,
    vscode.window.onDidChangeActiveTextEditor(() => {
      refreshStatus();
      applyIndentationToVisible();
    }),
    // Covers splits and restored tabs, which never become active on their own.
    // Overlaps with the line above by design: applying the same options twice
    // is a no-op, and missing an editor is a file being typed into with the
    // wrong indentation.
    vscode.window.onDidChangeVisibleTextEditors(applyIndentationToVisible),
    vscode.workspace.onWillSaveTextDocument((event) => {
      if (event.document.uri.scheme !== "file") {
        return;
      }
      // waitUntil holds the save until the edits arrive. The daemon answers in
      // well under a millisecond and VSCode caps the wait at 1.5s, after which
      // it saves without us -- a slow answer costs the .editorconfig fixes for
      // that save, never the save itself.
      event.waitUntil(
        editorConfig(event.document.uri).then((config) => config ? saveEdits(event.document, config) : []),
      );
    }),
    vscode.commands.registerCommand("poly.showOutput", () => client?.outputChannel.show()),
    vscode.commands.registerCommand("poly.createGoWork", createGoWork),
    vscode.commands.registerCommand("poly.formatFile", async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc?.uri.scheme === "file") {
        await runBatchFormat("paths", [doc.uri.fsPath]);
      }
    }),
    vscode.commands.registerCommand(
      "poly.formatPath",
      async (uri?: vscode.Uri) => {
        const target = uri?.fsPath ?? workspacePaths()[0];
        if (target) {
          await runBatchFormat("paths", [target]);
        }
      },
    ),
    vscode.commands.registerCommand("poly.formatWorkspace", async () => {
      const paths = workspacePaths();
      if (paths.length > 0) {
        await runBatchFormat("paths", paths);
      }
    }),
    vscode.commands.registerCommand("poly.formatGitRepo", async () => {
      const base = gitBase();
      if (base.length > 0) {
        await runBatchFormat("gitRepo", base);
      }
    }),
    vscode.commands.registerCommand("poly.formatGitChanged", async () => {
      const base = gitBase();
      if (base.length > 0) {
        await runBatchFormat("gitChanged", base);
      }
    }),
    // Lint runs through the CLI in a terminal: output stays visible and the
    // command line matches CI exactly.
    vscode.commands.registerCommand(
      "poly.lintPath",
      async (uri?: vscode.Uri) => {
        const target = uri?.fsPath ?? workspacePaths()[0];
        if (!target) {
          return;
        }
        const terminal = vscode.window.createTerminal("poly check");
        terminal.show();
        terminal.sendText(`"${serverPath}" check "${target}"`);
      },
    ),
    // Dead code goes through the terminal for the same reason lint does, and
    // for one more: it is asked, not watched. Whole-program reachability costs
    // a build and answers "nothing calls this anywhere", which is a question
    // with a moment — before deleting something — rather than a thing to
    // recompute on every save. It stays out of `poly check` for the same
    // reason; see `cmd_deadcode`.
    vscode.commands.registerCommand(
      "poly.analyzeDeadCode",
      async (uri?: vscode.Uri) => {
        const target = uri?.fsPath
          ?? vscode.window.activeTextEditor?.document.uri.fsPath
          ?? workspacePaths()[0];
        if (!target) {
          return;
        }
        const terminal = vscode.window.createTerminal("poly deadcode");
        terminal.show();
        terminal.sendText(`"${serverPath}" deadcode "${target}"`);
      },
    ),
    // Minify is the inverse of what every other command here does, so it is
    // driven by the user rather than by a save: nothing about it belongs in
    // format-on-save, and `poly fmt` would undo it on the next run.
    vscode.commands.registerCommand("poly.minifyJson", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== "file") {
        return;
      }
      // Checked here so the message can say which of the two things went
      // wrong: the daemon answers "no edits" for a file that is already
      // minified and for one that was never JSON, and those deserve different
      // words.
      if (!["json", "jsonc"].includes(editor.document.languageId)) {
        vscode.window.showWarningMessage(
          `Poly: Minify JSON needs a JSON file (this one is ${editor.document.languageId})`,
        );
        return;
      }
      if (!client || health !== "ready") {
        await reportDaemonFailure(health);
        return;
      }
      try {
        const edits = (await client.sendRequest("workspace/executeCommand", {
          // Not "poly.minifyJson": the client registers every command the
          // server advertises as an editor command, so an id shared with the
          // one registered above would collide and stop the client starting.
          command: "poly.minifyJsonEdits",
          arguments: [{ uri: editor.document.uri.toString() }],
        })) as {
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
          newText: string;
        }[];
        if (edits.length === 0) {
          vscode.window.setStatusBarMessage("Poly: already minified", 3000);
          return;
        }
        // An editor edit rather than a WorkspaceEdit: undo stays a single
        // keystroke, which is the first thing anyone reaches for after
        // watching a file collapse into one line.
        await editor.edit((builder) => {
          for (const edit of edits) {
            builder.replace(
              new vscode.Range(
                edit.range.start.line,
                edit.range.start.character,
                edit.range.end.line,
                edit.range.end.character,
              ),
              edit.newText,
            );
          }
        });
      } catch (err) {
        vscode.window.showErrorMessage(`Poly: minify failed: ${err}`);
      }
    }),
    vscode.commands.registerCommand("poly.checkForUpdates", () => checkForUpdates(context, false)),
  );
  analyzeDeadCodeLens(context);

  refreshStatus();
  try {
    await client.start();
  } catch (err) {
    // Missing/blocked binary (SmartScreen, wrong arch, bad poly.serverPath) is
    // the most common install failure; let activation succeed so the status bar
    // and log stay reachable instead of dying with a generic error toast.
    health = "failed";
    refreshStatus();
    void reportDaemonFailure(`${serverPath}: ${err}`);
    return;
  }
  await reportVersionSkew(serverPath, context.extension.packageJSON.version);
  // The editors already open when the window was restored: they fired their
  // events before the daemon could answer, so nothing above has seen them.
  applyIndentationToVisible();
  scheduleUpdateCheck(context);
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

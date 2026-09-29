import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DocumentFormattingRequest, LanguageClient, State, TransportKind } from "vscode-languageclient/node";
import { firstCodeLine } from "./anchor";
import { activate as activateEditor } from "./editor/extension";
import { commonRoot, useLines } from "./gowork";
import { isOn, type Quiet, stillOn, toggler } from "./quiet";
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
  // The ids `prompt-basics` takes off markdown -- SKILL.md, *.prompt.md,
  // *.instructions.md, .claude/rules/**, .claude/agents/**. They are `.md`
  // files, so `poly fmt` already formats them from the CLI by path; leaving
  // them out of the selector is what made the editor and the CLI disagree
  // about the same file.
  "prompt",
  "instructions",
  "chatagent",
  "skill",
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
  "php",
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
  // Not a built-in id either -- it arrives with REditorSupport.r. poly pins
  // arity, which formats, lints and serves R, so the file works the moment the
  // id exists and costs nothing while it does not.
  "r",
  // poly-syntax-highlight's id; the formatter is jsonnetfmt.
  "jsonnet",
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
// as poly-syntax-highlight's, which is the one place the two extensions
// deliberately repeat each other. VSCode's built-in shellscript claims neither,
// so without the mapping the file opens as plain text and no formatter is bound
// to it -- and the two extensions are independent, so someone running only
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

/**
 * Editor language ids `poly.minify` offers itself for.
 *
 * poly's own five (`minifiable_language` in poly-engines) spelled in the
 * editor's vocabulary, which needs more names than poly does: `json` splits
 * into `json` and `jsonc`, and poly's one `typescript` is four ids here once
 * JSX is counted. `xml` is listed although a bare VSCode has no such language
 * id -- a `.xml` with no XML extension installed reads as `plaintext`, falls
 * through this list and gets the message, which is the right answer.
 *
 * A copy of a list that lives in Rust, and the only honest thing to say about
 * that is that the copy is not what decides anything: the daemon refuses or
 * accepts by poly's own detection, and this list only picks which sentence the
 * user reads. What keeps the two in step is the e2e test, which opens a buffer
 * per language and asserts an edit comes back -- a behaviour, not a list.
 */
const MINIFIABLE = [
  "json",
  "jsonc",
  "css",
  "html",
  "xml",
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
];

let client: LanguageClient | undefined;
let status: vscode.StatusBarItem | undefined;
let formatToggle: vscode.StatusBarItem | undefined;
let lintToggle: vscode.StatusBarItem | undefined;
let health: "starting" | "ready" | "failed" = "starting";

/// May poly rewrite a file right now?
///
/// One rule rather than two. The tempting version suppresses only the
/// automatic rewrites and lets an explicit Format Document through, but the
/// provider is handed the same request either way -- the editor does not say
/// whether a save or a keystroke asked -- so "except when you ask twice" would
/// have to be guessed at from a save participant's timing. A switch that means
/// "poly does not touch my files while this is off" is one sentence, and the
/// status bar says which way it is pointing.
///
/// Not `editor.formatOnSave` alone, even though the status bar switch writes
/// that too (see quiet.ts): Format Document does not consult it, and "poly
/// does not touch my files" has to cover the explicit request as well.
///
/// The format shortcut (`poly.formatDocument`) is the one way past it, and it
/// goes around rather than through: it asks the daemon itself, so there is no
/// request here to tell apart from a save.
function mayFormat(): boolean {
  return isOn("format");
}

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
function binaryVersion(serverPath: string): Promise<string | undefined> {
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
  const mine = language !== undefined && LANGUAGES.includes(language);
  refreshSwitch(formatToggle, "format", language !== undefined);
  refreshSwitch(lintToggle, "lint", language !== undefined);
  // A version mismatch stays on screen whatever the active file is: it is a
  // broken installation, not a per-file state, and it will not fix itself.
  const relevant = health !== "ready" || versionWarning !== undefined || mine;
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
    const doing = [isOn("format") && "formatting", isOn("lint") && "linting"].filter(Boolean);
    status.tooltip = doing.length > 0
      ? `Poly is ${doing.join(" and ")} this file — click for the log`
      : "Formatting and linting are stopped — click for the log";
    status.backgroundColor = undefined;
  }
  status.show();
}

/// Items of their own, because they are other things.
///
/// The Poly item answers "is the daemon working"; these answer "may anything
/// rewrite this file" and "may anything lint it", which the user changes many
/// times a day and the other never. Folding a switch into the health item would
/// mean a click that opens the log when poly is unhappy and rewrites settings
/// when it is not. Shown for any file, not only poly's: the switches reach
/// every extension's formatter and linter, so a Go file served by golang.go is
/// as much theirs as a .ts is.
function refreshSwitch(item: vscode.StatusBarItem | undefined, which: Quiet, relevant: boolean): void {
  if (!item) {
    return;
  }
  if (!relevant) {
    item.hide();
    return;
  }
  const on = isOn(which);
  const name = which === "format" ? "Format" : "Lint";
  item.text = on ? `$(${which === "format" ? "edit" : "checklist"}) ${name}` : `$(circle-slash) ${name}`;
  const leftover = on ? [] : stillOn(which);
  item.tooltip = (on
    ? which === "format"
      ? "Files are formatted on save, type and paste — click to stop it for every extension"
      : "Linters are running — click to stop poly's and every other extension's"
    : which === "format"
    ? "No extension rewrites files on its own — click to resume"
    : "Linters are stopped — click to resume")
    + (leftover.length > 0 ? `\nStill on in this workspace's settings: ${leftover.join(", ")}` : "");
  // Warning rather than error: stopped is a state the user chose, and it has
  // to be visible across a window full of tabs or it is the kind of switch
  // that gets left off for a week.
  item.backgroundColor = on
    ? undefined
    : new vscode.ThemeColor("statusBarItem.warningBackground");
  item.show();
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

/// Format the active document now, whatever the switches say.
///
/// A key pressed to format this file is the one request no switch should be
/// able to swallow. For a file poly formats, the daemon is asked directly:
/// that never passes the middleware, so the switch cannot see it, and it does
/// not depend on which editor has focus -- `editor.action.formatDocument` does,
/// and run as a command it was measured returning without asking any formatter.
/// Anything else goes to Format Document, which poly never blocked, so the
/// language's own default formatter is the one that answers.
async function formatNow(self: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const { document } = editor;
  const chosen = vscode.workspace.getConfiguration("editor", document).get<string>("defaultFormatter");
  const polys = document.uri.scheme === "file"
    && LANGUAGES.includes(document.languageId)
    && (!chosen || chosen === self);
  if (!polys) {
    await vscode.commands.executeCommand("editor.action.formatDocument");
    return;
  }
  if (!client || health !== "ready") {
    await reportDaemonFailure(health);
    return;
  }
  const version = document.version;
  const edits = await client.sendRequest(DocumentFormattingRequest.type, {
    textDocument: { uri: document.uri.toString() },
    options: {
      tabSize: Number(editor.options.tabSize),
      insertSpaces: Boolean(editor.options.insertSpaces),
    },
  });
  // Typed into while the daemon was formatting: the edits describe a text
  // that no longer exists, and applying them would scramble the new one.
  if (!edits || edits.length === 0 || document.version !== version) {
    return;
  }
  await editor.edit((builder) => {
    for (const edit of edits) {
      builder.replace(client!.protocol2CodeConverter.asRange(edit.range), edit.newText);
    }
  });
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
 * Languages `poly deadcode` can answer about, and what answers for each.
 *
 * Three tools, one question -- "does anything reach this code" -- and poly
 * implements none of them. A language is here only if somebody already built
 * the whole-program analysis for it: Go has golang.org/x/tools/cmd/deadcode,
 * JS and TS have knip, Python has vulture. Rust is deliberately absent, and
 * that is an honest absence rather than an oversight -- rustc's own `dead_code`
 * lint already arrives through `cargo clippy` on every save, and nothing
 * mainstream answers the cross-crate version of the question.
 */
const DEAD_CODE_LANGUAGES: Readonly<Record<string, string>> = {
  go: "this file's module, or its whole go.work build list",
  typescript: "this file's npm project (knip)",
  typescriptreact: "this file's npm project (knip)",
  javascript: "this file's npm project (knip)",
  javascriptreact: "this file's npm project (knip)",
  python: "this file's Python project (vulture)",
};

/**
 * One `analyze dead code` lens per file, on the first line that is code.
 *
 * The command is in the palette already; a lens is what makes it something you
 * notice while reading the code you suspect. It is the entry point Tooltitude
 * puts on every declaration (`analyze unused in file/path/workspace`) and this
 * is deliberately one per file instead: the analysis is whole-program, so a
 * lens per function would be N entry points to the same answer.
 *
 * The scope is not the file. `poly deadcode` walks up to the project the file
 * belongs to -- the go.work, the package.json beside the knip that will answer,
 * the pyproject.toml -- which is exactly the question the file itself cannot
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
      const scope = DEAD_CODE_LANGUAGES[document.languageId];
      const line = on && scope ? firstCodeLine(document) : undefined;
      if (line === undefined) {
        return [];
      }
      // Resolved on the spot: there is nothing to compute, and an unresolved
      // lens is a spinner over every file for no reason.
      return [
        new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: "analyze dead code",
          tooltip: `Run poly deadcode over ${scope}`,
          command: "poly.analyzeDeadCode",
          arguments: [document.uri],
        }),
      ];
    },
  };
  context.subscriptions.push(
    changed,
    vscode.languages.registerCodeLensProvider(
      Object.keys(DEAD_CODE_LANGUAGES).map((language) => ({
        scheme: "file",
        language,
      })),
      provider,
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.deadCodeCodeLens")) {
        changed.fire();
      }
    }),
  );
}

/**
 * Extensions that start a language server of their own, and the server of
 * poly's each one stands in for.
 *
 * With both running, every question is answered twice: two gopls hold the same
 * module in memory, every reference search runs in both, and hover and
 * completion show each answer twice. The two cannot be merged and poly cannot
 * stop somebody else's server, so the one direction that can be enforced is
 * poly stepping back -- the extension the user installed for that language
 * keeps it, and poly routes only the languages nobody else serves.
 *
 * A list of other people's extension ids, which elsewhere in poly is a smell
 * (a guess about what is installed). Here it is not a guess: `getExtension`
 * answers from what is actually installed and enabled, and the list only says
 * which server each one runs. R is absent on purpose -- REditorSupport.r serves
 * nothing unless the `languageserver` R package is installed, and yielding to
 * it would leave most R files with no server at all.
 */
const OFFICIAL_SERVERS: readonly [extension: string, server: string][] = [
  ["golang.go", "gopls"],
  ["rust-lang.rust-analyzer", "rust-analyzer"],
  ["llvm-vs-code-extensions.vscode-clangd", "clangd"],
  ["ms-vscode.cpptools", "clangd"],
  ["swiftlang.swift-vscode", "sourcekit-lsp"],
  ["sswg.swift-lang", "sourcekit-lsp"],
  ["hashicorp.terraform", "terraform-ls"],
  ["sumneko.lua", "lua-language-server"],
  ["mads-hartmann.bash-ide-vscode", "bash-language-server"],
  ["bufbuild.vscode-buf", "buf"],
];

/**
 * The servers poly should leave alone, keyed by server with the extension that
 * serves the language instead -- the daemon names it in the log line that says
 * why a language went to someone else.
 */
function yieldServers(): Record<string, string> {
  const yielded: Record<string, string> = {};
  for (const [extension, server] of OFFICIAL_SERVERS) {
    if (!vscode.extensions.getExtension(extension) || yielded[server]) {
      continue;
    }
    // cpptools is often installed for its debugger alone, with IntelliSense
    // switched off so clangd can have C and C++. Yielding to it then would hand
    // the language to an engine that has been told to answer nothing.
    if (
      extension === "ms-vscode.cpptools"
      && vscode.workspace.getConfiguration("C_Cpp").get<string>("intelliSenseEngine") === "disabled"
    ) {
      continue;
    }
    yielded[server] = extension;
  }
  return yielded;
}

export async function activate(context: vscode.ExtensionContext) {
  // First, and returned on every path below: the editor features need no
  // daemon, and the markdown preview reads its plugin off this return value --
  // a binary that fails to start must not take the diagrams down with it.
  // They get the binary's path, not a running daemon (PlantUML asks it for the
  // jar), and finding the path only reads settings.
  const serverPath = resolveServerPath(context);
  const exports = activateEditor(context, serverPath);
  let yielded = yieldServers();
  client = new LanguageClient(
    "poly",
    "Poly",
    {
      command: serverPath,
      args: ["lsp"],
      transport: TransportKind.stdio,
    },
    {
      outputChannel: daemonLog(context),
      documentSelector: LANGUAGES.map((language) => ({
        scheme: "file",
        language,
      })),
      // A function, so that a restart asks again: `yieldServers` changes when an
      // extension is installed or removed, and the client re-sends these on
      // every start.
      initializationOptions: () => ({
        yieldServers: yielded,
        // Read at startup, and a change restarts the client (below): the lint
        // switch has to take poly's findings off the screen when it is clicked,
        // not at the next reload.
        lintOnSave: vscode.workspace
          .getConfiguration("poly")
          .get<boolean>("lintOnSave", true),
        // Read once at startup: the daemon acts on it when it
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
        // And again: the daemon reads it once, so turning it on mid-session
        // logs nothing until the window reloads.
        memoryLog: vscode.workspace
          .getConfiguration("poly")
          .get<boolean>("memoryLog", false),
      }),
      // The suspend switch, applied here rather than in the daemon: the daemon
      // would have to be told about the setting and would still answer the
      // same request the same way, and a client that never asks is one fewer
      // round trip on every save. Diagnostics are untouched -- suspending the
      // rewrite is not the same as not wanting to know.
      middleware: {
        provideDocumentFormattingEdits: (document, options, token, next) =>
          mayFormat() ? next(document, options, token) : [],
        provideDocumentRangeFormattingEdits: (document, range, options, token, next) =>
          mayFormat() ? next(document, range, options, token) : [],
      },
    },
  );

  status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  status.command = "poly.showOutput";
  // Left of the health item: the one that changes is the one the eye should
  // land on first, and 99 puts it there.
  formatToggle = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  formatToggle.command = "poly.toggleFormat";
  lintToggle = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    98,
  );
  lintToggle.command = "poly.toggleLint";
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
    formatToggle,
    lintToggle,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("poly.format") || event.affectsConfiguration("poly.lintOnSave")) {
        refreshStatus();
      }
      // The daemon reads it at spawn time, and a restart is also what clears
      // the findings already on screen: the client drops its diagnostics when
      // it stops, and a daemon started with lint off publishes none.
      if (event.affectsConfiguration("poly.lintOnSave")) {
        void client?.restart();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      refreshStatus();
      applyIndentationToVisible();
    }),
    // Covers splits and restored tabs, which never become active on their own.
    // Overlaps with the line above by design: applying the same options twice
    // is a no-op, and missing an editor is a file being typed into with the
    // wrong indentation.
    vscode.window.onDidChangeVisibleTextEditors(applyIndentationToVisible),
    // Installing golang.go mid-session is the moment two gopls start sharing a
    // window, and uninstalling it is the moment Go loses its only one. A
    // restart is what gets the daemon a new list: it is read at spawn time,
    // like every other initialization option.
    vscode.extensions.onDidChange(() => {
      const now = yieldServers();
      if (JSON.stringify(now) === JSON.stringify(yielded)) {
        return;
      }
      yielded = now;
      logLine(`[poly] language servers left to other extensions: ${JSON.stringify(now)}`);
      void client?.restart();
    }),
    vscode.workspace.onWillSaveTextDocument((event) => {
      // Same switch as the formatter: these are the save-time rewrites for a
      // file poly does not format, and "poly does not touch my files" has to
      // mean both or it means neither.
      if (event.document.uri.scheme !== "file" || !mayFormat()) {
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
    // Global scope: a switch is "I am not in the mood for this right now",
    // which is about the person and not about the project. Writing it at
    // workspace scope would leave lines in somebody's .vscode/settings.json
    // for the whole team to inherit. Switching back on puts back exactly what
    // was there, so the settings file ends as it started.
    vscode.commands.registerCommand("poly.toggleFormat", toggler("format", context.globalState, logLine)),
    vscode.commands.registerCommand("poly.toggleLint", toggler("lint", context.globalState, logLine)),
    vscode.commands.registerCommand("poly.createGoWork", createGoWork),
    vscode.commands.registerCommand("poly.formatDocument", () => formatNow(context.extension.id)),
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
      (uri?: vscode.Uri) => {
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
      (uri?: vscode.Uri) => {
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
    vscode.commands.registerCommand("poly.minify", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== "file") {
        return;
      }
      // Checked here so the message can say which of the two things went
      // wrong: the daemon answers "no edits" for a file that is already
      // minified and for one poly does not minify, and those deserve different
      // words. The daemon is still the authority -- it decides by poly's own
      // detection, which a remapped extension can change -- so this list is
      // only ever allowed to be the reason for a *message*.
      if (!MINIFIABLE.includes(editor.document.languageId)) {
        vscode.window.showWarningMessage(
          `Poly: Minify handles JSON, CSS, HTML, XML and JavaScript/TypeScript `
            + `(this one is ${editor.document.languageId})`,
        );
        return;
      }
      if (!client || health !== "ready") {
        await reportDaemonFailure(health);
        return;
      }
      try {
        const edits = (await client.sendRequest("workspace/executeCommand", {
          // Not "poly.minify": the client registers every command the
          // server advertises as an editor command, so an id shared with the
          // one registered above would collide and stop the client starting.
          command: "poly.minifyEdits",
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
    vscode.commands.registerCommand(
      "poly.checkForUpdates",
      () => checkForUpdates(context, false, logLine),
    ),
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
    return exports;
  }
  await reportVersionSkew(serverPath, context.extension.packageJSON.version);
  // The editors already open when the window was restored: they fired their
  // events before the daemon could answer, so nothing above has seen them.
  applyIndentationToVisible();
  scheduleUpdateCheck(context, "poly", logLine);
  return exports;
}

const LEVELS = { Error: "error", Warn: "warn", Info: "info", Debug: "debug", Trace: "trace" } as const;

/**
 * The daemon's "Poly" channel, as a `LogOutputChannel`: that is a file named
 * after it in the extension's own folder, the one "Developer: Open Extension
 * Logs Folder" opens, where a plain channel is a numbered file under
 * `output_logging_*` beside it that nobody finds -- and every line has a time.
 *
 * languageclient 9 writes to it as to a plain channel. The server's stderr
 * comes in whatever chunks the pipe gives, and a log channel makes each chunk
 * an entry, so lines are put back together here; the client's own messages
 * carry a clock and a level in brackets, which become the entry's instead.
 * Owning the channel also keeps the client from opening a second "Poly" to
 * say the server exited after it disposed the first.
 */
function daemonLog(context: vscode.ExtensionContext): vscode.OutputChannel {
  const log = vscode.window.createOutputChannel("Poly", { log: true });
  context.subscriptions.push(log);
  let partial = "";
  return {
    name: log.name,
    append(chunk: string) {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) log.info(line.replace(/\r$/, ""));
      }
    },
    appendLine(message: string) {
      const stamped = /^\[(Error|Warn|Info|Debug|Trace) *- [^\]]*\] /.exec(message);
      if (stamped) {
        log[LEVELS[stamped[1] as keyof typeof LEVELS]](message.slice(stamped[0].length));
      } else {
        log.info(message);
      }
    },
    replace(value: string) {
      log.replace(value);
    },
    clear() {
      log.clear();
    },
    show(column?: vscode.ViewColumn | boolean, preserveFocus?: boolean) {
      log.show(typeof column === "boolean" ? column : preserveFocus);
    },
    hide() {
      log.hide();
    },
    dispose() {
      log.dispose();
    },
  };
}

/** A line in the "Poly" channel, from code that runs outside the client. */
function logLine(line: string): void {
  client?.outputChannel.appendLine(line);
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

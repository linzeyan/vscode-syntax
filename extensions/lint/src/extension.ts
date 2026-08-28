import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { LanguageClient, State, TransportKind } from "vscode-languageclient/node";
import { checkForUpdates, scheduleUpdateCheck } from "./update";

// Everything the extension does goes through the daemon, so a daemon that
// never started must be visible and actionable rather than a silent no-op.
const TROUBLESHOOTING = "https://github.com/linzeyan/vscode-syntax/blob/main/extensions/lint/README.md#疑難排解";

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
];

// Languages the one-click opt-in makes poly the *default* formatter for.
// Toolchain languages are deliberately excluded: rust-analyzer, gopls and
// clangd already format them, silently taking that over would change output
// (gofumpt is not gofmt), and poly returns nothing at all when the toolchain
// binary is missing since it never auto-installs those. Poly stays reachable
// there through "Format Document With...".
const TOOLCHAIN_FORMATTERS = ["rust", "go", "c", "cpp", "swift", "terraform"];
const FORMAT_ON_SAVE_LANGUAGES = LANGUAGES.filter(
  (language) => !TOOLCHAIN_FORMATTERS.includes(language),
);

let client: LanguageClient | undefined;
let status: vscode.StatusBarItem | undefined;
let health: "starting" | "ready" | "failed" = "starting";

/// Show the item while starting, on failure, and whenever the active file is
/// one Poly actually handles — a permanent idle badge is just clutter.
function refreshStatus(): void {
  if (!status) {
    return;
  }
  const language = vscode.window.activeTextEditor?.document.languageId;
  const relevant = health !== "ready" || (language !== undefined && LANGUAGES.includes(language));
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

/// Scope for git commands: the folder of the active file, else the workspace.
function gitBase(): string[] {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "file") {
    return [path.dirname(active.fsPath)];
  }
  return workspacePaths().slice(0, 1);
}

async function promptFormatOnSave(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("poly");
  if (!config.get<boolean>("promptFormatOnSave")) {
    return;
  }
  if (context.globalState.get<boolean>("promptedFormatOnSave")) {
    return;
  }
  await context.globalState.update("promptedFormatOnSave", true);
  const pick = await vscode.window.showInformationMessage(
    "Poly can format supported files on save. Enable format-on-save for Poly languages?",
    "Enable",
    "No",
  );
  if (pick !== "Enable") {
    return;
  }
  // Per-language so unrelated languages keep their own formatter (A8).
  const root = vscode.workspace.getConfiguration();
  for (const lang of FORMAT_ON_SAVE_LANGUAGES) {
    const section = `[${lang}]`;
    const current = root.get<Record<string, unknown>>(section) ?? {};
    await root.update(
      section,
      {
        ...current,
        "editor.defaultFormatter": "ricky.poly-lint",
        "editor.formatOnSave": true,
      },
      vscode.ConfigurationTarget.Global,
    );
  }
  vscode.window.setStatusBarMessage("Poly: format-on-save enabled", 5000);
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
    vscode.window.onDidChangeActiveTextEditor(() => refreshStatus()),
    vscode.commands.registerCommand("poly.showOutput", () => client?.outputChannel.show()),
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
    vscode.commands.registerCommand("poly.checkForUpdates", () => checkForUpdates(context, false)),
  );

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
  void promptFormatOnSave(context);
  scheduleUpdateCheck(context);
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

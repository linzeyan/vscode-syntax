/**
 * formulahendry.code-runner's `CodeManager` (0.12.2), method for method, under
 * poly's names: runs a file, a selection or a custom command, in the output
 * panel or a terminal, and stops what it started. What differs from upstream,
 * and why, is in README.md beside this file.
 */
import { ChildProcess, execFile, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import { dirname, extname, join } from "path";
import * as vscode from "vscode";

import { commandLine, Executor, fallbackPython, resolveExecutor } from "./executor";

const TmpDir = os.tmpdir();
const PYTHON = fallbackPython(process.platform);

/**
 * The executor for `document`, from its own `poly.codeRunner` settings.
 *
 * The run lens asks this too, so a lens offers `run` exactly where Run Code
 * would find something to run.
 */
export function executorFor(document: vscode.TextDocument, languageId?: string): Executor | undefined {
  const config = vscode.workspace.getConfiguration("poly.codeRunner", document.uri);
  return resolveExecutor(
    {
      respectShebang: config.get<boolean>("respectShebang", true),
      executorMapByGlob: config.get("executorMapByGlob"),
      executorMap: config.get("executorMap", {}),
      executorMapByFileExtension: config.get("executorMapByFileExtension", {}),
      defaultLanguage: config.get<string>("defaultLanguage", ""),
    },
    { languageId: document.languageId, fileName: document.fileName, firstLine: document.lineAt(0).text },
    languageId,
  );
}

export class CodeManager implements vscode.Disposable {
  // Made on first use rather than at activation, as upstream did: poly starts
  // with every window, and an empty "Code Runner" in the Output list of
  // someone who never turned it on is clutter they did not ask for.
  private _outputChannel: vscode.OutputChannel | undefined;
  private _terminal: vscode.Terminal | undefined;
  private _isRunning = false;
  private _process: ChildProcess | undefined;
  private _codeFile: string | undefined;
  private _isTmpFile = false;
  private _languageId = "";
  private _cwd = "";
  private _runFromExplorer = false;
  private _wholeFile = false;
  private _document: vscode.TextDocument | undefined;
  private _workspaceFolder: string | undefined;
  private _config!: vscode.WorkspaceConfiguration;

  public onDidCloseTerminal(terminal: vscode.Terminal): void {
    // Upstream forgot its terminal when any terminal closed, and opened a
    // second one on the next run while its own was still there.
    if (terminal === this._terminal) {
      this._terminal = undefined;
    }
  }

  /**
   * `wholeFile` is the run lens: the program under the button, whatever is
   * selected, saved first. A lens over `main` that ran the selection, or the
   * file as it was last saved, would look exactly like a change that did not
   * work.
   */
  public async run(languageId: string | null = null, fileUri?: vscode.Uri, wholeFile = false) {
    if (this._isRunning) {
      vscode.window.showInformationMessage("Code is already running!");
      return;
    }

    this._wholeFile = wholeFile;
    this._runFromExplorer = this.checkIsRunFromExplorer(fileUri);
    if (this._runFromExplorer) {
      this._document = await vscode.workspace.openTextDocument(fileUri!);
    } else {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        this._document = editor.document;
      } else {
        vscode.window.showInformationMessage("No code found or selected.");
        return;
      }
    }

    this.initialize();

    const fileExtension = extname(this._document.fileName);
    const executor = this.getExecutor(languageId);
    // undefined or null
    if (executor == null) {
      vscode.window.showInformationMessage("Code language not supported or defined.");
      return;
    }

    await this.getCodeFileAndExecute(fileExtension, executor);
  }

  public async runCustomCommand() {
    if (this._isRunning) {
      vscode.window.showInformationMessage("Code is already running!");
      return;
    }

    this._runFromExplorer = false;
    this._wholeFile = false;
    // Upstream kept the previous run's document, and its file, when no editor
    // was open, so `$fileName` named a file that was not in front of anyone.
    this._document = vscode.window.activeTextEditor?.document;
    this._codeFile = undefined;

    this.initialize();

    const executor = this._config.get<string>("customCommand", "");

    if (this._document) {
      const fileExtension = extname(this._document.fileName);
      await this.getCodeFileAndExecute(fileExtension, executor, false);
    } else {
      await this.executeCommand(executor, false);
    }
  }

  public async runByLanguage() {
    const config = vscode.workspace.getConfiguration("poly.codeRunner", vscode.window.activeTextEditor?.document.uri);
    const executorMap = config.get<Record<string, string>>("executorMap", {});
    const languageId = await vscode.window.showQuickPick(Object.keys(executorMap), {
      placeHolder: "Type or select language to run",
    });
    if (languageId !== undefined) {
      await this.run(languageId);
    }
  }

  public stop(): void {
    this.stopRunning();
  }

  public dispose() {
    this.stopRunning();
    // Closed with the extension rather than left behind: VSCode brings a
    // terminal back after a reload, and this would no longer know it and
    // open a second one beside it.
    this._terminal?.dispose();
    this._outputChannel?.dispose();
  }

  private checkIsRunFromExplorer(fileUri?: vscode.Uri): boolean {
    const editor = vscode.window.activeTextEditor;
    if (!fileUri || !fileUri.fsPath) {
      return false;
    }
    if (!editor) {
      return true;
    }
    if (fileUri.fsPath === editor.document.uri.fsPath) {
      return false;
    }
    return true;
  }

  private stopRunning() {
    if (this._isRunning) {
      this._isRunning = false;
      vscode.commands.executeCommand("setContext", "poly.codeRunner.codeRunning", false);
      if (this._process) {
        kill(this._process);
      }
    }
  }

  private initialize(): void {
    this._config = this.getConfiguration("poly.codeRunner");
    // Before `cwd`, not after: upstream returned early when `cwd` was set and
    // left `$workspaceRoot` to whatever folder the previous run had found.
    this._workspaceFolder = this.getWorkspaceFolder();
    this._cwd = this._config.get<string>("cwd", "");
    if (this._cwd) {
      return;
    }
    if (
      (this._config.get<boolean>("fileDirectoryAsCwd") || !this._workspaceFolder)
      && this._document && !this._document.isUntitled
    ) {
      this._cwd = dirname(this._document.fileName);
    } else {
      this._cwd = this._workspaceFolder ?? "";
    }
    if (this._cwd) {
      return;
    }
    this._cwd = TmpDir;
  }

  private getConfiguration(section?: string): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(section, this._document?.uri);
  }

  private getWorkspaceFolder(): string | undefined {
    if (vscode.workspace.workspaceFolders) {
      if (this._document) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(this._document.uri);
        if (workspaceFolder) {
          return workspaceFolder.uri.fsPath;
        }
      }
      return vscode.workspace.workspaceFolders[0].uri.fsPath;
    } else {
      return undefined;
    }
  }

  private async getCodeFileAndExecute(fileExtension: string, executor: string, appendFile = true): Promise<void> {
    const document = this._document!;
    const selection = vscode.window.activeTextEditor?.selection;
    const ignoreSelection = this._config.get<boolean>("ignoreSelection");
    const wholeFile = this._wholeFile || this._runFromExplorer || !selection || selection.isEmpty || ignoreSelection;

    if (wholeFile && !document.isUntitled) {
      this._isTmpFile = false;
      this._codeFile = document.fileName;

      if (this._config.get<boolean>("saveAllFilesBeforeRun")) {
        await vscode.workspace.saveAll();
      } else if (this._config.get<boolean>("saveFileBeforeRun") || (this._wholeFile && document.isDirty)) {
        await document.save();
      }
    } else {
      let text = wholeFile ? document.getText() : document.getText(selection);

      if (this._languageId === "php") {
        text = text.trim();
        if (!text.startsWith("<?php")) {
          text = "<?php\r\n" + text;
        }
      }

      this._isTmpFile = true;
      const folder = document.isUntitled ? this._cwd : dirname(document.fileName);
      this.createRandomFile(text, folder, fileExtension);
    }

    await this.executeCommand(executor, appendFile);
  }

  private rndName(): string {
    return Math.random().toString(36).replace(/[^a-z]+/g, "").substring(0, 10);
  }

  private createRandomFile(content: string, folder: string, fileExtension: string) {
    let fileType = "";
    const languageIdToFileExtensionMap = this._config.get<Record<string, string>>("languageIdToFileExtensionMap", {});
    if (this._languageId && languageIdToFileExtensionMap[this._languageId]) {
      fileType = languageIdToFileExtensionMap[this._languageId];
    } else {
      if (fileExtension) {
        fileType = fileExtension;
      } else {
        fileType = "." + this._languageId;
      }
    }
    const temporaryFileName = this._config.get<string>("temporaryFileName");
    const tmpFileNameWithoutExt = temporaryFileName ? temporaryFileName : "temp" + this.rndName();
    const tmpFileName = tmpFileNameWithoutExt + fileType;
    this._codeFile = join(folder, tmpFileName);
    fs.writeFileSync(this._codeFile, content);
  }

  private getExecutor(languageId: string | null): string | undefined {
    const found = executorFor(this._document!, languageId ?? undefined);
    this._languageId = found?.languageId ?? "";
    return found?.executor;
  }

  private async executeCommand(executor: string, appendFile = true) {
    if (this._config.get<boolean>("runInTerminal")) {
      await this.executeCommandInTerminal(executor, appendFile);
    } else {
      await this.executeCommandInOutputChannel(executor, appendFile);
    }
  }

  private async getFinalCommandToRunCodeFile(executor: string, appendFile = true): Promise<string> {
    const pythonPath = this._codeFile && executor.includes("$pythonPath")
      ? await getPythonPath(this._document)
      : PYTHON;
    return commandLine(executor, this._codeFile, { workspaceFolder: this._workspaceFolder, pythonPath }, appendFile);
  }

  private changeExecutorFromCmdToPs(executor: string): string {
    if (executor.includes(" && ") && this.isPowershellOnWindows()) {
      let replacement = "; if ($?) {";
      executor = executor.replace("&&", replacement);
      replacement = "} " + replacement;
      executor = executor.replace(/&&/g, replacement);
      executor = executor.replace(/\$dir\$fileNameWithoutExt/g, ".\\$fileNameWithoutExt");
      return executor + " }";
    }
    return executor;
  }

  private isPowershellOnWindows(): boolean {
    if (os.platform() === "win32") {
      const defaultProfile = vscode.workspace.getConfiguration("terminal").get<string>(
        "integrated.defaultProfile.windows",
      );
      if (defaultProfile) {
        if (defaultProfile.toLowerCase().includes("powershell")) {
          return true;
        } else if (defaultProfile === "Command Prompt") {
          return false;
        }
      }
      const windowsShell = vscode.env.shell;
      return !!windowsShell && windowsShell.toLowerCase().includes("powershell");
    }
    return false;
  }

  private changeFilePathForBashOnWindows(command: string): string {
    if (os.platform() === "win32") {
      const windowsShell = vscode.env.shell;
      const terminalRoot = this._config.get<string>("terminalRoot");
      if (windowsShell && terminalRoot) {
        command = command
          .replace(/([A-Za-z]):\\/g, (_match, p1: string) => `${terminalRoot}${p1.toLowerCase()}/`)
          .replace(/\\/g, "/");
      } else if (
        windowsShell && windowsShell.toLowerCase().indexOf("bash") > -1
        && windowsShell.toLowerCase().indexOf("windows") > -1
      ) {
        command = command.replace(/([A-Za-z]):\\/g, this.replacer).replace(/\\/g, "/");
      }
    }
    return command;
  }

  private replacer(_match: string, p1: string): string {
    return `/mnt/${p1.toLowerCase()}/`;
  }

  private async executeCommandInTerminal(executor: string, appendFile = true) {
    let isNewTerminal = false;
    if (this._terminal === undefined) {
      this._terminal = vscode.window.createTerminal("Code Runner");
      isNewTerminal = true;
    }
    this._terminal.show(this._config.get<boolean>("preserveFocus"));
    executor = this.changeExecutorFromCmdToPs(executor);
    let command = await this.getFinalCommandToRunCodeFile(executor, appendFile);
    command = this.changeFilePathForBashOnWindows(command);
    if (this._config.get<boolean>("clearPreviousOutput") && !isNewTerminal) {
      await vscode.commands.executeCommand("workbench.action.terminal.clear");
    }
    if (this._config.get<boolean>("fileDirectoryAsCwd")) {
      const cwd = this.changeFilePathForBashOnWindows(this._cwd);
      this._terminal.sendText(`cd "${cwd}"`);
    }
    this._terminal.sendText(command);
  }

  private async executeCommandInOutputChannel(executor: string, appendFile = true) {
    this._isRunning = true;
    vscode.commands.executeCommand("setContext", "poly.codeRunner.codeRunning", true);
    // The output panel colours `[Running]` and `[Done]` by this language's
    // grammar, which upstream reached by claiming every output panel's MIME
    // type for its own.
    const output = this._outputChannel ??= vscode.window.createOutputChannel("Code Runner", "poly-code-runner-output");
    const clearPreviousOutput = this._config.get<boolean>("clearPreviousOutput");
    if (clearPreviousOutput) {
      output.clear();
    }
    const showExecutionMessage = this._config.get<boolean>("showExecutionMessage");
    output.show(this._config.get<boolean>("preserveFocus"));
    const command = await this.getFinalCommandToRunCodeFile(executor, appendFile);
    if (showExecutionMessage) {
      output.appendLine("[Running] " + command);
    }
    const startTime = new Date();
    // Taken now: by the time the process closes, another run may have
    // replaced both, and the file deleted would be that run's.
    const codeFile = this._codeFile;
    const isTmpFile = this._isTmpFile;
    // Detached on Unix so the shell leads a process group of its own, which
    // is what `kill` signals. On Windows it would open a console window.
    const child = spawn(command, [], { cwd: this._cwd, shell: true, detached: process.platform !== "win32" });
    this._process = child;

    child.stdout?.on("data", (data) => {
      output.append(data.toString());
    });

    child.stderr?.on("data", (data) => {
      output.append(data.toString());
    });

    // Upstream had no handler, so a `cwd` that no longer exists threw inside
    // the extension host and the panel said nothing at all.
    child.on("error", (error) => {
      output.appendLine(String(error));
    });

    child.on("close", (code) => {
      this._isRunning = false;
      vscode.commands.executeCommand("setContext", "poly.codeRunner.codeRunning", false);
      const endTime = new Date();
      const elapsedTime = (endTime.getTime() - startTime.getTime()) / 1000;
      output.appendLine("");
      if (showExecutionMessage) {
        output.appendLine("[Done] exited with code=" + code + " in " + elapsedTime + " seconds");
        output.appendLine("");
      }
      if (isTmpFile && codeFile) {
        fs.rmSync(codeFile, { force: true });
      }
    });
  }
}

/**
 * Ends the shell and everything it started.
 *
 * Upstream uses tree-kill, which walks `ps` for the descendants on Unix. The
 * shell here leads its own process group (see `spawn` above), so one signal to
 * the group reaches the same processes. On Windows tree-kill runs
 * `taskkill /T`, and so does this.
 */
function kill(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

/** The part of ms-python.python's API `$pythonPath` reads. */
interface PythonApi {
  settings: {
    getExecutionDetails?(resource?: vscode.Uri): { execCommand?: string[] };
    getExecutionCommand?(resource?: vscode.Uri): string[] | undefined;
  };
}

/** Upstream's `Utility.getPythonPath`: the interpreter the Python extension has selected. */
async function getPythonPath(document: vscode.TextDocument | undefined): Promise<string> {
  try {
    const extension = vscode.extensions.getExtension<PythonApi>("ms-python.python");
    if (!extension) {
      return PYTHON;
    }
    const usingNewInterpreterStorage = extension.packageJSON?.featureFlags?.usingNewInterpreterStorage;
    if (usingNewInterpreterStorage) {
      if (!extension.isActive) {
        await extension.activate();
      }
      const settings = extension.exports.settings;
      const execCommand = settings.getExecutionDetails
        ? settings.getExecutionDetails(document?.uri).execCommand
        : settings.getExecutionCommand?.(document?.uri);
      return execCommand ? execCommand.join(" ") : PYTHON;
    } else {
      return vscode.workspace.getConfiguration("python", document?.uri).get<string>("pythonPath") ?? PYTHON;
    }
  } catch {
    return PYTHON;
  }
}

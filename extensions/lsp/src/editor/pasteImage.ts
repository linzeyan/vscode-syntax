/**
 * mushan.vscode-paste-image 1.0.4: the image on the clipboard saved as a file
 * beside the one being edited, and a link to it typed in.
 *
 * An extension cannot read an image off the clipboard, so upstream's scripts
 * do, one per platform (pasteImage/, laid out in `dist/paste-image/` by the
 * build). This is its `extension.js`; pasteImagePaths.ts is the part of it
 * that is only strings.
 */
import { spawn } from "child_process";
import { existsSync, promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { expand, imageFileName, imagePath, insertion, Markup, Settings } from "./pasteImagePaths";

const ROOT = path.join(__dirname, "paste-image");

/** The script for this platform, as upstream runs it. */
function script(image: string): [string, string[]] {
  if (process.platform === "win32") {
    const system = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    return [
      existsSync(system) ? system : "powershell",
      [
        "-noprofile",
        "-noninteractive",
        "-nologo",
        "-sta",
        "-executionpolicy",
        "unrestricted",
        "-windowstyle",
        "hidden",
        "-file",
        path.join(ROOT, "pc.ps1"),
        image,
      ],
    ];
  }
  if (process.platform === "darwin") return ["osascript", [path.join(ROOT, "mac.applescript"), image]];
  return ["sh", [path.join(ROOT, "linux.sh"), image]];
}

/**
 * Has the script write the clipboard's image to `image`, and resolves to what
 * it printed: the path when it wrote one. All of it, once the script is done:
 * upstream took the first chunk of output, which is not always all of it.
 */
function saveClipboard(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let printed = "";
    child.stdout.on("data", (chunk) => (printed += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(printed.trim()));
  });
}

async function paste(markupOf: (languageId: string) => Markup) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const { document } = editor;
  if (document.isUntitled) {
    void vscode.window.showInformationMessage(
      "Save this file before pasting an image into it: the image goes beside it.",
    );
    return;
  }
  const selection = document.getText(editor.selection);
  if (/[\\:*?<>|]/.test(selection)) {
    void vscode.window.showInformationMessage("The selection cannot be a file name: it has one of \\ : * ? < > |.");
    return;
  }
  const file = document.uri.fsPath;
  // The file's own folder, where upstream read `workspace.rootPath`: the
  // first folder of a multi-root workspace, and the string "undefined" --
  // made into a folder -- with none open.
  const projectRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(file);
  let settings: Settings;
  try {
    settings = expand(vscode.workspace.getConfiguration("poly").get<Settings>("pasteImage")!, file, projectRoot);
  } catch (error) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return;
  }

  const name = imageFileName(settings, selection, new Date());
  let image = imagePath(settings, file, name);
  if (settings.showFilePathConfirmInputBox) {
    const onlyName = settings.filePathConfirmInputBoxMode === "onlyName";
    let answer = await vscode.window.showInputBox({
      prompt: "Please specify the filename of the image.",
      value: onlyName ? name : image,
    });
    if (!answer) return;
    if (!answer.endsWith(".png")) answer += ".png";
    // A relative answer is from the file's folder; upstream took it from the
    // editor's working directory, which is `/` on a Mac.
    image = onlyName ? imagePath(settings, file, answer) : path.resolve(path.dirname(file), answer);
  }
  if (existsSync(image)) {
    const choice = await vscode.window.showInformationMessage(`${image} exists. Replace it?`, "Replace", "Cancel");
    if (choice !== "Replace") return;
  }

  try {
    await fs.mkdir(path.dirname(image), { recursive: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Could not make the image's folder (poly.pasteImage.path): ${reason}`);
    return;
  }
  const [command, args] = script(image);
  let printed: string;
  try {
    printed = await saveClipboard(command, args);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? `${command} is not on PATH.`
      : error instanceof Error
      ? error.message
      : String(error);
    void vscode.window.showErrorMessage(`Could not read the clipboard: ${reason}`);
    return;
  }
  if (printed === "no image") {
    void vscode.window.showInformationMessage("There is no image on the clipboard.");
    return;
  }
  if (printed === "no xclip") {
    void vscode.window.showInformationMessage("Pasting an image needs xclip. Install it and paste again.");
    return;
  }
  if (!printed) {
    // The AppleScript prints nothing when it cannot write the file, and
    // upstream then did nothing at all.
    void vscode.window.showErrorMessage(`Could not write ${image}.`);
    return;
  }

  const text = insertion(settings, markupOf(document.languageId), image);
  await editor.edit((edit) => {
    const current = editor.selection;
    if (current.isEmpty) edit.insert(current.start, text);
    else edit.replace(current, text);
  });
}

export function registerPasteImage(context: vscode.ExtensionContext, isMarkdown: (languageId: string) => boolean) {
  // Upstream's markdown syntax was for the `markdown` id alone, and the
  // markdown-like ids VSCode gives agent and prompt files got a bare path.
  const markupOf = (languageId: string): Markup =>
    isMarkdown(languageId) ? "markdown" : languageId === "asciidoc" ? "asciidoc" : undefined;
  context.subscriptions.push(vscode.commands.registerCommand("poly.pasteImage", () => paste(markupOf)));
}

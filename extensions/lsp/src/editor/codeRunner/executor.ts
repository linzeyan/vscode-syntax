/**
 * Code Runner's answer to "how is this file run", with nothing of the editor in
 * it: which executor applies to a file, and the command line it becomes.
 *
 * Both halves are upstream's `CodeManager.getExecutor` and
 * `getFinalCommandToRunCodeFile`, lifted out of the class so that the run lens
 * asks the same question Code Runner's own commands do. There is one table of
 * how to run a file -- the executor maps in `poly.codeRunner.*` -- and this is
 * the only code that reads it.
 */
import { basename, extname } from "path";

// micromatch's `isMatch` is `picomatch(patterns, options)(str)`, so this is
// upstream's glob matching without the half of micromatch it never called.
const picomatch: (glob: string) => (input: string) => boolean = require("picomatch");

/** The settings resolution reads, as `poly.codeRunner` has them for one file. */
export interface ExecutorSettings {
  readonly respectShebang: boolean;
  readonly executorMapByGlob?: Readonly<Record<string, string>>;
  readonly executorMap: Readonly<Record<string, string>>;
  readonly executorMapByFileExtension: Readonly<Record<string, string>>;
  readonly defaultLanguage: string;
}

/** The file being asked about. `firstLine` is where a shebang would be. */
export interface RunnableFile {
  readonly languageId: string;
  readonly fileName: string;
  readonly firstLine: string;
}

export interface Executor {
  readonly executor: string;
  /**
   * What the executor was found under: the language id, or the file extension
   * when `executorMapByFileExtension` answered. The temporary file a selection
   * is written to takes its extension from this.
   */
  readonly languageId: string;
}

/**
 * The executor for `file`, or nothing where no map has one.
 *
 * In upstream's order: the shebang (unless a language was picked by hand),
 * the first glob that matches the file's name, the language id, the file
 * extension, and last the default language. `== null` rather than a falsy
 * test throughout, as upstream: an empty string in a map is an executor.
 */
export function resolveExecutor(
  settings: ExecutorSettings,
  file: RunnableFile,
  chosenLanguageId?: string,
): Executor | undefined {
  let languageId = chosenLanguageId ?? file.languageId;
  let executor: string | undefined;

  // `#![...]` is a Rust inner attribute, not a shebang.
  if (chosenLanguageId === undefined && settings.respectShebang && /^#!(?!\[)/.test(file.firstLine)) {
    executor = file.firstLine.slice(2);
  }

  if (executor == null && settings.executorMapByGlob) {
    const name = basename(file.fileName);
    const glob = Object.keys(settings.executorMapByGlob).find((one) => picomatch(one)(name));
    if (glob !== undefined) {
      executor = settings.executorMapByGlob[glob];
    }
  }

  if (executor == null) {
    executor = settings.executorMap?.[languageId];
  }

  const extension = extname(file.fileName);
  if (executor == null && extension) {
    executor = settings.executorMapByFileExtension?.[extension];
    if (executor != null) {
      languageId = extension;
    }
  }

  if (executor == null) {
    languageId = settings.defaultLanguage;
    executor = settings.executorMap?.[languageId];
  }

  return executor == null ? undefined : { executor, languageId };
}

/**
 * What `$pythonPath` is without the Python extension to ask.
 *
 * Upstream's is `python`, which neither macOS nor most Linux distributions
 * install any more. `python3` is the name that means Python 3 everywhere but
 * Windows, where the installer writes `python` and `python3` is a Store stub
 * that opens the Store.
 */
export function fallbackPython(platform: string): string {
  return platform === "win32" ? "python" : "python3";
}

/**
 * What a placeholder is replaced with, besides the file itself.
 *
 * `workspaceFolder` is the folder the file is in, or nothing outside one;
 * `pythonPath` is only asked for when the executor names it, because finding
 * it can mean activating the Python extension.
 */
export interface CommandContext {
  readonly workspaceFolder?: string;
  readonly pythonPath: string;
}

/**
 * The command line that runs `codeFile` with `executor`.
 *
 * An executor with a placeholder in it says where the file goes; one without
 * gets the quoted file appended. The order of the replacements is upstream's
 * and matters: `$fileNameWithoutExt` before `$fileName`,
 * `$dirWithoutTrailingSlash` before `$dir`. `codeFile` is absent only for a
 * custom command run with no editor open, which is left as written.
 */
export function commandLine(
  executor: string,
  codeFile: string | undefined,
  context: CommandContext,
  appendFile = true,
): string {
  let cmd = executor;
  if (codeFile) {
    const dir = fileDir(codeFile);
    const placeholders: [RegExp, string][] = [
      [/\$workspaceRoot/g, context.workspaceFolder ? context.workspaceFolder : dir],
      [/\$fileNameWithoutExt/g, fileNameWithoutExt(codeFile)],
      [/\$fullFileName/g, quote(codeFile)],
      [/\$fileName/g, baseName(codeFile)],
      [/\$driveLetter/g, driveLetter(codeFile)],
      [/\$dirWithoutTrailingSlash/g, quote(dir.replace(/[\/\\]$/, ""))],
      [/\$dir/g, quote(dir)],
      [/\$pythonPath/g, context.pythonPath],
    ];
    for (const [regex, value] of placeholders) {
      // A function, so that a `$&` or `$1` in a path is not read as a pattern.
      cmd = cmd.replace(regex, () => value);
    }
  }
  return cmd !== executor ? cmd : executor + (appendFile ? " " + quote(codeFile ?? "") : "");
}

/** The file name without its directory. */
function baseName(file: string): string {
  return file.match(/.*[\/\\](.*)/)?.[1] ?? file;
}

/** The file name without its directory or its last extension. */
function fileNameWithoutExt(file: string): string {
  return file.match(/.*[\/\\](.*(?=\..*))/)?.[1] ?? file;
}

/** The file's directory, with its trailing separator. */
function fileDir(file: string): string {
  return file.match(/(.*[\/\\]).*/)?.[1] ?? file;
}

/** `C:` on Windows; elsewhere the placeholder stays, as upstream leaves it. */
function driveLetter(file: string): string {
  return file.match(/^([A-Za-z]:).*/)?.[1] ?? "$driveLetter";
}

function quote(file: string): string {
  return `"${file}"`;
}

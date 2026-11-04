/**
 * Runs the diff viewer `poly.gitHistory.diffViewer` names over one file of the
 * Changes tab: difftastic over the file's two sides, delta over its patch.
 *
 * Both are the user's own installs, looked up on the PATH of the machine the
 * extension host runs on -- in a remote window, the remote one. One file at a
 * time, asked for by the page as the file scrolls near, because a page of
 * history is dozens of files and each run is a process.
 */
import { execFile } from "child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { Git } from "./gitGraphData";
import { type FilePatch, UNCOMMITTED } from "./gitGraphProtocol";
import { type DifftJson, type DifftView, difftView, type DiffViewer } from "./gitGraphViewers";

export type RenderFile = FilePatch & { from: string; to: string };

export type Rendered = { viewer: "difftastic"; view: DifftView } | { viewer: "delta"; ansi: string };

const PROGRAMS: Record<Exclude<DiffViewer, "builtin">, { command: string; name: string; url: string }> = {
  difftastic: { command: "difft", name: "difftastic", url: "https://github.com/Wilfred/difftastic" },
  delta: { command: "delta", name: "delta", url: "https://github.com/dandavison/delta" },
};

/** Rows per file, as the builtin view sends lines (PATCH_LINES). */
const MAX_ROWS = 500;

/** A tool not on the PATH, told apart from one that ran and failed. */
export class MissingTool extends Error {}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      // A file difftastic gives up on falls back to a line diff on its own;
      // the timeout is for a run that hangs, not for a slow one.
      { cwd, env, encoding: "utf8", maxBuffer: 1 << 26, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (!error) resolve(stdout);
        else if ((error as NodeJS.ErrnoException).code === "ENOENT") reject(new MissingTool(command));
        else reject(new Error(stderr.trim() || error.message));
      },
    );
    child.stdin?.on("error", () => {}); // A tool that exits before reading all of it.
    child.stdin?.end(input);
  });
}

/**
 * At most a few tools at once: scrolling fast through a long history asks
 * for many files together, and each is a process plus, for difftastic, a parse.
 */
const LIMIT = 4;
let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (running >= LIMIT) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** The file's two sides as text; empty where it does not exist, as on the far side of an addition. */
function sides(git: Git, repo: string, file: RenderFile): Promise<[string, string]> {
  const added = file.type === "A" || file.type === "U" || !file.from;
  return Promise.all([
    added ? "" : git(["show", `${file.from}:${file.oldPath}`]),
    file.type === "D"
      ? ""
      : file.to === UNCOMMITTED
      ? readFile(path.join(repo, file.newPath), "utf8")
      : git(["show", `${file.to}:${file.newPath}`]),
  ]);
}

async function difftastic(git: Git, repo: string, file: RenderFile): Promise<DifftView> {
  const [oldText, newText] = await sides(git, repo, file);
  const dir = await mkdtemp(path.join(os.tmpdir(), "poly-difft-"));
  try {
    // difftastic picks the language from the file name, so each side keeps
    // its own. An absent side is an empty file rather than /dev/null, which
    // Windows does not have; the rows come out the same.
    const a = path.join(dir, "a", path.basename(file.oldPath));
    const b = path.join(dir, "b", path.basename(file.newPath));
    await Promise.all([mkdir(path.dirname(a)), mkdir(path.dirname(b))]);
    await Promise.all([writeFile(a, oldText), writeFile(b, newText)]);
    // JSON output is behind DFT_UNSTABLE: its shape may change between
    // releases, which gitGraphViewers.ts's tests pin for the one measured.
    const out = await run(PROGRAMS.difftastic.command, ["--display", "json", a, b], repo, {
      ...process.env,
      DFT_UNSTABLE: "yes",
    });
    return difftView(JSON.parse(out) as DifftJson, oldText, newText, 3, MAX_ROWS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * delta over the file's patch as the page already has it, given the headers
 * delta reads the language from. The user's own delta settings in git config
 * apply (side-by-side, line numbers, theme); the file header is left out,
 * as the page draws its own, and light or dark follows the editor's theme
 * rather than a terminal delta cannot see.
 */
function delta(repo: string, file: RenderFile, columns: number, dark: boolean): Promise<string> {
  const added = file.type === "A" || file.type === "U";
  const patch = [
    `diff --git a/${file.oldPath} b/${file.newPath}`,
    `--- ${added ? "/dev/null" : `a/${file.oldPath}`}`,
    `+++ ${file.type === "D" ? "/dev/null" : `b/${file.newPath}`}`,
    ...file.lines,
    "",
  ].join("\n");
  return run(
    PROGRAMS.delta.command,
    [
      "--paging=never",
      `--width=${Math.max(40, Math.floor(columns))}`,
      "--true-color=always",
      "--file-style=omit",
      "--file-decoration-style=none",
      dark ? "--dark" : "--light",
    ],
    repo,
    process.env,
    patch,
  );
}

export async function render(
  viewer: Exclude<DiffViewer, "builtin">,
  git: Git,
  repo: string,
  file: RenderFile,
  columns: number,
  dark: boolean,
): Promise<Rendered> {
  try {
    return await limited(async () =>
      viewer === "difftastic"
        ? { viewer, view: await difftastic(git, repo, file) }
        : { viewer, ansi: await delta(repo, file, columns, dark) }
    );
  } catch (error) {
    if (error instanceof MissingTool) {
      const { command, name, url } = PROGRAMS[viewer];
      throw new Error(
        `${command} was not found on this machine's PATH, so this is git's diff. Install ${name} (${url}), or set poly.gitHistory.diffViewer to builtin.`,
      );
    }
    throw error;
  }
}

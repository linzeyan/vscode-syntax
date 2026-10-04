/**
 * The Git History panel and what its menus do, loaded the first time any of it
 * is used (gitGraph.ts registers the commands and hands them here).
 *
 * The page asks and draws; everything that touches git happens here. Menus
 * are VSCode's own webview context menus, declared in the manifest and keyed
 * on the `data-vscode-context` the page puts on each row and label, so they
 * look, read and navigate like every other menu in the editor -- and are
 * translated with it. Where Git Graph opens a form, this asks the same
 * questions as a short run of quick picks, with Git Graph's answers as the
 * first choice each time.
 */
import { randomBytes } from "crypto";
import MarkdownIt from "markdown-it";
import { full as emoji } from "markdown-it-emoji";
import * as path from "path";
import * as vscode from "vscode";

import { repositoriesOnDisk } from "./gitGraph";
import * as act from "./gitGraphActions";
import {
  commitDetails,
  comparison,
  type Git,
  gitIn,
  loadGraph,
  remotesOf,
  stashDetails,
  tagDetails,
  uncommittedChanges,
} from "./gitGraphData";
import {
  type CommitDetails,
  DEFAULT_VIEW,
  type FileChange,
  type Remote,
  UNCOMMITTED,
  type ViewOptions,
} from "./gitGraphProtocol";

const VIEW_TYPE = "poly.gitGraph";
const INITIAL = 300;
const MORE = 100;

/** As much of the built-in git extension's API as the panel uses. */
interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly onDidChange: vscode.Event<void> };
}
interface GitApi {
  readonly git: { readonly path: string };
  readonly state: "uninitialized" | "initialized";
  readonly onDidChangeState: vscode.Event<string>;
  readonly repositories: readonly Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}

async function gitApi(): Promise<GitApi> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
  let api: GitApi;
  try {
    if (!extension) throw new Error("the built-in Git extension is disabled");
    const exports = extension.isActive ? extension.exports : await extension.activate();
    // Without git on the machine, or with git.enabled off, the built-in
    // extension starts anyway and only `getAPI` throws.
    api = exports.getAPI(1);
  } catch (error) {
    log?.info(`Git History: no git to run (${error instanceof Error ? error.message : error}); reading with poly`);
    readOnly = true;
    return onDisk();
  }
  if (api.state !== "initialized") {
    await new Promise<void>((resolve) => {
      const listening = api.onDidChangeState((state) => {
        if (state === "initialized") {
          listening.dispose();
          resolve();
        }
      });
    });
  }
  return api;
}

/**
 * The repositories vscode.git would have offered, found on disk instead, each
 * refreshed by any change under it in the workspace.
 *
 * ponytail: found once, on first use; and a repository whose root is above
 * the workspace hears only of changes inside the workspace, so a commit made
 * from a terminal shows on the next save or refresh.
 */
function onDisk(): GitApi {
  const changed = new vscode.EventEmitter<string>();
  const watcher = vscode.workspace.createFileSystemWatcher("**");
  for (const event of [watcher.onDidChange, watcher.onDidCreate, watcher.onDidDelete]) {
    event((uri) => changed.fire(uri.fsPath));
  }
  const never = new vscode.EventEmitter<never>().event;
  return {
    git: { path: "" },
    state: "initialized",
    onDidChangeState: never,
    repositories: repositoriesOnDisk().map((root) => ({
      rootUri: vscode.Uri.file(root),
      state: {
        onDidChange: (listener, thisArgs, disposables) =>
          changed.event(
            (file) => (file === root || file.startsWith(root + path.sep)) && listener.call(thisArgs),
            undefined,
            disposables,
          ),
      },
    })),
    onDidOpenRepository: never,
    onDidCloseRepository: never,
  };
}

/** What a menu command is handed: the `data-vscode-context` of what was right-clicked, merged up to the page. */
interface Context {
  repo: string;
  hash?: string;
  subject?: string;
  parents?: string[];
  branch?: string;
  remoteBranch?: string;
  remote?: string;
  tag?: string;
  selector?: string;
  base?: string;
  path?: string;
  oldPath?: string;
  type?: FileChange["type"];
  from?: string;
  to?: string;
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(emoji);
const short = (hash: string) => (hash === UNCOMMITTED ? "Working Tree" : hash.slice(0, 7));

let api: GitApi | undefined;
let starting: Promise<GitApi> | undefined;
const ready = async () => (api ??= await (starting ??= gitApi()));
let log: vscode.LogOutputChannel | undefined;
let poly = "poly";
/**
 * Set where there is no git to run: poly answers the same questions with the
 * same output (`poly git`, held to git by tools/git-embed-check.js), and
 * nothing that would need git -- changing the repository, archiving, a diff
 * tool -- is offered.
 */
let readOnly = false;
const gitAt = (repo: string): Git => (readOnly ? gitIn(poly, repo, ["git"]) : gitIn(api?.git.path || "git", repo));

/** The commands that only read, copy or arrange the panel: all that runs without git. */
export const READS = new Set([
  "view",
  "copyHash",
  "copySubject",
  "createPullRequest",
  "filterToBranch",
  "copyBranchName",
  "viewTag",
  "copyTagName",
  "copyStashName",
  "viewDiff",
  "viewDiffWithWorkingFile",
  "viewFileAtRevision",
  "openFile",
  "copyFilePath",
  "copyRelativeFilePath",
  "toggleDate",
  "toggleAuthor",
  "toggleCommit",
]);

function needsGit(): void {
  void vscode.window.showErrorMessage(
    "Git History: this needs git, which was not found. Install git, or point git.path at it, then reload the window.",
  );
}

/** A diff side: a file as it is in `ref`, or nothing at all when `ref` is empty. */
function revisionUri(repo: string, ref: string, file: string): vscode.Uri {
  return vscode.Uri.file(path.join(repo, file)).with({
    scheme: "poly-git",
    query: JSON.stringify({ repo, ref, path: file }),
  });
}

/** Content for a `poly-git:` side; empty where the file does not exist, as on the far side of an addition. */
export async function content(uri: vscode.Uri, polyPath: string): Promise<string> {
  poly = polyPath;
  const { repo, ref, path: file } = JSON.parse(uri.query) as { repo: string; ref: string; path: string };
  if (!ref) return "";
  await ready();
  return await gitAt(repo)(["show", `${ref}:${file}`]).catch(() => "");
}

class GraphPanel {
  static current: GraphPanel | undefined;

  repo: string | undefined;
  private count = INITIAL;
  private stale = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watching = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, readonly panel: vscode.WebviewPanel) {
    const webview = panel.webview;
    const dist = vscode.Uri.joinPath(context.extensionUri, "dist", "git-graph");
    const nonce = randomBytes(16).toString("base64");
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(dist, "gitGraph.css"))}">
</head>
<body>
<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(dist, "gitGraph.js"))}"></script>
</body>
</html>`;
    this.disposables.push(
      webview.onDidReceiveMessage((message) => this.receive(message)),
      panel.onDidDispose(() => this.dispose()),
      // Changes while hidden are caught up on when it shows again, rather than
      // re-reading the history on every save into a page nobody is looking at.
      panel.onDidChangeViewState(() => {
        if (panel.visible && this.stale) this.refresh();
      }),
      api!.onDidOpenRepository(() => this.watch()),
      api!.onDidCloseRepository(() => this.watch()),
    );
    this.watch();
  }

  /** Follows every repository's state, so a commit or checkout made anywhere shows here. */
  private watch(): void {
    const roots = new Set(api!.repositories.map((repo) => repo.rootUri.fsPath));
    for (const [root, listener] of this.watching) {
      if (!roots.has(root)) {
        listener.dispose();
        this.watching.delete(root);
      }
    }
    for (const repo of api!.repositories) {
      const root = repo.rootUri.fsPath;
      if (!this.watching.has(root)) {
        this.watching.set(root, repo.state.onDidChange(() => root === this.repo && this.refresh()));
      }
    }
    void this.post({ type: "repos", repos: this.repos() });
  }

  repos(): string[] {
    return api!.repositories.map((repo) => repo.rootUri.fsPath).sort();
  }

  private post(message: unknown): Thenable<boolean> {
    return this.panel.webview.postMessage(message);
  }

  private views(): Record<string, ViewOptions> {
    return this.context.workspaceState.get<Record<string, ViewOptions>>("poly.gitGraph.views", {});
  }

  view(repo = this.repo): ViewOptions {
    return { ...DEFAULT_VIEW, ...repo ? this.views()[repo] : {} };
  }

  setView(view: ViewOptions): void {
    if (!this.repo) return;
    void this.context.workspaceState.update("poly.gitGraph.views", { ...this.views(), [this.repo]: view });
    this.count = INITIAL;
    void this.load();
  }

  open(repo: string | undefined): void {
    const repos = this.repos();
    const remembered = this.context.workspaceState.get<string>("poly.gitGraph.repo");
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const containing = active
      ? repos.filter((root) => active.startsWith(root + path.sep)).sort((a, b) => b.length - a.length)[0]
      : undefined;
    const chosen = [repo, this.repo, remembered, containing, repos[0]].find((root) => root && repos.includes(root));
    if (chosen !== this.repo) {
      this.repo = chosen;
      this.count = INITIAL;
      if (chosen) void this.context.workspaceState.update("poly.gitGraph.repo", chosen);
    }
    void this.load();
  }

  /** Reads again after a change, debounced: one checkout fires several. */
  refresh(): void {
    if (!this.panel.visible) {
      this.stale = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.load(), 250);
  }

  async load(): Promise<void> {
    this.stale = false;
    const repo = this.repo;
    const repos = this.repos();
    if (!repo) {
      await this.post({ type: "graph", repos, repo: undefined });
      return;
    }
    await this.post({ type: "busy", on: true });
    const view = this.view(repo);
    const git = gitAt(repo);
    try {
      const [graph, remotes, diffTool] = await Promise.all([
        loadGraph(git, view, this.count),
        remotesOf(git),
        git(["config", "--get", "diff.tool"]).then((tool) => tool.trim() !== "", () => false),
      ]);
      if (repo !== this.repo) return;
      await this.post({
        type: "graph",
        repos,
        repo,
        view,
        graph,
        subjects: graph.commits.map((commit) => md.renderInline(commit.subject)),
        remotes: remotes.map((remote) => ({ name: remote.name, pr: act.pullRequestUrl(remote, "") !== undefined })),
        diffTool,
        git: !readOnly,
        columns: this.context.globalState.get("poly.gitGraph.columns"),
      });
    } catch (error) {
      await this.post({ type: "error", message: String(error instanceof Error ? error.message : error) });
    }
  }

  private async receive(message: { type: string; [key: string]: unknown }): Promise<void> {
    const repo = this.repo;
    switch (message.type) {
      case "ready":
        return this.load();
      case "repo":
        return this.open(message.repo as string);
      case "view":
        return this.setView(message.view as ViewOptions);
      case "more":
        this.count += MORE;
        return this.load();
      case "refresh":
        return this.load();
      case "columns":
        void this.context.globalState.update("poly.gitGraph.columns", message.columns);
        return;
      // The page offers none of these without git; this is the backstop.
      case "fetch":
        if (readOnly) return needsGit();
        if (repo) await fetchAll(repo);
        return;
      case "remotes":
        if (readOnly) return needsGit();
        if (repo) await manageRemotes(repo);
        return;
      case "checkout":
        if (readOnly) return needsGit();
        if (repo) {
          await attempt(
            repo,
            `Checking out ${message.branch}`,
            (git) => act.checkoutBranch(git, message.branch as string),
          );
        }
        return;
      case "details":
        if (repo) {
          await this.details(
            repo,
            message.hash as string,
            message.stash as { base: string; untracked?: string } | undefined,
          );
        }
        return;
      case "compare":
        if (repo) await this.compare(repo, message.from as string, message.to as string);
        return;
      case "open":
        if (repo) await openDiff({ ...(message.file as Omit<Context, "repo">), repo });
        return;
    }
  }

  private async details(repo: string, hash: string, stash?: { base: string; untracked?: string }): Promise<void> {
    const git = gitAt(repo);
    try {
      let details: CommitDetails | undefined;
      let files: (FileChange & { from: string; to: string })[];
      if (hash === UNCOMMITTED) {
        files = (await uncommittedChanges(git)).map((file) => ({ ...file, from: "HEAD", to: UNCOMMITTED }));
      } else if (stash) {
        details = await stashDetails(git, hash, stash.base, stash.untracked);
        files = details.files.map((file) => ({
          ...file,
          from: file.type === "U" ? "" : stash.base,
          to: file.type === "U" ? stash.untracked! : hash,
        }));
      } else {
        details = await commitDetails(git, hash);
        const parent = details.parents[0] ?? "";
        files = details.files.map((file) => ({ ...file, from: parent, to: hash }));
      }
      await this.post({
        type: "details",
        hash,
        details,
        files,
        message: details ? md.render(details.body) : undefined,
      });
    } catch (error) {
      await this.post({ type: "details", hash, error: String(error instanceof Error ? error.message : error) });
    }
  }

  private async compare(repo: string, from: string, to: string): Promise<void> {
    try {
      const files = (await comparison(gitAt(repo), from, to)).map((file) => ({ ...file, from, to }));
      await this.post({ type: "compare", from, to, files });
    } catch (error) {
      await this.post({ type: "compare", from, to, error: String(error instanceof Error ? error.message : error) });
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    GraphPanel.current = undefined;
    this.watching.forEach((listener) => listener.dispose());
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}

/** Opens the panel, or brings it forward, on `repo` or the one it last showed. */
async function show(context: vscode.ExtensionContext, repo?: string): Promise<void> {
  await ready();
  if (!GraphPanel.current) {
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Git History", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist", "git-graph")],
    });
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, "media", "git-graph-light.svg"),
      dark: vscode.Uri.joinPath(context.extensionUri, "media", "git-graph-dark.svg"),
    };
    GraphPanel.current = new GraphPanel(context, panel);
  } else {
    GraphPanel.current.panel.reveal();
  }
  GraphPanel.current.open(repo);
}

const refreshAfter = () => GraphPanel.current?.refresh();

/**
 * Runs `work` with progress shown and its failure reported in git's own
 * words. Network work gets a notification, which can be watched; the rest
 * the status bar's spinner, which is all a local `git branch` deserves.
 */
async function attempt(
  repo: string,
  title: string,
  work: (git: Git) => Promise<unknown>,
  network = false,
): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      { location: network ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window, title },
      () => work(gitAt(repo)),
    );
    return true;
  } catch (error) {
    const text = String(error instanceof Error ? error.message : error);
    log?.warn(`Git History: ${title}: ${text}`);
    void vscode.window.showErrorMessage(`${title} failed: ${text}`);
    return false;
  } finally {
    refreshAfter();
  }
}

type Choice<T> = vscode.QuickPickItem & { value: T };

async function pick<T>(title: string, choices: Choice<T>[]): Promise<T | undefined> {
  return (await vscode.window.showQuickPick(choices, { title, ignoreFocusOut: true }))?.value;
}

async function pickMany<T>(title: string, choices: Choice<T>[]): Promise<T[] | undefined> {
  const picked = await vscode.window.showQuickPick(choices, { title, canPickMany: true, ignoreFocusOut: true });
  return picked?.map((choice) => choice.value);
}

function askName(title: string, value = ""): Thenable<string | undefined> {
  return vscode.window.showInputBox({ title, value, ignoreFocusOut: true, validateInput: act.refNameProblem });
}

async function confirm(message: string, detail: string, action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
}

function remotes(repo: string): Promise<Remote[]> {
  return remotesOf(gitAt(repo));
}

/** One remote chosen; asks only when there is more than one. */
async function pickRemote(repo: string, title: string): Promise<string | undefined> {
  const names = (await remotes(repo)).map((remote) => remote.name);
  if (names.length <= 1) return names[0];
  return pick(title, names.map((name) => ({ label: name, value: name })));
}

async function fetchAll(repo: string): Promise<void> {
  await attempt(
    repo,
    "Fetching from all remotes",
    (git) => act.fetch(git, undefined, { prune: false, pruneTags: false }),
    true,
  );
}

async function manageRemotes(repo: string): Promise<void> {
  const known = await remotes(repo);
  const chosen = await pick<Remote | "add">("Remotes", [
    ...known.map((remote) => ({
      label: `$(cloud) ${remote.name}`,
      description: remote.url,
      detail: remote.pushUrl ? `push: ${remote.pushUrl}` : undefined,
      value: remote,
    })),
    { label: "$(add) Add Remote…", value: "add" as const },
  ]);
  if (!chosen) return;
  if (chosen === "add") {
    const name = await askName("Add Remote: name", known.length === 0 ? "origin" : "");
    if (!name) return;
    const url = await vscode.window.showInputBox({
      title: `Add Remote "${name}": fetch URL`,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Enter a URL"),
    });
    if (!url) return;
    const pushUrl = await vscode.window.showInputBox({
      title: `Add Remote "${name}": push URL`,
      prompt: "Leave empty to push to the fetch URL",
      ignoreFocusOut: true,
    });
    if (pushUrl === undefined) return;
    const then = await pick("After adding", [
      { label: "Add and Fetch", value: true },
      { label: "Add", value: false },
    ]);
    if (then === undefined) return;
    await attempt(repo, `Adding remote ${name}`, async (git) => {
      await act.addRemote(git, name, url.trim(), pushUrl.trim() || undefined);
      if (then) await act.fetch(git, name, { prune: false, pruneTags: false });
    }, then);
    return;
  }
  const remote = chosen;
  const action = await pick(`Remote ${remote.name}`, [
    { label: "$(repo-fetch) Fetch", value: "fetch" },
    { label: "$(repo-fetch) Fetch and Prune", description: "--prune", value: "fetch-prune" },
    {
      label: "$(trash) Prune",
      description: "Remove remote-tracking branches that no longer exist on the remote",
      value: "prune",
    },
    { label: "$(edit) Edit…", value: "edit" },
    { label: "$(remove) Delete…", value: "delete" },
  ]);
  switch (action) {
    case "fetch":
    case "fetch-prune":
      await attempt(
        repo,
        `Fetching from ${remote.name}`,
        (git) => act.fetch(git, remote.name, { prune: action === "fetch-prune", pruneTags: false }),
        true,
      );
      return;
    case "prune":
      await attempt(repo, `Pruning ${remote.name}`, (git) => act.pruneRemote(git, remote.name), true);
      return;
    case "delete":
      if (
        await confirm(`Delete remote ${remote.name}?`, "Its remote-tracking branches are deleted with it.", "Delete")
      ) {
        await attempt(repo, `Deleting remote ${remote.name}`, (git) => act.deleteRemote(git, remote.name));
      }
      return;
    case "edit": {
      const name = await askName(`Edit Remote ${remote.name}: name`, remote.name);
      if (!name) return;
      const url = await vscode.window.showInputBox({
        title: `Edit Remote ${name}: fetch URL`,
        value: remote.url,
        ignoreFocusOut: true,
      });
      if (!url) return;
      const pushUrl = await vscode.window.showInputBox({
        title: `Edit Remote ${name}: push URL`,
        value: remote.pushUrl ?? "",
        prompt: "Leave empty to push to the fetch URL",
        ignoreFocusOut: true,
      });
      if (pushUrl === undefined) return;
      await attempt(
        repo,
        `Editing remote ${remote.name}`,
        (git) => act.editRemote(git, remote, { name, url: url.trim(), pushUrl: pushUrl.trim() || undefined }),
      );
      return;
    }
  }
}

async function openDiff(ctx: Context): Promise<void> {
  const { repo, from = "", to = "", type } = ctx;
  const oldPath = ctx.oldPath ?? ctx.path!;
  const newPath = ctx.path!;
  const left = revisionUri(repo, type === "A" || type === "U" ? "" : from, oldPath);
  const right = type === "D"
    ? revisionUri(repo, "", newPath)
    : to === UNCOMMITTED
    ? vscode.Uri.file(path.join(repo, newPath))
    : revisionUri(repo, to, newPath);
  const title = `${path.basename(newPath)} (${from ? short(from) : "Empty"} ↔ ${short(to)})`;
  await vscode.commands.executeCommand("vscode.diff", left, right, title, {
    preview: true,
    viewColumn: vscode.ViewColumn.Active,
  });
}

async function archive(repo: string, ref: string, name: string): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    title: `Archive ${name}`,
    defaultUri: vscode.Uri.file(
      path.join(path.dirname(repo), `${path.basename(repo)}-${name.replace(/[/\\]/g, "-")}.zip`),
    ),
    filters: { "Zip archive": ["zip"], "Tar archive": ["tar"] },
  });
  if (!target) return;
  const format = target.fsPath.endsWith(".tar") ? "tar" : "zip";
  await attempt(repo, `Archiving ${name}`, (git) => act.archive(git, ref, target.fsPath, format));
}

async function copy(text: string, what: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(`$(copy) Copied ${what}`, 2000);
}

function terminal(repo: string, name: string, command: string): void {
  const shell = vscode.window.createTerminal({ name, cwd: repo });
  shell.show();
  shell.sendText(command);
}

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

function currentBranch(repo: string): Promise<string | undefined> {
  return gitAt(repo)(["symbolic-ref", "--short", "-q", "HEAD"]).then((out) => out.trim() || undefined, () => undefined);
}

/** For a merge commit, which parent the change is taken against; 1 without asking for any other commit. */
async function pickParent(repo: string, hash: string, verb: string): Promise<number | undefined> {
  const parents = (await gitAt(repo)(["show", "-s", "--format=%P", hash])).trim().split(" ").filter(Boolean);
  if (parents.length < 2) return 0;
  const subjects = await Promise.all(
    parents.map((parent) => gitAt(repo)(["show", "-s", "--format=%s", parent]).then((s) => s.trim())),
  );
  return pick(
    `${verb} merge commit ${short(hash)} against which parent?`,
    parents.map((parent, index) => ({
      label: `Parent ${index + 1}: ${short(parent)}`,
      description: subjects[index],
      value: index + 1,
    })),
  );
}

async function mergeInto(ctx: Context, ref: string, kind: act.MergeKind): Promise<void> {
  const into = await currentBranch(ctx.repo) ?? "HEAD";
  const what = kind === "commit" ? short(ref) : ref;
  const mode = await pick<act.MergeMode>(`Merge ${kind} ${what} into ${into}`, [
    { label: "$(git-merge) Merge", description: "--no-ff", detail: "Always create a merge commit", value: "no-ff" },
    {
      label: "Fast-Forward If Possible",
      description: "--ff",
      detail: "Create a merge commit only when the histories have diverged",
      value: "ff",
    },
    {
      label: "Squash and Commit",
      description: "--squash",
      detail: "Combine the changes into one new commit",
      value: "squash",
    },
    {
      label: "Merge Without Committing",
      description: "--no-commit",
      detail: "Leave the merge staged for you to commit",
      value: "no-commit",
    },
  ]);
  if (mode) await attempt(ctx.repo, `Merging ${what} into ${into}`, (git) => act.merge(git, ref, kind, mode));
}

async function rebaseOnto(ctx: Context, ref: string, label: string): Promise<void> {
  const branch = await currentBranch(ctx.repo) ?? "HEAD";
  const how = await pick(`Rebase ${branch} on ${label}`, [
    {
      label: "$(git-merge) Rebase",
      description: "--ignore-date",
      detail: "The rebased commits are dated now",
      value: "rebase" as const,
    },
    { label: "Rebase, Keeping Author Dates", value: "keep-dates" as const },
    {
      label: "$(terminal) Rebase Interactively…",
      description: "--interactive",
      detail: "In a terminal, where git asks what to do with each commit",
      value: "interactive" as const,
    },
  ]);
  if (how === "interactive") {
    terminal(ctx.repo, `Rebase on ${label}`, `${quote(api?.git.path || "git")} rebase --interactive ${quote(ref)}`);
  } else if (how) {
    await attempt(ctx.repo, `Rebasing ${branch} on ${label}`, (git) => act.rebase(git, ref, how === "rebase"));
  }
}

async function addTag(ctx: Context): Promise<void> {
  const name = await askName(`Add Tag at ${short(ctx.hash!)}`);
  if (!name) return;
  const remote = (await remotes(ctx.repo))[0]?.name;
  const kind = await pick(`Add Tag ${name}`, [
    {
      label: "$(tag) Annotated",
      detail: "With a message, the tagger and a date",
      value: { annotated: true, push: false },
    },
    { label: "$(tag) Lightweight", detail: "Only a name for the commit", value: { annotated: false, push: false } },
    ...remote
      ? [
        { label: `$(cloud-upload) Annotated, Pushed to ${remote}`, value: { annotated: true, push: true } },
        { label: `$(cloud-upload) Lightweight, Pushed to ${remote}`, value: { annotated: false, push: true } },
      ]
      : [],
  ]);
  if (!kind) return;
  const message = kind.annotated
    ? await vscode.window.showInputBox({ title: `Annotated Tag ${name}: message`, ignoreFocusOut: true })
    : undefined;
  if (kind.annotated && message === undefined) return;
  await attempt(ctx.repo, `Adding tag ${name}`, async (git) => {
    await act.addTag(git, name, ctx.hash!, kind.annotated ? message : undefined);
    if (kind.push && remote) await act.pushTag(git, remote, name);
  }, kind.push);
}

async function createBranch(ctx: Context, at: string, label: string): Promise<void> {
  const name = await askName(`Create Branch at ${label}`);
  if (!name) return;
  const checkout = await pick(`Create Branch ${name}`, [
    { label: "$(git-branch) Create Branch", value: false },
    { label: "$(git-branch-create) Create Branch and Check It Out", value: true },
  ]);
  if (checkout !== undefined) {
    await attempt(ctx.repo, `Creating branch ${name}`, (git) => act.createBranch(git, name, at, checkout));
  }
}

async function pushBranch(ctx: Context): Promise<void> {
  const branch = ctx.branch!;
  const known = (await remotes(ctx.repo)).map((remote) => remote.name);
  const targets = known.length > 1
    ? await pickMany(
      `Push ${branch} to`,
      known.map((name, index) => ({ label: name, picked: index === 0, value: name })),
    )
    : known;
  if (!targets || targets.length === 0) return;
  const options = await pick(`Push ${branch} to ${targets.join(", ")}`, [
    {
      label: "$(cloud-upload) Push and Set Upstream",
      description: "--set-upstream",
      value: { setUpstream: true, force: "" as act.ForceMode },
    },
    { label: "$(cloud-upload) Push", value: { setUpstream: false, force: "" as act.ForceMode } },
    {
      label: "$(warning) Force Push with Lease",
      description: "--force-with-lease",
      detail: "Overwrite the remote branch, unless it has moved since it was last fetched",
      value: { setUpstream: true, force: "force-with-lease" as act.ForceMode },
    },
    {
      label: "$(warning) Force Push",
      description: "--force",
      detail: "Overwrite the remote branch whatever is on it",
      value: { setUpstream: true, force: "force" as act.ForceMode },
    },
  ]);
  if (!options) return;
  await attempt(ctx.repo, `Pushing ${branch} to ${targets.join(", ")}`, async (git) => {
    for (const remote of targets) await act.pushBranch(git, remote, branch, options);
  }, true);
}

async function deleteBranch(ctx: Context): Promise<void> {
  const branch = ctx.branch!;
  const tracking = (await gitAt(ctx.repo)(["for-each-ref", "--format=%(refname)", "refs/remotes"]).catch(() => ""))
    .split("\n")
    .filter(Boolean);
  const onRemotes = (await remotes(ctx.repo))
    .map((remote) => remote.name)
    .filter((remote) => tracking.includes(`refs/remotes/${remote}/${branch}`));
  const how = await pick(`Delete Branch ${branch}`, [
    {
      label: "$(trash) Delete Branch",
      description: "--delete",
      detail: "Refused if it has commits not merged anywhere",
      value: { force: false, remote: undefined as string | undefined },
    },
    {
      label: "$(warning) Force Delete Branch",
      description: "--delete --force",
      detail: "Even with unmerged commits, which are then only in the reflog",
      value: { force: true, remote: undefined as string | undefined },
    },
    ...onRemotes.map((remote) => ({
      label: `$(cloud) Delete Branch Here and on ${remote}`,
      value: { force: false, remote },
    })),
  ]);
  if (!how) return;
  await attempt(ctx.repo, `Deleting branch ${branch}`, async (git) => {
    await act.deleteBranch(git, branch, how.force);
    if (how.remote) await act.deleteRemoteBranch(git, how.remote, branch);
  }, how.remote !== undefined);
}

async function checkoutRemoteBranch(ctx: Context): Promise<void> {
  const remoteBranch = ctx.remoteBranch!;
  const suggested = ctx.branch ?? remoteBranch.slice(remoteBranch.indexOf("/") + 1);
  const locals = (await gitAt(ctx.repo)(["for-each-ref", "--format=%(refname:short)", "refs/heads"])).split("\n");
  if (locals.includes(suggested)) {
    const how = await pick(`A local branch ${suggested} already exists`, [
      { label: `$(check) Check Out ${suggested}`, value: "checkout" as const },
      { label: `$(cloud-download) Check Out ${suggested} and Pull ${remoteBranch}`, value: "pull" as const },
      { label: "$(git-branch-create) Check Out as a New Branch…", value: "new" as const },
    ]);
    if (how === "checkout" || how === "pull") {
      await attempt(ctx.repo, `Checking out ${suggested}`, async (git) => {
        await act.checkoutBranch(git, suggested);
        if (how === "pull") await act.pullBranch(git, ctx.remote!, ctx.branch!, "merge");
      }, how === "pull");
      return;
    }
    if (how !== "new") return;
  }
  const name = await askName(`Check Out ${remoteBranch} as`, locals.includes(suggested) ? "" : suggested);
  if (name) {
    await attempt(
      ctx.repo,
      `Checking out ${remoteBranch} as ${name}`,
      (git) => act.checkoutRemoteBranch(git, remoteBranch, name),
    );
  }
}

/** What each `poly.gitGraph.*` command does, by the part of its name after the prefix. */
const COMMANDS: Record<string, (ctx: Context, context: vscode.ExtensionContext) => unknown> = {
  view: (ctx, context) => {
    // From the Source Control title the argument is the repository's
    // SourceControl, which carries its root; from anywhere else, nothing.
    const root = (ctx as unknown as { rootUri?: vscode.Uri } | undefined)?.rootUri?.fsPath;
    return show(context, root);
  },
  fetch: async (_ctx, context) => {
    await show(context);
    const repo = GraphPanel.current?.repo;
    if (repo) await fetchAll(repo);
  },

  // A commit's menu.
  addTag,
  createBranch: (ctx) => createBranch(ctx, ctx.hash!, short(ctx.hash!)),
  checkoutCommit: async (ctx) => {
    if (
      await confirm(
        `Check out commit ${short(ctx.hash!)}?`,
        "HEAD is left detached: commits made there belong to no branch until you create one.",
        "Check Out",
      )
    ) {
      await attempt(ctx.repo, `Checking out ${short(ctx.hash!)}`, (git) => act.checkoutCommit(git, ctx.hash!));
    }
  },
  cherryPick: async (ctx) => {
    const parent = await pickParent(ctx.repo, ctx.hash!, "Cherry pick");
    if (parent === undefined) return;
    const options = await pick(`Cherry Pick ${short(ctx.hash!)}`, [
      { label: "$(git-commit) Cherry Pick", value: { recordOrigin: false, noCommit: false } },
      {
        label: "Cherry Pick, Recording Its Origin",
        description: "-x",
        detail: "Append \"(cherry picked from commit …)\" to the message",
        value: { recordOrigin: true, noCommit: false },
      },
      {
        label: "Cherry Pick Without Committing",
        description: "--no-commit",
        detail: "Leave the change staged",
        value: { recordOrigin: false, noCommit: true },
      },
    ]);
    if (options) {
      await attempt(
        ctx.repo,
        `Cherry picking ${short(ctx.hash!)}`,
        (git) => act.cherryPick(git, ctx.hash!, parent, options),
      );
    }
  },
  revert: async (ctx) => {
    const parent = await pickParent(ctx.repo, ctx.hash!, "Revert");
    if (parent === undefined) return;
    if (
      await confirm(`Revert commit ${short(ctx.hash!)}?`, "A new commit is added that undoes its changes.", "Revert")
    ) {
      await attempt(ctx.repo, `Reverting ${short(ctx.hash!)}`, (git) => act.revert(git, ctx.hash!, parent));
    }
  },
  drop: async (ctx) => {
    if (
      await confirm(
        `Drop commit ${short(ctx.hash!)}?`,
        "Every commit after it on this branch is rewritten. Drop only what has not been pushed.",
        "Drop",
      )
    ) {
      await attempt(ctx.repo, `Dropping ${short(ctx.hash!)}`, (git) => act.drop(git, ctx.hash!));
    }
  },
  mergeCommit: (ctx) => mergeInto(ctx, ctx.hash!, "commit"),
  rebaseOnCommit: (ctx) => rebaseOnto(ctx, ctx.hash!, short(ctx.hash!)),
  resetToCommit: async (ctx) => {
    const branch = await currentBranch(ctx.repo) ?? "HEAD";
    const mode = await pick<act.ResetMode>(`Reset ${branch} to ${short(ctx.hash!)}`, [
      {
        label: "Mixed",
        description: "--mixed",
        detail: "Keep the changes in the working tree, unstaged",
        value: "mixed",
      },
      { label: "Soft", description: "--soft", detail: "Keep the changes, staged", value: "soft" },
      {
        label: "$(warning) Hard",
        description: "--hard",
        detail: "Discard every change since, committed or not",
        value: "hard",
      },
    ]);
    if (!mode) return;
    if (
      mode === "hard"
      && !await confirm(
        `Hard reset ${branch} to ${short(ctx.hash!)}?`,
        "Uncommitted changes are lost for good.",
        "Reset",
      )
    ) return;
    await attempt(ctx.repo, `Resetting ${branch} to ${short(ctx.hash!)}`, (git) => act.reset(git, ctx.hash!, mode));
  },
  archiveCommit: (ctx) => archive(ctx.repo, ctx.hash!, short(ctx.hash!)),
  directoryDiff: (ctx) => {
    const parents = ctx.parents ?? [];
    terminal(
      ctx.repo,
      `Diff ${short(ctx.hash!)}`,
      `${quote(api?.git.path || "git")} difftool --dir-diff ${parents[0] ? quote(parents[0]) : "--root"} ${
        quote(ctx.hash!)
      }`,
    );
  },
  copyHash: (ctx) => copy(ctx.hash!, "commit hash"),
  copySubject: (ctx) => copy(ctx.subject!, "commit subject"),

  // A local branch's menu.
  checkoutBranch: (ctx) =>
    attempt(ctx.repo, `Checking out ${ctx.branch}`, (git) => act.checkoutBranch(git, ctx.branch!)),
  renameBranch: async (ctx) => {
    const name = await askName(`Rename Branch ${ctx.branch}`, ctx.branch);
    if (name && name !== ctx.branch) {
      await attempt(ctx.repo, `Renaming ${ctx.branch}`, (git) => act.renameBranch(git, ctx.branch!, name));
    }
  },
  deleteBranch,
  mergeBranch: (ctx) => mergeInto(ctx, ctx.branch!, "branch"),
  rebaseOnBranch: (ctx) => rebaseOnto(ctx, ctx.branch!, ctx.branch!),
  pushBranch,
  createPullRequest: async (ctx) => {
    const remote = ctx.remote ?? await pickRemote(ctx.repo, `Create Pull Request for ${ctx.branch}`);
    const found = (await remotes(ctx.repo)).find((r) => r.name === remote);
    const url = found && act.pullRequestUrl(found, ctx.branch!);
    if (url) await vscode.env.openExternal(vscode.Uri.parse(url, true));
    else void vscode.window.showWarningMessage(`${remote ?? "This repository"} is not on GitHub, GitLab or Bitbucket`);
  },
  archiveBranch: (ctx) => archive(ctx.repo, ctx.remoteBranch ?? ctx.branch!, ctx.remoteBranch ?? ctx.branch!),
  filterToBranch: (ctx) => {
    const panel = GraphPanel.current;
    if (panel) {
      panel.setView({ ...panel.view(), branches: [ctx.remoteBranch ? `remotes/${ctx.remoteBranch}` : ctx.branch!] });
    }
  },
  copyBranchName: (ctx) => copy(ctx.remoteBranch ?? ctx.branch!, "branch name"),

  // A remote-tracking branch's menu.
  checkoutRemoteBranch,
  deleteRemoteBranch: async (ctx) => {
    if (
      await confirm(
        `Delete ${ctx.remoteBranch} on ${ctx.remote}?`,
        "The branch is deleted on the remote itself, for everyone.",
        "Delete",
      )
    ) {
      await attempt(
        ctx.repo,
        `Deleting ${ctx.remoteBranch}`,
        (git) => act.deleteRemoteBranch(git, ctx.remote!, ctx.branch!),
        true,
      );
    }
  },
  fetchIntoLocalBranch: async (ctx) => {
    const name = await askName(`Fetch ${ctx.remoteBranch} into local branch`, ctx.branch);
    if (!name) return;
    const force = await pick(`Fetch ${ctx.remoteBranch} into ${name}`, [
      { label: "$(cloud-download) Fetch", detail: "Refused unless it is a fast-forward", value: false },
      {
        label: "$(warning) Force Fetch",
        description: "--force",
        detail: "Move the local branch whatever is on it",
        value: true,
      },
    ]);
    if (force !== undefined) {
      await attempt(
        ctx.repo,
        `Fetching ${ctx.remoteBranch} into ${name}`,
        (git) => act.fetchIntoLocalBranch(git, ctx.remote!, ctx.branch!, name, force),
        true,
      );
    }
  },
  mergeRemoteBranch: (ctx) => mergeInto(ctx, ctx.remoteBranch!, "remote branch"),
  pullIntoCurrent: async (ctx) => {
    const into = await currentBranch(ctx.repo) ?? "HEAD";
    const mode = await pick<act.PullMode>(`Pull ${ctx.remoteBranch} into ${into}`, [
      { label: "$(cloud-download) Pull", value: "merge" },
      { label: "Pull, Always Creating a Merge Commit", description: "--no-ff", value: "no-ff" },
      {
        label: "Pull and Squash",
        description: "--squash",
        detail: "Combine the pulled changes into one new commit",
        value: "squash",
      },
    ]);
    if (mode) {
      await attempt(
        ctx.repo,
        `Pulling ${ctx.remoteBranch} into ${into}`,
        (git) => act.pullBranch(git, ctx.remote!, ctx.branch!, mode),
        true,
      );
    }
  },

  // A tag's menu.
  viewTag: async (ctx) => {
    const tag = await tagDetails(gitAt(ctx.repo), ctx.tag!);
    const when = new Date(tag.date * 1000).toLocaleString();
    void vscode.window.showInformationMessage(`Tag ${ctx.tag}`, {
      modal: true,
      detail: `Object: ${tag.hash}\nTagger: ${tag.tagger} <${tag.email}>\nDate: ${when}\n\n${tag.message}`,
    });
  },
  deleteTag: async (ctx) => {
    const known = (await remotes(ctx.repo)).map((remote) => remote.name);
    const remote = await pick<string | null>(`Delete Tag ${ctx.tag}`, [
      { label: "$(trash) Delete Tag", value: null },
      ...known.map((name) => ({ label: `$(cloud) Delete Tag Here and on ${name}`, value: name })),
    ]);
    if (remote !== undefined) {
      await attempt(
        ctx.repo,
        `Deleting tag ${ctx.tag}`,
        (git) => act.deleteTag(git, ctx.tag!, remote ?? undefined),
        remote !== null,
      );
    }
  },
  pushTag: async (ctx) => {
    const remote = await pickRemote(ctx.repo, `Push Tag ${ctx.tag} to`);
    if (remote) {
      await attempt(ctx.repo, `Pushing tag ${ctx.tag} to ${remote}`, (git) => act.pushTag(git, remote, ctx.tag!), true);
    }
  },
  archiveTag: (ctx) => archive(ctx.repo, ctx.tag!, ctx.tag!),
  copyTagName: (ctx) => copy(ctx.tag!, "tag name"),

  // A stash's menu.
  applyStash: async (ctx) => {
    const index = await pick(`Apply ${ctx.selector}`, [
      { label: "$(git-stash-apply) Apply Stash", value: false },
      {
        label: "Apply Stash, Reinstating the Index",
        description: "--index",
        detail: "Restage what was staged when it was stashed",
        value: true,
      },
    ]);
    if (index !== undefined) {
      await attempt(ctx.repo, `Applying ${ctx.selector}`, (git) => act.applyStash(git, ctx.selector!, index));
    }
  },
  popStash: async (ctx) => {
    const index = await pick(`Pop ${ctx.selector}`, [
      { label: "$(git-stash-pop) Pop Stash", value: false },
      {
        label: "Pop Stash, Reinstating the Index",
        description: "--index",
        detail: "Restage what was staged when it was stashed",
        value: true,
      },
    ]);
    if (index !== undefined) {
      await attempt(ctx.repo, `Popping ${ctx.selector}`, (git) => act.popStash(git, ctx.selector!, index));
    }
  },
  dropStash: async (ctx) => {
    if (
      await confirm(`Drop ${ctx.selector}?`, "Its changes are lost unless they are applied somewhere first.", "Drop")
    ) {
      await attempt(ctx.repo, `Dropping ${ctx.selector}`, (git) => act.dropStash(git, ctx.selector!));
    }
  },
  branchFromStash: async (ctx) => {
    const name = await askName(`Create Branch from ${ctx.selector}`);
    if (name) {
      await attempt(
        ctx.repo,
        `Creating branch ${name} from ${ctx.selector}`,
        (git) => act.branchFromStash(git, ctx.selector!, name),
      );
    }
  },
  copyStashName: (ctx) => copy(ctx.selector!, "stash name"),

  // The uncommitted changes' menu.
  stashChanges: async (ctx) => {
    const message = await vscode.window.showInputBox({
      title: "Stash Uncommitted Changes",
      prompt: "A message to find it by (optional)",
      ignoreFocusOut: true,
    });
    if (message === undefined) return;
    const untracked = await pick("Stash", [
      { label: "$(git-stash) Stash, Including Untracked Files", description: "--include-untracked", value: true },
      { label: "$(git-stash) Stash Tracked Files Only", value: false },
    ]);
    if (untracked !== undefined) {
      await attempt(ctx.repo, "Stashing uncommitted changes", (git) => act.pushStash(git, message, untracked));
    }
  },
  resetChanges: async (ctx) => {
    const mode = await pick<act.ResetMode>("Reset Uncommitted Changes", [
      {
        label: "Mixed",
        description: "--mixed",
        detail: "Unstage everything, keep the changes in the working tree",
        value: "mixed",
      },
      {
        label: "$(warning) Hard",
        description: "--hard",
        detail: "Discard every change to tracked files",
        value: "hard",
      },
    ]);
    if (!mode) return;
    if (
      mode === "hard"
      && !await confirm("Discard all uncommitted changes to tracked files?", "This cannot be undone.", "Discard")
    ) return;
    await attempt(ctx.repo, "Resetting uncommitted changes", (git) => act.reset(git, "HEAD", mode));
  },
  cleanUntracked: async (ctx) => {
    const directories = await pick("Clean Untracked Files", [
      { label: "$(trash) Untracked Files and Directories", description: "-fd", value: true },
      { label: "$(trash) Untracked Files Only", description: "-f", value: false },
    ]);
    if (directories === undefined) return;
    if (await confirm("Delete untracked files?", "They are not in git, so nothing can bring them back.", "Delete")) {
      await attempt(ctx.repo, "Cleaning untracked files", (git) => act.cleanUntracked(git, directories));
    }
  },
  openSourceControl: () => vscode.commands.executeCommand("workbench.view.scm"),

  // A changed file's menu, in a commit's details.
  viewDiff: (ctx) => openDiff(ctx),
  viewDiffWithWorkingFile: (ctx) =>
    vscode.commands.executeCommand(
      "vscode.diff",
      revisionUri(ctx.repo, ctx.to === UNCOMMITTED ? "HEAD" : ctx.to!, ctx.path!),
      vscode.Uri.file(path.join(ctx.repo, ctx.path!)),
      `${path.basename(ctx.path!)} (${short(ctx.to === UNCOMMITTED ? "HEAD" : ctx.to!)} ↔ Working Tree)`,
      { preview: true },
    ),
  viewFileAtRevision: (ctx) =>
    vscode.window.showTextDocument(
      revisionUri(
        ctx.repo,
        ctx.type === "D" ? ctx.from! : ctx.to!,
        ctx.type === "D" ? ctx.oldPath ?? ctx.path! : ctx.path!,
      ),
      { preview: true },
    ),
  openFile: (ctx) => vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path.join(ctx.repo, ctx.path!))),
  copyFilePath: (ctx) => copy(path.join(ctx.repo, ctx.path!), "file path"),
  copyRelativeFilePath: (ctx) => copy(ctx.path!, "relative file path"),

  // The column header's menu: the page keeps which columns show.
  toggleDate: () => GraphPanel.current?.panel.webview.postMessage({ type: "toggleColumn", column: "date" }),
  toggleAuthor: () => GraphPanel.current?.panel.webview.postMessage({ type: "toggleColumn", column: "author" }),
  toggleCommit: () => GraphPanel.current?.panel.webview.postMessage({ type: "toggleColumn", column: "commit" }),
};

export async function run(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
  polyPath: string,
  command: string,
  ...args: unknown[]
): Promise<unknown> {
  log = output;
  poly = polyPath;
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(`poly.gitGraph.${command} is declared in the manifest but has no handler`);
  }
  try {
    await ready();
    // The menus hide these without git; a key binding gets past any `when`.
    if (readOnly && !READS.has(command)) return needsGit();
    return await handler((args[0] ?? {}) as Context, context);
  } catch (error) {
    void vscode.window.showErrorMessage(`Git History: ${error instanceof Error ? error.message : error}`);
  }
}

/** The commands with a handler, for the test that holds them to the manifest. */
export const handled = Object.keys(COMMANDS);

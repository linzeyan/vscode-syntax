/**
 * Git History: a graph of every branch, tag and stash with uncommitted
 * changes on top, a commit's details and files inline, two commits compared,
 * and actions on branches, commits, tags, stashes and remotes, in the menus of
 * what they act on.
 *
 * Its behaviour is modelled on mhutchie.git-graph 1.30.0: tools/git-graph-diff
 * holds what it reads from git and what its actions do to Git Graph's. The
 * graph's layout and drawing are ported from VS Code's own Source Control
 * Graph (MIT): gitGraphLayout.ts and preview/gitGraphDraw.ts. What this
 * registers is all that loads at startup: the command handlers, the dialogs
 * and the page itself are `dist/gitGraph.js`, loaded the first time any of
 * them is used.
 *
 * While Git Graph itself is installed, this stands aside from the status bar
 * and the Source Control title, so neither shows two entries; its own
 * commands stay available under their own names.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const ORIGINAL = "mhutchie.git-graph";

type Host = typeof import("./gitGraphPanel");
let host: Host | undefined;
const load = () => (host ??= require(path.join(__dirname, "gitGraph.js")) as Host);

/**
 * The repositories in the workspace as the disk shows them, for where there is
 * no git to ask: the one each folder is in, and any directly inside a folder
 * (vscode.git's own default scan depth).
 */
export function repositoriesOnDisk(): string[] {
  const found = new Set<string>();
  const isRepo = (dir: string) => fs.existsSync(path.join(dir, ".git"));
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") continue;
    const root = folder.uri.fsPath;
    for (let dir = root;; dir = path.dirname(dir)) {
      if (isRepo(dir)) {
        found.add(dir);
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && isRepo(path.join(root, entry.name))) found.add(path.join(root, entry.name));
      }
    } catch {
      // An unreadable folder has no repositories to show.
    }
  }
  return [...found].sort();
}

export function registerGitGraph(context: vscode.ExtensionContext, log: vscode.LogOutputChannel, poly: string): void {
  const statusBar = vscode.window.createStatusBarItem("poly.gitGraph", vscode.StatusBarAlignment.Left, 0);
  statusBar.name = "Git History";
  statusBar.text = "Git History";
  statusBar.tooltip = "View Git History";
  statusBar.command = "poly.gitGraph.view";

  let repositories = 0;
  const update = () => {
    const yielding = vscode.extensions.getExtension(ORIGINAL) !== undefined;
    void vscode.commands.executeCommand("setContext", "poly.yield.gitGraph", yielding);
    if (!yielding && repositories > 0) {
      statusBar.show();
    } else {
      statusBar.hide();
    }
  };
  update();
  // The item shows only where there is a repository to graph. The built-in
  // git extension is what knows; it activates on its own at startup. Where it
  // has no git to run, the panel reads with poly, so the disk is asked instead.
  const git = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
  void Promise.resolve(git?.isActive ? git.exports : git?.activate()).then((exports) => {
    const api = exports?.getAPI(1);
    if (!api) throw new Error("the built-in Git extension is disabled");
    const count = () => {
      repositories = api.repositories.length;
      update();
    };
    count();
    context.subscriptions.push(api.onDidOpenRepository(count), api.onDidCloseRepository(count));
    // Caught after the handler rather than beside it: without git on the
    // machine the extension starts fine and it is `getAPI` that throws, which
    // a rejection handler on the same `then` never sees.
  }).catch((error) => {
    log.info(`Git History: no git to run (${error}); finding repositories on disk`);
    repositories = repositoriesOnDisk().length;
    update();
  });

  // Every `poly.gitGraph.*` command the manifest declares, handled in the
  // lazily loaded half -- the list lives in package.json and nowhere else.
  const commands: { command: string }[] = context.extension.packageJSON.contributes.commands;
  for (const { command } of commands.filter(({ command }) => command.startsWith("poly.gitGraph."))) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        command,
        (...args: unknown[]) => load().run(context, log, poly, command.slice("poly.gitGraph.".length), ...args),
      ),
    );
  }
  context.subscriptions.push(
    statusBar,
    vscode.extensions.onDidChange(update),
    // Registered here rather than on first use: a diff tab restored with the
    // window asks for its content before anything else has loaded the panel.
    vscode.workspace.registerTextDocumentContentProvider("poly-git", {
      provideTextDocumentContent: (uri) => load().content(uri, poly),
    }),
  );
}

interface GitApi {
  readonly repositories: readonly unknown[];
  readonly onDidOpenRepository: vscode.Event<unknown>;
  readonly onDidCloseRepository: vscode.Event<unknown>;
}

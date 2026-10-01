/**
 * mhutchie.git-graph 1.30.0, written anew: its graph of every branch, tag and
 * stash with uncommitted changes on top, a commit's details and files inline,
 * two commits compared, and its actions on branches, commits, tags, stashes
 * and remotes, in the menus of what they act on.
 *
 * Git Graph's licence forbids redistributing any work derived from it, so
 * none of its code is in here; tools/git-graph-diff holds this to what it
 * does. What this registers is all that loads at startup: the command
 * handlers, the dialogs and the page itself are `dist/gitGraph.js`, loaded the
 * first time any of them is used.
 *
 * While Git Graph itself is installed, this stands aside from the status bar
 * and the Source Control title, so neither shows two entries; its own
 * commands stay available under their own names.
 */
import * as path from "path";
import * as vscode from "vscode";

const ORIGINAL = "mhutchie.git-graph";

type Host = typeof import("./gitGraphPanel");
let host: Host | undefined;
const load = () => (host ??= require(path.join(__dirname, "gitGraph.js")) as Host);

export function registerGitGraph(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): void {
  const statusBar = vscode.window.createStatusBarItem("poly.gitGraph", vscode.StatusBarAlignment.Left, 0);
  statusBar.name = "Git Graph";
  statusBar.text = "Git Graph";
  statusBar.tooltip = "View Git Graph (git log)";
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
  // git extension is what knows; it activates on its own at startup.
  const git = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
  void Promise.resolve(git?.isActive ? git.exports : git?.activate()).then((exports) => {
    const api = exports?.getAPI(1);
    if (!api) return;
    const count = () => {
      repositories = api.repositories.length;
      update();
    };
    count();
    context.subscriptions.push(api.onDidOpenRepository(count), api.onDidCloseRepository(count));
  }, (error) => log.warn(`Git Graph: the built-in git extension did not start: ${error}`));

  // Every `poly.gitGraph.*` command the manifest declares, handled in the
  // lazily loaded half -- the list lives in package.json and nowhere else.
  const commands: { command: string }[] = context.extension.packageJSON.contributes.commands;
  for (const { command } of commands.filter(({ command }) => command.startsWith("poly.gitGraph."))) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        command,
        (...args: unknown[]) => load().run(context, log, command.slice("poly.gitGraph.".length), ...args),
      ),
    );
  }
  context.subscriptions.push(
    statusBar,
    vscode.extensions.onDidChange(update),
    // Registered here rather than on first use: a diff tab restored with the
    // window asks for its content before anything else has loaded the panel.
    vscode.workspace.registerTextDocumentContentProvider("poly-git", {
      provideTextDocumentContent: (uri) => load().content(uri),
    }),
  );
}

interface GitApi {
  readonly repositories: readonly unknown[];
  readonly onDidOpenRepository: vscode.Event<unknown>;
  readonly onDidCloseRepository: vscode.Event<unknown>;
}

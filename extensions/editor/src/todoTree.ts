import * as path from "path";
import * as vscode from "vscode";

import { DEFAULT_TAGS, findTodos, Todo } from "./todos";

/** A file that has markers, or one of its markers. */
type Node = { kind: "file"; uri: vscode.Uri; todos: Todo[] } | {
  kind: "todo";
  uri: vscode.Uri;
  todo: Todo;
};

/**
 * A workspace scan is bounded rather than complete.
 *
 * An unbounded one is fine until someone opens a monorepo, and a tree view
 * that hangs the window is worse than one that says it stopped early. The cap
 * is reported, so "the list is short" and "the list was truncated" never look
 * the same.
 */
const MAX_FILES = 4000;
const MAX_BYTES = 512 * 1024;

export class TodoTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  private files: { uri: vscode.Uri; todos: Todo[] }[] = [];
  private truncated = false;
  private scanning: Promise<void> | undefined;

  async refresh(): Promise<void> {
    // One scan at a time: a save during a scan should join it, not start a
    // second walk of the same tree.
    this.scanning ??= this.scan().finally(() => {
      this.scanning = undefined;
      this.changed.fire();
    });
    await this.scanning;
  }

  private async scan(): Promise<void> {
    const tags = vscode.workspace
      .getConfiguration("poly")
      .get<string[]>("todo.tags", [...DEFAULT_TAGS]);
    // `undefined` for the exclude argument means files.exclude and
    // search.exclude apply -- the same directories the user already told
    // VSCode not to search.
    const uris = await vscode.workspace.findFiles("**/*", undefined, MAX_FILES);
    this.truncated = uris.length >= MAX_FILES;

    const found: { uri: vscode.Uri; todos: Todo[] }[] = [];
    for (const uri of uris) {
      let bytes: Uint8Array;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_BYTES) {
          continue;
        }
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch {
        // Deleted between the walk and the read, or not readable. Neither is
        // this view's problem.
        continue;
      }
      // A binary file decodes to replacement characters rather than throwing,
      // and replacement characters contain no tags -- so nothing extra is
      // needed to skip them.
      const todos = findTodos(new TextDecoder().decode(bytes), tags);
      if (todos.length > 0) {
        found.push({ uri, todos });
      }
    }
    found.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
    this.files = found;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.files.map((file) => ({ kind: "file", ...file }));
    }
    return node.kind === "file"
      ? node.todos.map((todo) => ({ kind: "todo", uri: node.uri, todo }))
      : [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "file") {
      const label = vscode.workspace.asRelativePath(node.uri);
      const item = new vscode.TreeItem(
        label,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = `${node.todos.length}`;
      item.resourceUri = node.uri;
      item.iconPath = vscode.ThemeIcon.File;
      return item;
    }
    const { todo } = node;
    const item = new vscode.TreeItem(
      todo.text || todo.tag,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${todo.tag} · ${todo.line + 1}`;
    item.tooltip = `${path.basename(node.uri.fsPath)}:${todo.line + 1}`;
    item.iconPath = new vscode.ThemeIcon("issues");
    item.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [
        node.uri,
        {
          selection: new vscode.Range(
            todo.line,
            todo.column,
            todo.line,
            todo.column,
          ),
        } satisfies vscode.TextDocumentShowOptions,
      ],
    };
    return item;
  }

  /** What the view's title should say it is showing. */
  get summary(): string {
    const markers = this.files.reduce((n, file) => n + file.todos.length, 0);
    const counted = `${markers} in ${this.files.length} files`;
    return this.truncated ? `${counted} (stopped at ${MAX_FILES} files)` : counted;
  }
}

export function registerTodoTree(context: vscode.ExtensionContext): void {
  const tree = new TodoTree();
  const view = vscode.window.createTreeView("polyTodos", {
    treeDataProvider: tree,
  });
  const refresh = async () => {
    await tree.refresh();
    view.description = tree.summary;
  };

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand("poly.refreshTodos", refresh),
    // Only when the view is on screen: scanning a workspace for a panel
    // nobody opened is work charged to every session that never wanted it.
    view.onDidChangeVisibility((event) => {
      if (event.visible) {
        void refresh();
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      if (view.visible) {
        void refresh();
      }
    }),
  );

  // A view restored open from the last session is visible without ever
  // changing visibility, so the event above never fires for it -- and an empty
  // tree would read as "no markers" rather than "not scanned".
  if (view.visible) {
    void refresh();
  }
}

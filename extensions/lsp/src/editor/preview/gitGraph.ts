/**
 * The Git History page: the toolbar, the table of commits with the graph
 * drawn in its first column, a commit's details opened under its row, find,
 * and the `data-vscode-context` that VSCode's own context menus key on.
 *
 * It holds no git of its own. Everything it shows comes from the host
 * (gitGraphPanel.ts), and everything it does beyond drawing is a message back.
 */
import "@vscode/codicons/dist/codicon.css";
import "./gitGraph.css";

import {
  asCssVariable,
  getHistoryItemColor,
  getHistoryItemIndex,
  type ISCMHistoryItemViewModel,
  layout,
} from "../gitGraphLayout";
import {
  type CommitDetails,
  type FileChange,
  type Graph,
  type GraphCommit,
  UNCOMMITTED,
  type ViewOptions,
} from "../gitGraphProtocol";
import {
  graphColumnCount,
  renderSCMHistoryGraphPlaceholder,
  renderSCMHistoryItemGraph,
  SWIMLANE_HEIGHT,
  SWIMLANE_WIDTH,
} from "./gitGraphDraw";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const post = (message: { type: string; [key: string]: unknown }) => vscode.postMessage(message);

const ROW = SWIMLANE_HEIGHT;

type Column = "date" | "author" | "commit";
interface Columns {
  widths: Partial<Record<"graph" | "description" | Column, number>>;
  hidden: Column[];
  muteMerges: boolean;
  fileView: "tree" | "list";
}
interface Remote {
  name: string;
  pr: boolean;
}
type FileEntry = FileChange & { from: string; to: string };

interface State {
  repos: string[];
  repo?: string;
  view?: ViewOptions;
  graph?: Graph;
  subjects: string[];
  remotes: Remote[];
  diffTool: boolean;
  layout?: ISCMHistoryItemViewModel[];
  /** The commit whose details are open, and the one compared with it if any. */
  open?: string;
  compare?: string;
  details?: {
    hash: string;
    details?: CommitDetails;
    files?: FileEntry[];
    message?: string;
    error?: string;
    loading?: boolean;
  };
  columns: Columns;
  find: { query: string; caseSensitive: boolean; regex: boolean; matches: number[]; current: number };
  waitingForMore: boolean;
}

const state: State = {
  repos: [],
  subjects: [],
  remotes: [],
  diffTool: false,
  columns: { widths: {}, hidden: [], muteMerges: true, fileView: "tree" },
  find: { query: "", caseSensitive: false, regex: false, matches: [], current: -1 },
  waitingForMore: false,
};

// ---------------------------------------------------------------- elements

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | undefined> = {},
  ...children: (Node | string | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) node.setAttribute(name, value);
  }
  for (const child of children) {
    if (child !== undefined && child !== false) node.append(child);
  }
  return node;
}
const icon = (name: string, title?: string) =>
  el("span", { class: `codicon codicon-${name}`, title, "aria-hidden": title ? undefined : "true" });
const context = (value: Record<string, unknown>) => JSON.stringify({ ...value, preventDefaultContextMenuItems: true });
const short = (hash: string) => hash.slice(0, 8);

function button(id: string, codicon: string, title: string): HTMLButtonElement {
  const node = el("button", { id, class: "icon-button", title, "aria-label": title }, icon(codicon));
  return node;
}

const toolbar = el("header", { class: "toolbar" });
const repoSelect = el("select", { id: "repo", title: "Repository", "aria-label": "Repository" });
const branchButton = el("button", {
  id: "branches",
  class: "dropdown",
  "aria-haspopup": "true",
  title: "Branches to show",
});
const remoteToggle = el("input", { type: "checkbox", id: "show-remotes" });
const findInput = el("input", {
  id: "find",
  type: "text",
  placeholder: "Find commits",
  spellcheck: "false",
  "aria-label": "Find commits",
});
const findCount = el("span", { class: "find-count", "aria-live": "polite" });
const caseToggle = button("find-case", "case-sensitive", "Match Case");
const regexToggle = button("find-regex", "regex", "Use Regular Expression");
const findPrevious = button("find-previous", "arrow-up", "Previous Match (Shift+Enter)");
const findNext = button("find-next", "arrow-down", "Next Match (Enter)");
const optionsButton = button("options", "filter", "View Options");
const fetchButton = button("fetch", "repo-fetch", "Fetch from All Remotes");
const remotesButton = button("remotes", "cloud", "Remotes…");
const refreshButton = button("refresh", "refresh", "Refresh (Ctrl/Cmd+R)");
const progress = el("div", { class: "progress", role: "progressbar", hidden: "" });
const scroller = el("main", { id: "scroller", tabindex: "-1" });
const table = el("table", { class: "commits" });
const colgroup = el("colgroup");
const head = el("thead");
const rows = el("tbody");
const footer = el("div", { class: "footer" });
const notice = el("div", { class: "notice", hidden: "" });
const popover = el("div", { class: "popover", hidden: "", role: "dialog" });

toolbar.append(
  el(
    "div",
    { class: "toolbar-group" },
    repoSelect,
    branchButton,
    el(
      "label",
      { class: "check", for: "show-remotes", title: "Show remote-tracking branches" },
      remoteToggle,
      el("span", {}, "Remote Branches"),
    ),
  ),
  el(
    "div",
    { class: "find", role: "search" },
    icon("search"),
    findInput,
    findCount,
    caseToggle,
    regexToggle,
    findPrevious,
    findNext,
  ),
  el("div", { class: "toolbar-group end" }, optionsButton, fetchButton, remotesButton, refreshButton),
);
table.append(colgroup, head, rows);
scroller.append(table, footer);
document.body.append(toolbar, progress, scroller, notice, popover);

// ---------------------------------------------------------------- columns

const COLUMN_TITLES: Record<"graph" | "description" | Column, string> = {
  graph: "Graph",
  description: "Description",
  date: "Date",
  author: "Author",
  commit: "Commit",
};
const visible = (): ("graph" | "description" | Column)[] =>
  (["graph", "description", "date", "author", "commit"] as const).filter((column) =>
    !state.columns.hidden.includes(column as Column)
  );

/** As wide as the widest row's graph, which is as wide as renderSCMHistoryItemGraph makes it. */
function graphWidth(): number {
  return SWIMLANE_WIDTH * (Math.max(1, ...(state.layout ?? []).map(graphColumnCount)) + 1);
}

/** What the details row leaves free on its left, for the lanes that run past it. */
function setGraphWidth(width: number): void {
  table.style.setProperty("--graph-width", `${width}px`);
}

function renderHeader(): void {
  colgroup.replaceChildren();
  const row = el("tr");
  for (const column of visible()) {
    const col = el("col", { class: column });
    const width = column === "graph" ? state.columns.widths.graph ?? graphWidth() : state.columns.widths[column];
    if (column === "graph") setGraphWidth(width!);
    if (width && column !== "description") col.style.width = `${width}px`;
    colgroup.append(col);
    const cell = el("th", { class: column, scope: "col" }, COLUMN_TITLES[column]);
    if (column !== "description") {
      const grip = el("span", { class: "grip", title: "Drag to resize" });
      grip.addEventListener("mousedown", (event) => resize(event, column, col));
      cell.append(grip);
    }
    row.append(cell);
  }
  head.replaceChildren(row);
  head.setAttribute(
    "data-vscode-context",
    context({
      webviewSection: "header",
      polyDate: !state.columns.hidden.includes("date"),
      polyAuthor: !state.columns.hidden.includes("author"),
      polyCommit: !state.columns.hidden.includes("commit"),
    }),
  );
}

function resize(event: MouseEvent, column: "graph" | Column, col: HTMLTableColElement): void {
  event.preventDefault();
  const start = event.clientX;
  const initial = col.getBoundingClientRect().width || (state.columns.widths[column] ?? 80);
  const move = (moved: MouseEvent) => {
    const width = Math.max(column === "graph" ? SWIMLANE_WIDTH * 2 : 48, Math.round(initial + moved.clientX - start));
    state.columns.widths[column] = width;
    col.style.width = `${width}px`;
    if (column === "graph") setGraphWidth(width);
  };
  const done = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", done);
    document.body.classList.remove("resizing");
    post({ type: "columns", columns: state.columns });
  };
  document.body.classList.add("resizing");
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", done);
}

// ---------------------------------------------------------------- rows

const isMerge = (commit: GraphCommit) => commit.parents.length > 1;

/** Commits HEAD reaches among those listed: what Revert and Drop make sense on. */
function ancestorsOfHead(graph: Graph): Set<string> {
  const byHash = new Map(graph.commits.map((commit) => [commit.hash, commit]));
  const reached = new Set<string>();
  const queue = graph.head ? [graph.head] : [];
  while (queue.length > 0) {
    const hash = queue.pop()!;
    if (reached.has(hash)) continue;
    reached.add(hash);
    for (const parent of byHash.get(hash)?.parents ?? []) queue.push(parent);
  }
  return reached;
}

// Numeric, so it fits its column in every locale: a long month name in some is twice as wide.
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const FULL_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" });

function relative(seconds: number): string {
  const delta = Date.now() / 1000 - seconds;
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [31536000, "year"],
    [2592000, "month"],
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [size, unit] of units) {
    if (Math.abs(delta) >= size) return format.format(-Math.round(delta / size), unit);
  }
  return format.format(0, "second");
}

/** The reference labels of one commit, local branches first, each with its remotes folded in. */
function labels(commit: GraphCommit, graph: Graph, colour: string): HTMLElement[] {
  const found: HTMLElement[] = [];
  const remotesLeft = [...commit.remotes];
  const remoteOf = (name: string) => state.remotes.find((remote) => remote.name === name);
  const anyPr = state.remotes.some((remote) => remote.pr);
  const heads = [...commit.heads].sort((a, b) => (a === graph.headBranch ? -1 : b === graph.headBranch ? 1 : 0));
  for (const branch of heads) {
    const current = branch === graph.headBranch;
    const label = el(
      "span",
      {
        class: `ref branch${current ? " current" : ""}`,
        title: current ? `${branch} (checked out)` : `${branch} — double-click to check out`,
        "data-vscode-context": context({ webviewSection: "branch", branch, polyCurrent: current, polyPr: anyPr }),
        "data-branch": branch,
      },
      icon(current ? "check" : "git-branch"),
      el("span", { class: "name" }, branch),
    );
    // Git Graph's combined label: `main` with each remote that has `main` on this same commit.
    for (const remote of remotesLeft.filter((r) => r.name === `${r.remote}/${branch}`)) {
      remotesLeft.splice(remotesLeft.indexOf(remote), 1);
      label.append(el(
        "span",
        {
          class: "remote-part",
          title: remote.name,
          "data-vscode-context": context({
            webviewSection: "remoteBranch",
            remoteBranch: remote.name,
            remote: remote.remote,
            branch,
            polyPr: remoteOf(remote.remote)?.pr ?? false,
          }),
        },
        icon("cloud"),
        remote.remote,
      ));
    }
    label.style.setProperty("--lane", colour);
    found.push(label);
  }
  if (!graph.headBranch && commit.hash === graph.head) {
    const label = el(
      "span",
      { class: "ref detached", title: "HEAD is detached here" },
      icon("debug-disconnect"),
      "HEAD",
    );
    label.style.setProperty("--lane", colour);
    found.unshift(label);
  }
  for (const remote of remotesLeft) {
    const branch = remote.name.slice(remote.remote.length + 1);
    const isHead = branch === "HEAD";
    const label = el(
      "span",
      {
        class: `ref remote-branch${isHead ? " remote-head" : ""}`,
        title: remote.name,
        "data-vscode-context": context(
          isHead
            ? { webviewSection: "remoteHead", remoteBranch: remote.name }
            : {
              webviewSection: "remoteBranch",
              remoteBranch: remote.name,
              remote: remote.remote,
              branch,
              polyPr: remoteOf(remote.remote)?.pr ?? false,
            },
        ),
      },
      icon("cloud"),
      el("span", { class: "name" }, remote.name),
    );
    label.style.setProperty("--lane", colour);
    found.push(label);
  }
  for (const tag of commit.tags) {
    found.push(el(
      "span",
      {
        class: "ref tag",
        title: tag.annotated ? `${tag.name} (annotated)` : tag.name,
        "data-vscode-context": context({ webviewSection: "tag", tag: tag.name, polyAnnotated: tag.annotated }),
      },
      icon("tag"),
      el("span", { class: "name" }, tag.name),
    ));
  }
  if (commit.stash) {
    found.push(
      el(
        "span",
        { class: "ref stash", title: commit.stash.selector },
        icon("git-stash"),
        el("span", { class: "name" }, commit.stash.selector),
      ),
    );
  }
  return found;
}

function renderRows(): void {
  const graph = state.graph;
  rows.replaceChildren();
  if (!graph) return;
  const ancestors = ancestorsOfHead(graph);
  const columns = visible();
  graph.commits.forEach((commit, index) => {
    const viewModel = state.layout![index];
    const colour = asCssVariable(getHistoryItemColor(viewModel));
    const uncommitted = commit.hash === UNCOMMITTED;
    const row = el("tr", {
      class: [
        "commit",
        uncommitted ? "uncommitted" : "",
        commit.stash ? "stash-row" : "",
        state.columns.muteMerges && isMerge(commit) ? "muted" : "",
        commit.hash === graph.head ? "head" : "",
      ].filter(Boolean).join(" "),
      "data-index": String(index),
      "data-hash": commit.hash,
      tabindex: "-1",
      "data-vscode-context": context(
        uncommitted
          ? { webviewSection: "uncommitted" }
          : commit.stash
          ? { webviewSection: "stash", hash: commit.hash, selector: commit.stash.selector }
          : {
            webviewSection: "commit",
            hash: commit.hash,
            subject: commit.subject,
            parents: commit.parents,
            polyMerge: isMerge(commit),
            polyRoot: commit.parents.length === 0,
            polyHead: commit.hash === graph.head,
            polyAncestor: ancestors.has(commit.hash),
          },
      ),
    });
    for (const column of columns) {
      switch (column) {
        case "graph":
          // The kind is a class on the cell, as VS Code puts it on the
          // graph's container: the stylesheet hollows HEAD's circle by it.
          row.append(el(
            "td",
            { class: `graph ${viewModel.kind === "HEAD" ? "current" : viewModel.kind}`, "aria-hidden": "true" },
            renderSCMHistoryItemGraph(viewModel),
          ));
          break;
        case "description": {
          const subject = el("span", { class: "subject" });
          if (uncommitted) {
            subject.textContent = commit.subject;
          } else {
            subject.innerHTML = state.subjects[index] ?? "";
          }
          row.append(el("td", { class: "description" }, ...labels(commit, graph, colour), subject));
          break;
        }
        case "date": {
          const date = new Date(commit.date * 1000);
          row.append(
            el(
              "td",
              { class: "date", title: `${FULL_DATE.format(date)} (${relative(commit.date)})` },
              DATE_FORMAT.format(date),
            ),
          );
          break;
        }
        case "author":
          row.append(
            el(
              "td",
              { class: "author", title: uncommitted ? undefined : `${commit.author} <${commit.email}>` },
              uncommitted ? "*" : commit.author,
            ),
          );
          break;
        case "commit":
          row.append(
            el(
              "td",
              { class: "commit-hash", title: uncommitted ? undefined : commit.hash },
              uncommitted ? "*" : short(commit.hash),
            ),
          );
          break;
      }
    }
    rows.append(row);
    if (commit.hash === state.open) rows.append(detailsRow(columns.length, viewModel));
  });
  markSelection();
}

function markSelection(): void {
  for (const row of rows.querySelectorAll<HTMLElement>("tr.commit")) {
    row.classList.toggle("selected", row.dataset.hash === state.open);
    row.classList.toggle("compared", row.dataset.hash === state.compare);
  }
}

// ---------------------------------------------------------------- details

/**
 * The open commit's details, with the lanes leaving it carried on down their
 * left, its own lane thicker -- as VS Code draws them past a commit's changed
 * files when one is expanded in its graph. The placeholder is drawn one row
 * high and stretched to the details' height: the lanes are straight there.
 */
function detailsRow(span: number, viewModel: ISCMHistoryItemViewModel): HTMLTableRowElement {
  const lanes = renderSCMHistoryGraphPlaceholder(
    viewModel.outputSwimlanes,
    viewModel.historyItem.parentIds.length > 0 ? getHistoryItemIndex(viewModel) : undefined,
  );
  lanes.classList.add("graph-placeholder");
  lanes.setAttribute("viewBox", `0 0 ${SWIMLANE_WIDTH * (viewModel.outputSwimlanes.length + 1)} ${SWIMLANE_HEIGHT}`);
  lanes.setAttribute("preserveAspectRatio", "none");
  lanes.setAttribute("aria-hidden", "true");
  const cell = el("td", { colspan: String(span) }, lanes, renderDetails());
  return el("tr", { class: "details-row" }, cell);
}

interface Folder {
  folders: Map<string, Folder>;
  files: FileEntry[];
}

function tree(files: FileEntry[]): Folder {
  const root: Folder = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.newPath.split("/");
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), files: [] });
      folder = folder.folders.get(part)!;
    }
    folder.files.push(file);
  }
  return root;
}

const TYPE_TITLES: Record<FileChange["type"], string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  U: "Untracked",
};

function fileRow(file: FileEntry, label: string, depth: number): HTMLElement {
  const stats = file.additions === null
    ? el("span", { class: "stats binary" }, file.type === "U" && file.additions === null ? "" : "binary")
    : el(
      "span",
      { class: "stats" },
      el("span", { class: "added" }, `+${file.additions}`),
      el("span", { class: "deleted" }, `−${file.deletions}`),
    );
  const renamed = file.type === "R"
    ? el("span", { class: "renamed-from", title: file.oldPath }, `← ${file.oldPath}`)
    : undefined;
  const item = el(
    "li",
    {
      class: `file type-${file.type}`,
      role: "treeitem",
      tabindex: "0",
      title: `${TYPE_TITLES[file.type]}: ${file.newPath}`,
      "data-vscode-context": context({
        webviewSection: "file",
        path: file.newPath,
        oldPath: file.oldPath,
        type: file.type,
        from: file.from,
        to: file.to,
        polyDeleted: file.type === "D",
      }),
    },
    el("span", { class: "badge" }, file.type),
    el("span", { class: "file-name" }, label),
    renamed,
    stats,
  );
  item.style.paddingLeft = `${8 + depth * 14}px`;
  const open = () =>
    post({
      type: "open",
      file: { path: file.newPath, oldPath: file.oldPath, type: file.type, from: file.from, to: file.to },
    });
  item.addEventListener("click", open);
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter") open();
  });
  return item;
}

function renderFolder(folder: Folder, depth: number, list: HTMLElement): void {
  const names = [...folder.folders.keys()].sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    // Compact folders, as Git Graph and the explorer both do: a chain of
    // folders each holding only the next is one row.
    let label = name;
    let inner = folder.folders.get(name)!;
    while (inner.files.length === 0 && inner.folders.size === 1) {
      const [next, nested] = [...inner.folders.entries()][0];
      label += `/${next}`;
      inner = nested;
    }
    const children = el("ul", { role: "group" });
    const toggle = el(
      "li",
      { class: "folder", role: "treeitem", "aria-expanded": "true", tabindex: "0", title: label },
      icon("chevron-down"),
      icon("folder-opened"),
      el("span", { class: "file-name" }, label),
    );
    toggle.style.paddingLeft = `${8 + depth * 14}px`;
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.querySelector(".codicon-chevron-down, .codicon-chevron-right")!.className = `codicon codicon-chevron-${
        open ? "down" : "right"
      }`;
      toggle.querySelector(".codicon-folder-opened, .codicon-folder")!.className = `codicon codicon-folder${
        open ? "-opened" : ""
      }`;
      children.hidden = !open;
    });
    list.append(toggle, children);
    renderFolder(inner, depth + 1, children);
  }
  for (const file of [...folder.files].sort((a, b) => a.newPath.localeCompare(b.newPath))) {
    list.append(fileRow(file, file.newPath.slice(file.newPath.lastIndexOf("/") + 1), depth));
  }
}

function renderFiles(files: FileEntry[]): HTMLElement {
  const added = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deleted = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const viewToggle = button(
    "file-view",
    state.columns.fileView === "tree" ? "list-flat" : "list-tree",
    state.columns.fileView === "tree" ? "View as List" : "View as Tree",
  );
  viewToggle.addEventListener("click", () => {
    state.columns.fileView = state.columns.fileView === "tree" ? "list" : "tree";
    post({ type: "columns", columns: state.columns });
    rerenderDetails();
  });
  const list = el("ul", { class: "files", role: "tree", "aria-label": "Changed files" });
  if (state.columns.fileView === "tree") {
    renderFolder(tree(files), 0, list);
  } else {
    for (const file of files) list.append(fileRow(file, file.newPath, 0));
  }
  return el(
    "section",
    { class: "files-pane" },
    el(
      "div",
      { class: "pane-header" },
      el("span", {}, `${files.length} ${files.length === 1 ? "file" : "files"} changed`),
      el(
        "span",
        { class: "stats" },
        el("span", { class: "added" }, `+${added}`),
        el("span", { class: "deleted" }, `−${deleted}`),
      ),
      el("span", { class: "spacer" }),
      viewToggle,
    ),
    files.length > 0 ? list : el("p", { class: "empty" }, "No files changed"),
  );
}

function person(name: string, email: string, date: number): HTMLElement {
  return el(
    "span",
    {},
    el("span", { class: "person", title: email }, name),
    " ",
    el("span", { class: "email" }, `<${email}>`),
    el(
      "span",
      { class: "when", title: FULL_DATE.format(new Date(date * 1000)) },
      ` · ${DATE_FORMAT.format(new Date(date * 1000))} (${relative(date)})`,
    ),
  );
}

function hashLink(hash: string): HTMLElement {
  const link = el("a", { href: "#", class: "hash-link", title: `Show ${hash}` }, short(hash));
  link.addEventListener("click", (event) => {
    event.preventDefault();
    select(hash, false);
  });
  return link;
}

function renderDetails(): HTMLElement {
  const details = state.details;
  const graph = state.graph!;
  const commit = graph.commits.find((c) => c.hash === state.open);
  const close = button("close-details", "close", "Close (Escape)");
  close.addEventListener("click", () => select(undefined, false));
  const [from, to] = state.compare ? compared() : [];
  const title = from && to
    ? el(
      "span",
      {},
      "Changes from ",
      el("code", {}, compareLabel(from)),
      " ",
      icon("arrow-right"),
      " ",
      el("code", {}, compareLabel(to)),
    )
    : state.open === UNCOMMITTED
    ? el("span", {}, "Uncommitted Changes")
    : commit?.stash
    ? el("span", {}, "Stash ", el("code", {}, commit.stash.selector))
    : el("span", {}, "Commit ", el("code", {}, short(state.open!)));
  const container = el(
    "div",
    { class: "details", role: "region", "aria-label": "Commit details" },
    el(
      "div",
      { class: "details-header" },
      title,
      el("span", { class: "spacer" }),
      state.compare ? undefined : el("span", { class: "hint" }, "Ctrl/Cmd+click another commit to compare"),
      close,
    ),
  );
  if (!details || details.loading) {
    container.append(el("div", { class: "details-body loading" }, icon("loading"), " Loading…"));
    return container;
  }
  if (details.error) {
    container.append(el("div", { class: "details-body error" }, icon("error"), ` ${details.error}`));
    return container;
  }
  const body = el("div", { class: "details-body" });
  if (details.details && !state.compare) {
    const d = details.details;
    const message = el("div", { class: "message" });
    message.innerHTML = details.message ?? "";
    const meta = el(
      "dl",
      { class: "meta" },
      el("dt", {}, "Commit"),
      el("dd", {}, el("code", { class: "selectable" }, d.hash)),
      el("dt", {}, d.parents.length > 1 ? "Parents" : "Parent"),
      el(
        "dd",
        {},
        ...(d.parents.length ? d.parents.flatMap((parent, i) => [i > 0 ? ", " : "", hashLink(parent)]) : ["None"]),
      ),
      el("dt", {}, "Author"),
      el("dd", {}, person(d.author, d.authorEmail, d.authorDate)),
      ...(d.committer !== d.author || d.committerEmail !== d.authorEmail || d.committerDate !== d.authorDate
        ? [el("dt", {}, "Committer"), el("dd", {}, person(d.committer, d.committerEmail, d.committerDate))]
        : []),
    );
    body.append(el("section", { class: "summary-pane" }, message, meta));
  }
  body.append(renderFiles(details.files ?? []));
  container.append(body);
  return container;
}

const compareLabel = (hash: string) => (hash === UNCOMMITTED ? "Working Tree" : short(hash));

function rerenderDetails(): void {
  rows.querySelector(".details-row .details")?.replaceWith(renderDetails());
}

/**
 * Opens a commit's details, or closes them with `undefined`. With `compare`
 * it is the second commit of a comparison with the one already open, as a
 * Ctrl/Cmd+click makes it.
 */
function select(hash: string | undefined, compare: boolean): void {
  const graph = state.graph;
  if (!graph) return;
  if (compare && state.open && hash && hash !== state.open) {
    state.compare = hash === state.compare ? undefined : hash;
  } else {
    if (hash === state.open && !state.compare) hash = undefined;
    state.open = hash;
    state.compare = undefined;
  }
  state.details = state.open ? { hash: state.open, loading: true } : undefined;
  renderRows();
  if (!state.open) return;
  request();
  const row = rows.querySelector<HTMLElement>(`tr.commit[data-hash="${CSS.escape(state.open)}"]`);
  row?.focus({ preventScroll: true });
  // Keep the open row and as much of its details as fit in view.
  const details = rows.querySelector<HTMLElement>(".details-row");
  if (row && details) {
    const top = row.offsetTop + table.offsetTop - head.offsetHeight;
    const bottom = details.offsetTop + table.offsetTop + details.offsetHeight;
    if (top < scroller.scrollTop || bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, Math.min(top - ROW * 2, bottom - scroller.clientHeight + ROW));
    }
  }
}

/**
 * The two commits compared, older first, as a diff reads: the list is newest
 * first, and the uncommitted changes, always first, are only ever the newer side.
 */
function compared(): [string, string] {
  const [open, other] = [state.open!, state.compare!];
  const index = (hash: string) => state.graph!.commits.findIndex((c) => c.hash === hash);
  return index(open) > index(other) ? [open, other] : [other, open];
}

/** Asks for what the open details show: one commit's, or the open one compared with another. */
function request(): void {
  const graph = state.graph!;
  const open = state.open!;
  if (state.compare) {
    const [from, to] = compared();
    post({ type: "compare", from, to });
  } else {
    const stash = graph.commits.find((c) => c.hash === open)?.stash;
    post({ type: "details", hash: open, stash: stash && { base: stash.base, untracked: stash.untracked } });
  }
}

// ---------------------------------------------------------------- find

function findMatches(): void {
  const graph = state.graph;
  const { query, caseSensitive, regex } = state.find;
  state.find.matches = [];
  findInput.classList.remove("invalid");
  if (graph && query) {
    let test: (text: string) => boolean;
    try {
      const pattern = new RegExp(
        regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        caseSensitive ? "" : "i",
      );
      test = (text) => pattern.test(text);
    } catch {
      findInput.classList.add("invalid");
      test = () => false;
    }
    graph.commits.forEach((commit, index) => {
      if (commit.hash === UNCOMMITTED) return;
      const fields = [
        commit.subject,
        commit.author,
        commit.email,
        ...commit.heads,
        ...commit.remotes.map((r) => r.name),
        ...commit.tags.map((t) => t.name),
      ];
      if (fields.some(test) || commit.hash.toLowerCase().startsWith(query.toLowerCase())) {
        state.find.matches.push(index);
      }
    });
  }
  if (state.find.current >= state.find.matches.length) state.find.current = state.find.matches.length - 1;
  if (state.find.current < 0 && state.find.matches.length > 0) state.find.current = 0;
  showMatches(false);
}

function showMatches(scroll: boolean): void {
  const { matches, current, query } = state.find;
  const current_ = matches[current];
  for (const row of rows.querySelectorAll<HTMLElement>("tr.commit")) {
    const index = Number(row.dataset.index);
    row.classList.toggle("match", matches.includes(index));
    row.classList.toggle("current-match", index === current_);
  }
  findCount.textContent = !query ? "" : matches.length === 0 ? "No results" : `${current + 1} of ${matches.length}`;
  findCount.classList.toggle("none", Boolean(query) && matches.length === 0);
  if (scroll && current_ !== undefined) {
    rows.querySelector<HTMLElement>(`tr.commit[data-index="${current_}"]`)?.scrollIntoView({ block: "center" });
  }
}

function step(direction: 1 | -1): void {
  const count = state.find.matches.length;
  if (count === 0) return;
  state.find.current = (state.find.current + direction + count) % count;
  showMatches(true);
}

findInput.addEventListener("input", () => {
  state.find.query = findInput.value;
  state.find.current = 0;
  findMatches();
  showMatches(true);
});
findInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
  } else if (event.key === "Escape") {
    // Only the find box's: the open details stay open.
    event.stopPropagation();
    findInput.value = "";
    state.find.query = "";
    findMatches();
    findInput.blur();
  }
});
for (const [toggle, key] of [[caseToggle, "caseSensitive"], [regexToggle, "regex"]] as const) {
  toggle.addEventListener("click", () => {
    state.find[key] = !state.find[key];
    toggle.classList.toggle("on", state.find[key]);
    toggle.setAttribute("aria-pressed", String(state.find[key]));
    findMatches();
  });
}
findPrevious.addEventListener("click", () => step(-1));
findNext.addEventListener("click", () => step(1));

// ---------------------------------------------------------------- toolbar

function renderToolbar(): void {
  repoSelect.replaceChildren(
    ...state.repos.map((repo) =>
      el("option", { value: repo, selected: repo === state.repo ? "" : undefined }, repo.split(/[/\\]/).pop() ?? repo)
    ),
  );
  repoSelect.title = state.repo ?? "";
  repoSelect.hidden = state.repos.length <= 1;
  const view = state.view;
  const chosen = view?.branches ?? [];
  const name = (branch: string) => branch.replace(/^remotes\//, "");
  branchButton.replaceChildren(
    icon("git-branch"),
    el(
      "span",
      { class: "label" },
      chosen.length === 0 ? "All Branches" : chosen.length === 1 ? name(chosen[0]) : `${chosen.length} Branches`,
    ),
    icon("chevron-down"),
  );
  remoteToggle.checked = view?.showRemoteBranches ?? true;
  const hasRemotes = state.remotes.length > 0;
  fetchButton.hidden = !hasRemotes;
  document.body.setAttribute(
    "data-vscode-context",
    context({
      repo: state.repo,
      polyRemotes: hasRemotes,
      polyDiffTool: state.diffTool,
    }),
  );
}

repoSelect.addEventListener("change", () => post({ type: "repo", repo: repoSelect.value }));
remoteToggle.addEventListener(
  "change",
  () => state.view && post({ type: "view", view: { ...state.view, showRemoteBranches: remoteToggle.checked } }),
);
fetchButton.addEventListener("click", () => post({ type: "fetch" }));
remotesButton.addEventListener("click", () => post({ type: "remotes" }));
refreshButton.addEventListener("click", () => post({ type: "refresh" }));

function openPopover(anchor: HTMLElement, content: HTMLElement): void {
  if (!popover.hidden && popover.dataset.for === anchor.id) {
    closePopover();
    return;
  }
  popover.replaceChildren(content);
  popover.dataset.for = anchor.id;
  popover.hidden = false;
  const box = anchor.getBoundingClientRect();
  popover.style.top = `${box.bottom + 4}px`;
  popover.style.left = `${Math.max(4, Math.min(box.left, window.innerWidth - popover.offsetWidth - 4))}px`;
  anchor.setAttribute("aria-expanded", "true");
  content.querySelector<HTMLElement>("input")?.focus({ preventScroll: true });
}

function closePopover(): void {
  if (popover.hidden) return;
  document.getElementById(popover.dataset.for ?? "")?.setAttribute("aria-expanded", "false");
  popover.hidden = true;
}

document.addEventListener("mousedown", (event) => {
  const target = event.target as Node;
  if (
    !popover.hidden && !popover.contains(target)
    && !document.getElementById(popover.dataset.for ?? "")?.contains(target)
  ) closePopover();
});

branchButton.addEventListener("click", () => {
  const graph = state.graph;
  const view = state.view;
  if (!graph || !view) return;
  const filter = el("input", {
    type: "text",
    placeholder: "Filter branches",
    class: "popover-filter",
    spellcheck: "false",
    "aria-label": "Filter branches",
  });
  const list = el("ul", { class: "choices", role: "listbox", "aria-multiselectable": "true" });
  const chosen = new Set(view.branches);
  const apply = () => post({ type: "view", view: { ...view, branches: [...chosen] } });
  const option = (label: string, checked: boolean, onChange: (on: boolean) => void, iconName?: string) => {
    const box = el("input", { type: "checkbox" });
    box.checked = checked;
    box.addEventListener("change", () => onChange(box.checked));
    return el(
      "li",
      { role: "option", "data-label": label.toLowerCase() },
      el("label", {}, box, iconName ? icon(iconName) : undefined, el("span", {}, label)),
    );
  };
  list.append(option("Show All", chosen.size === 0, (on) => {
    if (on) {
      chosen.clear();
      apply();
      closePopover();
    }
  }));
  for (const branch of graph.branches) {
    const remote = branch.startsWith("remotes/");
    list.append(option(remote ? branch.slice("remotes/".length) : branch, chosen.has(branch), (on) => {
      if (on) chosen.add(branch);
      else chosen.delete(branch);
      apply();
    }, remote ? "cloud" : "git-branch"));
  }
  filter.addEventListener("input", () => {
    const text = filter.value.toLowerCase();
    for (const item of list.querySelectorAll<HTMLElement>("li")) {
      item.hidden = !(item.dataset.label ?? "").includes(text);
    }
  });
  openPopover(branchButton, el("div", { class: "branch-popover" }, filter, list));
});

optionsButton.addEventListener("click", () => {
  const view = state.view;
  if (!view) return;
  const update = (change: Partial<ViewOptions>) => post({ type: "view", view: { ...view, ...change } });
  const check = (label: string, checked: boolean, onChange: (on: boolean) => void) => {
    const box = el("input", { type: "checkbox" });
    box.checked = checked;
    box.addEventListener("change", () => onChange(box.checked));
    return el("label", { class: "option" }, box, el("span", {}, label));
  };
  const order = (label: string, value: ViewOptions["order"]) => {
    const radio = el("input", { type: "radio", name: "order" });
    radio.checked = view.order === value;
    radio.addEventListener("change", () => update({ order: value }));
    return el("label", { class: "option" }, radio, el("span", {}, label));
  };
  openPopover(
    optionsButton,
    el(
      "div",
      { class: "options-popover" },
      el("div", { class: "popover-title" }, "Show"),
      check("Tags", view.showTags, (on) => update({ showTags: on })),
      check("Stashes", view.showStashes, (on) => update({ showStashes: on })),
      check("Uncommitted Changes", view.showUncommitted, (on) => update({ showUncommitted: on })),
      check("Only First Parents", view.firstParent, (on) => update({ firstParent: on })),
      check("Merge Commits Muted", state.columns.muteMerges, (on) => {
        state.columns.muteMerges = on;
        post({ type: "columns", columns: state.columns });
        renderRows();
      }),
      el("div", { class: "popover-title" }, "Order"),
      order("Commit Date", "date"),
      order("Author Date", "author-date"),
      order("Topological", "topo"),
    ),
  );
});

// ---------------------------------------------------------------- table events

rows.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest(".details-row") || target.closest("a")) return;
  const row = target.closest<HTMLElement>("tr.commit");
  if (row) select(row.dataset.hash, event.ctrlKey || event.metaKey);
});
rows.addEventListener("dblclick", (event) => {
  const label = (event.target as HTMLElement).closest<HTMLElement>(".ref.branch:not(.current)");
  if (label?.dataset.branch) post({ type: "checkout", branch: label.dataset.branch });
});

document.addEventListener("keydown", (event) => {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (mod && key === "f") {
    event.preventDefault();
    findInput.focus();
    findInput.select();
  } else if (mod && key === "r") {
    event.preventDefault();
    post({ type: "refresh" });
  } else if (mod && key === "h") {
    event.preventDefault();
    const head = state.graph?.head;
    if (head) rows.querySelector<HTMLElement>(`tr.commit[data-hash="${head}"]`)?.scrollIntoView({ block: "center" });
  } else if (mod && key === "s") {
    // Each press moves to the next stash, as Git Graph's shortcut does.
    event.preventDefault();
    const stashes = [...rows.querySelectorAll<HTMLElement>("tr.stash-row")];
    if (stashes.length === 0) return;
    const after = stashes.find((row) => row.offsetTop > scroller.scrollTop + scroller.clientHeight / 2) ?? stashes[0];
    after.scrollIntoView({ block: "center" });
  } else if (event.key === "Escape") {
    if (!popover.hidden) closePopover();
    else if (state.open) select(undefined, false);
  } else if (
    (event.key === "ArrowDown" || event.key === "ArrowUp") && state.open
    && !(event.target as HTMLElement).closest("input, select, .files, .popover")
  ) {
    event.preventDefault();
    const commits = state.graph!.commits;
    const at = commits.findIndex((c) => c.hash === state.open);
    const next = commits[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) select(next.hash, false);
  }
});

let more: IntersectionObserver | undefined;
function renderFooter(): void {
  footer.replaceChildren();
  more?.disconnect();
  const graph = state.graph;
  if (!graph?.more) return;
  const load = el("button", { class: "text-button" }, "Load More Commits");
  load.addEventListener("click", () => requestMore());
  footer.append(load);
  // Git Graph loads more on its own once the end comes into view.
  more = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) requestMore();
  }, { root: scroller, rootMargin: "200px" });
  more.observe(footer);
}
function requestMore(): void {
  if (state.waitingForMore) return;
  state.waitingForMore = true;
  footer.replaceChildren(el("span", { class: "loading-more" }, icon("loading"), " Loading more commits…"));
  post({ type: "more" });
}

function showNotice(text: string | undefined, error = false): void {
  notice.hidden = text === undefined;
  notice.classList.toggle("error", error);
  notice.replaceChildren(...text === undefined ? [] : [icon(error ? "error" : "info"), el("span", {}, text)]);
  scroller.hidden = text !== undefined && !state.graph?.commits.length;
}

// ---------------------------------------------------------------- messages

window.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as { type: string; [key: string]: unknown };
  switch (message.type) {
    case "busy":
      progress.hidden = !message.on;
      return;
    case "repos":
      state.repos = message.repos as string[];
      renderToolbar();
      return;
    case "error":
      progress.hidden = true;
      state.waitingForMore = false;
      showNotice(message.message as string, true);
      return;
    case "graph": {
      progress.hidden = true;
      state.waitingForMore = false;
      const changedRepo = message.repo !== state.repo;
      state.repos = message.repos as string[];
      state.repo = message.repo as string | undefined;
      if (!state.repo) {
        state.graph = undefined;
        renderToolbar();
        rows.replaceChildren();
        showNotice("No Git repository is open in this window. Open a folder that has one, or run git init.");
        return;
      }
      state.view = message.view as ViewOptions;
      state.graph = message.graph as Graph;
      state.subjects = message.subjects as string[];
      state.remotes = message.remotes as Remote[];
      state.diffTool = message.diffTool as boolean;
      if (message.columns) state.columns = { ...state.columns, ...message.columns as Partial<Columns> };
      state.layout = layout(state.graph.commits, state.view.firstParent, state.graph.head);
      if (changedRepo || !state.graph.commits.some((c) => c.hash === state.open)) {
        state.open = undefined;
        state.compare = undefined;
        state.details = undefined;
      }
      if (changedRepo) scroller.scrollTop = 0;
      renderToolbar();
      renderHeader();
      renderRows();
      showNotice(state.graph.commits.length === 0 ? "No commits yet." : undefined);
      renderFooter();
      findMatches();
      // A refresh keeps an open commit open, its details shown until they are
      // read again: a checkout changes the uncommitted changes, an amend the files.
      if (state.compare && !state.graph.commits.some((c) => c.hash === state.compare)) {
        state.compare = undefined;
        state.details = { hash: state.open!, loading: true };
        rerenderDetails();
      }
      if (state.open) request();
      return;
    }
    case "details":
    case "compare": {
      // Replies to requests since overtaken are dropped.
      const current = message.type === "compare"
        ? state.compare !== undefined && [state.open, state.compare].includes(message.from as string)
          && [state.open, state.compare].includes(message.to as string)
        : state.compare === undefined && message.hash === state.open;
      if (!current) return;
      state.details = {
        hash: state.open!,
        details: message.details as CommitDetails | undefined,
        files: message.files as FileEntry[] | undefined,
        message: message.message as string | undefined,
        error: message.error as string | undefined,
      };
      rerenderDetails();
      return;
    }
    case "toggleColumn": {
      const column = message.column as Column;
      state.columns.hidden = state.columns.hidden.includes(column)
        ? state.columns.hidden.filter((c) => c !== column)
        : [...state.columns.hidden, column];
      post({ type: "columns", columns: state.columns });
      renderHeader();
      renderRows();
      return;
    }
  }
});

post({ type: "ready" });

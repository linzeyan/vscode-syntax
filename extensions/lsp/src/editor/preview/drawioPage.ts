/**
 * Starts draw.io's web app in the draw.io editor's webview, and carries
 * messages between it and the extension. Loaded before the app, from the page
 * ../drawio.ts writes.
 *
 * draw.io embedded talks to whoever framed or opened it: it posts to
 * `window.opener || window.parent`, and acts on a message only when that same
 * window sent it. Here the parent is VSCode's own frame, so both ends are one
 * window poly owns instead -- a blank frame of its own. What draw.io posts
 * lands on that frame and goes on to the extension; what the extension sends
 * is dispatched again as though that frame had sent it. draw.io's code is not
 * edited; one of its defaults is set, and the plugins the user allowed are
 * handed to it, below, with one of poly's own for code links.
 */
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

interface Cell {
  value: unknown;
}

interface Graph {
  addListener(
    name: "doubleClick",
    listener: (sender: unknown, event: { getProperty(name: "cell"): Cell | null; consume(): void }) => void,
  ): void;
  getSelectionCell(): Cell | null;
  convertValueToString(cell: Cell): string;
  isHtmlLabel(cell: Cell): boolean;
  getModel(): { setValue(cell: Cell, value: unknown): void };
}

interface DrawioWindow {
  urlParams: Record<string, string>;
  isLocalStorage: boolean;
  mxIsElectron: boolean;
  mxscript: typeof mxscript;
  mxinclude: typeof mxinclude;
  mxmeta: typeof mxmeta;
  App: { main(): void; initPluginCallback(): void; embedModePluginsCount: number };
  Draw: { loadPlugin(plugin: (ui: { editor: { graph: Graph } }) => void): void };
  mxUrlConverter: { prototype: { baseUrl: string | null; baseDomain: string | null } };
  mxSettings: { setResizeImages(resize: boolean | null): void; save(): void };
}
const drawio = window as unknown as DrawioWindow;

const vscode = acquireVsCodeApi();
const page = document.currentScript as HTMLScriptElement;

// What draw.io's index.html defines before it loads the app, and the app
// calls afterwards: its parameters, and its script and meta loaders.
drawio.urlParams = JSON.parse(atob(page.dataset.params ?? ""));
drawio.isLocalStorage = true;
drawio.mxIsElectron = false;

function mxscript(
  src: string,
  onLoad?: () => void,
  id?: string,
  dataAppKey?: string,
  _noWrite?: boolean,
  onError?: (message: string, error: Event | string) => void,
): void {
  const script = document.createElement("script");
  script.src = src;
  if (id) {
    script.id = id;
  }
  if (dataAppKey) {
    script.setAttribute("data-app-key", dataAppKey);
  }
  if (onLoad) {
    script.onload = () => onLoad();
  }
  if (onError) {
    script.onerror = (error) => onError(`Failed to load ${src}`, error);
  }
  document.head.append(script);
}

function mxinclude(src: string): void {
  const script = document.createElement("script");
  script.async = true;
  script.src = src;
  document.head.append(script);
}

function mxmeta(name: string | null, content: string, httpEquiv?: string): void {
  const meta = document.createElement("meta");
  if (name !== null) {
    meta.name = name;
  }
  meta.content = content;
  if (httpEquiv) {
    meta.httpEquiv = httpEquiv;
  }
  document.head.prepend(meta);
}

drawio.mxscript = mxscript;
drawio.mxinclude = mxinclude;
drawio.mxmeta = mxmeta;

const channel = document.createElement("iframe");
channel.hidden = true;
document.head.append(channel);
const peer = channel.contentWindow as Window;
Object.defineProperty(window, "opener", { value: peer });

peer.addEventListener("message", (event: MessageEvent<string>) => vscode.postMessage(JSON.parse(event.data)));

// Code links, which draw.io's messages have no part in: the node a link is
// written to, and a double click taken from label editing, are the graph's.
let graph: Graph | undefined;
let codeLinks = false;

/**
 * A double click on a node, while code links are on, told to the extension
 * instead of editing the label: the label's text, and the node's attributes,
 * which hold its link if it has one.
 */
function codeLinkPlugin(ui: { editor: { graph: Graph } }) {
  graph = ui.editor.graph;
  graph.addListener("doubleClick", (_sender, event) => {
    const cell = event.getProperty("cell");
    if (!codeLinks || !cell || !graph) {
      return;
    }
    event.consume();
    let label = graph.convertValueToString(cell);
    if (graph.isHtmlLabel(cell)) {
      // A parsed document is inert: nothing in the label runs or loads.
      label = new DOMParser().parseFromString(label, "text/html").body.textContent ?? "";
    }
    const value = cell.value instanceof Element ? cell.value : undefined;
    const attributes = Object.fromEntries(Array.from(value?.attributes ?? [], (one) => [one.name, one.value]));
    vscode.postMessage({ event: "poly.doubleClick", label, attributes });
  });
}

/**
 * `attributes` written to the node selected, in place of the link it had, as
 * one undoable change; the label becomes an `<object>` holding it, as
 * draw.io's own Edit Data makes one.
 */
function link(prefix: string, attributes: [string, string][]) {
  const cell = graph?.getSelectionCell();
  if (graph && cell) {
    let value: Element;
    if (cell.value instanceof Element) {
      value = cell.value.cloneNode(true) as Element;
    } else {
      value = document.implementation.createDocument(null, null).createElement("object");
      value.setAttribute("label", String(cell.value ?? ""));
    }
    for (const name of value.getAttributeNames().filter((one) => one.startsWith(prefix))) {
      value.removeAttribute(name);
    }
    for (const [name, text] of attributes) {
      value.setAttribute(name, text);
    }
    graph.getModel().setValue(cell, value);
  }
  vscode.postMessage({ event: "poly.linked", linked: !!cell });
}

window.addEventListener("message", (event) => {
  // The re-dispatch below arrives here too; and VSCode's frame may post its
  // own traffic, which is not draw.io's to see.
  if (event.source === peer || typeof event.data?.action !== "string") {
    return;
  }
  if (event.data.action === "poly.codeLinks") {
    codeLinks = event.data.on === true;
    return;
  }
  if (event.data.action === "poly.link") {
    link(event.data.prefix, event.data.attributes);
    return;
  }
  // The plugins the user allowed, queued as draw.io queues the ones it loads
  // itself: it runs them once its editor exists, and holds its start until
  // each has. Queued before draw.io has `configure`, which it waits for
  // before it loads any, and may start on at once.
  if (event.data.action === "configure") {
    drawio.App.initPluginCallback();
    drawio.App.embedModePluginsCount++;
    drawio.Draw.loadPlugin(codeLinkPlugin);
    for (const plugin of (event.data.plugins ?? []) as string[]) {
      drawio.App.embedModePluginsCount++;
      try {
        // Indirect, so it runs as a script would: in the global scope.
        (0, eval)(plugin);
      } catch (error) {
        // It will not queue itself; draw.io would wait for it until it times out.
        drawio.App.embedModePluginsCount--;
        console.error("draw.io plugin failed to load:", error);
      }
    }
  }
  window.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event.data), source: peer }));
  // The answer to draw.io's "resize large images?" is the setting's, unset
  // being none, so that draw.io asks, as in hediet: draw.io keeps its
  // settings in storage, and an answer from an earlier start would outlive
  // the setting that gave it. draw.io loads them on `configure`, handled as
  // it was dispatched just above, so this goes after; and saved, because
  // draw.io reads them again while it starts (setting up the scratchpad).
  if (event.data.action === "configure") {
    drawio.mxSettings.setResizeImages(JSON.parse(page.dataset.resizeImages ?? "null"));
    drawio.mxSettings.save();
  }
});

// index.html's order: the app's scripts, then the window, then main.
window.addEventListener("load", () => {
  // draw.io resolves a picture a shape names by a relative path
  // (`image=img/lib/...`) against the page's location, not its <base>. On
  // draw.io's site the two are one place; here the location is VSCode's
  // webview host, which answers 403 for draw.io's files.
  const converter = drawio.mxUrlConverter.prototype;
  converter.baseUrl = document.baseURI;
  converter.baseDomain = new URL(document.baseURI).origin;
  drawio.App.main();
});

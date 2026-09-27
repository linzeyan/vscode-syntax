/**
 * Carries messages between draw.io on the web, in the page's frame, and the
 * extension: the same messages drawioPage.ts carries for the copy poly ships,
 * so the extension does not tell the two apart. Loaded from the page
 * ../drawio.ts writes for it.
 */
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

// A module, so that its names are its own, not globals beside drawioPage.ts's.
export {};

const vscode = acquireVsCodeApi();
const frame = document.querySelector("iframe") as HTMLIFrameElement;
const drawioOrigin = new URL(frame.src).origin;

window.addEventListener("message", (event) => {
  // draw.io's own, from its frame and origin alone: whatever else the web
  // page it navigates to might post is not the extension's to hear.
  if (event.source === frame.contentWindow) {
    if (event.origin === drawioOrigin && typeof event.data === "string") {
      vscode.postMessage(JSON.parse(event.data));
    }
    return;
  }
  // The extension's, through VSCode's frame; draw.io takes them as text.
  if (typeof event.data?.action === "string") {
    frame.contentWindow?.postMessage(JSON.stringify(event.data), drawioOrigin);
  }
});

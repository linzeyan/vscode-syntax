/**
 * Drawing the non-mermaid diagram fences, inside the markdown preview's webview.
 *
 * This is the small script every preview loads (`dist/diagrams.js`); the
 * libraries are not in it. It finds the blocks ../diagrams.ts emitted and
 * fetches the one renderer bundle each kind needs, the first time a document
 * uses it -- vega and markmap are 800 KB apiece, and most documents use none.
 */
import DOMPurify from "dompurify";

import { DIAGRAM_CLASS, DIAGRAMS } from "../diagrams";
import type { Render } from "./diagram/register";
import { isDarkTheme } from "./theme";

/**
 * Where the renderers live, and the nonce that lets them run.
 *
 * Read now, while this script is the one executing: `currentScript` is null
 * again once it returns. The preview's policy admits scripts by nonce alone,
 * so a `<script>` added later runs only if it carries the same one.
 */
const self = document.currentScript as HTMLScriptElement;
const base = self.src;
const nonce = self.nonce;

const loading = new Map<string, Promise<Render>>();

/**
 * Renderers that are modules instead: Excalidraw's sits beside the editor's
 * page and shares its chunks, so its 9 MB are in the package once. A module's
 * imports carry its nonce.
 */
const MODULES: Readonly<Record<string, string>> = { excalidraw: "excalidraw/fence.js" };

function renderer(bundle: string): Promise<Render> {
  let pending = loading.get(bundle);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL(MODULES[bundle] ?? `diagram/${bundle}.js`, base).href;
      if (MODULES[bundle]) {
        script.type = "module";
      }
      script.nonce = nonce;
      script.onload = () => {
        const render = window.polyDiagram?.[bundle];
        if (render) {
          resolve(render);
        } else {
          reject(new Error(`the ${bundle} renderer loaded and registered nothing`));
        }
      };
      script.onerror = () => reject(new Error(`the ${bundle} renderer did not load`));
      document.head.append(script);
    });
    loading.set(bundle, pending);
  }
  return pending;
}

/**
 * The libraries that draw in fixed dark ink on a transparent background. On a
 * dark preview their lines vanish, and none of them takes a palette, so they
 * get a light card instead; markmap has a dark style of its own.
 */
const PAPER = new Set(["nomnoml", "flowchart", "sequence", "vega"]);

/** Same shape as mermaid's failure: the source stays, the message goes under it. */
function failure(kind: string, source: string, error: unknown): HTMLElement {
  const block = document.createElement("pre");
  block.className = `${DIAGRAM_CLASS} ${DIAGRAM_CLASS}-error`;
  block.dataset.diagram = kind;
  block.textContent = source;
  const message = document.createElement("div");
  message.className = `${DIAGRAM_CLASS}-message`;
  message.textContent = error instanceof Error ? error.message : String(error);
  block.append(message);
  return block;
}

/** The render allowed to finish; see preview/mermaid.ts for the race. */
let generation = 0;

async function drawOne(block: HTMLElement, mine: number): Promise<void> {
  const kind = block.dataset.diagram ?? "";
  const bundle = DIAGRAMS[kind];
  const source = (block.textContent ?? "").trim();
  // An unknown kind cannot come from ../diagrams.ts, and an empty fence is a
  // diagram nobody has started writing: both stay as they are.
  if (!bundle || source === "") {
    return;
  }
  try {
    const svg = await (await renderer(bundle))(source, kind);
    if (mine !== generation) {
      return;
    }
    const host = document.createElement("div");
    host.className = `${DIAGRAM_CLASS} ${DIAGRAM_CLASS}-${bundle}`;
    if (PAPER.has(bundle)) {
      host.classList.add(`${DIAGRAM_CLASS}-paper`);
    } else if (isDarkTheme()) {
      host.classList.add("markmap-dark");
    }
    // The libraries build their SVG from the document's text, and the
    // preview is not a trusted document. The policy already refuses inline
    // script, but a user can relax it, and then this is what is left.
    host.innerHTML = DOMPurify.sanitize(svg, {
      // mermaid's own settings for the same library: markmap draws its
      // labels as HTML inside <foreignObject>, and without the integration
      // point the sanitizer keeps the element and drops every label in it.
      ADD_TAGS: ["foreignobject"],
      ADD_ATTR: ["dominant-baseline"],
      HTML_INTEGRATION_POINTS: { foreignobject: true },
    });
    block.replaceWith(host);
  } catch (error) {
    if (mine !== generation) {
      return;
    }
    block.replaceWith(failure(kind, source, error));
  }
}

async function draw(): Promise<void> {
  const mine = ++generation;
  const blocks = Array.from(
    document.querySelectorAll<HTMLElement>(`pre.${DIAGRAM_CLASS}:not(.${DIAGRAM_CLASS}-error)`),
  );
  // All at once rather than in document order: markmap waits for an animation
  // frame, which a covered or hidden preview never gets, and in a queue every
  // diagram after it waited too -- measured: in a covered window, every
  // diagram below a markmap stayed source.
  await Promise.all(blocks.map((block) => drawOne(block, mine)));
}

window.addEventListener("vscode.markdown.updateContent", () => {
  void draw();
});
void draw();

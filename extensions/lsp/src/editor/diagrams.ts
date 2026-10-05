/**
 * The diagram fences other than mermaid, and what the preview gets instead.
 *
 * The set is MarkNote's: nomnoml, flowchart.js (as `flowchart` or `flow`),
 * js-sequence-diagrams (`sequence`), vega and vega-lite, markmap, and an
 * Excalidraw scene's JSON (`excalidraw`). No
 * built-in draws any of them, so unlike mermaid there is nothing to stand down
 * for. The split is mermaid's too: this module runs in the extension host and
 * decides the markup, `preview/diagrams.ts` draws it in the webview.
 */
import { escapeHtml } from "./mermaid";

/** The class the webview script looks for. */
export const DIAGRAM_CLASS = "poly-diagram";

/**
 * Fence language -> the renderer bundle that draws it.
 *
 * A bundle per library rather than one for all: vega and markmap are 800 KB
 * each, and the preview only fetches the ones a document uses.
 */
export const DIAGRAMS: Readonly<Record<string, string>> = {
  nomnoml: "nomnoml",
  flowchart: "flowchart",
  flow: "flowchart",
  sequence: "sequence",
  vega: "vega",
  "vega-lite": "vega",
  markmap: "markmap",
  excalidraw: "excalidraw",
};

/**
 * Which diagram this fence is, if any.
 *
 * The first word of the info string, in any case. MarkNote matches the whole
 * info string exactly; taking the first word accepts everything it accepts and
 * also ```vega-lite {caption}, which is how other renderers spell attributes.
 */
export function diagramOf(info: string): string | undefined {
  const word = info.trim().split(/\s+/)[0].toLowerCase();
  return Object.hasOwn(DIAGRAMS, word) ? word : undefined;
}

/** The element the webview script replaces; see `mermaidBlock` for the `<pre>`. */
export function diagramBlock(kind: string, source: string): string {
  return `<pre class="${DIAGRAM_CLASS}" data-diagram="${kind}">${escapeHtml(source)}</pre>`;
}

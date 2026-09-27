/**
 * Which fenced block is a diagram, and what the preview gets instead of it.
 *
 * The markdown preview renders a ```mermaid fence the way it renders any fence
 * it cannot highlight: as the source text. Turning that text into a diagram
 * takes mermaid.js, and mermaid.js only runs in the preview's webview -- so the
 * work is split. This module runs in the extension host and decides what markup
 * the fence becomes; `preview/mermaid.ts` runs in the webview and draws it.
 *
 * VSCode ships `mermaid-markdown-features` since 1.135 and it does this same
 * job. poly's `engines.vscode` is `^1.85.0`, which is the whole reason this
 * exists: below 1.135 there is nothing in the editor that draws a diagram, and
 * above it poly must stand down rather than draw a second one. The standing
 * down is in `extension.ts`, where the extension registry can be asked; here
 * there is only the markup.
 */

/** The class the webview script looks for. Not `mermaid`: that is the class
 * the built-in and bierner's extension both claim, and a shared name is how
 * two renderers end up fighting over one element. */
export const MERMAID_CLASS = "poly-mermaid";

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (character) => ESCAPES[character]);
}

/**
 * Is this fence a mermaid diagram?
 *
 * Word boundaries rather than an exact match, and this is a copy rather than a
 * choice: it is the test `mermaid-markdown-features` makes (`new RegExp("\\b(" +
 * languageIds.join("|") + ")\\b", "i")` around markdown-it's `highlight` hook),
 * and below 1.135 poly is standing in for exactly that. The same document has
 * to draw the same diagrams the day the editor updates -- a stricter rule here
 * would mean fences that stop rendering on an upgrade, which is a worse defect
 * than the quirk it fixes.
 *
 * The quirk is real: ```mermaid-example, the fence mermaid's own documentation
 * uses for source it is talking *about*, is inside the boundary and gets drawn.
 */
const MERMAID_FENCE = /\bmermaid\b/i;

export function isMermaidFence(info: string): boolean {
  return MERMAID_FENCE.test(info);
}

/**
 * Is this `:::` block a mermaid diagram?
 *
 * Stricter than the fence above, and the asymmetry is upstream's rather than
 * a position of poly's: the built-in matches a fence with `\bmermaid\b` but a
 * container with `info.trim().split(" ")[0].toLowerCase() !== "mermaid"`. Both
 * rules are copied as they are, because the point of having them at all is that
 * a document renders the same on either side of VSCode 1.135.
 */
export function isMermaidContainer(info: string): boolean {
  return info.trim().split(" ")[0].toLowerCase() === "mermaid";
}

/**
 * The element the webview script turns into a diagram.
 *
 * A `<pre>` rather than a `<div>` so that the source stays readable, with the
 * preview's own code-block styling, for the two cases where no diagram appears:
 * the script has not run yet, and the markup does not parse. The source goes in
 * as text -- it is read back with `textContent`, so escaping it here is what
 * keeps a diagram from being able to write HTML into the preview.
 */
export function mermaidBlock(source: string): string {
  return `<pre class="${MERMAID_CLASS}">${escapeHtml(source)}</pre>`;
}

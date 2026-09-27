/**
 * How a renderer bundle hands itself to the loader.
 *
 * Each library is its own bundle (see ../../diagrams.ts for why), loaded by a
 * `<script>` the loader adds, so the only thing the two share at run time is
 * this table on `window`.
 */
export type Render = (source: string, kind: string) => Promise<string>;

declare global {
  interface Window {
    polyDiagram?: Record<string, Render>;
  }
}

export function register(bundle: string, render: Render): void {
  (window.polyDiagram ??= {})[bundle] = render;
}

/**
 * Draw into a detached-from-view element that is still in the document.
 *
 * flowchart.js, js-sequence-diagrams and markmap all measure the text they lay
 * out, which needs layout, which needs the element attached -- MarkNote parks
 * it off screen for the same reason.
 */
export async function offscreen<T extends Element>(element: T, draw: (element: T) => Promise<void> | void): Promise<T> {
  (element as unknown as HTMLElement).style.position = "absolute";
  (element as unknown as HTMLElement).style.left = "-9999px";
  document.body.append(element);
  try {
    await draw(element);
  } finally {
    element.remove();
  }
  (element as unknown as HTMLElement).style.position = "";
  (element as unknown as HTMLElement).style.left = "";
  return element;
}

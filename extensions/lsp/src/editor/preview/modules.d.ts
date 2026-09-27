// The two libraries the diagram renderers use that ship no types, declared only
// as far as the renderers reach into them.
declare module "flowchart.js" {
  export function parse(source: string): {
    drawSVG(container: HTMLElement, options?: Record<string, unknown>): void;
  };
}

declare module "raphael" {
  const Raphael: unknown;
  export default Raphael;
}

interface Window {
  Raphael?: unknown;
}

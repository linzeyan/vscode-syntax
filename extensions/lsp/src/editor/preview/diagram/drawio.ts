import { isDarkTheme } from "../theme";
import { offscreen, register } from "./register";

interface Viewer {
  graph: {
    getSvg(
      background: string | null,
      scale: number,
      border: number,
      nocrop: boolean,
      crisp: null,
      ignoreSelection: boolean,
      showText: null,
      imgExport: null,
      linkTarget: null,
      hasShadow: null,
      incExtFonts: null,
      theme: "light" | "dark",
    ): SVGSVGElement;
  };
}

interface DrawioViewerWindow {
  GraphViewer: new(container: HTMLElement, xml: Element, config: Record<string, unknown>) => Viewer;
  mxUtils: { parseXml(xml: string): Document };
  mxUrlConverter: { prototype: { baseUrl: string | null; baseDomain: string | null } };
  mxStencilRegistry: { allowEval: boolean };
  MathJax?: unknown;
  onDrawioViewerLoad?: () => void;
}
const drawio = window as unknown as DrawioViewerWindow;

// Read while this bundle is the script running; see ../diagrams.ts.
const self = document.currentScript as HTMLScriptElement;
/** draw.io's web app, which poly ships for its editor: the viewer is in it. */
const webapp = new URL("../drawio/", self.src).href;

function script(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const element = document.createElement("script");
    element.src = new URL(file, webapp).href;
    element.nonce = self.nonce;
    element.onload = () => resolve();
    element.onerror = () => reject(new Error(`draw.io's ${file} did not load`));
    document.head.append(element);
  });
}

let loading: Promise<void> | undefined;

/**
 * draw.io's viewer, loaded the first time a document has a fence, with every
 * shape it can draw: 13 MB, once a preview. Left to itself it fetches from
 * draw.io's site -- MathJax as it starts, and a set of shapes the first time
 * one is drawn -- which the preview's policy refuses, and a refusal is the
 * preview saying content was disabled, as it does under hediet's. Here the
 * shapes are the web app's own copies, loaded as its offline editor loads
 * them, and there is no MathJax: a MathJax already there the viewer leaves
 * alone, so a formula shows as its TeX.
 */
function viewer(): Promise<void> {
  loading ??= (async () => {
    drawio.MathJax ??= {};
    // The viewer's own hook for once it has started; set, it no longer draws
    // every `.mxgraph` element the document has.
    drawio.onDrawioViewerLoad = () => undefined;
    await script("js/viewer-static.min.js");
    await script("js/shapes-14-6-5.min.js");
    // Answers for each set of shapes before a request is made.
    await script("js/stencils.min.js");
    // The shapes' code is loaded above; this would fetch it again, to eval.
    drawio.mxStencilRegistry.allowEval = false;
    // A shape's picture named by a relative path (`image=img/lib/...`) is one
    // of the web app's files.
    drawio.mxUrlConverter.prototype.baseUrl = webapp;
    drawio.mxUrlConverter.prototype.baseDomain = new URL(webapp).origin;
  })();
  return loading;
}

// As hediet draws a fence: the diagram's first page at its own size, in the
// preview's light or dark (the room around it is media/diagrams.css's); as a
// picture, drawn as draw.io exports one.
register("drawio", async (source) => {
  await viewer();
  const diagram = drawio.mxUtils.parseXml(source).documentElement;
  if (!["mxfile", "mxGraphModel"].includes(diagram.nodeName)) {
    // draw.io's words, as hediet shows them.
    throw new Error("Not a diagram file");
  }
  let svg = "";
  await offscreen(document.createElement("div"), (container) => {
    const shown = new drawio.GraphViewer(container, diagram, {
      lightbox: false,
      nav: false,
      // Drawn at once: off screen, the viewer would wait to be shown.
      "check-visible-state": false,
    });
    svg = shown.graph
      .getSvg(null, 1, 0, false, null, true, null, null, null, null, null, isDarkTheme() ? "dark" : "light")
      .outerHTML;
  });
  return svg;
});

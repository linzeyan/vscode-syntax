// MarkNote's render path, one library call per kind, with MarkNote's options.
//
// Transcribed from its widgets (src/components/editor/extensions/*Widget.ts):
// the same calls, the same options, the same trimmed source, no sanitizer and
// no theming. Bundled by run.js against poly's node_modules, so both sides run
// the same library versions and only the path around them differs.
import { exportToSvg } from "@excalidraw/excalidraw";
import * as flowchartModule from "flowchart.js";
import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";
import nomnoml from "nomnoml";
import Raphael from "raphael";
import * as vega from "vega";
import * as vegaLite from "vega-lite";

// MarkNote asks its own theme; in a webview this is the same question.
import { isDarkTheme } from "../../extensions/lsp/src/editor/preview/theme";

function offscreen(element) {
  element.style.position = "absolute";
  element.style.left = "-9999px";
  document.body.appendChild(element);
  return element;
}

window.reference = async function reference(kind, code) {
  if (kind === "nomnoml") {
    return nomnoml.renderSvg(code);
  }
  if (kind === "flowchart" || kind === "flow") {
    const parse = flowchartModule.default?.parse ?? flowchartModule.parse;
    const container = offscreen(document.createElement("div"));
    try {
      parse(code).drawSVG(container, { "line-width": 2, "font-size": 14 });
      const svg = container.querySelector("svg");
      if (!svg) throw new Error("Flowchart produced no SVG output");
      return svg.outerHTML;
    } finally {
      document.body.removeChild(container);
    }
  }
  if (kind === "sequence") {
    // Set here rather than at load: poly's own sequence bundle has to find
    // no Raphael but the one it sets, or a bundle that forgot would pass.
    window.Raphael = Raphael;
    const { Diagram, DiagramPainter } = await import("@hackmd/js-sequence-diagrams");
    const container = offscreen(document.createElement("div"));
    try {
      new DiagramPainter(Diagram.parse(code)).drawSvg(container, { theme: "simple" });
      const svg = container.querySelector("svg");
      if (!svg) throw new Error("Sequence diagram produced no SVG output");
      return svg.outerHTML;
    } finally {
      document.body.removeChild(container);
    }
  }
  if (kind === "vega" || kind === "vega-lite") {
    let spec = JSON.parse(code);
    if (kind === "vega-lite") spec = vegaLite.compile(spec).spec;
    const view = new vega.View(vega.parse(spec), { renderer: "none" });
    const svg = await view.toSVG();
    view.finalize();
    return svg;
  }
  if (kind === "markmap") {
    const { root } = new Transformer().transform(code);
    const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgEl.setAttribute("width", "800");
    svgEl.setAttribute("height", "400");
    offscreen(svgEl);
    try {
      const mm = Markmap.create(svgEl, { duration: 0 }, root);
      await mm.fit();
      if (svgEl.getAttribute("viewBox")) {
        svgEl.style.width = "100%";
        svgEl.style.maxWidth = "800px";
        svgEl.style.height = "auto";
      }
      svgEl.style.position = "";
      svgEl.style.left = "";
      return svgEl.outerHTML;
    } finally {
      document.body.removeChild(svgEl);
    }
  }
  if (kind === "excalidraw") {
    const data = JSON.parse(code);
    const svg = await exportToSvg({
      elements: data.elements || [],
      appState: { ...(data.appState || {}), exportWithDarkMode: isDarkTheme(), exportBackground: true },
      files: data.files || null,
    });
    return svg.outerHTML;
  }
  throw new Error(`no reference for ${kind}`);
};

import Raphael from "raphael";

import { offscreen, register } from "./register";

// js-sequence-diagrams draws through a Raphael it expects to find as a global,
// so it is set before the library is loaded rather than imported beside it.
window.Raphael = Raphael;

register("sequence", async (source) => {
  const { Diagram, DiagramPainter } = await import("@hackmd/js-sequence-diagrams");
  const host = await offscreen(document.createElement("div"), (element) => {
    new DiagramPainter(Diagram.parse(source)).drawSvg(element, { theme: "simple" });
  });
  const svg = host.querySelector("svg");
  if (!svg) {
    throw new Error("js-sequence-diagrams drew nothing");
  }
  return svg.outerHTML;
});

import { Transformer } from "markmap-lib";
import { Markmap } from "markmap-view";

import { offscreen, register } from "./register";

const WIDTH = 800;
const HEIGHT = 400;

register("markmap", async (source) => {
  const { root } = new Transformer().transform(source);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(WIDTH));
  svg.setAttribute("height", String(HEIGHT));
  await offscreen(svg, async (element) => {
    // No transition, so the tree is laid out by the time `fit` returns.
    await Markmap.create(element, { duration: 0 }, root).fit();
  });
  if (svg.hasAttribute("viewBox")) {
    svg.style.width = "100%";
    svg.style.maxWidth = `${WIDTH}px`;
    svg.style.height = "auto";
  }
  return svg.outerHTML;
});

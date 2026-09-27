import { parse } from "flowchart.js";

import { offscreen, register } from "./register";

register("flowchart", async (source) => {
  const host = await offscreen(document.createElement("div"), (element) => {
    // MarkNote's two options; the rest are flowchart.js's defaults.
    parse(source).drawSVG(element, { "line-width": 2, "font-size": 14 });
  });
  const svg = host.querySelector("svg");
  if (!svg) {
    throw new Error("flowchart.js drew nothing");
  }
  return svg.outerHTML;
});

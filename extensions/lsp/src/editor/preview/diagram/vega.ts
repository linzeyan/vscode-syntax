import { parse, View } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { compile } from "vega-lite";

import { register } from "./register";

register("vega", async (source, kind) => {
  const spec = JSON.parse(source);
  // The interpreter rather than vega's default expression compiler, which
  // builds functions from strings: the preview's policy has no 'unsafe-eval',
  // and there every spec with an expression in it -- which is every vega-lite
  // spec once compiled -- failed to draw at all. `ast: true` is what the
  // interpreter walks instead.
  const runtime = parse(kind === "vega-lite" ? compile(spec).spec : spec, undefined, { ast: true });
  // `renderer: "none"` because the SVG is asked for as a string, not drawn
  // into the page: it goes through the same sanitizer as every other diagram.
  const view = new View(runtime, { expr: expressionInterpreter, renderer: "none" });
  try {
    return await view.toSVG();
  } finally {
    view.finalize();
  }
});

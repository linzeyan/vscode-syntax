import nomnoml from "nomnoml";

import { register } from "./register";

// No document handed over, as MarkNote calls it: nomnoml then estimates text
// widths instead of measuring them, and the layout matches MarkNote's.
register("nomnoml", (source) => Promise.resolve(nomnoml.renderSvg(source)));

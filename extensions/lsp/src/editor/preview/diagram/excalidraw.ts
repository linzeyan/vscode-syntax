import { exportToSvg } from "@excalidraw/excalidraw";

import { isDarkTheme } from "../theme";
import { register } from "./register";

/**
 * The fonts poly ships, beside this module. The preview's policy allows no
 * fetch, so Excalidraw cannot inline a font and names its CDN copy instead;
 * pointing those at the local files draws the text without the network.
 */
const FONTS = new URL("fonts/", import.meta.url).href;
const SHIPPED =
  /https:\/\/esm\.sh\/@excalidraw\/excalidraw@[^/]+\/dist\/prod\/fonts\/(Cascadia|ComicShanns|Excalifont|Lilita|Nunito|Virgil)\//g;

/**
 * Excalidraw fetches each font to inline it in the SVG. The preview's policy
 * allows no fetch, and a refused request makes the preview say content was
 * disabled; refused here, before a request exists, Excalidraw names the font's
 * URL instead, which the policy does allow. Anything else still goes out.
 */
const fetchAnything = window.fetch.bind(window);
window.fetch = (input, init) =>
  String(input instanceof Request ? input.url : input).endsWith(".woff2")
    ? Promise.reject(new TypeError("the preview links fonts rather than inlining them"))
    : fetchAnything(input, init);

// MarkNote's call: the scene as saved, on its background, in the preview's
// light or dark.
register("excalidraw", async (source) => {
  const data = JSON.parse(source);
  const svg = await exportToSvg({
    elements: data.elements ?? [],
    appState: { ...data.appState, exportWithDarkMode: isDarkTheme(), exportBackground: true },
    files: data.files ?? null,
  });
  return svg.outerHTML.replace(SHIPPED, (_: string, family: string) => `${FONTS}${family}/`);
});

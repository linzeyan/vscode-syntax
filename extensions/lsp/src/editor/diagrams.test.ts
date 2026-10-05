import * as assert from "node:assert/strict";
import { test } from "node:test";

import { DIAGRAM_CLASS, diagramBlock, diagramOf, DIAGRAMS } from "./diagrams";
import { diagramPlugin, GITHUB_THEMES, githubStyleOf, githubStylePlugin, MarkdownIt } from "./markdownIt";

test("every fence MarkNote draws is claimed, and nothing near them", () => {
  // The list is the contract with MarkNote: a document that draws there has to
  // draw here.
  for (const kind of ["nomnoml", "flowchart", "flow", "sequence", "vega", "vega-lite", "markmap", "excalidraw"]) {
    assert.equal(diagramOf(kind), kind, kind);
  }
  // `flow` is a whole word, not a prefix: a fence for some other language that
  // starts with it stays a code block.
  for (const other of ["flows", "sequenceDiagram", "vegas", "excalidrawing", "markdown", "mermaid", ""]) {
    assert.equal(diagramOf(other), undefined, other);
  }
});

test("the first word decides, in any case, with attributes after it", () => {
  assert.equal(diagramOf("  Vega-Lite  "), "vega-lite");
  assert.equal(diagramOf("nomnoml {caption=\"x\"}"), "nomnoml");
  // An inherited property is not a diagram kind; `in` would have said it was.
  assert.equal(diagramOf("constructor"), undefined);
  assert.equal(diagramOf("toString"), undefined);
});

test("each kind names a bundle the build writes", () => {
  // The loader fetches dist/diagram/<bundle>.js, or excalidraw's module beside
  // its editor; a kind pointing anywhere else is a fence that always fails to
  // load.
  assert.deepEqual(
    [...new Set(Object.values(DIAGRAMS))].sort(),
    ["excalidraw", "flowchart", "markmap", "nomnoml", "sequence", "vega"],
  );
});

test("the source goes in as text, so a diagram cannot write HTML", () => {
  assert.equal(
    diagramBlock("nomnoml", "[<script>x</script>] -> [B & C]"),
    `<pre class="${DIAGRAM_CLASS}" data-diagram="nomnoml">[&lt;script&gt;x&lt;/script&gt;] -&gt; [B &amp; C]</pre>`,
  );
});

/** A markdown-it stand-in holding one fence token, for the plugin's rule. */
function fakeMd(): MarkdownIt {
  return {
    renderer: {
      rules: { fence: () => "<pre><code>previous</code></pre>" },
      render: () => "<p>body</p>",
    },
    block: { ruler: { before: () => undefined } },
  };
}

function renderFence(md: MarkdownIt, info: string): string {
  const token = { info, content: "a -> b\n", markup: "```", block: true, map: null };
  const self = { renderToken: () => "default" };
  return md.renderer.rules.fence!([token], 0, {}, {}, self);
}

test("the fence rule claims a diagram only while the setting is on", () => {
  let on = false;
  const md = diagramPlugin(() => on)(fakeMd());
  assert.equal(renderFence(md, "sequence"), "<pre><code>previous</code></pre>");
  on = true;
  assert.match(renderFence(md, "sequence"), /data-diagram="sequence"/);
  // Any other language still reaches whatever rule was there before.
  assert.equal(renderFence(md, "rust"), "<pre><code>previous</code></pre>");
});

test("the GitHub wrapper spells what the stylesheets select on", () => {
  // The stylesheets are bierner's, unedited apart from base.css, so the
  // attribute names and values have to be its own.
  const md = githubStylePlugin(() => githubStyleOf("dark", "light_colorblind", "dark_dimmed"))(fakeMd());
  assert.equal(
    md.renderer.render([], {}, {}),
    "<div class=\"github-markdown-body\" data-color-mode=\"dark\" data-light-theme=\"light_colorblind\""
      + " data-dark-theme=\"dark_dimmed\"><div class=\"github-markdown-content\"><p>body</p></div></div>",
  );
});

test("with the style off, a render is exactly what it was", () => {
  const md = githubStylePlugin(() => undefined)(fakeMd());
  assert.equal(md.renderer.render([], {}, {}), "<p>body</p>");
});

test("a setting that is not a known name falls back instead of reaching the page", () => {
  // The values are written into attributes; a hand-edited settings.json must not
  // be able to close the quote.
  assert.deepEqual(githubStyleOf("\"><script>", "nope", 7), {
    colorMode: "auto",
    lightTheme: "light",
    darkTheme: "dark",
  });
  for (const theme of GITHUB_THEMES) {
    assert.equal(githubStyleOf("auto", theme, theme).lightTheme, theme);
  }
});

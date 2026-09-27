// The documents the preview differential renders.
//
// The diagram corpus is MarkNote's own README: every fence of a kind poly
// took from it, as MarkNote documents them. Read from the checkout rather than
// copied, so the corpus is whatever MarkNote currently promises; a missing
// checkout is an error, not an empty corpus that agrees with itself.
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

const MARKNOTE = process.env.MARKNOTE ?? join(homedir(), "git", "MarkNote");
const KINDS = ["nomnoml", "flowchart", "flow", "sequence", "vega-lite", "vega", "markmap", "excalidraw"];

function marknoteCases() {
  const readme = join(MARKNOTE, "README.md");
  if (!existsSync(readme)) {
    throw new Error(`no MarkNote checkout at ${MARKNOTE}; set MARKNOTE to one`);
  }
  const text = readFileSync(readme, "utf8");
  const cases = [];
  for (const kind of KINDS) {
    const fence = new RegExp("^```" + kind.replace("-", "\\-") + "\\n([\\s\\S]*?)^```", "gm");
    let index = 0;
    for (const match of text.matchAll(fence)) {
      cases.push({ name: `marknote-${kind}-${index++}`, kind, source: match[1] });
    }
  }
  return cases;
}

// What the README does not cover: a full vega spec (it only has vega-lite),
// broken sources, markup in a label, and the info-string forms MarkNote itself
// would not match but poly accepts.
const EXTRA = [
  {
    name: "vega-bar",
    kind: "vega",
    source: JSON.stringify(
      {
        $schema: "https://vega.github.io/schema/vega/v5.json",
        width: 200,
        height: 100,
        data: [{ name: "t", values: [{ k: "A", v: 3 }, { k: "B", v: 7 }] }],
        scales: [
          { name: "x", type: "band", domain: { data: "t", field: "k" }, range: "width" },
          { name: "y", domain: { data: "t", field: "v" }, range: "height" },
        ],
        axes: [{ orient: "bottom", scale: "x" }, { orient: "left", scale: "y" }],
        marks: [{
          type: "rect",
          from: { data: "t" },
          encode: {
            enter: {
              x: { scale: "x", field: "k" },
              width: { scale: "x", band: 1 },
              y: { scale: "y", field: "v" },
              y2: { scale: "y", value: 0 },
            },
          },
        }],
      },
      null,
      2,
    ),
  },
  { name: "nomnoml-broken", kind: "nomnoml", source: "[a] -> [b\n" },
  { name: "flowchart-broken", kind: "flowchart", source: "st=>start: A\nst->nowhere->\n" },
  { name: "sequence-broken", kind: "sequence", source: "A->: \n" },
  { name: "vega-lite-broken", kind: "vega-lite", source: "{ \"mark\": " },
  { name: "excalidraw-broken", kind: "excalidraw", source: "{ \"elements\": " },
  // MarkNote's example has no text: this one has Excalifont, which poly ships,
  // and CJK, which falls back to Xiaolai from esm.sh.
  {
    name: "excalidraw-text",
    kind: "excalidraw",
    source: JSON.stringify(
      {
        type: "excalidraw",
        version: 2,
        elements: [
          { type: "rectangle", id: "r", x: 0, y: 0, width: 200, height: 60, seed: 1, version: 1, versionNonce: 1 },
          {
            type: "text",
            id: "t",
            x: 10,
            y: 15,
            width: 180,
            height: 25,
            text: "poly 繁體中文",
            originalText: "poly 繁體中文",
            fontSize: 20,
            fontFamily: 5,
            seed: 2,
            version: 1,
            versionNonce: 2,
          },
        ],
      },
      null,
      2,
    ),
  },
  // Inside the label rather than at its start: `[<x>` is nomnoml's classifier
  // syntax, and an unknown classifier fails before anything is drawn.
  { name: "nomnoml-markup", kind: "nomnoml", source: "[a <img src=x onerror=\"window.__xss=1\">] -> [b]" },
  {
    name: "markmap-markup",
    kind: "markmap",
    source: "# root\n## <img src=x onerror=\"window.__xss=1\">\n## <b>bold</b>",
  },
];

/** Every diagram case, as the fence the preview is given. */
function diagramCases() {
  return [...marknoteCases(), ...EXTRA].map((one) => ({
    ...one,
    markdown: "```" + one.kind + "\n" + one.source + (one.source.endsWith("\n") ? "" : "\n") + "```\n",
  }));
}

// Fences the plugin must leave alone, beside the ones it takes.
const INFO_CASES = [
  {
    name: "info-attributes",
    markdown: "```vega-lite {caption}\n{\"mark\":\"point\",\"data\":{\"values\":[{\"a\":1}]}}\n```\n",
    claimed: true,
  },
  { name: "info-case", markdown: "```Nomnoml\n[a]->[b]\n```\n", claimed: true },
  { name: "info-empty-fence", markdown: "```nomnoml\n```\n", claimed: true },
  { name: "info-prefix", markdown: "```flows\nnot a diagram\n```\n", claimed: false },
  { name: "info-rust", markdown: "```rust\nfn main() {}\n```\n", claimed: false },
];

// One document with every element GitHub's stylesheet has a rule for.
const STYLE_DOC = `# Heading one

## Heading two

A paragraph with a [link](https://example.com), \`inline code\`, **bold**, _italic_
and <kbd>Ctrl</kbd>.

> A quote.

- item
  - nested
- [ ] task

1. first

\`\`\`js
const answer = 42;
\`\`\`

| head | other |
| ---- | ----- |
| cell | cell  |
| cell | cell  |

---
`;

module.exports = { diagramCases, INFO_CASES, STYLE_DOC, KINDS };

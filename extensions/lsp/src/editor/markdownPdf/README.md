# yzane.markdown-pdf's converter

These files are from [yzane/vscode-markdown-pdf](https://github.com/yzane/vscode-markdown-pdf) at tag `2.2.0`
(commit `37bee5a16aa63773c3081b23e607248fcb2c8be8`), under its MIT license (`LICENSE.txt`). They are copied from
`src/`, `styles/`, `template/` and `data/`.

`src/extension.ts` is not here. It holds the commands, the settings and the Chrome download, and poly's version of it is
`../markdownPdf.ts`. `src/readme-previews.ts` isn't here either, because it only draws upstream's README images.

The files are kept as upstream wrote them, so that a new release can be diffed in. `poly.toml` leaves them out of poly's
own formatting and lint for the same reason. Only these lines differ:

- `utils.ts`, `resolveHighlightStyle`: the highlight.js themes are read from `highlight.js/styles` under the assets
  folder, not from `node_modules/highlight.js/styles`. poly's VSIX ships no `node_modules`, so the build copies the
  themes (`tools/markdown-pdf-assets.js`).
- `utils.ts`, `buildSanitizeLogDetail`, and `diagnostics.ts`, `classifyError`: the setting names in messages and
  "Open Settings" links are `poly.markdownPdf.*`.
- `markdown-it-checkbox.ts`, `markdown-it-math-brackets.ts`, `markdown-it-named-headers.ts`: the type-only imports of
  markdown-it's `.mjs` files carry `with { 'resolution-mode': 'import' }`. poly compiles as Node16 CommonJS, where
  TypeScript asks for the attribute; upstream compiles as plain `commonjs`, where it does not.

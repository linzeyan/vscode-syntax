# RandomFractalsInc.vscode-data-preview's page

`data.view.html`, `scripts/data.view.js`, `styles/data.view.css` and `images/` are `web/` and `images/` from the
marketplace's [RandomFractalsInc.vscode-data-preview](https://github.com/RandomFractals/vscode-data-preview) 2.3.0 VSIX,
with LF line endings where it ships CRLF. The page is a toolbar around Perspective's `<perspective-viewer>`, which draws the
grid and the charts.

Apache-2.0 (`LICENSE.txt`, which also lists what Perspective's bundles carry).

Perspective is not here. `tools/perspective-assets.js` puts its 0.4.0 release beside the page in `dist/data-preview` at
build time, pinned by digest; its header says what is left out and the one line it changes. The Highcharts plugin is
not among it, so `{charts}` is always `d3fc`.

`out/` is not here. poly's version of it is `../dataPreview.ts` and `../dataPreviewData.ts`.

The files are kept as upstream wrote them, so that a new release can be diffed in. `poly.toml` leaves them out of poly's
own formatting and lint for the same reason. What differs:

- `data.view.html` loads `perspective-viewer.js` from beside itself rather than from unpkg, which upstream's own copy in
  the VSIX was shadowed by. Nothing is loaded from the network, so the policy no longer allows scripts from `https:`.
- `data.view.html` has no ko-fi link.
- `data.view.js` drops a message that is not an array where it expects Arrow's bytes. VSCode's webview host sends the
  first page in a window an empty string, which went to `viewer.load()` as an empty Arrow file: that preview's grid
  stayed blank, whatever the file.

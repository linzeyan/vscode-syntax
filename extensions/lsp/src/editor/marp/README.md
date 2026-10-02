# marp-team.marp-vscode

`src/`, `preview.js`, `marp-vscode.css` and `images/icon.woff` are from
[marp-team/marp-vscode](https://github.com/marp-team/marp-vscode) v3.6.1 (commit
`f71843717643a80fef73dfa466193931772ac7eb`), the tag the marketplace's 3.6.1 VSIX is built from. `src/` is upstream's
without the tests, the Jest mocks and `web/`, the browser build's stand-in that only says export is unavailable; poly
has no browser build. MIT (`LICENSE.txt`).

poly's side of it is `../marp.ts`, which decides when this loads. The dependencies are upstream's, at the versions its
lockfile pins.

The files are kept as upstream wrote them, so that a new release can be diffed in. `poly.toml` leaves them out of poly's
own formatting and lint for the same reason. What differs:

- Names. The settings are `poly.marp.*` rather than `markdown.marp.*` (`utils.ts`, `extension.ts`, and the two math
  diagnostics that watch `mathTypesetting`), the commands `poly.marp.*` (`commands/`), the color
  `poly.marpDirectiveKeyForeground` (`language/decorations.ts`) and the chat tool `poly_export_marp`
  (`lm/tools/export-marp.ts`). With marp-vscode installed as well, the same names would collide, and VSCode refuses a
  second command or tool by an id already taken.
- `option.ts` no longer reads `markdown.marp.enableHtml` and `markdown.marp.chromePath`, which upstream keeps for users of
  its old releases. poly never had them.
- `commands/show-quick-pick.ts` and `commands/open-extension-settings.ts` imported upstream's `package.json` for the
  command titles and the extension's id. They read poly's manifest from VSCode instead, which also gives the titles in
  the display language, and the settings search is narrowed to `poly.marp`, since poly's settings are not Marp's alone.
- `marp-cli.ts` requires marp-cli from `cli.js` beside the bundle rather than importing the package. poly's VSIX ships no
  `node_modules`, and marp-cli, with puppeteer, is bundled on its own so that it loads only for an export.
- `lm/lm.ts` skips the chat tool on a VSCode without `lm.registerTool` (before 1.95). poly supports VSCode from 1.85,
  marp-vscode from 1.101.
- `preview.js` does nothing when marp-vscode's preview script is on the page. Both are in every Markdown preview once
  both extensions are installed, and each copy of marp-core defines the same custom elements: the second
  `customElements.define` throws.
- `utils.ts` recognises no document while `poly.marp.enabled` is off, and `extension.ts` refreshes the preview when it
  changes. Every Marp feature (the preview, diagnostics, completion, export) starts from that one check, so the switch
  reaches all of them without an edit at each.

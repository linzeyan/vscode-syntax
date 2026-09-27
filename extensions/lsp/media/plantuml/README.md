# PlantUML preview page

The preview panel of `jebbs.plantuml` (qjebbs/vscode-plantuml, MIT, LICENSE
beside this file), commit `7bc1758ed73dc269f5721d78c6c6c01f461d7cb0`:
`templates/js/*.js` and `templates/css/preview.css` unchanged, so zooming,
panning, snapping, paging and copying behave as they do there.
`css/MaterialIcons-Regular.woff2` is Google's Material Icons font (Apache-2.0),
as that repository ships it (sha256
`9710a5e2fe3c35051e4ec21086644b4b59c457bbd5a8a5ac8fc377f829090373`).

`preview.html` is its `templates/preview.html` with three edits:

- The `${localize(…)}` strings are written out in English, the language poly's
  runtime strings are in.
- Scripts load by nonce under a Content-Security-Policy. jebbs's page has no
  policy, and it shows PlantUML's error text and image maps, both of which come
  from the diagram.
- It is filled by name, not evaluated: jebbs runs the page through `eval` as a
  template literal. What goes into it is escaped by the code that fills it.

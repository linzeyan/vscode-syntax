# adpyke.codesnap's page

`index.html`, `style.css` and `src/` are from [kufii/CodeSnap](https://github.com/kufii/CodeSnap) 1.3.4 (commit
`8ddd3c51090a4a6e2475b08cb9fada3079288287`; the repository has no tags), copied from `webview/`. They are byte for byte
what the marketplace's 1.3.4 VSIX ships.

`dom-to-image-more.min.js` is `dist/dom-to-image-more.min.js` from npm's dom-to-image-even-more 1.0.4 (integrity
`sha512-ZRTXejTIczfk5C9H10m2sttPVVD2PY7REw/M2uZ3ASSUvapFjLoOotvyPvS7hhK89pto2QsfupwjD2uoNXOOPg==`), the version upstream's
lockfile pins and its VSIX ships. It is copied rather than installed because the package depends on `@babel/polyfill`,
which pulls in core-js 2, and none of that is in the file the page loads.

Both are MIT (`LICENSE.txt`). CodeSnap declares the license in its `package.json` only. The repository has no license
file and names no copyright holder.

`src/extension.js` and `src/util.js` are not here. poly's version of them is `../codeSnap.ts`.

The files are kept as upstream wrote them, so that a new release can be diffed in. `poly.toml` leaves them out of poly's
own formatting and lint for the same reason. Only one line differs:

- `index.html` loads `./dom-to-image-more.min.js` rather than
  `../node_modules/dom-to-image-even-more/dist/dom-to-image-more.min.js`. poly's VSIX ships no `node_modules`, so the
  file sits next to the page.

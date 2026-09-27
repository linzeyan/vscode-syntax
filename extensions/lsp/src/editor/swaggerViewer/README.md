# arjun.swagger-viewer's page and schemas

`index.html`, `schema.json` and `schemas/` are from [arjun-g/vs-swagger-viewer](https://github.com/arjun-g/vs-swagger-viewer)
3.2.0 (commit `96627b5e344edf22c254704549022d38f05dd397`; the repository has no tag for it), copied from `static/`, the
root and `src/schemas/`. The marketplace's 3.2.0 VSIX ships the same files with CRLF line endings.

The build lays them out in `dist/swagger/`, with Swagger UI's own files from npm's swagger-ui-dist in
`dist/swagger/swagger-ui-dist/`. Those are byte for byte what upstream's VSIX ships at 3.2.0: the version is the same,
5.30.3.

`LICENSE.txt` is upstream's `LICENSE.md` (MIT), with a note on where the two schemas come from: they are the OpenAPI
Initiative's, under Apache-2.0.

`src/` is not here. poly's version of `src/preview/client.ts` is `../swaggerViewer.ts`, and of `src/preview/server.ts`
`../swaggerPreview.ts`.

The files are kept as upstream wrote them, so that a new release can be diffed in. `poly.toml` leaves them out of poly's
own formatting and lint for the same reason. Two edits differ:

- `index.html` gets its spec from `events/<token>`, a stream of Server-Sent Events, rather than from socket.io, and so no
  longer loads `/socket.io/socket.io.js`. The server is Node's own `http`, and the page only ever listens.
- `schema.json` refers to `./schemas/`, not `./out/schemas/`, which is where upstream's build puts them.

# draw.io editor

The editor is draw.io's web app, version 31.5.2, from the `draw.war` of
jgraph/drawio's release `v31.5.2` (sha256
`abd58ad15baef57f43acb79a56350ba8900a8b6fabe94391d8906148fe64e264`), unpacked
by `tools/drawio-webapp.js` into `dist/drawio` without its servlet side, its
top-level pages, and the stencil and shape sources it also ships minified.
The page that loads it is poly's.

Two libraries the release carries are removed, as files and from
`js/extensions.min.js`, which is the one file edited and says so at its top;
`js/integrate.min.js`, which bundles them again and which the page never loads,
is left out with them. They are libavoid (LGPL-2.1), the solver behind
Orthogonal Routing, and draw.io's build of ELK (EPL-2.0), the ELK layouts.
Both licenses oblige whoever ships the object code to offer its complete
source, and the source of these builds is in jgraph's drawio-libavoid and
drawio-elk repositories, which are not public, so poly could not make that
offer. Without them the editor does not offer Orthogonal Routing, an ELK layout
reports that it is unavailable, and Mermaid import lays a diagram out with
dagre, its own fallback.

draw.io is jointly owned and developed by draw.io Ltd (previously JGraph) and
draw.io AG. Its code is licensed under the Apache License 2.0, LICENSE beside
this file (the repository's, at the same tag). Its diagram templates,
`dist/drawio/templates`, are licensed under CC BY 4.0, and that directory
carries the license. Its icon sets and stencil libraries, `dist/drawio/img`
and the stencils minified into `dist/drawio/js`, come with the terms in
`dist/drawio/img/LICENSE`: they, and anything derived from them, may not be
used in, distributed for use with, or incorporated into Atlassian products or
products distributed through the Atlassian marketplace or plugin ecosystem
without draw.io's written permission; diagrams made with them are not
restricted. draw.io states that it has verified that the original licenses of
icons first defined by a third party permit this use. Of the scripts the app
bundles, libavoid and ELK, above, were not licensed compatibly with shipping
them here; DOMPurify, in `js/sanitizer`, offers Apache-2.0 or MPL-2.0, and poly
takes Apache-2.0. The fonts the app ships, and what each says of itself, are in
`FONTS.md` beside this file and in `dist/drawio`.

draw.io is a registered EU trademark (#018062448). This extension is not
affiliated with, endorsed or sponsored by draw.io, and it does not use the
draw.io logo.

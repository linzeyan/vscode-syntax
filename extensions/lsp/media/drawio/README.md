# draw.io editor

The editor is draw.io's web app, version 31.5.2, from the `draw.war` of
jgraph/drawio's release `v31.5.2` (sha256
`abd58ad15baef57f43acb79a56350ba8900a8b6fabe94391d8906148fe64e264`), unpacked
by `tools/drawio-webapp.js` into `dist/drawio` without its servlet side, its
top-level pages, and the stencil and shape sources it also ships minified.
Nothing in it is edited; the page that loads it is poly's.

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
icons first defined by a third party permit this use, and that the other
scripts the app bundles are licensed compatibly with the Apache License 2.0,
none of them GPL or AGPL.

draw.io is a registered EU trademark (#018062448). This extension is not
affiliated with, endorsed or sponsored by draw.io, and it does not use the
draw.io logo.

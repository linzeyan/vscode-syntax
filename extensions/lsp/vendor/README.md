# Vendored packages

`xlsx-0.20.3.tgz` is SheetJS Community Edition 0.20.3 (Apache-2.0), which Data Preview reads and writes workbooks
with. It is the tarball from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, byte for byte; `pnpm-lock.yaml`
holds its sha512.

SheetJS stopped publishing to npm at 0.18.5, which carries a prototype pollution and a ReDoS advisory for exactly
what Data Preview does, reading files it did not write; the fixed releases are only on SheetJS's own CDN. A URL
dependency on that CDN installs, but `pnpm licenses list` cannot read one (pnpm 11: the install indexes it under a
different key than `licenses` looks up), and `tools/third-party-notices.py` stands on that command. A `file:` tarball
it reads. SheetJS's own documentation recommends vendoring the tarball the same way.

Dependabot does not watch a `file:` dependency: a new SheetJS release is a new tarball here and a new line in
`package.json`.

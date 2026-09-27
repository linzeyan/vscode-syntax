#!/usr/bin/env python3
"""Everything an extension's manifest points at is really inside its VSIX.

A manifest path is a promise to the editor, and nothing checks it: vsce packages
whatever `.vscodeignore` leaves behind without reading `contributes`, so a
preview script that never got built, a `.vscodeignore` line that reaches one
file too far, and a renamed bundle all produce a VSIX that installs cleanly and
does nothing. `markdown.previewScripts` is the case that prompted this: every
test the preview has loads `dist/preview.js` by path from the source tree, so
the packaged copy has never been the thing under test.

Usage: python3 tools/vsix-check.py extensions/lsp
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

# vsce puts the extension's own tree under this prefix and its metadata beside
# it, so a manifest path is not a zip entry name until it is joined to this.
PREFIX = "extension/"


def manifest_paths(manifest: dict) -> list[str]:
    """Every file the manifest names, from the keys and from `contributes`.

    Contributions are walked rather than listed key by key: which keys hold a
    path is up to whatever VSCode accepts this month, and a list that has to be
    extended for each new contribution point is a list that will be out of date
    the first time one is added. `./` is the signal -- it is how the manifests
    here spell a path and not how they spell anything else.
    """
    found = [manifest[key] for key in ("main", "browser", "icon") if manifest.get(key)]

    def walk(node: object) -> None:
        if isinstance(node, str):
            if node.startswith("./"):
                found.append(node)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            for item in node.values():
                walk(item)

    walk(manifest.get("contributes", {}))
    return found


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    manifest = json.loads((root / "package.json").read_text())

    # By the version in the manifest, not the newest file in the directory:
    # every release ever packaged is still sitting here, so "the most recent
    # one" is the previous release whenever this run's packaging step failed --
    # and checking last release's VSIX would pass while this one is broken.
    package = root / f"{manifest['name']}-{manifest['version']}.vsix"
    if not package.exists():
        print(
            f"{package.name} is not here: package the extension before checking it",
            file=sys.stderr,
        )
        return 1

    with zipfile.ZipFile(package) as archive:
        # Sizes rather than names alone: an entry can be present and empty, and
        # an empty bundle is the same outage as a missing one.
        sizes = {info.filename: info.file_size for info in archive.infolist()}

    # The translations, which no manifest key names: VSCode finds them by
    # filename next to package.json. That makes them the one kind of required
    # file `manifest_paths` cannot see, and the kind `.vscodeignore` drops
    # without anything going red -- a missing package.nls.zh-tw.json renders
    # the English string, which reads like a translation nobody wrote yet.
    paths = manifest_paths(manifest)
    paths += [f"./{one.name}" for one in sorted(root.glob("package.nls*.json"))]
    # And the files code loads by path at run time (`dist/dbml.js`, the
    # preview's `dist/diagram/*.js`, the PlantUML preview page under
    # `media/plantuml/`, the Excalidraw page's styles and fonts, draw.io's web
    # app, markdown export's styles and template, CodeSnap's page, the Swagger
    # preview's page, schemas and Swagger UI, Marp's bundles and the template
    # script marp-cli reads beside itself), which no
    # manifest key names either: whatever the build wrote, or the page is made
    # of, has to ship.
    built = [
        f"./{one.relative_to(root).as_posix()}"
        for one in sorted(
            [
                *root.glob("dist/**/*.js"),
                *root.glob("dist/excalidraw/**/*"),
                *root.glob("dist/drawio/**/*"),
                *root.glob("dist/markdown-pdf/**/*"),
                *root.glob("dist/codesnap/**/*"),
                *root.glob("dist/swagger/**/*"),
                *root.glob("dist/marp/**/*"),
                *root.glob("media/plantuml/**/*"),
                *root.glob("media/excalidraw/**/*"),
                *root.glob("media/drawio/**/*"),
            ]
        )
        if one.is_file()
    ]
    paths += [path for path in built if path not in paths]
    problems = []
    for path in paths:
        entry = PREFIX + path.removeprefix("./")
        if entry not in sizes:
            problems.append(f"{path} is required and not in the package")
        elif sizes[entry] == 0:
            problems.append(f"{path} is in the package and empty")

    print(
        f"{package.name}: {len(paths)} required path(s), {len(sizes)} file(s) packaged"
    )
    for problem in problems:
        print(f"  {problem}", file=sys.stderr)
    if problems:
        return 1
    print("  every path the manifest needs is packaged and not empty")
    return 0


if __name__ == "__main__":
    sys.exit(main())

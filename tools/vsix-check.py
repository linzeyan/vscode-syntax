#!/usr/bin/env python3
"""Everything an extension's manifest points at is really inside its VSIX.

A manifest path is a promise to the editor, and nothing checks it: vsce packages
whatever `.vscodeignore` leaves behind without reading `contributes`, so a
preview script that never got built, a `.vscodeignore` line that reaches one
file too far, and a renamed bundle all produce a VSIX that installs cleanly and
does nothing. `markdown.previewScripts` is the case that prompted this: every
test the preview has loads `dist/preview.js` by path from the source tree, so
the packaged copy has never been the thing under test.

The same goes for licenses: nothing in vsce asks whether a font, a copied
package or a vendored web app carries the license it has to travel with, so
`license_problems` does.

Usage: python3 tools/vsix-check.py extensions/lsp
"""

from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath

# vsce puts the extension's own tree under this prefix and its metadata beside
# it, so a manifest path is not a zip entry name until it is joined to this.
PREFIX = "extension/"

# What counts as a license file beside an asset: the name says so. FONTS.md is
# how the font notices here are spelled.
LICENSE_FILE = re.compile(r"(?i)^(licen[cs]e|copying|notice|third[-_]?party|fonts\.md)")
FONT = re.compile(r"(?i)\.(ttf|otf|woff2?|eot)$")
# The first line of a license text whose terms poly cannot meet by shipping a
# copy: each asks for the complete source of the object code to be offered.
# Headings, not names, so a notice that merely mentions one (a font left out
# because it is GPL) does not trip it.
COPYLEFT = re.compile(
    r"GNU (LESSER |LIBRARY |AFFERO )?GENERAL PUBLIC LICENSE|Eclipse Public License - v"
)


def license_problems(manifest: dict, archive: zipfile.ZipFile) -> list[str]:
    """Assets that ship without the license that has to travel with them.

    Three rules, each the shape of a defect that shipped: a font with no
    license beside it, or above it naming it (KaTeX's and Git Graph's fonts);
    a directory named for a package with no license in it (highlight.js's
    themes, KaTeX's stylesheet); and a license text whose terms the package
    cannot meet (libavoid's LGPL, in draw.io's web app).
    """
    files = {
        info.filename.removeprefix(PREFIX): info
        for info in archive.infolist()
        if info.filename.startswith(PREFIX) and not info.is_dir()
    }
    licenses = {path for path in files if LICENSE_FILE.match(PurePosixPath(path).name)}

    def text(path: str) -> str:
        return archive.read(PREFIX + path).decode("utf-8", errors="replace")

    def squash(value: str) -> str:
        return re.sub(r"[\s_-]", "", value).lower()

    problems = []
    for path in sorted(files):
        if not FONT.search(path) or "/" not in path:
            continue
        own = PurePosixPath(path).parent
        if any(PurePosixPath(one).parent == own for one in licenses):
            continue
        # An ancestor's license covers the font only if it names it: a stem
        # like `KaTeX_AMS` from `KaTeX_AMS-Regular.woff2`.
        stem = squash(re.split(r"[-.]", PurePosixPath(path).name)[0])
        if not any(
            own.is_relative_to(PurePosixPath(one).parent) and stem in squash(text(one))
            for one in licenses
            if PurePosixPath(one).parent != PurePosixPath(".")
        ):
            problems.append(f"{path}: no license beside it, or above it naming it")
    packages = {
        name.split("/")[-1]
        for key in ("dependencies", "devDependencies")
        for name in manifest.get(key, {})
    }
    # Every ancestor, not just the directories holding files: a copied package
    # often keeps only a subdirectory (highlight.js's `styles/`), and the
    # license belongs at the directory carrying its name.
    directories = {str(one) for path in files for one in PurePosixPath(path).parents}
    for directory in sorted(directories):
        if PurePosixPath(directory).name in packages and not any(
            str(PurePosixPath(one).parent) == directory for one in licenses
        ):
            problems.append(
                f"{directory}/: named for a package and has no license file"
            )
    for path in sorted(licenses):
        if path.startswith(("dist/", "media/")) and COPYLEFT.search(text(path)):
            problems.append(f"{path}: a copyleft license text poly cannot ship under")
    return problems


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
        problems = license_problems(manifest, archive)

    # The translations, which no manifest key names: VSCode finds them by
    # filename next to package.json. That makes them the one kind of required
    # file `manifest_paths` cannot see, and the kind `.vscodeignore` drops
    # without anything going red -- a missing package.nls.zh-tw.json renders
    # the English string, which reads like a translation nobody wrote yet.
    paths = manifest_paths(manifest)
    paths += [f"./{one.name}" for one in sorted(root.glob("package.nls*.json"))]
    # The extension's license, which vsce writes as LICENSE.txt, and the
    # third-party notices: no manifest key names them, and a package that
    # ships without them still installs.
    paths += [
        "./LICENSE.txt",
        *(f"./{one.name}" for one in sorted(root.glob("THIRD-PARTY-NOTICES*.md"))),
    ]
    # And the files code loads by path at run time (`dist/dbml.js`, the
    # preview's `dist/diagram/*.js`, the PlantUML preview page under
    # `media/plantuml/`, the Excalidraw page's styles and fonts, markdown
    # export's styles and template, CodeSnap's page, Paste Image's
    # clipboard scripts, Data Preview's page and Perspective, the Swagger
    # preview's page, schemas and Swagger UI, Marp's bundles and the template
    # script marp-cli reads beside itself, Git Graph's page with its icon font
    # and the icons its panel's tab shows, Code Runner's licence, Error Lens's
    # bundle with its licence and its gutter icons, and the licenses copied
    # beside the bundles that carry no file of their own, opencc-js's), which no
    # manifest key names either: whatever the build wrote, or the page is made
    # of, has to ship.
    built = [
        f"./{one.relative_to(root).as_posix()}"
        for one in sorted(
            [
                *root.glob("dist/**/*.js"),
                *root.glob("dist/excalidraw/**/*"),
                *root.glob("dist/markdown-pdf/**/*"),
                *root.glob("dist/codesnap/**/*"),
                *root.glob("dist/paste-image/**/*"),
                *root.glob("dist/data-preview/**/*"),
                *root.glob("dist/swagger/**/*"),
                *root.glob("dist/marp/**/*"),
                *root.glob("dist/git-graph/**/*"),
                *root.glob("dist/code-runner/**/*"),
                *root.glob("dist/errorLens/**/*"),
                *root.glob("dist/opencc-js/**/*"),
                *root.glob("media/git-graph-*.svg"),
                *root.glob("media/errorLens/**/*"),
                *root.glob("media/plantuml/**/*"),
                *root.glob("media/excalidraw/**/*"),
            ]
        )
        if one.is_file()
    ]
    paths += [path for path in built if path not in paths]
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
    print("  every path the manifest needs is packaged and not empty, with its license")
    return 0


if __name__ == "__main__":
    sys.exit(main())

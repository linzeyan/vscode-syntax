#!/usr/bin/env python3
"""Move every version string in the repo to a new release, or check they agree.

The version lives in places none of which can be derived from another: two
package.json, the cargo workspace, the lockfile cargo regenerates, and a
handful of spots in prose. A release that bumps all but one ships an extension
whose binary reports a different version than its manifest, which is a state
the daemon has a whole status-bar colour for.

Prose is why this is a script rather than a sed one-liner, and the trap is that
these files mention old releases *on purpose* -- the upgrade notes are about
0.5.0 and have to stay about 0.5.0. So nothing here matches a bare version
number. Every prose site is anchored on the text around it:

- the docker section lists tags `X.Y.Z` and `X.Y`, so the short tag moves too
  and a plain replace of the full version silently misses it
- both READMEs quote the broken update prompt 0.5.0 still shows. The filename
  in it is built by code frozen inside the installed 0.5.0, which asks for the
  *latest* release under the old name -- so it tracks the current version. That
  quote in the extension README was missed at 0.7.0 and sat a version behind
  until this check was written

Usage:
  tools/bump.py 0.8.0    rewrite every file, then run `cargo update -w`
  tools/bump.py --check  fail if the versions disagree; no writes
"""

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CARGO = ROOT / "cli" / "Cargo.toml"
MANIFESTS = [
    ROOT / "extensions" / "lsp" / "package.json",
    ROOT / "extensions" / "syntax" / "package.json",
]
# Listed explicitly rather than globbed: docs/ is a symlink to another repo and
# its roadmap is full of old version numbers that are evidence of what was
# measured when, not values to keep current.
PROSE = [ROOT / "README.md", ROOT / "extensions" / "lsp" / "README.md"]

V = r"(?P<v>\d+\.\d+\.\d+)"
M = r"(?P<m>\d+\.\d+)"
# Each of these must name the release being shipped. A pattern that stops
# matching anything is an error rather than a silent pass -- prose gets
# rewritten, and a site that quietly drops off this list is one nothing checks
# again.
SITES = [
    rf"poly-syntax-highlight-{V}\.vsix",
    rf"poly-lsp-[a-z0-9-]+-{V}\.vsix",
    # The asset name the frozen 0.5.0 installer asks for, quoted in both files.
    rf"poly-syntax-{V}\.vsix",
    rf"POLY_VERSION={V}",
    rf'version: "{V}"',
    rf"`{V}`、`{M}`",  # docker tags, full and minor
]


def current() -> str:
    """The version the cargo workspace claims, which is the one poly reports."""
    match = re.search(r'(?m)^version = "([^"]+)"', CARGO.read_text())
    if not match:
        sys.exit(f"error: no workspace version in {CARGO}")
    return match.group(1)


def check(version: str) -> int:
    bad = []
    minor = ".".join(version.split(".")[:2])
    for manifest in MANIFESTS:
        declared = json.loads(manifest.read_text())["version"]
        if declared != version:
            bad.append(f"{manifest.relative_to(ROOT)}: {declared}, want {version}")

    seen = {site: 0 for site in SITES}
    for path in PROSE:
        text = path.read_text()
        for site in SITES:
            for found in re.finditer(site, text):
                seen[site] += 1
                if found.group("v") != version:
                    bad.append(
                        f"{path.relative_to(ROOT)}: {found.group(0)!r} "
                        f"names {found.group('v')}, want {version}"
                    )
                if "m" in found.groupdict() and found.group("m") != minor:
                    bad.append(
                        f"{path.relative_to(ROOT)}: {found.group(0)!r} "
                        f"names {found.group('m')}, want {minor}"
                    )
    for site, hits in seen.items():
        if not hits:
            bad.append(f"pattern matched nothing and is no longer checking: {site}")

    if bad:
        print(f"version drift (workspace says {version}):", file=sys.stderr)
        for line in bad:
            print(f"  {line}", file=sys.stderr)
        return 1
    print(
        f"{sum(seen.values())} prose sites and {len(MANIFESTS)} manifests agree on {version}"
    )
    return 0


def bump(old: str, new: str) -> None:
    CARGO.write_text(
        CARGO.read_text().replace(f'version = "{old}"', f'version = "{new}"', 1)
    )
    for manifest in MANIFESTS:
        # Line-oriented rather than json.dump: rewriting the whole file would
        # reformat and reorder it, turning a one-line bump into a diff nobody
        # can review.
        manifest.write_text(
            manifest.read_text().replace(
                f'"version": "{old}"', f'"version": "{new}"', 1
            )
        )

    new_minor = ".".join(new.split(".")[:2])

    def retarget(found: re.Match) -> str:
        text = found.group(0)
        # Rightmost first, so replacing the shorter minor tag cannot corrupt
        # the full version that precedes it.
        if "m" in found.groupdict():
            span = found.span("m")
            text = (
                text[: span[0] - found.start()]
                + new_minor
                + text[span[1] - found.start() :]
            )
        span = found.span("v")
        return text[: span[0] - found.start()] + new + text[span[1] - found.start() :]

    for path in PROSE:
        text = path.read_text()
        for site in SITES:
            text = re.sub(site, retarget, text)
        path.write_text(text)

    # cargo owns the lockfile; hand-editing its entries is how they drift.
    subprocess.run(
        ["cargo", "update", "-w", "--manifest-path", str(CARGO)],
        check=True,
        capture_output=True,
    )
    print(f"bumped {old} -> {new}")


def main() -> int:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    if sys.argv[1] == "--check":
        return check(current())
    new = sys.argv[1]
    if not re.fullmatch(r"\d+\.\d+\.\d+", new):
        sys.exit(f"error: {new} is not a release version")
    old = current()
    if old == new:
        sys.exit(f"error: already at {new}")
    bump(old, new)
    return check(new)


if __name__ == "__main__":
    sys.exit(main())

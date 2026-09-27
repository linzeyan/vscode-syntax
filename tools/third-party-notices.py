#!/usr/bin/env python3
"""Generate extensions/lsp/THIRD-PARTY-NOTICES*.md from cargo and pnpm (A9).

The poly binary statically links these crates; the notice ships inside the
platform VSIX and as a release asset. Grammar notices are generated
separately by grammar-sync.py. Run with --check to verify the committed
file is current (CI drift gate).
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extensions" / "lsp" / "THIRD-PARTY-NOTICES.md"
EXTENSION = ROOT / "extensions" / "lsp"
NPM_OUT = EXTENSION / "THIRD-PARTY-NOTICES-npm.md"

# npm packages whose `license` field is missing, and what their own LICENSE file
# says instead. An entry here is a claim about a file on disk, so it names the
# file: khroma ships `license` starting "The MIT License (MIT)" and simply omits
# the field from its package.json. Without this the run stops, which is the
# right default -- a package that documents nothing is not silently permissive.
NPM_LICENSE_FILES = {
    "khroma": ("MIT", "license"),
    # Raphael's event library; its LICENSE is the Apache-2.0 text under Adobe's
    # copyright, and eve.js carries the same header.
    "eve-raphael": ("Apache-2.0", "LICENSE"),
}

# A9/N5 allowlist for everything the binary statically links. Ordered by
# preference: when a crate offers a choice we take the earliest entry, so MIT
# leads. MPL-2.0 is acceptable because we use crates.io originals unmodified --
# there is no patched source form we would owe anyone under §3.1. Copyleft with
# no permissive alternative (GPL/AGPL/SSPL, bare LGPL) is not on the list and
# fails the build rather than landing quietly in the notices.
#
# PSF-2.0 arrived with ruff's linter: libcst carries `MIT AND (MIT AND
# PSF-2.0)` because parts of it derive from CPython's own grammar. It is the
# licence CPython itself ships under -- permissive, no copyleft, attribution
# only -- so it belongs with the rest of this list rather than being a reason
# to refuse the dependency.
ALLOWED = (
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "0BSD",
    "Zlib",
    "BSL-1.0",
    "Unlicense",
    "MIT-0",
    "CC0-1.0",
    "PSF-2.0",
    "Unicode-3.0",
    "Unicode-DFS-2016",
    "CDLA-Permissive-2.0",
    "MPL-2.0",
    # Fonts: the Excalidraw editor draws in its hand-drawn families. OFL's one
    # condition beyond attribution, that the font is not sold on its own,
    # does not reach a package that only ships it.
    "OFL-1.1",
)


def _alternatives(tokens: list[str], pos: int) -> tuple[list[tuple[str, ...]], int]:
    """Parse an SPDX expression into disjunctive normal form.

    Each returned element is one way to satisfy the expression: a tuple of
    terms that must *all* be accepted. `(MIT OR Apache-2.0) AND Unicode-3.0`
    becomes [(MIT, Unicode-3.0), (Apache-2.0, Unicode-3.0)], which is the shape
    the allowlist check wants -- and it is why this is a parser rather than a
    string split. Grammar: or := and ("OR" and)*, and := atom ("AND" atom)*,
    atom := "(" or ")" | LICENSE ["WITH" EXCEPTION].
    """
    left: list[tuple[str, ...]] = []
    while True:
        if tokens[pos] == "(":
            atom, pos = _alternatives(tokens, pos + 1)
            pos += 1  # closing paren
        else:
            term = tokens[pos]
            pos += 1
            if pos < len(tokens) and tokens[pos] == "WITH":
                term = f"{term} WITH {tokens[pos + 1]}"
                pos += 2
            atom = [(term,)]
        left = [a + b for a in left for b in atom] if left else atom
        if pos < len(tokens) and tokens[pos] == "AND":
            pos += 1
            continue
        if pos < len(tokens) and tokens[pos] == "OR":
            right, pos = _alternatives(tokens, pos + 1)
            return left + right, pos
        return left, pos


def choose_license(expr: str) -> tuple[str | None, bool]:
    """Resolve an SPDX expression to the terms poly relies on.

    Returns (chosen, some_alternative_rejected); chosen is None when no way of
    satisfying the expression stays inside the allowlist.
    """
    # "MIT/Apache-2.0" is cargo's pre-SPDX spelling of OR and still in the tree.
    tokens = expr.replace("/", " OR ").replace("(", " ( ").replace(")", " ) ").split()
    alternatives, _ = _alternatives(tokens, 0)
    # "Apache-2.0 WITH LLVM-exception" only adds permissions to Apache-2.0, and
    # a trailing "+" means "or later" -- neither affects acceptability.
    bases = [
        tuple(t.split(" WITH ")[0].rstrip("+") for t in alt) for alt in alternatives
    ]
    usable = [
        (alt, base)
        for alt, base in zip(alternatives, bases)
        if set(base) <= set(ALLOWED)
    ]
    if not usable:
        return None, False
    chosen, _ = min(usable, key=lambda pair: min(ALLOWED.index(b) for b in pair[1]))
    return " AND ".join(chosen), len(usable) != len(alternatives)


def collect() -> str:
    meta = json.loads(
        subprocess.run(
            ["cargo", "metadata", "--format-version", "1", "--locked"],
            cwd=ROOT / "cli",
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    )
    rows = []
    unknown = []
    disallowed = []
    for pkg in meta["packages"]:
        if pkg["source"] is None:  # workspace member, not third-party
            continue
        license_ = pkg.get("license")
        if not license_:
            unknown.append(f"{pkg['name']} {pkg['version']}")
            continue
        chosen, rejected_some = choose_license(license_)
        if chosen is None:
            disallowed.append(f"{pkg['name']} {pkg['version']} ({license_})")
            continue
        repo = pkg.get("repository") or ""
        # Only spelled out when the crate also offered something we refused:
        # noting "takes MIT" on all 200-odd MIT-OR-Apache crates would bury the
        # two lines where the choice actually carries legal weight.
        taken = chosen if rejected_some else None
        rows.append((pkg["name"], pkg["version"], license_, taken, repo))
    if unknown:
        sys.exit(f"crates without license metadata (resolve manually): {unknown}")
    if disallowed:
        sys.exit(
            "crates outside the A9 license allowlist "
            f"({', '.join(ALLOWED)}): {disallowed}"
        )
    rows.sort()
    lines = [
        "# Third-party notices — poly-lsp",
        "",
        "The bundled poly binary statically links the following crates.",
        "Generated by tools/third-party-notices.py from Cargo.lock — do not",
        "edit by hand. Licenses are checked against the A9 allowlist; where a",
        "crate also offers one poly does not accept, the term poly relies on is",
        "named inline.",
        "",
    ]
    for name, version, license_, taken, repo in rows:
        suffix = f" — {repo}" if repo else ""
        note = f"; poly takes {taken}" if taken else ""
        lines.append(f"- {name} {version} ({license_}{note}){suffix}")
    lines.append("")
    return "\n".join(lines)


def bundled_externals() -> set[str]:
    """npm packages the extension's build deliberately leaves out of its bundles.

    Read off the build command rather than listed here, because the two would
    drift and the drift is invisible: a package dropped from `--external:` would
    start shipping without appearing in the notices, which is the exact failure
    this file exists to prevent. `vscode` is the editor API, not a package.
    """
    build = json.loads((EXTENSION / "package.json").read_text())["scripts"]["build"]
    return set(re.findall(r"--external:([@\w./-]+)", build)) - {"vscode"}


def platform_only(pkg: dict) -> bool:
    """A package whose manifest limits it to some `os` or `cpu`.

    pnpm installs it only on those machines, so keeping it would make the
    notices depend on where this runs: fsevents (macOS, under excalidraw's
    sass) made the Linux CI call the file stale. They are native modules,
    which esbuild cannot put in a bundle, so none of them is shipped.
    """
    return any(
        {"os", "cpu"} & json.loads((Path(path) / "package.json").read_text()).keys()
        for path in pkg.get("paths") or []
    )


def collect_npm() -> str:
    """The packages esbuild bundles into the extension's two scripts.

    `pnpm licenses` rather than a walk of node_modules: it resolves the same
    tree the build resolves, and `--prod` is the half of it that can reach the
    bundle. Anything `--external:` keeps out is removed afterwards, since poly
    does not ship it and owes no notice for it.
    """
    try:
        listed = json.loads(
            subprocess.run(
                ["pnpm", "licenses", "list", "--prod", "--json"],
                cwd=EXTENSION,
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )
    except FileNotFoundError:
        sys.exit(
            "pnpm is required to read the extension's dependency tree. "
            "Where it is absent, ask for the other artifact with --scope cargo."
        )
    external = bundled_externals()
    rows = []
    unknown = []
    disallowed = []
    for packages in listed.values():
        for pkg in packages:
            name = pkg["name"]
            if name in external or platform_only(pkg):
                continue
            # pnpm hands back some expressions already parenthesised
            # ("(MPL-2.0 OR Apache-2.0)"), and the line below adds its own.
            license_ = (pkg.get("license") or "").strip()
            if license_.startswith("(") and license_.endswith(")"):
                inner = license_[1:-1]
                if "(" not in inner and ")" not in inner:
                    license_ = inner
            source = ""
            if license_ in ("", "Unknown"):
                override = NPM_LICENSE_FILES.get(name)
                if override is None:
                    unknown.append(name)
                    continue
                license_, source = override
            chosen, rejected_some = choose_license(license_)
            if chosen is None:
                disallowed.append(f"{name} ({license_})")
                continue
            for version in pkg.get("versions") or [""]:
                rows.append(
                    (
                        name,
                        version,
                        license_,
                        chosen if rejected_some else None,
                        source,
                        pkg.get("homepage") or "",
                    )
                )
    if unknown:
        sys.exit(f"npm packages without license metadata (resolve manually): {unknown}")
    if disallowed:
        sys.exit(
            "npm packages outside the A9 license allowlist "
            f"({', '.join(ALLOWED)}): {disallowed}"
        )
    rows.sort()
    lines = [
        "# Third-party notices — poly-lsp scripts",
        "",
        "The extension's own scripts bundle the packages below: the language client",
        "in `dist/extension.js`, mermaid in the markdown preview's `dist/preview.js`,",
        "the other diagram libraries in `dist/diagrams.js` and `dist/diagram/*.js`,",
        "@dbml/core in the DBML commands' `dist/dbml.js`, puppeteer, KaTeX and",
        "markdown-it in markdown export's `dist/markdownPdf.js`, swagger-parser",
        "in the Swagger preview's `dist/swaggerPreview.js`, marp-core and the",
        "directive parsers in Marp's `dist/marp/extension.js`, and marp-cli with",
        "puppeteer in its `dist/marp/cli.js`; swagger-ui-dist's files are copied to",
        "`dist/swagger/swagger-ui-dist`, and marp-cli's `bespoke.js` to `dist/marp`,",
        "as they are. The GitHub preview styles, the PlantUML preview page, draw.io's",
        "web app in `dist/drawio`, yzane.markdown-pdf's converter, CodeSnap's page",
        "with dom-to-image-even-more, the Swagger preview's page and schemas and",
        "marp-vscode's source are not packages; their notices are",
        "`media/github-markdown/LICENSE`, `media/plantuml/LICENSE` (its README",
        "names the icon font's), `media/drawio/LICENSE` (its README names the",
        "templates' and the icons'), `dist/markdown-pdf/LICENSE.txt`,",
        "`dist/codesnap/LICENSE.txt`, `dist/swagger/LICENSE.txt` and",
        "`dist/marp/LICENSE.txt`.",
        "Generated by tools/third-party-notices.py from",
        "`pnpm licenses list --prod` — do not edit by hand. Licenses are checked",
        "against the same A9 allowlist the poly binary uses; where a package also",
        "offers one poly does not accept, the term poly relies on is named inline.",
        "",
        "Packages the build marks `--external:` are absent, because they are not",
        "shipped.",
        "",
    ]
    for name, version, license_, taken, source, homepage in rows:
        suffix = f" — {homepage}" if homepage else ""
        note = f"; poly takes {taken}" if taken else ""
        via = f"; from its {source} file" if source else ""
        lines.append(f"- {name} {version} ({license_}{note}{via}){suffix}")
    lines.append("")
    return "\n".join(lines)


# A gate that stops working is worse than no gate: --check would still pass on
# a tree whose licenses were never really evaluated. These pin the behavior the
# allowlist depends on, including the copyleft cases we have no crate for today.
SELF_TEST = {
    "MIT": ("MIT", False),
    "MIT/Apache-2.0": ("MIT", False),  # cargo's pre-SPDX spelling of OR
    "Unlicense OR MIT": ("MIT", False),  # preference order, not source order
    "MIT AND BSD-3-Clause": ("MIT AND BSD-3-Clause", False),
    "MPL-2.0+": ("MPL-2.0+", False),
    "Apache-2.0 WITH LLVM-exception": ("Apache-2.0 WITH LLVM-exception", False),
    "(MIT OR Apache-2.0) AND Unicode-3.0": ("MIT AND Unicode-3.0", False),
    "MIT OR LGPL-3.0-or-later": ("MIT", True),
    "(MIT OR GPL-3.0) AND Unicode-3.0": ("MIT AND Unicode-3.0", True),
    "GPL-3.0": (None, False),
    "AGPL-3.0-only": (None, False),
    "LGPL-3.0-or-later": (None, False),
    "GPL-2.0 AND MIT": (None, False),  # AND, so the GPL half is not optional
}


def self_test() -> None:
    bad = [
        f"{expr!r}: expected {want}, got {got}"
        for expr, want in SELF_TEST.items()
        if (got := choose_license(expr)) != want
    ]
    if bad:
        sys.exit("license resolution regressed:\n  " + "\n  ".join(bad))
    print(f"license resolution: {len(SELF_TEST)} expressions OK")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check", action="store_true", help="verify committed file is current"
    )
    parser.add_argument(
        "--self-test", action="store_true", help="check SPDX resolution only"
    )
    # Two artifacts, two dependency managers, one allowlist: the poly binary's
    # crates and the packages the extension's bundles carry. Separable
    # because reading each needs that manager installed, and CI builds the two
    # in different jobs -- the cargo half runs where there is no pnpm, and
    # asking for both there failed the gate on a missing tool rather than on a
    # missing notice.
    parser.add_argument(
        "--scope",
        choices=("all", "cargo", "npm"),
        default="all",
        help="which artifact's notices to work on",
    )
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    artifacts = {"cargo": (OUT, collect), "npm": (NPM_OUT, collect_npm)}
    wanted = artifacts.keys() if args.scope == "all" else (args.scope,)
    for name in wanted:
        out, collector = artifacts[name]
        content = collector()
        if args.check:
            current = out.read_text() if out.exists() else ""
            if current != content:
                sys.exit(
                    f"{out.relative_to(ROOT)} is stale; run tools/third-party-notices.py"
                )
            print(f"{out.relative_to(ROOT)} is current")
            continue
        out.write_text(content)
        print(f"wrote {out.relative_to(ROOT)} ({content.count(chr(10))} lines)")


if __name__ == "__main__":
    main()

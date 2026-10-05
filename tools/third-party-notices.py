#!/usr/bin/env python3
"""Generate extensions/lsp/THIRD-PARTY-NOTICES*.md from cargo and pnpm (A9).

The poly binary statically links these crates; the notice ships inside the
platform VSIX and as a release asset. Grammar notices are generated
separately by grammar-sync.py. Run with --check to verify the committed
file is current (CI drift gate), and with --fetch to vendor the license of a
package that publishes none into licenses/.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extensions" / "lsp" / "THIRD-PARTY-NOTICES.md"
EXTENSION = ROOT / "extensions" / "lsp"
NPM_OUT = EXTENSION / "THIRD-PARTY-NOTICES-npm.md"
# Upstream license texts for packages that publish none of their own, one
# directory per repository (licenses/github.com/<owner>/<repo>/), each with a
# SOURCE file naming the URL every text was fetched from. A list of names and
# SPDX ids is not what MIT, BSD or Apache-2.0 ask to accompany a copy -- the
# text and its copyright lines are -- and a crate like ruff_linter, which
# publishes no LICENSE, still owes the one in its repository, whose
# attributions for the flake8 plugins it ports are the part that matters.
LICENSES = ROOT / "licenses"

# What counts as a package's license notice: the files at the top of the
# package whose name says so. NOTICE is here because Apache-2.0 §4(d) makes it
# part of what travels with a copy, and the third-party files because a package
# that bundles others (opencc-js's dictionaries) names their terms there.
# AUTHORS because a license granted by "the authors" names them there, and
# r-efi's is the only place it states its license and copyright at all.
NOTICE_FILE = re.compile(
    r"(?i)^(licen[cs]e|copying|notice|copyright|unlicense|third[-_]?party|authors)"
)

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
    # apache-arrow's two, for Data Preview. flatbuffers' manifest says "SEE
    # LICENSE IN LICENSE.txt", which is the Apache-2.0 text; text-encoding-utf-8
    # has none, and its LICENSE.md is the Unlicense.
    "flatbuffers": ("Apache-2.0", "LICENSE.txt"),
    "text-encoding-utf-8": ("Unlicense", "LICENSE.md"),
    # AutoCorrect's wasm build publishes the wasm and its glue and nothing else.
    # The licence is the MIT file in huacnlee/autocorrect at the same tag,
    # shipped beside the extension since the package does not carry it.
    "@huacnlee/autocorrect": ("MIT", "media/autocorrect/LICENSE"),
}

# A9/N5 allowlist for everything the binary statically links. Ordered by
# preference: when a crate offers a choice we take the earliest entry, so MIT
# leads. MPL-2.0 is acceptable because we use crates.io originals unmodified --
# there is no patched source form we would owe anyone under §3.1 -- but the
# binary is the Executable Form, and §3.2(a) still asks that its recipients be
# told where the Source Code Form is: every MPL row names its crates.io archive
# and the license's URL (`mpl_source`). Copyleft with no permissive
# alternative (GPL/AGPL/SSPL, bare LGPL) is not on the list and fails the build
# rather than landing quietly in the notices.
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
    # Icons: Git Graph's page draws its icons with the editor's own codicon
    # font. CC-BY's one condition is attribution, which is what this file is.
    "CC-BY-4.0",
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


def notice_files(directory: Path) -> list[Path]:
    return sorted(
        one
        for one in directory.iterdir()
        if one.is_file() and NOTICE_FILE.match(one.name)
    )


LICENSE_HEADING = re.compile(
    r"(?im)^(?:#{1,6}[ \t]*licen[cs]e\b[^\n]*|licen[cs]e\b[^\n]*\n[-=]{3,})[ \t]*$"
)
NEXT_HEADING = re.compile(r"(?m)^(?:#{1,6}[ \t]|[^\n]+\n[-=]{3,}[ \t]*$)")


def readme_license(text: str) -> str | None:
    """The License section of a README, when it is the license text itself.

    Some packages ship no LICENSE and put the MIT text, copyright line and all,
    under their README's License heading (degenerator, fastdom). That is the
    package's own copy, so it is preferred to one fetched from the repository;
    a section that only names the license is not a text and does not count.
    """
    heading = LICENSE_HEADING.search(text)
    if not heading:
        return None
    rest = text[heading.end() :]
    end = NEXT_HEADING.search(rest)
    section = rest[: end.start() if end else None].strip()
    if re.search(r"(?i)copyright", section) and re.search(
        r"(?i)permission|permitted|licensed under", section
    ):
        return section
    return None


def readme_licenses(directory: Path) -> list[Path]:
    return [
        one
        for one in sorted(directory.iterdir())
        if one.is_file()
        and one.name.lower().startswith("readme")
        and readme_license(one.read_text(errors="replace"))
    ]


def repo_key(url: str | None) -> str | None:
    """`host/owner/repo` for a repository URL in any spelling a manifest uses.

    It names the directory under licenses/, so `.git`, a trailing slash and a
    `/tree/main/packages/x` suffix must all land on the same one.
    """
    full = re.match(
        r"^(?:git\+)?(?:\w+://)?(?:git@)?([\w-]+(?:\.[\w-]+)+)[/:]([\w.-]+)/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$",
        url or "",
    )
    if full:
        return "/".join(full.groups())
    # npm's `owner/repo` shorthand, which means GitHub.
    short = re.match(r"^(?:github:)?([\w.-]+)/([\w.-]+?)(?:\.git)?$", url or "")
    return f"github.com/{short[1]}/{short[2]}" if short else None


def vendored(key: str | None) -> tuple[list[Path], list[str]]:
    """The license files kept under licenses/ for a repository, and their URLs."""
    directory = LICENSES / key if key else None
    if directory is None or not directory.is_dir():
        return [], []
    lines = (directory / "SOURCE").read_text().splitlines()
    urls = [line for line in lines if line and not line.startswith("#")]
    files = [one for one in sorted(directory.iterdir()) if one.name != "SOURCE"]
    # A SOURCE that is only a `#` note records that upstream has no license
    # text anywhere; the note is then what the notices say, rather than a
    # copyright line nobody wrote.
    return files or ([directory / "SOURCE"] if not urls else []), urls


def source_refs(urls: list[str]) -> set[str]:
    return {
        url.split("/blob/", 1)[1].split("/", 1)[0] for url in urls if "/blob/" in url
    }


def mpl_source(chosen: str, url: str) -> str:
    """MPL §3.2(a)'s pointer to the Source Code Form, for the rows that need one."""
    return f" — source {url} (https://mozilla.org/MPL/2.0/)" if "MPL" in chosen else ""


def license_texts(entries: list[tuple[str, list[Path], list[str]]]) -> list[str]:
    """Every text once, under the packages that carry it.

    Identical texts are folded together -- the Apache-2.0 text alone is carried
    by a few hundred crates -- comparing words rather than bytes, since the same
    license reflowed or re-indented is the same license. `entries` are (who,
    files, URLs of the vendored ones).
    """
    groups: dict[str, dict] = {}
    for who, files, urls in sorted(entries):
        for one in files:
            raw = one.read_bytes().decode("utf-8", errors="replace").lstrip("\ufeff")
            if one.name.lower().startswith("readme"):
                raw = readme_license(raw) or raw
            text = "\n".join(line.rstrip() for line in raw.splitlines()).strip("\n")
            group = groups.setdefault(
                " ".join(text.split()), {"text": text, "who": set(), "from": set()}
            )
            group["who"].add(who)
            group["from"].update(
                url for url in urls if url.rsplit("/", 1)[-1] == one.name
            )
    lines = ["", "## License texts"]
    for group in sorted(groups.values(), key=lambda g: (sorted(g["who"]), g["text"])):
        # Longer than any run of backticks inside, so a license written in
        # markdown cannot close the block early.
        runs = [len(run) for run in re.findall(r"`+", group["text"])]
        fence = "`" * max(3, max(runs, default=0) + 1)
        lines += ["", f"### {', '.join(sorted(group['who']))}", ""]
        lines += [f"From {url}" for url in sorted(group["from"])]
        if group["from"]:
            lines.append("")
        lines += [f"{fence}text", group["text"], fence]
    return lines


def missing_message(missing: list[tuple[str | None, list[str], str]]) -> str:
    named = sorted({f"{who} ({key or 'no repository'})" for key, _, who in missing})
    return (
        "packages with no license text of their own and none, or a stale one, "
        "under licenses/ -- run tools/third-party-notices.py --fetch, or vendor "
        "the repository's by hand with a SOURCE line per file:\n  " + "\n  ".join(named)
    )


def collect() -> tuple[str, list]:
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
    texts = []
    missing = []
    # Per vendored repository: the commits its crates were published from. The
    # text kept for it is current while it was fetched at one of them, and
    # stale once a bump has moved every crate past it -- the case where the
    # attributions upstream added since would otherwise never arrive.
    published: dict[str, set[str]] = {}
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
        who = f"{pkg['name']} {pkg['version']}"
        archive = f"https://static.crates.io/crates/{pkg['name']}/{pkg['name']}-{pkg['version']}.crate"
        rows.append(
            (
                pkg["name"],
                pkg["version"],
                license_,
                taken,
                repo,
                mpl_source(chosen, archive),
            )
        )
        crate = Path(pkg["manifest_path"]).parent
        files = notice_files(crate)
        if (
            pkg.get("license_file")
            and (crate / pkg["license_file"]).resolve() not in files
        ):
            files.append((crate / pkg["license_file"]).resolve())
        if files:
            texts.append((who, files, []))
            continue
        vcs = crate / ".cargo_vcs_info.json"
        sha = json.loads(vcs.read_text())["git"]["sha1"] if vcs.exists() else None
        key = repo_key(repo)
        refs = (
            [sha]
            if sha
            else [
                f"v{pkg['version']}",
                f"{pkg['name']}-v{pkg['version']}",
                pkg["version"],
                "HEAD",
            ]
        )
        files, urls = vendored(key)
        if not files:
            missing.append((key, refs, who))
            continue
        if sha:
            published.setdefault(key, set()).add(sha)
        texts.append((who, files, urls))
    for key, shas in published.items():
        # A `#` line in SOURCE says none of the crates' commits was on GitHub
        # when it was fetched (swc publishes from commits it never pushes), so
        # there is no commit to compare against.
        if "\n#" in "\n" + (LICENSES / key / "SOURCE").read_text():
            continue
        if not source_refs(vendored(key)[1]) & shas:
            missing.append(
                (key, sorted(shas), f"licenses/{key} (fetched at another commit)")
            )
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
        "named inline. A crate poly takes under MPL-2.0 is used unmodified, and",
        "its line names the crates.io archive that is its Source Code Form.",
        "",
        "The license texts the crates carry follow the list, each given once",
        "with the crates that carry it. A crate that publishes none is given",
        "its repository's, from the URL shown, at the commit the crate was",
        "published from.",
        "",
    ]
    for name, version, license_, taken, repo, source in rows:
        suffix = f" — {repo}" if repo else ""
        note = f"; poly takes {taken}" if taken else ""
        lines.append(f"- {name} {version} ({license_}{note}){suffix}{source}")
    lines += license_texts(texts)
    lines.append("")
    return "\n".join(lines), missing


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


def collect_npm() -> tuple[str, list]:
    """The packages esbuild bundles into the extension's two scripts.

    `pnpm licenses` rather than a walk of node_modules: it resolves the same
    tree the build resolves, and `--prod` is the half of it that can reach the
    bundle. Anything `--external:` keeps out is removed afterwards, since poly
    does not ship it and owes no notice for it. The license texts are read from
    the directories it names, one per installed version.
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
    texts = []
    missing = []
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
                tarball = f"https://registry.npmjs.org/{name}/-/{name.split('/')[-1]}-{version}.tgz"
                rows.append(
                    (
                        name,
                        version,
                        license_,
                        chosen if rejected_some else None,
                        source,
                        pkg.get("homepage") or "",
                        mpl_source(chosen, tarball),
                    )
                )
            for path in pkg.get("paths") or []:
                manifest = json.loads((Path(path) / "package.json").read_text())
                who = f"{name} {manifest['version']}"
                files = notice_files(Path(path)) or readme_licenses(Path(path))
                if not files and source and (EXTENSION / source).is_file():
                    # The override names a file shipped beside the extension
                    # when the package itself carries none (AutoCorrect's).
                    files = [EXTENSION / source]
                if files:
                    texts.append((who, files, []))
                    continue
                repository = manifest.get("repository")
                if isinstance(repository, dict):
                    repository = repository.get("url")
                key = repo_key(repository)
                files, urls = vendored(key)
                if not files:
                    short = name.split("/")[-1]
                    version = manifest["version"]
                    refs = [
                        f"v{version}",
                        f"{name}@{version}",
                        f"{short}-v{version}",
                        f"{short}@{version}",
                        version,
                        "HEAD",
                    ]
                    missing.append((key, refs, who))
                    continue
                texts.append((who, files, urls))
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
        "and Code Runner's picomatch in `dist/extension.js`, mermaid in the markdown",
        "preview's `dist/preview.js`,",
        "the other diagram libraries in `dist/diagrams.js` and `dist/diagram/*.js`,",
        "@dbml/core in the DBML commands' `dist/dbml.js`, opencc-js with OpenCC's",
        "dictionaries in the Chinese conversion commands' `dist/chinese.js`, AutoCorrect's",
        "wasm build in `dist/autocorrect.js` with `dist/autocorrect_bg.wasm`, puppeteer, KaTeX and",
        "markdown-it in markdown export's `dist/markdownPdf.js`, swagger-parser",
        "in the Swagger preview's `dist/swaggerPreview.js`, apache-arrow, avsc,",
        "parquets, SheetJS and the text formats' parsers in Data Preview's",
        "`dist/dataPreview.js`, marp-core and the",
        "directive parsers in Marp's `dist/marp/extension.js`, and marp-cli with",
        "puppeteer in its `dist/marp/cli.js`, lodash-es's debounce and throttle in",
        "Error Lens's `dist/errorLens/extension.js`, markdown-it and its emoji plugin",
        "in Git History's `dist/gitGraph.js`, and the codicon font and its stylesheet",
        "in Git History's page, `dist/git-graph`; swagger-ui-dist's files are copied to",
        "`dist/swagger/swagger-ui-dist`, and marp-cli's `bespoke.js` to `dist/marp`,",
        "as they are. The GitHub preview styles, the PlantUML preview page,",
        "yzane.markdown-pdf's converter, CodeSnap's page",
        "with dom-to-image-even-more, Paste Image's clipboard scripts, Data",
        "Preview's page with Perspective's release, the Swagger preview's page",
        "and schemas, marp-vscode's source, Code Runner's source, Error Lens's",
        "source and gutter icons, and Git History's graph (ported from Visual Studio",
        "Code's source control graph) are not packages; their notices are",
        "`media/github-markdown/LICENSE`, `media/plantuml/LICENSE` (its README",
        "names the icon font's), `dist/markdown-pdf/LICENSE.txt`,",
        "`dist/codesnap/LICENSE.txt`, `dist/paste-image/LICENSE.txt`,",
        "`dist/data-preview/LICENSE.txt`,",
        "`dist/swagger/LICENSE.txt`, `dist/marp/LICENSE.txt`,",
        "`dist/code-runner/LICENSE.txt`, `dist/errorLens/LICENSE.txt` and",
        "`dist/git-graph/LICENSE-vscode.txt`. Files copied out of a package carry its license",
        "beside them: `dist/git-graph/LICENSE`, `dist/opencc-js/`,",
        "`dist/markdown-pdf/highlight.js/LICENSE` and",
        "`dist/markdown-pdf/styles/katex/LICENSE`. Fonts name their copyright and",
        "license in a `FONTS.md` beside them (`dist/excalidraw`,",
        "`dist/markdown-pdf/styles/katex/fonts`), or in",
        "`media/plantuml/css/LICENSE-MaterialIcons.txt`.",
        "Generated by tools/third-party-notices.py from",
        "`pnpm licenses list --prod` — do not edit by hand. Licenses are checked",
        "against the same A9 allowlist the poly binary uses; where a package also",
        "offers one poly does not accept, the term poly relies on is named inline.",
        "",
        "Packages the build marks `--external:` are absent, because they are not",
        "shipped.",
        "",
        "The license, notice and third-party files the packages carry follow the",
        "list, each given once with the packages that carry it. A package that",
        "publishes none is given its repository's, from the URL shown.",
        "",
    ]
    for name, version, license_, taken, source, homepage, mpl in rows:
        suffix = f" — {homepage}" if homepage else ""
        note = f"; poly takes {taken}" if taken else ""
        via = f"; from its {source} file" if source else ""
        lines.append(f"- {name} {version} ({license_}{note}{via}){suffix}{mpl}")
    lines += license_texts(texts)
    lines.append("")
    return "\n".join(lines), missing


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


# Every spelling of a repository the manifests here use, against the directory
# under licenses/ it has to find. A miss is a package whose vendored license is
# never read, so the gate would call it missing on a tree that has it -- or,
# worse, two spellings of one repository would each get a copy.
REPO_KEYS = {
    "https://github.com/astral-sh/ruff": "github.com/astral-sh/ruff",
    "https://github.com/swc-project/swc.git": "github.com/swc-project/swc",
    "https://github.com/open-i18n/rust-unic/": "github.com/open-i18n/rust-unic",
    "git+https://github.com/radix-ui/primitives.git": "github.com/radix-ui/primitives",
    "git://github.com/wilsonpage/fastdom.git": "github.com/wilsonpage/fastdom",
    "https://github.com/puppeteer/puppeteer/tree/main/packages/browsers": "github.com/puppeteer/puppeteer",
    "antlr/antlr4.git": "github.com/antlr/antlr4",
    "https://gitlab.redox-os.org/redox-os/seahash": "gitlab.redox-os.org/redox-os/seahash",
    "": None,
}


def self_test() -> None:
    bad = [
        f"{expr!r}: expected {want}, got {got}"
        for expr, want in SELF_TEST.items()
        if (got := choose_license(expr)) != want
    ]
    bad += [
        f"repository {url!r}: expected {want}, got {got}"
        for url, want in REPO_KEYS.items()
        if (got := repo_key(url)) != want
    ]
    # The texts themselves: which files are a package's notice, that the same
    # license spelled with other whitespace is given once, and that a package
    # with neither a file nor a vendored copy is reported rather than listed
    # with nothing under it -- the defect this generator once shipped 1200 of.
    with tempfile.TemporaryDirectory() as tmp:
        one, two = Path(tmp, "one"), Path(tmp, "two")
        for directory, text in (
            (one, "MIT License\n\nCopyright (c) A"),
            (two, "MIT  License\r\n Copyright (c) A\n"),
        ):
            directory.mkdir()
            for name in ("LICENSE-MIT", "NOTICE", "README.md", "Cargo.toml"):
                (directory / name).write_text(text if name != "README.md" else "readme")
        if [f.name for f in notice_files(one)] != ["LICENSE-MIT", "NOTICE"]:
            bad.append(f"notice files: got {[f.name for f in notice_files(one)]}")
        rendered = license_texts(
            [("a 1", notice_files(one)[:1], []), ("b 2", notice_files(two)[:1], [])]
        )
        if (
            rendered.count("### a 1, b 2") != 1
            or sum(line.startswith("###") for line in rendered) != 1
        ):
            bad.append(
                "identical texts in different whitespace were not folded into one"
            )
        mit = (
            "(The MIT License)\n\nCopyright (c) 2013 A\n\nPermission is hereby granted"
        )
        readmes = {
            # degenerator's spelling: a setext heading, then the text, then more.
            f"# x\n\nusage\n\nLicense\n-------\n\n{mit}\n\n## After\n\nnot it\n": mit,
            f"## Licence\n\n{mit}\n": mit,
            "## License\n\nMIT\n\n## Copyright\n\nno text here\n": None,
            "# x\n\nno license section\n": None,
        }
        bad += [
            f"README license section of {text!r}: expected {want!r}, got {got!r}"
            for text, want in readmes.items()
            if (got := readme_license(text)) != want
        ]
    if vendored("example.invalid/nobody/nothing") != ([], []):
        bad.append("a repository with nothing vendored produced license files")
    if bad:
        sys.exit("license resolution regressed:\n  " + "\n  ".join(bad))
    print(
        f"license resolution: {len(SELF_TEST)} expressions, {len(REPO_KEYS)} repositories and the texts OK"
    )


def github(path: str) -> bytes:
    headers = {"User-Agent": "poly-notices", "Accept": "application/vnd.github+json"}
    # 60 requests an hour anonymously is less than one fetch of ruff, oxc and
    # swc together; a token raises it to 5000.
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token and path.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(
        urllib.request.Request(path, headers=headers), timeout=60
    ) as resp:
        return resp.read()


def vendor(key: str | None, refs: list[str]) -> None:
    """Copy a repository's license files at the first of `refs` that exists into licenses/."""
    host, owner, repo = (key or "//").split("/")
    if host != "github.com":
        sys.exit(
            f"{key}: not a GitHub repository; vendor its license into licenses/{key}/ by hand"
        )
    api = f"https://api.github.com/repos/{owner}/{repo}"
    for ref in [*refs, "HEAD"] if "HEAD" not in refs else refs:
        note = ""
        try:
            if ref == "HEAD":
                note = f"# no license file at {', '.join(r for r in refs if r != 'HEAD')} on GitHub; fetched at HEAD\n"
                # Recorded as the commit, not as HEAD: a SOURCE line has to
                # name the text that was fetched, and HEAD moves.
                ref = json.loads(github(f"{api}/commits/HEAD"))["sha"]
            listing = json.loads(
                github(f"{api}/contents?ref={urllib.parse.quote(ref, safe='')}")
            )
        except urllib.error.HTTPError as error:
            if error.code in (404, 422):
                continue
            raise
        found = [
            item
            for item in listing
            if item["type"] == "file" and NOTICE_FILE.match(item["name"])
        ]
        if not found:
            # Some repositories added their LICENSE after the release poly
            # links; the newest text is then the only one there is.
            continue
        directory = LICENSES / key
        shutil.rmtree(directory, ignore_errors=True)
        directory.mkdir(parents=True)
        for item in found:
            (directory / item["name"]).write_bytes(github(item["download_url"]))
        (directory / "SOURCE").write_text(
            note
            + "".join(
                f"https://github.com/{owner}/{repo}/blob/{ref}/{item['name']}\n"
                for item in found
            )
        )
        print(
            f"vendored {', '.join(item['name'] for item in found)} from {key} at {ref}"
        )
        return
    sys.exit(
        f"{key}: no license file at any of {refs} or HEAD; vendor its license by hand"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check", action="store_true", help="verify committed file is current"
    )
    parser.add_argument(
        "--self-test", action="store_true", help="check SPDX resolution only"
    )
    parser.add_argument(
        "--fetch",
        action="store_true",
        help="vendor the missing or stale license texts into licenses/ (network)",
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
        content, missing = collector()
        if missing and args.fetch:
            # One fetch per repository -- ruff's 29 crates share one LICENSE --
            # trying every crate's commit before falling back to HEAD.
            merged: dict[str | None, list[str]] = {}
            for key, refs, _ in missing:
                merged.setdefault(key, []).extend(
                    r for r in refs if r not in merged[key] and r != "HEAD"
                )
            for key, refs in merged.items():
                vendor(key, refs)
            content, missing = collector()
        if missing:
            sys.exit(missing_message(missing))
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

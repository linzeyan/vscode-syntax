#!/usr/bin/env python3
"""Generate extensions/lsp/THIRD-PARTY-NOTICES.md from cargo metadata (A9).

The poly binary statically links these crates; the notice ships inside the
platform VSIX and as a release asset. Grammar notices are generated
separately by grammar-sync.py. Run with --check to verify the committed
file is current (CI drift gate).
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extensions" / "lsp" / "THIRD-PARTY-NOTICES.md"

# A9/N5 allowlist for everything the binary statically links. Ordered by
# preference: when a crate offers a choice we take the earliest entry, so MIT
# leads. MPL-2.0 is acceptable because we use crates.io originals unmodified --
# there is no patched source form we would owe anyone under §3.1. Copyleft with
# no permissive alternative (GPL/AGPL/SSPL, bare LGPL) is not on the list and
# fails the build rather than landing quietly in the notices.
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
    "Unicode-3.0",
    "Unicode-DFS-2016",
    "CDLA-Permissive-2.0",
    "MPL-2.0",
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
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    content = collect()
    if args.check:
        current = OUT.read_text() if OUT.exists() else ""
        if current != content:
            sys.exit(
                f"{OUT.relative_to(ROOT)} is stale; run tools/third-party-notices.py"
            )
        print(f"{OUT.relative_to(ROOT)} is current")
        return
    OUT.write_text(content)
    print(f"wrote {OUT.relative_to(ROOT)} ({content.count(chr(10))} lines)")


if __name__ == "__main__":
    main()

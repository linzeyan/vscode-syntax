#!/usr/bin/env python3
"""External tool pin pipeline: the registry in poly-tools -> poly-tools.lock.

The grammars have had a weekly upstream refresh since M5; the external
linters never did. Their versions are pinned in Rust and were bumped by hand,
so `poly check` kept reporting whatever shellcheck said the day someone last
remembered -- the other half of R1.

Two things happen here:

- Versions come from upstream's latest release (--update), written back into
  the registry so Rust stays the single definition of what poly downloads.
- Every (version, platform) gets its sha256 recorded in poly-tools.lock, from
  the release API's asset digest. Before this, only the platforms someone had
  actually downloaded on were pinned; every other user's first download was
  trust-on-first-use, which is not a pin at all.

Usage: tools/tool-sync.py [--update | --check]

  (no flag)  refresh the lock for the versions the registry pins now
  --update   bump each tool to upstream's latest release, then refresh
  --check    verify the lock matches the registry; offline, for CI
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "cli" / "crates" / "poly-tools" / "src" / "lib.rs"
LOCK = ROOT / "poly-tools.lock"
UA = {"User-Agent": "poly-tool-sync"}
ASSET_URL = re.compile(
    r"https://github\.com/([^/]+/[^/]+)/releases/download/([^/]+)/(.+)"
)


def fetch(url: str) -> bytes:
    headers = dict(UA)
    # 60 requests/hour unauthenticated is thin for twelve tools on a shared
    # runner IP; a token raises it to 5000.
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def gh(url: str) -> dict:
    try:
        return json.loads(fetch(url))
    except urllib.error.HTTPError as e:
        if e.code in (403, 429) and not (
            os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        ):
            # Twelve tools is two dozen requests, and the anonymous budget is
            # 60 an hour shared across everyone on this IP. Saying so beats a
            # bare 403, which reads like the release is gone.
            sys.exit(
                f"error: {url} -> HTTP {e.code}: GitHub API rate limit. "
                "Set GITHUB_TOKEN (60 requests/hour anonymous, 5000 with one)."
            )
        sys.exit(f"error: {url} -> HTTP {e.code} {e.reason}")


def manifest() -> list[dict]:
    """The registry's (tool, version, platform, url) rows, from Rust itself.

    Asset naming is written once, in the registry closures; re-deriving it here
    would be a second definition that drifts the first time an upstream renames
    something -- and drift would look exactly like "this platform has no build".
    """
    out = subprocess.run(
        ["cargo", "run", "-q", "-p", "poly-tools", "--example", "manifest"],
        cwd=ROOT / "cli",
        capture_output=True,
        text=True,
        check=False,
    )
    if out.returncode != 0:
        sys.exit(f"error: cargo run --example manifest failed\n{out.stderr}")
    return json.loads(out.stdout)


# ── lock ───────────────────────────────────────────────────────────────────
# Kept in the shape poly itself writes (toml::to_string_pretty): one table per
# tool, "<version>-<platform>" = "<sha256>". poly only writes an entry it does
# not find, so a complete lock makes the runtime read-only -- and any mismatch
# a hard error instead of a silent re-pin.


def read_lock() -> dict[str, dict[str, str]]:
    if not LOCK.is_file():
        return {}
    lock: dict[str, dict[str, str]] = {}
    table = None
    for line in LOCK.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            table = lock.setdefault(line[1:-1].strip('"'), {})
        elif "=" in line and table is not None:
            key, value = line.split("=", 1)
            table[key.strip().strip('"')] = value.strip().strip('"')
    return lock


def write_lock(lock: dict[str, dict[str, str]]) -> None:
    out = []
    for tool in sorted(lock):
        out.append(f"[{tool}]")
        out += [f'"{k}" = "{v}"' for k, v in sorted(lock[tool].items())]
        out.append("")
    LOCK.write_text("\n".join(out).rstrip("\n") + "\n", encoding="utf-8")


def digests(rows: list[dict]) -> dict[str, dict[str, str]]:
    """sha256 for every row, from the release API's asset digest."""
    releases: dict[tuple[str, str], dict] = {}
    lock: dict[str, dict[str, str]] = {}
    for row in rows:
        match = ASSET_URL.match(row["url"])
        if not match:
            sys.exit(f"error: {row['name']} url is not a GitHub release asset")
        repo, tag, asset = match.groups()
        if (repo, tag) not in releases:
            releases[(repo, tag)] = gh(
                f"https://api.github.com/repos/{repo}/releases/tags/{tag}"
            )
        found = next(
            (a for a in releases[(repo, tag)]["assets"] if a["name"] == asset), None
        )
        if not found:
            sys.exit(
                f"error: {repo} {tag} ships no asset {asset!r} "
                f"({row['name']} {row['platform']}) — upstream renamed it, so "
                f"the registry closure needs updating"
            )
        digest = found.get("digest") or ""
        if digest.startswith("sha256:"):
            digest = digest.removeprefix("sha256:")
        else:
            # GitHub only started publishing digests in 2025; an older release
            # has none, and the only way to pin it is to hash the bytes.
            print(f"  {row['name']} {row['platform']}: no digest, downloading")
            digest = hashlib.sha256(fetch(row["url"])).hexdigest()
        lock.setdefault(row["name"], {})[f"{row['version']}-{row['platform']}"] = digest
    return lock


# ── version bump ───────────────────────────────────────────────────────────


def latest_version(repo: str, tag: str) -> str:
    """Upstream's newest non-prerelease version, in the registry's spelling.

    Half these projects tag `v1.2.3` and half tag `1.2.3`, but the registry
    stores the bare version either way -- the closure adds the `v` back where
    its URL needs one. Deriving that from the pinned tag rather than assuming
    keeps a tool that changes its tag style from silently building 404s.
    """
    release = gh(f"https://api.github.com/repos/{repo}/releases/latest")
    latest = release["tag_name"]
    if tag.startswith("v") != latest.startswith("v"):
        print(f"  note: {repo} tags {latest!r}, pin was {tag!r}")
    return latest.removeprefix("v") if latest.startswith("v") else latest


def bump(source: str, tool: str, version: str) -> str:
    """Rewrite one tool's `version:` in the registry."""
    pattern = re.compile(rf'(name: "{re.escape(tool)}",\s*\n\s*version: ")[^"]*(")')
    source, count = pattern.subn(rf"\g<1>{version}\g<2>", source, count=1)
    if count != 1:
        sys.exit(f"error: could not find the version pin for {tool} in {REGISTRY}")
    return source


def update_registry(rows: list[dict]) -> bool:
    """Bump every tool that has a newer release, or change nothing at all.

    The edits accumulate in memory and land in one write at the end, so a tool
    whose lookup fails half way through leaves the registry untouched rather
    than pinned to a mix of old and new. grammar-sync learned this the hard
    way: it wrote a half-synced lock, then rebuilt package.json from it.
    """
    source = REGISTRY.read_text(encoding="utf-8")
    original = source
    seen: dict[str, tuple[str, str]] = {}
    for row in rows:
        if row["name"] in seen:
            continue
        _, tag, _ = ASSET_URL.match(row["url"]).groups()
        seen[row["name"]] = (row["version"], tag)
    for tool, (pinned, tag) in seen.items():
        repo = ASSET_URL.match(next(r["url"] for r in rows if r["name"] == tool)).group(
            1
        )
        latest = latest_version(repo, tag)
        if latest != pinned:
            print(f"  {tool}: {pinned} -> {latest}")
            source = bump(source, tool, latest)
    if source == original:
        return False
    REGISTRY.write_text(source, encoding="utf-8")
    return True


# ── commands ───────────────────────────────────────────────────────────────


def cmd_check(rows: list[dict]) -> int:
    """The lock covers the registry exactly. Offline: no upstream, no bytes."""
    lock = read_lock()
    want = {(r["name"], f"{r['version']}-{r['platform']}") for r in rows}
    have = {(tool, key) for tool, keys in lock.items() for key in keys}
    problems = []
    for tool, key in sorted(want - have):
        problems.append(f"{tool} {key}: pinned in the registry, missing from the lock")
    # A stale entry is a version nobody can reach any more: dead weight at best,
    # and at worst it is the previous pin left behind by a hand-edited bump,
    # which is the failure this gate exists to catch.
    for tool, key in sorted(have - want):
        problems.append(f"{tool} {key}: in the lock, not pinned by the registry")
    for line in problems:
        print(f"::error title=tool-sync::{line}" if os.environ.get("CI") else line)
    if problems:
        print(
            f"\n{len(problems)} problems — run tools/tool-sync.py to rebuild the lock"
        )
        return 1
    print(f"poly-tools.lock covers all {len(want)} pinned (version, platform) pairs")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--update", action="store_true", help="bump versions to upstream latest"
    )
    group.add_argument(
        "--check", action="store_true", help="verify the lock offline (CI gate)"
    )
    args = parser.parse_args()

    rows = manifest()
    if args.check:
        return cmd_check(rows)

    if args.update:
        print("checking upstream for newer releases")
        if update_registry(rows):
            # The versions moved, so every URL did: ask Rust again rather than
            # patching the rows here, which would assume the version is the
            # only thing in an asset name that changes.
            rows = manifest()
        else:
            print("  every tool is already on its latest release")

    print(f"pinning {len(rows)} (tool, version, platform) downloads")
    write_lock(digests(rows))
    print(f"wrote {LOCK.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

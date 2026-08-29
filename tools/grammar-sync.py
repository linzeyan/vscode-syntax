#!/usr/bin/env python3
"""Grammar sync pipeline: grammars/sources.json -> extensions/syntax/.

- Downloads each grammar pinned to a per-repo commit sha (grammars/sources.lock.json);
  --update refreshes pins to upstream HEAD.
- Converts .tmLanguage (plist) and .yaml sources to tmLanguage.json.
- Generates the csv/tsv rainbow grammars locally (no upstream).
- Regenerates package.json `contributes.languages/grammars` and
  THIRD-PARTY-NOTICES.md from sources.json, so sources.json is the single
  source of truth.

Usage: tools/grammar-sync.py [--update] [--only id,id,...]
"""

import argparse
import hashlib
import io
import json
import os
import plistlib
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "grammars" / "sources.json"
LOCK = ROOT / "grammars" / "sources.lock.json"
EXT = ROOT / "extensions" / "syntax"
SYNTAXES = EXT / "syntaxes"
UA = {"User-Agent": "poly-grammar-sync"}
# Grammar contribution keys copied verbatim from upstream (see contributesFrom).
GRAMMAR_META = ("embeddedLanguages", "tokenTypes", "unbalancedBracketScopes")


def fetch(url: str) -> bytes:
    headers = dict(UA)
    # 60 requests/hour unauthenticated is not enough for a full --update on a
    # shared runner IP; a token raises it to 5000.
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def head_sha(repo: str) -> str:
    data = json.loads(fetch(f"https://api.github.com/repos/{repo}/commits/HEAD"))
    return data["sha"]


def fetch_vsix(publisher: str, name: str, version: str) -> zipfile.ZipFile:
    """Download a marketplace VSIX ('latest' allowed) and open it as a zip.

    Used when upstream only commits unprocessable build sources (e.g. mermaid's
    custom !!import YAML tags) — the marketplace package carries the built JSON.
    """
    url = (
        "https://marketplace.visualstudio.com/_apis/public/gallery/"
        f"publishers/{publisher}/vsextensions/{name}/{version}/vspackage"
    )
    req = urllib.request.Request(
        url,
        headers={**UA, "Accept": "application/octet-stream", "Accept-Encoding": "gzip"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            import gzip

            raw = gzip.decompress(raw)
    return zipfile.ZipFile(io.BytesIO(raw))


def convert(raw: bytes, src_path: str) -> dict:
    # language-haskell authors in YAML and commits only the source; the .json
    # its package.json points at is build output that never lands in the repo.
    if src_path.endswith((".yaml", ".yml", "YAML-tmLanguage")):
        import yaml  # only needed for yaml-sourced grammars (svelte, haskell)

        return yaml.safe_load(raw)
    if src_path.endswith(".json"):
        return json.loads(raw)
    # .tmLanguage / .plist
    return plistlib.loads(raw)


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


# ── csv/tsv rainbow generator ──────────────────────────────────────────────
# Columns map onto widely-themed standard scopes so every color theme shows a
# rainbow without any configurationDefaults. First 16 columns cycle 8 scopes;
# later columns stay uncolored (acceptable: most CSVs are narrower).
RAINBOW_SCOPES = [
    "keyword",
    "string",
    "constant.numeric",
    "entity.name.function",
    "entity.name.type",
    "variable.language",
    "comment",
    "support.constant",
]
RAINBOW_COLUMNS = 16


def rainbow_grammar(lang: str, sep_re: str, sep_name: str) -> dict:
    field = '("(?:[^"]|"")*"|[^SEP\\n]*)'.replace("SEP", sep_re)
    pattern = (
        "^" + field + ("(?:(" + sep_re + ")" + field + ")?") * (RAINBOW_COLUMNS - 1)
    )
    captures = {}
    for i in range(1, RAINBOW_COLUMNS + 1):
        group = 1 if i == 1 else 2 * i - 1
        scope = RAINBOW_SCOPES[(i - 1) % len(RAINBOW_SCOPES)]
        captures[str(group)] = {"name": f"{scope}.rainbow{i}.{lang}"}
        if i > 1:
            captures[str(2 * i - 2)] = {
                "name": f"punctuation.separator.{sep_name}.{lang}"
            }
    return {
        "name": lang.upper(),
        "scopeName": f"source.{lang}",
        "patterns": [{"match": pattern, "captures": captures}],
    }


# ── ssh_config generator ───────────────────────────────────────────────────
# The only tmBundles for this format ship without a license file, so poly
# generates its own rather than vendoring one (N5). ssh parses a line as
# "keyword arguments", and OpenSSH keeps adding keywords -- so any first word
# is a keyword here instead of a closed list that would silently rot.

SSH_CONSTANTS = "yes|no|ask|confirm|auto|none|any|default|force|autoask"
# %-tokens ssh expands in values (%h host, %p port, %r remote user, ...).
SSH_TOKENS = "%[%CdhijkLlnprTu]"


def ssh_config_grammar() -> dict:
    value_patterns = [
        {"include": "#comment"},
        {"match": SSH_TOKENS, "name": "constant.character.escape.ssh-config"},
        {"match": '"[^"]*"', "name": "string.quoted.double.ssh-config"},
        {
            "match": f"(?i)\\b({SSH_CONSTANTS})\\b",
            "name": "constant.language.ssh-config",
        },
        {"match": "\\b\\d+\\b", "name": "constant.numeric.ssh-config"},
    ]
    return {
        "name": "SSH Config",
        "scopeName": "source.ssh-config",
        "patterns": [
            {"include": "#comment"},
            {"include": "#section"},
            {"include": "#directive"},
        ],
        "repository": {
            "comment": {"match": "#.*$", "name": "comment.line.number-sign.ssh-config"},
            # Host/Match open a block, and their patterns are what people scan
            # a config for, so they get section scopes rather than plain values.
            "section": {
                "begin": "(?i)^\\s*(Host|Match)\\b",
                "beginCaptures": {"1": {"name": "keyword.control.ssh-config"}},
                "end": "$",
                "patterns": [
                    {"include": "#comment"},
                    {"match": "[^\\s#]+", "name": "entity.name.section.ssh-config"},
                ],
            },
            "directive": {
                "begin": "^\\s*([A-Za-z][A-Za-z0-9]*)\\s*(=)?",
                "beginCaptures": {
                    "1": {"name": "keyword.other.ssh-config"},
                    "2": {"name": "punctuation.separator.key-value.ssh-config"},
                },
                "end": "$",
                "patterns": value_patterns,
            },
        },
    }


GENERATORS = {
    "csv": lambda: rainbow_grammar("csv", ",", "comma"),
    "tsv": lambda: rainbow_grammar("tsv", "\\t", "tab"),
    "ssh-config": ssh_config_grammar,
}


# ── contributes generation ─────────────────────────────────────────────────
# A9/N5: an allowlist enforced here, not a judgement call at review time. The
# M0 near-miss -- a GPL-3.0 nginx grammar -- was caught by reading the upstream
# repo by hand, and nothing in this pipeline would have stopped it from
# shipping. MPL-2.0 is in because N5 ratified it: it is file-level copyleft and
# the vendored file we redistribute *is* its source form, sitting in a public
# repo, which satisfies §3.1 even though convert() reserializes it. Widening
# this set is a spec change, not a sources.json edit.
ALLOWED_LICENSES = {
    "0BSD",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "MIT",
    "MPL-2.0",
    "Unlicense",
}


def check_licenses(sources: dict) -> None:
    """Every vendored grammar carries an allowlisted upstream license (A9).

    Locally generated grammars are exempt: they have no upstream to license,
    which is also why they carry no `license` field rather than an empty one.
    """
    missing = [
        lang["id"]
        for lang in sources["languages"]
        if not lang.get("generated") and not lang.get("license")
    ]
    disallowed = [
        f"{lang['id']} ({lang['license']})"
        for lang in sources["languages"]
        if lang.get("license") and lang["license"] not in ALLOWED_LICENSES
    ]
    problems = []
    if missing:
        problems.append("grammar sources with no license: " + ", ".join(missing))
    if disallowed:
        allowed = ", ".join(sorted(ALLOWED_LICENSES))
        problems.append(
            f"grammar licenses outside the A9 allowlist ({allowed}): "
            + ", ".join(disallowed)
        )
    if problems:
        raise SystemExit("\n".join(problems))


def check_language_ids(sources: dict) -> None:
    """A grammar must bind to a language id somebody actually contributes.

    When an entry declares its own language (`override: false`), VSCode gets the
    file associations from *our* id, so a grammar carrying upstream's different
    id binds to nothing and the files open with no highlighting at all. Nothing
    else catches it: tokenize-check loads grammars by scopeName, so the fixtures
    keep passing. Entries without a `language` block are exempt — those take
    over a built-in and legitimately name the built-in's id.
    """
    bad = [
        f"{lang['id']}: {f['out']} declares language {f['language']!r}"
        for lang in sources["languages"]
        if lang.get("language") and not lang.get("override")
        for f in lang["files"]
        if f.get("language") and f["language"] != lang["id"]
    ]
    if bad:
        raise SystemExit(
            "grammar language ids do not match the contributed language:\n  "
            + "\n  ".join(bad)
        )


def build_contributes(sources: dict, lock: dict) -> tuple[list, list]:
    check_licenses(sources)
    check_language_ids(sources)
    languages, grammars = [], []
    for lang in sources["languages"]:
        cfg = lang.get("language") or {}
        if not lang.get("override"):
            entry = {"id": lang["id"]}
            for key in ("extensions", "filenames", "filenamePatterns", "aliases"):
                if cfg.get(key):
                    entry[key] = cfg[key]
            if cfg.get("configuration"):
                entry["configuration"] = (
                    f"./language-configuration/{cfg['configuration']}"
                )
            languages.append(entry)
        elif cfg.get("configuration"):
            # Built-in override that only refines configuration (e.g. markdown
            # onEnterRules): contribute id+configuration, never associations.
            languages.append(
                {
                    "id": lang["id"],
                    "configuration": f"./language-configuration/{cfg['configuration']}",
                }
            )
        for f in lang["files"]:
            g = {}
            if f.get("language"):
                g["language"] = f["language"]
            g["scopeName"] = f["scopeName"]
            g["path"] = f"./syntaxes/{f['out']}"
            if f.get("injectTo"):
                g["injectTo"] = f["injectTo"]
            # Static declarations in sources.json win; contributesFrom-harvested
            # metadata lives in the lock so partial (--only) runs and CI re-runs
            # stay deterministic.
            harvested = (
                lock.get(lang.get("repo") or "", {})
                .get("contributes", {})
                .get(f["scopeName"], {})
            )
            for key in GRAMMAR_META:
                value = f.get(key) or harvested.get(key)
                if value:
                    g[key] = value
            grammars.append(g)
    return languages, grammars


def build_notices(sources: dict, lock: dict) -> str:
    lines = [
        "# Third-party notices — poly-syntax-highlight",
        "",
        "Bundled grammars retain their upstream licenses. Sources are pinned in",
        "grammars/sources.lock.json.",
        "",
    ]
    seen = set()
    for lang in sources["languages"]:
        repo = lang.get("repo")
        if not repo or repo in seen:
            continue
        seen.add(repo)
        sha = lock.get(repo, {}).get("sha", "unpinned")[:12]
        files = sorted(
            {
                f["out"]
                for l in sources["languages"]
                if l.get("repo") == repo
                for f in l["files"]
            }
        )
        lines.append(f"- https://github.com/{repo} ({lang['license']}) @ {sha}")
        lines.append(f"  files: {', '.join(files)}")
    # Derived, not spelled out: this line named csv/tsv only and went stale the
    # moment a third generated grammar landed.
    generated = sorted(
        lang["id"] for lang in sources["languages"] if lang.get("generated")
    )
    lines.append("")
    lines.append(f"Generated locally, no upstream: {', '.join(generated)}.")
    return "\n".join(lines) + "\n"


def prune_lock(sources: dict, lock: dict) -> None:
    """Drop lock state for sources that no longer exist.

    Retiring a grammar otherwise leaves its digest behind forever, and the
    stale entry keeps showing up in the notices as a file we still ship.
    Only safe on a full run: --only never visits the other languages.
    """
    live_files: dict[str, set[str]] = {}
    live_keys = set()
    for lang in sources["languages"]:
        if lang.get("generated"):
            continue
        if lang.get("vsix"):
            key = f"vsix:{lang['vsix']['publisher']}.{lang['vsix']['name']}"
        else:
            key = lang["repo"]
        live_keys.add(key)
        live_files.setdefault(key, set()).update(f["src"] for f in lang["files"])
    for key in list(lock):
        if key not in live_keys:
            del lock[key]
            continue
        files = lock[key].get("files")
        if files:
            for src in list(files):
                if src not in live_files[key]:
                    del files[src]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--update", action="store_true", help="refresh pinned shas to HEAD"
    )
    parser.add_argument("--only", help="comma-separated language ids")
    args = parser.parse_args()

    sources = json.loads(SOURCES.read_text())
    lock = json.loads(LOCK.read_text()) if LOCK.exists() else {}
    only = set(args.only.split(",")) if args.only else None

    failures = []
    # One repo backs many languages (microsoft/vscode alone backs 11), and the
    # refresh below resets its lock entry. Doing that per language would wipe
    # the files/embedded maps the earlier languages just filled in, leaving
    # only the last one's — so refresh each source once per run.
    refreshed: set[str] = set()
    for lang in sources["languages"]:
        if only and lang["id"] not in only:
            continue
        try:
            if lang.get("generated"):
                for f in lang["files"]:
                    write_json(SYNTAXES / f["out"], GENERATORS[f["generator"]]())
                    print(f"  {lang['id']}: generated {f['out']}")
                continue
            if lang.get("vsix"):
                pub, name = lang["vsix"]["publisher"], lang["vsix"]["name"]
                key = f"vsix:{pub}.{name}"
                version = (
                    "latest"
                    if (args.update or key not in lock)
                    else lock[key]["version"]
                )
                zf = fetch_vsix(pub, name, version)
                actual_version = json.loads(zf.read("extension/package.json"))[
                    "version"
                ]
                if key not in refreshed:
                    lock[key] = {"version": actual_version}
                    refreshed.add(key)
                for f in lang["files"]:
                    raw = zf.read(f["src"])
                    grammar = json.loads(raw)
                    if grammar.get("scopeName") != f["scopeName"]:
                        raise ValueError(
                            f"{f['src']}: scopeName {grammar.get('scopeName')!r} != {f['scopeName']!r}"
                        )
                    write_json(SYNTAXES / f["out"], grammar)
                    digest = hashlib.sha256(raw).hexdigest()[:16]
                    lock[key].setdefault("files", {})[f["src"]] = digest
                    print(
                        f"  {lang['id']}: {f['out']} <- vsix {pub}.{name}@{actual_version} ({digest})"
                    )
                continue
            repo = lang["repo"]
            if repo not in refreshed and (args.update or repo not in lock):
                lock[repo] = {"sha": head_sha(repo)}
                refreshed.add(repo)
            sha = lock[repo]["sha"]
            for f in lang["files"]:
                # Upstream paths may contain spaces ("Regular Expressions
                # (JavaScript).tmLanguage"), which urllib rejects raw.
                src = urllib.parse.quote(f["src"])
                raw = fetch(f"https://raw.githubusercontent.com/{repo}/{sha}/{src}")
                grammar = convert(raw, f["src"])
                actual = grammar.get("scopeName")
                if actual != f["scopeName"]:
                    raise ValueError(
                        f"{f['src']}: scopeName {actual!r} != expected {f['scopeName']!r}"
                    )
                if f.get("contributesFrom"):
                    # A grammar alone is not the whole contribution: embedded
                    # languages, token types and bracket exclusions decide how
                    # the editor treats template expressions, JSX and regexes.
                    # Copy them from upstream so takeover changes nothing else.
                    pkg = json.loads(
                        fetch(
                            f"https://raw.githubusercontent.com/{repo}/{sha}/{f['contributesFrom']}"
                        )
                    )
                    entries = [
                        e
                        for e in pkg["contributes"]["grammars"]
                        if e.get("scopeName") == f["scopeName"]
                    ]
                    if not entries:
                        raise ValueError(
                            f"{f['src']}: {f['scopeName']} not in {f['contributesFrom']}"
                        )
                    # One scope can be listed under several languages with only
                    # one of them carrying the metadata (source.yaml is both
                    # yaml and dockercompose), so merge rather than take the
                    # first match.
                    meta = {}
                    for entry in entries:
                        meta.update({k: entry[k] for k in GRAMMAR_META if entry.get(k)})
                    if meta:
                        lock[repo].setdefault("contributes", {})[f["scopeName"]] = meta
                write_json(SYNTAXES / f["out"], grammar)
                digest = hashlib.sha256(raw).hexdigest()[:16]
                lock[repo].setdefault("files", {})[f["src"]] = digest
                print(f"  {lang['id']}: {f['out']} <- {repo}@{sha[:8]} ({digest})")
        # Blind on purpose: one bad upstream (404, moved path, invalid plist)
        # must not hide what the other 78 languages would have reported.
        except Exception as exc:  # noqa: BLE001
            failures.append((lang["id"], str(exc)))
            print(f"  {lang['id']}: FAILED — {exc}", file=sys.stderr)

    # A failed language leaves its lock entry stripped of the files/embedded
    # maps it was about to repopulate, so writing the aggregates here would
    # bake a half-synced lock into package.json and the notices. Bail first.
    if failures:
        print("\nFAILURES (no files written):", file=sys.stderr)
        for lang_id, err in failures:
            print(f"  {lang_id}: {err}", file=sys.stderr)
        return 1

    if not only:
        prune_lock(sources, lock)
    write_json(LOCK, lock)

    languages, grammars = build_contributes(sources, lock)
    pkg_path = EXT / "package.json"
    pkg = json.loads(pkg_path.read_text())
    pkg["contributes"]["languages"] = languages
    pkg["contributes"]["grammars"] = grammars
    write_json(pkg_path, pkg)
    (EXT / "THIRD-PARTY-NOTICES.md").write_text(
        build_notices(sources, lock), encoding="utf-8"
    )

    print(f"\nlanguages: {len(languages)} contributed, grammars: {len(grammars)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())

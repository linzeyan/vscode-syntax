#!/usr/bin/env python3
"""Do the three manifests and their translations still agree?

`make nls`, and part of `make gates`.

VSCode resolves `%key%` against package.nls.json, and against
package.nls.<locale>.json when the editor is in that locale. Neither failure
mode is loud: a `%key%` with no entry renders as the literal `%key%` in the
settings UI, and a key missing from the Chinese file silently falls back to
English. Both look like nothing happened, so both need a check rather than a
reviewer.

Three things are asserted, per extension:

  * every `%key%` the manifest references exists in package.nls.json
  * package.nls.json has no key the manifest never references
  * every locale file holds exactly the same key set as the English one

The second one matters as much as the first. A key left behind after a setting
is removed is a translation somebody will keep updating for a string nobody
renders.
"""

import json
import pathlib
import re
import sys

EXTENSIONS = ("lsp",)

# `%key%` and nothing else: a percent sign inside prose (`50% of`) has to stay
# prose, so the whole value has to be the reference. That is also how VSCode
# reads it -- it substitutes whole values, not fragments.
REFERENCE = re.compile(r"^%([^%]+)%$")


def referenced(node, found):
    """Every `%key%` reachable from `node`, whatever it is nested in."""
    if isinstance(node, str):
        match = REFERENCE.match(node)
        if match:
            found.add(match.group(1))
    elif isinstance(node, dict):
        for value in node.values():
            referenced(value, found)
    elif isinstance(node, list):
        for value in node:
            referenced(value, found)
    return found


def check(root, name, problems):
    where = root / "extensions" / name
    manifest = json.loads((where / "package.json").read_text())
    english_path = where / "package.nls.json"
    if not english_path.exists():
        problems.append(f"{name}: no package.nls.json")
        return
    english = json.loads(english_path.read_text())

    used = referenced(manifest, set())
    for key in sorted(used - set(english)):
        problems.append(f"{name}: %{key}% has no entry, so the UI shows the key itself")
    for key in sorted(set(english) - used):
        problems.append(
            f"{name}: package.nls.json defines {key}, which nothing references"
        )

    locales = sorted(where.glob("package.nls.*.json"))
    if not locales:
        problems.append(f"{name}: no translation at all")
    for path in locales:
        translated = json.loads(path.read_text())
        locale = path.name[len("package.nls.") : -len(".json")]
        for key in sorted(set(english) - set(translated)):
            problems.append(
                f"{name} [{locale}]: {key} is missing, and falls back to English"
            )
        for key in sorted(set(translated) - set(english)):
            problems.append(
                f"{name} [{locale}]: {key} translates a string that no longer exists"
            )
    print(f"  {name}: {len(used)} keys, {len(locales)} translation(s)")


def main():
    root = pathlib.Path(__file__).resolve().parent.parent
    problems = []
    print("manifest strings and their translations")
    for name in EXTENSIONS:
        check(root, name, problems)
    if problems:
        print(f"\n{len(problems)} problem(s):")
        for problem in problems:
            print(f"  {problem}")
        return 1
    print("every %key% resolves, in every locale")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Turn `poly --format json` into GitHub check annotations.

Reading a job log needs a token that not every collaborator on this repo has;
annotations are public. A gate whose failure reads "Process completed with exit
code 1" is a gate nobody can act on, so this republishes poly's own findings
where they can be seen -- and, because poly reports a position, on the line
that caused them rather than on the job as a whole.

Nothing here re-renders a finding. The message, the rule and the severity are
poly's, verbatim; this only maps them onto GitHub's annotation syntax. The
markdown table in the job summary comes from `poly --format table_markdown`
for the same reason: a second definition of what a finding looks like is a
second thing to keep in sync.

Usage: ci-annotate.py <report.json> [...]
Always exits 0 -- the verdict is poly's exit code, not this script's.
"""

import json
import pathlib
import sys

# GitHub keeps the first few annotations of each level per step and silently
# drops the rest. Announcing the cut beats stopping without saying so.
LIMIT = 20


def escape(text: str) -> str:
    """Encode the characters that would end an annotation early.

    Order matters: the percent sign is the escape character, so it has to be
    replaced before anything that introduces one.
    """
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def annotate(issue: dict) -> None:
    # `fatal` is poly's own answer to "does this fail the build", already
    # resolved against the fail-on in force. Deriving it from the severity here
    # would mean reimplementing that ordering in a second language.
    level = "error" if issue["fatal"] else "warning"
    title = f"{issue['tool']}/{issue['rule']}"
    print(
        f"::{level} file={issue['file']},line={issue['line']},"
        f"col={issue['col']},title={escape(title)}::{escape(issue['message'])}"
    )


def main(paths: list[str]) -> int:
    shown = 0
    dropped = 0
    for path in paths:
        report = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
        for issue in report["issues"]:
            if shown < LIMIT:
                annotate(issue)
                shown += 1
            else:
                dropped += 1
    if dropped:
        print(
            f"::notice title=poly::{dropped} more findings not annotated; "
            f"run `poly check .` locally for the full list"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

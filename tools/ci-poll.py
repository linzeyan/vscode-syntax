#!/usr/bin/env python3
"""Poll GitHub Actions runs for a commit until all complete.

Usage: ci-poll.py <head_sha> [max_polls] [--workflow NAME]

--workflow waits for that workflow by name and ignores the others; without
it, every run for the sha must complete. Needed because a tag push adds a
run to a sha whose branch-push runs already finished — polling all runs
would exit before the new one registers.

gh CLI is not installed here; commit messages may contain control
characters, hence strict=False decoding.
"""

import json
import subprocess
import sys
import time

argv = [a for a in sys.argv[1:]]
workflow = None
if "--workflow" in argv:
    i = argv.index("--workflow")
    workflow = argv[i + 1]
    del argv[i : i + 2]

sha = argv[0]
max_polls = int(argv[1]) if len(argv) > 1 else 20
url = f"https://api.github.com/repos/linzeyan/vscode-syntax/actions/runs?head_sha={sha}"

for i in range(1, max_polls + 1):
    time.sleep(45)
    raw = subprocess.run(
        ["curl", "-s", "-H", "User-Agent: poly-dev", url],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    runs = json.JSONDecoder(strict=False).decode(raw).get("workflow_runs", [])
    if workflow:
        runs = [r for r in runs if r["name"] == workflow]
    print(f"--- poll {i} ---", flush=True)
    if not runs:
        print(f"no {workflow or ''} runs yet", flush=True)
        continue
    for r in runs:
        print(
            f"{r['name']}: {r['status']}/{r.get('conclusion')} {r['html_url']}",
            flush=True,
        )
    if all(r["status"] == "completed" for r in runs):
        ok = all(r["conclusion"] == "success" for r in runs)
        print("ALL GREEN" if ok else "FAILURES PRESENT", flush=True)
        sys.exit(0 if ok else 1)
print("TIMEOUT", flush=True)
sys.exit(2)

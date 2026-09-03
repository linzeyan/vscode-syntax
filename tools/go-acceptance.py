#!/usr/bin/env python3
"""End-to-end acceptance for poly's Go support.

Go is the language poly does the most for: gofumpt formats it, golangci-lint
lints it, gopls answers language requests through the proxy. Until this file
existed no gate ever ran the first two against a real Go project -- the Rust
tests only cover `gofumpt = "off"`, which is the path where nothing runs at all,
and `make dogfood` has no Go in it to find. The proxy probe covers gopls; this
covers the two tools that are poly's own to drive, the module grouping that is
Go-specific, and the one place the editor and the CLI disagree.

Usage: tools/go-acceptance.py [path-to-poly-binary]
Skips loudly when the Go toolchain is absent; fails otherwise.
"""

import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time

BIN = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "cli/target/release/poly")

# gofmt leaves a blank line at the top of a block alone; gofumpt removes it.
# Chosen for exactly that: a fixture both tools rewrite would pass even if poly
# had quietly fallen back to the gofmt in the user's toolchain, and "poly
# formats Go" is not the claim -- "poly formats Go the way `poly check` will
# demand in CI" is.
BLANK_LINE_AFTER_BRACE = """package main

func main() {

\tprintln("hi")
}
"""

# Two default golangci-lint linters, deliberately different in kind: `unused`
# needs the whole package to conclude anything, `errcheck` is local. A fixture
# that only tripped a local one would pass against a golangci-lint that had
# lost its package view.
UNUSED_AND_UNCHECKED = """package main

import "os"

func unusedHelper() int {
\treturn 1
}

func main() {
\tos.Setenv("A", "B")
\tprintln("hi")
}
"""

GO_MOD = "module {name}\n\ngo 1.21\n"


def write(root, files):
    for name, text in files.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)
    return root


def fixture(prefix, files):
    # realpath, because macOS makes /tmp a symlink to /private/tmp and a tool
    # that resolves its own workspace root will not recognise paths under the
    # link. Cost a wrong finding once already, in a different probe.
    return write(os.path.realpath(tempfile.mkdtemp(prefix=prefix)), files)


def poly(*args, cwd=None):
    # check=False: a non-zero exit is the answer here, not a crash. `poly
    # check` returning 1 is the finding this file is looking for.
    done = subprocess.run(
        [BIN, *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    return done.returncode, done.stdout + done.stderr


def gofumpt_not_gofmt():
    """poly formats Go, and with gofumpt rather than whatever gofmt would do."""
    root = fixture(
        "poly-go-fmt-",
        {
            "go.mod": GO_MOD.format(name="example.com/fmtcase"),
            "main.go": BLANK_LINE_AFTER_BRACE,
        },
    )
    # The fixture's whole point, asserted rather than assumed: if gofmt ever
    # starts rewriting this, the check below stops telling the two apart and
    # this says so instead of passing.
    listed = subprocess.run(
        ["gofmt", "-l", "."], cwd=root, capture_output=True, text=True, check=True
    )
    assert not listed.stdout.strip(), (
        f"gofmt now rewrites this fixture, so it no longer proves gofumpt ran: "
        f"{listed.stdout!r}"
    )

    code, output = poly("fmt", "--check", ".", cwd=root)
    assert code == 1, f"--check passed on an unformatted file (exit {code}): {output}"
    assert "main.go" in output, output
    print(f"  --check names the file gofmt would have called clean: exit {code}")

    code, output = poly("fmt", ".", cwd=root)
    assert code == 0, f"fmt failed: {output}"
    with open(os.path.join(root, "main.go")) as formatted:
        text = formatted.read()
    assert "{\n\n" not in text, f"the blank line survived: {text!r}"
    print("  fmt removed it, which is gofumpt's rule and not gofmt's")

    code, output = poly("fmt", "--check", ".", cwd=root)
    assert code == 0, f"--check still fails after fmt: {output}"
    print("  --check is clean afterwards, so editor and CI agree on the result")
    shutil.rmtree(root, ignore_errors=True)


def golangci_reaches_check():
    """`poly check` runs golangci-lint, and reports it as golangci-lint."""
    root = fixture(
        "poly-go-lint-",
        {
            "go.mod": GO_MOD.format(name="example.com/lintcase"),
            "main.go": UNUSED_AND_UNCHECKED,
        },
    )
    code, output = poly("check", ".", cwd=root)
    assert code == 1, (
        f"check passed on a file with two findings (exit {code}): {output}"
    )
    for expected in ("golangci-lint/unused", "golangci-lint/errcheck"):
        assert expected in output, f"{expected} missing from:\n{output}"
    # The rule code is a link in the editor and a line in the terminal, and both
    # come from this url. A finding nobody can look up is a finding nobody acts on.
    assert "golangci-lint.run/docs/linters/configuration/#unused" in output, output
    print("  check reports unused and errcheck, each with its own linter docs")
    shutil.rmtree(root, ignore_errors=True)


def golangci_groups_by_module():
    """One run covers every module under the walk root, not just the first.

    golangci-lint is invoked per module -- poly reduces the .go files it found
    to their go.mod roots and runs once per root. Two modules in one tree is the
    smallest thing that tells a correct grouping from a run that quietly stopped
    after one, and it is the layout the go.work work is all about.
    """
    root = fixture(
        "poly-go-modules-",
        {
            "liba/go.mod": GO_MOD.format(name="example.com/liba"),
            "liba/lib.go": UNUSED_AND_UNCHECKED.replace(
                "package main", "package liba"
            ).replace("func main()", "func Run()"),
            "appb/go.mod": GO_MOD.format(name="example.com/appb"),
            "appb/main.go": UNUSED_AND_UNCHECKED,
        },
    )
    code, output = poly("check", ".", cwd=root)
    assert code == 1, f"check passed on two modules of findings: {output}"
    for module in ("liba", "appb"):
        assert f"{module}/" in output, f"nothing reported for {module}:\n{output}"
    print("  both modules reported from one run, so the grouping covers the walk")
    shutil.rmtree(root, ignore_errors=True)


def editor_sources(root, name, text, seconds=25):
    """The `source` of every diagnostic poly publishes for one open Go file."""
    proc = subprocess.Popen(
        [BIN, "lsp"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    inbox = queue.Queue()

    def reader():
        while True:
            length = 0
            while True:
                line = proc.stdout.readline()
                if not line:
                    inbox.put(None)
                    return
                if line in (b"\r\n", b"\n"):
                    break
                if line.lower().startswith(b"content-length"):
                    length = int(line.split(b":")[1])
            inbox.put(json.loads(proc.stdout.read(length)))

    threading.Thread(target=reader, daemon=True).start()

    def send(message):
        data = json.dumps(message).encode()
        proc.stdin.write(b"Content-Length: %d\r\n\r\n" % len(data) + data)
        proc.stdin.flush()

    uri = f"file://{root}/{name}"
    send(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": None,
                "rootUri": f"file://{root}",
                "workspaceFolders": [{"uri": f"file://{root}", "name": "go"}],
                "initializationOptions": {"languageServers": True},
                "capabilities": {
                    "workspace": {"configuration": True},
                    "textDocument": {"publishDiagnostics": {}},
                },
            },
        }
    )
    send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
    send(
        {
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": uri,
                    "languageId": "go",
                    "version": 1,
                    "text": text,
                }
            },
        }
    )
    send(
        {
            "jsonrpc": "2.0",
            "method": "textDocument/didSave",
            "params": {"textDocument": {"uri": uri}, "text": text},
        }
    )

    # Collected with a real deadline rather than a blocking read: a server with
    # nothing to say would otherwise hang past every timeout in this file.
    sources, end = set(), time.time() + seconds
    while time.time() < end:
        try:
            message = inbox.get(timeout=max(0.1, end - time.time()))
        except queue.Empty:
            break
        if message is None:
            break
        if "method" in message and "id" in message:
            answer = [None] if message["method"] == "workspace/configuration" else None
            send({"jsonrpc": "2.0", "id": message["id"], "result": answer})
        if message.get("method") == "textDocument/publishDiagnostics":
            for diagnostic in message["params"]["diagnostics"]:
                sources.add(diagnostic.get("source", "?"))
    proc.kill()
    return sources


# What `poly check` finds for a Go file and the editor does not, measured
# 2026-09-04 and written down rather than discovered per run.
#
# A4 says the editor and CI must never give different answers, and for Go they
# do. `external_lint` only drives tools that lint one file from stdin --
# shellcheck, ruff, selene and the rest -- and golangci-lint is neither of
# those things: it works per module and needs the whole package. So it runs in
# `poly check` and has never run in the editor, and closing that needs
# package-scoped lint on save, which is a feature and not a fix.
#
# Recorded as an exact set, the same way the proxy probe records a server that
# lies about its capabilities. It fails when the gap widens, and it fails when
# the gap closes -- the second is the point. A gap nobody is failing over is a
# gap that stops being read.
EDITOR_NEVER_SEES = {"golangci-lint"}


def editor_and_cli_agree():
    """The same file, asked twice: does Problems say what `poly check` says?

    Not "does the editor say nothing" -- gopls has analyzers of its own and
    catches some of this under its own names, which is exactly why the
    comparison has to be by source rather than by count.
    """
    root = fixture(
        "poly-go-a4-",
        {
            "go.mod": GO_MOD.format(name="example.com/a4case"),
            "main.go": UNUSED_AND_UNCHECKED,
        },
    )
    _, output = poly("check", ".", cwd=root)
    from_check = {
        line.split("[", 1)[1].split("/", 1)[0]
        for line in output.splitlines()
        if "] " in line and "[" in line
    }
    in_editor = editor_sources(root, "main.go", UNUSED_AND_UNCHECKED)
    shutil.rmtree(root, ignore_errors=True)
    print(f"  poly check reports: {sorted(from_check)}")
    print(f"  the editor publishes: {sorted(in_editor)}")
    assert from_check, f"no findings from check at all; the fixture is stale:\n{output}"
    assert in_editor, "the editor published nothing; gopls never answered"

    missing = from_check - in_editor
    assert missing == EDITOR_NEVER_SEES, (
        f"the editor/CI gap for Go changed: expected {sorted(EDITOR_NEVER_SEES)} "
        f"to be CI-only, measured {sorted(missing)}.\n"
        "If it shrank, package-scoped lint on save landed — shrink "
        "EDITOR_NEVER_SEES to match. If it grew, something that used to reach "
        "Problems no longer does, and that is a regression."
    )
    print(f"  known A4 gap, unchanged: {sorted(missing)} is CI-only")


if not shutil.which("go"):
    print("GO ACCEPTANCE SKIPPED: no go toolchain on PATH")
    raise SystemExit(0)

print(f"go acceptance against {BIN}")
print("gofumpt:")
gofumpt_not_gofmt()
print("golangci-lint:")
golangci_reaches_check()
golangci_groups_by_module()
print("editor and CI, same file:")
editor_and_cli_agree()
print("GO ACCEPTANCE PASS")

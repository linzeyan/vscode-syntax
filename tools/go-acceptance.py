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


def editor_diagnostics(root, name, text, seconds=25):
    """Open one Go file and watch what poly publishes about it.

    Two answers, because two different questions are asked of this session.
    `union` is everything that reached Problems at any point, which is what the
    editor/CI comparison wants. `final` is the last publish for the file, which
    is the only thing the user actually ends up looking at -- `publishDiagnostics`
    replaces the whole set, so a source present in the union and absent from the
    final publish is one that something else erased.
    """
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
    union, final, end = set(), set(), time.time() + seconds
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
            params = message["params"]
            published = {d.get("source", "?") for d in params["diagnostics"]}
            union |= published
            if params["uri"] == uri:
                final = published
    proc.kill()
    return union, final


# What `poly check` finds for a Go file and the editor does not.
#
# Empty since 2026-09-04, when package-scoped lint on save landed and
# golangci-lint started reaching Problems. It was the last entry: `external_lint`
# drives tools that lint one buffer from stdin, and golangci-lint is neither --
# it works per module and needs the whole package -- so for as long as the
# daemon had only that path, Go was the one language where CI could go red over
# something the editor never mentioned.
#
# Kept as an exact set rather than deleted, the same way the proxy probe records
# a server that lies about its capabilities. It fails when the gap widens and it
# fails when it narrows, and an empty set is a claim worth defending: A4 says the
# editor and CI must never give different answers, and this is the one gate that
# measures it for Go.
EDITOR_NEVER_SEES = set()


def editor_and_cli_agree():
    """The same file, asked twice: does Problems say what `poly check` says?

    Not "does the editor say nothing" -- gopls has analyzers of its own and
    catches some of this under its own names, which is exactly why the
    comparison has to be by source rather than by count.

    The second half is the interference question. Three publishers speak about
    this one file on three unrelated clocks: the per-file linters on save, gopls
    whenever it finishes thinking, and golangci-lint whenever the module
    finishes compiling. `publishDiagnostics` replaces the whole set for a uri, so
    any of them sending only its own half would erase the other two -- and it
    would erase them intermittently, which is the kind of bug that survives a
    gate that only looks at the union.
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
    in_editor, still_there = editor_diagnostics(root, "main.go", UNUSED_AND_UNCHECKED)
    shutil.rmtree(root, ignore_errors=True)
    print(f"  poly check reports: {sorted(from_check)}")
    print(f"  the editor publishes: {sorted(in_editor)}")
    assert from_check, f"no findings from check at all; the fixture is stale:\n{output}"
    assert in_editor, "the editor published nothing; gopls never answered"

    missing = from_check - in_editor
    assert missing == EDITOR_NEVER_SEES, (
        f"the editor/CI gap for Go changed: expected {sorted(EDITOR_NEVER_SEES)} "
        f"to be CI-only, measured {sorted(missing)}.\n"
        "If it grew, something that used to reach Problems no longer does. If it "
        "shrank, a tool poly could not run in the editor now runs there — shrink "
        "EDITOR_NEVER_SEES to match."
    )
    print(f"  editor/CI gap: {sorted(missing) or 'none'}")

    print(f"  last publish for main.go: {sorted(still_there)}")
    assert "golangci-lint" in still_there, (
        f"golangci-lint reached Problems and was then erased: the final publish "
        f"for main.go was {sorted(still_there)}. Something republished without "
        "merging the package findings back in."
    )
    assert still_there - {"golangci-lint"}, (
        f"only golangci-lint survived: the final publish for main.go was "
        f"{sorted(still_there)}, so package lint erased what gopls and the "
        "per-file linters had already put there."
    )
    print("  every publisher's findings are in it, so none of them erases another")


LIBA = """package liba

// Called from appb, which is a different module entirely.
func Used() string { return "used" }

// Exported, and nothing anywhere calls it.
func Orphan() string { return "dead" }
"""

APPB_MAIN = """package main

import (
\t"fmt"

\t"example.com/liba"
)

func main() { fmt.Println(liba.Used()) }
"""

GO_WORK = "go 1.21\n\nuse (\n\t./liba\n\t./appb\n)\n"


def deadcode_crosses_modules():
    """`poly deadcode`, and the go.work that decides what "reachable" means.

    This is the whole cross-module story in one measurement. golangci-lint's
    `unused` cannot answer it -- an exported function is never unused to it,
    because someone outside the package might call it -- so the question "does
    anything actually run this" needs the call graph, and the call graph needs
    every module in one build list.

    The control is the point: the same two modules with the go.work deleted
    still build -- `replace` sees to that -- but the sibling module is no longer
    in the build list, so its dead function cannot be found at all. Without that
    half, finding `Orphan` above would prove the analysis ran, not that it
    crossed a module boundary.
    """
    root = fixture(
        "poly-go-deadcode-",
        {
            "liba/go.mod": GO_MOD.format(name="example.com/liba"),
            "liba/lib.go": LIBA,
            # `replace` so the control below still compiles: what changes when
            # go.work goes away has to be the build list, not the build.
            "appb/go.mod": GO_MOD.format(name="example.com/appb")
            + "\nrequire example.com/liba v0.0.0\n"
            + "\nreplace example.com/liba => ../liba\n",
            "appb/main.go": APPB_MAIN,
            "go.work": GO_WORK,
        },
    )
    # Asked from inside one module: finding the other module's dead function
    # means the analysis walked up to the workspace on its own.
    _, joined = poly("deadcode", os.path.join(root, "appb"))
    print(f"  with go.work: {[line for line in joined.splitlines() if 'func' in line]}")
    assert "Orphan" in joined, (
        f"the unreachable function in the sibling module was not found:\n{joined}"
    )
    assert "Used" not in joined, (
        "a function called from the other module was reported as dead, so the "
        f"modules were analysed apart:\n{joined}"
    )

    os.remove(os.path.join(root, "go.work"))
    _, alone = poly("deadcode", os.path.join(root, "appb"))
    shutil.rmtree(root, ignore_errors=True)
    assert "Orphan" not in alone, (
        "without go.work the sibling module is not in the build list, so its "
        "dead function is not something this run could have found; it found it "
        f"anyway, which means go.work is not what put it there:\n{alone}"
    )
    print("  without go.work: the sibling module is not in the build list")


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
# Its own toolchain check: deadcode comes from golang.org/x/tools rather than
# with go itself, so a runner with a Go toolchain may still not have it. Loud,
# because a silent skip here is a whole feature nobody measured.
if shutil.which("deadcode"):
    print("dead code across modules:")
    deadcode_crosses_modules()
else:
    print("SKIPPED deadcode: go install golang.org/x/tools/cmd/deadcode@latest")
print("GO ACCEPTANCE PASS")

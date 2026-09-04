#!/usr/bin/env python3
"""End-to-end acceptance for poly's Terraform lint.

tflint is the second tool poly drives that cannot read a single buffer: it
takes a directory and reads it as one Terraform module. Until package-scoped
lint learned about it, Terraform was — after Go — the remaining language where
`poly check` could go red over something the editor never mentioned (A4).

Two things here are only observable end to end, and one of them was already
wrong when this file was written. tflint reports filenames relative to the
directory it was *started* in, so pointing it at a directory with `--chdir`
produced paths relative to wherever the editor happened to launch poly — fine
for the CLI, which resolves them against its own cwd on the way to printing
them, and useless for a daemon that has to turn each one into a document uri.
The other is scope nesting: tflint does not descend, so a repository with
modules in subdirectories is several runs, and they must not clear each other's
findings.

The transport below is deliberately its own copy rather than shared with
go-acceptance.py or the proxy probe: each of those asks the daemon a different
question and collects a different shape, and the framing is twenty lines.

Usage: tools/tf-acceptance.py [path-to-poly-binary]
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

# Three default rules from tflint's bundled Terraform ruleset, which needs
# neither `tflint --init` nor `terraform init` — the same thing `poly check`
# gets, because it is the same call.
UNUSED_VARIABLE = """variable "unused" {
  type = string
}

resource "aws_instance" "web" {
  instance_type = "t2.micro"
  ami           = "ami-123"
}
"""

# A second module in a subdirectory, which is how Terraform repositories are
# normally laid out. tflint reads one directory and does not descend, so this
# is a separate run — and the reason the daemon keys findings by the run that
# produced them rather than by a path prefix.
NESTED_MODULE = """variable "also_unused" {
  type = string
}
"""


def fixture(prefix, files):
    # realpath, because macOS makes /tmp a symlink to /private/tmp: the editor
    # sends the resolved path and a diagnostic published against the other one
    # attaches to a document nobody has open.
    root = os.path.realpath(tempfile.mkdtemp(prefix=prefix))
    for name, text in files.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)
    return root


def poly(*args, cwd=None):
    # check=False: `poly check` returning 1 is the finding, not a crash.
    done = subprocess.run(
        [BIN, *args], cwd=cwd, capture_output=True, text=True, check=False
    )
    return done.stdout + done.stderr


def published(root, opens, seconds=25):
    """Open and save each file in turn; report what Problems ends up holding.

    The answer is per uri and it is the *last* publish for each, not the union:
    `publishDiagnostics` replaces the whole set, so a finding that arrives and
    is then erased by another publisher looks identical to one that arrived, in
    a union. Erasure is half of what this file measures.

    One file at a time, waiting for each to have findings before saving the
    next. Sending them all at once measures nothing: the worker collapses
    everything queued during a run into one batch and sorts it by path, so the
    parent directory would run *first* and the nested run would put its own
    findings back afterwards — an erasure bug would pass.
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

    send(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": None,
                "rootUri": f"file://{root}",
                "workspaceFolders": [{"uri": f"file://{root}", "name": "tf"}],
                # Off: terraform-ls has nothing to say about a module that was
                # never `terraform init`ed, and starting it only adds a second
                # publisher to wait out.
                "initializationOptions": {"languageServers": False},
                "capabilities": {
                    "workspace": {"configuration": True},
                    "textDocument": {"publishDiagnostics": {}},
                },
            },
        }
    )
    send({"jsonrpc": "2.0", "method": "initialized", "params": {}})

    final = {}

    def collect(until, want=None):
        """Record publishes until `want` has findings, or the deadline passes.

        A real deadline rather than a blocking read: a daemon with nothing left
        to say would otherwise hang here, and "nothing left to say" is a legal
        outcome this file has to be able to fail on.
        """
        while time.time() < until:
            try:
                message = inbox.get(timeout=max(0.05, until - time.time()))
            except queue.Empty:
                return
            if message is None:
                return
            if "method" in message and "id" in message:
                send({"jsonrpc": "2.0", "id": message["id"], "result": None})
            if message.get("method") != "textDocument/publishDiagnostics":
                continue
            params = message["params"]
            final[params["uri"]] = {d.get("source", "?") for d in params["diagnostics"]}
            # The first publish for a document is the per-file linters saying
            # nothing; the directory run is seconds behind it.
            if want is not None and final.get(want):
                return

    for name in opens:
        uri = f"file://{root}/{name}"
        with open(os.path.join(root, name)) as f:
            text = f.read()
        send(
            {
                "jsonrpc": "2.0",
                "method": "textDocument/didOpen",
                "params": {
                    "textDocument": {
                        "uri": uri,
                        "languageId": "terraform",
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
        collect(time.time() + seconds, want=uri)

    # Whatever arrives after the last save is the part that erases, and that is
    # the part this file is looking for.
    collect(time.time() + 5)
    proc.kill()
    return final


def editor_and_cli_agree():
    """The same file, asked twice: does Problems say what `poly check` says?"""
    root = fixture("poly-tf-a4-", {"main.tf": UNUSED_VARIABLE})
    output = poly("check", ".", cwd=root)
    from_check = {
        line.split("[", 1)[1].split("/", 1)[0]
        for line in output.splitlines()
        if "] " in line and "[" in line
    }
    final = published(root, ["main.tf"])
    in_editor = final.get(f"file://{root}/main.tf", set())
    shutil.rmtree(root, ignore_errors=True)

    print(f"  poly check reports: {sorted(from_check)}")
    print(f"  the editor publishes: {sorted(in_editor)}")
    assert "tflint" in from_check, (
        f"no tflint findings from check at all; the fixture is stale:\n{output}"
    )
    assert from_check == in_editor, (
        f"the editor and CI disagree about main.tf: check said "
        f"{sorted(from_check)}, Problems ended up with {sorted(in_editor)}. "
        "A4 says these are the same answer."
    )


def a_nested_module_keeps_its_findings():
    """Saving the parent directory does not clear the module below it.

    tflint reads one directory, so `modules/db` is a run of its own and the run
    over the root will never repeat what it found. Whether the nested findings
    survive is decided by what "the last run's findings" means: keyed by the run
    they stand, keyed by a path prefix the root's run owns everything under it
    and clears the lot every time a file at the top is saved.
    """
    root = fixture(
        "poly-tf-nested-",
        {"main.tf": UNUSED_VARIABLE, "modules/db/main.tf": NESTED_MODULE},
    )
    # Deepest first, so the second save is the one that could erase the first.
    final = published(root, ["modules/db/main.tf", "main.tf"])
    shutil.rmtree(root, ignore_errors=True)

    nested = final.get(f"file://{root}/modules/db/main.tf", set())
    parent = final.get(f"file://{root}/main.tf", set())
    print(f"  modules/db/main.tf: {sorted(nested)}")
    print(f"  main.tf: {sorted(parent)}")
    assert parent, "the root directory's own run published nothing"
    assert nested, (
        "the nested module's findings are gone: the run over the root cleared "
        "them and is never going to produce them again, because tflint does "
        "not descend into modules/db"
    )


print(f"terraform acceptance against {BIN}")
print("editor and CI, same file:")
editor_and_cli_agree()
print("two directories, two runs:")
a_nested_module_keeps_its_findings()
print("TERRAFORM ACCEPTANCE PASS")

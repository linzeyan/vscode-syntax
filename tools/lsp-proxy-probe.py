#!/usr/bin/env python3
"""End-to-end probe for `poly lsp`'s language server proxy.

Drives poly over stdio against a real Go module and checks that a request poly
does not implement -- go-to-definition -- is answered by gopls through it.

Usage: tools/lsp-proxy-probe.py [path-to-poly-binary]
Skips loudly (exit 0) when gopls is not installed; fails otherwise.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

BIN = sys.argv[1] if len(sys.argv) > 1 else "cli/target/release/poly"

if not shutil.which("gopls"):
    print("PROXY PROBE SKIPPED: gopls is not on PATH")
    sys.exit(0)

MODULE = """module probe

go 1.21
"""

# Greet is defined on line 3 (0-based) and called on line 8; the probe asks
# about the call and expects to be sent to the definition.
# The unused local is deliberate: it makes gopls publish a diagnostic, which is
# what lets the probe prove poly does not overwrite them with its own empty set.
MAIN = """package main

func Greet(name string) string {
\treturn "hello " + name
}

func main() {
\tprintln(Greet("world"))
\tunused := 1
}
"""
DEFINITION_LINE = 2
CALL_LINE = 7
CALL_CHARACTER = 10  # inside `Greet` on the call line

root = tempfile.mkdtemp(prefix="poly-proxy-")
with open(os.path.join(root, "go.mod"), "w") as f:
    f.write(MODULE)
main_go = os.path.join(root, "main.go")
with open(main_go, "w") as f:
    f.write(MAIN)
uri = "file://" + main_go

proc = subprocess.Popen([BIN, "lsp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)


def send(msg):
    data = json.dumps(msg).encode()
    proc.stdin.write(b"Content-Length: %d\r\n\r\n" % len(data) + data)
    proc.stdin.flush()


def recv():
    headers = {}
    while True:
        line = proc.stdout.readline()
        if not line:
            raise EOFError("poly closed stdout")
        if line in (b"\r\n", b"\n"):
            break
        key, value = line.decode().split(":", 1)
        headers[key.strip().lower()] = value.strip()
    return json.loads(proc.stdout.read(int(headers["content-length"])))


# Everything poly has said, in order. Kept because notifications arrive
# whenever gopls feels like it -- a probe that only looked at what came in
# during one wait would miss the diagnostics that landed during the previous.
INBOX = []


def pump(want_id=None, want_method=None, limit=400):
    """Read until the wanted response or notification, answering server requests.

    poly and gopls both ask the editor things mid-flight (registerCapability,
    workspace/configuration, progress); a probe that ignored them would hang
    waiting for a server that is itself waiting for a reply.
    """
    start = len(INBOX)
    for _ in range(limit):
        msg = recv()
        INBOX.append(msg)
        if want_id is not None and msg.get("id") == want_id and "method" not in msg:
            return msg, INBOX[start:]
        if want_method is not None and msg.get("method") == want_method:
            return msg, INBOX[start:]
        if "method" in msg and "id" in msg:
            # A request from the server side. Answer everything the same way:
            # null is a legal answer to registerCapability and to a
            # configuration request for settings the editor does not have.
            result = [None] if msg["method"] == "workspace/configuration" else None
            send({"jsonrpc": "2.0", "id": msg["id"], "result": result})
    raise AssertionError(f"gave up waiting; last messages: {INBOX[-5:]}")


def diagnostics_for(target, since=0):
    """Every publishDiagnostics poly has sent for `target`, in order."""
    return [
        m["params"]["diagnostics"]
        for m in INBOX[since:]
        if m.get("method") == "textDocument/publishDiagnostics"
        and m["params"]["uri"] == target
    ]


send(
    {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "processId": None,
            "rootUri": "file://" + root,
            "workspaceFolders": [{"uri": "file://" + root, "name": "probe"}],
            "initializationOptions": {"languageServers": True},
            "capabilities": {
                "textDocument": {
                    "definition": {"linkSupport": False},
                    "hover": {"contentFormat": ["markdown", "plaintext"]},
                    "synchronization": {"dynamicRegistration": True},
                },
                "workspace": {"configuration": True, "didChangeConfiguration": {}},
            },
        },
    }
)
init, _ = pump(want_id=1)
assert init["result"]["capabilities"]["documentFormattingProvider"], init
send({"jsonrpc": "2.0", "method": "initialized", "params": {}})

# Opening the file is what starts gopls: poly spawns nothing until a document
# in a proxied language shows up.
send(
    {
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri": uri,
                "languageId": "go",
                "version": 1,
                "text": MAIN,
            }
        },
    }
)

# poly declared none of these at initialize, so the editor only learns about
# them when gopls is up and poly registers them scoped to Go.
registration, _ = pump(want_method="client/registerCapability")
methods = {r["method"]: r for r in registration["params"]["registrations"]}
assert "textDocument/definition" in methods, methods
selector = methods["textDocument/definition"]["registerOptions"]["documentSelector"]
assert selector[0]["language"] == "go", selector
send({"jsonrpc": "2.0", "id": registration["id"], "result": None})
print(f"registered for go: {sorted(methods)}")

# The actual point: poly implements no definition provider, so a location here
# can only have come from gopls.
send(
    {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "textDocument/definition",
        "params": {
            "textDocument": {"uri": uri},
            "position": {"line": CALL_LINE, "character": CALL_CHARACTER},
        },
    }
)
response, _ = pump(want_id=2)
locations = response.get("result")
assert locations, f"no definition came back: {response}"
if isinstance(locations, dict):
    locations = [locations]
found = locations[0]
assert found["uri"].endswith("main.go"), found
assert found["range"]["start"]["line"] == DEFINITION_LINE, found
print(f"definition resolved to line {found['range']['start']['line'] + 1}")

# Hover on the same position must come from gopls too, not from poly's own
# sqruff-only hover -- the two share a method and must not shadow each other.
send(
    {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "textDocument/hover",
        "params": {
            "textDocument": {"uri": uri},
            "position": {"line": CALL_LINE, "character": CALL_CHARACTER},
        },
    }
)
response, _ = pump(want_id=3)
hover = response.get("result")
assert hover, f"no hover came back: {response}"
value = (
    hover["contents"]["value"]
    if isinstance(hover["contents"], dict)
    else str(hover["contents"])
)
assert "Greet" in value, value
print(f"hover: {value.splitlines()[0][:60]}")

# gopls owns diagnostics for Go. publishDiagnostics replaces the whole set for
# a uri, so poly publishing its own (empty) list for a proxied language would
# erase them -- on every save, until gopls happened to republish.
while not any(diagnostics_for(uri)):
    pump(want_method="textDocument/publishDiagnostics")
reported = next(d for d in diagnostics_for(uri) if d)
print(f"gopls diagnostics: {reported[0]['message']}")

# Edit, then save. The edit matters: poly skips linting a document whose
# content hash has not moved, so a save with no change would exercise nothing.
# The unused local stays, so gopls has the same thing to say afterwards and an
# empty set for this uri can only have come from poly.
saved_at = len(INBOX)
send(
    {
        "jsonrpc": "2.0",
        "method": "textDocument/didChange",
        "params": {
            "textDocument": {"uri": uri, "version": 2},
            "contentChanges": [{"text": MAIN.replace("world", "there")}],
        },
    }
)
send(
    {
        "jsonrpc": "2.0",
        "method": "textDocument/didSave",
        "params": {"textDocument": {"uri": uri}},
    }
)
send(
    {
        "jsonrpc": "2.0",
        "id": 4,
        "method": "textDocument/hover",
        "params": {
            "textDocument": {"uri": uri},
            "position": {"line": CALL_LINE, "character": CALL_CHARACTER},
        },
    }
)
pump(want_id=4)
wiped = [d for d in diagnostics_for(uri, saved_at) if not d]
assert not wiped, "poly cleared gopls's diagnostics on save"

send({"jsonrpc": "2.0", "id": 9, "method": "shutdown", "params": None})
pump(want_id=9)
send({"jsonrpc": "2.0", "method": "exit", "params": None})
try:
    proc.wait(timeout=15)
except subprocess.TimeoutExpired:
    proc.kill()
    raise AssertionError("poly did not exit")

# gopls has to go down with poly: the editor closing is not a reason to leave a
# server behind holding a module's worth of memory.
leftover = subprocess.run(
    ["pgrep", "-f", f"gopls.*{os.path.basename(root)}"],
    capture_output=True,
    text=True,
    # pgrep exits 1 when it matches nothing, which is the answer this wants.
    check=False,
)
assert not leftover.stdout.strip(), f"gopls survived poly: {leftover.stdout}"

shutil.rmtree(root, ignore_errors=True)
print(
    "PROXY PROBE PASS: gopls started lazily, registered for go, answered definition and hover"
)

#!/usr/bin/env python3
"""LSP smoke test: drives `poly lsp` over stdio without an editor.

Usage: tools/lsp-smoke.py [path-to-poly-binary]
Exits non-zero on any failed expectation.
"""

import json
import os
import subprocess
import sys
import tempfile

BIN = sys.argv[1] if len(sys.argv) > 1 else "cli/target/release/poly"

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
            raise EOFError("server closed stdout")
        if line in (b"\r\n", b"\n"):
            break
        key, value = line.decode().split(":", 1)
        headers[key.strip().lower()] = value.strip()
    return json.loads(proc.stdout.read(int(headers["content-length"])))


NOTIFICATIONS = []


def recv_response(request_id):
    # Servers may interleave notifications; wait for the matching response.
    while True:
        msg = recv()
        if msg.get("id") == request_id:
            return msg
        if "method" in msg:
            NOTIFICATIONS.append(msg)


def wait_diagnostics(uri):
    for msg in NOTIFICATIONS:
        if (
            msg["method"] == "textDocument/publishDiagnostics"
            and msg["params"]["uri"] == uri
        ):
            return msg
    while True:
        msg = recv()
        if (
            msg.get("method") == "textDocument/publishDiagnostics"
            and msg["params"]["uri"] == uri
        ):
            return msg


URI = "file:///tmp/smoke.ts"
SQL_URI = "file:///tmp/smoke.sql"

send(
    {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"processId": None, "rootUri": None, "capabilities": {}},
    }
)
init = recv_response(1)
caps = init["result"]["capabilities"]
assert caps.get("documentFormattingProvider"), f"no formatting capability: {caps}"
assert caps.get("documentRangeFormattingProvider"), f"no Format Selection: {caps}"
assert caps.get("hoverProvider"), f"no hover capability: {caps}"
send({"jsonrpc": "2.0", "method": "initialized", "params": {}})

send(
    {
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri": URI,
                "languageId": "typescript",
                "version": 1,
                "text": "const  x = {a:1,\n\n\n b:2};",
            }
        },
    }
)

send(
    {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "textDocument/formatting",
        "params": {
            "textDocument": {"uri": URI},
            "options": {"tabSize": 2, "insertSpaces": True},
        },
    }
)
resp = recv_response(2)
edits = resp.get("result")
assert edits, f"expected edits, got: {resp}"
assert "const x = { a: 1, b: 2 };" in edits[0]["newText"], edits
assert edits[0]["range"]["start"] == {"line": 0, "character": 0}

# Lint-on-open: a messy SQL doc must produce sqruff diagnostics.
send(
    {
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri": SQL_URI,
                "languageId": "sql",
                "version": 1,
                "text": "select a,b from t\n",
            }
        },
    }
)
diag = wait_diagnostics(SQL_URI)
assert diag["params"]["diagnostics"], f"expected sqruff diagnostics: {diag}"
assert diag["params"]["diagnostics"][0]["source"] == "sqruff", diag

# Hover over that finding: sqruff publishes no rule pages, so the diagnostic
# carries no docs link and this prose -- compiled into the binary -- is the only
# route to "why is this a rule".
flagged = diag["params"]["diagnostics"][0]
send(
    {
        "jsonrpc": "2.0",
        "id": 4,
        "method": "textDocument/hover",
        "params": {
            "textDocument": {"uri": SQL_URI},
            "position": flagged["range"]["start"],
        },
    }
)
hover = recv_response(4).get("result")
assert hover, f"expected a hover on {flagged['code']}"
assert hover["contents"]["kind"] == "markdown", hover
assert hover["contents"]["value"].startswith(f"**sqruff/{flagged['code']}**"), hover
assert "Best practice" in hover["contents"]["value"], hover
assert hover["range"] == flagged["range"], hover

# Off the finding poly has nothing to say, and must say so rather than shadow
# whatever else the editor would have shown there.
send(
    {
        "jsonrpc": "2.0",
        "id": 5,
        "method": "textDocument/hover",
        "params": {
            "textDocument": {"uri": SQL_URI},
            "position": {"line": 50, "character": 0},
        },
    }
)
assert recv_response(5).get("result") is None, "hover away from any finding"

# Batch formatting via executeCommand, shared code path with the CLI.
batch_dir = tempfile.mkdtemp(prefix="poly-smoke-")
batch_file = os.path.join(batch_dir, "batch.json")
with open(batch_file, "w") as f:
    f.write('{"b":1,  "a":2}')
send(
    {
        "jsonrpc": "2.0",
        "id": 10,
        "method": "workspace/executeCommand",
        "params": {
            "command": "poly.formatPaths",
            "arguments": [{"mode": "paths", "paths": [batch_dir]}],
        },
    }
)
resp = recv_response(10)
summary = resp.get("result")
assert summary and summary["changed"], f"expected batch change: {resp}"
with open(batch_file) as f:
    assert f.read() == '{ "b": 1, "a": 2 }\n', "batch format did not rewrite file"

# Minify via executeCommand: the editor command that replaces a JSON Tools
# install. Edits rather than a file write, because the buffer it acts on may
# never have been saved -- so this asserts on what comes back, not on disk.
MINIFY_URI = "file:///tmp/smoke-minify.json"
send(
    {
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri": MINIFY_URI,
                "languageId": "json",
                "version": 1,
                # Key order and the spaces inside the string are the two things
                # a round-trip through a JSON map type would quietly destroy.
                "text": '{\n  "b": 1,\n  "a": "two  spaces"\n}\n',
            }
        },
    }
)
send(
    {
        "jsonrpc": "2.0",
        "id": 11,
        "method": "workspace/executeCommand",
        "params": {
            "command": "poly.minifyJsonEdits",
            "arguments": [{"uri": MINIFY_URI}],
        },
    }
)
resp = recv_response(11)
edits = resp.get("result")
assert edits, f"expected minify edits: {resp}"
assert edits[0]["newText"] == '{"b":1,"a":"two  spaces"}', edits[0]["newText"]

# Format Selection. Two things have to be true at once and only a round trip
# shows both: the selected line comes back formatted, and the identical problem
# on another line does not. A unit test can check the narrowing logic, but not
# that the request reaches it -- rangeFormatting is a separate LSP method, and
# an unhandled one is declined rather than answered.
RANGE_URI = "file:///tmp/smoke-range.json"
send(
    {
        "jsonrpc": "2.0",
        "method": "textDocument/didOpen",
        "params": {
            "textDocument": {
                "uri": RANGE_URI,
                "languageId": "json",
                "version": 1,
                "text": '{\n  "a":  1,\n  "b": 2,\n  "c":  3\n}\n',
            }
        },
    }
)
send(
    {
        "jsonrpc": "2.0",
        "id": 12,
        "method": "textDocument/rangeFormatting",
        "params": {
            "textDocument": {"uri": RANGE_URI},
            "range": {
                "start": {"line": 3, "character": 0},
                "end": {"line": 3, "character": 11},
            },
            "options": {"tabSize": 2, "insertSpaces": True},
        },
    }
)
resp = recv_response(12)
edits = resp.get("result")
assert edits, f"expected range edits: {resp}"
assert len(edits) == 1, f"only the selected line: {edits}"
assert edits[0]["newText"] == '  "c": 3\n', edits[0]["newText"]
assert edits[0]["range"]["start"] == {"line": 3, "character": 0}, edits[0]["range"]

# Same document, no range: the whole file in one edit. Without this the
# assertion above passes just as well for a server that formats nothing.
send(
    {
        "jsonrpc": "2.0",
        "id": 13,
        "method": "textDocument/formatting",
        "params": {
            "textDocument": {"uri": RANGE_URI},
            "options": {"tabSize": 2, "insertSpaces": True},
        },
    }
)
whole = recv_response(13).get("result")
assert whole and len(whole) == 1, f"expected one whole-file edit: {whole}"
assert '"a": 1' in whole[0]["newText"], whole[0]["newText"]

# Every request gets an answer, including the ones poly does not implement.
# Silence is not a polite decline: the editor keeps waiting on that id, so the
# feature looks hung rather than absent. Caught for real by a probe that hung
# for ten minutes instead of failing.
send({"jsonrpc": "2.0", "id": 90, "method": "textDocument/rename", "params": {}})
declined = recv_response(90)
assert declined.get("error", {}).get("code") == -32601, (
    f"expected a decline: {declined}"
)

# Idle RSS after real work (budget: <150MB, 02 §9). ps works on mac/linux;
# the Windows number comes from the VM checklist.
if sys.platform != "win32":
    rss_kb = int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(proc.pid)]))
    print(f"daemon RSS after formatting+lint: {rss_kb / 1024:.1f} MB")
    assert rss_kb < 150 * 1024, f"RSS budget exceeded: {rss_kb} KB"

send({"jsonrpc": "2.0", "id": 3, "method": "shutdown", "params": None})
recv_response(3)
send({"jsonrpc": "2.0", "method": "exit", "params": None})
try:
    proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    proc.kill()
    raise SystemExit("FAIL: server did not exit after `exit` notification")
assert proc.returncode == 0, f"server exit code {proc.returncode}"
print(
    "LSP SMOKE PASS: formatting, Format Selection, diagnostics, rule hover,"
    " batch executeCommand, minify, unhandled methods declined, clean shutdown"
)

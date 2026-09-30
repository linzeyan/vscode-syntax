#!/usr/bin/env python3
"""LSP smoke test: drives `poly lsp` over stdio without an editor.

Usage: tools/lsp-smoke.py [path-to-poly-binary]
Exits non-zero on any failed expectation.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

BIN = sys.argv[1] if len(sys.argv) > 1 else "cli/target/release/poly"

# The daemon's own log, kept rather than inherited: `poly.memoryLog` writes one
# line per open and close saying what poly is holding, and the soak at the
# bottom reads them. Everything else poly reports goes here too, which is why
# the path is printed on the way out -- a failure worth reading is usually
# explained by a line above it.
LOG_PATH = os.path.join(tempfile.mkdtemp(prefix="poly-smoke-log-"), "daemon.log")
# Not a context manager: the daemon writes to this fd until it exits, which is
# the last thing this script does. A `with` would have to wrap the file.
log_file = open(LOG_PATH, "w")  # poly: ignore ruff/SIM115

proc = subprocess.Popen(
    [BIN, "lsp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log_file
)


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
        "params": {
            "processId": None,
            "rootUri": None,
            "capabilities": {},
            # On for the whole run, because the soak needs the per-close lines
            # and there is nothing to be gained by turning it on halfway.
            "initializationOptions": {"memoryLog": True},
        },
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
#
# Three languages and not one, because the daemon's dispatch is the thing under
# test here rather than the engines: `run_minify` looks the language up with
# poly's own detection and hands it to one entry point, and a unit test of that
# entry point cannot tell that the daemon reached it. The expected strings are
# the same ones `poly-engines` asserts, so a difference here is the daemon
# taking a different route to the same function -- the failure that made this
# file exist.
MINIFY_CASES = [
    (
        11,
        "file:///tmp/smoke-minify.json",
        "json",
        # Key order and the spaces inside the string are the two things a
        # round-trip through a JSON map type would quietly destroy.
        '{\n  "b": 1,\n  "a": "two  spaces"\n}\n',
        '{"b":1,"a":"two  spaces"}',
    ),
    (
        15,
        "file:///tmp/smoke-minify.css",
        "css",
        "/* gone */\n.a .b {\n  color: red;\n}\n",
        ".a .b{color:red}",
    ),
    (
        16,
        "file:///tmp/smoke-minify.js",
        "javascript",
        (
            "// gone\nexport function go(aLongParameterName) {\n"
            "  return aLongParameterName;\n}\n"
        ),
        # The name survives: this is a printer, not a minifier that mangles.
        "export function go(aLongParameterName){return aLongParameterName;}",
    ),
]
for request_id, uri, language_id, text, expected in MINIFY_CASES:
    send(
        {
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": uri,
                    "languageId": language_id,
                    "version": 1,
                    "text": text,
                }
            },
        }
    )
    send(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "workspace/executeCommand",
            "params": {
                "command": "poly.minifyEdits",
                "arguments": [{"uri": uri}],
            },
        }
    )
    resp = recv_response(request_id)
    edits = resp.get("result")
    assert edits, f"expected {language_id} minify edits: {resp}"
    assert edits[0]["newText"] == expected, (language_id, edits[0]["newText"])

# .editorconfig, resolved by the daemon so the extension does not need a second
# parser. Asked about a path that was never opened and in a language poly does
# not format, because that is the case the feature exists for -- an editor-side
# EditorConfig extension is there for the files poly never touches.
ec_dir = tempfile.mkdtemp(prefix="poly-smoke-ec-")
with open(os.path.join(ec_dir, ".editorconfig"), "w") as f:
    f.write(
        "root = true\n\n[*]\nindent_style = space\nindent_size = 2\n"
        "insert_final_newline = true\n\n[*.ini]\ntrim_trailing_whitespace = false\n"
    )
send(
    {
        "jsonrpc": "2.0",
        "id": 14,
        "method": "workspace/executeCommand",
        "params": {
            "command": "poly.editorConfig",
            "arguments": [{"uri": "file://" + os.path.join(ec_dir, "settings.ini")}],
        },
    }
)
ec = recv_response(14).get("result")
assert ec, f"expected editorconfig settings: {ec}"
assert ec["insertSpaces"] is True and ec["tabSize"] == 2, ec
# Inherited from [*] while [*.ini] overrides its own key: the file chain and
# section precedence are the parts a second implementation gets wrong.
assert ec["trimTrailingWhitespace"] is False, ec
assert ec["insertFinalNewline"] is True, ec
# Unset stays null. A default would have the extension overwrite the setting
# the user chose.
assert ec["endOfLine"] is None, ec
# poly does not format .ini, so the extension is the one that has to apply the
# save-time properties. Getting this backwards means two participants editing
# one save.
assert ec["formatted"] is False, ec

# Spelling, the one check with no language of its own, which is why it is asked
# for separately from `lint(lang, ..)` on both sides. It reads from disk rather
# than the buffer -- on stdin the document would be called `-` and the per-type
# config keyed off the file name would stop applying -- which is why these are
# real files.
typo_dir = tempfile.mkdtemp(prefix="poly-smoke-typos-")
os.mkdir(os.path.join(typo_dir, "vendor"))
with open(os.path.join(typo_dir, "poly.toml"), "w") as f:
    f.write('[lint]\nexclude = ["vendor/**"]\n')
for name in ("notes.md", "vendor/notes.md"):
    with open(os.path.join(typo_dir, name), "w") as f:
        f.write("# Notes\n\nSpelt teh wrong way.\n")


def open_note(name):
    uri = "file://" + os.path.join(typo_dir, name)
    send(
        {
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": uri,
                    "languageId": "markdown",
                    "version": 1,
                    "text": "# Notes\n\nSpelt teh wrong way.\n",
                }
            },
        }
    )
    return wait_diagnostics(uri)["params"]["diagnostics"]


spelling = open_note("notes.md")
assert spelling, "expected a typos diagnostic"
assert spelling[0]["source"] == "typos", spelling
assert spelling[0]["code"] == "typo", spelling
assert "`teh` should be `the`" in spelling[0]["message"], spelling[0]["message"]
assert spelling[0]["range"]["start"] == {"line": 2, "character": 6}, spelling[0][
    "range"
]
# `[lint] exclude` is what decides which files CI looks at, so the same text
# under it has to come back clean -- an editor that reports findings no CI run
# can produce is the A4 split pointing the other way.
assert open_note("vendor/notes.md") == [], "excluded file still linted"

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

# Same document, no range: both changed lines, and only those. Without this the
# assertion above passes just as well for a server that formats nothing. Not one
# edit over the file, which is what this used to be: the format shortcut applies
# edits as they arrive, and replacing every line moved the cursor and the view.
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
assert whole, f"expected edits: {whole}"
assert [e["range"]["start"]["line"] for e in whole] == [1, 3], whole
assert whole[0]["newText"] == '  "a": 1,\n', whole[0]["newText"]

# Every request gets an answer, including the ones poly does not implement.
# Silence is not a polite decline: the editor keeps waiting on that id, so the
# feature looks hung rather than absent. Caught for real by a probe that hung
# for ten minutes instead of failing.
send({"jsonrpc": "2.0", "id": 90, "method": "textDocument/rename", "params": {}})
declined = recv_response(90)
assert declined.get("error", {}).get("code") == -32601, (
    f"expected a decline: {declined}"
)

# RSS after the handshake and a few small buffers. ps works on mac/linux; the
# Windows number comes from the VM checklist.
#
# This bounds a daemon born fat and nothing more, which is less than it used to
# claim. It read "idle RSS budget < 150MB, exceeding it is a bug" -- measured
# 2026-09-21, that is not true of a session: opening and formatting one 121 KB
# minified `.js` takes a fresh daemon from 13 MB to 164 MB, and `didClose`
# returns none of it, because macOS libmalloc keeps large blocks. Three such
# files and it sits at 285 MB for good. The number this asserts is safe only
# because the workload above it is four small documents.
#
# What is true is the shape, and the soak below is what checks it: RSS is a
# high-water mark set by the heaviest buffer the session has seen, not a slope
# that follows how much work has been done.
if sys.platform != "win32":

    def rss_kb_now():
        return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(proc.pid)]))

    rss_kb = rss_kb_now()
    print(f"daemon RSS after formatting+lint: {rss_kb / 1024:.1f} MB")
    assert rss_kb < 150 * 1024, f"fat for four small buffers: {rss_kb} KB"

    # That snapshot catches a daemon born fat. It cannot see what an editor
    # session actually hits -- RSS climbing buffer after buffer for hours and
    # never coming back down -- because it is one measurement after a little
    # work.
    #
    # Measured 2026-09-21 (macOS 26.6, poly 0.14.0) by driving 14k files of a
    # real source tree through open/change/format/save/close: the daemon's RSS
    # is a high-water mark, not a slope. It is set by the heaviest single
    # buffer the session has seen -- one 121KB minified .js takes it from 13MB
    # to 164MB on its own, and macOS libmalloc keeps those large blocks long
    # after the close -- and repeating work stops moving it after three passes:
    # passes 4 to 25 over that same document added 0.2MB between them, and a
    # 400-file round repeated twelve times ended flat for its last 1600 cycles.
    #
    # So the slope is the thing worth holding down and the level is not: an
    # absolute ceiling here would be a claim about which file the user opens.
    # Four buffers, a fresh uri each round, and the second half of the rounds
    # measured against the first.
    SOAK_ROUNDS = 120

    # 4MB, from both ends. Eleven runs of this exact soak drift +0.0MB at the
    # median and 1.6MB at worst. The same soak with the didClose taken out --
    # where the daemon genuinely does keep every buffer it was shown -- drifts
    # +9.5, +9.7 and +9.6MB, and fails. 4MB is between the two on a log scale:
    # 2.5x over anything a healthy run has produced, 2.4x under the smallest
    # reading of the failure it exists to catch.
    SOAK_BUDGET_MB = 4

    def grow(block):
        """~16KB of buffer, numbered so nothing downstream can fold the repeats."""
        pieces, size, n = [], 0, 0
        while size < 16 * 1024:
            piece = block.replace("$n", str(n))
            pieces.append(piece)
            size += len(piece)
            n += 1
        return "".join(pieces)

    # Unformatted, and misspelt on purpose: a clean buffer soaks a much
    # shorter chain than an editor's, because nothing reaches the diagnostic
    # store or a publish. These four produce ~160 findings per round between
    # them, and every one of them is memory somebody has to hand back.
    TS_BLOCK = """export  function handler$n(request:Request, context :Context) {
  const  payload = {id:$n, kind:"soak", tags:["alpha","beta"], nested:{deep:1}};
  if(!request.ok){ throw new Error("teh request failed") }
  return context.send( payload )
}
"""
    JSON_BLOCK = '  {"id": $n,  "kind":"soak",   "tags":["alpha","beta"]},\n'
    MD_BLOCK = """## Section $n

Some prose that is spelt teh wrong way, with a very long line that some linter
somewhere is going to have an opinion about, followed by a list:

*   one
*   two
"""
    CSS_BLOCK = ".block-$n { color :#FFF ;  margin:0px;  padding : 1px 2px 3px }\n"

    SOAK_DOCS = [
        ("typescript", "ts", grow(TS_BLOCK)),
        ("json", "json", "[\n" + grow(JSON_BLOCK)[:-2] + "\n]\n"),
        ("markdown", "md", grow(MD_BLOCK)),
        ("css", "css", grow(CSS_BLOCK)),
    ]
    soak_dir = tempfile.mkdtemp(prefix="poly-smoke-soak-")
    marks = []
    soak_id = 1000
    for round_no in range(SOAK_ROUNDS):
        for language, ext, body in SOAK_DOCS:
            # A real file per round. Real, because typos reads the path and
            # not the buffer, so a uri with nothing under it quietly drops a
            # linter out of the soak. Per round, because a document map that
            # never lets go of an entry can only show as growth if the keys
            # differ. Left behind rather than unlinked: didSave is a
            # notification, so the lint reading this path is still in flight
            # when the next cycle starts, and removing it here raced that read.
            soak_path = os.path.join(soak_dir, f"{round_no}.{ext}")
            with open(soak_path, "w") as f:
                f.write(body)
            soak_uri = "file://" + soak_path
            send(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/didOpen",
                    "params": {
                        "textDocument": {
                            "uri": soak_uri,
                            "languageId": language,
                            "version": 1,
                            "text": body,
                        }
                    },
                }
            )
            send(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/didChange",
                    "params": {
                        "textDocument": {"uri": soak_uri, "version": 2},
                        "contentChanges": [{"text": body + "\n"}],
                    },
                }
            )
            soak_id += 1
            send(
                {
                    "jsonrpc": "2.0",
                    "id": soak_id,
                    "method": "textDocument/formatting",
                    "params": {
                        "textDocument": {"uri": soak_uri},
                        "options": {"tabSize": 2, "insertSpaces": True},
                    },
                }
            )
            recv_response(soak_id)
            send(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/didSave",
                    "params": {"textDocument": {"uri": soak_uri}},
                }
            )
            send(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/didClose",
                    "params": {"textDocument": {"uri": soak_uri}},
                }
            )
            # recv_response keeps every notification it walked past, and a
            # round publishes ~160 diagnostics. Holding 120 rounds of them
            # would have this script's memory dwarf the thing it measures.
            NOTIFICATIONS.clear()
        marks.append(rss_kb_now())

    half = SOAK_ROUNDS // 2
    drift_mb = (marks[-1] - marks[half - 1]) / 1024
    print(
        f"daemon RSS over {SOAK_ROUNDS} soak rounds:"
        f" {marks[0] / 1024:.1f} -> {marks[half - 1] / 1024:.1f} ->"
        f" {marks[-1] / 1024:.1f} MB (drift {drift_mb:+.1f} MB)"
    )
    assert drift_mb < SOAK_BUDGET_MB, (
        f"RSS still climbing {SOAK_ROUNDS - half} rounds after warm-up:"
        f" {drift_mb:+.1f} MB, series {[round(kb / 1024) for kb in marks]}"
    )

    # The half of the question RSS cannot answer.
    #
    # `ps` reports one number for a process that keeps documents, lint hashes,
    # package scopes and four kinds of finding, so a drift within budget is
    # consistent with one of those maps never letting go of an entry -- the
    # allocator hides small leaks behind blocks it already had. `poly.memoryLog`
    # is the daemon saying what it holds, and these counts are exact rather than
    # sampled: every round opens four documents and closes all four, so the line
    # written by the last close of round 120 has to read the same as the line
    # written by the last close of round 1. Anything that grows by one per round
    # is a map with no `remove` behind it, and it names itself.
    #
    # Proved red 2026-09-22 by taking `lint_hashes.remove` out of didClose: RSS
    # drifted +0.2MB and passed its budget, while this printed hashes 12 -> 488.
    # That is the whole case for the assertion -- a Url and a u64 per closed
    # file is a leak the allocator hides and `ps` will never show.
    log_file.flush()
    HELD = re.compile(
        r"memory after didClose: .*?(?P<documents>\d+) documents .*?"
        r"(?P<hashes>\d+) lint hashes; (?P<scopes>\d+) package scopes; "
        r"findings lint (?P<lint>\d+) package (?P<package>\d+) over (?P<files>\d+) files, "
        r"format (?P<format>\d+), downstream (?P<downstream>\d+)"
    )
    with open(LOG_PATH) as f:
        held = [m.groupdict() for m in (HELD.search(line) for line in f) if m]
    assert len(held) >= SOAK_ROUNDS, (
        f"poly.memoryLog wrote {len(held)} usable close lines for {SOAK_ROUNDS}"
        f" rounds of four documents -- the log is in {LOG_PATH}"
    )
    # One line per closed document, four per round, so a round's last close is
    # the one that has handed everything back.
    first, last = held[len(SOAK_DOCS) - 1], held[-1]
    print("daemon held, first soak round -> last:")
    for key in first:
        print(f"  {key:11} {first[key]} -> {last[key]}")
    grew = [key for key in first if int(last[key]) > int(first[key])]
    assert not grew, (
        f"poly kept more after {SOAK_ROUNDS} rounds of open/close than after one,"
        f" in {', '.join(grew)}: {first} -> {last}"
    )

send({"jsonrpc": "2.0", "id": 3, "method": "shutdown", "params": None})
recv_response(3)
send({"jsonrpc": "2.0", "method": "exit", "params": None})
try:
    proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    proc.kill()
    raise SystemExit("FAIL: server did not exit after `exit` notification")
assert proc.returncode == 0, f"server exit code {proc.returncode}"
log_file.close()
print(f"daemon log: {LOG_PATH}")
print(
    "LSP SMOKE PASS: formatting, Format Selection, diagnostics, spelling,"
    " lint excludes, rule hover, batch executeCommand, minify, .editorconfig,"
    " unhandled methods declined, RSS settles under a soak, poly hands back"
    " everything it held, clean shutdown"
)

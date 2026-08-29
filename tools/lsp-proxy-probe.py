#!/usr/bin/env python3
"""End-to-end probe for `poly lsp`'s language server proxy.

Drives poly over stdio against real projects and checks that the requests poly
does not implement -- go-to-definition, hover -- are answered by a real
language server routed through it.

Usage: tools/lsp-proxy-probe.py [path-to-poly-binary]
Skips a language loudly when its server is not installed; fails otherwise.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field

BIN = sys.argv[1] if len(sys.argv) > 1 else "cli/target/release/poly"

# Greet is defined on line 3 (1-based) and called on line 8; the probe asks
# about the call and expects to be sent to the definition.
# The unused local is deliberate: it makes gopls publish a diagnostic, which is
# what lets the probe prove poly does not overwrite them with its own empty set.
MAIN_GO = """package main

func Greet(name string) string {
\treturn "hello " + name
}

func main() {
\tprintln(Greet("world"))
\tunused := 1
}
"""

# Same shape in Rust, with the call outside a macro so the definition request
# does not depend on macro expansion.
MAIN_RS = """fn greet(name: &str) -> String {
    format!("hello {name}")
}

fn main() {
    let message = greet("world");
    println!("{message}");
}
"""


MAIN_C = """int greet(int n) {
    return n + 1;
}

int main(void) {
    int message = greet(1);
    return message;
}
"""

OTHER_CPP = """int twice(int n) {
    return n * 2;
}

int main() {
    return twice(2);
}
"""

# No Package.swift, for the same reason the c case has no compile database:
# sourcekit-lsp falls back to default arguments for a loose file, and building
# a package is the project's job.
MAIN_SWIFT = """func greet(_ name: String) -> String {
    return "hello " + name
}

let message = greet("world")
print(message)
"""

# No `terraform init`: resolving var.name back to its own block is module-local
# and needs no provider schema.
MAIN_TF = """variable "name" {
  type = string
}

output "greeting" {
  value = var.name
}
"""

MAIN_LUA = """local function greet(name)
    return "hello " .. name
end

local message = greet("world")
print(message)
"""


@dataclass
class Second:
    """A file in another language the same server answers for."""

    entry: str
    language: str
    definition_line: int
    call_line: int
    call_character: int


@dataclass
class Case:
    """One language's end of the proxy, and where to poke it."""

    language: str
    server: str
    files: dict
    entry: str
    definition_line: int  # 0-based, as LSP counts
    call_line: int
    call_character: int
    hover_needle: str
    # Set where one server covers several languages. clangd is why this
    # exists: it answers for both c and cpp, and there must be one of it.
    second: Second = None
    # Prefix of a line this server writes for every request it handles, when
    # poly passes it no logging arguments. Set only for a server that is noisy
    # by default -- it is what the languageServerLogs switch is measured by.
    chatty: str = None
    # Only one case needs to prove poly does not clobber downstream diagnostics:
    # the guard lives in publish_all and is language-agnostic, so re-checking it
    # per language would buy nothing and cost a wait on cargo check.
    diagnostics: bool = False
    edit: tuple = field(default=("world", "there"))


CASES = [
    Case(
        language="go",
        server="gopls",
        files={"go.mod": "module probe\n\ngo 1.21\n", "main.go": MAIN_GO},
        entry="main.go",
        definition_line=2,
        call_line=7,
        call_character=10,  # inside `Greet` on the call line
        hover_needle="Greet",
        diagnostics=True,
    ),
    Case(
        language="rust",
        server="rust-analyzer",
        files={
            "Cargo.toml": '[package]\nname = "probe"\nversion = "0.0.0"\nedition = "2021"\n',
            "src/main.rs": MAIN_RS,
        },
        entry="src/main.rs",
        definition_line=0,
        call_line=5,
        call_character=20,  # inside `greet` on the call line
        hover_needle="greet",
    ),
    # No compile_commands.json on purpose. clangd falls back to default flags
    # for a standalone file, which is enough for a same-file definition, and
    # producing a compile database is the project's business -- poly inventing
    # one would be poly guessing at a build it did not run (D6).
    Case(
        language="c",
        server="clangd",
        files={"main.c": MAIN_C, "other.cpp": OTHER_CPP},
        entry="main.c",
        definition_line=0,
        call_line=5,
        call_character=20,  # inside `greet` on the call line
        hover_needle="greet",
        second=Second(
            entry="other.cpp",
            language="cpp",
            definition_line=0,
            call_line=5,
            call_character=13,  # inside `twice` on the call line
        ),
        chatty="[clangd] I[",
    ),
    Case(
        language="swift",
        server="sourcekit-lsp",
        files={"main.swift": MAIN_SWIFT},
        entry="main.swift",
        definition_line=0,
        call_line=4,
        call_character=16,  # inside `greet` on the call line
        hover_needle="greet",
    ),
    # The one server here that is not its own entry point: poly has to run
    # `terraform-ls serve`, and without the subcommand the binary prints usage
    # and exits.
    Case(
        language="terraform",
        server="terraform-ls",
        files={"main.tf": MAIN_TF},
        entry="main.tf",
        definition_line=0,
        call_line=5,
        call_character=15,  # inside `name` of `var.name`
        hover_needle="name",
        chatty="[terraform-ls] ",
    ),
    Case(
        language="lua",
        server="lua-language-server",
        files={"main.lua": MAIN_LUA},
        entry="main.lua",
        definition_line=0,
        call_line=4,
        call_character=18,  # inside `greet` on the call line
        hover_needle="greet",
    ),
]

# Everything poly has said, in order. Kept because notifications arrive
# whenever the downstream server feels like it -- a probe that only looked at
# what came in during one wait would miss diagnostics that landed in a previous.
INBOX = []
# Every line poly has written to stderr, including the downstream server's own
# output that poly prefixes and passes on.
STDERR = []
proc = None


def watch(stream):
    """Record poly's stderr, and echo it so a failing run still shows why."""
    for raw in stream:
        line = raw.decode(errors="replace").rstrip()
        STDERR.append(line)
        print(line, file=sys.stderr)


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


def pump(want_id=None, want_method=None, limit=2000):
    """Read until the wanted response or notification, answering server requests.

    poly and the downstream server both ask the editor things mid-flight
    (registerCapability, workspace/configuration, progress); a probe that
    ignored them would hang waiting for a server that is itself waiting for a
    reply.
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


def ask(rid, method, params):
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    response, _ = pump(want_id=rid)
    return response


def settle(rid, method, params, ready, what):
    """Ask until the answer is real, or give up loudly.

    rust-analyzer replies to a request the instant it arrives, with an empty
    result, while it is still building the crate graph. There is no portable
    "server is ready" signal across language servers, so the probe asks again
    rather than trusting the first answer. gopls answers correctly on the first
    try and never enters the loop.
    """
    deadline = time.time() + 120
    while True:
        response = ask(rid, method, params)
        if ready(response.get("result")):
            return response["result"]
        if time.time() > deadline:
            raise AssertionError(f"no {what} within 120s, last: {response}")
        time.sleep(0.5)
        rid += 100  # ids must stay unique, and clear of the fixed ones below


def hover_text(hover):
    if not hover:
        return ""
    contents = hover["contents"]
    return contents["value"] if isinstance(contents, dict) else str(contents)


def descendants(pid):
    """Every process underneath `pid`.

    Direct children are not enough: a shim can sit between poly and the real
    server -- rustup's rust-analyzer proxy execs a fallback binary, mise puts
    its own shim in front -- and it is the leaf that holds the memory.
    """
    found = subprocess.run(
        ["pgrep", "-P", str(pid)],
        capture_output=True,
        text=True,
        # pgrep exits 1 when a process has no children, which is a real answer.
        check=False,
    )
    kids = [int(p) for p in found.stdout.split()]
    return kids + [deeper for kid in kids for deeper in descendants(kid)]


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def run(case, logs=True):
    global proc, INBOX, STDERR
    INBOX = []
    STDERR = []

    root = tempfile.mkdtemp(prefix=f"poly-proxy-{case.language}-")
    for name, text in case.files.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)
    entry = os.path.join(root, case.entry)
    uri = "file://" + entry
    source = case.files[case.entry]

    proc = subprocess.Popen(
        [BIN, "lsp"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    threading.Thread(target=watch, args=(proc.stderr,), daemon=True).start()

    send(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": None,
                "rootUri": "file://" + root,
                "workspaceFolders": [{"uri": "file://" + root, "name": "probe"}],
                "initializationOptions": {
                    "languageServers": True,
                    "languageServerLogs": logs,
                },
                "capabilities": {
                    "textDocument": {
                        "definition": {"linkSupport": False},
                        "hover": {"contentFormat": ["markdown", "plaintext"]},
                        "synchronization": {"dynamicRegistration": True},
                        # resolveSupport is what makes rust-analyzer turn
                        # resolveProvider on; without it the server declares no
                        # resolve and the check below silently never runs.
                        "completion": {
                            "completionItem": {
                                "resolveSupport": {
                                    "properties": [
                                        "documentation",
                                        "detail",
                                        "additionalTextEdits",
                                    ]
                                }
                            }
                        },
                    },
                    "workspace": {"configuration": True, "didChangeConfiguration": {}},
                },
            },
        }
    )
    init, _ = pump(want_id=1)
    assert init["result"]["capabilities"]["documentFormattingProvider"], init
    send({"jsonrpc": "2.0", "method": "initialized", "params": {}})

    # Opening the file is what starts the server: poly spawns nothing until a
    # document in a proxied language shows up.
    send(
        {
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": uri,
                    "languageId": case.language,
                    "version": 1,
                    "text": source,
                }
            },
        }
    )

    # poly declared none of these at initialize, so the editor only learns about
    # them once the server is up and poly registers them scoped to the language.
    registration, _ = pump(want_method="client/registerCapability")
    methods = {r["method"]: r for r in registration["params"]["registrations"]}
    assert "textDocument/definition" in methods, methods
    # One registration covers every language the server answers for, so the
    # selector is the whole set and not just the language that started it.
    expected = {case.language} | ({case.second.language} if case.second else set())
    selector = methods["textDocument/definition"]["registerOptions"]["documentSelector"]
    covered = {entry["language"] for entry in selector}
    assert covered == expected, selector
    send({"jsonrpc": "2.0", "id": registration["id"], "result": None})
    print(f"  registered for {', '.join(sorted(covered))}: {sorted(methods)}")

    at_call = {
        "textDocument": {"uri": uri},
        "position": {"line": case.call_line, "character": case.call_character},
    }

    # The actual point: poly implements no definition provider, so a location
    # here can only have come from the downstream server.
    locations = settle(2, "textDocument/definition", at_call, bool, "definition")
    if isinstance(locations, dict):
        locations = [locations]
    found = locations[0]
    assert found["uri"].endswith(os.path.basename(case.entry)), found
    start = found["range"]["start"]["line"]
    assert start == case.definition_line, found
    print(f"  definition resolved to line {start + 1}")

    # Hover on the same position must come from the server too, not from poly's
    # own sqruff-only hover -- the two share a method and must not shadow.
    hover = settle(
        3,
        "textDocument/hover",
        at_call,
        lambda h: case.hover_needle in hover_text(h),
        "hover",
    )
    summary = next(line for line in hover_text(hover).splitlines() if line.strip())
    print(f"  hover: {summary[:60]}")

    if case.second:
        # Opening a file in the server's other language must reach the process
        # that is already running. A clangd per language would index the same
        # project twice to answer the same questions.
        before = descendants(proc.pid)
        assert before, (
            f"{case.server} answered but poly has no child to compare against"
        )
        second = os.path.join(root, case.second.entry)
        second_uri = "file://" + second
        send(
            {
                "jsonrpc": "2.0",
                "method": "textDocument/didOpen",
                "params": {
                    "textDocument": {
                        "uri": second_uri,
                        "languageId": case.second.language,
                        "version": 1,
                        "text": case.files[case.second.entry],
                    }
                },
            }
        )
        at_second = {
            "textDocument": {"uri": second_uri},
            "position": {
                "line": case.second.call_line,
                "character": case.second.call_character,
            },
        }
        found = settle(7, "textDocument/definition", at_second, bool, "cross-language")
        if isinstance(found, dict):
            found = [found]
        assert found[0]["range"]["start"]["line"] == case.second.definition_line, found
        after = descendants(proc.pid)
        assert after == before, f"a second {case.server} started: {before} -> {after}"
        print(
            f"  one {case.server} answers for {case.language} and {case.second.language}"
        )

    # completionItem/resolve carries no uri, so poly routes it by the language
    # of the last completion. Completing and then resolving one of the items is
    # the only way to exercise that link: get it wrong and the resolve falls
    # back to poly, which has no answer for it.
    #
    # Only worth asking of a server that declared it -- gopls registers
    # completion without resolveProvider and answers "not yet implemented",
    # which says nothing about routing either way.
    completion = methods["textDocument/completion"]["registerOptions"]
    if completion.get("resolveProvider"):
        items = settle(5, "textDocument/completion", at_call, bool, "completion")
        if isinstance(items, dict):
            items = items["items"]
        resolved = ask(6, "completionItem/resolve", items[0])
        assert "result" in resolved, f"resolve was not routed downstream: {resolved}"
        print(f"  completion resolved: {resolved['result']['label']}")
    else:
        print(f"  {case.server} declares no resolveProvider; resolve not asked")

    if case.diagnostics:
        # The server owns diagnostics for its language. publishDiagnostics
        # replaces the whole set for a uri, so poly publishing its own (empty)
        # list for a proxied language would erase them -- on every save, until
        # the server happened to republish.
        while not any(diagnostics_for(uri)):
            pump(want_method="textDocument/publishDiagnostics")
        reported = next(d for d in diagnostics_for(uri) if d)
        print(f"  {case.server} diagnostics: {reported[0]['message']}")

        # Edit, then save. The edit matters: poly skips linting a document whose
        # content hash has not moved, so a save with no change exercises
        # nothing. The unused local stays, so the server has the same thing to
        # say afterwards and an empty set for this uri can only be poly's.
        saved_at = len(INBOX)
        send(
            {
                "jsonrpc": "2.0",
                "method": "textDocument/didChange",
                "params": {
                    "textDocument": {"uri": uri, "version": 2},
                    "contentChanges": [{"text": source.replace(*case.edit)}],
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
                    "position": {
                        "line": case.call_line,
                        "character": case.call_character,
                    },
                },
            }
        )
        pump(want_id=4)
        wiped = [d for d in diagnostics_for(uri, saved_at) if not d]
        assert not wiped, f"poly cleared {case.server}'s diagnostics on save"

    if case.chatty and logs:
        # The default passes no arguments, so a server that narrates every
        # request narrates it straight into poly's log. This is the half of
        # the languageServerLogs switch that proves the other half means
        # something.
        narrated = [line for line in STDERR if line.startswith(case.chatty)]
        assert narrated, f"{case.server} was expected to be noisy by default"
        print(f"  {case.server} logged {len(narrated)} lines with logs on")

    # Snapshot the tree before poly can tear it down, so the survivor check
    # below has something to look for. An empty set here would make it vacuous.
    spawned = descendants(proc.pid)
    assert spawned, f"{case.server} answered but poly has no child process"

    send({"jsonrpc": "2.0", "id": 9, "method": "shutdown", "params": None})
    pump(want_id=9)
    send({"jsonrpc": "2.0", "method": "exit", "params": None})
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise AssertionError("poly did not exit")

    # The server has to go down with poly: the editor closing is not a reason to
    # leave a process behind holding a project's worth of memory.
    deadline = time.time() + 10
    while time.time() < deadline and any(alive(pid) for pid in spawned):
        time.sleep(0.1)
    survivors = [pid for pid in spawned if alive(pid)]
    assert not survivors, f"{case.server} survived poly: {survivors}"

    shutil.rmtree(root, ignore_errors=True)


ran = []
for probe in CASES:
    if not shutil.which(probe.server):
        print(f"SKIPPED {probe.language}: {probe.server} is not on PATH")
        continue
    print(f"{probe.language} via {probe.server}:")
    run(probe)
    ran.append(probe.language)

    if probe.chatty:
        # Turning poly.languageServerLogs off has to reach the server, and the
        # whole case runs again rather than just the handshake: an argument
        # poly got wrong would show up as a server that no longer answers, not
        # as one that is merely quiet.
        print(f"{probe.language} via {probe.server}, languageServerLogs off:")
        run(probe, logs=False)
        narrated = [line for line in STDERR if line.startswith(probe.chatty)]
        assert not narrated, f"asked for quiet, got {len(narrated)}: {narrated[:2]}"
        print(f"  {probe.server} still answered, and logged nothing")

if not ran:
    print("PROXY PROBE SKIPPED: no language server on PATH")
else:
    print(
        f"PROXY PROBE PASS: {', '.join(ran)} started lazily, answered definition and hover"
    )

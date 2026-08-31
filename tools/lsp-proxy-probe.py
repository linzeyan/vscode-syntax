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

# Greet is defined on line 10 (1-based) and called on line 15; the probe asks
# about the call and expects to be sent to the definition.
# The unused local is deliberate: it makes gopls publish a diagnostic, which is
# what lets the probe prove poly does not overwrite them with its own empty set.
# The import block is deliberately out of order and split by a blank line, so
# gopls has a `source.organizeImports` to offer. Without one there is nothing
# for poly to strip, and the check that it strips them passes over an empty
# list -- which is the shape of vacuous check this probe keeps finding.
#
# It is also the exact disagreement the design is about: goimports keeps the
# blank line and gofumpt removes it, so these two would rewrite the same lines
# on one save.
MAIN_GO = """package main

import (
\t"os"
\t"fmt"

\t"strings"
)

func Greet(name string) string {
\treturn "hello " + name
}

func main() {
\tfmt.Println(Greet("world"))
\tfmt.Println(strings.ToUpper(os.Getenv("USER")))
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

# The doc comment is load-bearing, not decoration: buf answers hover out of the
# comment above a definition and returns null where there is none, so a sample
# without it would test the hover path against a server that had nothing to say.
MAIN_PROTO = """syntax = "proto3";

package demo.v1;

// Greeting is the text returned to the caller.
message Greeting {
  string text = 1;
}

message Response {
  Greeting greeting = 1;
}
"""

# buf.yaml is what makes this a module. Without one buf falls back to the
# working directory as the module root and PACKAGE_DIRECTORY_MATCH fires on a
# package that is perfectly fine -- the same trap `buf_files` skips files to
# avoid. The directory matches the package for the same reason.
BUF_YAML = """version: v2
modules:
  - path: .
lint:
  use:
    - STANDARD
"""

MAIN_LUA = """local function greet(name)
    return "hello " .. name
end

local message = greet("world")
print(message)

-- selene reports this and lua-language-server reports it too, which is the
-- point: the editor has to end up with both halves, from both sources.
local unused = 1
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
    # Only one case needs to prove poly does not clobber downstream diagnostics
    # on save: the merge in publish_all is language-agnostic, so re-checking it
    # per language would buy nothing and cost a wait on cargo check.
    diagnostics: bool = False
    # `source` of a finding poly itself publishes for this language, which has
    # to still be there once the server is answering. Only lua and swift have
    # one -- selene and swiftlint are the only linters poly runs in the editor
    # for a proxied language, and no language server looks for what they do.
    merged_source: str = None
    # Set where poly downloads the server rather than finding it on PATH, which
    # buf is the only one of. PATH says nothing about whether it will run, so
    # the skip below has nothing to read -- and a case that can only ever skip
    # is the vacuous check this probe keeps having to remove.
    managed: bool = False
    # Exactly what poly must register for this server, `textDocument/` dropped.
    # Measured from each server's own initialize result, then written down --
    # discovering it at runtime would make the check agree with whatever poly
    # happened to do.
    registers: set = None
    # Capabilities this server declares at initialize and then refuses when
    # actually asked. poly registers them anyway: the policy is to relay what
    # the server said about itself, and a per-server denylist would be poly
    # holding an opinion about someone else's binary -- one that rots the
    # moment they fix it. Recorded here so the lie is visible, and so the
    # probe fails loudly if it ever becomes true.
    unsupported: set = field(default_factory=set)
    edit: tuple = field(default=("world", "there"))


# What every server here declares, so the per-case sets below are only the
# differences worth reading. Nothing is derived from PROXIED on purpose: a
# table built from the code under test agrees with it by construction.
COMMON = {
    "hover",
    "definition",
    "references",
    "documentSymbol",
    "completion",
    "signatureHelp",
}
# The rest of the batch, which the two thin servers do not all have.
FULL = COMMON | {
    "typeDefinition",
    "implementation",
    "rename",
    "codeAction",
    "documentHighlight",
    "foldingRange",
}

CASES = [
    Case(
        language="go",
        server="gopls",
        files={"go.mod": "module probe\n\ngo 1.21\n", "main.go": MAIN_GO},
        entry="main.go",
        definition_line=9,
        call_line=14,
        call_character=15,  # inside `Greet` on the call line
        hover_needle="Greet",
        diagnostics=True,
        # No declarationProvider: in Go a declaration and a definition are the
        # same thing, so gopls has nothing separate to point at.
        registers=FULL | {"selectionRange"},
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
        registers=FULL | {"selectionRange", "declaration"},
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
        registers=FULL | {"selectionRange", "declaration"},
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
        # No typeDefinition and no selectionRange; it is the only server here
        # that has declaration but not selectionRange.
        registers=(FULL - {"typeDefinition"}) | {"declaration"},
        # Declares declarationProvider, then answers -32001 "unsupported
        # method". Measured 2026-08-29 against sourcekit-lsp from the Xcode
        # toolchain.
        unsupported={"declaration"},
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
        # The thinnest of the six: no rename, no code actions, and none of the
        # position-scoped extras beyond signatureHelp.
        registers=COMMON | {"declaration"},
    ),
    # The one server poly pins itself, and the one that is not a toolchain's:
    # a .proto has no build behind it for buf to match. `buf lsp serve`, so
    # like terraform-ls it needs its subcommand.
    Case(
        language="protobuf",
        server="buf",
        managed=True,
        files={"buf.yaml": BUF_YAML, "demo/v1/main.proto": MAIN_PROTO},
        entry="demo/v1/main.proto",
        definition_line=5,
        call_line=10,
        call_character=4,  # inside `Greeting` on the field's type
        hover_needle="Greeting",
        # No implementation and no signatureHelp: protobuf has neither an
        # interface to implement nor a call to fill in arguments for.
        registers=FULL - {"implementation", "signatureHelp"},
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
        merged_source="selene",
        registers=FULL,
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


def on_save_kind(kind):
    """A code action kind VSCode runs on save rather than on request.

    Dot-separated prefix match down the LSP kind hierarchy, the same rule poly
    applies -- a vendor kind that merely starts with the same letters is not one.
    """
    return bool(kind) and (kind == "source" or kind.startswith("source."))


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


def run(case, logs=True, graceful=True):
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
                        # rust-analyzer returns null for every code action
                        # request unless the client declares it can accept
                        # CodeAction literals rather than bare Commands. Real
                        # editors declare it; the probe under-declaring made
                        # rust-analyzer look like it had nothing to offer.
                        #
                        # The on-save kinds are in the valueSet on purpose. A
                        # client that does not ask for them is one no server
                        # would offer them to, and the leak check downstream
                        # would then be inspecting a list that could not have
                        # contained the thing it is looking for.
                        "codeAction": {
                            "codeActionLiteralSupport": {
                                "codeActionKind": {
                                    "valueSet": [
                                        "quickfix",
                                        "refactor",
                                        "refactor.extract",
                                        "refactor.inline",
                                        "refactor.rewrite",
                                        "source",
                                        "source.organizeImports",
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

    # The exact set, not a subset. Stated per server rather than read off what
    # arrived, because the interesting failures are both directions: poly
    # dropping a capability the server has, and poly claiming one it does not.
    # A subset check would miss the first and a presence check would miss the
    # second, and both were real bugs the earlier per-capability booleans were
    # rewritten to catch.
    short = {m.removeprefix("textDocument/") for m in methods}
    assert short == case.registers, (
        f"{case.server} registrations differ\n"
        f"  missing: {sorted(case.registers - short)}\n"
        f"    extra: {sorted(short - case.registers)}"
    )

    at_call = {
        "textDocument": {"uri": uri},
        "position": {"line": case.call_line, "character": case.call_character},
    }
    # Code actions are asked over a range, and this one is the whole file. A
    # narrow selection gets whatever that one line supports, while the on-save
    # kinds are offered for the document — asking narrowly is how the leak
    # check ends up inspecting a list that never could have held the thing it
    # is looking for.
    entry_lines = case.files[case.entry].split("\n")
    at_range = {
        "textDocument": {"uri": uri},
        "range": {
            "start": {"line": 0, "character": 0},
            "end": {"line": len(entry_lines) - 1, "character": len(entry_lines[-1])},
        },
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

    # Rename is the one proxied request that answers with an edit rather than a
    # location. poly never applies it -- the editor does -- but it has to come
    # back at all, and only the server can produce it.
    #
    # Asserted against the table rather than skipped when absent. The first
    # version gated on `if registered`, which made it a no-op against a poly
    # that had never heard of rename -- it read as six clean skips.
    if "rename" in case.registers:
        if methods["textDocument/rename"]["registerOptions"].get("prepareProvider"):
            # Sent because of a flag inside the rename registration and never
            # registered on its own, so this is the only thing here that proves
            # poly routes a request it never advertised.
            prepared = ask(7, "textDocument/prepareRename", at_call)
            assert "result" in prepared, f"prepareRename was not routed: {prepared}"
            print(f"  prepareRename answered: {str(prepared['result'])[:50]}")
        edit = settle(
            8,
            "textDocument/rename",
            {**at_call, "newName": "renamed"},
            lambda r: bool(r) and bool(r.get("changes") or r.get("documentChanges")),
            "rename",
        )
        touched = edit.get("changes") or {
            c["textDocument"]["uri"]: c["edits"]
            for c in edit.get("documentChanges", [])
        }
        print(f"  rename produced edits in {len(touched)} file(s)")
    else:
        print(f"  {case.server} declares no renameProvider, as expected")

    # Code actions are the one proxied request poly does not pass through
    # untouched. `source.*` kinds are stripped, because VSCode runs those on
    # save and runs them *before* the formatter -- gopls's organizeImports and
    # poly's gofumpt disagree about import grouping, and save ordering would
    # pick the winner. What is left is the lightbulb.
    #
    # Asserted against the table, never gated on what showed up, for the reason
    # the rename check had to be rewritten: a check that skips when the
    # capability is absent cannot notice the capability going missing.
    if "codeAction" in case.registers:
        kinds = methods["textDocument/codeAction"]["registerOptions"].get(
            "codeActionKinds"
        )
        # The editor picks providers by declared kind, so claiming an on-save
        # kind is enough to put poly back on the save path on its own.
        claimed = [k for k in kinds or [] if on_save_kind(k)]
        assert not claimed, f"{case.server} registration still claims {claimed}"
        print(f"  codeAction kinds registered: {kinds}")

        # The save arriving. poly answers this one itself; nothing it hands
        # back here may be an action the formatter would then have to fight.
        saving = {
            **at_range,
            "context": {"diagnostics": [], "only": ["source.organizeImports"]},
        }
        on_save = ask(9, "textDocument/codeAction", saving)["result"]
        assert not on_save, f"an on-save action survived the save path: {on_save}"
        print("  on-save request answered empty, as designed")

        # The lightbulb: the path where the server really is asked. Asked once
        # rather than through settle -- a server with nothing to offer here is
        # answering correctly, and retrying for two minutes to confirm it is
        # still nothing only makes the run slower.
        actions = ask(
            10, "textDocument/codeAction", {**at_range, "context": {"diagnostics": []}}
        )["result"]
        leaked = [a.get("kind") for a in actions or [] if on_save_kind(a.get("kind"))]
        assert not leaked, f"{case.server} leaked on-save kinds: {leaked}"
        print(
            f"  lightbulb offered {len(actions or [])} action(s), none on-save: "
            f"{sorted({a.get('kind') for a in actions or []})}"
        )
    else:
        print(f"  {case.server} declares no codeActionProvider, as expected")

    # The read-only batch. poly implements none of these, and an unrouted
    # request comes back as METHOD_NOT_FOUND -- an error, with no `result`
    # field at all. So the presence of `result` is proof the request reached a
    # server, and it is the whole check: what the server then says is the
    # server's business, which is the point of proxying rather than answering.
    #
    # foldingRange and selectionRange are document-scoped rather than
    # position-scoped, and selectionRange wants a list of positions.
    extras = {
        "signatureHelp": at_call,
        "documentHighlight": at_call,
        "declaration": at_call,
        "foldingRange": {"textDocument": {"uri": uri}},
        "selectionRange": {
            "textDocument": {"uri": uri},
            "positions": [at_call["position"]],
        },
    }
    for offset, (feature, params) in enumerate(sorted(extras.items())):
        method = f"textDocument/{feature}"
        answer = ask(30 + offset, method, params)
        if feature in case.unsupported:
            # Registered, because the server said it could. Asked, and it said
            # otherwise. poly relays that verbatim rather than papering over it.
            assert "error" in answer, (
                f"{case.server} now answers {feature}; drop it from "
                f"`unsupported` -- the workaround note is stale"
            )
            print(f"  {feature}: declared by {case.server}, refused by it")
        elif feature in case.registers:
            assert "result" in answer, f"{method} was not routed: {answer}"
            print(f"  {feature} routed: {str(answer['result'])[:60]}")
        else:
            # Not registered, so the editor would never send it. Asking anyway
            # proves poly says so rather than hanging or inventing an answer.
            assert "error" in answer, (
                f"{case.server} declares no {feature} yet poly answered it: {answer}"
            )
            print(f"  {case.server} declares no {feature}, as expected")

    if case.merged_source:
        # publishDiagnostics replaces the whole set for a uri, so poly has to
        # merge rather than forward: whichever side spoke last would otherwise
        # erase the other. Turning the proxy on used to silently trade selene
        # and swiftlint away for language features.
        #
        # Waited on with a request as the barrier, never by pumping for the
        # publish itself. A poly that does not merge sends no publish at all
        # here, and pumping for one that is never coming hangs until something
        # outside kills the probe -- which is a worse failure than the bug.
        # poly answers every request, so the hover always comes back, and any
        # publish sent on the way lands in INBOX before it does.
        both = []
        for attempt in range(6):
            both = [
                published
                for published in diagnostics_for(uri)
                if any(d.get("source") == case.merged_source for d in published)
                and any(d.get("source") != case.merged_source for d in published)
            ]
            if both:
                break
            # A save with no change lints nothing: poly skips a document whose
            # content hash has not moved, so each attempt has to move it.
            send(
                {
                    "jsonrpc": "2.0",
                    "method": "textDocument/didChange",
                    "params": {
                        "textDocument": {"uri": uri, "version": 2 + attempt},
                        "contentChanges": [{"text": f"{source}\n-- {attempt}\n"}],
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
            ask(20 + attempt, "textDocument/hover", at_call)
        assert both, (
            f"no publish carried both {case.merged_source} and {case.server}: "
            f"{[[d.get('source') for d in p] for p in diagnostics_for(uri)]}"
        )
        sources = sorted({d.get("source") for d in both[-1]})
        print(f"  diagnostics merged from {sources}")

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

    # Every response poly sent has to carry a result or an error. A downstream
    # `"result": null` used to arrive as `{"jsonrpc":"2.0","id":3}` and nothing
    # else, which is not a legal response -- caught on Windows, but the bug was
    # never Windows-specific.
    malformed = [
        m
        for m in INBOX
        if "id" in m and "method" not in m and "result" not in m and "error" not in m
    ]
    assert not malformed, f"responses with neither result nor error: {malformed[:2]}"

    # Snapshot the tree before poly can tear it down, so the survivor check
    # below has something to look for. An empty set here would make it vacuous.
    spawned = descendants(proc.pid)
    assert spawned, f"{case.server} answered but poly has no child process"

    if graceful:
        send({"jsonrpc": "2.0", "id": 9, "method": "shutdown", "params": None})
        pump(want_id=9)
        send({"jsonrpc": "2.0", "method": "exit", "params": None})
    else:
        # An editor that dies takes its pipe with it and never asks politely.
        # poly used to stop its downstream servers only on the shutdown path,
        # which left this one to whatever the server did about it on its own.
        proc.stdin.close()
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
    # A managed server is poly's to produce, so there is nothing to skip on:
    # if it does not run, that is the finding, not a reason to stay quiet.
    if not probe.managed and not shutil.which(probe.server):
        print(f"SKIPPED {probe.language}: {probe.server} is not on PATH")
        continue
    if probe.managed:
        # Make poly produce it up front rather than during the case. Two
        # reasons, both learned from watching this hang: a server that cannot
        # be resolved surfaces as a case that sits until settle's 120s
        # deadline -- several times over, once per request -- instead of one
        # readable line; and on a cold cache the download itself would land
        # inside that deadline and could fail the case for being slow.
        got = subprocess.run(
            [BIN, "tools", "install", probe.server],
            capture_output=True,
            text=True,
            check=False,  # the exit code is the answer, not an exception
        )
        assert got.returncode == 0, (
            f"poly could not produce {probe.server}: {got.stderr.strip()}"
        )
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

# An editor that dies takes its pipe with it and never sends shutdown.
#
# Checking that nothing leaked is not enough here: a server notices its client
# has vanished and exits on its own, so that assertion holds whether or not
# poly did the right thing -- measured, not assumed. rust-analyzer is the one
# that says out loud which of the two happened, so it is the only case with
# anything to test.
rude = next(
    (c for c in CASES if c.language in ran and c.server == "rust-analyzer"), None
)
if rude:
    print(f"{rude.language} via {rude.server}, editor closes the pipe: ")
    run(rude, graceful=False)
    abandoned = [line for line in STDERR if "without proper shutdown" in line]
    assert not abandoned, f"poly walked out on {rude.server}: {abandoned}"
    print(f"  {rude.server} was shut down properly, not just abandoned")
elif ran:
    print("SKIPPED rude-exit check: needs rust-analyzer, the server that reports it")

if not ran:
    print("PROXY PROBE SKIPPED: no language server on PATH")
else:
    print(
        f"PROXY PROBE PASS: {', '.join(ran)} started lazily, answered definition and hover"
    )

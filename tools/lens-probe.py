#!/usr/bin/env python3
"""Do gopls and buf still answer what poly's lenses and commands ask for?

What it holds down is the half of the lenses that is not poly's code at all:
seven features are wired to particular code action kinds, to
`textDocument/implementation` reading backwards, and to the shape of two
servers' symbol trees -- each of those a claim about somebody else's server that
was true when measured.

`make lens-probe`, and part of `make gates`. It skips when `go` and `gopls` are
not on PATH, which is right on a machine that does not build Go and wrong in
CI: pass `--require` and a skip becomes a failure. That flag is the whole
reason this can be a gate, because a check that only ever skips is a check
nobody is running.

It is also the only thing standing behind `make ref-lens`'s protobuf and shell
sections. Those supply providers shaped like what was measured here, so they
pin poly's wiring and are deliberately blind to a server changing shape. This
is what sees that.

It asks each server directly, the way the editor's own extensions run them,
because the question is what the server has to give. If the answer here is no,
no amount of wiring in the extension produces it.

Measured 2026-09-21 against gopls v0.23.0. Three findings shaped the code it
guards, and all three are asserted below:

  * A Go method is a top-level symbol named `(Circle).Area`, not a child of
    `Circle`. `lensTargets` decides the implementation direction from a
    symbol's own kind for that reason.
  * An interface's methods are the opposite: children of the interface, named
    bare. `linkGeneratedGo` keys the generated Go on `${symbol.name}.${member
    .name}` to turn an rpc into `GreeterServer.SayHello`, so it reads the tree
    both ways and neither is a guess.
  * `refactor.move` answers null. The gesture is filed under
    `refactor.extract.toNewFile`, which is why `REFACTORINGS.moveToNewFile`
    asks for the extract kind.

And one more, measured 2026-09-22, which is here because it was assumed rather
than asked: buf answers in `SymbolInformation`, the flat shape, and VSCode
re-nests that one by range containment. Nothing nests anyway, but only because
buf's ranges cover a symbol's name rather than its body -- `service Greeter` is
eight columns of one line and does not reach the rpc below it. Body-spanning
ranges are what most servers send, and with them every rpc would arrive as a
child of its service. Both halves are asserted, because either one changing
moves the tree `linkGeneratedGo` walks.

It also found a gopls bug worth not tripping over: asked for an implementation
at the `func` keyword of a method declaration, gopls v0.23.0 segfaults in
`implFuncs`. poly asks at the symbol's `selectionRange.start`, which is the
identifier, so it cannot reach it -- and this file asks there too.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

SHAPES = """package probe

import "fmt"

type Shape interface {
	Area() float64
	Name() string
}

type Circle struct {
	Radius float64
}

func (c Circle) Area() float64 {
	return c.Radius * c.Radius * 3.14
}

func (c Circle) Name() string {
	return "circle"
}

type Square struct{ Side float64 }

func (s Square) Area() float64 { return s.Side * s.Side }

func (s Square) Name() string { return "square" }

func Describe(s Shape, prefix string) string {
	return fmt.Sprintf("%s%s: %f", prefix, s.Name(), s.Area())
}
"""

# The missing method is the whole point: gopls offers to stub methods against a
# diagnostic, so there has to be one. poly cannot conjure it without deciding
# which interface was meant, which is the analysis it does not do.
MISSING = """package probe

type Triangle struct{ Base float64 }

var _ Shape = Triangle{}
"""

# `main` in its own directory, because two package clauses in one directory is
# a load error and a package that does not load answers every type question
# with "denotes unknown object".
MAIN = """package main

import "fmt"

func main() {
	fmt.Println("hello")
}
"""

FIXTURE = {
    "go.mod": "module probe\n\ngo 1.22\n",
    "shapes.go": SHAPES,
    "missing.go": MISSING,
    "cmd/main.go": MAIN,
}

# The wire's numbering, which is one higher than `vscode.SymbolKind`:
# vscode-languageclient subtracts one on the way in, so every number in
# `references.ts` is the editor's and every number here is the protocol's.
KINDS = {
    5: "Class",
    6: "Method",
    8: "Field",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    22: "EnumMember",
    23: "Struct",
}

READY_S = 60

PROTO = """syntax = "proto3";

package greet.v1;

option go_package = "example.com/gen/greet/v1;greetv1";

message HelloRequest {
  string name = 1;

  message Nested {
    int32 count = 1;
  }
}

enum Tone {
  TONE_UNSPECIFIED = 0;
}

service Greeter {
  rpc SayHello(HelloRequest) returns (HelloRequest);
  rpc SayGoodbye(HelloRequest) returns (HelloRequest);
}
"""

BUF_YAML = "version: v2\nmodules:\n  - path: .\n"

# A shell function, defined once and called twice. The reference lens over a
# `.sh` was reported missing, and it was: poly counts an answer somebody else
# produced, and without the Bash IDE extension nothing answers for shellscript
# at all. What this fixture pins down is the other half -- that once
# bash-language-server is running there is something to count, in a shape poly
# counts. Two calls rather than one, because `elsewhere` drops the declaration
# from the list and a single call would leave a count of one either way.
SHELL = """#!/usr/bin/env bash

greet() {
  echo "hello $1"
}

greet world
greet again
"""


class Client:
    """One language server, spoken to over stdio."""

    def __init__(self, root, log, argv=("gopls", "-mode=stdio")):
        self.root = root
        # Held open for as long as the server runs, which is longer than any
        # block this could be scoped to. It is where a crash lands: gopls 0.23
        # writes its panic here, and the first version of this probe reported
        # the resulting silence as "the server answered nothing".
        # poly: ignore ruff/SIM115
        self.log = open(log, "w")
        self.proc = subprocess.Popen(
            list(argv),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.log,
            cwd=root,
        )
        self.next_id = 0

    def send(self, obj):
        body = json.dumps(obj).encode()
        try:
            self.proc.stdin.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
            self.proc.stdin.flush()
        except BrokenPipeError:
            return False
        return True

    def notify(self, method, params):
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method, params, timeout=30):
        self.next_id += 1
        rid = self.next_id
        if not self.send(
            {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
        ):
            return {"SERVER-DIED": method}
        deadline = time.time() + timeout
        while time.time() < deadline:
            message = self.read()
            if message is None:
                return {"SERVER-DIED": method}
            if message.get("id") == rid and ("result" in message or "error" in message):
                return message.get("result", {"ERROR": message.get("error")})
            # gopls asks the client things while it starts; answering keeps it
            # moving, and what it asks for does not change any answer below.
            if "id" in message and "method" in message:
                self.send({"jsonrpc": "2.0", "id": message["id"], "result": None})
        return {"TIMEOUT": method}

    def read(self):
        length = None
        while True:
            line = self.proc.stdout.readline()
            if not line:
                return None
            line = line.strip()
            if not line:
                break
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":")[1])
        return None if length is None else json.loads(self.proc.stdout.read(length))


def buf_path(poly):
    """Where poly keeps the buf it downloads, asked of poly rather than guessed.

    This was a literal `~/.cache/poly/tools/buf-1.72.0/buf`, and nothing kept it
    in step -- `make pins` checks poly's lock, not this file, so the first buf
    bump would have turned every .proto assertion below into a skip. `tools
    install` fetches when it has to, prints the resolved path either way, and
    costs 10ms once the tool is there.
    """
    printed = subprocess.run(
        [poly, "tools", "install", "buf"], check=True, capture_output=True, text=True
    ).stdout
    for line in printed.split("\n"):
        if line.startswith("buf:"):
            # A buf already on PATH is the one poly runs, and says so.
            return line.split(":", 1)[1].strip().removeprefix("on PATH, ")
    raise SystemExit(f"`{poly} tools install buf` printed no path:\n{printed}")


def uri(root, name):
    return "file://" + os.path.join(root, name)


def at_identifier(text, line_contains, name):
    """The position of `name` inside the first line containing `line_contains`."""
    for number, line in enumerate(text.split("\n")):
        if line_contains in line:
            return {
                "line": number,
                "character": line.index(name, line.index(line_contains)),
            }
    raise SystemExit(f"fixture has no line containing {line_contains!r}")


def start(root, log):
    client = Client(root, log)
    ready = client.request(
        "initialize",
        {
            "processId": os.getpid(),
            "rootUri": "file://" + root,
            "capabilities": {
                "textDocument": {
                    "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                    "codeAction": {
                        "codeActionLiteralSupport": {
                            "codeActionKind": {
                                "valueSet": [
                                    "quickfix",
                                    "refactor",
                                    "refactor.extract",
                                    "refactor.inline",
                                    "refactor.rewrite",
                                    "refactor.move",
                                    "source",
                                ]
                            }
                        }
                    },
                    "implementation": {"linkSupport": False},
                    "publishDiagnostics": {},
                },
                "workspace": {"workspaceFolders": True, "configuration": True},
                "window": {"workDoneProgress": True},
            },
            "workspaceFolders": [{"uri": "file://" + root, "name": "probe"}],
        },
        timeout=READY_S,
    )
    client.notify("initialized", {})
    for name, body in FIXTURE.items():
        if name.endswith(".go"):
            client.notify(
                "textDocument/didOpen",
                {
                    "textDocument": {
                        "uri": uri(root, name),
                        "languageId": "go",
                        "version": 1,
                        "text": body,
                    }
                },
            )
    # The package loads in the background and nothing below means anything
    # until it has. Poll a cheap question rather than guess a sleep.
    deadline = time.time() + READY_S
    while time.time() < deadline:
        got = client.request(
            "textDocument/documentSymbol",
            {"textDocument": {"uri": uri(root, "shapes.go")}},
            timeout=20,
        )
        if isinstance(got, list) and got:
            return client, ready
        time.sleep(1)
    raise SystemExit("gopls never loaded the fixture package")


def implementations(client, root, contains, name):
    found = client.request(
        "textDocument/implementation",
        {
            "textDocument": {"uri": uri(root, "shapes.go")},
            "position": at_identifier(SHAPES, contains, name),
        },
    )
    return found if isinstance(found, list) else []


def code_actions(
    client, root, file, text, contains, name, width, only=None, diagnostics=()
):
    position = at_identifier(text, contains, name)
    context = {"diagnostics": list(diagnostics)}
    if only:
        context["only"] = [only]
    found = client.request(
        "textDocument/codeAction",
        {
            "textDocument": {"uri": uri(root, file)},
            "range": {
                "start": position,
                "end": {
                    "line": position["line"],
                    "character": position["character"] + width,
                },
            },
            "context": context,
        },
    )
    return (
        [(one.get("title", ""), one.get("kind", "")) for one in found]
        if isinstance(found, list)
        else []
    )


def flatten(symbols, depth=0):
    out = []
    for symbol in symbols or []:
        out.append((depth, KINDS.get(symbol["kind"], symbol["kind"]), symbol["name"]))
        out.extend(flatten(symbol.get("children"), depth + 1))
    return out


def probe_buf(check, buf):
    """The .proto half: what `buf lsp serve` reports, which the Buf extension runs.

    Three of poly's decisions rest on this and on nothing else. The
    `go type` / `go server` / `go client` lenses read buf's symbol kinds; the
    `N methods` lens reads its qualified naming; and the implementation lens is
    drawn per language precisely because buf has no implementation provider and
    used to leave a `no impls` over every service and rpc in the file.
    """
    root = tempfile.mkdtemp(prefix="poly-proto-lens-")
    with open(os.path.join(root, "greet.proto"), "w") as handle:
        handle.write(PROTO)
    with open(os.path.join(root, "buf.yaml"), "w") as handle:
        handle.write(BUF_YAML)
    target = "file://" + os.path.join(root, "greet.proto")

    client = Client(root, os.path.join(root, "buf.log"), (buf, "lsp", "serve"))
    ready = client.request(
        "initialize",
        {
            "processId": os.getpid(),
            "rootUri": "file://" + root,
            "capabilities": {
                "textDocument": {
                    "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                    "references": {},
                    "implementation": {"linkSupport": False},
                },
                "workspace": {"workspaceFolders": True, "configuration": True},
            },
            "workspaceFolders": [{"uri": "file://" + root, "name": "probe"}],
        },
        timeout=READY_S,
    )
    client.notify("initialized", {})
    client.notify(
        "textDocument/didOpen",
        {
            "textDocument": {
                "uri": target,
                "languageId": "protobuf",
                "version": 1,
                "text": PROTO,
            }
        },
    )

    caps = ready.get("capabilities", {}) if isinstance(ready, dict) else {}
    check(
        "implementationProvider" not in caps,
        "buf declares no implementation provider, so the lens must be earned per language",
        sorted(k for k in caps if "Provider" in k and "implementation" in k.lower())
        or "(none)",
    )

    deadline = time.time() + READY_S
    tree = None
    while time.time() < deadline:
        tree = client.request(
            "textDocument/documentSymbol", {"textDocument": {"uri": target}}, 20
        )
        if isinstance(tree, list) and tree:
            break
        time.sleep(1)
    top = tree if isinstance(tree, list) else []
    # Which of the two symbol shapes buf answers in. Measured 2026-09-22: the
    # older one, `SymbolInformation` -- flat, carrying a `location` and no
    # `selectionRange`. It is asserted rather than merely read because the two
    # shapes reach the editor differently: VSCode takes a `DocumentSymbol` tree
    # as given, and re-nests a flat list by range containment. `make ref-lens`
    # feeds the proto lens a fixture, and a fixture in the other shape would be
    # a check of a tree no server sends.
    shape = (
        "DocumentSymbol"
        if top and all("selectionRange" in one for one in top)
        else "SymbolInformation"
        if top and all("location" in one for one in top)
        else "(neither, or mixed)"
    )
    check(
        shape == "SymbolInformation",
        "buf answers in SymbolInformation, which the editor re-nests by range",
        shape,
    )
    flat = flatten(top)
    by_name = {name: (depth, kind) for depth, kind, name in flat}

    # And what stops that re-nesting from happening: buf's ranges cover the
    # name, not the body. `service Greeter` is columns 8-15 of its own line, so
    # it does not reach the rpc a line below, and no symbol here contains
    # another. The flat list therefore stays flat.
    #
    # Both halves are load-bearing and neither is obvious. A server that sent
    # the same names with body-spanning ranges -- the shape most of them use --
    # would hand poly's provider a tree where every rpc is a child of its
    # service and every field a child of its message, and `linkGeneratedGo`
    # reads top-level symbols and their children differently.
    spans = {one["name"]: one["location"]["range"] for one in top if "location" in one}

    def inside(outer, inner):
        start = (outer["start"]["line"], outer["start"]["character"])
        end = (outer["end"]["line"], outer["end"]["character"])
        return (
            start <= (inner["start"]["line"], inner["start"]["character"])
            and (
                inner["end"]["line"],
                inner["end"]["character"],
            )
            <= end
        )

    nested = sorted(
        f"{inner} inside {outer}"
        for outer, out_range in spans.items()
        for inner, in_range in spans.items()
        if outer != inner and inside(out_range, in_range)
    )
    check(
        not nested,
        "buf's ranges cover the name and not the body, so nothing contains anything",
        nested or "(nothing nests)",
    )
    check(
        by_name.get("greet.v1.HelloRequest") == (0, "Class")
        and by_name.get("greet.v1.Tone") == (0, "Enum")
        and by_name.get("greet.v1.Greeter") == (0, "Interface"),
        "message is a Class, enum an Enum, service an Interface, all qualified",
        {k: v for k, v in by_name.items() if k.count(".") == 2} or "(none)",
    )
    check(
        by_name.get("greet.v1.Greeter.SayHello") == (0, "Method"),
        "an rpc is a top-level Method named after its service, which is what `N methods` reads",
        by_name.get("greet.v1.Greeter.SayHello", "(none)"),
    )
    check(
        by_name.get("greet.v1.HelloRequest.Nested") == (0, "Class"),
        "a nested message is qualified through its parent, which is protoc's Go name too",
        by_name.get("greet.v1.HelloRequest.Nested", "(none)"),
    )
    found = client.request(
        "textDocument/references",
        {
            "textDocument": {"uri": target},
            "position": {
                "line": PROTO.split("\n").index("message HelloRequest {"),
                "character": 8,
            },
            "context": {"includeDeclaration": True},
        },
    )
    check(
        isinstance(found, list) and len(found) > 0,
        "buf answers references, which is what puts any lens on a .proto at all",
        f"{len(found)} location(s)" if isinstance(found, list) else found,
    )
    client.proc.kill()


def probe_bash(check):
    """The `.sh` half: does anything answer, and in a shape poly's lens counts?

    "bash function still has no ref" was reported twice. The cause was never
    here -- without the Bash IDE extension nothing answers for shellscript
    and a lens that counts other people's answers correctly draws nothing. But
    nothing measured the other half either, so "the feature is off" and "the
    feature does not work" looked identical from outside. These three facts are
    the whole of what the lens needs once the server is running.
    """
    root = tempfile.mkdtemp(prefix="poly-shell-lens-")
    with open(os.path.join(root, "deploy.sh"), "w") as handle:
        handle.write(SHELL)
    target = "file://" + os.path.join(root, "deploy.sh")

    client = Client(
        root,
        os.path.join(root, "bash.log"),
        ("bash-language-server", "start"),
    )
    ready = client.request(
        "initialize",
        {
            "processId": os.getpid(),
            "rootUri": "file://" + root,
            "capabilities": {
                "textDocument": {
                    "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                    "references": {},
                },
                "workspace": {"workspaceFolders": True},
            },
            "workspaceFolders": [{"uri": "file://" + root, "name": "probe"}],
        },
        timeout=READY_S,
    )
    client.notify("initialized", {})
    client.notify(
        "textDocument/didOpen",
        {
            "textDocument": {
                "uri": target,
                "languageId": "shellscript",
                "version": 1,
                "text": SHELL,
            }
        },
    )

    caps = ready.get("capabilities", {}) if isinstance(ready, dict) else {}
    check(
        bool(caps.get("referencesProvider")),
        "bash-language-server answers references, which is the whole lens",
        caps.get("referencesProvider", "(absent)"),
    )

    tree = client.request(
        "textDocument/documentSymbol", {"textDocument": {"uri": target}}, 20
    )
    flat = flatten(tree if isinstance(tree, list) else [])
    kinds = {name: kind for _, kind, name in flat}
    # `Function` and not `Variable` or `Method`: references.ts counts a fixed
    # set of SymbolKinds, and a shell function arriving as something outside it
    # would be a lens that is off for one language and on for the rest -- the
    # hardest kind of missing feature to notice.
    check(
        kinds.get("greet") == "Function",
        "a shell function is a Function, one of the kinds poly counts",
        kinds or "(no symbols)",
    )

    found = client.request(
        "textDocument/references",
        {
            "textDocument": {"uri": target},
            "position": {
                "line": SHELL.split("\n").index("greet() {"),
                "character": 0,
            },
            "context": {"includeDeclaration": True},
        },
    )
    # Three: the definition and the two calls. poly drops the declaration, so
    # what the lens would say is `2 refs` -- and a server answering with only
    # the declaration would make it say `no refs` over a function used twice.
    count = len(found) if isinstance(found, list) else 0
    check(
        count >= 3,
        "the definition and both calls come back, so the lens reads `2 refs`",
        f"{count} location(s)",
    )
    client.proc.kill()


def main():
    argv = sys.argv[1:]
    required = "--require" in argv
    rest = [one for one in argv if one != "--require"]
    if len(rest) != 1:
        print("usage: lens-probe.py <poly binary> [--require]", file=sys.stderr)
        return 2
    poly = rest[0]

    # Skipping is right on a machine with no Go toolchain and wrong in CI, so
    # the caller says which it is. Without `--require` this exits 0, because a
    # gate that fails for a missing optional tool is a gate people delete.
    missing = [tool for tool in ("go", "gopls") if shutil.which(tool) is None]
    if missing:
        absent = ", ".join(missing)
        if required:
            print(
                f"lens-probe: {absent} not on PATH, and --require says that is a failure"
            )
            return 1
        print(f"SKIPPED lens-probe: {absent} not on PATH")
        return 0

    buf = buf_path(poly)

    root = tempfile.mkdtemp(prefix="poly-go-lens-")
    for name, body in FIXTURE.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as handle:
            handle.write(body)
    client, ready = start(root, os.path.join(root, "gopls.log"))

    problems = []

    def check(ok, what, saw):
        print(f"  {'ok  ' if ok else 'FAIL'}  {what}: {saw}")
        if not ok:
            problems.append(f"{what}: {saw}")

    print("\nimplementation, both directions — poly's `N impls` / `N interfaces`")
    for label, contains, name in (
        ("interface -> who satisfies it", "type Shape interface", "Shape"),
        # The one poly's upward lens depends on. Without it, `N interfaces`
        # would never have a number to show in any language.
        ("concrete type -> what it satisfies", "type Circle struct", "Circle"),
        ("method -> the interface method", "func (c Circle) Area", "Area"),
    ):
        found = implementations(client, root, contains, name)
        check(len(found) > 0, label, f"{len(found)} location(s)")

    print("\ndocumentSymbol — where a Go method sits in the tree")
    tree = client.request(
        "textDocument/documentSymbol", {"textDocument": {"uri": uri(root, "shapes.go")}}
    )
    flat = flatten(tree if isinstance(tree, list) else [])
    methods = [
        (depth, name)
        for depth, kind, name in flat
        if kind == "Method" and "Circle" in name
    ]
    check(
        methods == [(0, "(Circle).Area"), (0, "(Circle).Name")],
        "a method is top-level and carries its receiver in its name",
        methods,
    )
    # The other half of the same tree, and the one `linkGeneratedGo` keys on:
    # an rpc becomes `GreeterServer.SayHello` only because the generated
    # interface owns its methods as children under bare names. A struct method
    # and an interface method sit in opposite places, so reading one told us
    # nothing about the other -- and until this was written down, the key every
    # `N impls` on a .proto depends on was the one thing here nobody measured.
    members = [
        (depth, name)
        for depth, kind, name in flat
        if kind == "Method" and name in ("Area", "Name")
    ]
    check(
        members == [(1, "Area"), (1, "Name")],
        "an interface's methods are its children, named bare",
        members,
    )

    print("\ncodeAction — the kinds poly's commands ask for")
    at_declaration = code_actions(
        client,
        root,
        "shapes.go",
        SHAPES,
        "func Describe",
        "Describe",
        8,
        only="refactor.extract",
    )
    check(
        any(kind.endswith("toNewFile") for _, kind in at_declaration),
        "Move to New File finds refactor.extract.toNewFile",
        at_declaration or "(none)",
    )
    check(
        not code_actions(
            client,
            root,
            "shapes.go",
            SHAPES,
            "func Describe",
            "Describe",
            8,
            only="refactor.move",
        ),
        "refactor.move stays empty, which is why the command asks for extract",
        "(none)",
    )
    at_parameter = code_actions(
        client, root, "shapes.go", SHAPES, "func Describe", "prefix", 6
    )
    params = [
        (title, kind)
        for title, kind in at_parameter
        if kind.startswith("refactor.rewrite.")
    ]
    check(
        any("param" in title.lower() for title, _ in params),
        "Change Signature finds the parameter rewrites at a parameter",
        params or "(none)",
    )

    print("\ncodeAction — Implement Interface needs the diagnostic to exist first")
    diagnostics = client.request(
        "textDocument/diagnostic",
        {"textDocument": {"uri": uri(root, "missing.go")}},
        timeout=20,
    )
    items = diagnostics.get("items", []) if isinstance(diagnostics, dict) else []
    check(
        any("does not implement" in one.get("message", "") for one in items),
        "the missing method is a diagnostic",
        [one.get("message", "")[:60] for one in items] or "(none)",
    )
    stubs = code_actions(
        client,
        root,
        "missing.go",
        MISSING,
        "var _ Shape = Triangle{}",
        "Triangle",
        8,
        diagnostics=items,
    )
    check(
        any("missing method" in title.lower() for title, _ in stubs),
        "the stub-methods quickfix is offered",
        [title for title, _ in stubs] or "(none)",
    )

    print("\ncodeAction at `func main` — why poly's run lens is poly's own")
    at_main = code_actions(client, root, "cmd/main.go", MAIN, "func main", "main", 4)
    check(
        not any(
            "run" == title.lower() or "debug" in title.lower() for title, _ in at_main
        ),
        "gopls offers no run or debug action, so D6's hand-off is the only route",
        [title for title, _ in at_main],
    )

    # gopls answers `serverInfo.version` with its whole build info as JSON.
    version = (
        ready.get("serverInfo", {}).get("version", "?")
        if isinstance(ready, dict)
        else "?"
    )
    try:
        version = json.loads(version)["Main"]["Version"]
    except (ValueError, KeyError, TypeError):
        pass
    client.proc.kill()

    print("\n`buf lsp serve` — the .proto lenses")
    probe_buf(check, buf)

    # Its own skip rather than a line in the one above: go and gopls gate most
    # of this file, and a machine without bash-language-server should still run
    # all of that. `--require` is CI, where it is installed and a skip would
    # mean the shell lens went back to being the thing nobody measures.
    print("\n`bash-language-server` — the reference lens on a shell function")
    if shutil.which("bash-language-server") is None:
        if required:
            print(
                "  FAIL  bash-language-server not on PATH, and --require says that is a failure"
            )
            problems.append("bash-language-server not on PATH")
        else:
            print("  SKIPPED: bash-language-server not on PATH")
    else:
        probe_bash(check)

    print(f"\ngopls {version}, buf {os.path.basename(os.path.dirname(buf))}")
    if problems:
        print(f"\n{len(problems)} of poly's lens assumptions no longer hold:")
        for problem in problems:
            print(f"  {problem}")
        return 1
    print("every question poly asks a server still has an answer")
    return 0


if __name__ == "__main__":
    sys.exit(main())

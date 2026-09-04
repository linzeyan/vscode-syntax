#!/usr/bin/env python3
"""End-to-end acceptance for poly's Rust lint.

`cargo clippy` is the third tool poly drives that cannot read a single buffer,
and until it was wired in, Rust was the largest language poly supported with no
lint at all — `poly check` on a .rs file reported nothing but spelling. Wiring
it in the editor as well is not a bonus: a linter that only runs in CI is the
editor/CI split A4 forbids, and it is exactly the bug package lint was built to
close for Go.

Two things here are only observable end to end:

  * The scope is the *workspace*, not the crate. cargo resolves upward and so
    must poly, or one save lints a different set of files than `poly check`
    does over the same tree.
  * One mistake is one Problem. `--all-targets` compiles a `main.rs` as a bin
    and again as its own test harness, so clippy reports everything in it
    twice. That duplication is real, it was found by running this rather than
    by reading the docs, and without the dedup the editor draws two overlapping
    squiggles on one mistake.

The fixture has no dependencies on purpose: cargo then builds it in seconds,
and a gate nobody can afford to run is a gate nobody runs.

Usage: tools/rust-acceptance.py [path-to-poly-binary]
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

WORKSPACE = """[workspace]
members = ["alpha", "beta"]
resolver = "2"
"""

MEMBER = """[package]
name = "{name}"
version = "0.1.0"
edition = "2021"
"""

# `needless_return` is a clippy lint and `unused_variables` is a rustc one, so
# one file proves poly reports both halves of what `cargo clippy` produces --
# and only the first has a documentation page, which is why poly derives a url
# for one and not the other.
ALPHA = """pub fn double(x: i32) -> i32 {
    let doubled = x * 2;
    return doubled;
}
"""

BETA = """pub fn greet() -> String {
    let unused = 1;
    "hi".to_string()
}
"""


def fixture(prefix):
    # realpath, because macOS makes /tmp a symlink to /private/tmp: the editor
    # sends the resolved path and a diagnostic published against the other one
    # attaches to a document nobody has open.
    root = os.path.realpath(tempfile.mkdtemp(prefix=prefix))
    write(os.path.join(root, "Cargo.toml"), WORKSPACE)
    for name, source in (("alpha", ALPHA), ("beta", BETA)):
        write(os.path.join(root, name, "Cargo.toml"), MEMBER.format(name=name))
        write(os.path.join(root, name, "src", "lib.rs"), source)
    return root


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def poly(*args, cwd=None):
    # check=False: `poly check` returning 1 is the finding, not a crash.
    done = subprocess.run(
        [BIN, *args], cwd=cwd, capture_output=True, text=True, check=False
    )
    return done.stdout + done.stderr


def published(root, name, language="rust", seconds=90):
    """Open and save one file; report the last diagnostics published per uri.

    The last publish and not the union: `publishDiagnostics` replaces the whole
    set for a document, so a finding that arrives and is then erased looks
    identical to one that arrived if the two are unioned.

    The deadline is generous because the first `cargo clippy` in a fresh
    workspace is a compile, not a lookup.
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
                "workspaceFolders": [{"uri": f"file://{root}", "name": "rs"}],
                # Off: rust-analyzer would be a second publisher to wait out,
                # and it is not what this file is measuring.
                "initializationOptions": {"languageServers": False},
                "capabilities": {
                    "workspace": {"configuration": True},
                    "textDocument": {"publishDiagnostics": {}},
                },
            },
        }
    )
    send({"jsonrpc": "2.0", "method": "initialized", "params": {}})

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
                    "languageId": language,
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

    final = {}
    until = time.time() + seconds
    while time.time() < until:
        try:
            message = inbox.get(timeout=max(0.05, until - time.time()))
        except queue.Empty:
            break
        if message is None:
            break
        if "method" in message and "id" in message:
            send({"jsonrpc": "2.0", "id": message["id"], "result": None})
        if message.get("method") != "textDocument/publishDiagnostics":
            continue
        params = message["params"]
        final[params["uri"]] = params["diagnostics"]
        # Wait for *this* document, not for any document. One clippy run
        # publishes for every file it found something in, and the other crate's
        # publish can arrive first -- stopping on it would leave this file's
        # recorded state at the empty publish didOpen produced, which reads
        # exactly like a lint that never ran.
        if params["uri"] == uri and any(
            d.get("source") == "clippy" for d in params["diagnostics"]
        ):
            break
    proc.kill()
    return final


def sources(output):
    return {
        line.split("[", 1)[1].split("/", 1)[0]
        for line in output.splitlines()
        if "] " in line and "[" in line
    }


def editor_and_cli_agree():
    """The same file, asked twice: does Problems say what `poly check` says?"""
    root = fixture("poly-rs-a4-")
    output = poly("check", ".", cwd=root)
    from_check = sources(output)
    final = published(root, "alpha/src/lib.rs")
    in_editor = {
        d.get("source", "?") for d in final.get(f"file://{root}/alpha/src/lib.rs", [])
    }
    shutil.rmtree(root, ignore_errors=True)

    print(f"  poly check reports: {sorted(from_check)}")
    print(f"  the editor publishes: {sorted(in_editor)}")
    assert "clippy" in from_check, (
        f"no clippy findings from check at all; the fixture is stale:\n{output}"
    )
    assert "clippy" in in_editor, (
        f"poly check found clippy findings and the editor published "
        f"{sorted(in_editor)}. A4 says these are the same answer."
    )


def the_scope_is_the_workspace():
    """One run covers every crate, because that is what cargo resolves to.

    Saving a file in `alpha` has to lint `beta` as well, for the same reason
    `golangci-lint ./...` covers a whole Go module: `poly check` over the tree
    groups both crates into one run, and an editor that only linted the crate
    the file is in would be answering a different question.
    """
    root = fixture("poly-rs-scope-")
    output = poly("check", ".", cwd=root)
    shutil.rmtree(root, ignore_errors=True)
    crates = {
        line.split("/src/", 1)[0].rsplit("/", 1)[-1]
        for line in output.splitlines()
        if "/src/" in line and "] " in line
    }
    print(f"  one `poly check` covered: {sorted(crates)}")
    assert crates == {"alpha", "beta"}, (
        f"one run should cover the whole workspace; it covered {sorted(crates)}. "
        "Stopping at the member crate would give a different scope per file."
    )


def one_mistake_is_one_problem():
    """`--all-targets` compiles a crate more than once; the finding is still one.

    Measured, not assumed: without the dedup this reports every finding in a
    lib-with-tests or a bin twice, and the editor draws two squiggles on one
    mistake.
    """
    root = fixture("poly-rs-dupe-")
    # A test module is what makes cargo compile this crate a second time.
    write(
        os.path.join(root, "alpha", "src", "lib.rs"),
        ALPHA + "\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {}\n}\n",
    )
    output = poly("check", ".", cwd=root)
    shutil.rmtree(root, ignore_errors=True)
    returns = [
        line
        for line in output.splitlines()
        if "needless_return" in line and "alpha/src/lib.rs" in line
    ]
    print(f"  needless_return reported {len(returns)} time(s)")
    assert len(returns) == 1, (
        f"one mistake came back {len(returns)} times:\n" + "\n".join(returns)
    )


if shutil.which("cargo") is None:
    print("SKIP: cargo is not on PATH, so there is no clippy to drive")
    sys.exit(0)
if subprocess.run(
    ["cargo", "clippy", "--version"], capture_output=True, check=False
).returncode:
    print("SKIP: the clippy component is not installed (`rustup component add clippy`)")
    sys.exit(0)

print(f"rust acceptance against {BIN}")
print("editor and CI, same file:")
editor_and_cli_agree()
print("one workspace, one run:")
the_scope_is_the_workspace()
print("one mistake, one Problem:")
one_mistake_is_one_problem()
print("RUST ACCEPTANCE PASS")

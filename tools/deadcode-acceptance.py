#!/usr/bin/env python3
"""End-to-end acceptance for `poly deadcode` outside Go.

The Go half lives in go-acceptance.py, where it has a control that deletes the
go.work. This is the other two languages, and each one is here because reading
its documentation would not have told you what running it does:

  * knip reports paths relative to its own working directory, the same trap
    tflint set. A daemon or a CLI that joins them against the wrong base
    produces findings for files that do not exist.
  * vulture walks a directory itself and has no idea what a virtualenv is.
    Pointed at a project root, the fixture below produced 353KB of findings
    about pip's vendored copy of six. poly hands it a file list instead --
    its own walk, honouring .gitignore and `[lint] exclude` -- and passes
    `--exclude` behind that. The fixture below has no .gitignore, which is
    what makes the second mechanism the load-bearing one: with the file list
    alone, measured, the flood was still there.

Each language skips loudly without its tool. Neither is a poly download: knip
is an npm dev dependency and vulture is a pip install, because both have to
match the toolchain that builds the project.

Usage: tools/deadcode-acceptance.py [path-to-poly-binary]
"""

import os
import shutil
import subprocess
import sys
import tempfile

BIN = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "cli/target/release/poly")

PACKAGE_JSON = """{
  "name": "knipdemo",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.js"
}
"""

INDEX_JS = """import { used } from "./lib.js";

console.log(used());
"""

LIB_JS = """export function used() {
  return 1;
}

export function neverImported() {
  return 2;
}
"""

ORPHAN_JS = """export function nobodyLoadsThisFile() {
  return 3;
}
"""

APP_PY = """def used():
    return 1


def never_called(a, b):
    return a + b


print(used())
"""

# What a virtualenv looks like from the outside. The name is the only thing
# that makes it different from source, which is exactly why vulture cannot tell
# and poly has to.
VENDORED_PY = """class SomebodyElsesClass:
    def method(self):
        pass
"""


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def fixture(prefix, files):
    # realpath, because macOS makes /tmp a symlink to /private/tmp and a
    # finding reported against the other spelling is a finding about a file
    # nobody asked about.
    root = os.path.realpath(tempfile.mkdtemp(prefix=prefix))
    for name, text in files.items():
        write(os.path.join(root, name), text)
    return root


def poly(*args, cwd=None):
    # check=False: `poly deadcode` returning 1 is the finding, not a crash.
    done = subprocess.run(
        [BIN, *args], cwd=cwd, capture_output=True, text=True, check=False
    )
    return done.stdout + done.stderr


def knip_finds_what_nothing_imports():
    """An unused export and a file no entry point reaches, both located.

    The paths matter as much as the findings: knip prints them relative to its
    own cwd, so a report naming `src/lib.js` when poly was started elsewhere is
    a path that resolves to nothing.
    """
    root = fixture(
        "poly-knip-",
        {
            "package.json": PACKAGE_JSON,
            "src/index.js": INDEX_JS,
            "src/lib.js": LIB_JS,
            "src/orphan.js": ORPHAN_JS,
        },
    )
    installed = subprocess.run(
        ["npm", "install", "--silent", "--no-audit", "--no-fund", "knip"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if installed.returncode:
        shutil.rmtree(root, ignore_errors=True)
        print(f"  SKIP: npm install knip failed:\n{installed.stderr.strip()[:400]}")
        return

    # From outside the project on purpose. Run from inside it and a path knip
    # reported relative to its own cwd would land on the right file by
    # accident, which is the whole failure this is here to catch.
    outside = os.path.dirname(root)
    output = poly("deadcode", root, cwd=outside)
    findings = [line for line in output.splitlines() if "knip/" in line]
    # poly prints positions relative to where it was invoked, exactly as
    # `poly check` does, so resolving them against that is the reader's
    # contract -- and a path built against the wrong base does not resolve.
    unresolved = [
        line
        for line in findings
        if not os.path.isfile(os.path.join(outside, line.split(":", 1)[0]))
    ]
    shutil.rmtree(root, ignore_errors=True)

    print(f"  knip reported {len(findings)} finding(s)")
    assert "unused-export" in output and "neverImported" in output, (
        f"the export nothing imports was not reported:\n{output}"
    )
    assert "unused-file" in output and "orphan.js" in output, (
        f"the file no entry point reaches was not reported:\n{output}"
    )
    assert not unresolved, (
        "knip reports paths relative to its own working directory; these did "
        "not resolve against poly's:\n" + "\n".join(unresolved)
    )


def vulture_stays_out_of_the_virtualenv():
    """The project's own code is reported; its dependencies are not.

    Two mechanisms are being checked at once and that is deliberate: poly hands
    vulture a file list from its own walk, and passes `--exclude` behind it.
    The venv here is *not* in a .gitignore, which is what makes the second one
    load-bearing -- and what the first version of this got wrong.
    """
    if shutil.which("vulture") is None:
        print("  SKIP: vulture is not on PATH (`pip install vulture`)")
        return
    root = fixture(
        "poly-vulture-",
        {
            "pyproject.toml": '[project]\nname = "demo"\n',
            "pkg/app.py": APP_PY,
            "venv/lib/python3.12/site-packages/dep/thing.py": VENDORED_PY,
        },
    )
    output = poly("deadcode", root, cwd=os.path.dirname(root))
    shutil.rmtree(root, ignore_errors=True)

    findings = [line for line in output.splitlines() if "vulture/" in line]
    print(f"  vulture reported {len(findings)} finding(s)")
    assert any("never_called" in line for line in findings), (
        f"the project's own dead function was not reported:\n{output}"
    )
    assert not any("site-packages" in line for line in findings), (
        "vulture reported on the virtualenv. Pointed at a directory it walks "
        "into venv/ and reports thousands of findings about somebody else's "
        "vendored code:\n" + "\n".join(findings[:5])
    )


def a_path_with_nothing_to_analyse_says_so():
    """No marker anywhere above it is an answer, not a silent success."""
    root = fixture("poly-nothing-", {"notes.txt": "hello\n"})
    output = poly("deadcode", root)
    shutil.rmtree(root, ignore_errors=True)
    print(f"  {output.strip().splitlines()[0][:100]}")
    assert "nothing to analyse" in output, (
        f"a path with no project should say so rather than exit clean:\n{output}"
    )


print(f"deadcode acceptance against {BIN}")
print("knip, for JavaScript and TypeScript:")
if shutil.which("npm") is None:
    print("  SKIP: npm is not on PATH, so there is no knip to install")
else:
    knip_finds_what_nothing_imports()
print("vulture, for Python:")
vulture_stays_out_of_the_virtualenv()
print("a path with no project:")
a_path_with_nothing_to_analyse_says_so()
print("DEADCODE ACCEPTANCE PASS")

// The half poly's daemon answers for: GraphQL, nginx and Makefile references,
// and Makefile and shell definitions.
//
// Every other section asks a provider the editor or the suite brings. These
// languages have none offline, so poly registers documentSymbol, references and
// definition for exactly them (cli/crates/poly-cli/src/navigate.rs) --
// dynamically, so a YAML or CSS file never meets a reference provider that
// cannot answer for it and gets `no refs` drawn over everything. That
// registration, the nginx and Makefile sync that comes with it, and an answer
// that reaches a file nobody opened are what no Rust test can see: they are the
// client's half.
//
const { mkdirSync, writeFileSync } = require("node:fs");
const { join, relative } = require("node:path");

/**
 * The schema, and an operations file that uses it.
 *
 * Fields and operations are in here to be left alone: a field is reached
 * through its type and never by name from another file, and an operation is
 * named for the server's logs, not for anything in the project to call.
 */
const FIXTURE = {
  "schema.graphql": `type User {
  id: ID!
}

interface Node {
  id: ID!
}

type Query {
  me: User
}
`,
  "ops.graphql": `query Me {
  me {
    ...Who
  }
}

fragment Who on User {
  id
}
`,
  // Under a directory named nginx, which is what gives a .conf the `nginx`
  // language id -- the same rule a user's /etc/nginx/conf.d/*.conf meets.
  "nginx/upstreams.conf": `upstream api {
  server 127.0.0.1:8080;
}

limit_req_zone $binary_remote_addr zone=perip:10m rate=1r/s;
`,
  "nginx/site.conf": `server {
  set $origin api;
  location / {
    limit_req zone=perip;
    proxy_pass http://api;
    add_header X-Origin $origin;
  }
  location @fallback {
    return 502;
  }
  error_page 502 @fallback;
}
`,
  "common.mk": `CC ?= cc
CFLAGS := -O2
`,
  Makefile: `include common.mk

.PHONY: all clean

all: build

build:
\t$(CC) $(CFLAGS) -o app main.c

clean:
\trm -f app
`,
  // Shell has definitions and nothing else, so these two must carry no lens:
  // a reference provider here would draw one over every function.
  "lib.sh": `greet() {
  echo "hi $1"
}
`,
  // No shebang: that would bring poly's `run | debug` lens, which is not this
  // section's.
  "run.sh": `source ./lib.sh
NAME=world
main() {
  local who=$NAME
  greet "$who"
}
main
`,
};

/** The language id each fixture file must open as for poly's registration to apply. */
function languageOf(file) {
  if (file.endsWith(".graphql")) return "graphql";
  if (file.startsWith("nginx/")) return "nginx";
  if (file.endsWith(".sh")) return "shellscript";
  return "makefile";
}

/**
 * Go to Definition, asked on a name in one file, and the line it must land on.
 *
 * `greet` and `$(CC)` are declared only in the file the other one sources or
 * includes, which nobody opened: the answer has to come from the daemon
 * reading the folder. `$NAME` and `$who` are the same-file case.
 */
const DEFINITIONS = [
  { file: "run.sh", line: "greet \"$who\"", name: "greet", want: ["lib.sh", "greet() {"] },
  { file: "run.sh", line: "greet \"$who\"", name: "who", want: ["run.sh", "local who=$NAME"] },
  { file: "run.sh", line: "local who=$NAME", name: "NAME", want: ["run.sh", "NAME=world"] },
  { file: "Makefile", line: "$(CC) $(CFLAGS) -o app main.c", name: "CC", want: ["common.mk", "CC ?= cc"] },
  { file: "Makefile", line: "all: build", name: "build", want: ["Makefile", "build:"] },
];

/**
 * Every lens each file may carry, by the text of its line, and what it says.
 *
 * Exhaustive: a lens on any other line is a problem. That is what holds down
 * `location / {`, which no directive can name, and `$binary_remote_addr`, which
 * nginx declares and this project only uses.
 *
 * `Node` is the one that says the most by saying least. It is an interface and
 * nothing in poly answers implementations for GraphQL, so the lens must count
 * its references and draw no implementation count beside them.
 */
const EXPECTED = {
  "schema.graphql": {
    "type User {": ["2 refs"],
    "interface Node {": ["no refs"],
    "type Query {": ["no refs"],
  },
  "ops.graphql": {
    "fragment Who on User {": ["1 ref"],
  },
  "nginx/upstreams.conf": {
    "upstream api {": ["1 ref"],
    "limit_req_zone $binary_remote_addr zone=perip:10m rate=1r/s;": ["1 ref"],
  },
  "nginx/site.conf": {
    "set $origin api;": ["1 ref"],
    "location @fallback {": ["1 ref"],
  },
  // `.PHONY: all clean` is what gives those two their one reference.
  "common.mk": {
    "CC ?= cc": ["1 ref"],
    "CFLAGS := -O2": ["1 ref"],
  },
  Makefile: {
    "all: build": ["1 ref"],
    "build:": ["1 ref"],
    "clean:": ["1 ref"],
  },
  "lib.sh": {},
  "run.sh": {},
};

/** Written before the host launches, because the daemon walks the folder for them. */
exports.writeFixture = function writeFixture(workspace) {
  mkdirSync(join(workspace, "nginx"), { recursive: true });
  for (const [name, body] of Object.entries(FIXTURE)) {
    writeFileSync(join(workspace, name), body);
  }
  return { POLY_NAV_WORKSPACE: workspace };
};

/**
 * What each file's lenses say, opened one at a time in `FIXTURE`'s order, and
 * where each of `DEFINITIONS` lands.
 *
 * The order is the point: the first file of each pair is counted while its
 * partner is still unopened, so `2 refs` over `type User` and `1 ref` over
 * `upstream api` or `CC ?= cc` can only come from the daemon reading the
 * folder. The definitions are asked before any file is opened beyond the one
 * asked in, for the same reason.
 */
exports.observeNavigate = async function observeNavigate(lensesFor) {
  // Required here rather than at the top of the file: run.js loads this same
  // module in plain node, where `vscode` does not resolve.
  const vscode = require("vscode");
  const dir = process.env.POLY_NAV_WORKSPACE;
  const definitions = [];
  for (const asked of DEFINITIONS) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(dir, asked.file)));
    let line = 0;
    while (line < document.lineCount && document.lineAt(line).text.trim() !== asked.line) line++;
    const character = document.lineAt(line).text.indexOf(asked.name);
    const found = (await vscode.commands.executeCommand(
      "vscode.executeDefinitionProvider",
      document.uri,
      new vscode.Position(line, character + 1),
    )) ?? [];
    const landed = [];
    for (const location of found) {
      const uri = location.targetUri ?? location.uri;
      const range = location.targetRange ?? location.range;
      const target = await vscode.workspace.openTextDocument(uri);
      landed.push([relative(dir, uri.fsPath), target.lineAt(range.start.line).text.trim()]);
    }
    definitions.push({ ...asked, language: document.languageId, landed });
  }
  const observed = [];
  for (const name of Object.keys(FIXTURE)) {
    const uri = vscode.Uri.file(join(dir, name));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    // A file expected to carry none is still waited on until its count holds.
    const atLeast = Object.keys(EXPECTED[name]).length > 0 ? 1 : 0;
    for (const lens of await lensesFor(uri, atLeast)) {
      observed.push({
        file: name,
        language: document.languageId,
        line: lens.range.start.line,
        text: document.lineAt(lens.range.start.line).text.trim(),
        title: lens.command?.title ?? "(unresolved)",
      });
    }
  }
  return { lenses: observed, definitions };
};

/** What the lenses and definitions said, and what is wrong with it. */
exports.checkNavigate = function checkNavigate(navigate) {
  const observed = navigate?.lenses;
  console.log("\nGraphQL, nginx, Makefile and shell, answered by poly's daemon:");
  for (const one of observed ?? []) {
    console.log(
      `  ${one.file.padEnd(21)} ${String(one.line + 1).padStart(3)}  ${one.title.padEnd(8)} ${one.text}`,
    );
  }

  const problems = [];
  const said = new Map();
  for (const one of observed ?? []) {
    const key = `${one.file}|${one.text}`;
    said.set(key, [...(said.get(key) ?? []), one.title]);
  }
  for (const [file, lines] of Object.entries(EXPECTED)) {
    const language = (observed ?? []).find((one) => one.file === file)?.language;
    // Named apart from a missing lens, because the fix is somewhere else
    // entirely: the manifest's languages (grammars/sources.json), not the daemon.
    if (language && language !== languageOf(file)) {
      problems.push(`${file} opened as ${language}, so poly's registration never applied to it`);
    }
    for (const [text, want] of Object.entries(lines)) {
      const got = said.get(`${file}|${text}`) ?? [];
      if (got.join("; ") !== want.join("; ")) {
        problems.push(`${file}: ${text} — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
      }
    }
  }
  for (const one of observed ?? []) {
    if (!Object.hasOwn(EXPECTED[one.file] ?? {}, one.text)) {
      problems.push(`${one.file}: a lens on a name nothing can reach: ${one.text} says ${one.title}`);
    }
  }
  for (const one of navigate?.definitions ?? []) {
    console.log(`  definition of ${one.name} in ${one.file} -> ${JSON.stringify(one.landed)}`);
    if (one.language !== languageOf(one.file)) {
      problems.push(`${one.file} opened as ${one.language}, so poly's registration never applied to it`);
    }
    if (JSON.stringify(one.landed) !== JSON.stringify([one.want])) {
      problems.push(
        `definition of ${one.name} in ${one.file} — expected ${JSON.stringify([one.want])}, got ${
          JSON.stringify(one.landed)
        }`,
      );
    }
  }
  if (!navigate?.definitions?.length) {
    problems.push("no definitions were asked: the suite never reached them");
  }
  return problems;
};

// The GraphQL and nginx half: names whose references poly's daemon answers for.
//
// Every other section asks a provider the editor or the suite brings. These two
// languages have none offline, so poly registers documentSymbol and references
// for exactly them (cli/crates/poly-cli/src/navigate.rs) -- dynamically, so a
// YAML or CSS file never meets a reference provider that cannot answer for it
// and gets `no refs` drawn over everything. That registration, the nginx sync
// that comes with it, and a count that reaches a file nobody opened are what no
// Rust test can see: they are the client's half.
//
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

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
};

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
 * What each file's lenses say, opened one at a time in `FIXTURE`'s order.
 *
 * The order is the point: the first file of each pair is counted while its
 * partner is still unopened, so `2 refs` over `type User` and `1 ref` over
 * `upstream api` can only come from the daemon reading the folder.
 */
exports.observeNavigate = async function observeNavigate(lensesFor) {
  // Required here rather than at the top of the file: run.js loads this same
  // module in plain node, where `vscode` does not resolve.
  const vscode = require("vscode");
  const dir = process.env.POLY_NAV_WORKSPACE;
  const observed = [];
  for (const name of Object.keys(FIXTURE)) {
    const uri = vscode.Uri.file(join(dir, name));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    for (const lens of await lensesFor(uri)) {
      observed.push({
        file: name,
        language: document.languageId,
        line: lens.range.start.line,
        text: document.lineAt(lens.range.start.line).text.trim(),
        title: lens.command?.title ?? "(unresolved)",
      });
    }
  }
  return observed;
};

/** What the GraphQL and nginx lenses said, and what is wrong with it. */
exports.checkNavigate = function checkNavigate(observed) {
  console.log("\nGraphQL and nginx, answered by poly's daemon:");
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
    // entirely: poly-syntax's manifest, not the daemon.
    if (language && language !== (file.endsWith(".graphql") ? "graphql" : "nginx")) {
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
  return problems;
};

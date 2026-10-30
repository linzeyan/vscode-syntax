// The .proto half: does poly reach the Go that protoc generated for it?
//
// `linkGeneratedGo` is four steps -- compose a Go name out of a proto symbol,
// find the generated file by that file's name, find the name inside it, then
// ask that symbol's server who implements it -- and the unit tests cover the
// first step only, because the other three are questions for an editor. Both
// defects this feature shipped with were in the part no unit test can reach:
// `no impls` over every rpc, and `no interfaces` over every class. Both were
// visible in the first minute of running in a host.
//
// The servers here are fixtures, and that is the limit of what this proves. It
// proves poly's wiring -- name -> file -> symbol -> implementation query ->
// label -- against providers shaped like what `buf lsp serve` and gopls were
// measured to return (tools/lens-probe.py). It does not prove buf and gopls
// still answer that way; `make lens-probe` is what says that, and it is an
// audit rather than a gate because it needs both servers installed.
const { writeFileSync } = require("node:fs");
const { basename, join, resolve } = require("node:path");

/** One of each declaration the lens has an opinion about, and two it must not. */
const PROTO = `syntax = "proto3";

package greet.v1;

option go_package = "example.com/gen/greet/v1;greetv1";

message HelloRequest {
  string name = 1;
}

enum Tone {
  TONE_UNSPECIFIED = 0;
}

message Draft {
  string body = 1;
}

service Greeter {
  rpc SayHello(HelloRequest) returns (HelloRequest);
  rpc SayGoodbye(HelloRequest) returns (HelloRequest);
}
`;

/**
 * What protoc-gen-go wrote, with `Draft` deliberately missing.
 *
 * A .proto is edited before it is generated from, so a declaration with no Go
 * behind it is the ordinary state of the file and not a corner case. It is the
 * "find nothing, draw nothing" rule: a lens that points nowhere is worse than
 * no lens, because the word is an offer to jump somewhere.
 */
const PB_GO = `package greetv1

type HelloRequest struct {
	Name string
}

type Tone int32
`;

/**
 * What protoc-gen-go-grpc wrote: the client interface first, as it really is.
 *
 * The order matters to this check. Both interfaces declare a `SayHello`, and
 * the one an rpc's implementations hang off is the server's -- so a lookup
 * that took the first match would land on the client, whose only implementor
 * is the generated struct nobody is looking for. `SayGoodbye` is missing here
 * for the same reason `Draft` is missing above: the rpc was added and nothing
 * has been regenerated.
 */
const GRPC_GO = `package greetv1

type GreeterClient interface {
	SayHello(ctx context.Context, in *HelloRequest, opts ...grpc.CallOption) (*HelloRequest, error)
}

type GreeterServer interface {
	SayHello(context.Context, *HelloRequest) (*HelloRequest, error)
	mustEmbedUnimplementedGreeterServer()
}
`;

/** Two handlers, which are the answer `N impls` over the rpc has to arrive at. */
const SERVER_GO = `package main

type greetServer struct{}

func (s *greetServer) SayHello(ctx context.Context, in *HelloRequest) (*HelloRequest, error) {
	return in, nil
}
`;

const FAKE_GO = `package main

type fakeGreeter struct{}

func (f *fakeGreeter) SayHello(ctx context.Context, in *HelloRequest) (*HelloRequest, error) {
	return nil, nil
}
`;

const FIXTURE = {
  "greet.proto": PROTO,
  "greet.pb.go": PB_GO,
  "greet_grpc.pb.go": GRPC_GO,
  "server.go": SERVER_GO,
  "fake.go": FAKE_GO,
};

/** Which line a declaration is written on, read off the fixture rather than counted. */
function lineOf(text, needle) {
  return text.split("\n").findIndex((line) => line.includes(needle));
}

/** Where a lens says it will take you, as the report writes it down. */
function target(file, needle) {
  return `${file}:${lineOf(FIXTURE[file], needle) + 1}`;
}

/**
 * The same, read back out of the command a lens carries.
 *
 * The label is half the claim: `go type` over a message that opens the wrong
 * file is a lens pointing nowhere, which is the thing `linkGeneratedGo` is
 * written to refuse. `poly.showLocations` carries its destinations as
 * `Location`s, so one flat pass finds them. `poly.showReferences` carries only
 * where to ask, and `observeProto` clicks it instead.
 *
 * Read in the host and not off the report, because `Range.toJSON` is a
 * two-element array: written out and parsed back, a destination has no `.start`
 * left to read. Sorted, because the order is the editor's --
 * `executeImplementationProvider` handed fake.go back before server.go, which
 * is not the order the provider returned them in, and no lens means anything
 * by it.
 */
function targetsOf(command) {
  return (command?.arguments ?? [])
    .flat()
    .filter((one) => one && one.uri && one.range)
    .map((one) => `${basename(one.uri.path)}:${one.range.start.line + 1}`)
    .sort();
}

/**
 * Every lens the .proto must carry, and nothing else may.
 *
 * The list can be exhaustive because no reference provider is registered for
 * `protobuf` in this host, so poly's reference lens stands down and every lens
 * on the file came from `linkGeneratedGo`. That is what makes "nothing over
 * `message Draft`" a fact rather than the absence of one particular word.
 *
 * `go server` before `go client` is poly's order, not an accident of sorting:
 * the interface an implementation satisfies is what someone reading a service
 * block came for.
 */
const EXPECTED = {
  "message HelloRequest {": [`go type -> ${target("greet.pb.go", "type HelloRequest struct")}`],
  "enum Tone {": [`go type -> ${target("greet.pb.go", "type Tone int32")}`],
  "service Greeter {": [
    `go server -> ${target("greet_grpc.pb.go", "type GreeterServer interface")}`,
    `go client -> ${target("greet_grpc.pb.go", "type GreeterClient interface")}`,
  ],
  // Two and not three: the generated interface declares the method, so poly
  // has to subtract the declaration from what an implementation query returns.
  "rpc SayHello(HelloRequest) returns (HelloRequest);": [
    `2 impls -> ${target("fake.go", "func (f *fakeGreeter) SayHello")} `
    + target("server.go", "func (s *greetServer) SayHello"),
  ],
};

/** Written before the host launches, because `findFiles` is how poly finds them. */
exports.writeFixture = function writeFixture(workspace) {
  for (const [name, body] of Object.entries(FIXTURE)) {
    writeFileSync(join(workspace, name), body);
  }
  return { POLY_PROTO_WORKSPACE: workspace };
};

/** Long enough for the workspace search `findFiles` runs on to warm up. */
const READY_MS = 30_000;

/**
 * What the .proto's lenses say, once the answer stops changing.
 *
 * Every provider in play is a fixture in this process, so the only slow part is
 * `findFiles`: a search service that has not indexed the workspace yet answers
 * nothing, and `linkGeneratedGo` correctly draws nothing on an answer of
 * nothing. Polling rather than waiting on an event, because the event poly
 * fires is for configuration changes and would never arrive; each call of the
 * command asks the provider again.
 */
exports.observeProto = async function observeProto() {
  // Required here rather than at the top of the file: run.js loads this same
  // module in plain node, where `vscode` does not resolve.
  const vscode = require("vscode");
  // The editor's numbering and not the wire's: vscode-languageclient subtracts
  // one on the way in, so the `Class` here is the 4 `protobuf.ts` compares
  // against and not the 5 buf writes on the wire.
  const { Class, Enum, Interface, Method, Struct } = vscode.SymbolKind;
  const dir = process.env.POLY_PROTO_WORKSPACE;
  const uriOf = (name) => vscode.Uri.file(join(dir, name));

  /**
   * One symbol where the fixture writes it.
   *
   * `range` must contain `selectionRange` and every child's range or VSCode
   * drops the symbol, so a declaration with members names the line it ends on.
   * The lens is drawn at `selectionRange`; nothing reads the rest.
   */
  const symbol = (text, kind, name, needle, endNeedle = needle) => {
    const lines = text.split("\n");
    const line = lineOf(text, needle);
    const end = lineOf(text, endNeedle);
    // The last segment, because buf's names are qualified and the file is not:
    // `greet.v1.Greeter.SayHello` is written `SayHello` where it is declared.
    const written = name.split(".").pop();
    const column = lines[line].indexOf(written);
    return new vscode.DocumentSymbol(
      name,
      "",
      kind,
      new vscode.Range(line, 0, end, lines[end].length),
      new vscode.Range(line, column, line, column + written.length),
    );
  };

  // `buf lsp serve`, as measured: flat, and every name already qualified by the
  // proto package -- which is the package `goNameOf` has to strip back off. An
  // rpc is a top-level `Method` named through its service, not a child of it.
  //
  // Built as `DocumentSymbol` where buf sends the other shape. Measured
  // 2026-09-22: buf answers in `SymbolInformation`, which VSCode re-nests by
  // range containment, and the only reason nothing nests is that buf's ranges
  // cover a name rather than a body. Both arrive here as the same flat tree,
  // so this fixture asks the right question -- but it could not tell you if
  // buf started sending body-spanning ranges, because as a `DocumentSymbol`
  // tree it would still be taken as written. `make lens-probe` asserts both
  // halves of that, and is the half of this pair that would see it.
  const proto = [
    symbol(PROTO, Class, "greet.v1.HelloRequest", "message HelloRequest"),
    symbol(PROTO, Enum, "greet.v1.Tone", "enum Tone"),
    symbol(PROTO, Class, "greet.v1.Draft", "message Draft"),
    symbol(PROTO, Interface, "greet.v1.Greeter", "service Greeter"),
    symbol(PROTO, Method, "greet.v1.Greeter.SayHello", "rpc SayHello"),
    symbol(PROTO, Method, "greet.v1.Greeter.SayGoodbye", "rpc SayGoodbye"),
  ];
  // The generated side reads the other way round: gopls answers hierarchically,
  // and an interface's methods are its children -- which is the only reason
  // `GreeterServer.SayHello` is a key poly can look up. The kinds are not read
  // on this side at all, only the names and where they sit.
  const client = symbol(GRPC_GO, Interface, "GreeterClient", "type GreeterClient", "SayHello(ctx");
  client.children = [symbol(GRPC_GO, Method, "SayHello", "SayHello(ctx")];
  const server = symbol(GRPC_GO, Interface, "GreeterServer", "type GreeterServer", "mustEmbed");
  server.children = [
    symbol(GRPC_GO, Method, "SayHello", "SayHello(context"),
    symbol(GRPC_GO, Method, "mustEmbedUnimplementedGreeterServer", "mustEmbed"),
  ];
  const go = {
    "greet.pb.go": [
      symbol(PB_GO, Struct, "HelloRequest", "type HelloRequest struct"),
      symbol(PB_GO, Class, "Tone", "type Tone int32"),
    ],
    "greet_grpc.pb.go": [client, server],
  };
  const method = server.children[0].selectionRange;

  const disposables = [
    vscode.languages.registerDocumentSymbolProvider(
      { scheme: "file", language: "protobuf" },
      { provideDocumentSymbols: () => proto },
    ),
    vscode.languages.registerDocumentSymbolProvider(
      { scheme: "file", language: "go" },
      { provideDocumentSymbols: (document) => go[basename(document.uri.path)] ?? [] },
    ),
    vscode.languages.registerImplementationProvider({ scheme: "file", language: "go" }, {
      provideImplementation(document, position) {
        // At the generated server method and nowhere else. An implementation
        // query at the client's identically named method, at the interface
        // itself, or at a position composed from the wrong name has to come
        // back empty -- asking the wrong question is the defect this is here
        // to catch, and a provider that answers everywhere would hide it.
        if (basename(document.uri.path) !== "greet_grpc.pb.go" || !method.contains(position)) {
          return [];
        }
        // The declaration among them, because poly must subtract it either way
        // and a fixture that leaves it out never exercises that.
        return [
          new vscode.Location(uriOf("greet_grpc.pb.go"), method),
          new vscode.Location(
            uriOf("server.go"),
            symbol(SERVER_GO, Method, "SayHello", "func (s *greetServer) SayHello").selectionRange,
          ),
          new vscode.Location(
            uriOf("fake.go"),
            symbol(FAKE_GO, Method, "SayHello", "func (f *fakeGreeter) SayHello").selectionRange,
          ),
        ];
      },
    }),
  ];

  const uri = uriOf("greet.proto");
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const deadline = Date.now() + READY_MS;
  let lenses = [];
  let settled = 0;
  while (Date.now() < deadline && settled < 3) {
    await new Promise((done) => setTimeout(done, 500));
    const now = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri, 50)
      ?? [];
    settled = now.length > 0 && now.length === lenses.length ? settled + 1 : 0;
    lenses = now;
  }
  // An implementation lens carries where to ask, not the answer: the click asks
  // again (see `showReferences` in the editor). So its answer is read the way a
  // person gets it -- click, then read the list the click filled -- with the
  // providers above still registered to answer. And the editor has to still be
  // on the .proto afterwards: until 0.18.1 the click opened the generated file
  // the question was asked of, and threw the reader out of the one they were in.
  const observed = [];
  for (const lens of lenses) {
    const seen = {
      line: lens.range.start.line,
      text: document.lineAt(lens.range.start.line).text.trim(),
      title: lens.command?.title ?? "(unresolved)",
      targets: targetsOf(lens.command),
    };
    if (lens.command?.command === "poly.showReferences") {
      await vscode.commands.executeCommand(lens.command.command, ...lens.command.arguments);
      const shown = await vscode.commands.executeCommand("poly.referencesShown");
      seen.targets = shown.files
        .flatMap((file) => file.rows.map((row) => `${basename(file.path)}:${row.line + 1}`))
        .sort();
      seen.stayed = vscode.window.activeTextEditor?.document.uri.toString() === uri.toString();
    }
    observed.push(seen);
  }
  for (const disposable of disposables) {
    disposable.dispose();
  }
  return observed;
};

/** What the .proto's lenses said, and what is wrong with it. */
exports.checkProto = function checkProto(observed) {
  const said = new Map();
  for (const one of observed ?? []) {
    const what = `${one.title} -> ${one.targets.join(" ")}`;
    said.set(one.text, [...(said.get(one.text) ?? []), what]);
  }

  console.log("\nthe .proto, through the Go protoc generated for it:");
  for (const one of observed ?? []) {
    console.log(
      `  ${String(one.line + 1).padStart(4)}  ${one.title.padEnd(10)} `
        + `${one.targets.join(" ").padEnd(40)} ${one.text}`,
    );
  }

  const problems = [];
  for (const one of observed ?? []) {
    if (one.stayed === false) {
      problems.push(`clicking "${one.title}" on ${one.text} left the .proto for another file`);
    }
  }
  for (const [text, want] of Object.entries(EXPECTED)) {
    const got = said.get(text) ?? [];
    if (got.join("; ") !== want.join("; ")) {
      problems.push(`${text} — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
  for (const [text, got] of said) {
    if (!Object.hasOwn(EXPECTED, text)) {
      problems.push(`a lens with nothing generated behind it: ${text} says ${JSON.stringify(got)}`);
    }
  }
  return problems;
};

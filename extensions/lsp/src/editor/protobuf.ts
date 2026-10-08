/**
 * From a proto declaration to the Go declaration protoc generated for it.
 *
 * The one link in poly's editor features that crosses languages, and the only reason it
 * can exist without analysis is that protoc's output is not analysed but
 * *named*: `message HelloRequest` in package `greet.v1` becomes Go's
 * `HelloRequest` in `greet.pb.go`, every time, because that is what
 * protoc-gen-go is defined to do. This file is that definition written down.
 *
 * Everything else is delegated. The proto declarations come from
 * `buf lsp serve`, which the Buf extension runs for `.proto`; the Go declarations
 * come from whichever server answers for the generated file. poly forms a name
 * and asks -- the same shape as the reference lens, one step further out.
 *
 * What is deliberately not here: connect-go's `greet.connect.go`, gogo's
 * variants, and any generator whose file name or type name is configurable.
 * A wrong jump is worse than no lens, and those cannot be predicted from the
 * proto alone.
 */

/** `vscode.SymbolKind`, as `buf lsp serve` reports a .proto (measured 2026-09-21). */
const CLASS = 4; // message
const ENUM = 9; // enum
const INTERFACE = 10; // service

/** A Go declaration to look for, and the word the lens shows. */
export interface GoLink {
  readonly label: string;
  readonly name: string;
}

/**
 * The proto package a file declares, if it declares one.
 *
 * Read off the text rather than asked of the server, because buf does not
 * report the package clause as a symbol -- it reports every declaration's name
 * already qualified by it, which is the thing that has to be stripped back off.
 */
export function protoPackage(text: string): string | undefined {
  // Anchored at the start of a line so a `package` inside a comment or a
  // string does not win, and only the first one counts: a second package
  // clause is a file that does not compile.
  return /^[ \t]*package[ \t]+([A-Za-z0-9_.]+)[ \t]*;/m.exec(text)?.[1];
}

/**
 * The Go name for a proto declaration named `qualified`.
 *
 * protoc-gen-go drops the proto package and joins what is left with an
 * underscore, so `greet.v1.HelloRequest.Nested` in package `greet.v1` is
 * `HelloRequest_Nested`. Without a package clause the whole name is the path.
 */
export function goNameOf(qualified: string, pkg: string | undefined): string {
  const inside = pkg && qualified.startsWith(`${pkg}.`)
    ? qualified.slice(pkg.length + 1)
    : qualified;
  return inside.split(".").join("_");
}

/**
 * Which Go declarations a proto declaration turns into, and what to call them.
 *
 * A message or an enum is one type. A service is two, and neither of them is
 * called after the service: protoc-gen-go-grpc writes the `Client` interface a
 * caller uses and the `Server` interface an implementation satisfies, which is
 * the pair anyone reading a `service` block is actually looking for.
 */
export function goLinksFor(
  qualified: string,
  kind: number,
  pkg: string | undefined,
): GoLink[] {
  const name = goNameOf(qualified, pkg);
  if (kind === CLASS || kind === ENUM) {
    return [{ label: "go type", name }];
  }
  if (kind === INTERFACE) {
    return [
      { label: "go server", name: `${name}Server` },
      { label: "go client", name: `${name}Client` },
    ];
  }
  return [];
}

/**
 * The generated interface method an rpc becomes, as `Owner.Method`.
 *
 * This is the whole answer to "who implements this rpc". `buf lsp serve`
 * declares no implementation provider, so asking the .proto is a dead end --
 * but the rpc is a method on the generated `GreeterServer` interface, and the
 * server that answers for Go answers that question about it in the ordinary
 * way. poly forms the name; gopls finds the handlers.
 *
 * `Server` and not `Client`: an rpc's implementations are the things that
 * serve it. The client interface has exactly one implementation, the generated
 * struct, which nobody is looking for.
 */
export function goServerMethod(
  qualified: string,
  pkg: string | undefined,
): string | undefined {
  const inside = pkg && qualified.startsWith(`${pkg}.`)
    ? qualified.slice(pkg.length + 1)
    : qualified;
  const path = inside.split(".");
  // Exactly two: a service and an rpc in it. Proto has no nested services, so
  // anything else is not an rpc and this must not guess at it.
  return path.length === 2 ? `${path[0]}Server.${path[1]}` : undefined;
}

/**
 * The files protoc writes for `greet.proto`, by name.
 *
 * The stem is protoc's rule and not a guess: the output file is the input file
 * with its extension replaced. Where it lands is up to `option go_package` and
 * the generate config, which is why these are matched as a glob across the
 * workspace rather than resolved beside the proto.
 */
export function generatedFiles(protoPath: string): string[] {
  const stem = (protoPath.split("/").pop() ?? protoPath).replace(/\.proto$/, "");
  return [`${stem}.pb.go`, `${stem}_grpc.pb.go`];
}

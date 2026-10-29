/**
 * Which functions in a Go file `go test` would run, read from its text.
 *
 * golang.go draws `run test | debug test` over every function whose name
 * starts right, and `go test` runs only those whose signature is right too:
 * `TestFoo(x int)` gets the button and then refuses to build the package. So
 * this checks what `go test` checks -- the file, the name, and the signature
 * against however the file imported `testing` -- and leaves running and
 * debugging to golang.go's own commands, which LSP cannot start a debug
 * session for anyway.
 *
 * Read from the text rather than from a symbol provider: gopls's symbols carry
 * no parameter types, and the repo has no Go parser to lean on. Go's grammar
 * makes a scanner enough here: `func Name` only ever opens a top-level
 * declaration, and `import` only ever opens an import, so after comments and
 * strings are out of the way neither needs the rest of the file understood.
 */

export type GoTestKind = "test" | "benchmark" | "fuzz" | "example";

export interface GoTest {
  readonly name: string;
  readonly kind: GoTestKind;
  /** Zero-based line of the `func` keyword, where golang.go draws its lens. */
  readonly line: number;
}

/** Prefix, and the `testing` type its one parameter must point to. */
const KINDS: readonly (readonly [GoTestKind, string, string | undefined])[] = [
  ["test", "Test", "T"],
  ["benchmark", "Benchmark", "B"],
  ["fuzz", "Fuzz", "F"],
  // An example takes nothing, so it needs no `testing` either.
  ["example", "Example", undefined],
];

interface Token {
  readonly text: string;
  readonly kind: "ident" | "string" | "other";
  readonly line: number;
}

/**
 * Go's tokens, as coarsely as this needs.
 *
 * Comments and white space are dropped; strings, raw strings and runes are
 * kept whole so a `func` or a bracket inside one is not code. Operators come
 * out a character at a time, which is all the bracket matching below wants.
 */
const LEX =
  /(\s+|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|([\p{L}_][\p{L}\p{Decimal_Number}_]*)|("(?:[^"\\\n]|\\.)*"?|`[^`]*`?|'(?:[^'\\\n]|\\.)*'?)|([0-9][\w.]*|[\s\S])/uy;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let line = 0;
  LEX.lastIndex = 0;
  for (let m = LEX.exec(text); m && m[0] !== ""; m = LEX.exec(text)) {
    if (m[2] !== undefined) {
      tokens.push({ text: m[2], kind: "ident", line });
    } else if (m[3] !== undefined) {
      tokens.push({ text: m[3], kind: "string", line });
    } else if (m[4] !== undefined) {
      tokens.push({ text: m[4], kind: "other", line });
    }
    // A block comment and a raw string can both span lines.
    for (let at = m[0].indexOf("\n"); at !== -1; at = m[0].indexOf("\n", at + 1)) {
      line++;
    }
  }
  return tokens;
}

/** How the file can name `testing`: its qualifiers, and whether it is dot-imported. */
interface Testing {
  readonly qualifiers: Set<string>;
  dot: boolean;
}

/** Read one import spec at `at`; returns where the next one starts. */
function importSpec(tokens: readonly Token[], at: number, testing: Testing): number {
  const first = tokens[at];
  const named = first && (first.kind === "ident" || first.text === ".");
  const path = tokens[named ? at + 1 : at];
  if (path?.kind !== "string") {
    return at + 1;
  }
  if (path.text.slice(1, -1) === "testing") {
    const name = named ? first.text : "testing";
    if (name === ".") {
      testing.dot = true;
    } else if (name !== "_") {
      testing.qualifiers.add(name);
    }
  }
  return named ? at + 2 : at + 1;
}

/**
 * The tokens of a bracketed list, split at its top-level commas.
 *
 * `at` is the opening `(`; returns the groups and the index after the `)`, or
 * undefined for a list the file has not closed yet. A trailing comma -- legal
 * after the last parameter -- leaves no empty group behind.
 */
function groups(tokens: readonly Token[], at: number): [Token[][], number] | undefined {
  const found: Token[][] = [[]];
  let depth = 0;
  for (let i = at; i < tokens.length; i++) {
    const text = tokens[i].text;
    if (tokens[i].kind === "other" && "([{".includes(text)) {
      depth++;
      if (depth === 1) continue;
    } else if (tokens[i].kind === "other" && ")]}".includes(text)) {
      depth--;
      if (depth === 0) {
        if (found[found.length - 1].length === 0) found.pop();
        return [found, i + 1];
      }
    } else if (depth === 1 && text === ",") {
      found.push([]);
      continue;
    }
    found[found.length - 1].push(tokens[i]);
  }
  return undefined;
}

/** Is `group` one parameter of type `*testing.<want>`, named, blank or unnamed? */
function pointsTo(group: readonly Token[], want: string, testing: Testing): boolean {
  // A name, if there is one, comes before the `*` that starts the type.
  const type = group[0]?.kind === "ident" ? group.slice(1) : group;
  const text = type.map((token) => token.text);
  if (text.length === 4) {
    return text[0] === "*" && testing.qualifiers.has(text[1]) && text[2] === "." && text[3] === want;
  }
  return testing.dot && text.length === 2 && text[0] === "*" && text[1] === want;
}

/** `name` is `prefix`, or `prefix` and then anything but a lower-case letter. */
function hasPrefix(name: string, prefix: string): boolean {
  return name.startsWith(prefix) && !/^\p{Ll}/u.test(name.slice(prefix.length));
}

/** The functions `go test` would run in `fileName`, in the order they appear. */
export function goTests(fileName: string, text: string): GoTest[] {
  if (!fileName.endsWith("_test.go")) {
    return [];
  }
  const tokens = tokenize(text);
  const testing: Testing = { qualifiers: new Set(), dot: false };
  const candidates: { name: string; line: number; params: Token[][] }[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "ident") continue;
    if (token.text === "import") {
      if (tokens[i + 1]?.text === "(") {
        let at = i + 2;
        while (at < tokens.length && tokens[at].text !== ")") {
          at = tokens[at].text === ";" ? at + 1 : importSpec(tokens, at, testing);
        }
        i = at;
      } else {
        i = importSpec(tokens, i + 1, testing) - 1;
      }
      continue;
    }
    // `func (` is a method, a function literal or a function type; only a
    // top-level function declaration puts a name straight after the keyword.
    const name = tokens[i + 1];
    if (token.text !== "func" || name?.kind !== "ident") continue;
    // `[` is a type parameter list: go test has no type to instantiate it with.
    if (tokens[i + 2]?.text !== "(") continue;
    const list = groups(tokens, i + 2);
    if (!list) continue;
    const [params, after] = list;
    // Straight into the body: anything else between `)` and `{` is a result.
    if (tokens[after]?.text !== "{") continue;
    candidates.push({ name: name.text, line: token.line, params });
  }

  const found: GoTest[] = [];
  for (const { name, line, params } of candidates) {
    for (const [kind, prefix, want] of KINDS) {
      if (!hasPrefix(name, prefix)) continue;
      const fits = want === undefined
        ? params.length === 0
        : params.length === 1 && pointsTo(params[0], want, testing);
      if (fits) {
        found.push({ name, kind, line });
      }
      break;
    }
  }
  return found;
}

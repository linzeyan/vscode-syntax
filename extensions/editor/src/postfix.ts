/**
 * Postfix completion: `err.if` becomes `if err != nil { }`, in any language.
 *
 * This one is worth stating plainly, because it sits closer to 01 A6 ("poly
 * implements no language features") than anything else in this extension. The
 * line A6 draws is *analysis*: poly never answers a question about what the
 * program means -- what a name refers to, what type it has, whether it is
 * reachable. Everything else here relays somebody else's answer, and the
 * reference lens only counts what a provider handed over.
 *
 * A postfix template answers no such question. It reads the characters to the
 * left of the dot, rearranges them, and hands the result to the editor's own
 * snippet engine -- the same shape as the markdown emphasis toggle two files
 * over. It does not know whether `err` is an error, whether the expression has
 * a type, or whether the result compiles. That ignorance is the point: it is
 * why the table below can cover every language poly supports without poly
 * knowing anything about any of them, and it is the difference between this
 * and a language feature.
 *
 * gopls has no postfix completion, and neither do rust-analyzer's users get it
 * for free (r-a has its own, on for Rust only). This is the one thing in the
 * Tooltitude inventory that nothing poly proxies provides.
 */

/** The stand-in for the user's expression inside a template. */
export const EXPR_MARK = "%EXPR%";

/** Characters that can be part of the name typed after the dot. */
const IDENT = /[A-Za-z0-9_$]/;

/** One postfix, and what it expands to. */
export interface Postfix {
  /** What the user types after the dot. */
  readonly name: string;
  /** A snippet, with `EXPR_MARK` where the expression goes. */
  readonly template: string;
}

const post = (name: string, template: string): Postfix => ({ name, template });

/**
 * The expansions, by dialect rather than by language id.
 *
 * Grouped by the syntax, because that is the only thing that differs: C and C++
 * disagree about how to write a loop and agree about everything else, while Go
 * and Rust disagree about almost nothing except the loop and the print. Seven
 * dialects cover every programming language poly supports; the data formats
 * have no statements to expand into and are deliberately absent.
 */
const DIALECTS: Readonly<Record<string, readonly Postfix[]>> = {
  go: [
    post("if", `if ${EXPR_MARK} {\n\t$0\n}`),
    post("else", `if !${EXPR_MARK} {\n\t$0\n}`),
    post("for", `for _, ${"${1:item}"} := range ${EXPR_MARK} {\n\t$0\n}`),
    post("while", `for ${EXPR_MARK} {\n\t$0\n}`),
    // The one every Go file is made of, and the reason `.err` is worth having
    // even though `.if` already exists.
    post("err", `if ${EXPR_MARK} != nil {\n\treturn $0\n}`),
    post("nil", `if ${EXPR_MARK} == nil {\n\t$0\n}`),
    post("return", `return ${EXPR_MARK}`),
    post("not", `!${EXPR_MARK}`),
    post("print", `fmt.Println(${EXPR_MARK})`),
    post("var", `${"${1:name}"} := ${EXPR_MARK}`),
  ],
  rust: [
    post("if", `if ${EXPR_MARK} {\n\t$0\n}`),
    post("else", `if !${EXPR_MARK} {\n\t$0\n}`),
    post("for", `for ${"${1:item}"} in ${EXPR_MARK} {\n\t$0\n}`),
    post("while", `while ${EXPR_MARK} {\n\t$0\n}`),
    post("match", `match ${EXPR_MARK} {\n\t$0\n}`),
    post("some", `if let Some(${"${1:value}"}) = ${EXPR_MARK} {\n\t$0\n}`),
    post("return", `return ${EXPR_MARK};`),
    post("not", `!${EXPR_MARK}`),
    post("print", `println!("{:?}", ${EXPR_MARK});`),
    post("var", `let ${"${1:name}"} = ${EXPR_MARK};`),
  ],
  swift: [
    post("if", `if ${EXPR_MARK} {\n\t$0\n}`),
    post("else", `if !${EXPR_MARK} {\n\t$0\n}`),
    post("for", `for ${"${1:item}"} in ${EXPR_MARK} {\n\t$0\n}`),
    post("while", `while ${EXPR_MARK} {\n\t$0\n}`),
    post("guard", `guard let ${"${1:value}"} = ${EXPR_MARK} else {\n\treturn$0\n}`),
    post("return", `return ${EXPR_MARK}`),
    post("not", `!${EXPR_MARK}`),
    post("print", `print(${EXPR_MARK})`),
    post("var", `let ${"${1:name}"} = ${EXPR_MARK}`),
  ],
  js: [
    post("if", `if (${EXPR_MARK}) {\n\t$0\n}`),
    post("else", `if (!${EXPR_MARK}) {\n\t$0\n}`),
    post("for", `for (const ${"${1:item}"} of ${EXPR_MARK}) {\n\t$0\n}`),
    post("while", `while (${EXPR_MARK}) {\n\t$0\n}`),
    post("await", `await ${EXPR_MARK}`),
    post("return", `return ${EXPR_MARK};`),
    post("not", `!${EXPR_MARK}`),
    post("print", `console.log(${EXPR_MARK});`),
    post("var", `const ${"${1:name}"} = ${EXPR_MARK};`),
  ],
  python: [
    post("if", `if ${EXPR_MARK}:\n\t$0`),
    post("else", `if not ${EXPR_MARK}:\n\t$0`),
    post("for", `for ${"${1:item}"} in ${EXPR_MARK}:\n\t$0`),
    post("while", `while ${EXPR_MARK}:\n\t$0`),
    post("return", `return ${EXPR_MARK}`),
    post("not", `not ${EXPR_MARK}`),
    post("print", `print(${EXPR_MARK})`),
    post("var", `${"${1:name}"} = ${EXPR_MARK}`),
  ],
  lua: [
    post("if", `if ${EXPR_MARK} then\n\t$0\nend`),
    post("else", `if not ${EXPR_MARK} then\n\t$0\nend`),
    post("for", `for _, ${"${1:item}"} in ipairs(${EXPR_MARK}) do\n\t$0\nend`),
    post("while", `while ${EXPR_MARK} do\n\t$0\nend`),
    post("return", `return ${EXPR_MARK}`),
    post("not", `not ${EXPR_MARK}`),
    post("print", `print(${EXPR_MARK})`),
    post("var", `local ${"${1:name}"} = ${EXPR_MARK}`),
  ],
  c: [
    post("if", `if (${EXPR_MARK}) {\n\t$0\n}`),
    post("else", `if (!${EXPR_MARK}) {\n\t$0\n}`),
    post("while", `while (${EXPR_MARK}) {\n\t$0\n}`),
    post("return", `return ${EXPR_MARK};`),
    post("not", `!${EXPR_MARK}`),
    post("var", `${"${1:type}"} ${"${2:name}"} = ${EXPR_MARK};`),
  ],
  cpp: [
    post("if", `if (${EXPR_MARK}) {\n\t$0\n}`),
    post("else", `if (!${EXPR_MARK}) {\n\t$0\n}`),
    post("for", `for (auto &${"${1:item}"} : ${EXPR_MARK}) {\n\t$0\n}`),
    post("while", `while (${EXPR_MARK}) {\n\t$0\n}`),
    post("return", `return ${EXPR_MARK};`),
    post("not", `!${EXPR_MARK}`),
    post("var", `auto ${"${1:name}"} = ${EXPR_MARK};`),
  ],
};

/**
 * Which dialect each language id speaks.
 *
 * The keys of this map are also the document selector the provider registers
 * for, which is why it is a list of names and the reference lens is not: a
 * language either has these keywords or it does not, and no amount of asking
 * the editor would reveal how Lua spells a loop.
 */
const SPEAKS: Readonly<Record<string, keyof typeof DIALECTS>> = {
  go: "go",
  rust: "rust",
  swift: "swift",
  typescript: "js",
  typescriptreact: "js",
  javascript: "js",
  javascriptreact: "js",
  python: "python",
  lua: "lua",
  c: "c",
  cpp: "cpp",
};

/** Every language id with postfixes, for the provider's document selector. */
export const POSTFIX_LANGUAGES: readonly string[] = Object.keys(SPEAKS);

/** The postfixes for a language, or undefined when it has none. */
export function postfixesFor(languageId: string): readonly Postfix[] | undefined {
  const dialect = SPEAKS[languageId];
  return dialect === undefined ? undefined : DIALECTS[dialect];
}

/** The index of the `(` or `[` matching the bracket that closes at `close`. */
function matchingOpen(line: string, close: number): number | undefined {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const ch = line[i];
    if (ch === ")" || ch === "]") {
      depth++;
    } else if (ch === "(" || ch === "[") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return undefined;
}

/** The index of the quote opening the literal that closes at `close`. */
function matchingQuote(line: string, close: number): number | undefined {
  const quote = line[close];
  for (let i = close - 1; i >= 0; i--) {
    if (line[i] === quote && line[i - 1] !== "\\") {
      return i;
    }
  }
  return undefined;
}

/**
 * Where the expression ending at `dot` begins.
 *
 * Walks left over a member chain, taking bracket pairs and string literals
 * whole, and stops at the first thing that cannot be part of an expression --
 * an operator, a comma, a keyword boundary, the start of the line. So
 * `x + foo(a, b)[0].` yields `foo(a, b)[0]` and not the `x + ` in front of it.
 *
 * This is a text scan and nothing more. It has no idea whether the result is a
 * valid expression, and it does not need one: the worst case is a template
 * built around the wrong span, which the user sees before accepting and can
 * undo after.
 */
export function expressionStart(line: string, dot: number): number | undefined {
  let i = dot - 1;
  while (i >= 0) {
    const ch = line[i];
    if (IDENT.test(ch) || ch === ".") {
      i--;
    } else if (ch === ")" || ch === "]") {
      const open = matchingOpen(line, i);
      if (open === undefined) {
        break;
      }
      i = open - 1;
    } else if (ch === "\"" || ch === "'" || ch === "`") {
      const open = matchingQuote(line, i);
      if (open === undefined) {
        break;
      }
      i = open - 1;
    } else {
      break;
    }
  }
  const start = i + 1;
  return start < dot ? start : undefined;
}

/** The expression a postfix typed at `cursor` would wrap. */
export interface Target {
  /** Column the replacement starts at: the first character of the expression. */
  readonly start: number;
  /** The text to substitute into the template. */
  readonly expression: string;
}

/**
 * What `cursor` is positioned to expand, if anything.
 *
 * The name being typed runs from the dot to the cursor, so `foo.wh|` is a
 * target with `foo` as its expression -- the editor does the filtering from
 * there, and an empty name (right after typing the dot) offers all of them.
 */
export function postfixTarget(line: string, cursor: number): Target | undefined {
  let i = cursor;
  while (i > 0 && IDENT.test(line[i - 1])) {
    i--;
  }
  if (i === 0 || line[i - 1] !== ".") {
    return undefined;
  }
  const dot = i - 1;
  const start = expressionStart(line, dot);
  return start === undefined
    ? undefined
    : { start, expression: line.slice(start, dot) };
}

/**
 * A one-line rendering of what accepting the item would write.
 *
 * Shown next to the name in the list, because "if" alone does not say whether
 * this language wants parentheses, a `then`, or a colon -- which is the whole
 * reason the table above has seven entries.
 */
export function describe(template: string, expression: string): string {
  const filled = template.split(EXPR_MARK).join(expression);
  const plain = filled
    // Placeholders read as their default text; the tabstop markers are noise.
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    .replace(/\$0/g, "");
  const [first] = plain.split("\n");
  return plain.includes("\n") ? `${first.trimEnd()} …` : first;
}

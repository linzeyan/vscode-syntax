/**
 * Which declarations get a reference count, and what the count says.
 *
 * poly computes no references. It asks the editor, the editor asks whichever
 * provider is registered for the language -- for Go that is gopls, run by the
 * Go extension -- and this file only decides where to put the number and how
 * to word it. That distinction is what lets the feature live here at all:
 * counting an answer somebody else produced is not implementing a language
 * feature, it is handing over data already in hand.
 *
 * The consequence is that it is not a Go feature. Every language with a
 * reference provider gets the same lens, which is more than the editor manages
 * on its own -- VSCode ships a reference lens for TypeScript and for nothing
 * else.
 */

/** As much of `vscode.DocumentSymbol` as the choice below depends on. */
export interface LensSymbol {
  readonly kind: number;
  readonly children?: readonly LensSymbol[];
}

/**
 * Which way the implementation question points at a declaration.
 *
 * `textDocument/implementation` is one request with two readings, and the
 * declaration under the cursor decides which one you get. Measured against
 * gopls 0.23 (2026-09-21): asked at `type Shape interface` it answers with
 * `Circle` and `Square`, and asked at `type Circle struct` it answers with
 * `Shape`. Same for a method in either direction.
 *
 * So the count is the same query either way and only the word differs -- and
 * the word has to differ, because "2 impls" over a struct would read as "this
 * struct has two implementations", which is not a thing.
 */
export type Direction = "down" | "up";

/** A declaration that gets a lens, and which lenses it gets. */
export interface LensTarget<T extends LensSymbol> {
  readonly symbol: T;
  /**
   * Which implementation count belongs above it, if any.
   *
   * Neither question means anything over a free function or a constant, and
   * asking anyway would put a second grey word over most of the file. What is
   * left is the two halves of the same relation: an abstract declaration, whose
   * answer is who satisfies it (`down`), and a concrete type or method, whose
   * answer is what it satisfies (`up`).
   *
   * An interface and the methods declared inside one arrive as
   * `SymbolKind.Interface` with their methods as children in every language
   * measured -- Go's interface, Rust's trait, Java's and TypeScript's
   * interface. A Go method is the case that does not nest: gopls reports it at
   * the top level as `(Circle).Area` rather than as a child of `Circle`, which
   * is why `up` is decided by the symbol's own kind and not by its parent's.
   */
  readonly implementation?: Direction;
}

/** A reference location, and the declaration it might be. */
export interface At {
  readonly uri: string;
  readonly line: number;
}

/**
 * The `vscode.SymbolKind` values worth a count.
 *
 * Things another file can name. Fields and properties are deliberately absent:
 * they multiply the lens count by the size of every struct in the file, and
 * "who writes this field" is a different question from "is this type used at
 * all" -- the one a count above a declaration is asked.
 */
export const COUNTED_KINDS: ReadonlySet<number> = new Set([
  4, // Class
  5, // Method
  8, // Constructor
  9, // Enum
  10, // Interface
  11, // Function
  12, // Variable
  13, // Constant
  22, // Struct
  23, // Event
]);

/**
 * `vscode.SymbolKind.Interface`.
 *
 * 10 and not 11: the wire protocol numbers these from 1 and `vscode` from 0,
 * and vscode-languageclient subtracts one on the way in. Every number in this
 * file is on the editor's side of that subtraction.
 */
const INTERFACE = 10;

/**
 * How deep a declaration can sit and still get a lens.
 *
 * The file's own declarations, and the methods on them.
 */
const MAX_DEPTH = 2;

/**
 * The kinds whose children are declarations rather than code.
 *
 * Depth alone was the rule until 2026-09-17, and depth alone is not enough:
 * measured in a real extension host, Pylance reports a function's parameters
 * and locals as `Variable` children of the function (`value`, `total`, `obj`
 * are all depth 2), and TypeScript reports the locals of an arrow function the
 * same way -- as children of the `Variable` the arrow is assigned to, which is
 * why refusing to descend into functions by kind would still have missed them.
 * Every one of those got a `N refs` lens, which is the noise this file's own
 * comment said it was avoiding.
 *
 * So descent is an allow-list: a type can hold declarations another file names,
 * a function body holds code. `Object` is here for rust-analyzer's `impl`
 * blocks, which is where a Rust type's methods live; leaving it out would take
 * the lens off every method in the language.
 */
const CONTAINER_KINDS: ReadonlySet<number> = new Set([
  1, // Module
  2, // Namespace
  3, // Package
  4, // Class
  9, // Enum
  10, // Interface
  18, // Object
  22, // Struct
]);

/**
 * The kinds that can satisfy an interface, and so have an `up` answer.
 *
 * A function and a constant are left out on purpose: nothing implements them,
 * so every one of them would carry a permanent `no interfaces`.
 */
const CONCRETE_KINDS: ReadonlySet<number> = new Set([
  4, // Class
  5, // Method
  22, // Struct
]);

function directionFor(kind: number, insideInterface: boolean): Direction | undefined {
  if (kind === INTERFACE || insideInterface) {
    return "down";
  }
  return CONCRETE_KINDS.has(kind) ? "up" : undefined;
}

/**
 * The declarations in `symbols` that get a lens, outermost first.
 *
 * `cap` bounds a generated file -- a protobuf stub is thousands of symbols, and
 * a lens each is a wall of grey above code nobody reads. It bounds the list,
 * not the work: the editor only resolves the lenses actually on screen, which
 * is what keeps one reference query per visible declaration from becoming one
 * per declaration in the file.
 */
export function lensTargets<T extends LensSymbol>(
  symbols: readonly T[],
  cap: number,
): LensTarget<T>[] {
  const found: LensTarget<T>[] = [];
  const walk = (level: readonly T[], depth: number, insideInterface: boolean) => {
    for (const symbol of level) {
      if (found.length >= cap) {
        return;
      }
      const isInterface = symbol.kind === INTERFACE;
      if (COUNTED_KINDS.has(symbol.kind)) {
        found.push({ symbol, implementation: directionFor(symbol.kind, insideInterface) });
      }
      if (depth < MAX_DEPTH && symbol.children && CONTAINER_KINDS.has(symbol.kind)) {
        // A symbol's children are the same concrete type it is; the interface
        // cannot say so without making itself recursive in `T`, and the caller
        // wants its own type back rather than this file's view of it.
        walk(symbol.children as readonly T[], depth + 1, isInterface);
      }
    }
  };
  walk(symbols, 1, false);
  return found;
}

/** lua-language-server's kinds for a value: String, Number, Boolean, Array, Object. */
const LUA_VALUE_KINDS: ReadonlySet<number> = new Set([14, 15, 16, 17, 18]);

/**
 * lua-language-server's outline, reshaped into declarations `lensTargets` reads.
 *
 * It names a symbol's kind after the value assigned, not the declaration --
 * measured 2026-10-05: `local M = {}` is an Object, `local NAME = "x"` a
 * String, `local n = 0` a Number -- so the module table and every literal
 * constant fell outside `COUNTED_KINDS` and drew nothing. It also reports each
 * assignment as a symbol of its own: `count = count + 1` and
 * `Class.__index = Class` came back as Variables, and those were the ones that
 * did get a lens, over a line that declares nothing.
 *
 * So a value becomes a Variable, a name already seen is an assignment, and a
 * dotted name is a field write unless it is a function -- `function M.add` is
 * how a Lua module declares its exports. A method becomes a Function: Lua has
 * no interfaces, and lua-language-server declares an implementation provider,
 * so `Class:method` would otherwise be asked what it implements.
 *
 * ponytail: a table becomes a Variable, so a function written inside its
 * constructor (`return { setup = function() end }`) gets no lens of its own;
 * walk an Object's callable children if that style needs one.
 */
export function luaDeclarations<T extends LensSymbol & { readonly name: string }>(
  symbols: readonly T[],
): T[] {
  const seen = new Set<string>();
  const declared: T[] = [];
  for (const symbol of symbols) {
    const callable = symbol.kind === 11 || symbol.kind === 5; // Function, Method
    if (seen.has(symbol.name) || (!callable && /[.:]/.test(symbol.name))) {
      continue;
    }
    seen.add(symbol.name);
    if (LUA_VALUE_KINDS.has(symbol.kind)) {
      declared.push({ ...symbol, kind: 12 /* Variable */ });
    } else {
      declared.push(symbol.kind === 5 ? { ...symbol, kind: 11 } : symbol);
    }
  }
  return declared;
}

/**
 * arity's outline of an R file, cut down to what another file names.
 *
 * Measured 2026-10-06 (arity 0.22.0): every top-level assignment is a symbol of
 * its own, so `df <- df[...]` after `df <- data.frame()` is a second lens with
 * a different count, and an R script reassigns like that all the way down. The
 * first assignment is the declaration.
 *
 * And an S3 method runs through its generic -- `print(r)` reaches
 * `print.record` -- so nothing ever writes its name, arity answers with the
 * declaration alone, and the lens reads `no refs` over code that runs. A
 * package's NAMESPACE lists every one (`S3method(print, record)`), and R CMD
 * check holds it to that, so those get no lens rather than a wrong one.
 *
 * ponytail: an S3 method in a script has no NAMESPACE to say so and keeps its
 * `no refs`; S4 (`setClass`, `setGeneric`) has no symbols in arity at all.
 */
export function rDeclarations<T extends LensSymbol & { readonly name: string }>(
  symbols: readonly T[],
  namespace: string,
): T[] {
  const methods = s3Methods(namespace);
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    // arity names `%+%` with its backticks, and NAMESPACE writes it without.
    const name = symbol.name.replace(/^`(.*)`$/, "$1");
    if (seen.has(name) || methods.has(name)) {
      return false;
    }
    seen.add(name);
    return true;
  });
}

/**
 * The functions a NAMESPACE registers as S3 methods.
 *
 * `S3method(print, record)` is `print.record`; a third argument names the
 * function outright. roxygen2 quotes some generics (`"["`) and qualifies the
 * delayed ones (`dplyr::filter`), and the function is named without either.
 */
export function s3Methods(namespace: string): Set<string> {
  const bare = (arg: string) => arg.trim().replace(/^["'`](.*)["'`]$/, "$1").replace(/^\w[\w.]*::/, "");
  const methods = new Set<string>();
  for (const [, args] of namespace.matchAll(/^\s*S3method\(([^)]*)\)/gm)) {
    const [generic, cls, method] = args.split(",").map(bare);
    if (generic && cls) {
      methods.add(method || `${generic}.${cls}`);
    }
  }
  return methods;
}

/**
 * Answers about a declaration that are not the declaration itself.
 *
 * `vscode.executeReferenceProvider` asks with `includeDeclaration: true`, so
 * the symbol's own line comes back in the list. Leaving it in would put "1 ref"
 * over something nothing uses, which is the exact case the count exists to make
 * visible. An implementation provider is not supposed to name the declaration
 * back, but it costs nothing to hold both to the same rule.
 *
 * Matched by line rather than by exact position: the declaration's range as the
 * symbol provider reports it and as the reference provider reports it are the
 * same identifier in every server measured, but they are two answers to two
 * questions and only one of them has to be the identifier.
 */
export function elsewhere<T>(
  locations: readonly T[],
  declaration: At,
  where: (one: T) => At,
): T[] {
  return locations.filter((one) => {
    const at = where(one);
    return at.uri !== declaration.uri || at.line !== declaration.line;
  });
}

/** What an identifier may be made of, for the boundary test below. */
const WORD = /[\p{L}\p{N}_$]/u;

/**
 * Where `name` starts on a declaration's first line, searching from `from`.
 *
 * For the symbol shape that has no name range. A provider answering in the
 * flat `SymbolInformation` gives one range for the whole declaration, and the
 * editor copies it into `selectionRange` -- so `selectionRange.start` is where
 * the declaration starts, which is only where the name starts if nothing comes
 * before it. bash-language-server is that provider: `greet() {` begins with
 * its name and `function greet {` begins with a keyword, and a reference query
 * asked at the keyword comes back empty. Every shell function written the
 * second way read `no refs`, or drew nothing at all when the first three in a
 * file were written that way and the probe found nobody answering.
 *
 * A whole-word match, so `run` is not found inside `rerun`.
 */
export function nameStart(line: string, name: string, from: number): number | undefined {
  if (name.length === 0) {
    return undefined;
  }
  for (let at = line.indexOf(name, from); at >= 0; at = line.indexOf(name, at + 1)) {
    const before = line[at - 1];
    const after = line[at + name.length];
    if (!(before && WORD.test(before)) && !(after && WORD.test(after))) {
      return at;
    }
  }
  return undefined;
}

/**
 * A name for each declaration that survives typing.
 *
 * Not the line: every keystroke above a declaration moves it. The name, the
 * kind, and which occurrence of that pair it is, so an interface's `area` and
 * its class's `area` stay two keys and neither one takes the other's count.
 */
export function declarationKeys(symbols: readonly { name: string; kind: number }[]): string[] {
  const seen = new Map<string, number>();
  return symbols.map(({ name, kind }) => {
    const base = `${kind}:${name}`;
    const nth = seen.get(base) ?? 0;
    seen.set(base, nth + 1);
    return `${base}#${nth}`;
  });
}

/**
 * Counts already answered, reused for a while instead of asked again.
 *
 * The editor asks for every lens afresh after each edit, and without this each
 * visible lens was a reference search per burst of typing -- measured
 * 2026-09-23 at 17 reference and 6 implementation queries for five keystrokes
 * that changed no declaration, every one of them landing on gopls (twice, with
 * golang.go installed beside poly). A count is a question about the whole
 * workspace and it rarely moves because of what is being typed in this file,
 * so the answer is kept for `reuseMs` and the price is a count that can lag
 * the file by that long. A click never uses it: that asks again, because the
 * click is the one moment the answer must be current.
 */
export class Answered {
  private readonly byDocument = new Map<string, Map<string, { count: number; at: number }>>();

  constructor(
    private readonly reuseMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(document: string, key: string): number | undefined {
    const found = this.byDocument.get(document)?.get(key);
    return found && this.now() - found.at < this.reuseMs ? found.count : undefined;
  }

  set(document: string, key: string, count: number): void {
    const answers = this.byDocument.get(document) ?? new Map();
    answers.set(key, { count, at: this.now() });
    this.byDocument.set(document, answers);
  }

  /** A closed document's answers, which nothing will ask for again. */
  forget(document: string): void {
    this.byDocument.delete(document);
  }
}

/** What the reference lens says. */
export function refLabel(count: number): string {
  if (count === 0) {
    // Not "0 refs": an unused declaration is the one result here worth
    // stopping at, and a word stops the eye where a digit does not.
    return "no refs";
  }
  return count === 1 ? "1 ref" : `${count} refs`;
}

/**
 * What the implementation lens says, in whichever direction it points.
 *
 * Same shape as `refLabel` for the same reason: an interface nothing implements
 * is worth a word, not a nought. The noun is the whole difference between the
 * two readings of the one query -- see `Direction`.
 */
export function implLabel(count: number, direction: Direction): string {
  const noun = direction === "down" ? "impl" : "interface";
  if (count === 0) {
    return `no ${noun}s`;
  }
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

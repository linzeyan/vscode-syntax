/**
 * Which declarations get a reference count, and what the count says.
 *
 * poly computes no references. It asks the editor, the editor asks whichever
 * provider is registered for the language -- for Go that is poly's own proxy in
 * front of gopls -- and this file only decides where to put the number and how
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
 * How deep a declaration can sit and still get a lens.
 *
 * The file's own declarations, and the methods on them. A local inside a
 * function is deeper than that and gets nothing: its references are already on
 * screen, and a lens per local would bury the ones worth reading.
 */
const MAX_DEPTH = 2;

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
): T[] {
  const found: T[] = [];
  const walk = (level: readonly T[], depth: number) => {
    for (const symbol of level) {
      if (found.length >= cap) {
        return;
      }
      if (COUNTED_KINDS.has(symbol.kind)) {
        found.push(symbol);
      }
      if (depth < MAX_DEPTH && symbol.children) {
        // A symbol's children are the same concrete type it is; the interface
        // cannot say so without making itself recursive in `T`, and the caller
        // wants its own type back rather than this file's view of it.
        walk(symbol.children as readonly T[], depth + 1);
      }
    }
  };
  walk(symbols, 1);
  return found;
}

/**
 * References to a declaration, not counting the declaration itself.
 *
 * `vscode.executeReferenceProvider` asks with `includeDeclaration: true`, so
 * the symbol's own line comes back in the list. Leaving it in would put "1 ref"
 * over something nothing uses, which is the exact case the count exists to make
 * visible.
 *
 * Matched by line rather than by exact position: the declaration's range as the
 * symbol provider reports it and as the reference provider reports it are the
 * same identifier in every server measured, but they are two answers to two
 * questions and only one of them has to be the identifier.
 */
export function countReferences(
  locations: readonly At[],
  declaration: At,
): number {
  return locations.filter(
    (at) => at.uri !== declaration.uri || at.line !== declaration.line,
  ).length;
}

/** What the lens says. */
export function refLabel(count: number): string {
  if (count === 0) {
    // Not "0 refs": an unused declaration is the one result here worth
    // stopping at, and a word stops the eye where a digit does not.
    return "no refs";
  }
  return count === 1 ? "1 ref" : `${count} refs`;
}

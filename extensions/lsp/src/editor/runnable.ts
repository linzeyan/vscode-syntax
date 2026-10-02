/**
 * Which declaration is a program's entry point, and what poly does about it.
 *
 * poly ships no debugger. 01 D6 rules that out and the reasoning still holds:
 * a debugger is a second protocol (DAP) on top of an architecture that routes
 * LSP, Go's is already `golang.go`'s delve, and writing another would not let
 * anyone uninstall anything. `debug` therefore hands over to whatever debug
 * extension is installed, exactly as F5 does.
 *
 * `run` used to hand over too, to `workbench.action.debug.run` -- "Start
 * Without Debugging", which still goes through a debug adapter, still wants a
 * launch configuration, and still puts the debug toolbar on screen. Two
 * buttons, one behaviour, and the one labelled `run` was the one lying. So D6
 * is narrowed rather than kept: poly starts one process, the one the user just
 * pressed a button labelled `run` on, where they can read it and stop it. It
 * does not attach to it, restart it, or keep it alive past the window.
 *
 * How a file is run is not this file's to know. It is Code Runner's executor
 * maps (`poly.codeRunner.*`, read by codeRunner/executor.ts), the same table
 * Run Code reads, and `run` goes through the same engine: into the output
 * panel, or a terminal with `poly.codeRunner.runInTerminal`. The lens offers
 * `run` wherever that table has an answer; what is left here is where the
 * lens sits.
 */

/** As much of `vscode.DocumentSymbol` as the choice below depends on. */
export interface NamedSymbol {
  readonly name: string;
  readonly kind: number;
  readonly children?: readonly NamedSymbol[];
}

/** `vscode.SymbolKind.Method` and `.Function`, on the editor's side of the -1. */
const METHOD = 5;
const FUNCTION = 11;

/**
 * The kinds an entry point arrives as.
 *
 * A method as well as a function, because Java's and C#'s entry point is a
 * static method on a class rather than a free function.
 */
const CALLABLE: ReadonlySet<number> = new Set([METHOD, FUNCTION]);

/**
 * How deep one can sit.
 *
 * Two, for the same reason: `class Main { static void main(String[]) }` is the
 * entry point of every Java program and it is a child of the class.
 */
const MAX_DEPTH = 2;

/**
 * The names that mean "start here".
 *
 * Go, Rust, C, C++ and Java spell it `main`; C# spells it `Main`.
 */
const ENTRY: ReadonlySet<string> = new Set(["main", "Main"]);

/**
 * Languages whose entry point is not a declaration at all.
 *
 * Python's is `if __name__ == "__main__"`, a statement, so no symbol provider
 * reports it -- and a `def main` without that guard is a function nothing
 * calls, so putting the button there would offer to run a file that does
 * nothing. A shell script's entry point is the file: there is no declaration
 * to sit on, and `main()` is a convention some scripts follow and most do not.
 *
 * The shebang is the filter, and it is the script's own statement of intent.
 * Without one a `.sh` is usually something another script sources, and a run
 * button over a library is an offer to run nothing.
 *
 * A language in here uses only this rule: `entryPoints` is not consulted for
 * it, so a Python file does not end up with a button on `def main` as well as
 * on the guard that calls it.
 */
const TEXT_ENTRY: ReadonlyMap<string, RegExp> = new Map([
  ["python", /^if\s+__name__\s*==\s*(['"])__main__\1\s*:/m],
  ["shellscript", /^#!.*\b(?:bash|dash|ksh|zsh|sh)\b/],
]);

/** Is this a language whose entry point is found in the text? */
export function findsEntryInText(languageId: string): boolean {
  return TEXT_ENTRY.has(languageId);
}

/**
 * The line the entry point is on, for a language that has no declaration for it.
 *
 * Zero-based, and `undefined` when the file has no entry point -- which is most
 * Python files and most shell files, and is the answer that keeps the button
 * off a module nobody runs.
 */
export function entryLine(languageId: string, text: string): number | undefined {
  const pattern = TEXT_ENTRY.get(languageId);
  const found = pattern?.exec(text);
  if (!found) {
    return undefined;
  }
  // The index counts characters, and a lens wants a line. Everything before
  // the match, split -- the last piece is the matched line itself.
  return text.slice(0, found.index).split("\n").length - 1;
}

/**
 * The entry points among `symbols`.
 *
 * Name equality and not a prefix or a pattern: `TestMain` is a test harness,
 * `mainLoop` is a function that happens to start with the word, and a lens
 * offering to run either of them would be a lie the user only finds out about
 * after pressing it.
 */
export function entryPoints<T extends NamedSymbol>(symbols: readonly T[]): T[] {
  const found: T[] = [];
  const walk = (level: readonly T[], depth: number) => {
    for (const symbol of level) {
      if (CALLABLE.has(symbol.kind) && ENTRY.has(symbol.name)) {
        found.push(symbol);
      }
      if (depth < MAX_DEPTH && symbol.children) {
        walk(symbol.children as readonly T[], depth + 1);
      }
    }
  };
  walk(symbols, 1);
  return found;
}

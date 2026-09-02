/**
 * go.work, because it is the only thing that makes a reference cross a module
 * boundary.
 *
 * Measured against gopls 1.26 with two modules opened as two workspace folders,
 * `appb` requiring `liba` through a `replace` directive, asking who calls
 * `liba.Hello`:
 *
 *   two modules, replace, only liba open : []
 *   two modules, replace, both files open: []
 *   go.work over both                    : appb/main.go, appb/main.go
 *
 * So "open two projects in one window and see how they use each other" is not
 * something poly can route its way into. gopls builds one view per module and a
 * reference search stays inside it; a go.work is what makes the two one build.
 * It does not have to be a workspace folder — gopls walks up from each module
 * to find it, which is what makes a file in the common parent work.
 *
 * poly writes that file rather than analysing anything, which is the only
 * version of this feature that stays on the right side of A6.
 */

import * as path from "path";

/**
 * The deepest directory containing every one of `dirs`, or undefined when they
 * share nothing (different drives on Windows, or an empty list).
 */
export function commonRoot(dirs: readonly string[]): string | undefined {
  if (dirs.length === 0) {
    return undefined;
  }
  const split = dirs.map((dir) => path.resolve(dir).split(path.sep));
  const [first, ...rest] = split;
  let shared = first.length;
  for (const other of rest) {
    let i = 0;
    while (i < shared && i < other.length && first[i] === other[i]) {
      i++;
    }
    shared = i;
  }
  // A single leading empty segment is the filesystem root on POSIX; anything
  // shorter than that means the paths have nothing in common at all.
  if (shared === 0) {
    return undefined;
  }
  return first.slice(0, shared).join(path.sep) || path.sep;
}

/**
 * `use` entries for a go.work at `root`, in the spelling go itself writes:
 * relative, forward slashes, `./` even for a module that is the root.
 */
export function useLines(root: string, dirs: readonly string[]): string[] {
  const relative = dirs.map((dir) => {
    const rel = path.relative(root, dir).split(path.sep).join("/");
    return rel === "" ? "." : `./${rel}`;
  });
  return [...new Set(relative)].sort();
}

// There is deliberately no function here that writes the file itself. `go work
// init` does it, and it knows which `go` directive belongs in it; poly would be
// guessing. Requiring the toolchain costs nothing either -- gopls shells out to
// `go list`, so a machine without go has no cross-module references to fix.

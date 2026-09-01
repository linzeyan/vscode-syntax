/**
 * Which changed file to go to next.
 *
 * VSCode has next/previous change *within* a file
 * (`workbench.action.editor.nextChange`); what it has no command for is moving
 * to the next file that has changes at all. That is the part worth having: a
 * review pass over a branch is a walk across files, and doing it from the SCM
 * view means leaving the keyboard.
 *
 * Path order rather than the order git happens to report, because the order has
 * to be stable between two presses of the same key -- git's is not, and a
 * "next" that sometimes goes backwards is worse than no command.
 */

/**
 * The changed file to move to from `current`, or `undefined` when nothing has
 * changed.
 *
 * `current` need not be one of `files`: the common case is standing in a file
 * with no changes and asking for the next one, so an outside path lands on the
 * nearest entry in that direction rather than starting over at the beginning.
 * Wraps at both ends -- the list is a cycle, and stopping at the last entry
 * just means the key stops working with no way to tell why.
 */
export function nextChangedFile(
  files: readonly string[],
  current: string | undefined,
  direction: 1 | -1,
): string | undefined {
  const sorted = [...new Set(files)].sort();
  if (sorted.length === 0) {
    return undefined;
  }
  if (current === undefined) {
    return direction === 1 ? sorted[0] : sorted[sorted.length - 1];
  }
  const at = sorted.indexOf(current);
  if (at !== -1) {
    return sorted[(at + direction + sorted.length) % sorted.length];
  }
  // Not a changed file. `after` is the first entry past `current`, which is
  // where "next" belongs; "previous" wants the one before it.
  const after = sorted.findIndex((file) => file > current);
  if (direction === 1) {
    return after === -1 ? sorted[0] : sorted[after];
  }
  return after === -1 ? sorted[sorted.length - 1] : sorted[(after - 1 + sorted.length) % sorted.length];
}

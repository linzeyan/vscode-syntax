/**
 * Giving a chord back when another extension the user installed binds it too.
 *
 * These are the poly bindings with no language in their `when`, so they are
 * the ones that collide everywhere: `cmd+alt+v` is also
 * mushan.vscode-paste-image's paste-an-image, `cmd+alt+shift+v` quicktype's
 * paste-JSON-as-types, `alt+q` stkb.rewrap's rewrap -- where Revert and Save
 * would throw the edit away instead -- and `cmd+alt+a` an auto-approve toggle
 * in several AI assistants. (Format Document is the other one, and keeps its
 * chord: it is the editor's own Format Document chord, which it stands in
 * for.) When two extensions bind one chord, VSCode ranks each binding by its
 * position in its own manifest, a later entry winning, and only then by
 * command id; poly's sit late in its list, so, measured, installing poly
 * silently took the chord a user had installed the other extension for.
 * Matching by chord rather than by those ids covers the next extension that
 * picks the same keys. That extension is the more specific choice; poly's
 * command stays in the palette, and a `keybindings.json` entry takes the chord
 * back.
 *
 * Only extensions in poly's own extension host are visible to it: one that
 * ships only a web entry point runs in a separate worker host on the desktop,
 * and still loses its chord to poly.
 */

/** A `contributes.keybindings` entry, as a package.json writes it. */
export interface Binding {
  readonly command?: string;
  readonly key?: string;
  readonly mac?: string;
  readonly linux?: string;
  readonly win?: string;
}

/** The poly commands that yield. */
export const YIELDING = [
  "poly.extractVariable",
  "poly.inlineVariable",
  "poly.nextChangedFile",
  "poly.previousChangedFile",
  "poly.revertAndSave",
] as const;

/** The context key a yielding command's `when` reads. */
export function yieldKey(command: string): string {
  return `poly.yield.${command.slice("poly.".length)}`;
}

/**
 * The chord a binding takes on this platform, in one spelling: VSCode reads
 * `cmd+alt+v` and `alt+cmd+v` as the same keys, so the comparison has to.
 */
export function chordOf(binding: Binding, platform: string): string | undefined {
  const own = platform === "darwin" ? binding.mac : platform === "win32" ? binding.win : binding.linux;
  // Truthiness, as VSCode picks: an empty or null platform key falls back to
  // `key`, and an empty `key` binds nothing.
  const raw = own || binding.key;
  if (!raw) return undefined;
  return raw
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((part) => part.split("+").sort().join("+"))
    .join(" ");
}

/**
 * Whether VSCode registers this entry at all. Another extension's manifest is
 * not poly's to trust: VSCode skips an entry that is not an object, has no
 * string command, or sets `key`, `when` or a platform key to anything but a
 * string, and one such entry read as a binding here would throw inside poly's
 * activation and take all of poly down with it.
 */
function registers(entry: unknown): entry is Binding & { command: string } {
  if (typeof entry !== "object" || entry === null) return false;
  const fields = entry as Record<string, unknown>;
  return typeof fields.command === "string"
    && ["key", "when", "mac", "linux", "win"].every((field) => !fields[field] || typeof fields[field] === "string");
}

/**
 * For each yielding command, the extension it yields to, if any.
 *
 * The other side's `when` is not consulted: a `when` cannot be evaluated
 * outside the keybinding service, and a chord that works only some of the
 * time is worse than one that has moved to the palette.
 */
export function yieldsTo(
  own: readonly Binding[],
  others: readonly { id: string; bindings: readonly unknown[] }[],
  platform: string,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const command of YIELDING) {
    const binding = own.find((b) => b.command === command);
    const chord = binding && chordOf(binding, platform);
    if (!chord) continue;
    const taker = others.find(({ bindings }) =>
      bindings.some((b) => registers(b) && !b.command.startsWith("-") && chordOf(b, platform) === chord)
    );
    if (taker) result.set(command, taker.id);
  }
  return result;
}

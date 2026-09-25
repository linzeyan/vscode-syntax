/**
 * Giving a chord back when another extension the user installed binds it too.
 *
 * Extract and Inline Variable are the only poly bindings with no language in
 * their `when`, so they are the ones that collide everywhere: `cmd+alt+v` is
 * also mushan.vscode-paste-image's paste-an-image, and `cmd+alt+shift+v`
 * quicktype's paste-JSON-as-types. Between two extension bindings VSCode runs
 * whichever registered last, and ricky.* sorts after both -- so, measured,
 * installing poly silently took the chord a user had installed the other
 * extension for. Matching by chord rather than by those two ids covers the
 * next extension that picks the same keys. That extension is the more specific
 * choice; poly's command stays in the palette and the refactor menu, and a
 * `keybindings.json` entry takes the chord back.
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
export const YIELDING = ["poly.extractVariable", "poly.inlineVariable"] as const;

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
  const raw = own ?? binding.key;
  return raw
    ?.toLowerCase()
    .trim()
    .split(/\s+/)
    .map((part) => part.split("+").sort().join("+"))
    .join(" ");
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
  others: readonly { id: string; bindings: readonly Binding[] }[],
  platform: string,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const command of YIELDING) {
    const binding = own.find((b) => b.command === command);
    const chord = binding && chordOf(binding, platform);
    if (!chord) continue;
    const taker = others.find(({ bindings }) =>
      bindings.some((b) => b.command && !b.command.startsWith("-") && chordOf(b, platform) === chord)
    );
    if (taker) result.set(command, taker.id);
  }
  return result;
}

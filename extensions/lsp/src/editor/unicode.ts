/**
 * Characters that are not what they look like, found in a buffer as it is typed.
 *
 * The daemon's `poly/unicode-*` rules already report these, and they stay the
 * answer the Problems panel, the CLI and CI give -- `poly: ignore` and
 * poly.toml govern them and nothing here. What the rules cannot do is what
 * gremlins did: they run on open and save, and only for the languages the
 * daemon lints, so a character pasted into a `.txt` file, or looked at before
 * saving, is never shown. This is that other half.
 *
 * The table is a copy of the four in unicode.rs rather than a second opinion.
 * The unit test re-reads the Rust source and fails when the two drift, which
 * is cheaper than a request to the daemon on every keystroke and cannot
 * disagree with it for longer than one red test run.
 */

export type Rule = "invisible" | "bidi" | "space" | "lookalike";
export type Level = "error" | "warning" | "info";

export interface Suspect {
  codePoint: number;
  name: string;
  rule: Rule;
  /** The ASCII character a lookalike stands in for. */
  ascii?: string;
}

const TABLE: readonly [number, string, Rule, string?][] = [
  [0x0003, "END OF TEXT", "invisible"],
  [0x000b, "LINE TABULATION", "invisible"],
  [0x00ad, "SOFT HYPHEN", "invisible"],
  [0x061c, "ARABIC LETTER MARK", "invisible"],
  [0x180e, "MONGOLIAN VOWEL SEPARATOR", "invisible"],
  [0x200b, "ZERO WIDTH SPACE", "invisible"],
  [0x200c, "ZERO WIDTH NON-JOINER", "invisible"],
  [0x200d, "ZERO WIDTH JOINER", "invisible"],
  [0x200e, "LEFT-TO-RIGHT MARK", "invisible"],
  [0x200f, "RIGHT-TO-LEFT MARK", "invisible"],
  [0x2028, "LINE SEPARATOR", "invisible"],
  [0x2029, "PARAGRAPH SEPARATOR", "invisible"],
  [0x2060, "WORD JOINER", "invisible"],
  [0xfeff, "ZERO WIDTH NO-BREAK SPACE / BYTE ORDER MARK", "invisible"],
  [0xfffc, "OBJECT REPLACEMENT CHARACTER", "invisible"],
  [0x202a, "LEFT-TO-RIGHT EMBEDDING", "bidi"],
  [0x202b, "RIGHT-TO-LEFT EMBEDDING", "bidi"],
  [0x202c, "POP DIRECTIONAL FORMATTING", "bidi"],
  [0x202d, "LEFT-TO-RIGHT OVERRIDE", "bidi"],
  [0x202e, "RIGHT-TO-LEFT OVERRIDE", "bidi"],
  [0x2066, "LEFT-TO-RIGHT ISOLATE", "bidi"],
  [0x2067, "RIGHT-TO-LEFT ISOLATE", "bidi"],
  [0x2068, "FIRST STRONG ISOLATE", "bidi"],
  [0x2069, "POP DIRECTIONAL ISOLATE", "bidi"],
  [0x00a0, "NO-BREAK SPACE", "space"],
  [0x1680, "OGHAM SPACE MARK", "space"],
  [0x2000, "EN QUAD", "space"],
  [0x2001, "EM QUAD", "space"],
  [0x2002, "EN SPACE", "space"],
  [0x2003, "EM SPACE", "space"],
  [0x2004, "THREE-PER-EM SPACE", "space"],
  [0x2005, "FOUR-PER-EM SPACE", "space"],
  [0x2006, "SIX-PER-EM SPACE", "space"],
  [0x2007, "FIGURE SPACE", "space"],
  [0x2008, "PUNCTUATION SPACE", "space"],
  [0x2009, "THIN SPACE", "space"],
  [0x200a, "HAIR SPACE", "space"],
  [0x202f, "NARROW NO-BREAK SPACE", "space"],
  [0x205f, "MEDIUM MATHEMATICAL SPACE", "space"],
  [0x3000, "IDEOGRAPHIC SPACE", "space"],
  [0x037e, "GREEK QUESTION MARK", "lookalike", ";"],
  [0x2010, "HYPHEN", "lookalike", "-"],
  [0x2011, "NON-BREAKING HYPHEN", "lookalike", "-"],
  [0x2012, "FIGURE DASH", "lookalike", "-"],
  [0x2013, "EN DASH", "lookalike", "-"],
  [0x2015, "HORIZONTAL BAR", "lookalike", "-"],
  [0x2018, "LEFT SINGLE QUOTATION MARK", "lookalike", "'"],
  [0x2019, "RIGHT SINGLE QUOTATION MARK", "lookalike", "'"],
  [0x201a, "SINGLE LOW-9 QUOTATION MARK", "lookalike", "'"],
  [0x201b, "SINGLE HIGH-REVERSED-9 QUOTATION MARK", "lookalike", "'"],
  [0x201c, "LEFT DOUBLE QUOTATION MARK", "lookalike", "\""],
  [0x201d, "RIGHT DOUBLE QUOTATION MARK", "lookalike", "\""],
  [0x201e, "DOUBLE LOW-9 QUOTATION MARK", "lookalike", "\""],
  [0x201f, "DOUBLE HIGH-REVERSED-9 QUOTATION MARK", "lookalike", "\""],
  [0x2032, "PRIME", "lookalike", "'"],
  [0x2033, "DOUBLE PRIME", "lookalike", "\""],
  [0x2044, "FRACTION SLASH", "lookalike", "/"],
  [0x2215, "DIVISION SLASH", "lookalike", "/"],
];

export const SUSPECTS: ReadonlyMap<number, Suspect> = new Map(
  TABLE.map(([codePoint, name, rule, ascii]) => [codePoint, { codePoint, name, rule, ascii }]),
);

// Every entry is in the BMP, so one UTF-16 unit is one character and a match
// index is already the offset `TextDocument.positionAt` takes.
const ANY = new RegExp(
  `[${[...SUSPECTS.keys()].map((cp) => `\\u${cp.toString(16).padStart(4, "0")}`).join("")}]`,
  "g",
);

/**
 * gremlins' severity for the characters gremlins lists, so someone who
 * uninstalled it for poly reads the same colour on the same character. Only
 * the four that differ from their rule's level are spelled out; the rest of
 * gremlins' defaults already agree with the rule they fall under.
 */
const GREMLINS_LEVELS: ReadonlyMap<number, Level> = new Map<number, Level>([
  [0x0003, "warning"],
  [0x000b, "warning"],
  [0x00ad, "info"],
  [0x200c, "warning"],
]);

/**
 * Each rule's level where gremlins has no say, ranked by what the character
 * can do: a bidi control rewrites what a reviewer sees, an invisible one
 * breaks a comparison silently, a lookalike is usually a paste from a word
 * processor, and an odd space is mostly harmless outside a tokenizer.
 */
const RULE_LEVELS: Readonly<Record<Rule, Level>> = {
  bidi: "error",
  invisible: "error",
  lookalike: "warning",
  space: "info",
};

export function levelOf(suspect: Suspect): Level {
  return GREMLINS_LEVELS.get(suspect.codePoint) ?? RULE_LEVELS[suspect.rule];
}

/**
 * Whether the character draws nothing, so it has to be outlined rather than
 * filled -- a background on something zero-width is zero pixels wide.
 */
export function drawsNothing(suspect: Suspect): boolean {
  return suspect.rule === "invisible" || suspect.rule === "bidi";
}

export interface Found {
  offset: number;
  suspect: Suspect;
}

/**
 * Every suspect character in `text`, with its UTF-16 offset.
 *
 * A byte order mark at offset 0 is skipped, as unicode.rs skips it: it is an
 * encoding marker there, and junk anywhere else.
 */
export function findSuspects(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(ANY)) {
    if (match.index === 0 && match[0] === "\ufeff") {
      continue;
    }
    found.push({ offset: match.index, suspect: SUSPECTS.get(match[0].charCodeAt(0))! });
  }
  return found;
}

/** The code point and the name: what it is, and what to search for. */
export function nameOf(suspect: Suspect): string {
  return `U+${suspect.codePoint.toString(16).toUpperCase().padStart(4, "0")} ${suspect.name}`;
}

/**
 * What the end of a line says about the suspects on it: each one's name, once,
 * in the order they appear.
 *
 * Once, because a line of prose carries its curly quotes in pairs and fours,
 * and the fill already shows where each one is -- the label only has to say
 * what they are.
 */
export function label(suspects: readonly Suspect[]): string {
  return [...new Set(suspects)].map(nameOf).join(" · ");
}

/**
 * What the hover says: the character's name, which the Problems entry does
 * not carry, and the same claim the daemon's rule makes about it.
 */
export function explain(suspect: Suspect): string {
  const id = nameOf(suspect);
  switch (suspect.rule) {
    case "bidi":
      return `${id} reorders how the rest of this line is displayed without changing what is compiled`;
    case "invisible":
      return `${id} does not render as what it is`;
    case "space":
      return `${id} looks like a space and is not one, so nothing splitting on whitespace will split here`;
    case "lookalike":
      return `${id} reads as \`${suspect.ascii}\` and is not \`${suspect.ascii}\``;
  }
}

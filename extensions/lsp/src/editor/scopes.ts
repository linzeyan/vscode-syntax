/**
 * The TextMate scopes a grammar can produce, and a sheet to recolour them from.
 *
 * VSCode has no contribution point for turning one grammar off, and none for
 * changing what a grammar paints either -- colour comes from the theme, and a
 * theme addresses tokens by scope. So the answer to "let me set the highlight
 * colours" is `editor.tokenColorCustomizations.textMateRules`, which has been
 * there all along and is unusable for one reason: nobody knows the scope names.
 * `Developer: Inspect Editor Tokens and Scopes` tells you the one under the
 * cursor, one token at a time. This produces the whole list for a language at
 * once, which is the part that was missing.
 */

/**
 * Every scope name in a parsed tmLanguage, deduplicated and sorted.
 *
 * A walk rather than a schema, because the shape is recursive in several
 * directions at once: `patterns` nest, `repository` holds named rules that hold
 * more patterns, and the four capture maps are keyed by capture number. Every
 * one of them can carry a `name`.
 *
 * Two things are deliberately left out. The grammar's own top-level `name` is
 * its display name -- "Solidity", not a scope -- so the walk starts below it.
 * And a scope containing `$` is a template filled in from a capture group
 * (`entity.name.tag.$2.html`), which is not a scope anybody can write a theme
 * rule for; the ones it expands to are not knowable without tokenizing a file.
 */
export function scopesIn(grammar: unknown): string[] {
  const found = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    // TextMate allows several scopes in one `name`, separated by spaces.
    for (const scope of value.split(/\s+/)) {
      if (scope && !scope.includes("$")) {
        found.add(scope);
      }
    }
  };
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child);
      }
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "name" || key === "contentName") {
        add(value);
      } else {
        walk(value);
      }
    }
  };
  if (grammar && typeof grammar === "object") {
    const { name: _display, ...rest } = grammar as Record<string, unknown>;
    walk(rest);
    // The root scope is not in any rule but is the one a theme uses to say
    // "everything in this language", so it belongs on the sheet.
    add((grammar as Record<string, unknown>).scopeName);
  }
  return [...found].sort();
}

/** The placeholder every rule carries, so nothing changes until it is edited. */
const PLACEHOLDER = "#RRGGBB";

/**
 * A `poly.syntaxColors` object covering `scopes`, as a document to copy out of.
 *
 * A document rather than a write into settings.json. Writing would mean putting
 * several hundred entries into somebody's settings on one keystroke and leaving
 * them to delete the ones they did not want, and a file that big is no longer
 * reviewable -- the point of the sheet is to pick a handful of scopes off it.
 *
 * The placeholder is not a colour. Pasted unedited it is ignored, which is the
 * right way for this to fail: no entry can quietly recolour something because
 * the default got left in.
 */
export function colorSheet(language: string, source: string, scopes: string[]): string {
  const entries = scopes
    .map((scope) => `    ${JSON.stringify(scope)}: "${PLACEHOLDER}"`)
    .join(",\n");
  return `// Every TextMate scope the \`${language}\` grammar can produce.
// Grammar: ${source}
//
// Copy the scopes you want into "poly.syntaxColors" in your user settings,
// replacing ${PLACEHOLDER} with a colour, optionally followed by bold, italic,
// underline or strikethrough. Anything left as ${PLACEHOLDER} is not a colour
// and is ignored, so nothing changes until you edit it.
//
// A longer scope wins over a shorter one, so "comment.line.double-slash" beats
// "comment". Your colours win over the theme's.
//
// poly does not paint anything itself: the grammar names the tokens and the
// theme colours them. There is also no way to switch one grammar off -- VSCode
// registers them statically, so the only off switch is disabling the extension.
{
  "poly.syntaxColors": {
${entries}
  }
}
`;
}

/** What one `textMateRules` entry sets. */
export interface TokenStyle {
  foreground?: string;
  fontStyle?: string;
}

const COLOR = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FONT_STYLES = new Set(["bold", "italic", "underline", "strikethrough"]);

/**
 * A style as typed into `Set Syntax Color`: `#C586C0`, `#C586C0 italic`,
 * `bold underline`.
 *
 * One line rather than a colour prompt and then a style prompt, because most
 * answers are a colour alone and a second prompt would be a question asked
 * every time for the sake of the occasional italic. `null` is an empty answer,
 * which takes the rule away. A string is what was wrong with the input, for the
 * input box to show while it is being typed.
 */
export function parseStyle(text: string): TokenStyle | null | string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return null;
  }
  const style: TokenStyle = {};
  const fonts: string[] = [];
  for (const word of words) {
    if (COLOR.test(word) && !style.foreground) {
      style.foreground = word;
    } else if (FONT_STYLES.has(word.toLowerCase())) {
      fonts.push(word.toLowerCase());
    } else {
      return `"${word}" is not a colour like #C586C0, nor bold, italic, underline or strikethrough`;
    }
  }
  if (fonts.length > 0) {
    style.fontStyle = fonts.join(" ");
  }
  return style;
}

/** A style written back the way `parseStyle` reads it. */
export function styleText(style: TokenStyle): string {
  return [style.foreground, style.fontStyle].filter(Boolean).join(" ");
}

/**
 * The `name` on every `textMateRules` entry made from `poly.syntaxColors`.
 *
 * It is how the next sync tells its own rules from the user's: everything
 * carrying it is rebuilt from the setting, everything else is somebody's own
 * and left where it is. Named after the setting so that whoever reads it in
 * settings.json knows where to make the change instead.
 */
export const SYNTAX_COLORS_RULE = "poly.syntaxColors";

/**
 * `customizations` with poly's rules rebuilt from `colors`, or `undefined`
 * when they already match and nothing needs writing.
 *
 * `poly.syntaxColors` exists because a colour should be one line --
 * `"comment": "#6A9955 italic"` -- where `editor.tokenColorCustomizations`
 * wants a textMateRules entry for it. But the theme only reads the latter, and
 * no API colours a token any other way, so the setting is mirrored into it.
 *
 * Everything not carrying `SYNTAX_COLORS_RULE` is carried over untouched: the
 * user's own rules, the shorthand keys (`comments`, `keywords`) and the
 * per-theme blocks (`"[Dark+]"`). poly's rules go last, so for the same scope
 * they win over a hand-written one, as the setting being the newer word on it
 * says they should. A value that does not parse is left out rather than
 * guessed at -- the setting's schema already marks it in the editor.
 */
export function withSyntaxColors(
  customizations: unknown,
  colors: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const base = customizations && typeof customizations === "object" && !Array.isArray(customizations)
    ? customizations as Record<string, unknown>
    : {};
  const rules = Array.isArray(base.textMateRules) ? base.textMateRules : [];
  const kept = rules.filter((one) => one?.name !== SYNTAX_COLORS_RULE);
  const ours = Object.entries(colors).flatMap(([scope, text]) => {
    const style = typeof text === "string" ? parseStyle(text) : null;
    return style && typeof style === "object" ? [{ name: SYNTAX_COLORS_RULE, scope, settings: style }] : [];
  });
  const next = [...kept, ...ours];
  if (JSON.stringify(next) === JSON.stringify(rules)) {
    return undefined;
  }
  return { ...base, textMateRules: next };
}

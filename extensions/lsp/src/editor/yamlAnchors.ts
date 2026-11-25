/**
 * YAML's anchors and the aliases that repeat them.
 *
 * What Go to Definition on `*base`, Find All References and the `N refs` lens
 * over `&base` are answered from. Nothing else in the editor answers them: its
 * own YAML support is a grammar.
 *
 * Read here, in the editor, and not by the daemon that reads GraphQL, nginx,
 * Makefile and shell names (`poly_engines::symbols`). Two reasons, both
 * measured 2026-11-25:
 *
 * - The daemon's YAML parser gives a tree for a whole valid file or nothing.
 *   `use: *` -- an alias one keystroke in -- an unclosed `[` and a Helm
 *   template's `{{- if }}` line each cost the file every answer, so the lens
 *   would blink out while an alias is being typed and a chart would never have
 *   one. This reads the lexer's tokens, which have no notion of a file being
 *   wrong.
 * - An anchor never leaves its file, so the folder the daemon walks for the
 *   other languages has nothing to add.
 */

import { CST, Lexer } from "yaml";

/** One `&name` or `*name`, by its offsets in the text, sigil included. */
export interface AnchorMention {
  readonly start: number;
  readonly end: number;
  /** Where the `&name` this one is starts: an anchor's own `start`. */
  readonly anchor: number;
}

/**
 * Every anchor in `text`, and every alias that has one to repeat.
 *
 * An alias is the anchor of its name written last above it in the same
 * document: YAML's own rule (1.2.2 §7.1), not a guess at scope. So a name
 * anchored twice is two things, each with the aliases below it, and `---`
 * starts over -- matched by name alone, the `&defaults` of every document in
 * a multi-document file would count each other's aliases.
 *
 * An alias with no anchor above it is left out: there is nowhere to go from it
 * and nothing it counts towards.
 */
export function anchorMentions(text: string): AnchorMention[] {
  const found: AnchorMention[] = [];
  /** The last anchor of each name, in the document being read. */
  const anchors = new Map<string, number>();
  let offset = 0;
  let inScalar = false;
  // The lexer hands the text back in pieces, in order, between markers that
  // are not text and take up no room in it.
  for (const lexeme of new Lexer().lex(text)) {
    if (inScalar) {
      // A scalar's content, whatever it begins with: a block scalar's `*.log`
      // line is not an alias, and this is what keeps the shell under a
      // workflow's `run: |` from being read as one.
      inScalar = false;
    } else if (lexeme === CST.SCALAR) {
      inScalar = true;
      continue;
    } else if (lexeme === CST.DOCUMENT) {
      anchors.clear();
      continue;
    } else if (lexeme === CST.FLOW_END) {
      continue;
    } else if (lexeme === "---" || lexeme === "...") {
      anchors.clear();
    } else if (lexeme.length > 1 && lexeme[0] === "&") {
      anchors.set(lexeme.slice(1), offset);
      found.push({ start: offset, end: offset + lexeme.length, anchor: offset });
    } else if (lexeme.length > 1 && lexeme[0] === "*") {
      const anchor = anchors.get(lexeme.slice(1));
      if (anchor !== undefined) {
        found.push({ start: offset, end: offset + lexeme.length, anchor });
      }
    }
    offset += lexeme.length;
  }
  return found;
}

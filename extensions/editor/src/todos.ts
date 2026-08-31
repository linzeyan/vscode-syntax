/**
 * TODO-style markers in a file.
 *
 * Uppercase and word-bounded is the whole rule. Anything smarter would need to
 * know each language's comment syntax, and the failure mode of getting that
 * wrong is a marker that exists and is not listed -- which is worse than
 * listing one that happens to live inside a string.
 */

export interface Todo {
  /** Zero-based, ready for a Position. */
  line: number;
  column: number;
  tag: string;
  /** What follows the tag, with the comment's own closing punctuation removed. */
  text: string;
}

export const DEFAULT_TAGS = ["TODO", "FIXME", "HACK", "XXX", "BUG"] as const;

/** Closing punctuation that belongs to the comment, not to the message. */
const CLOSERS = /\s*(?:\*\/|-->|"""|'''|--}}|\*\)|\}\})\s*$/;

export function findTodos(source: string, tags: readonly string[]): Todo[] {
  const usable = tags.filter((tag) => /^[A-Za-z][\w-]*$/.test(tag));
  if (usable.length === 0) {
    return [];
  }
  // Escaping is unnecessary because the filter above already rejected
  // everything that is not a word -- a tag list is a list of words.
  const pattern = new RegExp(`\\b(${usable.join("|")})\\b:?[ \\t]*(.*)$`);

  const found: Todo[] = [];
  source.split(/\r?\n/).forEach((text, line) => {
    const match = pattern.exec(text);
    if (!match) {
      return;
    }
    found.push({
      line,
      column: match.index,
      tag: match[1],
      text: match[2].replace(CLOSERS, "").trim(),
    });
  });
  return found;
}

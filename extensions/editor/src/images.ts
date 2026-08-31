/**
 * Image references in a line of any language.
 *
 * Deliberately not a parser: markdown, HTML, CSS and a bare string literal all
 * spell a path differently, and none of them spells it wrongly enough to
 * matter here. What decides whether a match is real is whether the file is
 * there -- so the pattern stays loose and the filesystem does the filtering.
 * A false match costs one `stat`; a missed one costs the feature.
 */

export interface ImageReference {
  /** Character offsets into the line. */
  start: number;
  end: number;
  /** As written: relative, absolute, or something that is neither. */
  path: string;
}

// No `:` in the class, so a URL contributes only its path part -- which will
// not resolve on disk, which is the answer we wanted anyway. The trailing
// guard is what stops `.png` matching inside `a.pngx`.
const IMAGE = /[\w.~@/\\-]+\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif)(?![A-Za-z0-9])/gi;

export function imageReferences(line: string): ImageReference[] {
  const found: ImageReference[] = [];
  for (const match of line.matchAll(IMAGE)) {
    const start = match.index ?? 0;
    found.push({ start, end: start + match[0].length, path: match[0] });
  }
  return found;
}

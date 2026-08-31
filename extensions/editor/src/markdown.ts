/**
 * Markdown structure, parsed here rather than asked of VSCode.
 *
 * `executeDocumentSymbolProvider` would answer the same question, but only
 * once the built-in markdown extension has activated, and an empty answer
 * from a provider that is not ready yet looks exactly like a document with no
 * headings -- which would silently produce an empty table of contents. The
 * rules below are small enough to own, and owning them is what makes them
 * testable without an extension host.
 */

/** Marks the block `insertToc` owns, so running it twice updates in place. */
export const TOC_START = "<!-- poly:toc -->";
export const TOC_END = "<!-- /poly:toc -->";

/**
 * H1 is left out on purpose: it is the document's own title, and a table of
 * contents sitting under it does not need a link back up to it.
 */
const MIN_LEVEL = 2;

export interface Heading {
  level: number;
  text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;

/** ATX headings, skipping the two places a `#` is not one. */
export function headings(source: string): Heading[] {
  const lines = source.split(/\r?\n/);
  const found: Heading[] = [];
  let i = 0;

  // YAML front matter is metadata, not content. A `# comment` in it is a
  // comment, and reading it as a heading puts the file's own front matter at
  // the top of its table of contents.
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i].trim() !== "---") {
      i++;
    }
    i++;
  }

  let fence: string | undefined;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const marker = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      // A fence closes on the same character, at least as long as the one
      // that opened it -- which is what lets a ```` block contain a ``` one.
      const closes = marker !== undefined
        && marker[0] === fence[0]
        && marker.length >= fence.length
        && line.trim() === marker;
      if (closes) {
        fence = undefined;
      }
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    const atx = ATX.exec(line);
    if (!atx) {
      continue;
    }
    // A closing run of # is decoration, not part of the text.
    const text = (atx[2] ?? "").replace(/\s+#+\s*$/, "").trim();
    if (text) {
      found.push({ level: atx[1].length, text });
    }
  }
  return found;
}

/**
 * The punctuation VSCode's slugifier drops, transcribed character for
 * character from the one its markdown preview ships
 * (markdown-language-features, 1.135). Underscore is deliberately not in it:
 * VSCode keeps snake_case intact.
 */
const PUNCTUATION =
  /[\]\[!\/'"#$%&()*+,.:;<=>?@\\^{|}~`。，、；：？！…—·ˉ¨‘’“”々～‖∶＂＇｀｜〃〔〕〈〉《》「」『』．〖〗【】（）［］｛｝]/g;

/** Emphasis written with underscores, which `PUNCTUATION` would otherwise keep. */
const UNDERSCORE_EMPHASIS = /(^|\s)_{1,2}([^_]+)_{1,2}(?=\s|$)/g;

/**
 * A heading's anchor, by VSCode's rule rather than an approximation of it.
 *
 * Matching the editor exactly is the whole point: a table of contents whose
 * links do not resolve in the thing that wrote them is worse than none, and
 * VSCode's preview is the one renderer that is always present.
 *
 * GitHub's slugger is close but not identical -- they disagree about some
 * full-width punctuation -- so a document that has to navigate correctly in
 * both wants ASCII headings. That is not something this command can fix.
 */
export function slug(text: string): string {
  return linkText(text)
    .replace(UNDERSCORE_EMPHASIS, "$1$2")
    .toLowerCase()
    // Whitespace collapses before punctuation is dropped, which is why a run
    // of spaces becomes one hyphen but a dropped em dash between two spaces
    // leaves two.
    .replace(/\s+/g, "-")
    .replace(PUNCTUATION, "")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/**
 * Heading text as a reader sees it: a link contributes its label, not its
 * target. Emphasis markers stay -- they render, and the entry should look like
 * the heading it points at.
 */
function linkText(text: string): string {
  return text.replace(LINK, "$1").trim();
}

/**
 * The table of contents for `source`, one markdown list item per line.
 *
 * Empty when the document has no headings below H1 -- the caller says so out
 * loud rather than writing an empty block nobody can interpret.
 */
export function toc(source: string): string[] {
  const all = headings(source);
  // Anchors are deduplicated across the whole document, including the H1 this
  // list leaves out: GitHub numbers repeats in document order, so skipping a
  // heading here would shift every later suffix.
  const seen = new Map<string, number>();
  const anchored = all.map((heading) => {
    const base = slug(heading.text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { heading, anchor: count === 0 ? base : `${base}-${count}` };
  });

  const listed = anchored.filter(({ heading }) => heading.level >= MIN_LEVEL);
  if (listed.length === 0) {
    return [];
  }
  // Indent relative to the shallowest heading present, so a document whose
  // sections start at H3 does not open with six spaces of nothing.
  const top = Math.min(...listed.map(({ heading }) => heading.level));
  return listed.map(({ heading, anchor }) =>
    `${"  ".repeat(heading.level - top)}- [${linkText(heading.text)}](#${anchor})`
  );
}

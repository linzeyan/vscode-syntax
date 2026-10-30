/**
 * What Paste as Types decides before quicktype runs and after it answers:
 * which languages a document is offered, whether a paste is worth loading
 * quicktype for, and where Go output goes in a file that already has a
 * package clause. Apart from pasteTypes.ts so node's own runner tests it.
 */

/**
 * quicktype's targets by VSCode language id, the document's own language
 * first. Its other targets are a command away (Paste as Types picks from all
 * of them); these are what the paste widget offers without asking.
 */
export const LANGUAGE_TARGETS: Readonly<Record<string, readonly string[]>> = {
  go: ["go"],
  typescript: ["typescript", "typescript-zod", "typescript-effect-schema"],
  typescriptreact: ["typescript", "typescript-zod", "typescript-effect-schema"],
  javascript: ["javascript", "javascript-prop-types", "flow"],
  javascriptreact: ["javascript", "javascript-prop-types", "flow"],
  rust: ["rust"],
  python: ["python"],
  java: ["java"],
  kotlin: ["kotlin"],
  csharp: ["cs"],
  cpp: ["c++"],
  c: ["cjson"],
  "objective-c": ["objc"],
  swift: ["swift"],
  dart: ["dart"],
  elixir: ["elixir"],
  elm: ["elm"],
  haskell: ["haskell"],
  php: ["php"],
  ruby: ["ruby"],
  scala: ["scala3"],
  crystal: ["crystal"],
  pike: ["pike"],
  smithy: ["smithy4a"],
  json: ["schema"],
  jsonc: ["schema"],
};

/**
 * Worth loading quicktype to find out: it starts like JSON, or some line opens
 * like a YAML mapping key or a TOML table or assignment.
 *
 * A false yes costs one bundle load, a false no costs the feature, so this is
 * loose; `sourceOf` is the one that decides.
 */
export function mightBeData(text: string): boolean {
  return /^\s*[[{]/.test(text) || /^\s*[\w"'-]+\s*:(\s|$)/m.test(text) || looksLikeToml(text);
}

/**
 * Whether TOML's reader -- transform's 17 MB wasm -- is worth loading.
 *
 * Its first line of content opens a table, or assigns a literal: a string, a
 * number, a boolean, an array or an inline table. `x = foo()`, the usual shape
 * of a pasted statement, is no TOML, and a pasted `x = 1` that is code is
 * turned away by the reader rather than here.
 */
export function looksLikeToml(text: string): boolean {
  const first = text.split("\n").find((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  if (first === undefined) return false;
  return /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(first)
    || /^\s*[\w"'.-]+\s*=\s*(["'[{+-]|\d|true\b|false\b|inf\b|nan\b)/.test(first);
}

/** Go output placed in a file: what goes at the cursor, and the imports that go up top. */
export interface GoPlacement {
  readonly body: string;
  /** Inserted at the start of `line`, or nothing to add. */
  readonly imports?: { readonly line: number; readonly text: string };
}

const IMPORT_PATH = /"[^"]+"/;

/**
 * quicktype's Go into a file that is already a Go file.
 *
 * Its output is a file: a package clause (in code mode) and `import "time"`
 * before the types. Pasted at a cursor below other declarations, both are
 * syntax errors -- imports must come first and a file has one package. So the
 * clause is dropped and the imports join the file's own, after its last import
 * declaration or else its package clause, minus any it already has. Into an
 * empty file the output goes whole: it is the file.
 */
export function placeGo(output: string, file: string): GoPlacement {
  const fileLines = file.split("\n");
  const clause = fileLines.findIndex((line) => /^package\s/.test(line));
  if (clause === -1) return { body: output };

  const imports: string[] = [];
  const body: string[] = [];
  let inBlock = false;
  for (const line of output.split("\n")) {
    if (inBlock) {
      if (/^\)/.test(line)) inBlock = false;
      else if (IMPORT_PATH.test(line)) imports.push(line.trim());
    } else if (/^import\s*\($/.test(line)) {
      inBlock = true;
    } else if (/^import\s/.test(line)) {
      imports.push(line.replace(/^import\s+/, "").trim());
    } else if (!/^package\s/.test(line)) {
      // The lines that separated what was taken out would otherwise pile up.
      if (line.trim() !== "" || body[body.length - 1]?.trim() !== "") body.push(line);
    }
  }
  while (body.length && body[0].trim() === "") body.shift();
  while (body.length && body[body.length - 1].trim() === "") body.pop();

  // The file's imports, and the line its import section ends on.
  const have = new Set<string>();
  let last = clause;
  for (let i = clause + 1; i < fileLines.length; i++) {
    const line = fileLines[i];
    if (/^import\s*\(/.test(line)) {
      for (i++; i < fileLines.length && !/^\)/.test(fileLines[i]); i++) {
        const path = IMPORT_PATH.exec(fileLines[i]);
        if (path) have.add(path[0]);
      }
      last = i;
    } else if (/^import\s/.test(line)) {
      const path = IMPORT_PATH.exec(line);
      if (path) have.add(path[0]);
      last = i;
    }
  }
  const missing = imports.filter((spec) => !have.has(IMPORT_PATH.exec(spec)?.[0] ?? ""));
  const text = `${body.join("\n")}\n`;
  if (missing.length === 0) return { body: text };
  const added = missing.map((spec) => `import ${spec}\n`).join("");
  // Right after the clause, a blank line keeps gofmt's spacing.
  return { body: text, imports: { line: last + 1, text: last === clause ? `\n${added}` : added } };
}

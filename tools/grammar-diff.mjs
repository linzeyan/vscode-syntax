#!/usr/bin/env node
// Differential highlight check: the same fixture, tokenized twice -- once by the
// grammar poly ships and once by the grammar of the extension poly took it over
// from -- asserting poly never colours *less* than the thing it replaced.
//
// tokenize-check.mjs asks "did this grammar engage at all", which stays green
// when a takeover silently drops a scope the built-in had. The only way to see
// that is to run both and compare, which is what D5 promised: taking a built-in
// over swaps the grammar's source, not its output.
//
// What fails is decided in two steps, because poly pins its own upstream sha
// and deliberately runs ahead of whatever VSCode shipped:
//
//   - the grammar file itself is identical to the built-in's -- then the two
//     have to tokenize the same, and any scope only the built-in produced is
//     poly's packaging changing the answer (an injection reaching a language
//     nobody meant it to reach, a lost embeddedLanguages map). That fails.
//   - the grammar file differs -- upstream moved, and a re-scoped token is what
//     an upstream improvement looks like. Reported as drift for review.
//
// Extra scopes are never a failure: adding mermaid inside a markdown fence is
// the point of an injection.
//
// Usage: node tools/grammar-diff.mjs <node_modules_dir> [vscode_extensions_dir]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NM = process.argv[2];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extensions", "lsp");
const FIXTURES = join(ROOT, "grammars", "fixtures");
const EDGE = join(FIXTURES, "edge");
const BUILTIN = process.argv[3] || "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";

if (!NM) {
  console.error("usage: node tools/grammar-diff.mjs <node_modules_dir> [vscode_extensions_dir]");
  process.exit(2);
}
if (!existsSync(BUILTIN)) {
  console.error(`no built-in extensions at ${BUILTIN}`);
  console.error("pass the path as the second argument -- VSCode has to be installed to compare");
  process.exit(2);
}

const vsctmMod = await import(pathToFileURL(join(NM, "vscode-textmate", "release", "main.js")));
const onigMod = await import(pathToFileURL(join(NM, "vscode-oniguruma", "release", "main.js")));
const vsctm = vsctmMod.default ?? vsctmMod;
const oniguruma = onigMod.default ?? onigMod;
const wasm = readFileSync(join(NM, "vscode-oniguruma", "release", "onig.wasm"));
const onigLib = oniguruma.loadWASM(wasm.buffer).then(() => ({
  createOnigScanner: (s) => new oniguruma.OnigScanner(s),
  createOnigString: (s) => new oniguruma.OnigString(s),
}));

// ── the two sides ──────────────────────────────────────────────────────────

/**
 * Every grammar and language one set of manifests declares, plus a registry.
 *
 * `painted` is the theme to resolve colors against, and it belongs to the
 * constructor rather than to `setTheme` because a registry caches the style it
 * already worked out for a grammar. Handing the theme in later leaves the
 * grammars loaded so far holding color ids from a map that no longer exists,
 * which reads out as a token with no color at all.
 */
function side(manifests, painted, without = new Set()) {
  const grammars = new Map(); // scopeName -> { path, meta }
  const injections = new Map(); // target scope -> [scopeName]
  const languages = new Map(); // language id -> { configuration, extensions, filenames, patterns }
  // language id -> scopeName, last registration winning, which is what VSCode
  // does: the cpp extension lists `source.cpp.embedded.macro` for language
  // `cpp` before `source.cpp`, and a .cpp file opens with the latter.
  const scopeOfLanguage = new Map();
  for (const { dir, pkg } of manifests) {
    for (const g of pkg.contributes?.grammars ?? []) {
      if (g.scopeName && g.path) grammars.set(g.scopeName, { path: join(dir, g.path), meta: g });
      if (g.language && g.scopeName) scopeOfLanguage.set(g.language, g.scopeName);
      for (const target of g.injectTo ?? []) {
        if (!injections.has(target)) injections.set(target, []);
        injections.get(target).push(g.scopeName);
      }
    }
    for (const l of pkg.contributes?.languages ?? []) {
      // A language id can be declared by more than one extension, each adding
      // associations; merge rather than letting the last one read win.
      const prev = languages.get(l.id) ?? {};
      languages.set(l.id, {
        configuration: l.configuration ? join(dir, l.configuration) : prev.configuration,
        extensions: [...(prev.extensions ?? []), ...(l.extensions ?? [])],
        filenames: [...(prev.filenames ?? []), ...(l.filenames ?? [])],
        patterns: [...(prev.patterns ?? []), ...(l.filenamePatterns ?? [])],
      });
    }
  }
  const registry = new vsctm.Registry({
    onigLib,
    ...(painted ? { theme: painted } : {}),
    // vscode-textmate declares this Promise-returning, so the `async` is the
    // interface rather than an oversight.
    // poly: ignore deno_lint/require-await
    loadGrammar: async (scopeName) => {
      const entry = grammars.get(scopeName);
      if (!entry) return null; // an embedded scope this side does not bundle
      return vsctm.parseRawGrammar(readFileSync(entry.path, "utf8"), entry.path);
    },
    getInjections: (scopeName) => (injections.get(scopeName) ?? []).filter((scope) => !without.has(scope)),
  });
  return { grammars, languages, scopeOfLanguage, injections, registry };
}

const polyManifests = [
  { dir: EXT, pkg: JSON.parse(readFileSync(join(EXT, "package.json"), "utf8")) },
];
const poly = side(polyManifests);

const builtinManifests = [];
for (const name of readdirSync(BUILTIN)) {
  const dir = join(BUILTIN, name);
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest) || !statSync(dir).isDirectory()) continue;
  try {
    builtinManifests.push({ dir, pkg: JSON.parse(readFileSync(manifest, "utf8")) });
  } catch {
    // An unreadable manifest contributes nothing to compare against.
  }
}
const builtin = side(builtinManifests);

// ── which grammar answers for a fixture ────────────────────────────────────

/**
 * The language id a side gives this file name, by VSCode's own precedence:
 * exact filename, then filename pattern, then extension -- longest extension
 * wins, so `.opam.template` beats `.template`. Case-insensitive throughout,
 * which is why `sample.r` reaches the built-in that declares only `.R`.
 */
function languageOf(side_, name) {
  const lower = name.toLowerCase();
  for (const [id, l] of side_.languages) {
    if (l.filenames.some((f) => f.toLowerCase() === lower)) return id;
  }
  for (const [id, l] of side_.languages) {
    for (const p of l.patterns) {
      const rx = new RegExp(
        `^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*?/g, ".*")}$`,
        "i",
      );
      if (rx.test(name)) return id;
    }
  }
  let best = null;
  for (const [id, l] of side_.languages) {
    for (const e of l.extensions) {
      if (lower.endsWith(e.toLowerCase()) && (!best || e.length > best.ext.length)) {
        best = { id, ext: e };
      }
    }
  }
  return best?.id ?? null;
}

/** Deep equality, enough for parsed grammar JSON. */
function equal(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => equal(a[k], b[k]));
}

/**
 * Whether both sides ship the same grammar file. poly rewrites plists as JSON,
 * so this compares parsed values rather than bytes. When they match, the two
 * sides have no excuse to tokenize differently.
 */
function sameGrammarFile(scopeName) {
  const a = poly.grammars.get(scopeName);
  const b = builtin.grammars.get(scopeName);
  if (!a || !b || !existsSync(b.path)) return false;
  try {
    return equal(JSON.parse(readFileSync(a.path, "utf8")), JSON.parse(readFileSync(b.path, "utf8")));
  } catch {
    return false; // a plist on the built-in side: treat as "cannot prove same"
  }
}

/**
 * Every other grammar `scopeName` can pull rules from, transitively.
 *
 * A grammar reaches another two ways, and only one of them is visible in the
 * output. `<style>` pushes source.css onto the scope stack, so a token says it
 * was there; `"include": "source.cpp#function-call"` borrows a rule and pushes
 * nothing, so the borrowed grammar colours the line while leaving no trace of
 * having done so. Reading the includes is the only way to see the second kind.
 */
/**
 * The scopes one grammar file names directly, memoised.
 *
 * Only this is cached, and the reason is a bug that was here: caching the
 * transitive answer and returning it on a hit gave the *first* caller the whole
 * closure and everyone after it the direct children only. That made the
 * classification depend on which fixture ran first -- sample.agent.md expanded
 * text.html.markdown.prompt into its 97 reachable scopes, and
 * sample.instructions.md then got one, so the rust grammar underneath a code
 * fence was never compared and a known repaint was reported as a packaging
 * defect. Memoising the file read leaves the walk itself to run every time,
 * which is the part that has to see everything.
 */
const DIRECT = new Map();
function directScopes(scopeName) {
  const cached = DIRECT.get(scopeName);
  if (cached) return cached;
  const entry = poly.grammars.get(scopeName) ?? builtin.grammars.get(scopeName);
  const direct = new Set();
  if (entry) {
    try {
      const raw = readFileSync(entry.path, "utf8");
      // `"include": "source.x"` or `"source.x#rule"`. A leading `#` or `$` is a
      // rule in this same grammar and reaches nothing new.
      for (const [, scope] of raw.matchAll(/"include"\s*:\s*"([A-Za-z][\w.+-]*)(?:#[^"]*)?"/g)) {
        direct.add(scope);
      }
    } catch {
      // Unreadable here means "cannot prove anything about it", which the
      // caller already treats as not-identical.
    }
  }
  DIRECT.set(scopeName, direct);
  return direct;
}

function referencedScopes(scopeName, into = new Set()) {
  if (into.has(scopeName)) return into; // grammars include each other in cycles
  into.add(scopeName);
  for (const scope of directScopes(scopeName)) referencedScopes(scope, into);
  return into;
}

/**
 * Whether every grammar that could have coloured this document is the same file
 * on both sides -- not just the one the language is bound to.
 *
 * The root is only where a document starts. `<style>` hands the rest of the
 * line to source.css and a `#define` body to source.cpp.embedded.macro, each
 * pinned at its own sha. Comparing the root alone reported two of VSCode's own
 * colorize fixtures as poly's packaging changing the answer, when what had
 * moved was a grammar underneath: test.cu is scoped by source.cpp, which
 * cuda-cpp borrows rules from without ever naming it in the output.
 */
function sameGrammarFiles(scopeName, seen) {
  if (!sameGrammarFile(scopeName)) return false;
  const involved = new Set([...seen, ...referencedScopes(scopeName)]);
  for (const scope of involved) {
    if (scope === scopeName) continue;
    if (!poly.grammars.has(scope) || !builtin.grammars.has(scope)) continue;
    if (!sameGrammarFile(scope)) return false;
  }
  return true;
}

// ── token comparison ───────────────────────────────────────────────────────

/**
 * A built-in color theme, with its `include` chain resolved.
 *
 * The theme is the user's, not either extension's, so both sides are asked
 * under the same one. This is the dimension that decides whether a scope
 * difference is a difference anybody can see: two grammars can disagree about
 * a name and paint identical pixels, and they can agree on every name and
 * still paint differently if one of them stops matching a rule.
 */
function theme(name) {
  const file = join(BUILTIN, "theme-defaults", "themes", name);
  const read = (path) => {
    const data = JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""));
    const inherited = data.include
      ? read(join(dirname(path), data.include))
      : { colors: {}, tokenColors: [] };
    return {
      colors: { ...inherited.colors, ...(data.colors ?? {}) },
      tokenColors: [...inherited.tokenColors, ...(data.tokenColors ?? [])],
    };
  };
  const { colors, tokenColors } = read(file);
  // The entry with no scope is what a character nothing matched gets painted.
  // Without it both sides fall back to vscode-textmate's own black, and the
  // two "unstyled" answers stop being comparable: poly's `meta.embedded` block
  // matched a rule for the editor's default colour and the built-in's did not,
  // which is the same pixel described two ways.
  const defaults = {
    settings: {
      foreground: colors["editor.foreground"] ?? "#D4D4D4",
      background: colors["editor.background"] ?? "#1E1E1E",
    },
  };
  return {
    name,
    settings: [defaults, ...tokenColors],
    plain: defaults.settings.foreground.toUpperCase(),
  };
}

// vscode-textmate packs the resolved style into one integer per token. These
// are its own `getForeground` and `getFontStyle`, transcribed from the bundled
// tokenizer (9.3.2) rather than remembered -- the layout has moved between
// versions, and a wrong shift does not fail, it reads a colour that is not
// there and reports every line as repainted.
const FOREGROUND_MASK = 16744448;
const FOREGROUND_OFFSET = 15;
const FONT_STYLE_MASK = 30720;
const FONT_STYLE_OFFSET = 11;

/** For each line, the theme-resolved color and font style of each character. */
async function colorsPerChar(registry, scopeName, lines) {
  const grammar = await registry.loadGrammar(scopeName);
  if (!grammar) return null;
  const map = registry.getColorMap();
  const out = [];
  let ruleStack = vsctm.INITIAL;
  for (const line of lines) {
    const r = grammar.tokenizeLine2(line, ruleStack);
    ruleStack = r.ruleStack;
    const chars = new Array(line.length).fill("");
    // tokenizeLine2 returns pairs: [startIndex, metadata, startIndex, ...]
    for (let i = 0; i < r.tokens.length; i += 2) {
      const start = r.tokens[i];
      const end = i + 2 < r.tokens.length ? r.tokens[i + 2] : line.length;
      const metadata = r.tokens[i + 1];
      const color = (map[(metadata & FOREGROUND_MASK) >>> FOREGROUND_OFFSET] ?? "").toUpperCase();
      const style = (metadata & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET;
      for (let c = start; c < Math.min(end, line.length); c++) chars[c] = `${color}/${style}`;
    }
    out.push(chars);
  }
  return out;
}

/**
 * The first places the built-in painted something and poly paints it
 * differently.
 *
 * Characters the built-in left at the editor's default colour are skipped: an
 * injection that colours a mermaid block inside a markdown fence is poly adding
 * to a picture, not changing one, and that is the reason injections exist. What
 * this looks for is the opposite -- text that had a colour and lost it or
 * swapped it, which is what an injection reaching the wrong language does.
 */
function repaints(mine, theirs, lines, plain, limit = 3) {
  const found = [];
  for (let i = 0; i < theirs.length && found.length < limit; i++) {
    const columns = [];
    for (let c = 0; c < (theirs[i]?.length ?? 0); c++) {
      const styled = theirs[i][c];
      if (styled.startsWith(`${plain}/`)) continue;
      if ((mine[i]?.[c] ?? "") !== styled) columns.push(c);
    }
    if (columns.length === 0) continue;
    const at = columns[0];
    found.push({
      line: i + 1,
      // Kept so the verdict can ask what poly's grammars said *here*. Blaming
      // a repaint on an injection that is nowhere near it reads as a defect in
      // the language poly replaced.
      at,
      text: (lines[i] ?? "").trim().slice(0, 60),
      detail: `${columns.length} chars from column ${at}: `
        + `poly ${mine[i]?.[at] || "(default)"} vs built-in ${theirs[i][at] || "(default)"}`,
    });
  }
  return found;
}

/**
 * Did taking `without` out of poly's injections put any of `painted` back?
 *
 * The control for "poly's extra injection did this", asked by doing it. A
 * repaint that survives the removal was never the injection's: something in
 * the grammars themselves moved, which for markdown is usually one of the
 * languages it embeds. A repaint that disappears is the injection's, and that
 * is the defect this audit was built for.
 *
 * Spot by spot rather than file by file, because the two causes turn up in the
 * same file: a markdown document has an embedded C++ block that drifted *and*
 * a mermaid block only poly colours.
 *
 * Built lazily and kept, because most files never ask.
 */
const controls = new Map();
async function fixedByRemoving(polyScope, builtinScope, lines, painted, without) {
  const key = [...without].sort().join("|");
  if (!controls.has(key)) {
    controls.set(key, side(polyManifests, undefined, without));
  }
  const control = controls.get(key);
  const left = new Set();
  for (const which of THEMES) {
    control.registry.setTheme(which);
    builtin.registry.setTheme(which);
    const [a, b] = await Promise.all([
      colorsPerChar(control.registry, polyScope, lines),
      colorsPerChar(builtin.registry, builtinScope, lines),
    ]);
    for (const spot of repaints(a, b, lines, which.plain)) {
      left.add(`${which.name}:${spot.line}:${spot.at}`);
    }
  }
  return painted.some((spot) => !left.has(`${spot.theme}:${spot.line}:${spot.at}`));
}

/** For each line, the set of scopes covering each character. */
async function scopesPerChar(registry, scopeName, lines) {
  const grammar = await registry.loadGrammar(scopeName);
  if (!grammar) return null;
  const out = [];
  let ruleStack = vsctm.INITIAL;
  for (const line of lines) {
    const r = grammar.tokenizeLine(line, ruleStack);
    ruleStack = r.ruleStack;
    const chars = Array.from({ length: line.length }, () => new Set());
    for (const t of r.tokens) {
      for (let i = t.startIndex; i < Math.min(t.endIndex, line.length); i++) {
        for (const s of t.scopes) chars[i].add(s);
      }
    }
    out.push(chars);
  }
  return out;
}

/**
 * Where the built-in scoped a character and poly did not. The root scope is
 * excluded: `source.cpp` vs `source.cpp.embedded.macro` is which grammar the
 * comparison picked, not what either said about the character.
 */
function regressions(mine, theirs, lines, limit = 4) {
  const found = [];
  for (let i = 0; i < theirs.length && found.length < limit; i++) {
    const line = lines[i] ?? "";
    const lost = new Map(); // scope -> first column
    for (let c = 0; c < (theirs[i]?.length ?? 0); c++) {
      const ours = mine[i]?.[c] ?? new Set();
      for (const scope of theirs[i][c]) {
        // A theme rule for `fenced_code.block.language` also selects
        // `fenced_code.block.language.markdown`, so a more specific scope is
        // not a lost one -- it is the same rule with a longer name. Comparing
        // the strings flagged an injection that changes no pixel.
        if (ours.has(scope) || [...ours].some((s) => s.startsWith(`${scope}.`))) continue;
        if (lost.has(scope)) continue;
        // A root scope is the grammar's own name; both sides always have one.
        if (scope.split(".").length <= 2 && c === 0) continue;
        lost.set(scope, c);
      }
    }
    if (lost.size === 0) continue;
    found.push({
      line: i + 1,
      text: line.trim().slice(0, 60),
      lost: [...lost].slice(0, 4).map(([s, c]) => `${s} @${c}`),
    });
  }
  return found;
}

/** True when poly produced at least one scope the built-in did not. */
function isRicher(mine, theirs) {
  for (let i = 0; i < mine.length; i++) {
    for (let c = 0; c < (mine[i]?.length ?? 0); c++) {
      const ours = theirs[i]?.[c] ?? new Set();
      for (const scope of mine[i][c]) {
        if (ours.has(scope)) continue;
        // Same rule as `regressions`, the other way round: a scope of theirs
        // that ours refines is not something ours added.
        if ([...ours].some((s) => scope.startsWith(`${s}.`))) continue;
        return true;
      }
    }
  }
  return false;
}

// ── run ────────────────────────────────────────────────────────────────────

const THEMES = [theme("dark_plus.json"), theme("light_plus.json")];

const sources = JSON.parse(readFileSync(join(ROOT, "grammars", "sources.json"), "utf8"));
const repoOfScope = new Map();
for (const entry of sources.languages) {
  for (const file of entry.files ?? []) {
    if (file.scopeName) repoOfScope.set(file.scopeName, entry.repo ?? "(generated)");
  }
}

// Differences that are what poly is for, rather than what it got wrong. The
// classifier above cannot tell these apart from a packaging bug on its own:
// both are the same grammar file answering differently, and the cause of both
// is an injection. What separates them is what the injection keys on. `gql(`
// and a Go string handed to text/template name themselves; `{{` in a JSON
// string does not, it is just punctuation that happens to be there.
//
// Listed here so the reason is written down once and checked both ways: a
// fixture that stops differing is reported too, because that means poly quietly
// lost the injection it was built to add.
const EXPECTED = {
  "edge/graphql-tag.py": [
    "poly injects GraphQL into python's gql() strings, which VSCode has no grammar for at all",
    "the block loses its string colour because Dark+ ships no rules for graphql scopes -- less colour than before, and still the feature",
  ].join("; "),
  "edge/injected-braces.go": [
    "poly injects go-template into Go strings",
    "text/template is Go's standard library, so `{{` there is the idiom rather than a coincidence -- the same injection is not shipped for css/js/json/html/xml, where it would be",
  ].join("; "),
};
const sawExpected = new Set();

let failed = 0;
let same = 0;
let richer = 0;
let drifted = 0;
let swapped = 0;
let repainted = 0;
let declared = 0;
const polyOnly = [];
const unclaimed = [];
/** Languages a fixture actually opened, so the rest can be named at the end. */
const exercised = new Set();

// `fixtures/` holds one representative file per language, and the ones with a
// grammar nothing else reaches are also tokenize-check's inputs.
// `fixtures/edge/` holds the constructs that only matter
// when two grammars are compared -- a `{{` inside a JSON string reaches five
// languages through one injection, and no representative sample contains one.
// They are a second directory rather than more of the first because
// tokenize-check would fail them: several are deliberately dull as documents.
//
// POLY_DIFF_CORPUS points at a third set that this repo does not own:
// VSCode's own colorize fixtures, most of them named for the issue number of a
// highlighting bug somebody reported. They are better edge cases than anything
// written here, because a grammar maintainer chose each one after it broke.
// Not committed -- `tools/colorize-corpus.mjs` fetches them at a pinned sha.
const CORPUS = process.env.POLY_DIFF_CORPUS;
const FIXTURE_FILES = [
  ...readdirSync(FIXTURES).filter((n) => statSync(join(FIXTURES, n)).isFile()).map((n) => [n, join(FIXTURES, n)]),
  ...readdirSync(EDGE).map((n) => [`edge/${n}`, join(EDGE, n)]),
  ...(CORPUS && existsSync(CORPUS)
    ? readdirSync(CORPUS).filter((n) => statSync(join(CORPUS, n)).isFile()).map((
      n,
    ) => [`corpus/${n}`, join(CORPUS, n)])
    : []),
].sort(([a], [b]) => a.localeCompare(b));

for (const [name, path] of FIXTURE_FILES) {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const base = name.replace(/^(edge|corpus)\//, "");
  const langId = languageOf(builtin, base) ?? languageOf(poly, base);
  if (!langId) {
    // Not a failure: a fixture is named for a human, and several are named so
    // no association could ever match (`sample.ssh_config`). Worth printing,
    // because it is also the shape of a real missing association.
    unclaimed.push(name);
    continue;
  }
  const builtinScope = builtin.scopeOfLanguage.get(langId);
  const polyScope = poly.scopeOfLanguage.get(langId);
  if (!polyScope) {
    console.log(`FAIL ${name}: poly has no grammar for language "${langId}"`);
    failed++;
    continue;
  }
  if (!builtinScope) {
    polyOnly.push(`${name} (${langId})`);
    continue;
  }
  exercised.add(langId);
  const [mine, theirs] = await Promise.all([
    scopesPerChar(poly.registry, polyScope, lines),
    scopesPerChar(builtin.registry, builtinScope, lines),
  ]);
  const lost = regressions(mine, theirs, lines);

  // The same file, under the same themes, on both sides.
  const painted = [];
  for (const which of THEMES) {
    // setTheme re-resolves the styles of the grammars already loaded, so the
    // two sides share one registry each rather than one per theme.
    poly.registry.setTheme(which);
    builtin.registry.setTheme(which);
    const [a, b] = await Promise.all([
      colorsPerChar(poly.registry, polyScope, lines),
      colorsPerChar(builtin.registry, builtinScope, lines),
    ]);
    for (const spot of repaints(a, b, lines, which.plain)) {
      painted.push({ ...spot, theme: which.name });
    }
  }
  const repo = repoOfScope.get(polyScope) ?? "(unknown)";
  const contributing = new Set();
  for (const side_ of [mine, theirs]) {
    for (const line of side_) {
      for (const chars of line) {
        for (const scope of chars) contributing.add(scope);
      }
    }
  }
  const identicalFile = polyScope === builtinScope
    && sameGrammarFiles(polyScope, contributing);
  // Grammars poly injects into this root that the built-in does not. This is
  // the wiring rather than the grammars, so it stays decisive however far any
  // upstream has drifted -- and it is the thing that went wrong four times:
  // an injection shipped to everyone because one upstream aimed it at the
  // people who chose to install it.
  const extraInjections = (poly.injections.get(polyScope) ?? []).filter(
    (scope) => !(builtin.injections.get(builtinScope) ?? []).includes(scope),
  );
  const expected = EXPECTED[name];
  if (expected && (painted.length > 0 || lost.length > 0)) {
    sawExpected.add(name);
    declared++;
    console.log(`note ${name}: ${langId} differs on purpose`);
    console.log(`       ${expected}`);
    continue;
  }
  if (painted.length > 0) {
    // A repaint under a stock theme is the difference a user sees, so it is
    // reported whatever the scopes did -- including when the scopes agreed.
    //
    // An injection poly adds and the built-in does not is decided first,
    // because it explains the repaint on its own: the extra grammar took text
    // the built-in had already coloured. Leaving this to `identicalFile` made
    // the check miss it for html and markdown, whose grammars borrow from css
    // and js, which drift -- exactly the languages the injections reach.
    // ...but only when they are what did it, which is asked by taking them out
    // and looking again. A markdown file with a C++ block blamed every
    // injection poly adds to markdown -- mermaid, graphql, kotlin, eleven more,
    // none of which has anything to do with C++. What had moved was poly's
    // pinned C++ grammar, reported as drift by the same run for every `.cpp`
    // file in the corpus. Naming a cause that is not the cause is worse than
    // naming none: it sends whoever reads it to the wrong grammar.
    //
    // Asked by removing them rather than by looking for their scope names on
    // the repainted character, which was the first attempt and does not work:
    // an injected grammar contributes the scopes its rules name and not its
    // own, so `markdown.mermaid.codeblock` never appears in a token and that
    // test would have quietly blamed nothing, ever.
    const blamed = extraInjections.length > 0
        && await fixedByRemoving(
          polyScope,
          builtinScope,
          lines,
          painted,
          new Set(extraInjections),
        )
      ? extraInjections
      : [];
    if (blamed.length > 0) {
      failed++;
      console.log(
        `FAIL ${name}: ${langId} -- repainted by injections the built-in does not have: `
          + blamed.join(", "),
      );
    } else if (identicalFile) {
      failed++;
      console.log(`FAIL ${name}: ${langId} -- same grammar as the built-in, different colors`);
    } else {
      repainted++;
      console.log(`paint ${name}: ${langId} renders differently (${repo})`);
    }
    for (const spot of painted) {
      console.log(`       ${spot.theme} line ${spot.line}: ${JSON.stringify(spot.text)}`);
      console.log(`         ${spot.detail}`);
    }
    continue;
  }
  if (lost.length === 0) {
    if (isRicher(mine, theirs)) {
      richer++;
      console.log(`rich ${name}: ${langId} keeps every built-in scope and adds its own`);
    } else {
      same++;
      console.log(`ok   ${name}: ${langId} identical to built-in (${polyScope})`);
    }
    continue;
  }
  if (identicalFile) {
    // The same grammar, two answers. Whatever did this lives in the manifest,
    // not in the grammar: an injection, or metadata that did not come across.
    failed++;
    console.log(`FAIL ${name}: ${langId} -- same grammar as the built-in, different tokens`);
  } else if (repo !== "microsoft/vscode" && repo !== "(unknown)") {
    swapped++;
    console.log(`note ${name}: ${langId} -- poly ships ${repo}, so the scopes are its own`);
  } else {
    drifted++;
    console.log(`drift ${name}: ${langId} -- poly's pinned ${repo} has moved past this VSCode`);
  }
  for (const d of lost) {
    console.log(`       line ${d.line}: ${JSON.stringify(d.text)}`);
    console.log(`         only built-in: ${d.lost.join(" | ")}`);
  }
}

// ── which takeovers no fixture ever opened ─────────────────────────────────
//
// Every line above is about a file that exists. This is the other half of the
// answer, and the one a summary leaves out: a language poly takes over from a
// built-in that no fixture in any of the three sets is named to reach has been
// compared by nobody. Saying which ones those are is the difference between
// "checked" and "not known to be broken".
//
// Not a failure, and split in two because only one half is a gap somebody could
// close. `markdown-math` and `cpp_embedded_latex` have no file association at
// all -- they exist to be embedded in another grammar, and no file name reaches
// them -- so they are named as out of reach rather than as untested. The
// associations are read off the built-in side because that is where they are
// declared: poly contributes the grammar for these ids and nothing else.
const overridden = [...poly.scopeOfLanguage.keys()].filter((l) => builtin.scopeOfLanguage.has(l));
const openable = (id) => {
  const both = [poly.languages.get(id), builtin.languages.get(id)];
  return both.some((l) => (l?.extensions?.length ?? 0) + (l?.filenames?.length ?? 0) + (l?.patterns?.length ?? 0) > 0);
};
const untested = overridden.filter((l) => !exercised.has(l)).sort();
const missing = untested.filter(openable);
const embedded = untested.filter((l) => !openable(l));
console.log(
  `\n${overridden.length - untested.length}/${overridden.length} overridden languages had a fixture`
    + (missing.length > 0 ? `; no file opened: ${missing.join(", ")}` : "")
    + (embedded.length > 0 ? `; no file can: ${embedded.join(", ")}` : ""),
);

// ── which grammar a language ends up bound to ──────────────────────────────
//
// VSCode resolves this with a plain `this._languageToScope.set(language,
// scopeName)` over the contributions in order, so the *last* entry declaring a
// language wins. The built-in cpp extension relies on that: it lists
// `source.cpp.embedded.macro` first and `source.cpp` second. A takeover that
// reorders the two silently opens every .cpp file with the macro grammar, and
// no fixture notices, because both grammars tokenize the body identically --
// only the root scope, and the metadata hanging off that entry, change.
let bindingFailed = 0;
for (const [langId, scopeName] of poly.scopeOfLanguage) {
  const theirs = builtin.scopeOfLanguage.get(langId);
  if (!theirs || theirs === scopeName) continue;
  if (!poly.grammars.has(theirs)) continue; // poly ships a different grammar entirely
  bindingFailed++;
  console.log(`FAIL ${langId}: binds to ${scopeName}, the built-in binds to ${theirs}`);
  console.log(`       poly declares, in order: ${
    [...poly.grammars]
      .filter(([, g]) => g.meta.language === langId)
      .map(([s]) => s)
      .join(", ")
  }`);
}

// ── the metadata a grammar entry carries besides its path ───────────────────
//
// M6's lesson: moving the .tmLanguage without these keys silently changes JSX
// expressions, template literals and regex brackets. They are part of the
// takeover, so they are part of the comparison -- and losing one is as
// invisible as losing a scope.
const META_KEYS = [
  "embeddedLanguages",
  "tokenTypes",
  "unbalancedBracketScopes",
  "balancedBracketScopes",
];
let metaFailed = 0;
for (const [scopeName, { meta }] of poly.grammars) {
  const other = builtin.grammars.get(scopeName);
  if (!other) continue;
  for (const key of META_KEYS) {
    const mine = meta[key];
    const theirs = other.meta[key];
    if (!theirs) continue; // poly declaring more than the built-in is the ahead case
    const missing = Array.isArray(theirs)
      ? theirs.filter((v) => !(mine ?? []).includes(v))
      : Object.entries(theirs).filter(([k, v]) => (mine ?? {})[k] !== v);
    if (missing.length === 0) continue;
    metaFailed++;
    console.log(`FAIL ${scopeName}: contributes.${key} loses what the built-in declares`);
    console.log(`       missing: ${JSON.stringify(missing).slice(0, 200)}`);
  }
}

// ── language-configuration ─────────────────────────────────────────────────
//
// VSCode merges these field by field, so a field poly leaves out keeps the
// built-in's -- that is the documented design for markdown's onEnterRules and
// is not a difference at all. What this reports is the other case: a field poly
// does declare, whose value contradicts the one it took over.
const CFG_KEYS = [
  "comments",
  "brackets",
  "autoClosingPairs",
  "surroundingPairs",
  "folding",
  "wordPattern",
  "indentationRules",
  "autoCloseBefore",
  "colorizedBracketPairs",
];
let overrides = 0;
for (const [id, l] of poly.languages) {
  if (!l.configuration) continue;
  const other = builtin.languages.get(id);
  if (!other?.configuration || !existsSync(other.configuration)) continue;
  const strip = (s) => s.replace(/^\s*\/\/.*$/gm, "");
  const mine = JSON.parse(strip(readFileSync(l.configuration, "utf8")));
  const theirs = JSON.parse(strip(readFileSync(other.configuration, "utf8")));
  for (const key of CFG_KEYS) {
    if (!(key in mine) || !(key in theirs)) continue;
    const a = JSON.stringify(mine[key]);
    const b = JSON.stringify(theirs[key]);
    if (a === b) continue;
    overrides++;
    console.log(`over ${id}: language-configuration ${key} replaces the built-in's`);
    console.log(`       poly    : ${a.slice(0, 120)}`);
    console.log(`       built-in: ${b.slice(0, 120)}`);
  }
}

// The other direction of the EXPECTED table. A declared difference that has
// gone away is not good news: poly did not set out to match the built-in here,
// it set out to add something, and matching means the injection stopped
// reaching the fixture.
let lapsed = 0;
for (const name of Object.keys(EXPECTED)) {
  if (sawExpected.has(name)) continue;
  lapsed++;
  console.log(`FAIL ${name}: matches the built-in now, but is listed as differing on purpose`);
  console.log(`       was: ${EXPECTED[name]}`);
}

console.log(
  `\n${same} identical, ${richer} richer, ${declared} declared, ${repainted} repainted, ${drifted} upstream drift, `
    + `${swapped} swapped upstream, `
    + `${polyOnly.length} poly-only, ${overrides} configuration overrides, `
    + `${failed} token REGRESSIONS, ${bindingFailed} binding REGRESSIONS, ${metaFailed} metadata REGRESSIONS, `
    + `${lapsed} lapsed`,
);
if (unclaimed.length) console.log(`no association claims: ${unclaimed.join(", ")}`);
process.exit(failed || metaFailed || bindingFailed || lapsed ? 1 : 0);

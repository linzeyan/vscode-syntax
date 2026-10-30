#!/usr/bin/env node
// What the shipped grammars do with input nobody would write on purpose.
//
// The fixture check asks whether a grammar engages on a well-formed sample.
// This asks the other question: a grammar is a pile of backtracking regexes run
// by oniguruma on every keystroke, and the inputs that make one of them take a
// second are not the ones anyone writes deliberately -- they are half-typed
// strings, a pasted minified line, a run of brackets, a file that opens a block
// comment and never closes it.
//
// The pass/fail line is the editor's own, twice over:
//
//   * VSCode tokenizes with a time limit, and a line past it is not a slow
//     editor but a wrong one -- `stoppedEarly` comes back true and everything
//     after the last token is painted as plain text. No invented budget.
//   * Every grammar here was synced from somewhere, and most of them from the
//     editor's own. So a slow grammar is only poly's problem when the built-in
//     of the same name is not slow: the same inputs go through both, and a
//     finding on both sides is upstream's behaviour, reported and not failed.
//
// Usage: node tools/grammar-fuzz.mjs <node_modules_dir> [builtin_extensions_dir]
//        [--seed N] [--rounds N]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NM = process.argv[2];
const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
// Seeded so a failure can be re-run, and so a green run means the same thing
// twice. A fuzzer that cannot reproduce its own finding reports a rumour.
const SEED = flag("--seed", 20260920);
const ROUNDS = flag("--rounds", 24);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extensions", "lsp");
const FIXTURES = join(ROOT, "grammars", "fixtures");
const CACHE = join(ROOT, "extensions", "lsp", ".vscode-test");

/**
 * VSCode's own per-line tokenization budget, in milliseconds.
 *
 * `TextMateTokenizationSupport` passes this to `tokenizeLine2`, and what
 * happens past it is not a slow editor but a wrong one: tokenization of that
 * line stops where it is and the remainder loses its scopes.
 */
const TIME_LIMIT = 500;

/**
 * What one line may cost before it is a finding, in milliseconds.
 *
 * Above the editor's own limit on purpose, because that limit does not catch
 * this: it is checked between rule matches, so a single oniguruma call that
 * runs for eight seconds returns `stoppedEarly: false` and the editor simply
 * stops repainting for eight seconds. Measured here, the worst line in this
 * corpus costs 8.7s -- which is why wall clock is a separate question from
 * whether the tokenizer gave up.
 */
const SLOW_LINE = 1000;

/** How many copies of a fixture the stack is watched across. */
const REPEATS = 20;

/**
 * How deep the stack may be after a whole well-formed document.
 *
 * Not a guess about nesting: the input is a fixture that opens and closes
 * everything it opens, so whatever it leaves behind is a frame the grammar
 * never popped. Repeated copies turn a per-document leak into a growing number,
 * which is the shape that makes an editor slower the longer the file is.
 */
const MAX_LEFTOVER = 12;

/**
 * Findings that are accepted, one line of reason each.
 *
 * Only for grammars with no built-in of the same name: where there is one, the
 * comparison decides and nothing has to be written down. These are the ones
 * poly ships alone, so "upstream does it too" is not an answer anybody can
 * check -- it has to be a sentence somebody wrote.
 *
 * A finding not in here fails. That is the point: the corpus is fixed and the
 * seed is fixed, so the only way a new line appears is that a synced grammar
 * changed behaviour, and that is worth a look before it ships.
 */
const KNOWN = {
  "source.nix leaks frames": "jnoortheen/vscode-nix-ide loses 4 frames per file: the closing brace of a flake pushes "
    + "instead of popping, so the stack grows with the file. Synced verbatim, reported upstream's to fix.",
  "source.jsonnet is slow": "grafana/vscode-jsonnet spends 8.7s on one 20000-character line. Nothing in the editor "
    + "interrupts it, and no built-in jsonnet grammar exists to compare against.",
  "source.zig is slow": "ziglang/vscode-zig gives up on a 20000-character run of one letter. A zig file with a line "
    + "that long is not a case worth carrying another grammar for.",
  "source.erlang is slow": "erlang-ls/vscode-erlang gives up on the same 20000-character line, same reasoning.",
};

/** The built-in extensions to compare against, cached test build first. */
function builtinRoot() {
  const given = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : null;
  if (given) return given;
  const builds = existsSync(CACHE)
    ? readdirSync(CACHE)
      .map((name) => ({ name, version: /(\d+)\.(\d+)\.(\d+)$/.exec(name) }))
      .filter((build) => build.name.startsWith("vscode-") && build.version)
      .sort((a, b) =>
        Number(a.version[1]) - Number(b.version[1])
        || Number(a.version[2]) - Number(b.version[2])
        || Number(a.version[3]) - Number(b.version[3])
      )
    : [];
  const newest = builds.pop();
  const cached = newest
    && join(CACHE, newest.name, "Visual Studio Code.app", "Contents", "Resources", "app", "extensions");
  if (cached && existsSync(cached)) return cached;
  return "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions";
}

const oniguruma = await (async () => {
  const mod = await import(pathToFileURL(join(NM, "vscode-oniguruma", "release", "main.js")));
  return mod.default ?? mod;
})();
const vsctm = await (async () => {
  const mod = await import(pathToFileURL(join(NM, "vscode-textmate", "release", "main.js")));
  return mod.default ?? mod;
})();
const wasm = readFileSync(join(NM, "vscode-oniguruma", "release", "onig.wasm"));
const onigLib = oniguruma.loadWASM(wasm.buffer).then(() => ({
  createOnigScanner: (s) => new oniguruma.OnigScanner(s),
  createOnigString: (s) => new oniguruma.OnigString(s),
}));

/** One side: its grammar files by scope, and a registry that loads them. */
function side(manifests) {
  const byScope = new Map();
  const injections = new Map();
  const extensionsFor = new Map();
  for (const { dir, pkg } of manifests) {
    for (const g of pkg.contributes?.grammars ?? []) {
      if (!byScope.has(g.scopeName)) byScope.set(g.scopeName, join(dir, g.path));
      for (const target of g.injectTo ?? []) {
        if (!injections.has(target)) injections.set(target, []);
        injections.get(target).push(g.scopeName);
      }
    }
    for (const language of pkg.contributes?.languages ?? []) {
      if (!extensionsFor.has(language.id)) extensionsFor.set(language.id, language.extensions ?? []);
    }
  }
  const registry = new vsctm.Registry({
    onigLib,
    // The interface declares a Promise, so the `async` is the contract.
    // poly: ignore deno_lint/require-await
    loadGrammar: async (scopeName) => {
      const path = byScope.get(scopeName);
      if (!path) return null;
      return vsctm.parseRawGrammar(readFileSync(path, "utf8"), path);
    },
    getInjections: (scopeName) => injections.get(scopeName) ?? [],
  });
  return { byScope, extensionsFor, registry };
}

const polyPkg = JSON.parse(readFileSync(join(EXT, "package.json"), "utf8"));
const poly = side([{ dir: EXT, pkg: polyPkg }]);
// The synced grammars. poly-lsp's manifest also carries Code Runner's output
// grammar, which is poly's own and sits in dist/, built only with the rest of
// the extension -- not what this fuzzes.
const synced = polyPkg.contributes.grammars.filter((grammar) => grammar.path.startsWith("./syntaxes/"));

const BUILTIN = builtinRoot();
const builtinManifests = [];
if (existsSync(BUILTIN)) {
  for (const name of readdirSync(BUILTIN)) {
    const manifest = join(BUILTIN, name, "package.json");
    if (existsSync(manifest)) {
      builtinManifests.push({ dir: join(BUILTIN, name), pkg: JSON.parse(readFileSync(manifest, "utf8")) });
    }
  }
}
const builtin = side(builtinManifests);

/** Deterministic PRNG: the same seed has to produce the same run. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The characters a grammar's rules are built out of.
 *
 * Not random bytes: a regex that backtracks does it on the punctuation the
 * language gives meaning to, and uniform noise almost never lands on a rule at
 * all. These are the openers, closers, escapes and quotes that appear in
 * TextMate patterns across every grammar here, plus the handful of characters
 * that break the assumption that a line is ASCII.
 */
const ALPHABET = [
  ..."(){}[]<>\"'`\\/*#-+=|&^%$@!?:;,.~_ \t",
  ..."abZ019",
  "\u0000",
  " ",
  "​", // poly: ignore confusable-character
  "😀",
  "́",
  "‮", // poly: ignore confusable-character
];

/** Single lines that have a reason to be here, rather than random ones. */
function pathological() {
  const many = (text, times) => text.repeat(times);
  return [
    "",
    " ",
    "\t".repeat(200),
    "\u0000",
    // A lone surrogate: not text, but a paste can produce one and oniguruma is
    // handed a UTF-16 string either way.
    "\ud800",
    many("a", 20000),
    // Unclosed openers. Each is the start of some grammar's block construct,
    // repeated past the point where a backtracking rule stays cheap.
    many("(", 2000),
    many("[", 2000),
    many("{", 2000),
    many("<", 2000),
    many("/*", 2000),
    many("\"", 2000),
    many("'", 2000),
    many("`", 2000),
    many("\\", 2000),
    many("${", 1000),
    many("{{", 1000),
    many("<!--", 500),
    many("#", 2000),
    // Balanced but deep, which is where a nested rule set pays twice.
    many("(", 1000) + many(")", 1000),
    many("[", 1000) + many("]", 1000),
    many("{", 1000) + many("}", 1000),
    // The shape of a minified bundle: one very long line of punctuation-heavy
    // code, which is a real thing to open and the usual cause of a slow editor.
    many("a={b:[1,2,3],c:(d)=>{return e?f:g},}", 400),
    many("\"a\",", 2000),
    many("a.b(c).d(e).", 1000),
    // Whitespace that is not a space, which several grammars match on.
    many(" ", 2000),
    many("​", 2000), // poly: ignore confusable-character
  ];
}

/**
 * Runs of the punctuation this particular grammar matches on.
 *
 * Mutating a fixture was the first generator, and across five seeds and 120
 * rounds each it found nothing the fixed list above had not: an edit to a line
 * of real code lands on a rule that was going to match anyway. What makes a
 * backtracking rule expensive is a long run of the characters it is built out
 * of, and a grammar says which ones those are -- in TextMate JSON a literal
 * bracket is written `\\[`, so the escaped characters are exactly the
 * punctuation its patterns take seriously.
 *
 * Derived per grammar rather than shared, because the whole point is that
 * `(((((` is interesting to a C grammar and `#####` is interesting to a
 * markdown one.
 */
function derived(path) {
  const source = readFileSync(path, "utf8");
  const counts = new Map();
  for (const [, char] of source.matchAll(/\\\\([^\w\s])/g)) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  const common = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([char]) => char);
  const lines = [];
  for (const char of common) {
    lines.push(char.repeat(1000));
  }
  // Pairs as well as singles: a rule that is cheap on one character can be
  // quadratic on an alternation of two, and a begin/end pair is two characters
  // by construction.
  for (let i = 0; i < common.length && i < 4; i++) {
    for (let j = i + 1; j < common.length && j < 5; j++) {
      lines.push((common[i] + common[j]).repeat(500));
    }
  }
  return lines;
}

/** One mutation of a line: the edits a half-finished document really contains. */
function mutate(line, rand) {
  const at = Math.floor(rand() * Math.max(1, line.length));
  const what = Math.floor(rand() * 6);
  const char = ALPHABET[Math.floor(rand() * ALPHABET.length)];
  if (what === 0) return line.slice(0, at);
  if (what === 1) return line.slice(0, at) + char + line.slice(at);
  if (what === 2) return line.slice(0, at) + line.slice(at + 1);
  if (what === 3) return line.slice(0, at) + line.slice(at).repeat(3);
  if (what === 4) return char.repeat(200) + line;
  return line + char.repeat(200);
}

/** Fixture text for a language, so mutations start from something real. */
const fixtures = readdirSync(FIXTURES).filter((name) => name !== "edge");
function fixtureFor(language, extensions) {
  const wanted = new Set(extensions.map((one) => one.toLowerCase()));
  const named = fixtures.find((name) =>
    wanted.has(extname(name).toLowerCase()) || name.toLowerCase() === language.toLowerCase()
  );
  return named ? readFileSync(join(FIXTURES, named), "utf8").split("\n") : [];
}

/** A line named by what it is, because printing 20000 characters helps nobody. */
function describe(line) {
  if (line === "") return "an empty line";
  const shown = line.length > 40 ? `${JSON.stringify(line.slice(0, 40))}...` : JSON.stringify(line);
  return `${shown} (${line.length} chars)`;
}

/**
 * What one grammar does with one set of lines.
 *
 * Reported rather than asserted: which of these is a defect depends on whether
 * the other side does it too, and that comparison is the caller's.
 */
function exercise(grammar, lines, document) {
  const result = { gaveUp: [], slow: [], threw: [], slowest: 0, leftover: 0 };
  for (const line of lines) {
    const started = performance.now();
    try {
      const tokens = grammar.tokenizeLine(line, vsctm.INITIAL, TIME_LIMIT);
      const elapsed = performance.now() - started;
      result.slowest = Math.max(result.slowest, elapsed);
      if (tokens.stoppedEarly) result.gaveUp.push(line);
      else if (elapsed > SLOW_LINE) result.slow.push(line);
    } catch (error) {
      result.threw.push(`${describe(line)}: ${error.message ?? error}`);
    }
  }
  // A well-formed document closes what it opens, so whatever depth survives
  // several copies of one is a frame the grammar never popped.
  if (document.length > 0) {
    let stack = vsctm.INITIAL;
    try {
      for (let round = 0; round < REPEATS; round++) {
        for (const line of document) {
          stack = grammar.tokenizeLine(line, stack, TIME_LIMIT).ruleStack;
        }
      }
      result.leftover = stack.depth;
    } catch (error) {
      result.threw.push(`${REPEATS} copies of its own fixture: ${error.message ?? error}`);
    }
  }
  return result;
}

const problems = [];
const upstream = [];
const slow = [];
let compared = 0;
let alone = 0;
let tokenizedLines = 0;
let derivedFrom = 0;

for (const entry of synced) {
  const mine = await poly.registry.loadGrammar(entry.scopeName);
  if (!mine) {
    problems.push(`${entry.scopeName}: declared in the manifest and not loadable`);
    continue;
  }
  const rand = random(SEED);
  const language = entry.language ?? "";
  const document = fixtureFor(language, poly.extensionsFor.get(language) ?? []);
  const fromGrammar = derived(poly.byScope.get(entry.scopeName));
  if (fromGrammar.length > 0) derivedFrom++;
  const lines = [...pathological(), ...fromGrammar];
  tokenizedLines += lines.length;
  for (let round = 0; round < ROUNDS && document.length > 0; round++) {
    const seed = document[Math.floor(rand() * document.length)];
    if (seed) lines.push(mutate(seed, rand));
  }

  const ours = exercise(mine, lines, document);
  const theirGrammar = builtin.byScope.has(entry.scopeName)
    ? await builtin.registry.loadGrammar(entry.scopeName)
    : null;
  const theirs = theirGrammar ? exercise(theirGrammar, lines, document) : null;
  if (theirs) compared++;
  else alone++;

  slow.push({ scope: entry.scopeName, ours: ours.slowest, theirs: theirs?.slowest ?? null });

  // One rule for all of them: the built-in answers when there is one, and a
  // sentence in KNOWN answers when there is not. Nothing is waved through for
  // the absence of a reference -- an editor that stalls on a .zig file stalls
  // whether or not VSCode ships a zig grammar to blame it on.
  const classify = (key, note, shared) => {
    if (theirs && shared) upstream.push(`${note} -- the built-in of the same name does too`);
    else if (theirs) problems.push(`${note} -- and the built-in of the same name does not`);
    else if (KNOWN[key]) upstream.push(`${note} -- accepted: ${KNOWN[key]}`);
    else problems.push(`${note} -- no built-in to compare against and no entry in KNOWN`);
  };

  // Throwing is nobody's acceptable behaviour, so it fails either way.
  for (const threw of ours.threw) {
    problems.push(`${entry.scopeName}: threw on ${threw}`);
  }
  for (const line of ours.gaveUp) {
    classify(
      `${entry.scopeName} is slow`,
      `${entry.scopeName}: gave up after ${TIME_LIMIT}ms on ${describe(line)}`,
      theirs?.gaveUp.includes(line),
    );
  }
  for (const line of ours.slow) {
    classify(
      `${entry.scopeName} is slow`,
      `${entry.scopeName}: spent over ${SLOW_LINE}ms on ${describe(line)} without the tokenizer `
        + "noticing, so the editor simply stops repainting",
      theirs?.slow.includes(line),
    );
  }
  if (ours.leftover > MAX_LEFTOVER) {
    classify(
      `${entry.scopeName} leaks frames`,
      `${entry.scopeName}: ${REPEATS} copies of its own fixture left the rule stack ${ours.leftover} deep`,
      theirs?.leftover === ours.leftover,
    );
  }
}

// Asked once, of the whole run rather than of each grammar: a small grammar
// with no escaped punctuation is ordinary -- `source.csv` has none -- but a
// corpus that quietly shrank back to the fixed list for everything would still
// pass while having stopped asking the question.
if (derivedFrom < synced.length / 2) {
  problems.push(
    `only ${derivedFrom} of ${synced.length} grammars yielded any punctuation `
      + "of their own, so the corpus is no longer derived from what the grammars match",
  );
}

slow.sort((a, b) => b.ours - a.ours);
console.log(
  `\n${synced.length} grammars, ${compared} compared against a built-in of the `
    + `same name, ${alone} with none, ${tokenizedLines} lines each side, seed ${SEED}`,
);
console.log("\nslowest single line, poly against the built-in:");
for (const one of slow.slice(0, 8)) {
  const reference = one.theirs === null ? "no built-in" : `${one.theirs.toFixed(1)}ms`;
  console.log(`  ${one.ours.toFixed(1).padStart(7)}ms  (${reference.padStart(11)})  ${one.scope}`);
}

if (upstream.length > 0) {
  console.log(`\n${upstream.length} finding(s) already answered for:`);
  for (const note of upstream.slice(0, 20)) console.log(`  ${note}`);
  if (upstream.length > 20) console.log(`  ... and ${upstream.length - 20} more`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) that are poly's:`);
  for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
  if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`);
  process.exit(1);
}
console.log("\nno grammar loses a line the built-in keeps, and none leaves frames behind");

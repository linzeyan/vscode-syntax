#!/usr/bin/env node
// Do poly's code lenses land where they should, and nowhere else?
//
// This is a gate rather than an audit: it compares poly against nothing but
// itself, needs no marketplace extension and no network, and the one real
// provider it leans on -- TypeScript's -- ships inside the editor. It exists
// because the reference lens once counted parameters and locals, a defect the
// unit tests could not see: they assert against a symbol tree written by the
// same hand that wrote the rule, and the rule was wrong about what a real
// server reports. Every lens added since has been given its own section here
// for the same reason, and each section says what it does and does not prove.
//
// Usage: node tools/ref-lens-check/run.js
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const navigate = require("./navigate");
const proto = require("./proto");
const runnable = require("./runnable");

const ROOT = resolve(__dirname, "..", "..");
const LSP = join(ROOT, "extensions", "lsp");
const { runTests } = require(join(ROOT, "extensions", "lsp", "node_modules", "@vscode", "test-electron"));

// One scratch root per checkout, agreed in runnable.js -- see there for why.
const SCRATCH = runnable.SCRATCH;
const WORKSPACE = join(SCRATCH, "workspace");
const OUT = join(ROOT, ".logs", "audit", "ref-lens.json");
const COST_OUT = join(ROOT, ".logs", "audit", "ref-lens-cost.json");
const CACHE = join(ROOT, "extensions", "lsp", ".vscode-test");

/**
 * One file holding each shape the rule has an opinion about.
 *
 * Every name in it is either a declaration another file can reach -- and so
 * worth a count -- or a name that lives and dies inside one body. The second
 * kind is the point: `radius` is a property, `twice` and `scaled` are locals,
 * `value` and `factor` are parameters, and `inner` is a local of an arrow
 * function, which TypeScript reports as a child of the `Variable` the arrow is
 * assigned to rather than of a function.
 */
const FIXTURE = `export interface Shape {
  area(): number;
}

export class Circle implements Shape {
  private radius = 1;

  area(): number {
    const twice = this.radius * 2;
    return twice * Math.PI;
  }
}

export function scale(value: number, factor: number): number {
  const scaled = value * factor;
  return scaled;
}

export const scaleAll = (values: number[]): number[] => {
  const inner = values.map((one) => scale(one, 2));
  return inner;
};

export enum Unit {
  Meter,
  Inch,
}
`;

/** The declarations that must carry a lens, by the text of their line. */
const EXPECTED = [
  "export interface Shape {",
  "area(): number;",
  "export class Circle implements Shape {",
  "area(): number {",
  "export function scale(value: number, factor: number): number {",
  "export const scaleAll = (values: number[]): number[] => {",
  "export enum Unit {",
  // `Unit.Meter` is a name another file writes, so it is counted -- and it is
  // counted through `Variable`, which is the kind TypeScript reports an enum
  // member as. Excluding `EnumMember` would not have taken this lens away.
  // Measured 2026-09-20: the editor's own TypeScript lens puts a count here too.
  "Meter,",
];

/** Declarations that must carry an implementation count, and what it must say. */
const IMPLS = {
  "export interface Shape {": "1 impl",
  "area(): number;": "1 impl",
};

/** Names that must never carry one, and what each of them is. */
const FORBIDDEN = {
  // The one place poly and the editor deliberately disagree: VSCode counts a
  // property, poly does not. "Who writes this field" is a different question
  // from the one a count above a declaration answers -- see `COUNTED_KINDS`.
  "private radius = 1;": "a property",
  "const twice = this.radius * 2;": "a local",
  "const scaled = value * factor;": "a local",
  "const inner = values.map((one) => scale(one, 2));": "a local of an arrow function",
};

/** The newest VSCode already downloaded, ordered by version and not by name. */
function cachedVSCode() {
  if (!existsSync(CACHE)) return null;
  const builds = readdirSync(CACHE)
    .map((name) => ({ name, version: /(\d+)\.(\d+)\.(\d+)$/.exec(name) }))
    .filter((build) => build.name.startsWith("vscode-") && build.version)
    .sort((a, b) =>
      Number(a.version[1]) - Number(b.version[1])
      || Number(a.version[2]) - Number(b.version[2])
      || Number(a.version[3]) - Number(b.version[3])
    );
  const build = builds.pop();
  if (!build) return null;
  const macos = join(CACHE, build.name, "Visual Studio Code.app", "Contents", "MacOS");
  return existsSync(macos) ? join(macos, readdirSync(macos)[0]) : null;
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VSCODE_")) delete process.env[key];
  }
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(join(ROOT, ".logs", "audit"), { recursive: true });
  const fixture = join(WORKSPACE, "shapes.ts");
  writeFileSync(fixture, FIXTURE);
  // Plaintext, so the only symbol provider in play is the one the suite
  // registers -- see `registerFlatProvider` for what it is proving.
  const flat = join(WORKSPACE, "flat.txt");
  writeFileSync(flat, "deploy\n\nusage\n\ncalled here\n");
  // The editor's own TypeScript lens, turned on so this file can be read by
  // both and the two placements compared. It is the only second opinion
  // available offline about where a reference count belongs, and poly's README
  // claims the editor ships one for TypeScript and nothing else.
  mkdirSync(join(WORKSPACE, ".vscode"), { recursive: true });
  writeFileSync(
    join(WORKSPACE, ".vscode", "settings.json"),
    `${
      JSON.stringify(
        {
          "typescript.referencesCodeLens.enabled": true,
          "typescript.referencesCodeLens.showOnAllFunctions": true,
          // poly's three lenses ship off. This check is about where they land,
          // so it turns on exactly the ones it reads -- a fixture that relied
          // on the shipped default would go from checking placement to
          // checking that nothing appears, and still pass its "no forbidden
          // lens" half.
          "poly.referencesCodeLens.enabled": true,
          "poly.runCodeLens.enabled": true,
          "poly.protobufCodeLens.enabled": true,
          // The checkout's build, as `make e2e` does: GraphQL and nginx are
          // answered by the daemon, and a bundled bin/poly is whichever release
          // was last packaged here, not the code under test.
          "poly.serverPath": process.env.POLY_BIN ?? join(ROOT, "cli", "target", "release", "poly"),
        },
        null,
        2,
      )
    }\n`,
  );

  const protoEnv = proto.writeFixture(WORKSPACE);
  const navigateEnv = navigate.writeFixture(WORKSPACE);

  execFileSync("pnpm", ["run", "build"], { cwd: LSP, stdio: "inherit" });

  await runTests({
    // poly-syntax alongside, because it is what gives a .proto the `protobuf`
    // language id poly's lens is registered for -- see proto.js.
    extensionDevelopmentPath: [LSP, proto.SYNTAX],
    extensionTestsPath: resolve(__dirname, "suite.js"),
    extensionTestsEnv: {
      POLY_LENS_FIXTURE: fixture,
      POLY_FLAT_FIXTURE: flat,
      POLY_LENS_OUT: OUT,
      POLY_COST_OUT: COST_OUT,
      ...protoEnv,
      ...navigateEnv,
    },
    ...(cachedVSCode() ? { vscodeExecutablePath: cachedVSCode() } : {}),
    launchArgs: [
      `--folder-uri=${pathToFileURL(WORKSPACE).toString()}`,
      `--user-data-dir=${join(SCRATCH, "user-data")}`,
      `--extensions-dir=${join(SCRATCH, "extensions")}`,
      "--disable-workspace-trust",
    ],
  });

  const report = JSON.parse(readFileSync(OUT, "utf8"));
  const lensed = new Set(report.lenses.filter((one) => one.poly.length > 0).map((one) => one.text));
  const problems = [];
  // A lens that never appeared would pass a "no forbidden lenses" check on its
  // own, so both halves are required: the declarations have to be counted, and
  // the names inside them have to be left alone.
  for (const text of EXPECTED) {
    if (!lensed.has(text)) problems.push(`no lens on a declaration: ${text}`);
  }
  for (const [text, what] of Object.entries(FORBIDDEN)) {
    if (lensed.has(text)) problems.push(`lens on ${what}: ${text}`);
  }
  // The other symbol shape. A provider answering in `SymbolInformation` has no
  // `selectionRange`, and every lens poly draws reads one -- so this is either
  // two counts or an exception swallowed into an empty lens list.
  const flatSaid = (report.flat ?? []).map((one) => `${one.line}:${one.title}`).sort();
  if (flatSaid.join() !== ["0:1 ref", "2:1 ref"].join()) {
    problems.push(
      `the flat symbol shape got no usable lens — expected 1 ref on lines 1 and 3, got `
        + JSON.stringify(flatSaid),
    );
  }

  const titles = new Map(report.lenses.map((one) => [one.text, one.poly]));
  for (const [text, said] of Object.entries(IMPLS)) {
    if (!(titles.get(text) ?? []).includes(said)) {
      problems.push(`no "${said}" on ${text} — got ${JSON.stringify(titles.get(text) ?? [])}`);
    }
  }
  // The other direction of the same query, and the reason it is not simply
  // drawn everywhere: measured 2026-09-21, TypeScript's implementation provider
  // answers nothing at `class Circle implements Shape`, so an unconditional
  // upward lens reads `no interfaces` over every class and method in the
  // language. poly earns that lens per language instead -- and this is the
  // check that says whether it stayed earned.
  for (const one of report.lenses) {
    const upward = one.poly.filter((title) => /interface/.test(title));
    if (upward.length > 0) {
      problems.push(
        `an upward implementation lens where the provider does not answer upward: `
          + `${one.text} says ${upward.join(", ")}`,
      );
    }
  }

  // What the References view's kind column is built on, asked of the same two
  // providers. Three claims, and poly reads every one of them as a fact:
  //
  //  1. `executeDocumentSymbolProvider` normalises the flat shape, so
  //     `outlineOf` can read `range` with no conversion. A conversion branch
  //     would be unreachable code, which is why there is none.
  //  2. A real server nests, so `enclosing` has something to descend into. The
  //     unit tests walk an outline this repo wrote and cannot say this.
  //  3. A container's `range` covers its body rather than just its name, which
  //     is the difference between "in method Handle" on every line of it and on
  //     exactly one.
  const flatMissing = (report.flatSymbols ?? []).filter((one) => !one.hasRange);
  if ((report.flatSymbols ?? []).length === 0) {
    problems.push("the flat provider reported no symbols, so nothing checked its shape");
  } else if (flatMissing.length > 0) {
    problems.push(
      `executeDocumentSymbolProvider stopped normalising: ${
        flatMissing.map((one) => one.name).join(", ")
      } arrived without a range, so the References view has no outline to read`,
    );
  }
  const outline = report.outline ?? [];
  if (!outline.some((one) => one.depth > 1)) {
    problems.push(
      "no symbol in the fixture is nested, so `enclosing` was never asked to descend",
    );
  }
  const bodyless = outline.filter((one) => one.depth > 1 && one.endLine === one.startLine);
  if (bodyless.length === outline.filter((one) => one.depth > 1).length) {
    problems.push(
      "every nested symbol's range is one line, so a reference inside one would resolve "
        + "to its container instead",
    );
  }

  problems.push(...proto.checkProto(report.proto));
  problems.push(...navigate.checkNavigate(report.navigate));

  console.log(
    `\nVSCode ${report.vscode}, ${report.lenses.length} lines carry a lens; `
      + `the flat symbol shape got ${JSON.stringify(flatSaid)}`,
  );
  console.log(
    `  ${"line".padStart(4)}  ${"poly".padEnd(14)} ${"typescript".padEnd(13)} ${"kind".padEnd(11)} declaration`,
  );
  for (const one of report.lenses) {
    console.log(
      `  ${String(one.line + 1).padStart(4)}  ${one.poly.join(", ").padEnd(14)} `
        + `${one.typescript.join(", ").padEnd(13)} ${one.kind.padEnd(11)} ${one.text}`,
    );
  }
  problems.push(...runnable.check());

  // What the lens asked of the server behind it, per gesture. See cost.js.
  const cost = JSON.parse(readFileSync(COST_OUT, "utf8"));
  console.log(
    `\nquestions put to a server answering in ${cost.answerMs}ms, `
      + `${cost.declarations} declarations, a click on ${cost.hitFiles * 2} hits in ${cost.hitFiles} files:`,
  );
  for (const [gesture, counts] of Object.entries(cost.phases)) {
    console.log(`  ${gesture.padEnd(13)} ${JSON.stringify(counts)}`);
  }
  // Only the counts poly decides are held down. Typing that changes no
  // declaration and a scroll over lenses already drawn were 17 reference and
  // 6-12 implementation queries each before 0.18.1; a click opened every file
  // it listed. What is left unbounded is the first open, which has to ask, and
  // a lens drawn again after its count went stale, which is the reuse window
  // doing its job.
  const { typing, scroll, click, clickSettled } = cost.phases;
  if (typing.references + typing.implementations > 0) {
    problems.push(`typing asked again: ${JSON.stringify(typing)}`);
  }
  if (scroll.implementations > 0) {
    problems.push(`a scroll probed implementations again: ${JSON.stringify(scroll)}`);
  }
  if (click.opened > 0) {
    problems.push(`the click opened ${click.opened} file(s) before the list appeared`);
  }
  // MAX_EXPANDED in extensions/lsp/src/editor/referenceTree.ts: the files that
  // arrive unfolded, each of which is an outline request.
  if (clickSettled.opened > 10) {
    problems.push(`the list opened ${clickSettled.opened} files, more than it unfolds`);
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log("\nevery declaration counted, nothing else touched");
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});

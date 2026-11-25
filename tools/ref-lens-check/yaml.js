// The YAML half: anchors, counted by the aliases that repeat them.
//
// Answered by the extension itself (src/editor/yamlAnchors.ts), not by the
// daemon and not by anybody's outline. What no unit test can say is that the
// editor asks it: that a lens lands on `&name`, that Go to Definition on
// `*name` arrives, and that none of it cost the file an outline.
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * Two documents that both anchor `defaults`.
 *
 * Matched by name, each `&defaults` would read `3 refs` and the second
 * document's alias would have two definitions. `&spare` is the anchor nothing
 * repeats, which is the count worth stopping at.
 */
const FIXTURE = `defaults: &defaults
  retries: 3
  image: &image app:1

web:
  <<: *defaults
  image: *image
worker:
  <<: *defaults
spare: &spare 1
---
base: &defaults
  retries: 5
api: *defaults
`;

/**
 * The fixture under both ids a bare VSCode gives a YAML file.
 *
 * `compose.yaml` opens as `dockercompose`, not `yaml` -- VSCode's own yaml
 * extension names it so -- and a compose file's `x-common: &common` is where
 * anchors are written most. Providers registered for `yaml` alone pass every
 * check on the first file and answer nothing on the second.
 */
const FILES = [
  { name: "anchors.yaml", language: "yaml" },
  { name: "compose.yaml", language: "dockercompose" },
];

/** Every lens a file may carry, by the text of its line. Exhaustive. */
const EXPECTED = {
  "defaults: &defaults": ["2 refs"],
  "image: &image app:1": ["1 ref"],
  "spare: &spare 1": ["no refs"],
  "base: &defaults": ["1 ref"],
};

/** Go to Definition, asked on an alias, and the line it must land on. */
const DEFINITIONS = [
  { line: "<<: *defaults", name: "*defaults", want: "defaults: &defaults" },
  { line: "image: *image", name: "*image", want: "image: &image app:1" },
  // The second document's own anchor, not the first one of that name.
  { line: "api: *defaults", name: "*defaults", want: "base: &defaults" },
];

exports.writeFixture = function writeFixture(workspace) {
  for (const file of FILES) {
    writeFileSync(join(workspace, file.name), FIXTURE);
  }
  return { POLY_YAML_DIR: workspace };
};

/** Each file's outline, what its lenses say, and where each definition lands. */
exports.observeYaml = async function observeYaml(lensesFor) {
  // Required here rather than at the top of the file: run.js loads this same
  // module in plain node, where `vscode` does not resolve.
  const vscode = require("vscode");
  const observed = [];
  for (const file of FILES) {
    const uri = vscode.Uri.file(join(process.env.POLY_YAML_DIR, file.name));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    const outline = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri) ?? [];
    const lenses = (await lensesFor(uri, Object.keys(EXPECTED).length)).map((lens) => ({
      text: document.lineAt(lens.range.start.line).text.trim(),
      title: lens.command?.title ?? "(unresolved)",
    }));
    const definitions = [];
    for (const asked of DEFINITIONS) {
      let line = 0;
      while (line < document.lineCount && document.lineAt(line).text.trim() !== asked.line) line++;
      const character = document.lineAt(line).text.indexOf(asked.name);
      const found = (await vscode.commands.executeCommand(
        "vscode.executeDefinitionProvider",
        uri,
        new vscode.Position(line, character + 1),
      )) ?? [];
      definitions.push({
        ...asked,
        landed: found.map((one) => document.lineAt((one.targetRange ?? one.range).start.line).text.trim()),
      });
    }
    observed.push({
      file: file.name,
      language: document.languageId,
      outline: outline.map((symbol) => symbol.name),
      lenses,
      definitions,
    });
  }
  return observed;
};

/** What one file's lenses and definitions said, and what is wrong with it. */
function checkFile(file, observed) {
  console.log(`  ${file.name}, opened as ${observed?.language}`);
  for (const one of observed?.lenses ?? []) {
    console.log(`    ${one.title.padEnd(8)} ${one.text}`);
  }
  const problems = [];
  if (observed?.language !== file.language) {
    problems.push(
      `${file.name} opened as ${observed?.language}, not ${file.language}: `
        + "what follows is not about the id this file is here for",
    );
  }
  // Sticky scroll follows an outline the moment a file has one, and a YAML
  // file's sticky lines are its parent keys only for as long as it has none.
  if ((observed?.outline ?? []).length > 0) {
    problems.push(
      `${file.name} has an outline (${observed.outline.join(", ")}), which sticky scroll follows `
        + "in place of the file's indentation",
    );
  }
  const said = new Map();
  for (const one of observed?.lenses ?? []) {
    said.set(one.text, [...(said.get(one.text) ?? []), one.title]);
  }
  for (const [text, want] of Object.entries(EXPECTED)) {
    const got = said.get(text) ?? [];
    if (got.join("; ") !== want.join("; ")) {
      problems.push(`${file.name}: ${text} — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
  for (const one of observed?.lenses ?? []) {
    if (!Object.hasOwn(EXPECTED, one.text)) {
      problems.push(`${file.name}: a lens on a line that anchors nothing: ${one.text} says ${one.title}`);
    }
  }
  for (const one of observed?.definitions ?? []) {
    console.log(`    definition of ${one.name} at ${one.line} -> ${JSON.stringify(one.landed)}`);
    if (JSON.stringify(one.landed) !== JSON.stringify([one.want])) {
      problems.push(
        `${file.name}: definition of ${one.name} at ${one.line} — expected ${JSON.stringify([one.want])}, got ${
          JSON.stringify(one.landed)
        }`,
      );
    }
  }
  if (!observed?.definitions?.length) {
    problems.push(`${file.name}: no definitions were asked: the suite never reached them`);
  }
  return problems;
}

/** What the YAML lenses and definitions said, and what is wrong with it. */
exports.checkYaml = function checkYaml(observed) {
  console.log("\nYAML anchors, answered by the extension:");
  return FILES.flatMap((file) => checkFile(file, (observed ?? []).find((one) => one.file === file.name)));
};

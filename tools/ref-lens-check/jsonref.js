// The `$ref` half: Go to Definition on a JSON Reference, and the finding on
// one that leads nowhere.
//
// Both are poly's daemon (cli/crates/poly-engines/src/json_ref.rs), and the
// Rust tests say where a reference leads. What they cannot say is the editor's
// half: that the daemon's registration reaches `json`, `jsonc` and `yaml`
// documents, that the answer arrives as exactly one place -- VSCode's own JSON
// support follows a `$ref` as a link, and a second definition beside poly's
// would turn every F12 into a list to choose from -- and that a spec opened in
// an editor has its dangling reference in Problems.
const { mkdirSync, writeFileSync } = require("node:fs");
const { join, relative } = require("node:path");

/**
 * An OpenAPI 3 spec in YAML, a Swagger 2 one in JSON, the two files they share,
 * and a JSON Schema.
 *
 * The schema is here because it is no spec: its references are followed all the
 * same, and nothing in it is reported.
 */
const FIXTURE = {
  "spec/openapi.yaml": `openapi: 3.0.3
info:
  title: Pets
  version: "1"
paths:
  /pets/{id}:
    get:
      responses:
        "200":
          description: A pet
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Pet"
components:
  schemas:
    Pet:
      type: object
      properties:
        owner:
          $ref: "./shared/owner.yaml#/Owner"
        tag:
          $ref: shared/tag.json
    Lost:
      $ref: "#/components/schemas/Pte"
`,
  "spec/openapi.json": `{
  "swagger": "2.0",
  "info": { "title": "Pets", "version": "1" },
  "paths": {},
  "definitions": {
    "Pet": {
      "type": "object",
      "properties": {
        "owner": { "$ref": "#/definitions/Owner" },
        "tag": { "$ref": "shared/tag.json" }
      }
    },
    "Owner": { "type": "string" }
  }
}
`,
  "spec/shared/owner.yaml": `Owner:
  type: string
`,
  "spec/shared/tag.json": `{ "type": "string" }
`,
  "spec/pet.schema.json": `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "name": { "type": "string" }
  },
  "properties": {
    "name": { "$ref": "#/$defs/name" },
    "gone": { "$ref": "#/$defs/nope" }
  }
}
`,
};

/**
 * Go to Definition, asked inside a `$ref`'s string, and the one line it must
 * land on -- or `null` where it must land nowhere.
 *
 * The files under `shared/` are never opened: the daemon reads them from disk.
 */
const DEFINITIONS = [
  { file: "spec/openapi.yaml", ref: "#/components/schemas/Pet\"", want: ["spec/openapi.yaml", "Pet:"] },
  { file: "spec/openapi.yaml", ref: "./shared/owner.yaml#/Owner", want: ["spec/shared/owner.yaml", "Owner:"] },
  { file: "spec/openapi.yaml", ref: "shared/tag.json", want: ["spec/shared/tag.json", "{ \"type\": \"string\" }"] },
  { file: "spec/openapi.yaml", ref: "#/components/schemas/Pte", want: null },
  {
    file: "spec/openapi.json",
    ref: "#/definitions/Owner",
    want: ["spec/openapi.json", "\"Owner\": { \"type\": \"string\" }"],
  },
  { file: "spec/openapi.json", ref: "shared/tag.json", want: ["spec/shared/tag.json", "{ \"type\": \"string\" }"] },
  {
    file: "spec/pet.schema.json",
    ref: "#/$defs/name",
    want: ["spec/pet.schema.json", "\"name\": { \"type\": \"string\" }"],
  },
  { file: "spec/pet.schema.json", ref: "#/$defs/nope", want: null },
];

/** The finding each file must carry, by the reference it is on. Exhaustive. */
const FINDINGS = {
  "spec/openapi.yaml": ["#/components/schemas/Pte"],
  "spec/openapi.json": [],
  "spec/pet.schema.json": [],
};

const CODE = "openapi-unresolved-ref";

/** Long enough for a lint the daemon runs on open to be published. */
const PUBLISHED_MS = 20_000;

exports.writeFixture = function writeFixture(workspace) {
  mkdirSync(join(workspace, "spec", "shared"), { recursive: true });
  for (const [name, body] of Object.entries(FIXTURE)) {
    writeFileSync(join(workspace, name), body);
  }
  return { POLY_REF_WORKSPACE: workspace };
};

/** Where each reference lands, and what Problems says about each opened file. */
exports.observeJsonRef = async function observeJsonRef() {
  // Required here rather than at the top of the file: run.js loads this same
  // module in plain node, where `vscode` does not resolve.
  const vscode = require("vscode");
  const dir = process.env.POLY_REF_WORKSPACE;
  const codeOf = (diagnostic) => String(diagnostic.code?.value ?? diagnostic.code ?? "");

  const definitions = [];
  for (const asked of DEFINITIONS) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(dir, asked.file)));
    await vscode.window.showTextDocument(document);
    const offset = document.getText().indexOf(asked.ref);
    const found = (await vscode.commands.executeCommand(
      "vscode.executeDefinitionProvider",
      document.uri,
      document.positionAt(offset + 2),
    )) ?? [];
    const landed = [];
    for (const location of found) {
      const uri = location.targetUri ?? location.uri;
      const range = location.targetSelectionRange ?? location.targetRange ?? location.range;
      const target = await vscode.workspace.openTextDocument(uri);
      landed.push([relative(dir, uri.fsPath).replaceAll("\\", "/"), target.lineAt(range.start.line).text.trim()]);
    }
    definitions.push({ ...asked, language: document.languageId, landed });
  }

  const findings = [];
  for (const [file, want] of Object.entries(FINDINGS)) {
    const uri = vscode.Uri.file(join(dir, file));
    const document = await vscode.workspace.openTextDocument(uri);
    const mine = () => vscode.languages.getDiagnostics(uri).filter((one) => codeOf(one) === CODE);
    // A file expected to carry none is not waited on: the spec above it in
    // this list was, and its finding is what proves the lint is being published.
    const deadline = Date.now() + (want.length > 0 ? PUBLISHED_MS : 0);
    while (mine().length < want.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    findings.push({
      file,
      on: mine().map((one) => document.getText(one.range)),
      source: [...new Set(mine().map((one) => one.source))],
      severity: [...new Set(mine().map((one) => vscode.DiagnosticSeverity[one.severity]))],
    });
  }
  return { definitions, findings };
};

/** What was observed, and what is wrong with it. */
exports.checkJsonRef = function checkJsonRef(observed) {
  console.log("\n$ref in JSON and YAML, answered by poly's daemon:");
  const problems = [];
  for (const one of observed?.definitions ?? []) {
    console.log(`  ${one.file.padEnd(21)} ${one.ref.padEnd(28)} -> ${JSON.stringify(one.landed)}`);
    const want = one.want ? [one.want] : [];
    if (JSON.stringify(one.landed) !== JSON.stringify(want)) {
      problems.push(
        `definition of ${one.ref} in ${one.file} (${one.language}) — expected ${JSON.stringify(want)}, got ${
          JSON.stringify(one.landed)
        }`,
      );
    }
  }
  if ((observed?.definitions ?? []).length !== DEFINITIONS.length) {
    problems.push("not every $ref definition was asked: the suite never reached them");
  }
  for (const [file, want] of Object.entries(FINDINGS)) {
    const got = (observed?.findings ?? []).find((one) => one.file === file);
    console.log(`  ${file.padEnd(21)} ${CODE}: ${JSON.stringify(got?.on ?? null)}`);
    if (JSON.stringify(got?.on) !== JSON.stringify(want)) {
      problems.push(`${file}: ${CODE} — expected on ${JSON.stringify(want)}, got ${JSON.stringify(got?.on ?? null)}`);
    }
    if (want.length > 0 && JSON.stringify([got?.source, got?.severity]) !== JSON.stringify([["poly"], ["Error"]])) {
      problems.push(`${file}: ${CODE} — expected poly at Error, got ${JSON.stringify([got?.source, got?.severity])}`);
    }
  }
  return problems;
};

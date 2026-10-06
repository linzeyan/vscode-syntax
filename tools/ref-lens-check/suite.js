// Where poly's reference lens actually lands, asked of a real language server.
//
// The unit tests hand `lensTargets` a symbol tree this repo wrote, so they can
// only be as right as the assumption behind them -- and that assumption is
// exactly what was wrong: parameters and locals arrive as `Variable` children
// of the declaration they sit in, which no hand-written fixture had said. The
// only way to hold that down is to ask a server that really reports symbols.
//
// TypeScript, because it is the one real provider a test host has offline:
// VSCode ships it, so this needs no marketplace extension and no network. What
// it pins is the shape every server shares -- a declaration's body is full of
// names, and none of them is a declaration another file can reach.
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const vscode = require("vscode");

const { measure: measureCost } = require("./cost");
const { observeNavigate } = require("./navigate");
const { observeProto } = require("./proto");
const runnable = require("./runnable");

/** Long enough for the TypeScript server to load the file, then give up. */
const READY_MS = 60_000;

/**
 * The lenses on `uri`, once there are `atLeast` of them and the count holds.
 *
 * `atLeast` exists for the one caller that is testing a file which must carry
 * no lens at all: an empty list is both "none" and "not published yet", so the
 * default of one keeps the wait honest, and a caller that means zero has to
 * say so.
 *
 * Zero settles after the count holds rather than after any proof the provider
 * ran, which would be a real hole if poly's lenses could arrive late. They
 * cannot: all three providers fire `onDidChangeCodeLenses` only when a `poly.*`
 * setting changes, and no fixture changes one, so the first answer is the final
 * one. The settle loop is here for TypeScript's lens, which waits for its
 * project -- and the only TypeScript fixture asks for `atLeast` of one. The one
 * late lens is an upward count, drawn after the refs lens beside it has asked;
 * `observeUpward` waits for it by number.
 */
async function lensesFor(uri, atLeast = 1) {
  const deadline = Date.now() + READY_MS;
  let lenses = [];
  let settled = 0;
  // Until the count stops changing, not until the first lens appears. poly's
  // lens is published as soon as the document has symbols; TypeScript's waits
  // for the project, and returning early reported that the editor places no
  // reference lens at all -- which is the claim this check exists to test.
  while (Date.now() < deadline && settled < 6) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const now = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri, 50) ?? [];
    settled = now.length >= atLeast && now.length === lenses.length ? settled + 1 : 0;
    lenses = now;
  }
  return lenses;
}

/**
 * A provider that answers in the older of the two symbol shapes.
 *
 * `SymbolInformation` is flat and carries a `location` where `DocumentSymbol`
 * carries a `selectionRange`, and a server picks which -- bash-language-server
 * answers in this one, gopls in the other. Every lens poly draws reads
 * `selectionRange`, so the flat shape looks like it must be converted first.
 *
 * Measured 2026-09-21: it must not be. `executeDocumentSymbolProvider`
 * normalises, and hands back objects carrying both, so poly needs no
 * conversion -- and writing one is actively wrong, because the test that tells
 * the shapes apart by `location` matches the normalised object too and throws
 * every nested symbol away. That is what this check is here to keep saying.
 *
 * Registered against plaintext so it is the only provider in play: TypeScript's
 * cannot be asked to answer in a shape it does not use, and the built-in would
 * be merged with it anyway.
 */
function registerFlatProvider(uri) {
  const selector = { scheme: "file", language: "plaintext" };
  const at = (line) => new vscode.Location(uri, new vscode.Range(line, 0, line, 8));
  return [
    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols() {
        return [
          new vscode.SymbolInformation("deploy", vscode.SymbolKind.Function, "", at(0)),
          new vscode.SymbolInformation("usage", vscode.SymbolKind.Function, "", at(2)),
        ];
      },
    }),
    vscode.languages.registerReferenceProvider(selector, {
      provideReferences(_document, position) {
        // The declaration and one use, so the count is `1 ref` and not `no
        // refs` -- a provider that answers at all answers with the declaration.
        return [
          new vscode.Location(uri, new vscode.Range(position.line, 0, position.line, 8)),
          new vscode.Location(uri, new vscode.Range(4, 0, 4, 8)),
        ];
      },
    }),
  ];
}

/**
 * Two classes in a language whose implementation provider answers upward, and
 * only one of them satisfies anything.
 *
 * gopls answers at `type Circle struct` with the interface it satisfies, and
 * with nothing at the many structs and methods that satisfy none -- each of
 * which read `no interfaces`. The upward count is now drawn only once it is
 * known to be above zero, so both halves are pinned: the class with an
 * interface says so, and the other carries its refs and nothing more. `log`,
 * because nothing else in the host answers for it, and a language that has
 * answered upward stays that way for the session.
 */
async function observeUpward(lensesFor) {
  const file = join(vscode.workspace.workspaceFolders[0].uri.fsPath, "upward.log");
  writeFileSync(file, "Circle\n\nLoose\n\nShape\n\ncalled here\n");
  const uri = vscode.Uri.file(file);
  const selector = { scheme: "file", language: "log" };
  const word = (line) => new vscode.Range(line, 0, line, 5);
  const disposables = [
    vscode.languages.registerDocumentSymbolProvider(selector, {
      provideDocumentSymbols() {
        return [
          new vscode.DocumentSymbol("Circle", "", vscode.SymbolKind.Class, word(0), word(0)),
          new vscode.DocumentSymbol("Loose", "", vscode.SymbolKind.Class, word(2), word(2)),
        ];
      },
    }),
    vscode.languages.registerReferenceProvider(selector, {
      provideReferences(_document, position) {
        return [new vscode.Location(uri, word(position.line)), new vscode.Location(uri, word(6))];
      },
    }),
    vscode.languages.registerImplementationProvider(selector, {
      provideImplementation(_document, position) {
        return position.line === 0 ? [new vscode.Location(uri, word(4))] : [];
      },
    }),
  ];
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  // Three: two refs and the one interface, which arrives a redraw later.
  const said = (await lensesFor(uri, 3)).map((lens) =>
    `${lens.range.start.line}:${lens.command?.title ?? "(unresolved)"}`
  );
  for (const disposable of disposables) {
    disposable.dispose();
  }
  return said.sort();
}

exports.run = async function run() {
  await vscode.extensions.getExtension("ricky.poly-lsp").activate();

  const flatUri = vscode.Uri.file(process.env.POLY_FLAT_FIXTURE);
  const disposables = registerFlatProvider(flatUri);
  const flatDocument = await vscode.workspace.openTextDocument(flatUri);
  await vscode.window.showTextDocument(flatDocument);
  const flat = (await lensesFor(flatUri)).map((lens) => ({
    line: lens.range.start.line,
    title: lens.command?.title ?? "(unresolved)",
  }));
  // The other half of the flat-shape claim, and the one the References view
  // depends on. `referenceTree.outlineOf` reads `range` off every symbol with
  // no conversion, on the strength of `executeDocumentSymbolProvider`
  // normalising both shapes before handing them back. This is the provider that
  // really answers in the old one, so if the normalisation ever stops, the
  // field is missing here.
  const flatSymbols = (await vscode.commands.executeCommand(
    "vscode.executeDocumentSymbolProvider",
    flatUri,
  ) ?? []).map((symbol) => ({
    name: symbol.name,
    hasRange: Boolean(symbol.range),
  }));
  for (const disposable of disposables) {
    disposable.dispose();
  }
  const upward = await observeUpward(lensesFor);

  const uri = vscode.Uri.file(process.env.POLY_LENS_FIXTURE);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);

  const lenses = await lensesFor(uri);
  // Both providers publish into the same list, and the workspace turns the
  // editor's own TypeScript lens on: "where does VSCode put one" is the only
  // outside opinion available about where a reference count belongs. They are
  // told apart by what they say -- poly counts "refs" and "impls", TypeScript
  // counts "references".
  const byLine = new Map();
  for (const lens of lenses) {
    const title = lens.command?.title ?? "(unresolved)";
    const line = lens.range.start.line;
    const entry = byLine.get(line) ?? { poly: [], typescript: [] };
    entry[/references?$/.test(title) ? "typescript" : "poly"].push(title);
    byLine.set(line, entry);
  }

  // What the server called each of them. The rule is written in symbol kinds,
  // so a lens in the wrong place is only half a finding until the kind that put
  // it there is on the record -- an enum member reported as `Constant` and one
  // reported as `EnumMember` are two different bugs, or none.
  const kinds = new Map();
  // ...and the shape of the tree they came in, which is what the References
  // view's kind column is computed from. `referenceRows.enclosing` finds the
  // innermost symbol whose `range` contains a line; its unit tests walk an
  // outline this repo wrote, so this is the only place that says a real server
  // nests at all and that a container's range covers its body rather than its
  // name. Both were assumptions until this recorded them.
  const outline = [];
  const collect = (symbols, depth) => {
    for (const symbol of symbols ?? []) {
      kinds.set(symbol.selectionRange.start.line, vscode.SymbolKind[symbol.kind]);
      outline.push({
        name: symbol.name,
        kind: vscode.SymbolKind[symbol.kind],
        depth,
        nameLine: symbol.selectionRange.start.line,
        startLine: symbol.range.start.line,
        endLine: symbol.range.end.line,
      });
      collect(symbol.children, depth + 1);
    }
  };
  collect(await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri), 1);

  const lines = [...byLine.keys()].sort((a, b) => a - b).map((line) => ({
    line,
    text: document.lineAt(line).text.trim(),
    kind: kinds.get(line) ?? "(not a symbol)",
    ...byLine.get(line),
  }));

  // The .proto half, whole in its own module: it brings its own servers.
  const proto = await observeProto();
  // And GraphQL and nginx, whose providers are poly's daemon.
  const navigate = await observeNavigate(lensesFor);

  writeFileSync(
    process.env.POLY_LENS_OUT,
    `${
      JSON.stringify(
        { vscode: vscode.version, lenses: lines, flat, flatSymbols, upward, outline, proto, navigate },
        null,
        2,
      )
    }\n`,
  );
  console.log(`ref-lens: ${lines.length} lines carry a lens, ${flat.length} on the flat shape`);

  // Last, and with the TypeScript server already warm: it writes its own file
  // and needs nothing from the report above.
  await runnable.collect(lensesFor);

  // After everything else, with every editor closed: it counts questions, and
  // a lens from another section resolving meanwhile would be counted too.
  const cost = await measureCost(vscode.workspace.workspaceFolders[0].uri.fsPath);
  writeFileSync(process.env.POLY_COST_OUT, `${JSON.stringify(cost, null, 2)}\n`);
};

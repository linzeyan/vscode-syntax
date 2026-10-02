// Where poly's `run | debug` lens lands, asked of a real editor.
//
// `runnable.ts`'s unit tests are the only other thing that reads this feature,
// and they read it the way the reference lens's tests once did: against a
// symbol tree this repo wrote by hand. That is how `no interfaces` shipped over
// every TypeScript class and `no impls` over every proto rpc -- each rule was
// right about its fixture and wrong about the host. So this asks a host, and
// asks about both halves, because the halves reach it by different routes: one
// reads a symbol provider, the other reads the document's text.
//
// Five files rather than one, because the rule is per language and the claims
// worth pinning are about a language having exactly one of the two routes --
// or neither, which is the answer for most of the files in either language.
const { createHash } = require("node:crypto");
const { readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

/**
 * Where this check keeps the fixture workspace and the editor state it makes.
 *
 * Keyed by the checkout rather than fixed, because it was fixed and two
 * worktrees running `make ref-lens` at once shared one user-data directory and
 * one fixture workspace: the second editor to start read the first one's
 * files, which is a failure that looks like a flaky assertion. Stable across
 * runs of one checkout, so the editor state is reused rather than rebuilt.
 *
 * Agreed here because both processes of this check load this module -- see
 * `OUT` -- and they have to land on the same directory.
 */
const SCRATCH = join(
  tmpdir(),
  `poly-ref-lens-${createHash("sha1").update(resolve(__dirname, "..", "..")).digest("hex").slice(0, 8)}`,
);

/**
 * What the host saw, on its way back out.
 *
 * Its own file rather than a key in `suite.js`'s report: both sides of this
 * check load this module, so the path is agreed here and neither of the two
 * shared files has to carry an env var or a field for it.
 */
const OUT = join(SCRATCH, "runnable.json");

/**
 * What each button has to invoke, spelled out here rather than imported.
 *
 * Importing them from `extension.ts` would make this check agree with whatever
 * that file says, which is not a check.
 *
 * The pair used to be `workbench.action.debug.run` and `.start` -- ctrl+F5 and
 * F5. Both are debug commands, so both wanted a launch configuration and both
 * raised the debug toolbar, and the button labelled `run` was describing
 * something it did not do. `run` is now poly's own command, which runs the
 * file the way Code Runner's Run Code does; `debug` still hands over, because
 * poly ships no debugger.
 */
const RUNS = { run: "poly.runFile", debug: "workbench.action.debug.start" };

/**
 * One file per claim, and `entry` is the line that must carry the pair.
 *
 * `null` means the file must carry no pair at all. That is not an oversight in
 * the fixture, it is the feature: a `.py` with no guard would run and do
 * nothing, and a `.sh` with no shebang is usually something another script
 * sources. Ordered so that each silent file is opened after one of its own
 * language has already answered -- see `collect` for why that matters.
 */
const FIXTURES = [
  {
    // The symbol route, through the one real provider a test host has offline.
    // A fake here would prove the rule against this repo's own idea of what a
    // server reports, which is the mistake the unit tests already make.
    file: "entry.ts",
    entry: "export function main(): void {",
    // Both: `run` is offered wherever Code Runner's executor maps have a
    // command for the file, and TypeScript's is `ts-node`.
    buttons: ["debug", "run"],
    text: `export function main(): void {
  console.log("poly");
}
`,
  },
  {
    // The text route, and the exclusivity it is supposed to buy: `def main` is
    // right there and is reported as a symbol, so a rule that consulted both
    // routes would draw a second pair on it.
    file: "guarded.py",
    entry: `if __name__ == "__main__":`,
    buttons: ["debug", "run"],
    text: `def main() -> None:
    print("poly")


if __name__ == "__main__":
    main()
`,
  },
  {
    // The same `def main`, the same symbol, no guard. Silence is the only
    // right answer, and it is the one the symbol route cannot give.
    file: "library.py",
    entry: null,
    text: `def main() -> None:
    print("poly")
`,
  },
  {
    file: "entry.sh",
    entry: "#!/usr/bin/env bash",
    buttons: ["debug", "run"],
    text: `#!/usr/bin/env bash
set -euo pipefail

echo "poly"
`,
  },
  {
    file: "helpers.sh",
    entry: null,
    text: `log() {
  echo "$@" >&2
}
`,
  },
];

/**
 * A `def main` that a symbol provider really reports.
 *
 * Measured 2026-09-21: a bare host answers `executeDocumentSymbolProvider` with
 * nothing at all for Python -- the symbol tree comes from an extension nobody
 * installed here. Without this the claim "the text rule wins over the symbol
 * tree" would pass for the wrong reason: there would be no symbol tree to win
 * against. So this is the one fake, and it is the smallest thing that makes the
 * claim falsifiable -- a single `Function` named `main`, on the fixture's `def`.
 */
function fakePythonSymbols(vscode) {
  return vscode.languages.registerDocumentSymbolProvider(
    { scheme: "file", language: "python" },
    {
      provideDocumentSymbols() {
        return [
          new vscode.DocumentSymbol(
            "main",
            "",
            vscode.SymbolKind.Function,
            new vscode.Range(0, 0, 1, 0),
            new vscode.Range(0, 4, 0, 8),
          ),
        ];
      },
    },
  );
}

exports.SCRATCH = SCRATCH;

/** Open every fixture in the host and write down what carries a lens. */
exports.collect = async function collect(lensesFor) {
  // Loaded here and not at the top of the file because `run.js` loads this
  // module too, and outside the extension host there is no `vscode` to load.
  const vscode = require("vscode");

  const folder = vscode.workspace.workspaceFolders[0].uri;
  const disposable = fakePythonSymbols(vscode);
  const seen = [];
  for (const fixture of FIXTURES) {
    const uri = vscode.Uri.joinPath(folder, fixture.file);
    writeFileSync(uri.fsPath, fixture.text);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    // A file with no entry point must carry no lens, and `lensesFor` cannot
    // tell "none" from "not published yet" -- so those wait for a count that
    // stays zero instead of one that stops growing. What keeps that honest is
    // the order above: a file of the same language has already answered, so
    // the provider is known to be alive and asked about this language.
    const lenses = await lensesFor(uri, fixture.entry === null ? 0 : 1);
    const symbols = await vscode.commands.executeCommand(
      "vscode.executeDocumentSymbolProvider",
      uri,
    );
    seen.push({
      file: fixture.file,
      language: document.languageId,
      symbols: (symbols ?? []).map((symbol) => symbol.name),
      lenses: lenses.map((lens) => ({
        line: lens.range.start.line,
        title: lens.command?.title ?? "(unresolved)",
        command: lens.command?.command ?? "(none)",
        text: document.lineAt(lens.range.start.line).text.trim(),
      })),
    });
  }
  disposable.dispose();

  writeFileSync(OUT, `${JSON.stringify(seen, null, 2)}\n`);
  console.log(`run-lens: ${seen.length} fixtures opened`);
};

/** What the host saw, printed; what is wrong with it, returned. */
exports.check = function check() {
  const seen = JSON.parse(readFileSync(OUT, "utf8"));
  // Read once, then taken away. A check that reads a file it did not watch
  // being written can pass on the last run's answer, which is how a gate goes
  // quietly dead: if the host ever stops calling `collect`, this throws.
  rmSync(OUT);
  const problems = [];
  const rows = [];

  for (const fixture of FIXTURES) {
    const one = seen.find((each) => each.file === fixture.file);
    if (!one) {
      problems.push(`the host never opened ${fixture.file}`);
      continue;
    }
    // Told apart from every other lens in the list by what it says: poly's
    // reference count and the editor's own both publish into the same array.
    const buttons = one.lenses.filter((lens) => lens.title === "run" || lens.title === "debug");
    const lines = [...new Set(buttons.map((lens) => lens.line))].sort((a, b) => a - b);
    rows.push({
      file: fixture.file,
      language: one.language,
      symbols: one.symbols.join(", ") || "-",
      said: buttons.map((lens) => lens.title).join(", ") || "(none)",
      where: lines.map((line) => `${line + 1}: ${one.lenses.find((l) => l.line === line).text}`)
        .join(" | "),
    });

    if (fixture.entry === null) {
      for (const button of buttons) {
        problems.push(
          `${fixture.file} has no entry point but carries "${button.title}" `
            + `on line ${button.line + 1}: ${button.text}`,
        );
      }
      continue;
    }
    // Every part of this is load-bearing: one line, because a Python file that
    // got buttons from the text rule and another set from the symbol tree
    // would otherwise pass; the exact titles, because which buttons a language
    // gets is now a claim rather than a constant; and the line's own text,
    // because the buttons being *somewhere* is the claim the unit tests
    // already make.
    if (lines.length !== 1) {
      problems.push(
        `${fixture.file} should carry one pair of buttons, on ${JSON.stringify(fixture.entry)}, `
          + `but ${lines.length} line(s) carry one: ${
            JSON.stringify(buttons.map((lens) => `${lens.line + 1}: ${lens.text}`))
          }`,
      );
      continue;
    }
    const said = buttons.map((lens) => lens.title).sort();
    if (said.join() !== fixture.buttons.join()) {
      problems.push(
        `${fixture.file} carries ${JSON.stringify(said)} and not ${JSON.stringify(fixture.buttons)}`,
      );
    }
    if (buttons[0].text !== fixture.entry) {
      problems.push(
        `${fixture.file} puts run | debug on ${JSON.stringify(buttons[0].text)} `
          + `and not on ${JSON.stringify(fixture.entry)}`,
      );
    }
    // What the buttons actually invoke. poly ships no debugger and decides
    // nothing but placement, so these two ids are the entire feature -- and a
    // renamed one is the failure this cannot afford to miss, because it looks
    // identical until someone clicks. The host will not press them for us
    // (`workbench.action.debug.start` wants a launch configuration and a user),
    // so the id is as far as an offline check can follow the click.
    for (const button of buttons) {
      const wanted = RUNS[button.title];
      if (button.command !== wanted) {
        problems.push(
          `${fixture.file}'s "${button.title}" runs ${JSON.stringify(button.command)}, `
            + `not ${JSON.stringify(wanted)}`,
        );
      }
    }
  }

  // The control for the exclusivity claim above. If the fake provider stops
  // answering, every Python assertion here still passes -- and says nothing,
  // because the symbol route it is supposed to beat would be empty too.
  for (const file of ["guarded.py", "library.py"]) {
    const one = seen.find((each) => each.file === file);
    if (one && !one.symbols.includes("main")) {
      problems.push(
        `no symbol provider reported main for ${file}, so "the text rule wins over the `
          + `symbol tree" was never tested — got ${JSON.stringify(one.symbols)}`,
      );
    }
  }

  console.log(
    `\n  ${"fixture".padEnd(11)} ${"language".padEnd(12)} ${"symbols".padEnd(8)} `
      + `${"buttons".padEnd(11)} on`,
  );
  for (const row of rows) {
    console.log(
      `  ${row.file.padEnd(11)} ${row.language.padEnd(12)} ${row.symbols.padEnd(8)} `
        + `${row.said.padEnd(11)} ${row.where}`,
    );
  }
  return problems;
};

# formulahendry.code-runner

From [formulahendry/vscode-code-runner](https://github.com/formulahendry/vscode-code-runner) 0.12.2 (commit
`97af1080d09046e0129acce592f0033ff2df9f26`, the marketplace's 0.12.2). MIT (`LICENSE.txt`, from the repository).

- `codeManager.ts` is upstream's `src/codeManager.ts`, method for method, with `src/utility.ts` and
  `src/constants.ts` folded in. `executor.ts` is the part of it that decides what runs -- `getExecutor` and
  `getFinalCommandToRunCodeFile` -- moved out, because the run lens asks it too and because it is what the unit
  tests hold to upstream's behaviour.
- `code-runner-output.tmLanguage` is upstream's `syntaxes/` grammar for `[Running]` and `[Done]` in the output.
- upstream's `src/extension.ts` is `../codeRunner.ts`, which also decides when all of this stands aside.
- The commands, keys, menus and settings are upstream's `package.json`, in poly's manifest.

What differs, and why:

- Names. Settings are `poly.codeRunner.*` rather than `code-runner.*`, with the same names and defaults; commands
  are `poly.codeRunner.*`, the context key `poly.codeRunner.codeRunning`, the output panel and the terminal
  `Code Runner` rather than `Code`. With Code Runner installed too, the same command ids would collide, and two
  panels named `Code` could not be told apart.
- `poly.codeRunner.enabled`, off by default, is new: poly's editor features ship off. The commands, menus and keys
  show only when it is on, and not while formulahendry.code-runner is installed and enabled. Stop Code Run shows
  whenever a run poly started is going, switch or not, because the run lens starts runs with the switch off. Its
  context menu entry in the output panel shows only then, rather than in every output panel.
- `ctrl+alt+m` (Stop Code Run) is bound only while a run is going: on Windows and Linux it is also poly's Minify,
  in the languages Minify handles, and stopping nothing should not take it from Minify.
- No telemetry: `enableAppInsights` and `appInsightsClient.ts` are gone, with the applicationinsights dependency.
- Three defaults in `executorMap` are not upstream's. They are the cases the run lens got right before it ran
  through this, and upstream's default would have broken them:
  - `go` is `cd $dir && go run .`, not `go run`. A main package is rarely one file, and `go run main.go` fails on
    the first symbol defined in the file next door.
  - `rust` is `cd $dir && cargo run`, not `cd $dir && rustc $fileName && $dir$fileNameWithoutExt`. `rustc` on a
    crate's `main.rs` cannot see the crate's dependencies, and leaves a binary in `src/`. A single `.rs` file with
    no `Cargo.toml` needs upstream's line back in `poly.codeRunner.executorMap`.
  - `python` is `$pythonPath -u $fullFileName`, not `python -u`: the interpreter the Python extension has selected,
    and without it `python3` (`python` on Windows) rather than upstream's `python`, which macOS and most Linux
    distributions no longer install.
  - The cost: Run Code on a selection of Go or Rust no longer runs just the selection. The temporary file it is
    written to lands in the package, where `go run .` compiles it with the rest, and `cargo run` runs the crate
    without it. `poly.codeRunner.executorMapByGlob` can give `tempCodeRunnerFile.go` and `tempCodeRunnerFile.rs`
    upstream's executors back.
- Stopping. upstream's tree-kill walks `ps` for the shell's descendants; here the shell is started detached on Unix,
  so it leads its own process group, and one signal to the group reaches the same processes. On Windows both run
  `taskkill /T /F`. One dependency fewer.
- Globs are matched with picomatch, which is what micromatch's `isMatch` calls: the same matching, one dependency
  fewer.
- The output panel's language is set when it is made, `poly-code-runner-output`, with the grammar's scope renamed
  `poly.code-runner.output`. upstream claimed the MIME type every output panel has, so that its grammar coloured
  them all; poly's colours its own, and does not clash with upstream's when both are installed.
- Bugs fixed, each a piece of state carried over from a previous run:
  - Closing any terminal made upstream forget its own, and open a second one on the next run.
  - `$workspaceRoot` was the previous run's folder, or the file's own, whenever `cwd` was set.
  - Run Custom Command with no editor open ran against the previous run's file.
  - A run that ended after another had started deleted that run's temporary file rather than its own.
  - A placeholder's value containing `$&` or `$1` was read as a replacement pattern.
  - A process that could not start (a `cwd` that no longer exists) threw in the extension host; its error is
    written to the panel.
- The terminal and the output panel are made on first use and closed with the extension. upstream made the panel at
  startup, which would put an empty `Code Runner` in the Output list of everyone who never turns this on, and a
  terminal left open across a reload is one this would not know and would open a second beside.

The run lens (`../runnable.ts`, `poly.runFile`) runs through `CodeManager.run` too, with one difference: it runs the
whole file whatever is selected, and saves it first even with `saveFileBeforeRun` off. A button over `main` that ran
the selection, or the file as last saved, would look exactly like a change that did not work.

import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { commandLine, ExecutorSettings, fallbackPython, resolveExecutor } from "./codeRunner/executor";

const manifest = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
const defaults = manifest.contributes.configuration.properties.poly.default.codeRunner;
const defaultOf = (key: string) => defaults[key];

/** What the shipped settings say, untouched -- what a user who changed nothing runs with. */
const SHIPPED: ExecutorSettings = {
  respectShebang: defaultOf("respectShebang"),
  executorMapByGlob: defaultOf("executorMapByGlob"),
  executorMap: defaultOf("executorMap"),
  executorMapByFileExtension: defaultOf("executorMapByFileExtension"),
  defaultLanguage: defaultOf("defaultLanguage"),
};

const file = (languageId: string, fileName: string, firstLine = "") => ({ languageId, fileName, firstLine });
const run = (languageId: string, fileName: string, firstLine = "", settings = SHIPPED) => {
  const found = resolveExecutor(settings, file(languageId, fileName, firstLine));
  return found && commandLine(found.executor, fileName, { workspaceFolder: "/w", pythonPath: "python3" });
};

test("a glob beats the language, which beats the extension, which beats the default", () => {
  const settings: ExecutorSettings = {
    respectShebang: true,
    executorMapByGlob: { "*.test.js": "tap" },
    executorMap: { javascript: "node", python: "python3" },
    executorMapByFileExtension: { ".js": "deno run", ".mjs": "deno run" },
    defaultLanguage: "python",
  };
  assert.deepEqual(resolveExecutor(settings, file("javascript", "/w/a.test.js")), {
    executor: "tap",
    languageId: "javascript",
  });
  assert.deepEqual(resolveExecutor(settings, file("javascript", "/w/a.js")), {
    executor: "node",
    languageId: "javascript",
  });
  // The extension's entry is found under the extension, and the temporary
  // file a selection is written to takes its extension from that.
  assert.deepEqual(resolveExecutor(settings, file("plaintext", "/w/a.mjs")), {
    executor: "deno run",
    languageId: ".mjs",
  });
  assert.deepEqual(resolveExecutor(settings, file("plaintext", "/w/notes.txt")), {
    executor: "python3",
    languageId: "python",
  });
  assert.equal(resolveExecutor({ ...settings, defaultLanguage: "" }, file("plaintext", "/w/notes.txt")), undefined);
});

test("a glob is matched against the file's name, not its path", () => {
  // pom.xml is the shipped glob: a Maven build wherever the project sits.
  assert.equal(run("xml", "/w/deep/er/pom.xml"), "cd \"/w/deep/er/\" && mvn clean package");
  assert.equal(run("xml", "/w/pom.xml.bak"), undefined);
});

test("a shebang comes first, unless the language was picked by hand", () => {
  // Not the language's executor: the script names its own interpreter, and a
  // `#!/bin/zsh` script run under bash breaks quietly rather than loudly.
  assert.equal(run("shellscript", "/w/d.sh", "#!/bin/zsh"), "/bin/zsh \"/w/d.sh\"");
  assert.equal(run("python", "/w/t.py", "#!/usr/bin/env python3.12"), "/usr/bin/env python3.12 \"/w/t.py\"");
  assert.equal(run("shellscript", "/w/d.sh", "#!/bin/zsh", { ...SHIPPED, respectShebang: false }), "bash \"/w/d.sh\"");
  // Run By Language: the user chose, and the shebang does not overrule them.
  assert.equal(resolveExecutor(SHIPPED, file("shellscript", "/w/d.sh", "#!/bin/zsh"), "perl")?.executor, "perl");
  // A shebang has to be the first line; one further down is a comment, and
  // `#![...]` opens a Rust file's inner attributes.
  assert.equal(run("rust", "/w/src/main.rs", "#![allow(dead_code)]"), "cd \"/w/src/\" && cargo run");
});

test("every placeholder, in the order that keeps the longer names whole", () => {
  const line = commandLine(
    "$workspaceRoot|$fileNameWithoutExt|$fullFileName|$fileName|$driveLetter|$dirWithoutTrailingSlash|$dir|$pythonPath",
    "/w/src/app.test.py",
    { workspaceFolder: "/w", pythonPath: "/w/.venv/bin/python" },
  );
  assert.equal(
    line,
    "/w|app.test|\"/w/src/app.test.py\"|app.test.py|$driveLetter|\"/w/src\"|\"/w/src/\"|/w/.venv/bin/python",
  );
  assert.equal(commandLine("$driveLetter $dir", "C:\\w\\a.py", { pythonPath: "python" }), "C: \"C:\\w\\\"");
  // Outside a workspace the file's own folder stands in for its root.
  assert.equal(commandLine("cd $workspaceRoot", "/tmp/x/a.js", { pythonPath: "python3" }), "cd /tmp/x/");
});

test("the file goes on the end only where no placeholder put it somewhere", () => {
  assert.equal(commandLine("node", "/w/a.js", { pythonPath: "python3" }), "node \"/w/a.js\"");
  // A name with a space stays one argument.
  assert.equal(commandLine("ruby", "/w/my app.rb", { pythonPath: "python3" }), "ruby \"/w/my app.rb\"");
  // Run Custom Command appends nothing, and with no file open has nothing to
  // put in a placeholder.
  assert.equal(commandLine("make $fileNameWithoutExt", "/w/a.c", { pythonPath: "python3" }, false), "make a");
  assert.equal(commandLine("echo Hello", "/w/a.c", { pythonPath: "python3" }, false), "echo Hello");
  assert.equal(commandLine("echo $fileName", undefined, { pythonPath: "python3" }, false), "echo $fileName");
});

test("a path with a dollar in it is put in as it is", () => {
  assert.equal(commandLine("cat $fullFileName", "/w/$&.txt", { pythonPath: "python3" }), "cat \"/w/$&.txt\"");
});

// The cases the run lens used to answer from its own four-line table, and the
// reason each shipped default differs from Code Runner's.
test("Go runs its package: a main package is rarely one file", () => {
  // `go run main.go`, Code Runner's default, fails on the first symbol
  // defined next door -- which reads as a broken button, not a wrong command.
  assert.equal(run("go", "/w/cmd/serve/main.go"), "cd \"/w/cmd/serve/\" && go run .");
});

test("Rust runs its crate: rustc on main.rs cannot see the crate's dependencies", () => {
  assert.equal(run("rust", "/w/src/main.rs"), "cd \"/w/src/\" && cargo run");
});

test("Python runs under the selected interpreter, python3 without one, python on Windows", () => {
  assert.equal(
    resolveExecutor(SHIPPED, file("python", "/w/app.py"))?.executor,
    "$pythonPath -u $fullFileName",
  );
  assert.equal(
    commandLine("$pythonPath -u $fullFileName", "/w/my app.py", { pythonPath: fallbackPython("darwin") }),
    "python3 -u \"/w/my app.py\"",
  );
  assert.equal(fallbackPython("linux"), "python3");
  // `python3` on Windows is a Store stub that opens the Store.
  assert.equal(fallbackPython("win32"), "python");
});

test("the lens offers run wherever the shipped table has an answer, and nowhere else", () => {
  // Every language whose entry point the lens finds -- including the ones the
  // old table left to `debug` alone because they compile first.
  const entries = [
    ["go", "main.go"],
    ["rust", "main.rs"],
    ["python", "app.py"],
    ["shellscript", "d.sh"],
    ["c", "main.c"],
    ["cpp", "main.cpp"],
    ["java", "App.java"],
    ["csharp", "Program.cs"],
    ["typescript", "entry.ts"],
  ];
  for (const [languageId, name] of entries) {
    assert.notEqual(resolveExecutor(SHIPPED, file(languageId, `/w/${name}`)), undefined, languageId);
  }
  // A language no map covers draws `debug` alone.
  assert.equal(resolveExecutor(SHIPPED, file("cobol", "/w/MAIN.cbl")), undefined);
  assert.equal(resolveExecutor(SHIPPED, file("plaintext", "/w/notes.txt")), undefined);
});

test("Code Runner is off until switched on, and carries upstream's settings but telemetry", () => {
  const keys = Object.keys(defaults);
  assert.equal(defaultOf("enabled"), false);
  // Upstream's telemetry switch is not carried over; everything else is.
  assert.equal(keys.length, 23);
  assert.ok(!keys.includes("enableAppInsights"));
});

test("Code Runner's commands show only when switched on and not standing aside", () => {
  // A rename on either side -- the manifest's `when` or codeRunner.ts's
  // context key -- would put a second ▶ next to Code Runner's own, or show
  // poly's with the switch off, and nothing else would fail.
  const gated = ["poly.codeRunner.run", "poly.codeRunner.runCustomCommand", "poly.codeRunner.runByLanguage"];
  type Entry = { command: string; when?: string };
  const menus = Object.values(manifest.contributes.menus as Record<string, Entry[]>).flat();
  const entries = [...menus, ...manifest.contributes.keybindings].filter((one) => gated.includes(one.command));
  // Palette, editor and Explorer context menus, editor title, and the keys.
  assert.equal(entries.length, 3 + 1 + 1 + 1 + 3);
  for (const entry of entries) {
    assert.match(entry.when ?? "", /config\.poly\.codeRunner\.enabled && !poly\.yield\.codeRunner\b/, entry.command);
  }
  // Stop is reachable whenever something poly started is running -- the
  // lens runs with the switch off -- except by key, where ctrl+alt+m is
  // Minify's when nothing is.
  const stops = [...menus, ...manifest.contributes.keybindings].filter((one) => one.command === "poly.codeRunner.stop");
  for (const stop of stops) {
    assert.match(stop.when ?? "", /poly\.codeRunner\.codeRunning/, JSON.stringify(stop));
  }
  const key = manifest.contributes.keybindings.find((one: { command: string }) =>
    one.command === "poly.codeRunner.stop"
  );
  assert.match(
    key.when,
    /config\.poly\.codeRunner\.enabled && !poly\.yield\.codeRunner && poly\.codeRunner\.codeRunning/,
  );
});

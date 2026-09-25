import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { Binding, chordOf, YIELDING, yieldKey, yieldsTo } from "./chords";

// The real manifests, as they shipped when the collision was measured --
// quicktype's case and modifier order included.
const PASTE_IMAGE: Binding = { command: "extension.pasteImage", key: "ctrl+alt+v", mac: "cmd+alt+v" };
const QUICKTYPE: Binding = { command: "quicktype.pasteJSONAsTypes", key: "ctrl+shift+alt+V", mac: "cmd+shift+alt+V" };
const REWRAP: Binding = { command: "rewrap.rewrapComment", key: "alt+q" };
const ROO_CODE: Binding = {
  command: "roo-cline.toggleAutoApprove",
  key: "cmd+alt+a",
  mac: "cmd+alt+a",
  win: "ctrl+alt+a",
  linux: "ctrl+alt+a",
};

const manifest = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
const own: Binding[] = manifest.contributes.keybindings;

test("poly gives cmd+alt+v and cmd+alt+shift+v to the extensions installed for them", () => {
  const others = [
    { id: "mushan.vscode-paste-image", bindings: [PASTE_IMAGE] },
    { id: "quicktype.quicktype", bindings: [QUICKTYPE] },
  ];
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.deepEqual(
      [...yieldsTo(own, others, platform)],
      [
        ["poly.extractVariable", "mushan.vscode-paste-image"],
        ["poly.inlineVariable", "quicktype.quicktype"],
      ],
      platform,
    );
  }
});

// Measured: with Rewrap installed, alt+q ran Revert and Save and the
// uncommitted edit under the cursor was gone from disk.
test("poly's git keys go to Rewrap and to Roo Code, which bind them too", () => {
  const others = [
    { id: "stkb.rewrap", bindings: [REWRAP] },
    { id: "RooVeterinaryInc.roo-cline", bindings: [ROO_CODE] },
  ];
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.deepEqual(
      [...yieldsTo(own, others, platform)],
      [
        ["poly.previousChangedFile", "RooVeterinaryInc.roo-cline"],
        ["poly.revertAndSave", "stkb.rewrap"],
      ],
      platform,
    );
  }
});

// One such manifest anywhere used to throw inside poly's activation, and
// nothing of poly -- not even the language server -- started.
test("an entry VSCode would reject is skipped, not thrown on", () => {
  const others = [
    {
      id: "bad.keys",
      bindings: [
        null,
        "cmd+alt+v",
        { command: "bad.number", key: 5 },
        { command: 5, key: "cmd+alt+v", mac: "cmd+alt+v" },
        { command: "bad.when", key: "ctrl+alt+v", mac: "cmd+alt+v", when: true },
      ],
    },
    { id: "mushan.vscode-paste-image", bindings: [{ command: "a.b", mac: null, key: 7 }, PASTE_IMAGE] },
  ];
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.deepEqual([...yieldsTo(own, others, platform)], [["poly.extractVariable", "mushan.vscode-paste-image"]]);
  }
});

test("nothing yields when nobody else binds the chord", () => {
  const others = [{ id: "a.b", bindings: [{ command: "a.go", key: "ctrl+alt+b", mac: "cmd+alt+b" }] }];
  assert.equal(yieldsTo(own, others, "darwin").size, 0);
});

test("a removal is not a claim, and neither is another platform's key", () => {
  const others = [
    // `-command` unbinds; it takes nothing.
    { id: "a.b", bindings: [{ command: "-editor.action.foo", mac: "cmd+alt+v" }] },
    // Binds cmd+alt+v on mac only; on Linux its key is something else.
    { id: "c.d", bindings: [{ command: "c.go", key: "ctrl+shift+v", mac: "cmd+alt+v" }] },
  ];
  assert.equal(yieldsTo(own, others, "linux").size, 0);
  assert.deepEqual([...yieldsTo(own, others, "darwin").keys()], ["poly.extractVariable"]);
});

test("modifier order does not make a different chord", () => {
  assert.equal(chordOf({ mac: "Alt+Cmd+V" }, "darwin"), chordOf({ mac: "cmd+alt+v" }, "darwin"));
  assert.equal(chordOf({ key: "ctrl+k  ctrl+s" }, "linux"), "ctrl+k ctrl+s");
});

// The context key only works if the manifest's `when` reads it; a rename on
// either side would leave the chord taken with nothing failing.
test("every yielding command's when clause reads its yield key", () => {
  for (const command of YIELDING) {
    const binding = manifest.contributes.keybindings.find((b: { command: string }) => b.command === command);
    assert.ok(binding, command);
    assert.match(binding.when, new RegExp(`!${yieldKey(command).replace(/\./g, "\\.")}\\b`), command);
  }
});

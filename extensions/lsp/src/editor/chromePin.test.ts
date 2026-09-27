import * as assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as PB from "@puppeteer/browsers";

import { CHROME_BUILD, CHROME_SHA256, downloadChrome } from "./chromePin";

test("the pinned Chrome is the one puppeteer-core was made for", () => {
  // Upgrading puppeteer-core moves its build. A pin left behind would still
  // download and pass its digest, but it would print with a Chrome the
  // protocol was never tested against.
  const { PUPPETEER_REVISIONS } = require("puppeteer-core");
  assert.equal(CHROME_BUILD, PUPPETEER_REVISIONS.chrome);
});

test("both platforms the VSIX ships for have a digest", () => {
  // darwin-arm64 and win32-x64. A missing entry would turn every export on
  // that platform into an error whenever no Chrome is installed.
  for (const platform of [PB.BrowserPlatform.MAC_ARM, PB.BrowserPlatform.WIN64]) {
    assert.match(CHROME_SHA256[platform] ?? "", /^[0-9a-f]{64}$/, platform);
  }
});

test("an archive that is not the pinned one is never unpacked, and is deleted", async () => {
  // Put where install() looks first, so no network is involved: this is the
  // state that a truncated download, or a tampered one, leaves behind.
  const cacheDir = mkdtempSync(join(tmpdir(), "chrome-pin-"));
  const chromeDir = join(cacheDir, "chrome");
  mkdirSync(chromeDir);
  const archive = join(chromeDir, `${CHROME_BUILD}-chrome-mac-arm64.zip`);
  writeFileSync(archive, "not chrome");

  await assert.rejects(downloadChrome(cacheDir, PB.BrowserPlatform.MAC_ARM, () => {}), /sha256/);
  assert.equal(existsSync(archive), false, "left in place, it would be reused by the next export");
  assert.deepEqual(readdirSync(chromeDir), [], "nothing may be unpacked from it");
});

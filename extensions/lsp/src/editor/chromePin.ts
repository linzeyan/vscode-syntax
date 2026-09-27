/**
 * The Chrome that markdown export downloads when none is set or installed
 * (markdownPdf.ts).
 *
 * It is the Chrome for Testing build that puppeteer-core was released against,
 * because that is the only build its printing is tested with. yzane.markdown-pdf
 * instead fetches whatever Stable is newest. There is one archive per platform
 * the VSIX ships for, each pinned by digest like everything else poly downloads.
 * Google publishes no sha256 for these, so the digests are of the archives as
 * fetched on 2026-09-27, whose MD5s matched the ones Cloud Storage reports.
 *
 * No `vscode` import, so the node test runner can exercise the download.
 */
import * as PB from "@puppeteer/browsers";
import { createHash } from "crypto";
import { createReadStream, rmSync } from "fs";

export const CHROME_BUILD = "146.0.7680.153";

/** Keyed by @puppeteer/browsers' platform name. */
export const CHROME_SHA256: Readonly<Record<string, string>> = {
  mac_arm: "81872a7f6ea110f0204bc859db9729bd990c165c338aae86950876e6133310f2",
  win64: "bcfa1f1e46ddf5f21225b82e2ba4f2e29db5d5391b07cb0c00fd184f8aacafff",
};

/**
 * Downloads the pinned Chrome into `cacheDir` and returns its executable.
 *
 * The download is checked before it is unpacked. install() skips the fetch
 * when the archive is already at its path, so it is called twice: first to
 * fetch only, then, after the digest matches, to unpack. A mismatched archive
 * is deleted, so the next export fetches it again instead of failing on it
 * forever.
 */
export async function downloadChrome(
  cacheDir: string,
  platform: PB.BrowserPlatform,
  onProgress: (downloadedBytes: number, totalBytes: number) => void,
): Promise<string> {
  const sha256 = CHROME_SHA256[platform];
  if (!sha256) {
    throw new Error(`poly pins no Chrome for Testing for ${platform}`);
  }
  const options = { browser: PB.Browser.CHROME, buildId: CHROME_BUILD, cacheDir, platform };
  const archive = await PB.install({ ...options, unpack: false, downloadProgressCallback: onProgress });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) {
    hash.update(chunk);
  }
  const digest = hash.digest("hex");
  if (digest !== sha256) {
    rmSync(archive, { force: true });
    throw new Error(`${archive}: sha256 ${digest}, pinned ${sha256}`);
  }
  return (await PB.install({ ...options, unpack: true })).executablePath;
}

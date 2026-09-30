import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

// Every poly extension releases in lockstep (02 §8), and each one runs this
// check on its own schedule, from its own settings section: either can be
// installed alone, and someone with only the grammars still has to hear about a
// release. Whichever finds a release first updates every poly extension that is
// installed, so two extensions still mean one download and one reload.
//
// Installed without asking. Through 0.18.10 a release was offered with an Install
// button, which is a question the update switch had already answered: someone
// with `updateCheck.enabled` on still had to click, and a machine nobody
// clicked on stayed behind. The reload is still theirs to choose.
const REPO = "linzeyan/vscode-syntax";

/**
 * Every poly extension, as the release asset it installs from and the id it
 * installs as. Grammars first, so a reload part-way through an install still
 * has a grammar and a client that match.
 *
 * Updated only when the user already has them: installing an extension
 * somebody deliberately does not have is not an update -- it is poly deciding
 * what belongs on their machine.
 */
const PACKAGES: readonly [asset: (version: string) => string, id: string][] = [
  [(version) => `poly-syntax-highlight-${version}.vsix`, "ricky.poly-syntax-highlight"],
  [(version) => `poly-lsp-${vsceTarget()}-${version}.vsix`, "ricky.poly-lsp"],
];
const LAST_CHECK = "updateCheck.lastCheck";
const ETAG = "updateCheck.etag";
const CACHED_TAG = "updateCheck.cachedTag";

interface Release {
  tag: string;
  htmlUrl: string;
  assets: Map<string, string>; // name -> browser_download_url
}

/** win32-x64 style identifier matching our vsce package targets. */
function vsceTarget(): string {
  const platform = process.platform === "win32"
    ? "win32"
    : process.platform === "darwin"
    ? "darwin"
    : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${platform}-${arch}`;
}

/**
 * Is the release GitHub last named newer than what is installed?
 *
 * The cached tag is not "already seen" in any sense that matters: seeing a
 * release is not installing it. A download that failed, or a prompt dismissed
 * back when there was one, leaves exactly this state behind -- and until 0.18.1
 * the check below treated it as "nothing to do", so a 304 kept a machine on
 * 0.11.0 through seven releases.
 */
export function knownNewer(cachedTag: string | undefined, current: string): boolean {
  return cachedTag !== undefined && isNewer(cachedTag, current);
}

/**
 * Should the check ask GitHub "has anything changed since this ETag"?
 *
 * Only when the cached answer is one there is nothing to do about. A 304
 * carries no body, and the asset list an install needs is in the body -- so
 * while the cached tag is still ahead of this install, the question has to be
 * asked in full or the answer cannot be acted on.
 */
export function revalidates(
  etag: string | undefined,
  cachedTag: string | undefined,
  current: string,
): boolean {
  return etag !== undefined && cachedTag !== undefined && !knownNewer(cachedTag, current);
}

async function fetchLatest(
  state: vscode.Memento,
  current: string,
): Promise<Release | undefined> {
  const headers: Record<string, string> = {
    "User-Agent": "poly-lsp",
    Accept: "application/vnd.github+json",
  };
  const etag = state.get<string>(ETAG);
  const cachedTag = state.get<string>(CACHED_TAG);
  if (etag && revalidates(etag, cachedTag, current)) {
    headers["If-None-Match"] = etag;
  }
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    { headers },
  );
  if (res.status === 304 && cachedTag) {
    // Only reachable when the cached tag is not newer than this install, which
    // is the one case where "unchanged" really does mean "nothing to update".
    return undefined;
  }
  // /releases/latest skips pre-releases, so a repo carrying only -rc tags
  // answers 404. That is "nothing to update to", not a failure.
  if (res.status === 404) {
    return undefined;
  }
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}`);
  }
  const body = (await res.json()) as {
    tag_name: string;
    html_url: string;
    assets: { name: string; browser_download_url: string }[];
  };
  await state.update(ETAG, res.headers.get("etag") ?? undefined);
  await state.update(CACHED_TAG, body.tag_name);
  return {
    tag: body.tag_name,
    htmlUrl: body.html_url,
    assets: new Map(body.assets.map((a) => [a.name, a.browser_download_url])),
  };
}

export function isNewer(latestTag: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parse(latestTag), parse(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      return (a[i] ?? 0) > (b[i] ?? 0);
    }
  }
  return false;
}

async function download(url: string, dest: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { "User-Agent": "poly-lsp" } });
  if (!res.ok) {
    throw new Error(`download failed (${res.status}): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(dest, buf);
  return buf;
}

/** Download the installed ones' VSIX, verify against SHA256SUMS, install, prompt reload. */
async function installUpdate(release: Release): Promise<void> {
  const version = release.tag.replace(/^v/, "");
  // Filtered before the download rather than before the install: there is no
  // reason to spend the bytes on a VSIX this machine will not take.
  const names = PACKAGES.filter(([, id]) => vscode.extensions.getExtension(id))
    .map(([asset]) => asset(version));
  const sumsUrl = release.assets.get("SHA256SUMS");
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "poly-update-"));
  const files: string[] = [];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Poly: downloading ${release.tag}…`,
    },
    async () => {
      const sums = sumsUrl
        ? await (await fetch(sumsUrl, { headers: { "User-Agent": "poly-lsp" } })).text()
        : "";
      for (const name of names) {
        const url = release.assets.get(name);
        if (!url) {
          throw new Error(`release has no asset ${name}`);
        }
        const dest = path.join(dir, name);
        const buf = await download(url, dest);
        // TOFU is not enough for updates: the sums file rides in the same
        // release, but it still catches truncated/corrupted downloads.
        if (sums) {
          const digest = crypto.createHash("sha256").update(buf).digest("hex");
          if (!sums.includes(`${digest}  ${name}`)) {
            throw new Error(`sha256 mismatch for ${name}`);
          }
        }
        files.push(dest);
      }
    },
  );

  try {
    for (const file of files) {
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        vscode.Uri.file(file),
      );
    }
  } catch (err) {
    // Fallback (02 §8): reveal the downloaded files for manual install.
    const pick = await vscode.window.showWarningMessage(
      `Poly: automatic install failed (${err}). The VSIX files were downloaded — install them manually via "Extensions: Install from VSIX".`,
      "Show Files",
    );
    if (pick === "Show Files") {
      await vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(files[0]),
      );
    }
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `Poly ${release.tag} installed. Reload to activate.`,
    "Reload Window",
    "Release Notes",
  );
  if (pick === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  } else if (pick === "Release Notes") {
    await vscode.env.openExternal(vscode.Uri.parse(release.htmlUrl));
  }
}

export async function checkForUpdates(
  context: vscode.ExtensionContext,
  quiet: boolean,
  log: (line: string) => void,
): Promise<void> {
  const state = context.globalState;
  const current = context.extension.packageJSON.version as string;
  let release: Release | undefined;
  try {
    release = await fetchLatest(state, current);
    // Recorded only once GitHub has answered. Written before the fetch, a
    // check that never got there -- offline, or the unauthenticated 60/hr API
    // budget exhausted -- still spent the whole interval, and the background
    // path only console.warns, so the next check moved a week out with nothing
    // on screen to say why. A 304 and a 404 both count: those reached GitHub.
    await state.update(LAST_CHECK, Date.now());
  } catch (err) {
    // Network failures are routine (offline, rate limit): never toast on the
    // background path. Into poly's own log rather than console.warn, which
    // lands in the extension host log where nobody looking at "Poly" finds it.
    if (quiet) {
      log(`[update] check failed: ${err}`);
    } else {
      vscode.window.showWarningMessage(`Poly: update check failed: ${err}`);
    }
    return;
  }
  if (!release) {
    if (!quiet) {
      vscode.window.setStatusBarMessage("Poly: no new release", 5000);
    }
    return;
  }
  if (!isNewer(release.tag, current)) {
    if (!quiet) {
      vscode.window.setStatusBarMessage(
        `Poly: up to date (${current})`,
        5000,
      );
    }
    return;
  }
  if (quiet && !firstToInstall(release.tag)) {
    return;
  }
  try {
    await installUpdate(release);
  } catch (err) {
    // Said out loud on either path, unlike a failed check: GitHub answered,
    // a release is waiting, and poly could not put it on this machine. Only
    // logged, a missing VSIX kept a WSL install behind with nothing on screen.
    log(`[update] installing ${release.tag} failed: ${err}`);
    vscode.window.showWarningMessage(`Poly: could not install ${release.tag}: ${err}`);
  }
}

/**
 * The release a background check in this extension host already took on,
 * whichever poly extension found it. Both run in one host, so a global is the
 * one thing they share without either depending on the other being installed.
 */
const INSTALLING = Symbol.for("poly.updateCheck.installing");

function firstToInstall(tag: string): boolean {
  const host = globalThis as { [INSTALLING]?: string };
  if (host[INSTALLING] === tag) {
    return false;
  }
  host[INSTALLING] = tag;
  return true;
}

/**
 * Is a background check due: at most once per `days` (02 §8), unless a newer
 * release is already known and not yet installed.
 *
 * The interval is there to spare GitHub's API, not to ration updates. Once a
 * newer tag is on record, waiting out the week just means an install that
 * failed -- offline half-way through a download -- is retried a week late.
 */
export function updateDue(
  state: vscode.Memento,
  current: string,
  days: number,
  now = Date.now(),
): boolean {
  return knownNewer(state.get<string>(CACHED_TAG), current)
    || now - state.get<number>(LAST_CHECK, 0) >= days * 86_400_000;
}

/**
 * Deferred background check, governed by `<section>.updateCheck.enabled` and
 * `<section>.updateCheck.intervalDays` -- `poly` for Poly, `poly.syntax` for
 * poly-syntax-highlight.
 */
export function scheduleUpdateCheck(
  context: vscode.ExtensionContext,
  section: string,
  log: (line: string) => void,
): void {
  const config = vscode.workspace.getConfiguration(section);
  if (!config.get<boolean>("updateCheck.enabled", true)) {
    return;
  }
  const current = context.extension.packageJSON.version as string;
  if (!updateDue(context.globalState, current, config.get<number>("updateCheck.intervalDays", 7))) {
    return;
  }
  const timer = setTimeout(() => void checkForUpdates(context, true, log), 10_000);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}

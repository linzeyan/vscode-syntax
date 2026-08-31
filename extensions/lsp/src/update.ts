import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

// Every poly extension releases in lockstep (02 §8); poly-lsp owns the update
// check for all of them, because it is the one that already runs a daemon and
// already has a status bar to say something went wrong in.
const REPO = "linzeyan/vscode-syntax";

/**
 * The universal VSIX that ship alongside poly-lsp, and the extension id each
 * one installs as.
 *
 * Updated only when the user already has them. poly-lsp works standalone (both
 * READMEs document that), and installing an extension somebody deliberately
 * does not have is not an update -- it is poly deciding what belongs on their
 * machine.
 */
const COMPANIONS: readonly [string, string][] = [
  ["poly-syntax-highlight", "ricky.poly-syntax-highlight"],
  ["poly-editor", "ricky.poly-editor"],
];
const LAST_CHECK = "updateCheck.lastCheck";
const ETAG = "updateCheck.etag";
const CACHED_TAG = "updateCheck.cachedTag";
const SKIPPED = "updateCheck.skippedVersion";

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

async function fetchLatest(
  state: vscode.Memento,
): Promise<Release | undefined> {
  const headers: Record<string, string> = {
    "User-Agent": "poly-lsp",
    Accept: "application/vnd.github+json",
  };
  const etag = state.get<string>(ETAG);
  const cachedTag = state.get<string>(CACHED_TAG);
  if (etag && cachedTag) {
    headers["If-None-Match"] = etag;
  }
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    { headers },
  );
  if (res.status === 304 && cachedTag) {
    // Unchanged since last check; no need to re-parse assets because an
    // unchanged tag can only mean an already-seen (or current) version.
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

function isNewer(latestTag: string, current: string): boolean {
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

/** Download both VSIX, verify against SHA256SUMS, install, prompt reload. */
async function installUpdate(release: Release): Promise<void> {
  const version = release.tag.replace(/^v/, "");
  // Companions first, so a reload part-way through an install still has a
  // grammar and a client that match. Filtered before the download rather than
  // before the install: there is no reason to spend the bytes on a VSIX this
  // machine will not take.
  const names = [
    ...COMPANIONS.filter(([, id]) => vscode.extensions.getExtension(id))
      .map(([name]) => `${name}-${version}.vsix`),
    `poly-lsp-${vsceTarget()}-${version}.vsix`,
  ];
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
  );
  if (pick === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

export async function checkForUpdates(
  context: vscode.ExtensionContext,
  quiet: boolean,
): Promise<void> {
  const state = context.globalState;
  try {
    await state.update(LAST_CHECK, Date.now());
    const release = await fetchLatest(state);
    if (!release) {
      if (!quiet) {
        vscode.window.setStatusBarMessage("Poly: no new release", 5000);
      }
      return;
    }
    const current = context.extension.packageJSON.version as string;
    if (!isNewer(release.tag, current)) {
      if (!quiet) {
        vscode.window.setStatusBarMessage(
          `Poly: up to date (${current})`,
          5000,
        );
      }
      return;
    }
    if (quiet && state.get<string>(SKIPPED) === release.tag) {
      return;
    }
    const pick = await vscode.window.showInformationMessage(
      `Poly ${release.tag} is available (installed: ${current}).`,
      "Install",
      "Release Notes",
      "Skip This Version",
    );
    if (pick === "Install") {
      await installUpdate(release);
    } else if (pick === "Release Notes") {
      await vscode.env.openExternal(vscode.Uri.parse(release.htmlUrl));
    } else if (pick === "Skip This Version") {
      await state.update(SKIPPED, release.tag);
    }
  } catch (err) {
    // Network failures are routine (offline, rate limit): never toast on the
    // background path.
    if (quiet) {
      console.warn(`poly update check failed: ${err}`);
    } else {
      vscode.window.showWarningMessage(`Poly: update check failed: ${err}`);
    }
  }
}

/** Deferred background check, at most once per intervalDays (02 §8). */
export function scheduleUpdateCheck(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("poly");
  if (!config.get<boolean>("updateCheck.enabled", true)) {
    return;
  }
  const days = config.get<number>("updateCheck.intervalDays", 7);
  const last = context.globalState.get<number>(LAST_CHECK, 0);
  if (Date.now() - last < days * 86_400_000) {
    return;
  }
  const timer = setTimeout(() => void checkForUpdates(context, true), 10_000);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}

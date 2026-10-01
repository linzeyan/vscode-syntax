/**
 * What each of Git Graph's actions does to a repository, as git commands.
 *
 * Each runs the commands mhutchie.git-graph 1.30.0 runs for the same action
 * and options, observed by running it with a git that logs its arguments;
 * tools/git-graph-diff/actions.js runs both sides on copies of one repository
 * and compares what they leave behind. The options are the ones its dialogs
 * offer, and the defaults are its defaults.
 *
 * Kept apart from `vscode` so that comparison can load it.
 */
import type { Git } from "./gitGraphData";
import type { Remote } from "./gitGraphProtocol";

export { gitIn } from "./gitGraphData";

export type MergeKind = "branch" | "remote branch" | "commit";
/** No-ff is Git Graph's default: a merge commit even when a fast-forward would do. */
export type MergeMode = "no-ff" | "ff" | "squash" | "no-commit";
export type PullMode = "merge" | "no-ff" | "squash";
export type ResetMode = "soft" | "mixed" | "hard";
export type ForceMode = "" | "force-with-lease" | "force";

/** After a squash, commit what it staged -- if it staged anything -- as Git Graph does. */
async function commitSquash(run: Git, message: string): Promise<void> {
  const staged = await run(["diff-index", "--cached", "--name-only", "HEAD"]);
  if (staged.trim() !== "") {
    await run(["commit", "-m", message]);
  }
}

export const checkoutBranch = (run: Git, branch: string) => run(["checkout", branch]);

export const checkoutRemoteBranch = (run: Git, remoteBranch: string, local: string) =>
  run(["checkout", "-b", local, remoteBranch]);

export const checkoutCommit = (run: Git, hash: string) => run(["checkout", hash]);

export const createBranch = (run: Git, name: string, at: string, checkout: boolean) =>
  run(checkout ? ["checkout", "-b", name, at] : ["branch", name, at]);

export const deleteBranch = (run: Git, name: string, force: boolean) =>
  run(["branch", "--delete", ...force ? ["--force"] : [], name]);

export const renameBranch = (run: Git, from: string, to: string) => run(["branch", "-m", from, to]);

export const deleteRemoteBranch = (run: Git, remote: string, branch: string) =>
  run(["push", remote, "--delete", branch]);

export const fetchIntoLocalBranch = (run: Git, remote: string, remoteBranch: string, local: string, force: boolean) =>
  run(["fetch", ...force ? ["-f"] : [], remote, `${remoteBranch}:${local}`]);

export async function pullBranch(run: Git, remote: string, branch: string, mode: PullMode): Promise<void> {
  await run(["pull", remote, branch, ...mode === "no-ff" ? ["--no-ff"] : mode === "squash" ? ["--squash"] : []]);
  if (mode === "squash") {
    await commitSquash(run, `Merge branch '${remote}/${branch}'`);
  }
}

export async function merge(run: Git, ref: string, kind: MergeKind, mode: MergeMode): Promise<void> {
  const options = { "no-ff": ["--no-ff"], ff: [], squash: ["--squash"], "no-commit": ["--no-ff", "--no-commit"] }[mode];
  await run(["merge", ref, ...options]);
  if (mode === "squash") {
    await commitSquash(run, `Merge ${kind} '${ref}'`);
  }
}

/** Author dates are reset by default, as Git Graph's dialog has it: the rebased commits are new work. */
export const rebase = (run: Git, onto: string, ignoreDate = true) =>
  run(["rebase", onto, ...ignoreDate ? ["--ignore-date"] : []]);

/** `parent` is 1-based and only for a merge commit: the side it is taken against. */
export const cherryPick = (
  run: Git,
  hash: string,
  parent: number,
  options: { recordOrigin: boolean; noCommit: boolean },
) =>
  run([
    "cherry-pick",
    ...options.noCommit ? ["--no-commit"] : [],
    ...options.recordOrigin ? ["-x"] : [],
    ...parent > 0 ? ["-m", String(parent)] : [],
    hash,
  ]);

export const revert = (run: Git, hash: string, parent: number) =>
  run(["revert", "--no-edit", ...parent > 0 ? ["-m", String(parent)] : [], hash]);

/** Replays everything after `hash` onto its parent, leaving it out. */
export const drop = (run: Git, hash: string) => run(["rebase", "--onto", `${hash}^`, hash]);

export const reset = (run: Git, to: string, mode: ResetMode) => run(["reset", `--${mode}`, to]);

/** Annotated when it has a message, lightweight when it has none. */
export const addTag = (run: Git, name: string, at: string, message: string | undefined) =>
  run(message === undefined ? ["tag", name, at] : ["tag", "-a", name, "-m", message, at]);

/** On the remote first: if that fails, the local tag is still there to try again with. */
export async function deleteTag(run: Git, name: string, remote?: string): Promise<void> {
  if (remote) {
    await run(["push", remote, "--delete", name]);
  }
  await run(["tag", "-d", name]);
}

export const pushTag = (run: Git, remote: string, name: string) => run(["push", remote, name]);

export const pushBranch = (
  run: Git,
  remote: string,
  branch: string,
  options: { setUpstream: boolean; force: ForceMode },
) =>
  run([
    "push",
    remote,
    branch,
    ...options.setUpstream ? ["--set-upstream"] : [],
    ...options.force ? [`--${options.force}`] : [],
  ]);

/** One remote, or all of them. */
export const fetch = (run: Git, remote: string | undefined, options: { prune: boolean; pruneTags: boolean }) =>
  run([
    "fetch",
    remote ?? "--all",
    ...options.prune ? ["--prune"] : [],
    ...options.pruneTags ? ["--prune-tags"] : [],
  ]);

export const archive = (run: Git, ref: string, file: string, format: "zip" | "tar") =>
  run(["archive", `--format=${format}`, "-o", file, ref]);

export const applyStash = (run: Git, selector: string, reinstateIndex: boolean) =>
  run(["stash", "apply", ...reinstateIndex ? ["--index"] : [], selector]);

export const popStash = (run: Git, selector: string, reinstateIndex: boolean) =>
  run(["stash", "pop", ...reinstateIndex ? ["--index"] : [], selector]);

export const dropStash = (run: Git, selector: string) => run(["stash", "drop", selector]);

export const branchFromStash = (run: Git, selector: string, name: string) => run(["stash", "branch", name, selector]);

export const pushStash = (run: Git, message: string, includeUntracked: boolean) =>
  run([
    "stash",
    "push",
    ...includeUntracked ? ["--include-untracked"] : [],
    ...message ? ["--message", message] : [],
  ]);

export const cleanUntracked = (run: Git, directories: boolean) => run(["clean", directories ? "-fd" : "-f"]);

export async function addRemote(run: Git, name: string, url: string, pushUrl: string | undefined): Promise<void> {
  await run(["remote", "add", name, url]);
  if (pushUrl) {
    await run(["remote", "set-url", name, "--push", pushUrl]);
  }
}

export async function editRemote(run: Git, before: Remote, after: Remote): Promise<void> {
  if (after.name !== before.name) {
    await run(["remote", "rename", before.name, after.name]);
  }
  if (after.url !== before.url) {
    await run(["remote", "set-url", after.name, after.url, before.url]);
  }
  if (after.pushUrl !== before.pushUrl) {
    await run(
      !before.pushUrl
        ? ["remote", "set-url", "--push", after.name, "--add", after.pushUrl!]
        : !after.pushUrl
        ? ["remote", "set-url", "--push", after.name, "--delete", before.pushUrl]
        : ["remote", "set-url", "--push", after.name, after.pushUrl, before.pushUrl],
    );
  }
}

export const deleteRemote = (run: Git, name: string) => run(["remote", "remove", name]);

export const pruneRemote = (run: Git, name: string) => run(["remote", "prune", name]);

/** Why `name` cannot name a branch or tag, after git-check-ref-format(1); undefined when it can. */
export function refNameProblem(name: string): string | undefined {
  if (name.trim() === "") return "Enter a name";
  if (
    name === "@"
    // Control characters are among what git refuses in a name.
    // poly: ignore deno_lint/no-control-regex
    || /[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^[-/.]|\/\.|[/.]$|\.lock$|\.lock\//.test(name)
  ) {
    return `"${name}" is not a valid reference name`;
  }
  return undefined;
}

/**
 * The page where a host opens a pull request from `branch`, for the three
 * hosts Git Graph knows without being configured; undefined for any other.
 */
export function pullRequestUrl(remote: Remote, branch: string): string | undefined {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)(github\.com|gitlab\.com|bitbucket\.org)[:/](.+?)(?:\.git)?\/?$/
      .exec(remote.url);
  if (!match) return undefined;
  const [, host, project] = match;
  const source = encodeURIComponent(branch);
  return host === "github.com"
    ? `https://github.com/${project}/compare/${source}?expand=1`
    : host === "gitlab.com"
    ? `https://gitlab.com/${project}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${source}`
    : `https://bitbucket.org/${project}/pull-requests/new?source=${source}`;
}

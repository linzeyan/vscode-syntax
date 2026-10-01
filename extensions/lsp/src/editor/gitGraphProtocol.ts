/**
 * What the Git Graph host and its page say to each other. Types only, so the
 * page's bundle can import it without pulling in anything from node.
 */

/** The row for uncommitted changes uses this in place of a hash, as mhutchie.git-graph does. */
export const UNCOMMITTED = "*";

export interface GraphCommit {
  hash: string;
  /** Only the base for a stash: its index and untracked commits are not history. */
  parents: string[];
  author: string;
  email: string;
  /** Seconds since the epoch: the author date. */
  date: number;
  subject: string;
  heads: string[];
  tags: { name: string; annotated: boolean }[];
  remotes: { name: string; remote: string }[];
  stash?: { selector: string; base: string; untracked?: string };
}

export interface Graph {
  commits: GraphCommit[];
  /** The checked-out commit; absent in a repository with no commits yet. */
  head?: string;
  /** The checked-out branch; absent when HEAD is detached. */
  headBranch?: string;
  /** Local branches, then `remotes/<remote>/<branch>`, newest first as `git branch -a` would sort them. */
  branches: string[];
  remotes: string[];
  /** Whether a longer list would have had more. */
  more: boolean;
}

export type ChangeType = "A" | "M" | "D" | "R" | "U";

export interface FileChange {
  oldPath: string;
  newPath: string;
  type: ChangeType;
  /** Null for a binary file, and for an untracked one among uncommitted changes. */
  additions: number | null;
  deletions: number | null;
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: number;
  committer: string;
  committerEmail: string;
  committerDate: number;
  body: string;
  files: FileChange[];
}

export interface TagDetails {
  hash: string;
  tagger: string;
  email: string;
  date: number;
  message: string;
}

export interface Remote {
  name: string;
  url: string;
  pushUrl?: string;
}

/** The view options the toolbar changes, kept per repository. */
export interface ViewOptions {
  /** Branch names to show, or empty for all. */
  branches: string[];
  showRemoteBranches: boolean;
  showTags: boolean;
  showStashes: boolean;
  showUncommitted: boolean;
  firstParent: boolean;
  order: "date" | "author-date" | "topo";
}

export const DEFAULT_VIEW: ViewOptions = {
  branches: [],
  showRemoteBranches: true,
  showTags: true,
  showStashes: true,
  showUncommitted: true,
  firstParent: false,
  order: "date",
};

#!/usr/bin/env bash
# Builds the repositories the Git Graph comparison runs against, under $1.
#
# Each shape is one Git Graph has to draw or report differently from a plain
# line of commits: merges both ways, an octopus, two roots, a commit only a
# tag reaches, both kinds of tag, stashes on two bases (one with untracked
# files), a remote that is ahead and behind with its HEAD, a rename, a binary
# file, a mode change, and every kind of uncommitted change. Dates are fixed
# and one branch's are out of order, so date order and topological order
# disagree.
set -u
root=${1:?usage: fixture.sh <dir>}
rm -rf "$root"
mkdir -p "$root"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
t=1767225600 # 2026-01-01T00:00:00Z
at() {       # at <offset-minutes> <cmd...>: run with author and committer dates fixed
	local when=$((t + $1 * 60))
	shift
	GIT_AUTHOR_DATE="@$when +0800" GIT_COMMITTER_DATE="@$when +0800" "$@"
}
# maintenance.auto as well as gc.auto: git 2.54's background maintenance
# repacks regardless of gc.auto and can race the next commit, losing objects.
g() { git -c gc.auto=0 -c maintenance.auto=false -c user.name="Ada Lovelace" -c user.email=ada@example.com -c init.defaultBranch=main -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }
commit() { # commit <offset> <file> <message...>
	local off=$1 file=$2
	shift 2
	mkdir -p "$(dirname "$file")"
	echo "$off $*" >>"$file"
	g add -A && at "$off" g commit -q -m "$@"
}

# --- graph: the main fixture -------------------------------------------------
repo=$root/graph
mkdir -p "$repo" && cd "$repo" || exit 1
g init -q
commit 1 README.md "Initial commit"
commit 2 src/app.ts "Add app" -m "Body line one." -m "Body paragraph with **markdown** and :sparkles: and #12."
g checkout -q -b feature/login
commit 3 src/login.ts "Login form"
commit 5 src/login.ts "Login validation"
g checkout -q main
commit 4 src/app.ts "Main moves on"
at 6 g merge -q --no-ff feature/login -m "Merge branch 'feature/login'"
g checkout -q -b hotfix
commit 7 src/app.ts "Hotfix: crash on start"
g checkout -q main
at 8 g merge -q --ff-only hotfix
# Out-of-order dates: this branch's commits claim to be older than their parents.
g checkout -q -b backdated
commit 2 docs/old.md "Backdated one"
commit 1 docs/old.md "Backdated two"
g checkout -q main
# Octopus: three heads merged at once.
for b in oct-a oct-b oct-c; do
	g checkout -q -b "$b" main
	commit 9 "oct/$b.txt" "Octopus part $b"
	g checkout -q main
done
at 10 g merge -q --no-ff oct-a oct-b oct-c -m "Octopus merge"
# Rename, binary, mode change, deletion, unicode.
g mv src/login.ts src/auth.ts && at 11 g commit -q -m "Rename login to auth"
printf '\x00\x01\x02binary' >logo.bin && g add logo.bin && at 12 g commit -q -m "Add binary logo"
chmod +x src/app.ts && g add src/app.ts && at 13 g commit -q -m "Make app executable"
g rm -q oct/oct-a.txt && commit 14 "文件/說明.md" "中文提交：新增說明 ✨"
at 15 g commit -q --allow-empty -m "Empty commit" -m "Nothing changed here."
# A second root.
g checkout -q --orphan gh-pages
g rm -rqf . >/dev/null
commit 16 index.html "Pages root"
g checkout -q main
# Tags: lightweight, annotated, and one on a commit no branch reaches.
g tag v1.0 HEAD~3
at 17 g tag -a v1.1 -m "Release 1.1" -m "Annotated body."
g checkout -q --detach HEAD~1
commit 18 tagged-only.txt "Reached only by a tag"
g tag tag-only
g checkout -q main
# Remote: a bare clone that then moves ahead, and a local branch that moves on.
g clone -q --bare "$repo" "$root/graph-origin.git"
g remote add origin "$root/graph-origin.git"
g fetch -q origin
g branch -q --set-upstream-to=origin/main main
g remote set-head origin main
(
	cd "$root" && g clone -q graph-origin.git graph-other && cd graph-other &&
		echo remote >remote.txt && g add remote.txt && at 19 g commit -q -m "Remote-only commit" &&
		g push -q origin main && g push -q origin main:remote-only
)
g fetch -q origin
commit 20 src/app.ts "Local-only commit"
# Stashes: one plain on an older base, one with untracked files on HEAD.
g checkout -q hotfix
echo "stashed on hotfix" >>src/app.ts
at 21 g stash push -q -m "WIP on hotfix base"
g checkout -q main
echo "stash me" >>README.md
echo "untracked" >untracked-in-stash.txt
at 22 g stash push -q -u -m "WIP with untracked"
# Uncommitted: staged, unstaged, deleted, renamed, untracked.
echo staged >>README.md && g add README.md
echo unstaged >>src/app.ts
g rm -q --cached logo.bin && rm logo.bin
g mv src/auth.ts src/authn.ts
echo new >untracked.txt
mkdir -p newdir && echo nested >newdir/nested.txt

# --- detached: HEAD on a commit only HEAD reaches, clean tree ----------------
repo=$root/detached
mkdir -p "$repo" && cd "$repo" || exit 1
g init -q
commit 1 a.txt "One"
commit 2 a.txt "Two"
commit 3 a.txt "Three"
g checkout -q --detach HEAD~1
commit 4 b.txt "Only HEAD reaches this"

# --- empty: no commits at all -------------------------------------------------
repo=$root/empty
mkdir -p "$repo" && cd "$repo" && g init -q

# --- long: more commits than one page, for loading more ----------------------
repo=$root/long
mkdir -p "$repo" && cd "$repo" || exit 1
g init -q
for i in $(seq 1 450); do
	echo "$i" >n.txt
	g add n.txt && at "$i" g commit -q -m "Commit $i"
	if ((i % 50 == 0)); then
		g checkout -q -b "side-$i" HEAD~5 && commit "$i" "side-$i.txt" "Side $i" && g checkout -q main
		at "$i" g merge -q --no-ff "side-$i" -m "Merge side-$i"
	fi
done
# The checked-out branch is not the newest, so a list sorted by date alone
# would not start with it.
g checkout -q side-100

echo "fixtures in $root"

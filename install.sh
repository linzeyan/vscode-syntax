#!/bin/sh
# Install the poly CLI on macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/linzeyan/vscode-syntax/main/install.sh | sh
#
# Environment:
#   POLY_VERSION      release to install, without the leading v (default: latest)
#   POLY_INSTALL_DIR  where to put the binary (default: ~/.local/bin)
#
# POSIX sh on purpose: this runs before poly exists, on whatever the machine
# came with. The Windows twin is install.ps1.
set -eu

REPO=linzeyan/vscode-syntax
VERSION="${POLY_VERSION:-latest}"
DIR="${POLY_INSTALL_DIR:-$HOME/.local/bin}"

die() {
	echo "install.sh: $*" >&2
	exit 1
}

case "$(uname -s)" in
Darwin) os=darwin ;;
Linux) os=linux ;;
*) die "no poly build for $(uname -s); build from source or use the container image" ;;
esac
case "$(uname -m)" in
arm64 | aarch64) arch=arm64 ;;
x86_64 | amd64) arch=x64 ;;
*) die "no poly build for $(uname -m)" ;;
esac
asset="poly-$os-$arch"

if command -v curl >/dev/null 2>&1; then
	fetch() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
	fetch() { wget -qO- "$1"; }
else
	die "needs curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
	# Read on stdin so the output is the hash and nothing else: coreutils
	# escapes odd characters in a filename and marks the line with a leading
	# backslash, which the comparison below would then never match.
	checksum() { sha256sum | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
	checksum() { shasum -a 256 | cut -d' ' -f1; }
else
	die "needs sha256sum or shasum to verify the download"
fi

# "latest" is the newest release that ships binaries, which is not what
# /releases/latest returns. The v0 tag is the Marketplace listing for the
# action -- a release with no assets -- and GitHub is happy to call that one
# latest. Version-shaped tags (vX.Y.Z) are the ones a build publishes, and the
# same pattern excludes pre-releases, whose tags carry an -rc suffix.
if [ "$VERSION" = latest ]; then
	# Fetched on its own line, not straight into the pipe: the API's anonymous
	# budget is 60 an hour per IP and shared behind NAT, so this call fails for
	# people who have made no requests at all. Inside a pipeline that failure
	# becomes an empty tag, and the message below would blame the release.
	releases=$(fetch "https://api.github.com/repos/$REPO/releases?per_page=30") ||
		die "could not reach the GitHub API (its anonymous limit is 60 requests an hour per IP, shared behind NAT). Retry later, or name a version to skip the lookup: POLY_VERSION=0.4.1"
	tag=$(printf '%s' "$releases" |
		grep -o '"tag_name": *"v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"' |
		head -1 | sed 's/.*"\(v[0-9.]*\)"$/\1/')
	[ -n "$tag" ] || die "no published release ships binaries yet"
else
	tag="v${VERSION#v}"
fi

base="https://github.com/$REPO/releases/download/$tag"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "install.sh: downloading poly $tag ($asset)"
fetch "$base/$asset" >"$tmp/poly" || die "no $asset in release $tag"
fetch "$base/SHA256SUMS" >"$tmp/SHA256SUMS" || die "release $tag has no SHA256SUMS"

want=$(grep "  $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
[ -n "$want" ] || die "$asset is not listed in SHA256SUMS for $tag"
got=$(checksum <"$tmp/poly")
# A truncated download otherwise surfaces much later as "cannot execute
# binary file", which reads like the wrong platform was picked.
[ "$want" = "$got" ] || die "checksum mismatch for $asset (want $want, got $got)"

mkdir -p "$DIR"
chmod 755 "$tmp/poly"
mv "$tmp/poly" "$DIR/poly"
echo "install.sh: installed $("$DIR/poly" --version) to $DIR/poly"

case ":$PATH:" in
*":$DIR:"*) ;;
# Not appended to a shell profile: which file is right depends on the shell
# and on whether this is a login shell, and guessing wrong edits a config
# the user did not ask to have edited.
*) echo "install.sh: $DIR is not on PATH — add: export PATH=\"$DIR:\$PATH\"" ;;
esac

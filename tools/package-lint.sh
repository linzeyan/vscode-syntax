#!/usr/bin/env bash
# Package the poly-lint platform VSIX with the poly binary embedded.
# Usage: tools/package-lint.sh [vsce-target] [poly-binary]
# Defaults: current platform's target, cli/target/release/poly.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/extensions/lint"

case "${1:-}" in
"")
	case "$(uname -sm)" in
	"Darwin arm64") TARGET=darwin-arm64 ;;
	"Darwin x86_64") TARGET=darwin-x64 ;;
	"Linux x86_64") TARGET=linux-x64 ;;
	*)
		echo "unrecognized platform; pass a vsce target explicitly" >&2
		exit 2
		;;
	esac
	;;
*) TARGET="$1" ;;
esac
BIN="${2:-$ROOT/cli/target/release/poly}"

if [ ! -f "$BIN" ]; then
	echo "poly binary not found: $BIN (run cargo build --release first)" >&2
	exit 2
fi

set -x
rm -rf "${EXT:?}/bin" && mkdir -p "$EXT/bin"
case "$TARGET" in
win32-*) cp "$BIN" "$EXT/bin/poly.exe" ;;
*) cp "$BIN" "$EXT/bin/poly" && chmod +x "$EXT/bin/poly" ;;
esac
cd "$EXT" || exit 1
npm run build || exit 1
npx --yes @vscode/vsce package --allow-missing-repository --target "$TARGET" || exit 1
set +x
ls -1 "$EXT"/poly-lint-*.vsix

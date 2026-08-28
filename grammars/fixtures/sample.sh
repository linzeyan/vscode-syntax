#!/usr/bin/env bash
set -uo pipefail

main() {
  local count=0
  for f in "$@"; do
    [[ -f "$f" ]] && count=$((count + 1))
  done
  echo "checked ${count} files"
}

main "$@"

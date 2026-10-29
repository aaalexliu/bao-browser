#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="${BAO_EXTENSION_DIR:-$HOME/.bao-browser/extension}"
SOURCE="${BAO_EXTENSION_SOURCE:-$ROOT/extension/dist}"

if [ -z "${BAO_SKIP_BUILD:-}" ]; then
  ( cd "$ROOT" && npm run --silent build:extension )
fi

FORCE=()
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then FORCE+=(--force); fi
done

node "$ROOT/scripts/stage-unpacked.mjs" sync "$SOURCE" "$STAGE" "${FORCE[@]}"
echo "Unpacked extension → $STAGE"
echo "Extension id jcjcpblcjaakcmbgljdjkfgmmdfdbnfj"
echo "Load that directory at chrome://extensions, then click Reload on the Bao card."

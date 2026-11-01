#!/usr/bin/env bash
# Stage the runtime the packaged server loads. DEST is Contents/Resources.
# npm installs the runtime set so classic-level brings its own native binary.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:?usage: stage-runtime.sh DEST}"
cd "$ROOT"

OUT="$(mktemp -d "${TMPDIR:-/tmp}/bao-tsc.XXXXXX")"
SMOKE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/bao-home.XXXXXX")"
cleanup_out() { rm -rf "$OUT" "$SMOKE_HOME"; }
trap cleanup_out EXIT
"$ROOT/node_modules/.bin/tsc" -p tsconfig.desktop.json --outDir "$OUT"
node extension/build.mjs "$OUT/extension-dist"
echo "STAGED_TSC $OUT"

test -s "$OUT/extension/src/host-grant.js"
test -s "$OUT/extension-dist/manifest.json"
test -d "$OUT/web/src"
test -d "$OUT/src"

rm -rf "$DEST/bao" "$DEST/extension" "$DEST/src" "$DEST/web"
mkdir -p "$DEST/bao" "$DEST/extension/src" "$DEST/src" "$DEST/web"
cp -a "$OUT/desktop/src" "$DEST/bao/src"
# tsc does not copy .cjs. home.js loads library-home.cjs, and the launcher runs print-home.cjs.
cp -a desktop/src/library-home.cjs desktop/src/print-home.cjs "$DEST/bao/src/"
cp -a desktop/src/app/public "$DEST/bao/public"
cp -a "$OUT/extension/src/host-grant.js" "$DEST/extension/src/host-grant.js"
cp -a "$OUT/src/." "$DEST/src/"
cp -a "$OUT/web/src" "$DEST/web/src"
mkdir -p "$DEST/extension/dist"
cp -a "$OUT/extension-dist/." "$DEST/extension/dist/"

"$ROOT/node_modules/.bin/esbuild" desktop/src/app/client.ts \
  --bundle --format=iife --platform=browser --target=es2022 \
  --outfile="$DEST/bao/src/app/app.js"
test -s "$DEST/bao/src/app/app.js"

node "$ROOT/desktop/packaging/stage-agent-browser.mjs" "$DEST/agent-browser"
node "$ROOT/desktop/packaging/stage-deps.mjs" "$DEST/bao"
env -u NODE_PATH -u NODE_OPTIONS HOME="$SMOKE_HOME" node "$ROOT/desktop/packaging/require-staged.js" "$DEST/bao"
# The launcher reads ok and a home from print-home. A cwd with no .bao-mcp keeps the smoke away from the checkout.
PRINTED="$(cd "$SMOKE_HOME" && env -u NODE_PATH -u NODE_OPTIONS -u BAO_HOME HOME="$SMOKE_HOME" node "$DEST/bao/src/print-home.cjs")"
test "$(printf '%s\n' "$PRINTED" | sed -n 1p)" = ok

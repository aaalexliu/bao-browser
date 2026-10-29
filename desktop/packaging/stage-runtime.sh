#!/usr/bin/env bash
# Stage the runtime the packaged server loads. DEST is Contents/Resources.
# npm installs the runtime set so classic-level brings its own native binary.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:?usage: stage-runtime.sh DEST}"
cd "$ROOT"

OUT="$(mktemp -d "${TMPDIR:-/tmp}/bao-tsc.XXXXXX")"
cleanup_out() { rm -rf "$OUT"; }
trap cleanup_out EXIT
"$ROOT/node_modules/.bin/tsc" -p tsconfig.desktop.json --outDir "$OUT"
node extension/build.mjs

test -s "$OUT/extension/src/host-grant.js"
test -s extension/dist/manifest.json
test -d "$OUT/web/src"
test -d "$OUT/src"

rm -rf "$DEST/bao" "$DEST/extension" "$DEST/src" "$DEST/web"
mkdir -p "$DEST/bao" "$DEST/extension/src" "$DEST/src" "$DEST/web"
cp -a "$OUT/desktop/src" "$DEST/bao/src"
cp -a desktop/src/app/public "$DEST/bao/public"
cp -a "$OUT/extension/src/host-grant.js" "$DEST/extension/src/host-grant.js"
cp -a "$OUT/src/." "$DEST/src/"
cp -a "$OUT/web/src" "$DEST/web/src"
mkdir -p "$DEST/extension/dist"
cp -a extension/dist/. "$DEST/extension/dist/"

"$ROOT/node_modules/.bin/esbuild" desktop/src/app/client.ts \
  --bundle --format=iife --platform=browser --target=es2022 \
  --outfile="$DEST/bao/src/app/app.js"
test -s "$DEST/bao/src/app/app.js"

node "$ROOT/desktop/packaging/stage-deps.mjs" "$DEST/bao"
(
  cd "$DEST/bao"
  node -e "require('classic-level')"
)

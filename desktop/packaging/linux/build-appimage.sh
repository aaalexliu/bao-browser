#!/usr/bin/env bash
# Linux AppImage. Uses the system Chrome for the window and for replay.
# Does not bundle Chromium. Run from the repo root.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
npx tsc -p tsconfig.desktop.json
STAGE="$(mktemp -d /tmp/bao-appdir-XXXX)"
APP="$STAGE/Bao.AppDir"
mkdir -p "$APP/usr/bin" "$APP/usr/share/bao/public" "$APP/usr/lib"
cp "$(command -v node)" "$APP/usr/bin/node"
cp -a desktop/dist/desktop/src "$APP/usr/share/bao/src"
# tsc does not copy .cjs. home.js loads library-home.cjs from beside it.
cp -a desktop/src/library-home.cjs desktop/src/print-home.cjs "$APP/usr/share/bao/src/"
mkdir -p "$APP/usr/share/src"
cp -a desktop/dist/src/. "$APP/usr/share/src/"
cp desktop/dist/desktop/src/app/cli.js "$APP/usr/share/bao/cli.js"
# cli.js requires sibling modules by relative path from dist. Keep that tree.
rm -f "$APP/usr/share/bao/cli.js"
cp -a desktop/src/app/public "$APP/usr/share/bao/public"
cp -a node_modules "$APP/usr/lib/node_modules"
# Point node at the bundled modules. The compiled files live under usr/share/bao/src
# and resolve node_modules by walking parents, so place a link at the AppDir root.
ln -s usr/lib/node_modules "$APP/node_modules"
cp desktop/packaging/linux/AppRun "$APP/AppRun"
cp desktop/packaging/linux/bao.desktop "$APP/bao.desktop"
printf 'P1\n1 1\n0\n' > "$APP/bao.xpm"
chmod +x "$APP/AppRun"
# The compiled cli lives at dist/desktop/src/app/cli.js inside the copied src tree.
# AppRun calls usr/share/bao/cli.js. Write a one-line trampoline.
cat > "$APP/usr/share/bao/cli.js" <<'EOF'
require("./src/app/cli.js");
EOF
TOOL="${APPIMAGETOOL:-/tmp/appimagetool}"
if [[ ! -x "$TOOL" ]]; then
  curl -fsSL -o "$TOOL" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x "$TOOL"
fi
OUT="${BAO_APPIMAGE_OUT:-$ROOT/desktop/packaging/linux/Bao-x86_64.AppImage}"
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" "$APP" "$OUT"
echo "WROTE $OUT"

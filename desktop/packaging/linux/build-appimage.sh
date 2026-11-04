#!/usr/bin/env bash
# Linux AppImage. Uses the system Chrome for the window and for replay.
# Does not bundle Chromium. Run from the repo root.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
STAGE="$(mktemp -d /tmp/bao-appdir-XXXX)"
APP="$STAGE/Bao.AppDir"
mkdir -p "$APP/usr/bin" "$APP/usr/share"
cp "$(command -v node)" "$APP/usr/bin/node"
bash "$ROOT/desktop/packaging/stage-runtime.sh" "$APP/usr/share"
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

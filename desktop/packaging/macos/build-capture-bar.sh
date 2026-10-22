#!/usr/bin/env bash
# Floating capture bar. /usr/bin/clang, signed with the bao dev identity.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/desktop/packaging/macos/dist/BaoCaptureBar.app"
IDENTITY="${BAO_SIGN_IDENTITY:-bao dev signing}"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS"
/usr/bin/clang -fobjc-arc -framework AppKit -framework Carbon -O2 \
  -o "$OUT/Contents/MacOS/BaoCaptureBar" \
  "$ROOT/desktop/packaging/macos/capture-bar.m"
cp "$ROOT/desktop/packaging/macos/CaptureBar-Info.plist" "$OUT/Contents/Info.plist"
codesign --force --sign "$IDENTITY" --identifier dev.bao.capturebar "$OUT"
echo "WROTE $OUT"

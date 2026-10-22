#!/usr/bin/env bash
# Replay-window recorder. /usr/bin/clang, signed with the bao dev identity.
# A separate bundle from BaoOSHelper so the helper cdhash stays put.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/desktop/packaging/macos/dist/BaoWindowVideo.app"
IDENTITY="${BAO_SIGN_IDENTITY:-bao dev signing}"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS"
/usr/bin/clang -fobjc-arc -framework AppKit -framework CoreGraphics -framework ScreenCaptureKit -framework ImageIO -framework UniformTypeIdentifiers -O2 \
  -o "$OUT/Contents/MacOS/bao-window-video" \
  "$ROOT/desktop/packaging/macos/window-video.m"
cp "$ROOT/desktop/packaging/macos/WindowVideo-Info.plist" "$OUT/Contents/Info.plist"
# Same bundle id as the helper. Screen Recording on this Mac is granted to
# dev.bao.oshelper. A new bundle id preflights false, and this script does
# not request access. The helper binary itself is not rebuilt.
codesign --force --sign "$IDENTITY" --identifier dev.bao.oshelper "$OUT"
echo "WROTE $OUT"

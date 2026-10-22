#!/usr/bin/env bash
# Build Bao.app and a dmg on a Mac. Signing identity defaults to "bao dev signing".
# No notarization. The OS helper is a separate bundle copied into Resources.
# The product window is Playwright's Chromium copied into the app.
# An installed Chrome is not launched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
IDENTITY="${BAO_SIGN_IDENTITY:-bao dev signing}"
DIST="$ROOT/desktop/packaging/macos/dist"
APP="$DIST/Bao.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bao"
cp desktop/packaging/macos/Info.plist "$APP/Contents/Info.plist"
npx tsc -p tsconfig.desktop.json
cp -a desktop/dist/desktop/src "$APP/Contents/Resources/bao/src"
cp -a desktop/src/app/public "$APP/Contents/Resources/bao/public"
# interpret.js requires ../../../src/mask, which lands at Contents/Resources/src.
mkdir -p "$APP/Contents/Resources/src"
cp -a desktop/dist/src/. "$APP/Contents/Resources/src/"
# The server requires playwright. A copy of the app outside this repo cannot see node_modules.
mkdir -p "$APP/Contents/Resources/bao/node_modules"
cp -a node_modules/playwright node_modules/playwright-core "$APP/Contents/Resources/bao/node_modules/"
if [[ -d desktop/os-helper-macos/BaoOSHelper.app ]]; then
  cp -a desktop/os-helper-macos/BaoOSHelper.app "$APP/Contents/Resources/BaoOSHelper.app"
fi

BROWSER="$(node -e "const {chromium}=require('playwright'); process.stdout.write(chromium.executablePath())")"
if [[ ! -x "$BROWSER" ]]; then
  npx playwright install chromium
  BROWSER="$(node -e "const {chromium}=require('playwright'); process.stdout.write(chromium.executablePath())")"
fi
if [[ "$BROWSER" != *".app/"* ]]; then
  echo "package-app.sh bundles Playwright Chromium.app and must run on macOS (got $BROWSER)" >&2
  exit 1
fi
CHROMIUM_APP="$(cd "$(dirname "$BROWSER")/../.." && pwd)"
cp -a "$CHROMIUM_APP" "$APP/Contents/Resources/Chromium.app"
MACOS_DIR="$APP/Contents/Resources/Chromium.app/Contents/MacOS"
FOUND=""
for name in Chromium "Google Chrome for Testing" chrome; do
  if [[ -x "$MACOS_DIR/$name" ]]; then
    FOUND="$name"
    break
  fi
done
if [[ -z "$FOUND" ]]; then
  echo "package-app.sh copied Playwright's browser but found no executable under Chromium.app" >&2
  exit 1
fi
echo "BUNDLED_BROWSER $FOUND"

clang -O2 -o "$APP/Contents/MacOS/bao" desktop/packaging/macos/bao-main.c
codesign --force --deep --sign "$IDENTITY" --identifier dev.bao.desktop "$APP"
hdiutil create -volname Bao -srcfolder "$APP" -ov -format UDZO "$DIST/Bao.dmg"
echo "WROTE $APP"
echo "WROTE $DIST/Bao.dmg"

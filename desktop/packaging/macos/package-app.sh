#!/usr/bin/env bash
# Build Bao.app and a dmg on a Mac. Signing identity defaults to "bao dev signing".
# No notarization. The OS helper is a separate bundle copied into Resources.
# The product window is Playwright's Chromium copied into the app.
# An installed Chrome is not launched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
IDENTITY="${BAO_SIGN_IDENTITY:-bao dev signing}"
DIST="${BAO_DIST:-$ROOT/desktop/packaging/macos/dist}"
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
# sync.js and catalog.js require ../../../web/src/lib, which lands at Contents/Resources/web.
mkdir -p "$APP/Contents/Resources/web"
cp -a desktop/dist/web/src "$APP/Contents/Resources/web/src"
# The window script is bundled from the TypeScript client. cwd is Resources/bao.
# desktop/src/v1/time.ts imports ../../../web, which is Resources/bao/web from that cwd.
mkdir -p "$APP/Contents/Resources/bao/desktop"
cp -a desktop/src "$APP/Contents/Resources/bao/desktop/src"
mkdir -p "$APP/Contents/Resources/bao/web"
cp -a web/src "$APP/Contents/Resources/bao/web/src"
# schema.ts imports ../../../src/mask. From this cwd that file is Resources/bao/src/mask.ts.
# Without it the window's /app.js bundle fails and the sidebar never renders.
mkdir -p "$APP/Contents/Resources/bao/src"
cp -a src/mask.ts "$APP/Contents/Resources/bao/src/mask.ts"
# server.js requires ../../../extension/src/host-grant, which lands at Contents/Resources/extension.
# views.ts, bundled from bao/desktop, resolves the same module under bao/extension.
mkdir -p "$APP/Contents/Resources/extension/src" "$APP/Contents/Resources/bao/extension/src"
cp desktop/dist/extension/src/host-grant.js "$APP/Contents/Resources/extension/src/host-grant.js"
cp extension/src/host-grant.ts "$APP/Contents/Resources/bao/extension/src/host-grant.ts"
# The server requires playwright and esbuild. A copy of the app outside this repo cannot see node_modules.
mkdir -p "$APP/Contents/Resources/bao/node_modules"
cp -a node_modules/playwright node_modules/playwright-core node_modules/esbuild "$APP/Contents/Resources/bao/node_modules/"
if [[ -d node_modules/@esbuild ]]; then
  mkdir -p "$APP/Contents/Resources/bao/node_modules/@esbuild"
  cp -a node_modules/@esbuild/. "$APP/Contents/Resources/bao/node_modules/@esbuild/"
fi
if [[ -d desktop/os-helper-macos/BaoOSHelper.app ]]; then
  cp -a desktop/os-helper-macos/BaoOSHelper.app "$APP/Contents/Resources/BaoOSHelper.app"
fi
bash desktop/packaging/macos/build-capture-bar.sh
cp -a "$ROOT/desktop/packaging/macos/dist/BaoCaptureBar.app" "$APP/Contents/Resources/BaoCaptureBar.app"
bash desktop/packaging/macos/build-window-video.sh
cp -a "$ROOT/desktop/packaging/macos/dist/BaoWindowVideo.app" "$APP/Contents/Resources/BaoWindowVideo.app"

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

# Chromium promotes itself to a foreground app, so this Dock icon stays.
# Name it Bao. Sign only this bundle. --deep on Bao.app would re-sign
# BaoOSHelper.app and change its cdhash.
CHROME="$APP/Contents/Resources/Chromium.app"
PLIST="$CHROME/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Bao" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Bao" "$PLIST"
while IFS= read -r -d '' strings; do
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Bao" "$strings" || true
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Bao" "$strings" || true
done < <(find "$CHROME" -name InfoPlist.strings -print0)
codesign --force --sign "$IDENTITY" "$CHROME"

/usr/bin/clang -fobjc-arc -O2 \
  -framework Foundation -framework AppKit -framework UserNotifications \
  -o "$APP/Contents/MacOS/bao" \
  desktop/packaging/macos/bao-main.c desktop/packaging/macos/bao-launch.c desktop/packaging/macos/bao-notify.m
# Nested BaoOSHelper.app is already signed. --deep would change its cdhash.
codesign --force --sign "$IDENTITY" --identifier dev.bao.desktop "$APP"
hdiutil create -volname Bao -srcfolder "$APP" -ov -format UDZO "$DIST/Bao.dmg"
echo "WROTE $APP"
echo "WROTE $DIST/Bao.dmg"

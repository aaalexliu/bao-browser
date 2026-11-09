#!/usr/bin/env bash
# Build Bao.app and a dmg on a Mac. Signing identity defaults to "bao dev signing".
# BAO_SIGN_IDENTITY=- signs everything ad-hoc, as a release without a signing secret does.
# BAO_VERSION sets the app version. No notarization. The OS helper is a separate bundle copied into Resources.
# The product window is native WebKit. Bundled Chromium stays available for tasks.
# Opening Bao does not launch a browser.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
IDENTITY="${BAO_SIGN_IDENTITY:-bao dev signing}"
export BAO_SIGN_IDENTITY="$IDENTITY"
DIST="${BAO_DIST:-$ROOT/desktop/packaging/macos/dist}"
APP="$DIST/Bao.app"

HELPER="${BAO_HELPER_APP:-$ROOT/desktop/os-helper-macos/BaoOSHelper.app}"
node "$ROOT/desktop/packaging/helper-identity.js" "$HELPER"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp desktop/packaging/macos/Info.plist "$APP/Contents/Info.plist"
if [[ -n "${BAO_VERSION:-}" ]]; then
  if [[ ! "$BAO_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "package-app.sh: BAO_VERSION must look like 1.2.3 (got $BAO_VERSION)" >&2
    exit 1
  fi
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $BAO_VERSION" -c "Set :CFBundleVersion $BAO_VERSION" "$APP/Contents/Info.plist"
fi
bash "$ROOT/desktop/packaging/stage-runtime.sh" "$APP/Contents/Resources"
cp -a "$HELPER" "$APP/Contents/Resources/BaoOSHelper.app"
# BAO_BUNDLE_NODE names a nodejs.org node binary (24 or newer). It keeps its own
# Developer ID signature, so the app no longer needs Node on the Mac.
if [[ -n "${BAO_BUNDLE_NODE:-}" ]]; then
  BUNDLED_MAJOR="$("$BAO_BUNDLE_NODE" -p 'process.versions.node.split(".")[0]')"
  if (( BUNDLED_MAJOR < 24 )); then
    echo "package-app.sh: BAO_BUNDLE_NODE is Node $BUNDLED_MAJOR; Bao needs 24 or newer" >&2
    exit 1
  fi
  codesign --verify --strict "$BAO_BUNDLE_NODE"
  mkdir -p "$APP/Contents/Resources/node/bin"
  cp -p "$BAO_BUNDLE_NODE" "$APP/Contents/Resources/node/bin/node"
  echo "BUNDLED_NODE $("$APP/Contents/Resources/node/bin/node" --version)"
fi
codesign --force --sign "$IDENTITY" --identifier dev.bao.agent-browser "$APP/Contents/Resources/agent-browser/agent-browser"
codesign --verify --strict "$APP/Contents/Resources/agent-browser/agent-browser"

SMOKE="$(mktemp -d "${TMPDIR:-/tmp}/bao-require.XXXXXX")"
SMOKE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/bao-home.XXXXXX")"
cleanup_smoke() { rm -rf "$SMOKE" "$SMOKE_HOME"; }
trap cleanup_smoke EXIT
case "$SMOKE" in
  "$ROOT"|"$ROOT"/*)
    echo "package-app.sh: smoke directory is inside the checkout" >&2
    exit 1
    ;;
esac
mkdir -p "$SMOKE"
cp -a "$APP/Contents/Resources/bao" "$SMOKE/bao"
cp -a "$APP/Contents/Resources/extension" "$SMOKE/extension"
cp -a "$APP/Contents/Resources/web" "$SMOKE/web"
cp -a "$APP/Contents/Resources/shared" "$SMOKE/shared"
env -u NODE_PATH -u NODE_OPTIONS HOME="$SMOKE_HOME" node "$ROOT/desktop/packaging/require-staged.js" "$SMOKE/bao"
rm -rf "$SMOKE"

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

# Re-sign the renamed task browser without touching BaoOSHelper.app.
# --deep on Bao.app would re-sign BaoOSHelper.app and change its cdhash.
CHROME="$APP/Contents/Resources/Chromium.app"
PLIST="$CHROME/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Bao" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Bao" "$PLIST"
while IFS= read -r -d '' strings; do
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Bao" "$strings" || true
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Bao" "$strings" || true
done < <(find "$CHROME" -name InfoPlist.strings -print0)
codesign --force --sign "$IDENTITY" "$CHROME"

# A certificate keeps a Files & Folders grant across updates, so agents answer to macOS as Bao.
# An ad-hoc grant lasts one build, so an ad-hoc build leaves agents with their own app. See bao-run-node.h.
CERT_FLAG=""
[[ "$IDENTITY" == "-" ]] || CERT_FLAG="-DBAO_CERT_SIGNED"
/usr/bin/clang -fobjc-arc -O2 $CERT_FLAG \
  -framework Foundation -framework AppKit -framework WebKit -framework UserNotifications \
  -o "$APP/Contents/MacOS/bao" \
  desktop/packaging/macos/bao-main.c desktop/packaging/macos/bao-launch.c desktop/packaging/macos/bao-run-node.c \
  desktop/packaging/macos/bao-window.m desktop/packaging/macos/bao-notify.m
# The agents' MCP entry. Built and run once, with a temp HOME that holds only a test
# library, before it and Bao.app are signed.
bash desktop/packaging/macos/build-mcp-launcher.sh "$APP"
node "$ROOT/desktop/packaging/build-mcpb.mjs" "$DIST/bao.mcpb"
# codesign on Bao.app signs only the main executable, so the launcher is signed on its own.
codesign --force --sign "$IDENTITY" --identifier dev.bao.mcp "$APP/Contents/MacOS/bao-mcp"
codesign --force --sign "$IDENTITY" --identifier dev.bao.cli "$APP/Contents/MacOS/bao-cli"
# Nested BaoOSHelper.app is already signed. --deep would change its cdhash.
codesign --force --sign "$IDENTITY" --identifier dev.bao.desktop "$APP"
node "$ROOT/desktop/packaging/macos/prove-apple-events.mjs" "$APP"
# The release workflow ships a zip, not the dmg, so it sets BAO_SKIP_DMG=1.
if [[ "${BAO_SKIP_DMG:-}" != 1 ]]; then
  hdiutil create -volname Bao -srcfolder "$APP" -ov -format UDZO "$DIST/Bao.dmg"
fi
echo "WROTE $APP"
[[ "${BAO_SKIP_DMG:-}" == 1 ]] || echo "WROTE $DIST/Bao.dmg"
echo "WROTE $DIST/bao.mcpb"

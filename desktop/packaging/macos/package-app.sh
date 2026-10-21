#!/usr/bin/env bash
# Build Bao.app and a dmg on a Mac. Signing identity defaults to "bao dev signing".
# No notarization. The OS helper is a separate bundle copied into Resources.
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
if [[ -d desktop/os-helper-macos/BaoOSHelper.app ]]; then
  cp -a desktop/os-helper-macos/BaoOSHelper.app "$APP/Contents/Resources/BaoOSHelper.app"
fi
cat > "$APP/Contents/MacOS/bao" <<'EOF'
#!/bin/bash
ROOT="$(cd "$(dirname "$0")/../Resources/bao" && pwd)"
export BAO_PUBLIC="$ROOT/public"
export BAO_HOME="${BAO_HOME:-$HOME/Library/Application Support/bao}"
PORT="${BAO_PORT:-4787}"
cd "$ROOT"
node src/app/cli.js serve --home "$BAO_HOME" --port "$PORT" &
sleep 0.5
open -na "Google Chrome" --args --app="http://127.0.0.1:${PORT}" --user-data-dir="$BAO_HOME/ui-profile" --no-first-run
wait
EOF
chmod +x "$APP/Contents/MacOS/bao"
codesign --force --sign "$IDENTITY" --identifier dev.bao.desktop "$APP"
hdiutil create -volname Bao -srcfolder "$APP" -ov -format UDZO "$DIST/Bao.dmg"
echo "WROTE $APP"
echo "WROTE $DIST/Bao.dmg"

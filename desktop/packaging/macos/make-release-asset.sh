#!/usr/bin/env bash
# Turn a built Bao.app into the release asset the bao-browser installer downloads:
# Bao-<version>-darwin-arm64.zip, and release.json with its URL, size and SHA-256.
# .github/workflows/mac-release.yml runs this after package-app.sh.
# usage: make-release-asset.sh path/to/Bao.app OUT_DIR [BASE_URL]
# BASE_URL is where the zip will live, such as
#   https://github.com/aaalexliu/bao-browser/releases/download/v0.2.0
# Without it, release.json names the zip by file name, and the installer looks for
# it beside release.json:
#   npx https://github.com/aaalexliu/bao-browser/releases/latest/download/bao-browser.tgz --release path/to/release.json
set -euo pipefail
APP="${1:?usage: make-release-asset.sh path/to/Bao.app OUT_DIR [BASE_URL]}"
OUT="${2:?usage: make-release-asset.sh path/to/Bao.app OUT_DIR [BASE_URL]}"
BASE="${3:-}"
test -x "$APP/Contents/MacOS/bao-mcp"
test -x "$APP/Contents/MacOS/bao-cli"
test -x "$APP/Contents/MacOS/bao-spawn"
test -x "$APP/Contents/Resources/node/bin/node"
codesign --verify --strict "$APP"
VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist")"
if [[ "$(lipo -archs "$APP/Contents/MacOS/bao")" != "arm64" ]]; then
  echo "make-release-asset.sh: Bao releases are Apple silicon (arm64) only" >&2
  exit 1
fi
mkdir -p "$OUT"
NAME="Bao-$VERSION-darwin-arm64.zip"
ZIP="$OUT/$NAME"
rm -f "$ZIP"
# ditto keeps the code signatures, symlinks and modes that a plain zip can break.
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
SHA="$(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
SIZE="$(stat -f %z "$ZIP")"
URL="$NAME"
[[ -n "$BASE" ]] && URL="${BASE%/}/$NAME"
cat > "$OUT/release.json" <<JSON
{
  "version": "$VERSION",
  "platforms": {
    "darwin-arm64": {
      "url": "$URL",
      "size": $SIZE,
      "sha256": "$SHA"
    }
  }
}
JSON
echo "WROTE $ZIP ($SIZE bytes, sha256 $SHA)"
echo "WROTE $OUT/release.json"

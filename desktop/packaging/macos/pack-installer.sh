#!/usr/bin/env bash
# Pack the bao-browser installer with the release.json it pins. Publishing it is
# `npm publish` on the same staged directory; the owner decides when that starts.
# usage: pack-installer.sh path/to/release.json OUT_DIR
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RELEASE="${1:?usage: pack-installer.sh release.json OUT_DIR}"
OUT="${2:?usage: pack-installer.sh release.json OUT_DIR}"
# Inside the package a bare file name would point into the package, so the zip needs a full URL.
# shellcheck disable=SC2016
node -e '
const release = require(require("node:path").resolve(process.argv[1]));
for (const [key, asset] of Object.entries(release.platforms || {})) {
  if (!/^(https?|file):\/\//.test(asset.url)) {
    console.error(`pack-installer.sh: ${key} url must be an https:// or file:// URL, not ${asset.url}. Run make-release-asset.sh with BASE_URL.`);
    process.exit(1);
  }
}' "$RELEASE"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/bao-installer.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp -a "$ROOT/installer/." "$STAGE/"
cp "$RELEASE" "$STAGE/release.json"
VERSION="$(node -p 'require(process.argv[1]).version' "$STAGE/release.json")"
(cd "$STAGE" && npm pkg set version="$VERSION" >/dev/null)
mkdir -p "$OUT"
TGZ="$(cd "$STAGE" && npm pack --silent --pack-destination "$OUT")"
echo "WROTE $OUT/$TGZ"

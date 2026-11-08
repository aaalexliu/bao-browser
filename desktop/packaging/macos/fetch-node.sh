#!/usr/bin/env bash
# Download the Node that a release bundles into Bao.app, check it against node-pin.json,
# and print the path of its node binary. The binary keeps the Node.js Foundation's
# Developer ID signature; package-app.sh copies it with BAO_BUNDLE_NODE.
# usage: fetch-node.sh OUT_DIR
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: fetch-node.sh OUT_DIR}"
PIN="$HERE/node-pin.json"
VERSION="$(node -p 'require(process.argv[1]).version' "$PIN")"
FILE="$(node -p 'require(process.argv[1])["darwin-arm64"].file' "$PIN")"
SHA="$(node -p 'require(process.argv[1])["darwin-arm64"].sha256' "$PIN")"
mkdir -p "$OUT"
ARCHIVE="$OUT/$FILE"
if [[ ! -f "$ARCHIVE" ]] || ! echo "$SHA  $ARCHIVE" | shasum -a 256 -c - >/dev/null 2>&1; then
  curl -fsSL "https://nodejs.org/dist/v$VERSION/$FILE" -o "$ARCHIVE.part"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
if ! echo "$SHA  $ARCHIVE" | shasum -a 256 -c - >/dev/null 2>&1; then
  echo "fetch-node.sh: $FILE does not match node-pin.json" >&2
  rm -f "$ARCHIVE"
  exit 1
fi
tar -xJf "$ARCHIVE" -C "$OUT"
NODE="$OUT/${FILE%.tar.xz}/bin/node"
codesign --verify --strict "$NODE"
echo "$NODE"

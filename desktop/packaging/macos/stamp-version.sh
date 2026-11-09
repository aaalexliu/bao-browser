#!/usr/bin/env bash
# Write the root package.json version into an app's Info.plist as CFBundleShortVersionString and CFBundleVersion.
# package.json is Bao's only version source; mac-release.yml sets it to the release tag's version when they differ.
set -euo pipefail
PLIST="${1:?usage: stamp-version.sh Info.plist}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "stamp-version.sh: package.json version must look like 1.2.3 (got $VERSION)" >&2
  exit 1
fi
/usr/bin/plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
/usr/bin/plutil -replace CFBundleVersion -string "$VERSION" "$PLIST"
echo "$VERSION"

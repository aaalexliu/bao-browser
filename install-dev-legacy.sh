#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="${BAO_EXT_DIR:-$HOME/.bao-browser/ext}"
SOURCE="${BAO_LEGACY_SOURCE:-$ROOT}"
PROFILE_NAME="${BAO_CHROME_PROFILE:-dev}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ -z "${BAO_SKIP_BUILD:-}" ]; then
  echo "Building…"
  ( cd "$ROOT" && npm run --silent build )
fi

node "$ROOT/scripts/stage-unpacked.mjs" copy "$SOURCE" "$STAGE"
echo "Synced legacy extension → $STAGE"

PROFILE_DIR="$(
  python3 - "$PROFILE_NAME" <<'PY' 2>/dev/null || true
import json, os, sys
name = sys.argv[1].lower()
ls = os.path.expanduser("~/Library/Application Support/Google/Chrome/Local State")
cache = json.load(open(ls)).get("profile", {}).get("info_cache", {})
for d, info in cache.items():
    if info.get("name", "").lower() == name:
        print(d); break
PY
)"

if [ -z "$PROFILE_DIR" ]; then
  echo "Could not find a Chrome profile named \"$PROFILE_NAME\"." >&2
  echo "Load unpacked manually from: $STAGE" >&2
  exit 0
fi
echo "Dev profile: \"$PROFILE_NAME\" → $PROFILE_DIR"

if [ "${1:-}" = "--launch" ]; then
  echo "Opening chrome://extensions in the \"$PROFILE_NAME\" profile…"
  "$CHROME" --profile-directory="$PROFILE_DIR" "chrome://extensions" >/dev/null 2>&1 &
else
  echo "Reload it at chrome://extensions, or rerun with --launch to open that page."
fi

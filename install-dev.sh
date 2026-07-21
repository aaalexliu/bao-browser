#!/usr/bin/env bash
# Build the extension and sync the latest dist into a stable, clean directory
# that Chrome loads as an unpacked extension in the "dev" profile.
#
# Why a staging dir instead of loading the repo root directly? The loadable
# extension is only manifest.json + sidepanel.html + dist/*.js. Pointing Chrome at
# the repo root drags in node_modules/, tests/, and docs. Staging keeps the
# unpacked extension small and its path stable regardless of where the repo lives.
#
# Usage:
#   ./install-dev.sh            # build + sync to the staging dir
#   ./install-dev.sh --launch   # also open the dev profile's chrome://extensions
#
# First time only: open chrome://extensions in the dev profile, enable
# "Developer mode", click "Load unpacked", and pick the staging dir printed
# below. After that, rerun this script to push new builds; click the extension's
# reload icon (⟳) to pick up manifest/background changes — content-script changes
# just need a page reload.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="${BAO_EXT_DIR:-$HOME/.bao-browser/ext}"
PROFILE_NAME="${BAO_CHROME_PROFILE:-dev}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# 1. Build the bundles into dist/.
echo "Building…"
( cd "$ROOT" && npm run --silent build )

# 2. Sync just the loadable extension into the staging dir.
#    --delete on dist/ so removed bundles don't linger in the installed copy.
mkdir -p "$STAGE/dist"
rsync -a --delete "$ROOT/dist/" "$STAGE/dist/"
rsync -a "$ROOT/manifest.json" "$ROOT/sidepanel.html" "$STAGE/"
echo "Synced extension → $STAGE"

# 3. Resolve the Chrome profile directory whose display name is "$PROFILE_NAME".
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
  echo "⚠️  Could not find a Chrome profile named \"$PROFILE_NAME\"." >&2
  echo "    Load unpacked manually from: $STAGE" >&2
  exit 0
fi
echo "Dev profile: \"$PROFILE_NAME\" → $PROFILE_DIR"

# 4. Optionally open that profile's extensions page so you can load/reload.
if [ "${1:-}" = "--launch" ]; then
  echo "Opening chrome://extensions in the \"$PROFILE_NAME\" profile…"
  "$CHROME" --profile-directory="$PROFILE_DIR" "chrome://extensions" >/dev/null 2>&1 &
else
  echo "Reload it at chrome://extensions, or rerun with --launch to open that page."
fi

#!/usr/bin/env bash
# Build Contents/MacOS/bao-mcp in a staged Bao.app and run it once from there.
# APP must already hold the staged server (stage-runtime.sh). This script does
# not sign. package-app.sh signs the launcher before it signs the app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="${1:?usage: build-mcp-launcher.sh path/to/Bao.app}"
mkdir -p "$APP/Contents/MacOS"
/usr/bin/clang -Wall -Wextra -Werror -O2 \
  -o "$APP/Contents/MacOS/bao-mcp" \
  "$ROOT/desktop/packaging/macos/bao-mcp.c" "$ROOT/desktop/packaging/macos/bao-launch.c"
node "$ROOT/desktop/packaging/macos/prove-mcp-launcher.mjs" "$APP"

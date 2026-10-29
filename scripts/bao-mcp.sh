#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CLI="$ROOT/desktop/dist/desktop/src/app/cli.js"
if [ ! -f "$CLI" ]; then
  echo "desktop/dist is missing. Run npm run build:desktop." >&2
  exit 1
fi
exec node "$CLI" mcp

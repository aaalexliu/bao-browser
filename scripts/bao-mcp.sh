#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CLI="$ROOT/desktop/dist/desktop/src/app/cli.js"
if [ ! -f "$CLI" ]; then
  echo "desktop/dist is missing. Run npm run build:desktop." >&2
  exit 1
fi
if [ -z "${BAO_HOME:-}" ]; then
  echo "BAO_HOME is unset. Set it to the home bao serve printed. Without it, bao mcp picks a library from HOME and this working directory, and a .bao-mcp library here can win over the serve home." >&2
  exit 1
fi
exec node "$CLI" mcp

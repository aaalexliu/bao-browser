#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CLI="$ROOT/desktop/dist/desktop/src/app/cli.js"
if [ ! -f "$CLI" ]; then
  echo "desktop/dist is missing. Run npm run build:desktop." >&2
  exit 1
fi
if [ -z "${BAO_HOME:-}" ]; then
  echo "BAO_HOME is unset. bao mcp would create .bao-mcp in the current directory. That path is /.bao-mcp when the working directory is /. Set BAO_HOME to the home bao serve printed." >&2
  exit 1
fi
exec node "$CLI" mcp

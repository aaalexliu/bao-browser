#!/usr/bin/env bash
# Dump the GTK3 calculator tree into fixtures/atspi/baocalc.json.
# Throwaway Xvfb, dbus, and HOME. Does not touch the daily session.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKDIR="$(mktemp -d /tmp/bao-atspi-cap-XXXX)"
export HOME="$WORKDIR/home"
export XDG_RUNTIME_DIR="$WORKDIR/runtime"
export XDG_CACHE_HOME="$WORKDIR/cache"
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  pkill -f baocalc.py >/dev/null 2>&1 || true
}
trap cleanup EXIT
Xvfb :121 -screen 0 1400x900x24 -ac >"$WORKDIR/xvfb.log" 2>&1 &
PIDS+=($!)
sleep 0.4
export DISPLAY=:121
eval "$(dbus-launch --sh-syntax)"
PIDS+=("${DBUS_SESSION_BUS_PID}")
/usr/libexec/at-spi-bus-launcher >"$WORKDIR/atspi.log" 2>&1 &
PIDS+=($!)
sleep 0.5
export GTK_A11Y=atspi GTK_MODULES=gail:atk-bridge
python3 "$ROOT/desktop/os-helper/baocalc.py" --x 40 --y 40 --w 320 --h 220 >"$WORKDIR/calc.log" 2>&1 &
PIDS+=($!)
sleep 1
BIN="$ROOT/desktop/os-helper/target/release/bao-os-helper"
"$BIN" nodes --screen 1400x900 >"$WORKDIR/nodes.json"
python3 - "$WORKDIR/nodes.json" "$ROOT/fixtures/atspi/baocalc.json" <<'PY'
import json, sys
raw = json.load(open(sys.argv[1]))
doc = {
  "source": "bao-os-helper nodes",
  "surface": "atspi",
  "app": "baocalc.py",
  "screen": "1400x900",
  "nodes": raw,
}
json.dump(doc, open(sys.argv[2], "w"), indent=2)
print("nodes", len(raw))
PY
cd "$ROOT"
export BAO_CALC=1 BAO_OS_HELPER="$BIN" BAO_SCREEN=1400x900 BAO_WRITE_EXAMPLES=1
node --test desktop/dist/desktop/test/live/calc.test.js

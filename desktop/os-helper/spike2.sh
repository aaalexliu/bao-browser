#!/usr/bin/env bash
# Throwaway Xvfb + dbus + AT-SPI session. Records one GTK save dialog into a
# version-2 workflow and replays it in a second helper process.
# Never touches a real home directory or the caller's DISPLAY.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VALUE="bao-spike2-note.txt"
DISPLAY_NUM=98
ARTIFACTS="${BAO_SPIKE_ARTIFACTS:-/opt/cursor/artifacts}"

WORKDIR="$(mktemp -d /tmp/bao-spike2-XXXX)"
export HOME="$WORKDIR/home"
export XDG_RUNTIME_DIR="$WORKDIR/runtime"
export XDG_CACHE_HOME="$WORKDIR/cache"
export XDG_CONFIG_HOME="$WORKDIR/config"
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"
chmod 700 "$XDG_RUNTIME_DIR"

PIDS=()
cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT

Xvfb ":$DISPLAY_NUM" -screen 0 1280x800x24 -ac >"$WORKDIR/xvfb.log" 2>&1 &
PIDS+=($!)
sleep 0.4
export DISPLAY=":$DISPLAY_NUM"

eval "$(dbus-launch --sh-syntax)"
PIDS+=("${DBUS_SESSION_BUS_PID}")

/usr/libexec/at-spi-bus-launcher >"$WORKDIR/atspi.log" 2>&1 &
PIDS+=($!)
sleep 0.4

export GTK_A11Y=atspi

if command -v rustup >/dev/null 2>&1; then
  CARGO=(rustup run stable cargo)
else
  CARGO=(cargo)
fi
if ! "${CARGO[@]}" build --release >"$WORKDIR/cargo.log" 2>&1; then
  cat "$WORKDIR/cargo.log"
  exit 1
fi
BIN="$ROOT/target/release/bao-os-helper"

launch_zenity() {
  local outfile="$1"
  : >"$outfile"
  # cwd is the throwaway dir, so Save prints $WORKDIR/$filename.
  (cd "$WORKDIR" && zenity --file-selection --save --title="Bao spike2" --filename="wrong.txt" >"$outfile" 2>>"$WORKDIR/zenity.err") &
  PIDS+=($!)
  echo $! >"$WORKDIR/zenity.pid"
}

wait_zenity() {
  local i
  for i in $(seq 1 30); do
    if ! kill -0 "$(cat "$WORKDIR/zenity.pid")" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

shot() {
  import -display "$DISPLAY" -window root "$1"
}

nontrivial() {
  local f="$1"
  local bytes std
  bytes="$(wc -c <"$f")"
  std="$(identify -format '%[fx:standard_deviation]' "$f")"
  python3 - "$bytes" "$std" "$f" <<'PY'
import sys
bytes_, std, path = int(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
if bytes_ < 8000 or std < 0.02:
    raise SystemExit(f"trivial image {path} bytes={bytes_} std={std}")
print(f"IMAGE {path} bytes={bytes_} std={std:.4f}")
PY
}

echo "WORKDIR=$WORKDIR"
launch_zenity "$WORKDIR/record.out"
"$BIN" record --value "$VALUE" --out "$WORKDIR/workflow.json" --dump "$WORKDIR/tree.txt" --screen 1280x800 \
  | tee "$WORKDIR/record.log"
shot "$WORKDIR/dialog_before_confirm.png"
nontrivial "$WORKDIR/dialog_before_confirm.png"
"$BIN" confirm --workflow "$WORKDIR/workflow.json" | tee "$WORKDIR/confirm.log"
if ! wait_zenity; then
  echo "FAIL record dialog did not close"
  exit 1
fi
RECORD_GOT="$(tr -d '\n' <"$WORKDIR/record.out")"
echo "RECORD_STDOUT=$RECORD_GOT"

# Fresh dialog, fresh helper process.
launch_zenity "$WORKDIR/replay.out"
sleep 0.8
shot "$WORKDIR/replay_before.png"
nontrivial "$WORKDIR/replay_before.png"

ffmpeg -y -loglevel error -f x11grab -video_size 1280x800 -framerate 8 -i "$DISPLAY" \
  -t 7 -c:v libvpx-vp9 -pix_fmt yuv420p "$WORKDIR/replay.webm" &
FF=$!
PIDS+=($FF)
sleep 0.4
# One fresh helper process sets the name, pauses so the grab can see it, then confirms.
"$BIN" replay --workflow "$WORKDIR/workflow.json" --pause-ms 1500 | tee "$WORKDIR/replay.log"
if ! wait_zenity; then
  echo "FAIL replay dialog did not close"
  exit 1
fi
REPLAY_GOT="$(tr -d '\n' <"$WORKDIR/replay.out")"
echo "REPLAY_STDOUT=$REPLAY_GOT"
shot "$WORKDIR/replay_closed.png"
wait "$FF" || true

EXPECTED="$WORKDIR/$VALUE"
python3 - "$WORKDIR" "$EXPECTED" "$RECORD_GOT" "$REPLAY_GOT" "$VALUE" <<'PY'
import json, sys
from pathlib import Path
workdir, expected, record_got, replay_got, value = sys.argv[1:]
wf = json.loads(Path(workdir, "workflow.json").read_text())
assert wf["version"] == 2, wf.get("version")
steps = wf["steps"]
assert [s["action"] for s in steps] == ["osSetValue", "osConfirm"], steps
for s in steps:
    t = s["os"]["target"]
    assert t["platform"] == "linux", t
    assert t["app"] == "zenity", t
    assert t["role"] and isinstance(t["name"], str), t
    assert isinstance(t["path"], list) and t["path"], t
    assert all("role" in p for p in t["path"])
    assert s["surface"] == "os"
set_step, confirm = steps
assert set_step["os"]["value"] == value
assert set_step["os"]["target"]["role"] == "text box", set_step["os"]["target"]
assert confirm["os"]["target"]["role"] == "button", confirm["os"]["target"]
assert expected.startswith(workdir + "/")
assert record_got == expected, record_got
assert replay_got == expected, replay_got
# The chosen file must stay inside the throwaway dir. Zenity prints the path
# even when the user cancels nothing; the file itself is not written until a
# caller saves. Nothing outside workdir may appear in the stdout.
for got in (record_got, replay_got):
    assert got.startswith(workdir + "/"), got
    assert ".." not in Path(got).parts
print("IR_OK")
print("RECORD_PATH_OK", record_got)
print("REPLAY_PATH_OK", replay_got)
PY

grep -q "STRATEGY=atspi-editable-text" "$WORKDIR/record.log"
grep -q "STRATEGY=atspi-action" "$WORKDIR/confirm.log"
grep -q "STRATEGY=atspi-editable-text" "$WORKDIR/replay.log"
grep -q "STRATEGY=atspi-action" "$WORKDIR/replay.log"
if grep -q "coordinate" "$WORKDIR/record.log" "$WORKDIR/confirm.log" "$WORKDIR/replay.log"; then
  echo "FAIL coordinate path mentioned"
  exit 1
fi

mkdir -p "$ARTIFACTS"
cp "$WORKDIR/dialog_before_confirm.png" "$ARTIFACTS/spike2_dialog_before_confirm.png"
cp "$WORKDIR/replay_before.png" "$ARTIFACTS/spike2_replay_before.png"
cp "$WORKDIR/replay_closed.png" "$ARTIFACTS/spike2_replay_closed.png"
cp "$WORKDIR/replay.webm" "$ARTIFACTS/spike2_replay.webm"
cp "$WORKDIR/workflow.json" "$ARTIFACTS/spike2_workflow.json"
cp "$WORKDIR/tree.txt" "$ARTIFACTS/spike2_tree.txt"

echo "PASS enumerated tree"
echo "PASS osSetValue + osConfirm linux role name path"
echo "PASS record dialog closed with $RECORD_GOT"
echo "PASS replay dialog closed with $REPLAY_GOT"
echo "PASS screenshots non-trivial"
echo "PASS strategy atspi only"
echo "SPIKE 2: PASS"
echo "ARTIFACTS=$ARTIFACTS"

#!/bin/sh
# Assemble BaoOSHelper.app from the release binary and ad-hoc sign it.
# No keychain identity is created. CC is /usr/bin/clang so the build does not
# call a shell alias named cc.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/dev/bao-mac-toolchain/rustup}"
export CARGO_HOME="${CARGO_HOME:-$HOME/dev/bao-mac-toolchain/cargo}"
export CC=/usr/bin/clang
export CXX=/usr/bin/clang++
CARGO="$CARGO_HOME/bin/cargo"
"$CARGO" build --release --manifest-path "$ROOT/Cargo.toml"
APP="$ROOT/BaoOSHelper.app"
/bin/rm -rf "$APP"
/bin/mkdir -p "$APP/Contents/MacOS"
/bin/cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"
/bin/cp "$ROOT/target/release/bao-os-macos" "$APP/Contents/MacOS/BaoOSHelper"
/bin/chmod 755 "$APP/Contents/MacOS/BaoOSHelper"
/usr/bin/codesign -s - --force --identifier dev.bao.oshelper \
  -r='designated => identifier "dev.bao.oshelper"' \
  "$APP"
/usr/bin/codesign --verify --verbose=2 "$APP"
/usr/bin/codesign -d -r- "$APP"

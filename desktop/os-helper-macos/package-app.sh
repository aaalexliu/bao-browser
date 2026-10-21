#!/bin/sh
# Assemble BaoOSHelper.app and sign it with the login-keychain identity.
# BAO_SIGN_IDENTITY overrides the certificate common name. No key material
# is read or written here. CC is /usr/bin/clang so the build does not call
# a shell alias named cc.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/dev/bao-mac-toolchain/rustup}"
export CARGO_HOME="${CARGO_HOME:-$HOME/dev/bao-mac-toolchain/cargo}"
export CC=/usr/bin/clang
export CXX=/usr/bin/clang++
IDENTITY="${BAO_SIGN_IDENTITY:-bao dev signing}"
CARGO="$CARGO_HOME/bin/cargo"
"$CARGO" build --release --manifest-path "$ROOT/Cargo.toml"
APP="$ROOT/BaoOSHelper.app"
/bin/rm -rf "$APP"
/bin/mkdir -p "$APP/Contents/MacOS"
/bin/cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"
/bin/cp "$ROOT/target/release/bao-os-macos" "$APP/Contents/MacOS/BaoOSHelper"
/bin/chmod 755 "$APP/Contents/MacOS/BaoOSHelper"
/usr/bin/codesign --force --options runtime --identifier dev.bao.oshelper -s "$IDENTITY" "$APP"
/usr/bin/codesign --verify --verbose=2 "$APP"
/usr/bin/codesign -d -r- "$APP"

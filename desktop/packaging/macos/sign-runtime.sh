#!/usr/bin/env bash
# Sign one file, or a bundle's main executable, with the hardened runtime.
# usage:
#   sign-runtime.sh PATH [--identifier ID] [--entitlements FILE]
#   sign-runtime.sh --inside-out PATH [--entitlements FILE]
# BAO_SIGN_IDENTITY selects the certificate. "-" is ad-hoc.
# --timestamp is added only when BAO_APPLE_TEAM_ID is set. A self-signed
# certificate cannot timestamp, and notarization requires a timestamp.
# --inside-out signs nested Mach-O files and bundles before the root.
# It refuses BaoOSHelper.app. Do not point it at Bao.app: that would re-sign the helper.
set -euo pipefail

IDENTITY="${BAO_SIGN_IDENTITY:-bao dev signing}"
IDENTIFIER=""
ENTITLEMENTS=""
INSIDE_OUT=0
TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --identifier) IDENTIFIER="${2:?}"; shift 2 ;;
    --entitlements) ENTITLEMENTS="${2:?}"; shift 2 ;;
    --inside-out) INSIDE_OUT=1; shift ;;
    -*)
      echo "sign-runtime.sh: unknown flag $1" >&2
      exit 2
      ;;
    *)
      if [[ -n "$TARGET" ]]; then
        echo "sign-runtime.sh: extra argument $1" >&2
        exit 2
      fi
      TARGET="$1"
      shift
      ;;
  esac
done
if [[ -z "$TARGET" ]]; then
  echo "usage: sign-runtime.sh PATH [--identifier ID] [--entitlements FILE]" >&2
  exit 2
fi

sign_one() {
  local path="$1"
  local -a args=(--force --options runtime --sign "$IDENTITY")
  if [[ -n "${BAO_APPLE_TEAM_ID:-}" && "$IDENTITY" != "-" ]]; then
    args+=(--timestamp)
  fi
  if [[ -n "$ENTITLEMENTS" ]]; then
    args+=(--entitlements "$ENTITLEMENTS")
  fi
  if [[ -n "$IDENTIFIER" && "$path" == "$TARGET" ]]; then
    args+=(--identifier "$IDENTIFIER")
  fi
  codesign "${args[@]}" "$path"
}

if [[ "$INSIDE_OUT" != 1 ]]; then
  sign_one "$TARGET"
  exit 0
fi

if [[ ! -d "$TARGET" ]]; then
  echo "sign-runtime.sh: --inside-out needs a bundle directory" >&2
  exit 2
fi

case "$TARGET" in
  */Bao.app|*/BaoOSHelper.app)
    echo "sign-runtime.sh: refusing to walk $TARGET" >&2
    exit 2
    ;;
esac

list="$(mktemp)"
cleanup() { rm -f "$list"; }
trap cleanup EXIT
while IFS= read -r -d '' file; do
  case "$file" in
    */BaoOSHelper.app/*) continue ;;
  esac
  if file -b "$file" | grep -q 'Mach-O'; then
    printf '%s\n' "$file"
  fi
done < <(find "$TARGET" -type f -print0) | awk '{ print length($0), $0 }' | sort -nr | cut -d' ' -f2- > "$list"
while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  sign_one "$file"
done < "$list"

while IFS= read -r -d '' bundle; do
  case "$bundle" in
    "$TARGET"|*/BaoOSHelper.app|*/BaoOSHelper.app/*) continue ;;
  esac
  sign_one "$bundle"
done < <(find "$TARGET" -depth -type d \( -name '*.app' -o -name '*.framework' -o -name '*.xpc' -o -name '*.bundle' \) -print0)
sign_one "$TARGET"

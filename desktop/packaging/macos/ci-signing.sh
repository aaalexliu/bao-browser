#!/usr/bin/env bash
# Pick the identity a release build signs with, for .github/workflows/mac-release.yml.
#   ci-signing.sh import   writes BAO_SIGN_IDENTITY (and BAO_HELPER_CERT_HASH) to GITHUB_ENV
#   ci-signing.sh delete   removes the temporary keychain
# Without BAO_SIGNING_P12 (a base64 .p12) the build is ad-hoc: BAO_SIGN_IDENTITY=-.
# With it, the .p12's certificate signs every part, and its SHA-1 pins the helper.
# A project certificate (self-signed, like "bao dev signing") works as is. Apple Developer ID
# also needs desktop/packaging/helper-identity.js to accept Apple's requirement form and a
# notarytool step; docs/release.md lists both.
set -euo pipefail
KEYCHAIN="${RUNNER_TEMP:?}/bao-signing.keychain-db"
case "${1:?usage: ci-signing.sh import|delete}" in
  import)
    if [[ -z "${BAO_SIGNING_P12:-}" ]]; then
      echo "No BAO_SIGNING_P12 secret: signing ad-hoc. The helper's Accessibility grant will not survive updates."
      echo "BAO_SIGN_IDENTITY=-" >> "$GITHUB_ENV"
      exit 0
    fi
    PASS="$(openssl rand -hex 16)"
    P12="$RUNNER_TEMP/bao-signing.p12"
    printf '%s' "$BAO_SIGNING_P12" | base64 --decode > "$P12"
    security create-keychain -p "$PASS" "$KEYCHAIN"
    security set-keychain-settings -lut 21600 "$KEYCHAIN"
    security unlock-keychain -p "$PASS" "$KEYCHAIN"
    security import "$P12" -k "$KEYCHAIN" -P "${BAO_SIGNING_P12_PASSWORD:-}" -T /usr/bin/codesign -f pkcs12
    security set-key-partition-list -S apple-tool:,apple: -s -k "$PASS" "$KEYCHAIN" >/dev/null
    EXISTING=()
    while IFS= read -r line; do
      EXISTING+=("$(printf '%s' "$line" | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')")
    done < <(security list-keychains -d user)
    security list-keychains -d user -s "$KEYCHAIN" "${EXISTING[@]}"
    rm -f "$P12"
    HASH="$(security find-certificate -a -Z "$KEYCHAIN" | awk '/SHA-1/{print $3; exit}')"
    echo "Signing with certificate $HASH"
    echo "BAO_SIGN_IDENTITY=$HASH" >> "$GITHUB_ENV"
    echo "BAO_HELPER_CERT_HASH=$HASH" >> "$GITHUB_ENV"
    ;;
  delete)
    [[ -f "$KEYCHAIN" ]] && security delete-keychain "$KEYCHAIN"
    exit 0
    ;;
  *)
    echo "usage: ci-signing.sh import|delete" >&2
    exit 2
    ;;
esac

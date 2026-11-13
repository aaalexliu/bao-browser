#!/usr/bin/env bash
# Pick the identity a release build signs with, for .github/workflows/mac-release.yml.
#   ci-signing.sh import   writes BAO_SIGN_IDENTITY to GITHUB_ENV.
#                          A project certificate also writes BAO_HELPER_CERT_HASH.
#                          Developer ID writes BAO_APPLE_TEAM_ID and does not pin the leaf SHA-1.
#   ci-signing.sh delete   removes the temporary keychain
# Without BAO_SIGNING_P12 (a base64 .p12) the build is ad-hoc: BAO_SIGN_IDENTITY=-.
# A self-signed project certificate (like "bao dev signing") signs every part, and its SHA-1
# pins the helper. A Developer ID certificate does not: helper-identity.js accepts Apple's
# requirement form for BAO_APPLE_TEAM_ID, which survives certificate renewal.
# Notarization is desktop/packaging/macos/notarize-app.sh, and runs only when the notary secrets are set.
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
    SUBJECT="$(security find-certificate -a -p "$KEYCHAIN" | openssl x509 -noout -subject -nameopt RFC2253)"
    ISSUER="$(security find-certificate -a -p "$KEYCHAIN" | openssl x509 -noout -issuer -nameopt RFC2253)"
    ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
    PLAN="$(node -e '
const { signingPlan } = require(process.argv[1]);
const plan = signingPlan(process.argv[2], process.argv[3], process.env.BAO_APPLE_TEAM_ID || "");
if (!plan.ok) { process.stderr.write(plan.reason + "\n"); process.exit(1); }
process.stdout.write(plan.pinHash ? "pin" : "team");
' "$ROOT/desktop/packaging/helper-identity.js" "$SUBJECT" "$ISSUER")"
    echo "Signing with certificate $HASH"
    echo "BAO_SIGN_IDENTITY=$HASH" >> "$GITHUB_ENV"
    if [[ "$PLAN" == pin ]]; then
      echo "BAO_HELPER_CERT_HASH=$HASH" >> "$GITHUB_ENV"
    else
      echo "BAO_APPLE_TEAM_ID=${BAO_APPLE_TEAM_ID}" >> "$GITHUB_ENV"
      echo "Developer ID: the helper requirement names team ${BAO_APPLE_TEAM_ID}, not the leaf SHA-1."
    fi
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

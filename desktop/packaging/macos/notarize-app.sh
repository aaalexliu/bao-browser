#!/usr/bin/env bash
# Notarize Bao.app and staple the ticket, before make-release-asset.sh zips it.
# Skips when any notary secret is missing, so a release with no secrets stays ad-hoc.
# usage: notarize-app.sh path/to/Bao.app
# Secrets: BAO_NOTARY_KEY_P8 (base64 .p8), BAO_NOTARY_KEY_ID, BAO_NOTARY_ISSUER_ID.
# A Developer ID build also has BAO_APPLE_TEAM_ID and a certificate BAO_SIGN_IDENTITY.
set -euo pipefail
APP="${1:?usage: notarize-app.sh path/to/Bao.app}"
if [[ -z "${BAO_NOTARY_KEY_P8:-}" || -z "${BAO_NOTARY_KEY_ID:-}" || -z "${BAO_NOTARY_ISSUER_ID:-}" ]]; then
  echo "No notary secrets: skipping notarization."
  exit 0
fi
if [[ "${BAO_SIGN_IDENTITY:-}" == "-" || -z "${BAO_SIGN_IDENTITY:-}" ]]; then
  echo "notarize-app.sh: notary secrets are set but the build is ad-hoc. Notarization needs a Developer ID signature." >&2
  exit 1
fi
if [[ -z "${BAO_APPLE_TEAM_ID:-}" ]]; then
  echo "notarize-app.sh: notary secrets are set but BAO_APPLE_TEAM_ID is missing." >&2
  exit 1
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bao-notarize.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
KEY="$WORK/AuthKey.p8"
printf '%s' "$BAO_NOTARY_KEY_P8" | base64 --decode > "$KEY"
chmod 600 "$KEY"
ZIP="$WORK/Bao-notarize.zip"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --wait --key "$KEY" --key-id "$BAO_NOTARY_KEY_ID" --issuer "$BAO_NOTARY_ISSUER_ID"
xcrun stapler staple "$APP"
echo "Notarized and stapled $APP"

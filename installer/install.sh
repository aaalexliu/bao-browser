#!/bin/sh
# Run the installer attached to the newest GitHub release. npx caches a URL spec, so the
# releases/latest tarball URL keeps the first copy it fetched. This reads release.json from
# that latest URL, then runs the versioned tarball, which is a different spec each release.
set -eu
latest="${BAO_INSTALLER_LATEST:-https://github.com/aaalexliu/bao-browser/releases/latest/download/release.json}"
case "$latest" in
  */releases/latest/download/release.json) ;;
  *)
    echo "bao-browser: the newest release URL must end in /releases/latest/download/release.json" >&2
    exit 1
    ;;
esac
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$latest" -o "$tmp"
version=$(node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version; if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v)) process.exit(1); process.stdout.write(v)' "$tmp")
base=${latest%/releases/latest/download/release.json}
pkg="$base/releases/download/v${version}/bao-browser.tgz"
if true </dev/tty 2>/dev/null; then
  exec npx --yes "$pkg" "$@" </dev/tty
fi
exec npx --yes "$pkg" "$@"

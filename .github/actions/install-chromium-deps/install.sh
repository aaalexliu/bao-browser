#!/usr/bin/env bash
# Install Playwright's Chromium apt packages, reusing cached debs when the
# runner image matches and falling back across Ubuntu mirrors when it does not.
set -euo pipefail

APT_ARCHIVES="${APT_ARCHIVES:-/tmp/bao-apt-archives}"
ATTEMPT_SECONDS="${ATTEMPT_SECONDS:-180}"

rewrite_file() {
  local file="$1"
  local host="$2"
  local tmp
  tmp="$(mktemp)"
  sed -E "s#https?://[^/[:space:]]*archive\\.ubuntu\\.com/ubuntu#http://${host}/ubuntu#g" "$file" > "$tmp"
  if [[ -w "$file" ]]; then
    mv "$tmp" "$file"
  else
    sudo cp "$tmp" "$file"
    rm -f "$tmp"
  fi
}

rewrite_ubuntu_archive() {
  local dir="$1"
  local host="$2"
  local file changed=0
  local candidates=()
  local extra
  if [[ -f "$dir/sources.list" ]]; then
    candidates+=("$dir/sources.list")
  fi
  if [[ -d "$dir/sources.list.d" ]]; then
    shopt -s nullglob
    for extra in "$dir/sources.list.d"/*; do
      if [[ -f "$extra" ]]; then
        candidates+=("$extra")
      fi
    done
  fi
  if (( ${#candidates[@]} == 0 )); then
    return 1
  fi
  for file in "${candidates[@]}"; do
    if grep -Eq 'https?://[^/[:space:]]*archive\.ubuntu\.com/ubuntu' "$file"; then
      rewrite_file "$file" "$host"
      changed=1
    fi
  done
  [[ "$changed" == 1 ]]
}

switch_mirror() {
  local host="$1"
  case "$host" in
    archive.ubuntu.com|mirrors.edge.kernel.org) ;;
    *)
      echo "refusing mirror host: ${host}" >&2
      return 1
      ;;
  esac
  echo "Switching Ubuntu archive mirror to ${host}"
  rewrite_ubuntu_archive /etc/apt "$host"
  sudo timeout --kill-after=10s 60s apt-get update
}

configure_apt() {
  mkdir -p "$APT_ARCHIVES/partial"
  printf 'Dir::Cache::archives "%s";\nBinary::apt-get::APT::Keep-Downloaded-Packages "true";\nAcquire::Retries "0";\nAcquire::http::Timeout "60";\nAcquire::https::Timeout "60";\n' "$APT_ARCHIVES" \
    | sudo tee /etc/apt/apt.conf.d/99-bao-ci >/dev/null
}

install_offline() {
  local debs=()
  shopt -s nullglob
  debs=("$APT_ARCHIVES"/*.deb)
  if (( ${#debs[@]} == 0 )); then
    echo "Cached deb archive was empty."
    return 1
  fi
  sudo timeout --kill-after=10s 150s dpkg -i "${debs[@]}"
}

prune_unused_debs() {
  local deb pkg ver installed
  local debs=()
  shopt -s nullglob
  sudo chmod -R a+rX "$APT_ARCHIVES"
  debs=("$APT_ARCHIVES"/*.deb)
  for deb in "${debs[@]}"; do
    pkg="$(dpkg-deb -f "$deb" Package)"
    ver="$(dpkg-deb -f "$deb" Version)"
    installed="$(dpkg-query -W -f '${Version}' "$pkg" 2>/dev/null || true)"
    if [[ "$installed" != "$ver" ]]; then
      sudo rm -f "$deb"
    fi
  done
}

attempt_install() {
  local label="$1"
  echo "::group::${label}"
  if timeout --kill-after=10s "$ATTEMPT_SECONDS" npx playwright install-deps chromium; then
    echo "::endgroup::"
    echo "Chromium system dependencies installed via ${label}"
    return 0
  fi
  local status=$?
  echo "::endgroup::"
  echo "install-deps failed during ${label} (status ${status})"
  return 1
}

finish_download() {
  prune_unused_debs
  local debs=()
  shopt -s nullglob
  debs=("$APT_ARCHIVES"/*.deb)
  if (( ${#debs[@]} == 0 )); then
    echo "::error::install-deps succeeded but left no deb files to cache."
    return 1
  fi
  sudo chmod a+r "${debs[@]}"
}

install_with_mirrors() {
  configure_apt
  if attempt_install "default Ubuntu mirror"; then
    finish_download
    return
  fi
  if switch_mirror archive.ubuntu.com && attempt_install "archive.ubuntu.com"; then
    finish_download
    return
  fi
  if switch_mirror mirrors.edge.kernel.org && attempt_install "mirrors.edge.kernel.org"; then
    finish_download
    return
  fi
  echo "::error::Chromium system dependency setup failed on the default Ubuntu mirror, archive.ubuntu.com, and mirrors.edge.kernel.org."
  return 1
}

main() {
  echo "deb-cache-hit=${CACHE_HIT:-false}"
  if [[ "${CACHE_HIT:-}" == true ]]; then
    if install_offline; then
      echo "Chromium system dependencies installed from cached debs"
      return 0
    fi
    echo "Cached deb install failed; downloading instead."
  fi
  install_with_mirrors
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

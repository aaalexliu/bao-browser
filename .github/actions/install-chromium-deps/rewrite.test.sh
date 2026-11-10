#!/usr/bin/env bash
# Rewrite Ubuntu archive URIs without apt. Run from any machine.
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=install.sh
source "$root/install.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/apt/sources.list.d"
cat > "$tmp/apt/sources.list.d/ubuntu.sources" << 'EOF'
Types: deb
URIs: http://azure.archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main universe restricted multiverse

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main universe restricted multiverse
EOF

rewrite_ubuntu_archive "$tmp/apt" archive.ubuntu.com
grep -q 'URIs: http://archive.ubuntu.com/ubuntu/' "$tmp/apt/sources.list.d/ubuntu.sources"
grep -q 'URIs: http://security.ubuntu.com/ubuntu/' "$tmp/apt/sources.list.d/ubuntu.sources"

rewrite_ubuntu_archive "$tmp/apt" mirrors.edge.kernel.org
grep -q 'URIs: http://mirrors.edge.kernel.org/ubuntu/' "$tmp/apt/sources.list.d/ubuntu.sources"
grep -q 'URIs: http://security.ubuntu.com/ubuntu/' "$tmp/apt/sources.list.d/ubuntu.sources"

if rewrite_ubuntu_archive "$tmp/apt" archive.ubuntu.com; then
  echo "expected no match after the kernel.org rewrite" >&2
  exit 1
fi

if switch_mirror evil.example; then
  echo "expected unknown host to be refused" >&2
  exit 1
fi

echo "rewrite checks passed"

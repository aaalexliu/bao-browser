#!/usr/bin/env bash
# Two-way sync between the Obsidian vault copy and this git repo.
# Newer file wins (mtime), then commits + pushes any repo changes.
set -euo pipefail

REPO_DIR="/Users/alexliu/dev/bao-browser"
VAULT_DIR="/Users/alexliu/obsidian/alex1/bao-browser"
FILE="product-design-v1.md"

# Reconcile: copy whichever side is newer onto the other (-u skips if dest is newer, -t preserves mtimes).
rsync -ut "$VAULT_DIR/$FILE" "$REPO_DIR/$FILE"
rsync -ut "$REPO_DIR/$FILE" "$VAULT_DIR/$FILE"

cd "$REPO_DIR"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "Sync $FILE from Obsidian"
  git push -q
  echo "Synced and pushed."
else
  echo "Already in sync."
fi

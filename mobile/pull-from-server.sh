#!/usr/bin/env bash
# Copy edits made on the server (~/herdr-mobile) back into this repo's mobile/ folder, so they can be
# reviewed (git diff) and committed. Doesn't delete anything here.
set -euo pipefail
HOST="${HOST:-server}"
HERE="$(cd "$(dirname "$0")" && pwd)"
rsync -av --exclude node_modules --exclude .git --exclude package-lock.json "$HOST:herdr-mobile/" "$HERE/"
git -C "$HERE" status --short -- .

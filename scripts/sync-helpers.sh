#!/usr/bin/env bash
# Keeps the shared helper files identical across mods.
#   section.js  canonical: mods/wb-spaces/section.js  (before the rename: mods/spaces-copy/)
#   ai.js       canonical: mods/wb-ai/ai.js           (before the rename: mods/commit-gen/)
# Targets are discovered: every other mods/*/ folder that already contains the helper.
# Mods without the helper (Herdr's built-ins) are never touched.
#
# Usage: scripts/sync-helpers.sh [--write|-w] [--help|-h]
#   (no flag)  report copies that differ from the canonical file; exit 1 if any differ
#   --write    copy the canonical file over the differing copies

set -euo pipefail

write=0
case "${1:-}" in
  "") ;;
  -w|--write) write=1 ;;
  -h|--help)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mods="$root/mods"
differ=0

# sync <file name> <candidate source mod folders...>
sync_file() {
  local name="$1"; shift
  local src="" cand dir
  for cand in "$@"; do
    if [ -f "$mods/$cand/$name" ]; then src="$mods/$cand/$name"; break; fi
  done
  if [ -z "$src" ]; then echo "no source found for $name (looked in: $*)" >&2; exit 2; fi
  echo "$name: source ${src#"$root"/}"

  for dir in "$mods"/*/; do
    local target="${dir}${name}"
    [ -f "$target" ] || continue
    [ "$target" -ef "$src" ] && continue
    if cmp -s "$src" "$target"; then continue; fi
    if [ "$write" = 1 ]; then
      cp "$src" "$target"
      echo "  updated ${target#"$root"/}"
    else
      echo "  differs ${target#"$root"/}"
      diff -u "$src" "$target" | sed 's/^/    /' | head -20 || true
      differ=1
    fi
  done
}

sync_file section.js wb-spaces spaces-copy
sync_file ai.js wb-ai commit-gen

if [ "$differ" = 1 ]; then
  echo "Out of sync. Run: scripts/sync-helpers.sh --write" >&2
  exit 1
fi
[ "$write" = 1 ] || echo "All copies in sync."

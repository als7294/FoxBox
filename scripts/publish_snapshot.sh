#!/usr/bin/env bash
# Publish main to GitHub as a history-free snapshot commit (authored with this repo's configured identity).
# Local history, which may carry personal author emails, never leaves this Mac.
# A local deny-list at ~/.config/foxbox/publish-deny.txt (never committed) blocks strings that must not ship,
# in file contents and in file names.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
SRC="${1:-main}"
DENY="${FVWKS_PUBLISH_DENY:-$HOME/.config/foxbox/publish-deny.txt}"
tree=$(git rev-parse "$SRC^{tree}")
if [ -f "$DENY" ]; then
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    if git grep -I -q -i -F "$pat" "$SRC" -- .; then echo "refusing to publish: a deny-listed string is present in $SRC"; exit 1; fi
    if git ls-tree -r --name-only "$SRC" | grep -q -i -F "$pat"; then echo "refusing to publish: a deny-listed string is in a file name in $SRC"; exit 1; fi
  done < "$DENY"
fi
parent=$(git rev-parse -q --verify refs/heads/publish-foxbox || true)
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then echo "publish already matches $SRC"; exit 0; fi
msg="FoxBox snapshot ($(git rev-parse --short "$SRC"), $(date -u +%Y-%m-%d))"
commit=$(git commit-tree "$tree" ${parent:+-p "$parent"} -m "$msg")
git update-ref refs/heads/publish-foxbox "$commit"
git push origin publish-foxbox:main
echo "published $commit"

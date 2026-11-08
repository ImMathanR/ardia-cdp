#!/usr/bin/env bash
# Remove the /ardia skill installed by install.sh. Ardia's own data is untouched.
set -euo pipefail
DEST="${ARDIA_SKILL_DIR:-$HOME/.claude/skills/ardia}"
if [[ -d "$DEST" ]]; then
  rm -rf "$DEST"
  echo "→ removed $DEST"
else
  echo "→ nothing at $DEST"
fi

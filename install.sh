#!/usr/bin/env bash
# Install the /ardia skill for Claude Code and build the pane's ScreenCaptureKit helper.
#
#   ./install.sh            install into ~/.claude/skills/ardia (skips an existing skill)
#   ./install.sh --force    replace an existing skill with this one
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${ARDIA_SKILL_DIR:-$HOME/.claude/skills/ardia}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

command -v node >/dev/null || { echo "node is required (Node 22+)."; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || { echo "Node 22+ is required (found $(node -v))."; exit 1; }

if [[ -e "$DEST/SKILL.md" && $FORCE -eq 0 ]]; then
  echo "→ $DEST already exists — leaving it as-is (use --force to replace it)"
else
  echo "→ installing the /ardia skill to $DEST"
  mkdir -p "$DEST/bin" "$DEST/scripts"
  install -m 0644 "$REPO_DIR/skill/SKILL.md" "$DEST/SKILL.md"
  install -m 0755 "$REPO_DIR"/scripts/*.mjs "$DEST/scripts/"
  install -m 0755 "$REPO_DIR"/scripts/*.py  "$DEST/scripts/"
  install -m 0644 "$REPO_DIR"/scripts/*.swift "$REPO_DIR"/scripts/*.h "$DEST/scripts/"
fi

# The pane's live view uses a small ScreenCaptureKit helper (macOS + Swift).
build_frames() {
  local out="$1"
  [[ "$(uname)" == "Darwin" ]] || return 0
  command -v swiftc >/dev/null || { echo "→ swiftc not found: skipping $out (the pane falls back to screenshots)"; return 0; }
  echo "→ building $out"
  mkdir -p "$(dirname "$out")"
  swiftc -O -import-objc-header "$REPO_DIR/scripts/ardia-frames-shim.h" \
         -o "$out" "$REPO_DIR/scripts/ardia-frames.swift" 2>/dev/null \
    || echo "→ couldn't build the helper (Xcode command line tools?); the pane falls back to screenshots"
}
# both locations work: the skill's bin/, and the clone's bin/ when running from here
build_frames "$DEST/bin/ardia-frames"
build_frames "$REPO_DIR/bin/ardia-frames"

echo
echo "Done. In Ardia, turn on Settings › Let the ardia command control Ardia, then:"
echo "  node $DEST/scripts/ardia-cdp.mjs list"

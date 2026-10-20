#!/usr/bin/env bash
# worktree-guard: PreToolUse hook that blocks file writes outside declared
# worktree roots. Reads the tool-call JSON on stdin (Claude Code and Codex
# use the same shape) and exits 2 with a stderr explanation to deny.
#
# No-op unless <project>/.worktree-guard.json exists:
#   { "enabled": true, "allowedRoots": [".worktrees/issue-42"] }
set -euo pipefail

input=$(cat)
root="${CLAUDE_PROJECT_DIR:-$PWD}"
manifest="$root/.worktree-guard.json"
[ -f "$manifest" ] || exit 0

WTG_INPUT="$input" WTG_ROOT="$root" WTG_MANIFEST="$manifest" python3 - <<'PY'
import json
import os
import sys

data = json.loads(os.environ.get("WTG_INPUT") or "{}")
root = os.path.realpath(os.environ["WTG_ROOT"])

with open(os.environ["WTG_MANIFEST"], encoding="utf-8") as fh:
    manifest = json.load(fh)

if not manifest.get("enabled", True):
    sys.exit(0)

allowed = []
for entry in manifest.get("allowedRoots", []):
    resolved = entry if os.path.isabs(entry) else os.path.join(root, entry)
    allowed.append(os.path.realpath(resolved))

if not allowed:
    sys.exit(0)

tool_input = data.get("tool_input") or {}
candidates = [
    tool_input.get(key)
    for key in ("file_path", "path", "notebook_path")
    if tool_input.get(key)
]
if not candidates:
    sys.exit(0)

base = data.get("cwd") or root
for candidate in candidates:
    resolved = candidate if os.path.isabs(candidate) else os.path.join(base, candidate)
    real = os.path.realpath(resolved)
    inside = any(real == r or real.startswith(r + os.sep) for r in allowed)
    if not inside:
        roots = ", ".join(manifest.get("allowedRoots", []))
        sys.stderr.write(
            f"worktree-guard: blocked write to {candidate} — outside the declared "
            f"worktree roots ({roots}). Write inside the declared worktree; if the "
            f"scope legitimately changed, update .worktree-guard.json first.\n"
        )
        sys.exit(2)
PY

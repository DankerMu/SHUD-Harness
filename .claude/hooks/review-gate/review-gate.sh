#!/usr/bin/env bash
# review-gate: PreToolUse hook that denies implementer/reviewer subagent
# spawns while the subagent-workflow fix-pass gate is locked.
#
# Contains no gate logic: it only reads the `locked`/`lockReason` fields that
# the skill's fix_gate.py CLI precomputes into <project>/.review-gate.json.
# No-op unless that state file exists, so it is safe to install everywhere.
set -euo pipefail

input=$(cat)
root="${CLAUDE_PROJECT_DIR:-$PWD}"
state="$root/.review-gate.json"
[ -f "$state" ] || exit 0

RG_INPUT="$input" RG_STATE="$state" python3 - <<'PY'
import json
import os
import sys

data = json.loads(os.environ.get("RG_INPUT") or "{}")
with open(os.environ["RG_STATE"], encoding="utf-8") as fh:
    state = json.load(fh)

if not state.get("enabled", True) or not state.get("locked"):
    sys.exit(0)

tool_input = data.get("tool_input") or {}
# Claude Code Task carries `subagent_type`; Codex collaboration.spawn_agent /
# followup_task payloads name the agent under one of the other keys.
subagent = ""
for key in ("subagent_type", "agent", "agent_type", "agent_name", "name", "role", "target_agent"):
    value = tool_input.get(key)
    if isinstance(value, str) and value.strip():
        subagent = value.strip().lower()
        break
blocked = [s.lower() for s in state.get("blockedSubagents") or ["implementer", "reviewer"]]
if subagent not in blocked:
    sys.exit(0)

reason = state.get("lockReason") or "fix-pass gate is locked"
sys.stderr.write(
    f"review-gate: blocked `{subagent}` spawn - {reason}. "
    "Stop and report to the user. Only a recorded user decision "
    "(`python3 <subagent-workflow skill dir>/scripts/fix_gate.py extend "
    "--user-approved '<decision>'`) unlocks one more fix pass.\n"
)
sys.exit(2)
PY

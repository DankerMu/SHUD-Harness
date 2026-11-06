#!/usr/bin/env bash
# instruction-guard: PreToolUse hook that requires the user's approval before
# AGENTS.md or CLAUDE.md (any directory) is modified.
#
#   instruction-guard.sh [--platform claude|codex|omp]   guard mode, tool JSON on stdin
#   instruction-guard.sh approve <path>...                 user-run one-shot approval
#
# claude: emits permissionDecision "ask", so Claude Code shows its own approval
#         prompt (headless `claude -p` denies it).
# codex / omp: these hook APIs cannot ask, so the call is denied (exit 2) unless
#         the user has approved each target with `approve`. omp.ts turns the
#         deny into an interactive confirm when omp has a UI.
#
# Approvals are one-shot and expire after INSTRUCTION_GUARD_TTL seconds (900).
# They live outside the project, in $XDG_STATE_HOME/instruction-guard, so they
# are never committed and a workspace-sandboxed agent cannot forge them.
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/instruction-guard/approvals"

mode=guard
platform=claude
if [ "${1:-}" = "approve" ]; then
    mode=approve
    shift
elif [ "${1:-}" = "--platform" ]; then
    platform="${2:-claude}"
    shift 2 || true
fi

input=""
if [ "$mode" = "guard" ]; then
    input=$(cat)
fi

IG_MODE="$mode" IG_PLATFORM="$platform" IG_INPUT="$input" IG_SCRIPT="$SCRIPT_PATH" \
    IG_STATE_DIR="$STATE_DIR" IG_TTL="${INSTRUCTION_GUARD_TTL:-900}" \
    IG_ROOT="${CLAUDE_PROJECT_DIR:-}" python3 -I - "$@" <<'PY'
import hashlib
import json
import os
import re
import shlex
import sys
import time

GUARDED = {"AGENTS.md", "CLAUDE.md"}
MODE = os.environ["IG_MODE"]
PLATFORM = os.environ["IG_PLATFORM"]
SCRIPT = os.environ["IG_SCRIPT"]
STATE_DIR = os.environ["IG_STATE_DIR"]
TTL = int(os.environ["IG_TTL"])

# A guarded name as a shell word or path tail: `AGENTS.md`, `docs/CLAUDE.md`,
# `"./AGENTS.md"`. Not `AGENTS.md.bak` and not `MY_AGENTS.md`.
MENTION = re.compile(r"""(?<![\w.-])((?:[^\s"'`|;&<>()]*/)?(?:AGENTS|CLAUDE)\.md)(?![\w.-])""")
# Anything in a shell command that can write a file. Deliberately broad: a false
# positive costs one approval prompt, a false negative is an unreviewed edit.
WRITE = re.compile(
    r"""(?<![0-9&>])>{1,2}(?!&)(?!\s*/dev/null\b)"""
    r"""|\btee\b|\bsed\b[^|;&]*\s(?:-[a-zA-Z]*i|--in-place)|\bperl\b[^|;&]*\s-[a-zA-Z]*i"""
    r"""|\b(?:mv|cp|rm|ln|truncate|dd|install|rsync|touch|chmod|chown|patch|unlink)\b"""
    r"""|\bgit\s+(?:checkout|restore|mv|rm|apply|stash|reset|am|cherry-pick|merge|rebase|pull|switch)\b"""
    r"""|--write\b|-delete\b"""
    r"""|\b(?:python3?|node|ruby|perl|bash|sh|zsh|deno|bun)\b\s+(?:-[ce]\b|-(?:\s|$)|<<)"""
)
SELF_APPROVE = re.compile(r"instruction-guard(?:\.sh)?['\"]?\s+approve\b")
PATCH_HEADER = re.compile(r"^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$", re.M)


def token_path(real):
    return os.path.join(STATE_DIR, hashlib.sha256(real.encode("utf-8")).hexdigest())


def resolve(candidate, base):
    path = os.path.expanduser(candidate)
    if not os.path.isabs(path):
        path = os.path.join(base, path)
    return os.path.realpath(path)


def guarded(real):
    return os.path.basename(real) in GUARDED


def in_state_dir(real):
    state = os.path.realpath(STATE_DIR)
    return real == state or real.startswith(state + os.sep)


def approve(paths):
    if not paths:
        sys.stderr.write("usage: instruction-guard.sh approve <AGENTS.md|CLAUDE.md path>...\n")
        return 1
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    for candidate in paths:
        real = resolve(candidate, os.getcwd())
        if not guarded(real):
            sys.stderr.write(f"instruction-guard: {candidate} is not AGENTS.md or CLAUDE.md\n")
            return 1
        with open(token_path(real), "w", encoding="utf-8") as fh:
            json.dump({"path": real, "approvedAt": time.time()}, fh)
        print(f"approved once for {TTL // 60} min: {real}")
    return 0


def take_tokens(reals):
    """Consume one fresh approval per target, all or nothing."""
    now = time.time()
    tokens = []
    for real in reals:
        tp = token_path(real)
        try:
            with open(tp, encoding="utf-8") as fh:
                record = json.load(fh)
        except (OSError, ValueError):
            return False
        if record.get("path") != real or not 0 <= now - float(record.get("approvedAt", 0)) <= TTL:
            return False
        tokens.append(tp)
    for tp in tokens:
        try:
            os.unlink(tp)
        except OSError:
            pass
    return True


def guard():
    try:
        data = json.loads(os.environ.get("IG_INPUT") or "{}")
    except ValueError:
        return 0
    if not isinstance(data, dict):
        return 0
    base = data.get("cwd") or os.environ.get("IG_ROOT") or os.getcwd()
    tool = str(data.get("tool_name") or "")
    tool_input = data.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return 0

    candidates = [tool_input[k] for k in ("file_path", "path", "notebook_path") if isinstance(tool_input.get(k), str)]
    if isinstance(tool_input.get("paths"), list):
        candidates += [p for p in tool_input["paths"] if isinstance(p, str)]
    command = tool_input.get("command")
    via_shell = False
    if isinstance(command, str):
        if tool == "apply_patch" or command.lstrip().startswith("*** Begin Patch"):
            candidates += PATCH_HEADER.findall(command)
        elif tool.lower() in ("bash", "shell", "exec_command"):
            if SELF_APPROVE.search(command):
                return decide([], "runs the instruction-guard approval command, which only the user may run")
            if WRITE.search(command) and ("instruction-guard/approvals" in command
                                          or os.path.realpath(STATE_DIR) in command or STATE_DIR in command):
                return decide([], "writes into the instruction-guard approval store")
            if WRITE.search(command):
                mentions = MENTION.findall(command)
                if mentions:
                    via_shell = True
                    candidates += mentions

    reals = [resolve(c, base) for c in candidates]
    if any(in_state_dir(r) for r in reals):
        return decide([], "writes into the instruction-guard approval store")
    targets = sorted({r for r in reals if guarded(r)})
    if not targets:
        return 0
    how = "a shell command that may modify" if via_shell else "a change to"
    return decide(targets, f"{how} " + ", ".join(targets))


def decide(targets, what):
    if PLATFORM == "claude":
        reason = (f"instruction-guard: {what}. AGENTS.md / CLAUDE.md changes need your approval; "
                  "review the change before allowing it.")
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "ask",
            "permissionDecisionReason": reason,
        }}))
        return 0
    if targets and take_tokens(targets):
        return 0
    if targets:
        approve_cmd = "bash " + shlex.quote(SCRIPT) + " approve " + " ".join(shlex.quote(t) for t in targets)
        sys.stderr.write(
            f"instruction-guard: blocked {what}. AGENTS.md / CLAUDE.md changes need the user's approval. "
            "Stop, show the user the exact change and why, and ask them to approve it. The user approves "
            f"by running in their own terminal (one-shot, {TTL // 60} min): {approve_cmd} ; then retry "
            "the same change. Never run the approval command yourself.\n"
        )
    else:
        sys.stderr.write(f"instruction-guard: blocked a command that {what}. Ask the user instead.\n")
    return 2


sys.exit(approve(sys.argv[1:]) if MODE == "approve" else guard())
PY

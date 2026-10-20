#!/usr/bin/env sh
# no-bypass: agent-native enforcement of AGENTS.md ## Agent Operating Rules (out-of-bounds list).
# One script, two consumers: .claude/settings.json (PreToolUse Bash|Edit|Write) and .codex/hooks.json
# (exec_command|apply_patch). Reads the tool-call JSON on stdin and exits 2 with a reason to block.
# Rules are deliberately narrow and listed in constraints.yaml `no_bypass`.
# Known limit: a heredoc whose *body* contains a forbidden command line is blocked too — write such files
# with the editor tool instead of a shell redirect.
set -eu
input=$(cat)
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
NB_INPUT="$input" NB_ROOT="${CLAUDE_PROJECT_DIR:-$root}" python3 -I - <<'PY'
import json, os, re, sys

try:
    data = json.loads(os.environ.get("NB_INPUT") or "{}")
except json.JSONDecodeError:
    sys.exit(0)
root = os.path.realpath(os.environ.get("NB_ROOT") or os.getcwd())
base = data.get("cwd") or root
tool_input = data.get("tool_input") or {}
command = tool_input.get("command") or tool_input.get("cmd") or ""
if isinstance(command, list):
    command = " ".join(str(p) for p in command)
paths = []
for key in ("file_path", "path", "notebook_path"):
    v = tool_input.get(key)
    if isinstance(v, str):
        paths.append(v)
patch = tool_input.get("patch") or tool_input.get("input") or ""
if isinstance(patch, str):
    paths += re.findall(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$", patch, re.M)


def deny(reason):
    sys.stderr.write(f"no-bypass: blocked — {reason}\n")
    sys.exit(2)


def writes_to(target):
    """True when a write-ish verb in `command` has `target` in its argument span."""
    t = re.escape(target)
    pats = [
        rf"(>|>>)\s*\S*{t}",
        rf"\b(rm|mv|cp|tee|touch|mkdir|chmod|chown|ln|rsync|unlink|truncate)\b[^|;&\n]*{t}",
        rf"\bsed\s+-i[^|;&\n]*{t}",
        rf"\bgit\b[^|;&\n]*-C\s+\S*{t}[^|;&\n]*\b(commit|checkout|reset|rebase|pull|stash|apply|clean|merge|cherry-pick|push|rm|mv|tag)\b",
        rf"\bcd\s+\S*{t}\S*\s*(&&|;)\s*(git\s+(commit|checkout|reset|rebase|pull|stash|apply|clean|merge|cherry-pick|push|rm|mv|tag)|pnpm\s+(add|remove|install|update|up)|npm\b|yarn\b|rm\b|mv\b|sed\s+-i)",
        rf"\b(pnpm|npm|yarn)\b[^|;&\n]*(-C|--dir|--prefix)\s+\S*{t}",
    ]
    return any(re.search(p, command) for p in pats)


def is_repo_root_file(p, names):
    """True when p resolves to <repo root>/<name> for one of names (generated root instruction files)."""
    norm = p.replace("\\", "/")
    resolved = os.path.realpath(norm if os.path.isabs(norm) else os.path.join(base, norm))
    return any(resolved == os.path.join(root, n) for n in names)


if command:
    if re.search(r"\bgit\b[^|;&\n]*\b(commit|push|merge|rebase)\b[^|;&\n]*\s--no-verify\b", command):
        deny("the no-verify flag skips the pre-commit/commit-msg gates; fix the failing check instead")
    m = re.search(r"\bgit\b[^|;&\n]*\bconfig\b[^|;&\n]*core\.hooksPath\s+(\S+)", command)
    if m and m.group(1).strip("'\"") != ".git-hooks":
        deny("core.hooksPath must stay .git-hooks (pnpm run prepare)")
    for seg in re.findall(r"\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*", command):
        if re.search(r"\s(--force|-f|--force-with-lease)\b", seg):
            if re.search(r"\bmain\b", seg) or not re.search(r"\bpush\b(\s+-\S+)*\s+\S+\s+[^-\s]\S*", seg):
                deny("force-push to main (or to the current branch without an explicit refspec) is forbidden")
    if re.search(r"\bgit\b[^|;&\n]*\b(tag\s+-d|push\b[^|;&\n]*(--delete|\s:))[^|;&\n]*archive/zero", command):
        deny("the archive/zero-v0.8.3 tag is frozen history")
    if writes_to("deepseek-harness"):
        deny("../deepseek-harness is the read-only pinned dsh host (ADR-0004 K2); upgrades go through a chore(dsh-upgrade) issue")
    if writes_to("data/raw"):
        deny("data/raw is immutable (ADR-0004 K12); never write, move or delete raw data")
    if re.search(r"session-log-deepseek", command) and re.search(r"disabled:\s*false", command):
        deny("session-log-deepseek must stay disabled (ADR-0004 K9)")
    if (writes_to("AGENTS.md") or writes_to("CLAUDE.md")) and "instructions/agents" not in command and "instructions:render" not in command:
        deny("AGENTS.md/CLAUDE.md are generated; edit instructions/agents/*.md then run pnpm run instructions:render")
    if writes_to("docs/generated/"):
        deny("docs/generated is generated; change the Zod schema then run pnpm run schema:generate")
    if writes_to("docs/adr/archived/"):
        deny("archived decision records are frozen; write a new record in docs/adr/proposed/")

for p in paths:
    norm = p.replace("\\", "/")
    if "deepseek-harness/" in norm:
        deny(f"{p}: ../deepseek-harness is read-only (ADR-0004 K2)")
    if re.search(r"(^|/)data/raw(/|$)", norm):
        deny(f"{p}: data/raw is immutable (ADR-0004 K12)")
    if is_repo_root_file(p, ("AGENTS.md", "CLAUDE.md")):
        deny(f"{p} is generated; edit instructions/agents/*.md then run pnpm run instructions:render")
    if re.search(r"(^|/)docs/generated/", norm):
        deny(f"{p} is generated; change the Zod schema then run pnpm run schema:generate")
    if re.search(r"(^|/)docs/adr/archived/", norm):
        deny(f"{p}: archived decision records are frozen; write a new record in docs/adr/proposed/")
sys.exit(0)
PY

#!/usr/bin/env bash
# instruction-guard: PreToolUse size gate for AGENTS.md and CLAUDE.md (any directory).
#
#   instruction-guard.sh [--platform claude|codex|omp]   guard mode, tool JSON on stdin
#   instruction-guard.sh check [path...]                   report files over the limits
#
# Every AGENTS.md / CLAUDE.md must stay within INSTRUCTION_GUARD_MAX_BYTES (32768)
# and every line within INSTRUCTION_GUARD_MAX_LINE_BYTES (307, i.e. 0.3 KiB).
# Old content counts too:
# - when the tool call lets the guard compute the resulting file (file tools and
#   patches), the result must be within the limits, or be progress on a file that
#   is already over (less excess, no new long line);
# - when it cannot (shell commands, omp hashline/patch edits), the call is denied
#   while the current file is over the limits.
# A denial tells the agent to slim the file with the eng-init skill. Claude Code
# gets permissionDecision "deny"; Codex and omp get exit 2 with the reason.
set -euo pipefail

mode=guard
platform=claude
if [ "${1:-}" = "check" ]; then
    mode=check
    shift
elif [ "${1:-}" = "--platform" ]; then
    platform="${2:-claude}"
    shift 2 || true
fi

input=""
if [ "$mode" = "guard" ]; then
    input=$(cat)
fi

IG_MODE="$mode" IG_PLATFORM="$platform" IG_INPUT="$input" IG_ROOT="${CLAUDE_PROJECT_DIR:-}" \
    IG_MAX_BYTES="${INSTRUCTION_GUARD_MAX_BYTES:-32768}" IG_MAX_LINE="${INSTRUCTION_GUARD_MAX_LINE_BYTES:-307}" \
    python3 -I - "$@" <<'PY'
import fnmatch
import json
import os
import re
import sys

GUARDED = {"AGENTS.md", "CLAUDE.md"}
MODE = os.environ["IG_MODE"]
PLATFORM = os.environ["IG_PLATFORM"]
MAX_BYTES = int(os.environ["IG_MAX_BYTES"])
MAX_LINE = int(os.environ["IG_MAX_LINE"])
SLIM_HINT = (
    "Slim it with the eng-init skill in repair mode, following its 'AGENTS.md repair style' (SKILL.md) "
    "and references/agents-md-sections.md 'Rendering strategy - concise hard kernel', 'Size budget' and "
    "'Byte budget': keep a compact hard kernel, relocate before condensing, condense before raising, "
    "never drop a rule; decisions, the user's verbatim wording and user-owned sections are moved intact "
    "into linked docs, never rewritten. When AGENTS.md / CLAUDE.md is generated from source fragments, "
    "slim the sources and re-render. Make the change with a file edit tool (Write / Edit / apply_patch) "
    "so the result can be checked."
)

# A guarded name as a shell word or path tail: `AGENTS.md`, `docs/CLAUDE.md`,
# `"./AGENTS.md"`. Not `AGENTS.md.bak` and not `MY_AGENTS.md`.
MENTION = re.compile(r"""(?<![\w.-])((?:[^\s"'`|;&<>()]*/)?(?:AGENTS|CLAUDE)\.md)(?![\w.-])""")
# Fallback when a command cannot be tokenized (unbalanced quotes): any write sign.
WRITE = re.compile(
    r"""(?<![0-9&>])>{1,2}(?!&)(?!\s*/dev/null\b)"""
    r"""|\btee\b|\bsed\b[^|;&]*\s(?:-[a-zA-Z]*i|--in-place)|\bperl\b[^|;&]*\s-[a-zA-Z]*i"""
    r"""|\b(?:mv|cp|rm|ln|truncate|dd|install|rsync|touch|chmod|chown|patch|unlink)\b"""
    r"""|\bgit\s+(?:checkout|restore|mv|rm|apply|stash|reset|am|cherry-pick|merge|rebase|pull|switch)\b"""
    r"""|--write\b|-delete\b"""
    r"""|\b(?:python3?|node|ruby|perl|bash|sh|zsh|deno|bun)\b\s+(?:-[ce]\b|-(?:\s|$)|<<)"""
)
PATCH_FILE = re.compile(r"^\*\*\* (Add File|Update File|Delete File): (.+?)\s*$")
PATCH_MOVE = re.compile(r"^\*\*\* Move to: (.+?)\s*$")
HASHLINE_HEADER = re.compile(r"^\s*\[(?:\*\*\* (?:Add|Update|Delete) File:\s*)?([^\]\r\n#]+?)\s*(?:#[0-9A-Fa-f]+)?\]\s*$", re.M)


def resolve(candidate, base):
    path = os.path.expanduser(candidate)
    if not os.path.isabs(path):
        path = os.path.join(base, path)
    return os.path.realpath(path)


def guarded(real):
    return os.path.basename(real) in GUARDED


# --- size limits -----------------------------------------------------------

def size_problems(text):
    """(total excess in bytes, long lines as a set, human-readable problems)."""
    size = len(text.encode("utf-8"))
    excess, long_lines, problems = max(0, size - MAX_BYTES), set(), []
    if size > MAX_BYTES:
        problems.append(f"{size} bytes (limit {MAX_BYTES})")
    for number, line in enumerate(text.splitlines(), 1):
        width = len(line.encode("utf-8"))
        if width > MAX_LINE:
            excess += width - MAX_LINE
            long_lines.add(line)
            problems.append(f"line {number} is {width} bytes (limit {MAX_LINE})")
    return excess, long_lines, problems


def limit_violation(real, before, after):
    """Why after breaks the size limits, or None. A file already over the limits may
    only change in a way that reduces the excess and adds no new long line."""
    excess, long_lines, problems = size_problems(after)
    if not problems:
        return None
    old_excess, old_long, _ = size_problems(before or "")
    if excess < old_excess and long_lines <= old_long:
        return None
    shown = "; ".join(problems[:5]) + (f"; and {len(problems) - 5} more" if len(problems) > 5 else "")
    return f"{real} would be over the limits ({shown})"


def current_violation(real, current):
    """Why a change the guard cannot compute is refused: the file is already over."""
    if current is None:
        return None
    _, _, problems = size_problems(current)
    if not problems:
        return None
    shown = "; ".join(problems[:5]) + (f"; and {len(problems) - 5} more" if len(problems) > 5 else "")
    return f"{real} is over the limits ({shown}) and this change cannot be checked"


# --- computing the resulting file ------------------------------------------

def read_text(real):
    try:
        with open(real, encoding="utf-8", newline="") as fh:
            return fh.read()
    except FileNotFoundError:
        return ""
    except (OSError, UnicodeDecodeError):
        return None


def replace_once(text, old, new, replace_all=False):
    if text is None or not isinstance(old, str) or not isinstance(new, str):
        return None
    if old == "":
        return new if text == "" else None
    count = text.count(old)
    if count == 0 or (count > 1 and not replace_all):
        return None
    return text.replace(old, new) if replace_all else text.replace(old, new, 1)


def find_unique(lines, block, start):
    """Index of the only occurrence of block in lines[start:], exact or ignoring
    trailing whitespace; None when absent or ambiguous."""
    for norm in (lambda s: s, lambda s: s.rstrip()):
        want = [norm(x) for x in block]
        hits = [i for i in range(start, len(lines) - len(block) + 1)
                if [norm(x) for x in lines[i:i + len(block)]] == want]
        if len(hits) == 1:
            return hits[0]
        if hits:
            return None
    return None


def apply_update(text, body):
    """Apply Codex-style update hunks; None whenever the result is not certain."""
    if text is None:
        return None
    lines = text.split("\n")
    chunks, cur = [], None
    for raw in body:
        if raw.startswith("@@"):
            cur = {"anchor": raw[2:].strip(), "lines": []}
            chunks.append(cur)
            continue
        if cur is None:
            cur = {"anchor": "", "lines": []}
            chunks.append(cur)
        cur["lines"].append(raw)
    cursor = 0
    for chunk in chunks:
        if chunk["anchor"]:
            idx = next((i for i in range(cursor, len(lines)) if lines[i].strip() == chunk["anchor"]), None)
            if idx is None:
                return None
            cursor = idx + 1
        old, new = [], []
        for raw in chunk["lines"]:
            tag, rest = (raw[0], raw[1:]) if raw else (" ", "")
            if tag not in " -+":
                return None
            if tag != "+":
                old.append(rest)
            if tag != "-":
                new.append(rest)
        if not old:
            return None  # pure insertion: placement is not certain enough to judge
        pos = find_unique(lines, old, cursor)
        if pos is None:
            return None
        lines[pos:pos + len(old)] = new
        cursor = pos + len(new)
    return "\n".join(lines)


def patch_changes(patch, base):
    """(real path, resulting text or None) for every file a Codex patch touches."""
    sections, cur = [], None
    for raw in patch.split("\n"):
        m = PATCH_FILE.match(raw)
        if m:
            cur = {"op": m.group(1).split()[0], "path": m.group(2), "move": None, "body": []}
            sections.append(cur)
            continue
        m = PATCH_MOVE.match(raw)
        if m and cur is not None:
            cur["move"] = m.group(1)
            continue
        if raw.startswith("*** End Patch"):
            cur = None
            continue
        if raw.startswith("*** "):
            continue
        if cur is not None:
            cur["body"].append(raw)
    texts, changes = {}, []
    for sec in sections:
        real = resolve(sec["path"], base)
        if sec["op"] == "Add":
            texts[real] = "".join(line[1:] + "\n" for line in sec["body"] if line.startswith("+"))
            changes.append((sec["path"], real, texts[real]))
        elif sec["op"] == "Delete":
            texts[real] = ""
            changes.append((sec["path"], real, ""))
        elif sec["move"] is None:
            current = texts[real] if real in texts else read_text(real)
            texts[real] = apply_update(current, sec["body"])
            changes.append((sec["path"], real, texts[real]))
        else:  # moved away: the source is gone, the destination's text is not computed
            changes.append((sec["path"], real, ""))
            changes.append((sec["move"], resolve(sec["move"], base), None))
    return changes


# --- shell commands --------------------------------------------------------

OUT_REDIRECTS = {">", ">>", ">|", "&>", "&>>", "<>", ">&", "&>|"}
IN_REDIRECTS = {"<", "<<", "<<<", "<&"}
OP_CHARS = set("|&;()<>")
HEREDOC = re.compile(r"<<-?[ \t]*(['\"]?)([A-Za-z_][\w.-]*)\1")
WRITE_ALL = {"rm", "unlink", "touch", "truncate", "chmod", "chown", "chgrp", "tee", "shred",
             "ed", "ex", "vi", "vim", "nvim", "nano", "emacs"}
WRITE_DEST = {"cp", "ln", "install", "rsync", "scp"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "fish"}
INTERPRETERS = re.compile(r"^(?:python[\d.]*|node|nodejs|ruby|deno|bun|php|lua|osascript|pwsh)$")
INLINE_FLAGS = {"-c", "-e", "-p", "--eval", "--print", "-r", "eval"}
GIT_WRITE = {"checkout", "restore", "mv", "rm", "apply", "stash", "reset", "am", "cherry-pick",
             "merge", "rebase", "pull", "switch", "revert", "clean"}
WRAPPERS = {"sudo", "doas", "env", "command", "builtin", "exec", "nohup", "nice", "time",
            "timeout", "stdbuf", "caffeinate", "xargs", "watch", "npx", "pnpx", "bunx"}
WRAPPER_ARG_FLAGS = {"-u", "-g", "-C", "-n", "-I", "-P", "-L", "-d", "-s", "-E", "-k", "--signal"}
KEYWORDS = {"if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "case",
            "esac", "!", "{", "}", "function", "select"}


def split_heredocs(command):
    kept, bodies, lines, i = [], [], command.split("\n"), 0
    while i < len(lines):
        line = lines[i]
        kept.append(line)
        i += 1
        for m in HEREDOC.finditer(line):
            body = []
            while i < len(lines) and lines[i].strip() != m.group(2):
                body.append(lines[i])
                i += 1
            i += 1
            bodies.append("\n".join(body))
    return "\n".join(kept), bodies


def tokenize(s):
    """Shell-ish tokens: ("op", text) for unquoted operators, ("word", text) with
    quotes removed. Raises ValueError on unbalanced quotes."""
    toks, word, i, n = [], None, 0, len(s)

    def flush():
        nonlocal word
        if word is not None:
            toks.append(("word", "".join(word)))
            word = None

    while i < n:
        c = s[i]
        if c in " \t\r":
            flush(); i += 1
        elif c == "\n":
            flush(); toks.append(("op", ";")); i += 1
        elif c == "\\":
            if i + 1 < n and s[i + 1] == "\n":
                i += 2
                continue
            word = word or []
            word.append(s[i + 1] if i + 1 < n else "")
            i += 2
        elif c == "'":
            j = s.find("'", i + 1)
            if j < 0:
                raise ValueError("unbalanced quote")
            word = word or []
            word.extend(s[i + 1:j])
            i = j + 1
        elif c == '"':
            j, buf = i + 1, []
            while j < n and s[j] != '"':
                if s[j] == "\\" and j + 1 < n and s[j + 1] in '"\\$`':
                    buf.append(s[j + 1]); j += 2
                    continue
                buf.append(s[j]); j += 1
            if j >= n:
                raise ValueError("unbalanced quote")
            word = word or []
            word.extend(buf)
            i = j + 1
        elif c == "`" or (c == "$" and s[i + 1:i + 2] == "("):
            flush()
            toks.append(("op", "("))
            i += 1 if c == "`" else 2
        elif c in OP_CHARS:
            if c in "<>" and word is not None and "".join(word).isdigit():
                word = None  # the fd number of `2>file`
            flush()
            j = i
            while j < n and s[j] in OP_CHARS:
                j += 1
            run = s[i:j]
            # split a run such as `>&` / `;;` / `)|` into a redirect or separators
            if run in OUT_REDIRECTS or run in IN_REDIRECTS:
                toks.append(("op", run))
            else:
                toks.extend(("op", ch) for ch in run)
            i = j
        elif c == "#" and word is None:
            j = s.find("\n", i)
            i = n if j < 0 else j
        else:
            word = word or []
            word.append(c)
            i += 1
    flush()
    return toks


def substitutions(word):
    """Command text inside $(...) or `...` that survived inside a quoted word."""
    found = re.findall(r"\$\(([^()]*)\)", word) + re.findall(r"`([^`]*)`", word)
    return [f for f in found if f.strip()]


def strip_wrappers(argv):
    opaque = False
    while argv:
        head = os.path.basename(argv[0])
        if head in KEYWORDS or re.match(r"^[A-Za-z_]\w*=", argv[0]):
            argv = argv[1:]
            continue
        if head in WRAPPERS:
            opaque = opaque or head == "xargs"
            argv = argv[1:]
            while argv and (argv[0].startswith("-") or re.match(r"^[A-Za-z_]\w*=", argv[0])):
                flag = argv[0]
                argv = argv[1:]
                if flag in WRAPPER_ARG_FLAGS and argv:
                    argv = argv[1:]
            if head == "timeout" and argv:
                argv = argv[1:]  # the duration
            continue
        break
    return argv, opaque


def classify(argv, base, depth, stdin_code=False):
    """(literal write targets, opaque) for one simple command. opaque means it may
    write files the guard cannot name (inline code, xargs, find -exec, $vars)."""
    argv, opaque = strip_wrappers(argv)
    if not argv:
        return [], opaque
    name = os.path.basename(argv[0])
    args = argv[1:]
    nonopt = [a for a in args if a and (not a.startswith("-") or a == "-")]
    targets = []

    def dest_and_sources():
        target_dir = None
        for k, a in enumerate(args):
            if a in ("-t", "--target-directory") and k + 1 < len(args):
                target_dir = args[k + 1]
            elif a.startswith("--target-directory="):
                target_dir = a.split("=", 1)[1]
        if target_dir:
            return target_dir, [a for a in nonopt if a != target_dir]
        if len(nonopt) >= 2:
            return nonopt[-1], nonopt[:-1]
        return None, []

    def into_dir(dest, sources):
        if dest and (dest.endswith("/") or os.path.isdir(resolve(dest, base))):
            return [os.path.join(dest, os.path.basename(src.rstrip("/"))) for src in sources]
        return []

    if name in WRITE_ALL:
        targets += nonopt
    elif name in WRITE_DEST:
        dest, sources = dest_and_sources()
        if dest:
            targets += [dest] + into_dir(dest, sources)
    elif name == "mv":
        dest, sources = dest_and_sources()
        targets += nonopt + into_dir(dest, sources)
    elif name == "dd":
        targets += [a[3:] for a in args if a.startswith("of=")]
    elif name in ("sed", "gsed"):
        if any(re.match(r"^-[a-zA-Z]*i", a) or a.startswith("--in-place") for a in args):
            targets += nonopt
    elif name == "perl":
        if any(re.match(r"^-[a-zA-Z]*i", a) for a in args):
            targets += nonopt
        elif any(re.match(r"^-[a-zA-Z]*[eE]$", a) for a in args) or (not nonopt and stdin_code):
            opaque = True
    elif name in ("awk", "gawk", "mawk", "nawk"):
        if "inplace" in args:
            targets += nonopt
        elif nonopt and re.search(r">|\bsystem\b|\|", nonopt[0]):
            opaque = True
    elif INTERPRETERS.match(name):
        if (not nonopt and stdin_code) or nonopt[:1] == ["-"] or any(a in INLINE_FLAGS for a in args):
            opaque = True
    elif name in SHELLS:
        if "-c" in args:
            k = args.index("-c")
            if k + 1 < len(args):
                sub_targets, sub_opaque = analyze_shell(args[k + 1], base, depth + 1)
                targets += sub_targets
                opaque = opaque or sub_opaque
        elif (not nonopt and stdin_code) or nonopt[:1] == ["-"]:
            opaque = True
    elif name == "git":
        k = 0
        while k < len(args) and args[k].startswith("-"):
            k += 2 if args[k] in ("-C", "-c") else 1
        if k < len(args) and args[k] in GIT_WRITE:
            targets += [a for a in args[k + 1:] if not a.startswith("-")]
    elif name == "find":
        if any(a in ("-delete", "-fprint", "-fprintf", "-fls") for a in args):
            opaque = True
        for k, a in enumerate(args):
            if a in ("-exec", "-execdir", "-ok", "-okdir"):
                sub = []
                for b in args[k + 1:]:
                    if b in (";", "+"):
                        break
                    sub.append(b)
                sub_targets, sub_opaque = classify(sub, base, depth + 1)
                opaque = opaque or sub_opaque or bool(sub_targets)
    elif name == "patch":
        targets += nonopt
        opaque = True
    if any(a in ("--write", "--fix", "-write") or a.startswith("--write=") for a in args):
        targets += nonopt
    return targets, opaque


def analyze_shell(command, base, depth=0):
    """(literal write targets resolved to real paths, opaque) for a shell command."""
    if depth > 4:
        return [], True
    text, bodies = split_heredocs(command)
    toks = tokenize(text)
    targets, opaque = [], False
    segment, redirect_next, skip_next = [], None, False

    def finish(seg):
        nonlocal opaque, base
        if not seg:
            return
        if os.path.basename(seg[0]) == "cd" and len(seg) == 2 and not re.search(r"[$`*?]", seg[1]):
            base = resolve(seg[1], base)
            return
        found, opq = classify(seg, base, depth, stdin_code=bool(bodies))
        opaque = opaque or opq
        targets.extend((t, base) for t in found)

    for kind, value in toks:
        if kind == "op":
            if value in OUT_REDIRECTS:
                redirect_next = value
                continue
            if value in IN_REDIRECTS:
                skip_next = True
                continue
            redirect_next, skip_next = None, False  # `>(` process substitution is not a file
            finish(segment)
            segment = []
            continue
        for inner in substitutions(value):
            sub_targets, sub_opaque = analyze_shell(inner, base, depth + 1)
            targets.extend((t, base) for t in sub_targets)
            opaque = opaque or sub_opaque
        if redirect_next:
            dup = redirect_next in (">&", "<&") and re.match(r"^(\d+|-)$", value)
            if not dup and value not in ("/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"):
                targets.append((value, base))
            redirect_next = None
            continue
        if skip_next:
            skip_next = False
            continue
        segment.append(value)
    finish(segment)

    reals = []
    for raw, where in targets:
        if isinstance(raw, tuple):  # already resolved by a nested bash -c / $(...)
            reals.append(raw)
            continue
        if not raw:
            continue
        if "$" in raw or "`" in raw:
            opaque = True
            continue
        if re.search(r"[*?\[]", raw):
            head, tail = os.path.split(raw)
            reals += [(raw, resolve(os.path.join(head, g), where)) for g in sorted(GUARDED)
                      if fnmatch.fnmatchcase(g, tail)]
            continue
        reals.append((raw, resolve(raw, where)))
    return reals, opaque


def shell_targets(command, base):
    """Guarded files a shell command may write (resulting text never known)."""
    try:
        found, opaque = analyze_shell(command, base)
    except Exception:  # unbalanced quotes or a parser bug: fall back to the coarse check
        if not WRITE.search(command):
            return []
        return [(m, resolve(m, base), None) for m in MENTION.findall(command)]
    changes = [(raw, real, None) for raw, real in found]
    if opaque:
        changes += [(m, resolve(m, base), None) for m in MENTION.findall(command)]
    return changes


# --- decision --------------------------------------------------------------

def file_changes(tool, tool_input, base):
    """[(candidate, real, resulting text or None)] for file-tool calls."""
    command = tool_input.get("command")
    if isinstance(command, str) and (tool == "apply_patch" or command.lstrip().startswith("*** Begin Patch")):
        return patch_changes(command, base)
    patch_input = tool_input.get("input")
    if isinstance(patch_input, str):
        # omp edit, apply_patch or hashline mode. Hashline also arrives wrapped in
        # `*** Begin Patch` with `[PATH#HASH]` headers, so collect targets from every
        # source; only Codex-style file headers let the result be computed.
        changes = patch_changes(patch_input, base) if re.search(
            r"^\*\*\* (?:Add|Update|Delete) File: ", patch_input, re.M) else []
        known = {real for _, real, _ in changes}
        paths = HASHLINE_HEADER.findall(patch_input)
        paths += [tool_input[k] for k in ("path", "file_path") if isinstance(tool_input.get(k), str)]
        if isinstance(tool_input.get("paths"), list):
            paths += [p for p in tool_input["paths"] if isinstance(p, str)]
        for p in paths:
            real = resolve(p, base)
            if real not in known:
                known.add(real)
                changes.append((p, real, None))
        return changes

    paths = [tool_input[k] for k in ("file_path", "path", "notebook_path") if isinstance(tool_input.get(k), str)]
    if isinstance(tool_input.get("paths"), list):
        paths += [p for p in tool_input["paths"] if isinstance(p, str)]
    if isinstance(tool_input.get("edits"), list):  # omp patch mode renames
        paths += [e["rename"] for e in tool_input["edits"] if isinstance(e, dict) and isinstance(e.get("rename"), str)]
    changes = [(p, resolve(p, base), None) for p in paths]
    if len(changes) != 1 or tool.lower() == "notebookedit":
        return changes
    cand, real, _ = changes[0]
    after = None
    if isinstance(tool_input.get("content"), str):
        after = tool_input["content"]
    elif "old_string" in tool_input:
        after = replace_once(read_text(real), tool_input.get("old_string"), tool_input.get("new_string"),
                             bool(tool_input.get("replace_all")))
    elif isinstance(tool_input.get("edits"), list) and all(
            isinstance(e, dict) and "old_string" in e for e in tool_input["edits"]):
        after = read_text(real)
        for e in tool_input["edits"]:
            after = replace_once(after, e.get("old_string"), e.get("new_string"), bool(e.get("replace_all")))
    return [(cand, real, after)]


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

    command = tool_input.get("command")
    is_patch = isinstance(command, str) and (tool == "apply_patch" or command.lstrip().startswith("*** Begin Patch"))
    via_shell = isinstance(command, str) and not is_patch and tool.lower() in ("bash", "shell", "exec_command")
    changes = shell_targets(command, base) if via_shell else file_changes(tool, tool_input, base)

    problems, seen = [], set()
    for _, real, after in changes:
        if not guarded(real) or (real, after) in seen:
            continue
        seen.add((real, after))
        before = read_text(real)
        problem = limit_violation(real, before, after) if after is not None else current_violation(real, before)
        if problem:
            problems.append(problem)
    return deny(problems) if problems else 0


def deny(problems):
    reason = "instruction-guard: size limit: " + "; ".join(problems) + ". " + SLIM_HINT
    if PLATFORM == "claude":
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}))
        return 0
    sys.stderr.write(reason + "\n")
    return 2


# --- check -----------------------------------------------------------------

def check(paths):
    """Report size-limit violations in the given files or every AGENTS.md / CLAUDE.md below cwd."""
    files = []
    for target in paths or ["."]:
        if os.path.isdir(target):
            for root, dirs, names in os.walk(target):
                dirs[:] = [d for d in dirs if d not in (".git", "node_modules")]
                files += [os.path.join(root, n) for n in names if n in GUARDED]
        else:
            files.append(target)
    bad = 0
    for path in sorted(files):
        text = read_text(os.path.realpath(path))
        if text is None:
            continue
        _, _, problems = size_problems(text)
        for problem in problems:
            print(f"{path}: {problem}")
        bad += bool(problems)
    print(f"instruction-guard check: {len(files)} file(s), {bad} over the limits "
          f"({MAX_BYTES} bytes per file, {MAX_LINE} bytes per line)")
    return 1 if bad else 0


def main():
    if MODE == "check":
        return check(sys.argv[1:])
    try:
        return guard()
    except Exception as exc:  # fail closed whenever the call names an instruction file
        if MENTION.search(os.environ.get("IG_INPUT") or ""):
            return deny([f"the call could not be checked ({type(exc).__name__})"])
        return 0


sys.exit(main())
PY

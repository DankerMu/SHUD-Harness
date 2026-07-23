#!/usr/bin/env python3
"""evidence_check.py - mechanical evidence-hygiene linter for the subagent workflow.

The orchestrator runs this before spawning any comprehensive cross-review
round (initial or Phase 6.5 rerun) and again on the drafted PR body/evidence
files before posting at Phase 8. It lints the orchestrator's own bookkeeping -
the artifacts reviewers and the merge gate consume - so stale-evidence
findings stop burning comprehensive review rounds. A review round is the most
expensive linter there is; this closes the classes a script can catch and
leaves reviewers only what machines cannot judge.

Checks:
  placeholder   unreplaced template tokens (`<sha>`, `<fix summary>`, ...) and
                TODO/TBD/FIXME markers. Runs only on orchestrator-authored
                files passed via --file (PR body draft, evidence manifest,
                comment drafts); reviewer-authored reports may legitimately
                quote code or discuss TODOs and are exempt by design.
  head-sha      lines labeling a SHA as the current/frozen head must
                prefix-match the actual HEAD of --root (`git rev-parse HEAD`,
                or --head). Historical anchors such as `Last clean reviewed
                SHA` are not current-head claims and are not checked.
  round-status  "Round K pending/in progress/..." claims are stale once
                .review-gate.json has recorded round K. Skipped with a note
                when no state file exists.

Scanned files: every --file target (all checks) plus *.md/*.txt/*.log under
the review dir from .review-gate.json or --evidence-dir (head-sha and
round-status only).

Exit codes: 0 = clean, 2 = findings or nothing checkable (attention required).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import review_gate

TEXT_SUFFIXES = {".md", ".txt", ".log"}
PLACEHOLDER_RE = re.compile(r"(?<![0-9A-Za-z_])<[A-Za-z][^<>\n]{0,40}>")
MARKER_RE = re.compile(r"\b(TODO|TBD|FIXME)\b")
HEAD_CLAIM_RE = re.compile(
    r"(?i)(?:\bcurrent\s+head\b(?:\s+sha)?|\bfrozen\b[^\n]{0,12}?\bsha\b|\bfull_sha\b|冻结[^\n]{0,8}?SHA)"
    r"[^0-9a-f\n]{0,20}\b([0-9a-f]{7,40})\b"
)
ROUND_CLAIM_RE = re.compile(
    r"(?i)\bround\s*#?\s*(\d+)\b[^\n]{0,40}?"
    r"(?:\bpending\b|\bin[- ]progress\b|\bnot\s+yet\b|待复审|待审|待跑|进行中|未完成)"
)


def resolve_head(root: Path, head: str | None) -> str | None:
    if head:
        return head.lower()
    proc = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout.strip().lower()


def load_state(root: Path) -> dict | None:
    path = root / review_gate.STATE_NAME
    if not path.is_file():
        return None
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def is_placeholder(token: str) -> bool:
    inner = token[1:-1]
    if "://" in inner or "@" in inner or inner.lower().startswith("http"):
        return False  # autolinks and mail addresses, not template tokens
    return True


def rel(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def scan_file(path: Path, root: Path, head: str, last_round: int | None,
              authored: bool, findings: list[str]) -> None:
    text = path.read_text(encoding="utf-8", errors="replace")
    name = rel(path, root)
    for lineno, line in enumerate(text.splitlines(), 1):
        if authored:
            for m in PLACEHOLDER_RE.finditer(line):
                if is_placeholder(m.group(0)):
                    findings.append(f"{name}:{lineno}: [placeholder] unreplaced template token {m.group(0)}")
            for m in MARKER_RE.finditer(line):
                findings.append(f"{name}:{lineno}: [placeholder] unfinished-work marker {m.group(1)}")
        for m in HEAD_CLAIM_RE.finditer(line):
            claim = m.group(1).lower()
            if not head.startswith(claim):
                findings.append(
                    f"{name}:{lineno}: [head-sha] current/frozen head claim {claim} "
                    f"does not match actual HEAD {head[:12]}"
                )
        if last_round is not None:
            for m in ROUND_CLAIM_RE.finditer(line):
                claimed = int(m.group(1))
                if claimed <= last_round:
                    findings.append(
                        f"{name}:{lineno}: [round-status] round {claimed} claimed pending "
                        f"but the ledger already recorded round {last_round}"
                    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd(),
                        help="project root holding %s (default: CLAUDE_PROJECT_DIR or cwd)" % review_gate.STATE_NAME)
    parser.add_argument("--head", default=None,
                        help="expected HEAD SHA (default: git rev-parse HEAD in --root)")
    parser.add_argument("--file", dest="files", action="append", default=[],
                        help="orchestrator-authored artifact (PR body draft, manifest); repeatable, gets all checks")
    parser.add_argument("--evidence-dir", default=None,
                        help="override the review dir from %s" % review_gate.STATE_NAME)
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    head = resolve_head(root, args.head)
    if head is None:
        print(f"evidence_check: cannot resolve HEAD in {root} - not a git repo? pass --head", file=sys.stderr)
        return 2

    state = load_state(root)
    rounds = (state or {}).get("rounds", [])
    last_round = max((rd["n"] for rd in rounds), default=None) if rounds else None
    if last_round is None:
        print("evidence_check: no recorded rounds - round-status check skipped")

    findings: list[str] = []
    authored: list[Path] = []
    for raw in args.files:
        path = Path(raw)
        if not path.is_file():
            findings.append(f"{raw}:0: [input] --file target missing")
        else:
            authored.append(path.resolve())

    evidence_files: list[Path] = []
    ev_dir = args.evidence_dir or (state or {}).get("reviewDir")
    if ev_dir:
        ev_path = (root / ev_dir).resolve()
        if ev_path.is_dir():
            evidence_files = sorted(
                p.resolve() for p in ev_path.rglob("*")
                if p.is_file() and p.suffix in TEXT_SUFFIXES
            )
        else:
            print(f"evidence_check: review dir not present yet ({ev_path}) - skipped")

    authored_set = set(authored)
    scanned = authored + [p for p in evidence_files if p not in authored_set]
    if not scanned:
        print("evidence_check: nothing to check - pass --file and/or ensure the review dir exists", file=sys.stderr)
        return 2

    for path in scanned:
        scan_file(path, root, head, last_round, path in authored_set, findings)

    for line in findings:
        print(line)
    if findings:
        print(f"evidence_check: {len(findings)} finding(s) - fix the bookkeeping before spawning reviewers or posting",
              file=sys.stderr)
        return 2
    print(f"evidence_check: clean ({len(scanned)} file(s), head {head[:12]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

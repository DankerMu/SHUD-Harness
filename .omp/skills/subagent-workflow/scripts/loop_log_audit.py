#!/usr/bin/env python3
"""loop_log_audit.py - keep/cut decidability audit over the review-loop accountability log.

The log (docs/review-loop-log.jsonl) exists to be consumed, not only appended:
field data showed both consuming repos collecting keep/cut samples well past
the decision threshold with no recorded ADR. This script makes "a decision is
now owed" a mechanical fact instead of a prose expectation. The orchestrator
runs it after appending each line (Phase 8); exit 2 means at least one
DECIDABLE item exists - record the keep/cut or rotation ADR in docs/adr/ (or
a one-line recorded deferral with reason) before starting the next issue.

Reported:
  DECIDABLE keep-cut     a canonical fixture level has >= --min-sample merged
                         PRs with zero total gate_net_catch: the review loop
                         never caught anything there - decide keep/narrow/cut.
  DECIDABLE lens-rotation >= --min-multiround merged multi-round PRs carry
                         round_lenses/catches attribution: decide whether
                         free-slot rotation earns its keep (catches from
                         rotated-in lenses) or reverts to the round-1 mix.
  NOTE off-vocabulary    fixture labels outside none|compact|expanded|high|
                         broad-expanded fragment the keep/cut sample (they are
                         excluded from the buckets above).
  NOTE terminal outcomes ceiling-split/abandoned/descoped lines - each one
                         obligates an upstream sizing-retro when the issue
                         came from stage-change-pipeline.

Deterministic, stdlib-only. Exit codes: 0 = nothing decidable,
2 = decidable item(s) or unreadable input (attention required).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

FIXTURE_LEVELS = ("none", "compact", "expanded", "high", "broad-expanded")
TERMINAL_OUTCOMES = ("ceiling-split", "abandoned", "descoped")


def parse_log(path: Path) -> list[dict] | None:
    if not path.is_file():
        print(f"loop_log_audit: log not found: {path}", file=sys.stderr)
        return None
    entries = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as exc:
            print(f"loop_log_audit: {path}:{lineno}: invalid JSON ({exc.msg}) - "
                  "fix the log before auditing", file=sys.stderr)
            return None
        if not isinstance(entry, dict):
            print(f"loop_log_audit: {path}:{lineno}: line is not a JSON object", file=sys.stderr)
            return None
        entries.append(entry)
    return entries


def rotation_attribution(entry: dict) -> tuple[int, int]:
    """Catches in rounds >= 2 attributed to (pinned core, rotated-in) lenses."""
    lenses = entry.get("round_lenses") or []
    core_lenses = set(lenses[0]) if lenses else set()
    core = rotated = 0
    for catch in entry.get("catches") or []:
        if catch.get("round", 1) < 2:
            continue
        if catch.get("lens") in core_lenses:
            core += 1
        else:
            rotated += 1
    return core, rotated


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--log", required=True, help="path to review-loop-log.jsonl")
    parser.add_argument("--min-sample", type=int, default=8,
                        help="merged-PR sample per fixture level before keep/cut is decidable (default 8)")
    parser.add_argument("--min-multiround", type=int, default=8,
                        help="merged multi-round PRs with lens attribution before rotation is decidable (default 8)")
    args = parser.parse_args(argv)

    entries = parse_log(Path(args.log))
    if entries is None:
        return 2

    merged = [e for e in entries if e.get("outcome", "merged") == "merged"]
    terminal = [e for e in entries if e.get("outcome", "merged") in TERMINAL_OUTCOMES]
    print(f"loop_log_audit: {len(entries)} line(s) - {len(merged)} merged, {len(terminal)} terminal")

    decidable = 0

    off_vocab: dict[str, int] = {}
    by_level: dict[str, list[dict]] = {}
    for e in merged:
        fixture = e.get("fixture", "<missing>")
        if fixture in FIXTURE_LEVELS:
            by_level.setdefault(fixture, []).append(e)
        else:
            off_vocab[fixture] = off_vocab.get(fixture, 0) + 1

    for level in FIXTURE_LEVELS:
        sample = by_level.get(level, [])
        if not sample:
            continue
        total_catch = sum(e.get("gate_net_catch", 0) for e in sample)
        line = f"fixture {level}: {len(sample)} merged PR(s), total gate_net_catch {total_catch}"
        if len(sample) >= args.min_sample and total_catch == 0:
            decidable += 1
            print(f"DECIDABLE keep-cut: {line} - the loop never caught anything at this level; "
                  "record a keep/narrow/cut ADR (docs/adr/) or a one-line recorded deferral")
        else:
            print(line)

    if off_vocab:
        labels = ", ".join(f"{k}({v})" for k, v in sorted(off_vocab.items()))
        print(f"NOTE off-vocabulary fixture labels excluded from keep/cut buckets: {labels} - "
              "future lines are rejected by evidence_check --loop-log-entry")

    multiround = [e for e in merged if e.get("rounds", 0) >= 2 and e.get("round_lenses")]
    if multiround:
        core = rotated = 0
        for e in multiround:
            c, r = rotation_attribution(e)
            core += c
            rotated += r
        line = (f"rotation attribution: {len(multiround)} multi-round merged PR(s), "
                f"later-round catches core={core} rotated={rotated}")
        if len(multiround) >= args.min_multiround:
            decidable += 1
            print(f"DECIDABLE lens-rotation: {line} - decide keep (catches concentrate in rotated-in "
                  "lenses) or revert to the round-1 mix, and record it in docs/adr/")
        else:
            print(line)

    if terminal:
        outcomes = {}
        for e in terminal:
            outcomes[e["outcome"]] = outcomes.get(e["outcome"], 0) + 1
        summary = ", ".join(f"{k}={v}" for k, v in sorted(outcomes.items()))
        print(f"NOTE terminal outcomes: {summary} - each obligates an upstream sizing-retro "
              "(stage-change-pipeline) when the issue came from that pipeline")

    if decidable:
        print(f"loop_log_audit: {decidable} DECIDABLE item(s) - record the ADR or a recorded deferral "
              "before starting the next issue", file=sys.stderr)
        return 2
    print("loop_log_audit: nothing decidable yet")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Check rendered AGENTS.md against constraints.yaml; CLAUDE.md has no budget.

Usage: check-line-budget.py [--root DIR]
The owned config uses a block thresholds mapping and an unquoted decimal budget.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def configured_limit(root: Path) -> int:
    text = (root / "constraints.yaml").read_text(encoding="utf-8")
    headers = re.findall(r"(?m)^thresholds\b[^\n]*", text)
    blocks = re.findall(r"(?ms)^thresholds:[ \t]*(?:#[^\n]*)?\n(.*?)(?=^\S|\Z)", text)
    if len(headers) != 1 or len(blocks) != 1:
        raise ValueError("expected exactly one thresholds block")
    entries = re.findall(r"(?m)^  agents_md_max_lines\b([^\n]*)", blocks[0])
    if len(entries) != 1:
        raise ValueError("expected exactly one thresholds.agents_md_max_lines entry")
    value = re.fullmatch(r":[ \t]*([1-9][0-9]*)(?:[ \t]+#[^\n]*)?[ \t]*", entries[0])
    if value is None:
        raise ValueError("thresholds.agents_md_max_lines must be a positive decimal integer")
    return int(value.group(1))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    root = parser.parse_args().root.resolve()
    try:
        limit = configured_limit(root)
    except (OSError, UnicodeError, ValueError) as error:
        print(f"instructions:check: invalid budget configuration in {root / 'constraints.yaml'}: {error}", file=sys.stderr)
        return 2
    try:
        content = (root / "AGENTS.md").read_bytes()
    except OSError as error:
        print(f"instructions:check: cannot read {root / 'AGENTS.md'}: {error}", file=sys.stderr)
        return 2
    lines = content.count(b"\n") + int(bool(content) and not content.endswith(b"\n"))
    if lines > limit:
        print(
            f"instructions:check: AGENTS.md has {lines} lines, exceeding configured limit {limit} "
            "(constraints.yaml thresholds.agents_md_max_lines)", file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

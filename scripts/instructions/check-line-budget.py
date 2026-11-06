#!/usr/bin/env python3
"""Check rendered AGENTS.md line and byte budgets against constraints.yaml; CLAUDE.md has no budget.

Usage: check-line-budget.py [--root DIR]
The owned config uses a block thresholds mapping and an unquoted decimal budget.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def configured_limits(root: Path) -> dict[str, int]:
    text = (root / "constraints.yaml").read_text(encoding="utf-8")
    headers = re.findall(r"(?m)^thresholds\b[^\n]*", text)
    blocks = re.findall(r"(?ms)^thresholds:[ \t]*(?:#[^\n]*)?\n(.*?)(?=^\S|\Z)", text)
    if len(headers) != 1 or len(blocks) != 1:
        raise ValueError("expected exactly one thresholds block")
    limits: dict[str, int] = {}
    for key in ("agents_md_max_lines", "agents_md_max_bytes"):
        entries = re.findall(rf"(?m)^  {key}\b([^\n]*)", blocks[0])
        if len(entries) != 1:
            raise ValueError(f"expected exactly one thresholds.{key} entry")
        value = re.fullmatch(r":[ \t]*([1-9][0-9]*)(?:[ \t]+#[^\n]*)?[ \t]*", entries[0])
        if value is None:
            raise ValueError(f"thresholds.{key} must be a positive decimal integer")
        limits[key] = int(value.group(1))
    return limits


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    root = parser.parse_args().root.resolve()
    try:
        limits = configured_limits(root)
    except (OSError, UnicodeError, ValueError) as error:
        print(f"instructions:check: invalid budget configuration in {root / 'constraints.yaml'}: {error}", file=sys.stderr)
        return 2
    try:
        content = (root / "AGENTS.md").read_bytes()
    except OSError as error:
        print(f"instructions:check: cannot read {root / 'AGENTS.md'}: {error}", file=sys.stderr)
        return 2
    lines = content.count(b"\n") + int(bool(content) and not content.endswith(b"\n"))
    status = 0
    for key, unit, measured in (("agents_md_max_lines", "lines", lines), ("agents_md_max_bytes", "bytes", len(content))):
        if measured > limits[key]:
            print(
                f"instructions:check: AGENTS.md has {measured} {unit}, exceeding configured limit {limits[key]} "
                f"(constraints.yaml thresholds.{key})", file=sys.stderr,
            )
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())

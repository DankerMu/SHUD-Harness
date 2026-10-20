#!/usr/bin/env python3
"""Decision-record verifier (docs/adr four-zone lifecycle). Fails on:
duplicate ids, a record outside the four zones, a kind outside the allowed set, a status that does
not match its zone, missing frontmatter fields, an archived record whose sha256 differs from
manifest.yaml, or a manifest entry without a file. Usage: verify.py [--root DIR]
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

ZONES = {
    "proposed": {"proposed"},
    "implemented": {"accepted"},
    "rejected": {"rejected"},
    "archived": {"archived", "superseded", "deprecated"},
}
KINDS = {"architecture", "process", "testing", "bug-fix", "feature", "simplification"}
NAME = re.compile(r"^(\d{4})-[a-z0-9][a-z0-9-]*\.md$")


def frontmatter(text: str) -> dict[str, str]:
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return {}
    out: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip().strip('"')
    return out


def load_manifest(path: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    if not path.exists():
        return entries
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\s+([^#\s][^:]*):\s*([0-9a-f]{64})\s*$", line)
        if m:
            entries[m.group(1).strip()] = m.group(2)
    return entries


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=Path.cwd())
    args = ap.parse_args()
    root = args.root.resolve()
    adr = root / "docs" / "adr"
    errors: list[str] = []
    ids: dict[str, str] = {}
    if not adr.is_dir():
        print(f"adr:check: {adr} missing", file=sys.stderr)
        return 2
    for p in sorted(adr.rglob("*.md")):
        rel = p.relative_to(root).as_posix()
        if p.parent == adr:
            if p.name == "README.md":
                continue
            errors.append(f"{rel}: record outside the four zones (move to docs/adr/proposed/)")
            continue
        zone = p.relative_to(adr).parts[0]
        if zone not in ZONES or len(p.relative_to(adr).parts) != 2:
            errors.append(f"{rel}: unknown zone or nested path")
            continue
        m = NAME.match(p.name)
        if not m:
            errors.append(f"{rel}: file name must be NNNN-slug.md")
            continue
        if m.group(1) in ids:
            errors.append(f"{rel}: duplicate id {m.group(1)} (also {ids[m.group(1)]})")
        ids[m.group(1)] = rel
        fm = frontmatter(p.read_text(encoding="utf-8"))
        for field in ("status", "kind"):
            if field not in fm:
                errors.append(f"{rel}: frontmatter missing `{field}`")
        if fm.get("kind") and fm["kind"] not in KINDS:
            errors.append(f"{rel}: kind `{fm['kind']}` not in {sorted(KINDS)}")
        if fm.get("status") and fm["status"] not in ZONES[zone]:
            errors.append(f"{rel}: status `{fm['status']}` not allowed in zone {zone} ({sorted(ZONES[zone])})")
    manifest = load_manifest(adr / "manifest.yaml")
    for p in sorted((adr / "archived").glob("*.md")) if (adr / "archived").is_dir() else []:
        rel = p.relative_to(root).as_posix()
        digest = hashlib.sha256(p.read_bytes()).hexdigest()
        if rel not in manifest:
            errors.append(f"{rel}: archived record missing from manifest.yaml")
        elif manifest[rel] != digest:
            errors.append(f"{rel}: archived record was edited (sha256 differs from manifest.yaml) — archives are frozen")
    for rel in manifest:
        if not (root / rel).exists():
            errors.append(f"manifest.yaml: entry {rel} has no file")
    if errors:
        print("\n".join(f"adr:check: {e}" for e in errors), file=sys.stderr)
        return 1
    print(f"adr:check: OK ({len(ids)} records, {len(manifest)} archived)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

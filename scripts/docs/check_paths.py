#!/usr/bin/env python3
"""Doc gate: every backticked repo path claimed in the control-plane docs must exist.

Scanned files are listed in constraints.yaml `doc_gate.path_claim_files`. A token counts as a
path claim when it is backticked and looks like a repo path (contains '/' or starts with '.',
or ends with a known file extension). Skipped: URLs, globs, placeholders (<...>, {...}),
paths that leave the repo (../), and tokens with spaces.
Usage: check_paths.py [--root DIR] [FILE ...]   (explicit FILEs override the constraints list)
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

TOKEN = re.compile(r"`([^`\n]+)`")
EXTS = (".md", ".ts", ".mjs", ".json", ".yml", ".yaml", ".sh", ".py", ".toml", ".txt")


def claim_files(root: Path) -> list[str]:
    text = (root / "constraints.yaml").read_text(encoding="utf-8")
    block = re.search(r"(?ms)^doc_gate:\n(.*?)(?=^\S|\Z)", text)
    if not block:
        return []
    sub = re.search(r"(?ms)^  path_claim_files:\n(.*?)(?=^  \S|\Z)", block.group(1))
    return re.findall(r'^\s+- *"([^"]+)"', sub.group(1), re.M) if sub else []


ROOT_FILES = {
    "AGENTS.md", "CLAUDE.md", "CONTEXT.md", "constraints.yaml", "package.json", "pnpm-workspace.yaml",
    "pnpm-lock.yaml", "tsconfig.base.json", "tsconfig.eslint.json", "vitest.config.ts", "eslint.config.mjs",
    "knip.json", "commitlint.config.mjs", "README.md",
}


def is_path_claim(tok: str, root: Path) -> bool:
    if any(ch.isspace() for ch in tok) or len(tok) > 200:
        return False
    if any(c in tok for c in "<>{}*$|=:#@"):
        return False
    if tok.startswith(("http://", "https://", "../", "~", "/")):
        return False
    if "/" in tok:
        # rooted claim: first segment must be a directory that exists at the repo root
        first = tok.split("/", 1)[0]
        return bool(first) and (root / first).is_dir()
    if tok in ROOT_FILES:
        return True
    # dotfiles at the root (.editorconfig, .prettierrc.json) but not bare extensions (.ts)
    return tok.startswith(".") and not tok.startswith("..") and not re.fullmatch(r"\.[a-z0-9]+", tok)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=Path.cwd())
    ap.add_argument("files", nargs="*")
    args = ap.parse_args()
    root = args.root.resolve()
    files = args.files or claim_files(root)
    if not files:
        print("check_paths: no files to scan (doc_gate.path_claim_files empty)", file=sys.stderr)
        return 2
    failures = 0
    for rel in files:
        path = Path(rel) if Path(rel).is_absolute() else root / rel
        if not path.exists():
            print(f"check_paths: scanned file missing: {rel}", file=sys.stderr)
            failures += 1
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for tok in TOKEN.findall(line):
                tok = tok.rstrip(".,;:")
                if not is_path_claim(tok, root):
                    continue
                if not (root / tok.rstrip("/")).exists():
                    print(f"{rel}:{lineno}: path claim `{tok}` does not exist", file=sys.stderr)
                    failures += 1
    if failures:
        print(f"check_paths: {failures} broken path claim(s)", file=sys.stderr)
        return 1
    print(f"check_paths: OK ({len(files)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

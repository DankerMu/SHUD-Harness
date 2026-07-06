#!/usr/bin/env python3
"""Check docs-internal relative Markdown links."""

from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlsplit


FENCE_MARKER_RE = re.compile(r"^\s*(?P<marker>`{3,}|~{3,})")
HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$")
REFERENCE_LINK_RE = re.compile(r"^\s{0,3}\[[^\]]+\]:[ \t]*(?P<target><[^>\n]*>|\S+)")
HTML_ANCHOR_RE = re.compile(r"<a\s+[^>]*(?:id|name)=[\"']([^\"']+)[\"'][^>]*>", re.IGNORECASE)
INLINE_HTML_ID_RE = re.compile(r"\sid=[\"']([^\"']+)[\"']", re.IGNORECASE)
EXPLICIT_HEADING_ID_RE = re.compile(r"\s+\{#([^}]+)\}\s*$")
URL_SCHEMES_TO_IGNORE = {
    "data",
    "ftp",
    "ftps",
    "http",
    "https",
    "irc",
    "ircs",
    "mailto",
    "news",
    "tel",
    "urn",
}


@dataclass(frozen=True)
class Link:
    source: Path
    line: int
    column: int
    target: str


@dataclass(frozen=True)
class BrokenLink:
    link: Link
    reason: str


@dataclass(frozen=True)
class FenceState:
    marker_char: str
    marker_length: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=None,
        help="repository root; defaults to two directories above this script",
    )
    parser.add_argument(
        "--docs-root",
        type=Path,
        default=None,
        help="docs tree to scan; defaults to <repo-root>/docs",
    )
    parser.add_argument(
        "--no-anchor-check",
        action="store_true",
        help="check target files only, ignoring URL fragments",
    )
    return parser.parse_args()


def default_repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def normalize_root(path: Path) -> Path:
    return path.expanduser().resolve()


def relative_to_or_none(path: Path, root: Path) -> Path | None:
    try:
        return path.relative_to(root)
    except ValueError:
        return None


def iter_markdown_files(docs_root: Path) -> tuple[Path, ...]:
    return tuple(sorted(path for path in docs_root.rglob("*.md") if path.is_file()))


def strip_optional_angle_brackets(target: str) -> str:
    if target.startswith("<") and target.endswith(">"):
        return target[1:-1]
    return target


def is_ignored_url(target: str) -> bool:
    if target.startswith("//"):
        return True
    parsed = urlsplit(target)
    return parsed.scheme.lower() in URL_SCHEMES_TO_IGNORE


def is_docs_internal_target(source: Path, docs_root: Path, target_path: str) -> tuple[bool, Path | None]:
    if not target_path:
        return True, source
    if not target_path.lower().endswith(".md"):
        return False, None

    candidate = (source.parent / unquote(target_path)).resolve(strict=False)
    if relative_to_or_none(candidate, docs_root) is None:
        return False, None
    return True, candidate


def update_fence_state(line: str, fence: FenceState | None) -> tuple[FenceState | None, bool]:
    marker_match = FENCE_MARKER_RE.match(line)
    if not marker_match:
        return fence, False

    marker = marker_match.group("marker")
    marker_char = marker[0]
    marker_length = len(marker)

    if fence is None:
        return FenceState(marker_char=marker_char, marker_length=marker_length), True

    if marker_char == fence.marker_char and marker_length >= fence.marker_length:
        return None, True

    return fence, True


def iter_line_links(source: Path, text: str) -> tuple[Link, ...]:
    links: list[Link] = []
    fence: FenceState | None = None
    for line_number, line in enumerate(text.splitlines(), start=1):
        fence, found_fence_marker = update_fence_state(line, fence)
        if found_fence_marker:
            continue
        if fence is not None:
            continue

        reference_match = REFERENCE_LINK_RE.match(line)
        if reference_match:
            links.append(
                Link(
                    source=source,
                    line=line_number,
                    column=reference_match.start("target") + 1,
                    target=strip_optional_angle_brackets(reference_match.group("target")),
                )
            )

        links.extend(parse_inline_links(source, line_number, line))
    return tuple(links)


def parse_inline_links(source: Path, line_number: int, line: str) -> tuple[Link, ...]:
    links: list[Link] = []
    cursor = 0
    while cursor < len(line):
        close_bracket = line.find("](", cursor)
        if close_bracket == -1:
            break

        open_bracket = line.rfind("[", 0, close_bracket)
        if open_bracket == -1:
            cursor = close_bracket + 2
            continue
        if open_bracket > 0 and line[open_bracket - 1] == "!":
            cursor = close_bracket + 2
            continue

        target_start = close_bracket + 2
        target_end = find_closing_paren(line, target_start)
        if target_end is None:
            cursor = target_start
            continue

        raw_target = line[target_start:target_end].strip()
        target = first_markdown_link_token(raw_target)
        if target:
            links.append(
                Link(
                    source=source,
                    line=line_number,
                    column=target_start + 1,
                    target=strip_optional_angle_brackets(target),
                )
            )
        cursor = target_end + 1
    return tuple(links)


def find_closing_paren(line: str, start: int) -> int | None:
    depth = 0
    escaped = False
    for index in range(start, len(line)):
        char = line[index]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == "(":
            depth += 1
            continue
        if char == ")":
            if depth == 0:
                return index
            depth -= 1
    return None


def first_markdown_link_token(raw_target: str) -> str:
    if not raw_target:
        return ""
    if raw_target.startswith("<"):
        end = raw_target.find(">")
        if end != -1:
            return raw_target[: end + 1]
    return raw_target.split()[0]


def markdown_heading_to_slug(heading: str) -> str:
    heading = EXPLICIT_HEADING_ID_RE.sub("", heading)
    heading = re.sub(r"`([^`]*)`", r"\1", heading)
    heading = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", heading)
    heading = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", heading)
    heading = re.sub(r"<[^>]+>", "", heading)
    heading = unicodedata.normalize("NFKD", heading).strip().lower()

    chars: list[str] = []
    previous_dash = False
    for char in heading:
        if char.isalnum() or char in ("_", "-"):
            chars.append(char)
            previous_dash = False
        elif char.isspace():
            if not previous_dash:
                chars.append("-")
                previous_dash = True
    return "".join(chars).strip("-")


def markdown_anchors(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    anchors: set[str] = set()
    slug_counts: dict[str, int] = {}
    fence: FenceState | None = None

    for line in text.splitlines():
        fence, found_fence_marker = update_fence_state(line, fence)
        if found_fence_marker:
            continue
        if fence is not None:
            continue

        for match in HTML_ANCHOR_RE.finditer(line):
            anchors.add(match.group(1))
        for match in INLINE_HTML_ID_RE.finditer(line):
            anchors.add(match.group(1))

        heading_match = HEADING_RE.match(line)
        if not heading_match:
            continue

        heading = heading_match.group(2)
        explicit_id = EXPLICIT_HEADING_ID_RE.search(heading)
        if explicit_id:
            anchors.add(explicit_id.group(1))

        slug = markdown_heading_to_slug(heading)
        if not slug:
            continue
        count = slug_counts.get(slug, 0)
        anchors.add(slug if count == 0 else f"{slug}-{count}")
        slug_counts[slug] = count + 1

    return anchors


def validate_fragment(target_file: Path, fragment: str) -> str | None:
    if not fragment:
        return None

    fragment = unquote(fragment)
    line_match = re.fullmatch(r"L(?P<start>\d+)(?:-L(?P<end>\d+))?", fragment)
    if line_match:
        line_count = sum(1 for _ in target_file.open(encoding="utf-8"))
        start = int(line_match.group("start"))
        end = int(line_match.group("end") or start)
        if 1 <= start <= end <= line_count:
            return None
        return f"line fragment #{fragment} is outside 1..{line_count}"

    if fragment in markdown_anchors(target_file):
        return None
    return f"missing anchor #{fragment}"


def check_links(docs_root: Path, *, check_anchors: bool) -> tuple[int, tuple[BrokenLink, ...]]:
    markdown_files = iter_markdown_files(docs_root)
    broken: list[BrokenLink] = []
    anchor_errors: dict[tuple[Path, str], str | None] = {}

    for source in markdown_files:
        text = source.read_text(encoding="utf-8")
        for link in iter_line_links(source, text):
            target = link.target.strip()
            if not target or is_ignored_url(target):
                continue

            parsed = urlsplit(target)
            if parsed.scheme:
                continue

            is_internal, target_file = is_docs_internal_target(source, docs_root, parsed.path)
            if not is_internal:
                continue
            assert target_file is not None

            if not target_file.is_file():
                broken.append(BrokenLink(link, f"missing file {format_path(target_file, docs_root)}"))
                continue

            if check_anchors and parsed.fragment:
                cache_key = (target_file, parsed.fragment)
                if cache_key not in anchor_errors:
                    anchor_errors[cache_key] = validate_fragment(target_file, parsed.fragment)
                fragment_error = anchor_errors[cache_key]
                if fragment_error:
                    broken.append(BrokenLink(link, fragment_error))

    return len(markdown_files), tuple(broken)


def format_path(path: Path, base: Path) -> str:
    relative = relative_to_or_none(path, base)
    if relative is not None:
        return str(relative)
    return str(path)


def print_result(docs_root: Path, markdown_file_count: int, broken: tuple[BrokenLink, ...]) -> None:
    if not broken:
        print(f"docs link check passed: {markdown_file_count} Markdown files scanned")
        return

    print(f"docs link check failed: {len(broken)} broken link(s) in {markdown_file_count} Markdown files")
    for item in broken:
        source = format_path(item.link.source, docs_root)
        print(f"- {source}:{item.link.line}:{item.link.column} -> {item.link.target} ({item.reason})")


def main() -> int:
    args = parse_args()
    repo_root = normalize_root(args.repo_root) if args.repo_root else default_repo_root()
    docs_root = normalize_root(args.docs_root) if args.docs_root else repo_root / "docs"

    if not docs_root.is_dir():
        print(f"docs root does not exist: {docs_root}", file=sys.stderr)
        return 2

    try:
        markdown_file_count, broken = check_links(docs_root, check_anchors=not args.no_anchor_check)
    except UnicodeDecodeError as exc:
        print(f"cannot decode Markdown as UTF-8: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"cannot read docs tree: {exc}", file=sys.stderr)
        return 2

    print_result(docs_root, markdown_file_count, broken)
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())

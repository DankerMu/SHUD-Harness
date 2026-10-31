#!/usr/bin/env sh
# Renders the generated root instruction files from instructions/agents/ sources:
#   AGENTS.md = header + shared.md + codex.md     CLAUDE.md = header + shared.md + claude.md
# `--check` verifies both projections and the configured AGENTS.md budget (CI doc gate).
# Never hand-edit AGENTS.md/CLAUDE.md.
# Usage: render.sh [--check] [--root <dir>]
set -eu
MODE=render
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check; shift ;;
    --root) ROOT="$2"; shift 2 ;;
    *) echo "render.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
SRC="$ROOT/instructions/agents"
for f in shared.md claude.md codex.md; do
  [ -f "$SRC/$f" ] || { echo "render.sh: missing source $SRC/$f" >&2; exit 2; }
done

render() { # $1 = fragment name, $2 = output basename
  {
    printf '<!--\nGenerated from instructions/agents/shared.md and instructions/agents/%s\nby `pnpm run instructions:render` (project-instruction-bootstrap sources). Edit those sources, then re-render.\nDo not hand-edit this file.\n-->\n\n' "$1"
    cat "$SRC/shared.md"
    printf '\n'
    cat "$SRC/$1"
  }
}

status=0
for pair in "codex.md:AGENTS.md" "claude.md:CLAUDE.md"; do
  frag=${pair%%:*}; out=${pair##*:}
  if [ "$MODE" = render ]; then
    render "$frag" > "$ROOT/$out"
    echo "rendered $out"
  else
    if ! render "$frag" | cmp -s - "$ROOT/$out"; then
      echo "instructions:check: $out is out of date or hand-edited — run pnpm run instructions:render" >&2
      status=1
    fi
  fi
done
if [ "$MODE" = check ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  python3 "$SCRIPT_DIR/check-line-budget.py" --root "$ROOT" || status=1
fi
exit $status

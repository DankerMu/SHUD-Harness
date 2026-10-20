#!/usr/bin/env sh
# Naming guard: rejects parallel-version file names (_v2, _new, _old, _backup, _temp, _copy, _final).
# Pattern and exemptions come from constraints.yaml (naming.forbidden_pattern / naming.exempt_prefixes).
# Usage: check-naming.sh            → staged files (pre-commit)
#        check-naming.sh --all      → every tracked file
#        check-naming.sh <path>...  → the given paths (guardrail self-test)
set -eu
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
CONSTRAINTS="$ROOT/constraints.yaml"
PATTERN=$(sed -n "s/^  forbidden_pattern: *['\"]\(.*\)['\"]\$/\1/p" "$CONSTRAINTS")
EXEMPT=$(sed -n '/^  exempt_prefixes:/,/^  [a-z]/p' "$CONSTRAINTS" | sed -n 's/^    - *"\(.*\)"$/\1/p')
[ -n "$PATTERN" ] || { echo "check-naming: forbidden_pattern missing in constraints.yaml" >&2; exit 2; }

if [ "${1:-}" = "--all" ]; then
  FILES=$(git -C "$ROOT" ls-files)
elif [ $# -gt 0 ]; then
  FILES=$(printf '%s\n' "$@")
else
  FILES=$(git -C "$ROOT" diff --cached --name-only --diff-filter=AR)
fi

status=0
for f in $FILES; do
  skip=0
  for prefix in $EXEMPT; do
    case "$f" in "$prefix"*) skip=1 ;; esac
  done
  [ "$skip" -eq 1 ] && continue
  if printf '%s\n' "$f" | grep -Eq "$PATTERN"; then
    echo "naming guard: forbidden parallel-version name: $f" >&2
    status=1
  fi
done
[ "$status" -eq 0 ] || echo "naming guard: rename to a single canonical name; parallel implementations are banned (AGENTS.md ## Code Canonicality)." >&2
exit $status

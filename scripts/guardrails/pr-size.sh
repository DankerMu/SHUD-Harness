#!/usr/bin/env sh
# PR size gate: added+deleted lines must stay ≤ constraints.yaml thresholds.pr_diff_lines_max.
# Generated/lock files listed in constraints.yaml pr_size.exclude_paths do not count.
# Bypass: exact case-sensitive `size-exempt` member of PR_LABELS_JSON (one top-level JSON array of label names).
# Multiple JSON values and non-arrays never grant exemption.
# Requires jq; unset/empty labels mean []. Bypass is logged, never silent.
# Usage: pr-size.sh [--base <ref>] [--count <n>]   (--count evaluates the threshold logic directly; self-test)
set -eu
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
CONSTRAINTS="$ROOT/constraints.yaml"
MAX=$(sed -n 's/^  pr_diff_lines_max: *\([0-9]*\).*/\1/p' "$CONSTRAINTS")
[ -n "$MAX" ] || { echo "pr-size: pr_diff_lines_max missing in constraints.yaml" >&2; exit 2; }
EXCLUDES=$(sed -n '/^pr_size:/,/^[a-z]/p' "$CONSTRAINTS" | sed -n 's/^    - *"\(.*\)"$/\1/p')

BASE="${PR_BASE_SHA:-origin/main}"
COUNT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --count) COUNT="$2"; shift 2 ;;
    *) echo "pr-size: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ -z "$COUNT" ]; then
  set -- 
  for e in $EXCLUDES; do set -- "$@" ":(exclude)$e"; done
  COUNT=$(git -C "$ROOT" diff --numstat "$BASE"...HEAD -- . "$@" | awk '{ if ($1 != "-") a += $1 + $2 } END { print a + 0 }')
fi

echo "pr-size: $COUNT changed lines (limit $MAX, base $BASE)"
if [ "$COUNT" -gt "$MAX" ]; then
  if printf '%s\n' "${PR_LABELS_JSON:-[]}" | jq -es 'if length == 1 then .[0] | if type == "array" then index("size-exempt") != null else false end else false end' >/dev/null; then
    echo "pr-size: OVER LIMIT but label size-exempt present — bypass recorded" >&2
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "⚠️ pr-size bypassed via size-exempt: $COUNT lines > $MAX" >> "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
  echo "pr-size: FAIL — split the PR (≤ $MAX lines) or add label size-exempt with a reason in the PR body" >&2
  exit 1
fi

#!/usr/bin/env sh
# Required-check aggregate: RESULTS is the workflow's toJSON(needs) snapshot.
set -e

echo "$RESULTS"
bad=$(echo "$RESULTS" | jq -r 'to_entries[] | select(.value.result != "success") | "\(.key)=\(.value.result)"')
if [ -n "$bad" ]; then
  echo "required jobs not successful (result must be success, never skipped): $bad" >&2
  exit 1
fi
echo "all required checks passed"

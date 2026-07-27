#!/bin/sh
set -eu

# The original Round 1 replay copied source/tests from the caller's worktree and
# accepted any non-zero RED. It is intentionally retired rather than kept as an
# unsafe executable evidence path. Use the blob-bound Round 2 proof.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$script_dir/issue-132-round-2-red-proof.sh" "$@"

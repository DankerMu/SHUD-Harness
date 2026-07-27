#!/bin/sh
set -eu

base_sha=c9ea4fb325f2b4c9ff5c4693ffb90aa13ae8445e
repo_root=$(git rev-parse --show-toplevel)
proof_root=$(mktemp -d "${TMPDIR:-/tmp}/issue-132-round-1-red-proof.XXXXXX")
proof_tree="$proof_root/tree"
saved_source="$proof_root/source"
red_log="$proof_root/red.log"
green_log="$proof_root/green.log"
production_sources='packages/core/src/domain/schemas/stack-lock.ts packages/core/src/domain/services/stack-lock-collector.ts'
test_sources='packages/core/src/domain/schemas/core-schemas.test.ts packages/core/src/domain/services/stack-lock-collector.test.ts packages/core/src/domain/services/stack-lock-dirty-state.test.ts'
test_command='npx --yes bun@1.2.19 test packages/core/src/domain/schemas/core-schemas.test.ts packages/core/src/domain/services/stack-lock-collector.test.ts packages/core/src/domain/services/stack-lock-dirty-state.test.ts'

cleanup() {
  git -C "$repo_root" worktree remove --force "$proof_tree" >/dev/null 2>&1 || true
  rm -rf "$proof_root"
}
trap cleanup EXIT HUP INT TERM

if git -C "$repo_root" stash list | grep -q 'red-proof'; then
  echo 'refusing to run with an existing red-proof stash' >&2
  exit 2
fi

git -C "$repo_root" cat-file -e "$base_sha^{commit}"
git -C "$repo_root" worktree add --detach "$proof_tree" HEAD >/dev/null
mkdir -p "$saved_source"

for path in $production_sources $test_sources; do
  mkdir -p "$proof_tree/$(dirname "$path")"
  cp "$repo_root/$path" "$proof_tree/$path"
done
for path in $production_sources; do
  mkdir -p "$saved_source/$(dirname "$path")"
  cp "$repo_root/$path" "$saved_source/$path"
  git -C "$repo_root" show "$base_sha:$path" > "$proof_tree/$path"
done
if [ -d "$repo_root/node_modules" ]; then
  ln -s "$repo_root/node_modules" "$proof_tree/node_modules"
fi

set +e
(cd "$proof_tree" && sh -c "$test_command") >"$red_log" 2>&1
red_status=$?
set -e
if [ "$red_status" -eq 0 ]; then
  echo 'RED proof unexpectedly passed against base production source.' >&2
  tail -40 "$red_log" >&2
  exit 1
fi

for path in $production_sources; do
  cp "$saved_source/$path" "$proof_tree/$path"
done
set +e
(cd "$proof_tree" && sh -c "$test_command") >"$green_log" 2>&1
green_status=$?
set -e
if [ "$green_status" -ne 0 ]; then
  echo 'GREEN proof failed after restoring final production source.' >&2
  tail -80 "$green_log" >&2
  exit 1
fi

if git -C "$repo_root" stash list | grep -q 'red-proof'; then
  echo 'red-proof stash residue detected' >&2
  exit 1
fi

echo "base_sha=$base_sha"
echo "production_sources=$production_sources"
echo "test_command=$test_command"
echo "red_status=$red_status"
tail -6 "$red_log"
echo "green_status=$green_status"
tail -6 "$green_log"
echo 'cleanup=temporary worktree removed by trap; no stash created'

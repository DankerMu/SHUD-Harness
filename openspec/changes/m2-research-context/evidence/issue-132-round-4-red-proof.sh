#!/bin/sh
set -eu

if [ "$#" -ne 2 ] || [ "$1" != "--green-sha" ]; then
  echo "usage: $0 --green-sha <committed-green-sha>" >&2
  exit 64
fi

green_sha=$2
repo_root=$(git rev-parse --show-toplevel)
green_sha=$(git -C "$repo_root" rev-parse --verify "${green_sha}^{commit}")
paths='packages/core/src/domain/services/stack-lock-collector.ts
packages/core/src/domain/services/stack-lock-dirty-state.test.ts
openspec/changes/m2-research-context/design.md
openspec/changes/m2-research-context/specs/stack-lock/spec.md
openspec/changes/m2-research-context/evidence/issue-132.md
openspec/changes/m2-research-context/evidence/issue-132-round-4-red-proof.sh'

for path in $paths; do
  git -C "$repo_root" cat-file -e "$green_sha:$path"
done
git -C "$repo_root" diff --quiet "$green_sha" -- $paths
git -C "$repo_root" diff --cached --quiet "$green_sha" -- $paths
if [ -n "$(git -C "$repo_root" ls-files --others --exclude-standard -- $paths)" ]; then
  echo "refusing related untracked paths" >&2
  exit 65
fi

proof_root=$(mktemp -d "${TMPDIR:-/tmp}/issue-132-round-4-red-proof.XXXXXX")
proof_repo="$proof_root/repo"
cleanup() {
  git -C "$repo_root" worktree remove --force "$proof_repo" >/dev/null 2>&1 || true
  find "$proof_root" -depth -delete >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
git -C "$repo_root" worktree add --quiet --detach "$proof_repo" "$green_sha"
(cd "$proof_repo" && git submodule update --init zero >/dev/null)
(cd "$proof_repo" && npx --yes bun@1.2.19 install --frozen-lockfile >/dev/null)

test_pattern='preserves the source index timestamp|main checkout info-exclude|core.autocrlf and core.eol|main split-index clean|split-index companion is replaced|truthy alias yes|boolean alias yes|TMPDIR is inside a main|deinitialized stage-0'
test_command="GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null npx --yes bun@1.2.19 test packages/core/src/domain/services/stack-lock-dirty-state.test.ts -t $test_pattern"

echo "GREEN_SHA $green_sha"
for path in $paths; do
  echo "BLOB $(git -C "$repo_root" rev-parse "$green_sha:$path") $path"
done
echo "COMMAND $test_command"
echo "SETUP git submodule update --init zero"
echo "SETUP npx --yes bun@1.2.19 install --frozen-lockfile"

apply_semantic_mutants() {
  collector="$proof_repo/packages/core/src/domain/services/stack-lock-collector.ts"
  perl -0pi -e 's/new Date\(captured\.atimeMs\), new Date\(captured\.mtimeMs\)/Number(captured.atimeMs), Number(captured.mtimeMs)/' "$collector"
  perl -0pi -e 's/if \(audit\.infoExclude !== undefined\)/if (false \&\& audit.infoExclude !== undefined)/' "$collector"
  perl -0pi -e 's/\(statusConfig\.autocrlf === undefined \? "" :/\(true ? "" :/' "$collector"
  perl -0pi -e 's/if \(audit\.capturedIndex\.sharedIndex !== undefined\)/if (false \&\& audit.capturedIndex.sharedIndex !== undefined)/' "$collector"
  perl -0pi -e 's/  assertCapturedGitFileCurrent\(index\);\n  if \(sharedIndex !== undefined\) assertCapturedGitFileCurrent\(sharedIndex\.file\);/  \/\/ MUTANT: skip captured-source revalidation./' "$collector"
  perl -0pi -e 's/  assertCapturedRepositoryIndexCurrent\(capturedIndex\);/  \/\/ MUTANT: skip captured-source revalidation./' "$collector"
  perl -0pi -e 's/\["true", "yes", "on", "1"\]/["true"]/' "$collector"
  perl -0pi -e 's/frozenDirectory = createExternalFrozenGitDirectory\(audit\.authority\);/frozenDirectory = mkdtempSync(join(tmpdir(), "stack-lock-status-"));/' "$collector"
  perl -0pi -e 's/return Object\.freeze\(\{\n        state: "uninitialized",/throw new StackLockCollectionError("collection_contract_invalid");\n      return Object.freeze({\n        state: "uninitialized",/' "$collector"
}

assert_result() {
  phase=$1
  output=$2
  expected_pass=$3
  expected_fail=$4
  expected_exit=$5
  actual_exit=$6
  if [ "$actual_exit" -ne "$expected_exit" ]; then
    echo "$phase unexpected exit: $actual_exit" >&2
    return 1
  fi
  grep -Eq "^[[:space:]]*$expected_pass pass$" "$output"
  grep -Eq "^[[:space:]]*$expected_fail fail$" "$output"
  if grep -Eiq 'timed out|timeout|import error|unhandled|panic|harness error' "$output"; then
    echo "$phase contained a forbidden harness/import/timeout failure" >&2
    return 1
  fi
}

assert_expected_red_tests() {
  output=$1
  while IFS= read -r expected_test; do
    if ! grep -Fq "(fail) $expected_test" "$output"; then
      echo "RED missing expected semantic failure: $expected_test" >&2
      return 1
    fi
  done <<'EXPECTED_RED_TESTS'
StackLock actual repository state > preserves the source index timestamp and detects a same-length tracked byte change
StackLock actual repository state > matches native clean status for main checkout info-exclude ignore authority
StackLock actual repository state > matches native clean status for core.autocrlf and core.eol conversion
StackLock actual repository state > preserves main split-index clean status semantics
StackLock actual repository state > fails typed when a split-index companion is replaced during bounded capture
StackLock actual repository state > rejects main worktree filter when extensions.worktreeConfig uses Git truthy alias yes
StackLock actual repository state > accepts canonical Git boolean alias yes for frozen safe config
StackLock actual repository state > never observes its own temporary status authority when TMPDIR is inside a main checkout
StackLock actual repository state > treats a deinitialized stage-0 nested submodule like native clean status
EXPECTED_RED_TESTS
}

for repetition in 1 2; do
  apply_semantic_mutants
  red_output="$proof_root/red-$repetition.log"
  set +e
  (cd "$proof_repo" && GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    npx --yes bun@1.2.19 test packages/core/src/domain/services/stack-lock-dirty-state.test.ts \
    -t "$test_pattern") >"$red_output" 2>&1
  red_exit=$?
  set -e
  assert_result "RED[$repetition]" "$red_output" 0 9 1 "$red_exit"
  assert_expected_red_tests "$red_output"
  echo "RED[$repetition] 0 pass / 9 named semantic fail / exit 1"

  git -C "$proof_repo" restore --source "$green_sha" -- \
    packages/core/src/domain/services/stack-lock-collector.ts
  green_output="$proof_root/green-$repetition.log"
  (cd "$proof_repo" && GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    npx --yes bun@1.2.19 test packages/core/src/domain/services/stack-lock-dirty-state.test.ts \
    -t "$test_pattern") >"$green_output" 2>&1
  assert_result "GREEN[$repetition]" "$green_output" 9 0 0 0
  echo "GREEN[$repetition] 9 pass / 0 fail / exit 0"
done

echo "CLEANUP worktree removed by trap; source tree and index were never modified"

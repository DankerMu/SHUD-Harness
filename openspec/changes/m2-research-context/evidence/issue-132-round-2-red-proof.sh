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
packages/core/src/domain/services/stack-lock-collector.test.ts
packages/core/src/domain/services/stack-lock-dirty-state.test.ts
openspec/changes/m2-research-context/specs/stack-lock/spec.md
openspec/changes/m2-research-context/evidence/issue-132-round-2-red-proof.sh'

for path in $paths; do
  git -C "$repo_root" cat-file -e "$green_sha:$path"
done
git -C "$repo_root" diff --quiet "$green_sha" -- $paths
git -C "$repo_root" diff --cached --quiet "$green_sha" -- $paths
if [ -n "$(git -C "$repo_root" ls-files --others --exclude-standard -- $paths)" ]; then
  echo "refusing related untracked paths" >&2
  exit 65
fi

proof_root=$(mktemp -d "${TMPDIR:-/tmp}/issue-132-round-2-red-proof.XXXXXX")
proof_repo="$proof_root/repo"
cleanup() {
  git -C "$repo_root" worktree remove --force "$proof_repo" >/dev/null 2>&1 || true
  rm -f "$proof_root"/red-*.log "$proof_root"/green-*.log
  rmdir "$proof_root" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
git -C "$repo_root" worktree add --quiet --detach "$proof_repo" "$green_sha"
(cd "$proof_repo" && git submodule update --init zero >/dev/null)
(cd "$proof_repo" && npx --yes bun@1.2.19 install --frozen-lockfile >/dev/null)

test_pattern='dirty drift when its next publication sibling|commit drift when its next publication sibling|branch drift when its next publication sibling|symlink checkout before|distinguishes a descriptor|PATH components|owns a checkout handle|filter'
test_command="npx --yes bun@1.2.19 test packages/core/src/domain/services/stack-lock-collector.test.ts packages/core/src/domain/services/stack-lock-dirty-state.test.ts -t $test_pattern"

echo "GREEN_SHA $green_sha"
for path in $paths; do
  echo "BLOB $(git -C "$repo_root" rev-parse "$green_sha:$path") $path"
done
echo "COMMAND $test_command"
echo "SETUP git submodule update --init zero"
echo "SETUP npx --yes bun@1.2.19 install --frozen-lockfile"

apply_semantic_mutants() {
  collector="$proof_repo/packages/core/src/domain/services/stack-lock-collector.ts"
  perl -0pi -e 's/const secondSweep = await collectPublicationSweep\(repositoryRoot, snapshot, gitCommand\);/const secondSweep = firstSweep;/' "$collector"
  perl -0pi -e 's/const firstIdentity = await observeCheckoutPath\(requestedPath\);/const physicalPath = await realpathCheckoutPath(requestedPath);\n    const firstIdentity = await observeCheckoutPath(requestedPath);/' "$collector"
  perl -0pi -e 's/\n    const physicalPath = await realpathCheckoutPath\(requestedPath\);\n    const secondIdentity/\n    const secondIdentity/' "$collector"
  perl -0pi -e 's/boundedStderrEquals\(stderr, `\$\{CWD_IDENTITY_MISMATCH_MARKER\}\\n`\)/true/' "$collector"
  perl -0pi -e 's/const gitExecutable = await resolveTrustedGitExecutable\(env\);/const gitExecutable = "git";/' "$collector"
  perl -0pi -e 's/    authorityOwner\?\.register\(authority\);\n/    \/\/ MUTANT: authority ownership registration removed.\n/' "$collector"
  perl -0pi -e 's/  await assertNoExecutableRepositoryFilters\(authority, gitCommand\);\n//' "$collector"
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
StackLock context collector > distinguishes a descriptor identity marker from Git's own exit 73
StackLock context collector > rejects relative PATH components before a checkout-local git marker can execute
StackLock context collector > rejects empty PATH components before a checkout-local git marker can execute
StackLock context collector > owns a checkout handle before outer postconditions and preserves the primary error over close failure
StackLock actual repository state > rejects SHUD dirty drift when its next publication sibling rSHUD starts
StackLock actual repository state > rejects SHUD commit drift when its next publication sibling rSHUD starts
StackLock actual repository state > rejects SHUD branch drift when its next publication sibling rSHUD starts
StackLock actual repository state > rejects rSHUD dirty drift when its next publication sibling AutoSHUD starts
StackLock actual repository state > rejects rSHUD commit drift when its next publication sibling AutoSHUD starts
StackLock actual repository state > rejects rSHUD branch drift when its next publication sibling AutoSHUD starts
StackLock actual repository state > rejects AutoSHUD dirty drift when its next publication sibling zero starts
StackLock actual repository state > rejects AutoSHUD commit drift when its next publication sibling zero starts
StackLock actual repository state > rejects AutoSHUD branch drift when its next publication sibling zero starts
StackLock actual repository state > rejects a symlink checkout before any checkout realpath observation
StackLock actual repository state > rejects a real repo-local filter.clean command before status can execute it
StackLock actual repository state > rejects a real repo-local filter.process command before status can execute it
StackLock actual repository state > rejects a nested submodule process filter before parent status can execute it
EXPECTED_RED_TESTS
}

for repetition in 1 2; do
  apply_semantic_mutants
  red_output="$proof_root/red-$repetition.log"
  set +e
  (cd "$proof_repo" && npx --yes bun@1.2.19 test \
    packages/core/src/domain/services/stack-lock-collector.test.ts \
    packages/core/src/domain/services/stack-lock-dirty-state.test.ts \
    -t "$test_pattern") >"$red_output" 2>&1
  red_exit=$?
  set -e
  assert_result "RED[$repetition]" "$red_output" 0 17 1 "$red_exit"
  assert_expected_red_tests "$red_output"
  echo "RED[$repetition] 0 pass / 17 named semantic fail / exit 1"

  git -C "$proof_repo" restore --source "$green_sha" -- \
    packages/core/src/domain/services/stack-lock-collector.ts
  green_output="$proof_root/green-$repetition.log"
  (cd "$proof_repo" && npx --yes bun@1.2.19 test \
    packages/core/src/domain/services/stack-lock-collector.test.ts \
    packages/core/src/domain/services/stack-lock-dirty-state.test.ts \
    -t "$test_pattern") >"$green_output" 2>&1
  assert_result "GREEN[$repetition]" "$green_output" 17 0 0 0
  echo "GREEN[$repetition] 17 pass / 0 fail / exit 0"
done

echo "CLEANUP worktree removed by trap; source tree and index were never modified"

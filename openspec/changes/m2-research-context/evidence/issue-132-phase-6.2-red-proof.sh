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
openspec/changes/m2-research-context/evidence/issue-132-phase-6.2-red-proof.sh'

for path in $paths; do
  git -C "$repo_root" cat-file -e "$green_sha:$path"
done
git -C "$repo_root" diff --quiet "$green_sha" -- $paths
git -C "$repo_root" diff --cached --quiet "$green_sha" -- $paths
if [ -n "$(git -C "$repo_root" ls-files --others --exclude-standard -- $paths)" ]; then
  echo "refusing related untracked paths" >&2
  exit 65
fi

proof_root=$(mktemp -d "${TMPDIR:-/tmp}/issue-132-phase-6.2-red-proof.XXXXXX")
proof_repo="$proof_root/repo"
cleanup() {
  git -C "$repo_root" worktree remove --force "$proof_repo" >/dev/null 2>&1 || true
  find "$proof_root" -depth -delete >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
git -C "$repo_root" worktree add --quiet --detach "$proof_repo" "$green_sha"
(cd "$proof_repo" && git submodule update --init zero >/dev/null)
(cd "$proof_repo" && npx --yes bun@1.2.19 install --frozen-lockfile >/dev/null)

echo "GREEN_SHA $green_sha"
for path in $paths; do
  echo "BLOB $(git -C "$repo_root" rev-parse "$green_sha:$path") $path"
done
echo "COMMAND_TEMPLATE GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null npx --yes bun@1.2.19 test packages/core/src/domain/services/stack-lock-dirty-state.test.ts -t '<escaped-unique-full-test-title>'"

apply_semantic_mutants() {
  collector="$proof_repo/packages/core/src/domain/services/stack-lock-collector.ts"
  perl -0pi -e 's/      "core\.trustctime",\n      "core\.ignorestat"/      \/\/ MUTANT: omit stat-refresh booleans./' "$collector"
  perl -0pi -e 's/else if \(key === "core\.checkstat"\)/else if (false \&\& key === "core.checkstat")/' "$collector"
  perl -0pi -e 's/(if \(nested\.state === "absent"\) \{\n      await assertNestedRepositoryRemainsAbsent\(nested\);\n      )return true;/${1}throw new StackLockCollectionError("collection_contract_invalid");/' "$collector"
  perl -0pi -e 's/const relativeFromCollectionRoot = relative\(repositoryRoot\.path, physicalParent\);/const relativeFromCollectionRoot = "..";/' "$collector"
}

print_failure_log() {
  label=$1
  output=$2
  echo "$label output follows:" >&2
  sed -n '1,240p' "$output" >&2
}

run_rows() {
  phase=$1
  repetition=$2
  expected_marker=$3
  expected_exit=$4
  expected_pass=$5
  expected_fail=$6
  row=0
  while IFS='|' read -r selector expected_test; do
    row=$((row + 1))
    output="$proof_root/$(printf '%s' "$phase" | tr '[:upper:]' '[:lower:]')-$repetition-$row.log"
    set +e
    (cd "$proof_repo" && GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
      npx --yes bun@1.2.19 test packages/core/src/domain/services/stack-lock-dirty-state.test.ts \
      -t "$selector") >"$output" 2>&1
    actual_exit=$?
    set -e
    label="${phase}[$repetition] row $row"
    if [ "$actual_exit" -ne "$expected_exit" ]; then
      echo "$label unexpected exit: expected $expected_exit, got $actual_exit" >&2
      print_failure_log "$label" "$output"
      return 1
    fi
    if grep -Eiq 'timed out|timeout|import error|unhandled|panic|harness error|segmentation fault|TypeError' "$output"; then
      echo "$label contained a forbidden harness/import/timeout/runtime failure" >&2
      print_failure_log "$label" "$output"
      return 1
    fi
    if ! grep -Fq "($expected_marker) $expected_test" "$output"; then
      echo "$label missing exact named $expected_marker result: $expected_test" >&2
      print_failure_log "$label" "$output"
      return 1
    fi
    if ! grep -Eq "^[[:space:]]*$expected_pass pass$" "$output" ||
       ! grep -Eq "^[[:space:]]*$expected_fail fail$" "$output" ||
       ! grep -Eq '^Ran 1 test across 1 file\.' "$output"; then
      echo "$label summary or selector cardinality mismatch" >&2
      print_failure_log "$label" "$output"
      return 1
    fi
  done <<'PROOF_ROWS'
preserves native same-stat clean semantics for main-local effective stat config|StackLock actual repository state > preserves native same-stat clean semantics for main-local effective stat config
treats a stably absent direct stage-0 nested path as dirty|StackLock actual repository state > treats a stably absent direct stage-0 nested path as dirty
rejects collection-wide protected TMPDIR superproject before any transient creation|StackLock actual repository state > rejects collection-wide protected TMPDIR superproject before any transient creation
PROOF_ROWS
  if [ "$row" -ne 3 ]; then
    echo "${phase}[$repetition] internal row-count mismatch: expected 3, got $row" >&2
    return 1
  fi
  echo "${phase}[$repetition] 3/3 exact named rows passed their proof assertions"
}

for repetition in 1 2; do
  apply_semantic_mutants
  run_rows RED "$repetition" fail 1 0 1
  git -C "$proof_repo" restore --source "$green_sha" -- \
    packages/core/src/domain/services/stack-lock-collector.ts
  run_rows GREEN "$repetition" pass 0 1 0
done

echo "CLEANUP worktree removed by trap; source tree and index were never modified"

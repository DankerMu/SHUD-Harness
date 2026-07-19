#!/bin/sh

set -eu

repo_root=$(git rev-parse --show-toplevel)
verifier="$repo_root/openspec/changes/m1-failure-occurrence-ledger/evidence/scripts/verify-replay-evidence.sh"
self_test="$repo_root/openspec/changes/m1-failure-occurrence-ledger/evidence/scripts/verify-replay-evidence.test.sh"
test_root_parent=${SHUD_REPLAY_TEST_ROOT_PARENT:-${TMPDIR:-/tmp}}
test_root_name=${SHUD_REPLAY_SELF_TEST_ROOT_NAME:-shud-ledger-replay-tests.$$}
self_test_scenario=${SHUD_REPLAY_SELF_TEST_SCENARIO:-matrix}
test_parent=
test_parent_owned=0
test_cleanup_entry_signal=

cleanup_test_parent() {
  # The status argument was expanded by the EXIT trap before this function was
  # entered. Masking is deliberately the first cleanup command.
  trap '' EXIT HUP INT TERM
  test_status=$1
  if [ -n "$test_cleanup_entry_signal" ]; then
    kill -s "$test_cleanup_entry_signal" "$$"
  fi
  if [ "$test_parent_owned" -eq 1 ]; then
    git -C "$repo_root" worktree list --porcelain |
      while IFS= read -r line; do
        case "$line" in
          "worktree $test_parent/"*)
            test_worktree=${line#worktree }
            git -C "$repo_root" worktree unlock "$test_worktree" >/dev/null 2>&1 || true
            git -C "$repo_root" worktree remove --force "$test_worktree" >/dev/null 2>&1 || true
            ;;
        esac
      done
    find "$test_parent" -depth -type d -empty -delete >/dev/null 2>&1 || true
    rmdir "$test_parent" >/dev/null 2>&1 || true
  fi
  exit "$test_status"
}

exit_test_for_signal() {
  # The literal signal status is already an argument. Mask before any other
  # command so later signals cannot replace it.
  trap '' HUP INT TERM
  exit "$1"
}

case "$test_root_name" in
  ''|.|..|*/*)
    echo "invalid replay self-test root name: $test_root_name" >&2
    exit 64
    ;;
esac
case "$self_test_scenario" in
  matrix|harness_startup_term|harness_double_hup_int)
    ;;
  *)
    echo "unknown replay self-test scenario: $self_test_scenario" >&2
    exit 64
    ;;
esac

test_parent="${test_root_parent%/}/$test_root_name"

# Bind the exact harness root and install authority before creating it.
trap 'cleanup_test_parent "$?"' EXIT
trap 'exit_test_for_signal 129' HUP
trap 'exit_test_for_signal 130' INT
trap 'exit_test_for_signal 143' TERM

if [ ! -d "$test_root_parent" ]; then
  echo "replay self-test parent is not a directory: $test_root_parent" >&2
  exit 66
fi
if [ -e "$test_parent" ] || [ -L "$test_parent" ]; then
  echo "replay self-test root collision: $test_parent" >&2
  exit 73
fi

test_parent_owned=1
mkdir -m 700 "$test_parent"

case "$self_test_scenario" in
  harness_startup_term)
    kill -s TERM "$$"
    ;;
  harness_double_hup_int)
    test_cleanup_entry_signal=INT
    kill -s HUP "$$"
    ;;
esac

assert_no_residue() {
  if git -C "$repo_root" worktree list --porcelain | grep -F "worktree $test_parent/" >/dev/null; then
    echo "registered replay worktree residue after $1" >&2
    return 1
  fi
  if find "$test_parent" -mindepth 1 -print -quit | grep . >/dev/null; then
    echo "filesystem replay residue after $1" >&2
    return 1
  fi
}

run_verifier_case() {
  scenario=$1
  expected=$2
  set +e
  SHUD_REPLAY_TEST_ROOT_PARENT="$test_parent" \
    SHUD_REPLAY_TEST_SCENARIO="$scenario" \
    "$verifier" >/dev/null 2>&1
  actual=$?
  set -e
  case "$expected" in
    nonzero)
      if [ "$actual" -eq 0 ]; then
        echo "$scenario unexpectedly succeeded" >&2
        return 1
      fi
      ;;
    *)
      if [ "$actual" -ne "$expected" ]; then
        echo "$scenario exited $actual, expected $expected" >&2
        return 1
      fi
      ;;
  esac
  assert_no_residue "$scenario"
}

run_harness_case() {
  scenario=$1
  expected=$2
  root_name="harness-$scenario"
  set +e
  SHUD_REPLAY_TEST_ROOT_PARENT="$test_parent" \
    SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_SCENARIO="$scenario" \
    "$self_test" >/dev/null 2>&1
  actual=$?
  set -e
  if [ "$actual" -ne "$expected" ]; then
    echo "$scenario exited $actual, expected $expected" >&2
    return 1
  fi
  assert_no_residue "$scenario"
}

run_collision_case() {
  collision_root="$test_parent/replay-collision"
  mkdir -m 700 "$collision_root"
  printf '%s\n' foreign >"$collision_root/foreign-marker"
  set +e
  SHUD_REPLAY_TEST_ROOT_PARENT="$test_parent" \
    SHUD_REPLAY_TEST_ROOT_NAME=replay-collision \
    SHUD_REPLAY_TEST_SCENARIO=normal \
    "$verifier" >/dev/null 2>&1
  actual=$?
  set -e
  if [ "$actual" -ne 73 ]; then
    echo "root_collision exited $actual, expected 73" >&2
    return 1
  fi
  if [ "$(sed -n '1p' "$collision_root/foreign-marker")" != foreign ]; then
    echo "root_collision modified the foreign target" >&2
    return 1
  fi
  rm "$collision_root/foreign-marker"
  rmdir "$collision_root"
  assert_no_residue root_collision
}

run_harness_collision_case() {
  collision_root="$test_parent/harness-collision"
  mkdir -m 700 "$collision_root"
  printf '%s\n' foreign >"$collision_root/foreign-marker"
  set +e
  SHUD_REPLAY_TEST_ROOT_PARENT="$test_parent" \
    SHUD_REPLAY_SELF_TEST_ROOT_NAME=harness-collision \
    SHUD_REPLAY_SELF_TEST_SCENARIO=matrix \
    "$self_test" >/dev/null 2>&1
  actual=$?
  set -e
  if [ "$actual" -ne 73 ]; then
    echo "harness_collision exited $actual, expected 73" >&2
    return 1
  fi
  if [ "$(sed -n '1p' "$collision_root/foreign-marker")" != foreign ]; then
    echo "harness_collision modified the foreign target" >&2
    return 1
  fi
  rm "$collision_root/foreign-marker"
  rmdir "$collision_root"
  assert_no_residue harness_collision
}

run_verifier_case normal 0
run_verifier_case root_failure_after_create 41
run_verifier_case add_failure_round_1 nonzero
run_verifier_case add_failure_round_2 nonzero
run_verifier_case patch_failure_round_1 nonzero
run_verifier_case patch_failure_round_2 nonzero
run_verifier_case partial_after_round_1 38
run_verifier_case partial_after_round_2 39
run_verifier_case dirty_cleanup nonzero
run_verifier_case locked_cleanup nonzero
run_verifier_case missing_cleanup nonzero
run_verifier_case signal_after_root_hup 129
run_verifier_case signal_after_root_int 130
run_verifier_case signal_after_root_term 143
run_verifier_case double_hup_int 129
run_verifier_case double_int_term 130
run_verifier_case double_term_hup 143
run_verifier_case failure_cleanup_term 37
run_collision_case
run_harness_case harness_startup_term 143
run_harness_case harness_double_hup_int 129
run_harness_collision_case

rmdir "$test_parent"
test_parent_owned=0
test_parent=
trap - EXIT HUP INT TERM
echo "replay evidence lifecycle: 22/22 scenarios passed"

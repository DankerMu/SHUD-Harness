#!/bin/sh

set -eu

repo_root=$(git rev-parse --show-toplevel)
verifier="$repo_root/openspec/changes/m1-failure-occurrence-ledger/evidence/scripts/verify-replay-evidence.sh"
test_parent=$(mktemp -d "${TMPDIR:-/tmp}/shud-ledger-replay-tests.XXXXXX")

cleanup_test_parent() {
  test_status=$?
  trap - EXIT
  trap '' HUP INT TERM
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
  exit "$test_status"
}

trap '' HUP INT TERM
trap cleanup_test_parent EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

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

run_case() {
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

run_case normal 0
run_case add_failure_round_1 nonzero
run_case add_failure_round_2 nonzero
run_case patch_failure_round_1 nonzero
run_case patch_failure_round_2 nonzero
run_case partial_after_round_1 38
run_case partial_after_round_2 39
run_case dirty_cleanup nonzero
run_case locked_cleanup nonzero
run_case missing_cleanup nonzero
run_case signal_after_root_hup 129
run_case signal_after_root_int 130
run_case signal_after_root_term 143
run_case double_hup_int 129
run_case double_int_term 130
run_case double_term_hup 143
run_case failure_cleanup_term 37

rmdir "$test_parent"
test_parent=
trap - EXIT HUP INT TERM
echo "replay evidence lifecycle: 17/17 scenarios passed"

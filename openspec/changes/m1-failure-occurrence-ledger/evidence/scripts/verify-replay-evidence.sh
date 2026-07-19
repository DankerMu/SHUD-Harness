#!/bin/sh

set -eu

repo_root=$(git rev-parse --show-toplevel)
round_1_base=a370f8e3a510b34c47d642f10f7d095aa8bb4b26
round_2_base=b425a68aa6e3f886c424d439f48bb97ac05bac23
round_1_patch="$repo_root/openspec/changes/m1-failure-occurrence-ledger/evidence/repair-round-1/phase-6.2/red-before-tests.patch"
round_2_patch="$repo_root/openspec/changes/m1-failure-occurrence-ledger/evidence/repair-round-2/red-before-backend-undefined.patch"
replay_parent=${SHUD_REPLAY_TEST_ROOT_PARENT:-${TMPDIR:-/tmp}}
replay_name=${SHUD_REPLAY_TEST_ROOT_NAME:-shud-ledger-replay.$$}
replay_scenario=${SHUD_REPLAY_TEST_SCENARIO:-normal}
replay_root=
replay_root_owned=0
round_1_worktree=
round_2_worktree=
cleanup_entry_signal=

cleanup_replay_worktrees() {
  # The status argument was expanded by the EXIT trap before this function was
  # entered. Masking is deliberately the first cleanup command.
  trap '' EXIT HUP INT TERM
  replay_status=$1
  if [ -n "$cleanup_entry_signal" ]; then
    kill -s "$cleanup_entry_signal" "$$"
  fi
  if [ -n "$round_1_worktree" ]; then
    git -C "$repo_root" worktree unlock "$round_1_worktree" >/dev/null 2>&1 || true
    git -C "$repo_root" worktree remove --force "$round_1_worktree" >/dev/null 2>&1 || true
  fi
  if [ -n "$round_2_worktree" ]; then
    git -C "$repo_root" worktree unlock "$round_2_worktree" >/dev/null 2>&1 || true
    git -C "$repo_root" worktree remove --force "$round_2_worktree" >/dev/null 2>&1 || true
  fi
  if [ "$replay_root_owned" -eq 1 ]; then
    rmdir "$replay_root" >/dev/null 2>&1 || true
  fi
  exit "$replay_status"
}

exit_for_signal() {
  # The signal status is a literal argument. Mask before any other command so
  # a second HUP/INT/TERM cannot replace it at a shell command boundary.
  trap '' HUP INT TERM
  exit "$1"
}

case "$replay_name" in
  ''|.|..|*/*)
    echo "invalid replay root name: $replay_name" >&2
    exit 64
    ;;
esac

replay_root="${replay_parent%/}/$replay_name"

# The exact target and complete lifecycle authority are installed before any
# temporary state exists. EXIT expands the current status before function entry.
trap 'cleanup_replay_worktrees "$?"' EXIT
trap 'exit_for_signal 129' HUP
trap 'exit_for_signal 130' INT
trap 'exit_for_signal 143' TERM

case "$replay_scenario" in
  normal|root_failure_after_create|add_failure_round_1|add_failure_round_2|\
    patch_failure_round_1|patch_failure_round_2|\
    partial_after_round_1|partial_after_round_2|\
    dirty_cleanup|locked_cleanup|missing_cleanup|\
    signal_after_root_hup|signal_after_root_int|signal_after_root_term|\
    double_hup_int|double_int_term|double_term_hup|\
    failure_cleanup_term)
    ;;
  *)
    echo "unknown replay test scenario: $replay_scenario" >&2
    exit 64
    ;;
esac

if [ ! -d "$replay_parent" ]; then
  echo "replay parent is not a directory: $replay_parent" >&2
  exit 66
fi
if [ -e "$replay_root" ] || [ -L "$replay_root" ]; then
  echo "replay root collision: $replay_root" >&2
  exit 73
fi

# Ownership intent is recorded before creation, so a signal immediately after
# mkdir still has an exact cleanup target. A pre-existing target is rejected
# above and is never marked as owned.
replay_root_owned=1
mkdir -m 700 "$replay_root"
round_1_worktree="$replay_root/round-1"
round_2_worktree="$replay_root/round-2"

case "$replay_scenario" in
  root_failure_after_create) exit 41 ;;
  signal_after_root_hup) kill -s HUP "$$" ;;
  signal_after_root_int) kill -s INT "$$" ;;
  signal_after_root_term) kill -s TERM "$$" ;;
esac

if [ "$replay_scenario" = add_failure_round_1 ]; then
  round_1_base=0000000000000000000000000000000000000000
elif [ "$replay_scenario" = add_failure_round_2 ]; then
  round_2_base=0000000000000000000000000000000000000000
fi

git -C "$repo_root" worktree add --detach "$round_1_worktree" "$round_1_base"
if [ "$replay_scenario" = partial_after_round_1 ]; then
  exit 38
fi
if [ "$replay_scenario" = patch_failure_round_1 ]; then
  round_1_patch="$repo_root/openspec/changes/m1-failure-occurrence-ledger/tasks.md"
fi
git -C "$round_1_worktree" apply --check "$round_1_patch"

git -C "$repo_root" worktree add --detach "$round_2_worktree" "$round_2_base"
if [ "$replay_scenario" = partial_after_round_2 ]; then
  exit 39
fi
if [ "$replay_scenario" = patch_failure_round_2 ]; then
  round_2_patch="$repo_root/openspec/changes/m1-failure-occurrence-ledger/tasks.md"
fi
git -C "$round_2_worktree" apply --check "$round_2_patch"

case "$replay_scenario" in
  dirty_cleanup) printf '\n' >>"$round_1_worktree/package.json" ;;
  locked_cleanup)
    git -C "$repo_root" worktree lock "$round_1_worktree" --reason replay-cleanup-probe
    ;;
  missing_cleanup) git -C "$repo_root" worktree remove "$round_1_worktree" ;;
  double_hup_int)
    cleanup_entry_signal=INT
    kill -s HUP "$$"
    ;;
  double_int_term)
    cleanup_entry_signal=TERM
    kill -s INT "$$"
    ;;
  double_term_hup)
    cleanup_entry_signal=HUP
    kill -s TERM "$$"
    ;;
  failure_cleanup_term)
    cleanup_entry_signal=TERM
    exit 37
    ;;
esac

# Normal cleanup remains strict. Any expected removal failure enters the exact,
# force-capable EXIT cleanup and retains that first nonzero status.
git -C "$repo_root" worktree remove "$round_1_worktree"
round_1_worktree=
git -C "$repo_root" worktree remove "$round_2_worktree"
round_2_worktree=
rmdir "$replay_root"
replay_root_owned=0
replay_root=
trap - EXIT HUP INT TERM

#!/bin/sh

set -eu

repo_root=$(git rev-parse --show-toplevel)
script_dir=$repo_root/openspec/changes/m1-failure-occurrence-ledger/evidence/scripts
# shellcheck disable=SC1091,SC2154
. "$script_dir/replay-lifecycle.sh"
lifecycle_first_status=${lifecycle_first_status-}
lifecycle_root=${lifecycle_root-}

round_1_base=a370f8e3a510b34c47d642f10f7d095aa8bb4b26
round_2_base=b425a68aa6e3f886c424d439f48bb97ac05bac23
round_1_patch="$repo_root/openspec/changes/m1-failure-occurrence-ledger/evidence/repair-round-1/phase-6.2/red-before-tests.patch"
round_2_patch="$repo_root/openspec/changes/m1-failure-occurrence-ledger/evidence/repair-round-2/red-before-backend-undefined.patch"
replay_parent=${SHUD_REPLAY_TEST_ROOT_PARENT:-${TMPDIR:-/tmp}}
replay_name=${SHUD_REPLAY_TEST_ROOT_NAME:-shud-ledger-replay.$$}
replay_scenario=${SHUD_REPLAY_TEST_SCENARIO:-normal}
round_1_worktree=
round_2_worktree=
round_1_registered=0
round_2_registered=0
hold_ready=${SHUD_REPLAY_TEST_HOLD_READY:-}
hold_release=${SHUD_REPLAY_TEST_HOLD_RELEASE:-}
replay_owner_token=${SHUD_REPLAY_TEST_OWNER_TOKEN:-verifier.$$}

replay_worktree_is_registered() {
  git -C "$repo_root" worktree list --porcelain |
    grep -F -x "worktree $1" >/dev/null
}

refresh_replay_registration() {
  if [ -n "$round_1_worktree" ] && replay_worktree_is_registered "$round_1_worktree"; then
    round_1_registered=1
  else
    round_1_registered=0
  fi
  if [ -n "$round_2_worktree" ] && replay_worktree_is_registered "$round_2_worktree"; then
    round_2_registered=1
  else
    round_2_registered=0
  fi
}

cleanup_registered_worktree() {
  cleanup_path=$1
  cleanup_registered=$2
  if [ "$cleanup_registered" -eq 1 ] && replay_worktree_is_registered "$cleanup_path"; then
    git -C "$repo_root" worktree unlock "$cleanup_path" >/dev/null 2>&1 || true
    git -C "$repo_root" worktree remove --force "$cleanup_path" >/dev/null 2>&1 || true
  fi
}

cleanup_replay_worktrees() {
  # Masking EXIT and all handled signals is the first cleanup command. The
  # entry status is latched only afterwards and can never replace an earlier
  # command or signal status.
  lifecycle_mask_all_handlers
  lifecycle_latch_status "$1"
  lifecycle_inject_cleanup_diagnostic
  cleanup_registered_worktree "$round_1_worktree" "$round_1_registered"
  cleanup_registered_worktree "$round_2_worktree" "$round_2_registered"
  lifecycle_cleanup_root_failure
  exit "$lifecycle_first_status"
}

run_replay_command() {
  replay_failure_status=$1
  shift
  if ! "$@"; then
    lifecycle_latch_status "$replay_failure_status"
  fi
}

strict_remove_worktree() {
  strict_path=$1
  strict_status=$2
  if ! git -C "$repo_root" worktree remove "$strict_path"; then
    lifecycle_fail "$strict_status"
  fi
}

case "$replay_scenario" in
  normal|hold_after_root|root_failure_after_create|\
    add_failure_round_1|add_failure_round_2|\
    patch_failure_round_1|patch_failure_round_2|\
    partial_after_round_1|partial_after_round_2|\
    dirty_cleanup|locked_cleanup|missing_cleanup|\
    signal_after_root_hup|signal_after_root_int|signal_after_root_term|\
    double_hup_int|double_int_term|double_term_hup|failure_cleanup_term)
    ;;
  *)
    echo "unknown replay test scenario: $replay_scenario" >&2
    exit 64
    ;;
esac

lifecycle_install_signal_handlers
trap 'cleanup_replay_worktrees "$?"' EXIT
lifecycle_begin "$replay_parent" "$replay_name" "$replay_owner_token"
lifecycle_acquire_root

round_1_worktree="$lifecycle_root/round-1"
round_2_worktree="$lifecycle_root/round-2"

case "$replay_scenario" in
  root_failure_after_create) lifecycle_fail 41 ;;
  signal_after_root_hup) kill -s HUP "$$"; lifecycle_abort_if_latched ;;
  signal_after_root_int) kill -s INT "$$"; lifecycle_abort_if_latched ;;
  signal_after_root_term) kill -s TERM "$$"; lifecycle_abort_if_latched ;;
  hold_after_root)
    if [ -z "$hold_ready" ] || [ -z "$hold_release" ]; then
      lifecycle_fail 64
    fi
    : >"$hold_ready"
    while [ ! -e "$hold_release" ]; do :; done
    ;;
esac

if [ "$replay_scenario" = add_failure_round_1 ]; then
  round_1_base=0000000000000000000000000000000000000000
elif [ "$replay_scenario" = add_failure_round_2 ]; then
  round_2_base=0000000000000000000000000000000000000000
fi

run_replay_command 74 git -C "$repo_root" worktree add --detach "$round_1_worktree" "$round_1_base"
refresh_replay_registration
lifecycle_abort_if_latched
if [ "$replay_scenario" = partial_after_round_1 ]; then
  lifecycle_fail 38
fi
if [ "$replay_scenario" = patch_failure_round_1 ]; then
  round_1_patch="$repo_root/openspec/changes/m1-failure-occurrence-ledger/tasks.md"
fi
run_replay_command 76 git -C "$round_1_worktree" apply --check "$round_1_patch"
lifecycle_abort_if_latched

run_replay_command 75 git -C "$repo_root" worktree add --detach "$round_2_worktree" "$round_2_base"
refresh_replay_registration
lifecycle_abort_if_latched
if [ "$replay_scenario" = partial_after_round_2 ]; then
  lifecycle_fail 39
fi
if [ "$replay_scenario" = patch_failure_round_2 ]; then
  round_2_patch="$repo_root/openspec/changes/m1-failure-occurrence-ledger/tasks.md"
fi
run_replay_command 78 git -C "$round_2_worktree" apply --check "$round_2_patch"
lifecycle_abort_if_latched

case "$replay_scenario" in
  dirty_cleanup) printf '\n' >>"$round_1_worktree/package.json" ;;
  locked_cleanup)
    git -C "$repo_root" worktree lock "$round_1_worktree" --reason replay-cleanup-probe
    ;;
  missing_cleanup)
    git -C "$repo_root" worktree remove "$round_1_worktree"
    refresh_replay_registration
    ;;
  double_hup_int)
    kill -s HUP "$$"
    kill -s INT "$$"
    lifecycle_abort_if_latched
    ;;
  double_int_term)
    kill -s INT "$$"
    kill -s TERM "$$"
    lifecycle_abort_if_latched
    ;;
  double_term_hup)
    kill -s TERM "$$"
    kill -s HUP "$$"
    lifecycle_abort_if_latched
    ;;
  failure_cleanup_term)
    lifecycle_latch_status 37
    kill -s TERM "$$"
    lifecycle_abort_if_latched
    ;;
esac

case "$replay_scenario" in
  dirty_cleanup) round_1_remove_status=79 ;;
  locked_cleanup) round_1_remove_status=80 ;;
  missing_cleanup) round_1_remove_status=81 ;;
  *) round_1_remove_status=82 ;;
esac

strict_remove_worktree "$round_1_worktree" "$round_1_remove_status"
round_1_registered=0
round_1_worktree=
strict_remove_worktree "$round_2_worktree" 83
round_2_registered=0
round_2_worktree=
lifecycle_release_root_strict 84
trap - EXIT HUP INT TERM

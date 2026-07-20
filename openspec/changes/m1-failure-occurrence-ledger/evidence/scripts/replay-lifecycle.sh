#!/bin/sh

# Shared POSIX-shell ownership and first-status protocol for the replay proof
# and its lifecycle harness. The caller owns EXIT cleanup because it also owns
# the exact worktree or fixture registrations layered on top of this root.

lifecycle_first_status=
lifecycle_parent=
lifecycle_name=
lifecycle_root=
lifecycle_claim=
lifecycle_marker=
lifecycle_token=
lifecycle_claim_owned=0
lifecycle_root_owned=0
lifecycle_transaction_ready=
lifecycle_transaction_release=
lifecycle_transaction_outcome=

lifecycle_latch_status() {
  if [ -z "$lifecycle_first_status" ]; then
    lifecycle_first_status=$1
  fi
}

lifecycle_signal_hup() {
  lifecycle_latch_status 129
}

lifecycle_signal_int() {
  lifecycle_latch_status 130
}

lifecycle_signal_term() {
  lifecycle_latch_status 143
}

lifecycle_install_signal_handlers() {
  trap 'lifecycle_signal_hup' HUP
  trap 'lifecycle_signal_int' INT
  trap 'lifecycle_signal_term' TERM
}

lifecycle_mask_all_handlers() {
  trap '' EXIT HUP INT TERM
}

lifecycle_abort_if_latched() {
  if [ -n "$lifecycle_first_status" ]; then
    exit "$lifecycle_first_status"
  fi
}

lifecycle_begin_successful_finalization() {
  trap '' HUP INT TERM
  lifecycle_abort_if_latched
}

lifecycle_fail() {
  lifecycle_latch_status "$1"
  lifecycle_abort_if_latched
}

lifecycle_link_matches() {
  lifecycle_match_path=$1
  lifecycle_match_token=$2
  [ -L "$lifecycle_match_path" ] || return 1
  lifecycle_match_actual=$(readlink "$lifecycle_match_path") || return 1
  [ "$lifecycle_match_actual" = "$lifecycle_match_token" ]
}

lifecycle_begin() {
  lifecycle_requested_parent=$1
  lifecycle_name=$2
  lifecycle_token=$3

  case "$lifecycle_name" in
    ''|.|..|*/*)
      echo "invalid lifecycle root name: $lifecycle_name" >&2
      lifecycle_fail 64
      ;;
  esac
  case "$lifecycle_token" in
    ''|*/*|*:*)
      echo "invalid lifecycle ownership token" >&2
      lifecycle_fail 64
      ;;
  esac
  if [ ! -d "$lifecycle_requested_parent" ]; then
    echo "lifecycle parent is not a directory: $lifecycle_requested_parent" >&2
    lifecycle_fail 66
  fi
  lifecycle_parent=$(cd "$lifecycle_requested_parent" >/dev/null 2>&1 && pwd -P) || lifecycle_fail 66

  lifecycle_root="${lifecycle_parent%/}/$lifecycle_name"
  lifecycle_claim="${lifecycle_parent%/}/.$lifecycle_name.claim"
  lifecycle_marker="$lifecycle_root/.shud-replay-owner"
  lifecycle_transaction_ready="${lifecycle_claim}.transaction.$$.ready"
  lifecycle_transaction_release="${lifecycle_claim}.transaction.$$.release"
  lifecycle_transaction_outcome="${lifecycle_claim}.transaction.$$.outcome"
}

lifecycle_cleanup_transaction_files() {
  if [ "$lifecycle_claim_owned" -ne 1 ] ||
    ! lifecycle_link_matches "$lifecycle_claim" "$lifecycle_token"; then
    return
  fi
  if lifecycle_link_matches "$lifecycle_transaction_ready" "$lifecycle_token"; then
    rm "$lifecycle_transaction_ready" >/dev/null 2>&1 || true
  fi
  if lifecycle_link_matches "$lifecycle_transaction_release" "$lifecycle_token"; then
    rm "$lifecycle_transaction_release" >/dev/null 2>&1 || true
  fi
  if [ -L "$lifecycle_transaction_outcome" ]; then
    lifecycle_outcome_value=$(readlink "$lifecycle_transaction_outcome") || lifecycle_outcome_value=
    case "$lifecycle_outcome_value" in
      "$lifecycle_token":*) rm "$lifecycle_transaction_outcome" >/dev/null 2>&1 || true ;;
    esac
  fi
}

lifecycle_release_claim_failure() {
  lifecycle_cleanup_transaction_files
  if [ "$lifecycle_claim_owned" -eq 1 ] &&
    lifecycle_link_matches "$lifecycle_claim" "$lifecycle_token"; then
    if rm "$lifecycle_claim" >/dev/null 2>&1; then
      lifecycle_claim_owned=0
    fi
  fi
}

lifecycle_cleanup_root_failure() {
  if [ "$lifecycle_root_owned" -eq 1 ] &&
    lifecycle_link_matches "$lifecycle_claim" "$lifecycle_token" &&
    lifecycle_link_matches "$lifecycle_marker" "$lifecycle_token"; then
    rm "$lifecycle_marker" >/dev/null 2>&1 || true
    if rmdir "$lifecycle_root" >/dev/null 2>&1; then
      lifecycle_root_owned=0
    else
      ln -s "$lifecycle_token" "$lifecycle_marker" >/dev/null 2>&1 || true
    fi
  fi
  if [ "$lifecycle_root_owned" -eq 0 ]; then
    lifecycle_release_claim_failure
  fi
}

lifecycle_release_root_strict() {
  lifecycle_release_status=$1
  if [ "$lifecycle_root_owned" -ne 1 ] ||
    ! lifecycle_link_matches "$lifecycle_claim" "$lifecycle_token" ||
    ! lifecycle_link_matches "$lifecycle_marker" "$lifecycle_token"; then
    echo "lifecycle ownership token mismatch: $lifecycle_root" >&2
    lifecycle_fail "$lifecycle_release_status"
  fi
  if ! rm "$lifecycle_marker"; then
    lifecycle_fail "$lifecycle_release_status"
  fi
  if ! rmdir "$lifecycle_root"; then
    ln -s "$lifecycle_token" "$lifecycle_marker" >/dev/null 2>&1 || true
    lifecycle_fail "$lifecycle_release_status"
  fi
  lifecycle_root_owned=0
  if ! rm "$lifecycle_claim"; then
    lifecycle_fail "$lifecycle_release_status"
  fi
  lifecycle_claim_owned=0
}

lifecycle_inject_acquisition_signals() {
  lifecycle_inject_first=${SHUD_REPLAY_TEST_ACQUIRE_SIGNAL_FIRST:-}
  lifecycle_inject_second=${SHUD_REPLAY_TEST_ACQUIRE_SIGNAL_SECOND:-}
  if [ -n "$lifecycle_inject_first" ]; then
    kill -s "$lifecycle_inject_first" 0
  fi
  if [ -n "$lifecycle_inject_second" ]; then
    kill -s "$lifecycle_inject_second" 0
  fi
}

lifecycle_inject_hold_signals() {
  lifecycle_hold_first=${SHUD_REPLAY_TEST_HOLD_SIGNAL_FIRST:-}
  lifecycle_hold_second=${SHUD_REPLAY_TEST_HOLD_SIGNAL_SECOND:-}
  lifecycle_hold_signals_ready=${SHUD_REPLAY_TEST_HOLD_SIGNALS_READY:-}
  if [ -n "$lifecycle_hold_first" ]; then
    kill -s "$lifecycle_hold_first" "$$"
  fi
  if [ -n "$lifecycle_hold_second" ]; then
    kill -s "$lifecycle_hold_second" "$$"
  fi
  if [ -n "$lifecycle_hold_signals_ready" ]; then
    : >"$lifecycle_hold_signals_ready"
  fi
}

lifecycle_wait_for_link() {
  lifecycle_wait_path=$1
  lifecycle_wait_pid=$2
  while [ ! -L "$lifecycle_wait_path" ]; do
    if ! kill -0 "$lifecycle_wait_pid" >/dev/null 2>&1; then
      return 1
    fi
  done
}

lifecycle_run_creation_transaction() {
  lifecycle_external_ready=${SHUD_REPLAY_TEST_CREATE_BARRIER_READY:-}
  lifecycle_external_release=${SHUD_REPLAY_TEST_CREATE_BARRIER_RELEASE:-}

  (
    # This is the first child command. Once ready is published, the complete
    # mkdir + marker transaction ignores process-group HUP/INT/TERM.
    trap '' HUP INT TERM
    ln -s "$lifecycle_token" "$lifecycle_transaction_ready" || exit 67
    while ! lifecycle_link_matches "$lifecycle_transaction_release" "$lifecycle_token"; do :; done

    if [ -n "$lifecycle_external_ready" ]; then
      ln -s "$lifecycle_token" "$lifecycle_external_ready" || exit 67
      while [ ! -e "$lifecycle_external_release" ] && [ ! -L "$lifecycle_external_release" ]; do :; done
    fi

    lifecycle_child_status=73
    if mkdir -m 700 "$lifecycle_root"; then
      lifecycle_child_status=68
      if ln -s "$lifecycle_token" "$lifecycle_marker"; then
        lifecycle_child_status=0
      else
        rmdir "$lifecycle_root" >/dev/null 2>&1 || true
      fi
    fi
    ln -s "$lifecycle_token:$lifecycle_child_status" "$lifecycle_transaction_outcome" || exit 67
    exit "$lifecycle_child_status"
  ) &
  lifecycle_create_pid=$!

  if ! lifecycle_wait_for_link "$lifecycle_transaction_ready" "$lifecycle_create_pid"; then
    wait "$lifecycle_create_pid" >/dev/null 2>&1 || true
    return 67
  fi
  lifecycle_inject_acquisition_signals
  ln -s "$lifecycle_token" "$lifecycle_transaction_release" || return 67

  if ! lifecycle_wait_for_link "$lifecycle_transaction_outcome" "$lifecycle_create_pid"; then
    wait "$lifecycle_create_pid" >/dev/null 2>&1 || true
    return 67
  fi
  lifecycle_outcome_value=$(readlink "$lifecycle_transaction_outcome") || return 67
  wait "$lifecycle_create_pid" >/dev/null 2>&1 || true
  case "$lifecycle_outcome_value" in
    "$lifecycle_token":0) return 0 ;;
    "$lifecycle_token":73) return 73 ;;
    *) return 67 ;;
  esac
}

lifecycle_acquire_root() {
  ln -s "$lifecycle_token" "$lifecycle_claim" >/dev/null 2>&1 || true

  # The atomic symlink value, not an earlier absence check or intent flag, is
  # the ownership fact. An interrupted ln is resolved by reading that token.
  if lifecycle_link_matches "$lifecycle_claim" "$lifecycle_token"; then
    lifecycle_claim_owned=1
  else
    if [ -n "$lifecycle_first_status" ]; then
      lifecycle_abort_if_latched
    fi
    echo "lifecycle root collision: $lifecycle_root" >&2
    lifecycle_fail 73
  fi

  lifecycle_transaction_status=0
  lifecycle_run_creation_transaction || lifecycle_transaction_status=$?
  if [ "$lifecycle_transaction_status" -eq 0 ] &&
    lifecycle_link_matches "$lifecycle_claim" "$lifecycle_token" &&
    lifecycle_link_matches "$lifecycle_marker" "$lifecycle_token"; then
    lifecycle_root_owned=1
  fi
  lifecycle_cleanup_transaction_files

  if [ -n "$lifecycle_first_status" ]; then
    lifecycle_abort_if_latched
  fi
  case "$lifecycle_transaction_status" in
    0)
      if [ "$lifecycle_root_owned" -ne 1 ]; then
        echo "creation transaction token mismatch: $lifecycle_root" >&2
        lifecycle_fail 67
      fi
      ;;
    73)
      lifecycle_release_claim_failure
      echo "lifecycle root collision: $lifecycle_root" >&2
      lifecycle_fail 73
      ;;
    *)
      echo "lifecycle root creation transaction failed: $lifecycle_root" >&2
      lifecycle_fail 67
      ;;
  esac
}

lifecycle_inject_cleanup_diagnostic() {
  lifecycle_cleanup_injection=${SHUD_REPLAY_TEST_CLEANUP_DIAGNOSTIC:-}
  case "$lifecycle_cleanup_injection" in
    '') ;;
    77)
      echo "injected cleanup diagnostic: 77" >&2
      sh -c 'exit 77' >/dev/null 2>&1 || true
      ;;
    *)
      echo "invalid cleanup diagnostic status: $lifecycle_cleanup_injection" >&2
      ;;
  esac
}

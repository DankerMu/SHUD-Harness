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
lifecycle_create_pid=
lifecycle_transaction_active=0
lifecycle_transaction_adoption_active=0

lifecycle_latch_status() {
  if [ -z "$lifecycle_first_status" ]; then
    lifecycle_first_status=$1
  fi
}

lifecycle_adopt_published_transaction_outcome() {
  if [ "$lifecycle_transaction_active" -ne 1 ] ||
    [ "$lifecycle_transaction_adoption_active" -eq 1 ] ||
    [ ! -L "$lifecycle_transaction_outcome" ]; then
    return
  fi

  # A transaction outcome symlink is the publication boundary. A handled
  # lifecycle event that arrives after it must first adopt the published
  # non-zero result, even when the parent has not yet classified the link in
  # its ordinary settlement flow. Keep zero unpublished as a failure status:
  # a later lifecycle event still wins after a successful child outcome.
  lifecycle_transaction_adoption_active=1
  trap '' HUP INT TERM
  lifecycle_adopted_outcome=$(readlink "$lifecycle_transaction_outcome") || lifecycle_adopted_outcome=
  lifecycle_transaction_adoption_active=0
  case "$lifecycle_adopted_outcome" in
    "$lifecycle_token":73) lifecycle_latch_status 73 ;;
    "$lifecycle_token":0|'') ;;
    *) lifecycle_latch_status 67 ;;
  esac
}

lifecycle_signal_hup() {
  lifecycle_adopt_published_transaction_outcome
  lifecycle_latch_status 129
}

lifecycle_signal_int() {
  lifecycle_adopt_published_transaction_outcome
  lifecycle_latch_status 130
}

lifecycle_signal_term() {
  lifecycle_adopt_published_transaction_outcome
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

lifecycle_reconcile_claim_before_spawn() {
  # Keep the first read signal-capable so a signal already in flight is
  # latched. Then mask handled lifecycle signals and make one authoritative
  # exact-token read before any creation child can be spawned. A transiently
  # interrupted first read can therefore never hide a claim we physically own.
  lifecycle_link_matches "$lifecycle_claim" "$lifecycle_token" >/dev/null 2>&1 || true
  trap '' HUP INT TERM
  if lifecycle_link_matches "$lifecycle_claim" "$lifecycle_token"; then
    lifecycle_claim_owned=1
  fi

  if [ -n "$lifecycle_first_status" ]; then
    lifecycle_abort_if_latched
  fi
  lifecycle_install_signal_handlers
  [ "$lifecycle_claim_owned" -eq 1 ]
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

lifecycle_wait_for_creation_child() {
  while :; do
    wait "$lifecycle_create_pid" >/dev/null 2>&1 || true
    if ! kill -0 "$lifecycle_create_pid" >/dev/null 2>&1; then
      break
    fi
  done
}

lifecycle_mask_latched_signals() {
  if [ -n "$lifecycle_first_status" ]; then
    trap '' HUP INT TERM
  fi
}

lifecycle_latch_transaction_result() {
  lifecycle_transaction_result=$1
  if [ "$lifecycle_transaction_result" -ne 0 ]; then
    lifecycle_latch_status "$lifecycle_transaction_result"
    lifecycle_mask_latched_signals
  fi
}

lifecycle_inject_settlement_events() {
  lifecycle_settlement_event=${SHUD_REPLAY_TEST_SETTLEMENT_EVENT:-}
  lifecycle_settlement_signal=${SHUD_REPLAY_TEST_SETTLEMENT_SIGNAL:-}
  lifecycle_settlement_release=${SHUD_REPLAY_TEST_SETTLEMENT_RELEASE:-}

  if [ -n "$lifecycle_settlement_signal" ]; then
    if [ -n "$lifecycle_settlement_event" ]; then
      : >"$lifecycle_settlement_event"
    fi
    kill -s "$lifecycle_settlement_signal" "$$"
  fi
  if [ -n "$lifecycle_settlement_release" ]; then
    : >"$lifecycle_settlement_release"
  fi
}

lifecycle_link_matches_during_settlement() {
  lifecycle_settlement_match_path=$1
  lifecycle_settlement_match_token=$2
  lifecycle_mask_latched_signals
  if lifecycle_link_matches "$lifecycle_settlement_match_path" "$lifecycle_settlement_match_token"; then
    return 0
  fi
  if [ -n "$lifecycle_first_status" ]; then
    trap '' HUP INT TERM
    lifecycle_link_matches "$lifecycle_settlement_match_path" "$lifecycle_settlement_match_token"
    return $?
  fi
  return 1
}

lifecycle_settle_creation_transaction() {
  lifecycle_settlement_status=$1
  lifecycle_release_published=$2

  # A post-spawn transaction failure is already an externally observable
  # lifecycle result. Latch it before child settlement or ownership probes so
  # a later signal cannot replace the earlier result.
  lifecycle_latch_transaction_result "$lifecycle_settlement_status"

  if [ "$lifecycle_release_published" -ne 1 ] &&
    kill -0 "$lifecycle_create_pid" >/dev/null 2>&1; then
    kill -KILL "$lifecycle_create_pid" >/dev/null 2>&1 || true
  fi

  lifecycle_outcome_value=
  if [ "$lifecycle_release_published" -eq 1 ]; then
    if [ -L "$lifecycle_transaction_outcome" ]; then
      lifecycle_outcome_value=$(readlink "$lifecycle_transaction_outcome") || {
        lifecycle_outcome_value=
        lifecycle_settlement_status=67
        lifecycle_latch_transaction_result "$lifecycle_settlement_status"
      }
      if [ -z "$lifecycle_outcome_value" ] && [ -n "$lifecycle_first_status" ]; then
        trap '' HUP INT TERM
        lifecycle_outcome_value=$(readlink "$lifecycle_transaction_outcome") || lifecycle_outcome_value=
      fi
    elif [ "$lifecycle_settlement_status" -eq 0 ]; then
      lifecycle_settlement_status=67
      lifecycle_latch_transaction_result "$lifecycle_settlement_status"
    fi
  fi

  lifecycle_transaction_result=$lifecycle_settlement_status
  if [ "$lifecycle_transaction_result" -eq 0 ]; then
    case "$lifecycle_outcome_value" in
      "$lifecycle_token":0) lifecycle_transaction_result=0 ;;
      "$lifecycle_token":73) lifecycle_transaction_result=73 ;;
      *) lifecycle_transaction_result=67 ;;
    esac
  fi
  lifecycle_latch_transaction_result "$lifecycle_transaction_result"

  # The published outcome is authoritative before child process completion.
  # Once classified, later signals cannot replace a non-zero result, but the
  # child is still released, reaped, and reconciled before status propagation.
  lifecycle_inject_settlement_events
  lifecycle_wait_for_creation_child
  lifecycle_mask_latched_signals

  # Ownership is a physical fact independent of the command status. Record it
  # only after the child is reaped so EXIT cleanup cannot race later creation.
  if lifecycle_link_matches_during_settlement "$lifecycle_claim" "$lifecycle_token" &&
    lifecycle_link_matches_during_settlement "$lifecycle_marker" "$lifecycle_token"; then
    lifecycle_root_owned=1
  fi

  lifecycle_transaction_active=0
  return "$lifecycle_transaction_result"
}

lifecycle_run_creation_transaction() {
  lifecycle_external_ready=${SHUD_REPLAY_TEST_CREATE_BARRIER_READY:-}
  lifecycle_external_release=${SHUD_REPLAY_TEST_CREATE_BARRIER_RELEASE:-}

  lifecycle_transaction_active=1
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
  if [ -n "${SHUD_REPLAY_TEST_CREATION_PID_FILE:-}" ]; then
    printf '%s\n' "$lifecycle_create_pid" >"$SHUD_REPLAY_TEST_CREATION_PID_FILE" || true
  fi

  lifecycle_settlement_status=0
  lifecycle_release_published=0
  if ! lifecycle_wait_for_link "$lifecycle_transaction_ready" "$lifecycle_create_pid"; then
    lifecycle_settlement_status=67
    lifecycle_latch_transaction_result "$lifecycle_settlement_status"
  else
    lifecycle_inject_acquisition_signals
    ln -s "$lifecycle_token" "$lifecycle_transaction_release" >/dev/null 2>&1 || true
    if lifecycle_link_matches_during_settlement "$lifecycle_transaction_release" "$lifecycle_token"; then
      lifecycle_release_published=1
    else
      lifecycle_settlement_status=67
      lifecycle_latch_transaction_result "$lifecycle_settlement_status"
    fi
  fi

  if [ "$lifecycle_release_published" -eq 1 ] &&
    ! lifecycle_wait_for_link "$lifecycle_transaction_outcome" "$lifecycle_create_pid"; then
    lifecycle_settlement_status=67
    lifecycle_latch_transaction_result "$lifecycle_settlement_status"
  fi
  lifecycle_settle_creation_transaction "$lifecycle_settlement_status" "$lifecycle_release_published"
}

lifecycle_acquire_root() {
  ln -s "$lifecycle_token" "$lifecycle_claim" >/dev/null 2>&1 || true

  # The atomic symlink value, not an earlier absence check or intent flag, is
  # the ownership fact. Reconcile it before child spawn so an interrupted first
  # verification is retried under masked signals and cleanup can release only
  # the exact claim this invocation physically owns.
  if ! lifecycle_reconcile_claim_before_spawn; then
    echo "lifecycle root collision: $lifecycle_root" >&2
    lifecycle_fail 73
  fi

  lifecycle_transaction_status=0
  lifecycle_run_creation_transaction || lifecycle_transaction_status=$?
  lifecycle_mask_latched_signals
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

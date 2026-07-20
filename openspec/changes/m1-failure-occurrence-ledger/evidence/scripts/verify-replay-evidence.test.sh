#!/bin/sh

set -eu

repo_root=$(git rev-parse --show-toplevel)
script_dir=$repo_root/openspec/changes/m1-failure-occurrence-ledger/evidence/scripts
verifier=$script_dir/verify-replay-evidence.sh
self_test=$script_dir/verify-replay-evidence.test.sh
# shellcheck disable=SC1091,SC2154
. "$script_dir/replay-lifecycle.sh"
lifecycle_first_status=${lifecycle_first_status-}
lifecycle_root=${lifecycle_root-}

test_root_parent=${SHUD_REPLAY_TEST_ROOT_PARENT:-${TMPDIR:-/tmp}}
test_root_name=${SHUD_REPLAY_SELF_TEST_ROOT_NAME:-shud-ledger-replay-tests.$$}
self_test_scenario=${SHUD_REPLAY_SELF_TEST_SCENARIO:-matrix}
fixture_root=
fixture_marker=
fixture_marker_checksum=
aux_ready=
aux_release=
aux_signals_ready=
transaction_fault_dir=
transaction_pid_file=
claim_fault_dir=
passed=0
harness_owner_token=${SHUD_REPLAY_TEST_OWNER_TOKEN:-harness.$$}
# Reset background-job INT before the held child installs its own handlers.
# shellcheck disable=SC2016
signal_enabled_child_runner='
$SIG{HUP} = $SIG{INT} = $SIG{TERM} = "DEFAULT";
exec @ARGV or die "exec: $!";
'

test_worktree_is_registered() {
  git -C "$repo_root" worktree list --porcelain |
    grep -F -x "worktree $1" >/dev/null
}

cleanup_exact_child_root() {
  child_root=$1
  child_claim=$2
  expected_child_token=$3
  if [ ! -L "$child_claim" ]; then
    return
  fi
  child_token=$(readlink "$child_claim") || return
  if [ "$child_token" != "$expected_child_token" ]; then
    return
  fi
  if [ ! -L "$child_root/.shud-replay-owner" ] ||
    [ "$(readlink "$child_root/.shud-replay-owner")" != "$child_token" ]; then
    return
  fi
  child_round_1=$child_root/round-1
  child_round_2=$child_root/round-2
  if test_worktree_is_registered "$child_round_1"; then
    git -C "$repo_root" worktree unlock "$child_round_1" >/dev/null 2>&1 || true
    git -C "$repo_root" worktree remove --force "$child_round_1" >/dev/null 2>&1 || true
  fi
  if test_worktree_is_registered "$child_round_2"; then
    git -C "$repo_root" worktree unlock "$child_round_2" >/dev/null 2>&1 || true
    git -C "$repo_root" worktree remove --force "$child_round_2" >/dev/null 2>&1 || true
  fi
  if [ -L "$child_root/.shud-replay-owner" ]; then
    rm "$child_root/.shud-replay-owner" >/dev/null 2>&1 || true
  fi
  if rmdir "$child_root" >/dev/null 2>&1 && [ -L "$child_claim" ]; then
    rm "$child_claim" >/dev/null 2>&1 || true
  elif [ -d "$child_root" ] && [ ! -e "$child_root/.shud-replay-owner" ]; then
    ln -s "$child_token" "$child_root/.shud-replay-owner" >/dev/null 2>&1 || true
  fi
}

cleanup_fixture() {
  if [ -n "$fixture_marker" ] && [ -f "$fixture_marker" ] &&
    [ "$(cksum <"$fixture_marker")" = "$fixture_marker_checksum" ]; then
    rm "$fixture_marker" >/dev/null 2>&1 || true
  fi
  if [ -n "$fixture_root" ]; then
    rmdir "$fixture_root" >/dev/null 2>&1 || true
  fi
  fixture_marker=
  fixture_marker_checksum=
  fixture_root=
}

cleanup_test_parent() {
  # First cleanup command: stop EXIT recursion and mask every handled signal.
  lifecycle_mask_all_handlers
  lifecycle_latch_status "$1"
  lifecycle_inject_cleanup_diagnostic
  cleanup_fixture
  if [ -n "$aux_ready" ]; then rm "$aux_ready" >/dev/null 2>&1 || true; fi
  if [ -n "$aux_release" ]; then rm "$aux_release" >/dev/null 2>&1 || true; fi
  if [ -n "$aux_signals_ready" ]; then rm "$aux_signals_ready" >/dev/null 2>&1 || true; fi
  if [ -n "$transaction_fault_dir" ] && [ -d "$transaction_fault_dir" ]; then
    rm -rf "$transaction_fault_dir" >/dev/null 2>&1 || true
  fi
  if [ -n "$claim_fault_dir" ] && [ -d "$claim_fault_dir" ]; then
    rm -rf "$claim_fault_dir" >/dev/null 2>&1 || true
  fi
  lifecycle_cleanup_root_failure
  exit "$lifecycle_first_status"
}

assert_child_absent() {
  assertion_name=$1
  assertion_root_name=$2
  assertion_root="$lifecycle_root/$assertion_root_name"
  assertion_claim="$lifecycle_root/.$assertion_root_name.claim"
  if test_worktree_is_registered "$assertion_root/round-1" ||
    test_worktree_is_registered "$assertion_root/round-2" ||
    [ -e "$assertion_root" ] || [ -L "$assertion_root" ] ||
    [ -e "$assertion_claim" ] || [ -L "$assertion_claim" ]; then
    echo "replay residue after $assertion_name" >&2
    return 1
  fi
}

record_pass() {
  passed=$((passed + 1))
}

run_verifier_case() {
  case_name=$1
  scenario=$2
  expected=$3
  cleanup_diagnostic=${4:-}
  root_name="case-$case_name"
  set +e
  SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
    SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_TEST_SCENARIO="$scenario" \
    SHUD_REPLAY_TEST_CLEANUP_DIAGNOSTIC="$cleanup_diagnostic" \
    "$verifier" >/dev/null 2>&1
  actual=$?
  set -e
  if [ "$actual" -ne "$expected" ]; then
    echo "$case_name exited $actual, expected $expected" >&2
    return 1
  fi
  assert_child_absent "$case_name" "$root_name"
  record_pass
}

run_harness_case() {
  case_name=$1
  scenario=$2
  expected=$3
  root_name="case-$case_name"
  set +e
  SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
    SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_SCENARIO="$scenario" \
    "$self_test" >/dev/null 2>&1
  actual=$?
  set -e
  if [ "$actual" -ne "$expected" ]; then
    echo "$case_name exited $actual, expected $expected" >&2
    return 1
  fi
  assert_child_absent "$case_name" "$root_name"
  record_pass
}

run_decode_tail_signal_case() {
  case_name=$1
  child_kind=$2
  first_signal=$3
  second_signal=$4
  expected=$5
  root_name="case-$case_name"
  transaction_fault_dir="$lifecycle_root/$case_name.decode-tail-probe"
  first_event="$transaction_fault_dir/first-signal-fired"
  second_event="$transaction_fault_dir/second-signal-fired"
  mkdir -m 700 "$transaction_fault_dir"

  case "$child_kind" in
    verifier) tail_command=$verifier ;;
    harness) tail_command=$self_test ;;
    *)
      echo "unknown decode-tail child kind: $child_kind" >&2
      rm -rf "$transaction_fault_dir"
      transaction_fault_dir=
      return 1
      ;;
  esac

  set +e
  SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
    SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_SCENARIO=decode_tail_probe \
    SHUD_REPLAY_TEST_OWNER_TOKEN="decode-tail-$case_name" \
    SHUD_REPLAY_TEST_DECODE_TAIL_SIGNAL_FIRST="$first_signal" \
    SHUD_REPLAY_TEST_DECODE_TAIL_SIGNAL_SECOND="$second_signal" \
    SHUD_REPLAY_TEST_DECODE_TAIL_FIRST_EVENT="$first_event" \
    SHUD_REPLAY_TEST_DECODE_TAIL_SECOND_EVENT="$second_event" \
    "$tail_command" >/dev/null 2>&1
  actual=$?
  set -e

  tail_failed=0
  if [ "$actual" -ne "$expected" ]; then
    echo "$case_name exited $actual, expected $expected" >&2
    tail_failed=1
  fi
  if [ ! -e "$first_event" ]; then
    echo "$case_name did not inject its first decode-tail signal" >&2
    tail_failed=1
  fi
  if [ -n "$second_signal" ] && [ ! -e "$second_event" ]; then
    echo "$case_name did not inject its second decode-tail signal" >&2
    tail_failed=1
  fi

  rm -rf "$transaction_fault_dir"
  transaction_fault_dir=
  if ! assert_child_absent "$case_name" "$root_name"; then
    tail_failed=1
  fi
  if [ "$tail_failed" -ne 0 ]; then return 1; fi
  record_pass
}

run_committed_outcome_signal_case() {
  case_name=$1
  child_kind=$2
  pre_clear_signal=$3
  post_clear_signal=$4
  second_read_mode=$5
  expected=$6
  root_name="case-$case_name"
  child_token="committed-outcome-$case_name"
  child_root="$lifecycle_root/$root_name"
  child_claim="$lifecycle_root/.$root_name.claim"
  child_marker="$child_root/.shud-replay-owner"
  transaction_fault_dir="$lifecycle_root/$case_name.committed-outcome-probe"
  transaction_probe_dir=$transaction_fault_dir
  transaction_pid_file="$transaction_fault_dir/creation-pids"
  outcome_published_event="$transaction_fault_dir/outcome-published"
  pre_clear_event="$transaction_fault_dir/pre-clear-signal-fired"
  post_clear_event="$transaction_fault_dir/post-clear-signal-fired"
  second_read_event="$transaction_fault_dir/second-read-fired"
  settlement_release="$transaction_fault_dir/settlement-release"
  watchdog_event="$transaction_fault_dir/watchdog-fired"
  mkdir -m 700 "$transaction_fault_dir"

  cat >"$transaction_fault_dir/ln" <<'EOF'
#!/bin/sh
last_arg=
for arg do last_arg=$arg; done
case "$last_arg" in
  *.transaction.*.outcome)
    /bin/ln "$@" || exit $?
    printf '%s\n' "$PPID" >>"$SHUD_REPLAY_TEST_CREATION_PID_FILE"
    : >"$SHUD_REPLAY_TEST_OUTCOME_PUBLISHED_EVENT"
    hold_attempt=0
    while [ ! -e "$SHUD_REPLAY_TEST_SETTLEMENT_RELEASE" ]; do
      hold_attempt=$((hold_attempt + 1))
      if [ "$hold_attempt" -ge 20 ]; then
        : >"$SHUD_REPLAY_TEST_WATCHDOG_EVENT"
        kill -KILL "$PPID" >/dev/null 2>&1 || true
        exit 124
      fi
      sleep 0.05
    done
    exit 0
    ;;
esac
exec /bin/ln "$@"
EOF
  cat >"$transaction_fault_dir/readlink" <<'EOF'
#!/bin/sh
case "$1" in
  *.transaction.*.outcome)
    if [ -e "$SHUD_REPLAY_TEST_POST_CLASSIFICATION_EVENT" ] &&
      [ ! -e "$SHUD_REPLAY_TEST_SECOND_READ_EVENT" ]; then
      creation_child_live=0
      while IFS= read -r creation_pid; do
        case "$creation_pid" in
          ''|*[!0-9]*) ;;
          *)
            if kill -0 "$creation_pid" >/dev/null 2>&1; then
              creation_child_live=1
            fi
            ;;
        esac
      done <"$SHUD_REPLAY_TEST_CREATION_PID_FILE"
      if [ "$creation_child_live" -eq 1 ]; then
        : >"$SHUD_REPLAY_TEST_SECOND_READ_EVENT"
        case "$SHUD_REPLAY_TEST_SECOND_READ_MODE" in
          fail) exit 1 ;;
          73)
            outcome_value=$(/usr/bin/readlink "$@") || exit $?
            printf '%s:73\n' "${outcome_value%%:*}"
            exit 0
            ;;
        esac
      fi
    fi
    ;;
esac
exec /usr/bin/readlink "$@"
EOF
  chmod 700 "$transaction_fault_dir/ln" "$transaction_fault_dir/readlink"

  case "$child_kind" in
    verifier) transaction_command=$verifier ;;
    harness) transaction_command=$self_test ;;
    *)
      echo "unknown committed-outcome child kind: $child_kind" >&2
      rm -rf "$transaction_fault_dir"
      transaction_fault_dir=
      return 1
      ;;
  esac

  set +e
  PATH="$transaction_fault_dir:$PATH" \
    SHUD_REPLAY_TEST_CREATION_PID_FILE="$transaction_pid_file" \
    SHUD_REPLAY_TEST_OUTCOME_PUBLISHED_EVENT="$outcome_published_event" \
    SHUD_REPLAY_TEST_DECODE_TAIL_SIGNAL_FIRST="$pre_clear_signal" \
    SHUD_REPLAY_TEST_DECODE_TAIL_FIRST_EVENT="$pre_clear_event" \
    SHUD_REPLAY_TEST_POST_CLASSIFICATION_SIGNAL="$post_clear_signal" \
    SHUD_REPLAY_TEST_POST_CLASSIFICATION_EVENT="$post_clear_event" \
    SHUD_REPLAY_TEST_SECOND_READ_EVENT="$second_read_event" \
    SHUD_REPLAY_TEST_SECOND_READ_MODE="$second_read_mode" \
    SHUD_REPLAY_TEST_SETTLEMENT_RELEASE="$settlement_release" \
    SHUD_REPLAY_TEST_WATCHDOG_EVENT="$watchdog_event" \
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
    SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_SCENARIO=decode_tail_probe \
    SHUD_REPLAY_TEST_SCENARIO=normal \
    SHUD_REPLAY_TEST_OWNER_TOKEN="$child_token" \
    "$transaction_command" >/dev/null 2>&1
  actual=$?
  set -e

  committed_failed=0
  if [ "$actual" -ne "$expected" ]; then
    echo "$case_name exited $actual, expected $expected" >&2
    committed_failed=1
  fi
  if [ ! -e "$outcome_published_event" ]; then
    echo "$case_name did not publish token:0 before classification" >&2
    committed_failed=1
  fi
  if [ -n "$pre_clear_signal" ] && [ ! -e "$pre_clear_event" ]; then
    echo "$case_name did not inject its pre-clear signal" >&2
    committed_failed=1
  fi
  if [ ! -e "$post_clear_event" ]; then
    echo "$case_name did not inject its post-clear signal" >&2
    committed_failed=1
  fi
  if [ -e "$second_read_event" ]; then
    echo "$case_name re-adopted the committed token:0 outcome" >&2
    committed_failed=1
  fi
  if [ -e "$watchdog_event" ]; then
    echo "$case_name used its watchdog instead of settlement release" >&2
    committed_failed=1
  fi
  if [ ! -s "$transaction_pid_file" ]; then
    echo "$case_name did not identify the creation child" >&2
    committed_failed=1
  else
    while IFS= read -r child_pid; do
      case "$child_pid" in
        ''|*[!0-9]*)
          echo "$case_name recorded invalid creation pid: $child_pid" >&2
          committed_failed=1
          ;;
        *)
          if kill -0 "$child_pid" >/dev/null 2>&1; then
            echo "$case_name retained live creation child $child_pid" >&2
            committed_failed=1
          fi
          ;;
      esac
    done <"$transaction_pid_file"
  fi
  if find "$lifecycle_root" -maxdepth 1 -name ".$root_name.claim.transaction.*" -print -quit |
    grep . >/dev/null; then
    echo "$case_name retained transaction links" >&2
    committed_failed=1
  fi
  if [ -e "$child_claim" ] || [ -L "$child_claim" ] ||
    [ -e "$child_marker" ] || [ -L "$child_marker" ] ||
    [ -e "$child_root" ] || [ -L "$child_root" ]; then
    echo "$case_name retained owned lifecycle residue" >&2
    committed_failed=1
  fi
  if test_worktree_is_registered "$child_root/round-1" ||
    test_worktree_is_registered "$child_root/round-2"; then
    echo "$case_name retained a registered worktree" >&2
    committed_failed=1
  fi

  cleanup_transaction_fault_residue "$child_root" "$child_claim" "$child_token"
  transaction_fault_dir=
  transaction_pid_file=
  if [ "$committed_failed" -ne 0 ]; then return 1; fi
  record_pass
}

run_deferred_transfer_case() {
  case_name=$1
  child_kind=$2
  transfer_path=$3
  later_signal=$4
  root_name="case-$case_name"
  child_token="deferred-transfer-$case_name"
  child_root="$lifecycle_root/$root_name"
  child_claim="$lifecycle_root/.$root_name.claim"
  child_marker="$child_root/.shud-replay-owner"
  transaction_fault_dir="$lifecycle_root/$case_name.deferred-transfer-probe"
  transaction_probe_dir=$transaction_fault_dir
  transaction_pid_file="$transaction_fault_dir/creation-pids"
  outcome_attempted_event="$transaction_fault_dir/outcome-attempted"
  outcome_published_event="$transaction_fault_dir/outcome-published"
  first_event="$transaction_fault_dir/first-hup-fired"
  transfer_release="$transaction_fault_dir/transfer-release"
  transfer_event="$transaction_fault_dir/transfer-events"
  later_event="$transaction_fault_dir/later-signal-fired"
  nested_event="$transaction_fault_dir/nested-term-fired"
  current_event="$transaction_fault_dir/current-event-attempts"
  decode_entry_event="$transaction_fault_dir/decode-entries"
  settlement_release="$transaction_fault_dir/settlement-release"
  watchdog_event="$transaction_fault_dir/watchdog-fired"
  mkdir -m 700 "$transaction_fault_dir"

  cat >"$transaction_fault_dir/ln" <<'EOF'
#!/bin/sh
last_arg=
for arg do last_arg=$arg; done
case "$last_arg" in
  *.transaction.*.outcome)
    printf '%s\n' "$PPID" >>"$SHUD_REPLAY_TEST_CREATION_PID_FILE"
    : >"$SHUD_REPLAY_TEST_OUTCOME_ATTEMPTED_EVENT"
    if [ "$SHUD_REPLAY_TEST_DEFERRED_TRANSFER_PATH" = negative_wait ]; then
      hold_path=$SHUD_REPLAY_TEST_TRANSFER_RELEASE
    else
      /bin/ln "$@" || exit $?
      : >"$SHUD_REPLAY_TEST_OUTCOME_PUBLISHED_EVENT"
      hold_path=$SHUD_REPLAY_TEST_SETTLEMENT_RELEASE
    fi
    hold_attempt=0
    while [ ! -e "$hold_path" ]; do
      hold_attempt=$((hold_attempt + 1))
      if [ "$hold_attempt" -ge 40 ]; then
        : >"$SHUD_REPLAY_TEST_WATCHDOG_EVENT"
        kill -KILL "$PPID" >/dev/null 2>&1 || true
        exit 124
      fi
      sleep 0.05
    done
    if [ "$SHUD_REPLAY_TEST_DEFERRED_TRANSFER_PATH" = negative_wait ]; then
      /bin/ln "$@" || exit $?
      : >"$SHUD_REPLAY_TEST_OUTCOME_PUBLISHED_EVENT"
    fi
    exit 0
    ;;
esac
exec /bin/ln "$@"
EOF
  chmod 700 "$transaction_fault_dir/ln"

  case "$child_kind" in
    verifier) transaction_command=$verifier ;;
    harness) transaction_command=$self_test ;;
    *)
      echo "unknown deferred-transfer child kind: $child_kind" >&2
      rm -rf "$transaction_fault_dir"
      transaction_fault_dir=
      return 1
      ;;
  esac

  outcome_wait_signal=
  decode_tail_signal=
  if [ "$transfer_path" = negative_wait ]; then
    outcome_wait_signal=HUP
  else
    decode_tail_signal=HUP
  fi

  set +e
  PATH="$transaction_fault_dir:$PATH" \
    SHUD_REPLAY_TEST_CREATION_PID_FILE="$transaction_pid_file" \
    SHUD_REPLAY_TEST_OUTCOME_ATTEMPTED_EVENT="$outcome_attempted_event" \
    SHUD_REPLAY_TEST_OUTCOME_PUBLISHED_EVENT="$outcome_published_event" \
    SHUD_REPLAY_TEST_DEFERRED_TRANSFER_PATH="$transfer_path" \
    SHUD_REPLAY_TEST_OUTCOME_WAIT_SIGNAL="$outcome_wait_signal" \
    SHUD_REPLAY_TEST_OUTCOME_WAIT_EVENT="$first_event" \
    SHUD_REPLAY_TEST_DECODE_TAIL_SIGNAL_FIRST="$decode_tail_signal" \
    SHUD_REPLAY_TEST_DECODE_TAIL_FIRST_EVENT="$first_event" \
    SHUD_REPLAY_TEST_TRANSFER_RELEASE="$transfer_release" \
    SHUD_REPLAY_TEST_DEFERRED_TRANSFER_EVENT="$transfer_event" \
    SHUD_REPLAY_TEST_DEFERRED_TRANSFER_SIGNAL="$later_signal" \
    SHUD_REPLAY_TEST_DEFERRED_TRANSFER_SIGNAL_EVENT="$later_event" \
    SHUD_REPLAY_TEST_DEFERRED_TRANSFER_NESTED_SIGNAL=TERM \
    SHUD_REPLAY_TEST_DEFERRED_TRANSFER_NESTED_EVENT="$nested_event" \
    SHUD_REPLAY_TEST_DEFERRED_TRANSFER_CURRENT_EVENT="$current_event" \
    SHUD_REPLAY_TEST_DECODE_ENTRY_EVENT="$decode_entry_event" \
    SHUD_REPLAY_TEST_SETTLEMENT_RELEASE="$settlement_release" \
    SHUD_REPLAY_TEST_WATCHDOG_EVENT="$watchdog_event" \
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
    SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_SCENARIO=decode_tail_probe \
    SHUD_REPLAY_TEST_SCENARIO=normal \
    SHUD_REPLAY_TEST_OWNER_TOKEN="$child_token" \
    "$transaction_command" >/dev/null 2>&1
  actual=$?
  set -e

  transfer_failed=0
  if [ "$actual" -ne 129 ]; then
    echo "$case_name exited $actual, expected 129" >&2
    transfer_failed=1
  fi
  for required_event in "$outcome_attempted_event" "$outcome_published_event" \
    "$first_event" "$later_event" "$nested_event" "$settlement_release"; do
    if [ ! -e "$required_event" ]; then
      echo "$case_name missed required event: $required_event" >&2
      transfer_failed=1
    fi
  done
  transfer_count=0
  if [ -f "$transfer_event" ]; then
    transfer_count=$(wc -l <"$transfer_event" | tr -d ' ')
  fi
  if [ "$transfer_count" -ne 1 ] ||
    [ "$(sed -n '1p' "$transfer_event" 2>/dev/null || true)" != 129 ]; then
    echo "$case_name transferred deferred HUP $transfer_count times, expected once" >&2
    transfer_failed=1
  fi
  current_count=0
  if [ -f "$current_event" ]; then
    current_count=$(wc -l <"$current_event" | tr -d ' ')
  fi
  current_first=$(sed -n '1p' "$current_event" 2>/dev/null || true)
  current_second=$(sed -n '2p' "$current_event" 2>/dev/null || true)
  if [ "$current_count" -ne 2 ] ||
    [ "$current_first" != "129:143:129" ] ||
    [ "$current_second" != "129:130:129" ]; then
    echo "$case_name current events were $current_first,$current_second; expected 129:143:129,129:130:129" >&2
    transfer_failed=1
  fi
  decode_entry_count=0
  if [ -f "$decode_entry_event" ]; then
    decode_entry_count=$(wc -l <"$decode_entry_event" | tr -d ' ')
  fi
  if [ "$decode_entry_count" -ne 1 ]; then
    echo "$case_name classified/adopted its outcome $decode_entry_count times, expected 1" >&2
    transfer_failed=1
  fi
  if [ -e "$watchdog_event" ]; then
    echo "$case_name used its watchdog instead of mandatory child settlement" >&2
    transfer_failed=1
  fi
  if [ ! -s "$transaction_pid_file" ]; then
    echo "$case_name did not identify the creation child" >&2
    transfer_failed=1
  else
    while IFS= read -r child_pid; do
      case "$child_pid" in
        ''|*[!0-9]*)
          echo "$case_name recorded invalid creation pid: $child_pid" >&2
          transfer_failed=1
          ;;
        *)
          if kill -0 "$child_pid" >/dev/null 2>&1; then
            echo "$case_name retained live creation child $child_pid" >&2
            transfer_failed=1
          fi
          ;;
      esac
    done <"$transaction_pid_file"
  fi
  if find "$lifecycle_root" -maxdepth 1 -name ".$root_name.claim.transaction.*" -print -quit |
    grep . >/dev/null; then
    echo "$case_name retained transaction links" >&2
    transfer_failed=1
  fi
  if [ -e "$child_claim" ] || [ -L "$child_claim" ] ||
    [ -e "$child_marker" ] || [ -L "$child_marker" ] ||
    [ -e "$child_root" ] || [ -L "$child_root" ]; then
    echo "$case_name retained owned lifecycle residue" >&2
    transfer_failed=1
  fi
  if test_worktree_is_registered "$child_root/round-1" ||
    test_worktree_is_registered "$child_root/round-2"; then
    echo "$case_name retained a registered worktree" >&2
    transfer_failed=1
  fi

  cleanup_transaction_fault_residue "$child_root" "$child_claim" "$child_token"
  if [ -e "$child_root" ] || [ -L "$child_root" ] ||
    [ -e "$transaction_probe_dir" ]; then
    echo "$case_name retained deferred-transfer probe residue" >&2
    transfer_failed=1
  fi
  if [ "$transfer_failed" -ne 0 ]; then return 1; fi
  record_pass
}

run_outcome_disappearance_case() {
  case_name=$1
  child_kind=$2
  restore_outcome=$3
  expected=$4
  root_name="case-$case_name"
  child_token="outcome-disappearance-$case_name"
  child_root="$lifecycle_root/$root_name"
  child_claim="$lifecycle_root/.$root_name.claim"
  child_marker="$child_root/.shud-replay-owner"
  transaction_fault_dir="$lifecycle_root/$case_name.outcome-disappearance-probe"
  transaction_probe_dir=$transaction_fault_dir
  transaction_pid_file="$transaction_fault_dir/creation-pids"
  outcome_published_event="$transaction_fault_dir/outcome-published"
  disappearance_event="$transaction_fault_dir/outcome-removed"
  restoration_event="$transaction_fault_dir/outcome-restored"
  signal_event="$transaction_fault_dir/term-fired"
  decode_entry_event="$transaction_fault_dir/decode-entries"
  readoption_event="$transaction_fault_dir/forbidden-readoption"
  settlement_release="$transaction_fault_dir/settlement-release"
  watchdog_event="$transaction_fault_dir/watchdog-fired"
  mkdir -m 700 "$transaction_fault_dir"

  cat >"$transaction_fault_dir/ln" <<'EOF'
#!/bin/sh
last_arg=
for arg do last_arg=$arg; done
case "$last_arg" in
  *.transaction.*.outcome)
    /bin/ln "$@" || exit $?
    printf '%s\n' "$PPID" >>"$SHUD_REPLAY_TEST_CREATION_PID_FILE"
    : >"$SHUD_REPLAY_TEST_OUTCOME_PUBLISHED_EVENT"
    hold_attempt=0
    while [ ! -e "$SHUD_REPLAY_TEST_SETTLEMENT_RELEASE" ]; do
      hold_attempt=$((hold_attempt + 1))
      if [ "$hold_attempt" -ge 20 ]; then
        : >"$SHUD_REPLAY_TEST_WATCHDOG_EVENT"
        kill -KILL "$PPID" >/dev/null 2>&1 || true
        exit 124
      fi
      sleep 0.05
    done
    exit 0
    ;;
esac
exec /bin/ln "$@"
EOF
  cat >"$transaction_fault_dir/outcome-witnessed-hook" <<'EOF'
#!/bin/sh
rm "$1" || exit $?
: >"$SHUD_REPLAY_TEST_DISAPPEARANCE_EVENT"
EOF
  cat >"$transaction_fault_dir/post-classification-hook" <<'EOF'
#!/bin/sh
if [ -e "$SHUD_REPLAY_TEST_RESTORATION_EVENT" ]; then
  exit 0
fi
/bin/ln -s "$2:73" "$1" || exit $?
: >"$SHUD_REPLAY_TEST_RESTORATION_EVENT"
EOF
  cat >"$transaction_fault_dir/readlink" <<'EOF'
#!/bin/sh
case "$1" in
  *.transaction.*.outcome)
    if [ ! -e "$SHUD_REPLAY_TEST_SETTLEMENT_RELEASE" ]; then
      : >"$SHUD_REPLAY_TEST_READOPTION_EVENT"
    fi
    ;;
esac
exec /usr/bin/readlink "$@"
EOF
  chmod 700 "$transaction_fault_dir/ln" \
    "$transaction_fault_dir/outcome-witnessed-hook" \
    "$transaction_fault_dir/post-classification-hook" \
    "$transaction_fault_dir/readlink"

  case "$child_kind" in
    verifier) transaction_command=$verifier ;;
    harness) transaction_command=$self_test ;;
    *)
      echo "unknown outcome-disappearance child kind: $child_kind" >&2
      rm -rf "$transaction_fault_dir"
      transaction_fault_dir=
      return 1
      ;;
  esac

  post_classification_hook=
  decode_tail_signal=
  post_classification_signal=
  if [ "$restore_outcome" -eq 1 ]; then
    post_classification_hook="$transaction_fault_dir/post-classification-hook"
    post_classification_signal=TERM
  else
    decode_tail_signal=TERM
  fi

  set +e
  PATH="$transaction_fault_dir:$PATH" \
    SHUD_REPLAY_TEST_CREATION_PID_FILE="$transaction_pid_file" \
    SHUD_REPLAY_TEST_OUTCOME_PUBLISHED_EVENT="$outcome_published_event" \
    SHUD_REPLAY_TEST_OUTCOME_WITNESSED_HOOK="$transaction_fault_dir/outcome-witnessed-hook" \
    SHUD_REPLAY_TEST_DISAPPEARANCE_EVENT="$disappearance_event" \
    SHUD_REPLAY_TEST_POST_CLASSIFICATION_HOOK="$post_classification_hook" \
    SHUD_REPLAY_TEST_RESTORATION_EVENT="$restoration_event" \
    SHUD_REPLAY_TEST_DECODE_TAIL_SIGNAL_FIRST="$decode_tail_signal" \
    SHUD_REPLAY_TEST_DECODE_TAIL_FIRST_EVENT="$signal_event" \
    SHUD_REPLAY_TEST_POST_CLASSIFICATION_SIGNAL="$post_classification_signal" \
    SHUD_REPLAY_TEST_POST_CLASSIFICATION_EVENT="$signal_event" \
    SHUD_REPLAY_TEST_DECODE_ENTRY_EVENT="$decode_entry_event" \
    SHUD_REPLAY_TEST_READOPTION_EVENT="$readoption_event" \
    SHUD_REPLAY_TEST_SETTLEMENT_RELEASE="$settlement_release" \
    SHUD_REPLAY_TEST_WATCHDOG_EVENT="$watchdog_event" \
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
    SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_SCENARIO=decode_tail_probe \
    SHUD_REPLAY_TEST_SCENARIO=normal \
    SHUD_REPLAY_TEST_OWNER_TOKEN="$child_token" \
    "$transaction_command" >/dev/null 2>&1
  actual=$?
  set -e

  disappearance_failed=0
  if [ "$actual" -ne "$expected" ]; then
    echo "$case_name exited $actual, expected $expected" >&2
    disappearance_failed=1
  fi
  if [ ! -e "$outcome_published_event" ]; then
    echo "$case_name did not publish its outcome before the ordinary witness" >&2
    disappearance_failed=1
  fi
  if [ ! -e "$disappearance_event" ]; then
    echo "$case_name did not remove the witnessed outcome before classification" >&2
    disappearance_failed=1
  fi
  if [ ! -e "$signal_event" ]; then
    echo "$case_name did not inject its later TERM" >&2
    disappearance_failed=1
  fi
  if [ "$restore_outcome" -eq 1 ]; then
    if [ ! -e "$restoration_event" ]; then
      echo "$case_name did not restore token:73 before its later TERM" >&2
      disappearance_failed=1
    fi
    if [ -e "$readoption_event" ]; then
      echo "$case_name re-adopted the restored token:73 outcome" >&2
      disappearance_failed=1
    fi
  elif [ -e "$restoration_event" ]; then
    echo "$case_name unexpectedly restored its disappeared outcome" >&2
    disappearance_failed=1
  fi
  decode_entry_count=0
  if [ -f "$decode_entry_event" ]; then
    decode_entry_count=$(wc -l <"$decode_entry_event" | tr -d ' ')
  fi
  if [ "$decode_entry_count" -ne 1 ]; then
    echo "$case_name classified its outcome $decode_entry_count times, expected 1" >&2
    disappearance_failed=1
  fi
  if [ -e "$watchdog_event" ]; then
    echo "$case_name used its watchdog instead of settlement release" >&2
    disappearance_failed=1
  fi
  if [ ! -e "$settlement_release" ]; then
    echo "$case_name did not release its creation child during settlement" >&2
    disappearance_failed=1
  fi
  if [ ! -s "$transaction_pid_file" ]; then
    echo "$case_name did not identify the creation child" >&2
    disappearance_failed=1
  else
    while IFS= read -r child_pid; do
      case "$child_pid" in
        ''|*[!0-9]*)
          echo "$case_name recorded invalid creation pid: $child_pid" >&2
          disappearance_failed=1
          ;;
        *)
          if kill -0 "$child_pid" >/dev/null 2>&1; then
            echo "$case_name retained live creation child $child_pid" >&2
            disappearance_failed=1
          fi
          ;;
      esac
    done <"$transaction_pid_file"
  fi
  if find "$lifecycle_root" -maxdepth 1 -name ".$root_name.claim.transaction.*" -print -quit |
    grep . >/dev/null; then
    echo "$case_name retained transaction links" >&2
    disappearance_failed=1
  fi
  if [ -e "$child_claim" ] || [ -L "$child_claim" ] ||
    [ -e "$child_marker" ] || [ -L "$child_marker" ] ||
    [ -e "$child_root" ] || [ -L "$child_root" ]; then
    echo "$case_name retained owned lifecycle residue" >&2
    disappearance_failed=1
  fi
  if test_worktree_is_registered "$child_root/round-1" ||
    test_worktree_is_registered "$child_root/round-2"; then
    echo "$case_name retained a registered worktree" >&2
    disappearance_failed=1
  fi

  cleanup_transaction_fault_residue "$child_root" "$child_claim" "$child_token"
  if [ -e "$child_root" ] || [ -L "$child_root" ] ||
    [ -e "$transaction_probe_dir" ]; then
    echo "$case_name retained outcome-disappearance probe residue" >&2
    disappearance_failed=1
  fi
  if [ "$disappearance_failed" -ne 0 ]; then return 1; fi
  record_pass
}

create_collision_fixture() {
  fixture_name=$1
  fixture_kind=${2:-marker}
  fixture_candidate_root="$lifecycle_root/$fixture_name"
  fixture_candidate_marker="$fixture_candidate_root/foreign-marker"
  mkdir -m 700 "$fixture_candidate_root"
  fixture_root=$fixture_candidate_root
  if [ "$fixture_kind" = marker ]; then
    printf '%s\n' foreign >"$fixture_candidate_marker"
    fixture_marker=$fixture_candidate_marker
    fixture_marker_checksum=$(cksum <"$fixture_marker")
  fi
}

assert_fixture_unchanged() {
  if [ ! -d "$fixture_root" ]; then
    echo "$1 modified the foreign collision fixture" >&2
    return 1
  fi
  if [ -n "$fixture_marker" ]; then
    if [ ! -f "$fixture_marker" ] ||
      [ "$(cksum <"$fixture_marker")" != "$fixture_marker_checksum" ]; then
      echo "$1 modified the foreign collision fixture" >&2
      return 1
    fi
  elif find "$fixture_root" -mindepth 1 -print -quit | grep . >/dev/null; then
    echo "$1 modified the foreign empty target" >&2
    return 1
  fi
}

run_collision_case() {
  case_name=$1
  child_kind=$2
  forced_status=${3:-}
  fixture_kind=${4:-marker}
  fixture_name="fixture-$case_name"
  create_collision_fixture "$fixture_name" "$fixture_kind"
  set +e
  if [ -n "$forced_status" ]; then
    actual=$forced_status
  elif [ "$child_kind" = verifier ]; then
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
      SHUD_REPLAY_TEST_ROOT_NAME="$fixture_name" \
      "$verifier" >/dev/null 2>&1
    actual=$?
  else
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
      SHUD_REPLAY_SELF_TEST_ROOT_NAME="$fixture_name" \
      SHUD_REPLAY_SELF_TEST_SCENARIO=matrix \
      "$self_test" >/dev/null 2>&1
    actual=$?
  fi
  set -e
  if [ -n "$forced_status" ]; then
    lifecycle_latch_status "$actual"
    lifecycle_abort_if_latched
  fi
  if [ "$actual" -ne 73 ]; then
    echo "$case_name exited $actual, expected 73" >&2
    return 1
  fi
  assert_fixture_unchanged "$case_name"
  cleanup_fixture
  assert_child_absent "$case_name" "$fixture_name"
  record_pass
}

wait_for_ready() {
  wait_attempt=0
  while [ ! -e "$1" ] && [ ! -L "$1" ]; do
    wait_attempt=$((wait_attempt + 1))
    if [ "$wait_attempt" -gt 5 ]; then
      return 1
    fi
    sleep 1
  done
}

run_foreign_actor_race_case() {
  case_name=$1
  child_kind=$2
  root_name="case-$case_name"
  child_token="foreign-race-$case_name"
  aux_ready="$lifecycle_root/$case_name.ready"
  aux_release="$lifecycle_root/$case_name.release"

  if [ "$child_kind" = verifier ]; then
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
      SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
      SHUD_REPLAY_TEST_OWNER_TOKEN="$child_token" \
      SHUD_REPLAY_TEST_CREATE_BARRIER_READY="$aux_ready" \
      SHUD_REPLAY_TEST_CREATE_BARRIER_RELEASE="$aux_release" \
      "$verifier" >/dev/null 2>&1 &
  else
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
      SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
      SHUD_REPLAY_SELF_TEST_SCENARIO=matrix \
      SHUD_REPLAY_TEST_OWNER_TOKEN="$child_token" \
      SHUD_REPLAY_TEST_CREATE_BARRIER_READY="$aux_ready" \
      SHUD_REPLAY_TEST_CREATE_BARRIER_RELEASE="$aux_release" \
      "$self_test" >/dev/null 2>&1 &
  fi
  child_pid=$!

  if ! wait_for_ready "$aux_ready"; then
    : >"$aux_release"
    wait "$child_pid" || true
    echo "$case_name creation child did not reach the barrier" >&2
    return 1
  fi

  create_collision_fixture "$root_name" marker
  : >"$aux_release"
  set +e
  wait "$child_pid"
  child_status=$?
  set -e

  rm "$aux_ready" "$aux_release"
  aux_ready=
  aux_release=
  if [ "$child_status" -ne 73 ]; then
    echo "$case_name exited $child_status, expected 73" >&2
    return 1
  fi
  assert_fixture_unchanged "$case_name"
  race_claim="$lifecycle_root/.$root_name.claim"
  if [ -e "$race_claim" ] || [ -L "$race_claim" ]; then
    echo "$case_name retained its exact claim" >&2
    return 1
  fi
  cleanup_fixture
  assert_child_absent "$case_name" "$root_name"
  record_pass
}

run_concurrent_case() {
  case_name=$1
  child_kind=$2
  root_name="case-$case_name"
  winner_token="winner-$case_name"
  aux_ready="$lifecycle_root/$case_name.ready"
  aux_release="$lifecycle_root/$case_name.release"

  if [ "$child_kind" = verifier ]; then
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
      SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
      SHUD_REPLAY_TEST_SCENARIO=hold_after_root \
      SHUD_REPLAY_TEST_OWNER_TOKEN="$winner_token" \
      SHUD_REPLAY_TEST_HOLD_READY="$aux_ready" \
      SHUD_REPLAY_TEST_HOLD_RELEASE="$aux_release" \
      "$verifier" >/dev/null 2>&1 &
  else
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
      SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
      SHUD_REPLAY_SELF_TEST_SCENARIO=harness_hold_after_root \
      SHUD_REPLAY_TEST_OWNER_TOKEN="$winner_token" \
      SHUD_REPLAY_TEST_HOLD_READY="$aux_ready" \
      SHUD_REPLAY_TEST_HOLD_RELEASE="$aux_release" \
      "$self_test" >/dev/null 2>&1 &
  fi
  winner_pid=$!

  if ! wait_for_ready "$aux_ready"; then
    : >"$aux_release"
    wait "$winner_pid" || true
    echo "$case_name winner did not acquire its root" >&2
    return 1
  fi

  set +e
  if [ "$child_kind" = verifier ]; then
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
      SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
      "$verifier" >/dev/null 2>&1
  else
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
      SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
      SHUD_REPLAY_SELF_TEST_SCENARIO=matrix \
      "$self_test" >/dev/null 2>&1
  fi
  loser_status=$?
  set -e
  : >"$aux_release"
  set +e
  wait "$winner_pid"
  winner_status=$?
  set -e
  rm "$aux_ready" "$aux_release"
  aux_ready=
  aux_release=

  if [ "$winner_status" -ne 0 ] || [ "$loser_status" -ne 73 ]; then
    echo "$case_name statuses winner=$winner_status loser=$loser_status, expected 0/73" >&2
    cleanup_exact_child_root "$lifecycle_root/$root_name" "$lifecycle_root/.$root_name.claim" "$winner_token"
    return 1
  fi
  assert_child_absent "$case_name" "$root_name"
  record_pass
}

run_finalization_signal_case() {
  case_name=$1
  child_kind=$2
  first_signal=$3
  second_signal=$4
  expected=$5
  root_name="case-$case_name"
  child_token="finalization-$case_name"
  aux_ready="$lifecycle_root/$case_name.ready"
  aux_release="$lifecycle_root/$case_name.release"
  aux_signals_ready="$lifecycle_root/$case_name.signals-ready"

  if [ "$child_kind" = verifier ]; then
    /usr/bin/perl -e "$signal_enabled_child_runner" /usr/bin/env \
      SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
      SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
      SHUD_REPLAY_TEST_SCENARIO=hold_after_root \
      SHUD_REPLAY_TEST_OWNER_TOKEN="$child_token" \
      SHUD_REPLAY_TEST_HOLD_READY="$aux_ready" \
      SHUD_REPLAY_TEST_HOLD_RELEASE="$aux_release" \
      SHUD_REPLAY_TEST_HOLD_SIGNAL_FIRST="$first_signal" \
      SHUD_REPLAY_TEST_HOLD_SIGNAL_SECOND="$second_signal" \
      SHUD_REPLAY_TEST_HOLD_SIGNALS_READY="$aux_signals_ready" \
      "$verifier" >/dev/null 2>&1 &
  else
    /usr/bin/perl -e "$signal_enabled_child_runner" /usr/bin/env \
      SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
      SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
      SHUD_REPLAY_SELF_TEST_SCENARIO=harness_hold_after_root \
      SHUD_REPLAY_TEST_OWNER_TOKEN="$child_token" \
      SHUD_REPLAY_TEST_HOLD_READY="$aux_ready" \
      SHUD_REPLAY_TEST_HOLD_RELEASE="$aux_release" \
      SHUD_REPLAY_TEST_HOLD_SIGNAL_FIRST="$first_signal" \
      SHUD_REPLAY_TEST_HOLD_SIGNAL_SECOND="$second_signal" \
      SHUD_REPLAY_TEST_HOLD_SIGNALS_READY="$aux_signals_ready" \
      "$self_test" >/dev/null 2>&1 &
  fi
  child_pid=$!

  if ! wait_for_ready "$aux_ready"; then
    : >"$aux_release"
    wait "$child_pid" || true
    echo "$case_name child did not reach finalization hold" >&2
    return 1
  fi

  if ! wait_for_ready "$aux_signals_ready"; then
    : >"$aux_release"
    wait "$child_pid" || true
    echo "$case_name child did not finish ordered signal delivery" >&2
    return 1
  fi
  : >"$aux_release"
  set +e
  wait "$child_pid"
  child_status=$?
  set -e
  rm "$aux_ready" "$aux_release" "$aux_signals_ready"
  aux_ready=
  aux_release=
  aux_signals_ready=

  if [ "$child_status" -ne "$expected" ]; then
    echo "$case_name exited $child_status, expected $expected" >&2
    cleanup_exact_child_root "$lifecycle_root/$root_name" "$lifecycle_root/.$root_name.claim" "$child_token"
    return 1
  fi
  assert_child_absent "$case_name" "$root_name"
  record_pass
}

run_acquisition_signal_case() {
  case_name=$1
  first_signal=$2
  second_signal=$3
  expected=$4
  child_kind=${5:-verifier}
  root_name="case-$case_name"
  case "$child_kind" in
    verifier) transaction_command=$verifier ;;
    harness) transaction_command=$self_test ;;
    *)
      echo "unknown acquisition child kind: $child_kind" >&2
      return 1
      ;;
  esac
  set +e
  /usr/bin/perl -MPOSIX=setsid -e 'setsid() >= 0 or die "setsid: $!"; exec @ARGV or die "exec: $!"' \
    /usr/bin/env \
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
    SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_SCENARIO=matrix \
    SHUD_REPLAY_TEST_SCENARIO=normal \
    SHUD_REPLAY_TEST_ACQUIRE_SIGNAL_FIRST="$first_signal" \
    SHUD_REPLAY_TEST_ACQUIRE_SIGNAL_SECOND="$second_signal" \
    "$transaction_command" >/dev/null 2>&1
  actual=$?
  set -e
  if [ "$actual" -ne "$expected" ]; then
    echo "$case_name exited $actual, expected $expected" >&2
    return 1
  fi
  assert_child_absent "$case_name" "$root_name"
  record_pass
}

cleanup_transaction_fault_residue() {
  cleanup_root=$1
  cleanup_claim=$2
  cleanup_token=$3

  if [ -n "$transaction_pid_file" ] && [ -f "$transaction_pid_file" ]; then
    while IFS= read -r cleanup_pid; do
      case "$cleanup_pid" in
        ''|*[!0-9]*) continue ;;
      esac
      kill -KILL "$cleanup_pid" >/dev/null 2>&1 || true
    done <"$transaction_pid_file"
  fi
  cleanup_attempt=0
  while [ "$cleanup_attempt" -lt 20 ]; do
    cleanup_live=0
    if [ -n "$transaction_pid_file" ] && [ -f "$transaction_pid_file" ]; then
      while IFS= read -r cleanup_pid; do
        case "$cleanup_pid" in
          ''|*[!0-9]*) continue ;;
        esac
        if kill -0 "$cleanup_pid" >/dev/null 2>&1; then cleanup_live=1; fi
      done <"$transaction_pid_file"
    fi
    if [ "$cleanup_live" -eq 0 ]; then break; fi
    cleanup_attempt=$((cleanup_attempt + 1))
    sleep 0.05
  done

  for cleanup_link in "$cleanup_claim".transaction.*; do
    if [ -L "$cleanup_link" ]; then
      cleanup_value=$(readlink "$cleanup_link") || cleanup_value=
      case "$cleanup_value" in
        "$cleanup_token"|"$cleanup_token":*) rm "$cleanup_link" >/dev/null 2>&1 || true ;;
      esac
    fi
  done
  if lifecycle_link_matches "$cleanup_root/.shud-replay-owner" "$cleanup_token"; then
    rm "$cleanup_root/.shud-replay-owner" >/dev/null 2>&1 || true
  fi
  rmdir "$cleanup_root" >/dev/null 2>&1 || true
  if lifecycle_link_matches "$cleanup_claim" "$cleanup_token"; then
    rm "$cleanup_claim" >/dev/null 2>&1 || true
  fi
  rm -rf "$transaction_fault_dir" >/dev/null 2>&1 || true
  transaction_fault_dir=
  transaction_pid_file=
}

run_transaction_settlement_case() {
  case_name=$1
  fault_kind=$2
  expected=$3
  child_kind=${4:-verifier}
  root_name="case-$case_name"
  child_token="transaction-$case_name"
  child_root="$lifecycle_root/$root_name"
  child_claim="$lifecycle_root/.$root_name.claim"
  child_marker="$child_root/.shud-replay-owner"
  transaction_fault_dir="$lifecycle_root/$case_name.fault-bin"
  transaction_probe_dir=$transaction_fault_dir
  transaction_pid_file="$transaction_fault_dir/creation-pids"
  fault_event="$transaction_fault_dir/fault-fired"
  later_event="$transaction_fault_dir/later-event-fired"
  child_release="$transaction_fault_dir/child-release"
  watchdog_event="$transaction_fault_dir/watchdog-fired"
  handler_read_failure_event="$transaction_fault_dir/handler-read-failed"
  decode_failure_event="$transaction_fault_dir/decode-read-failed"
  decode_reentry_event="$transaction_fault_dir/decode-reentered"
  signal_burst_done_event="$transaction_fault_dir/signal-burst-done"
  collision_fixture=0
  mkdir -m 700 "$transaction_fault_dir"

  case "$fault_kind" in
    outcome_read_term)
      cat >"$transaction_fault_dir/readlink" <<'EOF'
#!/bin/sh
case "$1" in
  *.transaction.*.outcome)
    if [ ! -e "$SHUD_REPLAY_TEST_FAULT_EVENT" ]; then
      /bin/ps -axo pid=,ppid= |
        /usr/bin/awk -v parent="$PPID" -v self="$$" '$2 == parent && $1 != self { print $1 }' \
          >>"$SHUD_REPLAY_TEST_CREATION_PID_FILE"
      : >"$SHUD_REPLAY_TEST_FAULT_EVENT"
      kill -s TERM "$PPID"
      exit 1
    fi
    ;;
esac
exec /usr/bin/readlink "$@"
EOF
      chmod 700 "$transaction_fault_dir/readlink"
      ;;
    release_publication_failure)
      cat >"$transaction_fault_dir/ln" <<'EOF'
#!/bin/sh
last_arg=
for arg do last_arg=$arg; done
case "$last_arg" in
  *.transaction.*.release)
    /bin/ps -axo pid=,ppid= |
      /usr/bin/awk -v parent="$PPID" -v self="$$" '$2 == parent && $1 != self { print $1 }' \
        >>"$SHUD_REPLAY_TEST_CREATION_PID_FILE"
    : >"$SHUD_REPLAY_TEST_FAULT_EVENT"
    exit 67
    ;;
esac
exec /bin/ln "$@"
EOF
      chmod 700 "$transaction_fault_dir/ln"
      ;;
    release_result_then_term)
      cat >"$transaction_fault_dir/ln" <<'EOF'
#!/bin/sh
last_arg=
for arg do last_arg=$arg; done
case "$last_arg" in
  *.transaction.*.release)
    : >"$SHUD_REPLAY_TEST_FAULT_EVENT"
    exit 67
    ;;
esac
exec /bin/ln "$@"
EOF
      cat >"$transaction_fault_dir/readlink" <<'EOF'
#!/bin/sh
if [ "$1" = "$SHUD_REPLAY_TEST_FAULT_CLAIM" ] &&
  [ -e "$SHUD_REPLAY_TEST_FAULT_EVENT" ] &&
  [ ! -e "$SHUD_REPLAY_TEST_LATER_EVENT" ]; then
  : >"$SHUD_REPLAY_TEST_LATER_EVENT"
  kill -s TERM "$PPID"
fi
exec /usr/bin/readlink "$@"
EOF
      chmod 700 "$transaction_fault_dir/ln" "$transaction_fault_dir/readlink"
      ;;
    collision_result_then_term|unknown_outcome_then_term|\
    published_collision_read_term|published_unknown_read_term|\
    published_handler_read_failure|decoded_read_failure_then_handler_collision)
      mkdir -m 700 "$child_root"
      collision_fixture=1
      cat >"$transaction_fault_dir/ln" <<'EOF'
#!/bin/sh
last_arg=
for arg do last_arg=$arg; done
case "$last_arg" in
  *.transaction.*.outcome)
    outcome_target=$2
    if [ -n "${SHUD_REPLAY_TEST_FORCED_OUTCOME:-}" ]; then
      outcome_token=${outcome_target%%:*}
      /bin/ln -s "$outcome_token:$SHUD_REPLAY_TEST_FORCED_OUTCOME" "$last_arg" || exit $?
    else
      /bin/ln "$@" || exit $?
    fi
    printf '%s\n' "$PPID" >>"$SHUD_REPLAY_TEST_CREATION_PID_FILE"
    : >"$SHUD_REPLAY_TEST_FAULT_EVENT"
    hold_attempt=0
    while [ ! -e "$SHUD_REPLAY_TEST_SETTLEMENT_RELEASE" ]; do
      hold_attempt=$((hold_attempt + 1))
      if [ "$hold_attempt" -ge 20 ]; then
        : >"$SHUD_REPLAY_TEST_WATCHDOG_EVENT"
        kill -KILL "$PPID" >/dev/null 2>&1 || true
        exit 124
      fi
      sleep 0.05
    done
    ;;
  *) exec /bin/ln "$@" ;;
esac
exit 0
EOF
      chmod 700 "$transaction_fault_dir/ln"
      case "$fault_kind" in
        published_collision_read_term|published_unknown_read_term)
          cat >"$transaction_fault_dir/readlink" <<'EOF'
#!/bin/sh
case "$1" in
  *.transaction.*.outcome)
    if [ ! -e "$SHUD_REPLAY_TEST_LATER_EVENT" ]; then
      : >"$SHUD_REPLAY_TEST_LATER_EVENT"
      kill -s TERM "$PPID"
    fi
    ;;
esac
exec /usr/bin/readlink "$@"
EOF
          chmod 700 "$transaction_fault_dir/readlink"
          ;;
        published_handler_read_failure)
          cat >"$transaction_fault_dir/readlink" <<'EOF'
#!/bin/sh
case "$1" in
  *.transaction.*.outcome)
    if [ -e "$SHUD_REPLAY_TEST_LATER_EVENT" ] &&
      [ ! -e "$SHUD_REPLAY_TEST_HANDLER_READ_FAILURE_EVENT" ]; then
      : >"$SHUD_REPLAY_TEST_HANDLER_READ_FAILURE_EVENT"
      exit 1
    fi
    ;;
esac
exec /usr/bin/readlink "$@"
EOF
          chmod 700 "$transaction_fault_dir/readlink"
          ;;
        decoded_read_failure_then_handler_collision)
          cat >"$transaction_fault_dir/readlink" <<'EOF'
#!/bin/sh
case "$1" in
  *.transaction.*.outcome)
    if [ ! -e "$SHUD_REPLAY_TEST_DECODE_FAILURE_EVENT" ]; then
      : >"$SHUD_REPLAY_TEST_DECODE_FAILURE_EVENT"
      lifecycle_target_parent=$PPID
      (
        : >"$SHUD_REPLAY_TEST_LATER_EVENT"
        lifecycle_signal_count=0
        while [ "$lifecycle_signal_count" -lt 262144 ]; do
          kill -s TERM "$lifecycle_target_parent" >/dev/null 2>&1 || break
          lifecycle_signal_count=$((lifecycle_signal_count + 1))
        done
        : >"$SHUD_REPLAY_TEST_SIGNAL_BURST_DONE_EVENT"
      ) </dev/null >/dev/null 2>&1 &
      exit 1
    fi
    if [ ! -e "$SHUD_REPLAY_TEST_SETTLEMENT_RELEASE" ]; then
      : >"$SHUD_REPLAY_TEST_DECODE_REENTRY_EVENT"
    fi
    ;;
esac
exec /usr/bin/readlink "$@"
EOF
          chmod 700 "$transaction_fault_dir/readlink"
          ;;
      esac
      ;;
    *)
      echo "unknown transaction fault: $fault_kind" >&2
      return 1
      ;;
  esac

  forced_outcome=
  settlement_event=
  settlement_release=
  settlement_signal=
  published_outcome_signal=
  case "$fault_kind" in
    collision_result_then_term)
      settlement_event=$later_event
      settlement_release=$child_release
      settlement_signal=TERM
      ;;
    unknown_outcome_then_term)
      forced_outcome=99
      settlement_event=$later_event
      settlement_release=$child_release
      settlement_signal=TERM
      ;;
    published_collision_read_term)
      settlement_release=$child_release
      ;;
    published_unknown_read_term)
      forced_outcome=99
      settlement_release=$child_release
      ;;
    published_handler_read_failure)
      published_outcome_signal=TERM
      settlement_release=$child_release
      ;;
    decoded_read_failure_then_handler_collision)
      settlement_release=$child_release
      ;;
  esac

  case "$child_kind" in
    verifier) transaction_command=$verifier ;;
    harness) transaction_command=$self_test ;;
    *)
      echo "unknown transaction child kind: $child_kind" >&2
      return 1
      ;;
  esac

  set +e
  PATH="$transaction_fault_dir:$PATH" \
    SHUD_REPLAY_TEST_FAULT_EVENT="$fault_event" \
    SHUD_REPLAY_TEST_FAULT_CLAIM="$child_claim" \
    SHUD_REPLAY_TEST_LATER_EVENT="$later_event" \
    SHUD_REPLAY_TEST_WATCHDOG_EVENT="$watchdog_event" \
    SHUD_REPLAY_TEST_HANDLER_READ_FAILURE_EVENT="$handler_read_failure_event" \
    SHUD_REPLAY_TEST_DECODE_FAILURE_EVENT="$decode_failure_event" \
    SHUD_REPLAY_TEST_DECODE_REENTRY_EVENT="$decode_reentry_event" \
    SHUD_REPLAY_TEST_SIGNAL_BURST_DONE_EVENT="$signal_burst_done_event" \
    SHUD_REPLAY_TEST_PUBLISHED_OUTCOME_EVENT="$later_event" \
    SHUD_REPLAY_TEST_PUBLISHED_OUTCOME_SIGNAL="$published_outcome_signal" \
    SHUD_REPLAY_TEST_SETTLEMENT_EVENT="$settlement_event" \
    SHUD_REPLAY_TEST_SETTLEMENT_RELEASE="$settlement_release" \
    SHUD_REPLAY_TEST_SETTLEMENT_SIGNAL="$settlement_signal" \
    SHUD_REPLAY_TEST_FORCED_OUTCOME="$forced_outcome" \
    SHUD_REPLAY_TEST_CREATION_PID_FILE="$transaction_pid_file" \
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
    SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_SCENARIO=matrix \
    SHUD_REPLAY_TEST_OWNER_TOKEN="$child_token" \
    "$transaction_command" >/dev/null 2>&1
  actual=$?
  set -e

  if [ "$fault_kind" = decoded_read_failure_then_handler_collision ] &&
    ! wait_for_ready "$signal_burst_done_event"; then
    echo "$case_name signal burst did not finish" >&2
    return 1
  fi

  settlement_failed=0
  if [ "$actual" -ne "$expected" ]; then
    echo "$case_name exited $actual, expected $expected" >&2
    settlement_failed=1
  fi
  case "$fault_kind" in
    release_result_then_term|collision_result_then_term|unknown_outcome_then_term|\
    published_collision_read_term|published_unknown_read_term|\
    published_handler_read_failure|decoded_read_failure_then_handler_collision)
      if [ ! -e "$later_event" ]; then
        echo "$case_name did not inject the later TERM" >&2
        settlement_failed=1
      fi
      ;;
  esac
  case "$fault_kind" in
    collision_result_then_term|unknown_outcome_then_term|\
    published_collision_read_term|published_unknown_read_term|\
    published_handler_read_failure|decoded_read_failure_then_handler_collision)
      if [ ! -e "$fault_event" ]; then
        echo "$case_name did not hold its published outcome" >&2
        settlement_failed=1
      fi
      if [ -e "$watchdog_event" ]; then
        echo "$case_name used its watchdog instead of the settlement release" >&2
        settlement_failed=1
      fi
      ;;
  esac
  if [ "$fault_kind" = published_handler_read_failure ] &&
    [ ! -e "$handler_read_failure_event" ]; then
    echo "$case_name did not fail the handler-internal outcome read" >&2
    settlement_failed=1
  fi
  if [ "$fault_kind" = decoded_read_failure_then_handler_collision ] &&
    [ -e "$decode_reentry_event" ]; then
    echo "$case_name re-entered outcome decoding before committing status 67" >&2
    settlement_failed=1
  fi
  if [ ! -s "$transaction_pid_file" ]; then
    echo "$case_name did not identify the spawned creation child" >&2
    settlement_failed=1
  else
    while IFS= read -r child_pid; do
      case "$child_pid" in
        ''|*[!0-9]*)
          echo "$case_name recorded invalid creation pid: $child_pid" >&2
          settlement_failed=1
          ;;
        *)
          if kill -0 "$child_pid" >/dev/null 2>&1; then
            echo "$case_name retained live creation child $child_pid" >&2
            settlement_failed=1
          fi
          ;;
      esac
    done <"$transaction_pid_file"
  fi
  if find "$lifecycle_root" -maxdepth 1 -name ".$root_name.claim.transaction.*" -print -quit |
    grep . >/dev/null; then
    echo "$case_name retained transaction links" >&2
    settlement_failed=1
  fi
  if [ -e "$child_claim" ] || [ -L "$child_claim" ]; then
    echo "$case_name retained its claim" >&2
    settlement_failed=1
  fi
  if [ -e "$child_marker" ] || [ -L "$child_marker" ]; then
    echo "$case_name retained its owner marker" >&2
    settlement_failed=1
  fi
  if [ "$collision_fixture" -eq 1 ]; then
    if [ ! -d "$child_root" ] ||
      find "$child_root" -mindepth 1 -print -quit | grep . >/dev/null; then
      echo "$case_name modified its foreign collision root" >&2
      settlement_failed=1
    elif ! rmdir "$child_root"; then
      echo "$case_name could not remove its collision probe root" >&2
      settlement_failed=1
    fi
  elif [ -e "$child_root" ] || [ -L "$child_root" ]; then
    echo "$case_name retained its root" >&2
    settlement_failed=1
  fi
  if test_worktree_is_registered "$child_root/round-1" ||
    test_worktree_is_registered "$child_root/round-2"; then
    echo "$case_name retained a registered worktree" >&2
    settlement_failed=1
  fi

  cleanup_transaction_fault_residue "$child_root" "$child_claim" "$child_token"
  if [ -e "$child_root" ] || [ -L "$child_root" ] ||
    [ -e "$transaction_probe_dir" ]; then
    echo "$case_name retained transaction probe residue" >&2
    settlement_failed=1
  fi
  if [ "$settlement_failed" -ne 0 ]; then return 1; fi
  record_pass
}

cleanup_claim_fault_residue() {
  cleanup_claim=$1
  cleanup_token=$2
  if lifecycle_link_matches "$cleanup_claim" "$cleanup_token"; then
    rm "$cleanup_claim" >/dev/null 2>&1 || true
  fi
  rm -rf "$claim_fault_dir" >/dev/null 2>&1 || true
  claim_fault_dir=
}

run_claim_reconciliation_case() {
  case_name=$1
  child_kind=$2
  root_name="case-$case_name"
  child_token="claim-$case_name"
  child_root="$lifecycle_root/$root_name"
  child_claim="$lifecycle_root/.$root_name.claim"
  child_marker="$child_root/.shud-replay-owner"
  claim_fault_dir="$lifecycle_root/$case_name.fault-bin"
  fault_event="$claim_fault_dir/fault-fired"
  creation_pid_file="$claim_fault_dir/creation-pids"
  mkdir -m 700 "$claim_fault_dir"

  cat >"$claim_fault_dir/readlink" <<'EOF'
#!/bin/sh
if [ "$1" = "$SHUD_REPLAY_TEST_FAULT_CLAIM" ] &&
  [ ! -e "$SHUD_REPLAY_TEST_FAULT_EVENT" ]; then
  : >"$SHUD_REPLAY_TEST_FAULT_EVENT"
  kill -s TERM "$PPID"
  exit 1
fi
exec /usr/bin/readlink "$@"
EOF
  chmod 700 "$claim_fault_dir/readlink"

  set +e
  if [ "$child_kind" = verifier ]; then
    PATH="$claim_fault_dir:$PATH" \
      SHUD_REPLAY_TEST_FAULT_CLAIM="$child_claim" \
      SHUD_REPLAY_TEST_FAULT_EVENT="$fault_event" \
      SHUD_REPLAY_TEST_CREATION_PID_FILE="$creation_pid_file" \
      SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
      SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
      SHUD_REPLAY_TEST_OWNER_TOKEN="$child_token" \
      "$verifier" >/dev/null 2>&1
  else
    PATH="$claim_fault_dir:$PATH" \
      SHUD_REPLAY_TEST_FAULT_CLAIM="$child_claim" \
      SHUD_REPLAY_TEST_FAULT_EVENT="$fault_event" \
      SHUD_REPLAY_TEST_CREATION_PID_FILE="$creation_pid_file" \
      SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
      SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
      SHUD_REPLAY_SELF_TEST_SCENARIO=matrix \
      SHUD_REPLAY_TEST_OWNER_TOKEN="$child_token" \
      "$self_test" >/dev/null 2>&1
  fi
  actual=$?
  set -e

  claim_failed=0
  if [ ! -e "$fault_event" ]; then
    echo "$case_name did not inject the first claim-read TERM" >&2
    claim_failed=1
  fi
  if [ "$actual" -ne 143 ]; then
    echo "$case_name exited $actual, expected 143" >&2
    claim_failed=1
  fi
  if [ -s "$creation_pid_file" ]; then
    echo "$case_name spawned a creation child before claim reconciliation" >&2
    claim_failed=1
  fi
  if find "$lifecycle_root" -maxdepth 1 -name ".$root_name.claim.transaction.*" -print -quit |
    grep . >/dev/null; then
    echo "$case_name retained transaction links" >&2
    claim_failed=1
  fi
  if [ -e "$child_claim" ] || [ -L "$child_claim" ]; then
    echo "$case_name retained its exact claim" >&2
    claim_failed=1
  fi
  if [ -e "$child_marker" ] || [ -L "$child_marker" ]; then
    echo "$case_name retained its owner marker" >&2
    claim_failed=1
  fi
  if [ -e "$child_root" ] || [ -L "$child_root" ]; then
    echo "$case_name retained its root" >&2
    claim_failed=1
  fi
  if test_worktree_is_registered "$child_root/round-1" ||
    test_worktree_is_registered "$child_root/round-2"; then
    echo "$case_name retained a registered worktree" >&2
    claim_failed=1
  fi

  cleanup_claim_fault_residue "$child_claim" "$child_token"
  if [ "$claim_failed" -ne 0 ]; then return 1; fi
  record_pass
}

case "$self_test_scenario" in
  matrix|harness_startup_term|harness_double_hup_int|harness_hold_after_root|\
    collision_verifier_child_42|collision_harness_child_42|\
    assertion_signal_term|assertion_double_hup_int|\
    transaction_outcome_read_term|transaction_release_publication_failure|\
    chronology_release_verifier|chronology_release_harness|\
    chronology_collision_verifier|chronology_collision_harness|\
    chronology_unknown_verifier|chronology_unknown_harness|\
    chronology_published_collision_read_verifier|chronology_published_collision_read_harness|\
    chronology_published_unknown_read_verifier|chronology_published_unknown_read_harness|\
    chronology_handler_read_failure_verifier|chronology_handler_read_failure_harness|\
    chronology_decode_commit_verifier|chronology_decode_commit_harness|\
    decode_tail_probe|decode_tail_term_verifier|decode_tail_term_harness|\
    decode_tail_hup_int_verifier|\
    classification_commit_hup_int_verifier|classification_commit_hup_int_harness|\
    classification_commit_read_failure_verifier|classification_commit_read_failure_harness|\
    classification_commit_collision_verifier|classification_commit_collision_harness|\
    deferred_transfer_wait_verifier|deferred_transfer_wait_harness|\
    deferred_transfer_decode_verifier|deferred_transfer_decode_harness|\
    outcome_disappearance_term_verifier|outcome_disappearance_term_harness|\
    outcome_disappearance_restore_verifier|outcome_disappearance_restore_harness|\
    transaction_signal_before_publication_verifier|transaction_signal_before_publication_harness|\
    claim_reconciliation_verifier_term|claim_reconciliation_harness_term)
    ;;
  *)
    echo "unknown replay self-test scenario: $self_test_scenario" >&2
    exit 64
    ;;
esac

lifecycle_install_signal_handlers
trap 'cleanup_test_parent "$?"' EXIT
lifecycle_begin "$test_root_parent" "$test_root_name" "$harness_owner_token"
lifecycle_acquire_root

case "$self_test_scenario" in
  decode_tail_probe)
    lifecycle_begin_successful_finalization
    lifecycle_release_root_strict 84
    trap - EXIT HUP INT TERM
    exit 0
    ;;
  harness_startup_term)
    kill -s TERM "$$"
    lifecycle_abort_if_latched
    ;;
  harness_double_hup_int)
    kill -s HUP "$$"
    kill -s INT "$$"
    lifecycle_abort_if_latched
    ;;
  harness_hold_after_root)
    hold_ready=${SHUD_REPLAY_TEST_HOLD_READY:-}
    hold_release=${SHUD_REPLAY_TEST_HOLD_RELEASE:-}
    if [ -z "$hold_ready" ] || [ -z "$hold_release" ]; then lifecycle_fail 64; fi
    : >"$hold_ready"
    lifecycle_inject_hold_signals
    while [ ! -e "$hold_release" ]; do :; done
    lifecycle_begin_successful_finalization
    lifecycle_release_root_strict 84
    trap - EXIT HUP INT TERM
    exit 0
    ;;
  collision_verifier_child_42)
    run_collision_case forced_verifier_child_42 verifier 42
    ;;
  collision_harness_child_42)
    run_collision_case forced_harness_child_42 harness 42
    ;;
  assertion_signal_term)
    create_collision_fixture assertion-signal-term
    kill -s TERM "$$"
    lifecycle_abort_if_latched
    ;;
  assertion_double_hup_int)
    create_collision_fixture assertion-double-hup-int
    kill -s HUP "$$"
    kill -s INT "$$"
    lifecycle_abort_if_latched
    ;;
  transaction_outcome_read_term)
    run_transaction_settlement_case outcome_read_term outcome_read_term 67
    ;;
  transaction_release_publication_failure)
    run_transaction_settlement_case release_publication_failure release_publication_failure 67
    ;;
  chronology_release_verifier)
    run_transaction_settlement_case release_result_then_term_verifier release_result_then_term 67 verifier
    ;;
  chronology_release_harness)
    run_transaction_settlement_case release_result_then_term_harness release_result_then_term 67 harness
    ;;
  chronology_collision_verifier)
    run_transaction_settlement_case collision_result_then_term_verifier collision_result_then_term 73 verifier
    ;;
  chronology_collision_harness)
    run_transaction_settlement_case collision_result_then_term_harness collision_result_then_term 73 harness
    ;;
  chronology_unknown_verifier)
    run_transaction_settlement_case unknown_outcome_then_term_verifier unknown_outcome_then_term 67 verifier
    ;;
  chronology_unknown_harness)
    run_transaction_settlement_case unknown_outcome_then_term_harness unknown_outcome_then_term 67 harness
    ;;
  chronology_published_collision_read_verifier)
    run_transaction_settlement_case published_collision_read_term_verifier published_collision_read_term 73 verifier
    ;;
  chronology_published_collision_read_harness)
    run_transaction_settlement_case published_collision_read_term_harness published_collision_read_term 73 harness
    ;;
  chronology_published_unknown_read_verifier)
    run_transaction_settlement_case published_unknown_read_term_verifier published_unknown_read_term 67 verifier
    ;;
  chronology_published_unknown_read_harness)
    run_transaction_settlement_case published_unknown_read_term_harness published_unknown_read_term 67 harness
    ;;
  chronology_handler_read_failure_verifier)
    run_transaction_settlement_case handler_read_failure_verifier published_handler_read_failure 67 verifier
    ;;
  chronology_handler_read_failure_harness)
    run_transaction_settlement_case handler_read_failure_harness published_handler_read_failure 67 harness
    ;;
  chronology_decode_commit_verifier)
    for decode_commit_attempt in 1 2 3 4 5 6 7 8; do
      run_transaction_settlement_case "decode_commit_verifier_$decode_commit_attempt" \
        decoded_read_failure_then_handler_collision 67 verifier
    done
    ;;
  chronology_decode_commit_harness)
    for decode_commit_attempt in 1 2 3 4 5 6 7 8; do
      run_transaction_settlement_case "decode_commit_harness_$decode_commit_attempt" \
        decoded_read_failure_then_handler_collision 67 harness
    done
    ;;
  classification_commit_hup_int_verifier)
    run_committed_outcome_signal_case classification_commit_hup_int_verifier \
      verifier HUP INT zero 129
    ;;
  classification_commit_hup_int_harness)
    run_committed_outcome_signal_case classification_commit_hup_int_harness \
      harness HUP INT zero 129
    ;;
  classification_commit_read_failure_verifier)
    run_committed_outcome_signal_case classification_commit_read_failure_verifier \
      verifier '' TERM fail 143
    ;;
  classification_commit_read_failure_harness)
    run_committed_outcome_signal_case classification_commit_read_failure_harness \
      harness '' TERM fail 143
    ;;
  classification_commit_collision_verifier)
    run_committed_outcome_signal_case classification_commit_collision_verifier \
      verifier '' TERM 73 143
    ;;
  classification_commit_collision_harness)
    run_committed_outcome_signal_case classification_commit_collision_harness \
      harness '' TERM 73 143
    ;;
  deferred_transfer_wait_verifier)
    run_deferred_transfer_case deferred_transfer_wait_verifier verifier negative_wait INT
    ;;
  deferred_transfer_wait_harness)
    run_deferred_transfer_case deferred_transfer_wait_harness harness negative_wait INT
    ;;
  deferred_transfer_decode_verifier)
    run_deferred_transfer_case deferred_transfer_decode_verifier verifier decode_tail INT
    ;;
  deferred_transfer_decode_harness)
    run_deferred_transfer_case deferred_transfer_decode_harness harness decode_tail INT
    ;;
  outcome_disappearance_term_verifier)
    run_outcome_disappearance_case outcome_disappearance_term_verifier verifier 0 67
    ;;
  outcome_disappearance_term_harness)
    run_outcome_disappearance_case outcome_disappearance_term_harness harness 0 67
    ;;
  outcome_disappearance_restore_verifier)
    run_outcome_disappearance_case outcome_disappearance_restore_verifier verifier 1 67
    ;;
  outcome_disappearance_restore_harness)
    run_outcome_disappearance_case outcome_disappearance_restore_harness harness 1 67
    ;;
  transaction_signal_before_publication_verifier)
    run_acquisition_signal_case signal_before_publication_verifier TERM '' 143 verifier
    ;;
  transaction_signal_before_publication_harness)
    run_acquisition_signal_case signal_before_publication_harness TERM '' 143 harness
    ;;
  claim_reconciliation_verifier_term)
    run_claim_reconciliation_case claim_reconciliation_verifier_term verifier
    ;;
  claim_reconciliation_harness_term)
    run_claim_reconciliation_case claim_reconciliation_harness_term harness
    ;;
esac

case "$self_test_scenario" in
  transaction_outcome_read_term|transaction_release_publication_failure|\
  chronology_release_verifier|chronology_release_harness|\
  chronology_collision_verifier|chronology_collision_harness|\
  chronology_unknown_verifier|chronology_unknown_harness|\
  chronology_published_collision_read_verifier|chronology_published_collision_read_harness|\
  chronology_published_unknown_read_verifier|chronology_published_unknown_read_harness|\
  chronology_handler_read_failure_verifier|chronology_handler_read_failure_harness|\
  chronology_decode_commit_verifier|chronology_decode_commit_harness|\
  classification_commit_hup_int_verifier|classification_commit_hup_int_harness|\
  classification_commit_read_failure_verifier|classification_commit_read_failure_harness|\
  classification_commit_collision_verifier|classification_commit_collision_harness|\
  deferred_transfer_wait_verifier|deferred_transfer_wait_harness|\
  deferred_transfer_decode_verifier|deferred_transfer_decode_harness|\
  outcome_disappearance_term_verifier|outcome_disappearance_term_harness|\
  outcome_disappearance_restore_verifier|outcome_disappearance_restore_harness|\
  transaction_signal_before_publication_verifier|transaction_signal_before_publication_harness|\
  claim_reconciliation_verifier_term|claim_reconciliation_harness_term)
    lifecycle_begin_successful_finalization
    lifecycle_release_root_strict 84
    trap - EXIT HUP INT TERM
    echo "replay lifecycle fault probe: 1/1 passed"
    exit 0
    ;;
  decode_tail_term_verifier)
    run_decode_tail_signal_case decode_tail_term_verifier verifier TERM '' 143
    lifecycle_begin_successful_finalization
    lifecycle_release_root_strict 84
    trap - EXIT HUP INT TERM
    echo "replay evidence lifecycle: 1/1 passed"
    exit 0
    ;;
  decode_tail_term_harness)
    run_decode_tail_signal_case decode_tail_term_harness harness TERM '' 143
    lifecycle_begin_successful_finalization
    lifecycle_release_root_strict 84
    trap - EXIT HUP INT TERM
    echo "replay evidence lifecycle: 1/1 passed"
    exit 0
    ;;
  decode_tail_hup_int_verifier)
    run_decode_tail_signal_case decode_tail_hup_int_verifier verifier HUP INT 129
    lifecycle_begin_successful_finalization
    lifecycle_release_root_strict 84
    trap - EXIT HUP INT TERM
    echo "replay evidence lifecycle: 1/1 passed"
    exit 0
    ;;
esac

# 18 baseline verifier scenarios.
run_verifier_case normal normal 0
run_verifier_case root_failure root_failure_after_create 41
run_verifier_case add_failure_round_1 add_failure_round_1 74
run_verifier_case add_failure_round_2 add_failure_round_2 75
run_verifier_case patch_failure_round_1 patch_failure_round_1 76
run_verifier_case patch_failure_round_2 patch_failure_round_2 78
run_verifier_case partial_after_round_1 partial_after_round_1 38
run_verifier_case partial_after_round_2 partial_after_round_2 39
run_verifier_case dirty_cleanup dirty_cleanup 79
run_verifier_case locked_cleanup locked_cleanup 80
run_verifier_case missing_cleanup missing_cleanup 81
run_verifier_case signal_after_root_hup signal_after_root_hup 129
run_verifier_case signal_after_root_int signal_after_root_int 130
run_verifier_case signal_after_root_term signal_after_root_term 143
run_verifier_case double_hup_int double_hup_int 129
run_verifier_case double_int_term double_int_term 130
run_verifier_case double_term_hup double_term_hup 143
run_verifier_case failure_cleanup_term failure_cleanup_term 37

# Seven exact-status cleanup-diagnostic variants.
run_verifier_case add_failure_round_1_cleanup_77 add_failure_round_1 74 77
run_verifier_case add_failure_round_2_cleanup_77 add_failure_round_2 75 77
run_verifier_case patch_failure_round_1_cleanup_77 patch_failure_round_1 76 77
run_verifier_case patch_failure_round_2_cleanup_77 patch_failure_round_2 78 77
run_verifier_case dirty_cleanup_77 dirty_cleanup 79 77
run_verifier_case locked_cleanup_77 locked_cleanup 80 77
run_verifier_case missing_cleanup_77 missing_cleanup 81 77

# Static foreign targets, harness signal paths, and atomic same-name races.
run_collision_case verifier_static_collision verifier '' empty
run_collision_case harness_static_collision harness '' marker
run_harness_case harness_startup_term harness_startup_term 143
run_harness_case harness_double_hup_int harness_double_hup_int 129
run_concurrent_case verifier_same_name verifier
run_concurrent_case harness_same_name harness
run_foreign_actor_race_case verifier_foreign_actor_race verifier
run_foreign_actor_race_case harness_foreign_actor_race harness

# Signals latched after work completes but before strict successful teardown.
run_finalization_signal_case verifier_finalization_term verifier TERM '' 143
run_finalization_signal_case harness_finalization_term harness TERM '' 143
run_finalization_signal_case verifier_finalization_hup_int verifier HUP INT 129

# Process-group signals while the external root-creation child is live.
run_acquisition_signal_case acquisition_group_hup HUP '' 129
run_acquisition_signal_case acquisition_group_int INT '' 130
run_acquisition_signal_case acquisition_group_term TERM '' 143
run_acquisition_signal_case acquisition_group_hup_int HUP INT 129
run_acquisition_signal_case acquisition_group_int_term INT TERM 130
run_acquisition_signal_case acquisition_group_term_hup TERM HUP 143

# Collision-helper rollback and marker-created assertion-window signals.
run_harness_case forced_verifier_child_42 collision_verifier_child_42 42
run_harness_case forced_harness_child_42 collision_harness_child_42 42
run_harness_case assertion_signal_term assertion_signal_term 143
run_harness_case assertion_double_hup_int assertion_double_hup_int 129

# Every post-spawn fault settles the creation child before ownership cleanup.
run_transaction_settlement_case outcome_read_term outcome_read_term 67
run_transaction_settlement_case release_publication_failure release_publication_failure 67
run_transaction_settlement_case release_result_then_term_verifier release_result_then_term 67 verifier
run_transaction_settlement_case release_result_then_term_harness release_result_then_term 67 harness
run_transaction_settlement_case collision_result_then_term_verifier collision_result_then_term 73 verifier
run_transaction_settlement_case collision_result_then_term_harness collision_result_then_term 73 harness
run_transaction_settlement_case unknown_outcome_then_term_verifier unknown_outcome_then_term 67 verifier
run_transaction_settlement_case unknown_outcome_then_term_harness unknown_outcome_then_term 67 harness
run_transaction_settlement_case published_collision_read_term_verifier published_collision_read_term 73 verifier
run_transaction_settlement_case published_collision_read_term_harness published_collision_read_term 73 harness
run_transaction_settlement_case published_unknown_read_term_verifier published_unknown_read_term 67 verifier
run_transaction_settlement_case published_unknown_read_term_harness published_unknown_read_term 67 harness
run_transaction_settlement_case handler_read_failure_verifier published_handler_read_failure 67 verifier
run_transaction_settlement_case handler_read_failure_harness published_handler_read_failure 67 harness

# A decoded read failure commits before a later handler can re-adopt collision.
run_transaction_settlement_case decode_commit_verifier decoded_read_failure_then_handler_collision 67 verifier
run_transaction_settlement_case decode_commit_harness decoded_read_failure_then_handler_collision 67 harness

# A token:0 decode consumes a pre-clear event; ordered events remain first-wins.
run_decode_tail_signal_case decode_tail_term_verifier verifier TERM '' 143
run_decode_tail_signal_case decode_tail_term_harness harness TERM '' 143
run_decode_tail_signal_case decode_tail_hup_int_verifier verifier HUP INT 129

# Outcome classification remains committed through child settlement. A
# post-clear handler consumes any deferred first event and never re-adopts the
# publication, even if a second read would fail or decode as collision.
run_committed_outcome_signal_case classification_commit_hup_int_verifier \
  verifier HUP INT zero 129
run_committed_outcome_signal_case classification_commit_hup_int_harness \
  harness HUP INT zero 129
run_committed_outcome_signal_case classification_commit_read_failure_verifier \
  verifier '' TERM fail 143
run_committed_outcome_signal_case classification_commit_read_failure_harness \
  harness '' TERM fail 143
run_committed_outcome_signal_case classification_commit_collision_verifier \
  verifier '' TERM 73 143
run_committed_outcome_signal_case classification_commit_collision_harness \
  harness '' TERM 73 143

# Deferred HUP remains authoritative while moving from the negative-wait or
# exact-zero decode slot into the write-once latch. A reentrant later handler
# attempts its own event only after the transferred 129 is first.
run_deferred_transfer_case deferred_transfer_wait_verifier verifier negative_wait INT
run_deferred_transfer_case deferred_transfer_wait_harness harness negative_wait INT
run_deferred_transfer_case deferred_transfer_decode_verifier verifier decode_tail INT
run_deferred_transfer_case deferred_transfer_decode_harness harness decode_tail INT

# Once ordinary settlement witnesses publication, disappearance commits 67
# before a later TERM or any attempt to re-adopt a restored token:73 outcome.
run_outcome_disappearance_case outcome_disappearance_term_verifier verifier 0 67
run_outcome_disappearance_case outcome_disappearance_term_harness harness 0 67
run_outcome_disappearance_case outcome_disappearance_restore_verifier verifier 1 67
run_outcome_disappearance_case outcome_disappearance_restore_harness harness 1 67

# A handled event that arrives before outcome publication remains first.
run_acquisition_signal_case signal_before_publication_verifier TERM '' 143 verifier
run_acquisition_signal_case signal_before_publication_harness TERM '' 143 harness

# A first claim-read signal is reconciled before any creation child is spawned.
run_claim_reconciliation_case claim_reconciliation_verifier_term verifier
run_claim_reconciliation_case claim_reconciliation_harness_term harness

if [ "$passed" -ne 83 ]; then
  echo "replay scenario accounting mismatch: $passed/83" >&2
  lifecycle_fail 85
fi
lifecycle_begin_successful_finalization
lifecycle_release_root_strict 84
trap - EXIT HUP INT TERM
echo "replay evidence lifecycle: 83/83 named scenarios passed (28 two-party races, 56 participant outcomes)"

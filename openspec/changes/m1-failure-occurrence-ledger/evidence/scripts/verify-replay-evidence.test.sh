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
  root_name="case-$case_name"
  set +e
  /usr/bin/perl -MPOSIX=setsid -e 'setsid() >= 0 or die "setsid: $!"; exec @ARGV or die "exec: $!"' \
    /usr/bin/env \
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
    SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_TEST_SCENARIO=normal \
    SHUD_REPLAY_TEST_ACQUIRE_SIGNAL_FIRST="$first_signal" \
    SHUD_REPLAY_TEST_ACQUIRE_SIGNAL_SECOND="$second_signal" \
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
    collision_result_then_term)
      mkdir -m 700 "$child_root"
      collision_fixture=1
      cat >"$transaction_fault_dir/readlink" <<'EOF'
#!/bin/sh
case "$1" in
  *.transaction.*.ready)
    outcome_path=${1%.ready}.outcome
    if [ -L "$outcome_path" ] && [ ! -e "$SHUD_REPLAY_TEST_LATER_EVENT" ]; then
      : >"$SHUD_REPLAY_TEST_LATER_EVENT"
      kill -s TERM "$PPID"
    fi
    ;;
esac
exec /usr/bin/readlink "$@"
EOF
      chmod 700 "$transaction_fault_dir/readlink"
      ;;
    *)
      echo "unknown transaction fault: $fault_kind" >&2
      return 1
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
    SHUD_REPLAY_TEST_CREATION_PID_FILE="$transaction_pid_file" \
    SHUD_REPLAY_TEST_ROOT_PARENT="$lifecycle_root" \
    SHUD_REPLAY_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_ROOT_NAME="$root_name" \
    SHUD_REPLAY_SELF_TEST_SCENARIO=matrix \
    SHUD_REPLAY_TEST_OWNER_TOKEN="$child_token" \
    "$transaction_command" >/dev/null 2>&1
  actual=$?
  set -e

  settlement_failed=0
  if [ "$actual" -ne "$expected" ]; then
    echo "$case_name exited $actual, expected $expected" >&2
    settlement_failed=1
  fi
  case "$fault_kind" in
    release_result_then_term|collision_result_then_term)
      if [ ! -e "$later_event" ]; then
        echo "$case_name did not inject the later TERM" >&2
        settlement_failed=1
      fi
      ;;
  esac
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
    run_transaction_settlement_case outcome_read_term outcome_read_term 143
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
  claim_reconciliation_verifier_term|claim_reconciliation_harness_term)
    lifecycle_begin_successful_finalization
    lifecycle_release_root_strict 84
    trap - EXIT HUP INT TERM
    echo "replay lifecycle fault probe: 1/1 passed"
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
run_transaction_settlement_case outcome_read_term outcome_read_term 143
run_transaction_settlement_case release_publication_failure release_publication_failure 67
run_transaction_settlement_case release_result_then_term_verifier release_result_then_term 67 verifier
run_transaction_settlement_case release_result_then_term_harness release_result_then_term 67 harness
run_transaction_settlement_case collision_result_then_term_verifier collision_result_then_term 73 verifier
run_transaction_settlement_case collision_result_then_term_harness collision_result_then_term 73 harness

# A first claim-read signal is reconciled before any creation child is spawned.
run_claim_reconciliation_case claim_reconciliation_verifier_term verifier
run_claim_reconciliation_case claim_reconciliation_harness_term harness

if [ "$passed" -ne 54 ]; then
  echo "replay scenario accounting mismatch: $passed/54" >&2
  lifecycle_fail 85
fi
lifecycle_begin_successful_finalization
lifecycle_release_root_strict 84
trap - EXIT HUP INT TERM
echo "replay evidence lifecycle: 54/54 named scenarios passed (9 two-party races, 18 participant outcomes)"

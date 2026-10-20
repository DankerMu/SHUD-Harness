#!/usr/bin/env sh
# Profile smoke: boots dsh (pinned checkout, DSH_ROOT or ../deepseek-harness) with the shud overlay and
# asserts the routed model, DMXAPI base URL and the disabled outbound channel. Fails loud when dsh is
# missing — never skips green. Local-only (CI has no dsh checkout; recorded as a readiness gap).
set -eu
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
DSH_ROOT="${DSH_ROOT:-$ROOT/../deepseek-harness}"
BIN="$DSH_ROOT/apps/cli/lib/bin.js"
[ -f "$BIN" ] || { echo "profile:smoke: dsh binary not found at $BIN (set DSH_ROOT to the dsh-v0.2.1-rc.2 checkout)" >&2; exit 1; }
EXPECTED_TAG="dsh-v0.2.1-rc.2"
ACTUAL_TAG=$(git -C "$DSH_ROOT" describe --tags --exact-match 2>/dev/null || echo unknown)
[ "$ACTUAL_TAG" = "$EXPECTED_TAG" ] || { echo "profile:smoke: dsh checkout is $ACTUAL_TAG, expected $EXPECTED_TAG" >&2; exit 1; }
TMP=$(mktemp -d "${TMPDIR:-/tmp}/shud-profile-smoke.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
unset ALL_PROXY
DSH_HOME="$TMP/home" node "$BIN" --profile headless --patch "$ROOT/profile/shud/cordis.patch.yml" --dump-config > "$TMP/dump.yml" 2> "$TMP/stderr.log" || {
  echo "profile:smoke: dsh --dump-config failed" >&2; cat "$TMP/stderr.log" >&2; exit 1; }
fail=0
need() { grep -q -- "$1" "$TMP/dump.yml" || { echo "profile:smoke: expected '$1' in dump-config" >&2; fail=1; }; }
need "model: deepseek-flash-guan"
need "baseURL: https://www.dmxapi.cn"
need "apiKeyEnv: DMXAPI_KEY"
grep -A2 -- "id: session-log-deepseek" "$TMP/dump.yml" | grep -q "disabled: true" || { echo "profile:smoke: session-log-deepseek is not disabled (ADR-0004 K9)" >&2; fail=1; }
if grep -q "DMXAPI_KEY=" "$TMP/dump.yml" || grep -Eq "sk-[A-Za-z0-9]{20,}" "$TMP/dump.yml"; then echo "profile:smoke: secret material leaked into dump-config" >&2; fail=1; fi
[ "$fail" -eq 0 ] && echo "profile:smoke: OK (dsh $ACTUAL_TAG, model deepseek-flash-guan via DMXAPI, session-log-deepseek disabled)"
exit $fail

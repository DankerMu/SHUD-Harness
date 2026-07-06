#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
HELPER="$SCRIPT_DIR/check_shud_rshud.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/shud-rshud-readiness-test.XXXXXX")
LIVE_STATUS_BEFORE=$(git -C "$REPO_ROOT" status --short -- SHUD rSHUD workspace)

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'self-test failed: %s\n' "$1" >&2
  exit 1
}

if ! git -C "$REPO_ROOT" check-ignore --no-index -q workspace/readiness/shud_rshud_readiness.json; then
  fail "root runtime shud/rshud readiness output is not ignored"
fi

make_fake_bin() {
  bin_dir=$1
  mkdir -p "$bin_dir"
  cat > "$bin_dir/make" <<'EOF'
#!/usr/bin/env sh
set -eu
target=${1:-}
case "$target" in
  clean)
    case "${FAKE_MAKE_CLEAN_MODE:-minimal}" in
      fail)
        printf '%s\n' "fake make clean failure" >&2
        exit 43
        ;;
      hang)
        sleep 10
        exit 0
        ;;
      large-output)
        i=0
        while [ "$i" -lt 2000 ]; do
          printf 'fake clean output line %04d abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz\n' "$i"
          i=$((i + 1))
        done
        rm -f shud
        exit 0
        ;;
      full)
        rm -f shud shud_omp shud_debug ./*.o
        rm -rf shud.* ./*.dSYM SHUD.*
        exit 0
        ;;
      minimal)
        rm -f shud
        exit 0
        ;;
      *)
        printf 'unknown FAKE_MAKE_CLEAN_MODE: %s\n' "$FAKE_MAKE_CLEAN_MODE" >&2
        exit 97
        ;;
    esac
    ;;
  shud)
    case "${FAKE_MAKE_MODE:-success}" in
      fail)
        printf '%s\n' "fake make shud failure" >&2
        exit 42
        ;;
      hang)
        sleep 10
        exit 0
        ;;
      large-output)
        i=0
        while [ "$i" -lt 2000 ]; do
          printf 'fake build output line %04d abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz\n' "$i"
          i=$((i + 1))
        done
        printf '%s\n' '#!/usr/bin/env sh' > shud
        printf '%s\n' 'exit 0' >> shud
        chmod +x shud
        exit 0
        ;;
      missing)
        exit 0
        ;;
      residual)
        printf '%s\n' '#!/usr/bin/env sh' > shud
        printf '%s\n' 'exit 0' >> shud
        chmod +x shud
        printf '%s\n' '#!/usr/bin/env sh' > shud_omp
        chmod +x shud_omp
        : > residual.o
        : > shud.cache
        mkdir -p shud.dSYM
        printf '%s\n' "debug residue" > shud.dSYM/marker
        mkdir -p SHUD.build
        printf '%s\n' "xcode residue" > SHUD.build/marker
        exit 0
        ;;
      success)
        printf '%s\n' '#!/usr/bin/env sh' > shud
        printf '%s\n' 'exit 0' >> shud
        chmod +x shud
        exit 0
        ;;
      *)
        printf 'unknown FAKE_MAKE_MODE: %s\n' "$FAKE_MAKE_MODE" >&2
        exit 99
        ;;
    esac
    ;;
  *)
    printf 'unexpected make target: %s\n' "$target" >&2
    exit 98
    ;;
esac
EOF
  chmod +x "$bin_dir/make"

  cat > "$bin_dir/Rscript" <<'EOF'
#!/usr/bin/env sh
set -eu
if [ "${FAKE_RSHUD_VERSION:-2.5.0}" = "error" ]; then
  printf '%s\n' "there is no package called 'rSHUD'" >&2
  exit 1
fi
printf '%s' "${FAKE_RSHUD_VERSION:-2.5.0}"
EOF
  chmod +x "$bin_dir/Rscript"

  cat > "$bin_dir/g++" <<'EOF'
#!/usr/bin/env sh
set -eu
printf '%s\n' 'fake g++ 99.0.0'
EOF
  chmod +x "$bin_dir/g++"
}

init_git_repo() {
  repo=$1
  git -C "$repo" init -q
  git -C "$repo" config user.email "readiness-test@example.invalid"
  git -C "$repo" config user.name "readiness-test"
  git -C "$repo" config core.autocrlf false
  git -C "$repo" config advice.addEmbeddedRepo false
}

make_fixture() {
  fixture=$1
  mkdir -p "$fixture/SHUD" "$fixture/rSHUD" "$fixture/fake-home/sundials/include/sundials" "$fixture/fake-home/sundials/lib"
  init_git_repo "$fixture"
  printf '%s\n' '/workspace/readiness/*.json' > "$fixture/.gitignore"

  cat > "$fixture/SHUD/Makefile" <<'EOF'
SUNDIALS_DIR = $(HOME)/sundials
CC = g++
shud:
	@true
clean:
	@true
EOF
  init_git_repo "$fixture/SHUD"
  cat > "$fixture/SHUD/.gitignore" <<'EOF'
shud
shud.*
SHUD.*
*.o
*.dSYM
EOF
  git -C "$fixture/SHUD" add Makefile .gitignore
  git -C "$fixture/SHUD" commit -q -m "fixture shud"

  cat > "$fixture/rSHUD/DESCRIPTION" <<'EOF'
Package: rSHUD
Version: 2.5.0
EOF
  init_git_repo "$fixture/rSHUD"
  git -C "$fixture/rSHUD" add DESCRIPTION
  git -C "$fixture/rSHUD" commit -q -m "fixture rshud"

  git -C "$fixture" add .gitignore SHUD rSHUD >/dev/null 2>/dev/null
  git -C "$fixture" commit -q -m "fixture root"

  cat > "$fixture/fake-home/sundials/include/sundials/sundials_config.h" <<'EOF'
#define SUNDIALS_VERSION "6.0.0"
EOF
  : > "$fixture/fake-home/sundials/lib/libsundials_cvode.dylib"
  : > "$fixture/fake-home/sundials/lib/libsundials_nvecserial.dylib"
}

run_helper() {
  fixture=$1
  output=$2
  shift 2
  helper_fake_make_mode=${FAKE_MAKE_MODE:-success}
  helper_fake_make_clean_mode=${FAKE_MAKE_CLEAN_MODE:-minimal}
  helper_fake_rshud_version=${FAKE_RSHUD_VERSION:-2.5.0}
  helper_make_timeout=${SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS:-3}
  set +e
  FAKE_MAKE_MODE="$helper_fake_make_mode" \
    FAKE_MAKE_CLEAN_MODE="$helper_fake_make_clean_mode" \
    FAKE_RSHUD_VERSION="$helper_fake_rshud_version" \
    SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS="$helper_make_timeout" \
    PATH="$TMP_ROOT/bin:$PATH" \
    HOME="$fixture/fake-home" \
    "$HELPER" --repo-root "$fixture" --output "$output" "$@"
  helper_status=$?
  set -e
  unset FAKE_MAKE_MODE FAKE_MAKE_CLEAN_MODE FAKE_RSHUD_VERSION SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS
  unset helper_fake_make_mode helper_fake_make_clean_mode helper_fake_rshud_version helper_make_timeout
  return "$helper_status"
}

run_helper_default_output() {
  fixture=$1
  shift
  helper_fake_make_mode=${FAKE_MAKE_MODE:-success}
  helper_fake_make_clean_mode=${FAKE_MAKE_CLEAN_MODE:-minimal}
  helper_fake_rshud_version=${FAKE_RSHUD_VERSION:-2.5.0}
  helper_make_timeout=${SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS:-3}
  set +e
  FAKE_MAKE_MODE="$helper_fake_make_mode" \
    FAKE_MAKE_CLEAN_MODE="$helper_fake_make_clean_mode" \
    FAKE_RSHUD_VERSION="$helper_fake_rshud_version" \
    SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS="$helper_make_timeout" \
    PATH="$TMP_ROOT/bin:$PATH" \
    HOME="$fixture/fake-home" \
    "$HELPER" --repo-root "$fixture" "$@"
  helper_status=$?
  set -e
  unset FAKE_MAKE_MODE FAKE_MAKE_CLEAN_MODE FAKE_RSHUD_VERSION SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS
  unset helper_fake_make_mode helper_fake_make_clean_mode helper_fake_rshud_version helper_make_timeout
  return "$helper_status"
}

assert_json() {
  path=$1
  expected_conclusion=$2
  expected_error=$3
  python3 - "$path" "$expected_conclusion" "$expected_error" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
expected_conclusion = sys.argv[2]
expected_error = sys.argv[3]
data = json.loads(path.read_text(encoding="utf-8"))
if data.get("conclusion") != expected_conclusion:
    raise SystemExit(f"expected conclusion {expected_conclusion}, got {data.get('conclusion')}")
errors = "\n".join(data.get("errors", []))
incomplete_reasons = "\n".join(data.get("incomplete_reasons", []))
evidence_text = "\n".join(part for part in (errors, incomplete_reasons) if part)
if expected_error != "-" and expected_error not in evidence_text:
    raise SystemExit(f"expected error containing {expected_error!r}, got {evidence_text!r}")
if expected_conclusion == "pass" and evidence_text:
    raise SystemExit(f"pass conclusion has errors/incomplete reasons: {evidence_text}")
if data["rshud"]["submodule_description"].get("supporting_evidence_only") is not True:
    raise SystemExit("rSHUD DESCRIPTION is not marked supporting-only")
if data["rshud"]["installed"].get("version") is None:
    raise SystemExit("missing installed rSHUD version evidence")
PY
}

assert_json_expr() {
  path=$1
  expression=$2
  python3 - "$path" "$expression" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
expression = sys.argv[2]
allowed_globals = {"__builtins__": {}, "data": data, "len": len, "str": str, "any": any, "all": all}
allowed_locals = dict(allowed_globals)
if not eval(expression, allowed_globals, allowed_locals):
    raise SystemExit(f"JSON assertion failed: {expression}")
PY
}

assert_no_shud_artifacts() {
  fixture=$1
  residues=$(find "$fixture/SHUD" -maxdepth 1 \( -name shud -o -name shud_omp -o -name shud_debug -o -name '*.o' -o -name '*.dSYM' -o -name 'shud.*' -o -name 'SHUD.*' \) -print)
  if [ -n "$residues" ]; then
    printf '%s\n' "$residues" >&2
    fail "SHUD build artifacts remain in fixture"
  fi
}

make_fake_bin "$TMP_ROOT/bin"

pass_fixture="$TMP_ROOT/pass-fixture"
make_fixture "$pass_fixture"
pass_output="$pass_fixture/workspace/readiness/shud_rshud_readiness.json"
FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$pass_fixture" "$pass_output" --cleanup >/dev/null
assert_json "$pass_output" pass -
assert_no_shud_artifacts "$pass_fixture"
assert_json_expr "$pass_output" 'data["shud"]["build"]["cleanup_requested"] is True'
assert_json_expr "$pass_output" 'data["shud"]["build"]["pre_clean"]["make_clean"]["timeout_seconds"] == 3'
assert_json_expr "$pass_output" 'data["shud"]["build"]["result"]["timeout_seconds"] == 3'
assert_json_expr "$pass_output" 'data["shud"]["build"]["cleanup"]["make_clean"]["timeout_seconds"] == 3'
if ! git -C "$pass_fixture" check-ignore --no-index -q workspace/readiness/shud_rshud_readiness.json; then
  fail "fixture default readiness output is not ignored"
fi
fixture_workspace_status=$(git -C "$pass_fixture" status --short -- workspace)
if [ -n "$fixture_workspace_status" ]; then
  printf '%s\n' "$fixture_workspace_status" >&2
  fail "fixture workspace output is visible to git"
fi

default_wrapper_fixture="$TMP_ROOT/default-wrapper-fixture"
make_fixture "$default_wrapper_fixture"
default_wrapper_output="$default_wrapper_fixture/workspace/readiness/shud_rshud_readiness.json"
FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper_default_output "$default_wrapper_fixture" >/dev/null
assert_json "$default_wrapper_output" pass -
assert_no_shud_artifacts "$default_wrapper_fixture"
assert_json_expr "$default_wrapper_output" 'data["shud"]["build"]["cleanup_requested"] is True'

external_temp_fixture="$TMP_ROOT/external-temp-fixture"
make_fixture "$external_temp_fixture"
external_temp_output="$TMP_ROOT/external-temp-output.json"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$external_temp_fixture" "$external_temp_output" --skip-build >/dev/null 2>/dev/null; then
  fail "skip-build fixture unexpectedly returned zero"
fi
assert_json "$external_temp_output" incomplete -
assert_json_expr "$external_temp_output" 'data["errors"] == []'
assert_json_expr "$external_temp_output" 'data["shud"]["build"]["skipped"] is True'
assert_json_expr "$external_temp_output" 'any("--skip-build" in reason for reason in data["incomplete_reasons"])'

skip_residue_fixture="$TMP_ROOT/skip-residue-fixture"
make_fixture "$skip_residue_fixture"
mkdir -p "$skip_residue_fixture/SHUD/shud.dSYM"
printf '%s\n' "pre-existing residue" > "$skip_residue_fixture/SHUD/shud.dSYM/marker"
skip_residue_output="$TMP_ROOT/skip-residue-output.json"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$skip_residue_fixture" "$skip_residue_output" --skip-build >/dev/null 2>/dev/null; then
  fail "skip-build residue fixture unexpectedly returned zero"
fi
assert_json "$skip_residue_output" incomplete "SHUD build artifacts are present while --skip-build collected env-only evidence"

sundials_conflict_fixture="$TMP_ROOT/sundials-conflict-fixture"
make_fixture "$sundials_conflict_fixture"
mkdir -p "$sundials_conflict_fixture/alt-sundials/include/sundials" "$sundials_conflict_fixture/alt-sundials/lib"
cat > "$sundials_conflict_fixture/alt-sundials/include/sundials/sundials_config.h" <<'EOF'
#define SUNDIALS_VERSION "9.9.9"
EOF
: > "$sundials_conflict_fixture/alt-sundials/lib/libsundials_cvode.dylib"
: > "$sundials_conflict_fixture/alt-sundials/lib/libsundials_nvecserial.dylib"
sundials_conflict_output="$TMP_ROOT/sundials-conflict-output.json"
export SUNDIALS_DIR="$sundials_conflict_fixture/alt-sundials"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$sundials_conflict_fixture" "$sundials_conflict_output" --skip-build >/dev/null 2>/dev/null; then
  unset SUNDIALS_DIR
  fail "SUNDIALS conflict skip-build fixture unexpectedly returned zero"
fi
unset SUNDIALS_DIR
assert_json "$sundials_conflict_output" incomplete -
assert_json_expr "$sundials_conflict_output" 'data["sundials"]["selected"]["path"].endswith("/fake-home/sundials")'
assert_json_expr "$sundials_conflict_output" 'data["sundials"]["selected"]["version"] == "6.0.0"'
assert_json_expr "$sundials_conflict_output" 'any(candidate["path"].endswith("/alt-sundials") and candidate["version"] == "9.9.9" for candidate in data["sundials"]["candidates"])'

dirty_shud_fixture="$TMP_ROOT/dirty-shud-fixture"
make_fixture "$dirty_shud_fixture"
printf '%s\n' "# dirty SHUD fixture" >> "$dirty_shud_fixture/SHUD/Makefile"
dirty_shud_output="$TMP_ROOT/dirty-shud-output.json"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$dirty_shud_fixture" "$dirty_shud_output" >/dev/null 2>/dev/null; then
  fail "dirty SHUD fixture unexpectedly returned zero"
fi
assert_json "$dirty_shud_output" block "SHUD checkout has uncommitted or visible changes"

dirty_rshud_fixture="$TMP_ROOT/dirty-rshud-fixture"
make_fixture "$dirty_rshud_fixture"
printf '%s\n' "# dirty rSHUD fixture" >> "$dirty_rshud_fixture/rSHUD/DESCRIPTION"
dirty_rshud_output="$TMP_ROOT/dirty-rshud-output.json"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$dirty_rshud_fixture" "$dirty_rshud_output" >/dev/null 2>/dev/null; then
  fail "dirty rSHUD fixture unexpectedly returned zero"
fi
assert_json "$dirty_rshud_output" block "rSHUD checkout has uncommitted or visible changes"

workspace_drift_fixture="$TMP_ROOT/workspace-drift-fixture"
make_fixture "$workspace_drift_fixture"
: > "$workspace_drift_fixture/.gitignore"
git -C "$workspace_drift_fixture" add .gitignore
git -C "$workspace_drift_fixture" commit -q -m "make workspace visible"
mkdir -p "$workspace_drift_fixture/workspace/readiness"
printf '%s\n' "visible workspace drift" > "$workspace_drift_fixture/workspace/readiness/visible.txt"
workspace_drift_output="$TMP_ROOT/workspace-drift-output.json"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$workspace_drift_fixture" "$workspace_drift_output" >/dev/null 2>/dev/null; then
  fail "visible workspace drift fixture unexpectedly returned zero"
fi
assert_json "$workspace_drift_output" block "workspace/SHUD/rSHUD source boundary has uncommitted or visible changes"

status_failure_fixture="$TMP_ROOT/status-failure-fixture"
make_fixture "$status_failure_fixture"
rm -rf "$status_failure_fixture/rSHUD/.git"
status_failure_output="$TMP_ROOT/status-failure-output.json"
export GIT_CEILING_DIRECTORIES="$status_failure_fixture"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$status_failure_fixture" "$status_failure_output" >/dev/null 2>/dev/null; then
  unset GIT_CEILING_DIRECTORIES
  fail "status failure fixture unexpectedly returned zero"
fi
unset GIT_CEILING_DIRECTORIES
assert_json "$status_failure_output" block "rSHUD checkout git status failed"

residual_artifact_fixture="$TMP_ROOT/residual-artifact-fixture"
make_fixture "$residual_artifact_fixture"
residual_artifact_output="$residual_artifact_fixture/workspace/readiness/residual_artifact.json"
FAKE_MAKE_MODE=residual FAKE_RSHUD_VERSION=2.5.0 run_helper "$residual_artifact_fixture" "$residual_artifact_output" >/dev/null
assert_json "$residual_artifact_output" pass -
assert_no_shud_artifacts "$residual_artifact_fixture"
assert_json_expr "$residual_artifact_output" 'all(name in [artifact["name"] for artifact in data["shud"]["build"]["artifact_inventory_after_build"]] for name in ["shud_omp", "residual.o", "shud.cache", "shud.dSYM", "SHUD.build"])'
assert_json_expr "$residual_artifact_output" 'all(artifact["git_ignored"] is True for artifact in data["shud"]["build"]["artifact_inventory_after_build"] if artifact["name"] in ["shud.cache", "SHUD.build"])'

tracked_residue_fixture="$TMP_ROOT/tracked-residue-fixture"
make_fixture "$tracked_residue_fixture"
mkdir -p "$tracked_residue_fixture/SHUD/shud.dSYM"
printf '%s\n' "tracked residue" > "$tracked_residue_fixture/SHUD/shud.dSYM/marker"
printf '%s\n' "tracked shud dot residue" > "$tracked_residue_fixture/SHUD/shud.tracked"
mkdir -p "$tracked_residue_fixture/SHUD/SHUD.keep"
printf '%s\n' "tracked SHUD dot residue" > "$tracked_residue_fixture/SHUD/SHUD.keep/marker"
git -C "$tracked_residue_fixture/SHUD" add -f shud.dSYM/marker shud.tracked SHUD.keep/marker
git -C "$tracked_residue_fixture/SHUD" commit -q -m "tracked residue"
git -C "$tracked_residue_fixture" -c advice.addEmbeddedRepo=false add SHUD >/dev/null 2>/dev/null
git -C "$tracked_residue_fixture" commit -q -m "advance shud gitlink"
tracked_residue_output="$tracked_residue_fixture/workspace/readiness/tracked_residue.json"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$tracked_residue_fixture" "$tracked_residue_output" >/dev/null 2>/dev/null; then
  fail "tracked residue fixture unexpectedly returned zero"
fi
assert_json "$tracked_residue_output" block "SHUD pre-build cleanup left build artifacts in SHUD checkout"
if [ ! -e "$tracked_residue_fixture/SHUD/shud.dSYM/marker" ] || [ ! -e "$tracked_residue_fixture/SHUD/shud.tracked" ] || [ ! -e "$tracked_residue_fixture/SHUD/SHUD.keep/marker" ]; then
  fail "tracked matching SHUD artifacts were removed"
fi
assert_json_expr "$tracked_residue_output" 'all(name in [artifact["name"] for artifact in data["shud"]["build"]["pre_clean"]["artifact_inventory_after_cleanup"]] for name in ["shud.dSYM", "shud.tracked", "SHUD.keep"])'
assert_json_expr "$tracked_residue_output" 'all(artifact["tracked"] is True and artifact["removable"] is False for artifact in data["shud"]["build"]["pre_clean"]["artifact_inventory_after_cleanup"] if artifact["name"] in ["shud.dSYM", "shud.tracked", "SHUD.keep"])'

clean_hang_fixture="$TMP_ROOT/clean-hang-fixture"
make_fixture "$clean_hang_fixture"
clean_hang_output="$clean_hang_fixture/workspace/readiness/clean_hang.json"
if FAKE_MAKE_CLEAN_MODE=hang SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS=1 FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$clean_hang_fixture" "$clean_hang_output" >/dev/null 2>/dev/null; then
  fail "make clean hang fixture unexpectedly returned zero"
fi
assert_json "$clean_hang_output" block "SHUD pre-build make clean failed"
assert_json_expr "$clean_hang_output" 'data["shud"]["build"]["pre_clean"]["make_clean"]["timed_out"] is True'

build_hang_fixture="$TMP_ROOT/build-hang-fixture"
make_fixture "$build_hang_fixture"
build_hang_output="$build_hang_fixture/workspace/readiness/build_hang.json"
if FAKE_MAKE_CLEAN_MODE=minimal FAKE_MAKE_MODE=hang SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS=1 FAKE_RSHUD_VERSION=2.5.0 run_helper "$build_hang_fixture" "$build_hang_output" >/dev/null 2>/dev/null; then
  fail "make shud hang fixture unexpectedly returned zero"
fi
assert_json "$build_hang_output" block "SHUD build command failed"
assert_json_expr "$build_hang_output" 'data["shud"]["build"]["result"]["timed_out"] is True'

large_output_fixture="$TMP_ROOT/large-output-fixture"
make_fixture "$large_output_fixture"
large_output_output="$large_output_fixture/workspace/readiness/large_output.json"
FAKE_MAKE_CLEAN_MODE=minimal FAKE_MAKE_MODE=large-output FAKE_RSHUD_VERSION=2.5.0 run_helper "$large_output_fixture" "$large_output_output" >/dev/null
assert_json "$large_output_output" pass -
assert_json_expr "$large_output_output" 'data["shud"]["build"]["result"]["stdout_truncated"] is True'
assert_json_expr "$large_output_output" 'len(data["shud"]["build"]["result"]["stdout_tail"]) <= 12000'
assert_no_shud_artifacts "$large_output_fixture"

large_clean_output_fixture="$TMP_ROOT/large-clean-output-fixture"
make_fixture "$large_clean_output_fixture"
large_clean_output="$large_clean_output_fixture/workspace/readiness/large_clean_output.json"
FAKE_MAKE_CLEAN_MODE=large-output FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$large_clean_output_fixture" "$large_clean_output" >/dev/null
assert_json "$large_clean_output" pass -
assert_json_expr "$large_clean_output" 'data["shud"]["build"]["pre_clean"]["make_clean"]["stdout_truncated"] is True'
assert_json_expr "$large_clean_output" 'data["shud"]["build"]["cleanup"]["make_clean"]["stdout_truncated"] is True'

build_failure_fixture="$TMP_ROOT/build-failure-fixture"
make_fixture "$build_failure_fixture"
build_failure_output="$build_failure_fixture/workspace/readiness/build_failure.json"
if FAKE_MAKE_CLEAN_MODE=minimal FAKE_MAKE_MODE=fail FAKE_RSHUD_VERSION=2.5.0 run_helper "$build_failure_fixture" "$build_failure_output" >/dev/null 2>/dev/null; then
  fail "SHUD build failure fixture unexpectedly returned zero"
fi
assert_json "$build_failure_output" block "SHUD build command failed"

missing_artifact_fixture="$TMP_ROOT/missing-artifact-fixture"
make_fixture "$missing_artifact_fixture"
missing_artifact_output="$missing_artifact_fixture/workspace/readiness/missing_artifact.json"
if FAKE_MAKE_CLEAN_MODE=minimal FAKE_MAKE_MODE=missing FAKE_RSHUD_VERSION=2.5.0 run_helper "$missing_artifact_fixture" "$missing_artifact_output" >/dev/null 2>/dev/null; then
  fail "missing executable fixture unexpectedly returned zero"
fi
assert_json "$missing_artifact_output" block "SHUD/shud does not exist"

low_rshud_fixture="$TMP_ROOT/low-rshud-fixture"
make_fixture "$low_rshud_fixture"
low_rshud_output="$low_rshud_fixture/workspace/readiness/low_rshud.json"
if FAKE_MAKE_CLEAN_MODE=minimal FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.4.9 run_helper "$low_rshud_fixture" "$low_rshud_output" >/dev/null 2>/dev/null; then
  fail "low rSHUD fixture unexpectedly returned zero"
fi
assert_json "$low_rshud_output" block "installed rSHUD version 2.4.9 is below required 2.5.0"

bad_output_fixture="$TMP_ROOT/bad-output-fixture"
make_fixture "$bad_output_fixture"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$bad_output_fixture" "$bad_output_fixture/not-readiness.json" --skip-build >/dev/null 2>/dev/null; then
  fail "repo-local output outside workspace/readiness unexpectedly returned zero"
fi
if [ -e "$bad_output_fixture/not-readiness.json" ]; then
  fail "helper wrote repo-local output outside workspace/readiness"
fi

repo_external_forbidden_fixture="$TMP_ROOT/repo-external-forbidden-fixture"
make_fixture "$repo_external_forbidden_fixture"
repo_parent=$(CDPATH= cd -- "$REPO_ROOT/.." && pwd)
repo_external_forbidden_output="$repo_parent/.shud-rshud-readiness-forbidden-$(basename "$TMP_ROOT").json"
if [ -e "$repo_external_forbidden_output" ]; then
  fail "forbidden absolute output fixture path already exists"
fi
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$repo_external_forbidden_fixture" "$repo_external_forbidden_output" --skip-build >/dev/null 2>/dev/null; then
  fail "repo-external non-temp absolute output unexpectedly returned zero"
fi
if [ -e "$repo_external_forbidden_output" ]; then
  fail "helper wrote repo-external non-temp absolute output"
fi

symlink_workspace_fixture="$TMP_ROOT/symlink-workspace-fixture"
make_fixture "$symlink_workspace_fixture"
mkdir -p "$TMP_ROOT/outside-workspace/readiness"
ln -s "$TMP_ROOT/outside-workspace" "$symlink_workspace_fixture/workspace"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$symlink_workspace_fixture" "$symlink_workspace_fixture/workspace/readiness/escape.json" --skip-build >/dev/null 2>/dev/null; then
  fail "workspace symlink escape unexpectedly returned zero"
fi
if [ -e "$TMP_ROOT/outside-workspace/readiness/escape.json" ]; then
  fail "helper wrote through workspace symlink escape"
fi

LIVE_STATUS_AFTER=$(git -C "$REPO_ROOT" status --short -- SHUD rSHUD workspace)
if [ "$LIVE_STATUS_BEFORE" != "$LIVE_STATUS_AFTER" ]; then
  printf '%s\n' "$LIVE_STATUS_BEFORE" >&2
  printf '%s\n' "$LIVE_STATUS_AFTER" >&2
  fail "live SHUD/rSHUD/workspace status changed"
fi

printf '%s\n' "self-test passed"

#!/usr/bin/env sh
set -eu
umask 022

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
HELPER="$SCRIPT_DIR/check_shud_rshud.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/shud-rshud-readiness-test.XXXXXX")
REAL_GIT=$(command -v git)
REAL_PYTHON=$(command -v python3)
REAL_PYTHON_REALPATH=$("$REAL_PYTHON" -c 'from pathlib import Path; import sys; print(Path(sys.executable).resolve())')
SELF_TEST_TOOL_ALLOWANCE_TOKEN=allow-fixture-tools

git() {
  (
    for git_env_name in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do
      unset "$git_env_name"
    done
    command "$REAL_GIT" "$@"
  )
}

LIVE_STATUS_BEFORE=$(git -C "$REPO_ROOT" status --short -- SHUD rSHUD workspace)

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'self-test failed: %s\n' "$1" >&2
  exit 1
}

assert_repo_owned_ignore() {
  repo=$1
  path=$2
  label=$3
  ignore_output=$(git -C "$repo" -c core.excludesFile=/dev/null check-ignore -v --no-index -- "$path" 2>/dev/null) || {
    fail "$label is not ignored by repo-owned rules"
  }
  ignore_source=${ignore_output%%:*}
  case "$ignore_source" in
    .gitignore|*/.gitignore)
      ;;
    *)
      printf '%s\n' "$ignore_output" >&2
      fail "$label ignore source is not a repo-owned .gitignore"
      ;;
  esac
}

clear_make_environment() {
  unset MAKEFLAGS GNUMAKEFLAGS MFLAGS MAKEFILES
  unset CC CXX SUNDIALS_DIR
  unset STCFLAG CFLAGS INCLUDES LIBRARIES RPATH LK_FLAGS LK_OMP LK_DYLN
  unset TARGET_EXEC TARGET_OMP TARGET_DEBUG
  unset MAIN_shud MAIN_OMP MAIN_DEBUG
  unset SRC SRC_H BUILDDIR SRC_DIR
  unset LIB_SUN LIB_SYS INC_OMP LIB_OMP INC_MPI MPICC
}

export_make_environment() {
  export MAKEFLAGS GNUMAKEFLAGS MFLAGS MAKEFILES
  export CC CXX SUNDIALS_DIR
  export STCFLAG CFLAGS INCLUDES LIBRARIES RPATH LK_FLAGS LK_OMP LK_DYLN
  export TARGET_EXEC TARGET_OMP TARGET_DEBUG
  export MAIN_shud MAIN_OMP MAIN_DEBUG
  export SRC SRC_H BUILDDIR SRC_DIR
  export LIB_SUN LIB_SYS INC_OMP LIB_OMP INC_MPI MPICC
}

assert_repo_owned_ignore "$REPO_ROOT" workspace/readiness/shud_rshud_readiness.json "root runtime shud/rshud readiness output"

make_fake_bin() {
  bin_dir=$1
  mkdir -p "$bin_dir"
  cat > "$bin_dir/make" <<'EOF'
#!/usr/bin/env sh
set -eu
target=${1:-}
if [ -n "${FAKE_MAKE_MARKER:-}" ]; then
  printf '%s\n' "$target" >> "$FAKE_MAKE_MARKER"
fi
case "$target" in
  clean)
    if [ -n "${FAKE_MAKE_HONOR_TARGET_OMP_ON_CLEAN:-}" ] && [ -n "${TARGET_OMP:-}" ]; then
      rm -f "$TARGET_OMP"
    fi
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

  cat > "$bin_dir/rm" <<'EOF'
#!/usr/bin/env sh
set -eu
if [ -n "${FAKE_RM_MARKER:-}" ]; then
  printf '%s\n' "fake rm invoked" >> "$FAKE_RM_MARKER"
fi
exit 64
EOF
  chmod +x "$bin_dir/rm"

  cat > "$bin_dir/Rscript" <<'EOF'
#!/usr/bin/env sh
set -eu
case "${FAKE_RSHUD_VERSION:-2.5.0}" in
  error)
    printf '%s\n' "there is no package called 'rSHUD'" >&2
    exit 1
    ;;
  missing)
    printf '%s\n' "Rscript command not found" >&2
    exit 127
    ;;
  noisy-stdout-low)
    printf '%s\n' "unrelated tool 9.9.9"
    printf '%s\n' "RSHUD_VERSION=2.4.9"
    ;;
  stderr-high-low)
    printf '%s\n' "RSHUD_VERSION=2.4.9"
    printf '%s\n' "loaded dependency 9.9.9" >&2
    ;;
  *)
    printf 'RSHUD_VERSION=%s\n' "${FAKE_RSHUD_VERSION:-2.5.0}"
    ;;
esac
EOF
  chmod +x "$bin_dir/Rscript"

  cat > "$bin_dir/g++" <<'EOF'
#!/usr/bin/env sh
set -eu
printf '%s\n' 'fake g++ 99.0.0'
EOF
  chmod +x "$bin_dir/g++"

  real_git=$REAL_GIT
  cat > "$bin_dir/git" <<EOF
#!/usr/bin/env sh
set -eu
real_git='$real_git'
if [ -n "\${FAKE_GIT_FAIL_STATUS_FOR:-}" ]; then
  git_cwd=''
  git_saw_status=''
  git_previous=''
  for git_arg in "\$@"; do
    if [ "\$git_previous" = "-C" ]; then
      git_cwd="\$git_arg"
      git_previous=''
      continue
    fi
    if [ "\$git_arg" = "-C" ]; then
      git_previous='-C'
      continue
    fi
    if [ "\$git_arg" = "status" ]; then
      git_saw_status=1
    fi
  done
  if [ "\$git_saw_status" = "1" ] && [ "\$git_cwd" = "\$FAKE_GIT_FAIL_STATUS_FOR" ]; then
    printf '%s\n' "\${FAKE_GIT_FAIL_MESSAGE:-fake git status failure}" >&2
    exit "\${FAKE_GIT_FAIL_STATUS_CODE:-128}"
  fi
fi
if [ -n "\${FAKE_GIT_DELAY_ON_TRACKED_OUTPUT:-}" ] && [ -s "\$FAKE_GIT_DELAY_ON_TRACKED_OUTPUT" ]; then
  case " \$* " in
    *" status "*)
      sleep "\${FAKE_GIT_DELAY_SECONDS:-1}"
      ;;
  esac
fi
exec "\$real_git" "\$@"
EOF
  chmod +x "$bin_dir/git"
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
SRC_DIR = src
MAIN_shud = ${SRC_DIR}/main.cpp
MAIN_OMP = ${SRC_DIR}/main.cpp
MAIN_DEBUG = ${SRC_DIR}/main.cpp
SRC = ${SRC_DIR}/*.cpp
SRC_H = ${SRC_DIR}/*.hpp
TARGET_EXEC = ./shud
TARGET_OMP = ./shud_omp
TARGET_DEBUG = ./shud_debug
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

install_hostile_git_config() {
  fixture=$1
  hostile_excludes="$fixture/hostile-global-excludes"
  printf '%s\n' 'workspace/readiness/*.json' > "$hostile_excludes"
  HOME="$fixture/fake-home" git config --global status.showUntrackedFiles no
  HOME="$fixture/fake-home" git config --global core.excludesFile "$hostile_excludes"
  git -C "$fixture" config status.showUntrackedFiles no
}

run_helper() {
  fixture=$1
  output=$2
  shift 2
  helper_fake_make_mode=${FAKE_MAKE_MODE:-success}
  helper_fake_make_clean_mode=${FAKE_MAKE_CLEAN_MODE:-minimal}
  helper_fake_rshud_version=${FAKE_RSHUD_VERSION:-2.5.0}
  helper_make_timeout=${SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS:-3}
  helper_fake_make_marker=${FAKE_MAKE_MARKER:-}
  helper_fake_git_delay_on_tracked_output=${FAKE_GIT_DELAY_ON_TRACKED_OUTPUT:-}
  helper_fake_git_delay_seconds=${FAKE_GIT_DELAY_SECONDS:-1}
  helper_fake_git_fail_status_for=${FAKE_GIT_FAIL_STATUS_FOR:-}
  helper_fake_git_fail_message=${FAKE_GIT_FAIL_MESSAGE:-}
  helper_fake_git_fail_status_code=${FAKE_GIT_FAIL_STATUS_CODE:-128}
  helper_fake_make_honor_target_omp_on_clean=${FAKE_MAKE_HONOR_TARGET_OMP_ON_CLEAN:-}
  helper_fake_rm_marker=${FAKE_RM_MARKER:-}
  helper_preserve_make_env=${PRESERVE_MAKE_ENV:-}
  helper_allow_self_test_tools=${ALLOW_SELF_TEST_TOOLS:-1}
  helper_self_test_cli=${SELF_TEST_CLI:-1}
  helper_self_test_tool_dir=
  helper_self_test_tool_token=
  helper_self_test_arg=
  if [ "$helper_allow_self_test_tools" = "1" ]; then
    helper_self_test_tool_dir="$TMP_ROOT/bin"
    helper_self_test_tool_token="$SELF_TEST_TOOL_ALLOWANCE_TOKEN"
    if [ "$helper_self_test_cli" = "1" ]; then
      helper_self_test_arg=--self-test
    fi
  fi
  set +e
  if [ "$helper_preserve_make_env" = "1" ]; then
    export_make_environment
    FAKE_MAKE_MODE="$helper_fake_make_mode" \
      FAKE_MAKE_CLEAN_MODE="$helper_fake_make_clean_mode" \
      FAKE_RSHUD_VERSION="$helper_fake_rshud_version" \
      FAKE_MAKE_MARKER="$helper_fake_make_marker" \
      FAKE_GIT_DELAY_ON_TRACKED_OUTPUT="$helper_fake_git_delay_on_tracked_output" \
      FAKE_GIT_DELAY_SECONDS="$helper_fake_git_delay_seconds" \
      FAKE_GIT_FAIL_STATUS_FOR="$helper_fake_git_fail_status_for" \
      FAKE_GIT_FAIL_MESSAGE="$helper_fake_git_fail_message" \
      FAKE_GIT_FAIL_STATUS_CODE="$helper_fake_git_fail_status_code" \
      FAKE_MAKE_HONOR_TARGET_OMP_ON_CLEAN="$helper_fake_make_honor_target_omp_on_clean" \
      FAKE_RM_MARKER="$helper_fake_rm_marker" \
      SHUD_RSHUD_READINESS_SELF_TEST_TOOL_DIR="$helper_self_test_tool_dir" \
      SHUD_RSHUD_READINESS_ENABLE_SELF_TEST_TOOL_ALLOWANCE="$helper_self_test_tool_token" \
      SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS="$helper_make_timeout" \
      PATH="$TMP_ROOT/bin:$PATH" \
      HOME="$fixture/fake-home" \
      "$HELPER" --repo-root "$fixture" --output "$output" $helper_self_test_arg "$@"
  else
    (
      clear_make_environment
      FAKE_MAKE_MODE="$helper_fake_make_mode" \
        FAKE_MAKE_CLEAN_MODE="$helper_fake_make_clean_mode" \
        FAKE_RSHUD_VERSION="$helper_fake_rshud_version" \
        FAKE_MAKE_MARKER="$helper_fake_make_marker" \
        FAKE_GIT_DELAY_ON_TRACKED_OUTPUT="$helper_fake_git_delay_on_tracked_output" \
        FAKE_GIT_DELAY_SECONDS="$helper_fake_git_delay_seconds" \
        FAKE_GIT_FAIL_STATUS_FOR="$helper_fake_git_fail_status_for" \
        FAKE_GIT_FAIL_MESSAGE="$helper_fake_git_fail_message" \
        FAKE_GIT_FAIL_STATUS_CODE="$helper_fake_git_fail_status_code" \
        FAKE_MAKE_HONOR_TARGET_OMP_ON_CLEAN="$helper_fake_make_honor_target_omp_on_clean" \
        FAKE_RM_MARKER="$helper_fake_rm_marker" \
        SHUD_RSHUD_READINESS_SELF_TEST_TOOL_DIR="$helper_self_test_tool_dir" \
        SHUD_RSHUD_READINESS_ENABLE_SELF_TEST_TOOL_ALLOWANCE="$helper_self_test_tool_token" \
        SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS="$helper_make_timeout" \
        PATH="$TMP_ROOT/bin:$PATH" \
        HOME="$fixture/fake-home" \
        "$HELPER" --repo-root "$fixture" --output "$output" $helper_self_test_arg "$@"
    )
  fi
  helper_status=$?
  set -e
  unset FAKE_MAKE_MODE FAKE_MAKE_CLEAN_MODE FAKE_RSHUD_VERSION FAKE_MAKE_MARKER FAKE_GIT_DELAY_ON_TRACKED_OUTPUT FAKE_GIT_DELAY_SECONDS FAKE_GIT_FAIL_STATUS_FOR FAKE_GIT_FAIL_MESSAGE FAKE_GIT_FAIL_STATUS_CODE FAKE_MAKE_HONOR_TARGET_OMP_ON_CLEAN FAKE_RM_MARKER SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS SHUD_RSHUD_READINESS_SELF_TEST_CANDIDATE_LIMIT PRESERVE_MAKE_ENV ALLOW_SELF_TEST_TOOLS SELF_TEST_CLI
  unset helper_fake_make_mode helper_fake_make_clean_mode helper_fake_rshud_version helper_make_timeout helper_fake_make_marker helper_fake_git_delay_on_tracked_output helper_fake_git_delay_seconds helper_fake_git_fail_status_for helper_fake_git_fail_message helper_fake_git_fail_status_code helper_fake_make_honor_target_omp_on_clean helper_fake_rm_marker helper_preserve_make_env helper_allow_self_test_tools helper_self_test_cli helper_self_test_tool_dir helper_self_test_tool_token helper_self_test_arg
  return "$helper_status"
}

run_helper_default_output() {
  fixture=$1
  shift
  helper_fake_make_mode=${FAKE_MAKE_MODE:-success}
  helper_fake_make_clean_mode=${FAKE_MAKE_CLEAN_MODE:-minimal}
  helper_fake_rshud_version=${FAKE_RSHUD_VERSION:-2.5.0}
  helper_make_timeout=${SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS:-3}
  helper_fake_make_marker=${FAKE_MAKE_MARKER:-}
  helper_fake_git_delay_on_tracked_output=${FAKE_GIT_DELAY_ON_TRACKED_OUTPUT:-}
  helper_fake_git_delay_seconds=${FAKE_GIT_DELAY_SECONDS:-1}
  helper_fake_git_fail_status_for=${FAKE_GIT_FAIL_STATUS_FOR:-}
  helper_fake_git_fail_message=${FAKE_GIT_FAIL_MESSAGE:-}
  helper_fake_git_fail_status_code=${FAKE_GIT_FAIL_STATUS_CODE:-128}
  helper_fake_make_honor_target_omp_on_clean=${FAKE_MAKE_HONOR_TARGET_OMP_ON_CLEAN:-}
  helper_fake_rm_marker=${FAKE_RM_MARKER:-}
  helper_preserve_make_env=${PRESERVE_MAKE_ENV:-}
  helper_allow_self_test_tools=${ALLOW_SELF_TEST_TOOLS:-1}
  helper_self_test_cli=${SELF_TEST_CLI:-1}
  helper_self_test_tool_dir=
  helper_self_test_tool_token=
  helper_self_test_arg=
  if [ "$helper_allow_self_test_tools" = "1" ]; then
    helper_self_test_tool_dir="$TMP_ROOT/bin"
    helper_self_test_tool_token="$SELF_TEST_TOOL_ALLOWANCE_TOKEN"
    if [ "$helper_self_test_cli" = "1" ]; then
      helper_self_test_arg=--self-test
    fi
  fi
  set +e
  if [ "$helper_preserve_make_env" = "1" ]; then
    export_make_environment
    FAKE_MAKE_MODE="$helper_fake_make_mode" \
      FAKE_MAKE_CLEAN_MODE="$helper_fake_make_clean_mode" \
      FAKE_RSHUD_VERSION="$helper_fake_rshud_version" \
      FAKE_MAKE_MARKER="$helper_fake_make_marker" \
      FAKE_GIT_DELAY_ON_TRACKED_OUTPUT="$helper_fake_git_delay_on_tracked_output" \
      FAKE_GIT_DELAY_SECONDS="$helper_fake_git_delay_seconds" \
      FAKE_GIT_FAIL_STATUS_FOR="$helper_fake_git_fail_status_for" \
      FAKE_GIT_FAIL_MESSAGE="$helper_fake_git_fail_message" \
      FAKE_GIT_FAIL_STATUS_CODE="$helper_fake_git_fail_status_code" \
      FAKE_MAKE_HONOR_TARGET_OMP_ON_CLEAN="$helper_fake_make_honor_target_omp_on_clean" \
      FAKE_RM_MARKER="$helper_fake_rm_marker" \
      SHUD_RSHUD_READINESS_SELF_TEST_TOOL_DIR="$helper_self_test_tool_dir" \
      SHUD_RSHUD_READINESS_ENABLE_SELF_TEST_TOOL_ALLOWANCE="$helper_self_test_tool_token" \
      SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS="$helper_make_timeout" \
      PATH="$TMP_ROOT/bin:$PATH" \
      HOME="$fixture/fake-home" \
      "$HELPER" --repo-root "$fixture" $helper_self_test_arg "$@"
  else
    (
      clear_make_environment
      FAKE_MAKE_MODE="$helper_fake_make_mode" \
        FAKE_MAKE_CLEAN_MODE="$helper_fake_make_clean_mode" \
        FAKE_RSHUD_VERSION="$helper_fake_rshud_version" \
        FAKE_MAKE_MARKER="$helper_fake_make_marker" \
        FAKE_GIT_DELAY_ON_TRACKED_OUTPUT="$helper_fake_git_delay_on_tracked_output" \
        FAKE_GIT_DELAY_SECONDS="$helper_fake_git_delay_seconds" \
        FAKE_GIT_FAIL_STATUS_FOR="$helper_fake_git_fail_status_for" \
        FAKE_GIT_FAIL_MESSAGE="$helper_fake_git_fail_message" \
        FAKE_GIT_FAIL_STATUS_CODE="$helper_fake_git_fail_status_code" \
        FAKE_MAKE_HONOR_TARGET_OMP_ON_CLEAN="$helper_fake_make_honor_target_omp_on_clean" \
        FAKE_RM_MARKER="$helper_fake_rm_marker" \
        SHUD_RSHUD_READINESS_SELF_TEST_TOOL_DIR="$helper_self_test_tool_dir" \
        SHUD_RSHUD_READINESS_ENABLE_SELF_TEST_TOOL_ALLOWANCE="$helper_self_test_tool_token" \
        SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS="$helper_make_timeout" \
        PATH="$TMP_ROOT/bin:$PATH" \
        HOME="$fixture/fake-home" \
        "$HELPER" --repo-root "$fixture" $helper_self_test_arg "$@"
    )
  fi
  helper_status=$?
  set -e
  unset FAKE_MAKE_MODE FAKE_MAKE_CLEAN_MODE FAKE_RSHUD_VERSION FAKE_MAKE_MARKER FAKE_GIT_DELAY_ON_TRACKED_OUTPUT FAKE_GIT_DELAY_SECONDS FAKE_GIT_FAIL_STATUS_FOR FAKE_GIT_FAIL_MESSAGE FAKE_GIT_FAIL_STATUS_CODE FAKE_MAKE_HONOR_TARGET_OMP_ON_CLEAN FAKE_RM_MARKER SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS SHUD_RSHUD_READINESS_SELF_TEST_CANDIDATE_LIMIT PRESERVE_MAKE_ENV ALLOW_SELF_TEST_TOOLS SELF_TEST_CLI
  unset helper_fake_make_mode helper_fake_make_clean_mode helper_fake_rshud_version helper_make_timeout helper_fake_make_marker helper_fake_git_delay_on_tracked_output helper_fake_git_delay_seconds helper_fake_git_fail_status_for helper_fake_git_fail_message helper_fake_git_fail_status_code helper_fake_make_honor_target_omp_on_clean helper_fake_rm_marker helper_preserve_make_env helper_allow_self_test_tools helper_self_test_cli helper_self_test_tool_dir helper_self_test_tool_token helper_self_test_arg
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
if expected_conclusion == "pass" and data["rshud"]["installed"].get("version") is None:
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

trusted_symlink_prefix="$TMP_ROOT/test-trusted-prefix"
trusted_symlink_target_dir="$TMP_ROOT/test-untrusted-target"
mkdir -p "$trusted_symlink_prefix" "$trusted_symlink_target_dir"
cat > "$trusted_symlink_target_dir/make" <<'EOF'
#!/usr/bin/env sh
exit 0
EOF
chmod +x "$trusted_symlink_target_dir/make"
ln -s "$trusted_symlink_target_dir/make" "$trusted_symlink_prefix/make"
python3 - "$REPO_ROOT" "$trusted_symlink_prefix" "$trusted_symlink_prefix/make" <<'PY'
import importlib.util
import sys
from pathlib import Path

repo_root = Path(sys.argv[1])
trusted_prefix = Path(sys.argv[2])
symlink_path = Path(sys.argv[3])
module_path = repo_root / "scripts" / "readiness" / "check_shud_rshud.py"
spec = importlib.util.spec_from_file_location("check_shud_rshud", module_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)
module.TRUSTED_EXECUTABLE_RESOLVED_PREFIXES = (trusted_prefix,)
identity = module.executable_identity(str(symlink_path))
if identity["trusted"] or identity["ok"]:
    raise SystemExit(f"trusted-prefix symlink to untrusted target was accepted: {identity}")
if "outside trusted tool prefixes" not in (identity["block_reason"] or ""):
    raise SystemExit(f"unexpected symlink rejection reason: {identity['block_reason']}")
PY

trusted_execution_target="$TMP_ROOT/trusted-execution-target"
untrusted_execution_link_dir="$TMP_ROOT/untrusted-execution-link"
mkdir -p "$trusted_execution_target" "$untrusted_execution_link_dir"
cat > "$trusted_execution_target/make" <<'EOF'
#!/bin/sh
printf '%s\n' "trusted execution target"
EOF
chmod +x "$trusted_execution_target/make"
ln -s "$trusted_execution_target/make" "$untrusted_execution_link_dir/make"
python3 - "$REPO_ROOT" "$trusted_execution_target" "$untrusted_execution_link_dir/make" <<'PY'
import importlib.util
import sys
from pathlib import Path

repo_root = Path(sys.argv[1])
trusted_root = Path(sys.argv[2])
symlink_path = Path(sys.argv[3])
module_path = repo_root / "scripts" / "readiness" / "check_shud_rshud.py"
spec = importlib.util.spec_from_file_location("check_shud_rshud", module_path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)
module.TRUSTED_EXECUTABLE_RESOLVED_PREFIXES = (trusted_root,)
result = module.run_command([str(symlink_path)], timeout=5)
if result["exit_code"] != 0:
    raise SystemExit(f"trusted symlink target command failed: {result}")
executed = result["executed_command"][0]
expected = str((trusted_root / "make").resolve())
if executed != expected:
    raise SystemExit(f"expected realpath execution {expected}, got {executed}; result={result}")
if result["executable"]["path"] == result["executable"]["selected_realpath"]:
    raise SystemExit(f"fixture did not exercise symlink path: {result}")
if "trusted execution target" not in result["stdout_tail"]:
    raise SystemExit(f"trusted realpath command did not execute: {result}")
PY

pass_fixture="$TMP_ROOT/pass-fixture"
make_fixture "$pass_fixture"
pass_output="$pass_fixture/workspace/readiness/shud_rshud_readiness.json"
pass_fake_rm_marker="$pass_fixture/fake-rm.marker"
if FAKE_RM_MARKER="$pass_fake_rm_marker" FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$pass_fixture" "$pass_output" --cleanup >/dev/null; then
  fail "self-test fake pass fixture unexpectedly returned zero"
fi
if [ -e "$pass_fake_rm_marker" ]; then
  fail "fake rm from caller PATH was used by make recipe"
fi
assert_json "$pass_output" incomplete "self-test fixture mode"
assert_no_shud_artifacts "$pass_fixture"
assert_json_expr "$pass_output" 'data["conclusion"] != "pass"'
assert_json_expr "$pass_output" 'data["self_test_fixture"]["active"] is True'
assert_json_expr "$pass_output" 'data["self_test_fixture"]["ready_for_consumption"] is False'
assert_json_expr "$pass_output" 'data["runtime_authority"]["ready_for_consumption"] is False'
assert_json_expr "$pass_output" 'data["runtime_authority"]["helper"]["matches_expected"] is False'
assert_json_expr "$pass_output" 'data["runtime_authority"]["wrapper"]["matches_expected"] is False'
assert_json_expr "$pass_output" 'data["runtime_authority"]["python"]["matches_actual"] is True'
assert_json_expr "$pass_output" 'data["runtime_authority"]["python"]["isolated"] is True'
assert_json_expr "$pass_output" 'data["runtime_authority"]["python_import_environment"]["all_absent"] is True'
assert_json_expr "$pass_output" 'data["shud"]["build"]["cleanup_requested"] is True'
assert_json_expr "$pass_output" 'data["shud"]["build"]["pre_clean"]["make_clean"]["timeout_seconds"] == 3'
assert_json_expr "$pass_output" 'data["shud"]["build"]["result"]["timeout_seconds"] == 3'
assert_json_expr "$pass_output" 'data["shud"]["build"]["cleanup"]["make_clean"]["timeout_seconds"] == 3'
assert_json_expr "$pass_output" 'data["shud"]["build"]["pre_clean"]["make_clean"]["recipe_environment"]["PATH"] == data["shud"]["build"]["recipe_environment"]["PATH"]'
assert_json_expr "$pass_output" '"/bin" in data["shud"]["build"]["recipe_environment"]["path_entries"]'
assert_json_expr "$pass_output" 'all("shud-rshud-readiness-test" not in entry for entry in data["shud"]["build"]["recipe_environment"]["path_entries"])'
assert_json_expr "$pass_output" 'data["output"]["git_guard"]["tracked"] is False'
assert_json_expr "$pass_output" 'data["output"]["consumption_boundary"]["ready_for_consumption"] is True'
assert_json_expr "$pass_output" 'data["source_boundary"]["preflight"]["ok"] is True'
assert_json_expr "$pass_output" 'data["source_boundary"]["postflight_after_output_write"]["ok"] is True'
assert_json_expr "$pass_output" 'data["make_environment_guard"]["ok"] is True'
assert_json_expr "$pass_output" 'data["rshud"]["installed"]["parser"]["contract_ok"] is True'
assert_json_expr "$pass_output" 'all(data["tool_identity"][name]["ok"] is True for name in ["git", "make", "Rscript"])'
assert_json_expr "$pass_output" 'all(data["tool_identity"][name]["self_test_allowance"]["active"] is True for name in ["git", "make", "Rscript"])'
assert_json_expr "$pass_output" 'data["output"]["git_guard"]["git_ignore_proof"]["repo_owned"] is True'
assert_json_expr "$pass_output" 'data["output"]["git_guard"]["git_ignore_proof"]["source"]["relative_path"] == ".gitignore"'
assert_json_expr "$pass_output" 'data["output"]["git_guard"]["git_ignore_proof"]["source"]["tracked"] is True'
assert_json_expr "$pass_output" 'data["output"]["git_guard"]["git_ignore_proof"]["source"]["clean"] is True'
assert_json_expr "$pass_output" 'data["checkout_identity"]["ok"] is True'
assert_json_expr "$pass_output" 'data["checkout_identity"]["root"]["head"] is not None'
assert_json_expr "$pass_output" 'data["checkout_identity"]["root"]["dirty"] is False'
assert_json_expr "$pass_output" 'data["checkout_identity"]["submodules"]["SHUD"]["root_gitlink"]["gitlink_object"] is not None'
assert_json_expr "$pass_output" 'data["checkout_identity"]["submodules"]["SHUD"]["checkout"]["head"] is not None'
assert_json_expr "$pass_output" 'data["checkout_identity"]["submodules"]["SHUD"]["checkout"]["dirty"] is False'
assert_json_expr "$pass_output" 'data["checkout_identity"]["submodules"]["rSHUD"]["root_gitlink"]["gitlink_object"] is not None'
assert_json_expr "$pass_output" 'data["checkout_identity"]["submodules"]["rSHUD"]["checkout"]["head"] is not None'
assert_json_expr "$pass_output" 'data["checkout_identity"]["submodules"]["rSHUD"]["checkout"]["dirty"] is False'
assert_json_expr "$pass_output" 'data["checkout_identity"]["paths"]["helper"]["tracked"] is True'
assert_json_expr "$pass_output" 'data["checkout_identity"]["paths"]["helper"]["head_blob_oid"] is not None'
assert_json_expr "$pass_output" 'data["checkout_identity"]["paths"]["helper"]["current_blob_oid"] is not None'
assert_json_expr "$pass_output" 'data["checkout_identity"]["paths"]["wrapper"]["tracked"] is True'
assert_json_expr "$pass_output" 'data["checkout_identity"]["paths"]["wrapper"]["head_blob_oid"] is not None'
assert_json_expr "$pass_output" 'data["checkout_identity"]["paths"]["wrapper"]["current_blob_oid"] is not None'
assert_repo_owned_ignore "$pass_fixture" workspace/readiness/shud_rshud_readiness.json "fixture default readiness output"
fixture_workspace_status=$(git -C "$pass_fixture" status --short -- workspace)
if [ -n "$fixture_workspace_status" ]; then
  printf '%s\n' "$fixture_workspace_status" >&2
  fail "fixture workspace output is visible to git"
fi

default_wrapper_fixture="$TMP_ROOT/default-wrapper-fixture"
make_fixture "$default_wrapper_fixture"
default_wrapper_output="$default_wrapper_fixture/workspace/readiness/shud_rshud_readiness.json"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper_default_output "$default_wrapper_fixture" >/dev/null; then
  fail "self-test fake default-wrapper fixture unexpectedly returned zero"
fi
assert_json "$default_wrapper_output" incomplete "self-test fixture mode"
assert_no_shud_artifacts "$default_wrapper_fixture"
assert_json_expr "$default_wrapper_output" 'data["shud"]["build"]["cleanup_requested"] is True'

ambient_allowance_fixture="$TMP_ROOT/ambient-allowance-fixture"
make_fixture "$ambient_allowance_fixture"
ambient_allowance_output="$ambient_allowance_fixture/workspace/readiness/ambient_allowance.json"
if SELF_TEST_CLI=0 FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$ambient_allowance_fixture" "$ambient_allowance_output" >/dev/null 2>/dev/null; then
  fail "ambient self-test allowance without --self-test unexpectedly returned zero"
fi
assert_json "$ambient_allowance_output" block "executable identity is not trusted"
assert_json_expr "$ambient_allowance_output" 'data["conclusion"] != "pass"'
assert_json_expr "$ambient_allowance_output" 'data["self_test_fixture"]["active"] is False'
assert_json_expr "$ambient_allowance_output" 'all(data["tool_identity"][name]["self_test_allowance"]["token_ok"] is True for name in ["make", "Rscript"])'
assert_json_expr "$ambient_allowance_output" 'all(data["tool_identity"][name]["self_test_allowance"]["active"] is False for name in ["make", "Rscript"])'

fake_path_attack_fixture="$TMP_ROOT/fake-path-attack-fixture"
make_fixture "$fake_path_attack_fixture"
fake_path_attack_output="$fake_path_attack_fixture/workspace/readiness/fake_path_attack.json"
fake_path_attack_marker="$fake_path_attack_fixture/make.marker"
if ALLOW_SELF_TEST_TOOLS=0 FAKE_MAKE_MARKER="$fake_path_attack_marker" FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$fake_path_attack_fixture" "$fake_path_attack_output" >/dev/null 2>/dev/null; then
  fail "fake PATH tool attack fixture unexpectedly returned zero"
fi
assert_json "$fake_path_attack_output" block "executable identity is not trusted"
assert_json_expr "$fake_path_attack_output" 'data["tool_identity"]["git"]["ok"] is True'
assert_json_expr "$fake_path_attack_output" 'data["tool_identity"]["git"]["selected_by_trusted_fallback"] is True'
assert_json_expr "$fake_path_attack_output" 'data["tool_identity"]["git"]["blocked_path"] == data["tool_identity"]["git"]["path"]'
assert_json_expr "$fake_path_attack_output" 'data["tool_identity"]["git"]["selected_path"] != data["tool_identity"]["git"]["path"]'
assert_json_expr "$fake_path_attack_output" 'data["tool_identity"]["git"]["trusted"] is False'
assert_json_expr "$fake_path_attack_output" 'data["tool_identity"]["git"]["trusted_fallback"]["trusted"] is True'
assert_json_expr "$fake_path_attack_output" 'all(data["tool_identity"][name]["ok"] is False for name in ["make", "Rscript"])'
assert_json_expr "$fake_path_attack_output" 'data["shud"]["build"]["blocked_before_make"] is True'
assert_json_expr "$fake_path_attack_output" 'data["rshud"]["installed"]["ok"] is False'
if [ -e "$fake_path_attack_marker" ]; then
  fail "make executed for fake PATH attack fixture"
fi

fake_python_attack_fixture="$TMP_ROOT/fake-python-attack-fixture"
make_fixture "$fake_python_attack_fixture"
fake_python_attack_bin="$TMP_ROOT/fake-python-bin"
mkdir -p "$fake_python_attack_bin"
fake_python_attack_output="$fake_python_attack_fixture/workspace/readiness/fake_python_attack.json"
fake_python_attack_marker="$fake_python_attack_fixture/fake-python.marker"
fake_python_attack_stderr="$TMP_ROOT/fake-python-attack.stderr"
fake_sh_attack_output="$fake_python_attack_fixture/workspace/readiness/fake_sh_attack.json"
fake_sh_attack_marker="$fake_python_attack_fixture/fake-sh.marker"
fake_sh_attack_stderr="$TMP_ROOT/fake-sh-attack.stderr"
cat > "$fake_python_attack_bin/python3" <<'EOF'
#!/usr/bin/env sh
set -eu
if [ -n "${FAKE_PYTHON_MARKER:-}" ]; then
  printf '%s\n' "fake python invoked" > "$FAKE_PYTHON_MARKER"
fi
forged_output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      shift
      forged_output=${1:-}
      ;;
  esac
  shift || break
done
if [ -n "$forged_output" ]; then
  forged_dir=${forged_output%/*}
  if [ "$forged_dir" != "$forged_output" ]; then
    mkdir -p "$forged_dir"
  fi
  printf '%s\n' '{"readiness_check":"shud_rshud","conclusion":"pass","forged_by":"fake-python3"}' > "$forged_output"
fi
exit 0
EOF
chmod +x "$fake_python_attack_bin/python3"
cat > "$fake_python_attack_bin/sh" <<'EOF'
#!/bin/sh
set -eu
if [ -n "${FAKE_SH_MARKER:-}" ]; then
  printf '%s\n' "fake sh invoked" > "$FAKE_SH_MARKER"
fi
forged_output=${FAKE_SH_FORGED_OUTPUT:-}
if [ -n "$forged_output" ]; then
  forged_dir=${forged_output%/*}
  if [ "$forged_dir" != "$forged_output" ]; then
    mkdir -p "$forged_dir"
  fi
  printf '%s\n' '{"readiness_check":"shud_rshud","conclusion":"pass","forged_by":"fake-sh"}' > "$forged_output"
fi
exit 0
EOF
chmod +x "$fake_python_attack_bin/sh"
set +e
(
  clear_make_environment
  FAKE_SH_MARKER="$fake_sh_attack_marker" \
    FAKE_SH_FORGED_OUTPUT="$fake_sh_attack_output" \
    PATH="$fake_python_attack_bin:$TMP_ROOT/bin:$PATH" \
    HOME="$fake_python_attack_fixture/fake-home" \
    "$HELPER" --repo-root "$fake_python_attack_fixture" --output "$fake_sh_attack_output" >/dev/null 2>"$fake_sh_attack_stderr"
)
fake_sh_attack_status=$?
set -e
if [ "$fake_sh_attack_status" -eq 0 ]; then
  fail "fake sh PATH attack fixture unexpectedly returned zero"
fi
if [ -e "$fake_sh_attack_marker" ]; then
  fail "wrapper executed fake sh from PATH"
fi
if [ -e "$fake_sh_attack_output" ]; then
  if grep -q '"forged_by":"fake-sh"' "$fake_sh_attack_output" \
    || grep -q '"conclusion":"pass"' "$fake_sh_attack_output"; then
    fail "fake sh PATH attack left pass-shaped forged output"
  fi
else
  cat "$fake_sh_attack_stderr" >&2
  fail "fake sh PATH attack did not reach the real helper"
fi
assert_json "$fake_sh_attack_output" block "executable identity is not trusted"
assert_json_expr "$fake_sh_attack_output" 'data["tool_identity"]["git"]["ok"] is True'
assert_json_expr "$fake_sh_attack_output" 'all(data["tool_identity"][name]["ok"] is False for name in ["make", "Rscript"])'
assert_json_expr "$fake_sh_attack_output" 'data["conclusion"] != "pass"'
set +e
(
  clear_make_environment
  FAKE_PYTHON_MARKER="$fake_python_attack_marker" \
    PATH="$fake_python_attack_bin:$TMP_ROOT/bin:$PATH" \
    HOME="$fake_python_attack_fixture/fake-home" \
    "$HELPER" --repo-root "$fake_python_attack_fixture" --output "$fake_python_attack_output" >/dev/null 2>"$fake_python_attack_stderr"
)
fake_python_attack_status=$?
set -e
if [ "$fake_python_attack_status" -eq 0 ]; then
  fail "fake python PATH attack fixture unexpectedly returned zero"
fi
if [ -e "$fake_python_attack_marker" ]; then
  fail "wrapper executed fake python3 from PATH"
fi
if [ -e "$fake_python_attack_output" ]; then
  if grep -q '"forged_by":"fake-python3"' "$fake_python_attack_output" \
    || grep -q '"conclusion":"pass"' "$fake_python_attack_output"; then
    fail "fake python PATH attack left pass-shaped forged output"
  fi
else
  cat "$fake_python_attack_stderr" >&2
  fail "fake python PATH attack did not reach the real helper"
fi
assert_json "$fake_python_attack_output" block "executable identity is not trusted"
assert_json_expr "$fake_python_attack_output" 'data["tool_identity"]["git"]["ok"] is True'
assert_json_expr "$fake_python_attack_output" 'data["tool_identity"]["git"]["selected_by_trusted_fallback"] is True'
assert_json_expr "$fake_python_attack_output" 'all(data["tool_identity"][name]["ok"] is False for name in ["make", "Rscript"])'
assert_json_expr "$fake_python_attack_output" 'data["conclusion"] != "pass"'

python_import_poison_fixture="$TMP_ROOT/python-import-poison-fixture"
make_fixture "$python_import_poison_fixture"
python_import_poison_dir="$TMP_ROOT/python-import-poison"
mkdir -p "$python_import_poison_dir"
python_import_poison_output="$python_import_poison_fixture/workspace/readiness/python_import_poison.json"
python_import_poison_marker="$python_import_poison_fixture/python-import-poison.marker"
cat > "$python_import_poison_dir/argparse.py" <<'PY'
import os
from pathlib import Path

marker = os.environ.get("PYTHON_IMPORT_POISON_MARKER")
output = os.environ.get("PYTHON_IMPORT_POISON_OUTPUT")
if marker:
    Path(marker).write_text("poisoned argparse imported\n", encoding="utf-8")
if output:
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text('{"readiness_check":"shud_rshud","conclusion":"pass","forged_by":"python-import-poison"}\n', encoding="utf-8")
raise SystemExit(0)
PY
export PYTHONPATH="$python_import_poison_dir"
export PYTHONHOME="$python_import_poison_dir/python-home"
if PYTHON_IMPORT_POISON_MARKER="$python_import_poison_marker" \
  PYTHON_IMPORT_POISON_OUTPUT="$python_import_poison_output" \
  FAKE_MAKE_MODE=success \
  FAKE_RSHUD_VERSION=2.5.0 \
  run_helper "$python_import_poison_fixture" "$python_import_poison_output" >/dev/null 2>/dev/null; then
  unset PYTHONPATH PYTHONHOME
  fail "Python import poisoning fixture unexpectedly returned zero"
fi
unset PYTHONPATH PYTHONHOME
if [ -e "$python_import_poison_marker" ]; then
  fail "PYTHONPATH stdlib shadow executed before helper guards"
fi
if grep -q '"forged_by":"python-import-poison"' "$python_import_poison_output" \
  || grep -q '"conclusion":"pass"' "$python_import_poison_output"; then
  fail "Python import poisoning left pass-shaped forged output"
fi
assert_json "$python_import_poison_output" incomplete "self-test fixture mode"
assert_json_expr "$python_import_poison_output" 'data["runtime_authority"]["ready_for_consumption"] is False'
assert_json_expr "$python_import_poison_output" 'data["runtime_authority"]["python"]["isolated"] is True'
assert_json_expr "$python_import_poison_output" 'data["runtime_authority"]["python_import_environment"]["all_absent"] is True'

wrapper_symlink_fixture="$TMP_ROOT/wrapper-symlink-fixture"
make_fixture "$wrapper_symlink_fixture"
wrapper_symlink_dir="$TMP_ROOT/wrapper-symlink-entrypoint"
mkdir -p "$wrapper_symlink_dir"
ln -s "$HELPER" "$wrapper_symlink_dir/check_shud_rshud.sh"
wrapper_symlink_output="$wrapper_symlink_fixture/workspace/readiness/wrapper_symlink.json"
wrapper_symlink_marker="$wrapper_symlink_fixture/wrapper-symlink-adjacent.marker"
cat > "$wrapper_symlink_dir/check_shud_rshud.py" <<'PY'
import os
import sys
from pathlib import Path

marker = os.environ.get("WRAPPER_SYMLINK_ADJACENT_MARKER")
if marker:
    Path(marker).write_text("adjacent fake helper ran\n", encoding="utf-8")
output = Path(sys.argv[sys.argv.index("--output") + 1])
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text('{"readiness_check":"shud_rshud","conclusion":"pass","forged_by":"adjacent-fake-helper"}\n', encoding="utf-8")
raise SystemExit(0)
PY
set +e
(
  clear_make_environment
  WRAPPER_SYMLINK_ADJACENT_MARKER="$wrapper_symlink_marker" \
    FAKE_MAKE_MODE=success \
    FAKE_RSHUD_VERSION=2.5.0 \
    SHUD_RSHUD_READINESS_SELF_TEST_TOOL_DIR="$TMP_ROOT/bin" \
    SHUD_RSHUD_READINESS_ENABLE_SELF_TEST_TOOL_ALLOWANCE="$SELF_TEST_TOOL_ALLOWANCE_TOKEN" \
    SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS=3 \
    PATH="$TMP_ROOT/bin:$PATH" \
    HOME="$wrapper_symlink_fixture/fake-home" \
    "$wrapper_symlink_dir/check_shud_rshud.sh" --repo-root "$wrapper_symlink_fixture" --output "$wrapper_symlink_output" --self-test >/dev/null 2>/dev/null
)
wrapper_symlink_status=$?
set -e
if [ "$wrapper_symlink_status" -eq 0 ]; then
  fail "wrapper symlink adjacent-helper fixture unexpectedly returned zero"
fi
if [ -e "$wrapper_symlink_marker" ]; then
  fail "wrapper symlink executed adjacent fake Python helper"
fi
if grep -q '"forged_by":"adjacent-fake-helper"' "$wrapper_symlink_output" \
  || grep -q '"conclusion":"pass"' "$wrapper_symlink_output"; then
  fail "wrapper symlink left adjacent fake pass-shaped output"
fi
assert_json "$wrapper_symlink_output" incomplete "self-test fixture mode"
assert_json_expr "$wrapper_symlink_output" 'data["runtime_authority"]["ready_for_consumption"] is False'
assert_json_expr "$wrapper_symlink_output" 'data["runtime_authority"]["helper"]["matches_expected"] is False'
assert_json_expr "$wrapper_symlink_output" 'data["runtime_authority"]["wrapper"]["matches_expected"] is False'
assert_json_expr "$wrapper_symlink_output" 'data["runtime_authority"]["python"]["isolated"] is True'

wrapper_hardlink_dir="$TMP_ROOT/wrapper-hardlink-entrypoint"
mkdir -p "$wrapper_hardlink_dir"
wrapper_hardlink_marker="$wrapper_symlink_fixture/wrapper-hardlink-adjacent.marker"
wrapper_hardlink_stderr="$TMP_ROOT/wrapper-hardlink.stderr"
wrapper_hardlink_output="$wrapper_symlink_fixture/workspace/readiness/wrapper_hardlink.json"
if ln "$HELPER" "$wrapper_hardlink_dir/check_shud_rshud.sh" 2>/dev/null; then
  cat > "$wrapper_hardlink_dir/check_shud_rshud.py" <<'PY'
import os
import sys
from pathlib import Path

marker = os.environ.get("WRAPPER_HARDLINK_ADJACENT_MARKER")
if marker:
    Path(marker).write_text("hardlink adjacent fake helper ran\n", encoding="utf-8")
output = Path(sys.argv[sys.argv.index("--output") + 1])
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text('{"readiness_check":"shud_rshud","conclusion":"pass","forged_by":"hardlink-adjacent-fake-helper"}\n', encoding="utf-8")
raise SystemExit(0)
PY
  set +e
  (
    clear_make_environment
    WRAPPER_HARDLINK_ADJACENT_MARKER="$wrapper_hardlink_marker" \
      PATH="$TMP_ROOT/bin:$PATH" \
      HOME="$wrapper_symlink_fixture/fake-home" \
      "$wrapper_hardlink_dir/check_shud_rshud.sh" --repo-root "$wrapper_symlink_fixture" --output "$wrapper_hardlink_output" --self-test >/dev/null 2>"$wrapper_hardlink_stderr"
  )
  wrapper_hardlink_status=$?
  set -e
  rm -f "$wrapper_hardlink_dir/check_shud_rshud.sh"
  if [ "$wrapper_hardlink_status" -eq 0 ]; then
    fail "wrapper hardlink adjacent-helper fixture unexpectedly returned zero"
  fi
  if [ -e "$wrapper_hardlink_marker" ]; then
    fail "wrapper hardlink executed adjacent fake Python helper"
  fi
  if [ -e "$wrapper_hardlink_output" ] && {
    grep -q '"forged_by":"hardlink-adjacent-fake-helper"' "$wrapper_hardlink_output" \
      || grep -q '"conclusion":"pass"' "$wrapper_hardlink_output"
  }; then
    fail "wrapper hardlink left adjacent fake pass-shaped output"
  fi
  if ! grep -q "wrapper hardlink count must be 1" "$wrapper_hardlink_stderr"; then
    cat "$wrapper_hardlink_stderr" >&2
    fail "wrapper hardlink was not rejected by link-count guard"
  fi
fi

helper_copy_fixture="$TMP_ROOT/helper-copy-fixture"
make_fixture "$helper_copy_fixture"
helper_copy_dir="$TMP_ROOT/helper-copy-entrypoint"
mkdir -p "$helper_copy_dir"
cp "$SCRIPT_DIR/check_shud_rshud.py" "$helper_copy_dir/check_shud_rshud.py"
helper_copy_output="$helper_copy_fixture/workspace/readiness/helper_copy_attack.json"
cat > "$helper_copy_dir/check_shud_rshud.sh" <<EOF
#!/bin/sh
set -eu
script_parent=\${0%/*}
if [ "\$script_parent" = "\$0" ]; then
  script_parent=.
fi
script_dir=\$(CDPATH= cd -P -- "\$script_parent" && pwd -P)
unset PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONUSERBASE PYTHONBREAKPOINT
export SHUD_RSHUD_READINESS_WRAPPER_REALPATH="\$script_dir/check_shud_rshud.sh"
export SHUD_RSHUD_READINESS_PYTHON_REALPATH="$REAL_PYTHON_REALPATH"
export SHUD_RSHUD_READINESS_WRAPPER_PARENT_PID=\$\$
export SHUD_RSHUD_READINESS_PYTHON_ISOLATED=1
export SHUD_RSHUD_READINESS_PYTHON_IMPORT_ENV_SCRUBBED=1
"$REAL_PYTHON" -I "\$script_dir/check_shud_rshud.py" "\$@"
EOF
chmod +x "$helper_copy_dir/check_shud_rshud.sh"
set +e
(
  clear_make_environment
  FAKE_MAKE_MODE=success \
    FAKE_RSHUD_VERSION=2.5.0 \
    SHUD_RSHUD_READINESS_SELF_TEST_TOOL_DIR="$TMP_ROOT/bin" \
    SHUD_RSHUD_READINESS_ENABLE_SELF_TEST_TOOL_ALLOWANCE="$SELF_TEST_TOOL_ALLOWANCE_TOKEN" \
    SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS=3 \
    PATH="$TMP_ROOT/bin:$PATH" \
    HOME="$helper_copy_fixture/fake-home" \
    "$helper_copy_dir/check_shud_rshud.sh" --repo-root "$helper_copy_fixture" --output "$helper_copy_output" --self-test >/dev/null 2>/dev/null
)
helper_copy_status=$?
set -e
if [ "$helper_copy_status" -eq 0 ]; then
  fail "copied-helper adjacent-wrapper fixture unexpectedly returned zero"
fi
assert_json "$helper_copy_output" incomplete "trusted wrapper runtime identity is missing or incomplete"
assert_json_expr "$helper_copy_output" 'data["conclusion"] != "pass"'
assert_json_expr "$helper_copy_output" 'data["runtime_authority"]["ready_for_consumption"] is False'
assert_json_expr "$helper_copy_output" 'data["runtime_authority"]["helper"]["matches_expected"] is False'
assert_json_expr "$helper_copy_output" 'data["runtime_authority"]["helper"]["actual_realpath"] != data["runtime_authority"]["helper"]["expected_realpath"]'
assert_json_expr "$helper_copy_output" 'data["runtime_authority"]["wrapper"]["matches_expected"] is False'
assert_json_expr "$helper_copy_output" 'data["output"]["consumption_boundary"]["ready_for_consumption"] is True'
assert_json_expr "$helper_copy_output" 'data["checkout_identity"]["paths"]["helper"]["tracked"] is False'
assert_json_expr "$helper_copy_output" 'data["checkout_identity"]["paths"]["helper"]["tracked_clean"] is False'
assert_json_expr "$helper_copy_output" 'data["checkout_identity"]["paths"]["helper"]["worktree_root"] is None'

if [ -x "$SCRIPT_DIR/check_shud_rshud.py" ]; then
  fail "Python readiness helper is executable; public entrypoint must be the trusted wrapper"
fi
direct_python_attack_output="$fake_python_attack_fixture/workspace/readiness/direct_python_attack.json"
direct_python_attack_marker="$fake_python_attack_fixture/direct-python.marker"
direct_python_attack_stderr="$TMP_ROOT/direct-python-attack.stderr"
set +e
(
  clear_make_environment
  FAKE_PYTHON_MARKER="$direct_python_attack_marker" \
    PATH="$fake_python_attack_bin:$TMP_ROOT/bin:$PATH" \
    HOME="$fake_python_attack_fixture/fake-home" \
    "$SCRIPT_DIR/check_shud_rshud.py" --repo-root "$fake_python_attack_fixture" --output "$direct_python_attack_output" >/dev/null 2>"$direct_python_attack_stderr"
)
direct_python_attack_status=$?
set -e
if [ "$direct_python_attack_status" -eq 0 ]; then
  fail "direct Python helper execution unexpectedly returned zero"
fi
if [ -e "$direct_python_attack_marker" ]; then
  fail "direct Python helper execution invoked fake python3 from PATH"
fi
if [ -e "$direct_python_attack_output" ]; then
  if grep -q '"forged_by":"fake-python3"' "$direct_python_attack_output" \
    || grep -q '"conclusion":"pass"' "$direct_python_attack_output"; then
    fail "direct Python helper execution left pass-shaped forged output"
  fi
fi

direct_python_consumable_fixture="$TMP_ROOT/direct-python-consumable-fixture"
make_fixture "$direct_python_consumable_fixture"
direct_python_consumable_output="$direct_python_consumable_fixture/workspace/readiness/direct_python_consumable.json"
set +e
(
  clear_make_environment
  FAKE_MAKE_MODE=success \
    FAKE_RSHUD_VERSION=2.5.0 \
    SHUD_RSHUD_READINESS_SELF_TEST_TOOL_DIR="$TMP_ROOT/bin" \
    SHUD_RSHUD_READINESS_ENABLE_SELF_TEST_TOOL_ALLOWANCE="$SELF_TEST_TOOL_ALLOWANCE_TOKEN" \
    SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS=3 \
    PATH="$TMP_ROOT/bin:$PATH" \
    HOME="$direct_python_consumable_fixture/fake-home" \
    "$REAL_PYTHON" "$SCRIPT_DIR/check_shud_rshud.py" --repo-root "$direct_python_consumable_fixture" --output "$direct_python_consumable_output" --self-test >/dev/null 2>/dev/null
)
direct_python_consumable_status=$?
set -e
if [ "$direct_python_consumable_status" -eq 0 ]; then
  fail "direct python3 helper invocation unexpectedly returned zero"
fi
assert_json "$direct_python_consumable_output" incomplete "trusted wrapper runtime identity is missing or incomplete"
assert_json_expr "$direct_python_consumable_output" 'data["conclusion"] != "pass"'
assert_json_expr "$direct_python_consumable_output" 'data["runtime_authority"]["ready_for_consumption"] is False'
assert_json_expr "$direct_python_consumable_output" 'data["runtime_authority"]["helper"]["matches_expected"] is False'
assert_json_expr "$direct_python_consumable_output" 'data["runtime_authority"]["wrapper"]["matches_expected"] is False'
assert_json_expr "$direct_python_consumable_output" 'data["runtime_authority"]["python"]["isolated"] is False'
assert_json_expr "$direct_python_consumable_output" 'data["output"]["consumption_boundary"]["ready_for_consumption"] is True'

direct_python_spoof_fixture="$TMP_ROOT/direct-python-spoof-fixture"
make_fixture "$direct_python_spoof_fixture"
direct_python_spoof_output="$direct_python_spoof_fixture/workspace/readiness/direct_python_spoof.json"
direct_python_spoof_parent="$TMP_ROOT/direct-python-spoof-parent.sh"
cat > "$direct_python_spoof_parent" <<EOF
#!/bin/sh
set -eu
export SHUD_RSHUD_READINESS_WRAPPER_REALPATH="$HELPER"
export SHUD_RSHUD_READINESS_PYTHON_REALPATH="$REAL_PYTHON_REALPATH"
export SHUD_RSHUD_READINESS_WRAPPER_PARENT_PID=\$\$
export SHUD_RSHUD_READINESS_PYTHON_ISOLATED=1
export SHUD_RSHUD_READINESS_PYTHON_IMPORT_ENV_SCRUBBED=1
export SHUD_RSHUD_READINESS_SELF_TEST_TOOL_DIR="$TMP_ROOT/bin"
export SHUD_RSHUD_READINESS_ENABLE_SELF_TEST_TOOL_ALLOWANCE="$SELF_TEST_TOOL_ALLOWANCE_TOKEN"
export SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS=3
export FAKE_MAKE_MODE=success
export FAKE_RSHUD_VERSION=2.5.0
export PATH="$TMP_ROOT/bin:\$PATH"
set +e
"$REAL_PYTHON" -I "$SCRIPT_DIR/check_shud_rshud.py" --repo-root "$direct_python_spoof_fixture" --output "$direct_python_spoof_output" --self-test
status=\$?
exit "\$status"
EOF
chmod +x "$direct_python_spoof_parent"
set +e
(
  clear_make_environment
  HOME="$direct_python_spoof_fixture/fake-home" "$direct_python_spoof_parent" >/dev/null 2>/dev/null
)
direct_python_spoof_status=$?
set -e
if [ "$direct_python_spoof_status" -eq 0 ]; then
  fail "direct python authority-spoof fixture unexpectedly returned zero"
fi
assert_json "$direct_python_spoof_output" incomplete "trusted wrapper runtime identity is missing or incomplete"
assert_json_expr "$direct_python_spoof_output" 'data["conclusion"] != "pass"'
assert_json_expr "$direct_python_spoof_output" 'data["runtime_authority"]["helper"]["matches_expected"] is False'
assert_json_expr "$direct_python_spoof_output" 'data["runtime_authority"]["wrapper"]["matches_expected"] is False'
assert_json_expr "$direct_python_spoof_output" 'data["runtime_authority"]["python"]["matches_actual"] is True'
assert_json_expr "$direct_python_spoof_output" 'data["runtime_authority"]["python"]["isolated"] is True'
assert_json_expr "$direct_python_spoof_output" 'data["runtime_authority"]["wrapper_parent_pid"]["matches_parent"] is True'
assert_json_expr "$direct_python_spoof_output" 'data["runtime_authority"]["wrapper_parent_pid"]["parent_wrapper_reference"]["matches_expected"] is False'

direct_python_argv0_spoof_output="$direct_python_spoof_fixture/workspace/readiness/direct_python_argv0_spoof.json"
direct_python_argv0_spoof_parent="$TMP_ROOT/direct-python-argv0-spoof-parent.sh"
cat > "$direct_python_argv0_spoof_parent" <<EOF
#!/bin/bash
set -eu
exec -a "$HELPER" /bin/sh -c '
  export SHUD_RSHUD_READINESS_WRAPPER_REALPATH="$HELPER"
  export SHUD_RSHUD_READINESS_PYTHON_REALPATH="$REAL_PYTHON_REALPATH"
  export SHUD_RSHUD_READINESS_WRAPPER_PARENT_PID=\$\$
  export SHUD_RSHUD_READINESS_PYTHON_ISOLATED=1
  export SHUD_RSHUD_READINESS_PYTHON_IMPORT_ENV_SCRUBBED=1
  export SHUD_RSHUD_READINESS_SELF_TEST_TOOL_DIR="$TMP_ROOT/bin"
  export SHUD_RSHUD_READINESS_ENABLE_SELF_TEST_TOOL_ALLOWANCE="$SELF_TEST_TOOL_ALLOWANCE_TOKEN"
  export SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS=3
  export FAKE_MAKE_MODE=success
  export FAKE_RSHUD_VERSION=2.5.0
  export PATH="$TMP_ROOT/bin:\$PATH"
  set +e
  "$REAL_PYTHON" -I "$SCRIPT_DIR/check_shud_rshud.py" --repo-root "$direct_python_spoof_fixture" --output "$direct_python_argv0_spoof_output" --self-test
  status=\$?
  exit "\$status"
'
EOF
chmod +x "$direct_python_argv0_spoof_parent"
set +e
(
  clear_make_environment
  HOME="$direct_python_spoof_fixture/fake-home" "$direct_python_argv0_spoof_parent" >/dev/null 2>/dev/null
)
direct_python_argv0_spoof_status=$?
set -e
if [ "$direct_python_argv0_spoof_status" -eq 0 ]; then
  fail "direct python argv0-spoof fixture unexpectedly returned zero"
fi
assert_json "$direct_python_argv0_spoof_output" incomplete "trusted wrapper runtime identity is missing or incomplete"
assert_json_expr "$direct_python_argv0_spoof_output" 'data["conclusion"] != "pass"'
assert_json_expr "$direct_python_argv0_spoof_output" 'data["runtime_authority"]["ready_for_consumption"] is False'
assert_json_expr "$direct_python_argv0_spoof_output" 'data["runtime_authority"]["wrapper_parent_pid"]["matches_parent"] is True'
assert_json_expr "$direct_python_argv0_spoof_output" 'data["runtime_authority"]["wrapper_parent_pid"]["parent_wrapper_reference"]["matches_expected"] is False'

direct_python_space_argv0_spoof_output="$direct_python_spoof_fixture/workspace/readiness/direct_python_space_argv0_spoof.json"
direct_python_space_argv0_spoof_parent="$TMP_ROOT/direct-python-space-argv0-spoof-parent.sh"
cat > "$direct_python_space_argv0_spoof_parent" <<EOF
#!/bin/bash
set -eu
exec -a "sh $HELPER" /bin/bash -c '
  export SHUD_RSHUD_READINESS_WRAPPER_REALPATH="$HELPER"
  export SHUD_RSHUD_READINESS_PYTHON_REALPATH="$REAL_PYTHON_REALPATH"
  export SHUD_RSHUD_READINESS_WRAPPER_PARENT_PID=\$\$
  export SHUD_RSHUD_READINESS_PYTHON_ISOLATED=1
  export SHUD_RSHUD_READINESS_PYTHON_IMPORT_ENV_SCRUBBED=1
  export SHUD_RSHUD_READINESS_SELF_TEST_TOOL_DIR="$TMP_ROOT/bin"
  export SHUD_RSHUD_READINESS_ENABLE_SELF_TEST_TOOL_ALLOWANCE="$SELF_TEST_TOOL_ALLOWANCE_TOKEN"
  export SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS=3
  export FAKE_MAKE_MODE=success
  export FAKE_RSHUD_VERSION=2.5.0
  export PATH="$TMP_ROOT/bin:\$PATH"
  set +e
  "$REAL_PYTHON" -I "$SCRIPT_DIR/check_shud_rshud.py" --repo-root "$direct_python_spoof_fixture" --output "$direct_python_space_argv0_spoof_output" --self-test
  status=\$?
  exit "\$status"
'
EOF
chmod +x "$direct_python_space_argv0_spoof_parent"
set +e
(
  clear_make_environment
  HOME="$direct_python_spoof_fixture/fake-home" "$direct_python_space_argv0_spoof_parent" >/dev/null 2>/dev/null
)
direct_python_space_argv0_spoof_status=$?
set -e
if [ "$direct_python_space_argv0_spoof_status" -eq 0 ]; then
  fail "direct python space-bearing argv0-spoof fixture unexpectedly returned zero"
fi
assert_json "$direct_python_space_argv0_spoof_output" incomplete "trusted wrapper runtime identity is missing or incomplete"
assert_json_expr "$direct_python_space_argv0_spoof_output" 'data["conclusion"] != "pass"'
assert_json_expr "$direct_python_space_argv0_spoof_output" 'data["runtime_authority"]["ready_for_consumption"] is False'
assert_json_expr "$direct_python_space_argv0_spoof_output" 'data["runtime_authority"]["wrapper_parent_pid"]["matches_parent"] is True'
assert_json_expr "$direct_python_space_argv0_spoof_output" 'data["runtime_authority"]["wrapper_parent_pid"]["parent_wrapper_reference"]["matches_expected"] is False'
assert_json_expr "$direct_python_space_argv0_spoof_output" '"whitespace" in data["runtime_authority"]["wrapper_parent_pid"]["parent_wrapper_reference"]["error"]'

direct_python_stdin_spoof_output="$direct_python_spoof_fixture/workspace/readiness/direct_python_stdin_spoof.json"
direct_python_stdin_spoof_driver="$TMP_ROOT/direct-python-stdin-spoof-driver.sh"
cat > "$direct_python_stdin_spoof_driver" <<EOF
#!/bin/sh
set -eu
/bin/sh -s "$HELPER" <<'INNER'
export SHUD_RSHUD_READINESS_WRAPPER_REALPATH="$HELPER"
export SHUD_RSHUD_READINESS_PYTHON_REALPATH="$REAL_PYTHON_REALPATH"
export SHUD_RSHUD_READINESS_WRAPPER_PARENT_PID=\$\$
export SHUD_RSHUD_READINESS_PYTHON_ISOLATED=1
export SHUD_RSHUD_READINESS_PYTHON_IMPORT_ENV_SCRUBBED=1
export SHUD_RSHUD_READINESS_SELF_TEST_TOOL_DIR="$TMP_ROOT/bin"
export SHUD_RSHUD_READINESS_ENABLE_SELF_TEST_TOOL_ALLOWANCE="$SELF_TEST_TOOL_ALLOWANCE_TOKEN"
export SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS=3
export FAKE_MAKE_MODE=success
export FAKE_RSHUD_VERSION=2.5.0
export PATH="$TMP_ROOT/bin:\$PATH"
set +e
"$REAL_PYTHON" -I "$SCRIPT_DIR/check_shud_rshud.py" --repo-root "$direct_python_spoof_fixture" --output "$direct_python_stdin_spoof_output" --self-test
status=\$?
exit "\$status"
INNER
EOF
chmod +x "$direct_python_stdin_spoof_driver"
set +e
(
  clear_make_environment
  HOME="$direct_python_spoof_fixture/fake-home" "$direct_python_stdin_spoof_driver" >/dev/null 2>/dev/null
)
direct_python_stdin_spoof_status=$?
set -e
if [ "$direct_python_stdin_spoof_status" -eq 0 ]; then
  fail "direct python stdin-script spoof fixture unexpectedly returned zero"
fi
assert_json "$direct_python_stdin_spoof_output" incomplete "trusted wrapper runtime identity is missing or incomplete"
assert_json_expr "$direct_python_stdin_spoof_output" 'data["conclusion"] != "pass"'
assert_json_expr "$direct_python_stdin_spoof_output" 'data["runtime_authority"]["ready_for_consumption"] is False'
assert_json_expr "$direct_python_stdin_spoof_output" 'data["runtime_authority"]["wrapper_parent_pid"]["parent_wrapper_reference"]["matches_expected"] is False'

direct_python_option_arg_spoof_output="$direct_python_spoof_fixture/workspace/readiness/direct_python_option_arg_spoof.json"
direct_python_option_arg_spoof_driver="$TMP_ROOT/direct-python-option-arg-spoof-driver.sh"
cat > "$direct_python_option_arg_spoof_driver" <<EOF
#!/bin/bash
set -eu
/bin/bash --init-file "$HELPER" -c '
  export SHUD_RSHUD_READINESS_WRAPPER_REALPATH="$HELPER"
  export SHUD_RSHUD_READINESS_PYTHON_REALPATH="$REAL_PYTHON_REALPATH"
  export SHUD_RSHUD_READINESS_WRAPPER_PARENT_PID=\$\$
  export SHUD_RSHUD_READINESS_PYTHON_ISOLATED=1
  export SHUD_RSHUD_READINESS_PYTHON_IMPORT_ENV_SCRUBBED=1
  export SHUD_RSHUD_READINESS_SELF_TEST_TOOL_DIR="$TMP_ROOT/bin"
  export SHUD_RSHUD_READINESS_ENABLE_SELF_TEST_TOOL_ALLOWANCE="$SELF_TEST_TOOL_ALLOWANCE_TOKEN"
  export SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS=3
  export FAKE_MAKE_MODE=success
  export FAKE_RSHUD_VERSION=2.5.0
  export PATH="$TMP_ROOT/bin:\$PATH"
  set +e
  "$REAL_PYTHON" -I "$SCRIPT_DIR/check_shud_rshud.py" --repo-root "$direct_python_spoof_fixture" --output "$direct_python_option_arg_spoof_output" --self-test
  status=\$?
  exit "\$status"
'
EOF
chmod +x "$direct_python_option_arg_spoof_driver"
set +e
(
  clear_make_environment
  HOME="$direct_python_spoof_fixture/fake-home" "$direct_python_option_arg_spoof_driver" >/dev/null 2>/dev/null
)
direct_python_option_arg_spoof_status=$?
set -e
if [ "$direct_python_option_arg_spoof_status" -eq 0 ]; then
  fail "direct python option-argument spoof fixture unexpectedly returned zero"
fi
assert_json "$direct_python_option_arg_spoof_output" incomplete "trusted wrapper runtime identity is missing or incomplete"
assert_json_expr "$direct_python_option_arg_spoof_output" 'data["conclusion"] != "pass"'
assert_json_expr "$direct_python_option_arg_spoof_output" 'data["runtime_authority"]["ready_for_consumption"] is False'
assert_json_expr "$direct_python_option_arg_spoof_output" 'data["runtime_authority"]["wrapper_parent_pid"]["parent_wrapper_reference"]["matches_expected"] is False'

hardlink_output_fixture="$TMP_ROOT/hardlink-output-fixture"
make_fixture "$hardlink_output_fixture"
mkdir -p "$hardlink_output_fixture/workspace/readiness"
hardlink_output="$hardlink_output_fixture/workspace/readiness/hardlink_output.json"
hardlink_peer="$hardlink_output_fixture/workspace/readiness/hardlink_peer.json"
printf '%s\n' "original hardlink readiness content" > "$hardlink_output"
ln "$hardlink_output" "$hardlink_peer"
hardlink_before=$(cat "$hardlink_output")
hardlink_stderr="$TMP_ROOT/hardlink-output.stderr"
hardlink_marker="$hardlink_output_fixture/make.marker"
if FAKE_MAKE_MARKER="$hardlink_marker" FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$hardlink_output_fixture" "$hardlink_output" >/dev/null 2>"$hardlink_stderr"; then
  fail "hardlinked readiness output fixture unexpectedly returned zero"
fi
if ! grep -q "multiple hard links" "$hardlink_stderr"; then
  cat "$hardlink_stderr" >&2
  fail "hardlinked readiness output was not rejected"
fi
hardlink_after=$(cat "$hardlink_output")
if [ "$hardlink_before" != "$hardlink_after" ]; then
  fail "hardlinked readiness output content changed"
fi
if [ -e "$hardlink_marker" ]; then
  fail "make executed for hardlinked readiness output fixture"
fi

untracked_gitignore_fixture="$TMP_ROOT/untracked-gitignore-fixture"
make_fixture "$untracked_gitignore_fixture"
git -C "$untracked_gitignore_fixture" rm -q .gitignore
git -C "$untracked_gitignore_fixture" commit -q -m "remove tracked root gitignore"
printf '%s\n' '/workspace/readiness/*.json' > "$untracked_gitignore_fixture/.gitignore"
untracked_gitignore_output="$untracked_gitignore_fixture/workspace/readiness/untracked_gitignore.json"
untracked_gitignore_stderr="$TMP_ROOT/untracked-gitignore.stderr"
untracked_gitignore_make_marker="$TMP_ROOT/untracked-gitignore.make-marker"
if FAKE_MAKE_MARKER="$untracked_gitignore_make_marker" FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$untracked_gitignore_fixture" "$untracked_gitignore_output" >/dev/null 2>"$untracked_gitignore_stderr"; then
  fail "untracked .gitignore readiness output unexpectedly returned zero"
fi
if ! grep -q "output ignore source is not tracked-clean repo .gitignore" "$untracked_gitignore_stderr" \
  || ! grep -q "not tracked" "$untracked_gitignore_stderr"; then
  cat "$untracked_gitignore_stderr" >&2
  fail "untracked .gitignore readiness output was not rejected by tracked-clean ignore guard"
fi
if [ -e "$untracked_gitignore_output" ]; then
  fail "untracked .gitignore fixture wrote readiness output"
fi
if [ -e "$untracked_gitignore_make_marker" ]; then
  fail "make executed for untracked .gitignore fixture"
fi

modified_gitignore_fixture="$TMP_ROOT/modified-gitignore-fixture"
make_fixture "$modified_gitignore_fixture"
printf '%s\n' 'workspace/readiness/*.json' > "$modified_gitignore_fixture/.gitignore"
modified_gitignore_output="$modified_gitignore_fixture/workspace/readiness/modified_gitignore.json"
modified_gitignore_stderr="$TMP_ROOT/modified-gitignore.stderr"
modified_gitignore_make_marker="$TMP_ROOT/modified-gitignore.make-marker"
if FAKE_MAKE_MARKER="$modified_gitignore_make_marker" FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$modified_gitignore_fixture" "$modified_gitignore_output" >/dev/null 2>"$modified_gitignore_stderr"; then
  fail "modified .gitignore readiness output unexpectedly returned zero"
fi
if ! grep -q "output ignore source is not tracked-clean repo .gitignore" "$modified_gitignore_stderr" \
  || ! grep -q "unstaged changes" "$modified_gitignore_stderr"; then
  cat "$modified_gitignore_stderr" >&2
  fail "modified .gitignore readiness output was not rejected by tracked-clean ignore guard"
fi
if [ -e "$modified_gitignore_output" ]; then
  fail "modified .gitignore fixture wrote readiness output"
fi
if [ -e "$modified_gitignore_make_marker" ]; then
  fail "make executed for modified .gitignore fixture"
fi

staged_gitignore_fixture="$TMP_ROOT/staged-gitignore-fixture"
make_fixture "$staged_gitignore_fixture"
printf '%s\n' 'workspace/readiness/*.json' > "$staged_gitignore_fixture/.gitignore"
git -C "$staged_gitignore_fixture" add .gitignore
staged_gitignore_output="$staged_gitignore_fixture/workspace/readiness/staged_gitignore.json"
staged_gitignore_stderr="$TMP_ROOT/staged-gitignore.stderr"
staged_gitignore_make_marker="$TMP_ROOT/staged-gitignore.make-marker"
if FAKE_MAKE_MARKER="$staged_gitignore_make_marker" FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$staged_gitignore_fixture" "$staged_gitignore_output" >/dev/null 2>"$staged_gitignore_stderr"; then
  fail "staged .gitignore readiness output unexpectedly returned zero"
fi
if ! grep -q "output ignore source is not tracked-clean repo .gitignore" "$staged_gitignore_stderr" \
  || ! grep -q "staged changes" "$staged_gitignore_stderr"; then
  cat "$staged_gitignore_stderr" >&2
  fail "staged .gitignore readiness output was not rejected by tracked-clean ignore guard"
fi
if [ -e "$staged_gitignore_output" ]; then
  fail "staged .gitignore fixture wrote readiness output"
fi
if [ -e "$staged_gitignore_make_marker" ]; then
  fail "make executed for staged .gitignore fixture"
fi

global_excludes_only_fixture="$TMP_ROOT/global-excludes-only-fixture"
make_fixture "$global_excludes_only_fixture"
: > "$global_excludes_only_fixture/.gitignore"
git -C "$global_excludes_only_fixture" add .gitignore
git -C "$global_excludes_only_fixture" commit -q -m "remove readiness ignore"
global_excludes_only_file="$global_excludes_only_fixture/global-readiness-excludes"
printf '%s\n' 'workspace/readiness/*.json' > "$global_excludes_only_file"
HOME="$global_excludes_only_fixture/fake-home" git config --global core.excludesFile "$global_excludes_only_file"
global_excludes_only_output="$global_excludes_only_fixture/workspace/readiness/global_only.json"
global_excludes_only_stderr="$TMP_ROOT/global-excludes-only.stderr"
if ! HOME="$global_excludes_only_fixture/fake-home" git -C "$global_excludes_only_fixture" check-ignore --no-index -q workspace/readiness/global_only.json; then
  fail "global excludes fixture does not reproduce ambient ignore"
fi
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$global_excludes_only_fixture" "$global_excludes_only_output" >/dev/null 2>"$global_excludes_only_stderr"; then
  fail "global excludes-only readiness output unexpectedly returned zero"
fi
if ! grep -q "output path is not ignored" "$global_excludes_only_stderr" \
  && ! grep -q "repo-owned .gitignore" "$global_excludes_only_stderr"; then
  cat "$global_excludes_only_stderr" >&2
  fail "global excludes-only readiness output was not rejected by repo-owned ignore guard"
fi
if [ -e "$global_excludes_only_output" ]; then
  fail "global excludes-only fixture wrote readiness output"
fi

tracked_output_fixture="$TMP_ROOT/tracked-output-fixture"
make_fixture "$tracked_output_fixture"
install_hostile_git_config "$tracked_output_fixture"
mkdir -p "$tracked_output_fixture/workspace/readiness"
printf '%s\n' "tracked output must survive" > "$tracked_output_fixture/workspace/readiness/shud_rshud_readiness.json"
git -C "$tracked_output_fixture" add -f workspace/readiness/shud_rshud_readiness.json
git -C "$tracked_output_fixture" commit -q -m "track readiness output"
tracked_output_before=$(cat "$tracked_output_fixture/workspace/readiness/shud_rshud_readiness.json")
hostile_git_worktree="$TMP_ROOT/hostile-git-worktree"
mkdir -p "$hostile_git_worktree"
if GIT_INDEX_FILE=/tmp/nonexistent-shud-readiness-index \
  GIT_WORK_TREE="$hostile_git_worktree" \
  FAKE_MAKE_MODE=success \
  FAKE_RSHUD_VERSION=2.5.0 \
  run_helper_default_output "$tracked_output_fixture" >/dev/null 2>/dev/null; then
  fail "tracked output fixture unexpectedly returned zero"
fi
unset GIT_INDEX_FILE GIT_WORK_TREE
tracked_output_after=$(cat "$tracked_output_fixture/workspace/readiness/shud_rshud_readiness.json")
if [ "$tracked_output_before" != "$tracked_output_after" ]; then
  fail "tracked readiness output was overwritten"
fi
tracked_output_status=$(git -C "$tracked_output_fixture" status --short -- workspace)
if [ -n "$tracked_output_status" ]; then
  printf '%s\n' "$tracked_output_status" >&2
  fail "tracked output fixture workspace status changed"
fi

tracked_sibling_fixture="$TMP_ROOT/tracked-sibling-fixture"
make_fixture "$tracked_sibling_fixture"
install_hostile_git_config "$tracked_sibling_fixture"
mkdir -p "$tracked_sibling_fixture/workspace/readiness"
printf '%s\n' '{"readiness_check":"shud_rshud","conclusion":"pass"}' > "$tracked_sibling_fixture/workspace/readiness/shud_rshud_stale_pass.json"
git -C "$tracked_sibling_fixture" add -f workspace/readiness/shud_rshud_stale_pass.json
git -C "$tracked_sibling_fixture" commit -q -m "track stale readiness sibling"
tracked_sibling_output="$tracked_sibling_fixture/workspace/readiness/alternate_selected.json"
tracked_sibling_marker="$tracked_sibling_fixture/make.marker"
tracked_sibling_stderr="$TMP_ROOT/tracked-sibling.stderr"
if GIT_INDEX_FILE=/tmp/nonexistent-shud-readiness-index \
  GIT_WORK_TREE="$hostile_git_worktree" \
  FAKE_MAKE_MARKER="$tracked_sibling_marker" \
  FAKE_MAKE_MODE=success \
  FAKE_RSHUD_VERSION=2.5.0 \
  run_helper "$tracked_sibling_fixture" "$tracked_sibling_output" >/dev/null 2>"$tracked_sibling_stderr"; then
  fail "tracked sibling fixture unexpectedly returned zero"
fi
unset GIT_INDEX_FILE GIT_WORK_TREE
if ! grep -q "tracked readiness artifact(s) exist under workspace/readiness" "$tracked_sibling_stderr"; then
  cat "$tracked_sibling_stderr" >&2
  fail "tracked sibling fixture did not reject canonical tracked readiness artifact"
fi
if [ -e "$tracked_sibling_output" ]; then
  if grep -q '"conclusion": "pass"' "$tracked_sibling_output"; then
    fail "tracked sibling fixture left pass-shaped selected output"
  fi
fi
if [ -e "$tracked_sibling_marker" ]; then
  fail "make executed for tracked sibling fixture"
fi

final_recheck_fixture="$TMP_ROOT/final-recheck-output-fixture"
make_fixture "$final_recheck_fixture"
final_recheck_rel="workspace/readiness/final_recheck.json"
final_recheck_output="$final_recheck_fixture/$final_recheck_rel"
final_recheck_stderr="$TMP_ROOT/final-recheck-output.stderr"
(
  i=0
  while [ "$i" -lt 200 ]; do
    if [ -s "$final_recheck_output" ] && python3 - "$final_recheck_output" >/dev/null 2>/dev/null <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    json.load(handle)
PY
    then
      git -C "$final_recheck_fixture" add -f "$final_recheck_rel"
      exit 0
    fi
    i=$((i + 1))
    sleep 0.02
  done
  exit 1
) &
final_recheck_watcher=$!
if FAKE_GIT_DELAY_ON_TRACKED_OUTPUT="$final_recheck_output" FAKE_GIT_DELAY_SECONDS=1 FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$final_recheck_fixture" "$final_recheck_output" >/dev/null 2>"$final_recheck_stderr"; then
  final_recheck_status=0
else
  final_recheck_status=$?
fi
if ! wait "$final_recheck_watcher"; then
  fail "final output recheck watcher did not track the first write"
fi
if [ "$final_recheck_status" -eq 0 ]; then
  fail "final output recheck fixture unexpectedly returned zero"
fi
if ! grep -q "output path is tracked by git: $final_recheck_rel" "$final_recheck_stderr"; then
  cat "$final_recheck_stderr" >&2
  fail "final output recheck fixture did not reject tracked output"
fi
assert_json "$final_recheck_output" incomplete "postflight source-boundary evidence is pending"
assert_json_expr "$final_recheck_output" 'data["conclusion"] != "pass"'
assert_json_expr "$final_recheck_output" 'data["source_boundary"]["postflight_after_output_write"] is None'
assert_json_expr "$final_recheck_output" 'data["provisional"]["ready_for_consumption"] is False'
if ! git -C "$final_recheck_fixture" ls-files --error-unmatch "$final_recheck_rel" >/dev/null 2>/dev/null; then
  fail "final output recheck fixture did not make output tracked"
fi

external_temp_fixture="$TMP_ROOT/external-temp-fixture"
make_fixture "$external_temp_fixture"
external_temp_output="$TMP_ROOT/external-temp-output.json"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$external_temp_fixture" "$external_temp_output" --skip-build >/dev/null 2>/dev/null; then
  fail "skip-build fixture unexpectedly returned zero"
fi
assert_json "$external_temp_output" incomplete -
assert_json_expr "$external_temp_output" 'data["errors"] == []'
assert_json_expr "$external_temp_output" 'data["shud"]["build"]["skipped"] is True'
assert_json_expr "$external_temp_output" 'data["output"]["consumption_boundary"]["ready_for_consumption"] is False'
assert_json_expr "$external_temp_output" 'any("--skip-build" in reason for reason in data["incomplete_reasons"])'
assert_json_expr "$external_temp_output" 'any("repo-external readiness output" in reason for reason in data["incomplete_reasons"])'

external_temp_nonskip_fixture="$TMP_ROOT/external-temp-nonskip-fixture"
make_fixture "$external_temp_nonskip_fixture"
external_temp_nonskip_output="$TMP_ROOT/external-temp-nonskip-output.json"
if SELF_TEST_CLI=0 FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$external_temp_nonskip_fixture" "$external_temp_nonskip_output" >/dev/null 2>/dev/null; then
  fail "non-self-test external temp output fixture unexpectedly returned zero"
fi
assert_json_expr "$external_temp_nonskip_output" 'data["conclusion"] != "pass"'
assert_json_expr "$external_temp_nonskip_output" 'data["self_test_fixture"]["active"] is False'
assert_json_expr "$external_temp_nonskip_output" 'data["output"]["consumption_boundary"]["ready_for_consumption"] is False'
assert_json_expr "$external_temp_nonskip_output" 'any("repo-external readiness output" in reason for reason in data["incomplete_reasons"])'

poisoned_tmp_fixture="$TMP_ROOT/poisoned-tmp-fixture"
make_fixture "$poisoned_tmp_fixture"
poisoned_tmp_dir="$TMP_ROOT/poisoned-tmp"
mkdir -p "$poisoned_tmp_dir"
poisoned_tmp_victim="$poisoned_tmp_dir/victim.json"
printf '%s\n' "victim must survive" > "$poisoned_tmp_victim"
poisoned_tmp_before=$(cat "$poisoned_tmp_victim")
poisoned_tmp_stderr="$TMP_ROOT/poisoned-tmp.stderr"
saved_tmpdir_was_set=0
saved_tmpdir=
if [ "${TMPDIR+x}" = x ]; then
  saved_tmpdir_was_set=1
  saved_tmpdir=$TMPDIR
fi
export TMPDIR="$poisoned_tmp_dir"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$poisoned_tmp_fixture" "$poisoned_tmp_victim" --skip-build >/dev/null 2>"$poisoned_tmp_stderr"; then
  poisoned_tmp_status=0
else
  poisoned_tmp_status=$?
fi
if [ "$saved_tmpdir_was_set" = "1" ]; then
  TMPDIR=$saved_tmpdir
  export TMPDIR
else
  unset TMPDIR
fi
if [ "$poisoned_tmp_status" -eq 0 ]; then
  fail "poisoned TMPDIR existing victim fixture unexpectedly returned zero"
fi
poisoned_tmp_after=$(cat "$poisoned_tmp_victim")
if [ "$poisoned_tmp_before" != "$poisoned_tmp_after" ]; then
  fail "poisoned TMPDIR victim content changed"
fi
if ! grep -q "repo-external output path already exists" "$poisoned_tmp_stderr"; then
  cat "$poisoned_tmp_stderr" >&2
  fail "poisoned TMPDIR victim was not rejected before write"
fi

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
if PRESERVE_MAKE_ENV=1 FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$sundials_conflict_fixture" "$sundials_conflict_output" --skip-build >/dev/null 2>/dev/null; then
  unset SUNDIALS_DIR
  fail "SUNDIALS conflict skip-build fixture unexpectedly returned zero"
fi
unset SUNDIALS_DIR
assert_json "$sundials_conflict_output" incomplete -
assert_json_expr "$sundials_conflict_output" 'data["sundials"]["selected"]["path"].endswith("/fake-home/sundials")'
assert_json_expr "$sundials_conflict_output" 'data["sundials"]["selected"]["version"] == "6.0.0"'
assert_json_expr "$sundials_conflict_output" 'all("/alt-sundials" not in candidate["path"] for candidate in data["sundials"]["candidates"])'
assert_json_expr "$sundials_conflict_output" 'any(item["name"] == "SUNDIALS_DIR" and "conflict" in item["reason"] for item in data["make_environment_guard"]["blocked_variables"])'

sundials_secret_fixture="$TMP_ROOT/sundials-secret-fixture"
make_fixture "$sundials_secret_fixture"
sundials_secret_output="$sundials_secret_fixture/workspace/readiness/sundials_secret.json"
sundials_secret_stderr="$TMP_ROOT/sundials-secret.stderr"
sundials_secret_marker="$sundials_secret_fixture/make.marker"
sundials_secret_value="/tmp/SHUDSECRET_SUNDIALS_DIR_DO_NOT_LEAK_15"
if PRESERVE_MAKE_ENV=1 \
  SUNDIALS_DIR="$sundials_secret_value" \
  FAKE_MAKE_MARKER="$sundials_secret_marker" \
  FAKE_MAKE_MODE=success \
  FAKE_RSHUD_VERSION=2.5.0 \
  run_helper "$sundials_secret_fixture" "$sundials_secret_output" >/dev/null 2>"$sundials_secret_stderr"; then
  fail "secret SUNDIALS_DIR fixture unexpectedly returned zero"
fi
unset SUNDIALS_DIR
assert_json "$sundials_secret_output" block "unsupported make environment overrides are set before SHUD build"
if grep -q "$sundials_secret_value" "$sundials_secret_output" || grep -q "$sundials_secret_value" "$sundials_secret_stderr"; then
  fail "secret-like SUNDIALS_DIR value leaked to output or stderr"
fi
assert_json_expr "$sundials_secret_output" 'data["make_environment_guard"]["present_variables"]["SUNDIALS_DIR"]["redacted"] is True'
assert_json_expr "$sundials_secret_output" 'any(item["name"] == "SUNDIALS_DIR" and "conflict" in item["reason"] for item in data["make_environment_guard"]["blocked_variables"])'
assert_json_expr "$sundials_secret_output" 'all("SHUDSECRET_SUNDIALS_DIR_DO_NOT_LEAK_15" not in candidate["path"] for candidate in data["sundials"]["candidates"])'
if [ -e "$sundials_secret_marker" ]; then
  fail "make executed for secret SUNDIALS_DIR fixture"
fi

dirty_shud_fixture="$TMP_ROOT/dirty-shud-fixture"
make_fixture "$dirty_shud_fixture"
printf '%s\n' "# dirty SHUD fixture" >> "$dirty_shud_fixture/SHUD/Makefile"
dirty_shud_output="$TMP_ROOT/dirty-shud-output.json"
dirty_shud_marker="$dirty_shud_fixture/make.marker"
if FAKE_MAKE_MARKER="$dirty_shud_marker" FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$dirty_shud_fixture" "$dirty_shud_output" >/dev/null 2>/dev/null; then
  fail "dirty SHUD fixture unexpectedly returned zero"
fi
assert_json "$dirty_shud_output" block "SHUD checkout has uncommitted or visible changes"
if [ -e "$dirty_shud_marker" ]; then
  fail "make executed for dirty SHUD preflight fixture"
fi

dirty_rshud_fixture="$TMP_ROOT/dirty-rshud-fixture"
make_fixture "$dirty_rshud_fixture"
printf '%s\n' "# dirty rSHUD fixture" >> "$dirty_rshud_fixture/rSHUD/DESCRIPTION"
dirty_rshud_output="$TMP_ROOT/dirty-rshud-output.json"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$dirty_rshud_fixture" "$dirty_rshud_output" >/dev/null 2>/dev/null; then
  fail "dirty rSHUD fixture unexpectedly returned zero"
fi
assert_json "$dirty_rshud_output" block "rSHUD checkout has uncommitted or visible changes"
assert_json_expr "$dirty_rshud_output" 'data["checkout_identity"]["submodules"]["rSHUD"]["checkout"]["dirty"] is True'

workspace_drift_fixture="$TMP_ROOT/workspace-drift-fixture"
make_fixture "$workspace_drift_fixture"
: > "$workspace_drift_fixture/.gitignore"
git -C "$workspace_drift_fixture" add .gitignore
git -C "$workspace_drift_fixture" commit -q -m "make workspace visible"
install_hostile_git_config "$workspace_drift_fixture"
mkdir -p "$workspace_drift_fixture/workspace/readiness"
printf '%s\n' "visible workspace drift" > "$workspace_drift_fixture/workspace/readiness/visible.txt"
workspace_drift_output="$TMP_ROOT/workspace-drift-output.json"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$workspace_drift_fixture" "$workspace_drift_output" >/dev/null 2>/dev/null; then
  fail "visible workspace drift fixture unexpectedly returned zero"
fi
assert_json "$workspace_drift_output" block "workspace/SHUD/rSHUD source boundary has uncommitted or visible changes"
assert_json_expr "$workspace_drift_output" '"workspace/readiness/visible.txt" in data["source_boundary"]["preflight"]["repo_status_shud_rshud_workspace"]["stdout_tail"]'
assert_json_expr "$workspace_drift_output" '"--untracked-files=all" in data["source_boundary"]["preflight"]["repo_status_shud_rshud_workspace"]["command"]'

hidden_build_source_fixture="$TMP_ROOT/hidden-build-source-fixture"
make_fixture "$hidden_build_source_fixture"
mkdir -p "$hidden_build_source_fixture/SHUD/src"
printf '%s\n' "int hidden_build_source_fixture = 15;" > "$hidden_build_source_fixture/SHUD/src/hidden.cpp"
printf '%s\n' 'src/*.cpp' >> "$hidden_build_source_fixture/SHUD/.git/info/exclude"
hidden_build_source_output="$hidden_build_source_fixture/workspace/readiness/hidden_build_source.json"
hidden_build_source_marker="$hidden_build_source_fixture/make.marker"
if FAKE_MAKE_MARKER="$hidden_build_source_marker" FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$hidden_build_source_fixture" "$hidden_build_source_output" >/dev/null 2>/dev/null; then
  fail ".git/info/exclude hidden build source fixture unexpectedly returned zero"
fi
assert_json "$hidden_build_source_output" block "SHUD build-glob source is ignored by git"
assert_json_expr "$hidden_build_source_output" 'data["source_boundary"]["preflight"]["ignored_build_sources"]["ok"] is False'
assert_json_expr "$hidden_build_source_output" 'any(record["path"] == "src/hidden.cpp" and ".git/info/exclude" in (record["ignore"]["source"] or "") for record in data["source_boundary"]["preflight"]["ignored_build_sources"]["ignored_sources"])'
assert_json_expr "$hidden_build_source_output" 'data["shud"]["build"]["blocked_before_make"] is True'
if [ -e "$hidden_build_source_marker" ]; then
  fail "make executed for .git/info/exclude hidden build source fixture"
fi

broad_source_cap_fixture="$TMP_ROOT/broad-source-cap-fixture"
make_fixture "$broad_source_cap_fixture"
"$REAL_PYTHON" - "$broad_source_cap_fixture" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1]) / "SHUD" / "src" / "recursive"
root.mkdir(parents=True, exist_ok=True)
for index in range(10005):
    (root / f"candidate_{index:05d}.cpp").write_text(f"int candidate_{index:05d} = {index};\n", encoding="utf-8")
PY
printf '%s\n' 'SRC = **/*.cpp' >> "$broad_source_cap_fixture/SHUD/Makefile"
broad_source_cap_output="$broad_source_cap_fixture/workspace/readiness/broad_source_cap.json"
broad_source_cap_marker="$broad_source_cap_fixture/make.marker"
if FAKE_MAKE_MARKER="$broad_source_cap_marker" FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$broad_source_cap_fixture" "$broad_source_cap_output" >/dev/null 2>/dev/null; then
  fail "broad recursive source cap fixture unexpectedly returned zero"
fi
assert_json "$broad_source_cap_output" block "SHUD build source scan exceeded 10000 candidates"
assert_json_expr "$broad_source_cap_output" 'data["source_boundary"]["preflight"]["ignored_build_sources"]["ok"] is False'
assert_json_expr "$broad_source_cap_output" 'data["source_boundary"]["preflight"]["ignored_build_sources"]["materialized_all_candidates"] is False'
assert_json_expr "$broad_source_cap_output" 'len(data["source_boundary"]["preflight"]["ignored_build_sources"]["scan_blocks"]) == 1'
assert_json_expr "$broad_source_cap_output" 'data["source_boundary"]["preflight"]["ignored_build_sources"]["scan_blocks"][0]["recursive_pattern"] is True'
assert_json_expr "$broad_source_cap_output" '"before sorting or storing all glob matches" in data["source_boundary"]["preflight"]["ignored_build_sources"]["scan_blocks"][0]["reason"]'
assert_json_expr "$broad_source_cap_output" 'data["shud"]["build"]["blocked_before_make"] is True'
if [ -e "$broad_source_cap_marker" ]; then
  fail "make executed for broad recursive source cap fixture"
fi

sundials_lib_cap_fixture="$TMP_ROOT/sundials-lib-cap-fixture"
make_fixture "$sundials_lib_cap_fixture"
"$REAL_PYTHON" - "$sundials_lib_cap_fixture/fake-home/sundials/lib" <<'PY'
import sys
from pathlib import Path

lib_dir = Path(sys.argv[1])
for index in range(12):
    (lib_dir / f"libsundials_cvode_cap_{index:02d}.dylib").write_text("", encoding="utf-8")
PY
sundials_lib_cap_output="$sundials_lib_cap_fixture/workspace/readiness/sundials_lib_cap.json"
export SHUD_RSHUD_READINESS_SELF_TEST_CANDIDATE_LIMIT=8
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$sundials_lib_cap_fixture" "$sundials_lib_cap_output" >/dev/null 2>/dev/null; then
  unset SHUD_RSHUD_READINESS_SELF_TEST_CANDIDATE_LIMIT
  fail "SUNDIALS library scan cap fixture unexpectedly returned zero"
fi
unset SHUD_RSHUD_READINESS_SELF_TEST_CANDIDATE_LIMIT
assert_json "$sundials_lib_cap_output" block "SUNDIALS library scan limit"
assert_json_expr "$sundials_lib_cap_output" 'data["sundials"]["selected"]["library_scan"]["materialized_all_candidates"] is False'
assert_json_expr "$sundials_lib_cap_output" 'data["sundials"]["selected"]["library_scan"]["truncated"] is True'
assert_json_expr "$sundials_lib_cap_output" 'len(data["sundials"]["selected"]["library_scan"]["scan_blocks"]) == 1'
assert_json_expr "$sundials_lib_cap_output" '"SUNDIALS library scan limit" in data["sundials"]["selected"]["library_scan"]["scan_blocks"][0]["reason"]'

artifact_inventory_cap_fixture="$TMP_ROOT/artifact-inventory-cap-fixture"
make_fixture "$artifact_inventory_cap_fixture"
"$REAL_PYTHON" - "$artifact_inventory_cap_fixture/SHUD" <<'PY'
import sys
from pathlib import Path

shud_dir = Path(sys.argv[1])
for index in range(12):
    (shud_dir / f"shud.limit_{index:02d}").write_text("artifact inventory cap fixture\n", encoding="utf-8")
PY
artifact_inventory_cap_output="$artifact_inventory_cap_fixture/workspace/readiness/artifact_inventory_cap.json"
export SHUD_RSHUD_READINESS_SELF_TEST_CANDIDATE_LIMIT=8
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$artifact_inventory_cap_fixture" "$artifact_inventory_cap_output" >/dev/null 2>/dev/null; then
  unset SHUD_RSHUD_READINESS_SELF_TEST_CANDIDATE_LIMIT
  fail "SHUD artifact inventory scan cap fixture unexpectedly returned zero"
fi
unset SHUD_RSHUD_READINESS_SELF_TEST_CANDIDATE_LIMIT
assert_json "$artifact_inventory_cap_output" block "SHUD artifact inventory limit"
assert_json_expr "$artifact_inventory_cap_output" 'data["shud"]["build"]["artifact_inventory_final_scan"]["materialized_all_candidates"] is False'
assert_json_expr "$artifact_inventory_cap_output" 'data["shud"]["build"]["artifact_inventory_final_scan"]["truncated"] is True'
assert_json_expr "$artifact_inventory_cap_output" 'len(data["shud"]["build"]["artifact_inventory_final_scan"]["scan_blocks"]) == 1'
assert_json_expr "$artifact_inventory_cap_output" '"SHUD artifact inventory limit" in data["shud"]["build"]["artifact_inventory_final_scan"]["scan_blocks"][0]["reason"]'

status_failure_fixture="$TMP_ROOT/status-failure-fixture"
make_fixture "$status_failure_fixture"
status_failure_output="$TMP_ROOT/status-failure-output.json"
status_failure_rshud=$(CDPATH= cd -- "$status_failure_fixture/rSHUD" && pwd -P)
if FAKE_GIT_FAIL_STATUS_FOR="$status_failure_rshud" \
  FAKE_GIT_FAIL_MESSAGE="fake rSHUD status failure" \
  FAKE_MAKE_MODE=success \
  FAKE_RSHUD_VERSION=2.5.0 \
  run_helper "$status_failure_fixture" "$status_failure_output" >/dev/null 2>/dev/null; then
  fail "status failure fixture unexpectedly returned zero"
fi
assert_json "$status_failure_output" block "rSHUD checkout git status failed"
assert_json_expr "$status_failure_output" '"fake rSHUD status failure" in data["source_boundary"]["preflight"]["rshud_status"]["stderr_tail"]'

tracked_shud_fixture="$TMP_ROOT/tracked-shud-fixture"
make_fixture "$tracked_shud_fixture"
printf '%s\n' '#!/usr/bin/env sh' > "$tracked_shud_fixture/SHUD/shud"
printf '%s\n' 'exit 0' >> "$tracked_shud_fixture/SHUD/shud"
chmod +x "$tracked_shud_fixture/SHUD/shud"
git -C "$tracked_shud_fixture/SHUD" add -f shud
git -C "$tracked_shud_fixture/SHUD" commit -q -m "track shud executable"
git -C "$tracked_shud_fixture" -c advice.addEmbeddedRepo=false add SHUD >/dev/null 2>/dev/null
git -C "$tracked_shud_fixture" commit -q -m "advance shud gitlink for tracked shud"
tracked_shud_output="$tracked_shud_fixture/workspace/readiness/tracked_shud.json"
tracked_shud_marker="$tracked_shud_fixture/make.marker"
if FAKE_MAKE_MARKER="$tracked_shud_marker" FAKE_MAKE_CLEAN_MODE=full FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$tracked_shud_fixture" "$tracked_shud_output" >/dev/null 2>/dev/null; then
  fail "tracked SHUD/shud fixture unexpectedly returned zero"
fi
assert_json "$tracked_shud_output" block "SHUD pre-build cleanup refused unsafe build artifacts"
assert_json_expr "$tracked_shud_output" 'data["shud"]["build"]["pre_clean"]["make_clean_skipped"] is True'
assert_json_expr "$tracked_shud_output" 'any(artifact["name"] == "shud" and artifact["tracked"] is True and artifact["removable"] is False for artifact in data["shud"]["build"]["pre_clean"]["artifact_inventory_before_cleanup"])'
if [ ! -e "$tracked_shud_fixture/SHUD/shud" ]; then
  fail "tracked SHUD/shud was removed"
fi
if [ -e "$tracked_shud_marker" ]; then
  fail "make clean executed for tracked SHUD/shud fixture"
fi

make_env_fixture="$TMP_ROOT/make-env-fixture"
make_fixture "$make_env_fixture"
make_env_output="$make_env_fixture/workspace/readiness/make_env.json"
make_env_marker="$make_env_fixture/make.marker"
if PRESERVE_MAKE_ENV=1 MAKEFLAGS=-e CC="$TMP_ROOT/bin/g++" FAKE_MAKE_MARKER="$make_env_marker" FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$make_env_fixture" "$make_env_output" >/dev/null 2>/dev/null; then
  fail "make environment override fixture unexpectedly returned zero"
fi
unset MAKEFLAGS CC
assert_json "$make_env_output" block "unsupported make environment overrides are set before SHUD build"
assert_json_expr "$make_env_output" 'any(item["name"] == "MAKEFLAGS" for item in data["make_environment_guard"]["blocked_variables"])'
assert_json_expr "$make_env_output" 'any(item["name"] == "CC" for item in data["make_environment_guard"]["blocked_variables"])'
assert_json_expr "$make_env_output" 'data["shud"]["build"]["blocked_before_make"] is True'
if [ -e "$make_env_marker" ]; then
  fail "make executed for make environment override fixture"
fi

stcflag_env_fixture="$TMP_ROOT/stcflag-env-fixture"
make_fixture "$stcflag_env_fixture"
stcflag_env_output="$stcflag_env_fixture/workspace/readiness/stcflag_env.json"
stcflag_env_marker="$stcflag_env_fixture/make.marker"
if PRESERVE_MAKE_ENV=1 STCFLAG=-static FAKE_MAKE_MARKER="$stcflag_env_marker" FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$stcflag_env_fixture" "$stcflag_env_output" >/dev/null 2>/dev/null; then
  fail "STCFLAG environment override fixture unexpectedly returned zero"
fi
unset STCFLAG
assert_json "$stcflag_env_output" block "unsupported make environment overrides are set before SHUD build"
assert_json_expr "$stcflag_env_output" 'any(item["name"] == "STCFLAG" for item in data["make_environment_guard"]["blocked_variables"])'
assert_json_expr "$stcflag_env_output" 'data["shud"]["build"]["blocked_before_make"] is True'
if [ -e "$stcflag_env_marker" ]; then
  fail "make executed for STCFLAG environment override fixture"
fi

gnumakeflags_target_fixture="$TMP_ROOT/gnumakeflags-target-fixture"
make_fixture "$gnumakeflags_target_fixture"
gnumakeflags_target_output="$gnumakeflags_target_fixture/workspace/readiness/gnumakeflags_target.json"
gnumakeflags_target_marker="$gnumakeflags_target_fixture/make.marker"
printf '%s\n' "must survive" > "$gnumakeflags_target_fixture/must_survive"
if PRESERVE_MAKE_ENV=1 GNUMAKEFLAGS=-e TARGET_OMP=../must_survive FAKE_MAKE_HONOR_TARGET_OMP_ON_CLEAN=1 FAKE_MAKE_MARKER="$gnumakeflags_target_marker" FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$gnumakeflags_target_fixture" "$gnumakeflags_target_output" >/dev/null 2>/dev/null; then
  fail "GNUMAKEFLAGS TARGET_OMP fixture unexpectedly returned zero"
fi
unset GNUMAKEFLAGS TARGET_OMP
assert_json "$gnumakeflags_target_output" block "unsupported make environment overrides are set before SHUD build"
assert_json_expr "$gnumakeflags_target_output" 'any(item["name"] == "GNUMAKEFLAGS" for item in data["make_environment_guard"]["blocked_variables"])'
assert_json_expr "$gnumakeflags_target_output" 'any(item["name"] == "TARGET_OMP" for item in data["make_environment_guard"]["blocked_variables"])'
assert_json_expr "$gnumakeflags_target_output" 'data["shud"]["build"]["blocked_before_make"] is True'
if [ -e "$gnumakeflags_target_marker" ]; then
  fail "make executed for GNUMAKEFLAGS TARGET_OMP fixture"
fi
if [ ! -e "$gnumakeflags_target_fixture/must_survive" ]; then
  fail "TARGET_OMP sentinel was removed"
fi

secret_env_fixture="$TMP_ROOT/secret-env-fixture"
make_fixture "$secret_env_fixture"
secret_env_output="$secret_env_fixture/workspace/readiness/secret_env.json"
secret_env_stderr="$TMP_ROOT/secret-env.stderr"
secret_value="SHUDSECRET_DO_NOT_LEAK_15"
if PRESERVE_MAKE_ENV=1 MAKEFLAGS="$secret_value" FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$secret_env_fixture" "$secret_env_output" >/dev/null 2>"$secret_env_stderr"; then
  fail "secret environment override fixture unexpectedly returned zero"
fi
unset MAKEFLAGS
assert_json "$secret_env_output" block "unsupported make environment overrides are set before SHUD build"
if grep -q "$secret_value" "$secret_env_output" || grep -q "$secret_value" "$secret_env_stderr"; then
  fail "secret-like make environment value leaked to output or stderr"
fi
assert_json_expr "$secret_env_output" 'data["make_environment_guard"]["present_variables"]["MAKEFLAGS"]["redacted"] is True'
assert_json_expr "$secret_env_output" '"redaction_reason" in data["make_environment_guard"]["present_variables"]["MAKEFLAGS"]'
assert_json_expr "$secret_env_output" 'any(item["name"] == "MAKEFLAGS" and "make control variable" in item["reason"] for item in data["make_environment_guard"]["blocked_variables"])'

residual_artifact_fixture="$TMP_ROOT/residual-artifact-fixture"
make_fixture "$residual_artifact_fixture"
residual_artifact_output="$residual_artifact_fixture/workspace/readiness/residual_artifact.json"
if FAKE_MAKE_MODE=residual FAKE_RSHUD_VERSION=2.5.0 run_helper "$residual_artifact_fixture" "$residual_artifact_output" >/dev/null; then
  fail "self-test fake residual artifact fixture unexpectedly returned zero"
fi
assert_json "$residual_artifact_output" incomplete "self-test fixture mode"
assert_no_shud_artifacts "$residual_artifact_fixture"
assert_json_expr "$residual_artifact_output" 'all(name in [artifact["name"] for artifact in data["shud"]["build"]["artifact_inventory_after_build"]] for name in ["shud_omp", "residual.o", "shud.cache", "shud.dSYM", "SHUD.build"])'
assert_json_expr "$residual_artifact_output" 'all(artifact["git_ignored"] is True for artifact in data["shud"]["build"]["artifact_inventory_after_build"] if artifact["name"] in ["shud.cache", "SHUD.build"])'

broad_residue_fixture="$TMP_ROOT/broad-residue-fixture"
make_fixture "$broad_residue_fixture"
printf '%s\n' "local notes must survive" > "$broad_residue_fixture/SHUD/shud.notes"
broad_residue_output="$broad_residue_fixture/workspace/readiness/broad_residue.json"
broad_residue_marker="$broad_residue_fixture/make.marker"
if FAKE_MAKE_MARKER="$broad_residue_marker" FAKE_MAKE_CLEAN_MODE=full FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$broad_residue_fixture" "$broad_residue_output" >/dev/null 2>/dev/null; then
  fail "broad residue fixture unexpectedly returned zero"
fi
assert_json "$broad_residue_output" block "SHUD pre-build cleanup refused unsafe build artifacts"
assert_json_expr "$broad_residue_output" 'data["shud"]["build"]["pre_clean"]["make_clean_skipped"] is True'
assert_json_expr "$broad_residue_output" 'any(artifact["name"] == "shud.notes" and artifact["classification"] == "broad_residue_pattern" and artifact["removable"] is False for artifact in data["shud"]["build"]["pre_clean"]["artifact_inventory_before_cleanup"])'
if [ ! -e "$broad_residue_fixture/SHUD/shud.notes" ]; then
  fail "broad SHUD residue was removed"
fi
if [ -e "$broad_residue_marker" ]; then
  fail "make clean executed for broad residue fixture"
fi

wildcard_object_fixture="$TMP_ROOT/wildcard-object-fixture"
make_fixture "$wildcard_object_fixture"
printf '%s\n' "local object notes must survive" > "$wildcard_object_fixture/SHUD/local_notes.o"
wildcard_object_output="$wildcard_object_fixture/workspace/readiness/wildcard_object.json"
wildcard_object_marker="$wildcard_object_fixture/make.marker"
if FAKE_MAKE_MARKER="$wildcard_object_marker" FAKE_MAKE_CLEAN_MODE=full FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$wildcard_object_fixture" "$wildcard_object_output" >/dev/null 2>/dev/null; then
  fail "wildcard object fixture unexpectedly returned zero"
fi
assert_json "$wildcard_object_output" block "SHUD pre-build cleanup refused unsafe build artifacts"
assert_json_expr "$wildcard_object_output" 'data["shud"]["build"]["pre_clean"]["make_clean_skipped"] is True'
assert_json_expr "$wildcard_object_output" 'any(artifact["name"] == "local_notes.o" and artifact["classification"] == "current_build_artifact_pattern" and artifact["removable"] is False for artifact in data["shud"]["build"]["pre_clean"]["artifact_inventory_before_cleanup"])'
if [ ! -e "$wildcard_object_fixture/SHUD/local_notes.o" ]; then
  fail "pre-existing wildcard object artifact was removed"
fi
if [ -e "$wildcard_object_marker" ]; then
  fail "make clean executed for wildcard object fixture"
fi

wildcard_dsym_fixture="$TMP_ROOT/wildcard-dsym-fixture"
make_fixture "$wildcard_dsym_fixture"
mkdir -p "$wildcard_dsym_fixture/SHUD/local_debug.dSYM"
printf '%s\n' "local debug bundle must survive" > "$wildcard_dsym_fixture/SHUD/local_debug.dSYM/marker"
wildcard_dsym_output="$wildcard_dsym_fixture/workspace/readiness/wildcard_dsym.json"
wildcard_dsym_marker="$wildcard_dsym_fixture/make.marker"
if FAKE_MAKE_MARKER="$wildcard_dsym_marker" FAKE_MAKE_CLEAN_MODE=full FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$wildcard_dsym_fixture" "$wildcard_dsym_output" >/dev/null 2>/dev/null; then
  fail "wildcard dSYM fixture unexpectedly returned zero"
fi
assert_json "$wildcard_dsym_output" block "SHUD pre-build cleanup refused unsafe build artifacts"
assert_json_expr "$wildcard_dsym_output" 'data["shud"]["build"]["pre_clean"]["make_clean_skipped"] is True'
assert_json_expr "$wildcard_dsym_output" 'any(artifact["name"] == "local_debug.dSYM" and artifact["classification"] == "current_build_artifact_pattern" and artifact["kind"] == "directory" and artifact["removable"] is False for artifact in data["shud"]["build"]["pre_clean"]["artifact_inventory_before_cleanup"])'
if [ ! -e "$wildcard_dsym_fixture/SHUD/local_debug.dSYM/marker" ]; then
  fail "pre-existing wildcard dSYM directory was removed"
fi
if [ -e "$wildcard_dsym_marker" ]; then
  fail "make clean executed for wildcard dSYM fixture"
fi

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
assert_json "$tracked_residue_output" block "SHUD pre-build cleanup refused unsafe build artifacts"
if [ ! -e "$tracked_residue_fixture/SHUD/shud.dSYM/marker" ] || [ ! -e "$tracked_residue_fixture/SHUD/shud.tracked" ] || [ ! -e "$tracked_residue_fixture/SHUD/SHUD.keep/marker" ]; then
  fail "tracked matching SHUD artifacts were removed"
fi
assert_json_expr "$tracked_residue_output" 'data["shud"]["build"]["pre_clean"]["make_clean_skipped"] is True'
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

huge_timeout_fixture="$TMP_ROOT/huge-timeout-fixture"
make_fixture "$huge_timeout_fixture"
huge_timeout_output="$huge_timeout_fixture/workspace/readiness/huge_timeout.json"
huge_timeout_marker="$huge_timeout_fixture/make.marker"
if FAKE_MAKE_MARKER="$huge_timeout_marker" FAKE_MAKE_CLEAN_MODE=minimal FAKE_MAKE_MODE=hang SHUD_RSHUD_READINESS_MAKE_TIMEOUT_SECONDS=999999999 FAKE_RSHUD_VERSION=2.5.0 run_helper "$huge_timeout_fixture" "$huge_timeout_output" >/dev/null 2>/dev/null; then
  fail "huge make timeout fixture unexpectedly returned zero"
fi
assert_json "$huge_timeout_output" block "SHUD make timeout rejected"
assert_json_expr "$huge_timeout_output" 'data["shud"]["build"]["timeout_policy"]["ok"] is False'
assert_json_expr "$huge_timeout_output" 'data["shud"]["build"]["timeout_policy"]["reason"] == "make timeout environment value exceeds maximum"'
assert_json_expr "$huge_timeout_output" 'data["shud"]["build"]["blocked_before_make"] is True'
if [ -e "$huge_timeout_marker" ]; then
  fail "make executed for huge make timeout fixture"
fi

large_output_fixture="$TMP_ROOT/large-output-fixture"
make_fixture "$large_output_fixture"
large_output_output="$large_output_fixture/workspace/readiness/large_output.json"
if FAKE_MAKE_CLEAN_MODE=minimal FAKE_MAKE_MODE=large-output FAKE_RSHUD_VERSION=2.5.0 run_helper "$large_output_fixture" "$large_output_output" >/dev/null; then
  fail "self-test fake large-output fixture unexpectedly returned zero"
fi
assert_json "$large_output_output" incomplete "self-test fixture mode"
assert_json_expr "$large_output_output" 'data["shud"]["build"]["result"]["stdout_truncated"] is True'
assert_json_expr "$large_output_output" 'len(data["shud"]["build"]["result"]["stdout_tail"]) <= 12000'
assert_no_shud_artifacts "$large_output_fixture"

large_clean_output_fixture="$TMP_ROOT/large-clean-output-fixture"
make_fixture "$large_clean_output_fixture"
large_clean_output="$large_clean_output_fixture/workspace/readiness/large_clean_output.json"
if FAKE_MAKE_CLEAN_MODE=large-output FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$large_clean_output_fixture" "$large_clean_output" >/dev/null; then
  fail "self-test fake large-clean-output fixture unexpectedly returned zero"
fi
assert_json "$large_clean_output" incomplete "self-test fixture mode"
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

rscript_failure_fixture="$TMP_ROOT/rscript-failure-fixture"
make_fixture "$rscript_failure_fixture"
rscript_failure_output="$rscript_failure_fixture/workspace/readiness/rscript_failure.json"
if FAKE_MAKE_CLEAN_MODE=minimal FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=error run_helper "$rscript_failure_fixture" "$rscript_failure_output" >/dev/null 2>/dev/null; then
  fail "Rscript failure fixture unexpectedly returned zero"
fi
assert_json "$rscript_failure_output" block "installed rSHUD version did not match the strict Rscript sentinel contract"
assert_json_expr "$rscript_failure_output" 'data["rshud"]["installed"]["ok"] is False'
assert_json_expr "$rscript_failure_output" 'data["rshud"]["installed"]["version"] is None'
assert_json_expr "$rscript_failure_output" 'data["rshud"]["installed"]["meets_minimum"] is False'
assert_json_expr "$rscript_failure_output" 'data["rshud"]["submodule_description"]["supporting_evidence_only"] is True'
assert_json_expr "$rscript_failure_output" 'data["rshud"]["submodule_description"]["version"] == "2.5.0"'

noisy_stdout_rshud_fixture="$TMP_ROOT/noisy-stdout-rshud-fixture"
make_fixture "$noisy_stdout_rshud_fixture"
noisy_stdout_rshud_output="$noisy_stdout_rshud_fixture/workspace/readiness/noisy_stdout_rshud.json"
if FAKE_MAKE_CLEAN_MODE=minimal FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=noisy-stdout-low run_helper "$noisy_stdout_rshud_fixture" "$noisy_stdout_rshud_output" >/dev/null 2>/dev/null; then
  fail "noisy stdout rSHUD fixture unexpectedly returned zero"
fi
assert_json "$noisy_stdout_rshud_output" block "installed rSHUD version 2.4.9 is below required 2.5.0"
assert_json_expr "$noisy_stdout_rshud_output" 'data["rshud"]["installed"]["version"] == "2.4.9"'
assert_json_expr "$noisy_stdout_rshud_output" 'data["rshud"]["installed"]["parser"]["contract_ok"] is False'

stderr_noise_rshud_fixture="$TMP_ROOT/stderr-noise-rshud-fixture"
make_fixture "$stderr_noise_rshud_fixture"
stderr_noise_rshud_output="$stderr_noise_rshud_fixture/workspace/readiness/stderr_noise_rshud.json"
if FAKE_MAKE_CLEAN_MODE=minimal FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=stderr-high-low run_helper "$stderr_noise_rshud_fixture" "$stderr_noise_rshud_output" >/dev/null 2>/dev/null; then
  fail "stderr noise rSHUD fixture unexpectedly returned zero"
fi
assert_json "$stderr_noise_rshud_output" block "installed rSHUD version 2.4.9 is below required 2.5.0"
assert_json_expr "$stderr_noise_rshud_output" 'data["rshud"]["installed"]["version"] == "2.4.9"'
assert_json_expr "$stderr_noise_rshud_output" 'data["rshud"]["installed"]["parser"]["contract_ok"] is True'

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

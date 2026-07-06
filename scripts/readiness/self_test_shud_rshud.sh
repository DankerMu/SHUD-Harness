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
    rm -f shud
    exit 0
    ;;
  shud)
    case "${FAKE_MAKE_MODE:-success}" in
      fail)
        printf '%s\n' "fake make shud failure" >&2
        exit 42
        ;;
      missing)
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
}

make_fixture() {
  fixture=$1
  mkdir -p "$fixture/SHUD" "$fixture/rSHUD" "$fixture/fake-home/sundials/include/sundials" "$fixture/fake-home/sundials/lib"
  init_git_repo "$fixture"
  printf '%s\n' '/workspace/' > "$fixture/.gitignore"
  git -C "$fixture" add .gitignore
  git -C "$fixture" commit -q -m "fixture root"

  cat > "$fixture/SHUD/Makefile" <<'EOF'
SUNDIALS_DIR = $(HOME)/sundials
CC = g++
shud:
	@true
clean:
	@true
EOF
  init_git_repo "$fixture/SHUD"
  git -C "$fixture/SHUD" add Makefile
  git -C "$fixture/SHUD" commit -q -m "fixture shud"

  cat > "$fixture/rSHUD/DESCRIPTION" <<'EOF'
Package: rSHUD
Version: 2.5.0
EOF
  init_git_repo "$fixture/rSHUD"
  git -C "$fixture/rSHUD" add DESCRIPTION
  git -C "$fixture/rSHUD" commit -q -m "fixture rshud"

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
  FAKE_MAKE_MODE="${FAKE_MAKE_MODE:-success}" FAKE_RSHUD_VERSION="${FAKE_RSHUD_VERSION:-2.5.0}" PATH="$TMP_ROOT/bin:$PATH" HOME="$fixture/fake-home" "$HELPER" --repo-root "$fixture" --output "$output" "$@"
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
if expected_error != "-" and expected_error not in errors:
    raise SystemExit(f"expected error containing {expected_error!r}, got {errors!r}")
if expected_conclusion == "pass" and errors:
    raise SystemExit(f"pass conclusion has errors: {errors}")
if data["rshud"]["submodule_description"].get("supporting_evidence_only") is not True:
    raise SystemExit("rSHUD DESCRIPTION is not marked supporting-only")
if data["rshud"]["installed"].get("version") is None:
    raise SystemExit("missing installed rSHUD version evidence")
PY
}

make_fake_bin "$TMP_ROOT/bin"

pass_fixture="$TMP_ROOT/pass-fixture"
make_fixture "$pass_fixture"
pass_output="$pass_fixture/workspace/readiness/shud_rshud_readiness.json"
FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$pass_fixture" "$pass_output" --cleanup >/dev/null
assert_json "$pass_output" pass -
if [ -e "$pass_fixture/SHUD/shud" ]; then
  fail "cleanup left fixture SHUD/shud"
fi
if ! git -C "$pass_fixture" check-ignore --no-index -q workspace/readiness/shud_rshud_readiness.json; then
  fail "fixture default readiness output is not ignored"
fi
fixture_workspace_status=$(git -C "$pass_fixture" status --short -- workspace)
if [ -n "$fixture_workspace_status" ]; then
  printf '%s\n' "$fixture_workspace_status" >&2
  fail "fixture workspace output is visible to git"
fi

external_temp_fixture="$TMP_ROOT/external-temp-fixture"
make_fixture "$external_temp_fixture"
external_temp_output="$TMP_ROOT/external-temp-output.json"
FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.5.0 run_helper "$external_temp_fixture" "$external_temp_output" --skip-build >/dev/null
assert_json "$external_temp_output" pass -

build_failure_fixture="$TMP_ROOT/build-failure-fixture"
make_fixture "$build_failure_fixture"
build_failure_output="$build_failure_fixture/workspace/readiness/build_failure.json"
if FAKE_MAKE_MODE=fail FAKE_RSHUD_VERSION=2.5.0 run_helper "$build_failure_fixture" "$build_failure_output" >/dev/null 2>/dev/null; then
  fail "SHUD build failure fixture unexpectedly returned zero"
fi
assert_json "$build_failure_output" block "SHUD build command failed"

missing_artifact_fixture="$TMP_ROOT/missing-artifact-fixture"
make_fixture "$missing_artifact_fixture"
missing_artifact_output="$missing_artifact_fixture/workspace/readiness/missing_artifact.json"
if FAKE_MAKE_MODE=missing FAKE_RSHUD_VERSION=2.5.0 run_helper "$missing_artifact_fixture" "$missing_artifact_output" >/dev/null 2>/dev/null; then
  fail "missing executable fixture unexpectedly returned zero"
fi
assert_json "$missing_artifact_output" block "SHUD/shud does not exist"

low_rshud_fixture="$TMP_ROOT/low-rshud-fixture"
make_fixture "$low_rshud_fixture"
low_rshud_output="$low_rshud_fixture/workspace/readiness/low_rshud.json"
if FAKE_MAKE_MODE=success FAKE_RSHUD_VERSION=2.4.9 run_helper "$low_rshud_fixture" "$low_rshud_output" --skip-build >/dev/null 2>/dev/null; then
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

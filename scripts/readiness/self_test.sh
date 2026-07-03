#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
HELPER="$SCRIPT_DIR/check_readiness.sh"
OUTPUT_REL="workspace/readiness/readiness_gate_v0_8_1.yaml"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/shud-readiness-test.XXXXXX")
LIVE_OUTPUT="$REPO_ROOT/$OUTPUT_REL"
LIVE_COPY="$TMP_ROOT/live-readiness.before"
LIVE_EXISTED=0

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'self-test failed: %s\n' "$1" >&2
  exit 1
}

if [ -e "$LIVE_OUTPUT" ] || [ -L "$LIVE_OUTPUT" ]; then
  LIVE_EXISTED=1
  cp -p "$LIVE_OUTPUT" "$LIVE_COPY"
fi

workspace_status_before=$(git -C "$REPO_ROOT" status --short -- workspace)
if [ -n "$workspace_status_before" ]; then
  printf '%s\n' "$workspace_status_before" >&2
  fail "live workspace was not clean before self-test"
fi

if ! git -C "$REPO_ROOT" check-ignore --no-index -v workspace/readiness/readiness_gate_v0_8_1.yaml >/dev/null; then
  fail "root runtime workspace readiness output is not ignored"
fi
if git -C "$REPO_ROOT" check-ignore --no-index -v packages/core/src/workspace/index.ts >/dev/null; then
  fail "nested package workspace path is over-ignored"
fi

assert_live_unchanged() {
  workspace_status_after=$(git -C "$REPO_ROOT" status --short -- workspace)
  if [ -n "$workspace_status_after" ]; then
    printf '%s\n' "$workspace_status_after" >&2
    fail "live workspace has tracked or untracked status after self-test"
  fi
  if [ "$LIVE_EXISTED" -eq 1 ]; then
    if ! cmp -s "$LIVE_COPY" "$LIVE_OUTPUT"; then
      fail "self-test modified live readiness evidence"
    fi
  elif [ -e "$LIVE_OUTPUT" ] || [ -L "$LIVE_OUTPUT" ]; then
    fail "self-test created live readiness evidence"
  fi
}

validate_yaml() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
expected_decision = sys.argv[2]
expected_gate = sys.argv[3]
expected_gate_status = sys.argv[4]
expected_keys = [
    "gitmodules_parse",
    "submodules_checkout",
    "canonical_index",
    "core_schema",
    "support_schema",
    "api_registry",
    "error_idempotency",
    "artifact_registry",
    "lock_recovery",
]
valid_statuses = {"pass", "pass_with_notes", "block"}

if not path.is_file():
    raise SystemExit(f"missing YAML: {path}")
text = path.read_text(encoding="utf-8")
if "\t" in text:
    raise SystemExit("YAML contains a tab")
if not text.startswith("readiness_gate:\n"):
    raise SystemExit("missing readiness_gate root")
for token in ("  repo_state:\n", "      head: ", "      dirty: ", "        gitlink: ", "        branchish: "):
    if token not in text:
        raise SystemExit(f"missing repo/submodule state token: {token.strip()}")

fields = {}
p0 = {}
in_p0 = False
in_notes = False
note_count = 0
for line in text.splitlines():
    if line == "  p0:":
        in_p0 = True
        in_notes = False
        continue
    if line == "  notes:":
        in_p0 = False
        in_notes = True
        continue
    if in_p0 and line.startswith("    "):
        key, sep, value = line.strip().partition(": ")
        if sep != ": ":
            raise SystemExit(f"invalid p0 line: {line}")
        p0[key] = value
        continue
    if in_notes and line.startswith("    - "):
        note_count += 1
        continue
    match = re.match(r"^  ([a-z_]+): (.+)$", line)
    if match:
        fields[match.group(1)] = match.group(2).strip('"')

if fields.get("version") != "v0.8.1":
    raise SystemExit("wrong version")
if not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", fields.get("checked_at", "")):
    raise SystemExit("checked_at is not ISO8601 UTC")
if "checked_by" not in fields:
    raise SystemExit("missing checked_by")
if fields.get("decision") != expected_decision:
    raise SystemExit(f"expected decision {expected_decision}, got {fields.get('decision')}")
if list(p0.keys()) != expected_keys:
    raise SystemExit(f"unexpected p0 keys: {list(p0.keys())}")
if any(value not in valid_statuses for value in p0.values()):
    raise SystemExit(f"unexpected p0 statuses: {p0}")
if expected_decision == "pass" and any(value != "pass" for value in p0.values()):
    raise SystemExit(f"expected all p0 gates to pass, got {p0}")
if expected_decision == "pass_with_notes":
    if any(value == "block" for value in p0.values()):
        raise SystemExit(f"pass_with_notes decision cannot contain block: {p0}")
    if not any(value == "pass_with_notes" for value in p0.values()):
        raise SystemExit(f"pass_with_notes decision requires at least one noted gate: {p0}")
if expected_decision == "block" and not any(value == "block" for value in p0.values()):
    raise SystemExit(f"block decision requires at least one block gate: {p0}")
if expected_gate != "-" and p0.get(expected_gate) != expected_gate_status:
    raise SystemExit(f"expected {expected_gate}={expected_gate_status}, got {p0.get(expected_gate)}")
if note_count < len(expected_keys):
    raise SystemExit("missing per-gate notes")
PY
}

copy_contracts() {
  fixture_root=$1
  contract_files='docs/00_INDEX/CANONICAL_CONTRACTS.md
docs/SPEC_v0.8_Final.md
docs/03_SPEC/Minimal_Schemas.md
docs/03_SPEC/Support_Schema_Contracts.md
docs/03_SPEC/User_Session_And_Audit_Schema.md
docs/03_SPEC/Idempotency_Concurrency_Locking_Spec.md
docs/03_SPEC/Runner_Adapter_Contracts.md
docs/03_SPEC/Workspace_Snapshot_And_Recovery_Spec.md
docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md
docs/04_IMPLEMENTATION/API_Error_And_Idempotency_Contracts.md
docs/03_SPEC/Artifact_Registry_Spec.md'
  printf '%s\n' "$contract_files" | while IFS= read -r file_path; do
    mkdir -p "$fixture_root/$(dirname "$file_path")"
    cp "$REPO_ROOT/$file_path" "$fixture_root/$file_path"
  done
  cp "$REPO_ROOT/.gitmodules" "$fixture_root/.gitmodules"
  cp "$REPO_ROOT/.gitignore" "$fixture_root/.gitignore"
}

append_runner_result_definition() {
  fixture_root=$1
  cat >> "$fixture_root/docs/03_SPEC/Support_Schema_Contracts.md" <<'EOF'

## Self-test RunnerResult fixture

```ts
interface RunnerResult {
  result_id: string;
  job_id: string;
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  output_paths: string[];
  created_at: string;
}
```
EOF
}

init_git_repo() {
  fixture_root=$1
  git -C "$fixture_root" init -q
  git -C "$fixture_root" config user.email "readiness-test@example.invalid"
  git -C "$fixture_root" config user.name "readiness-test"
  git -C "$fixture_root" config core.autocrlf false
  git -C "$fixture_root" config advice.addEmbeddedRepo false
}

create_fake_submodules() {
  fixture_root=$1
  for name in SHUD rSHUD AutoSHUD zero; do
    mkdir -p "$fixture_root/$name"
    git -C "$fixture_root/$name" init -q
    git -C "$fixture_root/$name" config user.email "readiness-test@example.invalid"
    git -C "$fixture_root/$name" config user.name "readiness-test"
    printf '%s\n' "$name fixture" > "$fixture_root/$name/.fixture"
    git -C "$fixture_root/$name" add .fixture
    git -C "$fixture_root/$name" commit -q -m "fixture"
  done
}

commit_superproject_with_gitlinks() {
  fixture_root=$1
  git -C "$fixture_root" add .gitignore .gitmodules docs
  for name in SHUD rSHUD AutoSHUD zero; do
    git -C "$fixture_root" add "$name" 2>/dev/null
  done
  git -C "$fixture_root" commit -q -m "fixture superproject"
}

make_fixture() {
  fixture_root=$1
  runner_schema=${2:-with-runner}
  mkdir -p "$fixture_root"
  init_git_repo "$fixture_root"
  copy_contracts "$fixture_root"
  if [ "$runner_schema" = "with-runner" ]; then
    append_runner_result_definition "$fixture_root"
  fi
  create_fake_submodules "$fixture_root"
  commit_superproject_with_gitlinks "$fixture_root"
}

make_fake_standalone_fixture() {
  fixture_root=$1
  mkdir -p "$fixture_root"
  init_git_repo "$fixture_root"
  copy_contracts "$fixture_root"
  append_runner_result_definition "$fixture_root"
  git -C "$fixture_root" add .gitignore .gitmodules docs
  git -C "$fixture_root" commit -q -m "fixture superproject without gitlinks"
  create_fake_submodules "$fixture_root"
}

fixture="$TMP_ROOT/fixture-pass"
make_fixture "$fixture"
"$HELPER" --repo-root "$fixture" --checked-by readiness-self-test >/dev/null || fail "fixture pass run returned non-zero"
validate_yaml "$fixture/$OUTPUT_REL" pass - pass

workspace_files=$(find "$fixture/workspace" -type f -print | sed "s#^$fixture/##" | sort)
if [ "$workspace_files" != "$OUTPUT_REL" ]; then
  printf '%s\n' "$workspace_files" >&2
  fail "helper wrote unexpected files for absent workspace"
fi

printf '%s\n' stale > "$fixture/$OUTPUT_REL"
"$HELPER" --repo-root "$fixture" --checked-by readiness-self-test >/dev/null || fail "fixture overwrite run returned non-zero"
if grep -q stale "$fixture/$OUTPUT_REL"; then
  fail "helper did not overwrite expected readiness YAML"
fi
validate_yaml "$fixture/$OUTPUT_REL" pass - pass

failure_fixture="$TMP_ROOT/fixture-failure"
make_fixture "$failure_fixture"
rm "$failure_fixture/docs/04_IMPLEMENTATION/API_Error_And_Idempotency_Contracts.md"
if "$HELPER" --repo-root "$failure_fixture" --checked-by readiness-self-test >/dev/null; then
  fail "failure fixture unexpectedly returned zero"
fi
validate_yaml "$failure_fixture/$OUTPUT_REL" block error_idempotency block

notes_fixture="$TMP_ROOT/fixture-pass-with-notes"
make_fixture "$notes_fixture"
python3 - "$notes_fixture/docs/00_INDEX/CANONICAL_CONTRACTS.md" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
path.write_bytes(text.replace("\n", "\r\n").encode("utf-8"))
PY
git -C "$notes_fixture" add docs/00_INDEX/CANONICAL_CONTRACTS.md
git -C "$notes_fixture" commit -q -m "fixture committed crlf note"
"$HELPER" --repo-root "$notes_fixture" --checked-by readiness-self-test >/dev/null || fail "pass_with_notes fixture returned non-zero"
validate_yaml "$notes_fixture/$OUTPUT_REL" pass_with_notes canonical_index pass_with_notes

support_false_fixture="$TMP_ROOT/fixture-support-false-pass"
make_fixture "$support_false_fixture" without-runner
if "$HELPER" --repo-root "$support_false_fixture" --checked-by readiness-self-test >/dev/null; then
  fail "support schema prose-only RunnerResult fixture unexpectedly returned zero"
fi
validate_yaml "$support_false_fixture/$OUTPUT_REL" block support_schema block

fake_fixture="$TMP_ROOT/fixture-fake-standalone-submodules"
make_fake_standalone_fixture "$fake_fixture"
if "$HELPER" --repo-root "$fake_fixture" --checked-by readiness-self-test >/dev/null; then
  fail "fake standalone submodule fixture unexpectedly returned zero"
fi
validate_yaml "$fake_fixture/$OUTPUT_REL" block submodules_checkout block

mismatch_fixture="$TMP_ROOT/fixture-mismatched-submodule"
make_fixture "$mismatch_fixture"
printf '%s\n' "new commit" > "$mismatch_fixture/SHUD/.mismatch"
git -C "$mismatch_fixture/SHUD" add .mismatch
git -C "$mismatch_fixture/SHUD" commit -q -m "mismatch"
if "$HELPER" --repo-root "$mismatch_fixture" --checked-by readiness-self-test >/dev/null; then
  fail "mismatched submodule fixture unexpectedly returned zero"
fi
validate_yaml "$mismatch_fixture/$OUTPUT_REL" block submodules_checkout block

dirty_fixture="$TMP_ROOT/fixture-dirty-submodule"
make_fixture "$dirty_fixture"
printf '%s\n' dirty >> "$dirty_fixture/SHUD/.fixture"
if "$HELPER" --repo-root "$dirty_fixture" --checked-by readiness-self-test >/dev/null; then
  fail "dirty submodule fixture unexpectedly returned zero"
fi
validate_yaml "$dirty_fixture/$OUTPUT_REL" block submodules_checkout block

root_dirty_fixture="$TMP_ROOT/fixture-dirty-root"
make_fixture "$root_dirty_fixture"
printf '\nroot dirty fixture\n' >> "$root_dirty_fixture/docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md"
if "$HELPER" --repo-root "$root_dirty_fixture" --checked-by readiness-self-test >/dev/null; then
  fail "dirty root fixture unexpectedly returned zero"
fi
validate_yaml "$root_dirty_fixture/$OUTPUT_REL" block submodules_checkout block

workspace_symlink_fixture="$TMP_ROOT/fixture-workspace-symlink"
make_fixture "$workspace_symlink_fixture"
ln -s docs "$workspace_symlink_fixture/workspace"
if "$HELPER" --repo-root "$workspace_symlink_fixture" --checked-by readiness-self-test >/dev/null 2>/dev/null; then
  fail "workspace symlink ancestor fixture unexpectedly returned zero"
fi
if [ -e "$workspace_symlink_fixture/docs/readiness/readiness_gate_v0_8_1.yaml" ]; then
  fail "helper wrote through workspace symlink ancestor"
fi

readiness_symlink_fixture="$TMP_ROOT/fixture-readiness-symlink"
make_fixture "$readiness_symlink_fixture"
mkdir -p "$readiness_symlink_fixture/workspace"
ln -s ../docs "$readiness_symlink_fixture/workspace/readiness"
if "$HELPER" --repo-root "$readiness_symlink_fixture" --checked-by readiness-self-test >/dev/null 2>/dev/null; then
  fail "readiness symlink directory fixture unexpectedly returned zero"
fi
if [ -e "$readiness_symlink_fixture/docs/readiness_gate_v0_8_1.yaml" ]; then
  fail "helper wrote through readiness symlink directory"
fi

output_symlink_fixture="$TMP_ROOT/fixture-output-symlink"
make_fixture "$output_symlink_fixture"
mkdir -p "$output_symlink_fixture/workspace/readiness"
ln -s ../../docs/00_INDEX/CANONICAL_CONTRACTS.md "$output_symlink_fixture/$OUTPUT_REL"
if "$HELPER" --repo-root "$output_symlink_fixture" --checked-by readiness-self-test >/dev/null 2>/dev/null; then
  fail "output symlink fixture unexpectedly returned zero"
fi
if [ ! -L "$output_symlink_fixture/$OUTPUT_REL" ]; then
  fail "helper replaced symlinked output"
fi

hardlink_fixture="$TMP_ROOT/fixture-hardlink-output"
make_fixture "$hardlink_fixture"
mkdir -p "$hardlink_fixture/workspace/readiness"
printf '%s\n' stale > "$hardlink_fixture/$OUTPUT_REL"
ln "$hardlink_fixture/$OUTPUT_REL" "$hardlink_fixture/hardlink-peer"
if "$HELPER" --repo-root "$hardlink_fixture" --checked-by readiness-self-test >/dev/null 2>/dev/null; then
  fail "hardlinked output fixture unexpectedly returned zero"
fi
if ! grep -q stale "$hardlink_fixture/$OUTPUT_REL"; then
  fail "helper overwrote hardlinked output"
fi

before_temp_swap_fixture="$TMP_ROOT/fixture-swap-before-temp"
make_fixture "$before_temp_swap_fixture"
if _SHUD_READINESS_TEST_HOOK=swap_readiness_to_docs _SHUD_READINESS_TEST_HOOK_STAGE=before_temp_create "$HELPER" --repo-root "$before_temp_swap_fixture" --checked-by readiness-self-test >/dev/null 2>/dev/null; then
  fail "before-temp readiness dir swap fixture unexpectedly returned zero"
fi
if [ -e "$before_temp_swap_fixture/docs/readiness_gate_v0_8_1.yaml" ]; then
  fail "before-temp readiness dir swap wrote through symlink target"
fi

before_replace_swap_fixture="$TMP_ROOT/fixture-swap-before-replace"
make_fixture "$before_replace_swap_fixture"
if _SHUD_READINESS_TEST_HOOK=swap_readiness_to_docs _SHUD_READINESS_TEST_HOOK_STAGE=before_replace "$HELPER" --repo-root "$before_replace_swap_fixture" --checked-by readiness-self-test >/dev/null 2>/dev/null; then
  fail "before-replace readiness dir swap fixture unexpectedly returned zero"
fi
if [ -e "$before_replace_swap_fixture/docs/readiness_gate_v0_8_1.yaml" ]; then
  fail "before-replace readiness dir swap wrote through symlink target"
fi

assert_live_unchanged

printf '%s\n' "self-test passed"

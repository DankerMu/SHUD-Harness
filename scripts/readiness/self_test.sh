#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
HELPER="$SCRIPT_DIR/check_readiness.sh"
OUTPUT_REL="workspace/readiness/readiness_gate_v0_8_1.yaml"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/shud-readiness-test.XXXXXX")

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'self-test failed: %s\n' "$1" >&2
  exit 1
}

validate_yaml() {
  python3 - "$1" "$2" "$3" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
expected_decision = sys.argv[2]
expected_gate = sys.argv[3]
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

text = path.read_text(encoding="utf-8")
if "\t" in text:
    raise SystemExit("YAML contains a tab")
if not text.startswith("readiness_gate:\n"):
    raise SystemExit("missing readiness_gate root")
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
if expected_gate != "-" and p0.get(expected_gate) == "pass":
    raise SystemExit(f"expected non-pass gate {expected_gate}")
if expected_gate == "-" and any(value != "pass" for value in p0.values()):
    raise SystemExit(f"expected all p0 gates to pass, got {p0}")
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
docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md
docs/04_IMPLEMENTATION/API_Error_And_Idempotency_Contracts.md
docs/03_SPEC/Artifact_Registry_Spec.md
docs/03_SPEC/Idempotency_Concurrency_Locking_Spec.md
docs/03_SPEC/Workspace_Snapshot_And_Recovery_Spec.md'
  printf '%s\n' "$contract_files" | while IFS= read -r file_path; do
    mkdir -p "$fixture_root/$(dirname "$file_path")"
    cp "$REPO_ROOT/$file_path" "$fixture_root/$file_path"
  done
  cp "$REPO_ROOT/.gitmodules" "$fixture_root/.gitmodules"
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

make_fixture() {
  fixture_root=$1
  mkdir -p "$fixture_root"
  copy_contracts "$fixture_root"
  create_fake_submodules "$fixture_root"
}

"$HELPER" --repo-root "$REPO_ROOT" --checked-by readiness-self-test >/dev/null || fail "current HEAD readiness helper returned non-zero"
validate_yaml "$REPO_ROOT/$OUTPUT_REL" pass -

workspace_status=$(git -C "$REPO_ROOT" status --short -- workspace)
if [ -n "$workspace_status" ]; then
  printf '%s\n' "$workspace_status" >&2
  fail "workspace has tracked or untracked status after helper run"
fi

fixture="$TMP_ROOT/fixture-pass"
make_fixture "$fixture"
"$HELPER" --repo-root "$fixture" --checked-by readiness-self-test >/dev/null || fail "fixture pass run returned non-zero"
validate_yaml "$fixture/$OUTPUT_REL" pass -

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
workspace_files=$(find "$fixture/workspace" -type f -print | sed "s#^$fixture/##" | sort)
if [ "$workspace_files" != "$OUTPUT_REL" ]; then
  printf '%s\n' "$workspace_files" >&2
  fail "helper wrote unexpected files for preexisting workspace"
fi

failure_fixture="$TMP_ROOT/fixture-failure"
make_fixture "$failure_fixture"
rm "$failure_fixture/docs/04_IMPLEMENTATION/API_Error_And_Idempotency_Contracts.md"
if "$HELPER" --repo-root "$failure_fixture" --checked-by readiness-self-test >/dev/null; then
  fail "failure fixture unexpectedly returned zero"
fi
validate_yaml "$failure_fixture/$OUTPUT_REL" block error_idempotency

printf '%s\n' "self-test passed"

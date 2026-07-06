#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
VALIDATOR="$SCRIPT_DIR/validate.mjs"
BASE_LOCK="$REPO_ROOT/dependency-lock.initial.json"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/shud-dependency-lock-test.XXXXXX")

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'dependency-lock self-test failed: %s\n' "$1" >&2
  exit 1
}

EMPTY_LOCK="$TMP_ROOT/empty-packages.json"
MISSING_LOCK="$TMP_ROOT/missing-direct-dependency.json"
MISMATCH_LOCK="$TMP_ROOT/mismatched-version.json"
STALE_PACKAGE_MANAGER_VERSION_LOCK="$TMP_ROOT/stale-package-manager-version.json"
STALE_LOCKFILE_PATH_LOCK="$TMP_ROOT/stale-lockfile-path.json"

node --input-type=module - "$BASE_LOCK" "$EMPTY_LOCK" "$MISSING_LOCK" "$MISMATCH_LOCK" "$STALE_PACKAGE_MANAGER_VERSION_LOCK" "$STALE_LOCKFILE_PATH_LOCK" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";

const [basePath, emptyPath, missingPath, mismatchPath, stalePackageManagerVersionPath, staleLockfilePathPath] =
  process.argv.slice(2);
const base = JSON.parse(readFileSync(basePath, "utf8"));
const writeFixture = (target, value) => {
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
};

const empty = structuredClone(base);
empty.packages = [];
writeFixture(emptyPath, empty);

const missing = structuredClone(base);
const beforeMissingCount = missing.packages.length;
missing.packages = missing.packages.filter((pkg) => pkg.name !== "zod");
if (missing.packages.length !== beforeMissingCount - 1) {
  throw new Error("base DependencyLock does not contain zod for missing-dependency fixture");
}
writeFixture(missingPath, missing);

const mismatch = structuredClone(base);
const typescript = mismatch.packages.find((pkg) => pkg.name === "typescript");
if (!typescript) {
  throw new Error("base DependencyLock does not contain typescript for version-mismatch fixture");
}
typescript.version = "0.0.0-self-test";
writeFixture(mismatchPath, mismatch);

const stalePackageManagerVersion = structuredClone(base);
stalePackageManagerVersion.package_manager.version = "0.0.0-self-test";
writeFixture(stalePackageManagerVersionPath, stalePackageManagerVersion);

const staleLockfilePath = structuredClone(base);
staleLockfilePath.package_manager.lockfile_path = "stale/bun.lock";
writeFixture(staleLockfilePathPath, staleLockfilePath);
JS

node "$VALIDATOR" > "$TMP_ROOT/positive.out" 2>&1 || {
  cat "$TMP_ROOT/positive.out" >&2
  fail "real DependencyLock did not pass positive validation"
}

expect_failure() {
  label=$1
  fixture=$2
  expected_text=$3
  output="$TMP_ROOT/$label.out"

  if node "$VALIDATOR" --dependency-lock "$fixture" > "$output" 2>&1; then
    cat "$output" >&2
    fail "$label fixture unexpectedly passed"
  fi

  if ! grep -F "$expected_text" "$output" >/dev/null; then
    cat "$output" >&2
    fail "$label fixture did not report expected text: $expected_text"
  fi
}

expect_failure "empty-packages" "$EMPTY_LOCK" "DependencyLock.packages must be a non-empty array"
expect_failure "missing-direct-dependency" "$MISSING_LOCK" "missing package: zod"
expect_failure "mismatched-version" "$MISMATCH_LOCK" "version mismatch for typescript"
expect_failure "stale-package-manager-version" "$STALE_PACKAGE_MANAGER_VERSION_LOCK" "DependencyLock.package_manager.version mismatch"
expect_failure "stale-lockfile-path" "$STALE_LOCKFILE_PATH_LOCK" "DependencyLock.package_manager.lockfile_path mismatch"

printf 'dependency-lock self-test passed: positive validation plus package and identity negative fixtures\n'

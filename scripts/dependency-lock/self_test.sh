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
MISSING_SUBMODULE_LOCK="$TMP_ROOT/missing-submodule.json"
WRONG_SUBMODULE_COMMIT_LOCK="$TMP_ROOT/wrong-submodule-commit.json"
DIRTY_SUBMODULE_LOCK="$TMP_ROOT/dirty-submodule.json"
WRONG_ZERO_COMMIT_LOCK="$TMP_ROOT/wrong-zero-commit.json"

node --input-type=module - "$BASE_LOCK" "$EMPTY_LOCK" "$MISSING_LOCK" "$MISMATCH_LOCK" "$STALE_PACKAGE_MANAGER_VERSION_LOCK" "$STALE_LOCKFILE_PATH_LOCK" "$MISSING_SUBMODULE_LOCK" "$WRONG_SUBMODULE_COMMIT_LOCK" "$DIRTY_SUBMODULE_LOCK" "$WRONG_ZERO_COMMIT_LOCK" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";

const [
  basePath,
  emptyPath,
  missingPath,
  mismatchPath,
  stalePackageManagerVersionPath,
  staleLockfilePathPath,
  missingSubmodulePath,
  wrongSubmoduleCommitPath,
  dirtySubmodulePath,
  wrongZeroCommitPath,
] =
  process.argv.slice(2);
const base = JSON.parse(readFileSync(basePath, "utf8"));
const writeFixture = (target, value) => {
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
};
const getSubmodule = (lock, name, fixtureName) => {
  const submodule = lock.submodules.find((item) => item.name === name);
  if (!submodule) {
    throw new Error(`base DependencyLock does not contain ${name} for ${fixtureName} fixture`);
  }
  return submodule;
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

const missingSubmodule = structuredClone(base);
const beforeSubmoduleCount = missingSubmodule.submodules.length;
missingSubmodule.submodules = missingSubmodule.submodules.filter((submodule) => submodule.name !== "SHUD");
if (missingSubmodule.submodules.length !== beforeSubmoduleCount - 1) {
  throw new Error("base DependencyLock does not contain SHUD for missing-submodule fixture");
}
writeFixture(missingSubmodulePath, missingSubmodule);

const wrongSubmoduleCommit = structuredClone(base);
getSubmodule(wrongSubmoduleCommit, "SHUD", "wrong-submodule-commit").commit =
  "0000000000000000000000000000000000000000";
writeFixture(wrongSubmoduleCommitPath, wrongSubmoduleCommit);

const dirtySubmodule = structuredClone(base);
getSubmodule(dirtySubmodule, "rSHUD", "dirty-submodule").dirty = true;
writeFixture(dirtySubmodulePath, dirtySubmodule);

const wrongZeroCommit = structuredClone(base);
getSubmodule(wrongZeroCommit, "zero", "wrong-zero-commit").commit =
  "0000000000000000000000000000000000000000";
writeFixture(wrongZeroCommitPath, wrongZeroCommit);
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
expect_failure "missing-submodule" "$MISSING_SUBMODULE_LOCK" "missing submodule: SHUD"
expect_failure "wrong-submodule-commit" "$WRONG_SUBMODULE_COMMIT_LOCK" "submodule commit mismatch for SHUD"
expect_failure "dirty-submodule" "$DIRTY_SUBMODULE_LOCK" "DependencyLock.submodule rSHUD dirty must be false"
expect_failure "wrong-zero-commit" "$WRONG_ZERO_COMMIT_LOCK" "zero submodule commit must be 13e25c116c62411e6ee8a0ad67a6c53dc7c376c6"

printf 'dependency-lock self-test passed: positive validation plus package, package-manager identity, and submodule negative fixtures\n'

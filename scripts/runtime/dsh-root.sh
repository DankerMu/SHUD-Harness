#!/usr/bin/env sh
# Source after setting ROOT to the harness checkout. Resolves checkout/npm hosts
# without importing host internals; the bundle peer is the pinned version source.
: "${ROOT:?dsh-root requires repository ROOT}"
DSH_ROOT="${DSH_ROOT:-$ROOT/../deepseek-harness}"
DSH_EXPECTED_VERSION=$(node -e '
const fs = require("node:fs");
const version = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).peerDependencies["@deepseek-ai/dsh"];
if (typeof version !== "string" || !version) throw new Error("Missing pinned dsh peer version");
process.stdout.write(version);
' "$ROOT/profile/shud/package.json") || return 1
DSH_EXPECTED_TAG="dsh-v$DSH_EXPECTED_VERSION"
DSH_EXPECTED_LAYOUTS="expected $DSH_ROOT/apps/cli/lib/bin.js ($DSH_EXPECTED_TAG) or $DSH_ROOT/lib/bin.js ($DSH_EXPECTED_VERSION)"
if [ -f "$DSH_ROOT/apps/cli/lib/bin.js" ]; then
  DSH_BIN="$DSH_ROOT/apps/cli/lib/bin.js"
  DSH_VERSION_LABEL=$(git -C "$DSH_ROOT" describe --tags --exact-match 2>/dev/null) || {
    printf 'dsh-root: checkout has no exact release tag; %s\n' "$DSH_EXPECTED_LAYOUTS" >&2
    return 1
  }
  DSH_EXPECTED_LABEL="$DSH_EXPECTED_TAG"
elif [ -f "$DSH_ROOT/lib/bin.js" ]; then
  DSH_BIN="$DSH_ROOT/lib/bin.js"
  DSH_VERSION_LABEL=$(node -e 'const fs = require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version);' "$DSH_ROOT/package.json") || {
    printf 'dsh-root: cannot read npm version; %s\n' "$DSH_EXPECTED_LAYOUTS" >&2
    return 1
  }
  DSH_EXPECTED_LABEL="$DSH_EXPECTED_VERSION"
else
  printf 'dsh-root: host not found; %s\n' "$DSH_EXPECTED_LAYOUTS" >&2
  return 1
fi
if [ "$DSH_VERSION_LABEL" != "$DSH_EXPECTED_LABEL" ]; then
  printf 'dsh-root: actual version %s; %s\n' "$DSH_VERSION_LABEL" "$DSH_EXPECTED_LAYOUTS" >&2
  return 1
fi
export DSH_BIN DSH_VERSION_LABEL

#!/usr/bin/env sh
# Usage: DSH_HOME=<home> SHUD_BIN=<absolute-executable> [DSH_ROOT=<host>] pnpm run profile:install
# PROFILE_NAME=shud / PROFILE_TEMPLATE=web by default; use shud-probe/headless for probes.
# Build workspace packages first. Only the user patch's shud-jobs item is installer-owned.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
: "${DSH_HOME:?profile:install requires DSH_HOME}"
case "${SHUD_BIN:-}" in
  /*) ;;
  *) echo "profile:install requires SHUD_BIN to be an absolute executable regular file" >&2; exit 1 ;;
esac
if [ ! -f "$SHUD_BIN" ] || [ ! -x "$SHUD_BIN" ]; then
  echo "profile:install requires SHUD_BIN to be an executable regular file" >&2
  exit 1
fi
# Match the host's home spelling before checking existence: template creation
# replaces an existing profile, so a shell/host path mismatch would lose user state.
DSH_HOME=$(node -e '
const path = require("node:path");
const os = require("node:os");
let home = process.env.DSH_HOME;
if (!home || !home.trim()) throw new Error("profile:install requires non-blank DSH_HOME");
if (home === "~") home = os.homedir();
else if (home.startsWith("~/") || home.startsWith("~\\")) home = path.join(os.homedir(), home.slice(2));
process.stdout.write(path.resolve(home));
')
export DSH_HOME
PROFILE_NAME="${PROFILE_NAME:-shud}"
PROFILE_TEMPLATE="${PROFILE_TEMPLATE:-web}"
PATCH="$DSH_HOME/profiles/$PROFILE_NAME/cordis.patch.yml"
STATE_DIR="$DSH_HOME/profiles/$PROFILE_NAME/shud-jobs"
# Reject malformed/ambiguous user YAML before the host can print source-bearing parser errors.
node "$ROOT/scripts/runtime/profile-patch.ts" --check "$PATCH" "$SHUD_BIN" "$STATE_DIR"
unset ALL_PROXY
. "$ROOT/scripts/runtime/dsh-root.sh"
if [ ! -d "$DSH_HOME/profiles/$PROFILE_NAME" ]; then
  node "$DSH_BIN" --profile "$PROFILE_NAME" --from-default-profile "$PROFILE_TEMPLATE" --dump-config >/dev/null
fi
node "$DSH_BIN" plugin --profile "$PROFILE_NAME" add "link:$ROOT/profile/shud"
node "$ROOT/scripts/runtime/profile-patch.ts" "$PATCH" "$SHUD_BIN" "$STATE_DIR"

#!/usr/bin/env sh
# Usage: DSH_HOME=<home> [DSH_ROOT=<checkout-or-npm-package>] pnpm run profile:install
# PROFILE_NAME=shud / PROFILE_TEMPLATE=web by default; use shud-probe/headless
# for probes. Build the workspace packages before installing. Never writes user patch.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
: "${DSH_HOME:?profile:install requires DSH_HOME}"
PROFILE_NAME="${PROFILE_NAME:-shud}"
PROFILE_TEMPLATE="${PROFILE_TEMPLATE:-web}"
unset ALL_PROXY
. "$ROOT/scripts/runtime/dsh-root.sh"
if [ ! -d "$DSH_HOME/profiles/$PROFILE_NAME" ]; then
  node "$DSH_BIN" --profile "$PROFILE_NAME" --from-default-profile "$PROFILE_TEMPLATE" --dump-config >/dev/null
fi
node "$DSH_BIN" plugin --profile "$PROFILE_NAME" add "link:$ROOT/profile/shud"

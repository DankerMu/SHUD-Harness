#!/usr/bin/env sh
# Local engineering gate; the automatic report Allow once is not PI acceptance. Retains evidence.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
[ "$#" -eq 1 ] && [ -n "$1" ] || {
  echo 'usage: shud-sensitivity.sh <scratch-workspace>; workspace required; no session started' >&2; exit 1
}
case "$1" in
  *[![:space:]]*) ;;
  *) echo 'shud:sensitivity requires nonblank workspace; no session started' >&2; exit 1 ;;
esac
case "${DMXAPI_KEY:-}" in
  *[![:space:]]*) ;;
  *) echo 'shud:sensitivity requires nonblank DMXAPI_KEY; no session started' >&2; exit 1 ;;
esac
case "${SHUD_BIN:-}" in
  /*) ;;
  *) echo 'shud:sensitivity requires explicit absolute SHUD_BIN; no session started' >&2; exit 1 ;;
esac
[ -f "$SHUD_BIN" ] && [ -x "$SHUD_BIN" ] && [ ! -L "$SHUD_BIN" ] || {
  echo 'shud:sensitivity requires executable regular SHUD_BIN; no session started' >&2; exit 1
}
[ -d "$ROOT/SHUD/input/ccw" ] && [ ! -L "$ROOT/SHUD/input/ccw" ] || {
  echo 'shud:sensitivity requires the SHUD/input/ccw source directory; no session started' >&2; exit 1
}
unset ALL_PROXY
if ! . "$ROOT/scripts/runtime/dsh-root.sh"; then
  echo 'shud:sensitivity: pinned dsh unavailable; no session started' >&2; exit 1
fi
DSH_ROOT=$(CDPATH='' cd -- "$DSH_ROOT" && pwd -P)
DSH_BIN=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$DSH_BIN")
export DSH_BIN DSH_ROOT SHUD_BIN
exec node "$ROOT/scripts/runtime/shud-sensitivity.ts" "$1"

#!/usr/bin/env sh
# Local real-Web SIGTERM/SIGKILL acceptance. Evidence stays under private HOME
# scratch on success and failure; no tracer, offline judge, or skip-build option.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
[ "$#" -eq 0 ] || { echo 'shud:restart accepts no arguments' >&2; exit 1; }
case "${DMXAPI_KEY:-}" in
  *[![:space:]]*) ;;
  *) echo 'shud:restart requires nonblank DMXAPI_KEY' >&2; exit 1 ;;
esac
SHUD_BIN="${SHUD_BIN:-$ROOT/SHUD/shud}"
case "$SHUD_BIN" in
  /*) ;;
  *) echo 'shud:restart requires absolute SHUD_BIN' >&2; exit 1 ;;
esac
[ -f "$SHUD_BIN" ] && [ -x "$SHUD_BIN" ] || {
  echo 'shud:restart requires executable regular SHUD_BIN (build SHUD first)' >&2
  exit 1
}
[ -f "$ROOT/SHUD/input/ccw/ccw.cfg.para" ] || {
  echo 'shud:restart requires SHUD/input/ccw source inputs' >&2; exit 1
}
unset ALL_PROXY
. "$ROOT/scripts/runtime/dsh-root.sh"
DSH_ROOT=$(CDPATH='' cd -- "$DSH_ROOT" && pwd -P)
DSH_BIN=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$DSH_BIN")
export SHUD_BIN DSH_BIN DSH_ROOT
exec node "$ROOT/scripts/runtime/shud-restart.ts"

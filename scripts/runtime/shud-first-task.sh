#!/usr/bin/env sh
# Local engineering gate, not PI functional acceptance. Retains all owned evidence.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
case "$#" in
  1) ;;
  3) [ "$2" = '--patch' ] || { echo 'usage: shud-first-task.sh <workspace> [--patch <file>]; no session started' >&2; exit 1; } ;;
  *) echo 'usage: shud-first-task.sh <workspace> [--patch <file>]; workspace is required; no session started' >&2; exit 1 ;;
esac
[ -n "$1" ] || { echo 'shud:first-task requires workspace; no session started' >&2; exit 1; }
case "${DMXAPI_KEY:-}" in
  *[![:space:]]*) ;;
  *) echo 'shud:first-task requires nonblank DMXAPI_KEY; no session started' >&2; exit 1 ;;
esac
case "${SHUD_BIN:-}" in
  /*) ;;
  *) echo 'shud:first-task requires explicit absolute SHUD_BIN; no session started' >&2; exit 1 ;;
esac
[ -f "$SHUD_BIN" ] && [ -x "$SHUD_BIN" ] && [ ! -L "$SHUD_BIN" ] || {
  echo 'shud:first-task requires executable regular SHUD_BIN; no session started' >&2; exit 1
}
[ -f "$ROOT/SHUD/input/ccw/ccw.cfg.para" ] || {
  echo 'shud:first-task requires SHUD/input/ccw source inputs; no session started' >&2; exit 1
}
if [ "$#" -eq 3 ]; then
  [ -f "$3" ] && [ -r "$3" ] && [ ! -L "$3" ] || {
    echo 'shud:first-task requires a readable regular --patch file; no session started' >&2; exit 1
  }
fi
unset ALL_PROXY
if ! . "$ROOT/scripts/runtime/dsh-root.sh"; then
  echo 'shud:first-task: pinned dsh unavailable; no session started' >&2
  exit 1
fi
DSH_ROOT=$(CDPATH='' cd -- "$DSH_ROOT" && pwd -P)
DSH_BIN=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$DSH_BIN")
export SHUD_BIN DSH_BIN DSH_ROOT
exec node "$ROOT/scripts/runtime/shud-first-task.ts" "$@"

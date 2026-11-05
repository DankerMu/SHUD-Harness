#!/usr/bin/env sh
# Local engineering evidence only; this never substitutes for PI acceptance.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
[ "$#" -eq 1 ] && [ -n "$1" ] || {
  echo 'usage: shud-replay.sh <scratch-workspace>; workspace required; no session started' >&2; exit 1
}
case "$1" in
  *[![:space:]]*) ;;
  *) echo 'shud:replay requires nonblank workspace; no session started' >&2; exit 1 ;;
esac
case "${DMXAPI_KEY:-}" in
  *[![:space:]]*) ;;
  *) echo 'shud:replay requires nonblank DMXAPI_KEY; no session started' >&2; exit 1 ;;
esac
case "${SHUD_BIN:-}" in
  /*) ;;
  *) echo 'shud:replay requires explicit absolute SHUD_BIN; no session started' >&2; exit 1 ;;
esac
[ -f "$SHUD_BIN" ] && [ -x "$SHUD_BIN" ] && [ ! -L "$SHUD_BIN" ] || {
  echo 'shud:replay requires executable regular SHUD_BIN; no session started' >&2; exit 1
}
case "${SUNDIALS_ROOT:-}" in
  /*) ;;
  *) echo 'shud:replay requires explicit absolute SUNDIALS_ROOT; no session started' >&2; exit 1 ;;
esac
[ -d "$SUNDIALS_ROOT" ] || {
  echo 'shud:replay requires existing SUNDIALS_ROOT directory; no session started' >&2; exit 1
}
case "${SHUD_REPLAY_KELIYA:-}" in
  *[![:space:]]*) ;;
  *) echo 'shud:replay requires SHUD_REPLAY_KELIYA; no session started' >&2; exit 1 ;;
esac
[ -d "$SHUD_REPLAY_KELIYA" ] && [ -f "$SHUD_REPLAY_KELIYA/keliya.cfg.para" ] && [ -f "$SHUD_REPLAY_KELIYA/keliya.tsd.forc" ] || {
  echo 'shud:replay requires existing SHUD_REPLAY_KELIYA input directory; no session started' >&2; exit 1
}
[ -f "$ROOT/../openMP/docs/p1e/p1e_strict_omp_design.md" ] && [ -r "$ROOT/../openMP/docs/p1e/p1e_strict_omp_design.md" ] || {
  echo 'shud:replay requires readable P1e design document; no session started' >&2; exit 1
}
unset ALL_PROXY
if ! . "$ROOT/scripts/runtime/dsh-root.sh"; then
  echo 'shud:replay: pinned dsh unavailable; no session started' >&2; exit 1
fi
DSH_ROOT=$(CDPATH='' cd -- "$DSH_ROOT" && pwd -P)
DSH_BIN=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$DSH_BIN")
export DSH_BIN DSH_ROOT SHUD_BIN SUNDIALS_ROOT SHUD_REPLAY_KELIYA
exec node "$ROOT/scripts/runtime/shud-replay.ts" "$@"

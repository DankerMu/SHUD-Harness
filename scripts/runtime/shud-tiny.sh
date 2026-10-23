#!/usr/bin/env sh
# ccw tiny fixture: copies SHUD/input/ccw into a scratch workspace, patches END to 30 days (the submodule is
# never modified), runs the built SHUD binary and asserts exit 0 + binary output present. Fails loud when the
# binary or inputs are missing — never skips green. Local-only (<2 min); CI has no SHUD build.
set -eu
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SHUD_BIN="${SHUD_BIN:-$ROOT/SHUD/shud}"
INPUT="$ROOT/SHUD/input/ccw"
DAYS="${SHUD_TINY_DAYS:-30}"
[ -x "$SHUD_BIN" ] || { echo "shud:tiny: SHUD binary not found/executable at $SHUD_BIN (cd SHUD && ./configure && make shud; SUNDIALS at ~/sundials)" >&2; exit 1; }
[ -f "$INPUT/ccw.cfg.para" ] || { echo "shud:tiny: ccw inputs missing at $INPUT (git submodule update --init SHUD)" >&2; exit 1; }
WS="${SHUD_TINY_WORKSPACE:-$(mktemp -d "${TMPDIR:-/tmp}/shud-tiny.XXXXXX")}"
KEEP="${SHUD_TINY_KEEP:-0}"
cleanup() { [ "$KEEP" = "1" ] || rm -rf "$WS"; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$WS/input/ccw" "$WS/output"
cp -R "$INPUT"/. "$WS/input/ccw/"
# Use the same byte-preserving, solver-compatible END updater as submitted runs.
node "$ROOT/packages/dsh-shud-jobs/src/shud-end.ts" "$WS/input/ccw/ccw.cfg.para" "$DAYS"
echo "shud:tiny: running $SHUD_BIN ccw for $DAYS days in $WS"
start=$(date +%s)
set +e
( cd "$WS" && "$SHUD_BIN" -o "$WS/output/ccw.out" ccw > "$WS/stdout.log" 2> "$WS/stderr.log" )
code=$?
set -e
elapsed=$(( $(date +%s) - start ))
if [ "$code" -ne 0 ]; then
  echo "shud:tiny: SHUD exited $code after ${elapsed}s (0=ok 10=NaN 12=file IO 13=input 19=CVODE 20=consistency)" >&2
  tail -20 "$WS/stderr.log" >&2; KEEP=1; echo "shud:tiny: workspace kept at $WS" >&2; exit 1
fi
N=$(find "$WS/output" -name "*.dat" | wc -l | tr -d ' ')
[ "$N" -gt 0 ] || { echo "shud:tiny: exit 0 but no .dat output under $WS/output" >&2; KEEP=1; exit 1; }
echo "shud:tiny: OK — exit 0, $N .dat files, ${elapsed}s"

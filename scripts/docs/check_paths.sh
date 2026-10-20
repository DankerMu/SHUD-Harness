#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
exec python3 -I "$SCRIPT_DIR/check_paths.py" "$@"

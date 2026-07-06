#!/bin/sh
set -eu

script_parent=${0%/*}
if [ "$script_parent" = "$0" ]; then
  script_parent=.
fi
SCRIPT_DIR=$(CDPATH= cd -P -- "$script_parent" && pwd -P)

python_realpath() {
  python_path=$1
  case "$python_path" in
    /*) current=$python_path ;;
    *) current=$PWD/$python_path ;;
  esac

  symlink_depth=0
  while [ -L "$current" ]; do
    symlink_target=$(/usr/bin/readlink "$current") || return 1
    case "$symlink_target" in
      /*) current=$symlink_target ;;
      *) current=${current%/*}/$symlink_target ;;
    esac
    symlink_depth=$((symlink_depth + 1))
    if [ "$symlink_depth" -gt 40 ]; then
      return 1
    fi
  done

  current_dir=${current%/*}
  current_name=${current##*/}
  if [ "$current_dir" = "$current" ]; then
    current_dir=.
  fi
  resolved_dir=$(CDPATH= cd -P -- "$current_dir" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "$resolved_dir" "$current_name"
}

python_realpath_trusted() {
  case "$1" in
    /bin/*|\
    /usr/bin/*|\
    /usr/local/bin/*|\
    /usr/local/sbin/*|\
    /usr/local/Cellar/*|\
    /opt/homebrew/bin/*|\
    /opt/homebrew/sbin/*|\
    /opt/homebrew/Cellar/*|\
    /Library/Apple/usr/bin/*|\
    /Library/Developer/CommandLineTools/usr/bin/*|\
    /Applications/Xcode.app/Contents/Developer/usr/bin/*|\
    /Library/Frameworks/Python.framework/*|\
    /System/Library/Frameworks/Python.framework/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

resolve_trusted_python3() {
  first_rejected_path=
  first_rejected_realpath=
  search_path=${PATH:-}
  fallback_path=/usr/bin:/usr/local/bin:/opt/homebrew/bin:/Library/Developer/CommandLineTools/usr/bin:/Applications/Xcode.app/Contents/Developer/usr/bin

  for path_group in "$search_path" "$fallback_path"; do
    old_ifs=$IFS
    IFS=:
    # shellcheck disable=SC2086
    set -- $path_group
    IFS=$old_ifs
    for python_dir do
      if [ -z "$python_dir" ]; then
        python_dir=.
      fi
      python_candidate=$python_dir/python3
      if [ ! -f "$python_candidate" ] || [ ! -x "$python_candidate" ]; then
        continue
      fi
      python_resolved=$(python_realpath "$python_candidate" 2>/dev/null) || python_resolved=
      if [ -n "$python_resolved" ] && python_realpath_trusted "$python_resolved"; then
        printf '%s\n' "$python_resolved"
        return 0
      fi
      if [ -z "$first_rejected_path" ]; then
        first_rejected_path=$python_candidate
        first_rejected_realpath=$python_resolved
      fi
    done
  done

  if [ -n "$first_rejected_path" ]; then
    printf 'check_shud_rshud.sh: rejected python3 candidate: path=%s realpath=%s\n' "$first_rejected_path" "${first_rejected_realpath:-unknown}" >&2
  else
    printf '%s\n' 'check_shud_rshud.sh: no python3 executable found' >&2
  fi
  return 1
}

PYTHON3=$(resolve_trusted_python3) || exit 127
WRAPPER_REALPATH=$(python_realpath "$SCRIPT_DIR/check_shud_rshud.sh") || {
  printf '%s\n' 'check_shud_rshud.sh: failed to resolve wrapper realpath' >&2
  exit 127
}
WRAPPER_NLINK=$(/usr/bin/env -u PYTHONHOME -u PYTHONPATH -u PYTHONSTARTUP -u PYTHONUSERBASE -u PYTHONBREAKPOINT "$PYTHON3" -I -c 'import os, sys; print(os.stat(sys.argv[1], follow_symlinks=True).st_nlink)' "$WRAPPER_REALPATH") || {
  printf '%s\n' 'check_shud_rshud.sh: failed to inspect wrapper link count' >&2
  exit 127
}
if [ "$WRAPPER_NLINK" != "1" ]; then
  printf 'check_shud_rshud.sh: wrapper hardlink count must be 1, got %s\n' "$WRAPPER_NLINK" >&2
  exit 126
fi
REAL_SCRIPT_DIR=${WRAPPER_REALPATH%/*}
HELPER_REALPATH=$REAL_SCRIPT_DIR/check_shud_rshud.py

unset PYTHONHOME PYTHONPATH PYTHONSTARTUP PYTHONUSERBASE PYTHONBREAKPOINT
export SHUD_RSHUD_READINESS_WRAPPER_REALPATH=$WRAPPER_REALPATH
export SHUD_RSHUD_READINESS_PYTHON_REALPATH=$PYTHON3
export SHUD_RSHUD_READINESS_WRAPPER_PARENT_PID=$$
export SHUD_RSHUD_READINESS_PYTHON_ISOLATED=1
export SHUD_RSHUD_READINESS_PYTHON_IMPORT_ENV_SCRUBBED=1

"$PYTHON3" -I "$HELPER_REALPATH" "$@"

#!/usr/bin/env sh
set -eu

generated_paths="docs/generated/schema docs/generated/json-schema"

bun run test:schema-generation
bun run schema:generate

tracked_diff=$(git diff --name-status -- $generated_paths)
untracked_status=$(git status --porcelain --untracked-files=all -- $generated_paths | sed -n '/^?? /p')

if [ -n "$tracked_diff" ]; then
  printf '%s\n' "generated schema outputs contain tracked drift:" >&2
  printf '%s\n' "$tracked_diff" >&2
fi

if [ -n "$untracked_status" ]; then
  printf '%s\n' "generated schema outputs contain untracked drift:" >&2
  printf '%s\n' "$untracked_status" >&2
fi

if [ -n "$tracked_diff" ] || [ -n "$untracked_status" ]; then
  exit 1
fi

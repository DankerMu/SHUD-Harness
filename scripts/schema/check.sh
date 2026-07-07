#!/usr/bin/env sh
set -eu

bun run test:schema-generation
bun run schema:generate
git diff --exit-code docs/generated/schema docs/generated/json-schema

status=$(git status --porcelain -- docs/generated/schema docs/generated/json-schema)
if [ -n "$status" ]; then
  printf '%s\n' "generated schema outputs contain untracked drift:" >&2
  printf '%s\n' "$status" >&2
  exit 1
fi

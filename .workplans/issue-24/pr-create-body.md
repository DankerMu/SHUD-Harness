Closes #24.

## Summary

- Add the canonical five-role `role -> toolIds` map in `packages/core`.
- Keep exact comparable `toolIds` separate from explanatory `permissionNotes`.
- Add snapshot and semantic invariant tests for role membership, write-class exclusions, spawn/wait exclusivity, coordinator no-bash, coder edit/patch ownership, and subset semantics.
- Clarify the OpenSpec fixture and GitHub issue body after fixture review found mixed capability labels vs exact tool ids.

## Verification

- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet`
- `git -C zero rev-parse HEAD` -> `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`

## Agent Review

- Pending Phase 4/4.5/7 workflow evidence.

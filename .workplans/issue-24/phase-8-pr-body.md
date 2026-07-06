Closes #24.

## Summary

- Add the canonical five-role `role -> toolIds` map in `packages/core`.
- Keep exact comparable `toolIds` separate from explanatory `permissionNotes`.
- Add snapshot and semantic invariant tests for role membership, write-class exclusions, spawn/wait exclusivity, coordinator no-bash, coder edit/patch ownership, and subset semantics.
- Clarify the OpenSpec fixture and GitHub issue body after fixture review found mixed capability labels vs exact tool ids.
- Exclude raw Zero `memory` from M1 comparable `toolIds`; use `harness.memory.propose` as the future proposal-only adapter id.

## Verification

- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet`
- `git -C zero rev-parse HEAD` -> `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`
- GitHub checks: `check`, `linux-base`, `macos-seatbelt`

## Agent Review

- Reviewer agents used: `review-correctness`, `review-integration`, `review-security-perf`, `review-test-evidence`, `review-spec-compliance`, `review-invariant-state`, `phase-7-final-gap-sweep`
- Reviewed head SHA: `d9fd2f0102e42de845a1b5e89409fff0198d6084`
- Review evidence: https://github.com/DankerMu/SHUD-Harness/pull/49#issuecomment-4888347240
- Chinese work summary: https://github.com/DankerMu/SHUD-Harness/pull/49#issuecomment-4888347260
- OpenSpec change: `m1-foundation`; fixture level: high capability/role-boundary review
- Key findings addressed: raw Zero `memory` was removed from comparable role `toolIds`; live Issue #24 and fixture evidence were aligned to `harness.memory.propose`
- Final status: latest comprehensive cross-review clean; Phase 7 final gap sweep clean; CI passed

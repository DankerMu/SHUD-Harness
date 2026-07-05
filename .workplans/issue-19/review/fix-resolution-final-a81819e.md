# Fix Resolution for PR #48 — final follow-up a81819e

Base reviewed SHA: `a81819e601410d4b85e90f060fc8024ae8e49e78`
Resolution commit: pending
Fix list: `.workplans/issue-19/review/fix-list-final-a81819e.md`

Resolved finding:

1. `cand-final-a81819e-01-descendant-tracker-full-ps-scan`
   - Status: fixed.
   - Change: descendant tracker periodic sampling is no longer an unbounded 100ms interval. It now samples immediately, then follows a finite backoff schedule: `100ms`, `250ms`, `500ms`, `1000ms`, `2000ms`, `4000ms`, then stops periodic polling.
   - Code: `packages/core/src/tools/raw-data-sandbox.ts`
   - Test: `descendant tracker periodic sampling uses a bounded backoff schedule`
   - Preserved behavior: timeout, abort, and final teardown still force explicit `sample()` before descendant cleanup.

Verification run after fix:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
  - Result: pass, 175 tests.
- `pnpm --package=bun@1.2.19 dlx bun run check`
  - Result: pass.
- `openspec validate m1-foundation --strict`
  - Result: pass.
- `git diff --check`
  - Result: pass.
- `git diff --check origin/main...HEAD -- packages docs openspec package.json`
  - Result: pass.
- `git -C zero diff --quiet`
  - Result: pass.
- `git -C zero rev-parse HEAD`
  - Result: `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`

Residual boundary:
- The fix intentionally does not claim complete arbitrary descendant lifecycle ownership after the bounded periodic window. That remains outside #19 per ADR/OpenSpec boundary.
- Raw byte authority remains enforced by seatbelt; timeout/abort/final teardown still perform explicit descendant sampling.

Next gate:
- Commit and push this fix.
- Rerun a comprehensive six-reviewer follow-up on the new head.
- If clean, run Phase 7 final gap sweep on the same head.

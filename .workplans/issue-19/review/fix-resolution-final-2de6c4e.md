# Fix Resolution for PR #48 — final follow-up 2de6c4e

Base reviewed SHA: `2de6c4e6f6aa1048fc232eacb21d1f42b9b88190`
Resolution commit: pending
Fix list: `.workplans/issue-19/review/fix-list-final-2de6c4e.md`

Resolved findings:

1. `cand-final-2de6c4e-01-tempRoot-ancestor-authority`
   - Status: fixed.
   - Change: `buildRawDataSeatbeltProfile` now treats `tempRoot` as part of the complete write-authorized root set before computing protected raw/evidence ancestor literal denies.
   - Code: `packages/core/src/tools/raw-data-sandbox.ts`
   - Invariant: broad helper temp roots may allow scratch writes, but they must not widen authority over protected raw/evidence ancestors.
   - Regression tests:
     - `profile builder denies protected ancestor literals introduced by broad temp roots`
     - `broad tempRoot cannot authorize raw ancestor moves outside scoped writes`

2. `cand-final-2de6c4e-02-mutable-trusted-ws-evidence`
   - Status: fixed.
   - Change: sandbox-owned advisory `tool.failed` input is stored as a frozen snapshot; public helpers return defensive copies, proof the copy, and the backend advisory WS builder revalidates the trusted proof immediately before emission.
   - Code:
     - `packages/core/src/tools/raw-data-sandbox.ts`
     - `packages/backend/src/ws/index.ts`
   - Invariant: raw-denial telemetry must be derived from the original sandbox-owned `ToolResult`; caller mutation of helper-returned objects cannot change emitted WS evidence.
   - Regression test:
     - `raw-data advisory builder ignores caller mutations of helper-returned evidence`

Verification run after fixes:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
  - Result: pass, 174 tests.
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

Next gate:
- Commit and push this fix.
- Rerun six-reviewer comprehensive follow-up on the new head.
- If clean, continue to final gap sweep and merge gate.

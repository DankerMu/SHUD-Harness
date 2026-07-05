# Fix Resolution for PR #48 — final follow-up bbae63f

Base reviewed SHA: `bbae63f2f03138e27023f7074d762a4c56cbabfb`
Resolution commit: pending
Fix list: `.workplans/issue-19/review/fix-list-final-bbae63f.md`

Resolved blocking inputs:

1. `cand-final-bbae63f-01-bounded-sampling-real-path-test`
   - Status: fixed.
   - Change: added adapter-backed tracker regression coverage proving `createInvocationDescendantTracker.start()` executes the real periodic path with a finite schedule only.
   - Code/test:
     - `packages/core/src/tools/raw-data-sandbox.ts`
     - `packages/core/src/tools/raw-data-sandbox.test.ts`
   - Evidence: focused suite now includes 178 tests and passes.

2. `cand-final-bbae63f-04-reserved-denial-public-guard`
   - Status: fixed.
   - Change: public WS and audit guards now reject reserved raw-denial decisions regardless of caller-supplied rule value. The trusted raw advisory path remains available.
   - Code/test:
     - `packages/backend/src/ws/index.ts`
     - `packages/backend/src/ws/index.test.ts`
     - `packages/core/src/tools/raw-data-sandbox.ts`
     - `packages/core/src/tools/raw-data-sandbox.test.ts`

3. `cand-final-bbae63f-06-descendant-pid-reuse`
   - Status: fixed.
   - Change: descendant tracking now distinguishes historical known PIDs from current, identity-matched invocation processes. Cleanup signals current provable invocation processes rather than stale historical numeric PIDs. Normal completion does not blindly signal reused stale PIDs; timeout/abort still signal the root process group and current descendants.
   - Code/test:
     - `packages/core/src/tools/raw-data-sandbox.ts`
     - `packages/core/src/tools/raw-data-sandbox.test.ts`

Non-implementation dispositions:
- `cand-final-bbae63f-02-sha-matched-evidence-gap`: confirmed as an orchestrator evidence-gate item, not a Phase 5/6 code finding. It will be closed by regenerating final SHA-matched review/verdict/Phase 7 evidence after the next clean head.
- `cand-final-bbae63f-03-same-toolresult-replay`: refuted; same actual `ToolResult` rebuild is allowed by the recorded provenance invariant.
- `cand-final-bbae63f-05-fuse-source-conflict`: plausible but non-blocking runtime hardening follow-up under the typed repo contract; intentionally not fixed in this PR slice.

Verification run after fixes:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
  - Result: pass, 178 tests.
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
- Complete arbitrary descendant lifecycle ownership remains outside #19. The wrapper now avoids stale historical PID signaling and maintains bounded local cleanup for processes still provably tied to the invocation.
- Non-blocking fuse source runtime XOR hardening remains a follow-up candidate.

Next gate:
- Commit and push this fix.
- Rerun comprehensive cross-review on the new head.
- If clean, run Phase 7 final gap sweep and produce SHA-matched final evidence.

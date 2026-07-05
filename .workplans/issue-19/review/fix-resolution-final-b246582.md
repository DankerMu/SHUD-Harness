# Fix Resolution for PR #48 — final follow-up b246582

Base reviewed SHA: `b2465822329f0183987d0a4ff2b5018e835277a0`
Resolution commit: pending
Fix list: `.workplans/issue-19/review/fix-list-final-b246582.md`
Strategy package: `.workplans/issue-19/review/gate-level-pr-strategy-pr48-final-b246582.md`

Resolved blocking inputs:

1. `cand-final-b246582-01-root-pid-reuse-before-first-identity`
   - Status: fixed.
   - Change: normal completed invocations now stop the descendant tracker and clear current state without sampling or signaling historical PIDs.
   - Rationale: normal completion occurs after `proc.exited`, so the wrapper must not infer ownership from a reused PID.
   - Regression: `normal completion cleanup does not sample or signal a reused root PID`.

2. `cand-final-b246582-02-internal-test-helper-export`
   - Status: fixed.
   - Change: package root export changed from broad `export * from "./raw-data-sandbox"` to an explicit production API whitelist. Test seams moved behind `raw-data-sandbox-test-support.ts`, which is not exported by package root.
   - Regression: `package root does not expose raw sandbox test seams or denial builders`.

3. `cand-final-b246582-03-audit-row-mutable-toctou`
   - Status: fixed.
   - Change: `appendPolicyGateAuditRow()` snapshots the audit row before the first await, validates the snapshot, and writes only the snapshot.
   - Regression: `public audit append snapshots caller row before async reservation`.

4. `cand-final-b246582-04-hardlink-scan-prebudget-realpath`
   - Status: fixed.
   - Change: `scanProtectedHardlinks()` validates budget before canonicalization and canonicalizes roots sequentially while counting each root against the same scan budget.
   - Regression: multi-root low-budget hardlink scan fails before unbounded root expansion.

5. `cand-final-b246582-05-public-raw-denial-builders`
   - Status: fixed.
   - Change: raw-denial payload/tool-result builders are no longer reachable through `@shud-harness/core` package root. Internal trusted construction remains available inside the module and test support.
   - Regression: root export contract test covers builder absence.

6. `cand-final-b246582-06-lstart-pid-identity-collision`
   - Status: fixed by removing the dependency on historical `lstart` identity for normal-completion signaling and limiting timeout/abort cleanup to current parent-chain state.
   - Regression: `timeout cleanup does not signal historical child PID outside the live parent chain`.

Verification run after fixes:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
  - Result: pass, 182 tests.
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
- The wrapper still does not claim complete arbitrary descendant lifecycle ownership after intentional escape; this remains outside #19. Timeout/abort retain bounded cleanup for the root process group and current parent-chain descendants.
- Non-blocking fuse source runtime XOR hardening remains a follow-up candidate.

Next gate:
- Commit and push this fix.
- Rerun comprehensive cross-review on the new head.
- If clean, run Phase 7 final gap sweep and produce SHA-matched final evidence.

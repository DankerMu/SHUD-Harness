# Fix List for PR #48 — final follow-up a81819e

Reviewed head SHA: `a81819e601410d4b85e90f060fc8024ae8e49e78`
Verdict table: `.workplans/issue-19/review/verdict-table-final-a81819e.md`

Pattern escalation: no
Failure class: numerical / resource / runtime bounds

Invariant:
- The interactive sandboxed bash wrapper must keep descendant containment bookkeeping bounded and proportional. It must not run unbounded full-process-table scans for the entire lifetime of a legal long-running command.

Fix 1: Bound descendant tracker sampling (P2)
Problem:
- `createInvocationDescendantTracker.start()` samples immediately and then every 100ms.
- Each sample runs `/bin/ps -axo pid=,ppid=` and reads the full process table.
- Caller-supplied `timeout` has no maximum cap, so long-running commands can cause many full-table scans.

Fix:
- Replace the fixed 100ms full-lifetime polling with bounded sampling and/or backoff.
- Preserve forced sampling during timeout, abort, and final teardown before killing descendants.
- Keep existing process-containment behavior for timeout/abort tests.
- Do not broaden #19 scope into complete arbitrary descendant lifecycle ownership.

Required tests/evidence:
- Add or update a regression proving normal successful commands do not keep sampling indefinitely at 100ms cadence.
- Keep timeout/abort descendant containment tests passing.
- Focused policy/raw/backend WS suite passes.
- Full `bun run check` passes.
- OpenSpec strict validate and `zero/` checks pass.

Verification after fix:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict`
- `git diff --check`
- `git diff --check origin/main...HEAD -- packages docs openspec package.json`
- `git -C zero diff --quiet`
- `git -C zero rev-parse HEAD`

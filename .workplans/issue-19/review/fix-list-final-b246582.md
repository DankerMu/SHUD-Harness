# Fix List for PR #48 — final follow-up b246582

Reviewed head SHA: `b2465822329f0183987d0a4ff2b5018e835277a0`
Verdict table: `.workplans/issue-19/review/verdict-table-final-b246582.md`
Strategy package: `.workplans/issue-19/review/gate-level-pr-strategy-pr48-final-b246582.md`

Pattern escalation: yes
Failure classes:
- `host-process-safety`
- `public-api-boundary`
- `telemetry-provenance`
- `resource-bounds`

Invariant:
- Normal completion must not signal host processes using historical or uncertain PID state.
- Only trusted internal raw sandbox evidence may construct reserved raw-denial payload/tool-result/event/audit shapes.
- Public audit append must snapshot checked input before async work.
- Hardlink scanning budget must bound root canonicalization as well as recursive traversal.

Fix 1: Remove destructive normal-completion PID cleanup (P2)
Required behavior:
- After `proc.exited` with final cause `completed`, stop tracker scheduling and do not signal PIDs based on tracker history.
- Timeout/abort may still signal the root process group through the live process handle and current parent-chain descendants.
- Do not rely on `lstart` identity for historical PID ownership; avoid identity-based stale PID inference.
Tests:
- Root PID reused before first identity sample -> normal cleanup does not signal.
- Child PID reused with same identity string but no current parent-chain from live root -> no signal.
- Timeout/abort descendant containment tests remain green.

Fix 2: Remove test/internal helpers and reserved-denial builders from package root API (P2)
Required behavior:
- `@shud-harness/core` package root must not expose `*ForTest` tracker helpers, internal sampling helper, or raw-denial builder functions that construct reserved-looking payload/tool-result shapes.
- Tests may import from a non-root test-support module or use local test seams that are not exported through `packages/core/src/tools/index.ts`.
Tests:
- Root export contract test asserts these symbols are absent from package root.
- Existing backend/core trusted raw advisory tests remain green.

Fix 3: Snapshot public audit append rows before await (P1)
Required behavior:
- `appendPolicyGateAuditRow()` clones/snapshots `options.row` before the first await, validates the snapshot, and writes only that snapshot.
Tests:
- Caller mutates original row immediately after calling `appendPolicyGateAuditRow()`; audit file must not contain reserved `denied_by_sandbox` or reserved error id.

Fix 4: Bound hardlink root canonicalization (P2)
Required behavior:
- `scanProtectedHardlinks()` validates budget before root canonicalization.
- Root canonicalization must be sequential and count toward the same budget, or root count must be capped by budget before any `realpath` fan-out.
Tests:
- Many protected roots with a low `maxScannedPathCount` fails before unbounded work and before scanning/canonicalizing every root concurrently.
- Existing hardlink residual detection still passes.

Verification after fixes:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict`
- `git diff --check`
- `git diff --check origin/main...HEAD -- packages docs openspec package.json`
- `git -C zero diff --quiet`
- `git -C zero rev-parse HEAD`

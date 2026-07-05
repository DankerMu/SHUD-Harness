# Fix List for PR #48 - final follow-up da20028

Reviewed head SHA: `da20028bc40c1e5f90b1aa3d245acf5181e6add6`
Verdict table: `.workplans/issue-19/review/verdict-table-final-da20028.md`
Strategy package: `.workplans/issue-19/review/gate-level-pr-strategy-pr48-final-da20028.md`

Pattern escalation: yes
Failure classes:
- `contract`
- `resource`
- `concurrency`
- `state-transition`

Invariant:
- Runtime/public boundaries must not rely on TypeScript-only types or monorepo alias accidents.
- Sandboxed bash execution must reject invalid or unbounded runtime inputs before spawning or scheduling timers.
- Timeout/abort cleanup must only signal processes still owned by the invocation, never a PID re-owned from a current process-table snapshot.
- Every wrapper-owned terminal failure path must finalize the running tool handle.

Fix 1: Runtime XOR guard for fuse source (P2)
Required behavior:
- `resolveShudBashFuseRules()` must reject objects that include both `fuseRules` and `fuseListPath`, even when `fuseRules` is an empty array.
- It must also reject objects with neither source if an untyped caller constructs one.
Tests:
- Both `fuseRules: []` and `fuseListPath` -> throws stable configuration error.
- Existing inline-rule and fuse-list-path cases remain green.

Fix 2: Seal test-support/package subpath boundary (P2)
Required behavior:
- `@shud-harness/core/*` must not expose `packages/core/src/*` internals to production/backend/frontend tsconfigs.
- Raw sandbox test-support helpers must not live at a package-like import path under `@shud-harness/core/tools/...`.
- Existing tests may use a non-public relative test-support path outside `packages/core/src` or another project-local test-only pattern.
Tests/proof:
- TypeScript/package-boundary regression or resolver proof showing `@shud-harness/core/tools/raw-data-sandbox-test-support` no longer resolves.
- Existing backend/core raw sandbox tests remain green.

Fix 3: Runtime timeout bounds (P2)
Required behavior:
- Validate `timeout` before `setTimeout()` and before spawn-side effects: finite number, integer or safely coercible only if existing pattern allows, minimum > 0, and an explicit max.
- Align tool schema metadata with the same min/max where the local tool metadata supports it.
Tests:
- Invalid/negative/zero/non-finite/huge timeout returns a stable failed `ToolResult`.
- Valid explicit timeout and default timeout behavior remain green.

Fix 4: Timeout/abort cleanup must not re-own root PID from `ps` (P2)
Required behavior:
- Root process signaling must be tied to the original `proc` handle/known process group, not a current `ps` row for the same pid.
- `listCurrentInvocationProcesses()` / descendant cleanup must not seed a reused root PID as owned solely because it appears in the current process table.
- Current descendants may be killed only when proven by safe parent-chain ownership under a live/known invocation root, or by the original process group signal path.
Tests:
- Simulated root PID reuse during timeout/abort cleanup does not signal the reused root pid/group.
- Live invocation child containment still kills expected descendants on timeout/abort.

Fix 5: Finalize pre-exec profile failures (P2)
Required behavior:
- `buildRawDataSeatbeltProfile()` and `createRawDataSeatbeltProfileFile()` failures must be converted into structured failed `ToolResult`s and returned through `finalizeToolResult()`.
- Audit reservations must still be closed and any created profile file cleaned up.
Tests:
- `runningToolRegistry` plus symlinked `profileRoot` or `tempRoot` -> failure result and running handle marked finished.
- Existing profile-root/temp-root symlink rejection tests remain green.

Verification after fixes:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict`
- `git diff --check`
- `git diff --check origin/main...HEAD -- packages docs openspec package.json tsconfig.base.json`
- `git -C zero diff --quiet`
- `git -C zero rev-parse HEAD`

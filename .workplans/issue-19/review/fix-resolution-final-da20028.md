# Fix Resolution for PR #48 - da20028 follow-up closure

Input head SHA: `da20028bc40c1e5f90b1aa3d245acf5181e6add6`
Fix list: `.workplans/issue-19/review/fix-list-final-da20028.md`
Verdict table: `.workplans/issue-19/review/verdict-table-final-da20028.md`
Strategy package: `.workplans/issue-19/review/gate-level-pr-strategy-pr48-final-da20028.md`

Resolution summary:
- Added runtime exactly-one-source validation for SHUD sandboxed bash fuse sources. Ambiguous `fuseRules` + `fuseListPath` and missing-source untyped inputs now fail closed instead of silently disabling fuse-list rules.
- Removed the `@shud-harness/core/*` TypeScript wildcard alias and moved raw sandbox test-support out of `packages/core/src`, so package-like subpath imports cannot resolve test-only seams.
- Added runtime sandboxed-bash timeout validation before spawn/timer side effects and aligned timeout schema metadata with min/max bounds.
- Refactored timeout/abort process cleanup so root termination uses the original process handle only. Descendant cleanup excludes root and only tracks current descendants through safe parent-chain/known-descendant state; tests cover reused root PID with `signalRootProcessGroup: true`.
- Converted pre-exec profile build/write failures into structured failed `ToolResult`s returned through `finalizeToolResult()`, preserving running handle terminal metadata.

Files changed:
- `packages/core/src/tools/policy-gate-registry.ts`
- `packages/core/src/tools/policy-gate-registry.test.ts`
- `packages/core/src/tools/raw-data-sandbox.ts`
- `packages/core/src/tools/raw-data-sandbox.test.ts`
- `packages/backend/src/ws/index.test.ts`
- `packages/core/test-support/raw-data-sandbox-test-support.ts`
- `packages/core/src/tools/raw-data-sandbox-test-support.ts` (deleted)
- `tsconfig.base.json`

Verification:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000` -> passed, 192 tests.
- `pnpm --package=bun@1.2.19 dlx bun run check` -> passed.
- `openspec validate m1-foundation --strict` -> passed.
- `git diff --check` -> passed.
- `git diff --check origin/main...HEAD -- packages docs openspec package.json tsconfig.base.json` -> passed.
- `git -C zero diff --quiet` -> passed.
- `git -C zero rev-parse HEAD` -> `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Status:
- Ready for commit and a new comprehensive six-reviewer follow-up on the resulting HEAD.

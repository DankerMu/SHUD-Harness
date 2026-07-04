Reviewer agent: review-integration
Review round: post-gate follow-up on 4717f16
Reviewed head SHA: 4717f1608058418a279365b385afc17e35e2238a

Summary: No integration findings found; prior cand-2689-01..04 and V73 follow-up risks appear closed at this head.

Invariant Matrix Coverage:
- profile/evidence identity: covered - denial payload, audit row, and WS input derive from the same payload/profile fields in `packages/core/src/tools/raw-data-sandbox.ts:766`, `:819`, `:863`, `:884`.
- ToolResult-WS-audit chain: covered - raw denial evidence builds ToolResult + audit row + `tool.failed` input together, and backend WS tests consume the same payload shape in `packages/backend/src/ws/index.test.ts:14` and `:45`.
- process lifecycle: covered - timeout/abort descendant cleanup, session-escape preflight, delayed audit-subtree move, and running metadata are covered by tests around `packages/core/src/tools/raw-data-sandbox.test.ts:1429`, `:1460`, `:1498`, `:1570`, `:1660`, `:1721`.
- compatibility: covered - legal raw reads, workspace writes, workspace-local `data/raw`, over-budget legal commands, and canonical audit roots are covered in `packages/core/src/tools/raw-data-sandbox.test.ts:914`, `:1288`, `:1845`, `:1876`, `:2513`, `:2669`.
- zero: covered - `git -C zero diff --quiet` returned 0 and `zero` remains at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Findings:
- None.

Non-blocking notes:
- Verification run: `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts` passed: 127 pass, 0 fail.
- Verification run: `pnpm --package=bun@1.2.19 dlx bun run typecheck` passed.
- Verification run: `git diff --check origin/main...HEAD` passed.
- Report file was not written because this review was explicitly read-only.

Execution Summary: agents=review-integration; skills=review; tools=gh, git, sed, rg, pnpm/bun test, tsc; verification=127 tests passed + typecheck + diff-check + zero clean; limits=read-only, no edits/commit/push.

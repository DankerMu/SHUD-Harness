# Fix Resolution for PR #48 - final follow-up b999d2e

Prior reviewed head SHA: `b999d2e6e03af4424620cd2077688c2fd322aa93`
Fix commit base: current `codex/issue-19-seatbelt-raw-deny` worktree after `fix-list-final-b999d2e.md`

## Resolution

- `cand-final-b999d2e-01-ci-ruby-move-oracle`: resolved by narrowing the Ruby move test oracle to the条 2' raw-byte authority boundary. The test now requires `data/raw/input.csv` bytes to remain unchanged and treats a runner-created `workspace/ruby-moved.csv` as an allowed raw-source copy side effect when present.
- `cand-final-b999d2e-02-policy-evaluator-exception-lifecycle`: resolved by catching policy evaluator/remediation exceptions inside `PolicyGatedBaseToolAdapter.run()`, returning a failed `ToolResult`, preserving deny-style post-processing, preventing inner tool execution, and finishing any registered running handle with failure metadata.

## Local verification

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts --timeout 30000`: pass, 22 tests.
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts --timeout 30000`: pass, 180 tests.
- `pnpm --package=bun@1.2.19 dlx bun run check`: pass.
- `SHUD_REQUIRE_SEATBELT_TESTS=1 pnpm --package=bun@1.2.19 dlx bun run test:policy-gate`: pass, 206 tests.
- `openspec validate m1-foundation --strict --no-interactive`: pass.
- `git diff --check`: pass.
- `git diff --check origin/main...HEAD -- packages docs openspec package.json tsconfig.base.json .github/workflows/ci.yml`: pass.
- `git -C zero diff --quiet`: pass.
- `git -C zero rev-parse HEAD`: `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

## Gate state

- Requires a new commit and GitHub CI rerun.
- Requires a fresh comprehensive cross-review and Phase 7 final review on the new frozen head SHA before merge.

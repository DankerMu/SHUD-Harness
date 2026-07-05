# Fix Resolution for PR #48 - final follow-up 92f5569

Prior reviewed head SHA: `92f556915416a57015dcaa32ca97e044c9fc3353`
Verdict table: `.workplans/issue-19/review/verdict-table-final-92f5569.md`
Fix list: `.workplans/issue-19/review/fix-list-final-92f5569.md`

## Resolution

- `cand-final-92f5569-01-malformed-custom-evaluator-deny`: resolved.
- `PolicyGatedBaseToolAdapter.run()` now validates a custom evaluator's returned decision before deny handling.
- Invalid returned decisions are converted through the existing evaluator-error path into a failed `ToolResult`, so they do not reject, do not execute the inner tool, and finish registered running handles.
- Valid generic denials and valid outer raw-rule misconfiguration behavior are preserved.

## Local verification

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts --timeout 30000`: pass, 24 tests.
- `pnpm --package=bun@1.2.19 dlx bun run check`: pass.
- `SHUD_REQUIRE_SEATBELT_TESTS=1 pnpm --package=bun@1.2.19 dlx bun run test:policy-gate`: pass, 208 tests.
- `openspec validate m1-foundation --strict --no-interactive`: pass.
- `git diff --check`: pass.
- `git diff --check origin/main...HEAD -- packages docs openspec package.json tsconfig.base.json .github/workflows/ci.yml`: pass.
- `git -C zero diff --quiet`: pass.
- `git -C zero rev-parse HEAD`: `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

## Gate state

- Requires commit and GitHub CI rerun.
- Requires a fresh comprehensive cross-review on the new frozen head SHA before Phase 7.

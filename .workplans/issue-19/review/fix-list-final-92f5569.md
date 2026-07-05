# Fix List for PR #48 - final follow-up 92f5569

Reviewed head SHA: `92f556915416a57015dcaa32ca97e044c9fc3353`
Verdict table: `.workplans/issue-19/review/verdict-table-final-92f5569.md`

Failure class:
- `state-transition`
- `contract`
- `test-evidence`

## Fix 1: Validate custom policy evaluator decisions before deny handling

Required behavior:
- Direct custom evaluator return values must be runtime-validated before branching on deny handling.
- Malformed raw-rule deny and malformed generic deny must return a failed `ToolResult`, not reject.
- The inner tool must not execute.
- The failed result must pass the same post-processing/finalization path used by deny/evaluator-error paths.
- A registered running handle must reach `finished` with failure metadata.

Allowed implementation scope:
- `packages/core/src/tools/policy-gate-registry.ts`
- `packages/core/src/tools/policy-gate-registry.test.ts`

Out of scope:
- No changes to `packages/core/src/tools/raw-data-sandbox.ts`.
- No changes to seatbelt profile semantics, advisory classification, audit/WS trusted evidence, or docs/spec boundary text.

Required verification:
- Focused tests for malformed raw-rule deny and malformed generic deny from a direct custom evaluator.
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `SHUD_REQUIRE_SEATBELT_TESTS=1 pnpm --package=bun@1.2.19 dlx bun run test:policy-gate`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`

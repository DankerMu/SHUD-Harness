# Fix List for PR #48 - final follow-up b999d2e

Reviewed head SHA: `b999d2e6e03af4424620cd2077688c2fd322aa93`
Verdict table: `.workplans/issue-19/review/verdict-table-final-b999d2e.md`

Failure classes:
- `ci-evidence`
- `test-oracle-boundary`
- `state-transition`

## Fix 1: Align Ruby raw-source move oracle with条 2' boundary

Required behavior:
- The Ruby raw-source move case must prove the raw source bytes remain unchanged.
- If the GitHub macOS runner creates `workspace/ruby-moved.csv`, the test must treat it as an allowed raw read/copy side effect and assert the content is the original raw bytes.
- The delete and copy-to-raw assertions must remain unchanged.

Verification:
- `SHUD_REQUIRE_SEATBELT_TESTS=1 pnpm --package=bun@1.2.19 dlx bun run test:policy-gate`
- GitHub `macos-seatbelt` and aggregate `check` pass on the pushed head.

## Fix 2: Fail closed on policy evaluator exceptions

Required behavior:
- Evaluator throws and invalid remediation must return a failed `ToolResult`, not reject.
- The inner tool must not execute.
- The returned result must pass the same post-processing/redaction/observability path as deny results.
- A registered running handle must reach `finished` with failure metadata.

Verification:
- Focused `policy-gate-registry.test.ts` tests for evaluator throw and invalid remediation.
- Full policy-gate and check suites pass.

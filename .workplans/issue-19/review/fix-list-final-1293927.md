# Fix List for PR #48 - final follow-up 1293927

Reviewed head SHA: `12939272a0803fa6a4fb627a389569979f1801c0`
Verdict table: `.workplans/issue-19/review/verdict-table-final-1293927.md`

Pattern escalation: yes
Failure classes:
- `ci-evidence`
- `state-transition`
- `information-disclosure`

Invariant:
- The PR's required CI signal must execute the #19 macOS seatbelt authority evidence, wrapper terminal metadata must reflect the final returned `ToolResult`, and policy-gate deny paths must preserve Zero secret redaction semantics.

## Fix 1: Required CI must execute seatbelt authority tests

Required behavior:
- Preserve the required status context name `check`.
- Make `check` depend on a Linux base job and a macOS seatbelt job.
- The macOS job must fail closed when `/usr/bin/sandbox-exec` is unavailable.
- The macOS job must run the policy-gate suite with seatbelt tests required, not silently skipped.

Tests / evidence:
- Workflow diff shows the aggregate `check` depends on both jobs.
- `SHUD_REQUIRE_SEATBELT_TESTS=1 bun run test:policy-gate` passes locally on macOS.
- GitHub PR checks must show `check` green after both dependent jobs pass.

## Fix 2: Finalize running tool metadata after final ToolResult

Required behavior:
- `RawDataSandboxedBashTool.execute()` must not permanently finish the running handle before Zero `afterExecute()`.
- Per-invocation termination cause must be recorded and applied once in `run()` after `super.run()` returns the final `ToolResult`.
- Preserve timeout/abort/spawn_error cause.

Tests:
- Existing terminal metadata tests remain green.
- New regression: an `afterExecute()` failure returns a failed `ToolResult`, and running handle metadata matches that final result.

## Fix 3: Redact policy-deny results

Required behavior:
- Normal policy deny and raw-rule-misconfigured deny must apply Zero-equivalent secret filtering before returning.
- `output`, `outputSummary`, and text `contentItems` must not leak registered secrets.

Tests:
- Normal policy deny with a fake registered secret in reason/remediation returns redacted output and summary.
- Raw-rule-misconfigured deny with a fake registered secret in reason/ref returns redacted output and summary.

## Verification after fixes

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `SHUD_REQUIRE_SEATBELT_TESTS=1 pnpm --package=bun@1.2.19 dlx bun run test:policy-gate`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git diff --check origin/main...HEAD -- packages docs openspec package.json tsconfig.base.json .github/workflows/ci.yml`
- `git -C zero diff --quiet`
- `git -C zero rev-parse HEAD`

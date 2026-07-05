# Fix Resolution - final follow-up 1293927

Source reviewed head SHA: `12939272a0803fa6a4fb627a389569979f1801c0`
Verdict table: `.workplans/issue-19/review/verdict-table-final-1293927.md`
Fix list: `.workplans/issue-19/review/fix-list-final-1293927.md`

## Resolution Summary

All three confirmed findings from the final 1293927 follow-up were fixed as one evidence/lifecycle closure pass across CI authority coverage, running-tool terminal metadata, and policy-deny secret redaction.

## Findings Closed

- `cand-final-1293927-01-ci-skips-seatbelt-authority`: `.github/workflows/ci.yml` now preserves the required `check` context as an aggregate job that depends on `linux-base` and `macos-seatbelt`. The macOS job fail-closes on missing Darwin `/usr/bin/sandbox-exec` or `python3`, then runs `bun run test:policy-gate` with `SHUD_REQUIRE_SEATBELT_TESTS=1`. The test files now throw under that env when required seatbelt prerequisites are unavailable, preventing skip-green authority evidence.
- `cand-final-1293927-02-afterexecute-terminal-metadata`: `RawDataSandboxedBashTool.execute()` no longer permanently marks the running handle before Zero `afterExecute()`. It records the per-invocation termination cause, and `run()` writes terminal metadata once after `super.run()` returns the final `ToolResult`, preserving timeout/abort/spawn-error causes. A regression covers `afterExecute()` failure after sandbox success.
- `cand-final-1293927-03-policy-deny-secret-redaction`: `PolicyGatedBaseToolAdapter` now routes policy-deny and raw-rule-misconfigured deny results through `afterExecute()` before returning, applying Zero secret redaction to `output`, `outputSummary`, and text content items. Focused tests cover normal deny and raw-rule-misconfigured deny with registered fake secrets.

## Verification

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000` -> pass, 209 tests.
- `pnpm --package=bun@1.2.19 dlx bun run check` -> pass.
- `SHUD_REQUIRE_SEATBELT_TESTS=1 pnpm --package=bun@1.2.19 dlx bun run test:policy-gate` -> pass, 204 tests.
- `openspec validate m1-foundation --strict --no-interactive` -> pass.
- `git diff --check` -> pass.
- `git diff --check origin/main...HEAD -- packages docs openspec package.json tsconfig.base.json .github/workflows/ci.yml` -> pass.
- `git -C zero diff --quiet` -> pass.
- `git -C zero rev-parse HEAD` -> `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

## Next Gate

The fix must be committed and pushed. GitHub must run the new aggregate `check` context and the macOS seatbelt job successfully before Phase 7 final review and merge.

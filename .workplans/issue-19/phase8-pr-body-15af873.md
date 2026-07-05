Closes #19

## Summary

- Implement the revised 条 2' execution-layer raw-data write guard with a SHUD-owned `RawDataSandboxedBashTool` wrapper around Zero BashTool.
- Add macOS seatbelt profile building with canonical paths, stable profile identity, `/usr/bin/sandbox-exec -f`, child-process inheritance, and raw write/delete/rename denial.
- Demote static pre-exec detection to advisory-only for obvious writes; uncertain shell forms fail open and remain covered by the OS sandbox for raw byte integrity.
- Add minimal policy-gate audit row support, `tool.failed` WS skeleton builder, and reusable bounded `nlink>1` protected-root scanner.
- Validate custom policy evaluator decisions before deny handling so malformed raw/generic denies fail closed and cannot fabricate trusted raw-denial evidence.

## Validation

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts --timeout 30000`
- `SHUD_REQUIRE_SEATBELT_TESTS=1 pnpm --package=bun@1.2.19 dlx bun run test:policy-gate`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`

## Boundary Notes

- `zero/` is unchanged and remains pinned at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- `sandbox-exec` execution tests run on macOS/seatbelt; non-macOS CI keeps baseline check coverage and does not claim Linux sandbox support.
- The ADR-recorded residual remains: pre-existing hardlink aliases can mutate the same inode through a raw-external path. This PR demonstrates that residual and provides bounded protected-root `nlink>1` detection; ingest/readiness wiring is out of scope.
- Hidden-denial full telemetry and arbitrary descendant lifecycle ownership are explicitly out of #19 and reserved for later executor/audit work; raw byte integrity remains enforced by the inherited seatbelt profile.

## Agent Review

- Reviewer agents used: `review-correctness`, `review-integration`, `review-security-perf`, `review-test-evidence`, `review-spec-compliance`, `review-invariant-state`, `review-final-gap-sweep`
- Reviewed head SHA: `15af873cf0eb54b6510257b126d55250a071df7f`
- Review evidence: https://github.com/DankerMu/SHUD-Harness/pull/48#issuecomment-4887135445
- OpenSpec change: `m1-foundation`; fixture level: high; selected risk packs: correctness, integration, security/performance, test-evidence, spec-compliance, invariant/state-machine/compatibility
- Latest comprehensive cross-review: clean on `15af873cf0eb54b6510257b126d55250a071df7f`
- Phase 4.5 verifier table: `.workplans/issue-19/review/verdict-table-final-15af873.md` (no candidates in the final round)
- Phase 7 final review: `.workplans/issue-19/review/final-review-15af873.md` (clean)
- Key findings addressed: final blocker `cand-final-92f5569-01-malformed-custom-evaluator-deny` closed by validating custom evaluator decisions and asserting lifecycle finalization for malformed raw/generic denies

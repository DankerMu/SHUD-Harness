Closes #19

## Summary

- Implement the revised 条 2' execution-layer raw-data write guard with a SHUD-owned `RawDataSandboxedBashTool` wrapper around Zero BashTool.
- Add macOS seatbelt profile building with canonical paths, stable profile identity, `sandbox-exec -f`, child-process inheritance, and raw write/delete/rename denial.
- Demote static pre-exec detection to advisory-only for obvious writes; uncertain shell forms fail open and are still covered by the OS sandbox.
- Add minimal policy-gate audit row support, `tool.failed` WS skeleton builder, and reusable bounded `nlink>1` protected-root scanner.
- Add OpenSpec Issue #19 fixture evidence and wire root `check` to run the new sandbox/WS tests.

## Validation

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`

## Boundary Notes

- `zero/` is unchanged and remains pinned at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- `sandbox-exec` execution tests run on macOS/seatbelt; future non-macOS CI skips those tests rather than claiming Linux support.
- The ADR-recorded residual remains: pre-existing hardlink aliases can mutate the same inode through a raw-external path. This PR demonstrates that residual and provides bounded protected-root `nlink>1` detection; ingest/readiness wiring is out of scope.

## Agent Review

Pending Phase 4/4.5/7 evidence.

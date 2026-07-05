# Fix Resolution - final follow-up 90c4c39

Source reviewed head SHA: `90c4c397d09d2dee2360b1aa9cc7a4f50db3cd9b`
Verdict table: `.workplans/issue-19/review/verdict-table-final-90c4c39.md`
Fix list: `.workplans/issue-19/review/fix-list-final-90c4c39.md`

## Resolution Summary

All four confirmed findings from the final 90c4c39 follow-up were fixed as one invariant-closure pass across constructor/factory identity, child environment inheritance, process-creation preflight, and wrapper-owned running-tool terminal metadata.

## Findings Closed

- `cand-final-90c4c39-01-mutable-root-arrays`: `RawDataSandboxedBashTool` now snapshots `protectedRawPaths`, `allowedWriteRoots`, and optional `protectedEvidencePaths` at construction. `createShudSandboxedBashTool()` also snapshots profile root arrays at the registry/factory boundary before constructing the sandboxed bash tool, so caller-owned array mutation cannot rebind protected raw/evidence roots or broaden allowed write roots after assembly.
- `cand-final-90c4c39-02-fake-wait-popen`: Python `subprocess.Popen(...)` static allowance is narrowed to immediate chained waits or the first next statement being `name.wait()`, `name.communicate()`, or `sys.exit(name.wait()/communicate())`. Statically evident fake waits such as `sys.exit(0); p.wait()` and `if False:\n p.wait()` are rejected before delayed workspace side effects can run. The waited foreground child positive case remains covered.
- `cand-final-90c4c39-03-lc-env-leak`: `buildSanitizedToolProcessEnv()` no longer inherits arbitrary `LC_*` environment variables. The sandbox child receives only the finite allowlist (`PATH`, temp variables, exact locale/terminal/tz names, and SHUD-owned `ZERO_*` values) plus explicit secret-resolution channels; fake `LC_API_KEY` and `LC_PASSWORD` sentinels are covered by regression tests.
- `cand-final-90c4c39-04-preexecute-terminal-metadata`: fuse denial moved from `BaseTool.fuseCheck()` into `RawDataSandboxedBashTool.execute()` so wrapper-owned terminal paths can call `finalizeToolResult()`. The tool also wraps `run()` and idempotently calls `markRunningToolFinished()` after `super.run()`, closing early `BaseTool` validation failures such as a missing `command` field without overwriting timeout/abort metadata that was already finalized.

## Verification

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000` -> pass, 206 tests.
- `pnpm --package=bun@1.2.19 dlx bun run check` -> pass.
- `openspec validate m1-foundation --strict --no-interactive` -> pass.
- `git diff --check` -> pass.
- `git diff --check origin/main...HEAD -- packages docs openspec package.json tsconfig.base.json` -> pass.
- `git -C zero diff --quiet` -> pass.
- `git -C zero rev-parse HEAD` -> `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

## Next Gate

The fix must be committed and pushed, then exactly one comprehensive six-reviewer follow-up must run on the new head SHA before Phase 7. If that review finds a same-family critical/major blocker, re-enter the gate-level strategy path rather than continuing ordinary narrow fixes.

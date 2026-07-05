# Fix Resolution - final follow-up e4f00c3

Source reviewed head SHA: `e4f00c39aebc0fa6bfbc609a973ec9ff3d8c5c6a`
Verdict table: `.workplans/issue-19/review/verdict-table-final-e4f00c3.md`
Fix list: `.workplans/issue-19/review/fix-list-final-e4f00c3.md`

## Resolution Summary

All five confirmed findings from the final e4f00c3 follow-up were fixed as one invariant-closure pass across process/environment boundaries, lifecycle finalization, and caller-owned mutable payload boundaries.

## Findings Closed

- `cand-final-e4f00c3-01-ambient-env-secrets`: `buildSanitizedToolProcessEnv()` no longer copies ambient `process.env` wholesale. The sandbox child environment is allowlisted to `PATH`, temp vars, locale/terminal/tz vars, plus SHUD-owned `ZERO_*` values; `BASH_ENV`/`ENV`/`BASH_FUNC_*` remain stripped. Ambient `GLM_API_KEY`, `SMTP_PASSWORD`, `HOME`, `USER`, `LOGNAME`, and `SHELL` sentinel values are covered by regression tests. Explicit `envSecrets` still reach the child through the resolver and are redacted by `secretFilter`.
- `cand-final-e4f00c3-02-unwaited-interpreter-child`: Python `subprocess.Popen(...)` calls without evident `.wait()` / `.communicate()` are rejected by process-containment preflight before delayed workspace side effects can run. Existing waited foreground `Popen(...).wait()` remains allowed.
- `cand-final-e4f00c3-03-stale-protected-raw-root-finalization`: stale `protectedRawPaths` canonicalization failures now return a structured profile setup failure through `finalizeToolResult()`, without audit/profile/command side effects, and finalize the running tool handle.
- `cand-final-e4f00c3-04-generic-ws-error-snapshot`: generic `tool.failed` WS events now snapshot `ErrorRecord` fields, nested evidence/action arrays, and remediation before storing the payload.
- `cand-final-e4f00c3-05-fuse-rule-object-mutation`: SHUD sandboxed bash construction and registry fuse-source resolution now clone fuse rule objects, so caller mutation after construction cannot alter fuse behavior.

## Verification

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000` -> pass, 199 tests.
- `pnpm --package=bun@1.2.19 dlx bun run check` -> pass.
- `openspec validate m1-foundation --strict --no-interactive` -> pass.
- `git diff --check` -> pass.
- `git diff --check origin/main...HEAD -- packages docs openspec package.json tsconfig.base.json` -> pass.
- `git -C zero diff --quiet` -> pass.
- `git -C zero rev-parse HEAD` -> `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

## Next Gate

The fix must be committed and pushed, then the full six-reviewer comprehensive follow-up must run on the new head SHA before Phase 7.

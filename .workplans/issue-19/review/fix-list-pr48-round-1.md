# Issue #19 PR #48 Phase 6 Fix List

Base reviewed SHA: `8b3795c7c593638e19513a01c4100b3dc743ef43`

Verified findings addressed:
- V19-1 runtime entrypoint: added SHUD-owned runtime registry assembly that registers `RawDataSandboxedBashTool` as `bash` without modifying `zero/`.
- V19-2 fuse preservation: `RawDataSandboxedBashTool` now requires an explicit inner tool or fuse rules; SHUD registry factory constructs the inner `BashTool` with the resolved fuse rules.
- V19-3 raw-copy false positive: advisory classification now treats `cp data/raw/input.csv workspace/input.csv` as legal read plus workspace write, while raw destinations still deny.
- V19-4 profile symlink poisoning: profile files are written to per-run unpredictable paths with exclusive creation and regular-file validation, then cleaned up after execution.
- V19-5 evidence chain: raw-data denial payload now maps to a single ToolResult, audit row, and WS `tool.failed` input carrying matching rule, decision, guard class, profile id, invocation id, remediation, and ErrorRecord.
- V19-6 swallowed sandbox denial: known suppressible shell forms are pre-classified so `2>/dev/null || true` cases return failed remediation evidence rather than success/audit allowed; variable target regression is covered.

Adjacent hardening folded into the same touched surface:
- audit task/file path segments are constrained;
- denial payload survives audit append failures;
- non-denial audit append is best-effort;
- hardlink scan has an explicit traversal budget;
- raw-data guard metadata distinguishes authority vs advisory.

Verification after fixes:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts --timeout 30000` -> 21 pass.
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000` -> 7 pass.
- `pnpm --package=bun@1.2.19 dlx bun run check` -> passed: 30 policy-gate tests, 2 backend WS tests, 6 schema tests.
- `openspec validate m1-foundation --strict --no-interactive` -> valid.
- `git diff --check` -> passed.
- `git -C zero diff --quiet && git -C zero rev-parse HEAD` -> clean, `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

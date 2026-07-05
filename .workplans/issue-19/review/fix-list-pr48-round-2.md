# Issue #19 PR #48 Phase 6.2 Fix List

Base reviewed SHA: `2fa51433f837db2803a8eb511d2e6400aeeb3be3`

Confirmed findings addressed:
- V2-1 dynamic suppressed raw write: denial-hiding shell forms with dynamic raw-target variables now return failed `denied_by_sandbox` evidence instead of `tool.completed/allowed`.
- V2-2 output text false denial: sandbox-output classification only runs for failed underlying executions; successful raw reads can print `sandbox` or `Permission denied` as ordinary data.
- V2-3 profile root/temp root symlink poisoning: profile/temp roots are rejected when their lexical or canonical destination enters protected raw paths, before profile artifacts are created.
- V2-4 audit append symlink/hardlink poisoning: audit directories/files reject symlink components and hardlink file targets; appends use no-follow open plus fd metadata checks.
- V2-5 spawn/scoped registry inheritance: `createShudRuntimeToolRegistry` rebuilds `spawn_agent` against the final SHUD registry when a copied prebuilt spawn tool is present, so scoped `bash` resolves to `RawDataSandboxedBashTool`.
- V2-6 advisory cwd false positive: static advisory fails open for ambiguous relative `data/raw/**` after cwd-changing commands while preserving direct root raw-write denial.

Adjacent hardening:
- `error_id` includes `invocation_id` when present, separating repeated denials under one profile.

Verification after fixes:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts --timeout 30000` -> 29 pass.
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000` -> 8 pass.
- `pnpm --package=bun@1.2.19 dlx bun run check` -> passed: 39 policy-gate tests, 2 backend WS tests, 6 schema tests.
- `openspec validate m1-foundation --strict --no-interactive` -> valid.
- `git diff --check` -> passed.
- `git -C zero diff --quiet && git -C zero rev-parse HEAD` -> clean, `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

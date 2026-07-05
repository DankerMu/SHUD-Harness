# Fix resolution -- final follow-up at 6a3fab6

Previous reviewed head SHA: `6a3fab6673b63e1a0609f00deb6b67c662e5901c`
PR: `#48`
Issue: `#19`

## Confirmed / plausible findings closed

- V1: explicit relative `auditWorkspaceRoot` no longer resolves against process cwd. Runtime relative roots now require and use a stable `pathResolutionRoot`.
- V2: relative raw authority roots no longer drift with each invocation `ctx.workDir`. Runtime relative roots require a stable project root, and missing base fails closed before bash execution.
- V3: profile cleanup validates the original run directory identity before recursive delete; if the path was substituted, cleanup warns and skips deletion instead of deleting a substituted target.

## Regression evidence

Added/updated tests:

- `relative protected raw paths resolve against stable pathResolutionRoot`
- `relative auditWorkspaceRoot resolves against stable pathResolutionRoot`
- `relative runtime roots without pathResolutionRoot fail closed before execution`
- `SHUD runtime registry propagates pathResolutionRoot to sandboxed bash`
- `profile cleanup skips substituted symlink target`

## Verification

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`: pass, 158 tests.
- `pnpm --package=bun@1.2.19 dlx bun run check`: pass; policy/raw 160 pass, backend WS 2 pass, schemas 6 pass.
- `openspec validate m1-foundation --strict --no-interactive`: pass.
- `git diff --check`: pass.
- `git diff --check origin/main`: pass.
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`: pass, `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

## Gate status

Implementation fix is ready for a fresh comprehensive follow-up review on the new head.

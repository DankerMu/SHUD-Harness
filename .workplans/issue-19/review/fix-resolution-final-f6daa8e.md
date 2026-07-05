# Fix resolution -- final follow-up at f6daa8e

Previous reviewed head SHA: `f6daa8ee6af061097a2407c35593def8a873f600`
PR: `#48`
Issue: `#19`

## Confirmed findings closed

- C1: Python `0//1` no longer hides `os.setsid()` from process-containment preflight.
- C2: Bare Python `start_new_session=True` / `preexec_fn=os.setsid` assignments no longer trip process-containment preflight unless they are process-creation arguments.
- C3: Only a top-level parent-shell `wait` clears pending background work; grouped and piped `wait` forms fail closed.
- C4: Public `appendPolicyGateAuditRow()` rejects reserved raw `denied_by_sandbox` audit rows.
- C5: `RawDataSandboxedBashTool.execute()` binds relative profile roots to `ctx.workDir`, so `protectedRawPaths: ["data/raw"]` protects the bash execution workspace rather than the Node process cwd.
- C6: profile cleanup is best-effort and logs cleanup failure without replacing the already-produced tool result.

## Regression evidence

Added/updated tests in `packages/core/src/tools/raw-data-sandbox.test.ts`:

- `relative protected raw paths resolve against ctx workDir instead of process cwd`
- `Python floor-division is not stripped as a line comment in process preflight`
- `bare Python containment keyword assignments can write workspace`
- `only top-level parent shell wait clears pending background preflight`
- `public audit append rejects reserved sandbox raw-denial rows`
- `profile cleanup failure is logged without replacing command result`
- updated `real process containment escape forms remain rejected` for `preexec_fn=os.setsid`

## Verification

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`: pass, 154 tests.
- `pnpm --package=bun@1.2.19 dlx bun run check`: pass; policy/raw 156 pass, backend WS 2 pass, schemas 6 pass.
- `openspec validate m1-foundation --strict --no-interactive`: pass.
- `git diff --check`: pass.
- `git diff --check origin/main`: pass.
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`: pass, `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

## Gate status

Implementation fix is ready for a fresh comprehensive follow-up review on the new head.

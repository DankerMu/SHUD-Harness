# Fix list -- final follow-up at f6daa8e

Reviewed head SHA: `f6daa8ee6af061097a2407c35593def8a873f600`
PR: `#48`
Issue: `#19`

## Fix 1: bind relative sandbox roots to the execution workspace

Failure class: path-safety / authority binding

Problem: `protectedRawPaths` can be provided as documented relative path `data/raw`. The wrapper currently canonicalizes relative paths against Node `process.cwd()`, but the sandboxed bash process runs with `cwd: ctx.workDir`. If those differ and both raw roots exist, seatbelt can protect the wrong directory.

Required behavior:
- Relative `protectedRawPaths`, `protectedEvidencePaths`, `allowedWriteRoots`, `tempRoot`, and `profileRoot` used by `RawDataSandboxedBashTool.execute()` must be resolved against `ctx.workDir` before canonicalization/profile construction/advisory signals, or rejected consistently with clear tests.
- Preserve absolute path behavior.
- Add a regression where process cwd and `ctx.workDir` differ and `protectedRawPaths: ["data/raw"]` still protects `ctx.workDir/data/raw`.

## Fix 2: close process-preflight parser context gaps

Failure class: process-containment / state-transition

Problem:
- Python floor-division `//` is treated as a line comment, so `0//1; os.setsid()` hides a static session escape.
- Bare `start_new_session=True` assignment is rejected even when no subprocess/process call exists.
- `(wait)` and `wait | cat` are treated as waiting for the parent shell background job, but bash returns immediately in those forms.

Required behavior:
- Do not treat `//` as a comment for Python/R/Ruby-style interpreter payloads where it is not a comment.
- Scope `start_new_session=True` and `preexec_fn=os.setsid` to actual Python process creation calls.
- Treat only top-level `wait` in the parent shell context as clearing pending background work.
- Add regressions for the three failing scenarios and preserve legal `& wait` / waited foreground subprocess behavior.

## Fix 3: preserve the reserved raw-denial audit boundary

Failure class: evidence contract

Problem: public `appendPolicyGateAuditRow()` accepts arbitrary `decision` strings and can append `{ rule: "raw-data-write", decision: "denied_by_sandbox" }`, bypassing the reserved raw-denial converter guard.

Required behavior:
- Public append rejects reserved raw-denial audit rows unless/until a trusted OS-event append path exists.
- Add a regression for rejected public append with `rule: "raw-data-write"` and `decision: "denied_by_sandbox"`.
- Keep generic lifecycle rows such as `allowed`, `failed`, and `policy_gate_process_containment_unavailable` valid.

## Fix 4: prevent profile cleanup from masking tool results

Failure class: resource / cleanup

Problem: profile/temp cleanup runs uncaught in `finally`; a command can mutate a writable profile/temp root and make cleanup throw, replacing the already-produced tool result.

Required behavior:
- Cleanup failure must not replace an already-produced `ToolResult`.
- Prefer keeping wrapper-owned profile/temp roots outside sandbox-writable workspace; at minimum make cleanup best-effort and log/record without masking the command outcome.
- Add a regression where the command mutates profile/temp permissions or path and assert the final tool result/audit lifecycle remains the command outcome.

## Verification required

- Focused tests for `packages/core/src/tools/raw-data-sandbox.test.ts`.
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git diff --check origin/main`
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`

# Finding Verification: cand-19-r5-01

Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Verdict: CONFIRMED

Evidence: `packages/core/src/tools/raw-data-sandbox.ts:326-332` builds `sandbox-exec -f ... bash -c ...` with bare `sandbox-exec` and passes it to the inner BashTool; `zero/packages/core/src/tool/bash.ts:350,355` runs `Bun.spawn(['bash', '-c', command], ... env: { ...buildToolProcessEnv(ctx), ... })`; `zero/packages/core/src/tool/process-env.ts:4-6` copies `process.env`, including `PATH`. If that `PATH` resolves a fake `sandbox-exec`, the required OS sandbox authority in `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:21-23` is not applied, and a successful unsandboxed command records `decision: "allowed"` via `packages/core/src/tools/raw-data-sandbox.ts:348-354`.

Note: No guard in the cited wrapper or registry fixes the launcher to `/usr/bin/sandbox-exec` or sanitizes `PATH`.

# Finding Verification: cand-19-r5-03

Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Verdict: CONFIRMED

Evidence: `wrapToolWithPolicyGate` returns stale wrapped tools unchanged (`if (isPolicyGatedTool(tool)) { return tool; }`, `packages/core/src/tools/policy-gate-registry.ts:76-77`); `createShudRuntimeToolRegistry` relies on that wrapper for supplied non-bash/non-spawn tools with the current evaluator (`packages/core/src/tools/policy-gate-registry.ts:146-152`); the adapter executes using its stored `this.options.evaluate` and then calls `this.innerTool.run(...)` on allow (`packages/core/src/tools/policy-gate-registry.ts:231-249`). The spec requires the central policy gate to cover all registered tools including `spawn/bash/edit` (`openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:7-10`).

Note: A public prewrapped `edit` tool with an allow evaluator is constructibly registered unchanged into a deny-evaluator SHUD registry and still passes the WeakSet-based gated check.

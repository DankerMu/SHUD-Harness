# Finding Verification: cand-19-r5-02

Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Verdict: CONFIRMED

Evidence: `createShudRuntimeToolRegistry` wraps `createShudSandboxedBashTool(options)` with the outer policy gate at `packages/core/src/tools/policy-gate-registry.ts:155-160`; `PolicyGatedBaseToolAdapter.run()` evaluates first and returns on deny before `innerTool.run()` at `packages/core/src/tools/policy-gate-registry.ts:231-249`; the returned payload is generic `error: "policy_gate_denied"` at `packages/core/src/tools/policy-gate-registry.ts:261-267`. The raw advisory rule is exported at `packages/core/src/tools/raw-data-sandbox.ts:455-472`, denies static raw writes at `packages/core/src/tools/raw-data-sandbox.ts:486-491`, and treats `data/raw/...` as protected at `packages/core/src/tools/raw-data-sandbox.ts:1297-1305`. Raw profile/audit/ErrorRecord evidence is only built inside `RawDataSandboxedBashTool.execute()` after audit/profile setup at `packages/core/src/tools/raw-data-sandbox.ts:271-286` and raw denial evidence at `packages/core/src/tools/raw-data-sandbox.ts:313-322,547-596`; spec requires advisory and OS denials to share ErrorRecord/audit/profile shape at `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:23-25`.

Note: No guard prevents installing `createRawDataWriteAdvisoryRule([rawRoot])` into the outer evaluator.

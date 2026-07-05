# Finding Verification: cand-19-r5-05

Reviewed head SHA: `3acdba26d142cff9f9b004975fa5e29dca327dd5`

Verdict: CONFIRMED

Evidence: `packages/core/src/tools/raw-data-sandbox.ts:497-525` denies masked failures only when `hasStaticRawDataWrite` or `hasDynamicRawDataWriteRisk`; `packages/core/src/tools/raw-data-sandbox.ts:1333-1337` returns allow when no raw-candidate variable exists; `packages/core/src/tools/raw-data-sandbox.ts:1415-1455` only promotes assigned raw-candidate variables, so `d=data; r=raw; ... > "$d/$r/direct.txt"` is missed. After execution, `packages/core/src/tools/raw-data-sandbox.ts:1546-1561` also requires the same precise signal for a successful result, and `packages/core/src/tools/raw-data-sandbox.ts:348-354` records `decision: "allowed"` when `result.success` remains true. Spec requires dynamic variable-path raw writes to return a failed tool result with audit `decision=denied_by_sandbox` at `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:29-32`.

Note: Exact redirection order may still emit stderr, but the success-path detector still misses the direct `$d/$r` target, so the masked/normalized denial can transition to allowed.

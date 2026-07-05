# Verifier verdict -- cand-observable-37-02

Reviewed head SHA: `37cd38e0817df73a07bc08ce79b3e3750a2e1436`

Verdict: CONFIRMED

Evidence: `policy-gate-registry.ts` handles `decision.decision === "deny"` with `ruleId === RAW_DATA_WRITE_RULE_ID` by calling `this.innerTool.run(toolContext, input)`. The inner sandbox then builds enforcement from its own `protectedRawPaths` and `enableAdvisory` before execution. Runtime registry options expose `evaluate` independently from sandbox roots/advisory, so a stale/mismatched raw evaluator deny can be delegated into a differently configured inner sandbox.

Note: Existing registry test covers this delegation only with matching roots.

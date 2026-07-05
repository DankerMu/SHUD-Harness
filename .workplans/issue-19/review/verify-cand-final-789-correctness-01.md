# Verification report -- cand-final-789-correctness-01

Candidate: outer raw-rule misconfiguration result uses invalid remediation action.
Reviewed head SHA: `789485ad5ad8bc75a560c0df5fdc12eb7137fee3`
Verifier agent: `019f3094-e001-7fd3-bb24-4524508fa412`
Verdict: CONFIRMED

Evidence:
- `packages/core/src/tools/policy-gate-registry.ts:250` routes `RAW_DATA_WRITE_RULE_ID` outer denials to the misconfiguration result.
- The payload used `next_action: "fix_configuration"`.
- `packages/core/src/tools/policy-gate-registry.test.ts:480` locked in that invalid value.
- `packages/core/src/domain/schemas/error.ts:19` defines the canonical remediation enum as `escalate_to_pi | open_gate | adjust_scope | fix_and_retry | abort`.
- `openspec/changes/m1-foundation/specs/core-schemas/spec.md:36` requires out-of-enum values to fail Zod validation.

Disposition:
Use canonical `fix_and_retry` for configuration repair and add schema-parse proof to the misconfiguration regression.

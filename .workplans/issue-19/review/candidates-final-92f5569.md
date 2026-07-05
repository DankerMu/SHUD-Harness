# Candidate Findings - final comprehensive follow-up 92f5569

PR: #48
Reviewed head SHA: `92f556915416a57015dcaa32ca97e044c9fc3353`
Fixture: expanded / high

Review reports:
- `.workplans/issue-19/review/followup-final-92f5569-correctness.md`: clean
- `.workplans/issue-19/review/followup-final-92f5569-integration.md`: clean
- `.workplans/issue-19/review/followup-final-92f5569-security-perf.md`: 1 candidate
- `.workplans/issue-19/review/followup-final-92f5569-test-evidence.md`: same candidate
- `.workplans/issue-19/review/followup-final-92f5569-spec-compliance.md`: clean
- `.workplans/issue-19/review/followup-final-92f5569-invariant-state.md`: same candidate

## Deduplicated candidates

### `cand-final-92f5569-01-malformed-custom-evaluator-deny`

Origin:
- review-security-perf
- review-test-evidence
- review-invariant-state

Severity: P2
Failure class: `state-transition` / `contract` / `test-evidence`

Claim:
- A direct custom `PolicyGateEvaluator` passed to `wrapToolWithPolicyGate()` or `createShudRuntimeToolRegistry({ evaluate })` can return malformed deny data after resolving normally.
- `PolicyGatedBaseToolAdapter.run()` catches evaluator throws, but does not validate the returned decision before deny-result construction.
- A malformed `RAW_DATA_WRITE_RULE_ID` deny can throw while building the raw-rule misconfiguration `ToolResult`, bypassing deny-style finalization and running-handle terminal metadata.
- A malformed generic deny can emit a non-navigable `policy_gate_denied` payload without required remediation.

Evidence cited by reviewers:
- `packages/core/src/tools/policy-gate-registry.ts:241`
- `packages/core/src/tools/policy-gate-registry.ts:271`
- `packages/core/src/tools/policy-gate-registry.ts:357`
- `packages/core/src/tools/policy-gate-registry.ts:383`
- `zero/packages/core/src/agent/agent.ts:251`

Required verification if confirmed:
- Add direct custom-evaluator malformed raw-rule deny and malformed generic deny tests.
- Assert failed `ToolResult`, inner tool call count remains 0, deny/error post-processing path returns rather than rejects, and registered running handles reach `finished`.

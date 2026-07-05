# Verifier Report - cand-final-1293927-03-policy-deny-secret-redaction

Reviewed head SHA: `12939272a0803fa6a4fb627a389569979f1801c0`
Verdict: CONFIRMED

## Evidence

- `PolicyGatedBaseToolAdapter.run()` overrides `BaseTool.run()` and returns policy-deny `ToolResult`s directly.
- Zero applies `ctx.secretFilter` inside `BaseTool.afterExecute()` to `output`, `outputSummary`, and text `contentItems`.
- Normal policy deny payloads copy `decision.reason` and remediation into `output`, and `decision.reason` into `outputSummary`.
- Raw-rule-misconfigured payloads copy `decision.reason` into `outer_reason` / `outputSummary` and include remediation fields.
- A registered secret in these fields would be returned unfiltered.

## Merge Impact

Blocks merge. The wrapper violates Zero lifecycle compatibility and the project secret-redaction invariant.

## Minimal Fix

Route policy-deny results through Zero-equivalent post-execute handling before returning, or explicitly apply the same secret filtering. Add focused tests for normal deny and raw-rule-misconfigured deny.

# Verifier Report - cand-final-b999d2e-02-policy-evaluator-exception-lifecycle

Reviewed head SHA: `b999d2e6e03af4424620cd2077688c2fd322aa93`
Verdict: CONFIRMED

## Evidence

- `PolicyGatedBaseToolAdapter.run()` directly awaited `this.options.evaluate(...)` without a catch.
- `evaluatePolicyGate()` can throw through invalid remediation validation.
- Zero `BaseTool.run()` normally converts thrown errors into failed `ToolResult`s and logs `tool_call_error`, but the policy wrapper bypassed that lifecycle by overriding `run()`.
- Agent execution marks a running tool finished only after `await tool.run(...)`; a rejecting wrapper can skip that terminal transition.

## Merge Impact

Blocks merge. The wrapper leaves a realistic configuration/evaluator error path outside the #19 lifecycle and fail-closed contract.

## Minimal Fix

Wrap evaluator/decision execution in Zero-equivalent error conversion. Return a failed `ToolResult`, do not execute the inner tool, run the same post-processing/redaction path as deny results, and ensure running handles finish.

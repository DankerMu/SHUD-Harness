Reviewer agent: review-invariant-state
Review round: final comprehensive follow-up 92f5569
Reviewed head SHA: 92f556915416a57015dcaa32ca97e044c9fc3353
Summary: Raw byte authority, trusted denial evidence, audit/WS identity, and b999d2e follow-up fixes are broadly covered; one P2 candidate remains around malformed custom policy evaluator deny results bypassing the fail-closed terminal-state path.

Invariant Matrix Coverage:
- Governing invariant: covered - `RawDataSandboxedBashTool` applies seatbelt profile before bash execution and tests cover read-allowed/write-denied cases in `packages/core/src/tools/raw-data-sandbox.ts:678` and `packages/core/src/tools/raw-data-sandbox.test.ts:933`.
- Source-of-truth identity/contract: covered - profile id, `RAW_DATA_WRITE_RULE_ID`, remediation ref, `tool.failed`, and audit rows are bound in `packages/core/src/tools/raw-data-sandbox.ts:32`, `packages/core/src/tools/raw-data-sandbox.ts:1137`, and `packages/backend/src/ws/index.ts:55`.
- Producers: covered - profile builder, sandboxed bash wrapper, advisory rule, audit helper, and WS builder are implemented in `packages/core/src/tools/raw-data-sandbox.ts:206`, `packages/core/src/tools/raw-data-sandbox.ts:495`, `packages/core/src/tools/raw-data-sandbox.ts:948`, and `packages/backend/src/ws/index.ts:50`.
- Validators/preflight: covered - absolute root resolution, fail-closed relative root handling, advisory deny, containment preflight, and nlink scanning are covered in `packages/core/src/tools/raw-data-sandbox.ts:374`, `packages/core/src/tools/raw-data-sandbox.ts:641`, `packages/core/src/tools/raw-data-sandbox.ts:660`, and `packages/core/src/tools/raw-data-sandbox.ts:1407`.
- Storage/cache/query: covered - profile files are created in isolated run roots and cleaned by identity check; audit append uses no-follow/hardlink checks at `packages/core/src/tools/raw-data-sandbox.ts:319`, `packages/core/src/tools/raw-data-sandbox.ts:4909`, and `packages/core/src/tools/raw-data-sandbox.ts:5127`.
- Public routes/entrypoints: covered - SHUD registry replaces bash with sandboxed bash and rewraps spawn scoped registries at `packages/core/src/tools/policy-gate-registry.ts:111` and `packages/core/src/tools/policy-gate-registry.ts:131`.
- Frontend/downstream consumers: covered - M1 exposes only the skeleton `tool.failed` builder, with trusted raw-denial input required at `packages/backend/src/ws/index.ts:55` and generic raw-denial forgery rejected at `packages/backend/src/ws/index.ts:87`.
- Failure paths/stale-state: missing - evaluator exceptions are caught, but malformed custom evaluator deny objects can still bypass deny-result construction/finalization; see finding below.
- Evidence/audit/readiness: covered - trusted advisory denial produces remediation-shaped ToolResult, audit row, and WS input; public audit/WS helpers reject reserved raw-denial shapes at `packages/core/src/tools/raw-data-sandbox.ts:1116` and `packages/backend/src/ws/index.ts:87`.
- Six escape classes: covered - tests assert byte preservation for interpreter payloads, pipeline/stdin, dynamic targets, child/grandchild state, symlink/`../`, rename/unlink at `packages/core/src/tools/raw-data-sandbox.test.ts:933`.
- Raw read and workspace write compatibility: covered - registry and sandbox tests cover `cat data/raw/input.csv`, workspace writes, and waited foreground subprocess compatibility at `packages/core/src/tools/policy-gate-registry.test.ts:494` and `packages/core/src/tools/raw-data-sandbox.test.ts:3034`.
- Pre-existing hardlink residual: covered - helper scans only explicit protected roots, enforces a budget, and reports nlink risks at `packages/core/src/tools/raw-data-sandbox.ts:1407`.
- Outer raw-rule ownership: covered - outer `RAW_DATA_WRITE_RULE_ID` deny is converted to configuration misuse without raw evidence at `packages/core/src/tools/policy-gate-registry.ts:271` and tested at `packages/core/src/tools/policy-gate-registry.test.ts:744`.
- Zero adapter governance: covered - Zero remains unmodified and pinned; `git -C zero diff --quiet` returned 0 and `zero` HEAD is `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Findings:
- Severity: P2
  Failure class: state-transition / contract-validation
  Contract or invariant: Policy-gate evaluator/remediation failures must fail closed as a failed `ToolResult`, skip inner execution, run deny-style post-processing, and finish running handles.
  Scenario or repro: A caller supplies `createShudRuntimeToolRegistry({ evaluate })` or `wrapToolWithPolicyGate(..., { evaluate })` with a custom evaluator that returns a malformed deny object, for example `decision: "deny", ruleId: RAW_DATA_WRITE_RULE_ID, reason: "x"` without a valid `remediation`. The evaluator call itself succeeds, so the catch at `run()` does not execute; then raw-rule misconfiguration result construction dereferences `decision.remediation.ref` and can throw before `finalizePolicyGateResult()` marks the running handle finished.
  Evidence: `packages/core/src/tools/policy-gate-registry.ts:241`, `packages/core/src/tools/policy-gate-registry.ts:271`, `packages/core/src/tools/policy-gate-registry.ts:357`, `packages/core/src/tools/policy-gate-registry.ts:383`; Zero caller only marks the running handle after `tool.run()` resolves at `zero/packages/core/src/agent/agent.ts:251`.
  Consequence: Raw bytes are still protected because the inner bash tool is not executed, but the tool call can surface as a rejected execution with stale running metadata instead of the required failed `ToolResult`; generic malformed denies can also emit a policy denial without the required remediation payload.
  Fix direction: Add runtime validation/normalization for every custom `PolicyGateDecision` before deny handling, or wrap deny-result construction inside the same fail-closed finalization path; invalid or missing remediation should become a failed `ToolResult` with `fix_and_retry` remediation and should call `markRunningToolFinished`.
  Required verification: Add focused tests where a custom evaluator returns malformed generic deny and malformed raw-rule deny; assert inner tool calls stay at 0, returned value is a failed `ToolResult`, post-processing runs, and a registered running handle reaches `finished`.
  Sibling surfaces: `createPolicyGatedToolRegistry`, `createShudRuntimeToolRegistry`, `wrapToolWithPolicyGate`, custom async evaluators, and future policy evaluators not created through `createPolicyGateEvaluator`.
  Blocks merge: No, candidate P2; does not weaken the raw byte invariant, but should be fixed or explicitly accepted as a trusted-code-only precondition.

Non-blocking notes:
- I did not rerun test commands in this read-only leaf review; I reviewed source/tests/diff evidence and used the supplied CI-pass state for `linux-base`, `macos-seatbelt`, and `check`.

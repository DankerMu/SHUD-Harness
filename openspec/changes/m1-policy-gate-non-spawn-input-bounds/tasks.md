## 1. Preparation Contract

- [x] 1.1 Add generic non-spawn preparation budgets and descriptor-safe
  inspection before structured cloning.
- [x] 1.2 Change generic non-spawn preparation to use one execution snapshot and
  a mutation-blocking evaluator view.
- [x] 1.3 Preserve existing preparation failure payloads, evaluator failure
  behavior, and running-tool metadata finalization.
- [x] 1.4 Audit and preserve the `spawn_agent` preparation path unchanged.

## 2. Regression Tests

- [x] 2.1 Add tests for oversized and deeply nested non-spawn inputs failing
  closed before evaluator and inner tool execution.
  - Inputs: object depth = generic max depth + 1; array length = generic max
    array length + 1; total string budget = generic max string budget + 1.
  - Expected: result contains `policy_gate_input_preparation_failed`, evaluator
    calls = 0, inner tool calls = 0, running handle finished with failed summary.
- [x] 2.2 Add tests that evaluator top-level and nested mutation attempts cannot
  affect inner tool execution.
  - Inputs: `{ command: "original", nested: { flag: "original" } }`.
  - Mutations attempted by evaluator: `input.command = "mutated"` and
    `input.nested.flag = "mutated"`.
  - Expected: mutation returns a failed ToolResult before inner execution, or the
    inner tool receives `command="original"` and `nested.flag="original"`; in no
    case may the inner tool execute mutated input.
- [x] 2.3 Keep hostile accessor/prototype-pollution preparation tests green.
- [x] 2.4 Add or preserve tests proving representative `spawn_agent` paths remain
  unchanged.
  - Valid input: `role="worker"`, `tools=["read"]`, non-empty instruction ->
    allow path preserves normalized execution input.
  - Invalid input: `role="worker"`, `tools=["read","edit"]` -> deny before spawn
    with `ruleId=spawn-profile-subset`, `guard_class=authority`, and
    `remediation.next_action=adjust_scope`.

## 3. Risk Pack Evidence Matrix

- [x] 3.1 Public API / CLI / script entry: wrapped non-spawn `run()` tests cover
  the public entrypoint result shape for allow, preparation failure, and
  evaluator failure.
- [x] 3.2 Auth / permissions / secrets: representative valid and invalid
  `spawn_agent` profile tests preserve issue #20 authority semantics and
  `guard_class=authority`.
- [x] 3.3 Concurrency / shared state / ordering: evaluator mutation tests prove
  evaluator code cannot mutate the execution snapshot observed by the inner
  tool.
- [x] 3.4 Resource limits / large input / discovery: depth, array-length, and
  string-budget tests fail closed before evaluator execution.
- [x] 3.5 Legacy compatibility / examples: existing non-spawn deny, preparation
  failure, raw-data wrapper, and spawn tests remain green under `bun run check`.
- [x] 3.6 Error handling / rollback / partial outputs: preparation and evaluator
  failures skip inner execution and finish running-tool handles.
- [x] 3.7 Release / packaging / dependency compatibility: no dependency manifest
  or Zero source changes; `git -C zero diff --quiet` stays clean.
- [x] 3.8 Zero adapter / tool registry / agent role governance: SHUD policy-gated
  registry and spawn profile subset tests remain green.

## 4. Verification

- [x] 4.1 Run focused core policy-gate tests; expected exit 0.
- [x] 4.2 Run `npx --yes bun@1.2.19 run check`; expected exit 0.
- [x] 4.3 Run `openspec validate m1-policy-gate-non-spawn-input-bounds --strict --no-interactive`; expected exit 0.
- [x] 4.4 Run `git diff --check` and `git -C zero diff --quiet`; expected clean
  whitespace diff and zero submodule diff.
- [x] 4.5 Verify no runtime dependency manifest changes are present unless an
  unexpected implementation blocker is documented in PR evidence.

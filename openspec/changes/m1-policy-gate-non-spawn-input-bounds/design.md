## Context

Issue #51 is a PR #50 follow-up for the shared policy-gate wrapper. The current
generic non-spawn path clones input once for execution and again for evaluator
inspection. That preserves isolation, but it also makes large or deeply nested
inputs pay repeated preparation cost before policy evaluation can deny.

Fixture level: expanded; repair intensity: high. Project profile: SHUD-Harness.

Expanded-trigger rationale:
- Core triggers: shared wrapper entrypoint, resource-limit behavior, hostile
  input handling, and error/finalization paths.
- Profile triggers: `remediation`, `guard_class`, `Zero`, `ToolBase`, and
  tool registry governance.

## Goals / Non-Goals

Goals:
- Bound generic non-spawn preparation before expensive cloning.
- Use one execution snapshot for generic non-spawn input.
- Give policy evaluators a read-only view so evaluator mutation cannot alter
  inner tool execution.
- Preserve fail-closed behavior and running-tool metadata finalization.
- Leave `spawn_agent` normalization and authority snapshot behavior unchanged.

Non-Goals:
- Changing spawn profile subset enforcement.
- Changing raw-data sandbox semantics.
- Accepting arbitrary live proxies, accessors, functions, symbols, or
  prototype-polluting objects as safe policy-gate input.

## Decisions

1. Generic non-spawn input gets a budget check before `structuredClone`.
   The check inspects descriptors rather than reading accessor values. Accessors,
   functions, symbols, excessive depth, excessive node count, excessive array
   length, or excessive string budget fail closed as preparation errors.

2. Generic non-spawn input uses a single execution snapshot.
   After the budget check, one `structuredClone` creates the value passed to the
   inner tool. The evaluator receives a recursively read-only view of that
   snapshot, not a second clone.

3. The read-only evaluator view is a policy wrapper concern only.
   Mutation attempts from custom evaluators fail inside evaluator execution and
   return the existing failed ToolResult shape without invoking the inner tool.
   Honest evaluators continue to read the same data shape as before.

4. Spawn remains separate.
   `spawn_agent` keeps using `normalizeSpawnAgentInput()` plus its existing
   cloned evaluator snapshot because its role/tool authority path has separate
   invariants from issue #20.

Risk packs considered:
- Public API / CLI / script entry: selected - every wrapped non-spawn tool
  enters through `run()`.
- Config / project setup: not selected - no setup or environment change.
- File IO / path safety / overwrite: not selected - no path write semantics
  change in this slice.
- Schema / columns / units / field names: not selected - no schema field change.
- Auth / permissions / secrets: selected - spawn profile authority,
  `guard_class`, and deny/allow behavior must remain unchanged while the generic
  non-spawn path changes.
- Concurrency / shared state / ordering: selected - evaluator code must not
  mutate the execution snapshot before the inner tool runs.
- Resource limits / large input / discovery: selected - the issue is resource
  pressure from large/deep inputs.
- Legacy compatibility / examples: selected - existing non-spawn allow/deny and
  spawn behavior must remain compatible.
- Error handling / rollback / partial outputs: selected - preparation and
  evaluator failures must fail closed and finalize running metadata.
- Release / packaging / dependency compatibility: selected - no new runtime
  dependency and Zero source diff stays 0.
- Documentation / migration notes: not selected - PR evidence is sufficient.
Domain packs:
- Scientific governance / PI gate / evidence lineage: not selected - no
  scientific evidence or PI decision change.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - no
  solver/runtime behavior change.
- Zero adapter / tool registry / agent role governance: selected - this is a
  shared Zero tool wrapper boundary.

Invariant Matrix:
- Governing invariant: Generic non-spawn policy-gate preparation must bound
  untrusted input cost and must not let evaluator mutation change the input that
  the inner tool executes.
- Source-of-truth identity/contract: issue #51 acceptance criteria,
  `PolicyGatedBaseToolAdapter.preparePolicyGateInput()`, and existing
  `policy_gate_input_preparation_failed` / evaluator-failure ToolResult shapes.
- Producers: non-spawn tool callers and custom policy evaluators.
- Validators/preflight: generic preparation budget check and structured clone.
- Storage/cache/query: none - no persisted runtime state.
- Public routes/entrypoints: wrapped non-spawn `BaseTool.run()` path.
- Frontend/downstream consumers: none in this slice.
- Failure paths/rollback/stale state: preparation failures and evaluator
  mutation failures return stable failed ToolResults, skip inner tool execution,
  and finish any running-tool handle.
- Evidence/audit/readiness: unit tests, OpenSpec validation, `bun run check`,
  `git diff --check`, and `git -C zero diff --quiet`.
- Regression rows:
  - Oversized/deep non-spawn input -> preparation fails closed before evaluator
    and inner tool execution, with existing preparation failure payload.
  - Evaluator mutates top-level or nested non-spawn input -> evaluator failure
    is returned, inner tool does not run, and the execution snapshot remains
    isolated.
  - Honest evaluator reads valid non-spawn input -> inner tool receives the
    expected snapshot exactly once.
  - Existing accessor/prototype-polluting hostile input -> preparation still
    fails closed without leaking getter text or running the inner tool.
  - `spawn_agent` valid and invalid profile paths -> unchanged behavior.

Boundary-surface checklist:
- Shared helper roots: `packages/core/src/tools/policy-gate-registry.ts`.
- Public entrypoints: wrapped non-spawn `run()` path; spawn path audited as
  unchanged.
- Read surfaces: evaluator reads of prepared input.
- Write/delete/overwrite surfaces: evaluator mutation attempts against prepared
  input.
- Failure/evidence boundaries: preparation failure payload, evaluator failure
  ToolResult, and running-tool finalization.
- Unchanged downstream consumers: raw-data sandbox wrapper, spawn profile subset
  rule, and role-tool map tests.

## Risks / Trade-offs

- Read-only evaluator views may surface mutation attempts as evaluator failures.
  Mitigation: policy evaluators are inspection code; tests lock the failure as
  fail-closed and non-executing.
- Budget constants can reject pathological but technically cloneable inputs.
  Mitigation: this boundary is a shared policy gate; safe, bounded inspection is
  preferred over unbounded preparation.

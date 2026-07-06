## Context

Issue #51 is a PR #52 invariant-closure follow-up for the shared policy-gate
wrapper. The generic non-spawn path must reject pathological input before
expensive descriptor materialization, give honest evaluators cloneable data, and
keep evaluator mutation away from the input later supplied to the inner tool.

Fixture level: expanded; repair intensity: high. Project profile: SHUD-Harness.

Expanded-trigger rationale:
- Core triggers: shared wrapper entrypoint, resource-limit behavior, hostile
  input handling, and error/finalization paths.
- Profile triggers: `remediation`, `guard_class`, `Zero`, `ToolBase`, and
  tool registry governance.

## Goals / Non-Goals

Goals:
- Bound generic non-spawn preparation before expensive cloning.
- Use separate execution and evaluator snapshots for generic non-spawn input.
- Make evaluator snapshots cloneable plain data, with recursive null prototypes
  for plain objects.
- Isolate evaluator direct mutation and block input-derived prototype mutation
  paths from altering inner tool execution.
- Preserve fail-closed behavior and running-tool metadata finalization.
- Leave `spawn_agent` normalization and authority snapshot behavior unchanged.

Non-Goals:
- Changing spawn profile subset enforcement.
- Changing raw-data sandbox semantics.
- Accepting arbitrary live proxies, accessors, functions, symbols, or
  prototype-polluting objects as safe policy-gate input.

## Decisions

1. Generic non-spawn input gets cheap budget checks before descriptor reads.
   Arrays reject over-length `length` before own-key or element-descriptor
   enumeration. Plain objects reject over-budget own-key counts before per-key
   descriptor reads. Accessors, functions, symbols, bigint values, symbol keys,
   excessive depth, excessive node count, excessive array length, excessive
   object key count, or excessive string budget fail closed as preparation
   errors.

2. Generic non-spawn input uses bounded twin snapshots.
   After descriptor-safe inspection, the wrapper creates one execution snapshot
   for the inner tool and one evaluator snapshot for policy evaluation. Both
   snapshots are plain structured data. Plain object snapshots use null
   prototypes recursively; evaluator arrays also use null prototypes so
   input-derived array `constructor` / prototype paths cannot mutate shared
   array prototypes.

3. Evaluator mutation is isolated by snapshot separation.
   Direct top-level or nested evaluator mutation may succeed on the evaluator
   snapshot, but the inner tool receives the original execution snapshot.
   Honest evaluators can `structuredClone(call.input)` before returning allow.
   Prototype mutation attempts through `Object.getPrototypeOf(call.input)` or
   `call.input.constructor?.prototype` either have no reachable prototype or do
   not affect the execution snapshot.

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
  untrusted input cost, preserve cloneable honest-evaluator read semantics, and
  must not let evaluator mutation change the input that the inner tool executes.
- Source-of-truth identity/contract: issue #51 acceptance criteria,
  `PolicyGatedBaseToolAdapter.preparePolicyGateInput()`, and existing
  `policy_gate_input_preparation_failed` / evaluator-failure ToolResult shapes.
- Producers: non-spawn tool callers and custom policy evaluators.
- Validators/preflight: generic preparation budget check, descriptor-safe
  inspection, and bounded snapshot creation.
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
  - Over-length arrays and over-wide objects -> cheap budget rejection happens
    before array own-key / element descriptor enumeration or per-key object
    descriptor reads.
  - Evaluator mutates top-level or nested non-spawn input -> inner tool still
    receives the original execution snapshot.
  - Honest evaluator snapshots valid non-spawn input with `structuredClone` ->
    clone succeeds and inner tool receives the expected execution snapshot.
  - Existing accessor/prototype-polluting/proxy-hostile/unsafe value input ->
    preparation still fails closed without leaking trap or getter text and
    without running the inner tool.
  - `spawn_agent` valid and invalid profile paths -> unchanged behavior.

Boundary-surface checklist:
- Shared helper roots: `packages/core/src/tools/policy-gate-registry.ts`.
- Public entrypoints: wrapped non-spawn `run()` path; spawn path audited as
  unchanged.
- Read surfaces: evaluator reads and `structuredClone()` of prepared input.
- Write/delete/overwrite surfaces: evaluator mutation attempts against its
  isolated prepared input.
- Failure/evidence boundaries: preparation failure payload, evaluator failure
  ToolResult, and running-tool finalization.
- Unchanged downstream consumers: raw-data sandbox wrapper, spawn profile subset
  rule, and role-tool map tests.

## Risks / Trade-offs

- Evaluator snapshots are mutable by direct assignment, so mutation attempts no
  longer fail immediately. Mitigation: the execution snapshot is separate, and
  tests lock that the inner tool only sees the original values.
- Budget constants can reject pathological but technically cloneable inputs.
  Mitigation: this boundary is a shared policy gate; safe, bounded inspection is
  preferred over unbounded preparation.

## Context

Issue #51 is a PR #52 invariant-closure follow-up for the shared policy-gate
wrapper. The generic non-spawn path must reject unstable live input, materialize
accepted input once into a stable bounded graph, give honest evaluators cloneable
data with ordinary array read APIs, and keep evaluator mutation away from the
input later supplied to the inner tool.

Fixture level: expanded; repair intensity: high. Project profile: SHUD-Harness.

Expanded-trigger rationale:
- Core triggers: shared wrapper entrypoint, resource-limit behavior, hostile
  input handling, and error/finalization paths.
- Profile triggers: `remediation`, `guard_class`, `Zero`, `ToolBase`, and
  tool registry governance.

## Goals / Non-Goals

Goals:
- Reject generic non-spawn proxies and non-ordinary objects whose discovery cost
  or descriptor stability cannot be bounded.
- Materialize accepted generic non-spawn input once into a stable canonical graph.
- Use separate execution and evaluator snapshots derived from that canonical
  graph for generic non-spawn input.
- Make evaluator snapshots cloneable plain data, with recursive null prototypes
  for plain objects and compatible read APIs for arrays.
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

1. Generic non-spawn input uses a conservative stable-materialization boundary.
   Proxy inputs are rejected before key discovery or descriptor traps are
   reached. Live arrays must have the ordinary `Array.prototype`; array
   subclasses, custom-prototype arrays, and nested variants fail closed before
   evaluator or inner execution. Ordinary arrays reject over-length `length`
   before any index descriptor reads and are accepted only as JSON-style
   numeric-index arrays: preparation reads bounded descriptors for indices
   `0..length-1`, preserves sparse holes where possible, rejects unsafe
   accessors/functions/symbols/bigints in numeric indices, and omits non-index
   own array properties without discovering them. For ordinary plain objects,
   JavaScript cannot count keys without
   enumerating them, so the object key budget is checked after
   `Reflect.ownKeys()` and before per-key descriptor/value reads. Accessors,
   functions, symbols, bigint values, symbol keys, excessive depth, excessive
   node count, excessive array length, excessive object key count, excessive
   string budget, non-ordinary non-array prototypes, non-ordinary array
   prototypes, or prototype-polluting keys on ordinary object properties fail
   closed as preparation errors.

2. Generic non-spawn input uses one canonical materialization plus derived
   snapshots. The wrapper materializes the accepted live input once into a
   stable inert structured-data graph. It then creates one execution snapshot
   for the inner tool and one evaluator snapshot for policy evaluation from
   that canonical graph, so evaluator and execution preparation never reread a
   live proxy/accessor source differently. Execution snapshots preserve the
   previous structuredClone-like shape: plain objects are ordinary `{}` objects
   with `Object.prototype`, nested plain objects keep ordinary object
   compatibility, and arrays are normal arrays. Evaluator snapshots use
   null-prototype plain objects recursively, make those plain objects
   non-extensible after existing properties are installed, and preserve the
   explicitly supported array read/mutation APIs (`for...of`, spread,
   `.includes()`, `.map()`, direct numeric indexing, and `push`) through
   isolated array prototypes with no functional `constructor`, null-prototype
   frozen exposed methods/iterators, and `.map()` results that are
   evaluator-isolated arrays rather than ordinary `Array.prototype` arrays.

3. Evaluator mutation is isolated by snapshot separation.
   Direct top-level or nested evaluator mutation may succeed on the evaluator
   snapshot, but the inner tool receives the original execution snapshot.
   Honest evaluators can `structuredClone(call.input)`, read array fields with
   direct numeric indexing, iterate and spread them, call `.includes()` /
   `.map()`, and use `push` on the evaluator-local array before returning allow.
   Existing top-level/nested fields remain writable for evaluator-local
   assignment; adding new properties to evaluator plain objects is outside the
   supported contract because those objects are non-extensible. Isolated array
   prototype containers, isolated method functions, iterator objects, and
   iterator `next` functions are frozen or non-extensible after their desired
   prototypes are set. Evaluator arrays remain extensible so `push` and direct
   element writes work; if evaluator code reparents such an evaluator-local
   array or a `.map()` result to a global prototype, the wrapper restores
   input-derived intrinsic residue on `Object.prototype`, `Array.prototype`,
   `Function.prototype`, global array method functions, constructors, and array
   iterator prototypes before inner execution continues. Prototype mutation
   attempts through `Object.setPrototypeOf(call.input, ...)`,
   `Object.setPrototypeOf(call.input.nested, ...)`,
   `Object.setPrototypeOf(values, Array.prototype)`,
   `Object.setPrototypeOf(Object.getPrototypeOf(values), Array.prototype)`,
   `Object.setPrototypeOf(Object.getPrototypeOf(values).map, Function.prototype)`,
   `Object.getPrototypeOf(values.constructor)`,
   `Object.getPrototypeOf(values.map(...))`, or a directly accessed iterator
   therefore cannot mutate execution input or leave cross-call/global residue.

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
- Governing invariant: Generic non-spawn policy-gate preparation must
  materialize untrusted input into one stable bounded source of truth, derive
  evaluator/execution inputs from that source without rereading live input,
  preserve cloneable honest-evaluator read semantics, and must not let evaluator
  mutation change the input that the inner tool executes.
- Source-of-truth identity/contract: issue #51 acceptance criteria,
  `PolicyGatedBaseToolAdapter.preparePolicyGateInput()`, and existing
  `policy_gate_input_preparation_failed` / evaluator-failure ToolResult shapes.
- Producers: non-spawn tool callers and custom policy evaluators.
- Validators/preflight: proxy/non-ordinary rejection, generic preparation budget
  checks, canonical materialization, and bounded snapshot cloning.
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
  - Proxy or hostile key-discovery input -> preparation fails closed before
    evaluator and inner tool execution, without trap text or trap calls.
  - Over-length ordinary arrays -> cheap length rejection happens before array
    own-key discovery or numeric index descriptor reads.
  - Non-ordinary non-array inputs -> class instances, `Date`, `Map`, and
    custom-prototype objects fail closed before evaluator and inner execution.
  - Non-ordinary arrays -> array subclasses and custom-prototype arrays fail
    closed at top level and when nested in ordinary objects.
  - Low-length ordinary arrays with over-budget or unsafe non-index own
    properties -> preparation does not call array `Reflect.ownKeys()`, omits
    those properties from evaluator/execution snapshots, and still materializes
    safe numeric indices.
  - Over-wide ordinary objects -> key-count rejection happens after ordinary
    own-key enumeration and before per-key descriptor/value reads.
  - Execution compatibility -> inner tools receive ordinary plain-object
    execution snapshots where `input.hasOwnProperty(...)` works and
    `input instanceof Object` is true, while evaluator plain objects remain
    null-prototype and non-extensible.
  - Evaluator mutates top-level or nested non-spawn input -> inner tool still
    receives the original execution snapshot.
  - Honest evaluator snapshots valid non-spawn input with `structuredClone` and
    reads array fields via direct numeric indexing, `for...of`, spread,
    `.includes()`, `.map()`, and evaluator-local `push` -> reads succeed, map
    results stay evaluator-isolated, and inner tool receives the expected
    execution snapshot.
  - Evaluator prototype mutation probes through direct object reparenting,
    array instance reparenting, isolated array prototype containers, array
    constructor, array methods, map-result arrays/prototypes/functions, and
    iterator objects/functions -> no `Object.prototype`, `Function.prototype`,
    or `Array.prototype` residue and inner execution input remains unchanged.
  - Cross-call residue -> writing custom properties to evaluator-visible
    prototypes, methods, iterator objects, iterator functions, and map-result
    paths in one evaluator call is not observable by the next evaluator call.
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

- Evaluator snapshots allow direct assignment to existing fields and evaluator
  arrays remain extensible so `push` keeps working. Mitigation: the execution
  snapshot is separate, evaluator plain objects are non-extensible to block
  reparenting/new-property residue, isolated prototypes/functions/iterators are
  frozen, and tests lock that the inner tool only sees the original values.
- Evaluator array instances cannot be made non-extensible without breaking
  supported `push`. Mitigation: array instance reparenting is evaluator-local,
  and the non-spawn wrapper restores input-derived intrinsic residue before
  continuing to inner execution.
- Budget constants can reject pathological but technically cloneable inputs.
  Mitigation: this boundary is a shared policy gate; safe, bounded preparation
  is preferred over unbounded execution.
- Ordinary object own-key enumeration itself cannot be pre-budgeted with native
  JavaScript reflection. Mitigation: proxy-shaped inputs are rejected before key
  discovery, and the contract only claims ordinary object rejection after
  own-key enumeration and before per-key descriptor/value reads.

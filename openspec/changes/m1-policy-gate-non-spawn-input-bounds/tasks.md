## 1. Preparation Contract

- [x] 1.1 Add generic non-spawn preparation budgets and proxy/non-ordinary
  fail-closed checks before live key discovery or evaluator execution.
- [x] 1.2 Change generic non-spawn preparation to create separate execution and
  evaluator snapshots from one canonical materialized graph, using cloneable
  plain data, ordinary plain objects for execution snapshots, recursive
  null-prototype non-extensible plain objects for evaluator snapshots, and
  JSON-style numeric-index array materialization plus frozen evaluator array
  prototypes/functions/iterators that preserve supported APIs without shared
  global prototype mutation paths.
- [x] 1.3 Preserve existing preparation failure payloads, evaluator failure
  behavior, and running-tool metadata finalization.
- [x] 1.4 Audit and preserve the `spawn_agent` preparation path unchanged.
- [x] 1.5 Reject live non-ordinary generic arrays, including array subclasses
  and custom-prototype arrays at top level or nested under ordinary objects,
  while leaving materialized canonical arrays and execution arrays ordinary.
- [x] 1.6 Harden evaluator-visible graph after setup: evaluator plain objects
  are non-extensible, isolated array prototype containers and exposed method /
  iterator functions are frozen or non-extensible, and non-spawn evaluator
  execution restores input-derived intrinsic residue after evaluator-local
  array reparent attempts.

## 2. Regression Tests

- [x] 2.1 Add tests for oversized and deeply nested non-spawn inputs failing
  closed before evaluator and inner tool execution.
  - Inputs: object depth = generic max depth + 1; array length = generic max
    array length + 1; object key count = generic max key count + 1; total
    string budget = generic max string budget + 1.
  - Ordering evidence: proxy inputs fail before key/descriptor traps;
    over-length dense arrays fail before array own-key discovery or numeric
    index descriptor reads; over-wide ordinary objects fail after own-key
    enumeration and before per-key value reads.
  - Follow-up 3 ordering evidence: an over-length ordinary array with patched
    `Reflect.ownKeys` and array numeric `Reflect.getOwnPropertyDescriptor`
    fails with array own-key calls = 0, numeric descriptor reads = 0,
    evaluator calls = 0, and inner tool calls = 0.
  - Expected: result contains `policy_gate_input_preparation_failed`, evaluator
    calls = 0, inner tool calls = 0, running handle finished with failed summary.
- [x] 2.2 Add tests that evaluator top-level and nested mutation attempts cannot
  affect inner tool execution.
  - Inputs: `{ command: "original", nested: { flag: "original" } }`.
  - Mutations attempted by evaluator: `input.command = "mutated"` and
    `input.nested.flag = "mutated"`.
  - Expected: evaluator returns allow and the inner tool receives
    `command="original"` and `nested.flag="original"`.
- [x] 2.3 Keep hostile accessor/proxy/prototype-pollution and unsafe value
  preparation tests green.
  - Inputs: accessor-backed field, proxy-hostile own-key trap, function value,
    symbol value, bigint value, symbol key, own `__proto__` data key,
    `constructor` key, and `prototype` key.
- [x] 2.4 Add tests that honest evaluators can `structuredClone(call.input)`,
  use direct numeric indexing, iterate and spread evaluator array fields, call
  `.includes()` / `.map()`, use `push`, receive evaluator-isolated `.map()`
  results, and cannot mutate inner execution or global prototypes through direct
  object reparenting, array reparenting, array constructor, method,
  map-result, or iterator paths.
- [x] 2.5 Add tests that low-length ordinary arrays with over-budget non-index
  own properties do not trigger array `Reflect.ownKeys()`, do not read non-index
  descriptors, preserve sparse numeric-index holes, and omit non-index
  function/symbol/bigint/prototype-polluting properties from evaluator and
  execution snapshots.
- [x] 2.6 Add or preserve tests proving representative `spawn_agent` paths remain
  unchanged.
  - Valid input: `role="worker"`, `tools=["read"]`, non-empty instruction ->
    allow path preserves normalized execution input.
  - Invalid input: `role="worker"`, `tools=["read","edit"]` -> deny before spawn
    with `ruleId=spawn-profile-subset`, `guard_class=authority`, and
    `remediation.next_action=adjust_scope`.
- [x] 2.7 Add tests that non-ordinary non-array inputs fail closed before
  evaluator and inner execution.
  - Inputs: class instance, `Date`, `Map`, and custom-prototype object.
- [x] 2.8 Add tests that non-ordinary arrays fail closed before evaluator and
  inner execution.
  - Inputs: array subclass and custom-prototype array at top level; array
    subclass and custom-prototype array nested in an ordinary object.
- [x] 2.9 Add tests that execution snapshots preserve ordinary plain-object
  compatibility while evaluator snapshots remain null-prototype and hardened.
  - Expected: inner execution input supports `input.hasOwnProperty(...)`,
    `input instanceof Object`, ordinary nested object prototypes, and normal
    `Array.prototype` arrays; evaluator top/nested objects are null-prototype
    and non-extensible.
- [x] 2.10 Add tests that evaluator-visible graph hardening and residue cleanup
  cover direct `Object.setPrototypeOf()` probes against top object, nested
  object, evaluator arrays, isolated array prototype, isolated method function,
  iterator object, iterator next function, map result array/prototype/function
  paths, and global prototype residue.
- [x] 2.11 Add a cross-call residue test proving custom properties written to
  evaluator-visible prototypes, exposed methods, iterators, iterator functions,
  and map-result paths in one evaluator call are not observable by the next
  evaluator call.

## 3. Risk Pack Evidence Matrix

- [x] 3.1 Public API / CLI / script entry: wrapped non-spawn `run()` tests cover
  the public entrypoint result shape for allow, preparation failure, and
  evaluator failure.
- [x] 3.2 Auth / permissions / secrets: representative valid and invalid
  `spawn_agent` profile tests preserve issue #20 authority semantics and
  `guard_class=authority`.
- [x] 3.3 Concurrency / shared state / ordering: evaluator mutation tests prove
  evaluator code cannot mutate the execution snapshot observed by the inner
  tool, and evaluator-visible method/prototype residue cannot persist across
  calls.
- [x] 3.4 Resource limits / large input / discovery: depth, array-length, and
  string-budget tests fail closed before evaluator execution; proxy tests prove
  key/descriptor traps are not reached; ordinary object tests prove over-wide
  inputs fail before per-key value reads; ordinary over-length array tests
  prove length rejection happens before array key discovery and numeric
  descriptor reads.
- [x] 3.4a Non-ordinary live input boundary: class/Date/Map/custom-prototype
  non-array inputs and array subclass/custom-prototype inputs fail closed before
  evaluator and inner execution.
- [x] 3.4b Execution/evaluator snapshot compatibility: execution snapshots keep
  ordinary structuredClone-like object compatibility, while evaluator snapshots
  keep null-prototype hardened plain objects and isolated arrays.
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

## Why

PR #52 follow-up review found that generic non-spawn policy-gate input
preparation still had three invariant gaps: it read live input separately for
execution and evaluator snapshots, narrowed evaluator arrays enough to break
ordinary read APIs, and overclaimed key-discovery bounds for proxy-shaped or
otherwise unstable inputs.

## What Changes

- Add an explicit bounded preparation contract for generic non-spawn tool input.
- Materialize generic non-spawn input once into a stable canonical structured
  graph, then derive separate execution and evaluator snapshots from that
  canonical source without rereading live input.
- Reject proxy/non-ordinary live inputs whose discovery or stability cannot be
  bounded; for ordinary objects, check the key budget after own-key enumeration
  and before per-key descriptor/value reads.
- Give plain object snapshots null prototypes recursively so evaluator
  `Object.prototype` / inherited `constructor` mutation paths cannot affect the
  inner execution input.
- Preserve evaluator array read compatibility (`for...of`, spread, `.includes()`,
  `.map()`) through isolated array prototypes that do not mutate global
  `Array.prototype`.
- Preserve fail-closed preparation errors, running metadata finalization, and
  the existing spawn_agent authority snapshot path.
- Add regression tests for bounded-input rejection, hostile preparation
  failures, evaluator/inner-tool isolation, structured-clone evaluator reads,
  and unchanged spawn behavior.

## Capabilities

### New Capabilities

- `policy-gate-non-spawn-input-bounds`: Bounded, isolated generic non-spawn
  policy-gate input preparation.

### Modified Capabilities

- None. This is a bug-fix fixture for M1 policy-gate implementation behavior;
  no archived baseline spec currently exists under `openspec/specs/`.

## Impact

- Affected code: `packages/core/src/tools/policy-gate-registry.ts`.
- Affected tests: `packages/core/src/tools/policy-gate-registry.test.ts`.
- No runtime dependency changes, no Zero source edits, and no change to
  `spawn_agent` profile authority semantics.

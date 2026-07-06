## Why

PR #52 follow-up review found that generic non-spawn policy-gate input
preparation still had invariant gaps around array-shaped input: arrays with
bounded `length` could still force unbounded own-key discovery through
non-index properties, and evaluator-visible array prototypes exposed global
`Function.prototype` / `Array.prototype` mutation paths.

## What Changes

- Add an explicit bounded preparation contract for generic non-spawn tool input.
- Materialize generic non-spawn input once into a stable canonical structured
  graph, then derive separate execution and evaluator snapshots from that
  canonical source without rereading live input.
- Reject proxy/non-ordinary live inputs whose discovery or stability cannot be
  bounded; for ordinary objects, check the key budget after own-key enumeration
  and before per-key descriptor/value reads.
- Treat accepted generic non-spawn arrays as JSON-style numeric-index arrays:
  only indices `0..length-1` are materialized, non-index own array properties
  are outside the contract and omitted without discovery, and sparse holes are
  preserved where possible.
- Reject live non-spawn arrays whose prototype is not the ordinary
  `Array.prototype`, including array subclasses and custom-prototype arrays.
- Preserve execution snapshots as structuredClone-like ordinary plain objects
  and normal arrays, while keeping evaluator plain objects null-prototype and
  hardened.
- Preserve evaluator array read compatibility (`for...of`, spread, `.includes()`,
  and `.map()`) through frozen isolated array prototypes,
  null-prototype frozen exposed methods/iterators, evaluator-local arrays, and
  `.map()` results that do not expose global `Array.prototype`.
- Prevent input-derived global `Object.prototype` / `Array.prototype` /
  `Function.prototype` residue by making evaluator arrays and `.map()` results
  non-extensible rather than attempting same-realm global intrinsic repair.
- Preserve fail-closed preparation errors, running metadata finalization, and
  the existing spawn_agent authority snapshot path.
- Add regression tests for bounded-input rejection, hostile preparation
  failures, non-ordinary live input rejection, evaluator/inner-tool isolation,
  execution plain-object compatibility, evaluator graph hardening,
  cross-call residue isolation, structured-clone evaluator reads, and unchanged
  spawn behavior.

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

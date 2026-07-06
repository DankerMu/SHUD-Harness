## Why

PR #52 follow-up review found that generic non-spawn policy-gate input
preparation still had three invariant gaps: it materialized descriptors before
cheap budget rejection, exposed evaluator input through a non-cloneable Proxy
view, and let evaluator prototype paths reach shared prototypes before inner
tool execution.

## What Changes

- Add an explicit bounded preparation contract for generic non-spawn tool input.
- Prepare generic non-spawn execution and evaluator inputs as separate
  cloneable plain-data snapshots after descriptor-safe budget inspection.
- Give plain object snapshots null prototypes recursively so evaluator
  `Object.prototype` / inherited `constructor` mutation paths cannot affect the
  inner execution input.
- Preserve fail-closed preparation errors, running metadata finalization, and
  the existing spawn_agent authority snapshot path.
- Add regression tests for cheap budget rejection, hostile preparation
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

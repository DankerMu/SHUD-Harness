## Why

PR #50 follow-up review found that generic non-spawn policy-gate input
preparation snapshots tool input twice before the evaluator can deny. Large or
deep tool inputs can therefore create avoidable CPU and memory pressure inside
the shared policy-gate wrapper.

## What Changes

- Add an explicit bounded preparation contract for generic non-spawn tool input.
- Prepare non-spawn execution input from a single trusted snapshot while giving
  the evaluator a mutation-blocking view so evaluator code cannot affect inner
  tool execution.
- Preserve fail-closed preparation errors, running metadata finalization, and
  the existing spawn_agent authority snapshot path.
- Add regression tests for oversized/deep non-spawn input, hostile preparation
  failures, evaluator/inner-tool isolation, and unchanged spawn behavior.

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

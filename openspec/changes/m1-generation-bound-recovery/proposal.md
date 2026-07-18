## Why

Issue #79 identifies two recovery writers that decide from generation A but later mutate through a fresh-baseline writer. A completed generation B installed in that window can therefore be adopted and overwritten. The abandoned PR #104 mixed this invariant with an independent settlement redesign; this child reimplements only generation-bound recovery from the accepted `main` baseline.

## What Changes

- Bind the plain failed-recovery writer and `recoverCompletedRecordAfterRollbackFailure` to the exact record generation that justified the transition.
- Preserve and reclassify a newer completed, mismatched, malformed, or otherwise superseding generation instead of mutating it.
- Add public-service race regressions and compatibility rows without changing schemas, routes, or record-store publication primitives.

## Capabilities

### New Capabilities

- `generation-bound-recovery`: recovery transitions replace only their deciding idempotency-record generation.

### Modified Capabilities

- None.

## Impact

- Primary code: `packages/core/src/domain/services/idempotency-service.ts`.
- Tests: `packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts`.
- The existing `workspace-record-store.ts` observation/exact-replacement API is consumed unchanged unless fixture review proves a missing contract.
- No public schema, HTTP envelope, dependency, submodule, or persisted-format change.

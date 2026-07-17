## Why

Issue #79 records three verified residual gaps from #74: two recovery writers can adopt a fresh baseline after their deciding read and overwrite a newer completed idempotency generation, while one completed-consumption defensive exit and its comments do not match the promised resource-settlement contract. These are currently narrow or unreachable under the single-user MVP, but they sit on the shared completion authority and become higher severity as soon as recovery orchestration gains a production caller.

## What Changes

- Bind every failed/completed recovery write to the exact generation that justified the transition, or hold the existing transition guard through the write.
- Preserve a completed generation that appears after the recovery decision; never adopt it as a mutable baseline and overwrite it.
- Add deterministic red-first regressions for the plain failed-write replacement window and `recoverCompletedRecordAfterRollbackFailure` check-then-act window.
- Settle transported completed-consumption resources on every throw-after-fulfilled exit and correct the three-window contract comments.
- Document the workspace-record observation seam's intentional committed-then-throw behavior.

## Capabilities

### New Capabilities

- `completed-record-recovery`: generation-bound recovery transitions and complete settlement/documentation for completed-record authority.

### Modified Capabilities

- None. This follow-up tightens the already accepted #74 idempotency invariant without changing public record shapes or HTTP contracts.

## Impact

- Primary code: `packages/core/src/domain/services/idempotency-service.ts`.
- Regression and structural pin tests: `packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts`.
- Observation-seam documentation only if needed: `packages/core/src/domain/services/workspace-record-store.ts`.
- No schema, route, dependency, submodule, or persisted-format change.

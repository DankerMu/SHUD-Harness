## Why

Transition guard and cleanup-lock deletion can fail after the store has already moved the exact physical generation A from its public pathname into a store-owned private namespace. Restoring A to the public pathname and then isolating it a second time makes correctness depend on reconstructing pathname history. Review and diagnosis proved that asynchronous watchers, fixed waits, and raw error-graph normalization cannot supply that authority or preserve caller-owned failure provenance. Issue #108 therefore retains the first private ownership and represents failures in an operation-owned occurrence ledger.

## What Changes

- Add an opt-in store-owned total deletion mode that captures a one-consumer private-generation ticket immediately after the first successful isolation and exact private proof.
- On post-isolation failure, settle only private A against the ticket and pinned descriptor. The public pathname is observation-only: missing and every successor B are preserved while successful settlement reports recovered/deleted.
- Move transition guard and cleanup-lock failure recovery to this store-owned mode and remove fresh-observation plus field-equality deletion authority.
- Capture exact phase-tagged failure occurrences in an immutable sidecar ledger without rewriting, cloning, pruning, or trusting caller-owned `cause/errors/semanticPrimary` graphs. Preserve exact typed roots and expose typed compatibility as a trusted ledger view.
- When private settlement succeeds, return recovered/deleted and do not throw the recovered initial failure. Only when settlement or final authority release still fails, preserve the exact original post-mutation value as semantic primary, append each distinct later occurrence in phase order, and close the retained permit/FD/binding exactly once.
- Keep existing conditional-delete semantics as the default for all unchanged callers.

## Capabilities

### New Capabilities

- `transition-artifact-exact-settlement`: Exact physical-generation failure settlement for transition guard and cleanup-lock deletion.

### Modified Capabilities

- None.

## Impact

- Shared occurrence-ledger and typed compatibility primitives in `packages/core/src/domain/services/compensation-error-preservation.ts` and `task-service-error-compensation.ts`.
- Additive internal API/option in `packages/core/src/domain/services/workspace-record-store.ts`.
- Transition-artifact consumers in `packages/core/src/domain/services/idempotency-service.ts`.
- Store/service regression coverage in `packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts`.
- Backend serialization consumes the trusted typed ledger view without changing the public HTTP contract.
- No persisted schema, dependency, submodule, or `zero/` change.

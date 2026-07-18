## Why

Transition guard and cleanup-lock deletion can fail after mutation while the store restores the exact physical generation A. The one-shot cleanup permit is then terminal, so service-layer re-observation either adopts a same-field/new-inode successor B or converts an already fulfilled recovery into a false failure. Issue #108 is the prerequisite that lets PR #106 close this authority gap without inferring physical ownership in the service.

## What Changes

- Add an opt-in store-owned total deletion mode that, before terminal permit settlement, performs at most one exact-A failure settlement after a post-mutation delete failure.
- Preserve missing or superseded successors without granting deletion authority over them; a successful initial delete never performs a second settlement.
- Move transition guard and cleanup-lock failure recovery to this store-owned mode and remove fresh-observation plus field-equality deletion authority.
- When exact settlement succeeds, return a recovered outcome and do not throw the recovered initial failure. Only when settlement or final authority release still fails, preserve the original post-mutation failure as semantic primary, append each distinct later failure in occurrence order, and close the retained permit/FD/binding exactly once.
- Keep existing conditional-delete semantics as the default for all unchanged callers.

## Capabilities

### New Capabilities

- `transition-artifact-exact-settlement`: Exact physical-generation failure settlement for transition guard and cleanup-lock deletion.

### Modified Capabilities

- None.

## Impact

- Additive internal API/option in `packages/core/src/domain/services/workspace-record-store.ts`.
- Transition-artifact consumers in `packages/core/src/domain/services/idempotency-service.ts`.
- Store/service regression coverage in `packages/core/src/domain/services/idempotency-lock-artifact-services.test.ts`.
- No persisted schema, backend route, public HTTP contract, dependency, submodule, or `zero/` change.

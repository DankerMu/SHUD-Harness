## Why

Phase 1 needs deterministic filesystem state before APIs and UI can rely on persisted tasks. Workspace initialization, ID allocation, and snapshot persistence are the minimal runtime substrate for recoverable task state.

## What Changes

- Add workspace initialization that creates the Phase 1 runtime directory tree.
- Add deterministic ID allocation for TaskCard and related Phase 1 records.
- Add task snapshot read/write behavior with atomic writes.
- Add filesystem path safety checks for workspace-owned paths.
- Add snapshot tests covering create, read, reload, and malformed state.

## Capabilities

### New Capabilities

- `workspace-snapshot`: Provides workspace initialization, ID allocation, and task snapshot persistence for Phase 1.

### Modified Capabilities

None.

## Upstream References

| Document | Use | Boundary |
|---|---|---|
| `docs/Phased_Spec_Activation.md` | Normative Phase 1 activation for workspace directory, task snapshot, and refresh recovery. | Does not activate Phase 2 service restart recovery or RunJob recovery. |
| `docs/03_SPEC/Workspace_Conventions.md` | Normative path model, source submodule vs runtime workspace separation, and path safety expectations. | Implement Phase 1 workspace/task paths only; run/artifact deep lifecycle can remain skeletal. |
| `docs/03_SPEC/Data_Storage_Provenance.md` | Reference for storage layering and provenance constraints. | DataProvenance registration is not implemented here; only avoid blocking its future storage paths. |
| `docs/03_SPEC/Workspace_Snapshot_And_Recovery_Spec.md` | Phase 1 subset reference for task snapshot read/write and browser refresh recovery. | Service restart replay and WebSocket gap recovery are Phase 2+ and out of scope. |
| `docs/03_SPEC/Idempotency_Concurrency_Locking_Spec.md` | Phase 1 subset reference for lock/idempotency file placement. | Full lock ownership, expiry, and recovery semantics are out of scope. |

## Impact

- Affected paths: workspace service code, snapshot service code, filesystem utilities, tests.
- Depends on `phase1-monorepo-foundation` and `phase1-core-schemas`.
- Enables task API persistence and frontend refresh recovery.

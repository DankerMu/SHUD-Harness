## Why

Phase 1 needs stable shared contracts before API, workspace persistence, and UI components can safely exchange data. The docs define canonical fields, but implementation needs Zod schemas and tests as the future source of truth.

## What Changes

- Add Phase 1 Zod schemas for TaskCard, Artifact, ErrorRecord, IdempotencyRecord, and LockRecord.
- Export inferred TypeScript types for frontend and backend use.
- Add valid and invalid schema fixtures.
- Add schema unit tests covering required fields, enum values, timestamps, and rejected malformed payloads.
- Prepare schema generation hooks without requiring full generated docs in this changeset.

## Capabilities

### New Capabilities

- `core-schemas`: Defines the initial shared Zod schemas and type exports required by Phase 1.

### Modified Capabilities

None.

## Upstream References

| Document | Use | Boundary |
|---|---|---|
| `docs/Phased_Spec_Activation.md` | Normative Phase 1 activation for shared schema work: TaskCard, Artifact, ErrorRecord, idempotency, and lock skeletons. | Only Phase 1 schema subset is implemented. Full v0.8 schema surface is out of scope. |
| `docs/00_INDEX/CANONICAL_CONTRACTS.md` | Normative source-of-truth order for schemas and generated docs. | Zod becomes highest source only after implementation exists. |
| `docs/03_SPEC/Minimal_Schemas.md` | Normative field source for TaskCard and core object references used in Phase 1. | Implement TaskCard now; other core schemas can remain out of scope unless needed by Phase 1 tests. |
| `docs/03_SPEC/Support_Schema_Contracts.md` | Normative field source for Artifact, ErrorRecord, IdempotencyRecord, and LockRecord. | Implement only the support schema subset needed by Phase 1. |
| `docs/02_ARCHITECTURE/Control_Kernel.md` | Normative state-machine context for TaskCard status and `runtime_phase`. | Runtime execution transitions are not implemented in this changeset. |
| `docs/04_IMPLEMENTATION/Schema_Generation_And_Drift_Control.md` | Reference-only future schema generation and drift-control policy. | No full generator is required in this changeset; quality gates may add placeholders later. |

## Impact

- Affected paths: `packages/core/src/domain/schemas/*`, `packages/core/src/domain/index.ts`, schema tests.
- Depends on `phase1-monorepo-foundation`.
- Enables workspace snapshot, task API, and frontend API client changes.

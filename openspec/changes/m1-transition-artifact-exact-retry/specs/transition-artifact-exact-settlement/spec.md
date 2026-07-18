## ADDED Requirements

### Requirement: Store-owned exact failure settlement

The store SHALL offer an explicit opt-in transition-artifact deletion operation that retains the original cleanup-permit generation authority through at most one post-mutation failure settlement and SHALL NOT authorize deletion from a fresh semantic observation.

#### Scenario: Restored exact generation is settled
- **WHEN** deletion of physical generation A fails after mutation and compensation restores the exact A
- **THEN** the store deletes A once before terminal permit release, returns a recovered/deleted outcome, and does not fail a fulfilled service operation

#### Scenario: Successor generation is preserved
- **WHEN** the pathname is missing or contains a different-field or same-field/new-inode generation B before failure settlement
- **THEN** the store returns recovered/missing or recovered/superseded, preserves B byte-for-byte and by physical identity, and does not propagate the recovered initial failure

#### Scenario: Initial success is terminal
- **WHEN** the initial deletion returns a terminal result without throwing
- **THEN** the store performs no second settlement or fresh deletion attempt

### Requirement: Ordered total failure and resource settlement

When recovery cannot complete, the store SHALL keep the initial post-mutation failure as semantic primary, SHALL append each distinct settlement/release failure once in occurrence order, and SHALL settle every permit, descriptor, capacity slot, authority mutex, and parent binding exactly once. A successfully recovered operation SHALL return a recovered outcome rather than throw that initial failure.

#### Scenario: Exact settlement also fails
- **WHEN** both the initial deletion and its one exact failure-settlement attempt fail
- **THEN** the initial failure remains primary, the settlement failure is one ordered compensation, and all retained resources return to baseline

#### Scenario: Final authority release fails after recovery
- **WHEN** post-mutation settlement converges but final lease or descriptor release fails
- **THEN** the initial post-mutation failure becomes primary and the distinct release failure follows once as compensation

#### Scenario: Permit cannot be reused
- **WHEN** a caller attempts a second terminal operation after the total operation completes
- **THEN** the store rejects or classifies it using the existing terminal permit contract without reacquiring authority over the current pathname

### Requirement: Transition artifact consumers preserve compatibility

Transition guard and cleanup-lock consumers SHALL use the store-owned exact failure settlement, SHALL remove fresh field-equality deletion recovery, and SHALL preserve existing record, replay, legacy artifact, and public error contracts.

#### Scenario: Guard and cleanup-lock races
- **WHEN** public idempotency service paths encounter restored A, missing, different-field B, or same-field/new-inode B during guard or cleanup-lock release/consumption
- **THEN** only exact A may be deleted, B remains unchanged, durable record/replay behavior is preserved, and resource diagnostics return to baseline

#### Scenario: Existing branch-only retry is removed after prerequisite merge
- **WHEN** PR #106 rebases onto this capability
- **THEN** its fresh-observation and unconditional second-settlement helpers are removed and its recovery paths consume the shared store-owned result contract

#### Scenario: Default callers remain unchanged
- **WHEN** a generic conditional-delete caller does not opt into exact failure settlement
- **THEN** its existing post-mutation restoration, error, and terminal-permit behavior remains unchanged

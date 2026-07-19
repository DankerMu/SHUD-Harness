## ADDED Requirements

### Requirement: Store-owned exact failure settlement

The store SHALL offer an explicit opt-in transition-artifact deletion operation that captures a store-private, one-consumer settlement ticket immediately after the first successful public-to-private rename and exact private proof. Post-isolation settlement SHALL prove and remove only that private generation against the ticket and pinned descriptor and SHALL NOT restore, re-isolate, or destructively act on the public pathname.

#### Scenario: First privately isolated generation is settled
- **WHEN** deletion of physical generation A fails after the first isolation and exact private proof
- **THEN** the store hands off the private ticket, deletes only private A once before terminal permit release, returns recovered/deleted, and does not restore or re-isolate public A

#### Scenario: Public state is observation-only
- **WHEN** the public pathname is missing, contains different-field B, contains same-field/new-inode B, or undergoes ancestor ABA after ticket capture
- **THEN** private A settlement returns recovered/deleted, preserves the public state byte-for-byte and by physical identity, registers no watcher, and waits for no event delivery

#### Scenario: Private authority drift fails closed
- **WHEN** private A is missing while the pinned descriptor has positive link count, is replaced, has link-count drift, the namespace drifts, or private unlink/namespace cleanup fails
- **THEN** the store returns a typed failure, does not classify the condition as missing or superseded, and does not touch the public pathname

#### Scenario: Initial success is terminal
- **WHEN** the initial deletion returns a terminal result without throwing
- **THEN** the store performs no second settlement or fresh deletion attempt

### Requirement: Ordered total failure and resource settlement

When recovery cannot complete, the store SHALL retain exact phase-tagged failures in an operation-owned immutable occurrence ledger. The exact initial value SHALL remain semantic primary; each distinct later object identity SHALL appear once in the ordered-distinct view while raw caller aliases/edges and repeated event slots remain unchanged. Every permit, descriptor, capacity slot, authority mutex, binding, private unlink, and namespace cleanup SHALL settle exactly once through a shared promise.

#### Scenario: Exact settlement also fails
- **WHEN** both the initial deletion and its one exact failure-settlement attempt fail
- **THEN** the exact initial value remains primary, the settlement failure is one later ledger occurrence, and all retained resources return to baseline

#### Scenario: Final authority release fails after recovery
- **WHEN** post-mutation settlement converges but final lease or descriptor release fails
- **THEN** the initial post-mutation failure becomes primary and the distinct release failure follows once as compensation

#### Scenario: Permit cannot be reused
- **WHEN** a caller attempts a second terminal operation after the total operation completes
- **THEN** the store rejects or classifies it using the existing terminal permit contract without reacquiring authority over the current pathname

### Requirement: Failure evidence and typed compatibility are ledger views

Raw caller `cause`, `errors`, and `semanticPrimary` graphs SHALL remain immutable evidence. Each fold SHALL use a fresh observation session, observe each accessor or brand at most once in that fold, and record identity-unique nodes separately from edge and event multiplicity. An Error primary SHALL be returned by exact identity; non-Error values SHALL remain exact in the ledger; typed compatibility SHALL use only trusted exact `TaskServiceError` ledger provenance.

#### Scenario: Exact typed root and aliases are preserved
- **WHEN** a frozen `TaskServiceError` primary or compensation shares aliases or cycles with other failure nodes
- **THEN** the exact typed object and all raw descriptors/edges remain unchanged, the ledger reports one identity node with every raw edge, and backend HTTP serialization retains the typed status/code

#### Scenario: Independent folds are fresh
- **WHEN** the same accessor or Proxy changes between independent folds
- **THEN** each fold observes its current graph at most once and no module-lifetime observation cache supplies stale evidence

#### Scenario: Caller envelope requires explicit adoption
- **WHEN** a caller-created writable, frozen, or nonconfigurable envelope contains a typed-looking inner value
- **THEN** the envelope remains its semantic root unless a trusted store-owned occurrence reference explicitly adopts the inner exact value

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

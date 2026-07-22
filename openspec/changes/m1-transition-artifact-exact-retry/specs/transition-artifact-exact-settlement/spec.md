## ADDED Requirements

### Requirement: Store-owned private exact settlement

The store SHALL provide an opt-in conditional-delete operation that captures the first exactly isolated private generation and settles only that generation after a post-isolation failure.

#### Scenario: Private A is recovered
- **WHEN** deletion fails after exact public-to-private isolation
- **THEN** the store deletes private A, returns recovered/deleted, and never restores or re-isolates public A

#### Scenario: Public state is observation-only
- **WHEN** public state is missing, successor B, or undergoes ancestor ABA after ticket capture
- **THEN** private A settlement preserves public state and uses no watcher or delayed event

#### Scenario: Initial terminal outcomes do not retry
- **WHEN** the predicate rejects or the initial operation succeeds
- **THEN** the operation returns that terminal result, starts no settlement, and rejects later permit reuse

### Requirement: Settlement authority is monotonic

One private ticket SHALL own one canonical settlement promise. Proof drift SHALL fail the attempt irreversibly; only transient unlink rejection MAY retry.

#### Scenario: Same-ticket concurrency
- **WHEN** two callers request settlement of the same ticket concurrently
- **THEN** both observe the same promise and private unlink executes once

#### Scenario: Transient proof drift is restored externally
- **WHEN** hardlink or namespace-mode drift appears during proof and is later restored
- **THEN** the attempt still fails after one proof attempt and does not retry the proof

### Requirement: Failure phases and resources remain exact

The operation SHALL preserve initial-release, settlement, and final-release failures through the existing public occurrence ledger and SHALL terminally settle every retained resource.

#### Scenario: Action and finalizer reject independently
- **WHEN** the operation action rejects and directory-binding finalization succeeds
- **THEN** the action is not reclassified as final release

#### Scenario: Permit admission and finalizer reject independently
- **WHEN** permit admission rejects before the inner release path and directory-binding finalization independently rejects with any raw value, including `undefined`
- **THEN** the admission action remains semantic primary and the finalizer is appended once as the ordered `final_release` occurrence without public-generation mutation or retained resources

#### Scenario: One value rejects at two physical releases
- **WHEN** one rejection object is thrown by pinned close and directory-binding release
- **THEN** two physical occurrences are recorded while ordered-distinct identity contains the object once

#### Scenario: Private failure matrix
- **WHEN** private unlink, namespace cleanup, pinned close, or binding release fails
- **THEN** phase order is truthful, public B is preserved, and authority, binding, FD, capacity, and mutex diagnostics return to baseline

### Requirement: Transition artifact consumers opt in

Idempotency transition guards and cleanup locks SHALL use private exact settlement while generic conditional-delete callers retain existing behavior.

#### Scenario: Guard release recovers
- **WHEN** an owned guard release fails after exact isolation and private settlement succeeds
- **THEN** the service preserves its fulfilled body result, removes exact A, and does not freshly re-observe public authority

#### Scenario: Benign convergence is explicit
- **WHEN** pre-mutation authority has already converged to missing or successor B
- **THEN** the service accepts only a direct explicit benign-convergence disposition and leaves B unchanged
- **AND** ordinary pre-mutation failures and ledger-carried failures propagate

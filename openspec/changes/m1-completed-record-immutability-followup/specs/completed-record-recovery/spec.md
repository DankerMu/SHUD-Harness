# completed-record-recovery

## ADDED Requirements

### Requirement: Recovery writes are bound to the deciding generation

Every failed/completed recovery mutation SHALL either hold the idempotency transition guard across its decision and commit or replace only the exact record generation captured by the deciding observation. A different generation that appears after the observation MUST NOT be adopted as a fresh mutable baseline.

#### Scenario: Plain failed recovery loses to a completed replacement

- **WHEN** failed-record recovery observes a started generation and a completed generation is installed before its write
- **THEN** the completed generation remains authoritative and byte-for-byte unchanged; for the same digest recovery returns/replays that completed record, while mismatch or invalid-completed replacements retain their existing typed classification

#### Scenario: Completed rollback recovery loses its check-then-act window

- **WHEN** `recoverCompletedRecordAfterRollbackFailure` observes a started generation and another actor completes the record before recovery commits
- **THEN** recovery preserves and returns/replays the completed generation and MUST NOT overwrite its digest, result reference, timestamps, or other bytes; mismatch or invalid-completed replacements retain their existing typed classification

#### Scenario: Uncontended recovery still succeeds

- **WHEN** the observed started generation remains current through the recovery commit
- **THEN** failed or completed recovery publishes the requested terminal transition exactly once and it is replayable through existing lookup APIs

### Requirement: Completed-consumption resources settle on every post-fulfillment error exit

After a completed-consumption body has fulfilled with transported authority, every subsequent error exit SHALL settle the mutation authority and rejected-reason resources exactly once before propagation. The semantic primary error and compensation ordering MUST remain stable.

#### Scenario: Defensive authority-state exit settles resources

- **WHEN** the post-release authority-state validation rejects a fulfilled result
- **THEN** all transported resources settle exactly once before the validation error propagates

#### Scenario: Existing release and refresh failure oracles remain stable

- **WHEN** release or cleanup-permit refresh fails after fulfillment
- **THEN** existing primary-once/compensation behavior and S34-P62-16 evidence remain unchanged

### Requirement: Throw-window and observation-seam documentation is exact

The completed-consumer contract comment SHALL enumerate all three post-fulfillment error windows. The record-store observation seam SHALL document that an injected error after canonical commit is intentionally propagated even though commit succeeded, as a fail-loud tripwire.

#### Scenario: Source contract pins the three windows

- **WHEN** the source-structure contract test inspects the completed-consumer settlement owner and observation seam documentation
- **THEN** it finds the three-window wording, the settlement call for each window, and the committed-then-throw contract without changing record-store runtime semantics

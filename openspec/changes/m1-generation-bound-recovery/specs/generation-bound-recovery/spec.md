## ADDED Requirements

### Requirement: Recovery writes are bound to the deciding generation

Every failed or completed recovery mutation SHALL invoke exact replacement only with the idempotency-record generation captured by its deciding observation. A different generation that appears after observation and before that invocation MUST NOT be adopted as a fresh mutable baseline. Store-internal authority failures after invocation begins are outside this capability and tracked by #107.

#### Scenario: Plain failed recovery loses to a completed replacement

- **WHEN** `lookupReplay` finds a stale fail-intent guard, its recovery path observes started generation A, and completed generation B is installed after that observation but before exact replacement is invoked
- **THEN** B remains authoritative and byte-for-byte unchanged; a same-digest call returns `completed` B, a different digest returns `mismatch`, an invalid completed B returns `invalid_completed`, and every acquired guard/permit/authority is settled

#### Scenario: Completed rollback recovery loses its check-then-act window

- **WHEN** `recoverCompletedRecordAfterRollbackFailure` observes started generation A and completed generation B is installed after that observation but before exact replacement is invoked
- **THEN** recovery preserves and returns B for the same digest, rejects different-digest B with `idempotency_mismatch`, rejects invalid-completed B with `record_malformed`, and never overwrites B's digest, result reference, timestamps, or other bytes

#### Scenario: Uncontended recovery still succeeds

- **WHEN** the observed started generation remains current through the recovery commit
- **THEN** failed or completed recovery publishes the requested terminal transition exactly once and existing lookup APIs replay the same terminal record

#### Scenario: Losing authority preserves error and resource contracts

- **WHEN** the deciding generation is missing, mismatched, malformed, invalid completed, or superseded by a byte-distinct same-digest started/failed generation before exact replacement is invoked
- **THEN** recovery uses the specified public classification/error contract, preserves the replacement bytes, performs no mutation of the replacement, and settles every guard and cleanup permit that belonged to the lost generation exactly once

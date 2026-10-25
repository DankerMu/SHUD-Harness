## ADDED Requirements

### Requirement: Native fixture cleanup failures preserve diagnostic evidence

Default test and CI failure output SHALL retain captured cleanup failures' nested messages, stacks, aggregate members and causes, with known execution pid/pgid and a failure-time process-state snapshot. Unknown identity or unavailable snapshot SHALL be explicit and SHALL NOT replace the underlying error. An earlier test-body or observed pending rejection SHALL remain observable alongside cleanup failure. Successful cleanup after a body failure SHALL preserve the original body error. Diagnostic changes SHALL preserve each surface's existing cleanup order and stop-or-continue behavior, including existing quiescence stopping boundaries.

#### Scenario: Nested cleanup failures reach the default reporter

- **WHEN** native fixture cleanup rejects with nested aggregate members and causes
- **THEN** default reporter output contains each captured inner failure and stack plus process identity/state evidence, without requiring a custom reporter

#### Scenario: Primary and cleanup errors coexist

- **WHEN** the body or pending submission rejects and finally cleanup also fails
- **THEN** both failures are observable rather than only the cleanup failure
- **AND** when cleanup succeeds a body failure remains the same error object

#### Scenario: Diagnostic capture preserves each existing cleanup boundary

- **WHEN** quiescence fails at an existing stopping boundary, including either early stop in the spawn/identity fault test
- **THEN** failure-time diagnostics include captured primary/pending evidence and later cleanup remains unexecuted
- **AND** existing collect-and-continue cleanup surfaces retain their current continuation behavior and order
- **AND** failure to capture ps evidence reports unavailability without suppressing or replacing the original error

#### Scenario: Ordinary cleanup and known root cause remain unchanged

- **WHEN** normal cleanup succeeds or the previously fixed one-shot startup identity fault is exercised
- **THEN** existing cleanup order and assertions are preserved without new diagnostic ps calls on success, production ownership changes or shared-default changes

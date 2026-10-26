## ADDED Requirements

### Requirement: Native recovery tests use coherent clocks and retain failure evidence

Tests that reconcile real submitted processes SHALL use coherent real wall-clock and kernel-time observations during startup, while retaining their existing controlled cadence and deterministic cancellation deadline assertions. A test SHALL NOT manufacture lost-process evidence by freezing wall time while native uptime advances. Failure output for the native reentrant-takeover test SHALL contain the complete harness error collection, durable status, pid, current registration id, cancellation timestamp and takeover registration count. Durable evidence SHALL be captured before cleanup can remove it, with capture phase and unavailable evidence explicit; diagnostics SHALL NOT replace the original failure or change cleanup behavior.

#### Scenario: Slow startup does not falsely lose a live submitted wrapper

- **WHEN** a real submitted wrapper remains alive while startup is delayed past one second
- **THEN** the native test observes one takeover and rejects the reentrant unpublished-identity kill
- **AND** the subsequent published public kill retains the original exact ownership, snapshot,9999/10000ms deadline, signal and result assertions without reinstalling or losing the existing fake cadence registration

#### Scenario: Failure before cleanup retains diagnostic context

- **WHEN** an assertion in the native R3/R5 takeover test fails
- **THEN** default test output contains the original failure and the complete harness errors, fresh pre-cleanup durable fields and takeover count
- **AND** diagnostic capture failure reports unavailable evidence without hiding the original failure or skipping cleanup

#### Scenario: Cleanup failure uses retained evidence

- **WHEN** fixture cleanup fails after the test's durable files have been removed
- **THEN** failure output still includes the labelled pre-cleanup snapshot, takeover count and final harness error collection
- **AND** successful tests emit no failure report and global Date plus timer state are restored

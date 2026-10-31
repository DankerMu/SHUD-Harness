## ADDED Requirements

### Requirement: Same-head CI diagnosis preserves required-check authority

CI aggregate logs SHALL identify the actual event name and action, run identity and attempt, workflow ref/SHA and PR head when applicable using only allowlisted public metadata. Existing seven required dependencies and rejection of failure, cancelled or skipped results SHALL remain unchanged. Operational guidance SHALL distinguish run, suite and check identities, observed required-check output and ordinary merge state; it SHALL preserve contradictory evidence and SHALL NOT assert undocumented service internals as fact. Recovery SHALL use successful execution of the affected suite's complete job graph on the unchanged head, never synthetic success, an empty commit, policy weakening or admin merge.

#### Scenario: Same-head event overlap is observable

- **WHEN** opened and labeled events overlap for one PR head
- **THEN** actual action and run-attempt metadata can be correlated with each run's dependency results, aggregate check and suite
- **AND** cancelled dependencies still fail the aggregate, with no credential or complete event payload in the diagnostic

#### Scenario: Required projection and merge state disagree

- **WHEN** a required-check query reports success but ordinary merge remains blocked with conflicting same-head suites
- **THEN** the operator preserves each suite/check result and authority/head evidence before intervention
- **AND** guidance targets a complete rerun of the affected failed/cancelled suite, followed by unchanged-head required-check and ordinary merge verification
- **AND** unresolved service behavior is reported with reproducible evidence, not bypassed or described as universally fixed

#### Scenario: Green control does not prove a blocked-state fix

- **WHEN** a later successful suite yields an ordinary mergeable state despite an older failed suite
- **THEN** the observation is retained as a control rather than reported as reproduction of the blocked symptom
- **AND** explicit cancellation used in an isolated experiment is distinguished from naturally occurring concurrency cancellation

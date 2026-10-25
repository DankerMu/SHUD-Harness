## ADDED Requirements

### Requirement: PR size exemptions are reevaluated on label changes

For PRs to main, granting or revoking size-exempt SHALL trigger CI reevaluation without a commit or close/reopen. An over-limit PR SHALL pass the size gate only while exempted and SHALL record the bypass. Label events SHALL run all existing required jobs; the sole all-checks-passed gate SHALL fail whenever any required job is failed, cancelled or skipped. Existing opened/synchronize/reopened and push-main triggers SHALL remain active. The cost of rerunning full CI for unrelated labels SHALL be explicitly documented; the threshold and exemption policy SHALL remain unchanged.

#### Scenario: Grant exemption after opening an oversized PR

- **WHEN** size-exempt is added to an oversized PR after it was opened without that label
- **THEN** a new CI run evaluates the same head, logs the bypass and succeeds in both size and aggregate checks when all other jobs succeed

#### Scenario: Revoke exemption without changing the commit

- **WHEN** size-exempt is removed from that same oversized PR
- **THEN** a new CI run fails the size check and required aggregate without needing another commit or reopening the PR

#### Scenario: Required job cannot be skipped into success

- **WHEN** the aggregate receives any required job result of failure, cancelled or skipped
- **THEN** it exits nonzero; only all-success input passes

#### Scenario: Unrelated label changes preserve full-check semantics

- **WHEN** a different label is added or removed
- **THEN** the full job set runs under the documented cost policy, with no label-based skip of the required aggregate

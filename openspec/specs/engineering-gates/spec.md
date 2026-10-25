# engineering-gates Specification

## Purpose
Define executable engineering checks whose success accurately describes the delivered code surfaces covered by the repository's default local and continuous-integration gate.

## Requirements

### Requirement: Root production scripts participate in blocking typecheck

The default typecheck command SHALL compile production TypeScript scripts under scripts with the repository's unchanged strict base compiler settings, in addition to existing package checks. Script compilation SHALL emit no build artifacts and SHALL resolve Node types from an explicit root dependency aligned with the existing package version. This addition SHALL NOT include test/fixture entrypoints or expand the package test typechecking surface.

#### Scenario: Script strict-null error blocks the default gate

- **WHEN** a production script contains a strict nullability violation
- **THEN** the default typecheck command exits nonzero and reports that script's file and location
- **AND** after restoring valid source the default command succeeds

#### Scenario: Frozen dependency installation supports script checks

- **WHEN** dependencies are installed using the committed frozen lockfile
- **THEN** script compiler Node types resolve without sibling-package path overrides, existing package checks still run, and no script JavaScript/declaration build artifacts are emitted

#### Scenario: Test fixtures stay outside the new program

- **WHEN** a TypeScript test or fixture exists under the scripts tree
- **THEN** it is not added as an entrypoint of the production script compiler program and the existing package test exclusions remain unchanged

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

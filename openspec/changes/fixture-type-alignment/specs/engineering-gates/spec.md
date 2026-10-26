## ADDED Requirements

### Requirement: Optional whole-tree compilation aligns fixtures with production types

The existing optional whole-tree TypeScript diagnostic program SHALL compile the delivered fixtures against their unchanged production contracts without errors. Ordinary fixture calls SHALL use the public branded-ID bridge, precise literal types and actual unknown-value narrowing. Deliberately malformed runtime input SHALL remain malformed and its local type bypass SHALL be explicitly documented. This repair SHALL NOT add tests to any blocking compiler gate, shrink lint's analysis scope, change compiler options or weaken runtime assertions.

#### Scenario: Ordinary fixture data respects the existing public contract

- **WHEN** the optional compiler checks policy contexts, job IDs/kinds, matcher inputs and parsed configuration inspection in the repaired fixtures
- **THEN** it exits0 with no type diagnostics using the unchanged program and production declarations
- **AND** branded strings retain their original runtime values and test scenarios/counts remain unchanged

#### Scenario: Hostile fixture input still reaches the rejection boundary

- **WHEN** the deliberate accessor-backed remediation fixture is exercised
- **THEN** the existing rejection and zero-getter-read assertions remain intact
- **AND** a local documented type boundary permits the negative test without a global suppression, arbitrary any cast or production signature widening

#### Scenario: Gate and observation scope remain unchanged

- **WHEN** the repository's default checks and CI execute after the fixture repair
- **THEN** their commands, compiler inclusion/exclusion policy and test discovery remain unchanged
- **AND** the optional all-tree compiler's green result is reported as an executed diagnostic, not a new blocking gate or a fresh measurement of the historical13-error baseline

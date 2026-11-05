# Spec Delta

## ADDED Requirements

### Requirement: Default tests bound independent file-worker contention

The repository's default local and CI test gate SHALL bound independent test-file workers to a documented ceiling of four, recorded in the canonical engineering constraints. It SHALL use at least one worker and otherwise reserve one available CPU for orchestration and native subprocess work, without exceeding that ceiling. This scheduling bound SHALL preserve all discovered tests, existing coverage thresholds and exclusions, the 5000 ms default test deadline, hook deadlines, isolation, and concurrency exercised within individual tests. Native build-evidence tests SHALL continue to execute their published regular executable through the existing direct native path and retain their stdout/stderr, compiler identity, inventory and binary-output assertions. No retry, skip or synthetic success SHALL substitute for a failing gate.

#### Scenario: Default gate limits workers without reducing behavioral evidence

- **WHEN** the default runner configuration is resolved on hosts with one, two, four, fourteen or sixty-four available CPUs
- **THEN** its worker count is respectively one, one, three, four or four and agrees with the canonical ceiling
- **AND** the unchanged default command still executes the complete discovered test suite with its existing deadlines, coverage and native-execution assertions
- **AND** diagnostic overrides or concurrent external runners are not represented as evidence that arbitrary resource contention cannot cause another failure

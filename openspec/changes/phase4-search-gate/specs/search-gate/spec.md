## ADDED Requirements

### Requirement: Search Preflight Gate

The API SHALL provide a `POST /api/analysis/:analysisPlanId/preflight` endpoint that executes all 13 PreflightGuard checks and returns a PreflightGuardResult before allowing search/calibration/sensitivity to proceed.

#### Scenario: Preflight passes for valid analysis plan

- **WHEN** an AnalysisPlan with mode `sensitivity` references a TheoryToCodeBundle with status `accepted_for_search`, has a recorded eval script hash, verified data checksums, and workspace within allowed paths
- **THEN** the preflight endpoint SHALL return status `pass` with an empty `blocking_reasons` array

#### Scenario: Preflight fails when bundle not accepted

- **WHEN** an AnalysisPlan references a high-risk ChangeRequest and the associated TheoryToCodeBundle status is not `accepted_for_search` or `accepted`
- **THEN** the preflight endpoint SHALL return status `fail` with a blocking reason containing `THEORY_BUNDLE_STATUS_BLOCKS_SEARCH`

#### Scenario: Preflight fails when bundle is missing for high-risk change

- **WHEN** an AnalysisPlan references a high-risk ChangeRequest with semantic_level in (output_semantics, numerical_implementation, parameter_default, physical_equation, model_assumption) and no `requires_theory_bundle_id` is set
- **THEN** the preflight endpoint SHALL return status `fail` with a blocking reason containing `THEORY_BUNDLE_REQUIRED`

#### Scenario: Preflight fails when raw data is modified

- **WHEN** the raw data checksum at preflight time differs from the recorded checksum
- **THEN** the preflight endpoint SHALL return status `fail` with a blocking reason referencing `raw_data_not_modified`

### Requirement: ExperimentTrial and Ledger CRUD

The API SHALL provide endpoints to create, update, and query ExperimentTrial and ExperimentLedger objects with the full schema defined in Controlled_Search_Boundary_Spec.md.

#### Scenario: Create trial with valid decision

- **WHEN** a trial is created with decision `keep` and a non-empty `decision_reason`
- **THEN** the trial SHALL be persisted and linked to its parent ledger

#### Scenario: Reject trial with invalid decision enum

- **WHEN** a trial creation payload uses a decision value outside (`keep`, `discard`, `crash`, `needs_pi_review`, `inconclusive`)
- **THEN** the schema SHALL reject the payload with a validation error

#### Scenario: Ledger summary computation

- **WHEN** a ledger summary is requested
- **THEN** the response SHALL include counts of kept, discarded, crashed, needs_pi_review, and inconclusive trials, the best candidate metrics, and failure mode categorization

### Requirement: Baseline-First Enforcement

The system SHALL reject any report or evidence artifact that uses improvement language (improved, better, worse) without a valid `BaselineComparisonRef` containing `baseline_run_id`.

#### Scenario: Improvement claim without baseline is rejected

- **WHEN** a report attempts to state improvement without a `baseline_run_id` in the associated trial or analysis plan
- **THEN** the report guard SHALL reject the claim and require neutral language ("candidate result observed")

#### Scenario: Improvement claim with valid baseline is accepted

- **WHEN** a report states metric improvement and the trial has a valid `BaselineComparisonRef` with matching `same_stack_lock` and `same_data_id`
- **THEN** the report guard SHALL allow the improvement statement

### Requirement: Mutation Boundary Enforcement

The system SHALL prevent modification of forbidden resources (raw data, benchmark baseline, solver source) during active search, according to the mutation boundary matrix keyed by task type.

#### Scenario: Raw data write during sensitivity is blocked

- **WHEN** a file-write targets a raw data path during a task of type `sensitivity`
- **THEN** the mutation boundary service SHALL block the write and record an ErrorRecord with code `MUTATION_BOUNDARY_VIOLATED`

#### Scenario: Parameter override write during calibration is allowed

- **WHEN** a file-write targets an allowed parameter override file during a task of type `calibration`
- **THEN** the mutation boundary service SHALL allow the write

#### Scenario: PI-gated override for forbidden mutation

- **WHEN** a forbidden mutation is requested with an explicit PI approval gate reference
- **THEN** the mutation boundary service SHALL allow the write after verifying the gate approval artifact

### Requirement: No-Progress Policy

The system SHALL detect when N consecutive trials show no improvement in the primary metric and emit a plateau event with strategy-shift recommendations.

#### Scenario: Plateau detected after N non-improving trials

- **WHEN** 5 consecutive trials (default N=5) record `primary_metric_delta <= 0` or decision `discard`/`inconclusive`
- **THEN** the system SHALL emit a `search.plateau_detected` event with the current trial count and strategy-shift recommendations

#### Scenario: Plateau does not auto-terminate

- **WHEN** a plateau is detected
- **THEN** the system SHALL NOT automatically terminate the search; it SHALL only recommend and await PI decision

#### Scenario: Custom threshold N

- **WHEN** an AnalysisPlan sets `no_progress_threshold: 3`
- **THEN** the plateau detector SHALL use 3 as the threshold instead of the default 5

### Requirement: Preflight Integration with AnalysisPlan Submit

The AnalysisPlan submit flow SHALL invoke preflight and block job creation when preflight status is `fail`.

#### Scenario: Submit blocked by preflight failure

- **WHEN** an AnalysisPlan with mode `calibration` is submitted and preflight returns status `fail`
- **THEN** the submit SHALL be rejected with the preflight blocking reasons and no RunJob SHALL be created

#### Scenario: Submit proceeds after preflight pass

- **WHEN** an AnalysisPlan is submitted and preflight returns status `pass`
- **THEN** the system SHALL persist the preflight artifact and proceed with RunJob creation

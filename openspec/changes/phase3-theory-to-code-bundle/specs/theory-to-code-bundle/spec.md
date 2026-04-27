## ADDED Requirements

### Requirement: TheoryToCodeBundle Full Lifecycle

The system SHALL provide full CRUD and a 13-state state machine for TheoryToCodeBundle objects, enforcing transition preconditions (review gates) and role-based guards (PI-only for accept/reject states).

#### Scenario: Valid bundle transition is accepted

- **WHEN** a bundle in `theory_review` state receives a transition request to `derivation_review` with all gate preconditions met
- **THEN** the system SHALL update the bundle status, emit an AuditEvent, and broadcast a `theory_bundle.status_updated` WebSocket event

#### Scenario: Invalid bundle transition is rejected

- **WHEN** a bundle receives a transition request to a state not reachable from its current state
- **THEN** the system SHALL reject the request with a 409 status and a descriptive error

#### Scenario: Agent cannot accept bundle

- **WHEN** an actor with Agent role attempts to transition a bundle to `accepted` or `accepted_for_search`
- **THEN** the system SHALL reject the request with a 403 status

### Requirement: Equation and Derivation CRUD

The system SHALL provide CRUD for EquationSpec (with SymbolDefinition, EquationDefinition, DimensionCheck) and DerivationRecord (with DerivationStep), enforcing that symbols have units and dimension checks do not have `fail` status before bundle can proceed to implementation_review.

#### Scenario: Symbol missing unit blocks review

- **WHEN** an EquationSpec contains a SymbolDefinition with an empty unit field
- **THEN** the bundle SHALL NOT be allowed to transition past `derivation_review`

#### Scenario: Dimension check failure blocks implementation

- **WHEN** any DimensionCheck has status `fail`
- **THEN** the bundle SHALL NOT be allowed to transition to `implementation_review`

### Requirement: NumericalSchemeSpec CRUD

The system SHALL provide CRUD for NumericalSchemeSpec with all sub-schemas, requiring at least one ConservationExpectation and one StabilityExpectation before bundle can enter `verification_ready`.

#### Scenario: Missing conservation expectation blocks verification

- **WHEN** a NumericalSchemeSpec has zero ConservationExpectation entries
- **THEN** the bundle SHALL NOT be allowed to transition to `verification_ready`

### Requirement: ImplementationMapping CRUD

The system SHALL provide CRUD for ImplementationMapping with CodeTargetMapping, SymbolCodeMapping, OutputSemanticsChange, and SemanticRisk, requiring high-risk code targets to reference at least one equation_id.

#### Scenario: High-risk target without equation reference

- **WHEN** a CodeTargetMapping has change_type other than `refactor_same_semantics` and references zero equation_ids
- **THEN** the system SHALL reject the mapping with a 422 status

### Requirement: VerificationCase Run and Collect

The system SHALL provide endpoints to run a VerificationCase (creating a RunJob), collect results (binding RunRecord and artifacts), and review outcomes. Passed cases without artifacts cannot enter reviewed status. Failed cases must retain all artifacts.

#### Scenario: Verification run creates RunJob

- **WHEN** POST /api/verification-cases/:caseId/run is called
- **THEN** the system SHALL create a RunJob, update the case status to `running`, and emit `verification_case.run_started`

#### Scenario: Failed verification retains artifacts

- **WHEN** a VerificationCase collect results in `failed` status
- **THEN** all associated logs, metrics, patches, and failure_reason SHALL be retained as queryable artifacts

### Requirement: Scientific Change Gating

The system SHALL auto-generate a PiGate when a ChangeRequest has semantic_level in (output_semantics, numerical_implementation, parameter_default, physical_equation, model_assumption), and SHALL block AnalysisPlan search when the referenced bundle is not `accepted_for_search`.

#### Scenario: High-risk change without bundle returns 422

- **WHEN** a ChangeRequest with semantic_level `physical_equation` is created or updated without a theory_bundle_id
- **THEN** the system SHALL return 422 with error code `THEORY_BUNDLE_REQUIRED`

#### Scenario: Search blocked before bundle acceptance

- **WHEN** POST /api/analysis/:analysisPlanId/preflight is called and the referenced bundle status is not `accepted_for_search` or `accepted`
- **THEN** the system SHALL return a preflight failure with blocking_reasons

#### Scenario: High-risk PI approve without comment returns 400

- **WHEN** a PI approves a high-risk scientific gate without providing a comment
- **THEN** the system SHALL return 400 with error code `SCIENTIFIC_GATE_COMMENT_REQUIRED`

### Requirement: CCW Tiny Basin Verification

The system SHALL include a CCW tiny basin verification case fixture (case_type: tiny_basin) that validates water balance residual within a threshold over a 30-day simulation, serving as the first real end-to-end VerificationCase.

#### Scenario: CCW verification passes threshold

- **WHEN** the CCW tiny basin verification case is run and the water_balance_residual is within the configured threshold
- **THEN** the case status SHALL be updated to `passed` with the metrics artifact attached

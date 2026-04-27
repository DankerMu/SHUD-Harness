## 1. Schema Full Implementation

- [ ] 1.1 Implement full TheoryToCodeBundle Zod schema with all canonical fields (replacing Phase 1 stub).
- [ ] 1.2 Implement TheoryNote schema.
- [ ] 1.3 Implement EquationSpec schema with nested SymbolDefinition, EquationDefinition, DimensionCheck.
- [ ] 1.4 Implement DerivationRecord schema with nested DerivationStep.
- [ ] 1.5 Implement NumericalSchemeSpec schema with nested StateVariableSpec, FluxTermSpec, SourceSinkTermSpec, BoundaryConditionSpec, InitialConditionSpec, ConservationExpectation, StabilityExpectation, ToleranceAssumption.
- [ ] 1.6 Implement ImplementationMapping schema with nested CodeTargetMapping, SymbolCodeMapping, OutputSemanticsChange, SemanticRisk, ComplexityCost.
- [ ] 1.7 Implement full VerificationCase Zod schema with all canonical fields (replacing Phase 1 stub).
- [ ] 1.8 Implement ChangeRequestScientificAdditions schema extension.
- [ ] 1.9 Export all Phase 3 schemas and inferred types from core package entrypoints.

## 2. State Machine

- [ ] 2.1 Implement bundle state machine transition function (pure function, 13 states, valid transition matrix).
- [ ] 2.2 Implement transition guards: role-based (PI-only for accepted/accepted_for_search/waived_by_pi).
- [ ] 2.3 Implement transition precondition checks (gate requirements per spec section 5).
- [ ] 2.4 Implement AuditEvent emission on every state transition.
- [ ] 2.5 Add exhaustive transition table unit tests (all valid + all invalid transitions).

## 3. API Endpoints

- [ ] 3.1 Bundle CRUD: POST/GET/PATCH /api/theory-bundles, POST /api/theory-bundles/:bundleId/transition.
- [ ] 3.2 TheoryNote CRUD: POST /api/theory-bundles/:bundleId/theory-note, PATCH /api/theory-notes/:noteId.
- [ ] 3.3 Equation CRUD: POST /api/theory-bundles/:bundleId/equations, PATCH /api/equations/:equationSpecId.
- [ ] 3.4 Dimension check endpoint: POST /api/equations/:equationSpecId/dimension-checks.
- [ ] 3.5 Derivation CRUD: POST /api/theory-bundles/:bundleId/derivation, PATCH /api/derivations/:derivationRecordId.
- [ ] 3.6 Numerical scheme CRUD: POST /api/theory-bundles/:bundleId/numerical-schemes, PATCH /api/numerical-schemes/:schemeId.
- [ ] 3.7 Conservation expectation endpoint: POST /api/numerical-schemes/:schemeId/conservation-expectations.
- [ ] 3.8 Implementation mapping CRUD: POST /api/theory-bundles/:bundleId/implementation-mapping, PATCH /api/implementation-mappings/:mappingId.
- [ ] 3.9 Code targets endpoint: POST /api/implementation-mappings/:mappingId/code-targets.
- [ ] 3.10 Complexity cost endpoint: POST /api/implementation-mappings/:mappingId/complexity-cost.
- [ ] 3.11 Verification case CRUD: POST /api/theory-bundles/:bundleId/verification-cases, GET /api/verification-cases/:caseId.
- [ ] 3.12 Verification run endpoint: POST /api/verification-cases/:caseId/run.
- [ ] 3.13 Verification collect endpoint: POST /api/verification-cases/:caseId/collect.
- [ ] 3.14 Verification review endpoint: PATCH /api/verification-cases/:caseId/review.
- [ ] 3.15 Search preflight endpoint: POST /api/analysis/:analysisPlanId/preflight.

## 4. Verification Integration

- [ ] 4.1 Implement VerificationCase.run → RunJob creation with case config.
- [ ] 4.2 Implement RunJob completion event → VerificationCase.collect trigger.
- [ ] 4.3 Implement collect logic: bind RunRecord, parse metrics artifact, update case status.
- [ ] 4.4 Implement artifact retention for failed verification cases (logs, metrics, patch, failure_reason).
- [ ] 4.5 Add CCW tiny basin fixture (input config, expected water_balance_residual threshold, pass criteria).
- [ ] 4.6 Add dummy echo-based verification fixture for CI (no SHUD binary dependency).
- [ ] 4.7 Implement dimension check artifact generation (structured YAML with checklist items).

## 5. Scientific Change Gating

- [ ] 5.1 Implement scientific gating middleware on ChangeRequest routes.
- [ ] 5.2 Implement auto-PiGate generation for high-risk semantic_level (output_semantics, numerical_implementation, parameter_default, physical_equation, model_assumption).
- [ ] 5.3 Implement bundle requirement enforcement: high-risk ChangeRequest without bundle returns 422.
- [ ] 5.4 Implement search preflight logic: block AnalysisPlan when referenced bundle is not accepted_for_search.
- [ ] 5.5 Implement comment-required enforcement: high-risk approve/reject/waive without comment returns 400.
- [ ] 5.6 Implement Agent role exclusion: Agent actor cannot set accepted/accepted_for_search/waived_by_pi.
- [ ] 5.7 Implement language/lineage guard: reject report submission containing calibration-as-validation phrasing.

## 6. WebSocket Events

- [ ] 6.1 Emit `theory_bundle.status_updated` on bundle transition.
- [ ] 6.2 Emit `equation.dimension_check_updated` on dimension check change.
- [ ] 6.3 Emit `implementation_mapping.updated` on mapping change.
- [ ] 6.4 Emit `verification_case.status_updated` on case status change.
- [ ] 6.5 Emit `verification_case.run_started` on run creation.
- [ ] 6.6 Emit `verification_case.result_recorded` on collect completion.
- [ ] 6.7 Emit `scientific_gate.required` on auto-PiGate generation.
- [ ] 6.8 Emit `scientific_gate.decision_recorded` on PI decision.
- [ ] 6.9 Emit `search_preflight.completed` on preflight check.

## 7. Testing

- [ ] 7.1 Schema tests: TC-SCHEMA-001, TC-SCHEMA-002 (valid/invalid bundle parsing).
- [ ] 7.2 Equation tests: TC-EQ-001 (symbol missing unit), TC-EQ-002 (dimension_check fail blocks implementation_review).
- [ ] 7.3 Gating tests: TC-GATE-001 (physical_equation CR without bundle → 422), TC-GATE-002 (agent attempts accept → 403), TC-GATE-003 (high-risk approve without comment → 400).
- [ ] 7.4 Mapping tests: TC-MAP-001 (high-risk code target without equation_id → 422).
- [ ] 7.5 Verification tests: TC-VER-001 (passed case missing artifact → cannot enter reviewed), TC-VER-002 (failed case retains artifacts).
- [ ] 7.6 Report guard tests: TC-REPORT-001 (high-risk report missing Theory-to-Code Evidence), TC-REPORT-002 (calibration-as-validation phrase rejected).
- [ ] 7.7 Search boundary tests: TC-SEARCH-001 (search before accepted_for_search → 409), TC-SEARCH-002 (improvement claim without baseline rejected).
- [ ] 7.8 Traceability test: TC-TRACE-001 (equation_id → code_target → verification_case → run_record → report).
- [ ] 7.9 State machine exhaustive transition test.
- [ ] 7.10 Integration test with dummy verification fixture (full lifecycle: create bundle → fill sub-objects → run verification → collect → PI accept).

## 8. Verification

- [ ] 8.1 Run all schema unit tests.
- [ ] 8.2 Run all state machine tests.
- [ ] 8.3 Run all API integration tests.
- [ ] 8.4 Run all gating/guard tests.
- [ ] 8.5 Run root typecheck for all Phase 3 exports.
- [ ] 8.6 Confirm all TC-* test IDs from test plan are covered.

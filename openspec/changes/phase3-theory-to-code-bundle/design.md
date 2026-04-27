## Context

Phase 1 established placeholder schemas for TheoryToCodeBundle and VerificationCase with minimal fields. The full governance spec suite (7 documents) defines the complete evidence chain from scientific hypothesis to code verification. Phase 3 activates this entire layer, making it possible to enforce scientific correctness before any search or calibration activity.

The SHUD model's physics-based nature means code changes can silently alter hydrological semantics. This layer provides the structural guarantee that theory, equations, numerical schemes, and implementation are reviewed and verified before downstream analysis is permitted.

## Goals / Non-Goals

**Goals:**

- Implement all TheoryToCodeBundle fields and the full 13-state state machine with transition validation.
- Implement TheoryNote, EquationSpec (with SymbolDefinition, EquationDefinition, DimensionCheck), and DerivationRecord (with DerivationStep) as full Zod schemas with CRUD endpoints.
- Implement NumericalSchemeSpec with all sub-schemas (StateVariableSpec, FluxTermSpec, SourceSinkTermSpec, BoundaryConditionSpec, InitialConditionSpec, ConservationExpectation, StabilityExpectation, ToleranceAssumption).
- Implement ImplementationMapping with CodeTargetMapping, SymbolCodeMapping, OutputSemanticsChange, SemanticRisk, and ComplexityCost.
- Implement VerificationCase full lifecycle: create, run (generates RunJob), collect (binds RunRecord + artifacts), review with pass/fail/inconclusive/waived_by_pi status.
- Implement scientific change gating middleware that auto-generates PiGate for high-risk semantic_level changes.
- Implement search preflight endpoint that blocks AnalysisPlan creation when bundle is not accepted_for_search.
- Provide CCW tiny basin as the first real VerificationCase fixture.
- Emit WebSocket events for all state transitions and verification lifecycle events.

**Non-Goals:**

- Do not implement an automated symbolic dimension algebra system (manual checklist + artifact is sufficient for MVP).
- Do not implement the full EvidenceReport rendering (that belongs to Phase 4/reporting layer; Phase 3 only ensures data availability).
- Do not implement SHUD compilation or model execution infrastructure (VerificationCase.run delegates to existing RunJob/sandbox).
- Do not implement the search/calibration engine itself (only the preflight gate that blocks it).
- Do not implement multi-user concurrent editing of bundles (single-writer assumption for MVP).

## Decisions

- **One service per sub-object**: TheoryBundleService, EquationService, NumericalSchemeService, ImplementationMappingService, VerificationService, ScientificGatingService. Each owns its schema validation and persistence.
- **State machine as pure function**: Bundle transition logic is a pure function `(currentState, targetState, bundleData) => { valid: boolean, errors: string[] }`. Side effects (audit events, WebSocket notifications, PiGate generation) are handled by the service layer after validation.
- **Gate checks as middleware**: Scientific gating is implemented as Hono middleware on ChangeRequest and AnalysisPlan routes, not as inline logic in each handler.
- **Verification run delegates to RunJob**: VerificationCase.run creates a RunJob with appropriate config; the existing job execution infrastructure handles scheduling and completion. VerificationCase.collect is called when RunJob completes (via existing job completion webhook/event).
- **Dimension check as artifact**: Rather than a computed pass/fail from a parser, dimension checks produce a structured YAML artifact with manual checklist items. Each item has a `checked_by` field and `status`.
- **CCW tiny basin as seed data**: The CCW case is provided as a fixture/seed that can be loaded into any workspace for testing the full verification flow.
- **Role-based transition guards**: Only PI role can set `accepted`, `accepted_for_search`, or `waived_by_pi`. Agent role cannot approve any scientific gate. This is enforced at the transition function level.

## Risks / Trade-offs

- **Complexity of 13-state machine**: Many states increase testing surface. Mitigation: exhaustive transition table test (valid transitions matrix + all invalid transitions return error).
- **Tight coupling between sub-objects**: Bundle references equation_spec_id, derivation_record_id, etc. If any sub-object is deleted, bundle integrity breaks. Mitigation: soft-delete only; referential integrity checks on transition.
- **CCW verification depends on SHUD binary**: Running the real CCW case requires a compiled SHUD binary and input data. Mitigation: dummy verification fixture for CI (echo-based), CCW case for integration/nightly.
- **Over-governance risk**: Requiring full bundle for every numerical change could slow iteration. Mitigation: `io_format` and `pure_engineering` levels are exempt; PI can waive verification cases with comment.
- **Language guard false positives**: Detecting "calibration-as-validation" phrasing may flag legitimate text. Mitigation: guard only blocks report submission (not creation), and PI can override with comment.

## Migration Plan

- Replace Phase 1 TheoryToCodeBundle stub schema with full schema (breaking change to stub consumers, but no runtime code exists yet).
- Replace Phase 1 VerificationCase stub schema with full schema.
- Add new schema files for TheoryNote, EquationSpec, DerivationRecord, NumericalSchemeSpec, ImplementationMapping, and all sub-schemas.
- Add route modules under `packages/api/src/routes/theory/`.
- Add service modules under `packages/api/src/services/theory/`.
- Add state machine module at `packages/core/src/domain/state-machines/bundle.ts`.
- Add gating middleware at `packages/api/src/middleware/scientific-gating.ts`.
- Add test files matching the TC-* test plan.
- Add CCW fixture data under `packages/core/src/fixtures/verification/ccw-tiny/`.

## Open Questions

- Should bundle creation automatically create empty sub-objects (TheoryNote, EquationSpec, etc.) or require explicit creation? Leaning toward explicit creation to avoid partially-filled objects.
- Should the dimension check checklist be a fixed 5-item list (per spec) or extensible per equation? Leaning toward extensible with the 5 items as defaults.
- Should VerificationCase.collect be triggered automatically by RunJob completion event, or require explicit API call? Leaning toward automatic trigger with manual override.
- What is the water_balance_residual threshold for CCW tiny basin pass criteria? Needs PI input (placeholder: 1% of total storage change over 30 days).

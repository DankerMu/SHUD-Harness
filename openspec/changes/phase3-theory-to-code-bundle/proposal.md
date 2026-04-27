## Why

SHUD is a physics-based hydrological model. Before any parameter search, sensitivity analysis, or calibration can be trusted, the system must guarantee an explicit evidence chain from scientific theory through equations, derivation, numerical scheme, and code mapping to verification results. Without this chain, code patches can silently alter physical semantics, and calibration improvements can masquerade as structural validation.

Phase 1 created stub/placeholder schemas for TheoryToCodeBundle and VerificationCase. Phase 3 replaces those stubs with full implementations, making the theory-to-code governance system operational.

## What Changes

- Implement full TheoryToCodeBundle Zod schema (all fields from governance spec) and CRUD endpoints with 13-state state machine transitions.
- Implement TheoryNote, EquationSpec, DerivationRecord schemas and CRUD with symbol table, dimension check, and derivation step support.
- Implement NumericalSchemeSpec schema and CRUD with state variables, flux terms, source/sink terms, boundary/initial conditions, conservation/stability expectations.
- Implement ImplementationMapping schema and CRUD with code target mapping, symbol-code mapping, output semantics changes, semantic risks, and complexity cost.
- Implement VerificationCase schema and full lifecycle: create, run (generates RunJob), collect (binds RunRecord and artifacts), review endpoints.
- Implement Scientific Change Gating: auto-generate PiGate when ChangeRequest semantic_level is high-risk, enforce bundle requirement before search/calibration via preflight API.
- Add CCW tiny basin as first real VerificationCase (case_type: tiny_basin, 30-day water balance threshold).
- Add dimension check support as manual checklist with artifact generation.
- Add WebSocket events for bundle status, verification status, and scientific gate notifications.
- Add language/lineage guard preventing calibration-as-validation phrasing in reports.

## Capabilities

### New Capabilities

- `theory-to-code-bundle`: Full theory-to-code governance lifecycle including bundle state machine, sub-object CRUD, verification integration, scientific gating, and search preflight enforcement.

### Modified Capabilities

- `core-schemas`: TheoryToCodeBundle and VerificationCase stubs are replaced by full schemas with all canonical fields.

## Upstream References

| Document | Use | Boundary |
|---|---|---|
| `docs/03_SPEC/Theory_To_Code_Governance_Spec.md` | Normative source for bundle schema, state machine, review gates, and governance rules. | Full implementation of all states and gates. |
| `docs/03_SPEC/Equation_And_Derivation_Spec.md` | Normative source for TheoryNote, EquationSpec, DerivationRecord schemas and quality rules. | Full implementation; dimension parser deferred to post-MVP. |
| `docs/03_SPEC/Numerical_Scheme_Spec.md` | Normative source for NumericalSchemeSpec and sub-schemas. | Full implementation of all sub-schemas. |
| `docs/03_SPEC/Implementation_Mapping_Spec.md` | Normative source for ImplementationMapping, CodeTargetMapping, SymbolCodeMapping, OutputSemanticsChange, SemanticRisk, ComplexityCost. | Full implementation. |
| `docs/03_SPEC/Verification_Case_Spec.md` | Normative source for VerificationCase schema and lifecycle rules. | Full implementation including RunJob/RunRecord binding. |
| `docs/03_SPEC/Scientific_Change_Gating_Spec.md` | Normative source for semantic level enum, gate matrix, auto-gate rules, and comment-required rules. | Full implementation of gate matrix and enforcement. |
| `docs/04_IMPLEMENTATION/Theory_To_Code_API_Contracts.md` | Normative API endpoints, error codes, and WebSocket events. | Full implementation of all listed endpoints and events. |
| `docs/04_IMPLEMENTATION/Theory_To_Code_Test_Plan.md` | Normative test IDs, scenarios, and fixture strategy. | All TC-* tests implemented in this phase. |

## Impact

- Affected paths: `packages/core/src/domain/schemas/theory/*`, `packages/api/src/routes/theory/*`, `packages/api/src/services/theory/*`, `packages/core/src/domain/state-machines/bundle.ts`, `packages/api/src/middleware/scientific-gating.ts`, `packages/api/src/services/verification/*`, schema tests, integration tests.
- Depends on `phase1-core-schemas` (shared enums, TaskCard, RunJob/RunRecord, Artifact, ChangeRequest base types).
- Depends on `phase1-monorepo-foundation` (package structure, test runner).
- Enables downstream Phase 4 search/calibration layer (search preflight blocks until bundle is accepted_for_search).
- Enables EvidenceReport Theory-to-Code Evidence section rendering.

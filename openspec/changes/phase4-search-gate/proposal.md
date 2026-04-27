## Why

Phase 4 activates the controlled search boundary — the gate that prevents sensitivity analysis, calibration, and parameter search from running before the theory-to-code bundle is accepted. Without this gate, an agent could run expensive search loops on unvalidated physics changes, produce misleading improvement claims without baselines, or silently mutate raw data and benchmark baselines during search.

## What Changes

- Add search preflight API endpoint (`POST /api/analysis/:id/preflight`) that checks bundle status, data integrity, and mutation boundaries before allowing search/calibration to proceed.
- Implement PreflightGuard with 13 deterministic checks (workspace path, data checksum, eval script hash, bundle status, etc.).
- Add ExperimentTrial and ExperimentLedger Zod schemas and CRUD endpoints.
- Enforce baseline-first rule: no improvement claim without a `baseline_run_id` reference.
- Enforce mutation boundary matrix: prevent modifying raw data, benchmark baseline, or solver source during active search.
- Implement no-progress policy: detect plateauing after N consecutive non-improving trials and recommend strategy shift.
- Integrate preflight into AnalysisPlan submit flow so search cannot begin without passing all guards.

## Capabilities

### New Capabilities

- `search-preflight`: Deterministic preflight guard that blocks search/calibration when preconditions are unmet.
- `experiment-ledger`: ExperimentTrial and ExperimentLedger schemas, CRUD, and decision tracking.
- `baseline-enforcement`: Report guard that rejects improvement claims without baseline comparison.
- `mutation-boundary`: Runtime enforcement of the mutation boundary matrix during active search.
- `no-progress-policy`: Plateau detection and strategy-shift recommendation after N non-improving trials.

### Modified Capabilities

- `analysis-plan-submit`: AnalysisPlan submit now invokes preflight before job creation.

## Upstream References

| Document | Use | Boundary |
|---|---|---|
| `docs/03_SPEC/Controlled_Search_Boundary_Spec.md` | Normative source for ExperimentTrial/Ledger schemas, baseline-first rule, decision enum, and no-progress policy. | Implement full spec. |
| `docs/03_SPEC/Preflight_And_Mutation_Boundary_Spec.md` | Normative source for PreflightGuard schema, 13 check items, and mutation boundary matrix. | Implement all 13 checks and the task-type mutation matrix. |
| `docs/03_SPEC/Sensitivity_Calibration_Benchmark.md` | Normative source for search precondition (requires_theory_bundle_id), report language constraints, and benchmark baseline update rules. | Implement search precondition and report guard; benchmark tier execution is out of scope. |
| `docs/04_IMPLEMENTATION/Theory_To_Code_API_Contracts.md` | Normative source for search preflight API shape, error codes, and WebSocket event `search_preflight.completed`. | Implement the `/api/analysis/:id/preflight` endpoint and error codes. |
| `docs/03_SPEC/Minimal_Schemas.md` | Reference for AnalysisPlan fields (mode, requires_theory_bundle_id, baseline_run_id). | Only extend AnalysisPlan with search-gate fields; no structural changes. |

## Impact

- Affected paths: `packages/core/src/domain/schemas/experiment-trial.ts`, `packages/core/src/domain/schemas/experiment-ledger.ts`, `packages/core/src/domain/schemas/preflight-guard.ts`, `packages/api/src/routes/analysis.ts`, `packages/api/src/services/preflight.service.ts`, `packages/api/src/services/mutation-boundary.service.ts`, schema tests, integration tests.
- Depends on: `phase1-core-schemas`, `phase3-theory-to-code-bundle`.
- Enables: safe sensitivity/calibration execution, evidence-backed reports, and PI-reviewable ledger summaries.

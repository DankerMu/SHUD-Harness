## Context

`docs/03_SPEC/Controlled_Search_Boundary_Spec.md` and `docs/03_SPEC/Preflight_And_Mutation_Boundary_Spec.md` define the runtime safety boundaries for search/calibration. These boundaries ensure that expensive parameter searches only run after scientific changes have been validated through the Theory-to-Code pipeline, that every improvement claim has a baseline, and that critical artifacts (raw data, benchmark baselines, solver source) cannot be silently mutated during search.

## Goals / Non-Goals

**Goals:**

- Implement the search preflight endpoint that gates AnalysisPlan submission for sensitivity/calibration/controlled_search modes.
- Implement all 13 PreflightGuard deterministic checks as composable, testable units.
- Provide ExperimentTrial and ExperimentLedger Zod schemas with full CRUD and decision tracking.
- Enforce baseline-first rule at the report generation boundary (reject improvement language without baseline_run_id).
- Enforce mutation boundary matrix at the file-system and API layers during active search.
- Detect no-progress plateaus and surface strategy-shift recommendations.

**Non-Goals:**

- Do not implement the search execution engine (parameter sampling, optimizer loop). That is a future phase.
- Do not implement benchmark tier execution (smoke/engineering/science-assist). Benchmarks are defined but executed via RunJob.
- Do not implement PI approval UI flows. The API exposes the gate; frontend rendering is a separate changeset.
- Do not implement report generation. Only the report guard (reject improvement claims) is in scope.

## Decisions

- PreflightGuard checks are implemented as an array of independent check functions, each returning a `PreflightCheck` result. This makes adding new checks trivial and keeps each check unit-testable.
- The mutation boundary is enforced via a middleware layer that intercepts file-write and API-mutation calls during an active search session. The boundary matrix is configured per task-type as defined in the spec.
- ExperimentTrial decisions use a closed enum (`keep | discard | crash | needs_pi_review | inconclusive`). No extensibility is offered; new decisions require a spec change.
- No-progress threshold N is configurable per AnalysisPlan (default: 5). The policy emits a `search.plateau_detected` event but does not auto-terminate — PI decides.
- The preflight endpoint returns a full `PreflightGuardResult` artifact that is persisted and linked to the eventual RunRecord lineage.
- Baseline comparison uses `BaselineComparisonRef` to ensure `same_stack_lock`, `same_data_id`, and `same_eval_script_hash` are recorded. Mismatches produce warnings, not hard failures, unless the comparison is used for an improvement claim.

## Risks / Trade-offs

- Over-strict preflight may block legitimate exploratory runs. Mitigation: checks that are advisory (disk_free, memory_budget) produce warnings, not failures. Only safety-critical checks (bundle status, raw data integrity, mutation boundary) are blocking.
- Under-strict mutation boundary may miss indirect mutations (e.g., via symlinks or external tools). Mitigation: checksum-based verification of critical files at preflight and post-run comparison.
- No-progress detection is heuristic. Mitigation: plateau is advisory, surfaced as recommendation, never auto-terminates.
- ExperimentLedger can grow large for long search campaigns. Mitigation: ledger is append-only with pagination support; summary is computed on demand.

## Migration Plan

- Add ExperimentTrial and ExperimentLedger schemas to `packages/core/src/domain/schemas/`.
- Add PreflightGuard schema and check definitions to `packages/core/src/domain/schemas/`.
- Add preflight service to `packages/api/src/services/`.
- Add mutation boundary service to `packages/api/src/services/`.
- Add `/api/analysis/:id/preflight` route to `packages/api/src/routes/`.
- Add experiment CRUD routes to `packages/api/src/routes/`.
- Add integration tests covering all 13 checks, baseline-first rejection, mutation boundary enforcement, and plateau detection.
- Emit `search_preflight.completed` and `search.plateau_detected` WebSocket events.

## Open Questions

- Whether the no-progress threshold N should be global or per-metric needs PI input during early usage.
- Whether mutation boundary enforcement should extend to git-tracked files in the SHUD source worktree (currently only workspace-scoped files are guarded).

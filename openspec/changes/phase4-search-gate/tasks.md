## 1. Schema Implementation

- [ ] 1.1 Add ExperimentTrial Zod schema with full fields (trial_id, analysis_plan_id, task_id, parameter_set_id, change_request_id, parent_trial_id, baseline_run_id, candidate_run_id, run_record_ids, patch_artifact_id, decision enum, decision_reason, primary_metric_delta, secondary_metric_deltas, complexity_cost_id, artifact_refs).
- [ ] 1.2 Add ExperimentLedger Zod schema (ledger_id, task_id, analysis_plan_id, trials array, summary_artifact_id).
- [ ] 1.3 Add PreflightGuardResult Zod schema (guard_id, task_id, job_id, change_request_id, analysis_plan_id, checks array, status enum, blocking_reasons, artifact_id).
- [ ] 1.4 Add PreflightCheck Zod schema (check_id, name, status enum, details).
- [ ] 1.5 Add BaselineComparisonRef Zod schema (baseline_run_id, candidate_run_id, same_stack_lock, same_data_id, same_eval_script_hash, metric_delta record).
- [ ] 1.6 Add MutationBoundaryMatrix config schema (task_type to allowed/forbidden path mappings).
- [ ] 1.7 Export all Phase 4 schemas and inferred types from core package entrypoints.

## 2. Preflight Service

- [ ] 2.1 Implement check: workspace_allowed_path.
- [ ] 2.2 Implement check: worktree_clean_or_expected_patch.
- [ ] 2.3 Implement check: theory_bundle_required_if_high_risk.
- [ ] 2.4 Implement check: theory_bundle_status_allows_search.
- [ ] 2.5 Implement check: baseline_required_for_improvement_claim.
- [ ] 2.6 Implement check: evaluation_script_hash_recorded.
- [ ] 2.7 Implement check: input_data_checksum_verified.
- [ ] 2.8 Implement check: raw_data_not_modified.
- [ ] 2.9 Implement check: benchmark_baseline_not_modified_without_gate.
- [ ] 2.10 Implement check: disk_free_threshold_passed.
- [ ] 2.11 Implement check: memory_thread_budget_declared.
- [ ] 2.12 Implement check: secret_redaction_enabled.
- [ ] 2.13 Implement check: output_directory_run_scoped.
- [ ] 2.14 Implement preflight orchestrator that runs all checks and produces PreflightGuardResult.

## 3. Search Preflight API

- [ ] 3.1 Add route `POST /api/analysis/:analysisPlanId/preflight`.
- [ ] 3.2 Integrate preflight into AnalysisPlan submit flow (block job creation on preflight fail).
- [ ] 3.3 Persist PreflightGuardResult as artifact with lineage link.
- [ ] 3.4 Emit `search_preflight.completed` WebSocket event.

## 4. Experiment Ledger CRUD

- [ ] 4.1 Add route `POST /api/experiments/trials` (create trial).
- [ ] 4.2 Add route `PATCH /api/experiments/trials/:trialId` (update decision).
- [ ] 4.3 Add route `GET /api/experiments/ledgers/:ledgerId` (get ledger with trials).
- [ ] 4.4 Add route `POST /api/experiments/ledgers` (create ledger).
- [ ] 4.5 Add route `GET /api/experiments/ledgers/:ledgerId/summary` (computed summary).

## 5. Baseline-First Enforcement

- [ ] 5.1 Implement report guard that rejects improvement language when BaselineComparisonRef is missing.
- [ ] 5.2 Validate BaselineComparisonRef consistency (same_stack_lock, same_data_id, same_eval_script_hash) and emit warnings on mismatch.

## 6. Mutation Boundary Enforcement

- [ ] 6.1 Implement mutation boundary middleware that intercepts file-write calls during active search.
- [ ] 6.2 Load mutation boundary matrix from config per task-type.
- [ ] 6.3 Block forbidden mutations with ErrorRecord (code: MUTATION_BOUNDARY_VIOLATED).
- [ ] 6.4 Allow PI-gated override for mutations that require explicit approval.

## 7. No-Progress Policy

- [ ] 7.1 Implement plateau detector (count consecutive trials without primary_metric improvement).
- [ ] 7.2 Emit `search.plateau_detected` event when threshold N is reached.
- [ ] 7.3 Attach strategy-shift recommendations to the plateau event payload.
- [ ] 7.4 Make threshold N configurable per AnalysisPlan (default: 5).

## 8. Fixtures and Tests

- [ ] 8.1 Add valid fixture data for ExperimentTrial, ExperimentLedger, PreflightGuardResult, BaselineComparisonRef.
- [ ] 8.2 Add invalid fixture data for decision enum violations, missing required fields, invalid status transitions.
- [ ] 8.3 Add unit tests for each of the 13 preflight checks (pass and fail scenarios).
- [ ] 8.4 Add unit tests for baseline-first report guard.
- [ ] 8.5 Add unit tests for mutation boundary enforcement (allowed vs forbidden per task-type).
- [ ] 8.6 Add unit tests for no-progress plateau detection.
- [ ] 8.7 Add integration test: full preflight → submit → trial → ledger flow.

## 9. Verification

- [ ] 9.1 Run all unit and integration tests.
- [ ] 9.2 Run root typecheck for schema exports.
- [ ] 9.3 Confirm preflight check names map back to spec (13 items in Preflight_And_Mutation_Boundary_Spec.md).
- [ ] 9.4 Confirm ExperimentTrial/Ledger fields match Controlled_Search_Boundary_Spec.md.
- [ ] 9.5 Confirm error codes match Theory_To_Code_API_Contracts.md § 7.

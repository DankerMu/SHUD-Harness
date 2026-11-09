import type {
  AnalysisPlan,
  AnalysisPlanId,
  JobRecordId,
  RunId,
  RunJob,
  RunRecord,
} from "@shud-harness/dsh-shud-core";
import type { RunMetrics } from "./run-metrics-wire.ts";

/** Synchronous readers: plans are schema/identity checked; metrics readers bind safe bytes to sha256. */
export interface SensitivityObjectLoaders {
  readAnalysisPlan(id: AnalysisPlanId): unknown;
  readRunMetrics(runId: RunId, expectedSha256: string): RunMetrics;
  /** Sensitivity success must not be reachable through the legacy loader/result overload. */
  readChange?: never;
  readPatch?: never;
  readVerification?: never;
}

/** Only validated identifiers, never native exceptions or authored text, enter diagnostics. */
export interface SensitivityClosureFailure {
  clause: 0 | 1 | 2 | 3 | 4 | 5;
  reason:
    | "invalid_sensitivity_card"
    | "missing_sensitivity_loaders"
    | "invalid_plan_link"
    | "plan_read_error"
    | "plan_identity_mismatch"
    | "foreign_plan"
    | "no_linked_jobs"
    | "missing_observations"
    | "missing_limitations"
    | "missing_pi_questions"
    | "invalid_job_link"
    | "missing_job"
    | "ambiguous_job"
    | "invalid_job"
    | "foreign_job"
    | "invalid_job_binding"
    | "invalid_collect_attempts"
    | "job_not_terminal"
    | "missing_record"
    | "ambiguous_record"
    | "invalid_record"
    | "record_identity_mismatch"
    | "missing_parameter_set"
    | "multiple_successes"
    | "inadmissible_effective_run"
    | "missing_stack_reference"
    | "mixed_stack"
    | "missing_data_reference"
    | "missing_metrics"
    | "metrics_read_error"
    | "metrics_unavailable";
  analysis_plan_id?: AnalysisPlanId;
  parameter_set_id?: string;
  job_id?: JobRecordId;
  job_ids?: readonly JobRecordId[];
}

export interface SensitivityRunIdentity {
  parameter_set_id: string;
  job_id: JobRecordId;
  run_id: RunId;
}

export interface SensitivitySelection extends SensitivityRunIdentity {
  record: RunRecord;
  /** Null only for an admissible failed perturbation; thresholds never determine closure. */
  metrics: RunMetrics | null;
}

/** Validated closure-owned evidence; downstream derivation must not join another snapshot. */
export interface SensitivitySupersededRun extends SensitivityRunIdentity {
  job: RunJob;
  record: RunRecord | null;
  collect_error_attempts: number;
}

/** No legacy metric_fact/no-artifact limitation: sensitivity success requires real metrics. */
export type SensitivityClosureResult =
  | {
      ok: true;
      failures: readonly [];
      analysis_plan_id: AnalysisPlanId;
      plan: AnalysisPlan;
      selected: readonly SensitivitySelection[];
      superseded: readonly SensitivitySupersededRun[];
    }
  | {
      ok: false;
      failures: readonly [SensitivityClosureFailure, ...SensitivityClosureFailure[]];
    };

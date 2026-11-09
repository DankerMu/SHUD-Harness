import type {
  AnalysisPlanId,
  CALIB_WHITELIST,
  JobRecordId,
  METRICS_METHOD_VERSION,
  NumericalHealthVerdict,
  RunExitClass,
  RunId,
  TaskId,
} from "@shud-harness/dsh-shud-core";

export const SUMMARY_METRICS = [
  "peak_flow_m3d",
  "peak_day",
  "total_runoff_m3",
  "water_balance_residual",
] as const;
export const SUMMARY_DELTAS = [
  "delta_peak_flow_pct",
  "delta_peak_day",
  "delta_total_runoff_pct",
] as const;
export type SummaryMetric = (typeof SUMMARY_METRICS)[number];
export type SummaryDelta = (typeof SUMMARY_DELTAS)[number];
export type SummaryDeltaReason = "baseline_row" | "run_failed" | "metric_null" | "zero_baseline";

export type SensitivitySummaryRow = Record<SummaryMetric | SummaryDelta, number | null> & {
  parameter_set_id: string;
  label: string | null;
  baseline: boolean;
  key: keyof typeof CALIB_WHITELIST | null;
  multiplier: number | null;
  job_id: JobRecordId;
  run_id: RunId;
  status: "succeeded" | "failed";
  exit_code: number | null;
  exit_class: RunExitClass;
  water_balance_residual_verdict: NumericalHealthVerdict | null;
  metric_reasons: Record<SummaryMetric, string | null>;
  delta_reasons: Record<SummaryDelta, SummaryDeltaReason | null>;
};

export interface SensitivitySummary {
  method_version: typeof METRICS_METHOD_VERSION;
  analysis_plan_id: AnalysisPlanId;
  plan_sha256: string;
  task_id: TaskId;
  project: string;
  end_days: number;
  rows: SensitivitySummaryRow[];
  superseded_runs: {
    parameter_set_id: string;
    job_id: JobRecordId;
    run_id: RunId;
    terminal_state: "collected" | "failed" | "cancelled" | "collect_exhausted";
    exit_class: RunExitClass | null;
  }[];
  inputs: { run_id: RunId; metrics_sha256: string }[];
}

/** Shared causal precedence; consuming stored evidence never recalculates its delta. */
export function summaryDeltaReason(
  row: Pick<SensitivitySummaryRow, "baseline" | "status">,
  value: number | null,
  baseline: number | null,
  delta: SummaryDelta,
): SummaryDeltaReason | null {
  if (row.baseline) return "baseline_row";
  if (row.status === "failed") return "run_failed";
  if (value === null || baseline === null) return "metric_null";
  if (delta !== "delta_peak_day" && baseline === 0) return "zero_baseline";
  return null;
}

/** Controlled provenance/wire failure; raw input and native causes are never retained. */
export class SensitivitySummaryError extends Error {
  constructor(readonly stage: "plan" | "identity" | "metrics" | "arithmetic" | "schema") {
    super(`Sensitivity summary ${stage} failed`);
    this.name = "SensitivitySummaryError";
  }
}

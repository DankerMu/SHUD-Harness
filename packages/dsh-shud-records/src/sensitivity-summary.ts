import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AnalysisPlanSchema,
  MAX_COLLECT_ATTEMPTS,
  METRICS_METHOD_VERSION,
  type AnalysisPlan,
  type RunRecord,
} from "@shud-harness/dsh-shud-core";
import type {
  SensitivityClosureResult,
  SensitivityRunIdentity,
} from "./sensitivity-closure-types.ts";
import { validateRunMetrics } from "./run-metrics-wire.ts";
import { parseSensitivitySummary } from "./sensitivity-summary-wire.ts";
import {
  SensitivitySummaryError,
  SUMMARY_DELTAS,
  SUMMARY_METRICS,
  summaryDeltaReason,
  type SensitivitySummary,
  type SensitivitySummaryRow,
} from "./sensitivity-summary-types.ts";

type SuccessfulClosure = Extract<SensitivityClosureResult, { ok: true }>;

function requireIdentity(condition: unknown): asserts condition {
  if (!condition) throw new SensitivitySummaryError("identity");
}

function checkRecord(
  plan: AnalysisPlan,
  identity: SensitivityRunIdentity,
  record: RunRecord,
): void {
  requireIdentity(
    record.task_id === plan.task_id &&
      record.analysis_plan_id === plan.analysis_plan_id &&
      record.parameter_set_id === identity.parameter_set_id &&
      record.job_id === identity.job_id &&
      record.run_id === identity.run_id,
  );
}

function planFromBytes(closure: SuccessfulClosure, bytes: Uint8Array): AnalysisPlan {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const plan = AnalysisPlanSchema.parse(value);
    const owned = AnalysisPlanSchema.parse(closure.plan);
    if (!isDeepStrictEqual(plan, owned) || plan.analysis_plan_id !== closure.analysis_plan_id) {
      throw new SensitivitySummaryError("identity");
    }
    return plan;
  } catch (error) {
    if (error instanceof SensitivitySummaryError) throw error;
    throw new SensitivitySummaryError("plan");
  }
}

function derive(closure: SuccessfulClosure, planBytes: Uint8Array): SensitivitySummary {
  requireIdentity(closure.ok === true);
  const plan = planFromBytes(closure, planBytes);
  requireIdentity(closure.selected.length === plan.parameter_sets.length);
  const inputs: SensitivitySummary["inputs"] = [];
  const rows: SensitivitySummaryRow[] = plan.parameter_sets.map((set, index) => {
    const selected = closure.selected[index];
    requireIdentity(selected.parameter_set_id === set.parameter_set_id);
    const record = selected.record;
    checkRecord(plan, selected, record);
    const metrics = selected.metrics;
    if (record.status === "succeeded") {
      try {
        validateRunMetrics(metrics);
        if (metrics.status !== "ok" || record.artifacts.metrics_summary === null) {
          throw new SensitivitySummaryError("metrics");
        }
      } catch {
        throw new SensitivitySummaryError("metrics");
      }
      inputs.push({
        run_id: selected.run_id,
        metrics_sha256: record.artifacts.metrics_summary.sha256,
      });
    } else requireIdentity(record.status === "failed" && metrics === null);
    const change = Object.entries(set.changes)[0];
    return {
      parameter_set_id: set.parameter_set_id,
      label: set.label,
      baseline: set.baseline,
      key: set.baseline ? null : (change[0] as SensitivitySummaryRow["key"]),
      multiplier: set.baseline ? null : change[1],
      job_id: selected.job_id,
      run_id: selected.run_id,
      status: record.status,
      exit_code: record.exit_code,
      exit_class: record.exit_class,
      peak_flow_m3d: metrics?.flow.peak_flow_m3d ?? null,
      peak_day: metrics?.flow.peak_day ?? null,
      total_runoff_m3: metrics?.flow.total_runoff_m3 ?? null,
      water_balance_residual: metrics?.numerical_health.water_balance_residual ?? null,
      water_balance_residual_verdict: metrics?.verdicts.water_balance_residual ?? null,
      metric_reasons: {
        peak_flow_m3d: metrics === null ? "run_failed" : metrics.flow.reasons.peak_flow_m3d,
        peak_day: metrics === null ? "run_failed" : metrics.flow.reasons.peak_day,
        total_runoff_m3: metrics === null ? "run_failed" : metrics.flow.reasons.total_runoff_m3,
        water_balance_residual:
          metrics === null ? "run_failed" : metrics.numerical_health.reasons.water_balance_residual,
      },
      delta_peak_flow_pct: null,
      delta_peak_day: null,
      delta_total_runoff_pct: null,
      delta_reasons: {
        delta_peak_flow_pct: null,
        delta_peak_day: null,
        delta_total_runoff_pct: null,
      },
    };
  });
  const baseline = rows.find((row) => row.baseline)!;
  for (const row of rows) {
    for (const [index, delta] of SUMMARY_DELTAS.entries()) {
      const metric = SUMMARY_METRICS[index];
      const x = row[metric];
      const base = baseline[metric];
      const reason = summaryDeltaReason(row, x, base, delta);
      row.delta_reasons[delta] = reason;
      if (reason !== null) continue;
      const value = delta === "delta_peak_day" ? x! - base! : ((x! - base!) / base!) * 100;
      if (!Number.isFinite(value)) throw new SensitivitySummaryError("arithmetic");
      row[delta] = value;
    }
  }
  const superseded_runs: SensitivitySummary["superseded_runs"] = closure.superseded.map((entry) => {
    const { job, record, collect_error_attempts: attempts } = entry;
    requireIdentity(
      job.task_id === plan.task_id &&
        job.analysis_plan_id === plan.analysis_plan_id &&
        job.parameter_set_id === entry.parameter_set_id &&
        job.job_id === entry.job_id &&
        job.run_id === entry.run_id,
    );
    requireIdentity(Number.isSafeInteger(attempts) && attempts >= 0);
    if (record !== null) checkRecord(plan, entry, record);
    const explicit =
      job.status === "collected" || job.status === "failed" || job.status === "cancelled";
    requireIdentity(explicit || attempts >= MAX_COLLECT_ATTEMPTS);
    return {
      parameter_set_id: entry.parameter_set_id,
      job_id: entry.job_id,
      run_id: job.run_id,
      terminal_state: explicit
        ? (job.status as "collected" | "failed" | "cancelled")
        : "collect_exhausted",
      exit_class: record?.exit_class ?? null,
    };
  });
  return parseSensitivitySummary({
    method_version: METRICS_METHOD_VERSION,
    analysis_plan_id: plan.analysis_plan_id,
    plan_sha256: createHash("sha256").update(planBytes).digest("hex"),
    task_id: plan.task_id,
    project: plan.project,
    end_days: plan.end_days,
    rows,
    superseded_runs,
    inputs,
  });
}

/**
 * Derive only from one successful closure and its exact plan bytes. No IO, reselection,
 * clock or report identity. Percent arithmetic is (x-base)/base*100, never rounded;
 * null operands precede zero denominators and overflow rejects before publication.
 */
export function buildSensitivitySummary(
  closure: SuccessfulClosure,
  planBytes: Uint8Array,
): SensitivitySummary {
  try {
    return derive(closure, planBytes);
  } catch (error) {
    if (error instanceof SensitivitySummaryError) throw error;
    throw new SensitivitySummaryError("identity");
  }
}

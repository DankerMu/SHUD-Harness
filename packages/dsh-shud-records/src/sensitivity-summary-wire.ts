import {
  AnalysisPlanIdSchema,
  CALIB_MULTIPLIER_RANGE,
  CALIB_WHITELIST,
  isProjectComponent,
  JobRecordIdSchema,
  METRICS_METHOD_VERSION,
  RunExitClassSchema,
  RunIdSchema,
  TaskIdSchema,
} from "@shud-harness/dsh-shud-core";
import {
  SensitivitySummaryError,
  SUMMARY_DELTAS,
  SUMMARY_METRICS,
  summaryDeltaReason,
  type SensitivitySummary,
  type SensitivitySummaryRow,
} from "./sensitivity-summary-types.ts";

const ROW_FIELDS = [
  "parameter_set_id",
  "label",
  "baseline",
  "key",
  "multiplier",
  "job_id",
  "run_id",
  "status",
  "exit_code",
  "exit_class",
  ...SUMMARY_METRICS,
  "water_balance_residual_verdict",
  "metric_reasons",
  ...SUMMARY_DELTAS,
  "delta_reasons",
] as const;
const TOP_FIELDS = [
  "method_version",
  "analysis_plan_id",
  "plan_sha256",
  "task_id",
  "project",
  "end_days",
  "rows",
  "superseded_runs",
  "inputs",
] as const;
const digestPattern = /^[0-9a-f]{64}$/u;
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function requireShape(condition: unknown): asserts condition {
  if (!condition) throw new SensitivitySummaryError("schema");
}

function strictObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  requireShape(value !== null && typeof value === "object" && !Array.isArray(value));
  const keys = Object.keys(value);
  requireShape(keys.length === fields.length && keys.every((key) => fields.includes(key)));
  return value as Record<string, unknown>;
}

function validateRow(value: unknown, index: number): asserts value is SensitivitySummaryRow {
  const row = strictObject(value, ROW_FIELDS);
  requireShape(row.parameter_set_id === `PSET-${index + 1}`);
  requireShape(row.label === null || (typeof row.label === "string" && row.label.length > 0));
  requireShape(typeof row.baseline === "boolean");
  if (row.baseline) requireShape(row.key === null && row.multiplier === null);
  else {
    requireShape(typeof row.key === "string" && Object.hasOwn(CALIB_WHITELIST, row.key));
    requireShape(
      finite(row.multiplier) &&
        row.multiplier !== 1 &&
        row.multiplier >= CALIB_MULTIPLIER_RANGE[0] &&
        row.multiplier <= CALIB_MULTIPLIER_RANGE[1],
    );
  }
  requireShape(JobRecordIdSchema.safeParse(row.job_id).success);
  requireShape(RunIdSchema.safeParse(row.run_id).success);
  requireShape(row.status === "succeeded" || row.status === "failed");
  requireShape(
    row.exit_code === null || (finite(row.exit_code) && Number.isInteger(row.exit_code)),
  );
  requireShape(RunExitClassSchema.safeParse(row.exit_class).success);
  requireShape(row.exit_class !== "cancelled" && row.exit_class !== "lost");
  requireShape(!row.baseline || row.status === "succeeded");
  const reasons = strictObject(row.metric_reasons, SUMMARY_METRICS);
  strictObject(row.delta_reasons, SUMMARY_DELTAS);
  for (const field of SUMMARY_METRICS) {
    if (row.status === "failed")
      requireShape(row[field] === null && reasons[field] === "run_failed");
    else if (row[field] === null)
      requireShape(nonempty(reasons[field]) && reasons[field] !== "run_failed");
    else requireShape(finite(row[field]) && reasons[field] === null);
  }
  const verdict = row.water_balance_residual_verdict;
  if (row.status === "failed") requireShape(verdict === null);
  else if (row.water_balance_residual === null) requireShape(verdict === "not_available");
  else requireShape(verdict === "pass" || verdict === "warn" || verdict === "fail");
  for (const field of SUMMARY_DELTAS) requireShape(row[field] === null || finite(row[field]));
}

function validateSummary(value: unknown): asserts value is SensitivitySummary {
  const summary = strictObject(value, TOP_FIELDS);
  requireShape(summary.method_version === METRICS_METHOD_VERSION);
  requireShape(AnalysisPlanIdSchema.safeParse(summary.analysis_plan_id).success);
  requireShape(TaskIdSchema.safeParse(summary.task_id).success);
  requireShape(typeof summary.plan_sha256 === "string" && digestPattern.test(summary.plan_sha256));
  requireShape(typeof summary.project === "string" && isProjectComponent(summary.project));
  requireShape(
    finite(summary.end_days) && Number.isInteger(summary.end_days) && summary.end_days > 0,
  );
  requireShape(Array.isArray(summary.rows) && summary.rows.length >= 3 && summary.rows.length <= 5);
  summary.rows.forEach(validateRow);
  const rows = summary.rows as SensitivitySummaryRow[];
  const baselines = rows.filter((row) => row.baseline);
  requireShape(baselines.length === 1);
  const baseline = baselines[0];
  const jobs = new Set<string>();
  const runs = new Set<string>();
  const changes = new Set<string>();
  const claimIdentity = (jobId: string, runId: string) => {
    requireShape(!jobs.has(jobId) && !runs.has(runId));
    jobs.add(jobId);
    runs.add(runId);
  };
  for (const row of rows) {
    claimIdentity(row.job_id, row.run_id);
    if (!row.baseline) {
      const change = `${row.key}:${row.multiplier}`;
      requireShape(!changes.has(change));
      changes.add(change);
    }
    for (const [index, delta] of SUMMARY_DELTAS.entries()) {
      const metric = SUMMARY_METRICS[index];
      const reason = summaryDeltaReason(row, row[metric], baseline[metric], delta);
      requireShape(row.delta_reasons[delta] === reason);
      requireShape(reason === null ? finite(row[delta]) : row[delta] === null);
    }
  }
  requireShape(Array.isArray(summary.superseded_runs));
  for (const value of summary.superseded_runs) {
    const entry = strictObject(value, [
      "parameter_set_id",
      "job_id",
      "run_id",
      "terminal_state",
      "exit_class",
    ]);
    requireShape(rows.some((row) => row.parameter_set_id === entry.parameter_set_id));
    const job = JobRecordIdSchema.safeParse(entry.job_id);
    const run = RunIdSchema.safeParse(entry.run_id);
    requireShape(job.success && run.success);
    claimIdentity(job.data, run.data);
    requireShape(
      ["collected", "failed", "cancelled", "collect_exhausted"].includes(
        entry.terminal_state as string,
      ),
    );
    requireShape(
      entry.exit_class === null || RunExitClassSchema.safeParse(entry.exit_class).success,
    );
    requireShape(entry.terminal_state !== "collected" || entry.exit_class !== null);
  }
  requireShape(Array.isArray(summary.inputs));
  const successes = rows.filter((row) => row.status === "succeeded");
  requireShape(summary.inputs.length === successes.length);
  summary.inputs.forEach((value, index) => {
    const entry = strictObject(value, ["run_id", "metrics_sha256"]);
    requireShape(entry.run_id === successes[index].run_id);
    requireShape(
      typeof entry.metrics_sha256 === "string" && digestPattern.test(entry.metrics_sha256),
    );
  });
}

/** Strict records-owned wire boundary. Validate causes, never recompute stored deltas/verdicts. */
export function parseSensitivitySummary(value: unknown): SensitivitySummary {
  try {
    validateSummary(value);
    return value;
  } catch {
    throw new SensitivitySummaryError("schema");
  }
}

/** Fixed field order, native shortest-roundtrip numbers and one LF; no caller mutation. */
export function serializeSensitivitySummary(value: SensitivitySummary): string {
  const summary = parseSensitivitySummary(value);
  const rows = summary.rows.map((row) =>
    Object.fromEntries(
      ROW_FIELDS.map((field) => [
        field,
        field === "metric_reasons"
          ? Object.fromEntries(SUMMARY_METRICS.map((key) => [key, row.metric_reasons[key]]))
          : field === "delta_reasons"
            ? Object.fromEntries(SUMMARY_DELTAS.map((key) => [key, row.delta_reasons[key]]))
            : row[field],
      ]),
    ),
  );
  return (
    JSON.stringify({
      method_version: summary.method_version,
      analysis_plan_id: summary.analysis_plan_id,
      plan_sha256: summary.plan_sha256,
      task_id: summary.task_id,
      project: summary.project,
      end_days: summary.end_days,
      rows,
      superseded_runs: summary.superseded_runs.map(
        ({ parameter_set_id, job_id, run_id, terminal_state, exit_class }) => ({
          parameter_set_id,
          job_id,
          run_id,
          terminal_state,
          exit_class,
        }),
      ),
      inputs: summary.inputs.map(({ run_id, metrics_sha256 }) => ({ run_id, metrics_sha256 })),
    }) + "\n"
  );
}

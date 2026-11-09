import { expect, test } from "vitest";
import { MAX_COLLECT_ATTEMPTS } from "@shud-harness/dsh-shud-core";
import {
  buildSensitivitySummary,
  serializeSensitivitySummary,
  SensitivitySummaryError,
} from "./index.ts";
import { digest } from "./run-metrics-test-harness.ts";
import { failCell } from "./sensitivity-closure-test-harness.ts";
import {
  closeSummaryEvidence,
  summaryEvidence,
} from "./sensitivity-summary-closure-test-harness.ts";
import { makeRunJob } from "./task-lifecycle-test-harness.ts";

const metrics = ["peak_flow_m3d", "peak_day", "total_runoff_m3"] as const;
const deltas = ["delta_peak_flow_pct", "delta_peak_day", "delta_total_runoff_pct"] as const;

test("the flagged non-first baseline owns arithmetic while rows and inputs keep plan order", () => {
  const evidence = summaryEvidence();
  const [first, baseline] = evidence.input.plan.parameter_sets;
  first.baseline = false;
  first.changes = { GEOL_KSATH: 2 };
  baseline.baseline = true;
  baseline.changes = {};
  const firstMetrics = evidence.metrics.get(evidence.input.records[0].run_id)!;
  const baselineMetrics = evidence.metrics.get(evidence.input.records[1].run_id)!;
  firstMetrics.flow.peak_flow_m3d = 150;
  firstMetrics.flow.peak_day = 46;
  baselineMetrics.flow.peak_flow_m3d = 200;
  baselineMetrics.flow.peak_day = 44;
  const { closure, planBytes } = closeSummaryEvidence(evidence);
  const summary = buildSensitivitySummary(closure, planBytes);
  expect(summary.rows.map((row) => row.parameter_set_id)).toEqual([
    "PSET-1",
    "PSET-2",
    "PSET-3",
    "PSET-4",
  ]);
  expect(summary.rows[0]).toMatchObject({ delta_peak_flow_pct: -25, delta_peak_day: 2 });
  expect(summary.rows[1].delta_reasons).toEqual({
    delta_peak_flow_pct: "baseline_row",
    delta_peak_day: "baseline_row",
    delta_total_runoff_pct: "baseline_row",
  });
  expect(summary.inputs.map((entry) => entry.run_id)).toEqual(
    evidence.input.records.map((record) => record.run_id),
  );
});

test("zero baseline day is subtracted and fractional percentages retain shortest-roundtrip precision", () => {
  const evidence = summaryEvidence();
  const base = evidence.metrics.get(evidence.input.records[0].run_id)!;
  const row = evidence.metrics.get(evidence.input.records[1].run_id)!;
  base.flow.peak_day = 0;
  row.flow.peak_day = 3;
  base.flow.peak_flow_m3d = 3;
  row.flow.peak_flow_m3d = 4;
  const { closure, planBytes } = closeSummaryEvidence(evidence);
  const summary = buildSensitivitySummary(closure, planBytes);
  expect(summary.rows[1]).toMatchObject({
    delta_peak_day: 3,
    delta_peak_flow_pct: 33.33333333333333,
  });
  expect(summary.rows[1].delta_reasons.delta_peak_day).toBeNull();
  expect(serializeSensitivitySummary(summary)).toContain('"delta_peak_flow_pct":33.33333333333333');
});

for (const index of [0, 1, 2]) {
  test.each(["baseline", "perturbation"] as const)(
    `${metrics[index]} null on %s takes precedence over zero`,
    (side) => {
      const evidence = summaryEvidence();
      const base = evidence.metrics.get(evidence.input.records[0].run_id)!;
      const row = evidence.metrics.get(evidence.input.records[1].run_id)!;
      base.flow[metrics[index]] = 0;
      const operand = side === "baseline" ? base : row;
      operand.flow[metrics[index]] = null;
      operand.flow.reasons[metrics[index]] = "missing_output";
      const { closure, planBytes } = closeSummaryEvidence(evidence);
      const summary = buildSensitivitySummary(closure, planBytes);
      expect(summary.rows[1][deltas[index]]).toBeNull();
      expect(summary.rows[1].delta_reasons[deltas[index]]).toBe("metric_null");
      expect(summary.rows[0].delta_reasons[deltas[index]]).toBe("baseline_row");
      expect(summary.rows[side === "baseline" ? 0 : 1].metric_reasons[metrics[index]]).toBe(
        "missing_output",
      );
    },
  );
}

test.each([0, 2])("zero percentage baseline %s leaves other deltas computable", (index) => {
  const evidence = summaryEvidence();
  evidence.metrics.get(evidence.input.records[0].run_id)!.flow[metrics[index]] = 0;
  const { closure, planBytes } = closeSummaryEvidence(evidence);
  const row = buildSensitivitySummary(closure, planBytes).rows[1];
  expect(row[deltas[index]]).toBeNull();
  expect(row.delta_reasons[deltas[index]]).toBe("zero_baseline");
  expect(row.delta_peak_day).toBe(0);
  expect(row[deltas[index === 0 ? 2 : 0]]).toBe(0);
});

test("successful residual nulls preserve their loaded reason and not-available verdict", () => {
  const evidence = summaryEvidence();
  const metrics = evidence.metrics.get(evidence.input.records[1].run_id)!;
  metrics.water_balance.residual = null;
  metrics.water_balance.reasons.residual = "zero_precipitation";
  metrics.numerical_health.water_balance_residual = null;
  metrics.numerical_health.reasons.water_balance_residual = "zero_precipitation";
  metrics.verdicts.water_balance_residual = "not_available";
  const { closure, planBytes } = closeSummaryEvidence(evidence);
  expect(buildSensitivitySummary(closure, planBytes).rows[1]).toMatchObject({
    water_balance_residual: null,
    water_balance_residual_verdict: "not_available",
    metric_reasons: { water_balance_residual: "zero_precipitation" },
    delta_peak_day: 0,
  });
});

test.each(["percentage", "day"] as const)(
  "finite operands with overflowing %s reject without mutation",
  (kind) => {
    const evidence = summaryEvidence();
    const base = evidence.metrics.get(evidence.input.records[0].run_id)!;
    const row = evidence.metrics.get(evidence.input.records[1].run_id)!;
    if (kind === "percentage") {
      base.flow.peak_flow_m3d = Number.MIN_VALUE;
      row.flow.peak_flow_m3d = 1;
    } else {
      base.flow.peak_day = -Number.MAX_VALUE;
      row.flow.peak_day = Number.MAX_VALUE;
    }
    const { closure, planBytes } = closeSummaryEvidence(evidence);
    const before = structuredClone(closure);
    expect(() => buildSensitivitySummary(closure, planBytes)).toThrow(SensitivitySummaryError);
    try {
      buildSensitivitySummary(closure, planBytes);
    } catch (error) {
      expect(error).toMatchObject({ stage: "arithmetic" });
    }
    expect(closure).toStrictEqual(before);
  },
);

test("plan whitespace and object key order change the original-byte digest, not plan equivalence", () => {
  const { closure, planBytes } = closeSummaryEvidence(summaryEvidence());
  const original = buildSensitivitySummary(closure, planBytes);
  for (const bytes of [
    Buffer.from(JSON.stringify(closure.plan, null, 2) + "\n"),
    Buffer.from(
      JSON.stringify({
        ...closure.plan,
        input_digests: Object.fromEntries(Object.entries(closure.plan.input_digests).reverse()),
      }),
    ),
  ]) {
    const variant = buildSensitivitySummary(closure, bytes);
    expect(variant.plan_sha256).toBe(digest(bytes));
    expect(variant.plan_sha256).not.toBe(original.plan_sha256);
    expect({ ...variant, plan_sha256: original.plan_sha256 }).toEqual(original);
  }
});

test("superseded terminal facts retain card order and absent records without selecting again", () => {
  const evidence = summaryEvidence();
  const terminal = [
    ["cancelled", 0, "f004"],
    ["failed", 0, "f001"],
    ["succeeded", MAX_COLLECT_ATTEMPTS, "f003"],
  ] as const;
  for (const [status, attempts, suffix] of terminal) {
    const job = makeRunJob(`JOB-20261108T093000-${suffix}`, {
      task_id: evidence.input.plan.task_id,
      analysis_plan_id: evidence.input.plan.analysis_plan_id,
      parameter_set_id: "PSET-2",
      status,
    });
    evidence.input.runJobs.push({ job, collect_error_attempts: attempts });
    evidence.input.card.linked_jobs.push(job.job_id);
  }
  failCell(evidence.input, 2);
  const { closure, planBytes } = closeSummaryEvidence(evidence);
  expect(buildSensitivitySummary(closure, planBytes).superseded_runs).toEqual([
    {
      parameter_set_id: "PSET-2",
      job_id: "JOB-20261108T093000-f004",
      run_id: "RUN-20261108T093000-f004",
      terminal_state: "cancelled",
      exit_class: null,
    },
    {
      parameter_set_id: "PSET-2",
      job_id: "JOB-20261108T093000-f001",
      run_id: "RUN-20261108T093000-f001",
      terminal_state: "failed",
      exit_class: null,
    },
    {
      parameter_set_id: "PSET-2",
      job_id: "JOB-20261108T093000-f003",
      run_id: "RUN-20261108T093000-f003",
      terminal_state: "collect_exhausted",
      exit_class: null,
    },
  ]);
});

test.each(["task", "run", "pset", "plan", "metrics"] as const)(
  "foreign %s evidence rejects at the builder boundary",
  (kind) => {
    const { closure, planBytes } = closeSummaryEvidence(summaryEvidence());
    if (kind === "task") closure.selected[1].record.task_id = "TASK-20261102T090000-ffff";
    if (kind === "run") closure.selected[1].record.run_id = closure.selected[0].run_id;
    if (kind === "pset") closure.selected[1].record.parameter_set_id = "PSET-1";
    if (kind === "plan") closure.plan.project = "foreign";
    if (kind === "metrics") closure.selected[1].metrics!.flow.peak_day = Infinity;
    expect(() => buildSensitivitySummary(closure, planBytes)).toThrow(SensitivitySummaryError);
  },
);

test("schema-valid whitespace parameter labels survive summary derivation and serialization", () => {
  const evidence = summaryEvidence();
  evidence.input.plan.parameter_sets[1].label = " ";
  const { closure, planBytes } = closeSummaryEvidence(evidence);

  const summary = buildSensitivitySummary(closure, planBytes);

  expect(summary.rows[1].label).toBe(" ");
  expect(serializeSensitivitySummary(summary)).toContain('"label":" "');
});

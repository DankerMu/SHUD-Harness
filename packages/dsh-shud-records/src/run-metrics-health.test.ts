import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { METRICS_METHOD_VERSION } from "@shud-harness/dsh-shud-core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { computeRunMetrics } from "./run-metrics.ts";
import {
  datPath,
  makeMetricsRun,
  project,
  stateVariables,
  writeDat,
} from "./run-metrics-test-harness.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(`${tmpdir()}/run-metrics-health-`));
  makeMetricsRun(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("counts exact line-start solver signatures without serializing source log payload", () => {
  const privateLine = "private-solver-payload";
  writeFileSync(
    `${root}/stderr.log`,
    `SUNDIALS_ERROR:${privateLine}\r\n ordinary\n SUNDIALS_ERROR: ignored\n` +
      `prefix SUNDIALS_ERROR: ignored\nsundials_error: ignored\nSUNDIALS_ERROR:final`,
  );
  const { metrics, health } = computeRunMetrics(root, project);
  expect(metrics.method_version).toBe(METRICS_METHOD_VERSION);
  expect(health).toEqual({
    water_balance_residual: null,
    cvode_failures: 2,
    negative_state_count: 0,
    max_solver_dt: null,
  });
  expect(metrics.status).toBe("ok");
  expect(metrics.numerical_health.reasons).toEqual({
    water_balance_residual: "missing_variable:eleveta",
    cvode_failures: null,
    negative_state_count: null,
    max_solver_dt: "not_observable_in_pinned_shud",
  });
  expect(metrics.verdicts).toEqual({
    water_balance_residual: "not_available",
    cvode_failures: "fail",
    negative_state_count: "pass",
  });
  expect(JSON.stringify(metrics)).not.toContain(privateLine);
});

test("negative count covers every state cell but excludes tolerance, negative times and dates", () => {
  writeDat(root, "eleygw", {
    start_date: -100,
    columns: [8, 7],
    rows: [
      { t_min: -1440, values: [-1e-6, -1e-6] },
      { t_min: 0, values: [-1e-6, -1e-12] },
      { t_min: 1440, values: [-1e-10, 0] },
    ],
  });
  const { metrics, health } = computeRunMetrics(root, project);
  expect(health.negative_state_count).toBe(3);
  expect(metrics.numerical_health.negative_state_count).toBe(3);
  expect(metrics.numerical_health.negative_state_count_note).toBe("SHUD 静默钳零，该值为下界");
  expect(metrics.numerical_health.reasons.negative_state_count).toBeNull();
  expect(metrics.verdicts.negative_state_count).toBe("warn");
  expect(metrics.status).toBe("ok");
});

test.each(stateVariables)(
  "counts negative values in %s rather than only groundwater",
  (variable) => {
    writeDat(root, variable, { columns: [7], rows: [{ t_min: 0, values: [-1.0000001e-10] }] });
    expect(computeRunMetrics(root, project).health.negative_state_count).toBe(1);
  },
);

test.each([
  { count: 0, verdict: "pass" },
  { count: 1, verdict: "warn" },
  { count: 10, verdict: "warn" },
  { count: 11, verdict: "fail" },
])("negative count $count yields $verdict without changing status", ({ count, verdict }) => {
  writeDat(root, "eleysurf", {
    columns: [7],
    rows: Array.from({ length: count }, (_, t_min) => ({ t_min, values: [-1e-6] })),
  });
  const { metrics, health } = computeRunMetrics(root, project);
  expect(health.negative_state_count).toBe(count);
  expect(metrics.verdicts.negative_state_count).toBe(verdict);
  expect(metrics.status).toBe("ok");
});

test("missing rivystage never publishes a partial negative count", () => {
  writeDat(root, "eleygw", { columns: [1, 2], rows: [{ t_min: 0, values: [-1e-6, -1e-6] }] });
  unlinkSync(`${root}/${datPath("rivystage")}`);
  const { metrics, health } = computeRunMetrics(root, project);
  expect(health.negative_state_count).toBeNull();
  expect(metrics.numerical_health.reasons.negative_state_count).toBe("missing_variable:rivystage");
  expect(metrics.verdicts.negative_state_count).toBe("not_available");
  expect(metrics.status).toBe("ok");
});

test("keliya-shaped missing states keep flow available and select the code-point-first missing variable", () => {
  for (const variable of stateVariables) unlinkSync(`${root}/${datPath(variable)}`);
  const { metrics, health } = computeRunMetrics(root, project);
  expect(metrics.status).toBe("ok");
  expect(metrics.flow).toMatchObject({ peak_flow_m3d: 30, peak_day: 2, total_runoff_m3: 60 });
  expect(health.negative_state_count).toBeNull();
  expect(metrics.numerical_health.reasons.negative_state_count).toBe("missing_variable:eleygw");
  expect(metrics.inputs.map(({ path }) => path)).not.toContain(datPath("eleygw"));
});

test.each([
  { name: "value", start_date: 20000101, t_min: 0, value: NaN },
  { name: "time", start_date: 20000101, t_min: Infinity, value: -1e-6 },
  { name: "date", start_date: -Infinity, t_min: 0, value: -1e-6 },
])(
  "nonfinite state $name prevents a partial count and contributes to the raw tally",
  ({ start_date, t_min, value }) => {
    writeDat(root, "eleygw", { start_date, columns: [7], rows: [{ t_min, values: [value] }] });
    const { metrics, health } = computeRunMetrics(root, project);
    expect(metrics.status).toBe("ok");
    expect(health.negative_state_count).toBeNull();
    expect(metrics.numerical_health.reasons.negative_state_count).toBe("nonfinite:eleygw");
    expect(metrics.nonfinite_count).toBe(1);
  },
);

test("missing state takes precedence over nonfinite state, with no fabricated observed digest", () => {
  writeDat(root, "eleygw", { columns: [7], rows: [{ t_min: NaN, values: [NaN] }] });
  unlinkSync(`${root}/${datPath("rivystage")}`);
  const { metrics } = computeRunMetrics(root, project);
  expect(metrics.status).toBe("ok");
  expect(metrics.numerical_health.reasons.negative_state_count).toBe("missing_variable:rivystage");
  expect(metrics.nonfinite_count).toBe(2);
  expect(metrics.inputs.map(({ path }) => path)).toContain(datPath("eleygw"));
  expect(metrics.inputs.map(({ path }) => path)).not.toContain(datPath("rivystage"));
});

test("multiple nonfinite state files choose the code-point-first reason and retain every raw count", () => {
  for (const variable of ["rivystage", "eleygw"]) {
    writeDat(root, variable, { columns: [7], rows: [{ t_min: 0, values: [NaN] }] });
  }
  const { metrics } = computeRunMetrics(root, project);
  expect(metrics.numerical_health.reasons.negative_state_count).toBe("nonfinite:eleygw");
  expect(metrics.nonfinite_count).toBe(2);
});

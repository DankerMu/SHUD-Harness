import * as fs from "node:fs";
import { instantiateSensitivityCoverage } from "@shud-harness/dsh-shud-core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { deriveSensitivityLimitations, parseSensitivitySummary } from "./index.ts";
import {
  AUTHORED_LIMITATION,
  COVERAGE,
  MAX_SOLVER_DT,
  makeSensitivityWorkspace,
  PARAMETER_RANGE,
  PSET3_FAILED,
  RUN6_WARN,
  run,
  type SensitivityWorkspace,
} from "./report-sensitivity-test-harness.ts";

let workspace: SensitivityWorkspace;
beforeEach(() => {
  workspace = makeSensitivityWorkspace();
});
afterEach(() => fs.rmSync(workspace.root, { recursive: true, force: true }));

const summary = () => parseSensitivitySummary(JSON.parse(workspace.summaryBytes));
// Plan view of the same experiment: ccw, 90 days, ordered single-key perturbations.
const plan = {
  project: "ccw",
  end_days: 90,
  parameter_sets: [
    { baseline: true, changes: {} },
    { baseline: false, changes: { GEOL_KSATH: 0.5 } },
    { baseline: false, changes: { GEOL_KSATH: 2 } },
    { baseline: false, changes: { LC_ROUGH: 2 } },
  ],
};

test("summary-derived kinds 1, 2 and 5 use the exact literal wording", () => {
  expect(deriveSensitivityLimitations(summary())).toEqual({
    leading: [COVERAGE, PARAMETER_RANGE],
    trailing: [PSET3_FAILED],
  });
});

test("plan and summary instantiate one identical coverage sentence", () => {
  const fromSummary = deriveSensitivityLimitations(summary());
  const fromPlan = deriveSensitivityLimitations(summary(), plan);
  expect(fromPlan).toEqual(fromSummary);
  expect(instantiateSensitivityCoverage(plan)).toBe(fromSummary.leading[0]);
  expect(fromSummary.leading[0]).toBe(COVERAGE);
});

test("composition with literal kind 3/4 entries is ordered 1 to 5 with one max_solver_dt", () => {
  const { leading, trailing } = deriveSensitivityLimitations(summary());
  const limitations = [AUTHORED_LIMITATION, ...leading, MAX_SOLVER_DT, RUN6_WARN, ...trailing];
  expect(limitations).toEqual(workspace.report.limitations);
  expect(limitations.filter((entry) => entry === MAX_SOLVER_DT)).toHaveLength(1);
});

test("every failed row yields one failed-cell entry in rows order, including a null exit code", () => {
  const value = summary();
  const failed = value.rows[2];
  value.rows[3] = {
    ...value.rows[3],
    ...Object.fromEntries(
      ["peak_flow_m3d", "peak_day", "total_runoff_m3", "water_balance_residual"].map((key) => [
        key,
        null,
      ]),
    ),
    status: "failed",
    exit_code: null,
    exit_class: "signal",
  };
  expect(deriveSensitivityLimitations(value).trailing).toEqual([
    PSET3_FAILED,
    `参数集 PSET-4 的运行 ${run(6)} 失败（exit_code: null，exit_class: signal），该 cell 不参与相对 baseline 的比较`,
  ]);
  expect(failed.status).toBe("failed");
});

test("a summary without failed rows has no trailing entries", () => {
  const value = summary();
  value.rows = value.rows.filter((row) => row.status === "succeeded");
  expect(deriveSensitivityLimitations(value).trailing).toEqual([]);
  expect(deriveSensitivityLimitations(value).leading[0]).toBe(
    "仅在 ccw 单流域、90 天窗口、相对 baseline 测试了 GEOL_KSATH×0.5, LC_ROUGH×2；未覆盖其它参数、取值与窗口",
  );
});

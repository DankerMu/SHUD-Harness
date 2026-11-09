import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { renderReport, validateReport, type RunMetrics } from "./index.ts";
import { section } from "./report-code-change-test-harness.ts";
import {
  makeMetricReportWorkspace,
  type MetricReportWorkspace,
} from "./report-metrics-test-harness.ts";
import { completeMetrics, snapshotTree } from "./run-metrics-test-harness.ts";
import { realFs, SECRET } from "./report-validation-test-harness.ts";

let workspace: MetricReportWorkspace;
beforeEach(() => {
  workspace = makeMetricReportWorkspace();
});
afterEach(() => realFs.rmSync(workspace.root, { recursive: true, force: true }));

function metricRows() {
  return section(renderReport(workspace.cwd, workspace.fixture.report.report_id), 5)
    .split("\n")
    .slice(2)
    .map((line) => line.split(" | ").map((cell) => cell.replace(/^\| | \|$/gu, "")));
}

test("section 5 keeps run order and displays stored values, three verdicts and bound sources", () => {
  const first = workspace.publishMetrics(0);
  const metrics = completeMetrics();
  metrics.flow.peak_flow_m3d = 1.2345678901234567;
  metrics.flow.peak_day = -0;
  metrics.flow.total_runoff_m3 = 1e-7;
  const second = workspace.publishMetrics(1, metrics);
  const before = snapshotTree(workspace.root);
  expect(metricRows()).toEqual([
    [
      "RUN-20261029T080000-b002",
      "ok",
      "30",
      "2",
      "60",
      "0.01",
      "2",
      "3",
      "null (not_observable_in_pinned_shud)",
      "pass",
      "fail",
      "warn",
      "runs/RUN-20261029T080000-b002/metrics.json",
      first.sha256,
    ],
    [
      "RUN-20261029T080000-a001",
      "ok",
      "1.2345678901234567",
      "0",
      "1e-7",
      "0.01",
      "2",
      "3",
      "null (not_observable_in_pinned_shud)",
      "pass",
      "fail",
      "warn",
      "runs/RUN-20261029T080000-a001/metrics.json",
      second.sha256,
    ],
  ]);
  expect(section(renderReport(workspace.cwd, workspace.fixture.report.report_id), 5)).not.toContain(
    "max_solver_dt verdict",
  );
  expect(snapshotTree(workspace.root)).toEqual(before);
});

test("absent references do not read even unsafe metrics targets and display not_available cells", () => {
  for (const run of workspace.fixture.runs) {
    realFs.symlinkSync(
      "/not-opened/report-metrics",
      join(workspace.cwd, "runs", run.run_id, "metrics.json"),
    );
  }
  const before = snapshotTree(workspace.root);
  expect(metricRows()).toEqual([
    ["RUN-20261029T080000-b002", ...Array<string>(13).fill("not_available")],
    ["RUN-20261029T080000-a001", ...Array<string>(13).fill("not_available")],
  ]);
  expect(snapshotTree(workspace.root)).toEqual(before);
});

test("unavailable artifacts retain stored null reasons and verdicts rather than absent-reference cells", () => {
  const metrics: RunMetrics = completeMetrics();
  metrics.status = "unavailable";
  metrics.reason = "missing_variable:rivqdown";
  for (const block of [metrics.flow, metrics.water_balance, metrics.numerical_health]) {
    for (const field of Object.keys(block.reasons)) {
      Object.assign(block, { [field]: null });
      Object.assign(block.reasons, { [field]: "missing|value\n{{summary}}" });
    }
  }
  metrics.numerical_health.reasons.max_solver_dt = "not_observable_in_pinned_shud";
  metrics.verdicts = {
    water_balance_residual: "not_available",
    cvode_failures: "not_available",
    negative_state_count: "not_available",
  };
  const source = workspace.publishMetrics(0, metrics);
  expect(metricRows()[0]).toEqual([
    "RUN-20261029T080000-b002",
    "unavailable",
    ...Array<string>(6).fill("null (missing&#124;value&#10;{{summary}})"),
    "null (not_observable_in_pinned_shud)",
    "not_available",
    "not_available",
    "not_available",
    source.relativePath,
    source.sha256,
  ]);
});

test("each public render and validation projection consumes fresh digest-bound metric bytes", () => {
  workspace.publishMetrics(0);
  expect(metricRows()[0]?.[2]).toBe("30");
  const metrics = completeMetrics();
  metrics.flow.peak_flow_m3d = 987.654;
  workspace.publishMetrics(0, metrics);
  expect(metricRows()[0]?.[2]).toBe("987.654");
  const before = snapshotTree(workspace.root);
  const validation = validateReport(workspace.cwd, workspace.fixture.report.report_id);
  expect(validation.checks).toHaveLength(15);
  expect(validation.checks.find(({ id }) => id === 8)?.pass).toBe(true);
  expect(snapshotTree(workspace.root)).toEqual(before);
});

test("metric reasons remain escaped section-5 metadata and participate in the existing secret check", () => {
  const metrics: RunMetrics = completeMetrics();
  metrics.numerical_health.cvode_failures = null;
  metrics.numerical_health.reasons.cvode_failures = `${SECRET}|\n## 6. {{summary}}`;
  metrics.verdicts.cvode_failures = "not_available";
  workspace.publishMetrics(0, metrics);
  expect(metricRows()[0]?.[6]).toBe(`null (${SECRET}&#124;&#10;## 6. {{summary}})`);
  const validation = validateReport(workspace.cwd, workspace.fixture.report.report_id);
  expect(validation.checks).toHaveLength(15);
  expect(validation.checks.find(({ id }) => id === 13)).toMatchObject({
    pass: false,
    details: [{ code: "secret_detected", section: 5 }],
  });
});

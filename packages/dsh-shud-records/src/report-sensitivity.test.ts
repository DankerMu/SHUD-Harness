import * as fs from "node:fs";
import { CODE_CHANGE_SECTION5_WORDING } from "@shud-harness/dsh-shud-core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readReferencedSensitivitySummary, renderReport, ReportRenderError } from "./index.ts";
import { section } from "./report-code-change-test-harness.ts";
import { readReportInput, readReportMetricFacts, readReportRun } from "./report-inputs.ts";
import { renderReportDocument } from "./report-render.ts";
import {
  job,
  makeSensitivityWorkspace,
  run,
  type SensitivityWorkspace,
} from "./report-sensitivity-test-harness.ts";
import { digest, snapshotTree } from "./run-metrics-test-harness.ts";

const HEADINGS = [
  "## 1. 摘要",
  "## 2. 任务与问题",
  "## 3. StackLock 与数据来源",
  "## 4. 运行记录",
  "## 5. 指标与图表",
  "## 6. 观测与解释限制",
  "## 7. 风险和失败项",
  "## 8. 需要 PI 判断的问题",
  "## 9. 建议下一步",
  "## 10. 附录：命令、日志、artifact manifest",
];

let workspace: SensitivityWorkspace;
beforeEach(() => {
  workspace = makeSensitivityWorkspace();
});
afterEach(() => fs.rmSync(workspace.root, { recursive: true, force: true }));

function render(): string {
  const before = snapshotTree(workspace.root);
  const markdown = renderReport(workspace.cwd, workspace.report.report_id);
  expect(snapshotTree(workspace.root)).toEqual(before);
  return markdown;
}

/** Independently authored delta segment oracle for the hand-written companion bytes. */
function expectedDeltaSegment(): string {
  const header = [
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
    "peak_flow_m3d",
    "peak_day",
    "total_runoff_m3",
    "water_balance_residual",
    "water_balance_residual verdict",
    "delta_peak_flow_pct",
    "delta_peak_day",
    "delta_total_runoff_pct",
  ];
  const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  const failed = "null (run_failed)";
  return [
    "### Sensitivity summary",
    "",
    `- path: ${workspace.summaryRelative}`,
    `- sha256: ${digest(workspace.summaryBytes)}`,
    "",
    row(header),
    row(header.map(() => "---")),
    row([
      "PSET-1",
      "baseline",
      "true",
      "null",
      "null",
      job(1),
      run(1),
      "succeeded",
      "0",
      "ok",
      "185185.18349999998",
      "40",
      "0",
      "0.004",
      "pass",
      "null (baseline_row)",
      "null (baseline_row)",
      "null (baseline_row)",
    ]),
    row([
      "PSET-2",
      "half&#124;KSATH",
      "false",
      "GEOL_KSATH",
      "0.5",
      job(5),
      run(5),
      "succeeded",
      "0",
      "ok",
      "123456.789",
      "43",
      "52.5",
      "0.0008",
      "pass",
      "-33.33333333333333",
      "3",
      "null (zero_baseline)",
    ]),
    row([
      "PSET-3",
      "null",
      "false",
      "GEOL_KSATH",
      "2",
      job(4),
      run(4),
      "failed",
      "19",
      "cvode",
      failed,
      failed,
      failed,
      failed,
      "null",
      failed,
      failed,
      failed,
    ]),
    row([
      "PSET-4",
      "null",
      "false",
      "LC_ROUGH",
      "2",
      job(6),
      run(6),
      "succeeded",
      "0",
      "ok",
      "210000.5",
      "null (no_rising_limb)",
      "1.5e-7",
      "0.02",
      "warn",
      "13.400271031942475",
      "null (metric_null)",
      "null (zero_baseline)",
    ]),
  ].join("\n");
}

test("fixture companion is a valid digest-bound summary for the report", () => {
  const summary = readReferencedSensitivitySummary(workspace.cwd, workspace.report);
  expect(summary?.rows.map((row) => row.parameter_set_id)).toEqual([
    "PSET-1",
    "PSET-2",
    "PSET-3",
    "PSET-4",
  ]);
});

test("sensitivity report matches the reviewed golden without publishing", () => {
  const golden = fs.readFileSync(
    new URL("./report-sensitivity.golden.md", import.meta.url),
    "utf8",
  );
  expect(render()).toBe(golden);
});

test("ten headings in order; section 5 is per-run metrics then the delta segment", () => {
  const markdown = render();
  let cursor = 0;
  for (const heading of HEADINGS) {
    const index = markdown.indexOf(`\n${heading}\n`, cursor);
    expect(index, heading).toBeGreaterThan(cursor - 1);
    cursor = index + heading.length;
  }
  const metrics = section(markdown, 5);
  const [perRun, delta] = metrics.split("\n\n### Sensitivity summary");
  expect(perRun.startsWith("| Run | Metrics status |")).toBe(true);
  for (const value of workspace.runs) expect(perRun).toContain(`| ${value.run_id} |`);
  expect(`### Sensitivity summary${delta}`).toBe(expectedDeltaSegment());
  expect(markdown).not.toContain(CODE_CHANGE_SECTION5_WORDING);
});

test("delta cells are stored shortest round-trip strings, never rounded or reformatted", () => {
  const metrics = section(render(), 5);
  const cells = metrics
    .split("\n")
    .filter((line) => line.startsWith("| PSET-2 |"))
    .flatMap((line) => line.split("|").map((cell) => cell.trim()));
  expect(cells).toContain("-33.33333333333333");
  expect(cells).not.toContain("-33.33");
  expect(cells).toContain("null (zero_baseline)");
  for (const literal of ["0.0008", "123456.789", "1.5e-7", "185185.18349999998"]) {
    expect(metrics).toContain(literal);
  }
  for (const reformatted of ["8e-4", "123,456.789", "0.00000015", "185185.18", "-33.3%"]) {
    expect(metrics).not.toContain(` ${reformatted} `);
  }
});

test("delta segment states no ranking, index or interpretation", () => {
  const delta = section(render(), 5).split("### Sensitivity summary")[1];
  for (const forbidden of [/rank/iu, /index/iu, /elastic/iu, /排名/u, /指数/u, /弹性/u, /解释/u]) {
    expect(delta).not.toMatch(forbidden);
  }
});

test("section 7 merges failed RunRecords and RunRecord-less superseded jobs by job_id", () => {
  const risks = section(render(), 7);
  expect(risks).toBe(
    [
      `- ${run(2)}: cvode`,
      `- ${run(3)}: no RunRecord (job_id: ${job(3)}, terminal_state: cancelled)`,
      `- ${run(4)}: cvode`,
    ].join("\n"),
  );
  expect(risks.split(run(2)).length - 1).toBe(1);
});

test("section 7 order follows job_id code points, not linked_runs order", () => {
  const reversed = {
    ...workspace.report,
    linked_runs: [...workspace.report.linked_runs].reverse(),
  };
  workspace.publishReport(reversed);
  const risks = section(renderReport(workspace.cwd, reversed.report_id), 7);
  expect(risks.split("\n").map((line) => line.slice(2, 26))).toEqual([run(2), run(3), run(4)]);
});

function pureInputs() {
  const report = readReportInput(workspace.cwd, "report", workspace.report.report_id);
  const runs = report.linked_runs.map((id) => readReportRun(workspace.cwd, id));
  return {
    report,
    stacks: report.stack_ids.map((id) => readReportInput(workspace.cwd, "stack", id)),
    data: report.data_ids.map((id) => readReportInput(workspace.cwd, "data", id)),
    runs,
    metrics: readReportMetricFacts(workspace.cwd, runs),
  };
}

test("pure projection fails loud when a referenced summary is not supplied", () => {
  const { report, stacks, data, runs, metrics } = pureInputs();
  const facts = { changes: [], verifications: [] };
  let failure: unknown;
  try {
    renderReportDocument(report, stacks, data, runs, facts, metrics);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ReportRenderError);
  expect(failure).toMatchObject({ path: workspace.summaryRelative });
  const summary = readReferencedSensitivitySummary(workspace.cwd, report);
  expect(
    renderReportDocument(report, stacks, data, runs, facts, metrics, undefined, summary).markdown,
  ).toBe(render());
});

test("pure projection rejects a supplied summary for a report without a companion", () => {
  const { report, stacks, data, runs, metrics } = pureInputs();
  const summary = readReferencedSensitivitySummary(workspace.cwd, report);
  const plain = { ...report, analysis_ids: [], sensitivity_summary: null };
  const facts = { changes: [], verifications: [] };
  expect(() =>
    renderReportDocument(plain, stacks, data, runs, facts, metrics, undefined, summary),
  ).toThrow(ReportRenderError);
  const markdown = renderReportDocument(plain, stacks, data, runs, facts, metrics).markdown;
  expect(markdown).not.toContain("### Sensitivity summary");
  expect(section(markdown, 7)).toBe(`- ${run(2)}: cvode\n- ${run(4)}: cvode`);
});

import * as fs from "node:fs";
import { join } from "node:path";
import { EvidenceReportSchema, type EvidenceReport } from "@shud-harness/dsh-shud-core";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  applyDecision,
  markReportReviewed,
  parseSensitivitySummary,
  readReferencedSensitivitySummary,
  renderReport,
  ReportRenderError,
  validateReport,
  writeReportMarkdown,
  writeWorkspaceRecord,
} from "./index.ts";
import {
  makeValidationWorkspace,
  type ValidationWorkspace,
} from "./report-validation-test-harness.ts";
import { digest } from "./run-metrics-test-harness.ts";
import {
  EXPECTED_SUMMARY_BYTES,
  EXPECTED_SUMMARY_SHA256,
} from "./sensitivity-summary-test-harness.ts";
import { makeRunJob, makeRunRecord } from "./task-lifecycle-test-harness.ts";
import { makeReportDecision } from "./report-render-test-harness.ts";

let workspace: ValidationWorkspace;
let report: EvidenceReport;
let summaryPath: string;
let reportPath: string;
beforeEach(() => {
  workspace = makeValidationWorkspace();
  const summary = parseSensitivitySummary(JSON.parse(EXPECTED_SUMMARY_BYTES));
  const relative = `reports/${workspace.fixture.report.report_id}.sensitivity.json`;
  summaryPath = join(workspace.cwd, relative);
  reportPath = join(workspace.cwd, workspace.reportPath);
  const runs = summary.rows.map((row) =>
    makeRunRecord(makeRunJob(row.job_id), {
      run_id: row.run_id,
      task_id: summary.task_id,
      analysis_plan_id: summary.analysis_plan_id,
      parameter_set_id: row.parameter_set_id,
      stack_id: workspace.fixture.stacks[0].stack_id,
      data_id: workspace.fixture.data[0].data_id,
      status: row.status,
      exit_code: row.exit_code,
      exit_class: row.exit_class,
    }),
  );
  for (const run of runs) workspace.publish(`runs/${run.run_id}/run-record.json`, run);
  report = EvidenceReportSchema.parse({
    ...workspace.fixture.report,
    task_id: summary.task_id,
    linked_runs: runs.map((run) => run.run_id),
    analysis_ids: [summary.analysis_plan_id],
    sensitivity_summary: { path: relative, sha256: EXPECTED_SUMMARY_SHA256 },
    // Literal kinds 1/2 for this companion so the intact report also passes item 16.
    limitations: [
      ...workspace.fixture.report.limitations,
      "仅在 ccw 单流域、90 天窗口、相对 baseline 测试了 GEOL_KSATH×2, LC_ROUGH×2；未覆盖其它参数、取值与窗口",
      "参数范围为 agent 建议值，未经 PI 确认",
    ],
  });
  workspace.publish(workspace.reportPath, report);
  fs.writeFileSync(summaryPath, EXPECTED_SUMMARY_BYTES);
});
afterEach(() => fs.rmSync(workspace.root, { recursive: true, force: true }));

function reportSnapshot() {
  return {
    bytes: fs.readFileSync(reportPath),
    mtimeNs: fs.statSync(reportPath, { bigint: true }).mtimeNs,
  };
}

test.each(["delete", "tamper", "symlink", "directory"] as const)(
  "each render rejects %s of the summary, then accepts exact-byte restoration",
  (change) => {
    const before = reportSnapshot();
    const markdown = renderReport(workspace.cwd, report.report_id);
    expect(readReferencedSensitivitySummary(workspace.cwd, report)).toEqual(
      JSON.parse(EXPECTED_SUMMARY_BYTES),
    );
    const outside = join(workspace.root, "summary-target.json");
    fs.writeFileSync(outside, EXPECTED_SUMMARY_BYTES);
    const targetMtime = fs.statSync(outside, { bigint: true }).mtimeNs;
    fs.unlinkSync(summaryPath);
    if (change === "tamper") fs.writeFileSync(summaryPath, EXPECTED_SUMMARY_BYTES + " ");
    if (change === "symlink") fs.symlinkSync(outside, summaryPath);
    if (change === "directory") fs.mkdirSync(summaryPath);
    let failure: unknown;
    try {
      renderReport(workspace.cwd, report.report_id);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ReportRenderError);
    expect(failure).toMatchObject({ path: report.sensitivity_summary!.path });
    expect(reportSnapshot()).toEqual(before);
    if (change === "delete") expect(fs.existsSync(summaryPath)).toBe(false);
    if (change === "tamper")
      expect(fs.readFileSync(summaryPath, "utf8")).toBe(EXPECTED_SUMMARY_BYTES + " ");
    if (change === "symlink") expect(fs.readlinkSync(summaryPath)).toBe(outside);
    if (change === "directory") expect(fs.lstatSync(summaryPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe(EXPECTED_SUMMARY_BYTES);
    expect(fs.statSync(outside, { bigint: true }).mtimeNs).toBe(targetMtime);
    fs.rmSync(summaryPath, { force: true, recursive: change === "directory" });
    fs.writeFileSync(summaryPath, EXPECTED_SUMMARY_BYTES);
    expect(renderReport(workspace.cwd, report.report_id)).toBe(markdown);
    expect(reportSnapshot()).toEqual(before);
  },
);

test.each(["delete", "tamper", "symlink"] as const)(
  "validator's separate projection rejects %s in all seventeen checks without repairing files",
  (change) => {
    const before = reportSnapshot();
    const outside = join(workspace.root, "validator-target.json");
    fs.writeFileSync(outside, EXPECTED_SUMMARY_BYTES);
    const targetMtime = fs.statSync(outside, { bigint: true }).mtimeNs;
    fs.unlinkSync(summaryPath);
    if (change === "tamper") fs.writeFileSync(summaryPath, EXPECTED_SUMMARY_BYTES + " ");
    if (change === "symlink") fs.symlinkSync(outside, summaryPath);
    const result = validateReport(workspace.cwd, report.report_id);
    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => check.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
    expect(result.checks.flatMap((check) => check.details)).toContainEqual({
      code: "render_unavailable",
      stage: change === "delete" ? "missing" : change === "tamper" ? "identity" : "target",
    });
    expect(reportSnapshot()).toEqual(before);
    if (change === "delete") expect(fs.existsSync(summaryPath)).toBe(false);
    if (change === "tamper")
      expect(fs.readFileSync(summaryPath, "utf8")).toBe(EXPECTED_SUMMARY_BYTES + " ");
    if (change === "symlink") expect(fs.readlinkSync(summaryPath)).toBe(outside);
    expect(fs.readFileSync(outside, "utf8")).toBe(EXPECTED_SUMMARY_BYTES);
    expect(fs.statSync(outside, { bigint: true }).mtimeNs).toBe(targetMtime);
  },
);

test.each(["json", "shape", "task", "analysis", "run"] as const)(
  "digest-matching %s corruption is rejected without rewriting its bytes",
  (kind) => {
    const summary = parseSensitivitySummary(JSON.parse(EXPECTED_SUMMARY_BYTES));
    if (kind === "shape") Object.assign(summary, { interpretation: "private-summary-payload" });
    if (kind === "task") Object.assign(summary, { task_id: "TASK-20261102T090000-ffff" });
    if (kind === "analysis")
      Object.assign(summary, { analysis_plan_id: "PLAN-20261108T093000-ffff" });
    if (kind === "run") {
      Object.assign(summary.rows[1], { run_id: "RUN-20261108T093000-ffff" });
      Object.assign(summary.inputs[1], { run_id: "RUN-20261108T093000-ffff" });
    }
    const bytes = kind === "json" ? "private-summary-payload" : JSON.stringify(summary);
    fs.writeFileSync(summaryPath, bytes);
    report.sensitivity_summary!.sha256 = digest(bytes);
    workspace.publish(workspace.reportPath, report);
    const before = reportSnapshot();
    const mtimeNs = fs.statSync(summaryPath, { bigint: true }).mtimeNs;
    let failure: unknown;
    try {
      readReferencedSensitivitySummary(workspace.cwd, report);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ReportRenderError);
    expect(failure).toMatchObject({
      path: report.sensitivity_summary!.path,
      stage: kind === "json" ? "parse" : "schema",
    });
    expect(String(failure)).not.toContain("private-summary-payload");
    expect(reportSnapshot()).toEqual(before);
    expect(fs.readFileSync(summaryPath, "utf8")).toBe(bytes);
    expect(fs.statSync(summaryPath, { bigint: true }).mtimeNs).toBe(mtimeNs);
  },
);

test("readonly summary resolution uses the physical cwd and rejects a symlinked reports root", () => {
  const physical = fs.realpathSync.native(workspace.cwd);
  fs.mkdirSync(join(physical, "child"));
  const alias = join(workspace.root, "alias");
  fs.symlinkSync(join(physical, "child"), alias);
  expect(readReferencedSensitivitySummary(`${alias}/..`, report)).toEqual(
    JSON.parse(EXPECTED_SUMMARY_BYTES),
  );
  const outside = join(workspace.root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(join(physical, "reports"), join(outside, "reports"));
  expect(() => readReferencedSensitivitySummary(outside, report)).toThrow(ReportRenderError);
});

test("null summary skips filesystem access even when the workspace does not exist", () => {
  const missing = join(workspace.root, "absent");
  expect(readReferencedSensitivitySummary(missing, workspace.fixture.report)).toBeNull();
  expect(fs.existsSync(missing)).toBe(false);
});

test("validation and reviewed/accepted publication preserve companion bytes and nanosecond mtime", async () => {
  const summaryBytes = fs.readFileSync(summaryPath);
  const summaryMtime = fs.statSync(summaryPath, { bigint: true }).mtimeNs;
  await writeReportMarkdown(
    workspace.cwd,
    report.report_id,
    renderReport(workspace.cwd, report.report_id),
  );
  expect(validateReport(workspace.cwd, report.report_id).ok).toBe(true);
  const reviewed = markReportReviewed(report, new Date("2026-11-09T08:01:00Z"));
  writeWorkspaceRecord(workspace.cwd, "report", reviewed);
  await writeReportMarkdown(
    workspace.cwd,
    report.report_id,
    renderReport(workspace.cwd, report.report_id),
  );
  expect(fs.readFileSync(summaryPath)).toEqual(summaryBytes);
  expect(fs.statSync(summaryPath, { bigint: true }).mtimeNs).toBe(summaryMtime);

  const accepted = applyDecision(
    reviewed,
    makeReportDecision("accepted", { report_id: report.report_id }),
    new Date("2026-11-09T08:02:00Z"),
  );
  writeWorkspaceRecord(workspace.cwd, "report", accepted);
  await writeReportMarkdown(
    workspace.cwd,
    report.report_id,
    renderReport(workspace.cwd, report.report_id),
  );
  expect(fs.readFileSync(summaryPath)).toEqual(summaryBytes);
  expect(fs.statSync(summaryPath, { bigint: true }).mtimeNs).toBe(summaryMtime);
  expect(readReferencedSensitivitySummary(workspace.cwd, accepted)).toEqual(
    JSON.parse(EXPECTED_SUMMARY_BYTES),
  );
});

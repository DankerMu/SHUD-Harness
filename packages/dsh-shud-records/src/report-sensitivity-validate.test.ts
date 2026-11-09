import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  markReportReviewed,
  parseSensitivitySummary,
  renderReport,
  validateReport,
  writeReportMarkdown,
  writeWorkspaceRecord,
  type ReportValidationCheck,
} from "./index.ts";
import {
  COVERAGE,
  makeSensitivityWorkspace,
  PARAMETER_RANGE,
  type SensitivityWorkspace,
} from "./report-sensitivity-test-harness.ts";
import { digest, snapshotTree } from "./run-metrics-test-harness.ts";

let workspace: SensitivityWorkspace;
beforeEach(() => {
  workspace = makeSensitivityWorkspace();
});
afterEach(() => fs.rmSync(workspace.root, { recursive: true, force: true }));

const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

function validateUnchanged() {
  const before = snapshotTree(workspace.root);
  const result = validateReport(workspace.cwd, workspace.report.report_id);
  expect(snapshotTree(workspace.root)).toEqual(before);
  expect(result.checks.map((check) => check.id)).toEqual(ids);
  expect(result.ok).toBe(false);
  return result;
}

const failing = (checks: readonly ReportValidationCheck[]) =>
  checks.filter((check) => !check.pass).map(({ id, details }) => ({ id, details }));

test("intact sensitivity draft passes the reviewed seventeen-check golden", async () => {
  const golden: unknown = JSON.parse(
    fs.readFileSync(
      new URL("./report-sensitivity-validation.golden.json", import.meta.url),
      "utf8",
    ),
  );
  const summaryBefore = fs.statSync(workspace.summaryPath, { bigint: true });
  const result = validateReport(workspace.cwd, workspace.report.report_id);
  expect(result).toEqual(golden);
  expect(result.ok).toBe(true);
  expect(result.checks[15]).toEqual({ id: 16, pass: true, vacuous: false, details: [] });
  expect(result.checks[16]).toEqual({ id: 17, pass: true, vacuous: false, details: [] });
  const reviewed = markReportReviewed(workspace.report, new Date("2026-11-09T08:00:00Z"));
  writeWorkspaceRecord(workspace.cwd, "report", reviewed);
  await writeReportMarkdown(
    workspace.cwd,
    reviewed.report_id,
    renderReport(workspace.cwd, reviewed.report_id),
  );
  expect(reviewed.status).toBe("reviewed");
  expect(fs.readFileSync(workspace.summaryPath, "utf8")).toBe(workspace.summaryBytes);
  expect(fs.statSync(workspace.summaryPath, { bigint: true }).mtimeNs).toBe(summaryBefore.mtimeNs);
});

test.each([
  ["coverage", [COVERAGE]],
  ["parameter_range", [PARAMETER_RANGE]],
  ["both", [COVERAGE, PARAMETER_RANGE]],
] as const)("rewritten limitations missing %s fail item 16 naming the sentence", (_, removed) => {
  workspace.publishReport({
    ...workspace.report,
    limitations: workspace.report.limitations.filter(
      (entry) => !(removed as readonly string[]).includes(entry),
    ),
  });
  const result = validateUnchanged();
  expect(failing(result.checks)).toEqual([
    {
      id: 16,
      details: removed.map((sentence) => ({
        code: "sensitivity_statement_missing",
        statement: sentence === COVERAGE ? "coverage" : "parameter_range",
      })),
    },
  ]);
  expect(result.checks[16]).toEqual({ id: 17, pass: true, vacuous: false, details: [] });
});

test.each([
  ["delete", "missing"],
  ["symlink", "target"],
  ["rewrite", "identity"],
] as const)("%s of the summary fails item 17 naming its path, keeping bytes", (change, stage) => {
  const outside = join(workspace.root, "outside.sensitivity.json");
  fs.writeFileSync(outside, workspace.summaryBytes);
  fs.unlinkSync(workspace.summaryPath);
  if (change === "symlink") fs.symlinkSync(outside, workspace.summaryPath);
  if (change === "rewrite") {
    fs.writeFileSync(
      workspace.summaryPath,
      workspace.summaryBytes.replace('"end_days":90', '"end_days":91'),
    );
  }
  const result = validateUnchanged();
  const unavailable = [{ code: "render_unavailable", stage }];
  expect(failing(result.checks)).toEqual([
    { id: 8, details: unavailable },
    { id: 9, details: unavailable },
    { id: 12, details: unavailable },
    { id: 13, details: unavailable },
    { id: 16, details: unavailable },
    {
      id: 17,
      details: [{ code: "sensitivity_summary_invalid", path: workspace.summaryRelative, stage }],
    },
  ]);
  expect(fs.readFileSync(outside, "utf8")).toBe(workspace.summaryBytes);
});

test.each(["parse", "schema"] as const)(
  "digest-matching %s corruption fails item 16 as render-unavailable while item 17 passes",
  (stage) => {
    const summary = parseSensitivitySummary(JSON.parse(workspace.summaryBytes));
    const bytes =
      stage === "parse"
        ? "not json"
        : JSON.stringify({ ...summary, interpretation: "private-summary-payload" });
    fs.writeFileSync(workspace.summaryPath, bytes);
    workspace.publishReport({
      ...workspace.report,
      sensitivity_summary: { path: workspace.summaryRelative, sha256: digest(bytes) },
    });
    const result = validateUnchanged();
    const unavailable = [{ code: "render_unavailable", stage }];
    expect(failing(result.checks).map(({ id }) => id)).toEqual([8, 9, 12, 13, 16]);
    expect(result.checks[15].details).toEqual(unavailable);
    expect(result.checks[16]).toEqual({ id: 17, pass: true, vacuous: false, details: [] });
    expect(JSON.stringify(result)).not.toContain("private-summary-payload");
  },
);

test("item 17 is decided independently of an unrelated missing StackLock", () => {
  const stackPath = join(workspace.cwd, `stacks/${workspace.report.stack_ids[0]}.json`);
  fs.unlinkSync(stackPath);
  let result = validateUnchanged();
  expect(result.checks[0].pass).toBe(false);
  expect(result.checks[16]).toEqual({ id: 17, pass: true, vacuous: false, details: [] });
  fs.writeFileSync(workspace.summaryPath, `${workspace.summaryBytes} `);
  result = validateUnchanged();
  expect(result.checks[16]).toEqual({
    id: 17,
    pass: false,
    vacuous: false,
    details: [
      { code: "sensitivity_summary_invalid", path: workspace.summaryRelative, stage: "identity" },
    ],
  });
});

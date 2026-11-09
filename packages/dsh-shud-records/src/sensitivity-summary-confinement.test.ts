import * as fs from "node:fs";
import { join } from "node:path";
import { EvidenceReportSchema } from "@shud-harness/dsh-shud-core";
import { expect, test, vi } from "vitest";
import {
  parseSensitivitySummary,
  readReferencedSensitivitySummary,
  ReportRenderError,
} from "./index.ts";
import { makeValidationWorkspace } from "./report-validation-test-harness.ts";
import {
  EXPECTED_SUMMARY_BYTES,
  EXPECTED_SUMMARY_SHA256,
} from "./sensitivity-summary-test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    realpathSync: Object.assign(vi.fn(actual.realpathSync), {
      native: vi.fn(actual.realpathSync.native),
    }),
    openSync: vi.fn(actual.openSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");

test.each(["ordinary", "alias", "alias-parent"] as const)(
  "%s summary reading rejects persistent reports-root replacement before opening any file",
  (mode) => {
    vi.mocked(fs.realpathSync.native).mockReset().mockImplementation(native.realpathSync.native);
    vi.mocked(fs.openSync).mockReset().mockImplementation(native.openSync);
    const workspace = makeValidationWorkspace();
    try {
      const physical = native.realpathSync.native(workspace.cwd);
      const managed = join(physical, "reports");
      const held = join(physical, "held-reports");
      const outside = join(native.realpathSync.native(workspace.root), "outside");
      native.mkdirSync(outside);
      native.mkdirSync(join(physical, "child"));
      const alias = join(workspace.root, "alias");
      native.symlinkSync(mode === "alias-parent" ? join(physical, "child") : physical, alias);
      const cwd = mode === "ordinary" ? workspace.cwd : mode === "alias" ? alias : `${alias}/..`;
      const summary = parseSensitivitySummary(JSON.parse(EXPECTED_SUMMARY_BYTES));
      const filename = `${workspace.fixture.report.report_id}.sensitivity.json`;
      const relative = `reports/${filename}`;
      const report = EvidenceReportSchema.parse({
        ...workspace.fixture.report,
        task_id: summary.task_id,
        linked_runs: summary.rows.map((row) => row.run_id),
        analysis_ids: [summary.analysis_plan_id],
        sensitivity_summary: { path: relative, sha256: EXPECTED_SUMMARY_SHA256 },
      });
      workspace.publish(workspace.reportPath, report);
      native.writeFileSync(join(managed, filename), EXPECTED_SUMMARY_BYTES);
      native.writeFileSync(join(outside, filename), EXPECTED_SUMMARY_BYTES);
      const outsideMtime = native.statSync(join(outside, filename), { bigint: true }).mtimeNs;
      const reportBytes = native.readFileSync(join(physical, workspace.reportPath));
      const reportMtime = native.statSync(join(physical, workspace.reportPath), {
        bigint: true,
      }).mtimeNs;
      expect(readReferencedSensitivitySummary(cwd, report)).toEqual(summary);
      vi.mocked(fs.openSync).mockClear();

      let replaced = false;
      vi.mocked(fs.realpathSync.native).mockImplementation((...args) => {
        const resolved = native.realpathSync.native(...args);
        if (!replaced && String(resolved) === managed) {
          replaced = true;
          native.renameSync(managed, held);
          native.symlinkSync(outside, managed);
        }
        return resolved;
      });
      let failure: unknown;
      try {
        readReferencedSensitivitySummary(cwd, report);
      } catch (error) {
        failure = error;
      }

      expect(replaced).toBe(true);
      expect(failure).toBeInstanceOf(ReportRenderError);
      expect(failure).toMatchObject({ stage: "target", path: relative });
      expect(fs.openSync).not.toHaveBeenCalled();
      expect(native.readlinkSync(managed)).toBe(outside);
      expect(native.readFileSync(join(outside, filename), "utf8")).toBe(EXPECTED_SUMMARY_BYTES);
      expect(native.statSync(join(outside, filename), { bigint: true }).mtimeNs).toBe(outsideMtime);
      expect(native.readFileSync(join(held, filename), "utf8")).toBe(EXPECTED_SUMMARY_BYTES);
      expect(native.readFileSync(join(held, `${report.report_id}.json`))).toEqual(reportBytes);
      expect(
        native.statSync(join(held, `${report.report_id}.json`), { bigint: true }).mtimeNs,
      ).toBe(reportMtime);
    } finally {
      vi.mocked(fs.realpathSync.native).mockReset().mockImplementation(native.realpathSync.native);
      vi.mocked(fs.openSync).mockReset().mockImplementation(native.openSync);
      native.rmSync(workspace.root, { recursive: true, force: true });
    }
  },
);

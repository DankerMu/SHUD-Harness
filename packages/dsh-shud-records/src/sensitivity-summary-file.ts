import { dirname } from "node:path";
import { EvidenceReportSchema, type EvidenceReport } from "@shud-harness/dsh-shud-core";
import { ReportRenderError } from "./report-render-error.ts";
import { readShudInputFile, ShudInputError } from "./shud-input-file.ts";
import { parseSensitivitySummary } from "./sensitivity-summary-wire.ts";
import { SensitivitySummaryError, type SensitivitySummary } from "./sensitivity-summary-types.ts";
import { resolveManagedRoot } from "./workspace-paths.ts";

/**
 * Observe the immutable companion anew for each projection. The safe descriptor's bytes
 * own both digest and parse; no plan/metrics discovery, cache, rederivation or repair.
 * The physical workspace is the trusted base; reports remains a checked relative ancestor,
 * including when its previously inspected directory is persistently replaced by a symlink.
 * Null references incur no summary-content IO. Errors name only the validated reference.
 */
export function readReferencedSensitivitySummary(
  cwd: string,
  report: EvidenceReport,
): SensitivitySummary | null {
  if (report.sensitivity_summary === null) return null;
  const parsed = EvidenceReportSchema.safeParse(report);
  if (!parsed.success) throw new ReportRenderError("schema");
  const reference = parsed.data.sensitivity_summary!;
  const path = reference.path;
  let root: string | undefined;
  try {
    root = resolveManagedRoot(cwd, "reports", "Reports", true);
  } catch {
    throw new ReportRenderError("directory", path);
  }
  if (root === undefined) throw new ReportRenderError("missing", path);
  try {
    const observed = readShudInputFile(dirname(root), path);
    if (observed.sha256 !== reference.sha256) throw new ReportRenderError("identity", path);
    const value: unknown = JSON.parse(observed.bytes.toString("utf8"));
    const summary = parseSensitivitySummary(value);
    if (
      parsed.data.analysis_ids.length !== 1 ||
      summary.analysis_plan_id !== parsed.data.analysis_ids[0] ||
      summary.task_id !== parsed.data.task_id ||
      summary.rows.some((row) => !parsed.data.linked_runs.includes(row.run_id))
    )
      throw new ReportRenderError("identity", path);
    return summary;
  } catch (error) {
    if (error instanceof ReportRenderError) throw error;
    if (error instanceof ShudInputError) {
      throw new ReportRenderError(error.stage === "unsafe" ? "target" : error.stage, path);
    }
    throw new ReportRenderError(
      error instanceof SensitivitySummaryError ? "schema" : "parse",
      path,
    );
  }
}

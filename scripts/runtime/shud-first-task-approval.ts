import { join } from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import {
  EvidenceReportSchema,
  ReportIdSchema,
} from "../../packages/dsh-shud-core/src/schemas/index.ts";
import { approvalReport } from "./shud-first-task-evidence.ts";
import { object, requireFact } from "./shud-restart-evidence.ts";
import { load, type WebHost } from "./shud-web-driver.ts";
import { openOwnedApprovals } from "./shud-approval-transport.ts";

/** Preserve the M3 report-only predicate on the shared original-peer transport. */
export async function openReportApprovals(
  host: WebHost,
  sessionId: string,
  workspace: string,
  options: { label?: string; streamId?: string } = {},
) {
  return openOwnedApprovals(
    host,
    async (value, signal) => {
      let allowed = false;
      const request = object(value.request);
      if (
        value.event === "approval/request" &&
        value.agentId === sessionId &&
        request.toolName === "report_submit" &&
        typeof request.callId === "string"
      ) {
        const prefix = await host.prefix(sessionId, signal);
        const reportId = approvalReport(prefix, request.callId);
        if (
          ReportIdSchema.safeParse(reportId).success &&
          request.reason === `PI approval required for report ${reportId}`
        ) {
          const path = join(workspace, "reports", `${reportId}.json`);
          requireFact(
            realpathSync(path) === path && lstatSync(path).isFile(),
            "Unsafe report approval target",
          );
          const report = EvidenceReportSchema.parse(load(path));
          allowed =
            report.report_id === reportId &&
            report.status === "reviewed" &&
            report.decision_history.length === 0;
        }
      }
      return allowed;
    },
    { streamId: options.streamId ?? "first-task-approvals", label: options.label },
  );
}

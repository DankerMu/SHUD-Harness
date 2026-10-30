import { defineTool, ToolArgsError, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ReportIdSchema } from "@shud-harness/dsh-shud-core";
import {
  markReportReviewed,
  validateReport,
  writeWorkspaceRecord,
} from "@shud-harness/dsh-shud-records";
import {
  publishReportMarkdown,
  readReport,
  repairReportEntry,
  reportCwd,
} from "./report-workflow.ts";
import { strictTool } from "./strict-tool.ts";

const parameters = {
  report_id: {
    type: "string",
    required: true,
    description: "Workspace REPORT identifier; only a draft can become reviewed.",
  },
} as const;

export function createReportValidateTool(): ToolDefinition {
  const tool = defineTool({
    name: "report_validate",
    description:
      "Repair an identified report's task link and Markdown watermark, then run all thirteen canonical checks. Passing drafts become reviewed, never PI-accepted; failed checks remain useful structured output.",
    parameters,
    output: {
      // The canonical validator owns the evolving checks/details contract.
      schema: { type: "object", additionalProperties: true },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    async execute(args, exec) {
      const id = ReportIdSchema.safeParse(args.report_id);
      if (!id.success) throw new ToolArgsError(["Invalid report_id"]);
      const cwd = reportCwd(exec.agent?.session?.header?.cwd);
      await repairReportEntry(cwd, readReport(cwd, id.data));
      // Repairs are independent commits. After their awaits, the authoritative report is fresh.
      const report = readReport(cwd, id.data);
      if (report.status !== "draft") {
        throw new Error(`report_validate ${id.data}: requires draft, found ${report.status}`);
      }
      const result = validateReport(cwd, id.data);
      // The host's JsonValue contract is mutable; preserve every canonical check/detail
      // while adapting the validator's readonly containers at this output boundary.
      const checks = result.checks.map((check) => ({
        ...check,
        details: check.details.map((detail) => ({ ...detail })),
      }));
      if (!result.ok) {
        return { report_id: id.data, status: "draft" as const, ok: false, checks };
      }
      const reviewed = markReportReviewed(report);
      writeWorkspaceRecord(cwd, "report", reviewed);
      await publishReportMarkdown(cwd, id.data);
      return { report_id: id.data, status: "reviewed" as const, ok: true, checks };
    },
  });
  return strictTool(tool, parameters);
}

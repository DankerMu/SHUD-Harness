import { defineTool, ToolArgsError, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  createBrandedId,
  PiGateDecisionSchema,
  ReportIdSchema,
  type PiGateDecision,
} from "@shud-harness/dsh-shud-core";
import {
  applyDecision,
  ReportStateError,
  writeWorkspaceRecord,
} from "@shud-harness/dsh-shud-records";
import {
  publishReportDecisionTask,
  publishReportMarkdown,
  readReport,
  repairReportEntry,
  reportCwd,
  withReportOperation,
} from "./report-workflow.ts";
import { strictTool } from "./strict-tool.ts";

const submitParameters = {
  report_id: {
    type: "string",
    required: true,
    description: "Reviewed workspace REPORT identifier.",
  },
} as const;
const decideParameters = {
  ...submitParameters,
  disposition: {
    type: "string",
    enum: ["rejected", "revision_requested"],
    required: true,
    description: "Explicit PI disposition; never inferred from a denied approval card.",
  },
  comment: {
    type: "string",
    required: true,
    description:
      "Nonempty PI comment, preserved verbatim and confirmed on this call's approval card.",
  },
} as const;
const output = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      report_id: { type: "string", required: true },
      status: {
        type: "string",
        enum: ["accepted", "rejected", "revision_requested"],
        required: true,
      },
      decision_id: { type: "string", required: true },
    },
  },
  render(_args: unknown, value: unknown) {
    return [{ type: "text" as const, text: JSON.stringify(value) }];
  },
} as const;

/** Host policy/approval admits execution; this workflow neither asks nor reconstructs that authority. */
function executeDecision(
  reportId: unknown,
  workspace: unknown,
  callId: unknown,
  outcome: PiGateDecision["outcome"],
  comment: string | null,
) {
  const id = ReportIdSchema.safeParse(reportId);
  if (!id.success) throw new ToolArgsError(["Invalid report_id"]);
  const cwd = reportCwd(workspace);
  if (typeof callId !== "string" || callId.length === 0) {
    throw new Error(`Report ${id.data}: a nonempty execution callId is required`);
  }
  return withReportOperation(cwd, id.data, async () => {
    await repairReportEntry(cwd, readReport(cwd, id.data));
    // Entry Markdown IO can yield. The precondition and conversion use fresh authoritative JSON.
    const report = readReport(cwd, id.data);
    if (report.status !== "reviewed") {
      throw new Error(`Report ${id.data}: requires reviewed, found ${report.status}`);
    }
    if (report.decision_history.length !== 0) {
      throw new ReportStateError("inconsistent_decision_history");
    }
    const now = new Date();
    const decision = PiGateDecisionSchema.safeParse({
      decision_id: createBrandedId("DEC", now),
      report_id: id.data,
      approval_ref: callId,
      outcome,
      comment,
      decided_at: now.toISOString(),
    });
    if (!decision.success) throw new ReportStateError("invalid_decision");
    const decided = applyDecision(report, decision.data, now);
    // No await between reading/converting/committing report state, or inside fresh card publication.
    writeWorkspaceRecord(cwd, "report", decided);
    publishReportDecisionTask(cwd, decided, decision.data.outcome);
    await publishReportMarkdown(cwd, id.data);
    return {
      report_id: id.data,
      status: decision.data.outcome,
      decision_id: decision.data.decision_id,
    };
  });
}

export function createReportSubmitTool(): ToolDefinition {
  const tool = defineTool({
    name: "report_submit",
    description:
      "Submit a reviewed report for PI acceptance. Only this call's allowed-once approval publishes accepted, closes its task and refreshes Markdown; denied cards write no decision.",
    parameters: submitParameters,
    output,
    execute(args, exec) {
      return executeDecision(
        args.report_id,
        exec.agent?.session?.header?.cwd,
        exec.callId,
        "accepted",
        null,
      );
    },
  });
  return strictTool(tool, submitParameters);
}

export function createReportDecideTool(): ToolDefinition {
  const tool = defineTool({
    name: "report_decide",
    description:
      "Request PI confirmation of an explicit rejected or revision_requested disposition and the full original comment for a reviewed report. Never overrides a terminal report.",
    parameters: decideParameters,
    output,
    execute(args, exec) {
      if (args.disposition !== "rejected" && args.disposition !== "revision_requested") {
        throw new ToolArgsError(["disposition must be rejected or revision_requested"]);
      }
      if (args.comment.length === 0) throw new ToolArgsError(["comment must be nonempty"]);
      return executeDecision(
        args.report_id,
        exec.agent?.session?.header?.cwd,
        exec.callId,
        args.disposition,
        args.comment,
      );
    },
  });
  return strictTool(tool, decideParameters);
}

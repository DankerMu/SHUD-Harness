import { defineTool, ToolArgsError, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  DataIdSchema,
  StackIdSchema,
  TaskIdSchema,
  type RunRecord,
  type TaskId,
} from "@shud-harness/dsh-shud-core";
import type { ShudJobRegistry } from "@shud-harness/dsh-shud-jobs";
import {
  createEvidenceReport,
  evaluateClosure,
  reconcileTaskCard,
  transitionTask,
  writeWorkspaceRecord,
  type ClosureRunJob,
} from "@shud-harness/dsh-shud-records";
import { checkReportCitations, type AuthoredReport } from "./report-citations.ts";
import {
  publishReportMarkdown,
  readGeneratableTask,
  reportCwd,
  reportStepError,
  withReportOperation,
} from "./report-workflow.ts";
import { strictTool } from "./strict-tool.ts";

const parameters = {
  task_id: {
    type: "string",
    required: true,
    description: "Workspace science task with collected evidence.",
  },
  summary: {
    type: "string",
    required: true,
    description: "Nonempty authored summary, preserved verbatim.",
  },
  observations: { type: "array", items: { type: "string" }, required: true },
  limitations: { type: "array", items: { type: "string" }, required: true },
  pi_questions: { type: "array", items: { type: "string" }, required: true },
} as const;

async function generateReport(
  cwd: string,
  taskId: TaskId,
  authored: AuthoredReport,
  jobs: ShudJobRegistry,
) {
  // Reject before any reconciliation publication or creating workspace read.
  readGeneratableTask(cwd, taskId);
  checkReportCitations(cwd, jobs, authored);
  const taskJobs = await jobs.listRunJobsByTask(taskId);
  const initial = readGeneratableTask(cwd, taskId);
  const reconciled = reconcileTaskCard(initial, taskJobs);
  if (reconciled !== initial) writeWorkspaceRecord(cwd, "task", reconciled);

  const linked = new Set(reconciled.linked_jobs);
  const evidence: ClosureRunJob[] = [];
  const records: RunRecord[] = [];
  for (const job of taskJobs) {
    if (!linked.has(job.job_id)) continue;
    try {
      // Retained failure history is independent of the collector's successful-record checkpoint.
      const attempts = await jobs.readCollectErrorAttempts(job.job_id);
      evidence.push({ job, collect_error_attempts: attempts });
      if (job.status === "collected")
        records.push(await jobs.collectShud(job.job_id, { readonly: true }));
    } catch {
      throw new Error(`report_generate collect evidence failed for ${job.job_id}`);
    }
  }

  // Evidence awaits may have allowed another writer to change the card. Never discard an
  // unseen job, retry collection, or publish a report using a stale linked_jobs snapshot.
  const card = readGeneratableTask(cwd, taskId);
  const closure = evaluateClosure(card, evidence, records, authored);
  if (!closure.ok) {
    throw new Error(`report_generate closure failed: ${JSON.stringify(closure.failures)}`);
  }
  const byJob = new Map(records.map((record) => [record.job_id, record]));
  const ordered = card.linked_jobs.map((jobId) => {
    const record = byJob.get(jobId);
    if (!record) throw new Error(`report_generate missing record for ${jobId}`);
    return record;
  });
  const now = new Date().toISOString();
  const report = createEvidenceReport(cwd, {
    task_id: taskId,
    status: "draft",
    ...authored,
    limitations: [...authored.limitations, closure.automatic_limitation],
    linked_runs: ordered.map((record) => record.run_id),
    stack_ids: [...new Set(ordered.map((record) => StackIdSchema.parse(record.stack_id)))],
    data_ids: [...new Set(ordered.map((record) => DataIdSchema.parse(record.data_id)))],
    llm_response_models: [...new Set(ordered.map((record) => record.llm.response_model))],
    decision_history: [],
    created_at: now,
    updated_at: now,
  });
  // Register the new id's publication before yielding; all report tools share this lane.
  return withReportOperation(cwd, report.report_id, async () => {
    try {
      const current = readGeneratableTask(cwd, taskId);
      writeWorkspaceRecord(cwd, "task", {
        ...transitionTask(current, { type: "report_generate" }),
        linked_reports: [...current.linked_reports, report.report_id],
      });
    } catch {
      throw reportStepError("task_card", report.report_id);
    }
    await publishReportMarkdown(cwd, report.report_id);
    return { report_id: report.report_id, status: "draft" as const };
  });
}

export function createReportGenerateTool(jobs: ShudJobRegistry): ToolDefinition {
  const tool = defineTool({
    name: "report_generate",
    description:
      "Generate a new draft EvidenceReport from an eligible task's already-collected runs. Preserves previous reports; does not approve evidence or collect unfinished jobs.",
    parameters,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          report_id: { type: "string", required: true },
          status: { type: "string", const: "draft", required: true },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    async execute(args, exec) {
      const taskId = TaskIdSchema.safeParse(args.task_id);
      if (!taskId.success) throw new ToolArgsError(["Invalid task_id"]);
      if (args.summary.length === 0) throw new ToolArgsError(["summary must be nonempty"]);
      for (const field of ["observations", "limitations", "pi_questions"] as const) {
        if (args[field].some((text) => text.length === 0)) {
          throw new ToolArgsError([`${field} entries must be nonempty`]);
        }
      }
      const cwd = reportCwd(exec.agent?.session?.header?.cwd);
      return generateReport(
        cwd,
        taskId.data,
        {
          summary: args.summary,
          observations: args.observations,
          limitations: args.limitations,
          pi_questions: args.pi_questions,
        },
        jobs,
      );
    },
  });
  return strictTool(tool, parameters);
}

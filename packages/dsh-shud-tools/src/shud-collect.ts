import { defineTool, ToolArgsError, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { JobRecordIdSchema, RunIdSchema } from "@shud-harness/dsh-shud-core";
import type { ShudJobRegistry } from "@shud-harness/dsh-shud-jobs";
import { strictTool } from "./strict-tool.ts";

const parameters = {
  job_id: { type: "string", description: "Persistent JOB identifier; supply this or run_id." },
  run_id: { type: "string", description: "Persistent RUN identifier; supply this or job_id." },
} as const;

export function createShudCollectTool(jobs: ShudJobRegistry): ToolDefinition {
  const tool = defineTool({
    name: "shud_collect",
    description:
      "Retrieve the canonical RunRecord by exactly one persistent job_id or run_id, from any session or workspace. Collects finished runs when needed; unfinished runs report their current status and dsh_job_id.",
    parameters,
    output: {
      // The registry owns full RunRecord validation; do not duplicate its evolving schema here.
      schema: { type: "object", additionalProperties: true },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    async execute(args) {
      if ((args.job_id === undefined) === (args.run_id === undefined)) {
        throw new ToolArgsError(["Supply exactly one of job_id or run_id"]);
      }
      const id =
        args.job_id === undefined
          ? RunIdSchema.safeParse(args.run_id)
          : JobRecordIdSchema.safeParse(args.job_id);
      if (!id.success) {
        throw new ToolArgsError([`Invalid ${args.job_id === undefined ? "run_id" : "job_id"}`]);
      }
      return jobs.collectShud(id.data);
    },
  });
  return strictTool(tool, parameters);
}

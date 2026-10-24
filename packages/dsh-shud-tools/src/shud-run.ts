import { basename } from "node:path";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { produceDetachedShud, type ShudJobRegistry } from "@shud-harness/dsh-shud-jobs";
import { strictTool } from "./strict-tool.ts";

const parameters = {
  input_dir: {
    type: "string",
    required: true,
    description: "SHUD input directory; relative paths use the calling session's cwd.",
  },
  project: {
    type: "string",
    description: "Project filename stem; defaults to the supplied input directory's basename.",
  },
  end_days: {
    type: "integer",
    description: "Positive END day override in the copied input.",
  },
  label: { type: "string", description: "Optional one-line description of this run." },
} as const;

export function createShudRunTool(jobs: ShudJobRegistry): ToolDefinition {
  const tool = defineTool({
    name: "shud_run",
    description:
      "Copy a SHUD project's input and start a durable background run. Returns running job identifiers without waiting for the solver to finish.",
    parameters,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", const: "running", required: true },
          job_id: { type: "string", required: true },
          run_id: { type: "string", required: true },
          dsh_job_id: { type: "string", required: true },
          run_dir: { type: "string", required: true },
        },
      },
      render(_args, value) {
        return [
          {
            type: "text",
            text:
              `SHUD running: job_id=${value.job_id}, run_id=${value.run_id}, ` +
              `dsh_job_id=${value.dsh_job_id}, run_dir=${value.run_dir}.\n` +
              `Use job_output and job_kill with dsh_job_id ${value.dsh_job_id}, not job_id or run_id. ` +
              `After a host restart the dsh_job_id changes; find the current id through job_list ` +
              `(the label contains run_id ${value.run_id}) or shud_collect.`,
          },
        ];
      },
    },
    async execute(args, exec) {
      const session = exec.agent?.session;
      const cwd = session?.header.cwd;
      const owner = session?.id;
      if (typeof cwd !== "string" || cwd.length === 0) {
        throw new Error("shud_run requires the calling session's cwd");
      }
      if (typeof owner !== "string" || owner.length === 0) {
        throw new Error("shud_run requires the calling session's id");
      }
      const headerModel = session?.requestHeader?.()?.config.model;
      const model = headerModel?.trim() ? headerModel : exec.agent?.options?.model;
      if (typeof model !== "string" || model.trim().length === 0) {
        throw new Error(
          "shud_run requires a configured model in the request header or agent options",
        );
      }
      const project = args.project ?? basename(args.input_dir);
      if (args.project === undefined && (project === "" || project === "." || project === "..")) {
        throw new Error("shud_run requires an explicit project for this input_dir");
      }
      const record = await jobs.submitShud(
        {
          cwd,
          input_dir: args.input_dir,
          project,
          ...(args.end_days === undefined ? {} : { end_days: args.end_days }),
          ...(args.label === undefined ? {} : { label: args.label }),
          owner_session: owner,
          llm: { response_model: model, response_model_source: "configured" },
        },
        produceDetachedShud,
      );
      if (record.status !== "running" || record.dsh_job_id === null) {
        throw new Error("SHUD submission did not return a running registered job");
      }
      return {
        status: "running" as const,
        job_id: record.job_id,
        run_id: record.run_id,
        dsh_job_id: record.dsh_job_id,
        run_dir: record.run_dir,
      };
    },
  });
  return strictTool(tool, parameters);
}

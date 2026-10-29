import { defineTool, ToolArgsError, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { readCallerPresetId } from "@shud-harness/dsh-shud-core";
import { strictTool } from "./strict-tool.ts";
import { createTaskCard } from "@shud-harness/dsh-shud-records";

const parameters = {
  type: { type: "string", const: "science_assist", required: true },
  title: { type: "string", required: true, description: "Nonempty task title." },
  question_or_goal: {
    type: "string",
    required: true,
    description: "Nonempty research question or goal.",
  },
} as const;

export function createTaskCreateTool(): ToolDefinition {
  const tool = defineTool({
    name: "task_create",
    description:
      "Create a planned science-assistance TaskCard in the calling session workspace. Does not start runs or link reports.",
    parameters,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string", required: true },
          status: { type: "string", const: "planned", required: true },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    execute(args, exec) {
      for (const field of ["title", "question_or_goal"] as const) {
        if (args[field].length === 0) throw new ToolArgsError([`${field} must be nonempty`]);
      }
      const cwd = exec.agent?.session?.header?.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) {
        throw new Error("task_create requires the calling session's cwd (workspace)");
      }
      const owner = readCallerPresetId(exec.agent);
      const now = new Date().toISOString();
      const card = createTaskCard(cwd, {
        ...args,
        status: "planned",
        runtime_phase: null,
        created_by: owner,
        current_owner: owner,
        reviewer: "pi",
        inference_budget: { mode: "normal" },
        linked_jobs: [],
        linked_reports: [],
        stack_id: null,
        data_id: null,
        created_at: now,
        updated_at: now,
      });
      return Promise.resolve({ task_id: card.task_id, status: "planned" as const });
    },
  });
  return strictTool(tool, parameters);
}

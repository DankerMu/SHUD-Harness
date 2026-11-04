import { join } from "node:path";
import { defineTool, ToolArgsError, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  createBrandedId,
  readCallerPresetId,
  SEMANTIC_LEVEL_ORDER,
  TaskIdSchema,
  type ChangeRequest,
  type TaskId,
} from "@shud-harness/dsh-shud-core";
import {
  createChangeRequest,
  deriveChangeRequest,
  ensureDirectory,
  observeSourceChanges,
  readWorkspaceRecord,
  transitionTask,
  WorkspaceRecordError,
  writeChangePatch,
  writeWorkspaceRecord,
} from "@shud-harness/dsh-shud-records";
import { readSourceCheckout } from "./source-checkout.ts";
import { strictTool } from "./strict-tool.ts";

const parameters = {
  task_id: {
    type: "string",
    required: true,
    description: "Planned or running code-change TASK identifier.",
  },
  semantic_level: {
    type: "string",
    enum: SEMANTIC_LEVEL_ORDER,
    description: "Optional declaration; cannot lower the observed semantic floor.",
  },
  description: {
    type: "string",
    description: "Optional one-line description, preserved verbatim.",
  },
} as const;

function readEligibleTask(cwd: string, taskId: TaskId, capturedPin?: string) {
  let card;
  let readStage: WorkspaceRecordError["stage"] = "read";
  try {
    card = readWorkspaceRecord(cwd, "task", taskId, { readonly: true });
  } catch (error) {
    readStage = error instanceof WorkspaceRecordError ? error.stage : "read";
  }
  if (card === undefined) {
    throw new Error(`change_create task ${taskId}: ${readStage} failed`);
  }
  if (card.type !== "code_change") {
    throw new Error(`change_create task ${taskId}: requires code_change type`);
  }
  if (card.status !== "planned" && card.status !== "running") {
    throw new Error(`change_create task ${taskId}: requires planned or running status`);
  }
  if (card.source_base_commit === null) {
    throw new Error(`change_create task ${taskId}: missing source base pin`);
  }
  if (capturedPin !== undefined && card.source_base_commit !== capturedPin) {
    throw new Error(`change_create task ${taskId}: source base pin changed during observation`);
  }
  return card;
}

export function createChangeCreateTool(): ToolDefinition {
  const tool = defineTool({
    name: "change_create",
    description:
      "Observe tracked modifications in repos/SHUD against a code-change task's pinned HEAD. Publish a proposed ChangeRequest and exact patch, raise declarations below the semantic floor, and link the running task. Does not approve changes or invoke a model.",
    parameters,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          change_id: { type: "string", required: true },
          semantic_level: { type: "string", enum: SEMANTIC_LEVEL_ORDER, required: true },
          semantic_floor: { type: "string", enum: SEMANTIC_LEVEL_ORDER, required: true },
          floor_categories: {
            type: "array",
            items: { type: "string", enum: SEMANTIC_LEVEL_ORDER },
            required: true,
          },
          risk: { type: "string", enum: ["low", "medium", "high"], required: true },
          files_changed: { type: "array", items: { type: "string" }, required: true },
          patch_path: { type: "string", required: true },
          status: { type: "string", const: "proposed", required: true },
          explanation: { type: "string" },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    async execute(args, exec) {
      const id = TaskIdSchema.safeParse(args.task_id);
      if (!id.success) throw new ToolArgsError(["Invalid task_id"]);
      if (args.description !== undefined && /[\r\n\u2028\u2029]/u.test(args.description)) {
        throw new ToolArgsError(["description must be one line"]);
      }
      const cwd = exec.agent?.session?.header?.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) {
        throw new Error("change_create requires the calling session's cwd (workspace)");
      }
      const initial = readEligibleTask(cwd, id.data);
      const pin = initial.source_base_commit;
      const { cwd: physicalCwd, sourceDir, head } = await readSourceCheckout(cwd);
      if (head !== pin) {
        throw new Error(`Source checkout repos/SHUD drifted from pinned base ${pin}: HEAD ${head}`);
      }
      const observation = await observeSourceChanges(sourceDir);
      if (observation.files_changed.length === 0) {
        throw new Error("Source checkout repos/SHUD: no modifications");
      }

      // Git awaits may have admitted other card writers. Reject changed eligibility or pin
      // before directory effects; no await occurs anywhere in the publication stretch below.
      readEligibleTask(physicalCwd, id.data, head);
      const now = new Date();
      const derived = deriveChangeRequest({
        change_id: createBrandedId("CHG", now),
        task_id: id.data,
        base_commit: head,
        created_by: readCallerPresetId(exec.agent),
        created_at: now.toISOString(),
        ...observation,
        semantic_level: args.semantic_level,
        description: args.description,
      });
      // A pure candidate is not an owned object. Directory failures never expose its id.
      for (const target of ["changes", "patches", "tasks", `tasks/${id.data}`]) {
        try {
          ensureDirectory(join(physicalCwd, target), "Change output");
        } catch {
          throw new Error(`change_create directory preflight failed: ${target}`);
        }
      }

      let change: ChangeRequest | undefined;
      try {
        change = createChangeRequest(physicalCwd, derived.record);
      } catch (error) {
        // The canonical publisher knows the actual collision-reallocated id, including
        // a committed record whose temporary-name cleanup failed before returning.
        if (error instanceof WorkspaceRecordError) throw error;
      }
      if (change === undefined) throw new Error("change_create CR publication failed");
      try {
        writeChangePatch(physicalCwd, change.change_id, observation.patch);
      } catch {
        throw new Error(
          `change_create ${change.change_id}: patch publication failed; prior commits retained`,
        );
      }
      try {
        const current = readEligibleTask(physicalCwd, id.data, head);
        writeWorkspaceRecord(physicalCwd, "task", {
          ...transitionTask(current, { type: "change_create" }, now),
          linked_changes: [...new Set([...current.linked_changes, change.change_id])].sort(),
        });
      } catch {
        throw new Error(
          `change_create ${change.change_id}: task_card publication failed; prior commits retained`,
        );
      }
      const adjustment = derived.level_adjustment;
      return {
        change_id: change.change_id,
        semantic_level: change.semantic_level,
        semantic_floor: change.semantic_floor,
        floor_categories: change.floor_categories,
        risk: change.risk,
        files_changed: change.files_changed,
        patch_path: change.patch_path,
        status: "proposed" as const,
        ...(adjustment === null
          ? {}
          : {
              explanation: `Declared semantic level ${adjustment.declared} raised to ${adjustment.effective} by the observed semantic floor.`,
            }),
      };
    },
  });
  return strictTool(tool, parameters);
}

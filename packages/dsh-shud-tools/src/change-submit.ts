import { createHash } from "node:crypto";
import { defineTool, ToolArgsError, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { ChangeIdSchema } from "@shud-harness/dsh-shud-core";
import {
  readChangePatch,
  readWorkspaceRecord,
  rewriteChangeRequest,
  WorkspaceRecordError,
} from "@shud-harness/dsh-shud-records";
import { strictTool } from "./strict-tool.ts";

const parameters = {
  change_id: {
    type: "string",
    required: true,
    description: "Proposed workspace CHG identifier to approve after policy admission.",
  },
} as const;

function recordFailure(subject: string, error: unknown): Error {
  const stage = error instanceof WorkspaceRecordError ? error.stage : "read";
  return new Error(`change_submit ${subject}: ${stage} failed`);
}

/** Policy owns risk and host approval; this tool owns fresh synchronous eligibility and publication. */
export function createChangeSubmitTool(): ToolDefinition {
  const tool = defineTool({
    name: "change_submit",
    description:
      "Approve a proposed ChangeRequest for a running task after policy admission. Recheck exact patch bytes and store the execution callId; never modify the TaskCard or patch.",
    parameters,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          change_id: { type: "string", required: true },
          status: { type: "string", const: "approved", required: true },
          approval_ref: { type: "string", required: true },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    execute(args, exec) {
      const id = ChangeIdSchema.safeParse(args.change_id);
      if (!id.success) throw new ToolArgsError(["Invalid change_id"]);
      const cwd = exec.agent?.session?.header?.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) {
        throw new Error("change_submit requires the calling session's cwd (workspace)");
      }
      if (typeof exec.callId !== "string" || exec.callId.length === 0) {
        throw new Error(`change_submit ${id.data}: a nonempty execution callId is required`);
      }
      let change;
      try {
        change = readWorkspaceRecord(cwd, "change", id.data, { readonly: true });
      } catch (error) {
        throw recordFailure(`change ${id.data}`, error);
      }
      if (change.status !== "proposed") {
        throw new Error(`change_submit ${id.data}: requires proposed, found ${change.status}`);
      }
      let card;
      try {
        card = readWorkspaceRecord(cwd, "task", change.task_id, { readonly: true });
      } catch (error) {
        throw recordFailure(`task ${change.task_id}`, error);
      }
      if (card.status !== "running") {
        throw new Error(
          `change_submit task ${change.task_id}: requires running, found ${card.status}`,
        );
      }
      let patch;
      try {
        patch = readChangePatch(cwd, id.data, { readonly: true });
      } catch (error) {
        throw recordFailure(`patch ${id.data}`, error);
      }
      if (createHash("sha256").update(patch).digest("hex") !== change.patch_sha256) {
        throw new Error("change_submit patch sha256 mismatch: run change_create again");
      }
      const now = new Date().toISOString();
      try {
        rewriteChangeRequest(cwd, {
          ...change,
          status: "approved",
          approval_ref: exec.callId,
          approved_at: now,
          updated_at: now,
        });
      } catch (error) {
        throw recordFailure(`approval ${id.data}`, error);
      }
      return Promise.resolve({
        change_id: id.data,
        status: "approved" as const,
        approval_ref: exec.callId,
      });
    },
  });
  return strictTool(tool, parameters);
}

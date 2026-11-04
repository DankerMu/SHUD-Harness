import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool, ToolArgsError, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  ChangeIdSchema,
  TaskIdSchema,
  type ChangeId,
  type ChangeRequest,
  type TaskId,
} from "@shud-harness/dsh-shud-core";
import {
  observeSourceChanges,
  publishBuildDirectory,
  readChangePatch,
  readWorkspaceRecord,
  WorkspaceRecordError,
} from "@shud-harness/dsh-shud-records";
import { buildGit } from "./shud-build/archive.ts";
import { buildProducer } from "./shud-build/produce.ts";
import { readSourceCheckout } from "./source-checkout.ts";
import { strictTool } from "./strict-tool.ts";

const parameters = {
  task_id: {
    type: "string",
    required: true,
    description: "Planned or running code-change TASK identifier with a pinned source checkout.",
  },
  change_id: {
    type: "string",
    description: "Optional approved CHG identifier whose exact patch is the candidate build input.",
  },
  rhs_openmp: {
    type: "boolean",
    description: "Enable SHUD_ENABLE_OPENMP_RHS=1; defaults to false.",
  },
} as const;

function eligibleTask(cwd: string, id: TaskId, pin?: string) {
  let card;
  let readStage: WorkspaceRecordError["stage"] = "read";
  try {
    card = readWorkspaceRecord(cwd, "task", id, { readonly: true });
  } catch (error) {
    readStage = error instanceof WorkspaceRecordError ? error.stage : "read";
  }
  if (card === undefined) {
    throw new Error(`shud_build task ${id}: ${readStage} failed`);
  }
  if (card.type !== "code_change" || (card.status !== "planned" && card.status !== "running")) {
    throw new Error(`shud_build task ${id}: requires planned or running code_change`);
  }
  if (card.source_base_commit === null || (pin !== undefined && card.source_base_commit !== pin)) {
    throw new Error(`shud_build task ${id}: source base pin missing or changed`);
  }
  return card;
}

function approvedChange(
  cwd: string,
  changeId: ChangeId,
  taskId: TaskId,
  head: string,
  observation: { files_changed: string[]; patch: Buffer },
) {
  let change: ChangeRequest | undefined;
  let patch;
  let readStage: WorkspaceRecordError["stage"] = "read";
  try {
    change = readWorkspaceRecord(cwd, "change", changeId, { readonly: true });
    patch = readChangePatch(cwd, changeId, { readonly: true });
  } catch (error) {
    readStage = error instanceof WorkspaceRecordError ? error.stage : "read";
  }
  if (change === undefined || patch === undefined) {
    throw new Error(`shud_build change ${changeId}: CR/patch ${readStage} failed`);
  }
  if (change.status !== "approved") {
    throw new Error(`shud_build change ${changeId}: requires approved status`);
  }
  if (change.task_id !== taskId || change.base_commit !== head) {
    throw new Error(`shud_build change ${changeId}: task or pinned base mismatch`);
  }
  if (
    observation.files_changed.length !== change.files_changed.length ||
    observation.files_changed.some((path, index) => path !== change.files_changed[index])
  ) {
    throw new Error(`shud_build change ${changeId}: observed paths differ from files_changed`);
  }
  const observedSha = createHash("sha256").update(observation.patch).digest("hex");
  const persistedSha = createHash("sha256").update(patch).digest("hex");
  if (observedSha !== change.patch_sha256 || persistedSha !== change.patch_sha256) {
    throw new Error(
      `shud_build change ${changeId}: observed diff or persisted patch sha256 mismatch`,
    );
  }
  return {
    changeId,
    patchSha256: change.patch_sha256,
    paths: observation.files_changed,
    patch,
  };
}

export function createShudBuildTool(ctx: Context): ToolDefinition {
  const tool = defineTool({
    name: "shud_build",
    description:
      "Build a code-change task's pinned Git archive with an optional exact approved patch, publish executable evidence and a BuildRecord, without changing source or task state.",
    parameters,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          build_id: { type: "string", required: true },
          change_id: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
          patch_sha256: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
          source_commit: { type: "string", required: true },
          rhs_openmp: { type: "boolean", required: true },
          binary_sha256: { type: "string", required: true },
          duration_seconds: { type: "number", required: true },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    async execute(args, exec) {
      const parsed = TaskIdSchema.safeParse(args.task_id);
      if (!parsed.success) throw new ToolArgsError(["Invalid task_id"]);
      const changeId =
        args.change_id === undefined ? null : ChangeIdSchema.safeParse(args.change_id);
      if (changeId !== null && !changeId.success) throw new ToolArgsError(["Invalid change_id"]);
      if (args.rhs_openmp !== undefined && typeof args.rhs_openmp !== "boolean") {
        throw new ToolArgsError(["Invalid rhs_openmp"]);
      }
      const rhsOpenmp = args.rhs_openmp === undefined ? false : args.rhs_openmp;
      const cwd = exec.agent?.session?.header?.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) {
        throw new Error("shud_build requires the calling session's cwd (workspace)");
      }
      // Cordis exposes the validated config on the injected provider's fiber. The
      // service itself is a tracing proxy, not necessarily the raw implementation.
      const config: unknown = ctx.fiber.store?.jobs?.fiber.config;
      const sundialsRoot: unknown =
        typeof config === "object" && config !== null
          ? Reflect.get(config, "sundialsRoot")
          : undefined;
      if (typeof sundialsRoot !== "string" || sundialsRoot.length === 0) {
        throw new Error("shud_build requires shud-jobs sundialsRoot configuration");
      }
      const { PATH, HOME } = process.env;
      if (PATH === undefined || HOME === undefined) {
        throw new Error("shud_build requires host PATH and HOME");
      }
      const pin = eligibleTask(cwd, parsed.data).source_base_commit;
      const { cwd: physicalCwd, sourceDir, head } = await readSourceCheckout(cwd);
      if (head !== pin) {
        throw new Error(`Source checkout repos/SHUD drifted from pinned base ${pin}: HEAD ${head}`);
      }
      let observation;
      try {
        observation = await observeSourceChanges(sourceDir);
      } catch {
        throw new Error("shud_build source observation failed");
      }
      if (changeId === null && observation.files_changed.length !== 0) {
        throw new Error(
          `shud_build requires a clean base checkout: ${observation.files_changed.join(", ")}`,
        );
      }
      const branch = (
        await buildGit(
          sourceDir,
          ["rev-parse", "--abbrev-ref", "HEAD"],
          "source branch observation",
        )
      )
        .toString("utf8")
        .trim();
      if (!branch) throw new Error("shud_build source branch observation failed");
      const change =
        changeId === null
          ? null
          : approvedChange(physicalCwd, changeId.data, parsed.data, head, observation);
      eligibleTask(physicalCwd, parsed.data, head);
      let diagnostic: string | undefined;
      let record;
      let publicationFailure = "shud_build publication failed";
      try {
        record = await publishBuildDirectory(
          physicalCwd,
          buildProducer({
            cwd: physicalCwd,
            source: sourceDir,
            commit: head,
            branch,
            taskId: parsed.data,
            sundialsRoot,
            rhsOpenmp,
            change,
            env: { PATH, HOME, SUNDIALS_DIR: sundialsRoot },
            diagnostic(message) {
              diagnostic = message;
            },
          }),
        );
      } catch (error) {
        // Publisher errors are controlled; relay only their stage/cleanup fact, never
        // an arbitrary producer cause or the now-deleted temporary pathname.
        const stage = error instanceof WorkspaceRecordError ? error.stage : "publication";
        const cleanup =
          error instanceof WorkspaceRecordError &&
          /: cleanup (failed|incomplete) \(/u.test(error.message);
        const buildsRoot =
          error instanceof WorkspaceRecordError &&
          error.stage === "directory" &&
          error.path === join(physicalCwd, "builds");
        const collision =
          error instanceof WorkspaceRecordError &&
          /: collision \(BUILD-[0-9]{8}T[0-9]{6}-[0-9a-f]{4}\)(?:: cleanup (?:failed|incomplete) \(BUILD-[0-9]{8}T[0-9]{6}-[0-9a-f]{4}\))?$/u.test(
            error.message,
          );
        const publication = buildsRoot
          ? "shud_build builds directory validation failed"
          : collision
            ? "shud_build builds allocation collision"
            : `shud_build ${stage} failed`;
        publicationFailure = `${diagnostic ?? publication}${cleanup ? "; build cleanup failed or incomplete" : ""}`;
      }
      if (record === undefined) throw new Error(publicationFailure);
      return {
        build_id: record.build_id,
        change_id: record.change_id,
        patch_sha256: record.patch_sha256,
        source_commit: record.source_commit,
        rhs_openmp: record.rhs_openmp,
        binary_sha256: record.binary_sha256,
        duration_seconds: record.duration_seconds,
      };
    },
  });
  return strictTool(tool, parameters);
}

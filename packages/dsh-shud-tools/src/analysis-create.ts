import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { defineTool, ToolArgsError, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  AnalysisPlanIdSchema,
  AnalysisPlanSchema,
  CALIB_MULTIPLIER_RANGE,
  CALIB_WHITELIST,
  readCallerPresetId,
  TaskIdSchema,
  type AnalysisPlan,
  type AnalysisPlanId,
  type TaskCard,
  type TaskId,
} from "@shud-harness/dsh-shud-core";
import {
  CalibProductError,
  checkCalibProducts,
  createAnalysisPlan,
  readShudInputFile,
  readWorkspaceRecord,
  ShudInputError,
  WorkspaceRecordError,
  writeWorkspaceRecord,
} from "@shud-harness/dsh-shud-records";
import { effectiveProject } from "./project-default.ts";
import { strictTool } from "./strict-tool.ts";

const parameters = {
  task_id: { type: "string", required: true, description: "Sensitivity TASK identifier." },
  input_dir: {
    type: "string",
    required: true,
    description: "SHUD input directory; relative paths use the calling session's cwd.",
  },
  project: {
    type: "string",
    description: "Project filename stem; defaults to the supplied input directory's basename.",
  },
  end_days: { type: "integer", required: true, description: "Positive END day for every run." },
  threads: { type: "integer", description: "Optional positive thread count; plan value 1." },
  parameter_sets: {
    type: "array",
    required: true,
    description:
      "Ordered sets: exactly one baseline with empty changes; each other set changes one " +
      "whitelisted calibration key by a multiplier in " +
      `[${CALIB_MULTIPLIER_RANGE.join(", ")}] other than 1. Ids PSET-1..PSET-n follow array order.`,
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        label: { type: "string", description: "Optional nonempty label." },
        baseline: { type: "boolean", required: true },
        changes: {
          type: "object",
          additionalProperties: true,
          required: true,
          description: "Whitelisted calibration key to multiplier; empty for the baseline.",
        },
      },
    },
  },
  rationale_basis: {
    type: "string",
    required: true,
    description: "Nonempty basis for the proposed parameter space.",
  },
} as const;

type ParameterSets = AnalysisPlan["parameter_sets"];
type CalibKey = keyof typeof CALIB_WHITELIST;
// Syntactically valid stand-in id: full-plan refinements run only on a complete object, while
// the real id is drawn by createAnalysisPlan so collision reallocation stays records-owned.
const VALIDATION_ID = AnalysisPlanIdSchema.parse("PLAN-00000000T000000-0000");

function readEligibleCard(cwd: string, taskId: TaskId): TaskCard {
  let card: TaskCard | undefined;
  let stage: WorkspaceRecordError["stage"] = "read";
  try {
    card = readWorkspaceRecord(cwd, "task", taskId, { readonly: true });
  } catch (error) {
    stage = error instanceof WorkspaceRecordError ? error.stage : "read";
  }
  if (card === undefined) throw new Error(`analysis_create task ${taskId}: card ${stage} failed`);
  if (card.type !== "sensitivity") {
    throw new Error(`analysis_create task ${taskId}: requires sensitivity type`);
  }
  if (card.status !== "planned" && card.status !== "running") {
    throw new Error(`analysis_create task ${taskId}: requires planned or running status`);
  }
  if (card.linked_analyses.length > 0) {
    throw new Error(
      `analysis_create task ${taskId}: already linked to ${card.linked_analyses.join(", ")}`,
    );
  }
  return card;
}

/** Read one plan entry's task_id without following links; any unreadable entry is fatal. */
function planTaskId(root: string, name: string): unknown {
  try {
    const fd = openSync(
      `${root}/${name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
      const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
      const taskId: unknown =
        typeof value === "object" && value !== null ? Reflect.get(value, "task_id") : undefined;
      if (typeof taskId !== "string") throw new Error("task_id unreadable");
      return taskId;
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error(`analysis_create analyses/${name}: plan entry is not a readable regular file`);
  }
}

/** The only analyses/ scan: find this card's unlinked plans, never skipping a bad entry. */
function findOrphan(cwd: string, taskId: TaskId): AnalysisPlan | undefined {
  // Same non-collapsing spelling records publishes plans under: no lexical `..` folding of cwd.
  const root = `${cwd}/analyses`;
  let names: string[];
  try {
    const stat = lstatSync(root, { throwIfNoEntry: false });
    if (stat === undefined) return undefined;
    if (!stat.isDirectory()) throw new Error("not a real directory");
    names = readdirSync(root);
  } catch {
    throw new Error("analysis_create analyses: not a readable real directory");
  }
  const owned: AnalysisPlanId[] = [];
  for (const name of names.sort()) {
    const id = AnalysisPlanIdSchema.safeParse(name.endsWith(".json") ? name.slice(0, -5) : "");
    if (id.success && planTaskId(root, name) === taskId) owned.push(id.data);
  }
  if (owned.length > 1) {
    throw new Error(`analysis_create task ${taskId}: multiple unlinked plans ${owned.join(", ")}`);
  }
  if (owned.length === 0) return undefined;
  let stage: WorkspaceRecordError["stage"] = "read";
  try {
    return readWorkspaceRecord(cwd, "analysis", owned[0], { readonly: true });
  } catch (error) {
    if (error instanceof WorkspaceRecordError) stage = error.stage;
  }
  throw new Error(`analysis_create unlinked plan ${owned[0]}: ${stage} failed`);
}

function resolveInput(cwd: string, inputDir: string, project: string, sets: ParameterSets) {
  let input: string;
  try {
    // Never path.resolve/join the user path: alias/.. has physical semantics, as raw-guard judges.
    input = realpathSync.native(isAbsolute(inputDir) ? inputDir : `${cwd}/${inputDir}`);
  } catch {
    throw new Error(`analysis_create input_dir ${inputDir}: not found`);
  }
  if (!lstatSync(input).isDirectory()) {
    throw new Error(`analysis_create input_dir ${inputDir}: not a directory`);
  }
  const tables = sets.flatMap((set) =>
    Object.keys(set.changes).map((key) =>
      CALIB_WHITELIST[key as CalibKey].table.replace("<project>", () => project),
    ),
  );
  for (const file of new Set([`${project}.cfg.para`, `${project}.cfg.calib`, ...tables])) {
    const stat = lstatSync(join(input, file), { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      throw new Error(`analysis_create input ${file}: ${stat ? "not a regular file" : "missing"}`);
    }
  }
  return input;
}

function sameChanges(left: Record<string, unknown>, right: Record<string, unknown>) {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && right[key] === left[key])
  );
}

/** Re-hash exactly the orphan's own digest set through the records safe reader, read-only. */
function sameInputs(plan: AnalysisPlan): boolean {
  try {
    return Object.entries(plan.input_digests).every(
      ([path, digest]) => readShudInputFile(plan.input_dir, path).sha256 === digest,
    );
  } catch (error) {
    if (error instanceof ShudInputError) return false;
    throw error;
  }
}

function sameRequest(plan: AnalysisPlan, request: Omit<AnalysisPlan, "analysis_plan_id">) {
  return (
    plan.input_dir === request.input_dir &&
    plan.project === request.project &&
    plan.end_days === request.end_days &&
    plan.threads === request.threads &&
    plan.parameter_space_rationale.basis === request.parameter_space_rationale.basis &&
    plan.parameter_sets.length === request.parameter_sets.length &&
    plan.parameter_sets.every(
      (set, index) =>
        set.baseline === request.parameter_sets[index].baseline &&
        sameChanges(set.changes, request.parameter_sets[index].changes),
    ) &&
    sameInputs(plan)
  );
}

function publishNewPlan(cwd: string, request: Omit<AnalysisPlan, "analysis_plan_id">) {
  let fields: typeof request | undefined;
  let failure = "";
  try {
    // Digests come from the same reads that the product check validated.
    const digests = checkCalibProducts(request.input_dir, request.project, request.parameter_sets);
    fields = { ...request, input_digests: digests };
  } catch (error) {
    if (!(error instanceof CalibProductError || error instanceof ShudInputError)) throw error;
    failure = error.message;
  }
  if (fields === undefined) throw new Error(`analysis_create ${failure}`);
  const checked = AnalysisPlanSchema.safeParse({ ...fields, analysis_plan_id: VALIDATION_ID });
  if (!checked.success) {
    const paths = new Set(checked.error.issues.map((issue) => String(issue.path[0] ?? "plan")));
    throw new Error(`analysis_create invalid plan: ${[...paths].join(", ")}`);
  }
  return createAnalysisPlan(cwd, fields);
}

/** Synchronous read-validate-write: no await between the fresh card read and its publication. */
function linkCard(cwd: string, taskId: TaskId, planId: AnalysisPlanId): void {
  try {
    const card = readEligibleCard(cwd, taskId);
    writeWorkspaceRecord(cwd, "task", {
      ...card,
      linked_analyses: [planId],
      updated_at: new Date().toISOString(),
    });
  } catch {
    throw new Error(`analysis_create ${planId}: plan 已落盘、任务卡回写失败`);
  }
}

function nonempty(field: string, value: string) {
  if (value.length === 0) throw new ToolArgsError([`${field} must be nonempty`]);
}

export function createAnalysisCreateTool(): ToolDefinition {
  const tool = defineTool({
    name: "analysis_create",
    description:
      "Create the single immutable one-at-a-time AnalysisPlan for a planned or running sensitivity task and link it to the card. Validates calibration products and records input digests. Does not run SHUD, ask for approval or invoke a model.",
    parameters,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          analysis_plan_id: { type: "string", required: true },
          parameter_sets: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                parameter_set_id: { type: "string", required: true },
                label: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
                baseline: { type: "boolean", required: true },
                changes: { type: "object", additionalProperties: true, required: true },
              },
            },
          },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    execute(args, exec) {
      const taskId = TaskIdSchema.safeParse(args.task_id);
      if (!taskId.success) throw new ToolArgsError(["Invalid task_id"]);
      nonempty("input_dir", args.input_dir);
      nonempty("rationale_basis", args.rationale_basis);
      if (!AnalysisPlanSchema.shape.end_days.safeParse(args.end_days).success) {
        throw new ToolArgsError(["end_days must be a positive integer"]);
      }
      const threads = args.threads ?? 1;
      if (!AnalysisPlanSchema.shape.threads.safeParse(threads).success) {
        throw new ToolArgsError(["threads must be a positive integer"]);
      }
      const sets = AnalysisPlanSchema.shape.parameter_sets.safeParse(
        args.parameter_sets.map((set, index) => ({
          parameter_set_id: `PSET-${index + 1}`,
          label: set.label ?? null,
          baseline: set.baseline,
          changes: set.changes,
        })),
      );
      if (!sets.success) throw new ToolArgsError(["parameter_sets are invalid"]);
      const cwd = exec.agent?.session?.header?.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) {
        throw new Error("analysis_create requires the calling session's cwd (workspace)");
      }
      const project = effectiveProject("analysis_create", args.input_dir, args.project);
      if (!AnalysisPlanSchema.shape.project.safeParse(project).success) {
        throw new ToolArgsError(["project must be one path component"]);
      }

      readEligibleCard(cwd, taskId.data);
      const orphan = findOrphan(cwd, taskId.data);
      const request = {
        task_id: taskId.data,
        mode: "sensitivity" as const,
        strategy: "one_at_a_time" as const,
        input_dir: resolveInput(cwd, args.input_dir, project, sets.data),
        project,
        end_days: args.end_days,
        threads,
        parameter_sets: sets.data,
        parameter_space_rationale: {
          proposed_by: "agent" as const,
          basis: args.rationale_basis,
          confirmed_by: null,
        },
        input_digests: {},
        created_by: readCallerPresetId(exec.agent),
        created_at: new Date().toISOString(),
      };
      if (orphan !== undefined && !sameRequest(orphan, request)) {
        throw new Error(
          `analysis_create task ${taskId.data}: unlinked plan ${orphan.analysis_plan_id} differs from these arguments or inputs`,
        );
      }
      const plan = orphan ?? publishNewPlan(cwd, request);
      linkCard(cwd, taskId.data, plan.analysis_plan_id);
      return Promise.resolve({
        analysis_plan_id: plan.analysis_plan_id,
        parameter_sets: plan.parameter_sets,
      });
    },
  });
  return strictTool(tool, parameters);
}

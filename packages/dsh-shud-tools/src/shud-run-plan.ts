import {
  AnalysisPlanIdSchema,
  CALIB_WHITELIST,
  ParameterSetIdSchema,
  type AnalysisPlan,
  type AnalysisPlanId,
  type TaskCard,
  type TaskId,
} from "@shud-harness/dsh-shud-core";
import type { SubmitShudRequest } from "@shud-harness/dsh-shud-jobs";
import { readWorkspaceRecord, WorkspaceRecordError } from "@shud-harness/dsh-shud-records";
import { physicalInputDir } from "./project-default.ts";

export interface PlanArguments {
  analysisPlanId: AnalysisPlanId;
  parameterSetId: string;
  taskId: TaskId;
}

export interface PlanCall {
  inputDir: string;
  project: string;
  endDays: number | undefined;
  threads: number | undefined;
}

/** Internal submission fields; never model-visible. */
type PlanFields = Required<
  Pick<
    SubmitShudRequest,
    | "analysis_plan_id"
    | "parameter_set_id"
    | "end_days"
    | "threads"
    | "calib_overrides"
    | "input_digests"
  >
>;
type CalibKey = keyof typeof CALIB_WHITELIST;

/** Pure shape check: both plan ids or neither, each brand-valid, the pair only with task_id. */
export function planArguments(
  args: { analysis_plan_id?: string; parameter_set_id?: string },
  taskId: TaskId | undefined,
): PlanArguments | undefined {
  const { analysis_plan_id: plan, parameter_set_id: set } = args;
  if (plan === undefined && set === undefined) return undefined;
  if (set === undefined) throw new Error("shud_run analysis_plan_id requires parameter_set_id");
  if (plan === undefined) throw new Error("shud_run parameter_set_id requires analysis_plan_id");
  const planId = AnalysisPlanIdSchema.safeParse(plan);
  if (!planId.success) throw new Error("shud_run requires a valid analysis_plan_id");
  const setId = ParameterSetIdSchema.safeParse(set);
  if (!setId.success) throw new Error("shud_run parameter_set_id must be PSET-1..PSET-5");
  if (taskId === undefined) {
    throw new Error("shud_run analysis_plan_id and parameter_set_id require task_id");
  }
  return { analysisPlanId: planId.data, parameterSetId: setId.data, taskId };
}

function readPlan(cwd: string, id: AnalysisPlanId): AnalysisPlan {
  let stage: WorkspaceRecordError["stage"] = "read";
  try {
    // Direct read by the validated branded id; analyses/ is never scanned.
    return readWorkspaceRecord(cwd, "analysis", id, { readonly: true });
  } catch (error) {
    if (error instanceof WorkspaceRecordError) stage = error.stage;
  }
  throw new Error(`shud_run analysis_plan_id ${id}: plan ${stage} failed`);
}

function resolvesTo(cwd: string, inputDir: string, expected: string): boolean {
  try {
    return physicalInputDir(cwd, inputDir) === expected;
  } catch {
    return false;
  }
}

/**
 * Read the bound plan and require the call to run exactly its parameter set: same card, input
 * directory (physical), project, window and threads. Runs before the task query, card
 * reconciliation and every write; the plan supplies the overrides and digests verbatim.
 */
export function resolvePlan(cwd: string, binding: PlanArguments, call: PlanCall): PlanFields {
  const id = binding.analysisPlanId;
  const plan = readPlan(cwd, id);
  if (plan.task_id !== binding.taskId) {
    throw new Error(
      `shud_run analysis_plan_id ${id} belongs to task ${plan.task_id}, not task_id ${binding.taskId}`,
    );
  }
  const set = plan.parameter_sets.find(
    (entry) => entry.parameter_set_id === binding.parameterSetId,
  );
  if (set === undefined) {
    throw new Error(`shud_run parameter_set_id ${binding.parameterSetId} is not in plan ${id}`);
  }
  if (!resolvesTo(cwd, call.inputDir, plan.input_dir)) {
    throw new Error(`shud_run input_dir ${call.inputDir} does not resolve to plan ${id} input_dir`);
  }
  if (call.project !== plan.project) {
    throw new Error(`shud_run project ${call.project} differs from plan ${id} project`);
  }
  if (call.endDays !== undefined && call.endDays !== plan.end_days) {
    throw new Error(`shud_run end_days ${call.endDays} differs from plan ${id} end_days`);
  }
  if (call.threads !== undefined && call.threads !== plan.threads) {
    throw new Error(`shud_run threads ${call.threads} differs from plan ${id} threads`);
  }
  // The plan schema allows a baseline with no change or a perturbation of exactly one key.
  const overrides = (Object.keys(CALIB_WHITELIST) as CalibKey[]).flatMap((key) => {
    const multiplier = set.changes[key];
    return multiplier === undefined ? [] : [{ key, multiplier }];
  });
  return {
    analysis_plan_id: id,
    parameter_set_id: set.parameter_set_id,
    end_days: plan.end_days,
    threads: plan.threads,
    calib_overrides: overrides,
    input_digests: plan.input_digests,
  };
}

/** Card-side binding rules, checked inside the synchronous card read before reconciliation. */
export function checkCardBinding(card: TaskCard, binding: PlanArguments | undefined): void {
  if (binding === undefined) {
    if (card.type === "sensitivity") {
      throw new Error(
        `shud_run task_id ${card.task_id} is a sensitivity task and requires its plan binding: analysis_plan_id and parameter_set_id`,
      );
    }
    return;
  }
  if (!card.linked_analyses.includes(binding.analysisPlanId)) {
    throw new Error(
      `shud_run analysis_plan_id ${binding.analysisPlanId} is not linked to task ${card.task_id}`,
    );
  }
}

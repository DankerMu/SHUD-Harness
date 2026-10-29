import {
  DataIdSchema,
  StackIdSchema,
  type JobRecordId,
  type RunJob,
  type TaskCard,
} from "@shud-harness/dsh-shud-core";
import { transitionTask } from "./task-transition.ts";

/** Only validated job identity and the controlled field name enter diagnostics. */
export class TaskReconcileError extends Error {
  constructor(
    readonly job_id: JobRecordId,
    readonly field: "stack_id" | "data_id",
    readonly reason: "invalid_job_reference" | "ambiguous_job_reference" = "invalid_job_reference",
  ) {
    super(`Task reconciliation failed: ${reason} (${job_id}, ${field})`);
    this.name = "TaskReconcileError";
  }
}

/** Compare validated UTC ISO instants without truncating arbitrary fractional precision. */
function compareSubmittedAt(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  const leftDot = left.indexOf(".");
  const rightDot = right.indexOf(".");
  const leftSecond = Date.parse(leftDot === -1 ? left : `${left.slice(0, leftDot)}Z`);
  const rightSecond = Date.parse(rightDot === -1 ? right : `${right.slice(0, rightDot)}Z`);
  if (leftSecond !== rightSecond) return leftSecond < rightSecond ? -1 : 1;

  const leftLength = leftDot === -1 ? 0 : left.length - leftDot - 2;
  const rightLength = rightDot === -1 ? 0 : right.length - rightDot - 2;
  for (let index = 0; index < Math.max(leftLength, rightLength); index++) {
    const leftDigit = index < leftLength ? left.charCodeAt(leftDot + 1 + index) : 48;
    const rightDigit = index < rightLength ? right.charCodeAt(rightDot + 1 + index) : 48;
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
  }
  return 0;
}

/**
 * Recover only task-owned job knowledge, using prevalidated domain objects and no IO.
 * The original object is returned on a no-op: future callers must use that identity as
 * their no-write signal. Changes preserve unowned fields and refresh updated_at once.
 * Select one latest job overall (null time oldest, ties by largest ordinal job id),
 * validate only references actually filled, and never fall back to an older reference.
 * Equal-rank latest entries may repeat identical references, regardless of unrelated
 * metadata. Conflicting references fail closed before clock access (stack_id first if
 * both conflict). A better-ranked winner discards lower-ranked reference ambiguity.
 */
export function reconcileTaskCard(
  card: TaskCard,
  runJobsForTask: readonly RunJob[],
  now?: Date,
): TaskCard {
  const ids = new Set(card.linked_jobs);
  let latest: RunJob | undefined;
  let stackConflict = false;
  let dataConflict = false;
  let hasLiveJob = false;
  for (const job of runJobsForTask) {
    if (job.task_id !== card.task_id) continue;
    ids.add(job.job_id);
    if (job.status === "created" || job.status === "submitted" || job.status === "running") {
      hasLiveJob = true;
    }
    const order =
      latest === undefined ? 1 : compareSubmittedAt(job.submitted_at, latest.submitted_at);
    if (latest === undefined || order > 0 || (order === 0 && job.job_id > latest.job_id)) {
      latest = job;
      stackConflict = false;
      dataConflict = false;
    } else if (order === 0 && job.job_id === latest.job_id) {
      stackConflict ||= job.stack_id !== latest.stack_id;
      dataConflict ||= job.data_id !== latest.data_id;
    }
  }
  if (latest !== undefined && (stackConflict || dataConflict)) {
    throw new TaskReconcileError(
      latest.job_id,
      stackConflict ? "stack_id" : "data_id",
      "ambiguous_job_reference",
    );
  }

  const linkedJobs = [...ids].sort();
  const linksChanged =
    linkedJobs.length !== card.linked_jobs.length ||
    linkedJobs.some((id, index) => id !== card.linked_jobs[index]);
  let stackId = card.stack_id;
  let dataId = card.data_id;
  if (latest !== undefined) {
    if (stackId === null && latest.stack_id !== null) {
      const parsed = StackIdSchema.safeParse(latest.stack_id);
      if (!parsed.success) throw new TaskReconcileError(latest.job_id, "stack_id");
      stackId = parsed.data;
    }
    if (dataId === null && latest.data_id !== null) {
      const parsed = DataIdSchema.safeParse(latest.data_id);
      if (!parsed.success) throw new TaskReconcileError(latest.job_id, "data_id");
      dataId = parsed.data;
    }
  }

  const activate = card.status === "planned" && hasLiveJob;
  if (!linksChanged && stackId === card.stack_id && dataId === card.data_id && !activate) {
    return card;
  }
  const result = activate
    ? transitionTask(card, { type: "reconcile" }, now)
    : { ...card, updated_at: (now ?? new Date()).toISOString() };
  if (linksChanged) result.linked_jobs = linkedJobs;
  result.stack_id = stackId;
  result.data_id = dataId;
  return result;
}

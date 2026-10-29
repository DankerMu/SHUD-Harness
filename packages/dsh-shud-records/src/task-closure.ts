import {
  MAX_COLLECT_ATTEMPTS,
  type JobRecordId,
  type RunJob,
  type RunRecord,
  type TaskCard,
} from "@shud-harness/dsh-shud-core";

export interface ClosureRunJob {
  job: RunJob;
  /** Required: the caller supplies 0 only when no collect-error ledger exists. */
  collect_error_attempts: number;
}

export interface ClosureDraft {
  observations: readonly string[];
  limitations: readonly string[];
  pi_questions: readonly string[];
}

/** Controlled clauses never include authored prose or raw reference/count payloads. */
export type ClosureFailure =
  | {
      reason:
        | "unsupported_task_type"
        | "no_linked_jobs"
        | "missing_observations"
        | "missing_limitations"
        | "missing_pi_questions";
    }
  | {
      reason:
        | "missing_job"
        | "ambiguous_job"
        | "foreign_job"
        | "job_not_collected"
        | "job_failed"
        | "job_cancelled"
        | "invalid_collect_attempts"
        | "collect_exhausted"
        | "missing_record"
        | "ambiguous_record"
        | "foreign_record"
        | "record_failed"
        | "missing_stack_reference"
        | "missing_data_reference";
      job_id: JobRecordId;
    };

export type ClosureResult = {
  metric_fact: true;
  automatic_limitation: string;
} & (
  | { ok: true; failures: readonly [] }
  | { ok: false; failures: readonly [ClosureFailure, ...ClosureFailure[]] }
);

const AUTOMATIC_LIMITATION = "本里程碑无指标 artifact，不能据此作指标或模型改进结论。";

function hasFailures(
  failures: ClosureFailure[],
): failures is [ClosureFailure, ...ClosureFailure[]] {
  return failures.length > 0;
}

/**
 * Evaluate prevalidated domain evidence synchronously, without IO, logging or mutation.
 * The future caller owns ledger reads (absent ledger -> explicit 0), reconciliation,
 * report persistence and appending automatic_limitation. Invalid counts fail closed.
 * Current M3 policy retains attempts >= MAX_COLLECT_ATTEMPTS as a blocker even after
 * direct collection produced a successful record; this helper neither resets the ledger
 * nor gives record success precedence. Evidence must uniquely identify this task's job
 * and its matching job_id/run_id record. Unrelated evidence is ignored.
 * The three authored arrays are counted as supplied, without prose classification or
 * automatic augmentation. M3 has no metric artifacts, so metric_fact is explicitly true.
 * A successful result establishes closure only, not approval or a TaskCard transition.
 */
export function evaluateClosure(
  card: TaskCard,
  runJobs: readonly ClosureRunJob[],
  runRecords: readonly RunRecord[],
  draft: ClosureDraft,
): ClosureResult {
  const failures: ClosureFailure[] = [];
  if (card.type !== "science_assist") failures.push({ reason: "unsupported_task_type" });
  if (card.linked_jobs.length === 0) failures.push({ reason: "no_linked_jobs" });
  if (draft.observations.length === 0) failures.push({ reason: "missing_observations" });
  if (draft.limitations.length === 0) failures.push({ reason: "missing_limitations" });
  if (draft.pi_questions.length === 0) failures.push({ reason: "missing_pi_questions" });

  for (const jobId of new Set(card.linked_jobs)) {
    let entry: ClosureRunJob | undefined;
    let ambiguousJob = false;
    for (const candidate of runJobs) {
      if (candidate.job.job_id !== jobId) continue;
      if (entry !== undefined) {
        ambiguousJob = true;
        break;
      }
      entry = candidate;
    }
    if (ambiguousJob) {
      failures.push({ reason: "ambiguous_job", job_id: jobId });
      continue;
    }
    if (entry === undefined) {
      failures.push({ reason: "missing_job", job_id: jobId });
      continue;
    }
    const { job, collect_error_attempts: attempts } = entry;
    if (job.task_id !== card.task_id) {
      failures.push({ reason: "foreign_job", job_id: jobId });
      continue;
    }

    if (!Number.isSafeInteger(attempts) || attempts < 0) {
      failures.push({ reason: "invalid_collect_attempts", job_id: jobId });
    } else if (attempts >= MAX_COLLECT_ATTEMPTS) {
      failures.push({ reason: "collect_exhausted", job_id: jobId });
    }
    if (job.status === "failed") {
      failures.push({ reason: "job_failed", job_id: jobId });
    } else if (job.status === "cancelled") {
      failures.push({ reason: "job_cancelled", job_id: jobId });
    } else if (job.status !== "collected") {
      failures.push({ reason: "job_not_collected", job_id: jobId });
    }

    let record: RunRecord | undefined;
    let ambiguousRecord = false;
    for (const candidate of runRecords) {
      if (candidate.job_id !== jobId || candidate.run_id !== job.run_id) continue;
      if (record !== undefined) {
        ambiguousRecord = true;
        break;
      }
      record = candidate;
    }
    if (ambiguousRecord) {
      failures.push({ reason: "ambiguous_record", job_id: jobId });
      continue;
    }
    if (record === undefined) {
      failures.push({ reason: "missing_record", job_id: jobId });
      continue;
    }
    if (record.task_id !== card.task_id) {
      failures.push({ reason: "foreign_record", job_id: jobId });
      continue;
    }
    if (record.status !== "succeeded") failures.push({ reason: "record_failed", job_id: jobId });
    if (record.stack_id === null)
      failures.push({ reason: "missing_stack_reference", job_id: jobId });
    if (record.data_id === null) failures.push({ reason: "missing_data_reference", job_id: jobId });
  }

  return hasFailures(failures)
    ? { ok: false, failures, metric_fact: true, automatic_limitation: AUTOMATIC_LIMITATION }
    : { ok: true, failures: [], metric_fact: true, automatic_limitation: AUTOMATIC_LIMITATION };
}

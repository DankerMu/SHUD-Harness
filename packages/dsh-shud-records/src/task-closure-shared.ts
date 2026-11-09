import {
  MAX_COLLECT_ATTEMPTS,
  type ChangeId,
  type JobRecordId,
  type RunId,
  type RunJob,
  type RunRecord,
  type TaskCard,
  type VerificationId,
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

type SharedClosureFailure =
  | {
      reason:
        "no_linked_jobs" | "missing_observations" | "missing_limitations" | "missing_pi_questions";
      /** Present only for code_change; science_assist results retain their original shape. */
      clause?: 0;
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
      clause?: 5;
    };

/** Controlled clauses never include authored prose, raw reader errors or unvalidated ids. */
export type ClosureFailure =
  | SharedClosureFailure
  | { reason: "unsupported_task_type" | "missing_code_change_loaders" }
  | { reason: "missing_sensitivity_loaders"; clause: 0 }
  | { reason: "run_jobs_read_error"; clause: 5 }
  | {
      reason: "change_read_error" | "change_identity_mismatch" | "foreign_change";
      change_id: ChangeId;
    }
  | {
      reason: "verification_read_error" | "verification_identity_mismatch" | "foreign_verification";
      vc_id: VerificationId;
    }
  | { reason: "no_approved_change"; clause: 1 }
  | {
      reason: "patch_read_error" | "patch_type_invalid" | "patch_digest_mismatch";
      clause: 1;
      change_id: ChangeId;
    }
  | { reason: "no_qualifying_verification"; clause: 2 }
  | {
      reason: "verification_change_not_qualified" | "verification_not_terminal";
      clause: 2;
      vc_id: VerificationId;
      change_id: ChangeId;
    }
  | {
      reason: "verification_run_missing";
      clause: 2;
      vc_id: VerificationId;
      run_id: RunId;
    }
  | {
      reason:
        "verification_run_ambiguous" | "verification_run_foreign" | "verification_run_unlinked";
      clause: 2;
      vc_id: VerificationId;
      run_id: RunId;
      job_id: JobRecordId;
    };

export type ClosureResult =
  | { ok: true; failures: readonly [] }
  | { ok: false; failures: readonly [ClosureFailure, ...ClosureFailure[]] };

function hasFailures(
  failures: ClosureFailure[],
): failures is [ClosureFailure, ...ClosureFailure[]] {
  return failures.length > 0;
}

export function closureResult(failures: ClosureFailure[]): ClosureResult {
  return hasFailures(failures) ? { ok: false, failures } : { ok: true, failures: [] };
}

/** One implementation of the authored-input and all-linked-run clauses for both task types. */
export function sharedClosureFailures(
  card: TaskCard,
  runJobs: readonly ClosureRunJob[],
  runRecords: readonly RunRecord[],
  draft: ClosureDraft,
): SharedClosureFailure[] {
  const failures: SharedClosureFailure[] = [];
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
  return failures;
}

import { createHash } from "node:crypto";
import {
  ChangeRequestSchema,
  VerificationCaseSchema,
  type ChangeId,
  type ChangeRequest,
  type JobRecordId,
  type RunId,
  type RunJob,
  type RunRecord,
  type TaskCard,
  type TaskId,
  type VerificationCase,
  type VerificationId,
} from "@shud-harness/dsh-shud-core";
import {
  closureResult,
  sharedClosureFailures,
  type ClosureDraft,
  type ClosureFailure,
  type ClosureResult,
  type ClosureRunJob,
} from "./task-closure-shared.ts";

/** Synchronous linked-object readers; raw records are schema/identity checked by closure. */
export interface CodeChangeObjectLoaders {
  readChange(id: ChangeId): unknown;
  readPatch(id: ChangeId): Uint8Array;
  readVerification(id: VerificationId): unknown;
}

export interface CodeChangeClosureLoaders extends CodeChangeObjectLoaders {
  /** Already loaded task-query snapshot, with explicit ledger counts; called exactly once. */
  listRunJobsByTask(id: TaskId): readonly ClosureRunJob[];
  runRecords: readonly RunRecord[];
  draft: ClosureDraft;
}

function qualifiedChanges(
  card: TaskCard,
  loaders: CodeChangeObjectLoaders,
  failures: ClosureFailure[],
): Set<ChangeId> {
  const qualified = new Set<ChangeId>();
  for (const id of new Set(card.linked_changes)) {
    let change: ChangeRequest;
    try {
      const parsed = ChangeRequestSchema.safeParse(loaders.readChange(id));
      if (!parsed.success) {
        failures.push({ reason: "change_read_error", change_id: id });
        continue;
      }
      change = parsed.data;
    } catch {
      failures.push({ reason: "change_read_error", change_id: id });
      continue;
    }
    if (change.change_id !== id) {
      failures.push({ reason: "change_identity_mismatch", change_id: id });
      continue;
    }
    if (change.task_id !== card.task_id) {
      failures.push({ reason: "foreign_change", change_id: id });
      continue;
    }
    if (change.status !== "approved") continue;

    try {
      const bytes = loaders.readPatch(id);
      if (!(bytes instanceof Uint8Array)) {
        failures.push({ reason: "patch_type_invalid", clause: 1, change_id: id });
      } else if (createHash("sha256").update(bytes).digest("hex") !== change.patch_sha256) {
        failures.push({ reason: "patch_digest_mismatch", clause: 1, change_id: id });
      } else {
        qualified.add(id);
      }
    } catch {
      failures.push({ reason: "patch_read_error", clause: 1, change_id: id });
    }
  }
  if (qualified.size === 0) failures.push({ reason: "no_approved_change", clause: 1 });
  return qualified;
}

function linkedVerification(
  id: VerificationId,
  taskId: TaskId,
  loaders: CodeChangeObjectLoaders,
  failures: ClosureFailure[],
): VerificationCase | undefined {
  try {
    const parsed = VerificationCaseSchema.safeParse(loaders.readVerification(id));
    if (!parsed.success) {
      failures.push({ reason: "verification_read_error", vc_id: id });
      return undefined;
    }
    if (parsed.data.vc_id !== id) {
      failures.push({ reason: "verification_identity_mismatch", vc_id: id });
      return undefined;
    }
    if (parsed.data.task_id !== taskId) {
      failures.push({ reason: "foreign_verification", vc_id: id });
      return undefined;
    }
    return parsed.data;
  } catch {
    failures.push({ reason: "verification_read_error", vc_id: id });
    return undefined;
  }
}

function checkRunBinding(
  runId: RunId,
  vcId: VerificationId,
  taskId: TaskId,
  linkedJobs: ReadonlySet<JobRecordId>,
  runJobs: readonly ClosureRunJob[],
  failures: ClosureFailure[],
): void {
  let match: RunJob | undefined;
  for (const { job } of runJobs) {
    if (job.run_id !== runId) continue;
    if (match !== undefined) {
      failures.push({
        reason: "verification_run_ambiguous",
        clause: 2,
        vc_id: vcId,
        run_id: runId,
        job_id: match.job_id,
      });
      return;
    }
    match = job;
  }
  if (match === undefined) {
    failures.push({ reason: "verification_run_missing", clause: 2, vc_id: vcId, run_id: runId });
    return;
  }
  if (match.task_id !== taskId || !linkedJobs.has(match.job_id)) {
    failures.push({
      reason: match.task_id !== taskId ? "verification_run_foreign" : "verification_run_unlinked",
      clause: 2,
      vc_id: vcId,
      run_id: runId,
      job_id: match.job_id,
    });
  }
}

function checkVerifications(
  card: TaskCard,
  loaders: CodeChangeObjectLoaders,
  runJobs: readonly ClosureRunJob[],
  changes: ReadonlySet<ChangeId>,
  failures: ClosureFailure[],
): void {
  const linkedJobs = new Set(card.linked_jobs);
  const candidates: ClosureFailure[] = [];
  let witness = false;
  for (const id of new Set(card.linked_verifications)) {
    // Always read/schema/identity check siblings, even after a valid witness was found.
    const verification = linkedVerification(id, card.task_id, loaders, failures);
    if (verification === undefined || witness) continue;
    if (!changes.has(verification.change_id)) {
      candidates.push({
        reason: "verification_change_not_qualified",
        clause: 2,
        vc_id: id,
        change_id: verification.change_id,
      });
      continue;
    }
    if (verification.status !== "passed" && verification.status !== "failed") {
      candidates.push({
        reason: "verification_not_terminal",
        clause: 2,
        vc_id: id,
        change_id: verification.change_id,
      });
      continue;
    }
    const before = candidates.length;
    checkRunBinding(verification.base_run_id, id, card.task_id, linkedJobs, runJobs, candidates);
    checkRunBinding(
      verification.candidate_run_id,
      id,
      card.task_id,
      linkedJobs,
      runJobs,
      candidates,
    );
    if (candidates.length === before) witness = true;
  }
  if (!witness) {
    failures.push({ reason: "no_qualifying_verification", clause: 2 });
    for (const candidate of candidates) failures.push(candidate);
  }
}

/**
 * Decide code_change closure from linked, identity-bound durable evidence only.
 * The caller owns readonly IO adapters, asynchronous preload/reconciliation and all writes.
 * Each linked object is read once; only approved changes require exact-byte patch hashes.
 * A passed or failed terminal verification may witness closure; invalid linked siblings
 * still block, while valid ineligible alternatives do not veto a witness. Clauses 3/4 are
 * core schema requirements, not additional policy. All linked jobs retain the shared
 * science_assist run/ledger rules independently of the witness pair. No clock, logging,
 * discovery, approval, state transition or input mutation is performed here.
 */
export function codeChangeClosure(
  card: TaskCard,
  loaders: CodeChangeClosureLoaders,
): ClosureResult {
  if (card.type !== "code_change") {
    return closureResult([{ reason: "unsupported_task_type" }]);
  }
  let runJobs: readonly ClosureRunJob[];
  try {
    runJobs = loaders.listRunJobsByTask(card.task_id);
  } catch {
    return closureResult([{ reason: "run_jobs_read_error", clause: 5 }]);
  }

  const shared = sharedClosureFailures(card, runJobs, loaders.runRecords, loaders.draft);
  for (const failure of shared) {
    if ("job_id" in failure) failure.clause = 5;
    else failure.clause = 0;
  }
  const failures: ClosureFailure[] = shared;
  const changes = qualifiedChanges(card, loaders, failures);
  checkVerifications(card, loaders, runJobs, changes, failures);
  return closureResult(failures);
}

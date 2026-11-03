import {
  ChangeIdSchema,
  ChangeRequestSchema,
  TaskIdSchema,
  VerificationCaseSchema,
  VerificationIdSchema,
  type ChangeRequest,
  type RunRecord,
  type TaskCard,
  type VerificationCase,
} from "@shud-harness/dsh-shud-core";
import type { ClosureRunJob, CodeChangeClosureLoaders } from "./index.ts";
import { makeRunJob, makeRunRecord, makeTaskCard } from "./task-lifecycle-test-harness.ts";
import { changeCase, verificationCase } from "./workspace-files-test-harness.ts";

export const OTHER_CHANGE = ChangeIdSchema.parse("CHG-20261102T090000-ffff");
export const OTHER_VERIFICATION = VerificationIdSchema.parse("VC-20261102T090000-ffff");
export const OTHER_TASK = TaskIdSchema.parse("TASK-20261102T090000-ffff");
export const PRIVATE_PAYLOAD = "private-closure-reader-payload-529";

export function approvedChange(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return ChangeRequestSchema.parse({
    ...changeCase.value,
    status: "approved",
    approval_ref: "approval-529",
    approved_at: "2026-11-02T09:01:00Z",
    ...overrides,
  });
}

export function terminalVerification(overrides: Partial<VerificationCase> = {}): VerificationCase {
  return VerificationCaseSchema.parse({ ...verificationCase.value, ...overrides });
}

export interface ClosureEvidence {
  card: TaskCard;
  change: ChangeRequest;
  verification: VerificationCase;
  patch: Uint8Array;
  runJobs: ClosureRunJob[];
  records: RunRecord[];
  draft: { observations: string[]; limitations: string[]; pi_questions: string[] };
}

export function closureEvidence(): ClosureEvidence {
  const change = approvedChange();
  const verification = terminalVerification();
  const base = makeRunJob("JOB-20261102T090000-d4e5", {
    run_id: verification.base_run_id,
    task_id: change.task_id,
  });
  const candidate = makeRunJob("JOB-20261102T090000-e5f6", {
    run_id: verification.candidate_run_id,
    task_id: change.task_id,
  });
  const card: TaskCard = makeTaskCard({
    task_id: change.task_id,
    type: "code_change",
    status: "running",
    source_base_commit: change.base_commit,
    linked_jobs: [base.job_id, candidate.job_id],
    linked_changes: [change.change_id],
    linked_verifications: [verification.vc_id],
  });
  return {
    card,
    change,
    verification,
    // The fixture's independently supplied SHA256 is the standard "abc" vector.
    patch: new Uint8Array([0x61, 0x62, 0x63]),
    runJobs: [
      { job: base, collect_error_attempts: 0 },
      { job: candidate, collect_error_attempts: 0 },
    ] satisfies ClosureRunJob[],
    records: [makeRunRecord(base), makeRunRecord(candidate)] as RunRecord[],
    draft: {
      observations: ["The archived comparison completed."],
      limitations: ["This fixed-input comparison is not scientific acceptance."],
      pi_questions: ["Does the PI accept the recorded evidence?"],
    },
  };
}

export function evidenceLoaders(input: ClosureEvidence) {
  const reads = {
    changes: [] as string[],
    patches: [] as string[],
    verifications: [] as string[],
    tasks: [] as string[],
  };
  const changes = new Map<string, unknown>([[input.change.change_id, input.change]]);
  const verifications = new Map<string, unknown>([[input.verification.vc_id, input.verification]]);
  const patches = new Map<string, Uint8Array>([[input.change.change_id, input.patch]]);
  const loaders: CodeChangeClosureLoaders = {
    readChange(id) {
      reads.changes.push(id);
      if (!changes.has(id)) throw new Error(PRIVATE_PAYLOAD);
      return changes.get(id);
    },
    readPatch(id) {
      reads.patches.push(id);
      const bytes = patches.get(id);
      if (bytes === undefined) throw new Error(PRIVATE_PAYLOAD);
      return bytes;
    },
    readVerification(id) {
      reads.verifications.push(id);
      if (!verifications.has(id)) throw new Error(PRIVATE_PAYLOAD);
      return verifications.get(id);
    },
    listRunJobsByTask(id) {
      reads.tasks.push(id);
      return input.runJobs;
    },
    runRecords: input.records,
    draft: input.draft,
  };
  return { loaders, reads, changes, verifications, patches };
}

export function freezeEvidence(value: unknown): void {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return;
  for (const child of Object.values(value)) freezeEvidence(child);
  Object.freeze(value);
}

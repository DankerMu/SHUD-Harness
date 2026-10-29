// Checked by the normal package typecheck; excluded from emitting builds.
import type {
  TaskCard,
  StackLock,
  DataProvenance,
  EvidenceReport,
  RunJob,
  RunRecord,
  JobRecordId,
} from "@shud-harness/dsh-shud-core";
import {
  readWorkspaceRecord,
  writeWorkspaceRecord,
  transitionTask,
  reconcileTaskCard,
  evaluateClosure,
  type ClosureRunJob,
  type ClosureDraft,
  type ClosureFailure,
  type ClosureResult,
} from "./index.ts";

declare const cwd: string;
declare const id: unknown;
declare const value: unknown;
const task: TaskCard = readWorkspaceRecord(cwd, "task", id);
const stack: StackLock = readWorkspaceRecord(cwd, "stack", id);
const data: DataProvenance = readWorkspaceRecord(cwd, "data", id);
const report: EvidenceReport = readWorkspaceRecord(cwd, "report", id);
const written: void = writeWorkspaceRecord(cwd, "task", value);
writeWorkspaceRecord(cwd, "data", value);
writeWorkspaceRecord(cwd, "report", value);
// @ts-expect-error StackLocks have no mutable write API.
writeWorkspaceRecord(cwd, "stack", value);
// @ts-expect-error The file layer has four fixed record kinds, not arbitrary path plugins.
readWorkspaceRecord(cwd, "custom", id);
// @ts-expect-error Kind-specific reads must not erase their domain result type.
const crossed: TaskCard = readWorkspaceRecord(cwd, "report", id);
void [task, stack, data, report, written, crossed];

const transitioned: TaskCard = transitionTask(task, { type: "shud_run" });
transitionTask(task, { type: "report_decide", disposition: "revision_requested" }, new Date());
transitionTask(task, { type: "report_decide", disposition: "rejected" });
// @ts-expect-error Decisions have exactly the two TaskCard dispositions.
transitionTask(task, { type: "report_decide", disposition: "accepted" });
// @ts-expect-error A report decision must name its disposition.
transitionTask(task, { type: "report_decide" });
// @ts-expect-error Events use a closed semantic domain, not arbitrary strings.
transitionTask(task, { type: "custom" });
// @ts-expect-error The optional clock is a Date, not an ISO string.
transitionTask(task, { type: "shud_run" }, "2026-10-29T09:10:11.123Z");
void transitioned;

declare const jobs: readonly RunJob[];
const reconciled: TaskCard = reconcileTaskCard(task, jobs);
reconcileTaskCard(task, jobs, new Date());
// @ts-expect-error Reconciliation consumes validated RunJobs, not unparsed evidence.
reconcileTaskCard(task, [value]);
// @ts-expect-error The optional reconciliation clock is a Date.
reconcileTaskCard(task, jobs, "2026-10-29T09:10:11.123Z");
void reconciled;

declare const closureJobs: readonly ClosureRunJob[];
declare const records: readonly RunRecord[];
declare const draft: ClosureDraft;
const closure: ClosureResult = evaluateClosure(task, closureJobs, records, draft);
const metricFact: true = closure.metric_fact;
if (closure.ok) {
  const noFailures: readonly [] = closure.failures;
  void noFailures;
} else {
  const firstFailure: ClosureFailure = closure.failures[0];
  if ("job_id" in firstFailure) {
    const failedJob: JobRecordId = firstFailure.job_id;
    void failedJob;
  }
}
// @ts-expect-error Each RunJob must be paired with its explicit collection attempt count.
evaluateClosure(task, jobs, records, draft);
// @ts-expect-error Missing ledgers are caller-supplied zero, never an omitted attempt field.
const missingAttempts: ClosureRunJob = { job: jobs[0] };
// @ts-expect-error Draft arrays are readonly at the closure boundary.
const mutableLimitations: string[] = draft.limitations;
// @ts-expect-error A failed result must include at least one controlled clause.
const emptyFailure: ClosureResult = {
  ok: false,
  failures: [],
  metric_fact: true,
  automatic_limitation: "",
};
// @ts-expect-error Job-specific failures require the affected branded job id.
const unidentifiedFailure: ClosureFailure = { reason: "collect_exhausted" };
// @ts-expect-error Failure reasons form a closed domain.
const unknownFailure: ClosureFailure = { reason: "model_says_incomplete" };
void [
  closure,
  metricFact,
  missingAttempts,
  mutableLimitations,
  emptyFailure,
  unidentifiedFailure,
  unknownFailure,
];

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
  isReportMarkdownStale,
  renderReport,
  ReportRenderError,
  type ReportRenderStage,
  validateReport,
  ReportValidationError,
  type ReportValidationStage,
  type ReportValidationCheckId,
  type ReportValidationCheck,
  type ReportValidationDetail,
  type ReportValidationResult,
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

const stale: boolean = isReportMarkdownStale(report, undefined);
isReportMarkdownStale(report, "# EvidenceReport\nDRAFT — not accepted by PI\n");
// @ts-expect-error The predicate takes a validated report, not raw unknown data.
isReportMarkdownStale(value, undefined);
// @ts-expect-error Missing Markdown is undefined, not null.
isReportMarkdownStale(report, null);
// @ts-expect-error The projection is synchronous, not a promise.
const asynchronousStale: Promise<boolean> = isReportMarkdownStale(report, undefined);
const renderError = new ReportRenderError("decision_history");
const renderStage: ReportRenderStage = renderError.stage;
const renderPath: string | undefined = renderError.path;
// @ts-expect-error Error stages are controlled, not authored payload.
new ReportRenderError("private-model-payload");
void [stale, asynchronousStale, renderStage, renderPath];

// Rendering accepts an untrusted routing id for runtime validation, not report JSON.
const markdown: string = renderReport(cwd, id);
// @ts-expect-error The workspace root must be a string.
renderReport(value, id);
// @ts-expect-error Rendering returns complete Markdown synchronously, not a promise.
const asynchronousMarkdown: Promise<string> = renderReport(cwd, report.report_id);
// @ts-expect-error Rendering is a text projection, not an updated report object.
const renderedReport: EvidenceReport = renderReport(cwd, report.report_id);
void [markdown, asynchronousMarkdown, renderedReport];

// Validation consumes only routing, not caller-supplied Markdown or cached evidence.
const validation: ReportValidationResult = validateReport(cwd, id);
const validationOk: boolean = validation.ok;
const validationCheck: ReportValidationCheck = validation.checks[0];
const validationCheckId: ReportValidationCheckId = validationCheck.id;
const firstValidationCheckId: 1 = validation.checks[0].id;
const lastValidationCheckId: 13 = validation.checks[12].id;
const validationDetails: readonly ReportValidationDetail[] = validationCheck.details;
const validationError = new ReportValidationError("parse");
const validationStage: ReportValidationStage = validationError.stage;
// @ts-expect-error The workspace root must be a string.
validateReport(value, id);
// @ts-expect-error Validation is synchronous, not a promise.
const asynchronousValidation: Promise<ReportValidationResult> = validateReport(cwd, id);
// @ts-expect-error There is no Markdown override input.
validateReport(cwd, id, markdown);
// @ts-expect-error Exactly thirteen ordered checks are returned.
void validation.checks[13];
// @ts-expect-error Check ids form a closed numeric domain.
const invalidValidationId: ReportValidationCheckId = 14;
// @ts-expect-error No raw path accompanies root errors.
void validationError.path;
// @ts-expect-error Root error constructors cannot accept a path or cause.
new ReportValidationError("read", cwd);
// @ts-expect-error Error stages cannot carry arbitrary source text.
new ReportValidationError("private-model-payload");
const leakingDetail: ReportValidationDetail = {
  code: "secret_detected",
  section: 1,
  // @ts-expect-error Secret diagnostics expose a numeric section, never the token.
  token: "private",
};
const unknownSection: ReportValidationDetail = {
  code: "secret_detected",
  // @ts-expect-error Numeric sections are limited to header/unclassified and 1–10.
  section: 11,
};
const unvalidatedReference: ReportValidationDetail = {
  code: "reference_unavailable",
  kind: "run",
  // @ts-expect-error Reference identifiers are validated brands, not arbitrary strings.
  id: "private",
  stage: "read",
};
void [
  validationOk,
  validationCheckId,
  firstValidationCheckId,
  lastValidationCheckId,
  validationDetails,
  validationStage,
  asynchronousValidation,
  invalidValidationId,
  leakingDetail,
  unknownSection,
  unvalidatedReference,
];

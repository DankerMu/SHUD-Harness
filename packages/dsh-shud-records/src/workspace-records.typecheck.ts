// Checked by the normal package typecheck; excluded from emitting builds.
import type {
  TaskCard,
  TaskStatus,
  StackLock,
  DataProvenance,
  EvidenceReport,
  ChangeRequest,
  VerificationCase,
  BuildRecord,
  BuildId,
  PiGateDecision,
  RunJob,
  RunRecord,
  JobRecordId,
  ChangeId,
  TaskId,
} from "@shud-harness/dsh-shud-core";
import {
  readWorkspaceRecord,
  writeWorkspaceRecord,
  createChangeRequest,
  observeSourceChanges,
  deriveChangeRequest,
  createVerificationCase,
  writeChangePatch,
  readChangePatch,
  rewriteChangeRequest,
  publishBuildDirectory,
  verifyBuildBinary,
  type BuildDirectoryProducer,
  transitionTask,
  reconcileTaskCard,
  evaluateClosure,
  codeChangeClosure,
  isReportMarkdownStale,
  applyDecision,
  markReportReviewed,
  reportTaskStatus,
  needsReportTaskRepair,
  ReportStateError,
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
  type CodeChangeClosureLoaders,
  type CodeChangeObjectLoaders,
  type TaskEvent,
  type MutableWorkspaceRecordKind,
} from "./index.ts";

declare const cwd: string;
declare const id: unknown;
declare const value: unknown;
const task: TaskCard = readWorkspaceRecord(cwd, "task", id);
const stack: StackLock = readWorkspaceRecord(cwd, "stack", id);
const data: DataProvenance = readWorkspaceRecord(cwd, "data", id);
const report: EvidenceReport = readWorkspaceRecord(cwd, "report", id);
const change: ChangeRequest = readWorkspaceRecord(cwd, "change", id);
const verification: VerificationCase = readWorkspaceRecord(cwd, "verification", id);
const build: BuildRecord = readWorkspaceRecord(cwd, "build", id);
const readonlyChange: ChangeRequest = readWorkspaceRecord(cwd, "change", id, { readonly: true });
const readonlyVerification: VerificationCase = readWorkspaceRecord(cwd, "verification", id, {
  readonly: true,
});
const readonlyBuild: BuildRecord = readWorkspaceRecord(cwd, "build", id, { readonly: true });
const written: void = writeWorkspaceRecord(cwd, "task", value);
writeWorkspaceRecord(cwd, "data", value);
writeWorkspaceRecord(cwd, "report", value);
// @ts-expect-error StackLocks have no mutable write API.
writeWorkspaceRecord(cwd, "stack", value);
// @ts-expect-error ChangeRequests use a dedicated update API, not generic overwrite.
writeWorkspaceRecord(cwd, "change", value);
// @ts-expect-error VerificationCases cannot be overwritten.
writeWorkspaceRecord(cwd, "verification", value);
// @ts-expect-error BuildRecords are published as whole directories, not generic overwrites.
writeWorkspaceRecord(cwd, "build", value);
declare const mutableKind: MutableWorkspaceRecordKind;
const legacyMutableKind: "task" | "data" | "report" = mutableKind;
// @ts-expect-error The file layer has seven fixed record kinds, not arbitrary path plugins.
readWorkspaceRecord(cwd, "custom", id);
// @ts-expect-error Kind-specific reads must not erase their domain result type.
const crossed: TaskCard = readWorkspaceRecord(cwd, "report", id);
void [task, stack, data, report, written, crossed];
// @ts-expect-error A change read must retain its ChangeRequest result.
const crossedChange: VerificationCase = readWorkspaceRecord(cwd, "change", id);
// @ts-expect-error A verification read must retain its VerificationCase result.
const crossedVerification: BuildRecord = readWorkspaceRecord(cwd, "verification", id);
// @ts-expect-error A build read must retain its BuildRecord result.
const crossedBuild: ChangeRequest = readWorkspaceRecord(cwd, "build", id);
void [
  change,
  verification,
  build,
  readonlyChange,
  readonlyVerification,
  readonlyBuild,
  legacyMutableKind,
  crossedChange,
  crossedVerification,
  crossedBuild,
];

const observation: Promise<{ files_changed: string[]; patch: Buffer }> = observeSourceChanges(cwd);
const derivationInput = {
  change_id: change.change_id,
  task_id: change.task_id,
  base_commit: change.base_commit,
  files_changed: change.files_changed,
  created_by: change.created_by,
  created_at: change.created_at,
  patch: new Uint8Array([97, 98, 99]),
};
const derived = deriveChangeRequest(derivationInput);
const derivedRecord: ChangeRequest = derived.record;
const adjustment: {
  declared: ChangeRequest["semantic_level"];
  effective: ChangeRequest["semantic_level"];
} | null = derived.level_adjustment;
deriveChangeRequest({
  ...derivationInput,
  semantic_level: "physical_equation",
  description: "Detail",
});
// @ts-expect-error Source observation is asynchronous.
const synchronousObservation: { files_changed: string[]; patch: Buffer } =
  observeSourceChanges(cwd);
// @ts-expect-error Observation needs a source directory, not arbitrary JSON.
void observeSourceChanges(value);
// @ts-expect-error Pure derivation requires explicit identity and time, not only domain fields.
deriveChangeRequest({
  task_id: change.task_id,
  base_commit: change.base_commit,
  files_changed: change.files_changed,
  created_by: change.created_by,
  patch: Buffer.from("abc"),
});
// @ts-expect-error Hashing consumes exact bytes, not a decoded string.
deriveChangeRequest({ ...derivationInput, patch: "abc" });
// @ts-expect-error Declarations belong to the closed semantic level domain.
deriveChangeRequest({ ...derivationInput, semantic_level: "arbitrary" });
// @ts-expect-error Derivation is synchronous and pure.
const asynchronousDerivation: Promise<unknown> = deriveChangeRequest(derivationInput);
void [observation, derivedRecord, adjustment, synchronousObservation, asynchronousDerivation];

declare const changeFields: Omit<ChangeRequest, "change_id" | "patch_path">;
declare const verificationFields: Omit<VerificationCase, "vc_id">;
const createdChange: ChangeRequest = createChangeRequest(cwd, change);
const createdVerification: VerificationCase = createVerificationCase(cwd, verificationFields);
const patchWritten: void = writeChangePatch(cwd, change.change_id, Buffer.from("abc"));
writeChangePatch(cwd, change.change_id, "abc");
writeChangePatch(cwd, change.change_id, new Uint8Array([97, 98, 99]));
const patchRead: Buffer = readChangePatch(cwd, change.change_id);
const readonlyPatch: Buffer = readChangePatch(cwd, change.change_id, { readonly: true });
const rewrittenChange: void = rewriteChangeRequest(cwd, change);
// @ts-expect-error Creation takes a complete candidate, not unknown JSON.
createChangeRequest(cwd, value);
// @ts-expect-error Verification creation takes complete domain fields.
createVerificationCase(cwd, value);
// @ts-expect-error The candidate must supply both its id and bound patch path.
createChangeRequest(cwd, changeFields);
// @ts-expect-error The candidate must supply its bound patch path.
createChangeRequest(cwd, { ...changeFields, change_id: change.change_id });
// @ts-expect-error The candidate must supply its id.
createChangeRequest(cwd, { ...changeFields, patch_path: change.patch_path });
// @ts-expect-error The allocator owns vc_id.
createVerificationCase(cwd, { ...verificationFields, vc_id: verification.vc_id });
// @ts-expect-error Patch publication takes a ChangeId, not a VerificationId.
writeChangePatch(cwd, verification.vc_id, "abc");
// @ts-expect-error Patch publication accepts bytes, not arbitrary objects.
writeChangePatch(cwd, change.change_id, { content: "abc" });
// @ts-expect-error Patch reads take a ChangeId, not a BuildId.
readChangePatch(cwd, build.build_id);
// @ts-expect-error Change rewrite requires a complete ChangeRequest.
rewriteChangeRequest(cwd, value);
// @ts-expect-error VerificationCases have no ChangeRequest rewrite API.
rewriteChangeRequest(cwd, verification);
// @ts-expect-error Creation is synchronous.
const asynchronousChange: Promise<ChangeRequest> = createChangeRequest(cwd, change);
// @ts-expect-error Patch reads preserve bytes rather than decoding to a string.
const decodedPatch: string = readChangePatch(cwd, change.change_id);
void [
  createdChange,
  createdVerification,
  patchWritten,
  patchRead,
  readonlyPatch,
  rewrittenChange,
  asynchronousChange,
  decodedPatch,
];

declare const buildProducer: BuildDirectoryProducer;
const publishedBuild: Promise<BuildRecord> = publishBuildDirectory(cwd, buildProducer);
void publishBuildDirectory(cwd, async (temporaryDirectory, buildId) => {
  const directory: string = temporaryDirectory;
  const selectedId: BuildId = buildId;
  void [directory, selectedId];
  return Promise.resolve(build);
});
const verifiedBuild: void = verifyBuildBinary(cwd, build);
// @ts-expect-error Publication requires an explicit producer.
void publishBuildDirectory(cwd);
// @ts-expect-error Publication consumes a producer, not already built metadata.
void publishBuildDirectory(cwd, build);
// @ts-expect-error The producer returns complete BuildRecord metadata.
void publishBuildDirectory(cwd, async () => Promise.resolve(value));
// @ts-expect-error The producer contract is asynchronous.
void publishBuildDirectory(cwd, () => build);
// @ts-expect-error Publication returns a promise, not synchronous metadata.
const synchronousBuild: BuildRecord = publishBuildDirectory(cwd, buildProducer);
// @ts-expect-error Verification requires a complete BuildRecord, not only an id.
verifyBuildBinary(cwd, build.build_id);
// @ts-expect-error Unparsed records must pass the core schema first.
verifyBuildBinary(cwd, value);
// @ts-expect-error Binary verification is synchronous.
const asynchronousBinary: Promise<void> = verifyBuildBinary(cwd, build);
void [publishedBuild, verifiedBuild, synchronousBuild, asynchronousBinary];

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

const closureObjects: CodeChangeObjectLoaders = {
  readChange: (id) => readWorkspaceRecord(cwd, "change", id, { readonly: true }),
  readPatch: (id) => readChangePatch(cwd, id, { readonly: true }),
  readVerification: (id) => readWorkspaceRecord(cwd, "verification", id, { readonly: true }),
};
const codeClosureLoaders: CodeChangeClosureLoaders = {
  ...closureObjects,
  listRunJobsByTask: (id: TaskId) => {
    void id;
    return closureJobs;
  },
  runRecords: records,
  draft,
};
const codeClosure: ClosureResult = codeChangeClosure(task, codeClosureLoaders);
const dispatchedClosure: ClosureResult = evaluateClosure(
  task,
  closureJobs,
  records,
  draft,
  closureObjects,
);
const closurePatch: Uint8Array = closureObjects.readPatch(change.change_id);
const closureChange: unknown = closureObjects.readChange(change.change_id);
const closureVerification: unknown = closureObjects.readVerification(verification.vc_id);
const closureSnapshot: readonly ClosureRunJob[] = codeClosureLoaders.listRunJobsByTask(
  task.task_id,
);
const changeEvent: TaskEvent = { type: "change_create" };
const changeTransition: TaskCard = transitionTask(task, changeEvent);

// @ts-expect-error The snapshot boundary is synchronous, not the async registry method.
codeClosureLoaders.listRunJobsByTask = (_id: TaskId): Promise<readonly ClosureRunJob[]> =>
  Promise.resolve(closureJobs);
// @ts-expect-error A complete task snapshot requires explicit collect ledger counts.
codeClosureLoaders.listRunJobsByTask = (_id: TaskId) => closureJobs.map(({ job }) => job);
// @ts-expect-error Patch readers return exact bytes, never decoded text.
closureObjects.readPatch = (_id: ChangeId) => "abc";
// @ts-expect-error Reader ids are branded, not interchangeable strings.
closureObjects.readChange("CHG-20261102T090000-a1b2");
// @ts-expect-error Verification identity cannot route a ChangeRequest read.
closureObjects.readChange(verification.vc_id);
// @ts-expect-error Change identity cannot route a VerificationCase read.
closureObjects.readVerification(change.change_id);
// @ts-expect-error A direct closure call requires the task snapshot, records and draft.
codeChangeClosure(task, closureObjects);
// @ts-expect-error Building is not a task-state transition event.
const buildEvent: TaskEvent = { type: "shud_build" };
// @ts-expect-error Approval is not a task-state transition event.
const submitEvent: TaskEvent = { type: "change_submit" };
// @ts-expect-error Verification publication is not a task-state transition event.
const verifyEvent: TaskEvent = { type: "verification_run" };
void [
  codeClosure,
  dispatchedClosure,
  closurePatch,
  closureChange,
  closureVerification,
  closureSnapshot,
  changeTransition,
  buildEvent,
  submitEvent,
  verifyEvent,
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

declare const decision: PiGateDecision;
const reviewedReport: EvidenceReport = markReportReviewed(report);
const decidedReport: EvidenceReport = applyDecision(report, decision);
markReportReviewed(report, new Date());
applyDecision(report, decision, new Date());
// @ts-expect-error Report transitions consume canonical domain reports, not raw inputs.
markReportReviewed(value);
// @ts-expect-error Decisions are canonical PiGateDecision inputs, not raw unknown data.
applyDecision(report, value);
// @ts-expect-error A TaskCard cannot substitute for a report.
applyDecision(task, decision);
// @ts-expect-error The optional validation clock is a Date, not an ISO string.
markReportReviewed(report, "2026-10-29T09:10:11.123Z");
// @ts-expect-error The optional decision clock is a Date, not an ISO string.
applyDecision(report, decision, "2026-10-29T09:10:11.123Z");
// @ts-expect-error Report transitions are synchronous, not promises.
const asynchronousDecision: Promise<EvidenceReport> = applyDecision(report, decision);
// @ts-expect-error Successful validation returns a report, not the validator's check results.
const validationTransition: ReportValidationResult = markReportReviewed(report);
const reportStateError = new ReportStateError("invalid_decision");
const reportStateReason:
  | "invalid_decision"
  | "invalid_transition"
  | "report_id_mismatch"
  | "inconsistent_decision_history"
  | "unsupported_report_status"
  | "task_id_mismatch" = reportStateError.reason;
// @ts-expect-error State errors cannot carry arbitrary authored payloads as reason codes.
new ReportStateError("private-model-payload");
// @ts-expect-error State errors do not accept raw schema issues or causes.
new ReportStateError("invalid_decision", value);
void [reviewedReport, decidedReport, asynchronousDecision, validationTransition, reportStateReason];

const projectedTaskStatus: TaskStatus = reportTaskStatus(report.status);
const reportTaskRepair: boolean = needsReportTaskRepair(task, report);
// @ts-expect-error Mapping consumes a report status, not a complete report.
reportTaskStatus(report);
// @ts-expect-error Arbitrary strings are outside the canonical report-status type.
reportTaskStatus("private-model-payload");
// @ts-expect-error Mapping is synchronous, not a promise.
const asynchronousProjection: Promise<TaskStatus> = reportTaskStatus(report.status);
// @ts-expect-error A projection is a task status, not a mutated TaskCard.
const projectedTask: TaskCard = reportTaskStatus(report.status);
// @ts-expect-error Repair requires a canonical TaskCard, not unknown file contents.
needsReportTaskRepair(value, report);
// @ts-expect-error Repair requires a canonical EvidenceReport, not unknown file contents.
needsReportTaskRepair(task, value);
// @ts-expect-error Report/card argument order is part of the public contract.
needsReportTaskRepair(report, task);
// @ts-expect-error The pure repair predicate takes no clock.
needsReportTaskRepair(task, report, new Date());
// @ts-expect-error Repair detection is synchronous, not a promise.
const asynchronousRepair: Promise<boolean> = needsReportTaskRepair(task, report);
// @ts-expect-error Repair detection returns a boolean, not a repaired TaskCard.
const repairedTask: TaskCard = needsReportTaskRepair(task, report);
void [
  projectedTaskStatus,
  reportTaskRepair,
  asynchronousProjection,
  projectedTask,
  asynchronousRepair,
  repairedTask,
];

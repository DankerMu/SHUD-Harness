/**
 * Core-and-Node workspace file layer. Atomic primitives retain their low-level diagnostics;
 * workspace reads/writes expose controlled errors and never repair invalid object evidence.
 * Seven-kind reads always bind change/verification/build identities; readonly also binds legacy
 * identities without mkdir. Build metadata reads never create a published build directory.
 * Safe Markdown facades share managed-path guards and the canonical atomic byte writer;
 * report allocation protects both siblings. Stack capture exclusively creates or reuses locks.
 * Generic overwrite remains limited to task/data/report.
 * Change/verification first publication and companion patches use exclusive link commits;
 * only existing valid ChangeRequests can be rewritten through the atomic replacement writer.
 * CR publication preserves a complete candidate's id/path unless an actual collision reallocates it.
 * Source observation returns literal tracked modification paths and exact HEAD diff bytes through
 * core's controlled Git runner. Pure CR derivation consumes explicit identity/time and core floors;
 * callers own TaskCard/base checks and the subsequent record/patch publication sequence.
 * Patch reads in default/readonly:false mode may create only the missing managed patches root;
 * readonly:true creates no paths, and no mode creates or repairs a patch. Publication binds the
 * stored CR and its patch digest.
 * Build publication reserves an owned temporary directory and commits by whole-directory rename.
 * Binary consumers explicitly verify effective execute permissions and descriptor-bound SHA256;
 * metadata reads neither execute nor implicitly verify binaries.
 * Rivqdown comparison preflights both final files, then compares descriptor-bound raw-byte
 * SHA256 without writes or numerical tolerance; missing/unsafe evidence is an error, not unequal.
 * Provenance inventories prepared input bytes before allocation. Task transition,
 * reconciliation and closure helpers are pure; callers own evidence reads, approval,
 * report augmentation and persistence. Reconciliation identity signals no write.
 * code_change closure requires explicit synchronous object readers and a preloaded task-job
 * snapshot with ledger counts. Every linked object is schema/identity checked; valid failed
 * verification is reportable evidence, not a veto, and closure neither approves nor writes.
 * Report rendering and thirteen-clause validation freshly read cited evidence without
 * publication. Validation returns controlled facts, not scientific or PI approval;
 * root errors omit paths and raw causes. The watermark stale predicate is pure.
 * Pure report transitions record caller-established validation/allowed-once facts; they
 * are not approval authority. Report status projection and last-link repair detection
 * are pure; tools own missing-link/status repair, prerequisites and atomic publication.
 */
export { readJson, writeJsonSync, writeJson, writeBytes } from "./state-files.ts";
export { createTaskCard } from "./task-card-file.ts";
export { captureStackLock } from "./capture-stack-lock.ts";
export type { StackCaptureConfig, StackCaptureLlm } from "./capture-stack-lock.ts";
export { generateProvenance } from "./generate-provenance.ts";
export { compareRivqdown } from "./compare-rivqdown.ts";
export { observeSourceChanges } from "./observe-source-changes.ts";
export { deriveChangeRequest } from "./derive-change-request.ts";
export { transitionTask, TaskTransitionError } from "./task-transition.ts";
export type { TaskEvent } from "./task-transition.ts";
export { reconcileTaskCard, TaskReconcileError } from "./task-reconcile.ts";
export { evaluateClosure } from "./task-closure.ts";
export { codeChangeClosure } from "./code-change-closure.ts";
export type { CodeChangeObjectLoaders, CodeChangeClosureLoaders } from "./code-change-closure.ts";
export type {
  ClosureRunJob,
  ClosureDraft,
  ClosureFailure,
  ClosureResult,
} from "./task-closure-shared.ts";
export { isReportMarkdownStale } from "./report-watermark.ts";
export {
  applyDecision,
  markReportReviewed,
  reportTaskStatus,
  needsReportTaskRepair,
  ReportStateError,
} from "./report-state.ts";
export { renderReport } from "./report-render.ts";
export { ReportRenderError } from "./report-render-error.ts";
export type { ReportRenderStage } from "./report-render-error.ts";
export { validateReport, ReportValidationError } from "./report-validate.ts";
export type {
  ReportValidationStage,
  ReportValidationCheckId,
  ReportValidationDetail,
  ReportValidationCheck,
  ReportValidationResult,
} from "./report-validate.ts";
export {
  readWorkspaceRecord,
  writeWorkspaceRecord,
  readReportMarkdown,
  writeReportMarkdown,
  createDataProvenance,
  createEvidenceReport,
  createChangeRequest,
  createVerificationCase,
  writeChangePatch,
  readChangePatch,
  rewriteChangeRequest,
  publishBuildDirectory,
  verifyBuildBinary,
  WorkspaceRecordError,
} from "./workspace-records.ts";
export type {
  WorkspaceRecordMap,
  WorkspaceRecordKind,
  MutableWorkspaceRecordKind,
  WorkspaceRecordStage,
  WorkspaceReadOptions,
  BuildDirectoryProducer,
} from "./workspace-records.ts";

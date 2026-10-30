/**
 * Core-and-Node workspace file layer. Atomic primitives retain their low-level diagnostics;
 * workspace reads/writes expose controlled errors and never repair invalid object evidence.
 * Opt-in readonly workspace reads bind identity without mkdir. Safe Markdown facades share
 * managed-path guards and the canonical atomic byte writer; report allocation protects both siblings.
 * Stack capture exclusively creates or reuses immutable locks; generic writers cannot modify them.
 * Provenance inventories prepared input bytes before allocation. Task transition,
 * reconciliation and closure helpers are pure; callers own evidence reads, approval,
 * report augmentation and persistence. Reconciliation identity signals no write.
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
export { transitionTask, TaskTransitionError } from "./task-transition.ts";
export type { TaskEvent } from "./task-transition.ts";
export { reconcileTaskCard, TaskReconcileError } from "./task-reconcile.ts";
export { evaluateClosure } from "./task-closure.ts";
export type { ClosureRunJob, ClosureDraft, ClosureFailure, ClosureResult } from "./task-closure.ts";
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
  WorkspaceRecordError,
} from "./workspace-records.ts";
export type {
  WorkspaceRecordMap,
  WorkspaceRecordKind,
  MutableWorkspaceRecordKind,
  WorkspaceRecordStage,
  WorkspaceReadOptions,
} from "./workspace-records.ts";

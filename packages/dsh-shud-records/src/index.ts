/**
 * Core-and-Node workspace file layer. Atomic primitives retain their low-level diagnostics;
 * workspace reads/writes expose controlled errors and never repair invalid object evidence.
 * Eight-kind reads always bind change/verification/build/analysis identities; readonly also
 * binds legacy identities without mkdir. Build reads never create a published build directory.
 * Safe Markdown facades share managed-path guards and the canonical atomic byte writer;
 * report allocation protects JSON, Markdown and immutable summary siblings. Stack capture reuses locks.
 * Generic overwrite remains limited to task/data/report.
 * Change/verification/analysis first publication and companion patches use exclusive link commits;
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
 * SHUD text inputs and binary outputs share that descriptor lifecycle: one read binds
 * parser bytes, SHA256 and observed size. Relative ancestors/targets are rechecked
 * observationally, not as an atomic sandbox. Eight text parsers preserve optional tables,
 * cfg duplicates and C numeric values. Little-endian .dat reads preserve date metadata,
 * interval-start minutes and raw samples, counting retained nonfinites without interpreting
 * them. Typed-array views use owned file storage, never unrelated Buffer-pool bytes.
 * Missing/unsafe/read/parse errors omit native causes and input payloads. Scientific
 * finiteness, cross-file counts, factors and units remain consumer responsibilities.
 * Calibration products consume the core whitelist and shared parser, applying read conversion
 * before baseline and multiplier. Returned input digests identify those same reads; product
 * errors identify a zero-based category row and inclusive bounds or finite-positive river rule.
 * Run metrics computation exposes read-only flow, health and six-store water-budget
 * diagnostics. Serialization owns the strict canonical wire format; metrics.json reads
 * bind the caller's digest before parsing. These APIs never write an artifact.
 * Sensitivity summaries consume one successful closure and exact plan bytes, retaining
 * failed/superseded facts without reselection. Their records-owned wire format contains
 * only relative deltas and provenance; overflow rejects rather than serializing as null.
 * Referenced companions are safely reread and digest/identity checked for each render
 * and validator projection, never rederived or rewritten. Summary Markdown is deferred.
 * Report creation owns companion references and exclusively publishes summary bytes before
 * atomic report JSON. A later JSON failure retains the immutable orphan for collision avoidance.
 * Provenance inventories prepared input bytes before allocation. Task transition,
 * reconciliation and closure helpers are pure; callers own evidence reads, approval,
 * report augmentation and persistence. Reconciliation identity signals no write.
 * code_change closure requires explicit synchronous object readers and a preloaded task-job
 * snapshot with ledger counts. Every linked object is schema/identity checked; valid failed
 * verification is reportable evidence, not a veto, and closure neither approves nor writes.
 * Report rendering and fifteen-clause validation freshly read cited evidence without
 * publication. Validation hashes VC artifacts and returns controlled facts, not scientific
 * or PI approval; artifact paths redact secrets, root errors omit paths and raw causes.
 * The watermark stale predicate is pure.
 * Pure report transitions record caller-established validation/allowed-once facts; they
 * are not approval authority. Report status projection and last-link repair detection
 * are pure; tools own missing-link/status repair, prerequisites and atomic publication.
 */
export { readJson, writeJsonSync, writeJson, writeBytes } from "./state-files.ts";
/** Final-directory preflight only; callers validate ancestors and sanitize low-level errors. */
export { ensureDirectory } from "./workspace-paths.ts";
export { createTaskCard } from "./task-card-file.ts";
export { captureStackLock } from "./capture-stack-lock.ts";
export type { StackCaptureConfig, StackCaptureLlm } from "./capture-stack-lock.ts";
export { generateProvenance } from "./generate-provenance.ts";
export { compareRivqdown } from "./compare-rivqdown.ts";
export { readShudDat } from "./shud-dat.ts";
export type { ShudDat, ShudDatRow } from "./shud-dat.ts";
export { computeRunMetrics } from "./run-metrics.ts";
export { serializeRunMetrics, readRunMetrics } from "./run-metrics-wire.ts";
export type { RunMetrics, RunMetricsHealth, MetricsInput } from "./run-metrics-wire.ts";
export { ShudInputError } from "./shud-input-file.ts";
export type { ShudInputStage } from "./shud-input-file.ts";
export { buildSensitivitySummary } from "./sensitivity-summary.ts";
export {
  serializeSensitivitySummary,
  parseSensitivitySummary,
} from "./sensitivity-summary-wire.ts";
export { readReferencedSensitivitySummary } from "./sensitivity-summary-file.ts";
export { SensitivitySummaryError } from "./sensitivity-summary-types.ts";
export type {
  SensitivitySummary,
  SensitivitySummaryRow,
  SummaryMetric,
  SummaryDelta,
  SummaryDeltaReason,
} from "./sensitivity-summary-types.ts";
export { readShudTextInput, parseShudTextInput } from "./shud-text-input.ts";
export { checkCalibProducts, CalibProductError } from "./calib-products.ts";
export type {
  ShudInputKind,
  ShudTable,
  ShudConfigEntry,
  ShudInputDataMap,
  ShudInputReadResult,
} from "./shud-text-input.ts";
export { observeSourceChanges } from "./observe-source-changes.ts";
export { deriveChangeRequest } from "./derive-change-request.ts";
export { transitionTask, TaskTransitionError } from "./task-transition.ts";
export type { TaskEvent } from "./task-transition.ts";
export { reconcileTaskCard, TaskReconcileError } from "./task-reconcile.ts";
export { evaluateClosure } from "./task-closure.ts";
export { codeChangeClosure } from "./code-change-closure.ts";
export type { CodeChangeObjectLoaders, CodeChangeClosureLoaders } from "./code-change-closure.ts";
export { deriveSensitivityClosure } from "./sensitivity-closure.ts";
export { createSensitivityClosureLoaders } from "./sensitivity-closure-files.ts";
export type {
  SensitivityObjectLoaders,
  SensitivityClosureFailure,
  SensitivityClosureResult,
  SensitivityRunIdentity,
  SensitivitySelection,
  SensitivitySupersededRun,
} from "./sensitivity-closure-types.ts";
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
export { readReportMetricFacts, type ReportMetricFacts } from "./report-inputs.ts";
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
  createAnalysisPlan,
  writeChangePatch,
  readChangePatch,
  rewriteChangeRequest,
  publishBuildDirectory,
  verifyBuildBinary,
  WorkspaceRecordError,
} from "./workspace-records.ts";
export type {
  EvidenceReportCreationInput,
  WorkspaceRecordMap,
  WorkspaceRecordKind,
  MutableWorkspaceRecordKind,
  WorkspaceRecordStage,
  WorkspaceReadOptions,
  BuildDirectoryProducer,
} from "./workspace-records.ts";

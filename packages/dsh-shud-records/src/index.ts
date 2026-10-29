/**
 * Core-and-Node workspace file layer. Atomic primitives retain their low-level diagnostics;
 * workspace reads/writes expose controlled errors and never repair invalid object evidence.
 * Stack capture exclusively creates or reuses immutable locks; generic writers cannot modify them.
 * Provenance inventories prepared input bytes before allocation. Task transition,
 * reconciliation and closure helpers are pure; callers own evidence reads, approval,
 * report augmentation and persistence. Reconciliation identity signals no write.
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
export {
  readWorkspaceRecord,
  writeWorkspaceRecord,
  createDataProvenance,
  createEvidenceReport,
  WorkspaceRecordError,
} from "./workspace-records.ts";
export type {
  WorkspaceRecordMap,
  WorkspaceRecordKind,
  MutableWorkspaceRecordKind,
  WorkspaceRecordStage,
} from "./workspace-records.ts";

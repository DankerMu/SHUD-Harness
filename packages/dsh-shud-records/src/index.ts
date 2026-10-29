/**
 * Core-and-Node workspace file layer. Atomic primitives retain their low-level diagnostics;
 * workspace reads/writes expose controlled errors and never repair invalid object evidence.
 * StackLocks are read-only here; capture, transitions and report rendering are not provided.
 */
export { readJson, writeJsonSync, writeJson, writeBytes } from "./state-files.ts";
export { createTaskCard } from "./task-card-file.ts";
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

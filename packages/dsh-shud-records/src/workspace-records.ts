import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createBrandedId,
  TaskIdSchema,
  StackIdSchema,
  DataIdSchema,
  ReportIdSchema,
  TaskCardSchema,
  StackLockSchema,
  DataProvenanceSchema,
  EvidenceReportSchema,
  type TaskCard,
  type StackLock,
  type DataProvenance,
  type EvidenceReport,
} from "@shud-harness/dsh-shud-core";
import { writeJsonSync } from "./state-files.ts";
import { ensureDirectory, regularTarget } from "./workspace-paths.ts";

export interface WorkspaceRecordMap {
  task: TaskCard;
  stack: StackLock;
  data: DataProvenance;
  report: EvidenceReport;
}
export type WorkspaceRecordKind = keyof WorkspaceRecordMap;
export type MutableWorkspaceRecordKind = Exclude<WorkspaceRecordKind, "stack">;
export type WorkspaceRecordStage =
  "id" | "directory" | "target" | "missing" | "read" | "parse" | "schema" | "write";

/** Model-facing diagnostics contain only a controlled stage and an already validated path. */
export class WorkspaceRecordError extends Error {
  constructor(
    readonly stage: WorkspaceRecordStage,
    readonly path?: string,
  ) {
    super(`Workspace record ${stage} failed${path === undefined ? "" : `: ${path}`}`);
    this.name = "WorkspaceRecordError";
  }
}

const recordTypes = {
  task: { field: "task_id", directory: "tasks", id: TaskIdSchema, schema: TaskCardSchema },
  stack: { field: "stack_id", directory: "stacks", id: StackIdSchema, schema: StackLockSchema },
  data: {
    field: "data_id",
    directory: "provenance",
    id: DataIdSchema,
    schema: DataProvenanceSchema,
    prefix: "DATA",
  },
  report: {
    field: "report_id",
    directory: "reports",
    id: ReportIdSchema,
    schema: EvidenceReportSchema,
    prefix: "REPORT",
  },
} as const;

function validatedId(kind: WorkspaceRecordKind, value: unknown): string {
  const result = recordTypes[kind].id.safeParse(value);
  if (!result.success) throw new WorkspaceRecordError("id");
  return result.data;
}

function parseRecord<K extends WorkspaceRecordKind>(
  kind: K,
  value: unknown,
  path?: string,
): WorkspaceRecordMap[K] {
  const result = recordTypes[kind].schema.safeParse(value);
  if (!result.success) throw new WorkspaceRecordError("schema", path);
  // The closed kind table pairs each core schema with its corresponding result type.
  return result.data as WorkspaceRecordMap[K];
}

function managedDirectory(path: string): void {
  try {
    ensureDirectory(path, "Workspace record");
  } catch {
    throw new WorkspaceRecordError("directory", path);
  }
}

function checkedTarget(path: string): boolean {
  try {
    return regularTarget(path, "Workspace record") !== undefined;
  } catch {
    throw new WorkspaceRecordError("target", path);
  }
}

function workspacePath(cwd: string, kind: WorkspaceRecordKind, id: string): string {
  const root = join(cwd, recordTypes[kind].directory);
  managedDirectory(root);
  if (kind !== "task") return join(root, `${id}.json`);
  const directory = join(root, id);
  managedDirectory(directory);
  return join(directory, "task.json");
}

function publish(path: string, value: unknown): void {
  try {
    writeJsonSync(path, value);
  } catch {
    throw new WorkspaceRecordError("write", path);
  }
}

/**
 * Read one of the four fixed workspace layouts, synchronously and through its core schema.
 * Missing managed directories are created, but missing/corrupt objects are never repaired.
 * cwd is the trusted session root; managed descendants are lstat-checked, not canonicalized.
 */
export function readWorkspaceRecord<K extends WorkspaceRecordKind>(
  cwd: string,
  kind: K,
  id: unknown,
): WorkspaceRecordMap[K] {
  const checkedId = validatedId(kind, id);
  const path = workspacePath(cwd, kind, checkedId);
  if (!checkedTarget(path)) throw new WorkspaceRecordError("missing", path);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    throw new WorkspaceRecordError(missing ? "missing" : "read", path);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new WorkspaceRecordError("parse", path);
  }
  return parseRecord(kind, value, path);
}

/**
 * Validate the complete object before path construction or IO, then atomically publish JSON.
 * No metadata or state transitions are invented. Immutable StackLocks have no write API.
 * The synchronous check/publication boundary is not a cross-process transaction or lock.
 */
export function writeWorkspaceRecord(
  cwd: string,
  kind: MutableWorkspaceRecordKind,
  value: unknown,
): void;
export function writeWorkspaceRecord(cwd: string, kind: WorkspaceRecordKind, value: unknown): void {
  // Preserve immutability for JavaScript callers as well as typed consumers.
  if (kind === "stack") throw new WorkspaceRecordError("write");
  const rawId: unknown =
    typeof value === "object" && value !== null
      ? Reflect.get(value, recordTypes[kind].field)
      : undefined;
  const id = validatedId(kind, rawId);
  const record = parseRecord(kind, value);
  const path = workspacePath(cwd, kind, id);
  checkedTarget(path);
  publish(path, record);
}

function createFlatRecord<K extends "data" | "report">(
  cwd: string,
  kind: K,
  fields: Omit<DataProvenance, "data_id"> | Omit<EvidenceReport, "report_id">,
): WorkspaceRecordMap[K] {
  const definition = recordTypes[kind];
  let id = createBrandedId(definition.prefix);
  let record = parseRecord(kind, { ...fields, [definition.field]: id });
  const directory = join(cwd, definition.directory);
  managedDirectory(directory);
  for (;;) {
    const path = join(directory, `${id}.json`);
    if (checkedTarget(path)) {
      // Only an existing regular object is a collision; unsafe targets already failed closed.
      id = createBrandedId(definition.prefix);
      record = { ...record, [definition.field]: id };
      continue;
    }
    publish(path, record);
    return record;
  }
}

/** Allocate a data id and persist supplied provenance; this does not collect input metadata. */
export function createDataProvenance(
  cwd: string,
  fields: Omit<DataProvenance, "data_id">,
): DataProvenance {
  return createFlatRecord(cwd, "data", fields);
}

/** Allocate a report id and persist supplied JSON; Markdown rendering belongs to a later slice. */
export function createEvidenceReport(
  cwd: string,
  fields: Omit<EvidenceReport, "report_id">,
): EvidenceReport {
  return createFlatRecord(cwd, "report", fields);
}

import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  createBrandedId,
  TaskIdSchema,
  StackIdSchema,
  DataIdSchema,
  ReportIdSchema,
  ChangeIdSchema,
  VerificationIdSchema,
  BuildIdSchema,
  AnalysisPlanIdSchema,
  TaskCardSchema,
  StackLockSchema,
  DataProvenanceSchema,
  EvidenceReportSchema,
  ChangeRequestSchema,
  VerificationCaseSchema,
  BuildRecordSchema,
  AnalysisPlanSchema,
  type TaskCard,
  type StackLock,
  type DataProvenance,
  type EvidenceReport,
  type ChangeRequest,
  type VerificationCase,
  type BuildRecord,
  type AnalysisPlan,
  type ReportId,
  type ChangeId,
  type BuildId,
} from "@shud-harness/dsh-shud-core";
import {
  ExclusivePublicationError,
  writeBytes,
  writeExclusiveBytesSync,
  writeJsonSync,
} from "./state-files.ts";
import { ensureDirectory, regularTarget, resolveManagedRoot } from "./workspace-paths.ts";
import { hashDescriptor } from "./hash-descriptor.ts";
import { serializeSensitivitySummary } from "./sensitivity-summary-wire.ts";
import type { SensitivitySummary } from "./sensitivity-summary-types.ts";

export interface WorkspaceRecordMap {
  task: TaskCard;
  stack: StackLock;
  data: DataProvenance;
  report: EvidenceReport;
  change: ChangeRequest;
  verification: VerificationCase;
  build: BuildRecord;
  analysis: AnalysisPlan;
}
export type WorkspaceRecordKind = keyof WorkspaceRecordMap;
export type MutableWorkspaceRecordKind = "task" | "data" | "report";
export interface WorkspaceReadOptions {
  /** Reject missing/unsafe/mismatched objects without creating managed directories. */
  readonly?: boolean;
}
export type WorkspaceRecordStage =
  | "kind"
  | "id"
  | "directory"
  | "target"
  | "missing"
  | "read"
  | "parse"
  | "schema"
  | "identity"
  | "write";

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
  task: {
    field: "task_id",
    directory: "tasks",
    id: TaskIdSchema,
    schema: TaskCardSchema,
    bindIdentity: false,
    nested: { filename: "task.json", createDirectory: true },
  },
  stack: {
    field: "stack_id",
    directory: "stacks",
    id: StackIdSchema,
    schema: StackLockSchema,
    bindIdentity: false,
  },
  data: {
    field: "data_id",
    directory: "provenance",
    id: DataIdSchema,
    schema: DataProvenanceSchema,
    bindIdentity: false,
    prefix: "DATA",
  },
  report: {
    field: "report_id",
    directory: "reports",
    id: ReportIdSchema,
    schema: EvidenceReportSchema,
    bindIdentity: false,
    prefix: "REPORT",
  },
  change: {
    field: "change_id",
    directory: "changes",
    id: ChangeIdSchema,
    schema: ChangeRequestSchema,
    bindIdentity: true,
    prefix: "CHG",
    patch: { directory: "patches", extension: "patch" },
  },
  verification: {
    field: "vc_id",
    directory: "verifications",
    id: VerificationIdSchema,
    schema: VerificationCaseSchema,
    bindIdentity: true,
    prefix: "VC",
  },
  build: {
    field: "build_id",
    directory: "builds",
    id: BuildIdSchema,
    schema: BuildRecordSchema,
    bindIdentity: true,
    prefix: "BUILD",
    binary: "shud",
    nested: { filename: "build-record.json", createDirectory: false },
  },
  analysis: {
    field: "analysis_plan_id",
    directory: "analyses",
    id: AnalysisPlanIdSchema,
    schema: AnalysisPlanSchema,
    bindIdentity: true,
    prefix: "PLAN",
  },
} as const;

function validatedId(kind: WorkspaceRecordKind, value: unknown): string {
  const result = recordTypes[kind].id.safeParse(value);
  if (!result.success) {
    const error = new WorkspaceRecordError("id");
    if (kind === "analysis") error.message += `: ${recordTypes[kind].field}`;
    throw error;
  }
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

function managedDirectory(path: string, readonly = false): void {
  try {
    ensureDirectory(path, "Workspace record", readonly);
  } catch {
    throw new WorkspaceRecordError("directory", path);
  }
}

function checkedFile(path: string): Stats | undefined {
  try {
    return regularTarget(path, "Workspace record");
  } catch {
    throw new WorkspaceRecordError("target", path);
  }
}

function checkedTarget(path: string): boolean {
  return checkedFile(path) !== undefined;
}

function workspacePath(
  cwd: string,
  kind: WorkspaceRecordKind,
  id: string,
  readonly = false,
  extension = "json",
): string {
  const definition = recordTypes[kind];
  const candidate = typeof cwd === "string" ? `${cwd || "."}/${definition.directory}` : undefined;
  let root: string | undefined;
  try {
    root = resolveManagedRoot(cwd, definition.directory, "Workspace record", readonly);
  } catch {
    throw new WorkspaceRecordError("directory", candidate);
  }
  if (root === undefined) {
    const relative =
      "nested" in definition ? `${id}/${definition.nested.filename}` : `${id}.${extension}`;
    throw new WorkspaceRecordError("missing", `${candidate}/${relative}`);
  }
  if (!("nested" in definition)) return join(root, `${id}.${extension}`);
  const directory = join(root, id);
  managedDirectory(directory, readonly || !definition.nested.createDirectory);
  return join(directory, definition.nested.filename);
}

function publish(path: string, value: unknown): void {
  try {
    writeJsonSync(path, value);
  } catch {
    throw new WorkspaceRecordError("write", path);
  }
}

/**
 * Read one of the eight fixed workspace layouts, synchronously and through its core schema.
 * Missing managed roots are created unless readonly, recursively including a missing cwd.
 * Reads never create a published build directory or repair missing/corrupt objects.
 * cwd is trusted but its symlink/.. traversal is physical: managed roots are lstat-checked
 * before native resolution, then descendants are checked. Readonly absence never falls back
 * to a lexical workspace and never creates cwd or managed directories.
 * New kinds always bind embedded identity; legacy kinds bind identity only in readonly mode.
 */
export function readWorkspaceRecord<K extends WorkspaceRecordKind>(
  cwd: string,
  kind: K,
  id: unknown,
  options: WorkspaceReadOptions = {},
): WorkspaceRecordMap[K] {
  // Exact primitive strings only: property-key coercion must never choose a schema or layout.
  if (typeof kind !== "string" || !Object.hasOwn(recordTypes, kind)) {
    throw new WorkspaceRecordError("kind");
  }
  const checkedId = validatedId(kind, id);
  const path = workspacePath(cwd, kind, checkedId, options.readonly);
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
  const record = parseRecord(kind, value, path);
  if (
    (options.readonly || recordTypes[kind].bindIdentity) &&
    Reflect.get(record, recordTypes[kind].field) !== checkedId
  ) {
    throw new WorkspaceRecordError("identity", path);
  }
  return record;
}

/** Safe, non-creating Markdown read. Only genuine absence returns undefined. */
export function readReportMarkdown(cwd: string, reportId: ReportId): string | undefined {
  const id = validatedId("report", reportId);
  let path: string;
  try {
    path = workspacePath(cwd, "report", id, true, "md");
  } catch (error) {
    if (error instanceof WorkspaceRecordError && error.stage === "missing") return undefined;
    throw error;
  }
  if (!checkedTarget(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new WorkspaceRecordError("read", path);
  }
}

/** Publish canonical rendered Markdown through the existing atomic byte writer and path guards. */
export async function writeReportMarkdown(
  cwd: string,
  reportId: ReportId,
  markdown: string,
): Promise<void> {
  const id = validatedId("report", reportId);
  const path = workspacePath(cwd, "report", id, false, "md");
  checkedTarget(path);
  try {
    await writeBytes(path, markdown);
  } catch {
    throw new WorkspaceRecordError("write", path);
  }
}

/**
 * Validate the complete object before path construction or IO, then atomically publish JSON.
 * Only task/data/report support generic overwrite; no metadata or state transitions are invented.
 * The synchronous check/publication boundary is not a cross-process transaction or lock.
 */
export function writeWorkspaceRecord(
  cwd: string,
  kind: MutableWorkspaceRecordKind,
  value: unknown,
): void;
export function writeWorkspaceRecord(cwd: string, kind: WorkspaceRecordKind, value: unknown): void {
  // Preserve immutability for JavaScript callers as well as typed consumers.
  if (typeof kind !== "string" || !Object.hasOwn(recordTypes, kind)) {
    throw new WorkspaceRecordError("kind");
  }
  if (kind !== "task" && kind !== "data" && kind !== "report") {
    throw new WorkspaceRecordError("write");
  }
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

// Analysis links remain caller-owned; the companion reference is generated by creation.
export type EvidenceReportCreationInput = Omit<
  EvidenceReport,
  "report_id" | "change_ids" | "verification_ids" | "sensitivity_summary"
> &
  Partial<Pick<EvidenceReport, "change_ids" | "verification_ids" | "sensitivity_summary">>;

interface ReportSummaryPublication {
  value: SensitivitySummary;
  bytes: string;
  sha256: string;
}

function summaryCreationError(stage: "schema" | "identity" | "write", path?: string) {
  const error = new WorkspaceRecordError(stage, path);
  error.message += ": sensitivity_summary";
  return error;
}

function createFlatRecord<K extends "data" | "report">(
  cwd: string,
  kind: K,
  fields: Omit<DataProvenance, "data_id"> | EvidenceReportCreationInput,
  summary?: ReportSummaryPublication,
): WorkspaceRecordMap[K] {
  const definition = recordTypes[kind];
  let id = createBrandedId(definition.prefix);
  let record = parseRecord(kind, {
    ...fields,
    ...(summary === undefined
      ? {}
      : {
          sensitivity_summary: { path: `reports/${id}.sensitivity.json`, sha256: summary.sha256 },
        }),
    [definition.field]: id,
  });
  if (summary !== undefined) {
    const report = record as EvidenceReport;
    if (
      report.task_id !== summary.value.task_id ||
      report.analysis_ids.length !== 1 ||
      report.analysis_ids[0] !== summary.value.analysis_plan_id ||
      summary.value.rows.some((row) => !report.linked_runs.includes(row.run_id))
    )
      throw summaryCreationError("identity");
  }
  const directory = dirname(workspacePath(cwd, kind, id));
  for (;;) {
    const path = join(directory, `${id}.json`);
    const jsonExists = checkedTarget(path);
    const markdownExists = kind === "report" && checkedTarget(join(directory, `${id}.md`));
    const summaryPath = join(directory, `${id}.sensitivity.json`);
    const summaryExists = kind === "report" && checkedTarget(summaryPath);
    if (jsonExists || markdownExists || summaryExists) {
      // Only an existing regular object is a collision; unsafe targets already failed closed.
      id = createBrandedId(definition.prefix);
      record = {
        ...record,
        [definition.field]: id,
        ...(summary === undefined
          ? {}
          : {
              sensitivity_summary: {
                path: `reports/${id}.sensitivity.json`,
                sha256: summary.sha256,
              },
            }),
      };
      continue;
    }
    if (summary !== undefined) {
      try {
        writeExclusiveBytesSync(summaryPath, summary.bytes);
      } catch {
        throw summaryCreationError("write", `reports/${id}.sensitivity.json`);
      }
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

/**
 * Allocate an unused JSON/Markdown/summary identity. A supplied immutable summary is
 * exclusively published immediately before the existing atomic JSON commit; JSON failure
 * retains the orphan. Callers own analysis links and subsequent Markdown publication.
 * Omitting the summary preserves legacy JSON bytes; supplied references are never reused.
 */
export function createEvidenceReport(
  cwd: string,
  fields: EvidenceReportCreationInput,
  summary?: SensitivitySummary | null,
): EvidenceReport {
  if (fields?.sensitivity_summary != null) throw summaryCreationError("identity");
  if (summary == null) return createFlatRecord(cwd, "report", fields);
  let bytes: string;
  try {
    bytes = serializeSensitivitySummary(summary);
  } catch {
    throw summaryCreationError("schema");
  }
  return createFlatRecord(cwd, "report", fields, {
    value: summary,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

type PublicationFailure =
  | "collision"
  | "publication"
  | "committed cleanup"
  | "publication cleanup"
  | "collision cleanup"
  | "producer"
  | "metadata"
  | "metadata cleanup"
  | "rename";

function publicationFailure(
  path: string,
  id: string,
  reason: PublicationFailure,
): WorkspaceRecordError {
  const error = new WorkspaceRecordError("write", path);
  error.message += `: ${reason} (${id})`;
  return error;
}

/** Only a regular final target is a retryable collision, never a temporary or cleanup failure. */
function publishExclusive(path: string, id: string, bytes: string | Uint8Array): boolean {
  if (checkedTarget(path)) return false;
  try {
    writeExclusiveBytesSync(path, bytes);
    return true;
  } catch (error) {
    if (error instanceof ExclusivePublicationError) {
      if (error.committed) throw publicationFailure(path, id, "committed cleanup");
      if (error.cleanupErrors.length > 0) {
        throw publicationFailure(
          path,
          id,
          error.collision ? "collision cleanup" : "publication cleanup",
        );
      }
      if (error.collision) {
        // A contender may have installed a link or special target after the initial lstat.
        if (checkedTarget(path)) return false;
      }
    }
    throw publicationFailure(path, id, "publication");
  }
}

function patchRelativePath(id: string): string {
  const { directory, extension } = recordTypes.change.patch;
  return `${directory}/${id}.${extension}`;
}

function changePatchPath(cwd: string, id: string, readonly: boolean): string {
  const { directory, extension } = recordTypes.change.patch;
  const candidate = typeof cwd === "string" ? `${cwd || "."}/${directory}` : undefined;
  let root: string | undefined;
  try {
    root = resolveManagedRoot(cwd, directory, "Workspace record", readonly);
  } catch {
    throw new WorkspaceRecordError("directory", candidate);
  }
  if (root === undefined) {
    throw new WorkspaceRecordError("missing", `${candidate}/${id}.${extension}`);
  }
  return join(root, `${id}.${extension}`);
}

function createExclusiveRecord<K extends "change" | "verification" | "analysis">(
  cwd: string,
  kind: K,
  candidate: WorkspaceRecordMap[K],
): WorkspaceRecordMap[K] {
  const definition = recordTypes[kind];
  let record = parseRecord(kind, candidate);
  for (let reallocations = 0; ; reallocations += 1) {
    const id = validatedId(kind, Reflect.get(record, definition.field));
    const path = workspacePath(cwd, kind, id);
    if (publishExclusive(path, id, `${JSON.stringify(record)}\n`)) return record;
    // The first candidate plus at most three reallocations; never draw a fifth id.
    if (reallocations === 3) throw publicationFailure(path, id, "collision");
    const replacement = createBrandedId(definition.prefix);
    record = parseRecord(kind, {
      ...record,
      [definition.field]: replacement,
      ...(kind === "change" ? { patch_path: patchRelativePath(replacement) } : {}),
    });
  }
}

/** Publish the complete CR candidate unchanged; only a collision reallocates its id/patch path. */
export function createChangeRequest(cwd: string, candidate: ChangeRequest): ChangeRequest {
  return createExclusiveRecord(cwd, "change", candidate);
}

/** Allocate and exclusively publish caller-supplied verification evidence without changing its verdict. */
export function createVerificationCase(
  cwd: string,
  fields: Omit<VerificationCase, "vc_id">,
): VerificationCase {
  return createExclusiveRecord(cwd, "verification", {
    ...fields,
    vc_id: createBrandedId("VC"),
  });
}

/**
 * Allocate a PLAN id and exclusively publish schema-valid, immutable analysis metadata.
 * Collisions permit at most three reallocations; existing bytes are never replaced.
 * Input product/digest validation belongs to the caller; this does not read model inputs.
 */
export function createAnalysisPlan(
  cwd: string,
  fields: Omit<AnalysisPlan, "analysis_plan_id">,
): AnalysisPlan {
  return createExclusiveRecord(cwd, "analysis", {
    ...fields,
    analysis_plan_id: createBrandedId("PLAN"),
  });
}

/** Bind an existing CR and its digest before exclusively publishing the companion patch bytes. */
export function writeChangePatch(
  cwd: string,
  changeId: ChangeId,
  bytes: string | Uint8Array,
): void {
  const id = validatedId("change", changeId);
  const record = readWorkspaceRecord(cwd, "change", id, { readonly: true });
  if (
    (typeof bytes !== "string" && !(bytes instanceof Uint8Array)) ||
    createHash("sha256").update(bytes).digest("hex") !== record.patch_sha256
  ) {
    throw new WorkspaceRecordError("write");
  }
  const path = changePatchPath(cwd, id, false);
  if (!publishExclusive(path, id, bytes)) throw publicationFailure(path, id, "collision");
}

/** Read exact patch bytes; readonly suppresses managed-root creation, never repairing a missing patch. */
export function readChangePatch(
  cwd: string,
  changeId: ChangeId,
  options: WorkspaceReadOptions = {},
): Buffer {
  const id = validatedId("change", changeId);
  const path = changePatchPath(cwd, id, options.readonly ?? false);
  if (!checkedTarget(path)) throw new WorkspaceRecordError("missing", path);
  try {
    return readFileSync(path);
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    throw new WorkspaceRecordError(missing ? "missing" : "read", path);
  }
}

/** Replace only an existing valid CR; approval fields remain caller-owned, not inferred here. */
export function rewriteChangeRequest(cwd: string, value: ChangeRequest): void {
  const rawId: unknown =
    typeof value === "object" && value !== null
      ? Reflect.get(value, recordTypes.change.field)
      : undefined;
  const id = validatedId("change", rawId);
  const record = parseRecord("change", value);
  readWorkspaceRecord(cwd, "change", id, { readonly: true });
  const path = workspacePath(cwd, "change", id, true);
  if (!checkedTarget(path)) throw new WorkspaceRecordError("missing", path);
  publish(path, record);
}

export type BuildDirectoryProducer = (
  /** Physical owned directory; the producer must not replace it or its managed parent. */
  temporaryDirectory: string,
  buildId: BuildId,
) => Promise<BuildRecord>;

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** Missing directories are observable absence; links and other entry types are never collisions. */
function buildDirectory(path: string): Stats | undefined {
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error("Not a directory");
    return stat;
  } catch {
    throw new WorkspaceRecordError("directory", path);
  }
}

function requireDirectoryIdentity(path: string, expected: DirectoryIdentity): void {
  const actual = buildDirectory(path);
  if (!actual || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new WorkspaceRecordError("directory", path);
  }
}

function requireBuildOwnership(
  root: string,
  parent: DirectoryIdentity,
  temporary: string,
  owned: DirectoryIdentity,
): void {
  // A replaced parent must stop traversal before inspecting its temporary child.
  requireDirectoryIdentity(root, parent);
  requireDirectoryIdentity(temporary, owned);
}

/** This directory is still unpublished: write the metadata directly, with no per-file rename. */
function writeBuildMetadata(path: string, id: BuildId, record: BuildRecord): void {
  let fd: number | undefined;
  let open = false;
  try {
    fd = openSync(path, "wx", 0o600);
    open = true;
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    open = false;
  } catch {
    let reason: PublicationFailure = "metadata";
    if (open && fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        reason = "metadata cleanup";
      }
    }
    throw publicationFailure(path, id, reason);
  }
}

/**
 * Reserve an exclusive temporary directory, then publish its complete contents in one rename.
 * Cooperating publishers cannot share a reservation. Final absence is rechecked after the await;
 * this is not rename-no-replace against arbitrary external writers between synchronous syscalls.
 */
export async function publishBuildDirectory(
  cwd: string,
  producer: BuildDirectoryProducer,
): Promise<BuildRecord> {
  for (let reallocations = 0; ; reallocations += 1) {
    const id = createBrandedId(recordTypes.build.prefix);
    let root: string;
    try {
      root = resolveManagedRoot(cwd, recordTypes.build.directory, "Workspace record");
    } catch {
      throw new WorkspaceRecordError(
        "directory",
        typeof cwd === "string" ? `${cwd || "."}/${recordTypes.build.directory}` : undefined,
      );
    }
    const parent = buildDirectory(root);
    if (!parent) throw new WorkspaceRecordError("directory", root);
    const final = join(root, id);
    const temporary = join(root, `.tmp-${id}`);
    const finalExists = buildDirectory(final) !== undefined;
    const temporaryExists = buildDirectory(temporary) !== undefined;
    if (finalExists || temporaryExists) {
      if (reallocations === 3) throw publicationFailure(final, id, "collision");
      continue;
    }
    try {
      mkdirSync(temporary, { mode: 0o700 });
    } catch (error) {
      const collision = error instanceof Error && "code" in error && error.code === "EEXIST";
      if (collision) {
        requireDirectoryIdentity(root, parent);
        // EEXIST proves a collision even if the winner already removed or committed its reservation.
        buildDirectory(temporary);
        if (reallocations === 3) throw publicationFailure(temporary, id, "collision");
        continue;
      }
      throw publicationFailure(temporary, id, "publication");
    }
    let owned: DirectoryIdentity | undefined;
    try {
      requireDirectoryIdentity(root, parent);
      owned = buildDirectory(temporary);
      if (!owned) throw new WorkspaceRecordError("directory", temporary);
      let value: unknown;
      try {
        value = await producer(temporary, id);
      } catch {
        // A producer can throw arbitrary objects, even errors resembling our own; never relay them.
        throw publicationFailure(temporary, id, "producer");
      }
      requireBuildOwnership(root, parent, temporary, owned);
      const metadataPath = join(temporary, recordTypes.build.nested.filename);
      const record = parseRecord("build", value, metadataPath);
      if (record.build_id !== id) throw new WorkspaceRecordError("identity", metadataPath);
      writeBuildMetadata(metadataPath, id, record);
      requireBuildOwnership(root, parent, temporary, owned);
      if (buildDirectory(final)) throw publicationFailure(final, id, "collision");
      try {
        renameSync(temporary, final);
      } catch {
        throw publicationFailure(final, id, "rename");
      }
      // Rename is the commit point. No later operation can roll back or remove the final directory.
      return record;
    } catch (error) {
      const primary =
        error instanceof WorkspaceRecordError
          ? error
          : publicationFailure(temporary, id, "publication");
      if (!owned) {
        // No initial identity was captured: a later lstat cannot establish ownership retroactively.
        primary.message += `: cleanup incomplete (${id})`;
        throw primary;
      }
      try {
        requireBuildOwnership(root, parent, temporary, owned);
        rmSync(temporary, { recursive: true, force: true });
      } catch {
        primary.message += `: cleanup failed (${id})`;
      }
      throw primary;
    }
  }
}

/**
 * Verify executable permissions and SHA256 through an identity-bound descriptor without mkdir.
 * This verifies the bytes read now, not immunity to external modification after verification.
 */
export function verifyBuildBinary(cwd: string, value: BuildRecord): void {
  const rawId: unknown =
    typeof value === "object" && value !== null
      ? Reflect.get(value, recordTypes.build.field)
      : undefined;
  const id = validatedId("build", rawId);
  const record = parseRecord("build", value);
  const metadataPath = workspacePath(cwd, "build", id, true);
  const path = join(dirname(metadataPath), recordTypes.build.binary);
  const inspected = checkedFile(path);
  if (!inspected) throw new WorkspaceRecordError("missing", path);
  if ((inspected.mode & 0o111) === 0) throw new WorkspaceRecordError("target", path);
  try {
    // Execute bits alone do not determine whether the current user can execute this file.
    accessSync(path, constants.X_OK);
  } catch {
    throw new WorkspaceRecordError("target", path);
  }
  let fd: number | undefined;
  let open = false;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    open = true;
    const descriptor = fstatSync(fd);
    if (
      !descriptor.isFile() ||
      (descriptor.mode & 0o111) === 0 ||
      descriptor.dev !== inspected.dev ||
      descriptor.ino !== inspected.ino
    ) {
      throw new WorkspaceRecordError("target", path);
    }
    if (hashDescriptor(fd) !== record.binary_sha256) {
      throw new WorkspaceRecordError("identity", path);
    }
    closeSync(fd);
    open = false;
  } catch (error) {
    const primary =
      error instanceof WorkspaceRecordError ? error : new WorkspaceRecordError("read", path);
    if (open && fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        primary.message += ": descriptor cleanup failed";
      }
    }
    throw primary;
  }
}

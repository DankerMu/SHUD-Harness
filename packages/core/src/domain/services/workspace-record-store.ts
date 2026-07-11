import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { TaskServiceError, type TaskServiceErrorCode } from "./task-card-service";
import {
  readDurableSingleLinkFile,
  type DurableSingleLinkReadFailureReason
} from "./durable-single-link-reader";
import {
  WorkspacePathSafetyError,
  isPathInsideBoundary,
  physicalCanonicalPath,
  resolveWorkspacePath
} from "./workspace-path-safety";

export const MAX_SERVICE_RECORD_BYTES = 1024 * 1024;

const SAFE_RECORD_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAX_RECORD_AUTHORITY_RESERVATIONS = 1024;
const MAX_RECORD_AUTHORITY_RESERVATIONS_PER_PATH = 64;
const RECORD_AUTHORITY_ACQUISITION_TIMEOUT_MS = 5_000;
const RECORD_TEMP_CLEANUP_ATTEMPTS = 3;
const RECORD_TEMP_CLEANUP_RETRY_MS = 5;
const RECORD_NAMESPACE_CLEANUP_ATTEMPTS = 3;

type FileStat = Awaited<ReturnType<typeof lstat>>;
type RecordFileHandle = Awaited<ReturnType<typeof open>>;

interface OwnedTemporaryRecordIdentity {
  dev: number;
  ino: number;
}

interface OwnedTemporaryRecord {
  identity: OwnedTemporaryRecordIdentity;
  file: RecordFileHandle;
}

interface OwnedIsolatedGeneration {
  namespacePath: string;
  path: string;
  identity: OwnedTemporaryRecordIdentity;
}

interface HardlinkPublicationOwnedResources {
  temporaryPath: string;
  canonicalPath: string;
  expectedBytes: Buffer;
  temporaryRecord?: OwnedTemporaryRecord;
  temporaryIdentity?: OwnedTemporaryRecordIdentity;
  isolatedGeneration?: OwnedIsolatedGeneration;
  canonicalIdentity?: OwnedTemporaryRecordIdentity;
  handleClosed: boolean;
  compensationErrors: unknown[];
}

type WorkspaceRecordAuthorityOperation = "read" | "rename" | "hardlink" | "delete";

interface RecordAuthorityWaiter {
  resolve: (lease: RecordAuthorityLease) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  active: boolean;
  deadline: number;
  evidenceRef: string;
}

interface RecordAuthorityCleanupWaiter {
  resolve: (lease: RecordAuthorityLease) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  active: boolean;
  deadline: number;
  evidenceRef: string;
}

interface RecordAuthorityMutex {
  waiters: Set<RecordAuthorityWaiter>;
  cleanupWaiters: Set<RecordAuthorityCleanupWaiter>;
  reservations: number;
  cleanupPermits: number;
  ownerActive: boolean;
}

interface RecordAuthorityLease {
  release: () => void;
  reserveCleanupPermit: (evidenceRef: string) => WorkspaceRecordCleanupPermit;
}

export interface WorkspaceRecordCleanupPermit {}

const cleanupPermitState = new WeakMap<
  WorkspaceRecordCleanupPermit,
  { identity: string; mutex: RecordAuthorityMutex; used: boolean }
>();

export interface WorkspaceRecordPublicationHookInput {
  canonicalPath: string;
  temporaryPath: string;
}

export interface WorkspaceRecordTemporaryCleanupHookInput extends WorkspaceRecordPublicationHookInput {
  attempt: number;
}

export interface WorkspaceRecordPublicationHooks {
  afterCanonicalLink?: (input: WorkspaceRecordPublicationHookInput) => Promise<void> | void;
  beforeTemporaryUnlink?: (input: WorkspaceRecordTemporaryCleanupHookInput) => Promise<void> | void;
  afterTemporaryFileWritten?: (input: WorkspaceRecordPublicationHookInput) => Promise<void> | void;
  afterTemporaryFileClosed?: (
    input: WorkspaceRecordPublicationHookInput
  ) => Promise<void> | void;
  afterAuthorityLeaseAcquired?: (
    input: Readonly<{ operation: WorkspaceRecordAuthorityOperation }>
  ) => Promise<void> | void;
  onAuthorityContention?: (
    input: Readonly<{ operation: WorkspaceRecordAuthorityOperation; deadline: number }>
  ) => void;
  beforePublishedRecordFinalValidation?: (
    input: Readonly<{ path: string }>
  ) => Promise<void> | void;
  beforeCleanupPermitIdentityResolution?: (
    input: Readonly<{ path: string }>
  ) => Promise<void> | void;
  beforeConditionalDelete?: (
    input: Readonly<{
      path: string;
      conditionStatus: "matched" | "not_matched";
    }>
  ) => Promise<void> | void;
  beforeGenerationIsolation?: (
    input: Readonly<{
      path: string;
      operation:
        | "conditional_delete"
        | "rename_publication"
        | "rename_temp_cleanup"
        | "hardlink_temp_cleanup";
    }>
  ) => Promise<void> | void;
  beforeAuthorityOwnedUnlink?: (
    input: Readonly<{
      path: string;
      operation:
        | "conditional_delete"
        | "restore_cleanup"
        | "rename_prior_cleanup"
        | "rename_temp_cleanup"
        | "hardlink_temp_cleanup";
    }>
  ) => Promise<void> | void;
  beforeAuthorityNamespaceRemoval?: (
    input: Readonly<{ path: string; attempt: number }>
  ) => Promise<void> | void;
}

const activeRecordAuthorityMutexes = new Map<string, RecordAuthorityMutex>();
let activeRecordAuthorityReservations = 0;
let activeRecordAuthorityCleanupPermits = 0;
const publicationHookStorage = new AsyncLocalStorage<WorkspaceRecordPublicationHooks>();
const authorityDeadlineStorage = new AsyncLocalStorage<number>();

export async function runWithWorkspaceRecordPublicationHooks<T>(
  hooks: WorkspaceRecordPublicationHooks,
  action: () => Promise<T>
): Promise<T> {
  return await publicationHookStorage.run(hooks, action);
}

export async function runWithWorkspaceRecordAuthorityDeadline<T>(
  deadline: number,
  action: () => Promise<T>
): Promise<T> {
  return await authorityDeadlineStorage.run(deadline, action);
}

export class WorkspaceRecordConditionalDeleteError extends Error {
  readonly mutationPhase: "pre_mutation" | "post_mutation";
  readonly failureStage: "permit_admission" | "operation";

  constructor(
    mutationPhase: "pre_mutation" | "post_mutation",
    failureStage: "permit_admission" | "operation",
    cause: unknown
  ) {
    super(
      mutationPhase === "pre_mutation"
        ? "Conditional workspace record deletion failed before mutation."
        : "Conditional workspace record deletion failed after mutation started.",
      { cause }
    );
    this.name = "WorkspaceRecordConditionalDeleteError";
    this.mutationPhase = mutationPhase;
    this.failureStage = failureStage;
  }
}

export function assertSafeRecordSegment(segment: string, evidenceRef: string): void {
  if (SAFE_RECORD_SEGMENT_PATTERN.test(segment)) {
    return;
  }

  throw new TaskServiceError({
    code: "record_id_not_safe",
    status: 400,
    category: "schema_error",
    message: "Record id is not a safe workspace path segment.",
    userMessage: "The record id contains unsupported path characters.",
    evidenceRefs: [evidenceRef],
    recommendedNextActions: ["Use an id made from letters, numbers, dots, dashes, or underscores."]
  });
}

export function assertSafeRelativeRecordPath(path: string, evidenceRef: string): void {
  const rawSegments = path.split(/[\\/]+/).filter(Boolean);
  const normalizedPath = normalize(path);
  const segments = normalizedPath.split(sep).filter(Boolean);
  if (
    path.trim().length > 0 &&
    !isAbsolute(path) &&
    !rawSegments.includes("..") &&
    normalizedPath !== "." &&
    normalizedPath !== ".." &&
    !normalizedPath.startsWith(`..${sep}`) &&
    !segments.includes("..")
  ) {
    return;
  }

  throw new TaskServiceError({
    code: "record_id_not_safe",
    status: 400,
    category: "schema_error",
    message: "Record path is not a safe workspace-relative path.",
    userMessage: "The record path must stay inside the workspace.",
    evidenceRefs: [evidenceRef],
    recommendedNextActions: ["Use a workspace-relative path without parent-directory traversal."]
  });
}

export function workspaceRecordPath(
  workspaceRoot: string,
  relativeSegments: readonly string[],
  evidenceRef: string
): string {
  const resolvedRoot = resolve(workspaceRoot);
  const targetPath = join(resolvedRoot, ...relativeSegments);
  assertPathInsideWorkspace(resolvedRoot, targetPath, evidenceRef);
  return targetPath;
}

export async function ensureWorkspaceRecordDirectory(
  workspaceRoot: string,
  relativeSegments: readonly string[],
  evidenceRef: string
): Promise<string> {
  const resolvedRoot = resolve(workspaceRoot);
  await ensureSafeDirectory(resolvedRoot, "workspace");

  let currentPath = resolvedRoot;
  for (const segment of relativeSegments) {
    currentPath = join(currentPath, segment);
    assertPathInsideWorkspace(resolvedRoot, currentPath, evidenceRef);
    await ensureSafeDirectory(currentPath, evidenceRef);
  }

  return currentPath;
}

export async function readJsonRecord<T>(
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<T | undefined> {
  const hooks = publicationHookStorage.getStore();
  const authorityLease = await acquireRecordAuthority(path, evidenceRef, "read", hooks);
  try {
    await hooks?.afterAuthorityLeaseAcquired?.(Object.freeze({ operation: "read" }));
    return await readJsonRecordUnderAuthority(path, evidenceRef, schema);
  } finally {
    authorityLease.release();
  }
}

export type ConditionalDeleteJsonRecordCondition<T> =
  | {
      kind: "record";
      expected: T;
      matches: (current: T, expected: T) => boolean;
    }
  | { kind: "malformed" };

export type ConditionalDeleteJsonRecordResult =
  { status: "deleted" } | { status: "missing" } | { status: "condition_not_met" };

export async function conditionalDeleteJsonRecordWithCleanupPermit<T>(
  permit: WorkspaceRecordCleanupPermit,
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>,
  condition: ConditionalDeleteJsonRecordCondition<T>
): Promise<ConditionalDeleteJsonRecordResult> {
  const hooks = publicationHookStorage.getStore();
  let authorityLease: RecordAuthorityLease;
  try {
    authorityLease = await acquireRecordAuthorityWithCleanupPermit(
      permit,
      path,
      evidenceRef,
      hooks
    );
  } catch (error) {
    throw new WorkspaceRecordConditionalDeleteError("pre_mutation", "permit_admission", error);
  }
  const mutationState = { started: false };
  try {
    try {
      await hooks?.afterAuthorityLeaseAcquired?.(Object.freeze({ operation: "delete" }));
      return await conditionalDeleteJsonRecordUnderAuthority(
        path,
        evidenceRef,
        schema,
        condition,
        hooks,
        mutationState
      );
    } catch (error) {
      throw new WorkspaceRecordConditionalDeleteError(
        mutationState.started ? "post_mutation" : "pre_mutation",
        "operation",
        error
      );
    }
  } finally {
    authorityLease.release();
  }
}

/**
 * Strictly reads, compares, and removes one canonical record while holding the
 * same physical-path authority used by all record readers and publishers.
 */
export async function conditionalDeleteJsonRecord<T>(
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>,
  condition: ConditionalDeleteJsonRecordCondition<T>
): Promise<ConditionalDeleteJsonRecordResult> {
  const hooks = publicationHookStorage.getStore();
  const authorityLease = await acquireRecordAuthority(path, evidenceRef, "delete", hooks);
  try {
    await hooks?.afterAuthorityLeaseAcquired?.(Object.freeze({ operation: "delete" }));
    return await conditionalDeleteJsonRecordUnderAuthority(
      path,
      evidenceRef,
      schema,
      condition,
      hooks
    );
  } finally {
    authorityLease.release();
  }
}

async function conditionalDeleteJsonRecordUnderAuthority<T>(
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>,
  condition: ConditionalDeleteJsonRecordCondition<T>,
  hooks?: WorkspaceRecordPublicationHooks,
  mutationState?: { started: boolean }
): Promise<ConditionalDeleteJsonRecordResult> {
  const observedIdentity = await readRecordPathIdentity(path, evidenceRef);
  if (!observedIdentity) {
    return { status: "missing" };
  }

  const observation = await inspectJsonRecordUnderAuthority(path, evidenceRef, schema);
  if (observation.status === "missing") {
    return { status: "missing" };
  }
  const matched =
    condition.kind === "malformed"
      ? observation.status === "malformed"
      : observation.status === "record" &&
        condition.matches(observation.record, condition.expected);
  await hooks?.beforeConditionalDelete?.(
    Object.freeze({
      path,
      conditionStatus: matched ? "matched" : "not_matched"
    })
  );
  if (!matched) {
    return { status: "condition_not_met" };
  }

  if (mutationState) mutationState.started = true;
  const mutationNamespace = await createAuthorityOwnedMutationNamespace(path, evidenceRef);
  const quarantinePath = join(mutationNamespace, "generation");
  try {
    await hooks?.beforeGenerationIsolation?.(
      Object.freeze({ path, operation: "conditional_delete" })
    );
    await rename(path, quarantinePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
      return { status: "missing" };
    }
    await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Failed to conditionally remove workspace record.",
      "The workspace record could not be removed safely.",
      [evidenceRef],
      error
    );
  }

  let quarantinedIdentity: OwnedTemporaryRecordIdentity | undefined;
  try {
    quarantinedIdentity = await readRegularFilePathIdentity(quarantinePath, evidenceRef);
    if (
      quarantinedIdentity?.dev === observedIdentity.dev &&
      quarantinedIdentity.ino === observedIdentity.ino &&
      (await isolatedBytesEqual(quarantinePath, observation.bytes, evidenceRef))
    ) {
      await hooks?.beforeAuthorityOwnedUnlink?.(
        Object.freeze({ path, operation: "conditional_delete" })
      );
      if (
        !(await ownedGenerationBytesEqual(
          quarantinePath,
          observedIdentity,
          observation.bytes,
          evidenceRef
        ))
      ) {
        throw recordChangedBeforeConditionalRemovalError(evidenceRef);
      }
      await unlink(quarantinePath);
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
      return { status: "deleted" };
    }

    await restoreQuarantinedRecordNoClobber(quarantinePath, path, evidenceRef, hooks);
    await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
    throw recordChangedBeforeConditionalRemovalError(evidenceRef);
  } catch (error) {
    const compensationErrors: unknown[] = [];
    if (await recordPathEntryExists(quarantinePath, evidenceRef)) {
      try {
        await restoreOwnedIsolatedPath(quarantinePath, path, evidenceRef);
        await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
      } catch (compensationError) {
        compensationErrors.push(compensationError);
      }
    }
    const primary = preserveWorkspacePrimaryError(error, compensationErrors);
    if (primary instanceof TaskServiceError) throw primary;
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Failed to remove quarantined workspace record.",
      "The workspace record could not be removed safely.",
      [evidenceRef],
      primary
    );
  }
}

async function restoreQuarantinedRecordNoClobber(
  quarantinePath: string,
  canonicalPath: string,
  evidenceRef: string,
  hooks?: WorkspaceRecordPublicationHooks
): Promise<void> {
  try {
    await link(quarantinePath, canonicalPath);
  } catch (error) {
    throw serviceWorkspaceError(
      "record_malformed",
      "Workspace record changed before conditional removal and its replacement was preserved in quarantine.",
      "The workspace record changed before it could be removed safely.",
      [evidenceRef],
      error
    );
  }

  try {
    await hooks?.beforeAuthorityOwnedUnlink?.(
      Object.freeze({ path: canonicalPath, operation: "restore_cleanup" })
    );
    const restoredIdentity = await readRegularFilePathIdentity(canonicalPath, evidenceRef);
    const quarantinedIdentity = await readRegularFilePathIdentity(quarantinePath, evidenceRef);
    if (
      !restoredIdentity ||
      !quarantinedIdentity ||
      restoredIdentity.dev !== quarantinedIdentity.dev ||
      restoredIdentity.ino !== quarantinedIdentity.ino
    ) {
      throw recordChangedBeforeConditionalRemovalError(evidenceRef);
    }
    await unlink(quarantinePath);
  } catch (error) {
    throw serviceWorkspaceError(
      "record_malformed",
      "Workspace record replacement was restored but its quarantine alias could not be removed.",
      "The workspace record changed before it could be removed safely.",
      [evidenceRef],
      error
    );
  }
}

function recordChangedBeforeConditionalRemovalError(evidenceRef: string): TaskServiceError {
  return serviceWorkspaceError(
    "record_malformed",
    "Workspace record changed before conditional removal.",
    "The workspace record changed before it could be removed safely.",
    [evidenceRef]
  );
}

type JsonRecordInspection<T> =
  | { status: "missing" }
  | { status: "record"; record: T; bytes: Buffer }
  | { status: "malformed"; error: TaskServiceError; bytes: Buffer };

async function readJsonRecordUnderAuthority<T>(
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<T | undefined> {
  const inspection = await inspectJsonRecordUnderAuthority(path, evidenceRef, schema);
  if (inspection.status === "missing") {
    return undefined;
  }
  if (inspection.status === "malformed") {
    throw inspection.error;
  }
  return inspection.record;
}

async function inspectJsonRecordUnderAuthority<T>(
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<JsonRecordInspection<T>> {
  const durableRead = await readDurableSingleLinkFile({
    path,
    maxBytes: MAX_SERVICE_RECORD_BYTES,
    validateParentPath: async () => await isSafeExistingDirectoryPath(dirname(path))
  });
  if (durableRead.status === "missing") {
    return { status: "missing" };
  }
  if (durableRead.status === "invalid") {
    throw recordDurableReadError(durableRead.reason, evidenceRef, durableRead.cause);
  }

  let rawRecord: unknown;
  try {
    rawRecord = JSON.parse(durableRead.bytes.toString("utf8")) as unknown;
  } catch (error) {
    return {
      status: "malformed",
      bytes: durableRead.bytes,
      error: serviceWorkspaceError(
        "record_malformed",
        "Record is not valid JSON.",
        "A workspace record is malformed.",
        [evidenceRef],
        error
      )
    };
  }

  const parsedRecord = schema.safeParse(rawRecord);
  if (!parsedRecord.success) {
    return {
      status: "malformed",
      bytes: durableRead.bytes,
      error: new TaskServiceError({
        code: "record_schema_error",
        status: 400,
        category: "schema_error",
        message: "Workspace record failed schema validation.",
        userMessage: "A workspace record has invalid fields.",
        evidenceRefs: toSchemaEvidenceRefs(parsedRecord.error, evidenceRef),
        recommendedNextActions: ["Inspect and repair the workspace record before retrying."]
      })
    };
  }

  return { status: "record", record: parsedRecord.data, bytes: durableRead.bytes };
}

async function isolatedBytesEqual(
  path: string,
  expectedBytes: Buffer,
  evidenceRef: string
): Promise<boolean> {
  const observed = await readDurableSingleLinkFile({
    path,
    maxBytes: MAX_SERVICE_RECORD_BYTES,
    validateParentPath: async () => await isSafeExistingDirectoryPath(dirname(path))
  });
  if (observed.status === "invalid") {
    throw recordDurableReadError(observed.reason, evidenceRef, observed.cause);
  }
  return observed.status === "read" && observed.bytes.equals(expectedBytes);
}

async function readRecordPathIdentity(
  path: string,
  evidenceRef: string
): Promise<OwnedTemporaryRecordIdentity | undefined> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw recordDurableReadError("not_regular_file", evidenceRef);
    }
    if (entry.nlink !== 1) {
      throw recordDurableReadError("multiple_links", evidenceRef);
    }
    return { dev: entry.dev, ino: entry.ino };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return undefined;
    }
    if (error instanceof TaskServiceError) {
      throw error;
    }
    throw recordDurableReadError("inspect_failed", evidenceRef, error);
  }
}

async function readRegularFilePathIdentity(
  path: string,
  evidenceRef: string
): Promise<OwnedTemporaryRecordIdentity | undefined> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw recordDurableReadError("not_regular_file", evidenceRef);
    }
    return { dev: entry.dev, ino: entry.ino };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return undefined;
    }
    if (error instanceof TaskServiceError) throw error;
    throw recordDurableReadError("inspect_failed", evidenceRef, error);
  }
}

async function createAuthorityOwnedMutationNamespace(
  publicPath: string,
  evidenceRef: string
): Promise<string> {
  const namespacePath = join(
    dirname(publicPath),
    `.${parse(publicPath).base}-${process.pid}-${randomUUID()}.authority`
  );
  try {
    await mkdir(namespacePath, { mode: 0o700 });
    const entry = await lstat(namespacePath);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o700) {
      await rmdir(namespacePath);
      throw publicationStateError(evidenceRef);
    }
    return namespacePath;
  } catch (error) {
    if (error instanceof TaskServiceError) throw error;
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Failed to create a private workspace mutation namespace.",
      "The workspace record could not be mutated safely.",
      [evidenceRef],
      error
    );
  }
}

async function removeEmptyAuthorityOwnedMutationNamespace(
  namespacePath: string,
  evidenceRef: string
): Promise<void> {
  let primaryError: unknown;
  const compensationErrors: unknown[] = [];
  for (let attempt = 1; attempt <= RECORD_NAMESPACE_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await publicationHookStorage
        .getStore()
        ?.beforeAuthorityNamespaceRemoval?.(Object.freeze({ path: namespacePath, attempt }));
      await rmdir(namespacePath);
      return;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return;
      if (primaryError === undefined) primaryError = error;
      else compensationErrors.push(error);
      if (attempt < RECORD_NAMESPACE_CLEANUP_ATTEMPTS) {
        await sleep(RECORD_TEMP_CLEANUP_RETRY_MS);
      }
    }
  }

  throw serviceWorkspaceError(
    "workspace_path_not_safe",
    "Workspace mutation namespace cleanup did not complete.",
    "The workspace record mutation could not be finalized safely.",
    [evidenceRef],
    preserveWorkspacePrimaryError(primaryError, compensationErrors)
  );
}

export async function writeJsonRecord<T>(
  workspaceRoot: string,
  relativeDirectorySegments: readonly string[],
  fileName: string,
  record: T,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<T> {
  const { data, directoryPath, recordPath, recordText } = await prepareJsonRecordWrite(
    workspaceRoot,
    relativeDirectorySegments,
    fileName,
    record,
    evidenceRef,
    schema
  );

  const temporaryPath = join(directoryPath, `.${fileName}-${process.pid}-${randomUUID()}.tmp`);
  let temporaryRecord: OwnedTemporaryRecord | undefined;
  let authorityLease: RecordAuthorityLease | undefined;
  let published = false;
  let operationError: unknown;
  const compensationErrors: unknown[] = [];
  const hooks = publicationHookStorage.getStore();
  try {
    try {
      authorityLease = await acquireRecordAuthority(recordPath, evidenceRef, "rename", hooks);
      await hooks?.afterAuthorityLeaseAcquired?.(Object.freeze({ operation: "rename" }));
      temporaryRecord = await writeTemporaryRecordFile(
        temporaryPath,
        recordText,
        evidenceRef
      );
      await hooks?.afterTemporaryFileWritten?.({
        canonicalPath: recordPath,
        temporaryPath
      });
      if (!(await isSafeExistingDirectoryPath(directoryPath))) {
        throw serviceWorkspaceError(
          "workspace_path_not_safe",
          "Record directory is not a safe directory.",
          "A workspace record directory is not usable.",
          [evidenceRef]
        );
      }
      await publishOwnedMutableRecord(
        temporaryPath,
        temporaryRecord,
        recordPath,
        recordText,
        evidenceRef,
        hooks
      );
      published = true;
    } catch (error) {
      operationError = error;
    }

    if (temporaryRecord) {
      try {
        await temporaryRecord.file.close();
        await hooks?.afterTemporaryFileClosed?.({
          canonicalPath: recordPath,
          temporaryPath
        });
      } catch (cleanupError) {
        if (operationError === undefined) operationError = cleanupError;
        else compensationErrors.push(cleanupError);
      }
      if (!published && (await recordPathEntryExists(temporaryPath, evidenceRef))) {
        try {
          await removeOwnedPublicationTemporaryPath(
            temporaryPath,
            temporaryRecord.identity,
            Buffer.from(recordText, "utf8"),
            recordPath,
            evidenceRef,
            hooks,
            "rename_temp_cleanup"
          );
        } catch (cleanupError) {
          if (operationError === undefined) operationError = cleanupError;
          else compensationErrors.push(cleanupError);
        }
      }
    }
    if (operationError !== undefined) {
      const settledError = preserveWorkspacePrimaryError(operationError, compensationErrors);
      if (settledError instanceof TaskServiceError) throw settledError;
      throw serviceWorkspaceError(
        "workspace_path_not_safe",
        "Failed to persist workspace record.",
        "The workspace record could not be written safely.",
        [evidenceRef],
        settledError
      );
    }
  } finally {
    authorityLease?.release();
  }

  return data;
}

async function publishOwnedMutableRecord(
  temporaryPath: string,
  temporaryRecord: OwnedTemporaryRecord,
  recordPath: string,
  recordText: string,
  evidenceRef: string,
  hooks?: WorkspaceRecordPublicationHooks
): Promise<void> {
  await assertOwnedTemporaryRecordPath(temporaryPath, temporaryRecord.identity, evidenceRef);
  await assertOpenRecordAuthority(temporaryRecord, recordText, 1, evidenceRef);
  await hooks?.beforeGenerationIsolation?.(
    Object.freeze({ path: temporaryPath, operation: "rename_publication" })
  );
  await assertOwnedTemporaryRecordPath(temporaryPath, temporaryRecord.identity, evidenceRef);
  await assertOpenRecordAuthority(temporaryRecord, recordText, 1, evidenceRef);
  try {
    await rename(temporaryPath, recordPath);
  } catch (error) {
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Failed to publish the captured workspace record generation.",
      "The workspace record could not be published safely.",
      [evidenceRef],
      error
    );
  }
}

export type CreateJsonRecordResult<T> = { status: "created"; record: T } | { status: "exists" };

export type CreateJsonRecordWithCleanupPermitResult<T> =
  | {
      status: "created";
      record: T;
      cleanupPermit: WorkspaceRecordCleanupPermit;
    }
  | { status: "exists" };

export async function createJsonRecordIfAbsent<T>(
  workspaceRoot: string,
  relativeDirectorySegments: readonly string[],
  fileName: string,
  record: T,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<CreateJsonRecordResult<T>> {
  return await createJsonRecordIfAbsentInternal(
    workspaceRoot,
    relativeDirectorySegments,
    fileName,
    record,
    evidenceRef,
    schema,
    false
  );
}

export async function createJsonRecordIfAbsentWithCleanupPermit<T>(
  workspaceRoot: string,
  relativeDirectorySegments: readonly string[],
  fileName: string,
  record: T,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<CreateJsonRecordWithCleanupPermitResult<T>> {
  return (await createJsonRecordIfAbsentInternal(
    workspaceRoot,
    relativeDirectorySegments,
    fileName,
    record,
    evidenceRef,
    schema,
    true
  )) as CreateJsonRecordWithCleanupPermitResult<T>;
}

async function createJsonRecordIfAbsentInternal<T>(
  workspaceRoot: string,
  relativeDirectorySegments: readonly string[],
  fileName: string,
  record: T,
  evidenceRef: string,
  schema: z.ZodType<T>,
  reserveCleanupPermit: boolean
): Promise<CreateJsonRecordResult<T> | CreateJsonRecordWithCleanupPermitResult<T>> {
  const { data, directoryPath, recordPath, recordText } = await prepareJsonRecordWrite(
    workspaceRoot,
    relativeDirectorySegments,
    fileName,
    record,
    evidenceRef,
    schema
  );

  const temporaryPath = join(directoryPath, `.${fileName}-${process.pid}-${randomUUID()}.tmp`);
  const hooks = publicationHookStorage.getStore();
  const ownedResources: HardlinkPublicationOwnedResources = {
    temporaryPath,
    canonicalPath: recordPath,
    expectedBytes: Buffer.from(recordText, "utf8"),
    handleClosed: false,
    compensationErrors: []
  };
  let authorityLease: RecordAuthorityLease | undefined;
  let publicationOutcome: "published" | "exists" | undefined;
  let operationError: unknown;
  const compensationErrors = ownedResources.compensationErrors;
  let cleanupPermit: WorkspaceRecordCleanupPermit | undefined;
  try {
    try {
      authorityLease = await acquireRecordAuthority(recordPath, evidenceRef, "hardlink", hooks);
      await hooks?.afterAuthorityLeaseAcquired?.(Object.freeze({ operation: "hardlink" }));
      if (!(await isSafeExistingDirectoryPath(directoryPath))) {
        throw serviceWorkspaceError(
          "workspace_path_not_safe",
          "Record directory is not a safe directory.",
          "A workspace record directory is not usable.",
          [evidenceRef]
        );
      }
      if (reserveCleanupPermit && (await recordPathEntryExists(recordPath, evidenceRef))) {
        publicationOutcome = "exists";
      } else if (reserveCleanupPermit) {
        cleanupPermit = reserveRecordAuthorityCleanupPermit(authorityLease, evidenceRef);
      }
      if (publicationOutcome === "exists") {
        return { status: "exists" };
      }
      ownedResources.temporaryRecord = await writeTemporaryRecordFile(
        temporaryPath,
        recordText,
        evidenceRef
      );
      ownedResources.temporaryIdentity = ownedResources.temporaryRecord.identity;
      await hooks?.afterTemporaryFileWritten?.({
        canonicalPath: recordPath,
        temporaryPath
      });
      await assertOwnedTemporaryRecordPath(
        temporaryPath,
        ownedResources.temporaryIdentity,
        evidenceRef
      );
      try {
        await link(temporaryPath, recordPath);
        publicationOutcome = "published";
        ownedResources.canonicalIdentity = ownedResources.temporaryIdentity;
        await hooks?.afterCanonicalLink?.({
          canonicalPath: recordPath,
          temporaryPath
        });
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) {
          publicationOutcome = "exists";
        } else {
          throw serviceWorkspaceError(
            "workspace_path_not_safe",
            "Failed to publish workspace record claim.",
            "The workspace record could not be written safely.",
            [evidenceRef],
            error
          );
        }
      }
    } catch (error) {
      operationError = error;
    }

    if (ownedResources.temporaryRecord && !ownedResources.handleClosed) {
      try {
        await closeOwnedTemporaryRecord(ownedResources, hooks);
      } catch (cleanupError) {
        if (operationError === undefined) operationError = cleanupError;
        else compensationErrors.push(cleanupError);
      }
    }

    if (ownedResources.temporaryIdentity) {
      try {
        await removeOwnedPublicationTemporaryPath(
          temporaryPath,
          ownedResources.temporaryIdentity,
          ownedResources.expectedBytes,
          recordPath,
          evidenceRef,
          hooks,
          "hardlink_temp_cleanup",
          ownedResources
        );
      } catch (cleanupError) {
        if (operationError === undefined) operationError = cleanupError;
        else compensationErrors.push(cleanupError);
      }
    }

    if (publicationOutcome === "published" && operationError === undefined) {
      try {
        await assertPublishedRecordAuthority(
          recordPath,
          directoryPath,
          recordText,
          evidenceRef,
          ownedResources.canonicalIdentity,
          hooks
        );
      } catch (error) {
        operationError = error;
      }
    }

    if (
      publicationOutcome === "published" &&
      operationError !== undefined &&
      ownedResources.canonicalIdentity
    ) {
      try {
        await rollbackPublishedRecordClaim(
          recordPath,
          ownedResources.canonicalIdentity,
          ownedResources.expectedBytes,
          evidenceRef
        );
      } catch (error) {
        compensationErrors.push(error);
      }
      if (await recordPathEntryExists(temporaryPath, evidenceRef)) {
        try {
          await removeOwnedPathWithoutHooks(
            temporaryPath,
            ownedResources.temporaryIdentity ?? ownedResources.canonicalIdentity,
            ownedResources.expectedBytes,
            evidenceRef
          );
        } catch (error) {
          compensationErrors.push(error);
        }
      }
      publicationOutcome = undefined;
    }

    if (
      publicationOutcome !== "published" &&
      operationError !== undefined &&
      ownedResources.temporaryIdentity &&
      (await recordPathEntryExists(temporaryPath, evidenceRef))
    ) {
      try {
        await removeOwnedPathWithoutHooks(
          temporaryPath,
          ownedResources.temporaryIdentity,
          ownedResources.expectedBytes,
          evidenceRef
        );
      } catch (error) {
        compensationErrors.push(error);
      }
    }

    if (operationError !== undefined) {
      cancelRecordAuthorityCleanupPermit(cleanupPermit);
      throw preserveWorkspacePrimaryError(operationError, compensationErrors);
    }

    if (publicationOutcome === "exists") {
      cancelRecordAuthorityCleanupPermit(cleanupPermit);
      return { status: "exists" };
    }
    if (publicationOutcome !== "published") {
      throw publicationStateError(evidenceRef);
    }

    return cleanupPermit
      ? { status: "created", record: data, cleanupPermit }
      : { status: "created", record: data };
  } finally {
    authorityLease?.release();
  }
}

async function closeOwnedTemporaryRecord(
  ownedResources: HardlinkPublicationOwnedResources,
  hooks: WorkspaceRecordPublicationHooks | undefined
): Promise<void> {
  const temporaryRecord = ownedResources.temporaryRecord;
  if (!temporaryRecord || ownedResources.handleClosed) return;
  try {
    await temporaryRecord.file.close();
    ownedResources.handleClosed = true;
  } finally {
    if (ownedResources.handleClosed) {
      await hooks?.afterTemporaryFileClosed?.({
        canonicalPath: ownedResources.canonicalPath,
        temporaryPath: ownedResources.temporaryPath
      });
    }
  }
}

async function recordPathEntryExists(path: string, evidenceRef: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return false;
    }
    throw publicationStateError(evidenceRef);
  }
}

async function writeTemporaryRecordFile(
  temporaryPath: string,
  recordText: string,
  evidenceRef: string
): Promise<OwnedTemporaryRecord> {
  let temporaryFile: RecordFileHandle | undefined;
  let temporaryIdentity: OwnedTemporaryRecordIdentity | undefined;
  let shouldCleanup = false;
  let operationError: unknown;
  try {
    temporaryFile = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
    );
    shouldCleanup = true;
    const entry = await temporaryFile.stat();
    if (!entry.isFile()) {
      throw publicationStateError(evidenceRef);
    }
    temporaryIdentity = { dev: entry.dev, ino: entry.ino };
    await temporaryFile.writeFile(recordText, "utf8");
    return { identity: temporaryIdentity, file: temporaryFile };
  } catch (error) {
    operationError = serviceWorkspaceError(
      "workspace_path_not_safe",
      "Failed to write workspace record temporary file.",
      "The workspace record could not be written safely.",
      [evidenceRef],
      error
    );
  }

  const cleanupErrors: unknown[] = [];
  if (shouldCleanup) {
    let observedBytes: Buffer | undefined;
    if (temporaryFile) {
      try {
        observedBytes = await readBoundedOpenFileBytes(temporaryFile);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await temporaryFile.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (temporaryIdentity && observedBytes) {
      try {
        await conditionalUnlinkOwnedPath(
          temporaryPath,
          temporaryIdentity,
          observedBytes,
          evidenceRef
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  throw preserveWorkspacePrimaryError(operationError, cleanupErrors);
}

async function conditionalUnlinkOwnedPath(
  path: string,
  expected: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string
): Promise<void> {
  const mutationNamespace = await createAuthorityOwnedMutationNamespace(path, evidenceRef);
  const isolatedPath = join(mutationNamespace, "generation");
  try {
    await rename(path, isolatedPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
      return;
    }
    await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
    throw error;
  }
  const isolatedIdentity = await readRegularFilePathIdentity(isolatedPath, evidenceRef);
  if (
    !isolatedIdentity ||
    isolatedIdentity.dev !== expected.dev ||
    isolatedIdentity.ino !== expected.ino ||
    !(await ownedGenerationBytesEqual(isolatedPath, expected, expectedBytes, evidenceRef))
  ) {
    await restoreQuarantinedRecordNoClobber(isolatedPath, path, evidenceRef);
    await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
    throw publicationStateError(evidenceRef);
  }
  if (!(await ownedGenerationBytesEqual(isolatedPath, expected, expectedBytes, evidenceRef))) {
    await restoreQuarantinedRecordNoClobber(isolatedPath, path, evidenceRef);
    await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
    throw publicationStateError(evidenceRef);
  }
  await unlink(isolatedPath);
  await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
}

async function readBoundedOpenFileBytes(file: RecordFileHandle): Promise<Buffer> {
  const before = await file.stat();
  if (!before.isFile() || before.size > MAX_SERVICE_RECORD_BYTES) {
    throw new Error("Temporary record bytes are not bounded.");
  }
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const after = await file.stat();
  if (offset !== bytes.length || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
    throw new Error("Temporary record bytes changed while observed.");
  }
  return bytes;
}

async function removeOwnedPublicationTemporaryPath(
  temporaryPath: string,
  temporaryIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  recordPath: string,
  evidenceRef: string,
  hooks: WorkspaceRecordPublicationHooks | undefined,
  operation: "rename_temp_cleanup" | "hardlink_temp_cleanup",
  ownedResources?: HardlinkPublicationOwnedResources
): Promise<void> {
  const attemptErrors: unknown[] = [];
  for (let attempt = 1; attempt <= RECORD_TEMP_CLEANUP_ATTEMPTS; attempt += 1) {
    let mutationNamespace: string | undefined;
    let namespaceCleanupAttempted = false;
    try {
      await hooks?.beforeTemporaryUnlink?.({
        canonicalPath: recordPath,
        temporaryPath,
        attempt
      });
      mutationNamespace = await createAuthorityOwnedMutationNamespace(temporaryPath, evidenceRef);
      const isolatedPath = join(mutationNamespace, "generation");
      await hooks?.beforeGenerationIsolation?.(
        Object.freeze({ path: temporaryPath, operation })
      );
      await rename(temporaryPath, isolatedPath);
      const isolatedIdentity = await readRegularFilePathIdentity(isolatedPath, evidenceRef);
      if (
        !isolatedIdentity ||
        isolatedIdentity.dev !== temporaryIdentity.dev ||
        isolatedIdentity.ino !== temporaryIdentity.ino ||
        !(await ownedGenerationBytesEqual(
          isolatedPath,
          temporaryIdentity,
          expectedBytes,
          evidenceRef
        ))
      ) {
        throw publicationStateError(evidenceRef);
      }
      if (ownedResources) {
        ownedResources.isolatedGeneration = {
          namespacePath: mutationNamespace,
          path: isolatedPath,
          identity: isolatedIdentity
        };
      }
      await hooks?.beforeAuthorityOwnedUnlink?.(
        Object.freeze({ path: temporaryPath, operation })
      );
      if (
        !(await ownedGenerationBytesEqual(
          isolatedPath,
          temporaryIdentity,
          expectedBytes,
          evidenceRef
        ))
      ) {
        throw publicationStateError(evidenceRef);
      }
      const publicReplacementExists = await recordPathEntryExists(
        temporaryPath,
        evidenceRef
      );
      await unlink(isolatedPath);
      namespaceCleanupAttempted = true;
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
      if (ownedResources) ownedResources.isolatedGeneration = undefined;
      if (publicReplacementExists) {
        throw publicationStateError(evidenceRef);
      }
      return;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (mutationNamespace) {
        const isolatedPath = join(mutationNamespace, "generation");
        if (await recordPathEntryExists(isolatedPath, evidenceRef)) {
          try {
            if (
              await ownedGenerationBytesEqual(
                isolatedPath,
                temporaryIdentity,
                expectedBytes,
                evidenceRef
              )
            ) {
              await unlink(isolatedPath);
            } else {
              await restoreOwnedIsolatedPath(isolatedPath, temporaryPath, evidenceRef);
            }
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (!namespaceCleanupAttempted) {
          try {
            await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
            if (ownedResources) ownedResources.isolatedGeneration = undefined;
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
      }
      const settledError = preserveWorkspacePrimaryError(error, cleanupErrors);
      if (hasErrorCode(error, "ENOENT") && cleanupErrors.length === 0) {
        return;
      }
      if (settledError instanceof TaskServiceError) {
        throw settledError;
      }
      attemptErrors.push(settledError);
      if (attempt < RECORD_TEMP_CLEANUP_ATTEMPTS) {
        await sleep(RECORD_TEMP_CLEANUP_RETRY_MS);
        continue;
      }
    }
  }

  throw preserveWorkspacePrimaryError(
    publicationTemporaryCleanupError(evidenceRef),
    attemptErrors
  );
}

async function rollbackPublishedRecordClaim(
  recordPath: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string
): Promise<void> {
  await removeOwnedPathWithoutHooks(recordPath, expectedIdentity, expectedBytes, evidenceRef);
}

async function removeOwnedPathWithoutHooks(
  path: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string
): Promise<void> {
  const mutationNamespace = await createAuthorityOwnedMutationNamespace(path, evidenceRef);
  const isolatedPath = join(mutationNamespace, "generation");
  let namespaceCleanupAttempted = false;
  try {
    await rename(path, isolatedPath);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (hasErrorCode(error, "ENOENT") && cleanupErrors.length === 0) return;
    throw preserveWorkspacePrimaryError(error, cleanupErrors);
  }

  try {
    const identity = await readRegularFilePathIdentity(isolatedPath, evidenceRef);
    if (
      !identity ||
      identity.dev !== expectedIdentity.dev ||
      identity.ino !== expectedIdentity.ino ||
      !(await ownedGenerationBytesEqual(
        isolatedPath,
        expectedIdentity,
        expectedBytes,
        evidenceRef
      ))
    ) {
      throw publicationStateError(evidenceRef);
    }
    await unlink(isolatedPath);
    namespaceCleanupAttempted = true;
    await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (await recordPathEntryExists(isolatedPath, evidenceRef)) {
      try {
        await restoreOwnedIsolatedPath(isolatedPath, path, evidenceRef);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (!namespaceCleanupAttempted) {
      try {
        await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    throw preserveWorkspacePrimaryError(error, cleanupErrors);
  }
}

async function restoreOwnedIsolatedPath(
  isolatedPath: string,
  publicPath: string,
  evidenceRef: string
): Promise<void> {
  try {
    await link(isolatedPath, publicPath);
    await unlink(isolatedPath);
  } catch (error) {
    throw serviceWorkspaceError(
      "record_malformed",
      "Workspace record generation could not be restored after a failed mutation.",
      "The workspace record changed before it could be mutated safely.",
      [evidenceRef],
      error
    );
  }
}

async function ownedGenerationBytesEqual(
  path: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string
): Promise<boolean> {
  let file: RecordFileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.dev !== expectedIdentity.dev ||
      before.ino !== expectedIdentity.ino ||
      before.size !== expectedBytes.length ||
      before.size > MAX_SERVICE_RECORD_BYTES
    ) {
      return false;
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await file.stat();
    return (
      offset === expectedBytes.length &&
      bytes.equals(expectedBytes) &&
      after.dev === before.dev &&
      after.ino === before.ino &&
      after.size === before.size
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw publicationStateError(evidenceRef);
  } finally {
    await file?.close();
  }
}

function preserveWorkspacePrimaryError(primary: unknown, compensations: unknown[]): unknown {
  if (!(primary instanceof Error) || compensations.length === 0) return primary;
  const priorCause = primary.cause;
  const aggregateCause = new AggregateError(
    priorCause === undefined ? compensations : [priorCause, ...compensations],
    "Workspace record publication compensation failed."
  );
  return cloneErrorWithCause(primary, aggregateCause);
}

function trySetErrorCause(error: Error, cause: unknown): boolean {
  try {
    Object.defineProperty(error, "cause", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: cause
    });
    return true;
  } catch {
    return false;
  }
}

function cloneErrorWithCause(primary: Error, cause: unknown): Error {
  if (primary instanceof TaskServiceError) {
    const clone = new TaskServiceError({
      code: primary.code,
      status: primary.status,
      category: primary.category,
      message: primary.message,
      userMessage: primary.userMessage,
      evidenceRefs: [...primary.evidenceRefs],
      retryable: primary.retryable,
      recommendedNextActions: [...primary.recommendedNextActions]
    });
    clone.stack = primary.stack;
    trySetErrorCause(clone, cause);
    return clone;
  }

  const clone = new Error(primary.message, { cause });
  clone.name = primary.name;
  clone.stack = primary.stack;
  return clone;
}

async function assertOwnedTemporaryRecordPath(
  temporaryPath: string,
  expected: OwnedTemporaryRecordIdentity,
  evidenceRef: string
): Promise<void> {
  let entry: FileStat;
  try {
    entry = await lstat(temporaryPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw error;
    }
    throw publicationStateError(evidenceRef);
  }

  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.dev !== expected.dev ||
    entry.ino !== expected.ino
  ) {
    throw publicationStateError(evidenceRef);
  }
}

async function assertPublishedRecordAuthority(
  recordPath: string,
  directoryPath: string,
  recordText: string,
  evidenceRef: string,
  expectedIdentity?: OwnedTemporaryRecordIdentity,
  hooks?: WorkspaceRecordPublicationHooks
): Promise<void> {
  if (!(await isSafeExistingDirectoryPath(directoryPath))) {
    throw publicationStateError(evidenceRef);
  }

  const published = await readDurableSingleLinkFile({
    path: recordPath,
    maxBytes: MAX_SERVICE_RECORD_BYTES,
    validateParentPath: async () => await isSafeExistingDirectoryPath(directoryPath),
    beforeFinalValidation: hooks?.beforePublishedRecordFinalValidation
  });
  if (published.status !== "read" || !published.bytes.equals(Buffer.from(recordText, "utf8"))) {
    throw publicationStateError(evidenceRef);
  }
  if (expectedIdentity) {
    if (
      published.identity.dev !== BigInt(expectedIdentity.dev) ||
      published.identity.ino !== BigInt(expectedIdentity.ino)
    ) {
      throw publicationStateError(evidenceRef);
    }
  }
}

async function assertOpenRecordAuthority(
  temporaryRecord: OwnedTemporaryRecord,
  recordText: string,
  expectedLinks: number,
  evidenceRef: string
): Promise<void> {
  const expectedBytes = Buffer.from(recordText, "utf8");
  const before = await temporaryRecord.file.stat();
  if (
    !before.isFile() ||
    before.dev !== temporaryRecord.identity.dev ||
    before.ino !== temporaryRecord.identity.ino ||
    before.nlink !== expectedLinks ||
    before.size !== expectedBytes.length ||
    before.size > MAX_SERVICE_RECORD_BYTES
  ) {
    throw publicationStateError(evidenceRef);
  }

  const observedBytes = Buffer.allocUnsafe(before.size);
  let offset = 0;
  while (offset < observedBytes.length) {
    const { bytesRead } = await temporaryRecord.file.read(
      observedBytes,
      offset,
      observedBytes.length - offset,
      offset
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const after = await temporaryRecord.file.stat();
  if (
    offset !== expectedBytes.length ||
    !observedBytes.equals(expectedBytes) ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.nlink !== expectedLinks ||
    after.size !== before.size
  ) {
    throw publicationStateError(evidenceRef);
  }
}

async function acquireRecordAuthority(
  recordPath: string,
  evidenceRef: string,
  operation: WorkspaceRecordAuthorityOperation,
  hooks?: WorkspaceRecordPublicationHooks
): Promise<RecordAuthorityLease> {
  const acquisitionDeadline =
    authorityDeadlineStorage.getStore() ?? Date.now() + RECORD_AUTHORITY_ACQUISITION_TIMEOUT_MS;
  const identity = await recordAuthorityIdentity(recordPath, evidenceRef);
  if (Date.now() >= acquisitionDeadline) {
    throw authorityWaitError(evidenceRef);
  }
  const existing = activeRecordAuthorityMutexes.get(identity);
  if (
    activeRecordAuthorityReservations >= MAX_RECORD_AUTHORITY_RESERVATIONS ||
    (existing?.reservations ?? 0) >= MAX_RECORD_AUTHORITY_RESERVATIONS_PER_PATH
  ) {
    throw authorityCapacityError(evidenceRef);
  }

  if (!existing) {
    const mutex: RecordAuthorityMutex = {
      waiters: new Set(),
      cleanupWaiters: new Set(),
      reservations: 1,
      cleanupPermits: 0,
      ownerActive: true
    };
    activeRecordAuthorityReservations += 1;
    activeRecordAuthorityMutexes.set(identity, mutex);
    return createRecordAuthorityLease(identity, mutex);
  }

  existing.reservations += 1;
  activeRecordAuthorityReservations += 1;
  if (!existing.ownerActive) {
    existing.ownerActive = true;
    return createRecordAuthorityLease(identity, existing);
  }
  const waitMs = Math.max(0, acquisitionDeadline - Date.now());
  let waiter!: RecordAuthorityWaiter;
  const lease = new Promise<RecordAuthorityLease>((resolveLease, rejectLease) => {
    waiter = {
      resolve: resolveLease,
      reject: rejectLease,
      timeout: setTimeout(() => {
        if (cancelRecordAuthorityWaiter(identity, existing, waiter)) {
          rejectLease(authorityWaitError(evidenceRef));
        }
      }, waitMs),
      active: true,
      deadline: acquisitionDeadline,
      evidenceRef
    };
    existing.waiters.add(waiter);
  });

  try {
    hooks?.onAuthorityContention?.(
      Object.freeze({ operation, deadline: acquisitionDeadline })
    );
  } catch (error) {
    if (cancelRecordAuthorityWaiter(identity, existing, waiter)) {
      waiter.reject(error);
    }
  }

  return await lease;
}

async function acquireRecordAuthorityWithCleanupPermit(
  permit: WorkspaceRecordCleanupPermit,
  recordPath: string,
  evidenceRef: string,
  hooks?: WorkspaceRecordPublicationHooks
): Promise<RecordAuthorityLease> {
  const acquisitionDeadline =
    authorityDeadlineStorage.getStore() ?? Date.now() + RECORD_AUTHORITY_ACQUISITION_TIMEOUT_MS;
  const state = cleanupPermitState.get(permit);
  if (!state || state.used) {
    throw publicationStateError(evidenceRef);
  }
  let identity: string;
  try {
    await hooks?.beforeCleanupPermitIdentityResolution?.(Object.freeze({ path: recordPath }));
    identity = await recordAuthorityIdentity(recordPath, evidenceRef);
    if (identity !== state.identity || activeRecordAuthorityMutexes.get(identity) !== state.mutex) {
      throw publicationStateError(evidenceRef);
    }
    if (Date.now() >= acquisitionDeadline) {
      throw authorityWaitError(evidenceRef);
    }
    if (state.mutex.ownerActive) {
      hooks?.onAuthorityContention?.(
        Object.freeze({ operation: "delete", deadline: acquisitionDeadline })
      );
    }
  } catch (error) {
    cancelRecordAuthorityCleanupPermit(permit);
    throw error;
  }

  state.used = true;
  state.mutex.cleanupPermits -= 1;
  activeRecordAuthorityCleanupPermits -= 1;
  if (!state.mutex.ownerActive) {
    state.mutex.ownerActive = true;
    return createRecordAuthorityLease(state.identity, state.mutex, false);
  }

  const waitMs = Math.max(0, acquisitionDeadline - Date.now());
  return await new Promise<RecordAuthorityLease>((resolveLease, rejectLease) => {
    let waiter!: RecordAuthorityCleanupWaiter;
    waiter = {
      resolve: resolveLease,
      reject: rejectLease,
      timeout: setTimeout(() => {
        if (cancelRecordAuthorityCleanupWaiter(state.identity, state.mutex, waiter)) {
          rejectLease(authorityWaitError(evidenceRef));
        }
      }, waitMs),
      active: true,
      deadline: acquisitionDeadline,
      evidenceRef
    };
    state.mutex.cleanupWaiters.add(waiter);
  });
}

function createRecordAuthorityLease(
  identity: string,
  mutex: RecordAuthorityMutex,
  consumesReservation = true
): RecordAuthorityLease {
  let released = false;
  return {
    reserveCleanupPermit: (evidenceRef) => {
      if (released || mutex.cleanupPermits >= 1) {
        throw new Error("Workspace record cleanup authority permit is unavailable.");
      }
      if (activeRecordAuthorityCleanupPermits >= MAX_RECORD_AUTHORITY_RESERVATIONS) {
        throw authorityCapacityError(evidenceRef);
      }
      const permit = Object.freeze({}) as WorkspaceRecordCleanupPermit;
      mutex.cleanupPermits += 1;
      activeRecordAuthorityCleanupPermits += 1;
      cleanupPermitState.set(permit, { identity, mutex, used: false });
      return permit;
    },
    release: () => {
      if (released) {
        return;
      }
      released = true;

      if (consumesReservation) {
        releaseRecordAuthorityReservation(identity, mutex);
      }
      if (handoffRecordAuthorityLease(identity, mutex)) {
        return;
      }
      mutex.ownerActive = false;
      removeUnusedRecordAuthorityMutex(identity, mutex);
    }
  };
}

function handoffRecordAuthorityLease(
  identity: string,
  mutex: RecordAuthorityMutex
): boolean {
  for (;;) {
    const cleanupNext = mutex.cleanupWaiters.values().next().value as
      | RecordAuthorityCleanupWaiter
      | undefined;
    if (!cleanupNext) break;
    mutex.cleanupWaiters.delete(cleanupNext);
    cleanupNext.active = false;
    clearTimeout(cleanupNext.timeout);
    if (Date.now() >= cleanupNext.deadline) {
      cleanupNext.reject(authorityWaitError(cleanupNext.evidenceRef));
      continue;
    }
    cleanupNext.resolve(createRecordAuthorityLease(identity, mutex, false));
    return true;
  }

  for (;;) {
    const next = mutex.waiters.values().next().value as RecordAuthorityWaiter | undefined;
    if (!next) return false;
    mutex.waiters.delete(next);
    next.active = false;
    clearTimeout(next.timeout);
    if (Date.now() >= next.deadline) {
      releaseRecordAuthorityReservation(identity, mutex);
      next.reject(authorityWaitError(next.evidenceRef));
      continue;
    }
    next.resolve(createRecordAuthorityLease(identity, mutex));
    return true;
  }
}

function cancelRecordAuthorityCleanupWaiter(
  identity: string,
  mutex: RecordAuthorityMutex,
  waiter: RecordAuthorityCleanupWaiter
): boolean {
  if (!waiter.active || !mutex.cleanupWaiters.delete(waiter)) return false;
  waiter.active = false;
  clearTimeout(waiter.timeout);
  removeUnusedRecordAuthorityMutex(identity, mutex);
  return true;
}

function reserveRecordAuthorityCleanupPermit(
  authorityLease: RecordAuthorityLease | undefined,
  evidenceRef: string
): WorkspaceRecordCleanupPermit {
  if (!authorityLease) {
    throw new Error("Workspace record authority lease is unavailable.");
  }
  return authorityLease.reserveCleanupPermit(evidenceRef);
}

function cancelRecordAuthorityCleanupPermit(
  permit: WorkspaceRecordCleanupPermit | undefined
): void {
  if (!permit) return;
  const state = cleanupPermitState.get(permit);
  if (!state || state.used) return;
  state.used = true;
  state.mutex.cleanupPermits -= 1;
  activeRecordAuthorityCleanupPermits -= 1;
  removeUnusedRecordAuthorityMutex(state.identity, state.mutex);
}

function cancelRecordAuthorityWaiter(
  identity: string,
  mutex: RecordAuthorityMutex,
  waiter: RecordAuthorityWaiter
): boolean {
  if (!waiter.active || !mutex.waiters.delete(waiter)) {
    return false;
  }
  waiter.active = false;
  clearTimeout(waiter.timeout);
  releaseRecordAuthorityReservation(identity, mutex);
  return true;
}

function releaseRecordAuthorityReservation(identity: string, mutex: RecordAuthorityMutex): void {
  mutex.reservations -= 1;
  activeRecordAuthorityReservations -= 1;
  removeUnusedRecordAuthorityMutex(identity, mutex);
}

function removeUnusedRecordAuthorityMutex(identity: string, mutex: RecordAuthorityMutex): void {
  if (
    !mutex.ownerActive &&
    mutex.reservations === 0 &&
    mutex.waiters.size === 0 &&
    mutex.cleanupWaiters.size === 0 &&
    mutex.cleanupPermits === 0 &&
    activeRecordAuthorityMutexes.get(identity) === mutex
  ) {
    activeRecordAuthorityMutexes.delete(identity);
  }
}

async function recordAuthorityIdentity(recordPath: string, evidenceRef: string): Promise<string> {
  try {
    const canonicalPath = await physicalCanonicalPath(recordPath, evidenceRef);
    return createHash("sha256").update(canonicalPath).digest("hex");
  } catch (error) {
    if (error instanceof WorkspacePathSafetyError) {
      throw serviceWorkspaceError(
        "workspace_path_not_safe",
        error.message,
        "The workspace record path could not be coordinated safely.",
        [error.evidenceRef],
        error
      );
    }
    throw error;
  }
}

function publicationStateError(evidenceRef: string): TaskServiceError {
  return serviceWorkspaceError(
    "workspace_path_not_safe",
    "Workspace record publication authority could not be verified.",
    "The workspace record could not be published safely.",
    [evidenceRef]
  );
}

function publicationTemporaryCleanupError(evidenceRef: string): TaskServiceError {
  return serviceWorkspaceError(
    "workspace_path_not_safe",
    "Workspace record publication temporary cleanup did not complete.",
    "The workspace record could not be published safely.",
    [evidenceRef]
  );
}

function authorityCapacityError(evidenceRef: string): TaskServiceError {
  return authorityCoordinationError(
    "Workspace record authority coordination is at capacity.",
    evidenceRef
  );
}

function authorityWaitError(evidenceRef: string): TaskServiceError {
  return authorityCoordinationError(
    "Workspace record authority lease was not acquired before the bounded deadline.",
    evidenceRef
  );
}

function authorityCoordinationError(message: string, evidenceRef: string): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 409,
    category: "workspace_error",
    message,
    userMessage: "The workspace record is currently busy.",
    evidenceRefs: [evidenceRef],
    retryable: true,
    recommendedNextActions: ["Retry after the active workspace record operation finishes."]
  });
}

export function assertPathInsideWorkspace(
  workspaceRoot: string,
  targetPath: string,
  evidenceRef: string
): void {
  if (isPathInsideBoundary(workspaceRoot, targetPath)) {
    return;
  }

  throw serviceWorkspaceError(
    "workspace_path_not_safe",
    "Resolved path escapes the configured workspace.",
    "A workspace path resolved outside the configured workspace.",
    [evidenceRef]
  );
}

function recordDurableReadError(
  reason: DurableSingleLinkReadFailureReason,
  evidenceRef: string,
  cause?: unknown
): TaskServiceError {
  if (reason === "not_regular_file" || reason === "multiple_links") {
    return serviceWorkspaceError(
      "record_malformed",
      "Record path is not a safe regular file.",
      "A workspace record cannot be read safely.",
      [evidenceRef],
      cause
    );
  }
  if (reason === "too_large") {
    return serviceWorkspaceError(
      "record_malformed",
      "Record exceeds the M1 bounded read size.",
      "A workspace record is too large to read safely.",
      [evidenceRef],
      cause
    );
  }
  if (reason === "parent_not_safe") {
    return serviceWorkspaceError(
      "record_malformed",
      "Record parent path is not a safe directory.",
      "A workspace record cannot be read safely.",
      [evidenceRef],
      cause
    );
  }
  if (reason === "open_failed") {
    return serviceWorkspaceError(
      "record_malformed",
      "Record cannot be opened safely.",
      "A workspace record cannot be read safely.",
      [evidenceRef],
      cause
    );
  }
  if (reason === "read_failed") {
    return serviceWorkspaceError(
      "record_malformed",
      "Record cannot be read safely.",
      "A workspace record cannot be read safely.",
      [evidenceRef],
      cause
    );
  }

  return serviceWorkspaceError(
    "record_malformed",
    "Record cannot be inspected.",
    "A workspace record cannot be read safely.",
    [evidenceRef],
    cause
  );
}

function serviceWorkspaceError(
  code: Extract<TaskServiceErrorCode, "workspace_path_not_safe" | "record_malformed">,
  message: string,
  userMessage: string,
  evidenceRefs: string[],
  cause?: unknown
): TaskServiceError {
  const error = new TaskServiceError({
    code,
    status: 500,
    category: "workspace_error",
    message,
    userMessage,
    evidenceRefs,
    retryable: false,
    recommendedNextActions: ["Inspect the workspace record state before retrying."]
  });

  if (cause instanceof Error) {
    error.cause = cause;
  }

  return error;
}

async function prepareJsonRecordWrite<T>(
  workspaceRoot: string,
  relativeDirectorySegments: readonly string[],
  fileName: string,
  record: T,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<{
  data: T;
  directoryPath: string;
  recordPath: string;
  recordText: string;
}> {
  const parsedRecord = schema.safeParse(record);
  if (!parsedRecord.success) {
    throw new TaskServiceError({
      code: "record_schema_error",
      status: 400,
      category: "schema_error",
      message: "Workspace record failed schema validation.",
      userMessage: "The record is missing required fields or contains invalid values.",
      evidenceRefs: toSchemaEvidenceRefs(parsedRecord.error, evidenceRef),
      recommendedNextActions: ["Fix the record fields and retry."]
    });
  }

  assertSafeRecordSegment(fileName.replace(/\.json$/, ""), `${evidenceRef}:file`);
  const recordText = serializeJsonRecord(parsedRecord.data, evidenceRef);

  const directoryPath = await ensureWorkspaceRecordDirectory(
    workspaceRoot,
    relativeDirectorySegments,
    evidenceRef
  );
  const recordPath = await resolveWorkspaceRecordPath(
    workspaceRoot,
    join(directoryPath, fileName),
    evidenceRef
  );

  return {
    data: parsedRecord.data,
    directoryPath,
    recordPath,
    recordText
  };
}

function serializeJsonRecord<T>(record: T, evidenceRef: string): string {
  const recordText = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(recordText, "utf8") > MAX_SERVICE_RECORD_BYTES) {
    throw new TaskServiceError({
      code: "record_schema_error",
      status: 400,
      category: "schema_error",
      message: "Workspace record would exceed the M1 bounded size.",
      userMessage: "The record is too large to persist safely.",
      evidenceRefs: [evidenceRef],
      recommendedNextActions: ["Reduce record field sizes and retry."]
    });
  }
  return recordText;
}

async function resolveWorkspaceRecordPath(
  workspaceRoot: string,
  path: string,
  evidenceRef: string
): Promise<string> {
  try {
    return (
      await resolveWorkspacePath({
        workspaceRoot,
        inputPath: path,
        evidenceRef,
        access: "write"
      })
    ).absolutePath;
  } catch (error) {
    if (error instanceof WorkspacePathSafetyError) {
      throw serviceWorkspaceError(
        "workspace_path_not_safe",
        error.message,
        "The workspace record path is not safe to write.",
        [error.evidenceRef],
        error
      );
    }
    throw error;
  }
}

async function ensureSafeDirectory(path: string, evidenceRef: string): Promise<void> {
  const existingEntry = await maybeLstat(path);
  if (existingEntry) {
    if (!(await isSafeExistingDirectoryPath(path))) {
      throw serviceWorkspaceError(
        "workspace_path_not_safe",
        "Path is not a safe directory.",
        "A required workspace path is not a safe directory.",
        [evidenceRef]
      );
    }
    return;
  }

  const parentPath = dirname(path);
  if (parentPath === path || !(await isSafeExistingDirectoryPath(parentPath))) {
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Parent path is not a safe directory.",
      "A required workspace parent path is not a safe directory.",
      [`${evidenceRef}:parent`]
    );
  }

  try {
    await mkdir(path);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST") && (await isSafeExistingDirectoryPath(path))) {
      return;
    }

    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Failed to create workspace directory.",
      "A required workspace directory could not be created safely.",
      [evidenceRef],
      error
    );
  }

  if (!(await isSafeExistingDirectoryPath(path))) {
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Created path is not a safe directory.",
      "A required workspace path is not a safe directory.",
      [evidenceRef]
    );
  }
}

async function isSafeExistingDirectoryPath(path: string): Promise<boolean> {
  const { rootPath, segments } = getPathParts(path);
  const rootEntry = await maybeLstat(rootPath);
  if (!isSafeDirectoryEntry(rootEntry)) {
    return false;
  }

  let currentPath = rootPath;
  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    const entry = await maybeLstat(currentPath);
    if (!isSafeDirectoryEntry(entry)) {
      return false;
    }
  }

  return true;
}

function getPathParts(path: string): { rootPath: string; segments: string[] } {
  const resolvedPath = resolve(path);
  const rootPath = parse(resolvedPath).root;
  return {
    rootPath,
    segments: resolvedPath.slice(rootPath.length).split(sep).filter(Boolean)
  };
}

function isSafeDirectoryEntry(entry: FileStat | undefined): boolean {
  return Boolean(entry?.isDirectory() && !entry.isSymbolicLink());
}

async function maybeLstat(path: string): Promise<FileStat | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

function toSchemaEvidenceRefs(error: z.ZodError, prefix: string): string[] {
  return Array.from(
    new Set(
      error.issues.map((issue) =>
        issue.path.length > 0 ? `${prefix}.${issue.path.join(".")}` : prefix
      )
    )
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

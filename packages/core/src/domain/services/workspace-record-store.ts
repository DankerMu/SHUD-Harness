import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
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

type FileStat = Awaited<ReturnType<typeof lstat>>;
type RecordFileHandle = Awaited<ReturnType<typeof open>>;

interface OwnedTemporaryRecordIdentity {
  dev: number;
  ino: number;
}

type WorkspaceRecordAuthorityOperation = "read" | "rename" | "hardlink" | "delete";

interface RecordAuthorityWaiter {
  resolve: (lease: RecordAuthorityLease) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  active: boolean;
}

interface RecordAuthorityMutex {
  waiters: Set<RecordAuthorityWaiter>;
  reservations: number;
}

interface RecordAuthorityLease {
  release: () => void;
}

export interface WorkspaceRecordPublicationHookInput {
  canonicalPath: string;
  temporaryPath: string;
}

export interface WorkspaceRecordTemporaryCleanupHookInput
  extends WorkspaceRecordPublicationHookInput {
  attempt: number;
}

export interface WorkspaceRecordPublicationHooks {
  afterCanonicalLink?: (
    input: WorkspaceRecordPublicationHookInput
  ) => Promise<void> | void;
  beforeTemporaryUnlink?: (
    input: WorkspaceRecordTemporaryCleanupHookInput
  ) => Promise<void> | void;
  afterAuthorityLeaseAcquired?: (
    input: Readonly<{ operation: WorkspaceRecordAuthorityOperation }>
  ) => Promise<void> | void;
  onAuthorityContention?: (
    input: Readonly<{ operation: WorkspaceRecordAuthorityOperation }>
  ) => void;
  beforeConditionalDelete?: (
    input: Readonly<{
      path: string;
      conditionStatus: "matched" | "not_matched";
    }>
  ) => Promise<void> | void;
}

const activeRecordAuthorityMutexes = new Map<string, RecordAuthorityMutex>();
let activeRecordAuthorityReservations = 0;
const publicationHookStorage = new AsyncLocalStorage<WorkspaceRecordPublicationHooks>();

export async function runWithWorkspaceRecordPublicationHooks<T>(
  hooks: WorkspaceRecordPublicationHooks,
  action: () => Promise<T>
): Promise<T> {
  return await publicationHookStorage.run(hooks, action);
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
  const authorityLease = await acquireRecordAuthority(
    path,
    evidenceRef,
    "read",
    hooks
  );
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
  | { status: "deleted" }
  | { status: "missing" }
  | { status: "condition_not_met" };

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
      Object.freeze({ path, conditionStatus: matched ? "matched" : "not_matched" })
    );
    if (!matched) {
      return { status: "condition_not_met" };
    }

    await assertRecordPathIdentity(path, observedIdentity, evidenceRef);
    try {
      await unlink(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return { status: "missing" };
      }
      throw serviceWorkspaceError(
        "workspace_path_not_safe",
        "Failed to conditionally remove workspace record.",
        "The workspace record could not be removed safely.",
        [evidenceRef],
        error
      );
    }
    return { status: "deleted" };
  } finally {
    authorityLease.release();
  }
}

type JsonRecordInspection<T> =
  | { status: "missing" }
  | { status: "record"; record: T }
  | { status: "malformed"; error: TaskServiceError };

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

  return { status: "record", record: parsedRecord.data };
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

async function assertRecordPathIdentity(
  path: string,
  expected: OwnedTemporaryRecordIdentity,
  evidenceRef: string
): Promise<void> {
  const current = await readRecordPathIdentity(path, evidenceRef);
  if (!current || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw serviceWorkspaceError(
      "record_malformed",
      "Workspace record changed before conditional removal.",
      "The workspace record changed before it could be removed safely.",
      [evidenceRef]
    );
  }
}

export async function writeJsonRecord<T>(
  workspaceRoot: string,
  relativeDirectorySegments: readonly string[],
  fileName: string,
  record: T,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<T> {
  const { data, directoryPath, recordPath } = await prepareJsonRecordWrite(
    workspaceRoot,
    relativeDirectorySegments,
    fileName,
    record,
    evidenceRef,
    schema
  );

  const temporaryPath = join(directoryPath, `.${fileName}-${process.pid}-${randomUUID()}.tmp`);
  let wroteTemporary = false;
  let authorityLease: RecordAuthorityLease | undefined;
  const hooks = publicationHookStorage.getStore();
  try {
    authorityLease = await acquireRecordAuthority(
      recordPath,
      evidenceRef,
      "rename",
      hooks
    );
    await hooks?.afterAuthorityLeaseAcquired?.(Object.freeze({ operation: "rename" }));
    const recordText = serializeJsonRecord(data, evidenceRef);
    wroteTemporary = await writeTemporaryRecordFile(temporaryPath, recordText, evidenceRef);
    if (!(await isSafeExistingDirectoryPath(directoryPath))) {
      throw serviceWorkspaceError(
        "workspace_path_not_safe",
        "Record directory is not a safe directory.",
        "A workspace record directory is not usable.",
        [evidenceRef]
      );
    }
    await rename(temporaryPath, recordPath);
    wroteTemporary = false;
  } catch (error) {
    if (error instanceof TaskServiceError) {
      throw error;
    }
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Failed to persist workspace record.",
      "The workspace record could not be written safely.",
      [evidenceRef],
      error
    );
  } finally {
    if (wroteTemporary) {
      await unlink(temporaryPath).catch(() => undefined);
    }
    authorityLease?.release();
  }

  return data;
}

export type CreateJsonRecordResult<T> =
  | { status: "created"; record: T }
  | { status: "exists" };

export async function createJsonRecordIfAbsent<T>(
  workspaceRoot: string,
  relativeDirectorySegments: readonly string[],
  fileName: string,
  record: T,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<CreateJsonRecordResult<T>> {
  const { data, directoryPath, recordPath } = await prepareJsonRecordWrite(
    workspaceRoot,
    relativeDirectorySegments,
    fileName,
    record,
    evidenceRef,
    schema
  );

  const temporaryPath = join(directoryPath, `.${fileName}-${process.pid}-${randomUUID()}.tmp`);
  const hooks = publicationHookStorage.getStore();
  let authorityLease: RecordAuthorityLease | undefined;
  let temporaryIdentity: OwnedTemporaryRecordIdentity | undefined;
  let publicationOutcome: "published" | "exists" | undefined;
  let operationError: unknown;
  try {
    try {
      authorityLease = await acquireRecordAuthority(
        recordPath,
        evidenceRef,
        "hardlink",
        hooks
      );
      await hooks?.afterAuthorityLeaseAcquired?.(Object.freeze({ operation: "hardlink" }));
      const recordText = serializeJsonRecord(data, evidenceRef);
      if (!(await isSafeExistingDirectoryPath(directoryPath))) {
        throw serviceWorkspaceError(
          "workspace_path_not_safe",
          "Record directory is not a safe directory.",
          "A workspace record directory is not usable.",
          [evidenceRef]
        );
      }
      await writeTemporaryRecordFile(temporaryPath, recordText, evidenceRef);
      temporaryIdentity = await readOwnedTemporaryRecordIdentity(temporaryPath, evidenceRef);
      await assertOwnedTemporaryRecordPath(
        temporaryPath,
        temporaryIdentity,
        evidenceRef
      );
      try {
        await link(temporaryPath, recordPath);
        publicationOutcome = "published";
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

    if (temporaryIdentity) {
      try {
        await removeOwnedPublicationTemporaryPath(
          temporaryPath,
          temporaryIdentity,
          recordPath,
          evidenceRef,
          hooks
        );
      } catch (cleanupError) {
        operationError = cleanupError;
      }
    }

    if (operationError !== undefined) {
      throw operationError;
    }

    if (publicationOutcome === "exists") {
      return { status: "exists" };
    }
    if (publicationOutcome !== "published") {
      throw publicationStateError(evidenceRef);
    }

    await assertPublishedRecordAuthority(
      recordPath,
      directoryPath,
      serializeJsonRecord(data, evidenceRef),
      evidenceRef
    );

    return { status: "created", record: data };
  } finally {
    authorityLease?.release();
  }
}

async function writeTemporaryRecordFile(
  temporaryPath: string,
  recordText: string,
  evidenceRef: string
): Promise<boolean> {
  let temporaryFile: RecordFileHandle | undefined;
  let shouldCleanup = false;
  let completed = false;
  try {
    temporaryFile = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    );
    shouldCleanup = true;
    await temporaryFile.writeFile(recordText, "utf8");
    completed = true;
    return shouldCleanup;
  } catch (error) {
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Failed to write workspace record temporary file.",
      "The workspace record could not be written safely.",
      [evidenceRef],
      error
    );
  } finally {
    await temporaryFile?.close().catch(() => undefined);
    if (shouldCleanup && !completed) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function readOwnedTemporaryRecordIdentity(
  temporaryPath: string,
  evidenceRef: string
): Promise<OwnedTemporaryRecordIdentity> {
  let entry: FileStat;
  try {
    entry = await lstat(temporaryPath);
  } catch {
    throw publicationStateError(evidenceRef);
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw publicationStateError(evidenceRef);
  }
  return { dev: entry.dev, ino: entry.ino };
}

async function removeOwnedPublicationTemporaryPath(
  temporaryPath: string,
  temporaryIdentity: OwnedTemporaryRecordIdentity,
  recordPath: string,
  evidenceRef: string,
  hooks?: WorkspaceRecordPublicationHooks
): Promise<void> {
  for (let attempt = 1; attempt <= RECORD_TEMP_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await hooks?.beforeTemporaryUnlink?.({
        canonicalPath: recordPath,
        temporaryPath,
        attempt
      });
      await assertOwnedTemporaryRecordPath(
        temporaryPath,
        temporaryIdentity,
        evidenceRef
      );
      await unlink(temporaryPath);
      return;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return;
      }
      if (error instanceof TaskServiceError) {
        throw error;
      }
      if (attempt < RECORD_TEMP_CLEANUP_ATTEMPTS) {
        await sleep(RECORD_TEMP_CLEANUP_RETRY_MS);
        continue;
      }
    }
  }

  throw publicationTemporaryCleanupError(evidenceRef);
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
  evidenceRef: string
): Promise<void> {
  if (!(await isSafeExistingDirectoryPath(directoryPath))) {
    throw publicationStateError(evidenceRef);
  }

  const published = await readDurableSingleLinkFile({
    path: recordPath,
    maxBytes: MAX_SERVICE_RECORD_BYTES,
    validateParentPath: async () => await isSafeExistingDirectoryPath(directoryPath)
  });
  if (
    published.status !== "read" ||
    !published.bytes.equals(Buffer.from(recordText, "utf8"))
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
  const acquisitionDeadline = Date.now() + RECORD_AUTHORITY_ACQUISITION_TIMEOUT_MS;
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
    const mutex: RecordAuthorityMutex = { waiters: new Set(), reservations: 1 };
    activeRecordAuthorityReservations += 1;
    activeRecordAuthorityMutexes.set(identity, mutex);
    return createRecordAuthorityLease(identity, mutex);
  }

  existing.reservations += 1;
  activeRecordAuthorityReservations += 1;
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
      active: true
    };
    existing.waiters.add(waiter);
  });

  try {
    hooks?.onAuthorityContention?.(Object.freeze({ operation }));
  } catch (error) {
    if (cancelRecordAuthorityWaiter(identity, existing, waiter)) {
      waiter.reject(error);
    }
  }

  return await lease;
}

function createRecordAuthorityLease(
  identity: string,
  mutex: RecordAuthorityMutex
): RecordAuthorityLease {
  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;

      releaseRecordAuthorityReservation(identity, mutex);
      const next = mutex.waiters.values().next().value as RecordAuthorityWaiter | undefined;
      if (next) {
        mutex.waiters.delete(next);
        next.active = false;
        clearTimeout(next.timeout);
        next.resolve(createRecordAuthorityLease(identity, mutex));
      }
    }
  };
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

function releaseRecordAuthorityReservation(
  identity: string,
  mutex: RecordAuthorityMutex
): void {
  mutex.reservations -= 1;
  activeRecordAuthorityReservations -= 1;
  if (
    mutex.reservations === 0 &&
    mutex.waiters.size === 0 &&
    activeRecordAuthorityMutexes.get(identity) === mutex
  ) {
    activeRecordAuthorityMutexes.delete(identity);
  }
}

async function recordAuthorityIdentity(
  recordPath: string,
  evidenceRef: string
): Promise<string> {
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

function authorityCoordinationError(
  message: string,
  evidenceRef: string
): TaskServiceError {
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
  code: Extract<
    TaskServiceErrorCode,
    "workspace_path_not_safe" | "record_malformed"
  >,
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
    recordPath
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

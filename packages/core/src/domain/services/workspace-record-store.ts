import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  readDurableSingleLinkFile,
  type DurableSingleLinkReadFailureReason
} from "./durable-single-link-reader";
import { TaskServiceError, type TaskServiceErrorCode } from "./task-card-service";
import {
  WorkspacePathSafetyError,
  isPathInsideBoundary,
  physicalAuthorityPathIdentityCandidates,
  resolveWorkspacePath
} from "./workspace-path-safety";

export const MAX_SERVICE_RECORD_BYTES = 1024 * 1024;

const SAFE_RECORD_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAX_RECORD_AUTHORITY_RESERVATIONS = 1024;
const MAX_RECORD_AUTHORITY_RESERVATIONS_PER_PATH = 64;
// One shared filesystem-aware alias plus 64 exact observed spellings.
const MAX_RECORD_AUTHORITY_ALIASES_PER_MUTEX = 65;
const RECORD_AUTHORITY_ACQUISITION_TIMEOUT_MS = 5_000;
const RECORD_TEMP_CLEANUP_ATTEMPTS = 3;
const RECORD_TEMP_CLEANUP_RETRY_MS = 5;
const RECORD_NAMESPACE_CLEANUP_ATTEMPTS = 3;

type FileStat = Awaited<ReturnType<typeof lstat>>;
type RecordFileHandle = Awaited<ReturnType<typeof open>>;

export interface WorkspaceRecordPhysicalIdentity {
  dev: bigint;
  ino: bigint;
}

interface OwnedTemporaryRecordIdentity extends WorkspaceRecordPhysicalIdentity {}

export function workspaceRecordPhysicalIdentityMatches(
  observed: WorkspaceRecordPhysicalIdentity,
  expected: WorkspaceRecordPhysicalIdentity
): boolean {
  return observed.dev === expected.dev && observed.ino === expected.ino;
}

interface OwnedTemporaryRecord {
  identity: OwnedTemporaryRecordIdentity;
  file: RecordFileHandle;
  handleClosed: boolean;
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

type WorkspaceRecordAuthorityOperation = "read" | "hardlink" | "delete";

interface RecordAuthorityWaiter {
  resolve: (lease: RecordAuthorityLease) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  active: boolean;
  deadline: number;
  evidenceRef: string;
  kind: "ordinary" | "cleanup";
  exactPath: string;
  ready: boolean;
  cleanupSetupSettled?: boolean;
  handedOff?: boolean;
  cleanupPermit?: WorkspaceRecordCleanupPermit;
  expectedCleanupGeneration?: WorkspaceRecordPhysicalIdentity;
}

interface RecordAuthorityMutex {
  waiters: Set<RecordAuthorityWaiter>;
  aliases: Set<string>;
  sequence: number;
  reservations: number;
  cleanupPermits: number;
  outstandingCleanupPermit?: WorkspaceRecordCleanupPermit;
  ownerActive: boolean;
}

interface RecordAuthorityLease {
  expectedCleanupGeneration?: WorkspaceRecordPhysicalIdentity;
  validateCleanupGeneration?: () => Promise<void>;
  release: () => void;
  reserveCleanupPermit: (
    publicPath: string,
    evidenceRef: string
  ) => WorkspaceRecordCleanupPermit;
  settleOutstandingCleanupPermit: (generation: WorkspaceRecordPhysicalIdentity) => void;
}

export interface WorkspaceRecordCleanupPermit {}

const cleanupPermitState = new WeakMap<
  WorkspaceRecordCleanupPermit,
  {
    mutex: RecordAuthorityMutex;
    publicPath: string;
    generation?: OwnedTemporaryRecordIdentity;
    pinnedFile?: RecordFileHandle;
    pinnedFileClosed: boolean;
    expectedBytes?: Buffer;
    afterPinnedFileClosed?: (
      input: Readonly<{ path: string; fd: number }>
    ) => Promise<void> | void;
    status: "outstanding" | "claimed" | "settled";
    capacityActive: boolean;
  }
>();

export interface WorkspaceRecordPublicationHookInput {
  canonicalPath: string;
  temporaryPath: string;
}

export interface WorkspaceRecordTemporaryHandleHookInput
  extends WorkspaceRecordPublicationHookInput {
  descriptor: Readonly<{
    fd: number;
    dev: bigint;
    ino: bigint;
  }>;
}

export interface WorkspaceRecordTemporaryCleanupHookInput extends WorkspaceRecordPublicationHookInput {
  attempt: number;
}

export interface WorkspaceRecordPublicationHooks {
  afterCanonicalLink?: (input: WorkspaceRecordPublicationHookInput) => Promise<void> | void;
  beforeTemporaryUnlink?: (input: WorkspaceRecordTemporaryCleanupHookInput) => Promise<void> | void;
  afterTemporaryFileWritten?: (input: WorkspaceRecordPublicationHookInput) => Promise<void> | void;
  beforeTemporaryFileClose?: (
    input: WorkspaceRecordTemporaryHandleHookInput
  ) => Promise<void> | void;
  afterTemporaryFileClosed?: (
    input: WorkspaceRecordTemporaryHandleHookInput
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
  beforePublicationCompensationStateInspection?: (
    input: Readonly<{
      path: string;
      site: "published_rollback" | "unpublished_cleanup";
      activeCleanupPermitCount: number;
    }>
  ) => Promise<void> | void;
  beforeCleanupPermitIdentityResolution?: (
    input: Readonly<{ path: string }>
  ) => Promise<void> | void;
  beforeRecordAuthorityIdentitySupplier?: (
    input: Readonly<{ path: string }>
  ) => Promise<void> | void;
  afterCleanupPermitPinnedHandleClosed?: (
    input: Readonly<{ path: string; fd: number }>
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
        | "hardlink_temp_cleanup";
    }>
  ) => Promise<void> | void;
  beforeAuthorityNamespaceCreation?: (
    input: Readonly<{ path: string }>
  ) => Promise<void> | void;
  beforeAuthorityOwnedUnlink?: (
    input: Readonly<{
      path: string;
      operation:
        | "conditional_delete"
        | "hardlink_temp_cleanup";
    }>
  ) => Promise<void> | void;
  beforeAuthorityNamespaceRemoval?: (
    input: Readonly<{ path: string; attempt: number }>
  ) => Promise<void> | void;
}

const activeRecordAuthorityMutexes = new Map<string, RecordAuthorityMutex>();
let nextRecordAuthorityMutexSequence = 1;
let activeRecordAuthorityReservations = 0;
let activeRecordAuthorityCleanupPermits = 0;
const publicationHookStorage = new AsyncLocalStorage<WorkspaceRecordPublicationHooks>();
const authorityDeadlineStorage = new AsyncLocalStorage<number>();

type WorkspaceRecordPostIsolationSite =
  | "conditional_delete"
  | "conditional_unlink_owned_path"
  | "published_rollback"
  | "temporary_generation_compensation";

export interface WorkspaceRecordCompensationTestHooks {
  beforeOwnedTemporaryRecordWrite?: (
    input: Readonly<{
      path: string;
      identity: WorkspaceRecordPhysicalIdentity;
      fd: number;
    }>
  ) => Promise<void> | void;
  beforeOwnedPathIsolation?: (
    input: Readonly<{ path: string; isolatedPath: string; site: WorkspaceRecordPostIsolationSite }>
  ) => Promise<void> | void;
  afterOwnedPathIsolation?: (
    input: Readonly<{ path: string; isolatedPath: string; site: WorkspaceRecordPostIsolationSite }>
  ) => Promise<void> | void;
  beforeOwnedPathCompensationStateInspection?: (
    input: Readonly<{ path: string; isolatedPath: string; site: WorkspaceRecordPostIsolationSite }>
  ) => Promise<void> | void;
  beforeOwnedIsolatedSourceUnlink?: (
    input: Readonly<{
      path: string;
      isolatedPath: string;
      site: WorkspaceRecordPostIsolationSite;
      attempt: number;
    }>
  ) => Promise<void> | void;
}

const compensationTestHookStorage =
  new AsyncLocalStorage<WorkspaceRecordCompensationTestHooks>();

export async function runWithWorkspaceRecordCompensationTestHooks<T>(
  hooks: WorkspaceRecordCompensationTestHooks,
  action: () => Promise<T>
): Promise<T> {
  return await compensationTestHookStorage.run(hooks, action);
}

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
      await authorityLease.validateCleanupGeneration?.();
      return await conditionalDeleteJsonRecordUnderAuthority(
        path,
        evidenceRef,
        schema,
        condition,
        hooks,
        mutationState,
        authorityLease.expectedCleanupGeneration
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
  const mutationState: {
    started: boolean;
    deletedGeneration?: WorkspaceRecordPhysicalIdentity;
  } = { started: false };
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
  } finally {
    if (mutationState.deletedGeneration) {
      authorityLease.settleOutstandingCleanupPermit(mutationState.deletedGeneration);
    }
    authorityLease.release();
  }
}

async function conditionalDeleteJsonRecordUnderAuthority<T>(
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>,
  condition: ConditionalDeleteJsonRecordCondition<T>,
  hooks?: WorkspaceRecordPublicationHooks,
  mutationState?: {
    started: boolean;
    deletedGeneration?: WorkspaceRecordPhysicalIdentity;
  },
  expectedGeneration?: WorkspaceRecordPhysicalIdentity
): Promise<ConditionalDeleteJsonRecordResult> {
  const observedIdentity = await readRecordPathIdentity(path, evidenceRef);
  if (!observedIdentity) {
    return { status: "missing" };
  }
  if (
    expectedGeneration &&
    !workspaceRecordPhysicalIdentityMatches(observedIdentity, expectedGeneration)
  ) {
    throw publicationStateError(evidenceRef);
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

  const mutationNamespace = await createAuthorityOwnedMutationNamespace(path, evidenceRef);
  const quarantinePath = join(mutationNamespace, "generation");
  try {
    await hooks?.beforeGenerationIsolation?.(
      Object.freeze({ path, operation: "conditional_delete" })
    );
    const finalPublicIdentity = await readRegularFilePathIdentity(path, evidenceRef);
    if (!finalPublicIdentity) {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
      return { status: "missing" };
    }
    if (!workspaceRecordPhysicalIdentityMatches(finalPublicIdentity, observedIdentity)) {
      throw recordChangedBeforeConditionalRemovalError(evidenceRef);
    }
    await compensationTestHookStorage.getStore()?.beforeOwnedPathIsolation?.(
      Object.freeze({ path, isolatedPath: quarantinePath, site: "conditional_delete" })
    );
    await rename(path, quarantinePath);
    if (mutationState) mutationState.started = true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
      return { status: "missing" };
    }
    await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
    if (error instanceof TaskServiceError) throw error;
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Failed to conditionally remove workspace record.",
      "The workspace record could not be removed safely.",
      [evidenceRef],
      error
    );
  }

  let quarantinedIdentity: OwnedTemporaryRecordIdentity | undefined;
  let namespaceCleanupAttempted = false;
  try {
    await compensationTestHookStorage.getStore()?.afterOwnedPathIsolation?.(
      Object.freeze({
        path,
        isolatedPath: quarantinePath,
        site: "conditional_delete"
      })
    );
    quarantinedIdentity = await readRegularFilePathIdentity(quarantinePath, evidenceRef);
    if (
      quarantinedIdentity &&
      workspaceRecordPhysicalIdentityMatches(quarantinedIdentity, observedIdentity) &&
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
      if (mutationState) {
        mutationState.deletedGeneration = Object.freeze({
          dev: quarantinedIdentity.dev,
          ino: quarantinedIdentity.ino
        });
      }
      namespaceCleanupAttempted = true;
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
      return { status: "deleted" };
    }

    throw recordChangedBeforeConditionalRemovalError(evidenceRef);
  } catch (error) {
    const compensationErrors = await compensateOwnedIsolatedPath(
      quarantinePath,
      path,
      mutationNamespace,
      observedIdentity,
      observation.bytes,
      evidenceRef,
      "conditional_delete",
      namespaceCleanupAttempted
    );
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
    const entry = await lstat(path, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw recordDurableReadError("not_regular_file", evidenceRef);
    }
    if (entry.nlink !== 1n) {
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
    const entry = await lstat(path, { bigint: true });
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
  await publicationHookStorage
    .getStore()
    ?.beforeAuthorityNamespaceCreation?.(Object.freeze({ path: namespacePath }));
  await createPrivateAuthorityNamespaceAt(namespacePath, evidenceRef);
  return namespacePath;
}

async function createPrivateAuthorityNamespaceAt(
  namespacePath: string,
  evidenceRef: string
): Promise<void> {
  try {
    await mkdir(namespacePath, { mode: 0o700 });
    const entry = await lstat(namespacePath);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o700) {
      await rmdir(namespacePath);
      throw publicationStateError(evidenceRef);
    }
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
  evidenceRef: string,
  invokeHooks = true
): Promise<void> {
  let primaryError: unknown;
  const compensationErrors: unknown[] = [];
  for (let attempt = 1; attempt <= RECORD_NAMESPACE_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      if (invokeHooks) {
        await publicationHookStorage
          .getStore()
          ?.beforeAuthorityNamespaceRemoval?.(Object.freeze({ path: namespacePath, attempt }));
      }
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
  let wroteTemporary = false;
  try {
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
  }

  return data;
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

  const producerNamespacePath = join(
    directoryPath,
    `.${fileName}-${process.pid}-${randomUUID()}.authority`
  );
  const temporaryPath = join(producerNamespacePath, "generation");
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
  let cleanupPermitOwnership: "none" | "owned" | "transferred" = "none";
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
        cleanupPermit = reserveRecordAuthorityCleanupPermit(
          authorityLease,
          recordPath,
          evidenceRef
        );
        cleanupPermitOwnership = "owned";
      }
      if (publicationOutcome === "exists") {
        return { status: "exists" };
      }
      ownedResources.temporaryRecord = await writeOwnedTemporaryRecordFile(
        producerNamespacePath,
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
          producerNamespacePath,
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
        if (cleanupPermit && ownedResources.canonicalIdentity) {
          await bindRecordAuthorityCleanupPermitGeneration(
            cleanupPermit,
            ownedResources.canonicalIdentity,
            ownedResources.expectedBytes,
            hooks,
            evidenceRef
          );
        }
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
      try {
        await hooks?.beforePublicationCompensationStateInspection?.(
          Object.freeze({
            path: temporaryPath,
            site: "published_rollback",
            activeCleanupPermitCount: activeRecordAuthorityCleanupPermits
          })
        );
        if (await recordPathEntryExists(temporaryPath, evidenceRef)) {
          await removeOwnedPathWithoutHooks(
            temporaryPath,
            ownedResources.temporaryIdentity ?? ownedResources.canonicalIdentity,
            ownedResources.expectedBytes,
            evidenceRef,
            true,
            "temporary_generation_compensation"
          );
        }
      } catch (error) {
        compensationErrors.push(error);
      }
      publicationOutcome = undefined;
    }

    if (
      publicationOutcome !== "published" &&
      operationError !== undefined &&
      ownedResources.temporaryIdentity
    ) {
      try {
        await hooks?.beforePublicationCompensationStateInspection?.(
          Object.freeze({
            path: temporaryPath,
            site: "unpublished_cleanup",
            activeCleanupPermitCount: activeRecordAuthorityCleanupPermits
          })
        );
        if (await recordPathEntryExists(temporaryPath, evidenceRef)) {
          await removeOwnedPathWithoutHooks(
            temporaryPath,
            ownedResources.temporaryIdentity,
            ownedResources.expectedBytes,
            evidenceRef,
            true,
            "temporary_generation_compensation"
          );
        }
      } catch (error) {
        compensationErrors.push(error);
      }
    }

    if (operationError !== undefined) {
      throw preserveWorkspacePrimaryError(operationError, compensationErrors);
    }

    if (publicationOutcome === "exists") {
      return { status: "exists" };
    }
    if (publicationOutcome !== "published") {
      throw publicationStateError(evidenceRef);
    }

    if (cleanupPermit) {
      cleanupPermitOwnership = "transferred";
      return { status: "created", record: data, cleanupPermit };
    }
    return { status: "created", record: data };
  } finally {
    if (cleanupPermitOwnership === "owned") {
      cleanupPermitOwnership = "none";
      cancelRecordAuthorityCleanupPermit(cleanupPermit);
    }
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
    await closeTemporaryRecord(
      temporaryRecord,
      ownedResources.canonicalPath,
      ownedResources.temporaryPath,
      hooks
    );
  } finally {
    ownedResources.handleClosed = temporaryRecord.handleClosed;
  }
}

async function closeTemporaryRecord(
  temporaryRecord: OwnedTemporaryRecord,
  canonicalPath: string,
  temporaryPath: string,
  hooks: WorkspaceRecordPublicationHooks | undefined
): Promise<void> {
  if (temporaryRecord.handleClosed) return;

  const hookInput = Object.freeze({
    canonicalPath,
    temporaryPath,
    descriptor: Object.freeze({
      fd: temporaryRecord.file.fd,
      dev: temporaryRecord.identity.dev,
      ino: temporaryRecord.identity.ino
    })
  });
  let primaryError: unknown;
  const compensationErrors: unknown[] = [];
  try {
    await hooks?.beforeTemporaryFileClose?.(hookInput);
  } catch (error) {
    primaryError = error;
  }

  try {
    await temporaryRecord.file.close();
    temporaryRecord.handleClosed = true;
  } catch (error) {
    if (primaryError === undefined) primaryError = error;
    else compensationErrors.push(error);
  }

  if (temporaryRecord.handleClosed) {
    try {
      await hooks?.afterTemporaryFileClosed?.(hookInput);
    } catch (error) {
      if (primaryError === undefined) primaryError = error;
      else compensationErrors.push(error);
    }
  }

  if (primaryError !== undefined) {
    throw preserveWorkspacePrimaryError(primaryError, compensationErrors);
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

async function writeOwnedTemporaryRecordFile(
  namespacePath: string,
  temporaryPath: string,
  recordText: string,
  evidenceRef: string
): Promise<OwnedTemporaryRecord> {
  let temporaryFile: RecordFileHandle | undefined;
  let temporaryIdentity: OwnedTemporaryRecordIdentity | undefined;
  let shouldCleanup = false;
  let namespaceCreated = false;
  let operationError: unknown;
  try {
    await createPrivateAuthorityNamespaceAt(namespacePath, evidenceRef);
    namespaceCreated = true;
    temporaryFile = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR
    );
    shouldCleanup = true;
    const entry = await temporaryFile.stat({ bigint: true });
    if (!entry.isFile()) {
      throw publicationStateError(evidenceRef);
    }
    temporaryIdentity = { dev: entry.dev, ino: entry.ino };
    await compensationTestHookStorage.getStore()?.beforeOwnedTemporaryRecordWrite?.(
      Object.freeze({ path: temporaryPath, identity: temporaryIdentity, fd: temporaryFile.fd })
    );
    await temporaryFile.writeFile(recordText, "utf8");
    return { identity: temporaryIdentity, file: temporaryFile, handleClosed: false };
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
    if (temporaryFile) {
      try {
        await temporaryFile.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (namespaceCreated) {
    try {
      await rmdir(namespacePath);
    } catch (error) {
      cleanupErrors.push(error);
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
    const finalPublicIdentity = await readRegularFilePathIdentity(path, evidenceRef);
    if (!finalPublicIdentity) {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
      return;
    }
    if (!workspaceRecordPhysicalIdentityMatches(finalPublicIdentity, expected)) {
      throw publicationStateError(evidenceRef);
    }
    await compensationTestHookStorage.getStore()?.beforeOwnedPathIsolation?.(
      Object.freeze({ path, isolatedPath, site: "conditional_unlink_owned_path" })
    );
    await rename(path, isolatedPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
      return;
    }
    await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
    throw error;
  }
  try {
    await compensationTestHookStorage.getStore()?.afterOwnedPathIsolation?.(
      Object.freeze({
        path,
        isolatedPath,
        site: "conditional_unlink_owned_path"
      })
    );
    const isolatedIdentity = await readRegularFilePathIdentity(isolatedPath, evidenceRef);
    if (
      !isolatedIdentity ||
      !workspaceRecordPhysicalIdentityMatches(isolatedIdentity, expected) ||
      !(await ownedGenerationBytesEqual(isolatedPath, expected, expectedBytes, evidenceRef))
    ) {
      throw publicationStateError(evidenceRef);
    }
    if (!(await ownedGenerationBytesEqual(isolatedPath, expected, expectedBytes, evidenceRef))) {
      throw publicationStateError(evidenceRef);
    }
    await unlink(isolatedPath);
    await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
  } catch (error) {
    const compensationErrors = await compensateOwnedIsolatedPath(
      isolatedPath,
      path,
      mutationNamespace,
      expected,
      expectedBytes,
      evidenceRef,
      "conditional_unlink_owned_path"
    );
    throw preserveWorkspacePrimaryError(error, compensationErrors);
  }
}

async function readBoundedOpenFileBytes(file: RecordFileHandle): Promise<Buffer> {
  const before = await file.stat({ bigint: true });
  if (!before.isFile() || before.size > BigInt(MAX_SERVICE_RECORD_BYTES)) {
    throw new Error("Temporary record bytes are not bounded.");
  }
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const after = await file.stat({ bigint: true });
  if (offset !== bytes.length || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
    throw new Error("Temporary record bytes changed while observed.");
  }
  return bytes;
}

async function removeOwnedPublicationTemporaryPath(
  namespacePath: string,
  temporaryPath: string,
  temporaryIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  recordPath: string,
  evidenceRef: string,
  hooks: WorkspaceRecordPublicationHooks | undefined,
  operation: "hardlink_temp_cleanup",
  ownedResources?: HardlinkPublicationOwnedResources
): Promise<void> {
  const attemptErrors: unknown[] = [];
  for (let attempt = 1; attempt <= RECORD_TEMP_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await hooks?.beforeTemporaryUnlink?.({
        canonicalPath: recordPath,
        temporaryPath,
        attempt
      });
      await hooks?.beforeGenerationIsolation?.(
        Object.freeze({ path: temporaryPath, operation })
      );
      const isolatedIdentity = await readRegularFilePathIdentity(temporaryPath, evidenceRef);
      if (
        !isolatedIdentity ||
        !workspaceRecordPhysicalIdentityMatches(isolatedIdentity, temporaryIdentity) ||
        !(await ownedGenerationBytesEqual(
          temporaryPath,
          temporaryIdentity,
          expectedBytes,
          evidenceRef
        ))
      ) {
        throw publicationStateError(evidenceRef);
      }
      if (ownedResources) {
        ownedResources.isolatedGeneration = {
          namespacePath,
          path: temporaryPath,
          identity: isolatedIdentity
        };
      }
      await hooks?.beforeAuthorityOwnedUnlink?.(
        Object.freeze({ path: temporaryPath, operation })
      );
      if (
        !(await ownedGenerationBytesEqual(
          temporaryPath,
          temporaryIdentity,
          expectedBytes,
          evidenceRef
        ))
      ) {
        throw publicationStateError(evidenceRef);
      }
      await unlink(temporaryPath);
      await removeEmptyAuthorityOwnedMutationNamespace(namespacePath, evidenceRef);
      if (ownedResources) ownedResources.isolatedGeneration = undefined;
      return;
    } catch (error) {
      attemptErrors.push(error);
      if (attempt < RECORD_TEMP_CLEANUP_ATTEMPTS) {
        await sleep(RECORD_TEMP_CLEANUP_RETRY_MS);
        continue;
      }
    }
  }

  const finalizationErrors: unknown[] = [];
  try {
    if (await recordPathEntryExists(temporaryPath, evidenceRef)) {
      await removeOwnedPrivateGenerationWithoutHooks(
        temporaryPath,
        temporaryIdentity,
        expectedBytes,
        evidenceRef
      );
    }
  } catch (error) {
    finalizationErrors.push(error);
  }
  try {
    await removeEmptyAuthorityOwnedMutationNamespace(namespacePath, evidenceRef, false);
    if (ownedResources) ownedResources.isolatedGeneration = undefined;
  } catch (error) {
    finalizationErrors.push(error);
  }

  throw preserveWorkspacePrimaryError(
    publicationTemporaryCleanupError(evidenceRef),
    [...attemptErrors, ...finalizationErrors]
  );
}

async function removeOwnedPrivateGenerationWithoutHooks(
  path: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string
): Promise<void> {
  if (!(await ownedGenerationBytesEqual(path, expectedIdentity, expectedBytes, evidenceRef))) {
    throw publicationStateError(evidenceRef);
  }
  await unlink(path);
}

async function rollbackPublishedRecordClaim(
  recordPath: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string
): Promise<void> {
  await removeOwnedPathWithoutHooks(
    recordPath,
    expectedIdentity,
    expectedBytes,
    evidenceRef,
    false,
    "published_rollback"
  );
}

async function removeOwnedPathWithoutHooks(
  path: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string,
  requireExpectedBytes = true,
  site: Extract<
    WorkspaceRecordPostIsolationSite,
    "published_rollback" | "temporary_generation_compensation"
  > = "temporary_generation_compensation"
): Promise<void> {
  const mutationNamespace = await createAuthorityOwnedMutationNamespace(path, evidenceRef);
  const isolatedPath = join(mutationNamespace, "generation");
  let namespaceCleanupAttempted = false;
  try {
    const finalPublicIdentity = await readRegularFilePathIdentity(path, evidenceRef);
    if (!finalPublicIdentity) {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
      return;
    }
    if (!workspaceRecordPhysicalIdentityMatches(finalPublicIdentity, expectedIdentity)) {
      throw publicationStateError(evidenceRef);
    }
    await compensationTestHookStorage.getStore()?.beforeOwnedPathIsolation?.(
      Object.freeze({ path, isolatedPath, site })
    );
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
    await compensationTestHookStorage.getStore()?.afterOwnedPathIsolation?.(
      Object.freeze({ path, isolatedPath, site })
    );
    const identity = await readRegularFilePathIdentity(isolatedPath, evidenceRef);
    if (
      !identity ||
      !workspaceRecordPhysicalIdentityMatches(identity, expectedIdentity) ||
      (requireExpectedBytes &&
        !(await ownedGenerationBytesEqual(
          isolatedPath,
          expectedIdentity,
          expectedBytes,
          evidenceRef
        )))
    ) {
      throw publicationStateError(evidenceRef);
    }
    await unlink(isolatedPath);
    namespaceCleanupAttempted = true;
    await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
  } catch (error) {
    const cleanupErrors = await compensateOwnedIsolatedPath(
      isolatedPath,
      path,
      mutationNamespace,
      expectedIdentity,
      expectedBytes,
      evidenceRef,
      site,
      namespaceCleanupAttempted
    );
    throw preserveWorkspacePrimaryError(error, cleanupErrors);
  }
}

async function compensateOwnedIsolatedPath(
  isolatedPath: string,
  publicPath: string,
  mutationNamespace: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string,
  site: WorkspaceRecordPostIsolationSite,
  namespaceCleanupAlreadyAttempted = false
): Promise<unknown[]> {
  const compensationErrors: unknown[] = [];
  let isolatedPathExists: boolean | undefined;
  try {
    await compensationTestHookStorage.getStore()?.beforeOwnedPathCompensationStateInspection?.(
      Object.freeze({ path: publicPath, isolatedPath, site })
    );
    isolatedPathExists = await recordPathEntryExists(isolatedPath, evidenceRef);
  } catch (error) {
    compensationErrors.push(error);
  }

  if (isolatedPathExists !== false) {
    try {
      await restoreOwnedIsolatedPath(
        isolatedPath,
        publicPath,
        expectedIdentity,
        expectedBytes,
        evidenceRef,
        site
      );
    } catch (error) {
      compensationErrors.push(error);
    }
  }

  if (!namespaceCleanupAlreadyAttempted) {
    try {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
    } catch (error) {
      compensationErrors.push(error);
    }
  }
  return compensationErrors;
}

async function restoreOwnedIsolatedPath(
  isolatedPath: string,
  publicPath: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string,
  site: WorkspaceRecordPostIsolationSite
): Promise<void> {
  try {
    if (
      !(await ownedGenerationStateMatches(
        isolatedPath,
        expectedIdentity,
        expectedBytes,
        1n,
        evidenceRef
      ))
    ) {
      const cleanupErrors = await removeUnsafeOwnedIsolatedSource(
        isolatedPath,
        expectedIdentity,
        expectedBytes,
        evidenceRef
      );
      throw preserveWorkspacePrimaryError(publicationStateError(evidenceRef), cleanupErrors);
    }

    await link(isolatedPath, publicPath);
    const sourceUnlinkErrors: unknown[] = [];
    for (let attempt = 1; attempt <= RECORD_TEMP_CLEANUP_ATTEMPTS; attempt += 1) {
      let commitProofFailed = false;
      try {
        await compensationTestHookStorage.getStore()?.beforeOwnedIsolatedSourceUnlink?.(
          Object.freeze({ path: publicPath, isolatedPath, site, attempt })
        );
        if (
          !(await restoredLinkedGenerationMatches(
            publicPath,
            isolatedPath,
            expectedIdentity,
            expectedBytes,
            evidenceRef
          ))
        ) {
          commitProofFailed = true;
          const cleanupErrors = await rollbackUnsafeRestoredLink(
            publicPath,
            isolatedPath,
            expectedIdentity,
            expectedBytes,
            evidenceRef
          );
          throw preserveWorkspacePrimaryError(
            publicationStateError(evidenceRef),
            cleanupErrors
          );
        }
        await unlink(isolatedPath);
        if (
          !(await ownedGenerationStateMatches(
            publicPath,
            expectedIdentity,
            expectedBytes,
            1n,
            evidenceRef
          ))
        ) {
          commitProofFailed = true;
          const cleanupErrors = await removeExactOwnedPublicLink(
            publicPath,
            expectedIdentity,
            evidenceRef
          );
          throw preserveWorkspacePrimaryError(
            publicationStateError(evidenceRef),
            cleanupErrors
          );
        }
        return;
      } catch (error) {
        sourceUnlinkErrors.push(error);
        if (commitProofFailed) break;
        if (!(await recordPathEntryExists(isolatedPath, evidenceRef))) break;
        if (attempt < RECORD_TEMP_CLEANUP_ATTEMPTS) {
          await sleep(RECORD_TEMP_CLEANUP_RETRY_MS);
        }
      }
    }

    const primary = preserveWorkspacePrimaryError(
      sourceUnlinkErrors[0],
      sourceUnlinkErrors.slice(1)
    );
    const rollbackErrors = await rollbackUnsafeRestoredLink(
      publicPath,
      isolatedPath,
      expectedIdentity,
      expectedBytes,
      evidenceRef
    );
    throw preserveWorkspacePrimaryError(primary, rollbackErrors);
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

async function restoredLinkedGenerationMatches(
  publicPath: string,
  isolatedPath: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string
): Promise<boolean> {
  return (
    (await ownedGenerationStateMatches(
      publicPath,
      expectedIdentity,
      expectedBytes,
      2n,
      evidenceRef
    )) &&
    (await ownedGenerationStateMatches(
      isolatedPath,
      expectedIdentity,
      expectedBytes,
      2n,
      evidenceRef
    ))
  );
}

async function rollbackUnsafeRestoredLink(
  publicPath: string,
  isolatedPath: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string
): Promise<unknown[]> {
  const cleanupErrors = await removeExactOwnedPublicLink(
    publicPath,
    expectedIdentity,
    evidenceRef
  );
  cleanupErrors.push(
    ...(await removeUnsafeOwnedIsolatedSource(
      isolatedPath,
      expectedIdentity,
      expectedBytes,
      evidenceRef
    ))
  );
  return cleanupErrors;
}

async function removeExactOwnedPublicLink(
  publicPath: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  evidenceRef: string
): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];
  try {
    const publicIdentity = await readRegularFilePathIdentity(publicPath, evidenceRef);
    if (publicIdentity) {
      if (workspaceRecordPhysicalIdentityMatches(publicIdentity, expectedIdentity)) {
        await unlink(publicPath);
      } else {
        cleanupErrors.push(publicationStateError(evidenceRef));
      }
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  return cleanupErrors;
}

async function removeUnsafeOwnedIsolatedSource(
  isolatedPath: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string
): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];
  try {
    const identity = await lstat(isolatedPath, { bigint: true });
    if (
      identity.isFile() &&
      !identity.isSymbolicLink() &&
      identity.nlink > 1n &&
      workspaceRecordPhysicalIdentityMatches(identity, expectedIdentity) &&
      (await ownedGenerationBytesEqual(
        isolatedPath,
        expectedIdentity,
        expectedBytes,
        evidenceRef
      ))
    ) {
      await unlink(isolatedPath);
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
      cleanupErrors.push(error);
    }
  }
  return cleanupErrors;
}

async function ownedGenerationStateMatches(
  path: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  expectedLinkCount: bigint,
  evidenceRef: string
): Promise<boolean> {
  let file: RecordFileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== expectedLinkCount ||
      !workspaceRecordPhysicalIdentityMatches(before, expectedIdentity) ||
      before.size !== BigInt(expectedBytes.length) ||
      before.size > BigInt(MAX_SERVICE_RECORD_BYTES)
    ) {
      return false;
    }
    const bytes = await readBoundedOpenFileBytes(file);
    const after = await file.stat({ bigint: true });
    return (
      bytes.equals(expectedBytes) &&
      after.dev === before.dev &&
      after.ino === before.ino &&
      after.size === before.size &&
      after.nlink === expectedLinkCount
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
    throw publicationStateError(evidenceRef);
  } finally {
    await file?.close();
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
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      !workspaceRecordPhysicalIdentityMatches(before, expectedIdentity) ||
      before.size !== BigInt(expectedBytes.length) ||
      before.size > BigInt(MAX_SERVICE_RECORD_BYTES)
    ) {
      return false;
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
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
    entry = await lstat(temporaryPath, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw error;
    }
    throw publicationStateError(evidenceRef);
  }

  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    !workspaceRecordPhysicalIdentityMatches(entry, expected)
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
    beforeFinalParentValidation: hooks?.beforePublishedRecordFinalValidation
  });
  if (published.status !== "read" || !published.bytes.equals(Buffer.from(recordText, "utf8"))) {
    throw publicationStateError(evidenceRef);
  }
  if (expectedIdentity) {
    if (
      !workspaceRecordPhysicalIdentityMatches(published.identity, expectedIdentity)
    ) {
      throw publicationStateError(evidenceRef);
    }
  }
}

async function assertClosedTemporaryRecordAuthority(
  temporaryPath: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string
): Promise<OwnedTemporaryRecordIdentity> {
  const observed = await readDurableSingleLinkFile({
    path: temporaryPath,
    maxBytes: MAX_SERVICE_RECORD_BYTES
  });
  if (
    observed.status !== "read" ||
    !workspaceRecordPhysicalIdentityMatches(observed.identity, expectedIdentity) ||
    !observed.bytes.equals(expectedBytes)
  ) {
    throw publicationStateError(evidenceRef);
  }

  return observed.identity;
}

async function assertOpenRecordAuthority(
  temporaryRecord: OwnedTemporaryRecord,
  recordText: string,
  expectedLinks: number,
  evidenceRef: string
): Promise<void> {
  const expectedBytes = Buffer.from(recordText, "utf8");
  const before = await temporaryRecord.file.stat({ bigint: true });
  if (
    !before.isFile() ||
    !workspaceRecordPhysicalIdentityMatches(before, temporaryRecord.identity) ||
    before.nlink !== BigInt(expectedLinks) ||
    before.size !== BigInt(expectedBytes.length) ||
    before.size > BigInt(MAX_SERVICE_RECORD_BYTES)
  ) {
    throw publicationStateError(evidenceRef);
  }

  const observedBytes = Buffer.allocUnsafe(Number(before.size));
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
  const after = await temporaryRecord.file.stat({ bigint: true });
  if (
    offset !== expectedBytes.length ||
    !observedBytes.equals(expectedBytes) ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.nlink !== BigInt(expectedLinks) ||
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
  if (activeRecordAuthorityReservations >= MAX_RECORD_AUTHORITY_RESERVATIONS) {
    throw authorityCapacityError(evidenceRef);
  }
  activeRecordAuthorityReservations += 1;

  let preIdentityReservationActive = true;
  const releasePreIdentityReservation = () => {
    if (!preIdentityReservationActive) return;
    preIdentityReservationActive = false;
    activeRecordAuthorityReservations -= 1;
  };
  if (Date.now() >= acquisitionDeadline) {
    releasePreIdentityReservation();
    throw authorityWaitError(evidenceRef);
  }

  let identitySettled = false;
  const identityWork = Promise.resolve()
    .then(async () => {
      await hooks?.beforeRecordAuthorityIdentitySupplier?.(
        Object.freeze({ path: recordPath })
      );
      return await recordAuthorityIdentityCandidates(recordPath, evidenceRef);
    })
    .then(
      (identity) => {
        identitySettled = true;
        return identity;
      },
      (error: unknown) => {
        identitySettled = true;
        throw error;
      }
    );
  let deadlineTimeout: ReturnType<typeof setTimeout> | undefined;
  let identity: Awaited<ReturnType<typeof recordAuthorityIdentityCandidates>>;
  try {
    identity = await Promise.race([
      identityWork,
      new Promise<never>((_resolve, reject) => {
        deadlineTimeout = setTimeout(
          () => reject(authorityWaitError(evidenceRef)),
          Math.max(0, acquisitionDeadline - Date.now())
        );
      })
    ]);
  } catch (error) {
    if (identitySettled) {
      releasePreIdentityReservation();
    } else {
      void identityWork.then(releasePreIdentityReservation, releasePreIdentityReservation);
    }
    throw error;
  } finally {
    if (deadlineTimeout) clearTimeout(deadlineTimeout);
  }

  if (Date.now() >= acquisitionDeadline) {
    releasePreIdentityReservation();
    throw authorityWaitError(evidenceRef);
  }

  let existing: RecordAuthorityMutex | undefined;
  try {
    existing = findRecordAuthorityMutex(identity.aliases, evidenceRef);
    if ((existing?.reservations ?? 0) >= MAX_RECORD_AUTHORITY_RESERVATIONS_PER_PATH) {
      throw authorityCapacityError(evidenceRef);
    }
  } catch (error) {
    releasePreIdentityReservation();
    throw error;
  }

  if (!existing) {
    const mutex: RecordAuthorityMutex = {
      waiters: new Set(),
      aliases: new Set(),
      sequence: nextRecordAuthorityMutexSequence++,
      reservations: 1,
      cleanupPermits: 0,
      ownerActive: true
    };
    try {
      bindRecordAuthorityAliases(mutex, identity.aliases, evidenceRef);
    } catch (error) {
      mutex.ownerActive = false;
      mutex.reservations = 0;
      releasePreIdentityReservation();
      removeUnusedRecordAuthorityMutex(mutex);
      throw error;
    }
    preIdentityReservationActive = false;
    return createRecordAuthorityLease(mutex, identity.exactPath);
  }

  try {
    bindRecordAuthorityAliases(existing, identity.aliases, evidenceRef);
  } catch (error) {
    releasePreIdentityReservation();
    throw error;
  }

  existing.reservations += 1;
  preIdentityReservationActive = false;
  if (!existing.ownerActive && existing.waiters.size === 0) {
    existing.ownerActive = true;
    return createRecordAuthorityLease(existing, identity.exactPath);
  }
  const waitMs = Math.max(0, acquisitionDeadline - Date.now());
  let waiter!: RecordAuthorityWaiter;
  const lease = new Promise<RecordAuthorityLease>((resolveLease, rejectLease) => {
    waiter = {
      resolve: resolveLease,
      reject: rejectLease,
      timeout: setTimeout(() => {
        if (cancelRecordAuthorityWaiter(existing, waiter)) {
          rejectLease(authorityWaitError(evidenceRef));
        }
      }, waitMs),
      active: true,
      deadline: acquisitionDeadline,
      evidenceRef,
      kind: "ordinary",
      exactPath: identity.exactPath,
      ready: true
    };
    existing.waiters.add(waiter);
  });

  try {
    hooks?.onAuthorityContention?.(
      Object.freeze({ operation, deadline: acquisitionDeadline })
    );
  } catch (error) {
    if (cancelRecordAuthorityWaiter(existing, waiter)) {
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
  if (
    !state ||
    state.status !== "outstanding" ||
    !state.generation ||
    !state.pinnedFile ||
    state.pinnedFileClosed
  ) {
    throw publicationStateError(evidenceRef);
  }
  const expectedCleanupGeneration = Object.freeze({
    dev: state.generation.dev,
    ino: state.generation.ino
  });
  claimRecordAuthorityCleanupPermit(permit, state);
  const wasContended = state.mutex.ownerActive || state.mutex.waiters.size > 0;
  let waiter!: RecordAuthorityWaiter;
  const lease = new Promise<RecordAuthorityLease>((resolveLease, rejectLease) => {
    waiter = {
      resolve: resolveLease,
      reject: rejectLease,
      timeout: setTimeout(() => {
        if (timeoutRecordAuthorityCleanupWaiter(state.mutex, waiter)) {
          rejectLease(authorityWaitError(evidenceRef));
        }
      }, Math.max(0, acquisitionDeadline - Date.now())),
      active: true,
      deadline: acquisitionDeadline,
      evidenceRef,
      kind: "cleanup",
      exactPath: state.publicPath,
      ready: false,
      cleanupSetupSettled: false,
      cleanupPermit: permit,
      expectedCleanupGeneration
    };
    state.mutex.waiters.add(waiter);
  });
  void lease.catch(() => undefined);
  const setup = (async () => {
    try {
      await hooks?.beforeCleanupPermitIdentityResolution?.(Object.freeze({ path: recordPath }));
      if (!waiter.active) return;
      const identity = await recordAuthorityIdentityCandidates(recordPath, evidenceRef);
      if (!waiter.active) return;
      const candidateMutex = findRecordAuthorityMutex(identity.aliases, evidenceRef);
      await assertCleanupPermitPinnedGeneration(state, recordPath, evidenceRef);
      if (!waiter.active) return;
      if (identity.exactPath !== state.publicPath || candidateMutex !== state.mutex) {
        throw publicationStateError(evidenceRef);
      }
      bindRecordAuthorityAliases(state.mutex, identity.aliases, evidenceRef);
      if (!waiter.active) return;
      if (Date.now() >= acquisitionDeadline) throw authorityWaitError(evidenceRef);
      if (wasContended) {
        hooks?.onAuthorityContention?.(
          Object.freeze({ operation: "delete", deadline: acquisitionDeadline })
        );
      }
      if (!waiter.active) return;
      waiter.ready = true;
      if (!state.mutex.ownerActive) handoffRecordAuthorityLease(state.mutex);
    } catch (error) {
      if (cancelRecordAuthorityCleanupWaiter(state.mutex, waiter, false)) {
        waiter.reject(error);
      }
    } finally {
      waiter.cleanupSetupSettled = true;
      if (!waiter.active && !waiter.handedOff) {
        settleRecordAuthorityCleanupAdmission(permit);
      }
    }
  })();
  void setup.catch(() => undefined);
  return await lease;
}

function createRecordAuthorityLease(
  mutex: RecordAuthorityMutex,
  exactPath: string,
  consumesReservation = true,
  cleanupPermit?: WorkspaceRecordCleanupPermit,
  expectedCleanupGeneration?: WorkspaceRecordPhysicalIdentity,
  cleanupEvidenceRef?: string
): RecordAuthorityLease {
  let released = false;
  return {
    expectedCleanupGeneration,
    validateCleanupGeneration:
      cleanupPermit && cleanupEvidenceRef
        ? async () => {
            const state = cleanupPermitState.get(cleanupPermit);
            if (!state) throw publicationStateError(cleanupEvidenceRef);
            await assertCleanupPermitPinnedGeneration(
              state,
              state.publicPath,
              cleanupEvidenceRef
            );
          }
        : undefined,
    reserveCleanupPermit: (_publicPath, evidenceRef) => {
      if (released || mutex.cleanupPermits >= 1) {
        throw authorityCapacityError(evidenceRef);
      }
      if (activeRecordAuthorityCleanupPermits >= MAX_RECORD_AUTHORITY_RESERVATIONS) {
        throw authorityCapacityError(evidenceRef);
      }
      const permit = Object.freeze({}) as WorkspaceRecordCleanupPermit;
      mutex.cleanupPermits += 1;
      activeRecordAuthorityCleanupPermits += 1;
      mutex.outstandingCleanupPermit = permit;
      cleanupPermitState.set(permit, {
        mutex,
        publicPath: exactPath,
        status: "outstanding",
        capacityActive: true,
        pinnedFileClosed: false
      });
      return permit;
    },
    settleOutstandingCleanupPermit: (generation) => {
      settleRecordAuthorityCleanupPermit(mutex.outstandingCleanupPermit, generation);
    },
    release: () => {
      if (released) {
        return;
      }
      released = true;

      if (consumesReservation) {
        releaseRecordAuthorityReservation(mutex);
      }
      settleRecordAuthorityCleanupAdmission(cleanupPermit);
      if (handoffRecordAuthorityLease(mutex)) {
        return;
      }
      mutex.ownerActive = false;
      removeUnusedRecordAuthorityMutex(mutex);
    }
  };
}

function handoffRecordAuthorityLease(
  mutex: RecordAuthorityMutex
): boolean {
  for (;;) {
    const next = mutex.waiters.values().next().value as RecordAuthorityWaiter | undefined;
    if (!next) return false;
    if (!next.ready) {
      mutex.ownerActive = false;
      return true;
    }
    mutex.waiters.delete(next);
    next.active = false;
    clearTimeout(next.timeout);
    if (Date.now() >= next.deadline) {
      if (next.kind === "ordinary") {
        releaseRecordAuthorityReservation(mutex);
      } else {
        settleRecordAuthorityCleanupAdmission(next.cleanupPermit);
      }
      next.reject(authorityWaitError(next.evidenceRef));
      continue;
    }
    mutex.ownerActive = true;
    next.handedOff = true;
    next.resolve(
      createRecordAuthorityLease(
        mutex,
        next.exactPath,
        next.kind === "ordinary",
        next.cleanupPermit,
        next.expectedCleanupGeneration,
        next.evidenceRef
      )
    );
    return true;
  }
}

function cancelRecordAuthorityCleanupWaiter(
  mutex: RecordAuthorityMutex,
  waiter: RecordAuthorityWaiter,
  retainUntilSetupSettles = true
): boolean {
  if (!waiter.active || waiter.kind !== "cleanup" || !mutex.waiters.delete(waiter)) return false;
  waiter.active = false;
  clearTimeout(waiter.timeout);
  if (!retainUntilSetupSettles || waiter.cleanupSetupSettled) {
    settleRecordAuthorityCleanupAdmission(waiter.cleanupPermit);
  }
  if (!mutex.ownerActive) handoffRecordAuthorityLease(mutex);
  removeUnusedRecordAuthorityMutex(mutex);
  return true;
}

function timeoutRecordAuthorityCleanupWaiter(
  mutex: RecordAuthorityMutex,
  waiter: RecordAuthorityWaiter
): boolean {
  return cancelRecordAuthorityCleanupWaiter(mutex, waiter, true);
}

function reserveRecordAuthorityCleanupPermit(
  authorityLease: RecordAuthorityLease | undefined,
  publicPath: string,
  evidenceRef: string
): WorkspaceRecordCleanupPermit {
  if (!authorityLease) {
    throw authorityCapacityError(evidenceRef);
  }
  return authorityLease.reserveCleanupPermit(publicPath, evidenceRef);
}

async function bindRecordAuthorityCleanupPermitGeneration(
  permit: WorkspaceRecordCleanupPermit,
  generation: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  hooks: WorkspaceRecordPublicationHooks | undefined,
  evidenceRef: string
): Promise<void> {
  const state = cleanupPermitState.get(permit);
  if (
    !state ||
    state.status !== "outstanding" ||
    state.generation ||
    state.pinnedFile ||
    state.pinnedFileClosed
  ) {
    throw publicationStateError(evidenceRef);
  }
  let pinnedFile: RecordFileHandle | undefined;
  try {
    pinnedFile = await open(state.publicPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await pinnedFile.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !workspaceRecordPhysicalIdentityMatches(before, generation) ||
      before.size !== BigInt(expectedBytes.length) ||
      before.size > BigInt(MAX_SERVICE_RECORD_BYTES)
    ) {
      throw publicationStateError(evidenceRef);
    }
    const observedBytes = await readBoundedOpenFileBytes(pinnedFile);
    const after = await pinnedFile.stat({ bigint: true });
    if (
      !observedBytes.equals(expectedBytes) ||
      !after.isFile() ||
      after.nlink !== 1n ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      throw publicationStateError(evidenceRef);
    }
    state.generation = Object.freeze({ dev: generation.dev, ino: generation.ino });
    state.expectedBytes = Buffer.from(expectedBytes);
    state.afterPinnedFileClosed = hooks?.afterCleanupPermitPinnedHandleClosed;
    state.pinnedFile = pinnedFile;
    pinnedFile = undefined;
  } catch (error) {
    await pinnedFile?.close().catch(() => undefined);
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef);
  }
}

async function assertCleanupPermitPinnedGeneration(
  state: NonNullable<ReturnType<typeof cleanupPermitState.get>>,
  path: string,
  evidenceRef: string
): Promise<void> {
  const pinnedFile = state.pinnedFile;
  const generation = state.generation;
  const expectedBytes = state.expectedBytes;
  if (!pinnedFile || !generation || !expectedBytes || state.pinnedFileClosed) {
    throw publicationStateError(evidenceRef);
  }
  try {
    const [pinnedIdentity, pathIdentity, observedBytes] = await Promise.all([
      pinnedFile.stat({ bigint: true }),
      readRegularFilePathIdentity(path, evidenceRef),
      readBoundedOpenFileBytes(pinnedFile)
    ]);
    if (
      !pinnedIdentity.isFile() ||
      pinnedIdentity.nlink !== 1n ||
      pinnedIdentity.size !== BigInt(expectedBytes.length) ||
      !observedBytes.equals(expectedBytes) ||
      !workspaceRecordPhysicalIdentityMatches(pinnedIdentity, generation) ||
      !pathIdentity ||
      !workspaceRecordPhysicalIdentityMatches(pathIdentity, generation) ||
      !workspaceRecordPhysicalIdentityMatches(pathIdentity, pinnedIdentity)
    ) {
      throw publicationStateError(evidenceRef);
    }
  } catch (error) {
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef);
  }
}

function cancelRecordAuthorityCleanupPermit(
  permit: WorkspaceRecordCleanupPermit | undefined
): void {
  if (!permit) return;
  const state = cleanupPermitState.get(permit);
  if (!state || state.status !== "outstanding") return;
  settleRecordAuthorityCleanupPermitState(permit, state);
}

function claimRecordAuthorityCleanupPermit(
  permit: WorkspaceRecordCleanupPermit,
  state: NonNullable<ReturnType<typeof cleanupPermitState.get>>
): void {
  if (state.status !== "outstanding") return;
  state.status = "claimed";
  if (state.mutex.outstandingCleanupPermit === permit) {
    state.mutex.outstandingCleanupPermit = undefined;
  }
}

function settleRecordAuthorityCleanupPermit(
  permit: WorkspaceRecordCleanupPermit | undefined,
  generation: WorkspaceRecordPhysicalIdentity
): void {
  if (!permit) return;
  const state = cleanupPermitState.get(permit);
  if (
    !state ||
    state.status !== "outstanding" ||
    !state.generation ||
    !workspaceRecordPhysicalIdentityMatches(state.generation, generation)
  ) {
    return;
  }
  settleRecordAuthorityCleanupPermitState(permit, state);
}

function settleRecordAuthorityCleanupPermitState(
  permit: WorkspaceRecordCleanupPermit,
  state: NonNullable<ReturnType<typeof cleanupPermitState.get>>
): void {
  if (state.status !== "outstanding") return;
  state.status = "settled";
  if (state.mutex.outstandingCleanupPermit === permit) {
    state.mutex.outstandingCleanupPermit = undefined;
  }
  settleRecordAuthorityCleanupAdmissionState(state);
}

function settleRecordAuthorityCleanupAdmission(
  permit: WorkspaceRecordCleanupPermit | undefined
): void {
  if (!permit) return;
  const state = cleanupPermitState.get(permit);
  if (!state) return;
  settleRecordAuthorityCleanupAdmissionState(state);
}

function settleRecordAuthorityCleanupAdmissionState(
  state: NonNullable<ReturnType<typeof cleanupPermitState.get>>
): void {
  if (!state.capacityActive) return;
  state.status = "settled";
  state.capacityActive = false;
  state.mutex.cleanupPermits -= 1;
  activeRecordAuthorityCleanupPermits -= 1;
  closeRecordAuthorityCleanupPermitPinnedFile(state);
  removeUnusedRecordAuthorityMutex(state.mutex);
}

function closeRecordAuthorityCleanupPermitPinnedFile(
  state: NonNullable<ReturnType<typeof cleanupPermitState.get>>
): void {
  if (state.pinnedFileClosed) return;
  state.pinnedFileClosed = true;
  const pinnedFile = state.pinnedFile;
  state.pinnedFile = undefined;
  if (!pinnedFile) return;
  const input = Object.freeze({ path: state.publicPath, fd: pinnedFile.fd });
  void (async () => {
    try {
      await pinnedFile.close();
    } finally {
      await state.afterPinnedFileClosed?.(input);
    }
  })().catch(() => undefined);
}

function cancelRecordAuthorityWaiter(
  mutex: RecordAuthorityMutex,
  waiter: RecordAuthorityWaiter
): boolean {
  if (!waiter.active || !mutex.waiters.delete(waiter)) {
    return false;
  }
  waiter.active = false;
  clearTimeout(waiter.timeout);
  releaseRecordAuthorityReservation(mutex);
  return true;
}

function releaseRecordAuthorityReservation(mutex: RecordAuthorityMutex): void {
  mutex.reservations -= 1;
  activeRecordAuthorityReservations -= 1;
  removeUnusedRecordAuthorityMutex(mutex);
}

function removeUnusedRecordAuthorityMutex(mutex: RecordAuthorityMutex): void {
  if (
    !mutex.ownerActive &&
    mutex.reservations === 0 &&
    mutex.waiters.size === 0 &&
    mutex.cleanupPermits === 0
  ) {
    for (const alias of mutex.aliases) {
      if (activeRecordAuthorityMutexes.get(alias) === mutex) {
        activeRecordAuthorityMutexes.delete(alias);
      }
    }
    mutex.aliases.clear();
  }
}

async function recordAuthorityIdentityCandidates(
  recordPath: string,
  evidenceRef: string
): Promise<{ exactPath: string; aliases: readonly string[] }> {
  try {
    const candidates = await physicalAuthorityPathIdentityCandidates(recordPath, evidenceRef);
    return {
      exactPath: candidates.exact,
      aliases: Object.freeze(candidates.aliases.map(hashRecordAuthorityAlias))
    };
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

function hashRecordAuthorityAlias(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

function findRecordAuthorityMutex(
  aliases: readonly string[],
  evidenceRef: string
): RecordAuthorityMutex | undefined {
  const matches = Array.from(
    new Set(
      aliases
        .map((alias) => activeRecordAuthorityMutexes.get(alias))
        .filter((mutex): mutex is RecordAuthorityMutex => mutex !== undefined)
    )
  ).sort((left, right) => left.sequence - right.sequence);
  if (matches.length > 1) {
    throw authorityCoordinationError(
      "Workspace record authority aliases collided across active lanes.",
      evidenceRef
    );
  }
  return matches[0];
}

function bindRecordAuthorityAliases(
  mutex: RecordAuthorityMutex,
  aliases: readonly string[],
  evidenceRef: string
): void {
  const uniqueAliases = new Set(aliases);
  let additionalAliasCount = 0;
  for (const alias of uniqueAliases) {
    const existing = activeRecordAuthorityMutexes.get(alias);
    if (existing && existing !== mutex) {
      throw authorityCoordinationError(
        "Workspace record authority aliases collided across active lanes.",
        evidenceRef
      );
    }
    if (!mutex.aliases.has(alias)) {
      additionalAliasCount += 1;
    }
  }
  if (
    mutex.aliases.size + additionalAliasCount >
    MAX_RECORD_AUTHORITY_ALIASES_PER_MUTEX
  ) {
    throw authorityCapacityError(evidenceRef);
  }
  for (const alias of uniqueAliases) {
    activeRecordAuthorityMutexes.set(alias, mutex);
    mutex.aliases.add(alias);
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

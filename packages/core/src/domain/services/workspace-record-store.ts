import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  preserveThrownValueAndCompensationErrors,
  registerPreservedErrorCompatibility,
  semanticPrimaryError
} from "./compensation-error-preservation";
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
const PRIVATE_PERMISSION_MASK = 0o7777n;
const PRIVATE_GENERATION_MODE = 0o600n;
const PRIVATE_NAMESPACE_MODE = 0o700n;

function hasExactPrivatePermissions(mode: bigint, expected: bigint): boolean {
  return (mode & PRIVATE_PERMISSION_MASK) === expected;
}

type FileStat = Awaited<ReturnType<typeof lstat>>;
type RecordFileHandle = Awaited<ReturnType<typeof open>>;

export interface WorkspaceRecordPhysicalIdentity {
  dev: bigint;
  ino: bigint;
}

interface OwnedTemporaryRecordIdentity extends WorkspaceRecordPhysicalIdentity {}

interface PresentFailure {
  readonly value: unknown;
}

interface ExactOwnedPublicLinkRemoval {
  readonly cleanupErrors: unknown[];
  readonly ownership: "removed" | "retained" | "relinquished";
  readonly isolatedSourceCleanupAllowed: boolean;
}

interface RestoredPublicLinkBinding {
  readonly identity: OwnedTemporaryRecordIdentity;
  readonly parentIdentity: OwnedTemporaryRecordIdentity;
  readonly parentCtimeNs: bigint;
  readonly parentMtimeNs: bigint;
}

function appendSequentialFailure(
  primary: PresentFailure | undefined,
  compensations: unknown[],
  value: unknown
): PresentFailure {
  if (primary) {
    compensations.push(value);
    return primary;
  }
  return { value };
}

type AuthorityMutatingCallbackOutcome =
  | { readonly status: "succeeded" }
  | { readonly status: "callback_failed"; readonly error: unknown };

async function captureAuthorityMutatingCallbackBoundary(
  callback: (() => Promise<void> | void) | undefined,
  proveAuthority: () => Promise<void>,
  proofCompensations: readonly unknown[] = []
): Promise<AuthorityMutatingCallbackOutcome> {
  let callbackFailure: PresentFailure | undefined;
  try {
    await callback?.();
  } catch (error) {
    callbackFailure = { value: error };
  }

  try {
    await proveAuthority();
  } catch (proofError) {
    throw preserveWorkspacePrimaryError(
      proofError,
      [
        ...(callbackFailure ? [callbackFailure.value] : []),
        ...proofCompensations
      ]
    );
  }

  return callbackFailure
    ? { status: "callback_failed", error: callbackFailure.value }
    : { status: "succeeded" };
}

async function runAuthorityMutatingCallbackBoundary(
  callback: (() => Promise<void> | void) | undefined,
  proveAuthority: () => Promise<void>,
  proofCompensations: readonly unknown[] = []
): Promise<void> {
  const outcome = await captureAuthorityMutatingCallbackBoundary(
    callback,
    proveAuthority,
    proofCompensations
  );
  if (outcome.status === "callback_failed") throw outcome.error;
}

interface OwnedAuthorityNamespace {
  path: string;
  parentPath: string;
  parentIdentity: OwnedTemporaryRecordIdentity;
  identity: OwnedTemporaryRecordIdentity;
}

interface OwnedGenerationExpectation {
  identity: OwnedTemporaryRecordIdentity;
  bytes: Buffer;
  mode: bigint;
  nlink: bigint;
}

interface OwnedGenerationCheckpoint {
  parentPath: string;
  parentIdentity: OwnedTemporaryRecordIdentity;
  namespace?: OwnedAuthorityNamespace;
  path: string;
  generation: OwnedGenerationExpectation;
}

type SafeRecordDirectoryBaseline =
  | { status: "absent" }
  | { status: "existing"; identity: OwnedTemporaryRecordIdentity };

type MutableCanonicalBaseline =
  | { status: "absent" }
  | {
      status: "existing";
      identity: OwnedTemporaryRecordIdentity;
      nlink: bigint;
      mode: bigint;
      bytes: Buffer;
      ctimeNs?: bigint;
      mtimeNs?: bigint;
    };

type CanonicalAuthorityBaseline =
  | MutableCanonicalBaseline
  | {
      status: "invalid";
      identity: OwnedTemporaryRecordIdentity;
      mode: bigint;
      nlink: bigint;
      size: bigint;
      ctimeNs: bigint;
      mtimeNs: bigint;
    };

export function workspaceRecordPhysicalIdentityMatches(
  observed: WorkspaceRecordPhysicalIdentity,
  expected: WorkspaceRecordPhysicalIdentity
): boolean {
  return observed.dev === expected.dev && observed.ino === expected.ino;
}

interface OwnedTemporaryRecord {
  identity: OwnedTemporaryRecordIdentity;
  namespaceIdentity: OwnedTemporaryRecordIdentity;
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
  temporaryExpectation?: OwnedGenerationExpectation;
  isolatedGeneration?: OwnedIsolatedGeneration;
  canonicalIdentity?: OwnedTemporaryRecordIdentity;
  handleClosed: boolean;
  compensationErrors: unknown[];
  directoryIdentity?: OwnedTemporaryRecordIdentity;
  namespaceAuthorityAdmitted: boolean;
}

type WorkspaceRecordAuthorityOperation = "read" | "hardlink" | "delete" | "rename";

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
  expectedCleanupGeneration?: OwnedGenerationExpectation;
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
    generationExpectation?: OwnedGenerationExpectation;
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
  afterDurableRecordObservation?: (
    input: Readonly<{ path: string; status: "read" | "missing" | "invalid" }>
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
        | "hardlink_temp_cleanup"
        | "rename_publication"
        | "rename_temp_cleanup";
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
        | "hardlink_temp_cleanup"
        | "rename_temp_cleanup";
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
  beforePublicationTemporaryUnlinkSyscall?: (
    input: Readonly<{ path: string; attempt: number }>
  ) => Promise<void> | void;
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
  afterOwnedPublicLinkCreated?: (
    input: Readonly<{
      path: string;
      isolatedPath: string;
      site: WorkspaceRecordPostIsolationSite;
    }>
  ) => Promise<void> | void;
  afterOwnedIsolatedSourceUnlink?: (
    input: Readonly<{
      path: string;
      isolatedPath: string;
      site: WorkspaceRecordPostIsolationSite;
      attempt: number;
    }>
  ) => Promise<void> | void;
  beforePostSourcePublicLinkCleanup?: (
    input: Readonly<{
      path: string;
      isolatedPath: string;
      site: WorkspaceRecordPostIsolationSite;
    }>
  ) => Promise<void> | void;
  beforeExactOwnedPublicLinkUnlink?: (
    input: Readonly<{ path: string }>
  ) => Promise<void> | void;
  afterExactOwnedPublicLinkUnlinkFailure?: (
    input: Readonly<{ path: string; error: unknown }>
  ) => Promise<void> | void;
  beforeUnsafeRestoredLinkRollback?: (
    input: Readonly<{
      path: string;
      isolatedPath: string;
      site: WorkspaceRecordPostIsolationSite;
    }>
  ) => Promise<void> | void;
  afterUnsafeRestoredLinkRollback?: (
    input: Readonly<{
      path: string;
      isolatedPath: string;
      site: WorkspaceRecordPostIsolationSite;
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
    const existingEntry = await maybeLstat(currentPath);
    if (existingEntry) {
      if (!isSafeDirectoryEntry(existingEntry)) {
        throw unsafeWorkspaceRecordDirectoryError(evidenceRef);
      }
      continue;
    }

    // The preceding serial walk proves every existing ancestor. Directory
    // creation is a mutation boundary, so retain the full pre/post proof used
    // by ensureSafeDirectory instead of carrying that admission across mkdir.
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
    const parentPath = dirname(path);
    const parentBaseline = await captureSafeRecordDirectoryBaseline(parentPath, evidenceRef);
    const canonicalBaseline = await captureCanonicalAuthorityBaseline(path, evidenceRef);
    if (hooks?.afterAuthorityLeaseAcquired) {
      await runAuthorityMutatingCallbackBoundary(
        () => hooks.afterAuthorityLeaseAcquired!(Object.freeze({ operation: "read" })),
        async () => {
          await assertSafeRecordDirectoryBaseline(parentPath, parentBaseline, evidenceRef);
          await assertCanonicalAuthorityBaseline(path, canonicalBaseline, evidenceRef);
        }
      );
    }
    return await readJsonRecordUnderAuthority(
      path,
      evidenceRef,
      schema,
      parentBaseline,
      canonicalBaseline
    );
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
      const parentPath = dirname(path);
      const admittedParentIdentity = await readSafeRecordDirectoryIdentity(
        parentPath,
        evidenceRef
      );
      if (hooks?.afterAuthorityLeaseAcquired) {
        await authorityLease.validateCleanupGeneration?.();
        await runAuthorityMutatingCallbackBoundary(
          () => hooks.afterAuthorityLeaseAcquired!(Object.freeze({ operation: "delete" })),
          async () => {
            await assertRecordDirectoryIdentity(parentPath, admittedParentIdentity, evidenceRef);
            await authorityLease.validateCleanupGeneration?.();
          }
        );
      }
      return await conditionalDeleteJsonRecordUnderAuthority(
        path,
        evidenceRef,
        schema,
        condition,
        hooks,
        mutationState,
        authorityLease.expectedCleanupGeneration,
        undefined,
        { status: "existing", identity: admittedParentIdentity }
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
  const parentPath = dirname(path);
  let initialParentAbsent = false;
  try {
    await lstat(parentPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      initialParentAbsent = true;
    } else {
      throw publicationStateError(evidenceRef);
    }
  }
  if (initialParentAbsent) {
    const initialParentBaseline: SafeRecordDirectoryBaseline = { status: "absent" };
    const initialCanonicalBaseline = await captureCanonicalAuthorityBaseline(path, evidenceRef);
    const observation = await inspectJsonRecordUnderAuthority(
      path,
      evidenceRef,
      schema,
      initialParentBaseline,
      initialCanonicalBaseline
    );
    await assertJsonRecordReadAuthority(
      path,
      observation.authorityObservation,
      initialParentBaseline,
      initialCanonicalBaseline,
      evidenceRef
    );
    if (observation.status === "missing") return { status: "missing" };
    throw publicationStateError(evidenceRef);
  }

  const hooks = publicationHookStorage.getStore();
  const authorityLease = await acquireRecordAuthority(path, evidenceRef, "delete", hooks);
  const mutationState: {
    started: boolean;
    deletedGeneration?: WorkspaceRecordPhysicalIdentity;
  } = { started: false };
  try {
    const admittedParentBaseline = await captureSafeRecordDirectoryBaseline(
      parentPath,
      evidenceRef
    );
    const canonicalBaseline = await captureCanonicalAuthorityBaseline(path, evidenceRef);
    if (hooks?.afterAuthorityLeaseAcquired) {
      await runAuthorityMutatingCallbackBoundary(
        () => hooks.afterAuthorityLeaseAcquired!(Object.freeze({ operation: "delete" })),
        async () => {
          await assertSafeRecordDirectoryBaseline(parentPath, admittedParentBaseline, evidenceRef);
          await assertCanonicalAuthorityBaseline(path, canonicalBaseline, evidenceRef);
        }
      );
    }
    return await conditionalDeleteJsonRecordUnderAuthority(
      path,
      evidenceRef,
      schema,
      condition,
      hooks,
      mutationState,
      undefined,
      canonicalBaseline,
      admittedParentBaseline
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
  expectedGeneration?: OwnedGenerationExpectation,
  ordinaryCanonicalBaseline?: CanonicalAuthorityBaseline,
  admittedParentBaseline?: SafeRecordDirectoryBaseline
): Promise<ConditionalDeleteJsonRecordResult> {
  const parentPath = dirname(path);
  const parentBaseline =
    admittedParentBaseline ??
    ({
      status: "existing",
      identity: await readSafeRecordDirectoryIdentity(parentPath, evidenceRef)
    } satisfies SafeRecordDirectoryBaseline);
  const callbackCanonicalBaseline: CanonicalAuthorityBaseline | undefined =
    expectedGeneration
      ? { status: "existing", ...expectedGeneration }
      : ordinaryCanonicalBaseline;
  const observation = await inspectJsonRecordUnderAuthority(
    path,
    evidenceRef,
    schema,
    parentBaseline,
    callbackCanonicalBaseline
  );
  let matched = false;
  let conditionFailure: PresentFailure | undefined;
  if (condition.kind === "malformed") {
    matched = observation.status === "malformed";
  } else if (observation.status === "record") {
    try {
      matched = condition.matches(observation.record, condition.expected);
    } catch (error) {
      conditionFailure = { value: error };
    }
  }
  try {
    await assertJsonRecordReadAuthority(
      path,
      observation.authorityObservation,
      parentBaseline,
      callbackCanonicalBaseline,
      evidenceRef
    );
  } catch (proofError) {
    const callbackErrors: unknown[] = [];
    if (observation.status === "malformed" || observation.status === "schema_threw") {
      callbackErrors.push(observation.error);
    }
    if (conditionFailure) callbackErrors.push(conditionFailure.value);
    throw preserveWorkspacePrimaryError(proofError, callbackErrors);
  }
  if (observation.status === "schema_threw") throw observation.error;
  if (conditionFailure) throw conditionFailure.value;
  if (observation.status === "missing") return { status: "missing" };
  if (parentBaseline.status !== "existing") throw publicationStateError(evidenceRef);
  const parentIdentity = parentBaseline.identity;
  const legacyOrdinaryMode = 0o644n;
  if (
    ordinaryCanonicalBaseline?.status === "existing" &&
    !hasExactPrivatePermissions(ordinaryCanonicalBaseline.mode, PRIVATE_GENERATION_MODE) &&
    !hasExactPrivatePermissions(ordinaryCanonicalBaseline.mode, legacyOrdinaryMode)
  ) {
    throw publicationStateError(evidenceRef);
  }
  const observedIdentity = observation.authorityObservation.identity;
  let generationExpectation =
    expectedGeneration ??
    (ordinaryCanonicalBaseline?.status === "existing"
      ? ordinaryCanonicalBaseline
      : await captureOwnedGenerationExpectation(
          path,
          observedIdentity,
          observation.bytes,
          1n,
          evidenceRef,
          PRIVATE_GENERATION_MODE
        ));
  const admittedGenerationCheckpoint: OwnedGenerationCheckpoint = {
    parentPath,
    parentIdentity,
    path,
    generation: generationExpectation
  };
  await runAuthorityMutatingCallbackBoundary(
    hooks?.beforeConditionalDelete
      ? () =>
          hooks.beforeConditionalDelete!(
            Object.freeze({
              path,
              conditionStatus: matched ? "matched" : "not_matched"
            })
          )
      : undefined,
    async () => await assertOwnedGenerationCheckpoint(admittedGenerationCheckpoint, evidenceRef)
  );
  if (!matched) {
    return { status: "condition_not_met" };
  }
  if (
    ordinaryCanonicalBaseline?.status === "existing" &&
    hasExactPrivatePermissions(ordinaryCanonicalBaseline.mode, legacyOrdinaryMode)
  ) {
    generationExpectation = await normalizeLegacyOrdinaryGenerationMode(
      path,
      parentPath,
      parentIdentity,
      generationExpectation,
      evidenceRef
    );
    admittedGenerationCheckpoint.generation = generationExpectation;
  }

  const mutationNamespace = await createAuthorityOwnedMutationNamespace(
    path,
    evidenceRef,
    parentIdentity
  );
  await assertOwnedGenerationCheckpoint(
    { ...admittedGenerationCheckpoint, namespace: mutationNamespace },
    evidenceRef
  );
  const quarantinePath = join(mutationNamespace.path, "generation");
  const compensationHooks = compensationTestHookStorage.getStore();
  try {
    if (hooks?.beforeGenerationIsolation) {
      await runAuthorityMutatingCallbackBoundary(
        () =>
          hooks.beforeGenerationIsolation!(
            Object.freeze({ path, operation: "conditional_delete" })
          ),
        async () =>
          await assertConditionalDeleteGenerationCheckpoint(
            { ...admittedGenerationCheckpoint, namespace: mutationNamespace },
            evidenceRef
          )
      );
    }
    if (compensationHooks?.beforeOwnedPathIsolation) {
      await runAuthorityMutatingCallbackBoundary(
        () =>
          compensationHooks.beforeOwnedPathIsolation!(
            Object.freeze({ path, isolatedPath: quarantinePath, site: "conditional_delete" })
          ),
        async () =>
          await assertConditionalDeleteGenerationCheckpoint(
            { ...admittedGenerationCheckpoint, namespace: mutationNamespace },
            evidenceRef
          )
      );
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    throw preserveWorkspacePrimaryError(error, cleanupErrors);
  }
  try {
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
    const afterIsolation = compensationTestHookStorage.getStore()?.afterOwnedPathIsolation;
    await runAuthorityMutatingCallbackBoundary(
      afterIsolation
        ? () =>
            afterIsolation(
              Object.freeze({
                path,
                isolatedPath: quarantinePath,
                site: "conditional_delete"
              })
            )
        : undefined,
      async () => {
        if (
          !(await ownedGenerationStateMatches(
            quarantinePath,
            generationExpectation,
            generationExpectation.nlink,
            evidenceRef
          ))
        ) throw recordChangedBeforeConditionalRemovalError(evidenceRef);
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
      }
    );
    if (
      await ownedGenerationStateMatches(
        quarantinePath,
        generationExpectation,
        generationExpectation.nlink,
        evidenceRef
      )
    ) {
      quarantinedIdentity = generationExpectation.identity;
      await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
      if (hooks?.beforeAuthorityOwnedUnlink) {
        await runAuthorityMutatingCallbackBoundary(
          () =>
            hooks.beforeAuthorityOwnedUnlink!(
              Object.freeze({ path, operation: "conditional_delete" })
            ),
          async () => {
            if (
              !(await ownedGenerationStateMatches(
                quarantinePath,
                generationExpectation,
                generationExpectation.nlink,
                evidenceRef
              ))
            ) {
              throw recordChangedBeforeConditionalRemovalError(evidenceRef);
            }
            await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
          }
        );
      }
      await unlink(quarantinePath);
      if (mutationState) {
        mutationState.deletedGeneration = Object.freeze({
          dev: quarantinedIdentity.dev,
          ino: quarantinedIdentity.ino
        });
      }
      namespaceCleanupAttempted = true;
      let namespaceCleanupFailure: PresentFailure | undefined;
      let namespaceCleanupCompensations: readonly unknown[] = [];
      try {
        namespaceCleanupCompensations = await removeEmptyAuthorityOwnedMutationNamespace(
          mutationNamespace,
          evidenceRef
        );
      } catch (error) {
        namespaceCleanupFailure = { value: error };
      }
      try {
        await assertRecordDirectoryIdentity(parentPath, parentIdentity, evidenceRef);
        await assertMutableCanonicalBaseline(path, { status: "absent" }, evidenceRef);
      } catch (proofError) {
        throw preserveWorkspacePrimaryError(
          proofError,
          [
            ...(namespaceCleanupFailure ? [namespaceCleanupFailure.value] : []),
            ...namespaceCleanupCompensations
          ]
        );
      }
      if (namespaceCleanupFailure) throw namespaceCleanupFailure.value;
      return { status: "deleted" };
    }

    throw recordChangedBeforeConditionalRemovalError(evidenceRef);
  } catch (error) {
    const compensationErrors = await compensateOwnedIsolatedPath(
      quarantinePath,
      path,
      mutationNamespace,
      generationExpectation,
      evidenceRef,
      "conditional_delete",
      namespaceCleanupAttempted
    );
    const primary = preserveWorkspacePrimaryError(error, compensationErrors);
    if (primary instanceof TaskServiceError) throw primary;
    const semanticPrimary = semanticPrimaryError(primary);
    if (semanticPrimary instanceof TaskServiceError) {
      throw taskServiceErrorWithCompensationEnvelope(semanticPrimary, primary);
    }
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

async function assertConditionalDeleteGenerationCheckpoint(
  checkpoint: OwnedGenerationCheckpoint & { namespace: OwnedAuthorityNamespace },
  evidenceRef: string
): Promise<void> {
  let generationMatches = false;
  try {
    generationMatches = await ownedGenerationStateMatches(
      checkpoint.path,
      checkpoint.generation,
      checkpoint.generation.nlink,
      evidenceRef
    );
  } catch {
    throw recordChangedBeforeConditionalRemovalError(evidenceRef);
  }
  if (!generationMatches) {
    throw recordChangedBeforeConditionalRemovalError(evidenceRef);
  }
  await assertAuthorityNamespaceOwnership(checkpoint.namespace, evidenceRef);
}

type JsonRecordInspection<T> =
  | {
      status: "missing";
      authorityObservation: Awaited<ReturnType<typeof readDurableSingleLinkFile>>;
    }
  | {
      status: "record";
      record: T;
      bytes: Buffer;
      authorityObservation: Extract<
        Awaited<ReturnType<typeof readDurableSingleLinkFile>>,
        { status: "read" }
      >;
    }
  | {
      status: "malformed";
      error: TaskServiceError;
      bytes: Buffer;
      authorityObservation: Extract<
        Awaited<ReturnType<typeof readDurableSingleLinkFile>>,
        { status: "read" }
      >;
    }
  | {
      status: "schema_threw";
      error: unknown;
      bytes: Buffer;
      authorityObservation: Extract<
        Awaited<ReturnType<typeof readDurableSingleLinkFile>>,
        { status: "read" }
      >;
    };

async function readJsonRecordUnderAuthority<T>(
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>,
  admittedParentBaseline?: SafeRecordDirectoryBaseline,
  canonicalBaseline?: CanonicalAuthorityBaseline
): Promise<T | undefined> {
  const inspection = await inspectJsonRecordUnderAuthority(
    path,
    evidenceRef,
    schema,
    admittedParentBaseline,
    canonicalBaseline
  );
  try {
    await assertJsonRecordReadAuthority(
      path,
      inspection.authorityObservation,
      admittedParentBaseline,
      canonicalBaseline,
      evidenceRef
    );
  } catch (proofError) {
    if (inspection.status === "malformed" || inspection.status === "schema_threw") {
      throw preserveWorkspacePrimaryError(proofError, [inspection.error]);
    }
    throw proofError;
  }
  if (inspection.status === "missing") {
    return undefined;
  }
  if (inspection.status === "malformed") {
    throw inspection.error;
  }
  if (inspection.status === "schema_threw") throw inspection.error;
  return inspection.record;
}

async function inspectJsonRecordUnderAuthority<T>(
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>,
  admittedParentBaseline?: SafeRecordDirectoryBaseline,
  canonicalBaseline?: CanonicalAuthorityBaseline
): Promise<JsonRecordInspection<T>> {
  const parentPath = dirname(path);
  const durableRead = await readDurableSingleLinkFile({
    path,
    maxBytes: MAX_SERVICE_RECORD_BYTES,
    validateParentPath: admittedParentBaseline
      ? durableReadParentValidatorFromAdmission(
          parentPath,
          admittedParentBaseline,
          evidenceRef
        )
      : async () => await isSafeExistingDirectoryPath(parentPath)
  });
  const afterDurableObservation = publicationHookStorage.getStore()
    ?.afterDurableRecordObservation;
  const durableFailure = durableRead.status === "invalid"
    ? recordDurableReadError(durableRead.reason, evidenceRef, durableRead.cause)
    : undefined;
  await runAuthorityMutatingCallbackBoundary(
    afterDurableObservation
      ? () => afterDurableObservation(Object.freeze({ path, status: durableRead.status }))
      : undefined,
    async () =>
      await assertJsonRecordReadAuthority(
        path,
        durableRead,
        admittedParentBaseline,
        canonicalBaseline,
        evidenceRef
      ),
    durableFailure ? [durableFailure] : []
  );
  if (durableRead.status === "missing") {
    return { status: "missing", authorityObservation: durableRead };
  }
  if (durableRead.status === "invalid") {
    throw durableFailure!;
  }

  let rawRecord: unknown;
  try {
    rawRecord = JSON.parse(durableRead.bytes.toString("utf8")) as unknown;
  } catch (error) {
    return {
      status: "malformed",
      bytes: durableRead.bytes,
      authorityObservation: durableRead,
      error: serviceWorkspaceError(
        "record_malformed",
        "Record is not valid JSON.",
        "A workspace record is malformed.",
        [evidenceRef],
        error
      )
    };
  }

  let parsedRecord:
    | { success: true; data: T }
    | { success: false; error: z.ZodError };
  try {
    parsedRecord = schema.safeParse(rawRecord);
  } catch (schemaError) {
    return {
      status: "schema_threw",
      error: schemaError,
      bytes: durableRead.bytes,
      authorityObservation: durableRead
    };
  }
  if (!parsedRecord.success) {
    return {
      status: "malformed",
      bytes: durableRead.bytes,
      authorityObservation: durableRead,
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

  return {
    status: "record",
    record: parsedRecord.data,
    bytes: durableRead.bytes,
    authorityObservation: durableRead
  };
}

async function assertJsonRecordReadAuthority(
  path: string,
  observed: Awaited<ReturnType<typeof readDurableSingleLinkFile>>,
  admittedParentBaseline: SafeRecordDirectoryBaseline | undefined,
  canonicalBaseline: CanonicalAuthorityBaseline | undefined,
  evidenceRef: string
): Promise<void> {
  const parentPath = dirname(path);
  if (admittedParentBaseline) {
    await assertSafeRecordDirectoryBaseline(
      parentPath,
      admittedParentBaseline,
      evidenceRef
    );
  }
  await assertDurableReadMatchesCanonicalBaseline(
    path,
    observed,
    canonicalBaseline,
    evidenceRef
  );
}

function durableReadParentValidatorFromAdmission(
  parentPath: string,
  admittedParentBaseline: SafeRecordDirectoryBaseline,
  evidenceRef: string
): () => Promise<boolean> {
  // The caller has just captured this baseline. The durable reader's first two
  // checks only bracket lstat/open and contain no hook or mutation, so they are
  // one authority epoch. Its final check still re-proves the complete parent
  // path after the read and after any final-validation hook.
  let admittedChecksRemaining = 2;
  return async () => {
    if (admittedChecksRemaining > 0) {
      admittedChecksRemaining -= 1;
      return true;
    }
    try {
      await assertSafeRecordDirectoryBaseline(
        parentPath,
        admittedParentBaseline,
        evidenceRef
      );
      return true;
    } catch {
      return false;
    }
  };
}

async function assertDurableReadMatchesCanonicalBaseline(
  path: string,
  observed: Awaited<ReturnType<typeof readDurableSingleLinkFile>>,
  expected: CanonicalAuthorityBaseline | undefined,
  evidenceRef: string
): Promise<void> {
  if (!expected) return;
  if (observed.status === "invalid") {
    if (expected.status !== "invalid") throw publicationStateError(evidenceRef);
    await assertCanonicalAuthorityBaseline(path, expected, evidenceRef);
    return;
  }
  if (expected.status === "absent") {
    if (observed.status !== "missing") throw publicationStateError(evidenceRef);
    await assertMutableCanonicalBaseline(path, expected, evidenceRef);
    return;
  }
  if (expected.status !== "existing" || observed.status !== "read") {
    throw publicationStateError(evidenceRef);
  }

  let finalPath: BigIntStats;
  try {
    finalPath = await lstat(path, { bigint: true });
  } catch {
    throw publicationStateError(evidenceRef);
  }
  if (
    !observed.bytes.equals(expected.bytes) ||
    !workspaceRecordPhysicalIdentityMatches(observed.identity, expected.identity) ||
    observed.linkCount !== expected.nlink ||
    observed.size !== BigInt(expected.bytes.length) ||
    !finalPath.isFile() ||
    finalPath.isSymbolicLink() ||
    !workspaceRecordPhysicalIdentityMatches(finalPath, observed.identity) ||
    finalPath.nlink !== expected.nlink ||
    finalPath.mode !== expected.mode ||
    finalPath.size !== observed.size ||
    finalPath.ctimeNs !== observed.mutation.ctimeNs ||
    finalPath.mtimeNs !== observed.mutation.mtimeNs
  ) {
    throw publicationStateError(evidenceRef);
  }
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
  evidenceRef: string,
  admittedParentIdentity?: OwnedTemporaryRecordIdentity
): Promise<OwnedAuthorityNamespace> {
  const parentPath = dirname(publicPath);
  const parentIdentity =
    admittedParentIdentity ??
    (await readSafeRecordDirectoryIdentity(parentPath, evidenceRef));
  const namespacePath = join(
    parentPath,
    `.${parse(publicPath).base}-${process.pid}-${randomUUID()}.authority`
  );
  const beforeCreation = publicationHookStorage.getStore()?.beforeAuthorityNamespaceCreation;
  if (beforeCreation) {
    await assertRecordDirectoryIdentity(parentPath, parentIdentity, evidenceRef);
    await runAuthorityMutatingCallbackBoundary(
      () => beforeCreation(Object.freeze({ path: namespacePath })),
      async () => await assertRecordDirectoryIdentity(parentPath, parentIdentity, evidenceRef)
    );
  } else {
    await assertRecordDirectoryIdentity(parentPath, parentIdentity, evidenceRef);
  }
  const identity = await createPrivateAuthorityNamespaceAt(namespacePath, evidenceRef);
  return { path: namespacePath, parentPath, parentIdentity, identity };
}

async function createPrivateAuthorityNamespaceAt(
  namespacePath: string,
  evidenceRef: string
): Promise<OwnedTemporaryRecordIdentity> {
  try {
    await mkdir(namespacePath, { mode: 0o700 });
    const entry = await lstat(namespacePath, { bigint: true });
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !hasExactPrivatePermissions(entry.mode, PRIVATE_NAMESPACE_MODE)
    ) {
      await rmdir(namespacePath);
      throw publicationStateError(evidenceRef);
    }
    return { dev: entry.dev, ino: entry.ino };
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
  ownership: OwnedAuthorityNamespace,
  evidenceRef: string,
  invokeHooks = true
): Promise<readonly unknown[]> {
  let primaryFailure: PresentFailure | undefined;
  const compensationErrors: unknown[] = [];
  for (let attempt = 1; attempt <= RECORD_NAMESPACE_CLEANUP_ATTEMPTS; attempt += 1) {
    if (invokeHooks) {
      try {
        const beforeRemoval = publicationHookStorage.getStore()?.beforeAuthorityNamespaceRemoval;
        await runAuthorityMutatingCallbackBoundary(
          beforeRemoval
            ? () => beforeRemoval(Object.freeze({ path: ownership.path, attempt }))
            : undefined,
          async () => await assertAuthorityNamespaceOwnership(ownership, evidenceRef)
        );
      } catch (error) {
        primaryFailure = appendSequentialFailure(
          primaryFailure,
          compensationErrors,
          error
        );
        if (attempt < RECORD_NAMESPACE_CLEANUP_ATTEMPTS) {
          await sleep(RECORD_TEMP_CLEANUP_RETRY_MS);
        }
        continue;
      }
    }
    try {
      if (!invokeHooks) await assertAuthorityNamespaceOwnership(ownership, evidenceRef);
    } catch (error) {
      primaryFailure = appendSequentialFailure(
        primaryFailure,
        compensationErrors,
        error
      );
      if (attempt < RECORD_NAMESPACE_CLEANUP_ATTEMPTS) {
        await sleep(RECORD_TEMP_CLEANUP_RETRY_MS);
      }
      continue;
    }
    try {
      await rmdir(ownership.path);
      return primaryFailure
        ? [primaryFailure.value, ...compensationErrors]
        : [];
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
        return primaryFailure
          ? [primaryFailure.value, ...compensationErrors]
          : [];
      }
      primaryFailure = appendSequentialFailure(
        primaryFailure,
        compensationErrors,
        error
      );
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
    preserveWorkspacePrimaryError(primaryFailure!.value, compensationErrors)
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

  const producerNamespacePath = join(
    directoryPath,
    `.${fileName}-${process.pid}-${randomUUID()}.authority`
  );
  const temporaryPath = join(producerNamespacePath, "generation");
  const expectedBytes = Buffer.from(recordText, "utf8");
  const hooks = publicationHookStorage.getStore();
  let authorityLease: RecordAuthorityLease | undefined;
  let temporaryRecord: OwnedTemporaryRecord | undefined;
  let recordDirectoryIdentity: OwnedTemporaryRecordIdentity | undefined;
  let canonicalBaseline: MutableCanonicalBaseline | undefined;
  let committed = false;
  let operationFailure: PresentFailure | undefined;
  const compensationErrors: unknown[] = [];
  try {
    try {
      authorityLease = await acquireRecordAuthority(recordPath, evidenceRef, "rename", hooks);
      recordDirectoryIdentity = await readSafeRecordDirectoryIdentity(
        directoryPath,
        evidenceRef
      );
      canonicalBaseline = await captureMutableCanonicalBaseline(recordPath, evidenceRef);
      await runAuthorityMutatingCallbackBoundary(
        hooks?.afterAuthorityLeaseAcquired
          ? () => hooks.afterAuthorityLeaseAcquired!(Object.freeze({ operation: "rename" }))
          : undefined,
        async () => {
          await assertRecordDirectoryIdentity(
            directoryPath,
            recordDirectoryIdentity!,
            evidenceRef
          );
          await assertMutableCanonicalBaseline(recordPath, canonicalBaseline!, evidenceRef);
        }
      );
      temporaryRecord = await writeOwnedTemporaryRecordFile(
        producerNamespacePath,
        temporaryPath,
        recordText,
        evidenceRef,
        directoryPath,
        recordDirectoryIdentity
      );
      if (hooks?.afterTemporaryFileWritten) {
        await runAuthorityMutatingCallbackBoundary(
          () => hooks.afterTemporaryFileWritten!({ canonicalPath: recordPath, temporaryPath }),
          async () => {
            await assertRecordDirectoryIdentity(
              directoryPath,
              recordDirectoryIdentity!,
              evidenceRef
            );
            await assertMutableCanonicalBaseline(recordPath, canonicalBaseline!, evidenceRef);
          }
        );
      }
      await publishOwnedMutableRecord(
        temporaryPath,
        temporaryRecord,
        recordPath,
        expectedBytes,
        directoryPath,
        recordDirectoryIdentity,
        canonicalBaseline,
        evidenceRef,
        hooks
      );
      committed = true;
    } catch (error) {
      operationFailure = { value: error };
    }

    if (temporaryRecord && !temporaryRecord.handleClosed) {
      try {
        await closeTemporaryRecord(temporaryRecord, recordPath, temporaryPath, hooks);
      } catch (error) {
        operationFailure = appendSequentialFailure(
          operationFailure,
          compensationErrors,
          error
        );
      }
    }

    if (temporaryRecord && !committed) {
      try {
        await removeOwnedMutablePublicationResources(
          producerNamespacePath,
          temporaryPath,
          temporaryRecord,
          expectedBytes,
          directoryPath,
          recordDirectoryIdentity!,
          recordPath,
          evidenceRef,
          hooks
        );
      } catch (error) {
        operationFailure = appendSequentialFailure(
          operationFailure,
          compensationErrors,
          error
        );
      }
    }

    if (operationFailure) {
      throw preserveWorkspacePrimaryError(operationFailure.value, compensationErrors);
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
  expectedBytes: Buffer,
  directoryPath: string,
  recordDirectoryIdentity: OwnedTemporaryRecordIdentity,
  canonicalBaseline: MutableCanonicalBaseline,
  evidenceRef: string,
  hooks?: WorkspaceRecordPublicationHooks
): Promise<void> {
  await assertOwnedTemporaryRecordPath(temporaryPath, temporaryRecord.identity, evidenceRef);
  await assertOpenRecordAuthority(
    temporaryRecord,
    expectedBytes.toString("utf8"),
    1,
    evidenceRef
  );
  await runAuthorityMutatingCallbackBoundary(
    hooks?.beforeGenerationIsolation
      ? () =>
          hooks.beforeGenerationIsolation!(
            Object.freeze({ path: temporaryPath, operation: "rename_publication" })
          )
      : undefined,
    async () => {
      await assertOwnedTemporaryRecordPath(temporaryPath, temporaryRecord.identity, evidenceRef);
      await assertOpenRecordAuthority(
        temporaryRecord,
        expectedBytes.toString("utf8"),
        1,
        evidenceRef
      );
    }
  );
  await closeTemporaryRecord(temporaryRecord, recordPath, temporaryPath, hooks);
  temporaryRecord.identity = await assertClosedTemporaryRecordAuthority(
    temporaryPath,
    temporaryRecord.identity,
    expectedBytes,
    evidenceRef
  );
  await assertFinalMutablePublicationAuthority(
    directoryPath,
    recordDirectoryIdentity,
    dirname(temporaryPath),
    temporaryRecord.namespaceIdentity,
    temporaryPath,
    temporaryRecord.identity,
    recordPath,
    canonicalBaseline,
    evidenceRef
  );

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

  const committedBaseline = await captureMutableCanonicalBaseline(recordPath, evidenceRef);
  if (
    committedBaseline.status !== "existing" ||
    !workspaceRecordPhysicalIdentityMatches(
      committedBaseline.identity,
      temporaryRecord.identity
    ) ||
    committedBaseline.nlink !== 1n ||
    !hasExactPrivatePermissions(committedBaseline.mode, PRIVATE_GENERATION_MODE) ||
    !committedBaseline.bytes.equals(expectedBytes)
  ) {
    throw publicationStateError(evidenceRef);
  }

  // The rename above is the commit point. The final validation-to-rename external
  // race is the accepted M1 residual. Namespace cleanup remains non-rejecting,
  // but no callback or cleanup failure can bypass the caller-altitude committed
  // generation checkpoint.
  let namespaceCleanupFailure: PresentFailure | undefined;
  let namespaceCleanupCompensations: readonly unknown[] = [];
  try {
    namespaceCleanupCompensations = await removeEmptyAuthorityOwnedMutationNamespace(
      {
        path: dirname(temporaryPath),
        parentPath: directoryPath,
        parentIdentity: recordDirectoryIdentity,
        identity: temporaryRecord.namespaceIdentity
      },
      evidenceRef
    );
  } catch (error) {
    namespaceCleanupFailure = { value: error };
  }
  try {
    await assertRecordDirectoryIdentity(
      directoryPath,
      recordDirectoryIdentity,
      evidenceRef
    );
    await assertMutableCanonicalBaseline(recordPath, committedBaseline, evidenceRef);
  } catch (proofError) {
    throw preserveWorkspacePrimaryError(
      proofError,
      [
        ...(namespaceCleanupFailure ? [namespaceCleanupFailure.value] : []),
        ...namespaceCleanupCompensations
      ]
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
    compensationErrors: [],
    namespaceAuthorityAdmitted: false
  };
  let authorityLease: RecordAuthorityLease | undefined;
  let publicationOutcome: "published" | "exists" | undefined;
  let operationFailure: PresentFailure | undefined;
  const compensationErrors = ownedResources.compensationErrors;
  let cleanupPermit: WorkspaceRecordCleanupPermit | undefined;
  let cleanupPermitOwnership: "none" | "owned" | "transferred" = "none";
  try {
    try {
      authorityLease = await acquireRecordAuthority(recordPath, evidenceRef, "hardlink", hooks);
      ownedResources.directoryIdentity = await readSafeRecordDirectoryIdentity(
        directoryPath,
        evidenceRef
      );
      if (hooks?.afterAuthorityLeaseAcquired) {
        await runAuthorityMutatingCallbackBoundary(
          () => hooks.afterAuthorityLeaseAcquired!(Object.freeze({ operation: "hardlink" })),
          async () =>
            await assertRecordDirectoryIdentity(
              directoryPath,
              ownedResources.directoryIdentity!,
              evidenceRef
            )
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
        evidenceRef,
        directoryPath,
        ownedResources.directoryIdentity
      );
      ownedResources.temporaryIdentity = ownedResources.temporaryRecord.identity;
      const temporaryNamespace = hardlinkTemporaryNamespaceOwnership(
        ownedResources,
        producerNamespacePath,
        directoryPath,
        evidenceRef
      );
      await assertAuthorityNamespaceOwnership(temporaryNamespace, evidenceRef);
      ownedResources.temporaryExpectation = await captureOwnedGenerationExpectation(
        temporaryPath,
        ownedResources.temporaryIdentity,
        ownedResources.expectedBytes,
        1n,
        evidenceRef,
        PRIVATE_GENERATION_MODE
      );
      const hardlinkCheckpoint: OwnedGenerationCheckpoint = {
        parentPath: directoryPath,
        parentIdentity: ownedResources.directoryIdentity,
        namespace: temporaryNamespace,
        path: temporaryPath,
        generation: ownedResources.temporaryExpectation
      };
      if (hooks?.afterTemporaryFileWritten) {
        await runAuthorityMutatingCallbackBoundary(
          () => hooks.afterTemporaryFileWritten!({ canonicalPath: recordPath, temporaryPath }),
          async () => await assertOwnedGenerationCheckpoint(hardlinkCheckpoint, evidenceRef)
        );
      }
      let linkCreated = false;
      try {
        await link(temporaryPath, recordPath);
        linkCreated = true;
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
      if (linkCreated) {
        publicationOutcome = "published";
        ownedResources.canonicalIdentity = ownedResources.temporaryIdentity;
        const callbackOutcome = await captureAuthorityMutatingCallbackBoundary(
          hooks?.afterCanonicalLink
            ? () => hooks.afterCanonicalLink!({ canonicalPath: recordPath, temporaryPath })
            : undefined,
          async () =>
            await assertHardlinkPublicationCheckpoint(
              hardlinkCheckpoint,
              recordPath,
              evidenceRef
            )
        );
        if (callbackOutcome.status === "callback_failed") {
          throw callbackOutcome.error;
        }
        ownedResources.namespaceAuthorityAdmitted = true;
      }
    } catch (error) {
      operationFailure = { value: error };
    }

    if (ownedResources.temporaryRecord && !ownedResources.handleClosed) {
      try {
        await closeOwnedTemporaryRecord(ownedResources, hooks);
      } catch (cleanupError) {
        operationFailure = appendSequentialFailure(
          operationFailure,
          compensationErrors,
          cleanupError
        );
      }
    }

    if (
      ownedResources.temporaryIdentity &&
      ownedResources.temporaryRecord &&
      ownedResources.directoryIdentity
    ) {
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
          {
            path: producerNamespacePath,
            parentPath: directoryPath,
            parentIdentity: ownedResources.directoryIdentity,
            identity: ownedResources.temporaryRecord.namespaceIdentity
          },
          ownedResources,
          ownedResources.namespaceAuthorityAdmitted &&
            !hooks?.beforeTemporaryFileClose &&
            !hooks?.afterTemporaryFileClosed &&
            !hooks?.beforeTemporaryUnlink &&
            !hooks?.beforeGenerationIsolation &&
            !hooks?.beforeAuthorityOwnedUnlink
        );
      } catch (cleanupError) {
        operationFailure = appendSequentialFailure(
          operationFailure,
          compensationErrors,
          cleanupError
        );
      }
    }

    if (
      publicationOutcome === "published" &&
      !operationFailure &&
      ownedResources.directoryIdentity &&
      ownedResources.temporaryExpectation
    ) {
      try {
        await assertPublishedRecordAuthority(
          recordPath,
          directoryPath,
          ownedResources.directoryIdentity,
          recordText,
          evidenceRef,
          ownedResources.temporaryExpectation,
          hooks
        );
        if (cleanupPermit && ownedResources.canonicalIdentity) {
          await bindRecordAuthorityCleanupPermitGeneration(
            cleanupPermit,
            ownedResources.temporaryExpectation,
            ownedResources.expectedBytes,
            hooks,
            evidenceRef,
            directoryPath,
            ownedResources.directoryIdentity
          );
        }
      } catch (error) {
        operationFailure = { value: error };
      }
    }

    if (
      publicationOutcome === "published" &&
      operationFailure &&
      ownedResources.canonicalIdentity &&
      ownedResources.directoryIdentity
    ) {
      try {
        await rollbackPublishedRecordClaim(
          recordPath,
          ownedResources.canonicalIdentity,
          ownedResources.expectedBytes,
          evidenceRef,
          directoryPath,
          ownedResources.directoryIdentity
        );
      } catch (error) {
        compensationErrors.push(error);
        try {
          const ownership = hardlinkTemporaryNamespaceOwnership(
            ownedResources,
            producerNamespacePath,
            directoryPath,
            evidenceRef
          );
          if (
            !(await recordPathEntryExists(temporaryPath, evidenceRef)) &&
            (await assertAuthorityNamespaceOwnershipIfPresent(ownership, evidenceRef))
          ) {
            await removeEmptyAuthorityOwnedMutationNamespace(ownership, evidenceRef);
          }
        } catch (cleanupError) {
          compensationErrors.push(cleanupError);
        }
      }
      try {
        const ownership = hardlinkTemporaryNamespaceOwnership(
          ownedResources,
          producerNamespacePath,
          directoryPath,
          evidenceRef
        );
        let namespacePresent = false;
        await runAuthorityMutatingCallbackBoundary(
          hooks?.beforePublicationCompensationStateInspection
            ? () =>
                hooks.beforePublicationCompensationStateInspection!(
                  Object.freeze({
                    path: temporaryPath,
                    site: "published_rollback",
                    activeCleanupPermitCount: activeRecordAuthorityCleanupPermits
                  })
                )
            : undefined,
          async () => {
            namespacePresent = await assertAuthorityNamespaceOwnershipIfPresent(
              ownership,
              evidenceRef
            );
          }
        );
        if (namespacePresent && (await recordPathEntryExists(temporaryPath, evidenceRef))) {
          await removeOwnedPathWithoutHooks(
            temporaryPath,
            ownedResources.temporaryIdentity ?? ownedResources.canonicalIdentity,
            ownedResources.expectedBytes,
            evidenceRef,
            "temporary_generation_compensation",
            ownedResources.temporaryRecord?.namespaceIdentity
          );
        }
        if (namespacePresent) {
          await removeEmptyAuthorityOwnedMutationNamespace(
            hardlinkTemporaryNamespaceOwnership(
              ownedResources,
              producerNamespacePath,
              directoryPath,
              evidenceRef
            ),
            evidenceRef
          );
        }
      } catch (error) {
        compensationErrors.push(error);
        try {
          const ownership = hardlinkTemporaryNamespaceOwnership(
            ownedResources,
            producerNamespacePath,
            directoryPath,
            evidenceRef
          );
          if (
            !(await recordPathEntryExists(temporaryPath, evidenceRef)) &&
            (await assertAuthorityNamespaceOwnershipIfPresent(ownership, evidenceRef))
          ) {
            await removeEmptyAuthorityOwnedMutationNamespace(ownership, evidenceRef);
          }
        } catch (cleanupError) {
          compensationErrors.push(cleanupError);
        }
      }
      publicationOutcome = undefined;
    }

    if (
      publicationOutcome !== "published" &&
      operationFailure &&
      ownedResources.temporaryIdentity
    ) {
      try {
        const ownership = hardlinkTemporaryNamespaceOwnership(
          ownedResources,
          producerNamespacePath,
          directoryPath,
          evidenceRef
        );
        let namespacePresent = false;
        await runAuthorityMutatingCallbackBoundary(
          hooks?.beforePublicationCompensationStateInspection
            ? () =>
                hooks.beforePublicationCompensationStateInspection!(
                  Object.freeze({
                    path: temporaryPath,
                    site: "unpublished_cleanup",
                    activeCleanupPermitCount: activeRecordAuthorityCleanupPermits
                  })
                )
            : undefined,
          async () => {
            namespacePresent = await assertAuthorityNamespaceOwnershipIfPresent(
              ownership,
              evidenceRef
            );
          }
        );
        if (namespacePresent && (await recordPathEntryExists(temporaryPath, evidenceRef))) {
          await removeOwnedPathWithoutHooks(
            temporaryPath,
            ownedResources.temporaryIdentity,
            ownedResources.expectedBytes,
            evidenceRef,
            "temporary_generation_compensation",
            ownedResources.temporaryRecord?.namespaceIdentity
          );
        }
        if (namespacePresent) {
          await removeEmptyAuthorityOwnedMutationNamespace(
            hardlinkTemporaryNamespaceOwnership(
              ownedResources,
              producerNamespacePath,
              directoryPath,
              evidenceRef
            ),
            evidenceRef
          );
        }
      } catch (error) {
        compensationErrors.push(error);
        try {
          const ownership = hardlinkTemporaryNamespaceOwnership(
            ownedResources,
            producerNamespacePath,
            directoryPath,
            evidenceRef
          );
          if (
            !(await recordPathEntryExists(temporaryPath, evidenceRef)) &&
            (await assertAuthorityNamespaceOwnershipIfPresent(ownership, evidenceRef))
          ) {
            await removeEmptyAuthorityOwnedMutationNamespace(ownership, evidenceRef);
          }
        } catch (cleanupError) {
          compensationErrors.push(cleanupError);
        }
      }
    }

    if (operationFailure) {
      throw preserveWorkspacePrimaryError(operationFailure.value, compensationErrors);
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
  let primaryFailure: PresentFailure | undefined;
  const compensationErrors: unknown[] = [];
  try {
    await hooks?.beforeTemporaryFileClose?.(hookInput);
  } catch (error) {
    primaryFailure = { value: error };
  }

  try {
    await temporaryRecord.file.close();
    temporaryRecord.handleClosed = true;
  } catch (error) {
    primaryFailure = appendSequentialFailure(primaryFailure, compensationErrors, error);
  }

  if (temporaryRecord.handleClosed) {
    try {
      await hooks?.afterTemporaryFileClosed?.(hookInput);
    } catch (error) {
      primaryFailure = appendSequentialFailure(primaryFailure, compensationErrors, error);
    }
  }

  if (primaryFailure) {
    throw preserveWorkspacePrimaryError(primaryFailure.value, compensationErrors);
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

async function writeOwnedTemporaryRecordFile(
  namespacePath: string,
  temporaryPath: string,
  recordText: string,
  evidenceRef: string,
  directoryPath: string,
  directoryIdentity: OwnedTemporaryRecordIdentity
): Promise<OwnedTemporaryRecord> {
  let temporaryFile: RecordFileHandle | undefined;
  let temporaryIdentity: OwnedTemporaryRecordIdentity | undefined;
  let shouldCleanup = false;
  let namespaceCreated = false;
  let namespaceIdentity: OwnedTemporaryRecordIdentity | undefined;
  let operationFailure: PresentFailure | undefined;
  try {
    namespaceIdentity = await createPrivateAuthorityNamespaceAt(namespacePath, evidenceRef);
    namespaceCreated = true;
    temporaryFile = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      0o600
    );
    shouldCleanup = true;
    const entry = await temporaryFile.stat({ bigint: true });
    if (!entry.isFile() || !hasExactPrivatePermissions(entry.mode, PRIVATE_GENERATION_MODE)) {
      throw publicationStateError(evidenceRef);
    }
    temporaryIdentity = { dev: entry.dev, ino: entry.ino };
    await compensationTestHookStorage.getStore()?.beforeOwnedTemporaryRecordWrite?.(
      Object.freeze({ path: temporaryPath, identity: temporaryIdentity, fd: temporaryFile.fd })
    );
    await temporaryFile.writeFile(recordText, "utf8");
    return {
      identity: temporaryIdentity,
      namespaceIdentity,
      file: temporaryFile,
      handleClosed: false
    };
  } catch (error) {
    operationFailure = {
      value: serviceWorkspaceError(
        "workspace_path_not_safe",
        "Failed to write workspace record temporary file.",
        "The workspace record could not be written safely.",
        [evidenceRef],
        error
      )
    };
  }

  const cleanupErrors: unknown[] = [];
  if (shouldCleanup) {
    let observedBytes: Buffer | undefined;
    if (temporaryFile) {
      try {
        observedBytes = (await readBoundedOpenFile(temporaryFile)).bytes;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (temporaryIdentity && observedBytes) {
      try {
        await assertAuthorityNamespaceOwnership(
          {
            path: namespacePath,
            parentPath: directoryPath,
            parentIdentity: directoryIdentity,
            identity: namespaceIdentity!
          },
          evidenceRef
        );
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
      await removeEmptyAuthorityOwnedMutationNamespace(
        {
          path: namespacePath,
          parentPath: directoryPath,
          parentIdentity: directoryIdentity,
          identity: namespaceIdentity!
        },
        evidenceRef
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throw preserveWorkspacePrimaryError(operationFailure!.value, cleanupErrors);
}

async function removeOwnedMutablePublicationResources(
  namespacePath: string,
  temporaryPath: string,
  temporaryRecord: OwnedTemporaryRecord,
  expectedBytes: Buffer,
  directoryPath: string,
  recordDirectoryIdentity: OwnedTemporaryRecordIdentity,
  recordPath: string,
  evidenceRef: string,
  hooks: WorkspaceRecordPublicationHooks | undefined
): Promise<void> {
  let cleanupFailure: PresentFailure | undefined;
  try {
    await assertMutableCleanupPathAuthority(
      directoryPath,
      recordDirectoryIdentity,
      namespacePath,
      temporaryRecord.namespaceIdentity,
      evidenceRef
    );
    await removeOwnedPublicationTemporaryPath(
      namespacePath,
      temporaryPath,
      temporaryRecord.identity,
      expectedBytes,
      recordPath,
      evidenceRef,
      hooks,
      "rename_temp_cleanup",
      {
        path: namespacePath,
        parentPath: directoryPath,
        parentIdentity: recordDirectoryIdentity,
        identity: temporaryRecord.namespaceIdentity
      }
    );
    return;
  } catch (error) {
    cleanupFailure = { value: error };
  }

  const finalizationErrors: unknown[] = [];
  const namespaceOwnership: OwnedAuthorityNamespace = {
    path: namespacePath,
    parentPath: directoryPath,
    parentIdentity: recordDirectoryIdentity,
    identity: temporaryRecord.namespaceIdentity
  };
  try {
    await assertMutableCleanupPathAuthority(
      directoryPath,
      recordDirectoryIdentity,
      namespacePath,
      temporaryRecord.namespaceIdentity,
      evidenceRef
    );
    await normalizeOwnedAuthorityNamespaceMode(namespaceOwnership, evidenceRef);

    if (await recordPathEntryExists(temporaryPath, evidenceRef)) {
      const generationExpectation = await captureOwnedGenerationExpectation(
        temporaryPath,
        temporaryRecord.identity,
        expectedBytes,
        1n,
        evidenceRef,
        PRIVATE_GENERATION_MODE
      );
      if (
        !(await ownedGenerationStateMatches(
          temporaryPath,
          generationExpectation,
          generationExpectation.nlink,
          evidenceRef
        ))
      ) {
        throw publicationStateError(evidenceRef);
      }
      await assertAuthorityNamespaceOwnership(namespaceOwnership, evidenceRef);
      if (
        !(await ownedGenerationStateMatches(
          temporaryPath,
          generationExpectation,
          generationExpectation.nlink,
          evidenceRef
        ))
      ) {
        throw publicationStateError(evidenceRef);
      }
      await assertAuthorityNamespaceOwnership(namespaceOwnership, evidenceRef);
      await unlink(temporaryPath);
    }

    await removeEmptyAuthorityOwnedMutationNamespace(namespaceOwnership, evidenceRef, false);
  } catch (error) {
    finalizationErrors.push(error);
  }

  throw preserveWorkspacePrimaryError(cleanupFailure!.value, finalizationErrors);
}

async function conditionalUnlinkOwnedPath(
  path: string,
  expected: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string
): Promise<void> {
  const generationExpectation = await captureOwnedGenerationExpectation(
    path,
    expected,
    expectedBytes,
    1n,
    evidenceRef,
    PRIVATE_GENERATION_MODE
  );
  const mutationNamespace = await createAuthorityOwnedMutationNamespace(path, evidenceRef);
  const isolatedPath = join(mutationNamespace.path, "generation");
  try {
    const finalPublicIdentity = await readRegularFilePathIdentity(path, evidenceRef);
    if (!finalPublicIdentity) {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
      return;
    }
    if (!workspaceRecordPhysicalIdentityMatches(finalPublicIdentity, expected)) {
      throw publicationStateError(evidenceRef);
    }
    const beforeIsolation = compensationTestHookStorage.getStore()?.beforeOwnedPathIsolation;
    await runAuthorityMutatingCallbackBoundary(
      beforeIsolation
        ? () => beforeIsolation(Object.freeze({ path, isolatedPath, site: "conditional_unlink_owned_path" }))
        : undefined,
      async () => {
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
        if (
          !(await ownedGenerationStateMatches(
            path,
            generationExpectation,
            generationExpectation.nlink,
            evidenceRef
          ))
        ) {
          await removePreIsolationExternallyLinkedOwnedPath(
            path,
            expected,
            expectedBytes,
            mutationNamespace.parentPath,
            mutationNamespace.parentIdentity,
            evidenceRef
          );
          throw publicationStateError(evidenceRef);
        }
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
      }
    );
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    throw preserveWorkspacePrimaryError(error, cleanupErrors);
  }
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
  try {
    const afterIsolation = compensationTestHookStorage.getStore()?.afterOwnedPathIsolation;
    await runAuthorityMutatingCallbackBoundary(
      afterIsolation
        ? () => afterIsolation(Object.freeze({ path, isolatedPath, site: "conditional_unlink_owned_path" }))
        : undefined,
      async () => {
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
        const isolatedIdentity = await readRegularFilePathIdentity(isolatedPath, evidenceRef);
        if (
          !isolatedIdentity ||
          !(await ownedGenerationStateMatches(
            isolatedPath,
            generationExpectation,
            generationExpectation.nlink,
            evidenceRef
          ))
        ) {
          throw publicationStateError(evidenceRef);
        }
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
      }
    );
    await unlink(isolatedPath);
    await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
  } catch (error) {
    const compensationErrors = await compensateOwnedIsolatedPath(
      isolatedPath,
      path,
      mutationNamespace,
      generationExpectation,
      evidenceRef,
      "conditional_unlink_owned_path"
    );
    throw preserveWorkspacePrimaryError(error, compensationErrors);
  }
}

async function removePreIsolationExternallyLinkedOwnedPath(
  path: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  parentPath: string,
  parentIdentity: OwnedTemporaryRecordIdentity,
  evidenceRef: string
): Promise<void> {
  const current = await captureOwnedGenerationExpectation(
    path,
    expectedIdentity,
    expectedBytes,
    undefined,
    evidenceRef,
    PRIVATE_GENERATION_MODE
  );
  if (current.nlink <= 1n) throw publicationStateError(evidenceRef);
  await assertRecordDirectoryIdentity(parentPath, parentIdentity, evidenceRef);
  if (!(await ownedGenerationStateMatches(path, current, current.nlink, evidenceRef))) {
    throw publicationStateError(evidenceRef);
  }
  await assertRecordDirectoryIdentity(parentPath, parentIdentity, evidenceRef);
  await unlink(path);
}

interface BoundedOpenFileObservation {
  bytes: Buffer;
  before: BigIntStats;
  after: BigIntStats;
}

async function readBoundedOpenFile(
  file: RecordFileHandle,
  admittedBefore?: BigIntStats
): Promise<BoundedOpenFileObservation> {
  const before = admittedBefore ?? (await file.stat({ bigint: true }));
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
  return { bytes, before, after };
}

async function removeOwnedPublicationTemporaryPath(
  namespacePath: string,
  temporaryPath: string,
  temporaryIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  recordPath: string,
  evidenceRef: string,
  hooks: WorkspaceRecordPublicationHooks | undefined,
  operation: "hardlink_temp_cleanup" | "rename_temp_cleanup",
  namespaceOwnership: OwnedAuthorityNamespace,
  ownedResources?: HardlinkPublicationOwnedResources,
  namespaceAuthorityAdmitted = false
): Promise<void> {
  const attemptErrors: unknown[] = [];
  let generationExpectation: OwnedGenerationExpectation | undefined;
  let generationExpectationFailure: PresentFailure | undefined;
  if (ownedResources?.temporaryExpectation) {
    generationExpectation = {
      ...ownedResources.temporaryExpectation,
      nlink: ownedResources.canonicalIdentity ? 2n : 1n
    };
  } else {
    try {
      generationExpectation = await captureOwnedGenerationExpectation(
        temporaryPath,
        temporaryIdentity,
        expectedBytes,
        undefined,
        evidenceRef,
        PRIVATE_GENERATION_MODE
      );
    } catch (error) {
      generationExpectationFailure = { value: error };
    }
  }
  for (let attempt = 1; attempt <= RECORD_TEMP_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      if (hooks?.beforeTemporaryUnlink) {
        await hooks.beforeTemporaryUnlink({ canonicalPath: recordPath, temporaryPath, attempt });
      }
      if (hooks?.beforeGenerationIsolation) {
        await runAuthorityMutatingCallbackBoundary(
          () => hooks.beforeGenerationIsolation!(Object.freeze({ path: temporaryPath, operation })),
          async () => {
            await assertAuthorityNamespaceOwnership(namespaceOwnership, evidenceRef);
            if (!generationExpectation) throw generationExpectationFailure!.value;
            if (
              !(await ownedGenerationStateMatches(
                temporaryPath,
                generationExpectation,
                generationExpectation.nlink,
                evidenceRef
              ))
            ) throw publicationStateError(evidenceRef);
          }
        );
      }
      if (!generationExpectation) throw generationExpectationFailure!.value;
      if (
        !(await ownedGenerationStateMatches(
          temporaryPath,
          generationExpectation,
          generationExpectation.nlink,
          evidenceRef
        ))
      ) {
        throw publicationStateError(evidenceRef);
      }
      if (ownedResources) {
        ownedResources.isolatedGeneration = {
          namespacePath,
          path: temporaryPath,
          identity: temporaryIdentity
        };
      }
      if (hooks?.beforeAuthorityOwnedUnlink) {
        await runAuthorityMutatingCallbackBoundary(
          () => hooks.beforeAuthorityOwnedUnlink!(Object.freeze({ path: temporaryPath, operation })),
          async () => {
            await assertAuthorityNamespaceOwnership(namespaceOwnership, evidenceRef);
            if (
              !(await ownedGenerationStateMatches(
                temporaryPath,
                generationExpectation!,
                generationExpectation!.nlink,
                evidenceRef
              ))
            ) throw publicationStateError(evidenceRef);
          }
        );
      }
      const beforeUnlinkSyscall = compensationTestHookStorage
        .getStore()
        ?.beforePublicationTemporaryUnlinkSyscall;
      if (beforeUnlinkSyscall) {
        namespaceAuthorityAdmitted = false;
        if (ownedResources) ownedResources.namespaceAuthorityAdmitted = false;
        await runAuthorityMutatingCallbackBoundary(
          () => beforeUnlinkSyscall(Object.freeze({ path: temporaryPath, attempt })),
          async () => {
            await assertAuthorityNamespaceOwnership(namespaceOwnership, evidenceRef);
            if (
              !(await ownedGenerationStateMatches(
                temporaryPath,
                generationExpectation!,
                generationExpectation!.nlink,
                evidenceRef
              ))
            ) throw publicationStateError(evidenceRef);
          }
        );
      } else if (!namespaceAuthorityAdmitted) {
        await assertAuthorityNamespaceOwnership(namespaceOwnership, evidenceRef);
      }
      await unlink(temporaryPath);
      namespaceAuthorityAdmitted = false;
      if (ownedResources) ownedResources.namespaceAuthorityAdmitted = false;
      await removeEmptyAuthorityOwnedMutationNamespace(namespaceOwnership, evidenceRef);
      if (ownedResources) ownedResources.isolatedGeneration = undefined;
      return;
    } catch (error) {
      attemptErrors.push(error);
      namespaceAuthorityAdmitted = false;
      if (ownedResources) ownedResources.namespaceAuthorityAdmitted = false;
      if (attempt < RECORD_TEMP_CLEANUP_ATTEMPTS) {
        await sleep(RECORD_TEMP_CLEANUP_RETRY_MS);
        continue;
      }
    }
  }

  const finalizationErrors: unknown[] = [];
  try {
    await assertAuthorityNamespaceOwnership(namespaceOwnership, evidenceRef);
    if (await recordPathEntryExists(temporaryPath, evidenceRef)) {
      await assertAuthorityNamespaceOwnership(namespaceOwnership, evidenceRef);
      await removeOwnedPrivateGenerationWithoutHooks(
        temporaryPath,
        temporaryIdentity,
        expectedBytes,
        namespaceOwnership,
        evidenceRef
      );
    }
  } catch (error) {
    finalizationErrors.push(error);
  }
  try {
    await removeEmptyAuthorityOwnedMutationNamespace(namespaceOwnership, evidenceRef, false);
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
  namespaceOwnership: OwnedAuthorityNamespace,
  evidenceRef: string
): Promise<void> {
  const expectation = await captureOwnedGenerationExpectation(
    path,
    expectedIdentity,
    expectedBytes,
    undefined,
    evidenceRef,
    PRIVATE_GENERATION_MODE
  );
  await assertAuthorityNamespaceOwnership(namespaceOwnership, evidenceRef);
  if (
    !(await ownedGenerationStateMatches(path, expectation, expectation.nlink, evidenceRef))
  ) {
    throw publicationStateError(evidenceRef);
  }
  await assertAuthorityNamespaceOwnership(namespaceOwnership, evidenceRef);
  await unlink(path);
}

async function rollbackPublishedRecordClaim(
  recordPath: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string,
  admittedParentPath: string,
  admittedParentIdentity: OwnedTemporaryRecordIdentity
): Promise<void> {
  await assertRecordDirectoryIdentity(
    admittedParentPath,
    admittedParentIdentity,
    evidenceRef
  );
  await removeOwnedPathWithoutHooks(
    recordPath,
    expectedIdentity,
    expectedBytes,
    evidenceRef,
    "published_rollback",
    admittedParentIdentity
  );
}

async function removeOwnedPathWithoutHooks(
  path: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string,
  site: Extract<
    WorkspaceRecordPostIsolationSite,
    "published_rollback" | "temporary_generation_compensation"
  > = "temporary_generation_compensation",
  admittedParentIdentity?: OwnedTemporaryRecordIdentity
): Promise<void> {
  const generationExpectation = await captureOwnedGenerationExpectation(
    path,
    expectedIdentity,
    expectedBytes,
    undefined,
    evidenceRef,
    PRIVATE_GENERATION_MODE
  );
  const mutationNamespace = await createAuthorityOwnedMutationNamespace(
    path,
    evidenceRef,
    admittedParentIdentity
  );
  const isolatedPath = join(mutationNamespace.path, "generation");
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
    const beforeIsolation = compensationTestHookStorage.getStore()?.beforeOwnedPathIsolation;
    await runAuthorityMutatingCallbackBoundary(
      beforeIsolation
        ? () => beforeIsolation(Object.freeze({ path, isolatedPath, site }))
        : undefined,
      async () => {
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
        if (
          !(await ownedGenerationStateMatches(
            path,
            generationExpectation,
            generationExpectation.nlink,
            evidenceRef
          ))
        ) {
          await removePreIsolationExternallyLinkedOwnedPath(
            path,
            expectedIdentity,
            expectedBytes,
            mutationNamespace.parentPath,
            mutationNamespace.parentIdentity,
            evidenceRef
          );
          throw publicationStateError(evidenceRef);
        }
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
      }
    );
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    throw preserveWorkspacePrimaryError(error, cleanupErrors);
  }
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
    const afterIsolation = compensationTestHookStorage.getStore()?.afterOwnedPathIsolation;
    await runAuthorityMutatingCallbackBoundary(
      afterIsolation
        ? () => afterIsolation(Object.freeze({ path, isolatedPath, site }))
        : undefined,
      async () => {
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
        const identity = await readRegularFilePathIdentity(isolatedPath, evidenceRef);
        if (
          !identity ||
          !(await ownedGenerationStateMatches(
            isolatedPath,
            generationExpectation,
            generationExpectation.nlink,
            evidenceRef
          ))
        ) {
          throw publicationStateError(evidenceRef);
        }
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
      }
    );
    await unlink(isolatedPath);
    namespaceCleanupAttempted = true;
    await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
  } catch (error) {
    const cleanupErrors = await compensateOwnedIsolatedPath(
      isolatedPath,
      path,
      mutationNamespace,
      generationExpectation,
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
  mutationNamespace: OwnedAuthorityNamespace,
  expectedGeneration: OwnedGenerationExpectation,
  evidenceRef: string,
  site: WorkspaceRecordPostIsolationSite,
  namespaceCleanupAlreadyAttempted = false
): Promise<unknown[]> {
  const compensationErrors: unknown[] = [];
  let isolatedPathExists: boolean | undefined;
  try {
    const beforeInspection = compensationTestHookStorage.getStore()
      ?.beforeOwnedPathCompensationStateInspection;
    await runAuthorityMutatingCallbackBoundary(
      beforeInspection
        ? () => beforeInspection(Object.freeze({ path: publicPath, isolatedPath, site }))
        : undefined,
      async () => await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef)
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
        mutationNamespace,
        expectedGeneration,
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
  mutationNamespace: OwnedAuthorityNamespace,
  expectedGeneration: OwnedGenerationExpectation,
  evidenceRef: string,
  site: WorkspaceRecordPostIsolationSite
): Promise<void> {
  let phase: "pre_public_link" | "public_link_created" | "post_source_committed" =
    "pre_public_link";
  try {
    await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
    if (
      !(await ownedGenerationStateMatches(
        isolatedPath,
        expectedGeneration,
        expectedGeneration.nlink,
        evidenceRef
      ))
    ) {
      const cleanupErrors = await removeUnsafeOwnedIsolatedSource(
        isolatedPath,
        mutationNamespace,
        expectedGeneration,
        evidenceRef
      );
      throw preserveWorkspacePrimaryError(publicationStateError(evidenceRef), cleanupErrors);
    }

    const linkAdmissionErrors: unknown[] = [];
    let publicLinkAdmitted = false;
    let publicLinkBinding: RestoredPublicLinkBinding | undefined;
    for (let attempt = 1; attempt <= RECORD_TEMP_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await link(isolatedPath, publicPath);
      } catch (error) {
        linkAdmissionErrors.push(error);
        break;
      }
      phase = "public_link_created";
      try {
        publicLinkBinding = await captureRestoredPublicLinkBinding(
          publicPath,
          expectedGeneration,
          evidenceRef
        );
        const afterPublicLink = compensationTestHookStorage.getStore()?.afterOwnedPublicLinkCreated;
        await runAuthorityMutatingCallbackBoundary(
          afterPublicLink
            ? () => afterPublicLink(Object.freeze({ path: publicPath, isolatedPath, site }))
            : undefined,
          async () => {
            await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
            if (
              !(await restoredPublicLinkBindingMatches(
                publicPath,
                publicLinkBinding!,
                expectedGeneration,
                expectedGeneration.nlink + 1n,
                evidenceRef
              ))
            ) throw publicationStateError(evidenceRef);
          }
        );
        publicLinkAdmitted = true;
        break;
      } catch (error) {
        linkAdmissionErrors.push(error);
        const rollback = await rollbackUnsafeRestoredLink(
          publicPath,
          isolatedPath,
          mutationNamespace,
          expectedGeneration,
          evidenceRef,
          publicLinkBinding
        );
        linkAdmissionErrors.push(...rollback.cleanupErrors);
        if (rollback.publicOwnership === "owned") break;
        phase = "pre_public_link";
        publicLinkBinding = undefined;
        if (attempt < RECORD_TEMP_CLEANUP_ATTEMPTS) {
          await sleep(RECORD_TEMP_CLEANUP_RETRY_MS);
        }
      }
    }
    if (!publicLinkAdmitted) {
      throw preserveWorkspacePrimaryError(linkAdmissionErrors[0], linkAdmissionErrors.slice(1));
    }

    const sourceUnlinkErrors: unknown[] = [];
    let publicOwnership: "owned" | "relinquished" = "owned";
    let firstProofRollbackAttempted = false;
    for (let attempt = 1; attempt <= RECORD_TEMP_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        let sourceUnlinkCallbackOutcome: AuthorityMutatingCallbackOutcome;
        try {
          const beforeSourceUnlink = compensationTestHookStorage.getStore()
            ?.beforeOwnedIsolatedSourceUnlink;
          sourceUnlinkCallbackOutcome = await captureAuthorityMutatingCallbackBoundary(
            beforeSourceUnlink
              ? () =>
                  beforeSourceUnlink(
                    Object.freeze({ path: publicPath, isolatedPath, site, attempt })
                  )
              : undefined,
            async () => {
              await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
              if (
                !(await restoredLinkedGenerationMatches(
                  publicPath,
                  isolatedPath,
                  mutationNamespace,
                  expectedGeneration,
                  evidenceRef,
                  publicLinkBinding!
                ))
              ) throw publicationStateError(evidenceRef);
            }
          );
        } catch (authorityDrift) {
          let unsafeRollbackCallbackFailure: PresentFailure | undefined;
          try {
            await compensationTestHookStorage.getStore()?.beforeUnsafeRestoredLinkRollback?.(
              Object.freeze({ path: publicPath, isolatedPath, site })
            );
          } catch (error) {
            unsafeRollbackCallbackFailure = { value: error };
          }
          firstProofRollbackAttempted = true;
          const rollback = await rollbackUnsafeRestoredLink(
            publicPath,
            isolatedPath,
            mutationNamespace,
            expectedGeneration,
            evidenceRef,
            publicLinkBinding
          );
          try {
            await compensationTestHookStorage.getStore()?.afterUnsafeRestoredLinkRollback?.(
              Object.freeze({ path: publicPath, isolatedPath, site })
            );
          } catch (error) {
            rollback.cleanupErrors.push(error);
          }
          const priorNoDriftCallbackFailures = sourceUnlinkErrors.splice(0);
          sourceUnlinkErrors.push(
            preserveWorkspacePrimaryError(authorityDrift, [
              ...priorNoDriftCallbackFailures,
              ...(unsafeRollbackCallbackFailure
                ? [unsafeRollbackCallbackFailure.value]
                : []),
              ...rollback.cleanupErrors
            ])
          );
          publicOwnership = rollback.publicOwnership;
          break;
        }
        if (sourceUnlinkCallbackOutcome.status === "callback_failed") {
          throw sourceUnlinkCallbackOutcome.error;
        }
        // A failure between the two exact proofs can only be induced by the
        // accepted external race because no callback runs in this window.
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
        if (
          !(await restoredLinkedGenerationMatches(
            publicPath,
            isolatedPath,
            mutationNamespace,
            expectedGeneration,
            evidenceRef,
            publicLinkBinding!
          ))
        ) {
          throw publicationStateError(evidenceRef);
        }
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
        await unlink(isolatedPath);
        phase = "post_source_committed";
        const afterSourceUnlink = compensationTestHookStorage.getStore()
          ?.afterOwnedIsolatedSourceUnlink;
        await runAuthorityMutatingCallbackBoundary(
          afterSourceUnlink
            ? () =>
                afterSourceUnlink(
                  Object.freeze({ path: publicPath, isolatedPath, site, attempt })
                )
            : undefined,
          async () => {
            await assertRecordDirectoryIdentity(
              mutationNamespace.parentPath,
              mutationNamespace.parentIdentity,
              evidenceRef
            );
            if (
              !(await ownedGenerationStateMatches(
                publicPath,
                expectedGeneration,
                expectedGeneration.nlink,
                evidenceRef
              ))
            ) throw publicationStateError(evidenceRef);
          }
        );
        return;
      } catch (error) {
        sourceUnlinkErrors.push(error);
        if (phase === "post_source_committed") break;
        try {
          await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
        } catch (authorityError) {
          sourceUnlinkErrors.push(authorityError);
          break;
        }
        if (!(await recordPathEntryExists(isolatedPath, evidenceRef))) break;
        if (attempt < RECORD_TEMP_CLEANUP_ATTEMPTS) {
          await sleep(RECORD_TEMP_CLEANUP_RETRY_MS);
        }
      }
    }

    let rollbackErrors: unknown[];
    if (phase === "post_source_committed" || publicOwnership === "relinquished") {
      rollbackErrors = [];
    } else if (firstProofRollbackAttempted) {
      const rollback = await removeExactOwnedPublicLink(
        publicPath,
        mutationNamespace,
        expectedGeneration,
        expectedGeneration.nlink + 1n,
        evidenceRef,
        false,
        publicLinkBinding
      );
      rollbackErrors = rollback.cleanupErrors;
      publicOwnership = rollback.ownership === "retained" ? "owned" : "relinquished";
    } else {
      const rollback = await rollbackUnsafeRestoredLink(
        publicPath,
        isolatedPath,
        mutationNamespace,
        expectedGeneration,
        evidenceRef,
        publicLinkBinding
      );
      rollbackErrors = rollback.cleanupErrors;
      publicOwnership = rollback.publicOwnership;
    }
    throw preserveWorkspacePrimaryError(sourceUnlinkErrors[0], [
      ...sourceUnlinkErrors.slice(1),
      ...rollbackErrors
    ]);
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
  mutationNamespace: OwnedAuthorityNamespace,
  expectedGeneration: OwnedGenerationExpectation,
  evidenceRef: string,
  publicLinkBinding: RestoredPublicLinkBinding
): Promise<boolean> {
  await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
  return (
    (await restoredPublicLinkBindingMatches(
      publicPath,
      publicLinkBinding,
      expectedGeneration,
      expectedGeneration.nlink + 1n,
      evidenceRef
    )) &&
    (await ownedGenerationStateMatches(
      isolatedPath,
      expectedGeneration,
      expectedGeneration.nlink + 1n,
      evidenceRef
    ))
  );
}

async function rollbackUnsafeRestoredLink(
  publicPath: string,
  isolatedPath: string,
  mutationNamespace: OwnedAuthorityNamespace,
  expectedGeneration: OwnedGenerationExpectation,
  evidenceRef: string,
  publicLinkBinding?: RestoredPublicLinkBinding
): Promise<{
  cleanupErrors: unknown[];
  publicOwnership: "owned" | "relinquished";
}> {
  const publicLinkRemoval = await removeExactOwnedPublicLink(
    publicPath,
    mutationNamespace,
    expectedGeneration,
    expectedGeneration.nlink + 1n,
    evidenceRef,
    true,
    publicLinkBinding
  );
  const cleanupErrors = publicLinkRemoval.cleanupErrors;
  if (publicLinkRemoval.isolatedSourceCleanupAllowed) {
    cleanupErrors.push(...(await removeUnsafeOwnedIsolatedSource(
      isolatedPath,
      mutationNamespace,
      expectedGeneration,
      evidenceRef
    )));
  }
  return {
    cleanupErrors,
    publicOwnership: publicLinkRemoval.ownership === "retained"
      ? "owned"
      : "relinquished"
  };
}

async function removeExactOwnedPublicLink(
  publicPath: string,
  mutationNamespace: OwnedAuthorityNamespace,
  expectedGeneration: OwnedGenerationExpectation,
  expectedLinkCount: bigint,
  evidenceRef: string,
  reportMismatch = true,
  expectedBinding?: RestoredPublicLinkBinding
): Promise<ExactOwnedPublicLinkRemoval> {
  const cleanupErrors: unknown[] = [];
  let ownership: ExactOwnedPublicLinkRemoval["ownership"] = "retained";
  let isolatedSourceCleanupAllowed = false;
  let finalUnlinkHookPassed = false;
  try {
    await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
    const publicIdentity = await readRegularFilePathIdentity(publicPath, evidenceRef);
    if (publicIdentity) {
      if (
        workspaceRecordPhysicalIdentityMatches(
          publicIdentity,
          expectedGeneration.identity
        ) &&
        (await ownedGenerationStateMatches(
          publicPath,
          expectedGeneration,
          expectedLinkCount,
          evidenceRef
        ))
      ) {
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
        if (
          !(await ownedGenerationStateMatches(
            publicPath,
            expectedGeneration,
            expectedLinkCount,
            evidenceRef
          ))
        ) {
          throw publicationStateError(evidenceRef);
        }
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
        const bindingCtimeNs = await readExactPublicLinkBindingCtime(
          publicPath,
          expectedGeneration.identity,
          evidenceRef
        );
        if (
          expectedBinding &&
          (!(await restoredPublicLinkParentBindingMatches(
            publicPath,
            expectedBinding,
            evidenceRef
          )) ||
            !workspaceRecordPhysicalIdentityMatches(publicIdentity, expectedBinding.identity))
        ) {
          ownership = "relinquished";
          if (reportMismatch) cleanupErrors.push(publicationStateError(evidenceRef));
          return { cleanupErrors, ownership, isolatedSourceCleanupAllowed };
        }
        const beforeExactUnlink = compensationTestHookStorage.getStore()
          ?.beforeExactOwnedPublicLinkUnlink;
        try {
          await runAuthorityMutatingCallbackBoundary(
            beforeExactUnlink
              ? () => beforeExactUnlink(Object.freeze({ path: publicPath }))
              : undefined,
            async () => {
              await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
              if (
                bindingCtimeNs === undefined ||
                (await readExactPublicLinkBindingCtime(
                  publicPath,
                  expectedGeneration.identity,
                  evidenceRef
                )) !== bindingCtimeNs ||
                !(await ownedGenerationStateMatches(
                  publicPath,
                  expectedGeneration,
                  expectedLinkCount,
                  evidenceRef
                ))
              ) throw publicationStateError(evidenceRef);
            }
          );
          finalUnlinkHookPassed = beforeExactUnlink !== undefined;
        } catch (error) {
          ownership = "relinquished";
          cleanupErrors.push(error);
          return { cleanupErrors, ownership, isolatedSourceCleanupAllowed };
        }
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
        if (
          !(await ownedGenerationStateMatches(
            publicPath,
            expectedGeneration,
            expectedLinkCount,
            evidenceRef
          )) ||
          (await readExactPublicLinkBindingCtime(
            publicPath,
            expectedGeneration.identity,
            evidenceRef
          )) !== bindingCtimeNs
        ) {
          ownership = "relinquished";
          if (reportMismatch) cleanupErrors.push(publicationStateError(evidenceRef));
          return { cleanupErrors, ownership, isolatedSourceCleanupAllowed };
        }
        try {
          await unlink(publicPath);
          ownership = "removed";
          isolatedSourceCleanupAllowed = true;
        } catch (error) {
          if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
            ownership = "relinquished";
          }
          cleanupErrors.push(error);
          try {
            await compensationTestHookStorage.getStore()?.afterExactOwnedPublicLinkUnlinkFailure?.(
              Object.freeze({ path: publicPath, error })
            );
          } catch (hookError) {
            cleanupErrors.push(hookError);
          }
        }
      } else {
        if (
          !workspaceRecordPhysicalIdentityMatches(
            publicIdentity,
            expectedGeneration.identity
          )
        ) {
          ownership = "relinquished";
        } else {
          isolatedSourceCleanupAllowed = true;
        }
        if (reportMismatch) cleanupErrors.push(publicationStateError(evidenceRef));
      }
    } else {
      ownership = "relinquished";
    }
  } catch (error) {
    if (finalUnlinkHookPassed) ownership = "relinquished";
    cleanupErrors.push(error);
  }
  return { cleanupErrors, ownership, isolatedSourceCleanupAllowed };
}

async function captureRestoredPublicLinkBinding(
  publicPath: string,
  expectedGeneration: OwnedGenerationExpectation,
  evidenceRef: string
): Promise<RestoredPublicLinkBinding> {
  let entry: BigIntStats;
  try {
    entry = await lstat(publicPath, { bigint: true });
  } catch {
    throw publicationStateError(evidenceRef);
  }
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== expectedGeneration.nlink + 1n ||
    entry.mode !== expectedGeneration.mode ||
    entry.size !== BigInt(expectedGeneration.bytes.length) ||
    !workspaceRecordPhysicalIdentityMatches(entry, expectedGeneration.identity)
  ) {
    throw publicationStateError(evidenceRef);
  }
  let parent: BigIntStats;
  try {
    parent = await lstat(dirname(publicPath), { bigint: true });
  } catch {
    throw publicationStateError(evidenceRef);
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw publicationStateError(evidenceRef);
  }
  return Object.freeze({
    identity: { dev: entry.dev, ino: entry.ino },
    parentIdentity: { dev: parent.dev, ino: parent.ino },
    parentCtimeNs: parent.ctimeNs,
    parentMtimeNs: parent.mtimeNs
  });
}

async function restoredPublicLinkBindingMatches(
  publicPath: string,
  binding: RestoredPublicLinkBinding,
  expectedGeneration: OwnedGenerationExpectation,
  expectedLinkCount: bigint,
  evidenceRef: string
): Promise<boolean> {
  if (
    !(await ownedGenerationStateMatches(
      publicPath,
      expectedGeneration,
      expectedLinkCount,
      evidenceRef
    ))
  ) {
    return false;
  }
  return await restoredPublicLinkParentBindingMatches(publicPath, binding, evidenceRef);
}

async function restoredPublicLinkParentBindingMatches(
  publicPath: string,
  binding: RestoredPublicLinkBinding,
  evidenceRef: string
): Promise<boolean> {
  try {
    const parent = await lstat(dirname(publicPath), { bigint: true });
    return (
      parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      workspaceRecordPhysicalIdentityMatches(parent, binding.parentIdentity) &&
      parent.ctimeNs === binding.parentCtimeNs &&
      parent.mtimeNs === binding.parentMtimeNs
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
    throw publicationStateError(evidenceRef);
  }
}

async function readExactPublicLinkBindingCtime(
  publicPath: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  evidenceRef: string
): Promise<bigint | undefined> {
  try {
    const entry = await lstat(publicPath, { bigint: true });
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !workspaceRecordPhysicalIdentityMatches(entry, expectedIdentity)
    ) {
      return undefined;
    }
    return entry.ctimeNs;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return undefined;
    throw publicationStateError(evidenceRef);
  }
}

async function removeUnsafeOwnedIsolatedSource(
  isolatedPath: string,
  mutationNamespace: OwnedAuthorityNamespace,
  expectedGeneration: OwnedGenerationExpectation,
  evidenceRef: string
): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];
  try {
    await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
    const identity = await lstat(isolatedPath, { bigint: true });
    if (
      identity.isFile() &&
      !identity.isSymbolicLink() &&
      identity.nlink > 1n &&
      workspaceRecordPhysicalIdentityMatches(identity, expectedGeneration.identity) &&
      (await ownedGenerationStateMatches(
        isolatedPath,
        expectedGeneration,
        identity.nlink,
        evidenceRef
      ))
    ) {
      await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
      if (
        !(await ownedGenerationStateMatches(
          isolatedPath,
          expectedGeneration,
          identity.nlink,
          evidenceRef
        ))
      ) {
        throw publicationStateError(evidenceRef);
      }
      await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
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
  expectedGeneration: OwnedGenerationExpectation,
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
      before.mode !== expectedGeneration.mode ||
      !workspaceRecordPhysicalIdentityMatches(before, expectedGeneration.identity) ||
      before.size !== BigInt(expectedGeneration.bytes.length) ||
      before.size > BigInt(MAX_SERVICE_RECORD_BYTES)
    ) {
      return false;
    }
    const { bytes, after } = await readBoundedOpenFile(file, before);
    return (
      bytes.equals(expectedGeneration.bytes) &&
      after.dev === before.dev &&
      after.ino === before.ino &&
      after.size === before.size &&
      after.mode === before.mode &&
      after.nlink === expectedLinkCount
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
    throw publicationStateError(evidenceRef);
  } finally {
    await file?.close();
  }
}

async function normalizeLegacyOrdinaryGenerationMode(
  path: string,
  parentPath: string,
  parentIdentity: OwnedTemporaryRecordIdentity,
  expectedGeneration: OwnedGenerationExpectation,
  evidenceRef: string
): Promise<OwnedGenerationExpectation> {
  if (!hasExactPrivatePermissions(expectedGeneration.mode, 0o644n)) {
    throw publicationStateError(evidenceRef);
  }
  await assertRecordDirectoryIdentity(parentPath, parentIdentity, evidenceRef);

  let file: RecordFileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      !hasExactPrivatePermissions(before.mode, 0o644n) ||
      !workspaceRecordPhysicalIdentityMatches(before, expectedGeneration.identity) ||
      before.size !== BigInt(expectedGeneration.bytes.length) ||
      before.size > BigInt(MAX_SERVICE_RECORD_BYTES)
    ) {
      throw publicationStateError(evidenceRef);
    }
    const beforeObservation = await readBoundedOpenFile(file, before);
    if (
      !beforeObservation.bytes.equals(expectedGeneration.bytes) ||
      beforeObservation.after.mode !== before.mode ||
      beforeObservation.after.nlink !== before.nlink
    ) {
      throw publicationStateError(evidenceRef);
    }

    await file.chmod(0o600);
    const afterChmod = await file.stat({ bigint: true });
    if (
      !afterChmod.isFile() ||
      afterChmod.isSymbolicLink() ||
      afterChmod.nlink !== 1n ||
      !hasExactPrivatePermissions(afterChmod.mode, PRIVATE_GENERATION_MODE) ||
      !workspaceRecordPhysicalIdentityMatches(afterChmod, expectedGeneration.identity) ||
      afterChmod.size !== BigInt(expectedGeneration.bytes.length)
    ) {
      throw publicationStateError(evidenceRef);
    }
    const afterObservation = await readBoundedOpenFile(file, afterChmod);
    if (
      !afterObservation.bytes.equals(expectedGeneration.bytes) ||
      afterObservation.after.mode !== afterChmod.mode ||
      afterObservation.after.nlink !== afterChmod.nlink
    ) {
      throw publicationStateError(evidenceRef);
    }
  } catch (error) {
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef);
  } finally {
    await file?.close();
  }

  await assertRecordDirectoryIdentity(parentPath, parentIdentity, evidenceRef);
  return await captureOwnedGenerationExpectation(
    path,
    expectedGeneration.identity,
    expectedGeneration.bytes,
    1n,
    evidenceRef,
    PRIVATE_GENERATION_MODE
  );
}

async function captureOwnedGenerationExpectation(
  path: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  expectedLinkCount: bigint | undefined,
  evidenceRef: string,
  expectedMode?: bigint
): Promise<OwnedGenerationExpectation> {
  let file: RecordFileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      (expectedLinkCount !== undefined && before.nlink !== expectedLinkCount) ||
      (expectedMode !== undefined && !hasExactPrivatePermissions(before.mode, expectedMode)) ||
      !workspaceRecordPhysicalIdentityMatches(before, expectedIdentity) ||
      before.size !== BigInt(expectedBytes.length) ||
      before.size > BigInt(MAX_SERVICE_RECORD_BYTES)
    ) {
      throw publicationStateError(evidenceRef);
    }
    const { bytes, after } = await readBoundedOpenFile(file, before);
    if (
      !bytes.equals(expectedBytes) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mode !== before.mode ||
      after.nlink !== before.nlink
    ) {
      throw publicationStateError(evidenceRef);
    }
    return {
      identity: { dev: before.dev, ino: before.ino },
      bytes: Buffer.from(expectedBytes),
      mode: before.mode,
      nlink: before.nlink
    };
  } catch (error) {
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef);
  } finally {
    await file?.close();
  }
}

async function assertOwnedGenerationCheckpoint(
  checkpoint: OwnedGenerationCheckpoint,
  evidenceRef: string,
  expectedLinkCount = checkpoint.generation.nlink
): Promise<void> {
  if (
    !(await ownedGenerationStateMatches(
      checkpoint.path,
      checkpoint.generation,
      expectedLinkCount,
      evidenceRef
    ))
  ) {
    throw publicationStateError(evidenceRef);
  }
  if (checkpoint.namespace) {
    await assertAuthorityNamespaceOwnership(checkpoint.namespace, evidenceRef);
  } else {
    await assertRecordDirectoryIdentity(
      checkpoint.parentPath,
      checkpoint.parentIdentity,
      evidenceRef
    );
  }
}

async function assertHardlinkPublicationCheckpoint(
  temporaryCheckpoint: OwnedGenerationCheckpoint,
  canonicalPath: string,
  evidenceRef: string
): Promise<void> {
  const namespace = temporaryCheckpoint.namespace;
  if (!namespace) throw publicationStateError(evidenceRef);

  await assertAuthorityNamespaceOwnership(namespace, evidenceRef);
  let canonical: BigIntStats;
  let temporary: BigIntStats;
  try {
    canonical = await lstat(canonicalPath, { bigint: true });
    temporary = await lstat(temporaryCheckpoint.path, { bigint: true });
  } catch {
    throw publicationStateError(evidenceRef);
  }
  const generation = temporaryCheckpoint.generation;
  if (
    !canonical.isFile() ||
    canonical.isSymbolicLink() ||
    canonical.nlink !== 2n ||
    canonical.mode !== generation.mode ||
    canonical.size !== BigInt(generation.bytes.length) ||
    !workspaceRecordPhysicalIdentityMatches(canonical, generation.identity) ||
    !temporary.isFile() ||
    temporary.isSymbolicLink() ||
    temporary.nlink !== 2n ||
    temporary.mode !== generation.mode ||
    temporary.size !== canonical.size ||
    !workspaceRecordPhysicalIdentityMatches(temporary, generation.identity) ||
    temporary.ctimeNs !== canonical.ctimeNs ||
    temporary.mtimeNs !== canonical.mtimeNs
  ) {
    throw publicationStateError(evidenceRef);
  }
}

function preserveWorkspacePrimaryError(primary: unknown, compensations: unknown[]): unknown {
  const preserved = preserveThrownValueAndCompensationErrors(
    primary,
    compensations,
    "Workspace record publication compensation failed."
  );
  const semanticPrimary = semanticPrimaryError(preserved);
  if (semanticPrimary instanceof TaskServiceError && preserved !== semanticPrimary) {
    return taskServiceErrorWithCompensationEnvelope(semanticPrimary, preserved);
  }
  return preserved;
}

function taskServiceErrorWithCompensationEnvelope(
  primary: TaskServiceError,
  compensationEnvelope: unknown
): TaskServiceError {
  const compatibleError = new TaskServiceError({
    code: primary.code,
    status: primary.status,
    category: primary.category,
    message: primary.message,
    userMessage: primary.userMessage,
    evidenceRefs: [...primary.evidenceRefs],
    retryable: primary.retryable,
    recommendedNextActions: [...primary.recommendedNextActions]
  });
  compatibleError.stack = primary.stack;
  if (compensationEnvelope instanceof Error) {
    compatibleError.cause = compensationEnvelope;
    registerPreservedErrorCompatibility(compatibleError, compensationEnvelope);
  }
  return compatibleError;
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
    !hasExactPrivatePermissions(entry.mode, PRIVATE_GENERATION_MODE) ||
    !workspaceRecordPhysicalIdentityMatches(entry, expected)
  ) {
    throw publicationStateError(evidenceRef);
  }
}

async function assertPublishedRecordAuthority(
  recordPath: string,
  directoryPath: string,
  expectedDirectoryIdentity: OwnedTemporaryRecordIdentity,
  recordText: string,
  evidenceRef: string,
  expectedGeneration?: OwnedGenerationExpectation,
  hooks?: WorkspaceRecordPublicationHooks
): Promise<void> {
  const admittedParentBaseline: SafeRecordDirectoryBaseline = {
    status: "existing",
    identity: expectedDirectoryIdentity
  };
  await assertSafeRecordDirectoryBaseline(
    directoryPath,
    admittedParentBaseline,
    evidenceRef
  );

  const published = await readDurableSingleLinkFile({
    path: recordPath,
    maxBytes: MAX_SERVICE_RECORD_BYTES,
    validateParentPath: durableReadParentValidatorFromAdmission(
      directoryPath,
      admittedParentBaseline,
      evidenceRef
    )
  });
  if (published.status === "invalid") {
    throw publicationStateError(evidenceRef, published.cause);
  }
  if (published.status !== "read") {
    throw publicationStateError(evidenceRef);
  }
  const provePublishedAuthority = async (reproveParent: boolean) => {
    if (reproveParent) {
      await assertSafeRecordDirectoryBaseline(
        directoryPath,
        admittedParentBaseline,
        evidenceRef
      );
    }
    if (!published.bytes.equals(Buffer.from(recordText, "utf8"))) {
      throw publicationStateError(evidenceRef);
    }
    if (expectedGeneration) {
      let finalPath: BigIntStats;
      try {
        finalPath = await lstat(recordPath, { bigint: true });
      } catch {
        throw publicationStateError(evidenceRef);
      }
      if (
        !workspaceRecordPhysicalIdentityMatches(
          published.identity,
          expectedGeneration.identity
        ) ||
        !finalPath.isFile() ||
        finalPath.isSymbolicLink() ||
        finalPath.nlink !== 1n ||
        finalPath.mode !== expectedGeneration.mode ||
        finalPath.size !== BigInt(expectedGeneration.bytes.length) ||
        !workspaceRecordPhysicalIdentityMatches(finalPath, published.identity) ||
        finalPath.ctimeNs !== published.mutation.ctimeNs ||
        finalPath.mtimeNs !== published.mutation.mtimeNs
      ) throw publicationStateError(evidenceRef);
    }
  };
  if (hooks?.beforePublishedRecordFinalValidation) {
    const callbackOutcome = await captureAuthorityMutatingCallbackBoundary(
        () =>
          hooks.beforePublishedRecordFinalValidation!(
            Object.freeze({ path: recordPath })
          ),
      async () => await provePublishedAuthority(true)
    );
    if (callbackOutcome.status === "callback_failed") {
      throw callbackOutcome.error;
    }
  } else {
    await provePublishedAuthority(false);
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
  await assertOwnedTemporaryRecordPath(temporaryPath, expectedIdentity, evidenceRef);

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
    !hasExactPrivatePermissions(before.mode, PRIVATE_GENERATION_MODE) ||
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
    !hasExactPrivatePermissions(after.mode, PRIVATE_GENERATION_MODE) ||
    after.nlink !== BigInt(expectedLinks) ||
    after.size !== before.size
  ) {
    throw publicationStateError(evidenceRef);
  }
}

async function readSafeRecordDirectoryIdentity(
  directoryPath: string,
  evidenceRef: string
): Promise<OwnedTemporaryRecordIdentity> {
  const directory = await readSafeExistingDirectoryEntry(directoryPath);
  if (!directory) {
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Record directory is not a safe directory.",
      "A workspace record directory is not usable.",
      [evidenceRef]
    );
  }

  return { dev: directory.dev, ino: directory.ino };
}

async function captureSafeRecordDirectoryBaseline(
  directoryPath: string,
  evidenceRef: string
): Promise<SafeRecordDirectoryBaseline> {
  try {
    const inspection = await inspectSafeExistingDirectoryPath(directoryPath);
    if (inspection.status === "missing") return { status: "absent" };
    if (inspection.status === "unsafe") throw publicationStateError(evidenceRef);
    const directory = inspection.entry;
    return {
      status: "existing",
      identity: { dev: directory.dev, ino: directory.ino }
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return { status: "absent" };
    }
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef);
  }
}

async function assertSafeRecordDirectoryBaseline(
  directoryPath: string,
  expected: SafeRecordDirectoryBaseline,
  evidenceRef: string
): Promise<void> {
  if (expected.status === "absent") {
    try {
      await lstat(directoryPath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return;
      throw publicationStateError(evidenceRef);
    }
    throw publicationStateError(evidenceRef);
  }
  const observed = await captureSafeRecordDirectoryBaseline(directoryPath, evidenceRef);
  if (
    observed.status !== "existing" ||
    !workspaceRecordPhysicalIdentityMatches(observed.identity, expected.identity)
  ) {
    throw publicationStateError(evidenceRef);
  }
}

async function assertRecordDirectoryIdentity(
  directoryPath: string,
  expectedDirectory: OwnedTemporaryRecordIdentity,
  evidenceRef: string
): Promise<void> {
  const observed = await readSafeRecordDirectoryIdentity(directoryPath, evidenceRef);
  if (!workspaceRecordPhysicalIdentityMatches(observed, expectedDirectory)) {
    throw publicationStateError(evidenceRef);
  }
}

async function assertAuthorityNamespaceOwnership(
  ownership: OwnedAuthorityNamespace,
  evidenceRef: string
): Promise<void> {
  await assertRecordDirectoryIdentity(
    ownership.parentPath,
    ownership.parentIdentity,
    evidenceRef
  );
  try {
    const namespace = await lstat(ownership.path, { bigint: true });
    if (
      !namespace.isDirectory() ||
      namespace.isSymbolicLink() ||
      !hasExactPrivatePermissions(namespace.mode, PRIVATE_NAMESPACE_MODE) ||
      !workspaceRecordPhysicalIdentityMatches(namespace, ownership.identity)
    ) {
      throw publicationStateError(evidenceRef);
    }
  } catch (error) {
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef);
  }
}

async function assertAuthorityNamespaceOwnershipIfPresent(
  ownership: OwnedAuthorityNamespace,
  evidenceRef: string
): Promise<boolean> {
  try {
    await lstat(ownership.path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
    throw publicationStateError(evidenceRef);
  }
  await assertAuthorityNamespaceOwnership(ownership, evidenceRef);
  return true;
}

function hardlinkTemporaryNamespaceOwnership(
  ownedResources: HardlinkPublicationOwnedResources,
  namespacePath: string,
  directoryPath: string,
  evidenceRef: string
): OwnedAuthorityNamespace {
  if (!ownedResources.directoryIdentity || !ownedResources.temporaryRecord) {
    throw publicationStateError(evidenceRef);
  }
  return {
    path: namespacePath,
    parentPath: directoryPath,
    parentIdentity: ownedResources.directoryIdentity,
    identity: ownedResources.temporaryRecord.namespaceIdentity
  };
}

async function normalizeOwnedAuthorityNamespaceMode(
  ownership: OwnedAuthorityNamespace,
  evidenceRef: string
): Promise<void> {
  await assertRecordDirectoryIdentity(
    ownership.parentPath,
    ownership.parentIdentity,
    evidenceRef
  );
  try {
    const namespace = await lstat(ownership.path, { bigint: true });
    if (
      !namespace.isDirectory() ||
      namespace.isSymbolicLink() ||
      !workspaceRecordPhysicalIdentityMatches(namespace, ownership.identity)
    ) {
      throw publicationStateError(evidenceRef);
    }
    if (!hasExactPrivatePermissions(namespace.mode, PRIVATE_NAMESPACE_MODE)) {
      await chmod(ownership.path, 0o700);
    }
    await assertAuthorityNamespaceOwnership(ownership, evidenceRef);
  } catch (error) {
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef);
  }
}

async function captureMutableCanonicalBaseline(
  recordPath: string,
  evidenceRef: string
): Promise<MutableCanonicalBaseline> {
  let file: RecordFileHandle | undefined;
  try {
    file = await open(recordPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_SERVICE_RECORD_BYTES)
    ) {
      throw publicationStateError(evidenceRef);
    }
    const { bytes, after } = await readBoundedOpenFile(file, before);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== before.nlink ||
      after.mode !== before.mode ||
      after.size !== before.size ||
      after.ctimeNs !== before.ctimeNs ||
      after.mtimeNs !== before.mtimeNs
    ) {
      throw publicationStateError(evidenceRef);
    }
    return {
      status: "existing",
      identity: { dev: before.dev, ino: before.ino },
      nlink: before.nlink,
      mode: before.mode,
      bytes,
      ctimeNs: before.ctimeNs,
      mtimeNs: before.mtimeNs
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return { status: "absent" };
    }
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef);
  } finally {
    await file?.close();
  }
}

async function captureCanonicalAuthorityBaseline(
  recordPath: string,
  evidenceRef: string
): Promise<CanonicalAuthorityBaseline> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(recordPath, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return { status: "absent" };
    }
    throw publicationStateError(evidenceRef);
  }

  if (
    entry.isFile() &&
    !entry.isSymbolicLink() &&
    entry.nlink === 1n &&
    entry.size <= BigInt(MAX_SERVICE_RECORD_BYTES)
  ) {
    return await captureMutableCanonicalBaseline(recordPath, evidenceRef);
  }
  return {
    status: "invalid",
    identity: { dev: entry.dev, ino: entry.ino },
    mode: entry.mode,
    nlink: entry.nlink,
    size: entry.size,
    ctimeNs: entry.ctimeNs,
    mtimeNs: entry.mtimeNs
  };
}

async function assertCanonicalAuthorityBaseline(
  recordPath: string,
  expected: CanonicalAuthorityBaseline,
  evidenceRef: string
): Promise<void> {
  if (expected.status !== "invalid") {
    await assertMutableCanonicalBaseline(recordPath, expected, evidenceRef);
    return;
  }
  const observed = await captureCanonicalAuthorityBaseline(recordPath, evidenceRef);
  if (
    observed.status !== "invalid" ||
    !workspaceRecordPhysicalIdentityMatches(observed.identity, expected.identity) ||
    observed.mode !== expected.mode ||
    observed.nlink !== expected.nlink ||
    observed.size !== expected.size ||
    (expected.ctimeNs !== undefined && observed.ctimeNs !== expected.ctimeNs) ||
    (expected.mtimeNs !== undefined && observed.mtimeNs !== expected.mtimeNs)
  ) {
    throw publicationStateError(evidenceRef);
  }
}

async function assertMutableCanonicalBaseline(
  recordPath: string,
  expected: MutableCanonicalBaseline,
  evidenceRef: string
): Promise<void> {
  const observed = await captureMutableCanonicalBaseline(recordPath, evidenceRef);
  if (expected.status === "absent") {
    if (observed.status !== "absent") throw publicationStateError(evidenceRef);
    return;
  }
  if (
    observed.status !== "existing" ||
    !workspaceRecordPhysicalIdentityMatches(observed.identity, expected.identity) ||
    observed.nlink !== expected.nlink ||
    observed.mode !== expected.mode ||
    !observed.bytes.equals(expected.bytes) ||
    observed.ctimeNs !== expected.ctimeNs ||
    observed.mtimeNs !== expected.mtimeNs
  ) {
    throw publicationStateError(evidenceRef);
  }
}

async function assertMutableCleanupPathAuthority(
  directoryPath: string,
  expectedDirectory: OwnedTemporaryRecordIdentity,
  namespacePath: string,
  expectedNamespace: OwnedTemporaryRecordIdentity,
  evidenceRef: string
): Promise<void> {
  if (!(await isSafeExistingDirectoryPath(directoryPath))) {
    throw publicationStateError(evidenceRef);
  }

  try {
    const [directory, namespace] = await Promise.all([
      lstat(directoryPath, { bigint: true }),
      lstat(namespacePath, { bigint: true })
    ]);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !workspaceRecordPhysicalIdentityMatches(directory, expectedDirectory) ||
      !namespace.isDirectory() ||
      namespace.isSymbolicLink() ||
      !workspaceRecordPhysicalIdentityMatches(namespace, expectedNamespace)
    ) {
      throw publicationStateError(evidenceRef);
    }
  } catch (error) {
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef);
  }
}

async function assertFinalMutablePublicationAuthority(
  directoryPath: string,
  expectedDirectory: OwnedTemporaryRecordIdentity,
  namespacePath: string,
  expectedNamespace: OwnedTemporaryRecordIdentity,
  temporaryPath: string,
  expectedGeneration: OwnedTemporaryRecordIdentity,
  recordPath: string,
  canonicalBaseline: MutableCanonicalBaseline,
  evidenceRef: string
): Promise<void> {
  await assertMutableCleanupPathAuthority(
    directoryPath,
    expectedDirectory,
    namespacePath,
    expectedNamespace,
    evidenceRef
  );

  try {
    const [namespace, generation] = await Promise.all([
      lstat(namespacePath, { bigint: true }),
      lstat(temporaryPath, { bigint: true })
    ]);
    if (
      !namespace.isDirectory() ||
      namespace.isSymbolicLink() ||
      !hasExactPrivatePermissions(namespace.mode, PRIVATE_NAMESPACE_MODE) ||
      !workspaceRecordPhysicalIdentityMatches(namespace, expectedNamespace) ||
      !generation.isFile() ||
      generation.isSymbolicLink() ||
      generation.nlink !== 1n ||
      !hasExactPrivatePermissions(generation.mode, PRIVATE_GENERATION_MODE) ||
      !workspaceRecordPhysicalIdentityMatches(generation, expectedGeneration)
    ) {
      throw publicationStateError(evidenceRef);
    }
  } catch (error) {
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef);
  }
  await assertMutableCanonicalBaseline(recordPath, canonicalBaseline, evidenceRef);
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
    expectedCleanupGeneration: cleanupPermit
      ? cleanupPermitState.get(cleanupPermit)?.generationExpectation
      : undefined,
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
  generation: OwnedGenerationExpectation,
  expectedBytes: Buffer,
  hooks: WorkspaceRecordPublicationHooks | undefined,
  evidenceRef: string,
  admittedParentPath: string,
  admittedParentIdentity: OwnedTemporaryRecordIdentity
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
    // assertPublishedRecordAuthority returns with this admitted parent proven.
    // No hook or mutation occurs before this descriptor is opened.
    pinnedFile = await open(state.publicPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await pinnedFile.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.mode !== generation.mode ||
      !workspaceRecordPhysicalIdentityMatches(before, generation.identity) ||
      before.size !== BigInt(expectedBytes.length) ||
      before.size > BigInt(MAX_SERVICE_RECORD_BYTES)
    ) {
      throw publicationStateError(evidenceRef);
    }
    await assertRecordDirectoryIdentity(
      admittedParentPath,
      admittedParentIdentity,
      evidenceRef
    );
    const {
      bytes: observedBytes,
      before: beforeRead,
      after
    } = await readBoundedOpenFile(pinnedFile, before);
    if (
      !observedBytes.equals(expectedBytes) ||
      !beforeRead.isFile() ||
      beforeRead.nlink !== 1n ||
      beforeRead.mode !== generation.mode ||
      beforeRead.dev !== before.dev ||
      beforeRead.ino !== before.ino ||
      beforeRead.size !== before.size ||
      !after.isFile() ||
      after.nlink !== 1n ||
      after.mode !== beforeRead.mode ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      throw publicationStateError(evidenceRef);
    }
    state.generation = Object.freeze({
      dev: generation.identity.dev,
      ino: generation.identity.ino
    });
    state.expectedBytes = Buffer.from(expectedBytes);
    state.generationExpectation = {
      identity: { dev: generation.identity.dev, ino: generation.identity.ino },
      bytes: Buffer.from(expectedBytes),
      mode: generation.mode,
      nlink: 1n
    };
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
  const generationExpectation = state.generationExpectation;
  if (
    !pinnedFile ||
    !generation ||
    !expectedBytes ||
    !generationExpectation ||
    state.pinnedFileClosed
  ) {
    throw publicationStateError(evidenceRef);
  }
  try {
    const pinnedIdentity = await pinnedFile.stat({ bigint: true });
    const observedBytes = await readBoundedOpenFile(pinnedFile, pinnedIdentity);
    if (
      !pinnedIdentity.isFile() ||
      pinnedIdentity.nlink !== 1n ||
      pinnedIdentity.size !== BigInt(expectedBytes.length) ||
      pinnedIdentity.mode !== generationExpectation.mode ||
      pinnedIdentity.nlink !== generationExpectation.nlink ||
      !observedBytes.bytes.equals(expectedBytes) ||
      !workspaceRecordPhysicalIdentityMatches(pinnedIdentity, generation) ||
      !(await ownedGenerationStateMatches(
        path,
        generationExpectation,
        generationExpectation.nlink,
        evidenceRef
      ))
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

function publicationStateError(evidenceRef: string, cause?: unknown): TaskServiceError {
  return serviceWorkspaceError(
    "workspace_path_not_safe",
    "Workspace record publication authority could not be verified.",
    "The workspace record could not be published safely.",
    [evidenceRef],
    cause
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
      throw unsafeWorkspaceRecordDirectoryError(evidenceRef);
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
    throw unsafeWorkspaceRecordDirectoryError(evidenceRef, true);
  }
}

function unsafeWorkspaceRecordDirectoryError(
  evidenceRef: string,
  created = false
): TaskServiceError {
  return serviceWorkspaceError(
    "workspace_path_not_safe",
    created ? "Created path is not a safe directory." : "Path is not a safe directory.",
    "A required workspace path is not a safe directory.",
    [evidenceRef]
  );
}

async function isSafeExistingDirectoryPath(path: string): Promise<boolean> {
  return Boolean(await readSafeExistingDirectoryEntry(path));
}

async function readSafeExistingDirectoryEntry(
  path: string
): Promise<BigIntStats | undefined> {
  const inspection = await inspectSafeExistingDirectoryPath(path);
  return inspection.status === "safe" ? inspection.entry : undefined;
}

async function inspectSafeExistingDirectoryPath(
  path: string
): Promise<
  | { status: "safe"; entry: BigIntStats }
  | { status: "missing" }
  | { status: "unsafe" }
> {
  const { rootPath, segments } = getPathParts(path);
  const rootEntry = await inspectDirectoryPathEntry(rootPath);
  if (rootEntry.status !== "safe") return rootEntry;

  let currentPath = rootPath;
  let entry = rootEntry.entry;
  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    const observed = await inspectDirectoryPathEntry(currentPath);
    if (observed.status !== "safe") return observed;
    entry = observed.entry;
  }

  return { status: "safe", entry };
}

function getPathParts(path: string): { rootPath: string; segments: string[] } {
  const resolvedPath = resolve(path);
  const rootPath = parse(resolvedPath).root;
  return {
    rootPath,
    segments: resolvedPath.slice(rootPath.length).split(sep).filter(Boolean)
  };
}

function isSafeDirectoryEntry(entry: FileStat | BigIntStats | undefined): boolean {
  return Boolean(entry?.isDirectory() && !entry.isSymbolicLink());
}

async function inspectDirectoryPathEntry(
  path: string
): Promise<
  | { status: "safe"; entry: BigIntStats }
  | { status: "missing" }
  | { status: "unsafe" }
> {
  try {
    const entry = await lstat(path, { bigint: true });
    return isSafeDirectoryEntry(entry)
      ? { status: "safe", entry }
      : { status: "unsafe" };
  } catch (error) {
    return hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")
      ? { status: "missing" }
      : { status: "unsafe" };
  }
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

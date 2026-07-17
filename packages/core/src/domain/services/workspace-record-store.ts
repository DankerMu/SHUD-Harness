import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  runWithPreservedRelease,
  semanticPrimaryError
} from "./compensation-error-preservation";
import { preserveTaskServiceErrorCompensationCompatibility } from "./task-service-error-compensation";
import {
  BOUNDED_NOFOLLOW_READ_OPEN_FLAGS,
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

function isSafeBaseCompatibleOrdinaryGenerationMode(mode: bigint): boolean {
  const permissions = mode & PRIVATE_PERMISSION_MASK;
  return (
    (permissions & 0o600n) === 0o600n &&
    (permissions & ~0o666n) === 0n
  );
}

type FileStat = Awaited<ReturnType<typeof lstat>>;
type RecordFileHandle = Awaited<ReturnType<typeof open>>;

export interface WorkspaceRecordPhysicalIdentity {
  dev: bigint;
  ino: bigint;
}

interface OwnedTemporaryRecordIdentity extends WorkspaceRecordPhysicalIdentity {}

interface RecordDirectoryPathnameBinding extends OwnedTemporaryRecordIdentity {
  readonly kind: "durable_directory" | "owned_namespace";
  readonly paths: Set<string>;
  ctimeNs: bigint;
  mtimeNs: bigint;
  mutationSequence: number;
  mutationLocked: boolean;
  mutationWaiters: Array<(release: () => void) => void>;
  mutationCapabilities: Map<RecordDirectoryPathnameBinding, () => void>;
  holders: number;
  retirementRequested: boolean;
  terminalOperation?: RecordDirectoryBindingOperationLease;
  state: "active" | "retired";
}

interface RecordDirectoryBindingTimeParentSnapshot {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
}

interface PendingDurableChildCreationCohort {
  readonly parentBinding: RecordDirectoryPathnameBinding;
  readonly childPath: string;
  participants: number;
  childBinding?: RecordDirectoryPathnameBinding;
  childBindingRelease?: () => void;
  state: "active" | "released";
}

interface RecordDirectoryBindingOperationLease {
  readonly bindings: Map<RecordDirectoryPathnameBinding, () => void>;
  readonly bindingsByPath: Map<string, RecordDirectoryPathnameBinding>;
  readonly pendingDurableChildCreationCohorts: Map<
    PendingDurableChildCreationCohort,
    () => void
  >;
  state: "active" | "released";
}

interface PresentFailure {
  readonly value: unknown;
}

interface ExactOwnedPublicLinkRemoval {
  readonly cleanupErrors: unknown[];
  readonly ownership: "removed" | "retained" | "relinquished";
  readonly isolatedSourceCleanupAllowed: boolean;
}

interface RestoredPublicLinkBinding {
  readonly parentBinding: RecordDirectoryPathnameBinding;
  readonly parentCtimeNs: bigint;
  readonly parentMtimeNs: bigint;
  readonly pathnameBinding: CanonicalPathnameBinding;
}

interface CanonicalPathnameBinding {
  readonly identity: OwnedTemporaryRecordIdentity;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
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
  | { readonly status: "callback_failed"; readonly error: unknown }
  | { readonly status: "cancelled" };

interface AuthorityMutatingCallbackCancellation {
  readonly settled: Promise<void>;
  readonly isCancelled: () => boolean;
}

async function captureAuthorityMutatingCallbackBoundary(
  callback: (() => Promise<void> | void) | undefined,
  proveAuthority: () => Promise<void>,
  proofCompensations: readonly unknown[] = [],
  cancellation?: AuthorityMutatingCallbackCancellation
): Promise<AuthorityMutatingCallbackOutcome> {
  if (!callback) {
    if (cancellation?.isCancelled()) return { status: "cancelled" };
    await proveAuthority();
    return { status: "succeeded" };
  }

  const callbackSettlement = (async (): Promise<PresentFailure | undefined> => {
    try {
      await callback();
      return undefined;
    } catch (error) {
      return { value: error };
    }
  })();
  const callbackFailure = cancellation
    ? await Promise.race([
        callbackSettlement,
        cancellation.settled.then(() => undefined)
      ])
    : await callbackSettlement;
  if (cancellation?.isCancelled()) {
    // callbackSettlement always fulfills, so a late resolve/reject is consumed
    // without retaining a proof or waiter-state continuation.
    void callbackSettlement.then(() => undefined);
    return { status: "cancelled" };
  }

  try {
    await proveAuthority();
  } catch (proofError) {
    const preservedProofFailure = preserveWorkspacePrimaryError(
      proofError,
      [
        ...(callbackFailure ? [callbackFailure.value] : []),
        ...proofCompensations
      ]
    );
    if (
      (typeof preservedProofFailure === "object" && preservedProofFailure !== null) ||
      typeof preservedProofFailure === "function"
    ) {
      authorityCallbackProofFailures.add(preservedProofFailure);
    }
    throw preservedProofFailure;
  }

  return callbackFailure
    ? { status: "callback_failed", error: callbackFailure.value }
    : { status: "succeeded" };
}

async function runAuthorityMutatingCallbackBoundary(
  callback: (() => Promise<void> | void) | undefined,
  proveAuthority: () => Promise<void>,
  proofCompensations: readonly unknown[] = [],
  cancellation?: AuthorityMutatingCallbackCancellation
): Promise<void> {
  const outcome = await captureAuthorityMutatingCallbackBoundary(
    callback,
    proveAuthority,
    proofCompensations,
    cancellation
  );
  if (outcome.status === "callback_failed") throw outcome.error;
}

interface OwnedAuthorityNamespace {
  path: string;
  parentPath: string;
  parentIdentity: RecordDirectoryPathnameBinding;
  identity: RecordDirectoryPathnameBinding;
}

interface OwnedGenerationExpectation {
  identity: OwnedTemporaryRecordIdentity;
  bytes: Buffer;
  mode: bigint;
  nlink: bigint;
}

interface OwnedGenerationCheckpoint {
  parentPath: string;
  parentIdentity: RecordDirectoryPathnameBinding;
  namespace?: OwnedAuthorityNamespace;
  path: string;
  generation: OwnedGenerationExpectation;
  pathnameBinding?: CanonicalPathnameBinding;
}

type SafeRecordDirectoryBaseline =
  | { status: "absent" }
  | { status: "existing"; identity: RecordDirectoryPathnameBinding };

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

type CanonicalAuthorityBaselineObservation =
  | CanonicalAuthorityBaseline
  | { status: "generation_drift" };

export function workspaceRecordPhysicalIdentityMatches(
  observed: WorkspaceRecordPhysicalIdentity,
  expected: WorkspaceRecordPhysicalIdentity
): boolean {
  return observed.dev === expected.dev && observed.ino === expected.ino;
}

interface OwnedTemporaryRecord {
  identity: OwnedTemporaryRecordIdentity;
  namespaceIdentity: RecordDirectoryPathnameBinding;
  file: RecordFileHandle;
  handleClosed: boolean;
}

interface OwnedIsolatedGeneration {
  namespacePath: string;
  path: string;
  identity: OwnedTemporaryRecordIdentity;
}

type HardlinkCanonicalPathnameAuthority =
  | { readonly status: "unpublished" }
  | {
      readonly status: "retained";
      readonly binding: CanonicalPathnameBinding;
      readonly expectedLinkCount: bigint;
    }
  | { readonly status: "relinquished" }
  | { readonly status: "removed" };

interface HardlinkPublicationOwnedResources {
  temporaryPath: string;
  canonicalPath: string;
  expectedBytes: Buffer;
  temporaryRecord?: OwnedTemporaryRecord;
  temporaryIdentity?: OwnedTemporaryRecordIdentity;
  temporaryExpectation?: OwnedGenerationExpectation;
  isolatedGeneration?: OwnedIsolatedGeneration;
  canonicalIdentity?: OwnedTemporaryRecordIdentity;
  canonicalPathnameAuthority: HardlinkCanonicalPathnameAuthority;
  handleClosed: boolean;
  compensationErrors: unknown[];
  directoryIdentity?: RecordDirectoryPathnameBinding;
}

type WorkspaceRecordAuthorityOperation = "read" | "hardlink" | "delete" | "rename";

interface RecordAuthorityWaiter {
  resolve: (lease: RecordAuthorityLease) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  status: "active" | "ready" | "finalizing" | "cancelled" | "handed_off";
  deadline: number;
  evidenceRef: string;
  kind: "ordinary" | "cleanup";
  exactPath: string;
  cancellationSettled: Promise<void>;
  cancelPendingWork: () => void;
  contentionRelease?: () => void;
  cleanupPermit?: WorkspaceRecordCleanupPermit;
  expectedCleanupGeneration?: WorkspaceRecordPhysicalIdentity;
  cleanupTerminalAdmission?: WorkspaceRecordCleanupTerminalAdmission;
  cleanupPermitAdmissionFailure?: PresentFailure;
}

interface RecordAuthorityMutex {
  waiters: Set<RecordAuthorityWaiter>;
  aliases: Set<string>;
  sequence: number;
  contentionStartTail: Promise<void>;
  reservations: number;
  cleanupPermits: number;
  outstandingCleanupPermit?: WorkspaceRecordCleanupPermit;
  ownerActive: boolean;
}

interface RecordAuthorityLease {
  expectedCleanupGeneration?: OwnedGenerationExpectation;
  expectedCleanupPathnameBinding?: CanonicalPathnameBinding;
  expectedCleanupParent?: Readonly<{
    path: string;
    identity: RecordDirectoryPathnameBinding;
  }>;
  validateCleanupGeneration?: () => Promise<void>;
  cleanupPermitAdmissionFailure?: PresentFailure;
  release: () => Promise<void>;
  reserveCleanupPermit: (
    publicPath: string,
    evidenceRef: string
  ) => WorkspaceRecordCleanupPermit;
  settleOutstandingCleanupPermit: (
    generation: WorkspaceRecordPhysicalIdentity
  ) => Promise<void>;
}

export interface WorkspaceRecordCleanupPermit {}

export interface WorkspaceRecordTransferredPinnedFile {
  readonly fd: number;
  stat: (options: { bigint: true }) => Promise<BigIntStats>;
  close: () => Promise<void>;
}

export interface WorkspaceRecordTransferredPublicationAuthority {
  readonly pinnedFile: WorkspaceRecordTransferredPinnedFile;
  readonly identity: BigIntStats;
}

interface WorkspaceRecordCleanupPermitState {
  mutex: RecordAuthorityMutex;
  publicPath: string;
  evidenceRef: string;
  parentPath?: string;
  parentIdentity?: RecordDirectoryPathnameBinding;
  bindingTimeParentSnapshot?: RecordDirectoryBindingTimeParentSnapshot;
  parentBindingRelease?: () => void;
  generation?: OwnedTemporaryRecordIdentity;
  generationExpectation?: OwnedGenerationExpectation;
  pathnameBinding?: CanonicalPathnameBinding;
  pinnedFile?: RecordFileHandle;
  pinnedFileClose?: Promise<void>;
  pinnedFileClosed: boolean;
  expectedBytes?: Buffer;
  afterPinnedFileClosed?: (
    input: Readonly<{ path: string; fd: number }>
  ) => Promise<void> | void;
  status: "outstanding" | "claimed" | "settled";
  capacityActive: boolean;
}

const cleanupPermitState = new WeakMap<
  WorkspaceRecordCleanupPermit,
  WorkspaceRecordCleanupPermitState
>();
const workspaceRecordDurableReadErrors = new WeakSet<TaskServiceError>();
const workspaceRecordOversizeErrors = new WeakSet<TaskServiceError>();
const pendingCleanupPermitFileCloses = new Set<Promise<void>>();

export function isWorkspaceRecordDurableReadError(
  error: unknown
): error is TaskServiceError {
  return error instanceof TaskServiceError && workspaceRecordDurableReadErrors.has(error);
}

export function isWorkspaceRecordOversizeError(
  error: unknown
): error is TaskServiceError {
  return error instanceof TaskServiceError && workspaceRecordOversizeErrors.has(error);
}

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
  ) => Promise<void> | void;
  beforePublishedRecordFinalValidation?: (
    input: Readonly<{ path: string }>
  ) => Promise<void> | void;
  beforeCommittedMutableBaselineCapture?: (
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
  rewriteRecordAuthorityIdentityCandidates?: (
    input: Readonly<{
      path: string;
      exactPath: string;
      aliases: readonly string[];
    }>
  ) =>
    | Readonly<{ exactPath: string; aliases: readonly string[] }>
    | undefined;
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
  beforeDurableDirectoryCreation?: (
    input: Readonly<{ path: string; parentPath: string }>
  ) => Promise<void> | void;
  afterDurableDirectoryCreated?: (
    input: Readonly<{ path: string; parentPath: string }>
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

export interface WorkspaceJsonRecordLifecycleInput {
  readonly directoryPath: string;
  readonly recordPath: string;
}

export interface WorkspaceJsonRecordLifecycleCallbacks {
  beforeWrite?: (input: WorkspaceJsonRecordLifecycleInput) => Promise<void> | void;
  afterWrite?: (input: WorkspaceJsonRecordLifecycleInput) => Promise<void> | void;
}

const WORKSPACE_JSON_RECORD_LIFECYCLE_STATE_HANDLE = Symbol(
  "workspace_json_record_lifecycle_state_handle"
);

export interface WorkspaceJsonRecordLifecycleStateHandle {
  readonly [WORKSPACE_JSON_RECORD_LIFECYCLE_STATE_HANDLE]: true;
}

export interface WorkspaceJsonRecordLifecycleStateSnapshot {
  readonly beforeWriteStarted: boolean;
  readonly beforeWriteReturned: boolean;
  readonly afterWriteStarted: boolean;
}

interface MutableWorkspaceJsonRecordLifecycleState {
  beforeWriteStarted: boolean;
  beforeWriteReturned: boolean;
  afterWriteStarted: boolean;
}

interface PreparedJsonRecordWrite<T> {
  readonly data: T;
  readonly directoryPath: string;
  readonly directoryIdentity: RecordDirectoryPathnameBinding;
  readonly fileName: string;
  readonly recordPath: string;
  readonly recordText: string;
}

const WRITER_POST_CLEANUP_EXACT_REBOUND_PROOF = Symbol(
  "writer_post_cleanup_exact_rebound_proof"
);

interface CommittedMutableRecordPublication {
  readonly committedBaseline: Extract<
    MutableCanonicalBaseline,
    { status: "existing" }
  >;
  readonly directoryIdentity: RecordDirectoryPathnameBinding;
  readonly postCleanupExactReboundProof:
    typeof WRITER_POST_CLEANUP_EXACT_REBOUND_PROOF;
  readonly publicationHooksActive: boolean;
  readonly recordPath: string;
}

interface WrittenPreparedJsonRecord<T> {
  readonly data: T;
  readonly publication: CommittedMutableRecordPublication;
  readonly cleanupPermit?: WorkspaceRecordCleanupPermit;
}

type AttemptedPreparedJsonRecordWrite<T> =
  | { readonly status: "written"; readonly written: WrittenPreparedJsonRecord<T> }
  | {
      readonly status: "failed";
      readonly error: unknown;
      readonly committed: boolean;
      readonly cleanupPermit?: WorkspaceRecordCleanupPermit;
    };

interface MutableRecordPublicationCommitState {
  committed: boolean;
  cleanupPermitBound: boolean;
}

export type WorkspaceRecordEntryQuarantineResult =
  | { readonly status: "quarantined" }
  | { readonly status: "missing" };

export type WorkspaceRecordDirectoryRemovalResult =
  | { readonly status: "removed" }
  | { readonly status: "missing" }
  | { readonly status: "not_empty" };

export type WorkspaceRecordCleanupPermitSettlementResult =
  | { readonly status: "current" }
  | { readonly status: "missing" }
  | { readonly status: "superseded" };

export type WorkspaceRecordCleanupPermitSiblingClassification =
  | { readonly status: "current" }
  | { readonly status: "missing" }
  | { readonly status: "superseded"; readonly bytes: Buffer };

export type ExactWorkspaceJsonRecordReplacementResult<T> =
  | { readonly status: "replaced"; readonly record: T }
  | { readonly status: "missing" }
  | { readonly status: "superseded" };

export type ConditionalDeleteObservedJsonRecordResult =
  | ConditionalDeleteJsonRecordResult
  | { readonly status: "superseded" };

const activeRecordAuthorityMutexes = new Map<string, RecordAuthorityMutex>();
const sharedRecordDirectoryPathnameBindings = new Map<
  string,
  Set<RecordDirectoryPathnameBinding>
>();
const pendingDurableChildCreationCohortsByParentBinding = new Map<
  RecordDirectoryPathnameBinding,
  Map<string, PendingDurableChildCreationCohort>
>();
const recordDirectoryBindingOperationStorage =
  new AsyncLocalStorage<RecordDirectoryBindingOperationLease>();
let nextRecordDirectoryPathnameBindingSequence = 1;
let nextRecordAuthorityMutexSequence = 1;
let activeRecordAuthorityReservations = 0;
let activeRecordAuthorityCleanupPermits = 0;
const publicationHookStorage = new AsyncLocalStorage<WorkspaceRecordPublicationHooks>();
const authorityDeadlineStorage = new AsyncLocalStorage<number>();
const committedMutablePublicationCleanupFailures = new WeakSet<object>();
const authorityCallbackProofFailures = new WeakSet<object>();
const authorityNamespaceRemovalProofFailures = new WeakSet<object>();
// The symbol gives callers a nominal type only. Runtime authority comes solely
// from record-store-owned WeakMap membership, which cannot be forged or proxied.
const workspaceJsonRecordLifecycleStates = new WeakMap<
  WorkspaceJsonRecordLifecycleStateHandle,
  MutableWorkspaceJsonRecordLifecycleState
>();

export function createWorkspaceJsonRecordLifecycleStateHandle():
  WorkspaceJsonRecordLifecycleStateHandle {
  const handle = Object.freeze({
    [WORKSPACE_JSON_RECORD_LIFECYCLE_STATE_HANDLE]: true as const
  });
  workspaceJsonRecordLifecycleStates.set(handle, {
    beforeWriteStarted: false,
    beforeWriteReturned: false,
    afterWriteStarted: false
  });
  return handle;
}

export function snapshotWorkspaceJsonRecordLifecycleState(
  handle: WorkspaceJsonRecordLifecycleStateHandle
): WorkspaceJsonRecordLifecycleStateSnapshot {
  const state = workspaceJsonRecordLifecycleStates.get(handle);
  if (!state) {
    throw new TypeError(
      "Workspace JSON record lifecycle state handle is not owned by the record store."
    );
  }
  return Object.freeze({
    beforeWriteStarted: state.beforeWriteStarted,
    beforeWriteReturned: state.beforeWriteReturned,
    afterWriteStarted: state.afterWriteStarted
  });
}

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
  beforeTerminalAuthorityNamespaceRemovalSyscall?: (
    input: Readonly<{ path: string }>
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

const observationOnlyPublicationHookOwners =
  new WeakSet<WorkspaceRecordPublicationHooks>();

/**
 * Root E (V32-09): observation-only projection of the publication hooks. The
 * hooks fire for test observability, but workspaceRecordPublicationHooksActive
 * stays false so production branch selectors (the create-only fast path in
 * persistTaskSnapshot) keep their production branch. Nesting real publication
 * hooks inside an observation context restores active=true. An injected hook
 * error after the canonical commit is intentionally propagated even though
 * the commit succeeded: committed-then-throw is this seam's fail-loud
 * tripwire, not a rollback signal.
 */
export async function runWithWorkspaceRecordObservationHooksForTest<T>(
  hooks: WorkspaceRecordPublicationHooks,
  action: () => Promise<T>
): Promise<T> {
  const observationHooks: WorkspaceRecordPublicationHooks = { ...hooks };
  observationOnlyPublicationHookOwners.add(observationHooks);
  return await publicationHookStorage.run(observationHooks, action);
}

export function workspaceRecordPublicationHooksActive(): boolean {
  const store = publicationHookStorage.getStore();
  return store !== undefined && !observationOnlyPublicationHookOwners.has(store);
}

export async function runWithWorkspaceRecordAuthorityDeadline<T>(
  deadline: number,
  action: () => Promise<T>
): Promise<T> {
  return await authorityDeadlineStorage.run(deadline, action);
}

async function runWithRecordDirectoryBindingOperation<T>(
  action: () => Promise<T>
): Promise<T> {
  const lease: RecordDirectoryBindingOperationLease = {
    bindings: new Map(),
    bindingsByPath: new Map(),
    pendingDurableChildCreationCohorts: new Map(),
    state: "active"
  };
  return await recordDirectoryBindingOperationStorage.run(lease, async () => {
    try {
      return await action();
    } finally {
      const participantReleases = [
        ...lease.pendingDurableChildCreationCohorts.values()
      ];
      lease.pendingDurableChildCreationCohorts.clear();
      for (let index = participantReleases.length - 1; index >= 0; index -= 1) {
        participantReleases[index]!();
      }
      lease.state = "released";
      const releases = [...lease.bindings.values()];
      lease.bindings.clear();
      lease.bindingsByPath.clear();
      for (let index = releases.length - 1; index >= 0; index -= 1) {
        releases[index]!();
      }
    }
  });
}

export function workspaceRecordDirectoryBindingDiagnosticsForTest(): Readonly<{
  registered: number;
  active: number;
  retired: number;
  holders: number;
  mutationLocks: number;
  mutationWaiters: number;
  mutationCapabilities: number;
  pendingCreationCohorts: number;
  pendingCreationParticipants: number;
  pendingCreationBindings: number;
}> {
  let active = 0;
  let retired = 0;
  let holders = 0;
  let mutationLocks = 0;
  let mutationWaiters = 0;
  let mutationCapabilities = 0;
  let pendingCreationCohorts = 0;
  let pendingCreationParticipants = 0;
  let pendingCreationBindings = 0;
  let registered = 0;
  for (const bindings of sharedRecordDirectoryPathnameBindings.values()) {
    for (const binding of bindings) {
      registered += 1;
      if (binding.state === "active") active += 1;
      else retired += 1;
      holders += binding.holders;
      if (binding.mutationLocked) mutationLocks += 1;
      mutationWaiters += binding.mutationWaiters.length;
      mutationCapabilities += binding.mutationCapabilities.size;
    }
  }
  for (const cohorts of pendingDurableChildCreationCohortsByParentBinding.values()) {
    for (const cohort of cohorts.values()) {
      pendingCreationCohorts += 1;
      pendingCreationParticipants += cohort.participants;
      if (cohort.childBinding) pendingCreationBindings += 1;
    }
  }
  return Object.freeze({
    registered,
    active,
    retired,
    holders,
    mutationLocks,
    mutationWaiters,
    mutationCapabilities,
    pendingCreationCohorts,
    pendingCreationParticipants,
    pendingCreationBindings
  });
}

function joinPendingDurableChildCreationCohort(
  parentPath: string,
  parentBinding: RecordDirectoryPathnameBinding,
  childPath: string,
  evidenceRef: string
): PendingDurableChildCreationCohort {
  const operation = recordDirectoryBindingOperationStorage.getStore();
  const resolvedParentPath = resolve(parentPath);
  const resolvedChildPath = resolve(childPath);
  if (
    !operation ||
    operation.state !== "active" ||
    !operation.bindings.has(parentBinding) ||
    operation.bindingsByPath.get(resolvedParentPath) !== parentBinding ||
    parentBinding.kind !== "durable_directory" ||
    parentBinding.state !== "active" ||
    parentBinding.retirementRequested ||
    !recordDirectoryPathnameBindingMatchesPath(resolvedParentPath, parentBinding) ||
    !sharedRecordDirectoryPathnameBindings.get(
      recordDirectoryPhysicalIdentityKey(parentBinding)
    )?.has(parentBinding) ||
    dirname(resolvedChildPath) !== resolvedParentPath
  ) {
    throw publicationStateError(evidenceRef);
  }

  let cohorts = pendingDurableChildCreationCohortsByParentBinding.get(parentBinding);
  if (!cohorts) {
    cohorts = new Map();
    pendingDurableChildCreationCohortsByParentBinding.set(parentBinding, cohorts);
  }
  let cohort = cohorts.get(resolvedChildPath);
  if (!cohort) {
    cohort = {
      parentBinding,
      childPath: resolvedChildPath,
      participants: 0,
      state: "active"
    };
    cohorts.set(resolvedChildPath, cohort);
  }
  if (cohort.state !== "active") throw publicationStateError(evidenceRef);
  if (operation.pendingDurableChildCreationCohorts.has(cohort)) return cohort;

  const joinedCohort = cohort;
  joinedCohort.participants += 1;
  let released = false;
  operation.pendingDurableChildCreationCohorts.set(joinedCohort, () => {
    if (released) return;
    released = true;
    operation.pendingDurableChildCreationCohorts.delete(joinedCohort);
    if (joinedCohort.participants > 0) joinedCohort.participants -= 1;
    if (joinedCohort.participants !== 0) return;

    const liveCohorts = pendingDurableChildCreationCohortsByParentBinding.get(
      joinedCohort.parentBinding
    );
    if (liveCohorts?.get(joinedCohort.childPath) === joinedCohort) {
      liveCohorts.delete(joinedCohort.childPath);
      if (liveCohorts.size === 0) {
        pendingDurableChildCreationCohortsByParentBinding.delete(
          joinedCohort.parentBinding
        );
      }
    }
    joinedCohort.state = "released";
    const releaseChildBinding = joinedCohort.childBindingRelease;
    joinedCohort.childBinding = undefined;
    joinedCohort.childBindingRelease = undefined;
    releaseChildBinding?.();
  });
  return joinedCohort;
}

function operationHasLivePendingDurableChildCreationCohort(
  cohort: PendingDurableChildCreationCohort
): boolean {
  const operation = recordDirectoryBindingOperationStorage.getStore();
  return Boolean(
    operation &&
    operation.state === "active" &&
    operation.pendingDurableChildCreationCohorts.has(cohort) &&
    cohort.state === "active" &&
    cohort.participants > 0 &&
    pendingDurableChildCreationCohortsByParentBinding
      .get(cohort.parentBinding)
      ?.get(cohort.childPath) === cohort
  );
}

function pendingDurableChildCreationCohortBindingAtProof(
  cohort: PendingDurableChildCreationCohort,
  childPath: string,
  observedChild: BigIntStats
): RecordDirectoryPathnameBinding | undefined {
  const binding = cohort.childBinding;
  if (
    !operationHasLivePendingDurableChildCreationCohort(cohort) ||
    !cohort.parentBinding.mutationLocked ||
    cohort.childPath !== resolve(childPath) ||
    !binding ||
    !cohort.childBindingRelease ||
    binding.kind !== "durable_directory" ||
    binding.retirementRequested ||
    !recordDirectoryPathnameBindingMatchesPath(childPath, binding) ||
    !recordDirectoryPathnameBindingMatchesStat(observedChild, binding) ||
    !sharedRecordDirectoryPathnameBindings.get(
      recordDirectoryPhysicalIdentityKey(binding)
    )?.has(binding)
  ) {
    return undefined;
  }
  return binding;
}

function publishPendingDurableChildCreationCohortBinding(
  cohort: PendingDurableChildCreationCohort,
  childPath: string,
  observedChild: BigIntStats,
  binding: RecordDirectoryPathnameBinding,
  evidenceRef: string
): void {
  const operation = recordDirectoryBindingOperationStorage.getStore();
  const resolvedChildPath = resolve(childPath);
  if (
    !operation ||
    !operationHasLivePendingDurableChildCreationCohort(cohort) ||
    !cohort.parentBinding.mutationLocked ||
    cohort.childPath !== resolvedChildPath ||
    cohort.childBinding ||
    cohort.childBindingRelease ||
    !operation.bindings.has(binding) ||
    operation.bindingsByPath.get(resolvedChildPath) !== binding ||
    binding.kind !== "durable_directory" ||
    binding.retirementRequested ||
    !recordDirectoryPathnameBindingMatchesPath(resolvedChildPath, binding) ||
    !recordDirectoryPathnameBindingMatchesStat(observedChild, binding) ||
    !sharedRecordDirectoryPathnameBindings.get(
      recordDirectoryPhysicalIdentityKey(binding)
    )?.has(binding)
  ) {
    throw publicationStateError(evidenceRef);
  }

  const releaseChildBinding = retainRecordDirectoryPathnameBinding(
    binding,
    evidenceRef
  );
  cohort.childBinding = binding;
  cohort.childBindingRelease = releaseChildBinding;
}

export function workspaceRecordDirectoryBindingSequenceForTest(
  identity: WorkspaceRecordPhysicalIdentity
): number | undefined {
  const bindings = sharedRecordDirectoryPathnameBindings.get(
    recordDirectoryPhysicalIdentityKey(identity)
  );
  if (!bindings) return undefined;
  let sequence: number | undefined;
  for (const binding of bindings) {
    if (binding.state !== "active") continue;
    sequence = sequence === undefined
      ? binding.mutationSequence
      : Math.min(sequence, binding.mutationSequence);
  }
  return sequence;
}

export function workspaceRecordAuthorityDiagnosticsForTest(): Readonly<{
  mutexes: number;
  reservations: number;
  cleanupPermits: number;
  pendingPinnedFileCloses: number;
}> {
  return Object.freeze({
    mutexes: new Set(activeRecordAuthorityMutexes.values()).size,
    reservations: activeRecordAuthorityReservations,
    cleanupPermits: activeRecordAuthorityCleanupPermits,
    pendingPinnedFileCloses: pendingCleanupPermitFileCloses.size
  });
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
  return await runWithRecordDirectoryBindingOperation(
    async () =>
      await ensureWorkspaceRecordDirectoryWithBindingOperation(
        workspaceRoot,
        relativeSegments,
        evidenceRef
      )
  );
}

export async function ensureWorkspaceRecordRootPhysicalIdentity(
  workspaceRoot: string,
  evidenceRef: string
): Promise<string> {
  return await runWithRecordDirectoryBindingOperation(async () => {
    const rootPath = await ensureWorkspaceRecordDirectoryWithBindingOperation(
      workspaceRoot,
      [],
      evidenceRef
    );
    const rootBinding = recordDirectoryBindingForCurrentOperation(rootPath);
    if (!rootBinding) throw publicationStateError(evidenceRef);

    let physicalRoot: string;
    try {
      physicalRoot = await realpath(rootPath);
    } catch (error) {
      throw serviceWorkspaceError(
        "workspace_path_not_safe",
        "Workspace root physical identity could not be observed safely.",
        "The workspace root could not be identified safely.",
        [evidenceRef],
        error
      );
    }

    await assertRecordDirectoryIdentity(rootPath, rootBinding, evidenceRef);
    return physicalRoot;
  });
}

export async function ensureWorkspaceDirectoryTree(
  workspaceRoot: string,
  relativeDirectorySegments: readonly (readonly string[])[],
  evidenceRef: string
): Promise<void> {
  await runWithRecordDirectoryBindingOperation(async () => {
    await ensureWorkspaceRecordDirectoryWithBindingOperation(workspaceRoot, [], evidenceRef);
    for (const segments of relativeDirectorySegments) {
      await ensureWorkspaceRecordDirectoryWithBindingOperation(
        workspaceRoot,
        segments,
        evidenceRef
      );
    }
  });
}

export async function runWithExistingWorkspaceRecordDirectoryReproof(
  workspaceRoot: string,
  relativeSegments: readonly string[],
  evidenceRef: string,
  callback: () => unknown
): Promise<boolean> {
  return await runWithRecordDirectoryBindingOperation(async () => {
    const admitted = await admitExistingWorkspaceRecordDirectory(
      workspaceRoot,
      relativeSegments,
      evidenceRef
    );
    if (!admitted) throw unsafeWorkspaceRecordDirectoryError(evidenceRef);

    let value = false;
    let callbackFailure: PresentFailure | undefined;
    try {
      value = Boolean(await callback());
    } catch (error) {
      callbackFailure = { value: error };
    }

    try {
      await assertRecordDirectoryIdentity(admitted.path, admitted.binding, evidenceRef);
    } catch (proofError) {
      throw preserveWorkspacePrimaryError(
        proofError,
        callbackFailure ? [callbackFailure.value] : []
      );
    }
    if (callbackFailure) throw callbackFailure.value;
    return value;
  });
}

const WorkspaceWritableProbeRecordSchema = z
  .object({ nonce: z.string().min(1) })
  .strict();

export async function probeWorkspaceRecordDirectoryWritable(
  workspaceRoot: string,
  evidenceRef: string
): Promise<boolean> {
  return await runWithRecordDirectoryBindingOperation(async () => {
    const admittedRoot = await admitExistingWorkspaceRecordDirectory(
      workspaceRoot,
      [],
      evidenceRef
    );
    if (!admittedRoot) throw unsafeWorkspaceRecordDirectoryError(evidenceRef);

    const nonce = randomUUID();
    const fileName = `health-write-probe-${process.pid}-${nonce}.json`;
    const record = Object.freeze({ nonce });
    const created = await createJsonRecordIfAbsentWithDirectoryBindingOperation(
      workspaceRoot,
      [],
      fileName,
      record,
      evidenceRef,
      WorkspaceWritableProbeRecordSchema,
      true
    );
    if (created.status !== "created" || !("cleanupPermit" in created)) {
      return false;
    }

    const recordPath = workspaceRecordPath(
      workspaceRoot,
      [fileName],
      evidenceRef
    );
    let cleanupPermit: WorkspaceRecordCleanupPermit | undefined = created.cleanupPermit;
    try {
      const claimedPermit = cleanupPermit;
      cleanupPermit = undefined;
      const deleted = await conditionalDeleteJsonRecordWithCleanupPermitAndDirectoryBindingOperation(
        claimedPermit,
        recordPath,
        evidenceRef,
        WorkspaceWritableProbeRecordSchema,
        {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.nonce === expected.nonce
        }
      );
      return deleted.status === "deleted";
    } finally {
      if (cleanupPermit) {
        await cancelRecordAuthorityCleanupPermit(cleanupPermit);
      }
    }
  });
}

async function ensureWorkspaceRecordDirectoryWithBindingOperation(
  workspaceRoot: string,
  relativeSegments: readonly string[],
  evidenceRef: string
): Promise<string> {
  const resolvedRoot = resolve(workspaceRoot);
  let currentBinding: RecordDirectoryPathnameBinding;
  const parentPath = dirname(resolvedRoot);
  if (parentPath === resolvedRoot) {
    const rootInspection = await inspectSafeExistingDirectoryPath(resolvedRoot);
    if (rootInspection.status !== "safe") {
      throw unsafeWorkspaceRecordDirectoryError("workspace");
    }
    const admitted = await admitObservedRecordDirectoryIdentity(
      resolvedRoot,
      rootInspection.entry,
      "workspace"
    );
    if (!admitted) throw unsafeWorkspaceRecordDirectoryError("workspace");
    currentBinding = admitted;
  } else {
    const parentEntry = await readSafeExistingDirectoryEntry(parentPath);
    if (!parentEntry) {
      throw serviceWorkspaceError(
        "workspace_path_not_safe",
        "Parent path is not a safe directory.",
        "A required workspace parent path is not a safe directory.",
        ["workspace:parent"]
      );
    }
    const parentBinding = await admitObservedRecordDirectoryIdentity(
      parentPath,
      parentEntry,
      "workspace:parent"
    );
    if (!parentBinding) throw unsafeWorkspaceRecordDirectoryError("workspace");
    currentBinding = await ensureDurableChildDirectory(
      parentPath,
      parentBinding,
      resolvedRoot,
      "workspace"
    );
  }

  let currentPath = resolvedRoot;
  for (const segment of relativeSegments) {
    const childPath = join(currentPath, segment);
    assertPathInsideWorkspace(resolvedRoot, childPath, evidenceRef);
    currentBinding = await ensureDurableChildDirectory(
      currentPath,
      currentBinding,
      childPath,
      evidenceRef
    );
    currentPath = childPath;
  }

  return currentPath;
}

async function admitExistingWorkspaceRecordDirectory(
  workspaceRoot: string,
  relativeSegments: readonly string[],
  evidenceRef: string
): Promise<
  | {
      readonly path: string;
      readonly binding: RecordDirectoryPathnameBinding;
    }
  | undefined
> {
  const directoryPath = workspaceRecordPath(workspaceRoot, relativeSegments, evidenceRef);
  const inspection = await inspectSafeExistingDirectoryPath(directoryPath);
  if (inspection.status === "missing") return undefined;
  if (inspection.status === "unsafe") {
    throw unsafeWorkspaceRecordDirectoryError(evidenceRef);
  }
  const binding = await admitObservedRecordDirectoryIdentity(
    directoryPath,
    inspection.entry,
    evidenceRef
  );
  if (!binding) throw unsafeWorkspaceRecordDirectoryError(evidenceRef);
  return Object.freeze({ path: directoryPath, binding });
}

async function ensureDurableChildDirectory(
  parentPath: string,
  parentBinding: RecordDirectoryPathnameBinding,
  childPath: string,
  evidenceRef: string
): Promise<RecordDirectoryPathnameBinding> {
  const initialChild = await inspectDirectoryPathEntry(childPath);
  if (initialChild.status === "unsafe") {
    throw unsafeWorkspaceRecordDirectoryError(evidenceRef);
  }
  const pendingCreationCohort = initialChild.status === "missing"
    ? joinPendingDurableChildCreationCohort(
        parentPath,
        parentBinding,
        childPath,
        evidenceRef
      )
    : undefined;
  const initialChildBinding = initialChild.status === "safe"
    ? await admitObservedRecordDirectoryIdentity(
        childPath,
        initialChild.entry,
        evidenceRef
      )
    : undefined;
  if (initialChild.status === "safe" && !initialChildBinding) {
    throw publicationStateError(evidenceRef);
  }
  const hooks = publicationHookStorage.getStore();
  if (initialChild.status === "missing" && hooks?.beforeDurableDirectoryCreation) {
    await runAuthorityMutatingCallbackBoundary(
      () => hooks.beforeDurableDirectoryCreation!(
        Object.freeze({ path: childPath, parentPath })
      ),
      async () => await assertRecordDirectoryIdentity(
        parentPath,
        parentBinding,
        evidenceRef
      )
    );
  }

  const outcome = await runWithRecordDirectoryMutationLocks([parentBinding], async () => {
    await assertRecordDirectoryIdentityNow(parentPath, parentBinding, evidenceRef);
    let settledChild = await readSafeDirectoryLeafEntry(childPath);
    if (initialChild.status === "safe") {
      if (!settledChild) {
        throw publicationStateError(evidenceRef);
      }
      if (
        recordDirectoryPathnameBindingMatchesPath(childPath, initialChildBinding!) &&
        recordDirectoryPathnameBindingMatchesAtProof(settledChild, initialChildBinding!)
      ) {
        return Object.freeze({ binding: initialChildBinding! });
      }
      const findTrustedSettledBinding = () =>
        Array.from(
          sharedRecordDirectoryPathnameBindings.get(
            recordDirectoryPhysicalIdentityKey(settledChild!)
          ) ?? []
        ).find(
          (binding) =>
            binding.kind === "durable_directory" &&
            recordDirectoryPathnameBindingMatchesPath(childPath, binding) &&
            recordDirectoryPathnameBindingMatchesStat(settledChild!, binding)
        );
      let trusted = findTrustedSettledBinding();
      if (!trusted) {
        const inFlight = Array.from(
          sharedRecordDirectoryPathnameBindings.get(
            recordDirectoryPhysicalIdentityKey(settledChild)
          ) ?? []
        ).find(
          (binding) =>
            binding.kind === "durable_directory" &&
            binding.state === "active" &&
            !binding.retirementRequested &&
            binding.mutationLocked &&
            recordDirectoryPathnameBindingMatchesPath(childPath, binding) &&
            workspaceRecordPhysicalIdentityMatches(settledChild!, binding)
        );
        if (inFlight) {
          await runWithRecordDirectoryMutationLocks([inFlight], async () => undefined);
          settledChild = await readSafeDirectoryLeafEntry(childPath);
          if (!settledChild) throw publicationStateError(evidenceRef);
          trusted = findTrustedSettledBinding();
        }
      }
      if (!trusted) throw publicationStateError(evidenceRef);
      retainRecordDirectoryBindingForCurrentOperation(
        trusted,
        evidenceRef,
        childPath,
        true
      );
      return Object.freeze({ binding: trusted });
    }

    if (settledChild) {
      let trusted = pendingCreationCohort
        ? pendingDurableChildCreationCohortBindingAtProof(
            pendingCreationCohort,
            childPath,
            settledChild
          )
        : undefined;
      const inFlightCohortBinding = pendingCreationCohort?.childBinding;
      if (
        !trusted &&
        inFlightCohortBinding &&
        inFlightCohortBinding.state === "active" &&
        !inFlightCohortBinding.retirementRequested &&
        recordDirectoryPathnameBindingMatchesPath(
          childPath,
          inFlightCohortBinding
        ) &&
        workspaceRecordPhysicalIdentityMatches(
          settledChild,
          inFlightCohortBinding
        )
      ) {
        await runWithRecordDirectoryMutationLocks(
          [inFlightCohortBinding],
          async () => undefined
        );
        settledChild = await readSafeDirectoryLeafEntry(childPath);
        if (!settledChild) throw publicationStateError(evidenceRef);
        trusted = pendingDurableChildCreationCohortBindingAtProof(
          pendingCreationCohort!,
          childPath,
          settledChild
        );
      }
      if (!trusted) {
        throw publicationStateError(evidenceRef);
      }
      retainRecordDirectoryBindingForCurrentOperation(
        trusted,
        evidenceRef,
        childPath
      );
      return Object.freeze({ binding: trusted });
    }

    if (
      !pendingCreationCohort ||
      !operationHasLivePendingDurableChildCreationCohort(pendingCreationCohort) ||
      pendingCreationCohort.childBinding ||
      pendingCreationCohort.childBindingRelease
    ) {
      throw publicationStateError(evidenceRef);
    }

    try {
      await mkdir(childPath);
    } catch (error) {
      throw serviceWorkspaceError(
        "workspace_path_not_safe",
        "Failed to create workspace directory.",
        "A required workspace directory could not be created safely.",
        [evidenceRef],
        error
      );
    }

    const [createdChild, observedParent] = await Promise.all([
      readSafeDirectoryLeafEntry(childPath),
      readSafeDirectoryLeafEntry(parentPath)
    ]);
    if (!createdChild) {
      throw unsafeWorkspaceRecordDirectoryError(evidenceRef, true);
    }
    assertRecordDirectoryPathnameEpochCanAdvance(
      observedParent,
      parentBinding,
      evidenceRef
    );
    advanceRecordDirectoryPathnameEpochFromStat(observedParent!, parentBinding);

    const admitted = await admitObservedRecordDirectoryIdentity(
      childPath,
      createdChild,
      evidenceRef,
      "durable_directory",
      false,
      false
    );
    if (!admitted) throw publicationStateError(evidenceRef);
    publishPendingDurableChildCreationCohortBinding(
      pendingCreationCohort,
      childPath,
      createdChild,
      admitted,
      evidenceRef
    );
    retainRecordDirectoryMutationCapability(parentBinding, admitted, evidenceRef);
    return Object.freeze({ binding: admitted, created: true });
  });

  if ("created" in outcome && outcome.created && hooks?.afterDurableDirectoryCreated) {
    await runAuthorityMutatingCallbackBoundary(
      () => hooks.afterDurableDirectoryCreated!(
        Object.freeze({ path: childPath, parentPath })
      ),
      async () => {
        await assertRecordDirectoryIdentity(parentPath, parentBinding, evidenceRef);
        await assertRecordDirectoryIdentity(childPath, outcome.binding, evidenceRef);
      }
    );
  }
  return outcome.binding;
}

export async function readJsonRecord<T>(
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<T | undefined> {
  return await runWithRecordDirectoryBindingOperation(
    async () => await readJsonRecordWithDirectoryBindingOperation(path, evidenceRef, schema)
  );
}

async function readJsonRecordWithDirectoryBindingOperation<T>(
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
    await authorityLease.release();
  }
}

export type WorkspaceJsonRecordCleanupObservation<T> =
  | { readonly status: "missing" }
  | {
      readonly status: "record";
      readonly record: T;
      readonly cleanupPermit: WorkspaceRecordCleanupPermit;
    }
  | {
      readonly status: "malformed";
      readonly error: TaskServiceError;
      readonly cleanupPermit: WorkspaceRecordCleanupPermit;
    }
  | {
      readonly status: "schema_threw";
      readonly error: unknown;
      readonly cleanupPermit: WorkspaceRecordCleanupPermit;
    };

export async function observeJsonRecordForCleanup<T>(
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<WorkspaceJsonRecordCleanupObservation<T>> {
  return await runWithRecordDirectoryBindingOperation(
    async () =>
      await observeJsonRecordForCleanupWithDirectoryBindingOperation(
        path,
        evidenceRef,
        schema
      )
  );
}

async function observeJsonRecordForCleanupWithDirectoryBindingOperation<T>(
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<WorkspaceJsonRecordCleanupObservation<T>> {
  const hooks = publicationHookStorage.getStore();
  const authorityLease = await acquireRecordAuthority(path, evidenceRef, "read", hooks);
  let cleanupPermit: WorkspaceRecordCleanupPermit | undefined;
  let cleanupPermitTransferred = false;
  let inspection: JsonRecordInspection<T> | undefined;
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

    inspection = await inspectJsonRecordUnderAuthority(
      path,
      evidenceRef,
      schema,
      parentBaseline,
      canonicalBaseline
    );
    await assertJsonRecordReadAuthority(
      path,
      inspection.authorityObservation,
      parentBaseline,
      canonicalBaseline,
      evidenceRef
    );
    if (inspection.status === "missing") return { status: "missing" };
    if (parentBaseline.status !== "existing" || canonicalBaseline.status !== "existing") {
      throw publicationStateError(evidenceRef);
    }

    const generation: OwnedGenerationExpectation = {
      identity: Object.freeze({
        dev: inspection.authorityObservation.identity.dev,
        ino: inspection.authorityObservation.identity.ino
      }),
      bytes: Buffer.from(inspection.bytes),
      mode: canonicalBaseline.mode,
      nlink: canonicalBaseline.nlink
    };
    cleanupPermit = reserveRecordAuthorityCleanupPermit(
      authorityLease,
      path,
      evidenceRef
    );
    await bindRecordAuthorityCleanupPermitGeneration(
      cleanupPermit,
      generation,
      inspection.bytes,
      hooks,
      evidenceRef,
      parentPath,
      parentBaseline.identity
    );
    cleanupPermitTransferred = true;

    if (inspection.status === "record") {
      return Object.freeze({
        status: "record",
        record: inspection.record,
        cleanupPermit
      });
    }
    if (inspection.status === "malformed") {
      return Object.freeze({
        status: "malformed",
        error: inspection.error,
        cleanupPermit
      });
    }
    return Object.freeze({
      status: "schema_threw",
      error: inspection.error,
      cleanupPermit
    });
  } catch (error) {
    if (inspection?.status === "malformed" || inspection?.status === "schema_threw") {
      throw preserveWorkspacePrimaryError(error, [inspection.error]);
    }
    throw error;
  } finally {
    if (cleanupPermit && !cleanupPermitTransferred) {
      await cancelRecordAuthorityCleanupPermit(cleanupPermit);
    }
    await authorityLease.release();
  }
}

export async function cancelWorkspaceRecordCleanupPermit(
  permit: WorkspaceRecordCleanupPermit
): Promise<void> {
  const state = cleanupPermitState.get(permit);
  if (
    !state ||
    state.status !== "outstanding" ||
    !state.capacityActive ||
    !state.parentPath ||
    !state.parentIdentity ||
    !state.bindingTimeParentSnapshot ||
    !state.parentBindingRelease ||
    !state.generation ||
    !state.generationExpectation ||
    !state.pathnameBinding ||
    !state.pinnedFile ||
    state.pinnedFileClosed
  ) {
    throw publicationStateError(state?.evidenceRef ?? "workspace_record_cleanup_permit");
  }
  await settleRecordAuthorityCleanupPermitState(permit, state);
}

export async function transferWorkspaceRecordCleanupPermitPublicationAuthority(
  permit: WorkspaceRecordCleanupPermit,
  path: string,
  evidenceRef: string
): Promise<WorkspaceRecordTransferredPublicationAuthority> {
  return await runWithRecordDirectoryBindingOperation(async () => {
  const state = cleanupPermitState.get(permit);
  const expectedBytes = state?.expectedBytes;
  if (
    !state ||
    state.status !== "outstanding" ||
    state.publicPath !== resolve(path) ||
    state.evidenceRef !== evidenceRef ||
    !state.pinnedFile ||
    state.pinnedFileClosed ||
    !expectedBytes
  ) {
    throw publicationStateError(evidenceRef);
  }

  const authorityLease = await acquireRecordAuthorityWithCleanupPermit(
    permit,
    path,
    evidenceRef,
    publicationHookStorage.getStore()
  );
  return await runWithPreservedRelease(
    async () => {
      if (!authorityLease.validateCleanupGeneration) {
        throw publicationStateError(evidenceRef);
      }
      await authorityLease.validateCleanupGeneration();
      const pinnedFile = state.pinnedFile;
      if (!pinnedFile || state.pinnedFileClosed) {
        throw publicationStateError(evidenceRef);
      }
      const identity = await pinnedFile.stat({ bigint: true });
      const observed = await readBoundedOpenFile(pinnedFile, identity);
      await authorityLease.validateCleanupGeneration();
      if (
        !state.generation ||
        !identity.isFile() ||
        !workspaceRecordPhysicalIdentityMatches(identity, state.generation) ||
        identity.size !== BigInt(expectedBytes.length) ||
        !observed.bytes.equals(expectedBytes) ||
        observed.before.dev !== identity.dev ||
        observed.before.ino !== identity.ino ||
        observed.after.dev !== identity.dev ||
        observed.after.ino !== identity.ino ||
        observed.after.size !== identity.size
      ) {
        throw publicationStateError(evidenceRef);
      }

      const closeHook = state.afterPinnedFileClosed;
      const hookInput = Object.freeze({ path: state.publicPath, fd: pinnedFile.fd });
      state.pinnedFile = undefined;
      state.pinnedFileClosed = true;
      state.afterPinnedFileClosed = undefined;
      let closePromise: Promise<void> | undefined;
      const transferred: WorkspaceRecordTransferredPinnedFile = Object.freeze({
        fd: pinnedFile.fd,
        stat: async (options: { bigint: true }) => await pinnedFile.stat(options),
        close: () => {
          if (!closePromise) {
            closePromise = pinnedFile.close().then(
              async () => {
                try {
                  await closeHook?.(hookInput);
                } catch {
                  // Close diagnostics are observation-only.
                }
              },
              async (error) => {
                try {
                  await closeHook?.(hookInput);
                } catch {
                  // Preserve the descriptor-close primary.
                }
                throw error;
              }
            );
          }
          return closePromise;
        }
      });
      return Object.freeze({ pinnedFile: transferred, identity });
    },
    authorityLease.release,
    "Workspace record publication-authority transfer and permit settlement both failed.",
    undefined,
    preserveTaskServiceErrorCompensationCompatibility
  );
  });
}

export async function refreshWorkspaceRecordCleanupPermitAfterSiblingMutation(
  permit: WorkspaceRecordCleanupPermit,
  path: string,
  evidenceRef: string
): Promise<void> {
  const result = await classifyWorkspaceRecordCleanupPermitAfterSiblingMutation(
    permit,
    path,
    evidenceRef
  );
  if (result.status !== "current") throw publicationStateError(evidenceRef);
}

export async function classifyWorkspaceRecordCleanupPermitAfterSiblingMutation(
  permit: WorkspaceRecordCleanupPermit,
  path: string,
  evidenceRef: string
): Promise<WorkspaceRecordCleanupPermitSiblingClassification> {
  const state = cleanupPermitState.get(permit);
  const parentIdentity = state?.parentIdentity;
  const parentPath = state?.parentPath;
  const pinnedFile = state?.pinnedFile;
  const generation = state?.generation;
  const generationExpectation = state?.generationExpectation;
  const expectedPathnameBinding = state?.pathnameBinding;
  const expectedBytes = state?.expectedBytes;
  if (
    !state ||
    state.status !== "outstanding" ||
    state.publicPath !== resolve(path) ||
    state.evidenceRef !== evidenceRef ||
    !state.capacityActive ||
    !parentIdentity ||
    !parentPath ||
    !state.parentBindingRelease ||
    !pinnedFile ||
    state.pinnedFileClosed ||
    !generation ||
    !generationExpectation ||
    !expectedPathnameBinding ||
    !expectedBytes
  ) {
    throw publicationStateError(evidenceRef);
  }

  try {
    await publicationHookStorage.getStore()?.beforeRecordAuthorityIdentitySupplier?.(
      Object.freeze({ path: state.publicPath })
    );
    return await runWithRecordDirectoryMutationLocks([parentIdentity], async () => {
      let beforeParent = await lstat(parentPath, { bigint: true });
      if (
        !beforeParent.isDirectory() ||
        beforeParent.isSymbolicLink() ||
        !workspaceRecordPhysicalIdentityMatches(beforeParent, parentIdentity)
      ) {
        throw publicationStateError(evidenceRef);
      }
      const pinnedIdentity = await pinnedFile.stat({ bigint: true });
      const observed = await readBoundedOpenFile(pinnedFile, pinnedIdentity);
      if (
        !pinnedIdentity.isFile() ||
        !workspaceRecordPhysicalIdentityMatches(pinnedIdentity, generation) ||
        pinnedIdentity.mode !== generationExpectation.mode ||
        (pinnedIdentity.nlink !== generationExpectation.nlink &&
          pinnedIdentity.nlink !== 0n) ||
        observed.before.dev !== pinnedIdentity.dev ||
        observed.before.ino !== pinnedIdentity.ino ||
        observed.after.dev !== pinnedIdentity.dev ||
        observed.after.ino !== pinnedIdentity.ino ||
        observed.after.size !== pinnedIdentity.size
      ) {
        throw publicationStateError(evidenceRef);
      }
      let current!: CanonicalAuthorityBaseline;
      let afterParent!: BigIntStats;
      let stableParentEpoch = false;
      const maxStableParentAttempts = 10;
      for (let attempt = 0; attempt < maxStableParentAttempts; attempt += 1) {
        const candidate = await captureCanonicalAuthorityBaseline(
          state.publicPath,
          evidenceRef,
          true
        );
        afterParent = await lstat(parentPath, { bigint: true });
        if (
          !afterParent.isDirectory() ||
          afterParent.isSymbolicLink() ||
          !workspaceRecordPhysicalIdentityMatches(afterParent, beforeParent)
        ) {
          throw publicationStateError(evidenceRef);
        }
        const parentEpochStable =
          afterParent.ctimeNs === beforeParent.ctimeNs &&
          afterParent.mtimeNs === beforeParent.mtimeNs;
        if (candidate.status !== "generation_drift" && parentEpochStable) {
          current = candidate;
          stableParentEpoch = true;
          break;
        }
        beforeParent = afterParent;
      }
      if (!stableParentEpoch) throw publicationStateError(evidenceRef);
      if (current.status === "invalid") {
        throw publicationStateError(evidenceRef);
      }
      const afterDurableObservation = publicationHookStorage.getStore()
        ?.afterDurableRecordObservation;
      if (afterDurableObservation) {
        await runAuthorityMutatingCallbackBoundary(
          () =>
            afterDurableObservation(
              Object.freeze({
                path: state.publicPath,
                status: current.status === "absent" ? "missing" : "read"
              })
            ),
          async () => {
            const provedParent = await lstat(parentPath, { bigint: true });
            if (
              !provedParent.isDirectory() ||
              provedParent.isSymbolicLink() ||
              !workspaceRecordPhysicalIdentityMatches(provedParent, afterParent) ||
              provedParent.ctimeNs !== afterParent.ctimeNs ||
              provedParent.mtimeNs !== afterParent.mtimeNs
            ) {
              throw publicationStateError(evidenceRef);
            }
            await assertCanonicalAuthorityBaseline(
              state.publicPath,
              current,
              evidenceRef
            );
          }
        );
      }
      const refreshParentBinding = (): void => {
        parentIdentity.ctimeNs = afterParent.ctimeNs;
        parentIdentity.mtimeNs = afterParent.mtimeNs;
        state.bindingTimeParentSnapshot = Object.freeze({
          path: parentPath,
          dev: afterParent.dev,
          ino: afterParent.ino,
          ctimeNs: afterParent.ctimeNs,
          mtimeNs: afterParent.mtimeNs
        });
      };
      if (current.status === "absent") {
        refreshParentBinding();
        return { status: "missing" };
      }
      const samePhysicalGeneration = workspaceRecordPhysicalIdentityMatches(
        current.identity,
        generation
      );
      if (!samePhysicalGeneration) {
        if (!isSafeBaseCompatibleOrdinaryGenerationMode(current.mode)) {
          throw publicationStateError(evidenceRef);
        }
        refreshParentBinding();
        return { status: "superseded", bytes: Buffer.from(current.bytes) };
      }
      if (
        pinnedIdentity.nlink !== generationExpectation.nlink ||
        current.mode !== generationExpectation.mode ||
        current.nlink !== generationExpectation.nlink
      ) {
        throw publicationStateError(evidenceRef);
      }
      if (
        pinnedIdentity.size !== BigInt(expectedBytes.length) ||
        !observed.bytes.equals(expectedBytes) ||
        !current.bytes.equals(expectedBytes) ||
        current.ctimeNs !== expectedPathnameBinding.ctimeNs ||
        current.mtimeNs !== expectedPathnameBinding.mtimeNs
      ) {
        refreshParentBinding();
        return { status: "superseded", bytes: Buffer.from(current.bytes) };
      }
      const refreshedPathnameBinding = await captureCanonicalPathnameBinding(
        state.publicPath,
        generationExpectation,
        generationExpectation.nlink,
        evidenceRef
      );
      refreshParentBinding();
      state.pathnameBinding = refreshedPathnameBinding;
      return { status: "current" };
    });
  } catch (error) {
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef, error);
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
  return await runWithRecordDirectoryBindingOperation(
    async () =>
      await conditionalDeleteJsonRecordWithCleanupPermitAndDirectoryBindingOperation(
        permit,
        path,
        evidenceRef,
        schema,
        condition
      )
  );
}

async function conditionalDeleteJsonRecordWithCleanupPermitAndDirectoryBindingOperation<T>(
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
      const admittedParent = authorityLease.expectedCleanupParent;
      if (!admittedParent || !authorityLease.validateCleanupGeneration) {
        throw publicationStateError(evidenceRef);
      }
      await authorityLease.validateCleanupGeneration();
      if (hooks?.afterAuthorityLeaseAcquired) {
        await runAuthorityMutatingCallbackBoundary(
          () => hooks.afterAuthorityLeaseAcquired!(Object.freeze({ operation: "delete" })),
          authorityLease.validateCleanupGeneration
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
        { status: "existing", identity: admittedParent.identity },
        authorityLease.expectedCleanupPathnameBinding
      );
    } catch (error) {
      throw new WorkspaceRecordConditionalDeleteError(
        mutationState.started ? "post_mutation" : "pre_mutation",
        "operation",
        error
      );
    }
  } finally {
    await authorityLease.release();
  }
}

interface WorkspaceRecordCleanupPermitGenerationSnapshot {
  readonly publicPath: string;
  readonly evidenceRef: string;
  readonly parentIdentity: RecordDirectoryPathnameBinding;
  readonly bindingTimeParentSnapshot: RecordDirectoryBindingTimeParentSnapshot;
  readonly generation: OwnedGenerationExpectation;
  readonly pathnameBinding: CanonicalPathnameBinding;
}

type WorkspaceRecordCleanupPermitGenerationClassification =
  | Extract<
      WorkspaceRecordCleanupPermitSettlementResult,
      { status: "missing" | "superseded" }
    >
  | {
      readonly status: "same_generation";
      readonly proof: "exact_observation" | "published_mutation";
    };

type WorkspaceRecordCleanupGenerationAuthority =
  | "exact_observation"
  | "published_generation";

interface WorkspaceRecordCleanupTerminalAdmission {
  readonly authority: WorkspaceRecordCleanupGenerationAuthority;
  readonly expected: WorkspaceRecordCleanupPermitGenerationSnapshot;
}

class WorkspaceRecordCleanupTerminalResultError extends Error {
  readonly result: Extract<
    WorkspaceRecordCleanupPermitSettlementResult,
    { status: "missing" | "superseded" }
  >;

  constructor(
    result: Extract<
      WorkspaceRecordCleanupPermitSettlementResult,
      { status: "missing" | "superseded" }
    >,
    cause: unknown
  ) {
    super("Workspace record cleanup terminally preserved the current pathname.", {
      cause
    });
    this.name = "WorkspaceRecordCleanupTerminalResultError";
    this.result = result;
  }
}

function recordDirectoryBindingTimeParentSnapshotsMatch(
  current: RecordDirectoryBindingTimeParentSnapshot,
  expected: RecordDirectoryBindingTimeParentSnapshot
): boolean {
  return (
    current.path === expected.path &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.ctimeNs === expected.ctimeNs &&
    current.mtimeNs === expected.mtimeNs
  );
}

function snapshotWorkspaceRecordCleanupPermitGeneration(
  permit: WorkspaceRecordCleanupPermit,
  path: string,
  evidenceRef: string
): WorkspaceRecordCleanupPermitGenerationSnapshot {
  const state = cleanupPermitState.get(permit);
  if (
    !state ||
    state.status !== "outstanding" ||
    !state.capacityActive ||
    state.publicPath !== path ||
    state.evidenceRef !== evidenceRef ||
    !state.parentPath ||
    !state.parentIdentity ||
    !state.bindingTimeParentSnapshot ||
    state.parentPath !== state.bindingTimeParentSnapshot.path ||
    !workspaceRecordPhysicalIdentityMatches(
      state.parentIdentity,
      state.bindingTimeParentSnapshot
    ) ||
    !state.generationExpectation ||
    !state.pathnameBinding
  ) {
    throw publicationStateError(evidenceRef);
  }

  return Object.freeze({
    publicPath: state.publicPath,
    evidenceRef: state.evidenceRef,
    parentIdentity: state.parentIdentity,
    bindingTimeParentSnapshot: Object.freeze({
      path: state.bindingTimeParentSnapshot.path,
      dev: state.bindingTimeParentSnapshot.dev,
      ino: state.bindingTimeParentSnapshot.ino,
      ctimeNs: state.bindingTimeParentSnapshot.ctimeNs,
      mtimeNs: state.bindingTimeParentSnapshot.mtimeNs
    }),
    generation: Object.freeze({
      identity: Object.freeze({
        dev: state.generationExpectation.identity.dev,
        ino: state.generationExpectation.identity.ino
      }),
      bytes: Buffer.from(state.generationExpectation.bytes),
      mode: state.generationExpectation.mode,
      nlink: state.generationExpectation.nlink
    }),
    pathnameBinding: Object.freeze({
      identity: Object.freeze({
        dev: state.pathnameBinding.identity.dev,
        ino: state.pathnameBinding.identity.ino
      }),
      ctimeNs: state.pathnameBinding.ctimeNs,
      mtimeNs: state.pathnameBinding.mtimeNs
    })
  });
}

function workspaceRecordCleanupPermitStateForTerminalOperation(
  permit: WorkspaceRecordCleanupPermit,
  expected: WorkspaceRecordCleanupPermitGenerationSnapshot
): WorkspaceRecordCleanupPermitState {
  const state = cleanupPermitState.get(permit);
  if (
    !state ||
    state.status !== "claimed" ||
    !state.capacityActive ||
    state.publicPath !== expected.publicPath ||
    state.evidenceRef !== expected.evidenceRef ||
    state.parentPath !== expected.bindingTimeParentSnapshot.path ||
    state.parentIdentity !== expected.parentIdentity ||
    !state.bindingTimeParentSnapshot ||
    !recordDirectoryBindingTimeParentSnapshotsMatch(
      state.bindingTimeParentSnapshot,
      expected.bindingTimeParentSnapshot
    ) ||
    !workspaceRecordPhysicalIdentityMatches(
      state.parentIdentity,
      expected.bindingTimeParentSnapshot
    ) ||
    !state.parentBindingRelease ||
    !state.generation ||
    !state.generationExpectation ||
    !state.pathnameBinding ||
    !state.pinnedFile ||
    state.pinnedFileClosed ||
    !workspaceRecordPhysicalIdentityMatches(
      state.generation,
      expected.generation.identity
    ) ||
    !workspaceRecordPhysicalIdentityMatches(
      state.generationExpectation.identity,
      expected.generation.identity
    ) ||
    state.generationExpectation.mode !== expected.generation.mode ||
    state.generationExpectation.nlink !== expected.generation.nlink ||
    !state.generationExpectation.bytes.equals(expected.generation.bytes) ||
    !workspaceRecordPhysicalIdentityMatches(
      state.pathnameBinding.identity,
      expected.pathnameBinding.identity
    ) ||
    state.pathnameBinding.ctimeNs !== expected.pathnameBinding.ctimeNs ||
    state.pathnameBinding.mtimeNs !== expected.pathnameBinding.mtimeNs
  ) {
    throw publicationStateError(expected.evidenceRef);
  }
  return state;
}

function workspaceRecordCleanupSnapshotParentMatchesStat(
  observed: BigIntStats | undefined,
  expected: WorkspaceRecordCleanupPermitGenerationSnapshot
): observed is BigIntStats {
  return Boolean(
    observed &&
    recordDirectoryPathnameBindingMatchesPath(
      expected.bindingTimeParentSnapshot.path,
      expected.parentIdentity
    ) &&
    recordDirectoryPathnameBindingMatchesAtProof(
      observed,
      expected.parentIdentity
    ) &&
    workspaceRecordPhysicalIdentityMatches(
      observed,
      expected.bindingTimeParentSnapshot
    ) &&
    observed.ctimeNs === expected.bindingTimeParentSnapshot.ctimeNs &&
    observed.mtimeNs === expected.bindingTimeParentSnapshot.mtimeNs
  );
}

function openFileStatsMatchCanonicalBaseline(
  observed: BigIntStats,
  current: Extract<CanonicalAuthorityBaseline, { status: "existing" }>,
  expected: WorkspaceRecordCleanupPermitGenerationSnapshot
): boolean {
  return (
    observed.isFile() &&
    observed.mode === expected.generation.mode &&
    observed.nlink === expected.generation.nlink &&
    observed.size === BigInt(current.bytes.length) &&
    observed.ctimeNs === current.ctimeNs &&
    observed.mtimeNs === current.mtimeNs &&
    workspaceRecordPhysicalIdentityMatches(
      observed,
      expected.generation.identity
    ) &&
    workspaceRecordPhysicalIdentityMatches(observed, current.identity)
  );
}

async function classifyWorkspaceRecordCleanupPermitGenerationNow(
  permit: WorkspaceRecordCleanupPermit,
  expected: WorkspaceRecordCleanupPermitGenerationSnapshot,
  authority: WorkspaceRecordCleanupGenerationAuthority
): Promise<WorkspaceRecordCleanupPermitGenerationClassification> {
  const state = workspaceRecordCleanupPermitStateForTerminalOperation(
    permit,
    expected
  );
  const parentPath = expected.bindingTimeParentSnapshot.path;
  const parentBefore = await readSafeDirectoryLeafEntry(parentPath);
  if (!workspaceRecordCleanupSnapshotParentMatchesStat(parentBefore, expected)) {
    return { status: "superseded" };
  }
  let exactObservation = false;
  try {
    await assertCleanupPermitPinnedGenerationNow(
      state,
      expected.publicPath,
      expected.evidenceRef
    );
    exactObservation = true;
  } catch {
    workspaceRecordCleanupPermitStateForTerminalOperation(permit, expected);
  }
  if (exactObservation) {
    const parentAfterExactProof = await readSafeDirectoryLeafEntry(parentPath);
    if (
      !workspaceRecordCleanupSnapshotParentMatchesStat(
        parentAfterExactProof,
        expected
      ) ||
      parentAfterExactProof.ctimeNs !== parentBefore.ctimeNs ||
      parentAfterExactProof.mtimeNs !== parentBefore.mtimeNs
    ) {
      return { status: "superseded" };
    }
    return { status: "same_generation", proof: "exact_observation" };
  }

  const current = await captureCanonicalAuthorityBaseline(
    expected.publicPath,
    expected.evidenceRef
  );
  if (current.status === "absent") return { status: "missing" };
  if (
    !workspaceRecordCleanupSnapshotParentMatchesStat(parentBefore, expected) ||
    !workspaceRecordPhysicalIdentityMatches(
      current.identity,
      expected.generation.identity
    ) ||
    current.status !== "existing" ||
    authority !== "published_generation"
  ) {
    return { status: "superseded" };
  }

  const pinnedFile = state.pinnedFile!;
  const pinnedBefore = await pinnedFile.stat({ bigint: true });
  const parentAfter = await readSafeDirectoryLeafEntry(parentPath);
  const pinnedAfter = await pinnedFile.stat({ bigint: true });
  if (
    !workspaceRecordCleanupSnapshotParentMatchesStat(parentAfter, expected) ||
    parentAfter.ctimeNs !== parentBefore.ctimeNs ||
    parentAfter.mtimeNs !== parentBefore.mtimeNs ||
    !openFileStatsMatchCanonicalBaseline(pinnedBefore, current, expected) ||
    !openFileStatsMatchCanonicalBaseline(pinnedAfter, current, expected) ||
    pinnedAfter.dev !== pinnedBefore.dev ||
    pinnedAfter.ino !== pinnedBefore.ino ||
    pinnedAfter.mode !== pinnedBefore.mode ||
    pinnedAfter.nlink !== pinnedBefore.nlink ||
    pinnedAfter.size !== pinnedBefore.size ||
    pinnedAfter.ctimeNs !== pinnedBefore.ctimeNs ||
    pinnedAfter.mtimeNs !== pinnedBefore.mtimeNs ||
    current.mtimeNs === expected.pathnameBinding.mtimeNs
  ) {
    return { status: "superseded" };
  }
  return { status: "same_generation", proof: "published_mutation" };
}

async function classifyWorkspaceRecordCleanupPermitGeneration(
  permit: WorkspaceRecordCleanupPermit,
  expected: WorkspaceRecordCleanupPermitGenerationSnapshot,
  authority: WorkspaceRecordCleanupGenerationAuthority
): Promise<WorkspaceRecordCleanupPermitGenerationClassification> {
  const state = workspaceRecordCleanupPermitStateForTerminalOperation(
    permit,
    expected
  );
  return await runWithRecordDirectoryMutationLocks(
    [state.parentIdentity!],
    async () =>
      await classifyWorkspaceRecordCleanupPermitGenerationNow(
        permit,
        expected,
        authority
      )
  );
}

async function removeWorkspaceRecordGenerationUnderCleanupPermitAuthority(
  permit: WorkspaceRecordCleanupPermit,
  expected: WorkspaceRecordCleanupPermitGenerationSnapshot,
  authority: WorkspaceRecordCleanupGenerationAuthority
): Promise<Extract<
  ConditionalDeleteObservedJsonRecordResult,
  { status: "deleted" | "missing" | "superseded" }
>> {
  const firstClassification =
    await classifyWorkspaceRecordCleanupPermitGeneration(
      permit,
      expected,
      authority
    );
  if (
    firstClassification.status === "missing" ||
    firstClassification.status === "superseded"
  ) {
    return firstClassification;
  }

  const state = workspaceRecordCleanupPermitStateForTerminalOperation(
    permit,
    expected
  );
  return await runWithRecordDirectoryMutationLocks(
    [state.parentIdentity!],
    async () => {
      const finalClassification =
        await classifyWorkspaceRecordCleanupPermitGenerationNow(
          permit,
          expected,
          authority
        );
      if (
        finalClassification.status === "missing" ||
        finalClassification.status === "superseded"
      ) {
        return finalClassification;
      }
      await unlink(expected.publicPath);
      await advanceRecordDirectoryPathnameEpoch(
        expected.bindingTimeParentSnapshot.path,
        expected.parentIdentity,
        expected.evidenceRef
      );
      return { status: "deleted" as const };
    }
  );
}

export async function conditionalDeleteObservedJsonRecordWithCleanupPermit<T>(
  permit: WorkspaceRecordCleanupPermit,
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>,
  condition: ConditionalDeleteJsonRecordCondition<T>
): Promise<ConditionalDeleteObservedJsonRecordResult> {
  return await conditionalDeleteJsonRecordGenerationWithCleanupPermit(
    permit,
    path,
    evidenceRef,
    schema,
    condition,
    "exact_observation"
  );
}

export async function conditionalDeletePublishedJsonRecordGenerationWithCleanupPermit<T>(
  permit: WorkspaceRecordCleanupPermit,
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>,
  condition: ConditionalDeleteJsonRecordCondition<T>
): Promise<ConditionalDeleteObservedJsonRecordResult> {
  return await conditionalDeleteJsonRecordGenerationWithCleanupPermit(
    permit,
    path,
    evidenceRef,
    schema,
    condition,
    "published_generation"
  );
}

async function conditionalDeleteJsonRecordGenerationWithCleanupPermit<T>(
  permit: WorkspaceRecordCleanupPermit,
  path: string,
  evidenceRef: string,
  schema: z.ZodType<T>,
  condition: ConditionalDeleteJsonRecordCondition<T>,
  authority: WorkspaceRecordCleanupGenerationAuthority
): Promise<ConditionalDeleteObservedJsonRecordResult> {
  return await runWithRecordDirectoryBindingOperation(async () => {
    const expected = snapshotWorkspaceRecordCleanupPermitGeneration(
      permit,
      path,
      evidenceRef
    );
    const hooks = publicationHookStorage.getStore();
    let authorityLease: RecordAuthorityLease;
    try {
      authorityLease = await acquireRecordAuthorityWithCleanupPermit(
        permit,
        path,
        evidenceRef,
        hooks,
        { authority, expected }
      );
    } catch (error) {
      if (error instanceof WorkspaceRecordCleanupTerminalResultError) {
        return error.result;
      }
      throw new WorkspaceRecordConditionalDeleteError(
        "pre_mutation",
        "permit_admission",
        error
      );
    }

    const mutationState = { started: false };
    try {
      const admissionFailure = authorityLease.cleanupPermitAdmissionFailure;
      const classification =
        await classifyWorkspaceRecordCleanupPermitGeneration(
          permit,
          expected,
          authority
        );
      if (
        admissionFailure !== undefined ||
        (classification.status === "same_generation" &&
          classification.proof === "published_mutation")
      ) {
        try {
          return await removeWorkspaceRecordGenerationUnderCleanupPermitAuthority(
            permit,
            expected,
            authority
          );
        } catch (cleanupError) {
          if (admissionFailure === undefined) throw cleanupError;
          throw preserveWorkspacePrimaryError(
            new WorkspaceRecordConditionalDeleteError(
              "pre_mutation",
              "permit_admission",
              admissionFailure.value
            ),
            [cleanupError]
          );
        }
      }
      if (
        classification.status === "missing" ||
        classification.status === "superseded"
      ) {
        return classification;
      }

      try {
        const admittedParent = authorityLease.expectedCleanupParent;
        if (!admittedParent || !authorityLease.validateCleanupGeneration) {
          throw publicationStateError(evidenceRef);
        }
        await authorityLease.validateCleanupGeneration();
        if (hooks?.afterAuthorityLeaseAcquired) {
          await runAuthorityMutatingCallbackBoundary(
            () =>
              hooks.afterAuthorityLeaseAcquired!(
                Object.freeze({ operation: "delete" })
              ),
            authorityLease.validateCleanupGeneration
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
          { status: "existing", identity: admittedParent.identity },
          authorityLease.expectedCleanupPathnameBinding
        );
      } catch (error) {
        throw new WorkspaceRecordConditionalDeleteError(
          mutationState.started ? "post_mutation" : "pre_mutation",
          "operation",
          error
        );
      }
    } finally {
      await authorityLease.release();
    }
  });
}

export async function settleWorkspaceRecordCleanupPermitAfterExactObservation(
  permit: WorkspaceRecordCleanupPermit,
  path: string,
  evidenceRef: string
): Promise<WorkspaceRecordCleanupPermitSettlementResult> {
  return await runWithRecordDirectoryBindingOperation(async () => {
    const expected = snapshotWorkspaceRecordCleanupPermitGeneration(
      permit,
      path,
      evidenceRef
    );
    const hooks = publicationHookStorage.getStore();
    let authorityLease: RecordAuthorityLease;
    try {
      authorityLease = await acquireRecordAuthorityWithCleanupPermit(
        permit,
        path,
        evidenceRef,
        hooks,
        { authority: "published_generation", expected }
      );
    } catch (error) {
      if (error instanceof WorkspaceRecordCleanupTerminalResultError) {
        return error.result;
      }
      throw error;
    }

    const admissionFailure = authorityLease.cleanupPermitAdmissionFailure;
    if (admissionFailure !== undefined) {
      try {
        const removal =
          await removeWorkspaceRecordGenerationUnderCleanupPermitAuthority(
            permit,
            expected,
            "published_generation"
          );
        if (removal.status === "deleted") throw admissionFailure.value;
        return removal;
      } catch (cleanupError) {
        if (cleanupError === admissionFailure.value) throw cleanupError;
        throw preserveWorkspacePrimaryError(admissionFailure.value, [cleanupError]);
      } finally {
        await authorityLease.release();
      }
    }

    let validationFailure: PresentFailure | undefined;
    try {
      if (!authorityLease.validateCleanupGeneration) {
        throw publicationStateError(evidenceRef);
      }
      if (hooks?.afterDurableRecordObservation) {
        await runAuthorityMutatingCallbackBoundary(
          () =>
            hooks.afterDurableRecordObservation!(
              Object.freeze({ path, status: "read" })
            ),
          authorityLease.validateCleanupGeneration
        );
      } else {
        await authorityLease.validateCleanupGeneration();
      }
    } catch (error) {
      validationFailure = { value: error };
    }
    if (!validationFailure) {
      await authorityLease.release();
      return { status: "current" };
    }

    try {
      const classification =
        await classifyWorkspaceRecordCleanupPermitGeneration(
          permit,
          expected,
          "published_generation"
        );
      if (classification.status === "same_generation") {
        const removal =
          await removeWorkspaceRecordGenerationUnderCleanupPermitAuthority(
            permit,
            expected,
            "published_generation"
          );
        if (removal.status === "deleted") throw validationFailure.value;
        return removal;
      }
      return classification;
    } catch (cleanupError) {
      if (cleanupError === validationFailure.value) throw cleanupError;
      throw preserveWorkspacePrimaryError(validationFailure.value, [cleanupError]);
    } finally {
      await authorityLease.release();
    }
  });
}

export async function validateWorkspaceRecordCleanupPermitAfterExactObservation(
  permit: WorkspaceRecordCleanupPermit,
  path: string,
  evidenceRef: string,
  acceptExactObservation: () => Promise<void> | void
): Promise<WorkspaceRecordCleanupPermitSettlementResult> {
  return await runWithPreservedRelease(
    async () =>
      await runWithRecordDirectoryBindingOperation(async () => {
        const expected = snapshotWorkspaceRecordCleanupPermitGeneration(
          permit,
          path,
          evidenceRef
        );
        const hooks = publicationHookStorage.getStore();
        let authorityLease: RecordAuthorityLease;
        try {
          authorityLease = await acquireRecordAuthorityWithCleanupPermit(
            permit,
            path,
            evidenceRef,
            hooks,
            { authority: "exact_observation", expected }
          );
        } catch (error) {
          if (error instanceof WorkspaceRecordCleanupTerminalResultError) {
            return error.result;
          }
          throw error;
        }

        return await runWithPreservedRelease(
          async () => {
            const admissionFailure = authorityLease.cleanupPermitAdmissionFailure;
            if (admissionFailure !== undefined) throw admissionFailure.value;
            const classification = await classifyWorkspaceRecordCleanupPermitGeneration(
              permit,
              expected,
              "exact_observation"
            );
            if (
              classification.status === "missing" ||
              classification.status === "superseded"
            ) {
              return classification;
            }
            if (!authorityLease.validateCleanupGeneration) {
              throw publicationStateError(evidenceRef);
            }
            if (hooks?.afterDurableRecordObservation) {
              await runAuthorityMutatingCallbackBoundary(
                () =>
                  hooks.afterDurableRecordObservation!(
                    Object.freeze({ path, status: "read" })
                  ),
                authorityLease.validateCleanupGeneration
              );
            } else {
              await authorityLease.validateCleanupGeneration();
            }
            await acceptExactObservation();
            return { status: "current" } as const;
          },
          authorityLease.release,
          "Workspace record consumer validation and authority release both failed.",
          undefined,
          preserveTaskServiceErrorCompensationCompatibility
        );
      }),
    async () => await cancelRecordAuthorityCleanupPermit(permit),
    "Workspace record consumer validation and cleanup-permit cancellation both failed.",
    undefined,
    preserveTaskServiceErrorCompensationCompatibility
  );
}

/**
 * Replaces only the exact physical generation captured by a cleanup
 * observation. Publication uses one rename commit, so no delete/create gap is
 * exposed, and a pathname successor is reported without being rewritten.
 */
export async function replaceJsonRecordAfterExactObservation<T>(
  permit: WorkspaceRecordCleanupPermit,
  workspaceRoot: string,
  relativeDirectorySegments: readonly string[],
  fileName: string,
  record: T,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<ExactWorkspaceJsonRecordReplacementResult<T>> {
  const recordPath = workspaceRecordPath(
    workspaceRoot,
    [...relativeDirectorySegments, fileName],
    evidenceRef
  );
  return await runWithPreservedRelease(
    async () =>
      await runWithRecordDirectoryBindingOperation(async () => {
        const expected = snapshotWorkspaceRecordCleanupPermitGeneration(
          permit,
          recordPath,
          evidenceRef
        );
        const hooks = publicationHookStorage.getStore();
        let authorityLease: RecordAuthorityLease;
        try {
          authorityLease = await acquireRecordAuthorityWithCleanupPermit(
            permit,
            recordPath,
            evidenceRef,
            hooks,
            { authority: "exact_observation", expected }
          );
        } catch (error) {
          if (error instanceof WorkspaceRecordCleanupTerminalResultError) {
            return error.result;
          }
          throw error;
        }

        try {
          const admissionFailure = authorityLease.cleanupPermitAdmissionFailure;
          if (admissionFailure !== undefined) throw admissionFailure.value;
          const classification = await classifyWorkspaceRecordCleanupPermitGeneration(
            permit,
            expected,
            "exact_observation"
          );
          if (
            classification.status === "missing" ||
            classification.status === "superseded"
          ) {
            return classification;
          }
          if (
            classification.proof !== "exact_observation" ||
            !authorityLease.validateCleanupGeneration
          ) {
            throw publicationStateError(evidenceRef);
          }
          await authorityLease.validateCleanupGeneration();

          const prepared = await prepareJsonRecordWrite(
            workspaceRoot,
            relativeDirectorySegments,
            fileName,
            record,
            evidenceRef,
            schema
          );
          if (prepared.recordPath !== recordPath) {
            throw publicationStateError(evidenceRef);
          }
          const expectedBaseline: Extract<MutableCanonicalBaseline, { status: "existing" }> = {
            status: "existing",
            identity: expected.generation.identity,
            bytes: Buffer.from(expected.generation.bytes),
            mode: expected.generation.mode,
            nlink: expected.generation.nlink,
            ctimeNs: expected.pathnameBinding.ctimeNs,
            mtimeNs: expected.pathnameBinding.mtimeNs
          };
          const outcome =
            await attemptPreparedJsonRecordWriteWithDirectoryBindingOperation(
              prepared,
              evidenceRef,
              false,
              { authorityLease, canonicalBaseline: expectedBaseline }
            );
          if (outcome.status === "failed") throw outcome.error;
          return Object.freeze({ status: "replaced" as const, record: outcome.written.data });
        } finally {
          await authorityLease.release();
        }
      }),
    async () => await cancelRecordAuthorityCleanupPermit(permit),
    "Exact workspace record replacement and cleanup-permit settlement both failed.",
    undefined,
    preserveTaskServiceErrorCompensationCompatibility
  );
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
  return await runWithRecordDirectoryBindingOperation(
    async () =>
      await conditionalDeleteJsonRecordWithDirectoryBindingOperation(
        path,
        evidenceRef,
        schema,
        condition
      )
  );
}

async function conditionalDeleteJsonRecordWithDirectoryBindingOperation<T>(
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
      await authorityLease.settleOutstandingCleanupPermit(mutationState.deletedGeneration);
    }
    await authorityLease.release();
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
  admittedParentBaseline?: SafeRecordDirectoryBaseline,
  expectedPathnameBinding?: CanonicalPathnameBinding
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
      ? {
          status: "existing",
          ...expectedGeneration,
          ctimeNs: expectedPathnameBinding?.ctimeNs,
          mtimeNs: expectedPathnameBinding?.mtimeNs
        }
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
  if (
    ordinaryCanonicalBaseline?.status === "existing" &&
    !isSafeBaseCompatibleOrdinaryGenerationMode(ordinaryCanonicalBaseline.mode)
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
    generation: generationExpectation,
    pathnameBinding: expectedPathnameBinding ??
      (ordinaryCanonicalBaseline?.status === "existing" &&
      ordinaryCanonicalBaseline.ctimeNs !== undefined &&
      ordinaryCanonicalBaseline.mtimeNs !== undefined
        ? {
            identity: ordinaryCanonicalBaseline.identity,
            ctimeNs: ordinaryCanonicalBaseline.ctimeNs,
            mtimeNs: ordinaryCanonicalBaseline.mtimeNs
          }
        : undefined)
  };
  if (hooks?.beforeConditionalDelete) {
    await runAuthorityMutatingCallbackBoundary(
      () =>
        hooks.beforeConditionalDelete!(
          Object.freeze({
            path,
            conditionStatus: matched ? "matched" : "not_matched"
          })
        ),
      async () => await assertOwnedGenerationCheckpoint(admittedGenerationCheckpoint, evidenceRef)
    );
  }
  if (!matched) {
    return { status: "condition_not_met" };
  }
  const admittedPublicGeneration = generationExpectation;
  const requiresPrivateModeNormalization =
    ordinaryCanonicalBaseline?.status === "existing" &&
    !hasExactPrivatePermissions(ordinaryCanonicalBaseline.mode, PRIVATE_GENERATION_MODE);

  const mutationNamespace = await createAuthorityOwnedMutationNamespace(
    path,
    evidenceRef,
    parentIdentity,
    async () => await assertOwnedGenerationCheckpoint(admittedGenerationCheckpoint, evidenceRef)
  );
  const quarantinePath = join(mutationNamespace.path, "generation");
  const compensationHooks = compensationTestHookStorage.getStore();
  const isolationCheckpoint = {
    ...admittedGenerationCheckpoint,
    namespace: mutationNamespace
  };
  if (hooks?.beforeGenerationIsolation || compensationHooks?.beforeOwnedPathIsolation) {
    // Prove the namespace before exposing it to a callback. The callback
    // boundary below reproves the same complete checkpoint after it settles.
    await assertOwnedGenerationCheckpoint(isolationCheckpoint, evidenceRef);
  } else {
    // The transfer mutation performs the serialized parent+namespace proof at
    // its syscall boundary. Avoid repeating those two pathname stats here;
    // retain the exact generation proof that the transfer itself cannot make.
    await assertOwnedGenerationState(isolationCheckpoint, evidenceRef);
  }
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
    await runOwnedRecordDirectoryTransferMutation(
      parentPath,
      parentIdentity,
      mutationNamespace.path,
      mutationNamespace.identity,
      evidenceRef,
      async () => await rename(path, quarantinePath)
    );
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
  let modeNormalizationCommitted = false;
  try {
    if (requiresPrivateModeNormalization) {
      generationExpectation = await normalizeLegacyIsolatedGenerationMode(
        quarantinePath,
        mutationNamespace,
        admittedPublicGeneration,
        evidenceRef
      );
      modeNormalizationCommitted = true;
    }
    const afterIsolation = compensationTestHookStorage.getStore()?.afterOwnedPathIsolation;
    if (afterIsolation) {
      await runAuthorityMutatingCallbackBoundary(
        () =>
          afterIsolation(
            Object.freeze({
              path,
              isolatedPath: quarantinePath,
              site: "conditional_delete"
            })
          ),
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
    }
    if (
      await ownedGenerationStateMatches(
        quarantinePath,
        generationExpectation,
        generationExpectation.nlink,
        evidenceRef
      )
    ) {
      quarantinedIdentity = generationExpectation.identity;
      if (hooks?.beforeAuthorityOwnedUnlink) {
        await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
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
        await runOwnedRecordDirectoryMutation(
          mutationNamespace.path,
          mutationNamespace.identity,
          evidenceRef,
          async () => await unlink(quarantinePath)
        );
      } else {
        await runOwnedAuthorityNamespaceMutation(
          mutationNamespace,
          evidenceRef,
          async () => await unlink(quarantinePath)
        );
      }
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
      namespaceCleanupAttempted,
      undefined,
      modeNormalizationCommitted ? admittedPublicGeneration : undefined
    );
    const primary = preserveWorkspacePrimaryError(error, compensationErrors);
    let taskServiceCompatible = false;
    try {
      taskServiceCompatible = primary instanceof TaskServiceError;
    } catch {
      taskServiceCompatible = false;
    }
    if (taskServiceCompatible) throw primary;
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

export async function quarantineWorkspaceRecordEntry(
  workspaceRoot: string,
  relativeDirectorySegments: readonly string[],
  fileName: string,
  evidenceRef: string
): Promise<WorkspaceRecordEntryQuarantineResult> {
  return await runWithRecordDirectoryBindingOperation(async () => {
    assertSafeRecordSegment(fileName.replace(/\.json$/, ""), `${evidenceRef}:file`);
    const admittedDirectory = await admitExistingWorkspaceRecordDirectory(
      workspaceRoot,
      relativeDirectorySegments,
      evidenceRef
    );
    if (!admittedDirectory) return { status: "missing" };

    const recordPath = workspaceRecordPath(
      workspaceRoot,
      [...relativeDirectorySegments, fileName],
      evidenceRef
    );
    const hooks = publicationHookStorage.getStore();
    const authorityLease = await acquireRecordAuthority(
      recordPath,
      evidenceRef,
      "rename",
      hooks
    );
    let mutationNamespace: OwnedAuthorityNamespace | undefined;
    let canonicalIsolated = false;
    try {
      const canonicalBaseline = await captureCanonicalAuthorityBaseline(
        recordPath,
        evidenceRef
      );
      if (canonicalBaseline.status === "absent") return { status: "missing" };
      if (hooks?.afterAuthorityLeaseAcquired) {
        await runAuthorityMutatingCallbackBoundary(
          () => hooks.afterAuthorityLeaseAcquired!(Object.freeze({ operation: "rename" })),
          async () => {
            await assertRecordDirectoryIdentity(
              admittedDirectory.path,
              admittedDirectory.binding,
              evidenceRef
            );
            await assertCanonicalAuthorityBaseline(
              recordPath,
              canonicalBaseline,
              evidenceRef
            );
          }
        );
      }

      mutationNamespace = await createAuthorityOwnedMutationNamespace(
        recordPath,
        evidenceRef,
        admittedDirectory.binding,
        async () =>
          await assertCanonicalAuthorityBaseline(
            recordPath,
            canonicalBaseline,
            evidenceRef
          )
      );
      const quarantinePath = join(mutationNamespace.path, "generation");
      try {
        await runOwnedRecordDirectoryTransferMutation(
          admittedDirectory.path,
          admittedDirectory.binding,
          mutationNamespace.path,
          mutationNamespace.identity,
          evidenceRef,
          async () => {
            await assertCanonicalAuthorityBaseline(
              recordPath,
              canonicalBaseline,
              evidenceRef
            );
            await rename(recordPath, quarantinePath);
          }
        );
        canonicalIsolated = true;
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          await removeEmptyAuthorityOwnedMutationNamespace(
            mutationNamespace,
            evidenceRef
          );
          mutationNamespace = undefined;
          return { status: "missing" };
        }
        throw error;
      }

      let quarantinedEntryRemoved = false;
      try {
        const quarantinedBaseline = await captureCanonicalAuthorityBaseline(
          quarantinePath,
          evidenceRef
        );
        if (
          !canonicalAuthorityBaselineGenerationMatches(
            quarantinedBaseline,
            canonicalBaseline
          )
        ) {
          throw publicationStateError(evidenceRef);
        }
        await runOwnedAuthorityNamespaceMutation(
          mutationNamespace,
          evidenceRef,
          async () => {
            await assertCanonicalAuthorityBaseline(
              quarantinePath,
              quarantinedBaseline,
              evidenceRef
            );
            const entry = await lstat(quarantinePath, { bigint: true });
            if (entry.isDirectory() && !entry.isSymbolicLink()) {
              await rmdir(quarantinePath);
            } else {
              await unlink(quarantinePath);
            }
          }
        );
        quarantinedEntryRemoved = true;
      } catch {
        // Keep non-empty or externally changed content isolated in the private namespace.
      }
      if (quarantinedEntryRemoved) {
        try {
          await removeEmptyAuthorityOwnedMutationNamespace(
            mutationNamespace,
            evidenceRef
          );
          mutationNamespace = undefined;
        } catch {
          // The canonical entry is already isolated; retain any private cleanup residue.
        }
      }
      return { status: "quarantined" };
    } finally {
      if (mutationNamespace && !canonicalIsolated) {
        await removeEmptyAuthorityOwnedMutationNamespace(
          mutationNamespace,
          evidenceRef
        ).catch(() => undefined);
      }
      await authorityLease.release();
    }
  });
}

function canonicalAuthorityBaselineGenerationMatches(
  observed: CanonicalAuthorityBaseline,
  expected: Exclude<CanonicalAuthorityBaseline, { status: "absent" }>
): boolean {
  if (observed.status === "absent" || observed.status !== expected.status) return false;
  if (
    !workspaceRecordPhysicalIdentityMatches(observed.identity, expected.identity) ||
    observed.mode !== expected.mode ||
    observed.nlink !== expected.nlink
  ) {
    return false;
  }
  if (observed.status === "existing" && expected.status === "existing") {
    return observed.bytes.equals(expected.bytes);
  }
  return observed.status === "invalid" &&
    expected.status === "invalid" &&
    observed.size === expected.size;
}

export async function removeWorkspaceRecordDirectoryIfEmpty(
  workspaceRoot: string,
  relativeSegments: readonly string[],
  evidenceRef: string
): Promise<WorkspaceRecordDirectoryRemovalResult> {
  return await runWithRecordDirectoryBindingOperation(async () => {
    if (relativeSegments.length === 0) throw publicationStateError(evidenceRef);
    const admittedDirectory = await admitExistingWorkspaceRecordDirectory(
      workspaceRoot,
      relativeSegments,
      evidenceRef
    );
    if (!admittedDirectory) return { status: "missing" };

    const parentPath = dirname(admittedDirectory.path);
    const parentEntry = await readSafeExistingDirectoryEntry(parentPath);
    if (!parentEntry) throw unsafeWorkspaceRecordDirectoryError(evidenceRef);
    const parentBinding = await admitObservedRecordDirectoryIdentity(
      parentPath,
      parentEntry,
      evidenceRef
    );
    if (!parentBinding) throw unsafeWorkspaceRecordDirectoryError(evidenceRef);

    return await runWithRecordDirectoryMutationLocks(
      [parentBinding, admittedDirectory.binding],
      async () => {
        await assertRecordDirectoryIdentityNow(
          parentPath,
          parentBinding,
          evidenceRef
        );
        await assertRecordDirectoryIdentityNow(
          admittedDirectory.path,
          admittedDirectory.binding,
          evidenceRef
        );
        try {
          await rmdir(admittedDirectory.path);
        } catch (error) {
          if (hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EEXIST")) {
            return { status: "not_empty" };
          }
          throw error;
        }
        try {
          await advanceRecordDirectoryPathnameEpoch(
            parentPath,
            parentBinding,
            evidenceRef
          );
        } finally {
          retireRecordDirectoryPathnameBinding(admittedDirectory.binding);
        }
        return { status: "removed" };
      }
    );
  });
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
      evidenceRef,
      checkpoint.pathnameBinding
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
  if (afterDurableObservation) {
    const callbackOutcome = await captureAuthorityMutatingCallbackBoundary(
      () => afterDurableObservation(Object.freeze({ path, status: durableRead.status })),
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
    if (callbackOutcome.status === "callback_failed") {
      if (durableFailure) {
        throw preserveWorkspacePrimaryError(durableFailure, [callbackOutcome.error]);
      }
      throw callbackOutcome.error;
    }
  }
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

  let normalizedRecord: T;
  try {
    normalizedRecord = reconstructInertJsonRecord(
      serializeJsonRecord(parsedRecord.data, evidenceRef)
    );
  } catch (normalizationError) {
    return {
      status: "schema_threw",
      error: normalizationError,
      bytes: durableRead.bytes,
      authorityObservation: durableRead
    };
  }

  return {
    status: "record",
    record: normalizedRecord,
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
  admittedParentIdentity?: RecordDirectoryPathnameBinding,
  proveCallerAuthority?: () => Promise<void>
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
      async () => {
        await assertRecordDirectoryIdentity(parentPath, parentIdentity, evidenceRef);
        await proveCallerAuthority?.();
      }
    );
  }
  // createPrivateAuthorityNamespaceAt performs the serialized parent proof
  // immediately before mkdir. With no callback there is no intervening
  // authority boundary, so another proof here would duplicate it.
  const identity = await createPrivateAuthorityNamespaceAt(
    namespacePath,
    parentPath,
    parentIdentity,
    evidenceRef
  );
  return { path: namespacePath, parentPath, parentIdentity, identity };
}

async function createPrivateAuthorityNamespaceAt(
  namespacePath: string,
  parentPath: string,
  parentIdentity: RecordDirectoryPathnameBinding,
  evidenceRef: string
): Promise<RecordDirectoryPathnameBinding> {
  try {
    const entry = await runWithRecordDirectoryMutationLocks(
      [parentIdentity],
      async () => {
        await assertRecordDirectoryIdentityNow(
          parentPath,
          parentIdentity,
          evidenceRef
        );
        await mkdir(namespacePath, { mode: 0o700 });
        const childObservation = lstat(namespacePath, { bigint: true }).then(
          (observed) => ({ status: "observed" as const, observed }),
          (error: unknown) => ({ status: "failed" as const, error })
        );
        const [observedParent, observedChild] = await Promise.all([
          readSafeExistingDirectoryEntry(parentPath),
          childObservation
        ]);
        assertRecordDirectoryPathnameEpochCanAdvance(
          observedParent,
          parentIdentity,
          evidenceRef
        );
        advanceRecordDirectoryPathnameEpochFromStat(
          observedParent!,
          parentIdentity
        );
        if (observedChild.status === "failed") throw observedChild.error;
        return observedChild.observed;
      }
    );
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !hasExactPrivatePermissions(entry.mode, PRIVATE_NAMESPACE_MODE)
    ) {
      await runOwnedRecordDirectoryMutation(
        parentPath,
        parentIdentity,
        evidenceRef,
        async () => await rmdir(namespacePath)
      );
      throw publicationStateError(evidenceRef);
    }
    const identity = await admitObservedRecordDirectoryIdentity(
      namespacePath,
      entry,
      evidenceRef,
      "owned_namespace",
      false,
      false
    );
    if (!identity) throw publicationStateError(evidenceRef);
    return identity;
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
  invokeHooks = true,
  proveCallerAuthority?: () => Promise<void>
): Promise<readonly unknown[]> {
  if (!invokeHooks) {
    ownership = await rebindExactOwnedAuthorityNamespaceForPrivateFinalization(
      ownership,
      evidenceRef
    );
  }
  let primaryFailure: PresentFailure | undefined;
  const compensationErrors: unknown[] = [];
  let hookFailureObserved = false;
  let hookAuthorityProofFailureObserved = false;
  let namespaceOwnershipProofFailureObserved = false;
  for (let attempt = 1; attempt <= RECORD_NAMESPACE_CLEANUP_ATTEMPTS; attempt += 1) {
    if (invokeHooks) {
      const beforeRemoval = publicationHookStorage.getStore()?.beforeAuthorityNamespaceRemoval;
      if (beforeRemoval) {
        try {
          await runAuthorityMutatingCallbackBoundary(
            () => beforeRemoval(Object.freeze({ path: ownership.path, attempt })),
            async () => {
              await assertAuthorityNamespaceOwnership(ownership, evidenceRef);
              await proveCallerAuthority?.();
            }
          );
        } catch (error) {
          hookFailureObserved = true;
          if (
            ((typeof error === "object" && error !== null) || typeof error === "function") &&
            authorityCallbackProofFailures.has(error)
          ) {
            hookAuthorityProofFailureObserved = true;
          }
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
    }
    try {
      await removeExactEmptyAuthorityOwnedMutationNamespace(
        ownership,
        evidenceRef
      );
      return primaryFailure
        ? [primaryFailure.value, ...compensationErrors]
        : [];
    } catch (error) {
      if (
        ((typeof error === "object" && error !== null) || typeof error === "function") &&
        authorityNamespaceRemovalProofFailures.has(error)
      ) {
        namespaceOwnershipProofFailureObserved = true;
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

  if (invokeHooks && hookFailureObserved) {
    try {
      const terminalOwnership = hookAuthorityProofFailureObserved
        ? await rebindExactOwnedAuthorityNamespaceForPrivateFinalization(
            ownership,
            evidenceRef
          )
        : ownership;
      await assertEmptyAuthorityOwnedMutationNamespace(terminalOwnership, evidenceRef);
      await compensationTestHookStorage.getStore()
        ?.beforeTerminalAuthorityNamespaceRemovalSyscall?.(
          Object.freeze({ path: terminalOwnership.path })
        );
      await removeExactEmptyAuthorityOwnedMutationNamespace(
        terminalOwnership,
        evidenceRef,
        false
      );
      if (!hookAuthorityProofFailureObserved) {
        return [primaryFailure!.value, ...compensationErrors];
      }
    } catch (error) {
      primaryFailure = appendSequentialFailure(
        primaryFailure,
        compensationErrors,
        error
      );
    }
  }

  if (!hookFailureObserved && namespaceOwnershipProofFailureObserved) {
    try {
      const terminalOwnership =
        await rebindExactOwnedAuthorityNamespaceForPrivateFinalization(
          ownership,
          evidenceRef
        );
      await assertEmptyAuthorityOwnedMutationNamespace(terminalOwnership, evidenceRef);
      await removeExactEmptyAuthorityOwnedMutationNamespace(
        terminalOwnership,
        evidenceRef,
        false
      );
      return primaryFailure
        ? [primaryFailure.value, ...compensationErrors]
        : [];
    } catch (error) {
      primaryFailure = appendSequentialFailure(
        primaryFailure,
        compensationErrors,
        error
      );
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

async function assertEmptyAuthorityOwnedMutationNamespace(
  ownership: OwnedAuthorityNamespace,
  evidenceRef: string
): Promise<void> {
  await runWithRecordDirectoryMutationLocks(
    [ownership.parentIdentity, ownership.identity],
    async () => {
      await assertAuthorityNamespaceOwnershipNow(ownership, evidenceRef);
      let entries: string[];
      try {
        entries = await readdir(ownership.path);
      } catch (error) {
        throw publicationStateError(evidenceRef, error);
      }
      if (entries.length !== 0) throw publicationStateError(evidenceRef);
      await assertAuthorityNamespaceOwnershipNow(ownership, evidenceRef);
    }
  );
}

export async function publishJsonRecordWithLifecycleCallbacks<T>(
  workspaceRoot: string,
  relativeDirectorySegments: readonly string[],
  fileName: string,
  record: T,
  evidenceRef: string,
  schema: z.ZodType<T>,
  callbacks: WorkspaceJsonRecordLifecycleCallbacks = {},
  lifecycleStateHandle?: WorkspaceJsonRecordLifecycleStateHandle
): Promise<T> {
  const beforeWrite = callbacks.beforeWrite;
  const afterWrite = callbacks.afterWrite;
  // Root E (V33-17): derived from the marked-aware selector so the
  // observation seam cannot flip exactGenerationPermitRequired — observation
  // hooks observe, they never select a different write mode.
  const publicationHooksEntryActive = workspaceRecordPublicationHooksActive();
  const lifecycleState = lifecycleStateHandle
    ? workspaceJsonRecordLifecycleStates.get(lifecycleStateHandle)
    : undefined;
  if (lifecycleStateHandle && !lifecycleState) {
    throw publicationStateError(evidenceRef);
  }

  let directoryPath: string | undefined;
  let cleanupPermit: WorkspaceRecordCleanupPermit | undefined;
  let operationFailure: PresentFailure | undefined;
  const lifecycleCallbackBoundaryObserved =
    beforeWrite !== undefined || afterWrite !== undefined;
  const exactGenerationPermitRequired =
    lifecycleCallbackBoundaryObserved || publicationHooksEntryActive;
  try {
    return await runWithRecordDirectoryBindingOperation(async () => {
      const prepared = await prepareJsonRecordWrite(
        workspaceRoot,
        relativeDirectorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      );
      directoryPath = prepared.directoryPath;
      const directoryBinding = recordDirectoryBindingForCurrentOperation(directoryPath);
      if (!directoryBinding) throw publicationStateError(evidenceRef);
      const lifecycleInput = Object.freeze({
        directoryPath,
        recordPath: prepared.recordPath
      });

      if (lifecycleState) lifecycleState.beforeWriteStarted = true;
      if (beforeWrite) {
        await runAuthorityMutatingCallbackBoundary(
          async () => {
            await beforeWrite(lifecycleInput);
            if (lifecycleState) lifecycleState.beforeWriteReturned = true;
          },
          async () =>
            await assertRecordDirectoryIdentity(
              directoryPath!,
              directoryBinding,
              evidenceRef
            )
        );
      } else if (lifecycleState) {
        lifecycleState.beforeWriteReturned = true;
      }

      const writeOutcome = await attemptPreparedJsonRecordWriteWithDirectoryBindingOperation(
        prepared,
        evidenceRef,
        exactGenerationPermitRequired
      );
      if (writeOutcome.status === "failed") {
        cleanupPermit = writeOutcome.cleanupPermit;
        throw writeOutcome.error;
      }
      const written = writeOutcome.written;
      cleanupPermit = written.cleanupPermit;

      if (lifecycleState) lifecycleState.afterWriteStarted = true;
      if (afterWrite) {
        await afterWrite(lifecycleInput);
      }
      const publication = written.publication;
      const writerProofIsTerminal =
        !exactGenerationPermitRequired &&
        beforeWrite === undefined &&
        afterWrite === undefined &&
        !publicationHooksEntryActive &&
        !publication.publicationHooksActive &&
        publication.postCleanupExactReboundProof ===
          WRITER_POST_CLEANUP_EXACT_REBOUND_PROOF &&
        publication.directoryIdentity === prepared.directoryIdentity &&
        publication.recordPath === prepared.recordPath;
      if (cleanupPermit) {
        const permit = cleanupPermit;
        cleanupPermit = undefined;
        const settlement = await settleWorkspaceRecordCleanupPermitAfterExactObservation(
          permit,
          prepared.recordPath,
          evidenceRef
        );
        if (settlement.status !== "current") throw publicationStateError(evidenceRef);
      } else if (!writerProofIsTerminal) {
        throw publicationStateError(evidenceRef);
      }
      return written.data;
    });
  } catch (error) {
    operationFailure = { value: error };
  }

  const compensationErrors: unknown[] = [];
  if (cleanupPermit) {
    const permit = cleanupPermit;
    cleanupPermit = undefined;
    try {
      await conditionalDeletePublishedJsonRecordGenerationWithCleanupPermit(
        permit,
        workspaceRecordPath(
          workspaceRoot,
          [...relativeDirectorySegments, fileName],
          evidenceRef
        ),
        evidenceRef,
        schema,
        { kind: "record", expected: record, matches: () => true }
      );
    } catch (error) {
      compensationErrors.push(error);
    }
  }
  if (directoryPath) {
    try {
      await removeWorkspaceRecordDirectoryIfEmpty(
        workspaceRoot,
        relativeDirectorySegments,
        evidenceRef
      );
    } catch (error) {
      compensationErrors.push(error);
    }
  }
  throw preserveWorkspacePrimaryError(operationFailure!.value, compensationErrors);
}

async function assertExactWorkspaceRecordBytesWithDirectoryBindingOperation(
  recordPath: string,
  expectedBytes: Buffer,
  expectedDirectory: RecordDirectoryPathnameBinding,
  expectedRecord: Extract<MutableCanonicalBaseline, { status: "existing" }>,
  evidenceRef: string
): Promise<void> {
  const hooks = publicationHookStorage.getStore();
  const authorityLease = await acquireRecordAuthority(
    recordPath,
    evidenceRef,
    "read",
    hooks
  );
  try {
    const parentPath = dirname(recordPath);
    const parentBaseline = await captureSafeRecordDirectoryBaseline(parentPath, evidenceRef);
    if (
      parentBaseline.status !== "existing" ||
      parentBaseline.identity !== expectedDirectory
    ) {
      throw publicationStateError(evidenceRef);
    }
    const inspection = await inspectJsonRecordUnderAuthority(
      recordPath,
      evidenceRef,
      z.unknown(),
      parentBaseline,
      expectedRecord
    );
    if (
      inspection.status !== "record" ||
      !inspection.bytes.equals(expectedBytes)
    ) {
      throw publicationStateError(evidenceRef);
    }
    await assertDurableReadMatchesCanonicalBaseline(
      recordPath,
      inspection.authorityObservation,
      expectedRecord,
      evidenceRef
    );
    if (
      expectedRecord.ctimeNs === undefined ||
      expectedRecord.mtimeNs === undefined ||
      inspection.authorityObservation.mutation.ctimeNs !== expectedRecord.ctimeNs ||
      inspection.authorityObservation.mutation.mtimeNs !== expectedRecord.mtimeNs
    ) {
      throw publicationStateError(evidenceRef);
    }
  } finally {
    await authorityLease.release();
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
  return await runWithRecordDirectoryBindingOperation(
    async () =>
      await writeJsonRecordWithDirectoryBindingOperation(
        workspaceRoot,
        relativeDirectorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      )
  );
}

async function writeJsonRecordWithDirectoryBindingOperation<T>(
  workspaceRoot: string,
  relativeDirectorySegments: readonly string[],
  fileName: string,
  record: T,
  evidenceRef: string,
  schema: z.ZodType<T>
): Promise<T> {
  const prepared = await prepareJsonRecordWrite(
    workspaceRoot,
    relativeDirectorySegments,
    fileName,
    record,
    evidenceRef,
    schema
  );
  const written = await writePreparedJsonRecordWithDirectoryBindingOperation(
    prepared,
    evidenceRef
  );
  return written.data;
}

async function writePreparedJsonRecordWithDirectoryBindingOperation<T>(
  prepared: PreparedJsonRecordWrite<T>,
  evidenceRef: string
): Promise<WrittenPreparedJsonRecord<T>> {
  const outcome = await attemptPreparedJsonRecordWriteWithDirectoryBindingOperation(
    prepared,
    evidenceRef,
    false
  );
  if (outcome.status === "failed") throw outcome.error;
  return outcome.written;
}

async function attemptPreparedJsonRecordWriteWithDirectoryBindingOperation<T>(
  prepared: PreparedJsonRecordWrite<T>,
  evidenceRef: string,
  reserveCleanupPermit: boolean,
  exactReplacement?: Readonly<{
    authorityLease: RecordAuthorityLease;
    canonicalBaseline: Extract<MutableCanonicalBaseline, { status: "existing" }>;
  }>
): Promise<AttemptedPreparedJsonRecordWrite<T>> {
  const {
    data,
    directoryPath,
    directoryIdentity,
    fileName,
    recordPath,
    recordText
  } = prepared;

  const producerNamespacePath = join(
    directoryPath,
    `.${fileName}-${process.pid}-${randomUUID()}.authority`
  );
  const temporaryPath = join(producerNamespacePath, "generation");
  const expectedBytes = Buffer.from(recordText, "utf8");
  const hooks = publicationHookStorage.getStore();
  let authorityLease: RecordAuthorityLease | undefined;
  let temporaryRecord: OwnedTemporaryRecord | undefined;
  let recordDirectoryIdentity: RecordDirectoryPathnameBinding | undefined;
  let canonicalBaseline: MutableCanonicalBaseline | undefined;
  let committedPublication: CommittedMutableRecordPublication | undefined;
  let committed = false;
  let operationFailure: PresentFailure | undefined;
  const compensationErrors: unknown[] = [];
  let cleanupPermit: WorkspaceRecordCleanupPermit | undefined;
  let cleanupPermitOwnership: "none" | "owned" | "transferred" = "none";
  const commitState: MutableRecordPublicationCommitState = {
    committed: false,
    cleanupPermitBound: false
  };
  try {
    try {
      authorityLease = exactReplacement?.authorityLease ??
        await acquireRecordAuthority(recordPath, evidenceRef, "rename", hooks);
      if (reserveCleanupPermit) {
        cleanupPermit = reserveRecordAuthorityCleanupPermit(
          authorityLease,
          recordPath,
          evidenceRef
        );
        cleanupPermitOwnership = "owned";
      }
      recordDirectoryIdentity =
        hooks?.beforeRecordAuthorityIdentitySupplier || hooks?.onAuthorityContention
          ? await readSafeRecordDirectoryIdentity(directoryPath, evidenceRef)
          : directoryIdentity;
      canonicalBaseline = exactReplacement?.canonicalBaseline ??
        await captureMutableCanonicalBaseline(recordPath, evidenceRef);
      if (hooks?.afterAuthorityLeaseAcquired) {
        await runAuthorityMutatingCallbackBoundary(
          () => hooks.afterAuthorityLeaseAcquired!(Object.freeze({ operation: "rename" })),
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
      committedPublication = await publishOwnedMutableRecord(
        temporaryPath,
        temporaryRecord,
        recordPath,
        expectedBytes,
        directoryPath,
        recordDirectoryIdentity,
        canonicalBaseline,
        evidenceRef,
        hooks,
        cleanupPermit,
        commitState
      );
      committed = true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        committedMutablePublicationCleanupFailures.has(error)
      ) {
        committed = true;
      }
      if (commitState.committed) committed = true;
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
      const error = preserveWorkspacePrimaryError(operationFailure.value, compensationErrors);
      if (cleanupPermit && commitState.cleanupPermitBound) {
        cleanupPermitOwnership = "transferred";
        return Object.freeze({
          status: "failed" as const,
          error,
          committed,
          cleanupPermit
        });
      }
      return Object.freeze({ status: "failed" as const, error, committed });
    }

    if (!committedPublication) {
      return Object.freeze({
        status: "failed" as const,
        error: publicationStateError(evidenceRef),
        committed
      });
    }
    if (cleanupPermit) cleanupPermitOwnership = "transferred";
    return Object.freeze({
      status: "written" as const,
      written: Object.freeze({
        data,
        publication: committedPublication,
        ...(cleanupPermit ? { cleanupPermit } : {})
      })
    });
  } finally {
    if (cleanupPermitOwnership === "owned") {
      cleanupPermitOwnership = "none";
      await cancelRecordAuthorityCleanupPermit(cleanupPermit);
    }
    if (!exactReplacement) await authorityLease?.release();
  }
}

async function publishOwnedMutableRecord(
  temporaryPath: string,
  temporaryRecord: OwnedTemporaryRecord,
  recordPath: string,
  expectedBytes: Buffer,
  directoryPath: string,
  recordDirectoryIdentity: RecordDirectoryPathnameBinding,
  canonicalBaseline: MutableCanonicalBaseline,
  evidenceRef: string,
  hooks: WorkspaceRecordPublicationHooks | undefined,
  cleanupPermit: WorkspaceRecordCleanupPermit | undefined,
  commitState: MutableRecordPublicationCommitState
): Promise<CommittedMutableRecordPublication> {
  const beforeCommittedMutableBaselineCapture =
    hooks?.beforeCommittedMutableBaselineCapture;
  await assertOwnedTemporaryRecordPath(temporaryPath, temporaryRecord.identity, evidenceRef);
  await assertOpenRecordAuthority(
    temporaryRecord,
    expectedBytes.toString("utf8"),
    1,
    evidenceRef
  );
  if (hooks?.beforeGenerationIsolation) {
    await runAuthorityMutatingCallbackBoundary(
      () =>
        hooks.beforeGenerationIsolation!(
          Object.freeze({ path: temporaryPath, operation: "rename_publication" })
        ),
      async () => {
        await assertOwnedTemporaryRecordPath(
          temporaryPath,
          temporaryRecord.identity,
          evidenceRef
        );
        await assertOpenRecordAuthority(
          temporaryRecord,
          expectedBytes.toString("utf8"),
          1,
          evidenceRef
        );
      }
    );
  }
  await closeTemporaryRecord(temporaryRecord, recordPath, temporaryPath, hooks);
  temporaryRecord.identity = await assertClosedTemporaryRecordAuthority(
    temporaryPath,
    temporaryRecord.identity,
    expectedBytes,
    evidenceRef
  );
  const committedGeneration = await assertFinalMutablePublicationAuthority(
    directoryPath,
    recordDirectoryIdentity,
    dirname(temporaryPath),
    temporaryRecord.namespaceIdentity,
    temporaryPath,
    temporaryRecord.identity,
    recordPath,
    canonicalBaseline,
    evidenceRef,
    expectedBytes
  );

  try {
    await runOwnedRecordDirectoryTransferMutation(
      dirname(temporaryPath),
      temporaryRecord.namespaceIdentity,
      directoryPath,
      recordDirectoryIdentity,
      evidenceRef,
      async () => await rename(temporaryPath, recordPath)
    );
  } catch (error) {
    throw serviceWorkspaceError(
      "workspace_path_not_safe",
      "Failed to publish the captured workspace record generation.",
      "The workspace record could not be published safely.",
      [evidenceRef],
      error
    );
  }

  commitState.committed = true;
  const bindCommittedCleanupPermitGeneration = async (): Promise<void> => {
    if (!cleanupPermit || commitState.cleanupPermitBound) return;
    await bindRecordAuthorityCleanupPermitGeneration(
      cleanupPermit,
      committedGeneration,
      expectedBytes,
      hooks,
      evidenceRef,
      directoryPath,
      recordDirectoryIdentity
    );
    commitState.cleanupPermitBound = true;
  };

  let committedBaselineCapture:
    | {
        readonly status: "captured";
        readonly baseline: Extract<MutableCanonicalBaseline, { status: "existing" }>;
      }
    | { readonly status: "failed"; readonly failure: PresentFailure };
  try {
    if (beforeCommittedMutableBaselineCapture != null) {
      await Reflect.apply(beforeCommittedMutableBaselineCapture, hooks, [
        Object.freeze({ path: recordPath })
      ]);
    }
    const observedCommittedBaseline = await captureMutableCanonicalBaseline(
      recordPath,
      evidenceRef
    );
    if (
      observedCommittedBaseline.status !== "existing" ||
      !workspaceRecordPhysicalIdentityMatches(
        observedCommittedBaseline.identity,
        temporaryRecord.identity
      ) ||
      observedCommittedBaseline.nlink !== 1n ||
      !hasExactPrivatePermissions(
        observedCommittedBaseline.mode,
        PRIVATE_GENERATION_MODE
      ) ||
      !observedCommittedBaseline.bytes.equals(expectedBytes)
    ) {
      throw publicationStateError(evidenceRef);
    }
    committedBaselineCapture = {
      status: "captured",
      baseline: observedCommittedBaseline
    };
  } catch (baselineError) {
    committedBaselineCapture = {
      status: "failed",
      failure: { value: baselineError }
    };
  }

  // The rename above is the commit point. The final validation-to-rename external
  // race is the accepted M1 residual. Cleanup failures cannot roll back this
  // proven commit, but they remain explicit after the committed generation and
  // its rebound parent authority are reproved.
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
  const orderedNamespaceCleanupFailures = [
    ...(namespaceCleanupFailure ? [namespaceCleanupFailure.value] : []),
    ...namespaceCleanupCompensations
  ];
  try {
    await bindCommittedCleanupPermitGeneration();
  } catch (bindingError) {
    throw preserveWorkspacePrimaryError(bindingError, [
      ...(committedBaselineCapture.status === "failed"
        ? [committedBaselineCapture.failure.value]
        : []),
      ...orderedNamespaceCleanupFailures
    ]);
  }
  if (committedBaselineCapture.status === "failed") {
    throw preserveWorkspacePrimaryError(
      committedBaselineCapture.failure.value,
      orderedNamespaceCleanupFailures
    );
  }
  const committedBaseline = committedBaselineCapture.baseline;
  try {
    await assertReboundCommittedCanonicalAuthority(
      directoryPath,
      recordDirectoryIdentity,
      recordPath,
      committedBaseline,
      evidenceRef
    );
  } catch (proofError) {
    throw preserveWorkspacePrimaryError(
      proofError,
      orderedNamespaceCleanupFailures
    );
  }
  if (namespaceCleanupFailure) {
    const orderedCleanupFailure = preserveWorkspacePrimaryError(
      namespaceCleanupFailure.value,
      [...namespaceCleanupCompensations]
    );
    const committedCleanupFailure = serviceWorkspaceError(
      "workspace_path_not_safe",
      "Workspace record publication committed, but mutation namespace cleanup did not complete.",
      "The workspace record was committed, but publication cleanup did not finish safely.",
      [evidenceRef],
      orderedCleanupFailure
    );
    committedMutablePublicationCleanupFailures.add(committedCleanupFailure);
    throw committedCleanupFailure;
  }
  return Object.freeze({
    committedBaseline,
    directoryIdentity: recordDirectoryIdentity,
    postCleanupExactReboundProof:
      WRITER_POST_CLEANUP_EXACT_REBOUND_PROOF,
    publicationHooksActive: hooks !== undefined,
    recordPath
  });
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
  return await runWithRecordDirectoryBindingOperation(
    async () =>
      await createJsonRecordIfAbsentWithDirectoryBindingOperation(
        workspaceRoot,
        relativeDirectorySegments,
        fileName,
        record,
        evidenceRef,
        schema,
        reserveCleanupPermit
      )
  );
}

async function createJsonRecordIfAbsentWithDirectoryBindingOperation<T>(
  workspaceRoot: string,
  relativeDirectorySegments: readonly string[],
  fileName: string,
  record: T,
  evidenceRef: string,
  schema: z.ZodType<T>,
  reserveCleanupPermit: boolean
): Promise<CreateJsonRecordResult<T> | CreateJsonRecordWithCleanupPermitResult<T>> {
  const {
    data,
    directoryPath,
    directoryIdentity,
    recordPath,
    recordText
  } = await prepareJsonRecordWrite(
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
    canonicalPathnameAuthority: { status: "unpublished" },
    handleClosed: false,
    compensationErrors: []
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
      ownedResources.directoryIdentity =
        hooks?.beforeRecordAuthorityIdentitySupplier || hooks?.onAuthorityContention
          ? await readSafeRecordDirectoryIdentity(directoryPath, evidenceRef)
          : directoryIdentity;
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
        await runOwnedRecordDirectoryMutation(
          directoryPath,
          ownedResources.directoryIdentity!,
          evidenceRef,
          async () => await link(temporaryPath, recordPath)
        );
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
        ownedResources.canonicalPathnameAuthority = { status: "relinquished" };
        const canonicalPathnameBinding = await captureCanonicalPathnameBinding(
          recordPath,
          ownedResources.temporaryExpectation,
          2n,
          evidenceRef
        );
        ownedResources.canonicalPathnameAuthority = {
          status: "retained",
          binding: canonicalPathnameBinding,
          expectedLinkCount: 2n
        };
        if (hooks?.afterCanonicalLink) {
          const callbackOutcome = await captureAuthorityMutatingCallbackBoundary(
            () => hooks.afterCanonicalLink!({ canonicalPath: recordPath, temporaryPath }),
            async () => {
              try {
                await assertHardlinkPublicationCheckpoint(
                  hardlinkCheckpoint,
                  recordPath,
                  canonicalPathnameBinding,
                  evidenceRef
                );
              } catch (error) {
                ownedResources.canonicalPathnameAuthority = { status: "relinquished" };
                throw error;
              }
            }
          );
          if (callbackOutcome.status === "callback_failed") {
            throw callbackOutcome.error;
          }
        }
      }
    } catch (error) {
      operationFailure = { value: error };
    }

    if (ownedResources.temporaryRecord && !ownedResources.handleClosed) {
      try {
        await closeOwnedTemporaryRecord(ownedResources, hooks, evidenceRef);
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
          ownedResources
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
          hooks,
          ownedResources
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
      ownedResources.directoryIdentity &&
      ownedResources.canonicalPathnameAuthority.status === "retained"
    ) {
      const rollbackAuthorityBefore = ownedResources.canonicalPathnameAuthority.status;
      try {
        await rollbackPublishedRecordClaim(
          recordPath,
          ownedResources.canonicalIdentity,
          ownedResources.expectedBytes,
          evidenceRef,
          directoryPath,
          ownedResources.directoryIdentity,
          ownedResources
        );
      } catch (error) {
        if (hardlinkCanonicalAuthorityTransitionedToRelinquished(
          ownedResources,
          rollbackAuthorityBefore
        )) {
          compensationErrors.unshift(operationFailure.value);
          operationFailure = { value: error };
        } else {
          compensationErrors.push(error);
        }
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
      const compensationInspectionAuthorityBefore =
        ownedResources.canonicalPathnameAuthority.status;
      try {
        const ownership = hardlinkTemporaryNamespaceOwnership(
          ownedResources,
          producerNamespacePath,
          directoryPath,
          evidenceRef
        );
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
            await assertAuthorityNamespaceOwnershipIfPresent(ownership, evidenceRef);
            await assertHardlinkCanonicalCompensationState(ownedResources, evidenceRef);
          }
        );
        await finalizeHardlinkTemporaryCompensation(
          ownedResources,
          producerNamespacePath,
          temporaryPath,
          directoryPath,
          evidenceRef,
          ownedResources.temporaryIdentity ?? ownedResources.canonicalIdentity
        );
      } catch (error) {
        if (hardlinkCanonicalAuthorityTransitionedToRelinquished(
          ownedResources,
          compensationInspectionAuthorityBefore
        )) {
          compensationErrors.unshift(operationFailure.value);
          operationFailure = { value: error };
        } else {
          compensationErrors.push(error);
        }
        try {
          await finalizeHardlinkTemporaryCompensation(
            ownedResources,
            producerNamespacePath,
            temporaryPath,
            directoryPath,
            evidenceRef,
            ownedResources.temporaryIdentity ?? ownedResources.canonicalIdentity
          );
        } catch (cleanupError) {
          compensationErrors.push(cleanupError);
        }
      }
      publicationOutcome = undefined;
    }

    if (
      operationFailure &&
      ownedResources.temporaryIdentity &&
      (publicationOutcome !== "published" ||
        ownedResources.canonicalPathnameAuthority.status === "relinquished")
    ) {
      try {
        const ownership = hardlinkTemporaryNamespaceOwnership(
          ownedResources,
          producerNamespacePath,
          directoryPath,
          evidenceRef
        );
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
            await assertAuthorityNamespaceOwnershipIfPresent(ownership, evidenceRef);
            await assertHardlinkCanonicalCompensationState(ownedResources, evidenceRef);
          }
        );
        await finalizeHardlinkTemporaryCompensation(
          ownedResources,
          producerNamespacePath,
          temporaryPath,
          directoryPath,
          evidenceRef,
          ownedResources.temporaryIdentity
        );
      } catch (error) {
        compensationErrors.push(error);
        try {
          await finalizeHardlinkTemporaryCompensation(
            ownedResources,
            producerNamespacePath,
            temporaryPath,
            directoryPath,
            evidenceRef,
            ownedResources.temporaryIdentity
          );
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
      await cancelRecordAuthorityCleanupPermit(cleanupPermit);
    }
    await authorityLease?.release();
  }
}

async function closeOwnedTemporaryRecord(
  ownedResources: HardlinkPublicationOwnedResources,
  hooks: WorkspaceRecordPublicationHooks | undefined,
  evidenceRef: string
): Promise<void> {
  const temporaryRecord = ownedResources.temporaryRecord;
  if (!temporaryRecord || ownedResources.handleClosed) return;
  try {
    await closeHardlinkTemporaryRecord(temporaryRecord, ownedResources, hooks, evidenceRef);
  } finally {
    ownedResources.handleClosed = temporaryRecord.handleClosed;
  }
}

async function closeHardlinkTemporaryRecord(
  temporaryRecord: OwnedTemporaryRecord,
  ownedResources: HardlinkPublicationOwnedResources,
  hooks: WorkspaceRecordPublicationHooks | undefined,
  evidenceRef: string
): Promise<void> {
  if (temporaryRecord.handleClosed) return;

  const hookInput = Object.freeze({
    canonicalPath: ownedResources.canonicalPath,
    temporaryPath: ownedResources.temporaryPath,
    descriptor: Object.freeze({
      fd: temporaryRecord.file.fd,
      dev: temporaryRecord.identity.dev,
      ino: temporaryRecord.identity.ino
    })
  });
  let primaryFailure: PresentFailure | undefined;
  const compensationErrors: unknown[] = [];
  try {
    await runHardlinkPostLinkCallbackBoundary(
      ownedResources,
      hooks?.beforeTemporaryFileClose
        ? () => hooks.beforeTemporaryFileClose!(hookInput)
        : undefined,
      evidenceRef,
      async () =>
        await assertHardlinkPrivateTemporaryAuthority(
          ownedResources,
          evidenceRef,
          "open"
        )
    );
  } catch (error) {
    primaryFailure = { value: error };
  }

  try {
    await temporaryRecord.file.close();
    temporaryRecord.handleClosed = true;
    ownedResources.handleClosed = true;
  } catch (error) {
    primaryFailure = appendSequentialFailure(primaryFailure, compensationErrors, error);
  }

  if (temporaryRecord.handleClosed) {
    try {
      await runHardlinkPostLinkCallbackBoundary(
        ownedResources,
        hooks?.afterTemporaryFileClosed
          ? () => hooks.afterTemporaryFileClosed!(hookInput)
          : undefined,
        evidenceRef,
        async () =>
          await assertHardlinkPrivateTemporaryAuthority(
            ownedResources,
            evidenceRef,
            "closed"
          )
      );
    } catch (error) {
      primaryFailure = appendSequentialFailure(primaryFailure, compensationErrors, error);
    }
  }

  if (primaryFailure) {
    throw preserveWorkspacePrimaryError(primaryFailure.value, compensationErrors);
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

async function finalizeHardlinkTemporaryCompensation(
  ownedResources: HardlinkPublicationOwnedResources,
  producerNamespacePath: string,
  temporaryPath: string,
  directoryPath: string,
  evidenceRef: string,
  temporaryIdentity: OwnedTemporaryRecordIdentity
): Promise<void> {
  if (!(await recordPathEntryExists(producerNamespacePath, evidenceRef))) return;
  const admittedOwnership = hardlinkTemporaryNamespaceOwnership(
    ownedResources,
    producerNamespacePath,
    directoryPath,
    evidenceRef
  );
  const ownership = await rebindExactOwnedAuthorityNamespaceForPrivateFinalization(
    admittedOwnership,
    evidenceRef
  );
  ownedResources.directoryIdentity = ownership.parentIdentity;
  if (ownedResources.temporaryRecord) {
    ownedResources.temporaryRecord.namespaceIdentity = ownership.identity;
  }
  const namespacePresent = await assertAuthorityNamespaceOwnershipIfPresent(
    ownership,
    evidenceRef
  );
  await assertHardlinkCanonicalCompensationState(ownedResources, evidenceRef);
  let finalizationFailure: PresentFailure | undefined;
  const finalizationCompensations: unknown[] = [];
  if (namespacePresent && (await recordPathEntryExists(temporaryPath, evidenceRef))) {
    try {
      await removeOwnedPathWithoutHooks(
        temporaryPath,
        temporaryIdentity,
        ownedResources.expectedBytes,
        evidenceRef,
        "temporary_generation_compensation",
        ownership.identity
      );
    } catch (error) {
      finalizationFailure = { value: error };
    }
  }
  if (namespacePresent) {
    try {
      await removeEmptyAuthorityOwnedMutationNamespace(ownership, evidenceRef);
    } catch (error) {
      finalizationFailure = appendSequentialFailure(
        finalizationFailure,
        finalizationCompensations,
        error
      );
    }
  }
  if (finalizationFailure) {
    throw preserveWorkspacePrimaryError(
      finalizationFailure.value,
      finalizationCompensations
    );
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
  directoryIdentity: RecordDirectoryPathnameBinding
): Promise<OwnedTemporaryRecord> {
  let temporaryFile: RecordFileHandle | undefined;
  let temporaryIdentity: OwnedTemporaryRecordIdentity | undefined;
  let shouldCleanup = false;
  let namespaceCreated = false;
  let namespaceIdentity: RecordDirectoryPathnameBinding | undefined;
  let operationFailure: PresentFailure | undefined;
  try {
    namespaceIdentity = await createPrivateAuthorityNamespaceAt(
      namespacePath,
      directoryPath,
      directoryIdentity,
      evidenceRef
    );
    namespaceCreated = true;
    temporaryFile = await runOwnedRecordDirectoryMutation(
      namespacePath,
      namespaceIdentity,
      evidenceRef,
      async () =>
        await open(
          temporaryPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
          0o600
        )
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
          evidenceRef,
          namespaceIdentity
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
  recordDirectoryIdentity: RecordDirectoryPathnameBinding,
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
  let namespaceOwnership: OwnedAuthorityNamespace = {
    path: namespacePath,
    parentPath: directoryPath,
    parentIdentity: recordDirectoryIdentity,
    identity: temporaryRecord.namespaceIdentity
  };
  try {
    namespaceOwnership = await rebindExactOwnedAuthorityNamespaceForPrivateFinalization(
      namespaceOwnership,
      evidenceRef,
      false
    );
    temporaryRecord.namespaceIdentity = namespaceOwnership.identity;
    await assertMutableCleanupPathAuthority(
      directoryPath,
      namespaceOwnership.parentIdentity,
      namespacePath,
      namespaceOwnership.identity,
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
      await runOwnedRecordDirectoryMutation(
        namespaceOwnership.path,
        namespaceOwnership.identity,
        evidenceRef,
        async () => await unlink(temporaryPath)
      );
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
  evidenceRef: string,
  admittedParentIdentity?: RecordDirectoryPathnameBinding
): Promise<void> {
  const generationExpectation = await captureOwnedGenerationExpectation(
    path,
    expected,
    expectedBytes,
    1n,
    evidenceRef,
    PRIVATE_GENERATION_MODE
  );
  const mutationNamespace = await createAuthorityOwnedMutationNamespace(
    path,
    evidenceRef,
    admittedParentIdentity
  );
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
    await runOwnedRecordDirectoryTransferMutation(
      mutationNamespace.parentPath,
      mutationNamespace.parentIdentity,
      mutationNamespace.path,
      mutationNamespace.identity,
      evidenceRef,
      async () => await rename(path, isolatedPath)
    );
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
    await runOwnedRecordDirectoryMutation(
      mutationNamespace.path,
      mutationNamespace.identity,
      evidenceRef,
      async () => await unlink(isolatedPath)
    );
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
  parentIdentity: RecordDirectoryPathnameBinding,
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
  await runOwnedRecordDirectoryMutation(
    parentPath,
    parentIdentity,
    evidenceRef,
    async () => await unlink(path)
  );
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
  ownedResources?: HardlinkPublicationOwnedResources
): Promise<void> {
  const attemptErrors: unknown[] = [];
  let canonicalAuthorityFailure: PresentFailure | undefined;
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
  const runCleanupCallback = async (
    callback: () => Promise<void> | void,
    proveAdditionalAuthority: () => Promise<void>
  ) => {
    if (ownedResources) {
      await runHardlinkPostLinkCallbackBoundary(
        ownedResources,
        callback,
        evidenceRef,
        proveAdditionalAuthority
      );
    } else {
      await runAuthorityMutatingCallbackBoundary(callback, proveAdditionalAuthority);
    }
  };
  for (let attempt = 1; attempt <= RECORD_TEMP_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      if (hooks?.beforeTemporaryUnlink) {
        await runCleanupCallback(
          () => hooks.beforeTemporaryUnlink!({ canonicalPath: recordPath, temporaryPath, attempt }),
          async () => {
            await assertAuthorityNamespaceOwnership(namespaceOwnership, evidenceRef);
            if (!generationExpectation) throw generationExpectationFailure!.value;
            if (!(await ownedGenerationStateMatches(
              temporaryPath,
              generationExpectation,
              generationExpectation.nlink,
              evidenceRef
            ))) throw publicationStateError(evidenceRef);
          }
        );
      }
      if (hooks?.beforeGenerationIsolation) {
        await runCleanupCallback(
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
        await runCleanupCallback(
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
        await runCleanupCallback(
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
      }
      await runOwnedAuthorityNamespaceMutation(
        namespaceOwnership,
        evidenceRef,
        async () => await unlink(temporaryPath)
      );
      if (ownedResources?.canonicalIdentity) {
        await advanceHardlinkCanonicalEpochAfterTemporaryUnlink(ownedResources, evidenceRef);
      }
      const namespaceCleanupErrors = await removeEmptyAuthorityOwnedMutationNamespace(
        namespaceOwnership,
        evidenceRef,
        true,
        ownedResources?.canonicalIdentity
          ? async () => await assertRetainedHardlinkCanonicalEpoch(ownedResources, evidenceRef)
          : undefined
      );
      if (namespaceCleanupErrors.length > 0 && ownedResources) {
        const reboundDirectory = await readSafeRecordDirectoryIdentity(
          namespaceOwnership.parentPath,
          evidenceRef
        );
        if (
          !workspaceRecordPhysicalIdentityMatches(
            reboundDirectory,
            namespaceOwnership.parentIdentity
          )
        ) {
          throw publicationStateError(evidenceRef);
        }
        ownedResources.directoryIdentity = reboundDirectory;
      }
      if (
        namespaceCleanupErrors.length > 0 &&
        ownedResources?.canonicalIdentity
      ) {
        try {
          await assertRetainedHardlinkCanonicalEpoch(ownedResources, evidenceRef);
        } catch (canonicalProofError) {
          throw preserveWorkspacePrimaryError(
            canonicalProofError,
            [...namespaceCleanupErrors]
          );
        }
      }
      if (ownedResources) ownedResources.isolatedGeneration = undefined;
      return;
    } catch (error) {
      if (ownedResources && hardlinkCanonicalAuthorityWasRelinquished(ownedResources)) {
        canonicalAuthorityFailure = { value: error };
      } else {
        attemptErrors.push(error);
      }
      if (canonicalAuthorityFailure) break;
      if (attempt < RECORD_TEMP_CLEANUP_ATTEMPTS) {
        await sleep(RECORD_TEMP_CLEANUP_RETRY_MS);
        continue;
      }
    }
  }

  const finalizationErrors: unknown[] = [];
  let finalizationRemovedTemporaryGeneration = false;
  let finalizationOwnership = namespaceOwnership;
  try {
    finalizationOwnership = await rebindExactOwnedAuthorityNamespaceForPrivateFinalization(
      namespaceOwnership,
      evidenceRef
    );
    if (ownedResources) {
      ownedResources.directoryIdentity = finalizationOwnership.parentIdentity;
      if (ownedResources.temporaryRecord) {
        ownedResources.temporaryRecord.namespaceIdentity = finalizationOwnership.identity;
      }
    }
    await assertAuthorityNamespaceOwnership(finalizationOwnership, evidenceRef);
    if (await recordPathEntryExists(temporaryPath, evidenceRef)) {
      await assertAuthorityNamespaceOwnership(finalizationOwnership, evidenceRef);
      await removeOwnedPrivateGenerationWithoutHooks(
        temporaryPath,
        temporaryIdentity,
        expectedBytes,
        finalizationOwnership,
        evidenceRef
      );
      finalizationRemovedTemporaryGeneration = true;
    }
    if (finalizationRemovedTemporaryGeneration && ownedResources?.canonicalIdentity) {
      await advanceHardlinkCanonicalEpochAfterTemporaryUnlink(ownedResources, evidenceRef);
    }
  } catch (error) {
    finalizationErrors.push(error);
  }
  try {
    await removeEmptyAuthorityOwnedMutationNamespace(
      finalizationOwnership,
      evidenceRef,
      false
    );
    if (ownedResources) ownedResources.isolatedGeneration = undefined;
  } catch (error) {
    finalizationErrors.push(error);
  }

  throw canonicalAuthorityFailure
    ? preserveWorkspacePrimaryError(
        canonicalAuthorityFailure.value,
        [...attemptErrors, ...finalizationErrors]
      )
    : preserveWorkspacePrimaryError(
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
  await runOwnedRecordDirectoryMutation(
    namespaceOwnership.path,
    namespaceOwnership.identity,
    evidenceRef,
    async () => await unlink(path)
  );
}

async function rollbackPublishedRecordClaim(
  recordPath: string,
  expectedIdentity: OwnedTemporaryRecordIdentity,
  expectedBytes: Buffer,
  evidenceRef: string,
  admittedParentPath: string,
  admittedParentIdentity: RecordDirectoryPathnameBinding,
  ownedResources: HardlinkPublicationOwnedResources
): Promise<void> {
  const authority = ownedResources.canonicalPathnameAuthority;
  if (authority.status !== "retained") throw publicationStateError(evidenceRef);
  try {
    const reboundParentIdentity = await readSafeRecordDirectoryIdentity(
      admittedParentPath,
      evidenceRef
    );
    if (
      !workspaceRecordPhysicalIdentityMatches(
        reboundParentIdentity,
        admittedParentIdentity
      )
    ) {
      throw publicationStateError(evidenceRef);
    }
    ownedResources.directoryIdentity = reboundParentIdentity;
    await assertRecordDirectoryIdentity(
      admittedParentPath,
      reboundParentIdentity,
      evidenceRef
    );
    await assertRetainedHardlinkCanonicalEpoch(ownedResources, evidenceRef);
    await removeOwnedPathWithoutHooks(
      recordPath,
      expectedIdentity,
      expectedBytes,
      evidenceRef,
      "published_rollback",
      reboundParentIdentity,
      authority.binding,
      authority.expectedLinkCount,
      () => {
        ownedResources.canonicalPathnameAuthority = { status: "relinquished" };
      },
      (binding) => {
        ownedResources.canonicalPathnameAuthority = {
          status: "retained",
          binding,
          expectedLinkCount: authority.expectedLinkCount
        };
      }
    );
    ownedResources.canonicalPathnameAuthority = { status: "removed" };
  } catch (error) {
    throw error;
  }
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
  admittedParentIdentity?: RecordDirectoryPathnameBinding,
  expectedPathnameBinding?: CanonicalPathnameBinding,
  expectedPathnameLinkCount = 1n,
  onPathnameBindingDrift?: () => void,
  onExactPublicRestore?: (binding: CanonicalPathnameBinding) => void
): Promise<void> {
  const generationExpectation = await captureOwnedGenerationExpectation(
    path,
    expectedIdentity,
    expectedBytes,
    undefined,
    evidenceRef,
    PRIVATE_GENERATION_MODE
  );
  if (expectedPathnameBinding) {
    try {
      await assertCanonicalPathnameBinding(
        path,
        expectedPathnameBinding,
        generationExpectation,
        expectedPathnameLinkCount,
        evidenceRef
      );
    } catch (error) {
      onPathnameBindingDrift?.();
      throw error;
    }
  }
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
        if (!(await ownedGenerationStateMatches(
            path,
            generationExpectation,
            generationExpectation.nlink,
            evidenceRef,
            expectedPathnameBinding
          ))) {
          if (expectedPathnameBinding) {
            onPathnameBindingDrift?.();
            throw publicationStateError(evidenceRef);
          }
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
    if (expectedPathnameBinding) {
      try {
        if (!(await ownedGenerationStateMatches(
            path,
            generationExpectation,
            generationExpectation.nlink,
            evidenceRef,
            expectedPathnameBinding
          ))) {
          onPathnameBindingDrift?.();
        }
      } catch (bindingProofError) {
        onPathnameBindingDrift?.();
        cleanupErrors.push(bindingProofError);
      }
    }
    try {
      await removeEmptyAuthorityOwnedMutationNamespace(mutationNamespace, evidenceRef);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    throw preserveWorkspacePrimaryError(error, cleanupErrors);
  }
  try {
    await runOwnedRecordDirectoryTransferMutation(
      mutationNamespace.parentPath,
      mutationNamespace.parentIdentity,
      mutationNamespace.path,
      mutationNamespace.identity,
      evidenceRef,
      async () => await rename(path, isolatedPath)
    );
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
    await runOwnedRecordDirectoryMutation(
      mutationNamespace.path,
      mutationNamespace.identity,
      evidenceRef,
      async () => await unlink(isolatedPath)
    );
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
      namespaceCleanupAttempted,
      onExactPublicRestore
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
  namespaceCleanupAlreadyAttempted = false,
  onExactPublicRestore?: (binding: CanonicalPathnameBinding) => void,
  publicRestoreGeneration?: OwnedGenerationExpectation
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
    let restoreGeneration: OwnedGenerationExpectation | undefined = expectedGeneration;
    if (publicRestoreGeneration) {
      try {
        restoreGeneration = await restoreIsolatedGenerationModeForPublicRollback(
          isolatedPath,
          mutationNamespace,
          expectedGeneration,
          publicRestoreGeneration,
          evidenceRef
        );
      } catch (error) {
        compensationErrors.push(error);
        restoreGeneration = undefined;
        const cleanupErrors = await removeUnsafeOwnedIsolatedSource(
          isolatedPath,
          mutationNamespace,
          expectedGeneration,
          evidenceRef,
          publicRestoreGeneration
        );
        compensationErrors.push(...cleanupErrors);
      }
    }
    if (restoreGeneration) {
      try {
        const restoredBinding = await restoreOwnedIsolatedPath(
          isolatedPath,
          publicPath,
          mutationNamespace,
          restoreGeneration,
          evidenceRef,
          site
        );
        onExactPublicRestore?.(restoredBinding);
      } catch (error) {
        compensationErrors.push(error);
      }
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
): Promise<CanonicalPathnameBinding> {
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
        await runOwnedRecordDirectoryMutation(
          mutationNamespace.parentPath,
          mutationNamespace.parentIdentity,
          evidenceRef,
          async () => await link(isolatedPath, publicPath)
        );
      } catch (error) {
        linkAdmissionErrors.push(error);
        break;
      }
      phase = "public_link_created";
      try {
        publicLinkBinding = await captureRestoredPublicLinkBinding(
          publicPath,
          mutationNamespace.parentIdentity,
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
        await runOwnedRecordDirectoryMutation(
          mutationNamespace.path,
          mutationNamespace.identity,
          evidenceRef,
          async () => await unlink(isolatedPath)
        );
        phase = "post_source_committed";
        const committedBinding = await captureCanonicalPathnameBinding(
          publicPath,
          expectedGeneration,
          expectedGeneration.nlink,
          evidenceRef
        );
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
                evidenceRef,
                committedBinding
              ))
            ) throw publicationStateError(evidenceRef);
          }
        );
        return committedBinding;
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
          !(await restoredPublicLinkOwnershipMatches(
            publicPath,
            expectedBinding,
            evidenceRef
          ))
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
          await runOwnedRecordDirectoryMutation(
            mutationNamespace.parentPath,
            mutationNamespace.parentIdentity,
            evidenceRef,
            async () => await unlink(publicPath)
          );
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
  parentBinding: RecordDirectoryPathnameBinding,
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
  await assertRecordDirectoryIdentity(dirname(publicPath), parentBinding, evidenceRef);
  return Object.freeze({
    parentBinding,
    parentCtimeNs: parentBinding.ctimeNs,
    parentMtimeNs: parentBinding.mtimeNs,
    pathnameBinding: {
      identity: { dev: entry.dev, ino: entry.ino },
      ctimeNs: entry.ctimeNs,
      mtimeNs: entry.mtimeNs
    }
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
      evidenceRef,
      binding.pathnameBinding
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
      workspaceRecordPhysicalIdentityMatches(parent, binding.parentBinding) &&
      binding.parentBinding.state === "active" &&
      parent.ctimeNs === binding.parentBinding.ctimeNs &&
      parent.mtimeNs === binding.parentBinding.mtimeNs
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
    throw publicationStateError(evidenceRef);
  }
}

async function restoredPublicLinkOwnershipMatches(
  publicPath: string,
  binding: RestoredPublicLinkBinding,
  evidenceRef: string
): Promise<boolean> {
  if (!(await restoredPublicLinkParentBindingMatches(publicPath, binding, evidenceRef))) {
    return false;
  }
  let publicEntry: BigIntStats;
  let parent: BigIntStats;
  try {
    [publicEntry, parent] = await Promise.all([
      lstat(publicPath, { bigint: true }),
      lstat(dirname(publicPath), { bigint: true })
    ]);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
    throw publicationStateError(evidenceRef);
  }
  if (
    !publicEntry.isFile() ||
    publicEntry.isSymbolicLink() ||
    !workspaceRecordPhysicalIdentityMatches(
      publicEntry,
      binding.pathnameBinding.identity
    )
  ) return false;

  const canonicalEpochMatches =
    publicEntry.ctimeNs === binding.pathnameBinding.ctimeNs &&
    publicEntry.mtimeNs === binding.pathnameBinding.mtimeNs;
  if (canonicalEpochMatches) return true;

  // chmod or a hardlink outside the public parent advances the inode epoch but
  // leaves this directory entry's parent epoch unchanged. A remove-and-relink
  // advances both, so ownership must be relinquished before source commit.
  return (
    parent.isDirectory() &&
    !parent.isSymbolicLink() &&
    parent.ctimeNs === binding.parentCtimeNs &&
    parent.mtimeNs === binding.parentMtimeNs
  );
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
  evidenceRef: string,
  publicRollbackGeneration?: OwnedGenerationExpectation
): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];
  try {
    await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
    const identity = await lstat(isolatedPath, { bigint: true });
    let matchedGeneration: OwnedGenerationExpectation | undefined;
    if (identity.isFile() && !identity.isSymbolicLink() && identity.nlink > 1n) {
      // Mode restoration can fail before chmod or after reaching the admitted
      // public mode, but only the exact admitted pair may widen this match.
      const expectedGenerations =
        publicRollbackGeneration &&
        publicRollbackGenerationPairMatches(expectedGeneration, publicRollbackGeneration)
        ? [expectedGeneration, publicRollbackGeneration]
        : [expectedGeneration];
      for (const candidate of expectedGenerations) {
        if (
          workspaceRecordPhysicalIdentityMatches(identity, candidate.identity) &&
          (await ownedGenerationStateMatches(
            isolatedPath,
            candidate,
            identity.nlink,
            evidenceRef
          ))
        ) {
          matchedGeneration = candidate;
          break;
        }
      }
    }
    if (matchedGeneration) {
      await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
      if (
        !(await ownedGenerationStateMatches(
          isolatedPath,
          matchedGeneration,
          identity.nlink,
          evidenceRef
        ))
      ) {
        throw publicationStateError(evidenceRef);
      }
      await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
      await runOwnedRecordDirectoryMutation(
        mutationNamespace.path,
        mutationNamespace.identity,
        evidenceRef,
        async () => await unlink(isolatedPath)
      );
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
  evidenceRef: string,
  pathnameBinding?: CanonicalPathnameBinding
): Promise<boolean> {
  let file: RecordFileHandle | undefined;
  try {
    file = await open(path, BOUNDED_NOFOLLOW_READ_OPEN_FLAGS);
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== expectedLinkCount ||
      before.mode !== expectedGeneration.mode ||
      !workspaceRecordPhysicalIdentityMatches(before, expectedGeneration.identity) ||
      (pathnameBinding !== undefined &&
        (!workspaceRecordPhysicalIdentityMatches(before, pathnameBinding.identity) ||
          before.ctimeNs !== pathnameBinding.ctimeNs ||
          before.mtimeNs !== pathnameBinding.mtimeNs)) ||
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
      after.nlink === expectedLinkCount &&
      (pathnameBinding === undefined ||
        (after.ctimeNs === pathnameBinding.ctimeNs &&
          after.mtimeNs === pathnameBinding.mtimeNs))
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return false;
    throw publicationStateError(evidenceRef);
  } finally {
    await file?.close();
  }
}

async function normalizeLegacyIsolatedGenerationMode(
  path: string,
  mutationNamespace: OwnedAuthorityNamespace,
  expectedGeneration: OwnedGenerationExpectation,
  evidenceRef: string
): Promise<OwnedGenerationExpectation> {
  if (
    !isSafeBaseCompatibleOrdinaryGenerationMode(expectedGeneration.mode) ||
    hasExactPrivatePermissions(expectedGeneration.mode, PRIVATE_GENERATION_MODE)
  ) {
    throw publicationStateError(evidenceRef);
  }
  await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);

  let file: RecordFileHandle | undefined;
  let modeMutationAttempted = false;
  let originalModeRestored = false;
  let normalizedGeneration: OwnedGenerationExpectation | undefined;
  let primaryFailure: PresentFailure | undefined;
  const compensationErrors: unknown[] = [];
  try {
    file = await open(path, BOUNDED_NOFOLLOW_READ_OPEN_FLAGS);
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.mode !== expectedGeneration.mode ||
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

    modeMutationAttempted = true;
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
    normalizedGeneration = {
      identity: { dev: afterChmod.dev, ino: afterChmod.ino },
      bytes: Buffer.from(expectedGeneration.bytes),
      mode: afterChmod.mode,
      nlink: afterChmod.nlink
    };
    if (
      !(await ownedGenerationStateMatches(
        path,
        normalizedGeneration,
        normalizedGeneration.nlink,
        evidenceRef
      ))
    ) {
      throw publicationStateError(evidenceRef);
    }
    await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
  } catch (error) {
    primaryFailure = {
      value: error instanceof TaskServiceError ? error : publicationStateError(evidenceRef, error)
    };
    if (modeMutationAttempted && file) {
      try {
        await restoreOpenGenerationMode(file, expectedGeneration, evidenceRef);
        originalModeRestored = true;
      } catch (restoreError) {
        compensationErrors.push(restoreError);
      }
    }
  } finally {
    try {
      await file?.close();
    } catch (closeError) {
      primaryFailure = appendSequentialFailure(primaryFailure, compensationErrors, closeError);
      if (modeMutationAttempted && !originalModeRestored && file) {
        try {
          await restoreOpenGenerationMode(file, expectedGeneration, evidenceRef);
          originalModeRestored = true;
        } catch (restoreError) {
          compensationErrors.push(restoreError);
        }
      }
    }
  }
  if (primaryFailure) {
    throw preserveWorkspacePrimaryError(primaryFailure.value, compensationErrors);
  }
  if (!normalizedGeneration) throw publicationStateError(evidenceRef);
  return normalizedGeneration;
}

function publicRollbackGenerationPairMatches(
  privateGeneration: OwnedGenerationExpectation,
  publicGeneration: OwnedGenerationExpectation
): boolean {
  return (
    hasExactPrivatePermissions(privateGeneration.mode, PRIVATE_GENERATION_MODE) &&
    isSafeBaseCompatibleOrdinaryGenerationMode(publicGeneration.mode) &&
    workspaceRecordPhysicalIdentityMatches(
      privateGeneration.identity,
      publicGeneration.identity
    ) &&
    privateGeneration.bytes.equals(publicGeneration.bytes) &&
    privateGeneration.nlink === publicGeneration.nlink
  );
}

async function restoreIsolatedGenerationModeForPublicRollback(
  path: string,
  mutationNamespace: OwnedAuthorityNamespace,
  privateGeneration: OwnedGenerationExpectation,
  publicGeneration: OwnedGenerationExpectation,
  evidenceRef: string
): Promise<OwnedGenerationExpectation> {
  if (!publicRollbackGenerationPairMatches(privateGeneration, publicGeneration)) {
    throw publicationStateError(evidenceRef);
  }
  await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);

  let file: RecordFileHandle | undefined;
  let primaryFailure: PresentFailure | undefined;
  const compensationErrors: unknown[] = [];
  try {
    file = await open(path, BOUNDED_NOFOLLOW_READ_OPEN_FLAGS);
    const before = await file.stat({ bigint: true });
    await assertOpenGenerationMatches(file, before, privateGeneration, evidenceRef);
    await file.chmod(Number(publicGeneration.mode & PRIVATE_PERMISSION_MASK));
    const restored = await file.stat({ bigint: true });
    await assertOpenGenerationMatches(file, restored, publicGeneration, evidenceRef);
  } catch (error) {
    primaryFailure = {
      value: error instanceof TaskServiceError ? error : publicationStateError(evidenceRef, error)
    };
  } finally {
    try {
      await file?.close();
    } catch (closeError) {
      primaryFailure = appendSequentialFailure(primaryFailure, compensationErrors, closeError);
    }
  }
  if (primaryFailure) {
    throw preserveWorkspacePrimaryError(primaryFailure.value, compensationErrors);
  }

  await assertAuthorityNamespaceOwnership(mutationNamespace, evidenceRef);
  return await captureOwnedGenerationExpectation(
    path,
    publicGeneration.identity,
    publicGeneration.bytes,
    publicGeneration.nlink,
    evidenceRef,
    publicGeneration.mode & PRIVATE_PERMISSION_MASK
  );
}

async function restoreOpenGenerationMode(
  file: RecordFileHandle,
  expectedGeneration: OwnedGenerationExpectation,
  evidenceRef: string
): Promise<void> {
  await file.chmod(Number(expectedGeneration.mode & PRIVATE_PERMISSION_MASK));
  const restored = await file.stat({ bigint: true });
  await assertOpenGenerationMatches(file, restored, expectedGeneration, evidenceRef);
}

async function assertOpenGenerationMatches(
  file: RecordFileHandle,
  before: BigIntStats,
  expectedGeneration: OwnedGenerationExpectation,
  evidenceRef: string
): Promise<void> {
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== expectedGeneration.nlink ||
    before.mode !== expectedGeneration.mode ||
    !workspaceRecordPhysicalIdentityMatches(before, expectedGeneration.identity) ||
    before.size !== BigInt(expectedGeneration.bytes.length) ||
    before.size > BigInt(MAX_SERVICE_RECORD_BYTES)
  ) {
    throw publicationStateError(evidenceRef);
  }
  const observed = await readBoundedOpenFile(file, before);
  if (
    !observed.bytes.equals(expectedGeneration.bytes) ||
    observed.after.dev !== before.dev ||
    observed.after.ino !== before.ino ||
    observed.after.mode !== before.mode ||
    observed.after.nlink !== before.nlink ||
    observed.after.size !== before.size
  ) {
    throw publicationStateError(evidenceRef);
  }
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
    file = await open(path, BOUNDED_NOFOLLOW_READ_OPEN_FLAGS);
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
  await assertOwnedGenerationState(checkpoint, evidenceRef, expectedLinkCount);
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

async function assertOwnedGenerationState(
  checkpoint: OwnedGenerationCheckpoint,
  evidenceRef: string,
  expectedLinkCount = checkpoint.generation.nlink
): Promise<void> {
  if (
    !(await ownedGenerationStateMatches(
      checkpoint.path,
      checkpoint.generation,
      expectedLinkCount,
      evidenceRef,
      checkpoint.pathnameBinding
    ))
  ) {
    throw publicationStateError(evidenceRef);
  }
}

async function assertHardlinkPublicationCheckpoint(
  temporaryCheckpoint: OwnedGenerationCheckpoint,
  canonicalPath: string,
  canonicalPathnameBinding: CanonicalPathnameBinding,
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
    !workspaceRecordPhysicalIdentityMatches(canonical, canonicalPathnameBinding.identity) ||
    canonical.ctimeNs !== canonicalPathnameBinding.ctimeNs ||
    canonical.mtimeNs !== canonicalPathnameBinding.mtimeNs ||
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

async function captureCanonicalPathnameBinding(
  path: string,
  generation: OwnedGenerationExpectation,
  expectedLinkCount: bigint,
  evidenceRef: string
): Promise<CanonicalPathnameBinding> {
  let entry: BigIntStats;
  try {
    entry = await lstat(path, { bigint: true });
  } catch {
    throw publicationStateError(evidenceRef);
  }
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== expectedLinkCount ||
    entry.mode !== generation.mode ||
    entry.size !== BigInt(generation.bytes.length) ||
    !workspaceRecordPhysicalIdentityMatches(entry, generation.identity)
  ) {
    throw publicationStateError(evidenceRef);
  }
  return Object.freeze({
    identity: { dev: entry.dev, ino: entry.ino },
    ctimeNs: entry.ctimeNs,
    mtimeNs: entry.mtimeNs
  });
}

async function assertCanonicalPathnameBinding(
  path: string,
  binding: CanonicalPathnameBinding,
  generation: OwnedGenerationExpectation,
  expectedLinkCount: bigint,
  evidenceRef: string
): Promise<void> {
  const observed = await captureCanonicalPathnameBinding(
    path,
    generation,
    expectedLinkCount,
    evidenceRef
  );
  if (
    !workspaceRecordPhysicalIdentityMatches(observed.identity, binding.identity) ||
    observed.ctimeNs !== binding.ctimeNs ||
    observed.mtimeNs !== binding.mtimeNs
  ) {
    throw publicationStateError(evidenceRef);
  }
}

async function assertRetainedHardlinkCanonicalEpoch(
  ownedResources: HardlinkPublicationOwnedResources,
  evidenceRef: string
): Promise<void> {
  const authority = ownedResources.canonicalPathnameAuthority;
  const generation = ownedResources.temporaryExpectation;
  if (authority.status !== "retained" || !generation) {
    throw publicationStateError(evidenceRef);
  }
  try {
    await assertCanonicalPathnameBinding(
      ownedResources.canonicalPath,
      authority.binding,
      generation,
      authority.expectedLinkCount,
      evidenceRef
    );
  } catch (error) {
    ownedResources.canonicalPathnameAuthority = { status: "relinquished" };
    throw error;
  }
}

function hardlinkCanonicalAuthorityWasRelinquished(
  ownedResources: HardlinkPublicationOwnedResources
): boolean {
  return ownedResources.canonicalPathnameAuthority.status === "relinquished";
}

function hardlinkCanonicalAuthorityTransitionedToRelinquished(
  ownedResources: HardlinkPublicationOwnedResources,
  statusBeforeBoundary: HardlinkCanonicalPathnameAuthority["status"]
): boolean {
  return statusBeforeBoundary !== "relinquished" &&
    hardlinkCanonicalAuthorityWasRelinquished(ownedResources);
}

async function runHardlinkPostLinkCallbackBoundary(
  ownedResources: HardlinkPublicationOwnedResources,
  callback: (() => Promise<void> | void) | undefined,
  evidenceRef: string,
  proveAdditionalAuthority?: () => Promise<void>
): Promise<void> {
  if (!callback) return;
  await runAuthorityMutatingCallbackBoundary(
    callback,
    async () => {
      let proofFailure: PresentFailure | undefined;
      const proofCompensations: unknown[] = [];
      if (ownedResources.canonicalPathnameAuthority.status === "retained") {
        try {
          await assertRetainedHardlinkCanonicalEpoch(ownedResources, evidenceRef);
        } catch (error) {
          proofFailure = { value: error };
        }
      }
      try {
        await proveAdditionalAuthority?.();
      } catch (error) {
        proofFailure = appendSequentialFailure(
          proofFailure,
          proofCompensations,
          error
        );
      }
      if (proofFailure) {
        throw preserveWorkspacePrimaryError(
          proofFailure.value,
          proofCompensations
        );
      }
    }
  );
}

async function assertHardlinkPrivateTemporaryAuthority(
  ownedResources: HardlinkPublicationOwnedResources,
  evidenceRef: string,
  handleState: "open" | "closed"
): Promise<void> {
  const temporaryRecord = ownedResources.temporaryRecord;
  const generation = ownedResources.temporaryExpectation;
  const directoryIdentity = ownedResources.directoryIdentity;
  if (!temporaryRecord || !generation || !directoryIdentity) {
    throw publicationStateError(evidenceRef);
  }

  const namespacePath = dirname(ownedResources.temporaryPath);
  await assertAuthorityNamespaceOwnership(
    {
      path: namespacePath,
      parentPath: dirname(namespacePath),
      parentIdentity: directoryIdentity,
      identity: temporaryRecord.namespaceIdentity
    },
    evidenceRef
  );
  const expectedLinkCount = ownedResources.canonicalIdentity ? 2n : 1n;
  if (
    !(await ownedGenerationStateMatches(
      ownedResources.temporaryPath,
      generation,
      expectedLinkCount,
      evidenceRef
    ))
  ) {
    throw publicationStateError(evidenceRef);
  }

  if (handleState === "open") {
    if (temporaryRecord.handleClosed || ownedResources.handleClosed) {
      throw publicationStateError(evidenceRef);
    }
    await assertOpenRecordAuthority(
      temporaryRecord,
      ownedResources.expectedBytes.toString("utf8"),
      Number(expectedLinkCount),
      evidenceRef
    );
  } else if (!temporaryRecord.handleClosed || !ownedResources.handleClosed) {
    throw publicationStateError(evidenceRef);
  }
}

async function advanceHardlinkCanonicalEpochAfterTemporaryUnlink(
  ownedResources: HardlinkPublicationOwnedResources,
  evidenceRef: string
): Promise<void> {
  const generation = ownedResources.temporaryExpectation;
  if (!generation || ownedResources.canonicalPathnameAuthority.status !== "retained") {
    throw publicationStateError(evidenceRef);
  }
  try {
    const binding = await captureCanonicalPathnameBinding(
      ownedResources.canonicalPath,
      generation,
      1n,
      evidenceRef
    );
    ownedResources.canonicalPathnameAuthority = {
      status: "retained",
      binding,
      expectedLinkCount: 1n
    };
  } catch (error) {
    ownedResources.canonicalPathnameAuthority = { status: "relinquished" };
    throw error;
  }
}

async function assertHardlinkCanonicalCompensationState(
  ownedResources: HardlinkPublicationOwnedResources,
  evidenceRef: string
): Promise<void> {
  const authority = ownedResources.canonicalPathnameAuthority;
  if (authority.status === "retained") {
    await assertRetainedHardlinkCanonicalEpoch(ownedResources, evidenceRef);
  } else if (authority.status === "removed") {
    try {
      await assertMutableCanonicalBaseline(
        ownedResources.canonicalPath,
        { status: "absent" },
        evidenceRef
      );
    } catch (error) {
      ownedResources.canonicalPathnameAuthority = { status: "relinquished" };
      throw error;
    }
  }
}

function preserveWorkspacePrimaryError(primary: unknown, compensations: unknown[]): unknown {
  return preserveTaskServiceErrorCompensationCompatibility(
    primary,
    compensations,
    "Workspace record publication compensation failed."
  );
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
  expectedDirectoryIdentity: RecordDirectoryPathnameBinding,
  recordText: string,
  evidenceRef: string,
  expectedGeneration?: OwnedGenerationExpectation,
  hooks?: WorkspaceRecordPublicationHooks,
  ownedResources?: HardlinkPublicationOwnedResources
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
    try {
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
        const epoch = ownedResources?.canonicalPathnameAuthority;
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
          finalPath.mtimeNs !== published.mutation.mtimeNs ||
          (ownedResources !== undefined &&
            (epoch?.status !== "retained" ||
              epoch.expectedLinkCount !== 1n ||
              !workspaceRecordPhysicalIdentityMatches(finalPath, epoch.binding.identity) ||
              finalPath.ctimeNs !== epoch.binding.ctimeNs ||
              finalPath.mtimeNs !== epoch.binding.mtimeNs))
        ) throw publicationStateError(evidenceRef);
      }
    } catch (error) {
      if (ownedResources) {
        ownedResources.canonicalPathnameAuthority = { status: "relinquished" };
      }
      throw error;
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
): Promise<RecordDirectoryPathnameBinding> {
  const scoped = recordDirectoryBindingForCurrentOperation(directoryPath);
  if (scoped) {
    try {
      await runWithRecordDirectoryMutationLocks(
        [scoped],
        async () => await assertRecordDirectoryIdentityNow(directoryPath, scoped, evidenceRef)
      );
      return scoped;
    } catch {
      // Keep the old generation retained for every explicit baseline that
      // still references it. This helper is a fresh full-path admission
      // checkpoint, so it may additionally borrow a coexisting new epoch.
    }
  }

  const directory = await readSafeExistingDirectoryEntry(directoryPath);
  if (directory) {
    const admitted = await admitObservedRecordDirectoryIdentity(
      directoryPath,
      directory,
      evidenceRef,
      "durable_directory",
      scoped !== undefined
    );
    if (admitted) return admitted;
  }

  throw serviceWorkspaceError(
    "workspace_path_not_safe",
    "Record directory is not a safe directory.",
    "A workspace record directory is not usable.",
    [evidenceRef]
  );
}

async function admitObservedRecordDirectoryIdentity(
  directoryPath: string,
  initialDirectory: BigIntStats,
  evidenceRef: string,
  bindingKind: RecordDirectoryPathnameBinding["kind"] = "durable_directory",
  replaceCurrentPathBinding = false,
  coalesceInFlightMutation = true
): Promise<RecordDirectoryPathnameBinding | undefined> {
  const resolvedDirectoryPath = resolve(directoryPath);
  const key = recordDirectoryPhysicalIdentityKey(initialDirectory);
  let bindings = sharedRecordDirectoryPathnameBindings.get(key);
  let observedDirectory = initialDirectory;
  let shared = Array.from(bindings ?? []).find(
    (binding) =>
      binding.kind === bindingKind &&
      recordDirectoryPathnameBindingMatchesStat(observedDirectory, binding)
  );
  if (!shared && coalesceInFlightMutation) {
    const inFlight = Array.from(bindings ?? []).find(
      (binding) =>
        binding.kind === bindingKind &&
        binding.state === "active" &&
        !binding.retirementRequested &&
        binding.mutationLocked &&
        recordDirectoryPathnameBindingMatchesPath(resolvedDirectoryPath, binding) &&
        workspaceRecordPhysicalIdentityMatches(observedDirectory, binding)
    );
    if (inFlight) {
      await runWithRecordDirectoryMutationLocks([inFlight], async () => undefined);
      const settledDirectory = await readSafeDirectoryLeafEntry(resolvedDirectoryPath);
      if (
        !settledDirectory ||
        !workspaceRecordPhysicalIdentityMatches(settledDirectory, observedDirectory)
      ) {
        return undefined;
      }
      observedDirectory = settledDirectory;
      bindings = sharedRecordDirectoryPathnameBindings.get(key);
      shared = Array.from(bindings ?? []).find(
        (binding) =>
          binding.kind === bindingKind &&
          recordDirectoryPathnameBindingMatchesPath(resolvedDirectoryPath, binding) &&
          recordDirectoryPathnameBindingMatchesStat(observedDirectory, binding)
      );
      if (!shared && (
        observedDirectory.ctimeNs !== initialDirectory.ctimeNs ||
        observedDirectory.mtimeNs !== initialDirectory.mtimeNs
      )) {
        return undefined;
      }
    }
  }
  if (shared) {
    shared.paths.add(resolvedDirectoryPath);
    retainRecordDirectoryBindingForCurrentOperation(
      shared,
      evidenceRef,
      resolvedDirectoryPath,
      replaceCurrentPathBinding
    );
    return shared;
  }

  const admitted = recordDirectoryPathnameBindingFromStat(
    resolvedDirectoryPath,
    observedDirectory,
    bindingKind
  );
  if (!bindings) {
    bindings = new Set();
    sharedRecordDirectoryPathnameBindings.set(key, bindings);
  }
  bindings.add(admitted);
  try {
    retainRecordDirectoryBindingForCurrentOperation(
      admitted,
      evidenceRef,
      resolvedDirectoryPath,
      replaceCurrentPathBinding
    );
    return admitted;
  } catch (error) {
    bindings.delete(admitted);
    if (bindings.size === 0) sharedRecordDirectoryPathnameBindings.delete(key);
    admitted.state = "retired";
    throw error;
  }
}

function recordDirectoryPhysicalIdentityKey(
  identity: WorkspaceRecordPhysicalIdentity
): string {
  return `${identity.dev.toString()}:${identity.ino.toString()}`;
}

function recordDirectoryPathnameBindingFromStat(
  directoryPath: string,
  directory: BigIntStats,
  kind: RecordDirectoryPathnameBinding["kind"]
): RecordDirectoryPathnameBinding {
  return {
    kind,
    paths: new Set([resolve(directoryPath)]),
    dev: directory.dev,
    ino: directory.ino,
    ctimeNs: directory.ctimeNs,
    mtimeNs: directory.mtimeNs,
    mutationSequence: nextRecordDirectoryPathnameBindingSequence++,
    mutationLocked: false,
    mutationWaiters: [],
    mutationCapabilities: new Map(),
    holders: 0,
    retirementRequested: false,
    state: "active"
  };
}

function recordDirectoryPathnameBindingMatchesPath(
  directoryPath: string,
  expected: RecordDirectoryPathnameBinding
): boolean {
  return expected.paths.has(resolve(directoryPath));
}

function recordDirectoryPathnameBindingMatchesStat(
  observed: BigIntStats,
  expected: RecordDirectoryPathnameBinding
): boolean {
  return (
    expected.state === "active" &&
    (!expected.retirementRequested ||
      expected.terminalOperation === recordDirectoryBindingOperationStorage.getStore()) &&
    workspaceRecordPhysicalIdentityMatches(observed, expected) &&
    observed.ctimeNs === expected.ctimeNs &&
    observed.mtimeNs === expected.mtimeNs
  );
}

function recordDirectoryBindingForCurrentOperation(
  directoryPath: string
): RecordDirectoryPathnameBinding | undefined {
  const operation = recordDirectoryBindingOperationStorage.getStore();
  if (!operation || operation.state !== "active") return undefined;
  return operation.bindingsByPath.get(resolve(directoryPath));
}

function retainRecordDirectoryPathnameBinding(
  binding: RecordDirectoryPathnameBinding,
  evidenceRef: string,
  allowRetiring = false
): () => void {
  const operation = recordDirectoryBindingOperationStorage.getStore();
  if (
    binding.state !== "active" ||
    (binding.retirementRequested &&
      (!allowRetiring || binding.terminalOperation !== operation)) ||
    !sharedRecordDirectoryPathnameBindings.get(
      recordDirectoryPhysicalIdentityKey(binding)
    )?.has(binding)
  ) {
    throw publicationStateError(evidenceRef);
  }
  binding.holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    binding.holders -= 1;
    maybeRetireRecordDirectoryPathnameBinding(binding);
  };
}

function retainRecordDirectoryBindingForCurrentOperation(
  binding: RecordDirectoryPathnameBinding,
  evidenceRef: string,
  directoryPath: string,
  replaceCurrentPathBinding = false
): void {
  const operation = recordDirectoryBindingOperationStorage.getStore();
  if (!operation || operation.state !== "active") {
    throw publicationStateError(evidenceRef);
  }
  const resolvedDirectoryPath = resolve(directoryPath);
  const existingPathBinding = operation.bindingsByPath.get(resolvedDirectoryPath);
  if (
    existingPathBinding &&
    existingPathBinding !== binding &&
    !replaceCurrentPathBinding
  ) {
    throw publicationStateError(evidenceRef);
  }
  if (operation.bindings.has(binding)) {
    operation.bindingsByPath.set(resolvedDirectoryPath, binding);
    return;
  }
  const release = retainRecordDirectoryPathnameBinding(binding, evidenceRef);
  operation.bindings.set(binding, release);
  operation.bindingsByPath.set(resolvedDirectoryPath, binding);
}

function maybeRetireRecordDirectoryPathnameBinding(
  binding: RecordDirectoryPathnameBinding
): void {
  if (
    binding.state !== "active" ||
    binding.holders !== 0 ||
    binding.mutationLocked ||
    binding.mutationWaiters.length !== 0 ||
    binding.mutationCapabilities.size !== 0
  ) {
    return;
  }
  binding.state = "retired";
  const key = recordDirectoryPhysicalIdentityKey(binding);
  const bindings = sharedRecordDirectoryPathnameBindings.get(key);
  bindings?.delete(binding);
  if (bindings?.size === 0) sharedRecordDirectoryPathnameBindings.delete(key);
}

function recordDirectoryPathnameBindingMatchesAtProof(
  observed: BigIntStats,
  expected: RecordDirectoryPathnameBinding
): boolean {
  return recordDirectoryPathnameBindingMatchesStat(observed, expected);
}

async function captureSafeRecordDirectoryBaseline(
  directoryPath: string,
  evidenceRef: string
): Promise<SafeRecordDirectoryBaseline> {
  try {
    const scoped = recordDirectoryBindingForCurrentOperation(directoryPath);
    if (scoped) {
      await runWithRecordDirectoryMutationLocks(
        [scoped],
        async () =>
          await assertRecordDirectoryIdentityNow(
            directoryPath,
            scoped,
            evidenceRef
          )
      );
      return { status: "existing", identity: scoped };
    }
    const inspection = await inspectSafeExistingDirectoryPath(directoryPath);
    if (inspection.status === "missing") return { status: "absent" };
    if (inspection.status === "unsafe") throw publicationStateError(evidenceRef);
    const directory = inspection.entry;
    const identity = await admitObservedRecordDirectoryIdentity(
      directoryPath,
      directory,
      evidenceRef
    );
    if (!identity) throw publicationStateError(evidenceRef);
    return {
      status: "existing",
      identity
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
  await assertRecordDirectoryIdentity(directoryPath, expected.identity, evidenceRef);
}

async function assertRecordDirectoryIdentity(
  directoryPath: string,
  expectedDirectory: RecordDirectoryPathnameBinding,
  evidenceRef: string
): Promise<void> {
  await runWithRecordDirectoryMutationLocks([expectedDirectory], async () => {
    await assertRecordDirectoryIdentityFullyNow(
      directoryPath,
      expectedDirectory,
      evidenceRef
    );
  });
}

async function assertRecordDirectoryIdentityFullyNow(
  directoryPath: string,
  expectedDirectory: RecordDirectoryPathnameBinding,
  evidenceRef: string
): Promise<void> {
  const observed = await readSafeExistingDirectoryEntry(directoryPath);
  if (
    observed &&
    recordDirectoryPathnameBindingMatchesPath(directoryPath, expectedDirectory) &&
    recordDirectoryPathnameBindingMatchesAtProof(observed, expectedDirectory)
  ) {
    return;
  }
  throw publicationStateError(evidenceRef);
}

async function assertRecordDirectoryIdentityNow(
  directoryPath: string,
  expectedDirectory: RecordDirectoryPathnameBinding,
  evidenceRef: string
): Promise<void> {
  const observed = await readSafeDirectoryLeafEntry(directoryPath);
  if (
    observed &&
    recordDirectoryPathnameBindingMatchesPath(directoryPath, expectedDirectory) &&
    recordDirectoryPathnameBindingMatchesAtProof(observed, expectedDirectory)
  ) {
    return;
  }
  throw publicationStateError(evidenceRef);
}

function recordDirectoryPathnameBindingMatches(
  observed: OwnedTemporaryRecordIdentity & { ctimeNs: bigint; mtimeNs: bigint },
  expected: RecordDirectoryPathnameBinding
): boolean {
  return (
    expected.state === "active" &&
    workspaceRecordPhysicalIdentityMatches(observed, expected) &&
    observed.ctimeNs === expected.ctimeNs &&
    observed.mtimeNs === expected.mtimeNs
  );
}

async function advanceRecordDirectoryPathnameEpoch(
  directoryPath: string,
  expectedDirectory: RecordDirectoryPathnameBinding,
  evidenceRef: string
): Promise<void> {
  const observed = await readSafeDirectoryLeafEntry(directoryPath);
  if (!recordDirectoryPathnameBindingMatchesPath(directoryPath, expectedDirectory)) {
    throw publicationStateError(evidenceRef);
  }
  assertRecordDirectoryPathnameEpochCanAdvance(
    observed,
    expectedDirectory,
    evidenceRef
  );
  advanceRecordDirectoryPathnameEpochFromStat(observed!, expectedDirectory);
}

function assertRecordDirectoryPathnameEpochCanAdvance(
  observed: BigIntStats | undefined,
  expectedDirectory: RecordDirectoryPathnameBinding,
  evidenceRef: string
): void {
  if (
    expectedDirectory.state !== "active" ||
    !observed ||
    !workspaceRecordPhysicalIdentityMatches(observed, expectedDirectory)
  ) throw publicationStateError(evidenceRef);
}

function advanceRecordDirectoryPathnameEpochFromStat(
  observed: BigIntStats,
  expectedDirectory: RecordDirectoryPathnameBinding
): void {
  expectedDirectory.ctimeNs = observed.ctimeNs;
  expectedDirectory.mtimeNs = observed.mtimeNs;
}

function acquireRecordDirectoryMutationLock(
  binding: RecordDirectoryPathnameBinding
): (() => void) | Promise<() => void> {
  const operation = recordDirectoryBindingOperationStorage.getStore();
  const releaseHolder = retainRecordDirectoryPathnameBinding(
    binding,
    "workspace_record_directory_mutation",
    Boolean(operation?.bindings.has(binding))
  );
  const wrapRelease = (releaseLock: () => void): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseLock();
      releaseHolder();
    };
  };
  if (!binding.mutationLocked) {
    binding.mutationLocked = true;
    return wrapRelease(createRecordDirectoryMutationRelease(binding));
  }
  return new Promise<() => void>((resolve) => {
    binding.mutationWaiters.push((releaseLock) => {
      resolve(wrapRelease(releaseLock));
    });
  });
}

function createRecordDirectoryMutationRelease(
  binding: RecordDirectoryPathnameBinding
): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = binding.mutationWaiters.shift();
    if (next) {
      next(createRecordDirectoryMutationRelease(binding));
    } else {
      binding.mutationLocked = false;
      const capabilityReleases = [...binding.mutationCapabilities.values()];
      binding.mutationCapabilities.clear();
      for (const releaseCapability of capabilityReleases) {
        releaseCapability();
      }
      maybeRetireRecordDirectoryPathnameBinding(binding);
    }
  };
}

function retainRecordDirectoryMutationCapability(
  mutationRoot: RecordDirectoryPathnameBinding,
  binding: RecordDirectoryPathnameBinding,
  evidenceRef: string
): void {
  if (!mutationRoot.mutationLocked) throw publicationStateError(evidenceRef);
  if (mutationRoot.mutationCapabilities.has(binding)) return;
  mutationRoot.mutationCapabilities.set(
    binding,
    retainRecordDirectoryPathnameBinding(binding, evidenceRef)
  );
}

async function runWithRecordDirectoryMutationLocks<T>(
  bindings: readonly RecordDirectoryPathnameBinding[],
  operation: () => Promise<T>
): Promise<T> {
  if (bindings.length === 1 || (bindings.length === 2 && bindings[0] === bindings[1])) {
    const binding = bindings[0]!;
    const admission = acquireRecordDirectoryMutationLock(binding);
    const release = typeof admission === "function" ? admission : await admission;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  if (bindings.length === 2) {
    const left = bindings[0]!;
    const right = bindings[1]!;
    const first = left.mutationSequence < right.mutationSequence ? left : right;
    const second = first === left ? right : left;
    const firstAdmission = acquireRecordDirectoryMutationLock(first);
    const releaseFirst = typeof firstAdmission === "function"
      ? firstAdmission
      : await firstAdmission;
    let releaseSecond: (() => void) | undefined;
    try {
      const secondAdmission = acquireRecordDirectoryMutationLock(second);
      releaseSecond = typeof secondAdmission === "function"
        ? secondAdmission
        : await secondAdmission;
      return await operation();
    } finally {
      releaseSecond?.();
      releaseFirst();
    }
  }
  const orderedBindings = [...new Set(bindings)].sort(
    (left, right) => left.mutationSequence - right.mutationSequence
  );
  const releases: Array<() => void> = [];
  try {
    for (const binding of orderedBindings) {
      const admission = acquireRecordDirectoryMutationLock(binding);
      releases.push(
        typeof admission === "function" ? admission : await admission
      );
    }
    return await operation();
  } finally {
    for (let index = releases.length - 1; index >= 0; index -= 1) {
      releases[index]!();
    }
  }
}

async function runOwnedRecordDirectoryMutation<T>(
  directoryPath: string,
  expectedDirectory: RecordDirectoryPathnameBinding,
  evidenceRef: string,
  mutation: () => Promise<T>
): Promise<T> {
  return await runWithRecordDirectoryMutationLocks([expectedDirectory], async () => {
    await assertRecordDirectoryIdentityNow(
      directoryPath,
      expectedDirectory,
      evidenceRef
    );
    const result = await mutation();
    await advanceRecordDirectoryPathnameEpoch(
      directoryPath,
      expectedDirectory,
      evidenceRef
    );
    return result;
  });
}

async function runOwnedAuthorityNamespaceMutation<T>(
  ownership: OwnedAuthorityNamespace,
  evidenceRef: string,
  mutation: () => Promise<T>
): Promise<T> {
  return await runWithRecordDirectoryMutationLocks(
    [ownership.parentIdentity, ownership.identity],
    async () => {
      await assertAuthorityNamespaceOwnershipNow(ownership, evidenceRef);
      const result = await mutation();
      const observedNamespace = await readSafeDirectoryLeafEntry(ownership.path);
      assertRecordDirectoryPathnameEpochCanAdvance(
        observedNamespace,
        ownership.identity,
        evidenceRef
      );
      advanceRecordDirectoryPathnameEpochFromStat(
        observedNamespace!,
        ownership.identity
      );
      return result;
    }
  );
}

async function runOwnedRecordDirectoryTransferMutation<T>(
  sourceDirectoryPath: string,
  sourceDirectory: RecordDirectoryPathnameBinding,
  destinationDirectoryPath: string,
  destinationDirectory: RecordDirectoryPathnameBinding,
  evidenceRef: string,
  mutation: () => Promise<T>
): Promise<T> {
  return await runWithRecordDirectoryMutationLocks(
    [sourceDirectory, destinationDirectory],
    async () => {
      if (sourceDirectory === destinationDirectory) {
        await assertRecordDirectoryIdentityNow(
          sourceDirectoryPath,
          sourceDirectory,
          evidenceRef
        );
      } else {
        const [observedSource, observedDestination] =
          await readSafeRecordDirectoryTransferPair(
            sourceDirectoryPath,
            destinationDirectoryPath
          );
        if (
          !observedSource ||
          !observedDestination ||
          !recordDirectoryPathnameBindingMatchesAtProof(
            observedSource,
            sourceDirectory
          ) ||
          !recordDirectoryPathnameBindingMatchesAtProof(
            observedDestination,
            destinationDirectory
          )
        ) throw publicationStateError(evidenceRef);
      }
      const result = await mutation();
      if (sourceDirectory === destinationDirectory) {
        await advanceRecordDirectoryPathnameEpoch(
          sourceDirectoryPath,
          sourceDirectory,
          evidenceRef
        );
      } else {
        const [observedSource, observedDestination] =
          await readSafeRecordDirectoryTransferPair(
            sourceDirectoryPath,
            destinationDirectoryPath
          );
        assertRecordDirectoryPathnameEpochCanAdvance(
          observedSource,
          sourceDirectory,
          evidenceRef
        );
        assertRecordDirectoryPathnameEpochCanAdvance(
          observedDestination,
          destinationDirectory,
          evidenceRef
        );
        advanceRecordDirectoryPathnameEpochFromStat(
          observedSource!,
          sourceDirectory
        );
        advanceRecordDirectoryPathnameEpochFromStat(
          observedDestination!,
          destinationDirectory
        );
      }
      return result;
    }
  );
}

async function readSafeRecordDirectoryTransferPair(
  sourceDirectoryPath: string,
  destinationDirectoryPath: string
): Promise<readonly [BigIntStats | undefined, BigIntStats | undefined]> {
  if (dirname(destinationDirectoryPath) === sourceDirectoryPath) {
    const source = await readSafeExistingDirectoryEntry(sourceDirectoryPath);
    const destination = source
      ? await readSafeDirectoryLeafEntry(destinationDirectoryPath)
      : undefined;
    return [source, destination];
  }
  if (dirname(sourceDirectoryPath) === destinationDirectoryPath) {
    const destination = await readSafeExistingDirectoryEntry(destinationDirectoryPath);
    const source = destination
      ? await readSafeDirectoryLeafEntry(sourceDirectoryPath)
      : undefined;
    return [source, destination];
  }
  return await Promise.all([
    readSafeExistingDirectoryEntry(sourceDirectoryPath),
    readSafeExistingDirectoryEntry(destinationDirectoryPath)
  ]);
}

async function readSafeDirectoryLeafEntry(
  path: string
): Promise<BigIntStats | undefined> {
  const inspection = await inspectDirectoryPathEntry(path);
  return inspection.status === "safe" ? inspection.entry : undefined;
}

async function assertAuthorityNamespaceOwnership(
  ownership: OwnedAuthorityNamespace,
  evidenceRef: string
): Promise<void> {
  await runWithRecordDirectoryMutationLocks(
    [ownership.parentIdentity, ownership.identity],
    async () => {
      await assertRecordDirectoryIdentityFullyNow(
        ownership.parentPath,
        ownership.parentIdentity,
        evidenceRef
      );
      await assertAuthorityNamespaceOwnershipNow(ownership, evidenceRef);
    }
  );
}

async function assertAuthorityNamespaceOwnershipNow(
  ownership: OwnedAuthorityNamespace,
  evidenceRef: string
): Promise<void> {
  const parent = await readSafeDirectoryLeafEntry(ownership.parentPath);
  const namespace = parent && dirname(ownership.path) === ownership.parentPath
    ? await readSafeDirectoryLeafEntry(ownership.path)
    : undefined;
  if (
    !parent ||
    !namespace ||
    !recordDirectoryPathnameBindingMatchesPath(
      ownership.parentPath,
      ownership.parentIdentity
    ) ||
    !recordDirectoryPathnameBindingMatchesPath(
      ownership.path,
      ownership.identity
    ) ||
    !recordDirectoryPathnameBindingMatchesAtProof(parent, ownership.parentIdentity) ||
    !recordDirectoryPathnameBindingMatchesAtProof(namespace, ownership.identity) ||
    !hasExactPrivatePermissions(namespace.mode, PRIVATE_NAMESPACE_MODE)
  ) {
    throw publicationStateError(evidenceRef);
  }
}

async function removeExactEmptyAuthorityOwnedMutationNamespace(
  ownership: OwnedAuthorityNamespace,
  evidenceRef: string,
  verifyEmpty = true
): Promise<void> {
  await runWithRecordDirectoryMutationLocks(
    [ownership.parentIdentity, ownership.identity],
    async () => {
      try {
        if (verifyEmpty) {
          await assertAuthorityNamespaceOwnershipNow(ownership, evidenceRef);
          const entries = await readdir(ownership.path);
          if (entries.length !== 0) throw publicationStateError(evidenceRef);
        } else {
          await assertRecordDirectoryIdentityNow(
            ownership.parentPath,
            ownership.parentIdentity,
            evidenceRef
          );
        }
      } catch (error) {
        const proofError = error instanceof TaskServiceError
          ? error
          : publicationStateError(evidenceRef, error);
        authorityNamespaceRemovalProofFailures.add(proofError);
        throw proofError;
      }

      await rmdir(ownership.path);
      try {
        await advanceRecordDirectoryPathnameEpoch(
          ownership.parentPath,
          ownership.parentIdentity,
          evidenceRef
        );
      } finally {
        retireRecordDirectoryPathnameBinding(ownership.identity);
      }
    }
  );
}

function retireRecordDirectoryPathnameBinding(
  binding: RecordDirectoryPathnameBinding
): void {
  if (binding.state === "retired") return;
  binding.retirementRequested = true;
  maybeRetireRecordDirectoryPathnameBinding(binding);
}

async function assertAuthorityNamespaceOwnershipIfPresent(
  ownership: OwnedAuthorityNamespace,
  evidenceRef: string
): Promise<boolean> {
  if (!(await readSafeDirectoryLeafEntry(ownership.path))) return false;
  return await runWithRecordDirectoryMutationLocks(
    [ownership.parentIdentity, ownership.identity],
    async () => {
      const namespace = dirname(ownership.path) === ownership.parentPath
        ? await readSafeDirectoryLeafEntry(ownership.path)
        : undefined;
      if (!namespace) return false;
      const parent = await readSafeExistingDirectoryEntry(ownership.parentPath);
      if (
        !parent ||
        !recordDirectoryPathnameBindingMatchesAtProof(parent, ownership.parentIdentity) ||
        !recordDirectoryPathnameBindingMatchesAtProof(namespace, ownership.identity) ||
        !hasExactPrivatePermissions(namespace.mode, PRIVATE_NAMESPACE_MODE)
      ) {
        throw publicationStateError(evidenceRef);
      }
      return true;
    }
  );
}

async function rebindExactOwnedAuthorityNamespaceForPrivateFinalization(
  ownership: OwnedAuthorityNamespace,
  evidenceRef: string,
  requirePrivateMode = true
): Promise<OwnedAuthorityNamespace> {
  const operation = recordDirectoryBindingOperationStorage.getStore();
  if (
    !operation ||
    operation.state !== "active" ||
    !operation.bindings.has(ownership.parentIdentity) ||
    !operation.bindings.has(ownership.identity)
  ) {
    throw publicationStateError(evidenceRef);
  }
  const parentIdentity = ownership.parentIdentity;
  const identity = await runWithRecordDirectoryMutationLocks(
    [ownership.parentIdentity, ownership.identity],
    async () => {
      const parent = await readSafeExistingDirectoryEntry(ownership.parentPath);
      let namespace: BigIntStats;
      try {
        namespace = await lstat(ownership.path, { bigint: true });
      } catch (error) {
        throw publicationStateError(evidenceRef, error);
      }
      if (
        !parent ||
        ownership.parentIdentity.state !== "active" ||
        (ownership.parentIdentity.retirementRequested &&
          ownership.parentIdentity.terminalOperation !== operation) ||
        !sharedRecordDirectoryPathnameBindings.get(
          recordDirectoryPhysicalIdentityKey(ownership.parentIdentity)
        )?.has(ownership.parentIdentity) ||
        !recordDirectoryPathnameBindingMatchesPath(
          ownership.parentPath,
          ownership.parentIdentity
        ) ||
        !workspaceRecordPhysicalIdentityMatches(parent, ownership.parentIdentity)
      ) {
        throw publicationStateError(evidenceRef);
      }
      if (
        parent.ctimeNs !== ownership.parentIdentity.ctimeNs ||
        parent.mtimeNs !== ownership.parentIdentity.mtimeNs
      ) {
        ownership.parentIdentity.retirementRequested = true;
        ownership.parentIdentity.terminalOperation = operation;
        advanceRecordDirectoryPathnameEpochFromStat(parent, ownership.parentIdentity);
      }
      if (
        ownership.identity.kind !== "owned_namespace" ||
        ownership.identity.state !== "active" ||
        (ownership.identity.retirementRequested &&
          ownership.identity.terminalOperation !== operation) ||
        !sharedRecordDirectoryPathnameBindings.get(
          recordDirectoryPhysicalIdentityKey(ownership.identity)
        )?.has(ownership.identity) ||
        !recordDirectoryPathnameBindingMatchesPath(
          ownership.path,
          ownership.identity
        ) ||
        !namespace.isDirectory() ||
        namespace.isSymbolicLink() ||
        (requirePrivateMode &&
          !hasExactPrivatePermissions(namespace.mode, PRIVATE_NAMESPACE_MODE)) ||
        !workspaceRecordPhysicalIdentityMatches(namespace, ownership.identity)
      ) {
        throw publicationStateError(evidenceRef);
      }
      if (
        namespace.ctimeNs !== ownership.identity.ctimeNs ||
        namespace.mtimeNs !== ownership.identity.mtimeNs
      ) {
        ownership.identity.retirementRequested = true;
        ownership.identity.terminalOperation = operation;
      }
      advanceRecordDirectoryPathnameEpochFromStat(namespace, ownership.identity);
      return ownership.identity;
    }
  );
  const rebound = {
    path: ownership.path,
    parentPath: ownership.parentPath,
    parentIdentity,
    identity
  };
  if (requirePrivateMode) {
    await assertAuthorityNamespaceOwnership(rebound, evidenceRef);
  } else {
    await runWithRecordDirectoryMutationLocks(
      [parentIdentity, identity],
      async () => {
        await assertRecordDirectoryIdentityNow(
          ownership.parentPath,
          parentIdentity,
          evidenceRef
        );
        await assertRecordDirectoryIdentityNow(
          ownership.path,
          identity,
          evidenceRef
        );
      }
    );
  }
  return rebound;
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
      await runOwnedRecordDirectoryMutation(
        ownership.path,
        ownership.identity,
        evidenceRef,
        async () => await chmod(ownership.path, 0o700)
      );
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
  const baseline = await captureCanonicalAuthorityBaseline(recordPath, evidenceRef);
  if (baseline.status === "invalid") throw publicationStateError(evidenceRef);
  return baseline;
}

async function assertReboundCommittedCanonicalAuthority(
  directoryPath: string,
  admittedDirectory: RecordDirectoryPathnameBinding,
  recordPath: string,
  committedBaseline: MutableCanonicalBaseline,
  evidenceRef: string
): Promise<void> {
  const reboundDirectory = await readSafeRecordDirectoryIdentity(
    directoryPath,
    evidenceRef
  );
  if (
    !workspaceRecordPhysicalIdentityMatches(
      reboundDirectory,
      admittedDirectory
    )
  ) {
    throw publicationStateError(evidenceRef);
  }
  await assertRecordDirectoryIdentity(directoryPath, reboundDirectory, evidenceRef);
  await assertMutableCanonicalBaseline(recordPath, committedBaseline, evidenceRef);
}

function captureCanonicalAuthorityBaseline(
  recordPath: string,
  evidenceRef: string
): Promise<CanonicalAuthorityBaseline>;
function captureCanonicalAuthorityBaseline(
  recordPath: string,
  evidenceRef: string,
  reportGenerationDrift: true
): Promise<CanonicalAuthorityBaselineObservation>;
async function captureCanonicalAuthorityBaseline(
  recordPath: string,
  evidenceRef: string,
  reportGenerationDrift = false
): Promise<CanonicalAuthorityBaselineObservation> {
  // A successful no-follow open is the valid-entry observation for this
  // mutation-free authority epoch. Only paths that cannot be opened that way
  // need a separate lstat to preserve their exact invalid baseline.
  let file: RecordFileHandle | undefined;
  try {
    file = await open(recordPath, BOUNDED_NOFOLLOW_READ_OPEN_FLAGS);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return { status: "absent" };
    }
    if (error instanceof TaskServiceError) throw error;
    return await captureInvalidCanonicalAuthorityBaseline(
      recordPath,
      evidenceRef,
      error
    );
  }

  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_SERVICE_RECORD_BYTES)
    ) {
      return canonicalInvalidBaselineFromStat(before);
    }
    const { bytes, after } = await readBoundedOpenFile(file, before);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.size !== before.size
    ) {
      throw publicationStateError(evidenceRef);
    }
    if (after.nlink !== before.nlink) {
      if (reportGenerationDrift && before.nlink === 1n && after.nlink === 0n) {
        return { status: "generation_drift" };
      }
      throw publicationStateError(evidenceRef);
    }
    if (
      after.ctimeNs !== before.ctimeNs ||
      after.mtimeNs !== before.mtimeNs
    ) {
      if (reportGenerationDrift) return { status: "generation_drift" };
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
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef, error);
  } finally {
    await file?.close();
  }
}

async function captureInvalidCanonicalAuthorityBaseline(
  recordPath: string,
  evidenceRef: string,
  openFailure: unknown
): Promise<CanonicalAuthorityBaseline> {
  let entry: BigIntStats;
  try {
    entry = await lstat(recordPath, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return { status: "absent" };
    }
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef, error);
  }
  if (
    entry.isFile() &&
    !entry.isSymbolicLink() &&
    entry.nlink === 1n &&
    entry.size <= BigInt(MAX_SERVICE_RECORD_BYTES)
  ) {
    throw publicationStateError(evidenceRef, openFailure);
  }
  return canonicalInvalidBaselineFromStat(entry);
}

function canonicalInvalidBaselineFromStat(entry: BigIntStats): Extract<
  CanonicalAuthorityBaseline,
  { status: "invalid" }
> {
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

function reserveRecordAuthorityContentionStart(
  mutex: RecordAuthorityMutex
): { predecessor: Promise<void>; release: () => void } {
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const predecessor = mutex.contentionStartTail;
  mutex.contentionStartTail = predecessor.then(
    () => current,
    () => current
  );
  let released = false;
  return {
    predecessor,
    release: () => {
      if (released) return;
      released = true;
      releaseCurrent();
    }
  };
}

function createRecordAuthorityWaiterCancellation(): Readonly<{
  settled: Promise<void>;
  cancel: () => void;
}> {
  let resolveCancellation!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  let cancelled = false;
  return {
    settled,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      resolveCancellation();
    }
  };
}

function recordAuthorityWaiterIsPending(waiter: RecordAuthorityWaiter): boolean {
  return waiter.status === "active" || waiter.status === "ready";
}

function releaseRecordAuthorityWaiterContention(waiter: RecordAuthorityWaiter): void {
  const release = waiter.contentionRelease;
  waiter.contentionRelease = undefined;
  release?.();
}

async function assertMutableCleanupPathAuthority(
  directoryPath: string,
  expectedDirectory: RecordDirectoryPathnameBinding,
  namespacePath: string,
  expectedNamespace: RecordDirectoryPathnameBinding,
  evidenceRef: string
): Promise<void> {
  await runWithRecordDirectoryMutationLocks(
    [expectedDirectory, expectedNamespace],
    async () => {
      await assertRecordDirectoryIdentityNow(
        directoryPath,
        expectedDirectory,
        evidenceRef
      );
      await assertRecordDirectoryIdentityNow(
        namespacePath,
        expectedNamespace,
        evidenceRef
      );
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
          !recordDirectoryPathnameBindingMatchesAtProof(directory, expectedDirectory) ||
          !namespace.isDirectory() ||
          namespace.isSymbolicLink() ||
          !recordDirectoryPathnameBindingMatchesAtProof(namespace, expectedNamespace)
        ) {
          throw publicationStateError(evidenceRef);
        }
      } catch (error) {
        if (error instanceof TaskServiceError) throw error;
        throw publicationStateError(evidenceRef);
      }
    }
  );
}

async function assertFinalMutablePublicationAuthority(
  directoryPath: string,
  expectedDirectory: RecordDirectoryPathnameBinding,
  namespacePath: string,
  expectedNamespace: RecordDirectoryPathnameBinding,
  temporaryPath: string,
  expectedGeneration: OwnedTemporaryRecordIdentity,
  recordPath: string,
  canonicalBaseline: MutableCanonicalBaseline,
  evidenceRef: string,
  expectedBytes: Buffer
): Promise<OwnedGenerationExpectation> {
  await assertMutableCleanupPathAuthority(
    directoryPath,
    expectedDirectory,
    namespacePath,
    expectedNamespace,
    evidenceRef
  );

  let generationExpectation: OwnedGenerationExpectation | undefined;
  try {
    const [namespace, generation] = await Promise.all([
      lstat(namespacePath, { bigint: true }),
      lstat(temporaryPath, { bigint: true })
    ]);
    if (
      !namespace.isDirectory() ||
      namespace.isSymbolicLink() ||
      !hasExactPrivatePermissions(namespace.mode, PRIVATE_NAMESPACE_MODE) ||
      !recordDirectoryPathnameBindingMatches(
        {
          dev: namespace.dev,
          ino: namespace.ino,
          ctimeNs: namespace.ctimeNs,
          mtimeNs: namespace.mtimeNs
        },
        expectedNamespace
      ) ||
      !generation.isFile() ||
      generation.isSymbolicLink() ||
      generation.nlink !== 1n ||
      !hasExactPrivatePermissions(generation.mode, PRIVATE_GENERATION_MODE) ||
      !workspaceRecordPhysicalIdentityMatches(generation, expectedGeneration)
    ) {
      throw publicationStateError(evidenceRef);
    }
    generationExpectation = Object.freeze({
      identity: Object.freeze({ dev: generation.dev, ino: generation.ino }),
      bytes: Buffer.from(expectedBytes),
      mode: generation.mode,
      nlink: generation.nlink
    });
  } catch (error) {
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef);
  }
  await assertMutableCanonicalBaseline(recordPath, canonicalBaseline, evidenceRef);
  if (!generationExpectation) throw publicationStateError(evidenceRef);
  return generationExpectation;
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
      contentionStartTail: Promise.resolve(),
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
  const cancellation = createRecordAuthorityWaiterCancellation();
  let waiter!: RecordAuthorityWaiter;
  const lease = new Promise<RecordAuthorityLease>((resolveLease, rejectLease) => {
    waiter = {
      resolve: resolveLease,
      reject: rejectLease,
      timeout: setTimeout(() => {
        finalizeRecordAuthorityWaiter(existing, waiter, {
          status: "cancelled",
          error: authorityWaitError(evidenceRef)
        });
      }, waitMs),
      status: "active",
      deadline: acquisitionDeadline,
      evidenceRef,
      kind: "ordinary",
      exactPath: identity.exactPath,
      cancellationSettled: cancellation.settled,
      cancelPendingWork: cancellation.cancel
    };
    existing.waiters.add(waiter);
  });
  void lease.catch(() => undefined);
  const contentionStart = hooks?.onAuthorityContention
    ? reserveRecordAuthorityContentionStart(existing)
    : undefined;
  waiter.contentionRelease = contentionStart?.release;
  const setup = (async () => {
    try {
      await contentionStart?.predecessor;
      if (!recordAuthorityWaiterIsPending(waiter)) return;
      const contentionParentBaseline = hooks?.onAuthorityContention
        ? await captureSafeRecordDirectoryBaseline(dirname(recordPath), evidenceRef)
        : undefined;
      const contentionCanonicalBaseline = hooks?.onAuthorityContention
        ? await captureCanonicalAuthorityBaseline(recordPath, evidenceRef)
        : undefined;
      if (!recordAuthorityWaiterIsPending(waiter)) return;
      if (Date.now() >= acquisitionDeadline) throw authorityWaitError(evidenceRef);
      const reproveContentionAuthority = async () => {
        if (!recordAuthorityWaiterIsPending(waiter)) return;
        if (Date.now() >= acquisitionDeadline) throw authorityWaitError(evidenceRef);
        if (contentionParentBaseline) {
          await assertSafeRecordDirectoryBaseline(
            dirname(recordPath),
            contentionParentBaseline,
            evidenceRef
          );
        }
        if (contentionCanonicalBaseline) {
          await assertCanonicalAuthorityBaseline(
            recordPath,
            contentionCanonicalBaseline,
            evidenceRef
          );
        }
        const currentIdentity = await recordAuthorityIdentityCandidates(
          recordPath,
          evidenceRef
        );
        if (!recordAuthorityWaiterIsPending(waiter)) return;
        const candidateMutex = findRecordAuthorityMutex(
          currentIdentity.aliases,
          evidenceRef
        );
        if (
          currentIdentity.exactPath !== waiter.exactPath ||
          candidateMutex !== existing
        ) {
          throw publicationStateError(evidenceRef);
        }
        bindRecordAuthorityAliases(existing, currentIdentity.aliases, evidenceRef);
        if (!recordAuthorityWaiterIsPending(waiter)) return;
        if (Date.now() >= acquisitionDeadline) throw authorityWaitError(evidenceRef);
      };
      if (hooks?.onAuthorityContention) {
        await runAuthorityMutatingCallbackBoundary(
          () => hooks.onAuthorityContention!(
            Object.freeze({ operation, deadline: acquisitionDeadline })
          ),
          reproveContentionAuthority,
          [],
          {
            settled: waiter.cancellationSettled,
            isCancelled: () => !recordAuthorityWaiterIsPending(waiter)
          }
        );
      } else {
        await reproveContentionAuthority();
      }
      releaseRecordAuthorityWaiterContention(waiter);
      if (!recordAuthorityWaiterIsPending(waiter)) return;
      waiter.status = "ready";
      if (!existing.ownerActive) handoffRecordAuthorityLease(existing);
    } catch (error) {
      finalizeRecordAuthorityWaiter(existing, waiter, {
        status: "cancelled",
        error
      });
    } finally {
      releaseRecordAuthorityWaiterContention(waiter);
    }
  })();
  void setup.catch(() => undefined);

  return await lease;
}

async function acquireRecordAuthorityWithCleanupPermit(
  permit: WorkspaceRecordCleanupPermit,
  recordPath: string,
  evidenceRef: string,
  hooks?: WorkspaceRecordPublicationHooks,
  terminalAdmission?: WorkspaceRecordCleanupTerminalAdmission
): Promise<RecordAuthorityLease> {
  const acquisitionDeadline =
    authorityDeadlineStorage.getStore() ?? Date.now() + RECORD_AUTHORITY_ACQUISITION_TIMEOUT_MS;
  const state = cleanupPermitState.get(permit);
  if (
    !state ||
    state.status !== "outstanding" ||
    !state.capacityActive ||
    !state.parentPath ||
    !state.parentIdentity ||
    !state.bindingTimeParentSnapshot ||
    !state.parentBindingRelease ||
    !state.generation ||
    !state.generationExpectation ||
    !state.pathnameBinding ||
    !state.pinnedFile ||
    state.pinnedFileClosed
  ) {
    throw publicationStateError(evidenceRef);
  }
  const expectedCleanupGeneration = Object.freeze({
    dev: state.generation.dev,
    ino: state.generation.ino
  });
  const retainedParentPath = state.parentPath;
  const retainedParentIdentity = state.parentIdentity;
  claimRecordAuthorityCleanupPermit(permit, state);
  if (state.evidenceRef !== evidenceRef) {
    await settleRecordAuthorityCleanupAdmission(permit);
    throw publicationStateError(evidenceRef);
  }
  const wasContended = state.mutex.ownerActive || state.mutex.waiters.size > 0;
  const cancellation = createRecordAuthorityWaiterCancellation();
  let waiter!: RecordAuthorityWaiter;
  const lease = new Promise<RecordAuthorityLease>((resolveLease, rejectLease) => {
    waiter = {
      resolve: resolveLease,
      reject: rejectLease,
      timeout: setTimeout(() => {
        finalizeRecordAuthorityWaiter(state.mutex, waiter, {
          status: "cancelled",
          error: authorityWaitError(evidenceRef)
        });
      }, Math.max(0, acquisitionDeadline - Date.now())),
      status: "active",
      deadline: acquisitionDeadline,
      evidenceRef,
      kind: "cleanup",
      exactPath: state.publicPath,
      cancellationSettled: cancellation.settled,
      cancelPendingWork: cancellation.cancel,
      cleanupPermit: permit,
      expectedCleanupGeneration,
      ...(terminalAdmission ? { cleanupTerminalAdmission: terminalAdmission } : {})
    };
    state.mutex.waiters.add(waiter);
  });
  void lease.catch(() => undefined);
  const contentionStart = wasContended && hooks?.onAuthorityContention
    ? reserveRecordAuthorityContentionStart(state.mutex)
    : undefined;
  waiter.contentionRelease = contentionStart?.release;
  const setup = (async () => {
    try {
      await assertCleanupPermitPinnedGeneration(state, recordPath, evidenceRef);
      if (!recordAuthorityWaiterIsPending(waiter)) return;
      if (hooks?.beforeCleanupPermitIdentityResolution) {
        await runAuthorityMutatingCallbackBoundary(
          () => hooks.beforeCleanupPermitIdentityResolution!(Object.freeze({ path: recordPath })),
          async () => await assertCleanupPermitPinnedGeneration(state, recordPath, evidenceRef),
          [],
          {
            settled: waiter.cancellationSettled,
            isCancelled: () => !recordAuthorityWaiterIsPending(waiter)
          }
        );
      }
      if (!recordAuthorityWaiterIsPending(waiter)) return;
      const identity = await recordAuthorityIdentityCandidates(recordPath, evidenceRef);
      if (!recordAuthorityWaiterIsPending(waiter)) return;
      const candidateMutex = findRecordAuthorityMutex(identity.aliases, evidenceRef);
      await assertCleanupPermitPinnedGeneration(state, recordPath, evidenceRef);
      if (!recordAuthorityWaiterIsPending(waiter)) return;
      if (identity.exactPath !== state.publicPath || candidateMutex !== state.mutex) {
        throw publicationStateError(evidenceRef);
      }
      bindRecordAuthorityAliases(state.mutex, identity.aliases, evidenceRef);
      if (!recordAuthorityWaiterIsPending(waiter)) return;
      if (Date.now() >= acquisitionDeadline) throw authorityWaitError(evidenceRef);
      if (wasContended) {
        await contentionStart?.predecessor;
        if (!recordAuthorityWaiterIsPending(waiter)) return;
        await assertCleanupPermitPinnedGeneration(state, recordPath, evidenceRef);
        if (!recordAuthorityWaiterIsPending(waiter)) return;
        if (Date.now() >= acquisitionDeadline) throw authorityWaitError(evidenceRef);
        const reproveContentionAuthority = async () => {
          if (!recordAuthorityWaiterIsPending(waiter)) return;
          if (
            state.status !== "claimed" ||
            !state.capacityActive ||
            waiter.cleanupPermit !== permit ||
            !workspaceRecordPhysicalIdentityMatches(
              waiter.expectedCleanupGeneration!,
              expectedCleanupGeneration
            )
          ) {
            throw publicationStateError(evidenceRef);
          }
          const finalIdentity = await recordAuthorityIdentityCandidates(
            recordPath,
            evidenceRef
          );
          if (!recordAuthorityWaiterIsPending(waiter)) return;
          const finalMutex = findRecordAuthorityMutex(
            finalIdentity.aliases,
            evidenceRef
          );
          await assertCleanupPermitPinnedGeneration(state, recordPath, evidenceRef);
          if (!recordAuthorityWaiterIsPending(waiter)) return;
          if (finalIdentity.exactPath !== state.publicPath || finalMutex !== state.mutex) {
            throw publicationStateError(evidenceRef);
          }
          bindRecordAuthorityAliases(state.mutex, finalIdentity.aliases, evidenceRef);
          if (!recordAuthorityWaiterIsPending(waiter)) return;
          if (Date.now() >= acquisitionDeadline) throw authorityWaitError(evidenceRef);
        };
        if (hooks?.onAuthorityContention) {
          await runAuthorityMutatingCallbackBoundary(
            () => hooks.onAuthorityContention!(
              Object.freeze({ operation: "delete", deadline: acquisitionDeadline })
            ),
            reproveContentionAuthority,
            [],
            {
              settled: waiter.cancellationSettled,
              isCancelled: () => !recordAuthorityWaiterIsPending(waiter)
            }
          );
        } else {
          await reproveContentionAuthority();
        }
      }
      releaseRecordAuthorityWaiterContention(waiter);
      if (!recordAuthorityWaiterIsPending(waiter)) return;
      waiter.status = "ready";
      if (!state.mutex.ownerActive) handoffRecordAuthorityLease(state.mutex);
    } catch (error) {
      let terminalError = error;
      if (
        terminalAdmission &&
        recordAuthorityWaiterIsPending(waiter) &&
        Date.now() < acquisitionDeadline
      ) {
        try {
          const classification =
            await classifyWorkspaceRecordCleanupPermitGeneration(
              permit,
              terminalAdmission.expected,
              terminalAdmission.authority
            );
          if (
            recordAuthorityWaiterIsPending(waiter) &&
            Date.now() < acquisitionDeadline &&
            classification.status === "same_generation"
          ) {
            waiter.cleanupPermitAdmissionFailure = { value: error };
            releaseRecordAuthorityWaiterContention(waiter);
            waiter.status = "ready";
            if (!state.mutex.ownerActive) {
              handoffRecordAuthorityLease(state.mutex);
            }
            return;
          }
          if (
            classification.status === "missing" ||
            classification.status === "superseded"
          ) {
            terminalError = new WorkspaceRecordCleanupTerminalResultError(
              classification,
              error
            );
          }
        } catch (classificationError) {
          terminalError = preserveWorkspacePrimaryError(error, [classificationError]);
        }
      }
      finalizeRecordAuthorityWaiter(state.mutex, waiter, {
        status: "cancelled",
        error: terminalError
      });
    } finally {
      releaseRecordAuthorityWaiterContention(waiter);
    }
  })();
  void setup.catch(() => undefined);
  const acquiredLease = await lease;
  try {
    if (Date.now() >= acquisitionDeadline) throw authorityWaitError(evidenceRef);
    try {
      await assertCleanupPermitPinnedGeneration(state, recordPath, evidenceRef);
    } catch (error) {
      if (!terminalAdmission) throw error;
      let classification: WorkspaceRecordCleanupPermitGenerationClassification;
      try {
        classification = await classifyWorkspaceRecordCleanupPermitGeneration(
          permit,
          terminalAdmission.expected,
          terminalAdmission.authority
        );
      } catch (classificationError) {
        throw preserveWorkspacePrimaryError(error, [classificationError]);
      }
      if (
        classification.status === "missing" ||
        classification.status === "superseded"
      ) {
        throw new WorkspaceRecordCleanupTerminalResultError(
          classification,
          error
        );
      }
      if (acquiredLease.cleanupPermitAdmissionFailure === undefined) {
        acquiredLease.cleanupPermitAdmissionFailure = { value: error };
      }
    }
    if (Date.now() >= acquisitionDeadline) throw authorityWaitError(evidenceRef);
    retainRecordDirectoryBindingForCurrentOperation(
      retainedParentIdentity,
      evidenceRef,
      retainedParentPath
    );
    return acquiredLease;
  } catch (error) {
    await acquiredLease.release();
    throw error;
  }
}

function createRecordAuthorityLease(
  mutex: RecordAuthorityMutex,
  exactPath: string,
  consumesReservation = true,
  cleanupPermit?: WorkspaceRecordCleanupPermit,
  expectedCleanupGeneration?: WorkspaceRecordPhysicalIdentity,
  cleanupEvidenceRef?: string,
  cleanupPermitAdmissionFailure?: PresentFailure
): RecordAuthorityLease {
  let released = false;
  let releaseSettled: Promise<void> | undefined;
  const cleanupState = cleanupPermit
    ? cleanupPermitState.get(cleanupPermit)
    : undefined;
  return {
    ...(cleanupPermitAdmissionFailure !== undefined
      ? { cleanupPermitAdmissionFailure }
      : {}),
    expectedCleanupGeneration: cleanupState?.generationExpectation,
    expectedCleanupPathnameBinding: cleanupState?.pathnameBinding,
    expectedCleanupParent:
      cleanupState?.parentPath && cleanupState.parentIdentity
        ? Object.freeze({
            path: cleanupState.parentPath,
            identity: cleanupState.parentIdentity
          })
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
        evidenceRef,
        status: "outstanding",
        capacityActive: true,
        pinnedFileClosed: false
      });
      return permit;
    },
    settleOutstandingCleanupPermit: (generation) => {
      return settleRecordAuthorityCleanupPermit(mutex.outstandingCleanupPermit, generation);
    },
    release: () => {
      if (released) {
        return releaseSettled ?? Promise.resolve();
      }
      released = true;

      if (consumesReservation) {
        releaseRecordAuthorityReservation(mutex);
      }
      releaseSettled = settleRecordAuthorityCleanupAdmission(cleanupPermit);
      if (handoffRecordAuthorityLease(mutex)) {
        return releaseSettled;
      }
      mutex.ownerActive = false;
      removeUnusedRecordAuthorityMutex(mutex);
      return releaseSettled;
    }
  };
}

function handoffRecordAuthorityLease(
  mutex: RecordAuthorityMutex
): boolean {
  for (;;) {
    const next = mutex.waiters.values().next().value as RecordAuthorityWaiter | undefined;
    if (!next) return false;
    if (next.status !== "ready") {
      mutex.ownerActive = false;
      return true;
    }
    if (Date.now() >= next.deadline) {
      finalizeRecordAuthorityWaiter(mutex, next, {
        status: "cancelled",
        error: authorityWaitError(next.evidenceRef)
      });
      continue;
    }
    mutex.ownerActive = true;
    if (finalizeRecordAuthorityWaiter(mutex, next, { status: "handed_off" })) {
      return true;
    }
  }
}

type RecordAuthorityWaiterTerminalOutcome =
  | { readonly status: "cancelled"; readonly error: unknown }
  | { readonly status: "handed_off" };

function finalizeRecordAuthorityWaiter(
  mutex: RecordAuthorityMutex,
  waiter: RecordAuthorityWaiter,
  outcome: RecordAuthorityWaiterTerminalOutcome
): boolean {
  if (!recordAuthorityWaiterIsPending(waiter) || !mutex.waiters.delete(waiter)) {
    return false;
  }
  clearTimeout(waiter.timeout);
  releaseRecordAuthorityWaiterContention(waiter);

  if (outcome.status === "handed_off") {
    waiter.status = "handed_off";
    waiter.resolve(
      createRecordAuthorityLease(
        mutex,
        waiter.exactPath,
        waiter.kind === "ordinary",
        waiter.cleanupPermit,
        waiter.expectedCleanupGeneration,
        waiter.evidenceRef,
        waiter.cleanupPermitAdmissionFailure
      )
    );
    return true;
  }

  waiter.status = "finalizing";
  waiter.cancelPendingWork();
  const resourceSettlement = waiter.kind === "ordinary"
    ? (releaseRecordAuthorityReservation(mutex), Promise.resolve())
    : settleRecordAuthorityCleanupAdmission(waiter.cleanupPermit);

  if (!mutex.ownerActive) handoffRecordAuthorityLease(mutex);
  removeUnusedRecordAuthorityMutex(mutex);
  void resourceSettlement.then(
    () => {
      waiter.status = "cancelled";
      waiter.reject(outcome.error);
    },
    () => {
      // Resource settlement is intentionally non-throwing. Preserve the
      // original terminal reason if a platform close implementation violates
      // that contract.
      waiter.status = "cancelled";
      waiter.reject(outcome.error);
    }
  );
  return true;
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
  admittedParentIdentity: RecordDirectoryPathnameBinding
): Promise<void> {
  const state = cleanupPermitState.get(permit);
  if (
    !state ||
    state.status !== "outstanding" ||
    !state.capacityActive ||
    state.parentPath ||
    state.parentIdentity ||
    state.bindingTimeParentSnapshot ||
    state.generation ||
    state.generationExpectation ||
    state.pathnameBinding ||
    state.expectedBytes ||
    state.parentBindingRelease ||
    state.pinnedFile ||
    state.pinnedFileClosed ||
    generation.nlink !== 1n
  ) {
    throw publicationStateError(evidenceRef);
  }
  let pinnedFile: RecordFileHandle | undefined;
  try {
    if (pendingCleanupPermitFileCloses.size > 0) {
      await Promise.all([...pendingCleanupPermitFileCloses]);
    }
    const generationExpectation: OwnedGenerationExpectation = {
      identity: Object.freeze({
        dev: generation.identity.dev,
        ino: generation.identity.ino
      }),
      bytes: Buffer.from(expectedBytes),
      mode: generation.mode,
      nlink: generation.nlink
    };
    const boundGeneration = Object.freeze({
      dev: generation.identity.dev,
      ino: generation.identity.ino
    });
    const expectedBytesForState = Buffer.from(expectedBytes);
    await runWithRecordDirectoryMutationLocks([admittedParentIdentity], async () => {
      await assertRecordDirectoryIdentityNow(
        admittedParentPath,
        admittedParentIdentity,
        evidenceRef
      );
      const openedPinnedFile = await open(
        state.publicPath,
        BOUNDED_NOFOLLOW_READ_OPEN_FLAGS
      );
      pinnedFile = openedPinnedFile;
      const before = await openedPinnedFile.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== generationExpectation.nlink ||
        before.mode !== generationExpectation.mode ||
        !workspaceRecordPhysicalIdentityMatches(before, generationExpectation.identity) ||
        before.size !== BigInt(expectedBytes.length) ||
        before.size > BigInt(MAX_SERVICE_RECORD_BYTES)
      ) {
        throw publicationStateError(evidenceRef);
      }
      const {
        bytes: observedBytes,
        before: beforeRead,
        after
      } = await readBoundedOpenFile(openedPinnedFile, before);
      if (
        !observedBytes.equals(expectedBytes) ||
        !beforeRead.isFile() ||
        beforeRead.nlink !== generationExpectation.nlink ||
        beforeRead.mode !== generationExpectation.mode ||
        beforeRead.dev !== before.dev ||
        beforeRead.ino !== before.ino ||
        beforeRead.size !== before.size ||
        !after.isFile() ||
        after.nlink !== generationExpectation.nlink ||
        after.mode !== beforeRead.mode ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size
      ) {
        throw publicationStateError(evidenceRef);
      }
      const pathnameBinding = await captureCanonicalPathnameBinding(
        state.publicPath,
        generationExpectation,
        generationExpectation.nlink,
        evidenceRef
      );
      await assertRecordDirectoryIdentityNow(
        admittedParentPath,
        admittedParentIdentity,
        evidenceRef
      );
      const bindingTimeParentSnapshot = Object.freeze({
        path: admittedParentPath,
        dev: admittedParentIdentity.dev,
        ino: admittedParentIdentity.ino,
        ctimeNs: admittedParentIdentity.ctimeNs,
        mtimeNs: admittedParentIdentity.mtimeNs
      });
      const parentBindingRelease = retainRecordDirectoryPathnameBinding(
        admittedParentIdentity,
        evidenceRef
      );
      state.parentPath = admittedParentPath;
      state.parentIdentity = admittedParentIdentity;
      state.bindingTimeParentSnapshot = bindingTimeParentSnapshot;
      state.parentBindingRelease = parentBindingRelease;
      state.generation = boundGeneration;
      state.expectedBytes = expectedBytesForState;
      state.generationExpectation = generationExpectation;
      state.pathnameBinding = pathnameBinding;
      state.afterPinnedFileClosed = hooks?.afterCleanupPermitPinnedHandleClosed;
      state.pinnedFile = openedPinnedFile;
      pinnedFile = undefined;
    });
  } catch (error) {
    await pinnedFile?.close().catch(() => undefined);
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef);
  }
}

async function assertCleanupPermitPinnedGeneration(
  state: WorkspaceRecordCleanupPermitState,
  path: string,
  evidenceRef: string
): Promise<void> {
  const parentIdentity = state.parentIdentity;
  if (!parentIdentity) throw publicationStateError(evidenceRef);
  try {
    await runWithRecordDirectoryMutationLocks([parentIdentity], async () => {
      await assertCleanupPermitPinnedGenerationNow(state, path, evidenceRef);
    });
  } catch (error) {
    if (error instanceof TaskServiceError) throw error;
    throw publicationStateError(evidenceRef);
  }
}

async function assertCleanupPermitPinnedGenerationNow(
  state: WorkspaceRecordCleanupPermitState,
  path: string,
  evidenceRef: string
): Promise<void> {
  const pinnedFile = state.pinnedFile;
  const generation = state.generation;
  const expectedBytes = state.expectedBytes;
  const generationExpectation = state.generationExpectation;
  const pathnameBinding = state.pathnameBinding;
  const parentPath = state.parentPath;
  const parentIdentity = state.parentIdentity;
  const bindingTimeParentSnapshot = state.bindingTimeParentSnapshot;
  const parentBindingRelease = state.parentBindingRelease;
  if (
    state.status !== "claimed" ||
    !state.capacityActive ||
    !pinnedFile ||
    !generation ||
    !expectedBytes ||
    !generationExpectation ||
    !pathnameBinding ||
    !parentPath ||
    !parentIdentity ||
    !bindingTimeParentSnapshot ||
    bindingTimeParentSnapshot.path !== parentPath ||
    !workspaceRecordPhysicalIdentityMatches(
      parentIdentity,
      bindingTimeParentSnapshot
    ) ||
    !parentBindingRelease ||
    state.pinnedFileClosed
  ) {
    throw publicationStateError(evidenceRef);
  }
  await assertRecordDirectoryIdentityNow(parentPath, parentIdentity, evidenceRef);
  const pinnedIdentity = await pinnedFile.stat({ bigint: true });
  const observed = await readBoundedOpenFile(pinnedFile, pinnedIdentity);
  if (
    !pinnedIdentity.isFile() ||
    pinnedIdentity.nlink !== generationExpectation.nlink ||
    pinnedIdentity.size !== BigInt(expectedBytes.length) ||
    pinnedIdentity.mode !== generationExpectation.mode ||
    !observed.bytes.equals(expectedBytes) ||
    observed.before.dev !== pinnedIdentity.dev ||
    observed.before.ino !== pinnedIdentity.ino ||
    observed.before.mode !== pinnedIdentity.mode ||
    observed.before.nlink !== pinnedIdentity.nlink ||
    observed.before.size !== pinnedIdentity.size ||
    observed.after.dev !== pinnedIdentity.dev ||
    observed.after.ino !== pinnedIdentity.ino ||
    observed.after.mode !== pinnedIdentity.mode ||
    observed.after.nlink !== pinnedIdentity.nlink ||
    observed.after.size !== pinnedIdentity.size ||
    !workspaceRecordPhysicalIdentityMatches(pinnedIdentity, generation)
  ) {
    throw publicationStateError(evidenceRef);
  }
  await assertCanonicalPathnameBinding(
    path,
    pathnameBinding,
    generationExpectation,
    generationExpectation.nlink,
    evidenceRef
  );
  await assertRecordDirectoryIdentityNow(parentPath, parentIdentity, evidenceRef);
}

function cancelRecordAuthorityCleanupPermit(
  permit: WorkspaceRecordCleanupPermit | undefined
): Promise<void> {
  if (!permit) return Promise.resolve();
  const state = cleanupPermitState.get(permit);
  if (!state || state.status !== "outstanding") return Promise.resolve();
  return settleRecordAuthorityCleanupPermitState(permit, state);
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
): Promise<void> {
  if (!permit) return Promise.resolve();
  const state = cleanupPermitState.get(permit);
  if (
    !state ||
    state.status !== "outstanding" ||
    !state.generation ||
    !workspaceRecordPhysicalIdentityMatches(state.generation, generation)
  ) {
    return Promise.resolve();
  }
  return settleRecordAuthorityCleanupPermitState(permit, state);
}

function settleRecordAuthorityCleanupPermitState(
  permit: WorkspaceRecordCleanupPermit,
  state: NonNullable<ReturnType<typeof cleanupPermitState.get>>
): Promise<void> {
  if (state.status !== "outstanding") {
    return state.pinnedFileClose ?? Promise.resolve();
  }
  state.status = "settled";
  if (state.mutex.outstandingCleanupPermit === permit) {
    state.mutex.outstandingCleanupPermit = undefined;
  }
  return settleRecordAuthorityCleanupAdmissionState(state);
}

function settleRecordAuthorityCleanupAdmission(
  permit: WorkspaceRecordCleanupPermit | undefined
): Promise<void> {
  if (!permit) return Promise.resolve();
  const state = cleanupPermitState.get(permit);
  if (!state) return Promise.resolve();
  return settleRecordAuthorityCleanupAdmissionState(state);
}

function settleRecordAuthorityCleanupAdmissionState(
  state: WorkspaceRecordCleanupPermitState
): Promise<void> {
  if (!state.capacityActive) {
    return state.pinnedFileClose ?? Promise.resolve();
  }
  state.status = "settled";
  state.capacityActive = false;
  state.mutex.cleanupPermits -= 1;
  activeRecordAuthorityCleanupPermits -= 1;
  const closeSettled = closeRecordAuthorityCleanupPermitPinnedFile(state);
  const releaseParentBinding = state.parentBindingRelease;
  state.parentBindingRelease = undefined;
  state.parentPath = undefined;
  state.parentIdentity = undefined;
  state.bindingTimeParentSnapshot = undefined;
  state.generation = undefined;
  state.generationExpectation = undefined;
  state.pathnameBinding = undefined;
  state.expectedBytes = undefined;
  releaseParentBinding?.();
  removeUnusedRecordAuthorityMutex(state.mutex);
  return closeSettled;
}

function closeRecordAuthorityCleanupPermitPinnedFile(
  state: WorkspaceRecordCleanupPermitState
): Promise<void> {
  if (state.pinnedFileClosed) {
    return state.pinnedFileClose ?? Promise.resolve();
  }
  state.pinnedFileClosed = true;
  const pinnedFile = state.pinnedFile;
  state.pinnedFile = undefined;
  if (!pinnedFile) {
    state.pinnedFileClose = Promise.resolve();
    return state.pinnedFileClose;
  }
  const input = Object.freeze({ path: state.publicPath, fd: pinnedFile.fd });
  const afterPinnedFileClosed = state.afterPinnedFileClosed;
  state.afterPinnedFileClosed = undefined;
  const closeSettled = pinnedFile.close().then(
    () => undefined,
    () => undefined
  );
  state.pinnedFileClose = closeSettled;
  pendingCleanupPermitFileCloses.add(closeSettled);
  void closeSettled.finally(() => {
    pendingCleanupPermitFileCloses.delete(closeSettled);
  });
  void closeSettled
    .then(async () => await afterPinnedFileClosed?.(input))
    .catch(() => undefined);
  return closeSettled;
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
    const observed = await physicalAuthorityPathIdentityCandidates(recordPath, evidenceRef);
    const rewritten = publicationHookStorage.getStore()
      ?.rewriteRecordAuthorityIdentityCandidates?.(
        Object.freeze({
          path: recordPath,
          exactPath: observed.exact,
          aliases: observed.aliases
        })
      );
    const candidates = rewritten ?? {
      exactPath: observed.exact,
      aliases: observed.aliases
    };
    const stableRequestedPath = resolve(dirname(recordPath), basename(recordPath));
    const stableAliases = Array.from(new Set([
      stableRequestedPath,
      // Root E (V33-14): the hashed physical-exact identity stays in every
      // alias set so hardlink/physical unification and collision detection
      // survive on case-sensitive filesystems, without moving the FIFO
      // anchor off the requested pathname.
      candidates.exactPath,
      ...candidates.aliases
    ]));
    return {
      // A hardlinked file descriptor can be canonicalized through either link.
      // Keep FIFO identity anchored to the requested pathname while retaining
      // the filesystem-aware shared alias for case-insensitive coordination.
      exactPath: stableRequestedPath,
      aliases: Object.freeze(stableAliases.map(hashRecordAuthorityAlias))
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
  let error: TaskServiceError;
  if (reason === "not_regular_file" || reason === "multiple_links") {
    error = serviceWorkspaceError(
      "record_malformed",
      "Record path is not a safe regular file.",
      "A workspace record cannot be read safely.",
      [evidenceRef],
      cause
    );
  } else if (reason === "too_large") {
    error = serviceWorkspaceError(
      "record_malformed",
      "Record exceeds the M1 bounded read size.",
      "A workspace record is too large to read safely.",
      [evidenceRef],
      cause
    );
  } else if (reason === "parent_not_safe") {
    error = serviceWorkspaceError(
      "record_malformed",
      "Record parent path is not a safe directory.",
      "A workspace record cannot be read safely.",
      [evidenceRef],
      cause
    );
  } else if (reason === "open_failed") {
    error = serviceWorkspaceError(
      "record_malformed",
      "Record cannot be opened safely.",
      "A workspace record cannot be read safely.",
      [evidenceRef],
      cause
    );
  } else if (reason === "read_failed") {
    error = serviceWorkspaceError(
      "record_malformed",
      "Record cannot be read safely.",
      "A workspace record cannot be read safely.",
      [evidenceRef],
      cause
    );
  } else {
    error = serviceWorkspaceError(
      "record_malformed",
      "Record cannot be inspected.",
      "A workspace record cannot be read safely.",
      [evidenceRef],
      cause
    );
  }
  workspaceRecordDurableReadErrors.add(error);
  return error;
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

  if (semanticPrimaryError(cause)) {
    error.cause = cause as Error;
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
): Promise<PreparedJsonRecordWrite<T>> {
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
  const normalizedRecord = reconstructInertJsonRecord<T>(recordText);

  const directoryPath = await ensureWorkspaceRecordDirectoryWithBindingOperation(
    workspaceRoot,
    relativeDirectorySegments,
    evidenceRef
  );
  const directoryIdentity = recordDirectoryBindingForCurrentOperation(directoryPath);
  if (!directoryIdentity) throw publicationStateError(evidenceRef);
  const recordPath = await resolveWorkspaceRecordPath(
    workspaceRoot,
    join(directoryPath, fileName),
    evidenceRef
  );

  return Object.freeze({
    data: normalizedRecord,
    directoryPath,
    directoryIdentity,
    fileName,
    recordPath,
    recordText
  });
}

function serializeJsonRecord<T>(record: T, evidenceRef: string): string {
  const recordText = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(recordText, "utf8") > MAX_SERVICE_RECORD_BYTES) {
    const error = new TaskServiceError({
      code: "record_schema_error",
      status: 400,
      category: "schema_error",
      message: "Workspace record would exceed the M1 bounded size.",
      userMessage: "The record is too large to persist safely.",
      evidenceRefs: [evidenceRef],
      recommendedNextActions: ["Reduce record field sizes and retry."]
    });
    workspaceRecordOversizeErrors.add(error);
    throw error;
  }
  return recordText;
}

function reconstructInertJsonRecord<T>(recordText: string): T {
  // Parsing the already bounded serialized value strips accessors, Proxies,
  // prototypes, functions, and non-enumerable thenable state without rerunning schema code.
  return JSON.parse(recordText) as T;
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

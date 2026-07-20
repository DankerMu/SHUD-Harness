import { randomUUID } from "node:crypto";
import { type BigIntStats, type Dirent } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import {
  InferenceBudgetSchema,
  TaskCardSchema,
  TaskRuntimePhaseSchema,
  TaskStatusSchema,
  TaskTypeSchema,
  type TaskCard
} from "../schemas/task";
import {
  captureFailureFoldEntry,
  failureFoldEntryValue,
  failureLedger,
  isTrustedFailureOccurrence,
  semanticPrimaryError,
  type FailureFoldEntry
} from "./compensation-error-preservation";
import { isPathInsideBoundary } from "./workspace-path-safety";
import {
  preserveTaskServiceErrorFailureEntries,
  taskServiceErrorAtBoundary
} from "./task-service-error-compensation";
import {
  readDurableSingleLinkFile,
  type DurableSingleLinkReadFailureReason
} from "./durable-single-link-reader";
import {
  MAX_SERVICE_RECORD_BYTES as MAX_TASK_SNAPSHOT_BYTES,
  cancelWorkspaceRecordCleanupPermit,
  conditionalDeleteObservedJsonRecordWithCleanupPermit,
  conditionalDeletePublishedJsonRecordGenerationWithCleanupPermit,
  createJsonRecordIfAbsent,
  createJsonRecordIfAbsentWithCleanupPermit,
  ensureWorkspaceDirectoryTree,
  isWorkspaceRecordOversizeError,
  isWorkspaceRecordDurableReadError,
  observeJsonRecordForCleanup,
  refreshWorkspaceRecordCleanupPermitAfterSiblingMutation,
  removeWorkspaceRecordDirectoryIfEmpty,
  settleWorkspaceRecordCleanupPermitAfterExactObservation,
  transferWorkspaceRecordCleanupPermitPublicationAuthority,
  validateWorkspaceRecordCleanupPermitAfterExactObservation,
  workspaceRecordPublicationHooksActive,
  type ConditionalDeleteObservedJsonRecordResult,
  type WorkspaceRecordCleanupPermit,
  type WorkspaceRecordTransferredPinnedFile
} from "./workspace-record-store";

export { MAX_TASK_SNAPSHOT_BYTES };

export const DEFAULT_TASK_CREATED_BY = "pi" as const;
export const DEFAULT_TASK_CURRENT_OWNER = "coordinator" as const;
export const DEFAULT_TASK_REVIEWER = "reviewer" as const;
export const TASK_SNAPSHOT_LATEST_SEQ = 0 as const;

const TASK_ID_PATTERN = /^TASK-[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_TASK_ID_ATTEMPTS = 20;
// M1 skeleton bound: cap workspace/tasks fan-out before opening any task snapshots.
const MAX_TASK_HYDRATION_ENTRIES = 1024;
const MAX_TASK_SNAPSHOT_CACHE_REOBSERVATIONS = 2;
// Root C (V33-12): the read-attempt carrier is a real Error whose `cause`
// transports the semantic reason, so any fold that walks cause/errors graphs
// observes the reason instead of an opaque non-Error wrapper. Consumers keep
// unwrapping `.reason` explicitly, exactly as before.
class TaskSnapshotReadAttemptFailure extends Error {
  constructor(
    readonly authority: "unknown",
    readonly reason: unknown
  ) {
    super("Task snapshot read attempt failed before authority was known.", {
      cause: reason
    });
    this.name = "TaskSnapshotReadAttemptFailure";
  }
}

class TasksRootGenerationChanged extends Error {
  constructor() {
    super("The workspace tasks root changed during bounded hydration.");
    this.name = "TasksRootGenerationChanged";
  }
}

export const CreateTaskInputSchema = z.object({
  type: TaskTypeSchema,
  title: z.string().min(1),
  question_or_goal: z.string().min(1),
  inference_budget: InferenceBudgetSchema,
  created_by: z.string().trim().min(1).optional()
});

export const TaskSnapshotSchema = z.object({
  task_id: z.string().min(1),
  status: TaskStatusSchema,
  runtime_phase: TaskRuntimePhaseSchema.nullable().optional(),
  stack_id: z.string().min(1).optional(),
  data_id: z.string().min(1).optional(),
  linked_jobs: z.array(z.string().min(1)),
  linked_runs: z.array(z.string().min(1)),
  linked_reports: z.array(z.string().min(1)),
  active_analysis_plan_id: z.string().min(1).optional(),
  latest_report_id: z.string().min(1).optional(),
  pending_pi_gates: z.array(z.string().min(1)),
  latest_seq: z.number().int().nonnegative(),
  updated_at: z.string().min(1),
  task_card: TaskCardSchema.optional()
});

export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;

const TASK_SNAPSHOT_CLEANUP_OBSERVATION = Symbol(
  "task_snapshot_cleanup_observation"
);

interface TaskSnapshotCleanupObservationAuthority {
  readonly [TASK_SNAPSHOT_CLEANUP_OBSERVATION]: true;
}

type TaskSnapshotCleanupObservationData =
  | {
      readonly status: "missing";
      readonly taskId: string;
    }
  | {
      readonly status: "record";
      readonly taskId: string;
      readonly task: TaskCard;
    }
  | {
      readonly status: "repairable";
      readonly taskId: string;
      readonly error: TaskServiceError;
    }
  | {
      readonly status: "invalid";
      readonly taskId: string;
      readonly error: TaskServiceError;
    }
  | {
      readonly status: "unknown";
      readonly taskId: string;
      readonly error: TaskServiceError;
    };

export type TaskSnapshotCleanupObservation =
  TaskSnapshotCleanupObservationAuthority & TaskSnapshotCleanupObservationData;

export type TaskServiceErrorCode =
  | "schema_error"
  | "record_schema_error"
  | "record_id_not_safe"
  | "record_not_found"
  | "record_malformed"
  | "idempotency_mismatch"
  | "task_not_found"
  | "task_id_not_safe"
  | "workspace_path_not_safe"
  | "task_lane_not_directory"
  | "task_snapshot_malformed"
  | "task_snapshot_mismatch"
  | "task_snapshot_missing_card"
  | "task_snapshot_too_large"
  | "task_id_generation_failed";

export interface TaskServiceErrorOptions {
  code: TaskServiceErrorCode;
  message: string;
  userMessage: string;
  status: 400 | 404 | 409 | 422 | 500;
  category: string;
  evidenceRefs?: string[];
  retryable?: boolean;
  recommendedNextActions?: string[];
}

const trustedTaskServiceErrors = new WeakSet<TaskServiceError>();
const trustedTaskServiceErrorProxyTargets = new WeakMap<object, TaskServiceError>();

export class TaskServiceError extends Error {
  readonly code: TaskServiceErrorCode;
  readonly status: 400 | 404 | 409 | 422 | 500;
  readonly category: string;
  readonly userMessage: string;
  readonly evidenceRefs: string[];
  readonly retryable: boolean;
  readonly recommendedNextActions: string[];

  constructor(options: TaskServiceErrorOptions) {
    super(options.message);
    this.name = "TaskServiceError";
    this.code = options.code;
    this.status = options.status;
    this.category = options.category;
    this.userMessage = options.userMessage;
    this.evidenceRefs = options.evidenceRefs ?? [];
    this.retryable = options.retryable ?? false;
    this.recommendedNextActions = options.recommendedNextActions ?? [
      "Inspect the workspace task snapshot state before retrying."
    ];
    trustedTaskServiceErrors.add(this);
  }
}

export function trustedTaskServiceErrorTarget(
  value: unknown
): TaskServiceError | undefined {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  if (trustedTaskServiceErrors.has(value as TaskServiceError)) {
    return value as TaskServiceError;
  }
  return trustedTaskServiceErrorProxyTargets.get(value);
}

export function createTrustedTaskServiceErrorProxy<T extends TaskServiceError>(
  target: T,
  handler: ProxyHandler<T> = {}
): T {
  if (!trustedTaskServiceErrors.has(target)) {
    throw new TypeError("A trusted TaskServiceError Proxy requires a constructed TaskServiceError target.");
  }
  const proxy = new Proxy(target, handler);
  trustedTaskServiceErrorProxyTargets.set(proxy, target);
  return proxy;
}

export interface TaskCardServiceOptions {
  workspaceRoot: string;
  now?: () => Date;
  taskIdFactory?: () => string;
  snapshotReadHooks?: TaskSnapshotReadHooks;
  snapshotWriteHooks?: TaskSnapshotWriteHooks;
  cacheDiagnosticsForTest?: (diagnostics: TaskCardCacheDiagnosticsForTest) => void;
}

export interface TaskCardCacheDiagnosticsForTest {
  readonly slots: number;
  readonly activeClaims: number;
}

export interface TaskCardService {
  createTask: (input: CreateTaskInput) => Promise<TaskCard>;
  createTaskForIdempotency: (input: CreateTaskInput) => Promise<TaskCard>;
  releaseTaskPublicationForIdempotency: (task: TaskCard) => Promise<void>;
  rollbackTaskForIdempotency: (taskId: string, expectedTask?: TaskCard) => Promise<void>;
  observeTaskSnapshotForCleanup: (
    taskId: string
  ) => Promise<TaskSnapshotCleanupObservation>;
  acceptTaskSnapshotCleanupObservation: (
    observation: TaskSnapshotCleanupObservation
  ) => Promise<TaskCard>;
  cancelTaskSnapshotCleanupObservation: (
    observation: TaskSnapshotCleanupObservation
  ) => Promise<void>;
  rejectTaskSnapshotCleanupObservation: (
    observation: TaskSnapshotCleanupObservation
  ) => Promise<void>;
  cleanupTaskSnapshotObservation: (
    observation: TaskSnapshotCleanupObservation
  ) => Promise<void>;
  listTasks: () => Promise<TaskCard[]>;
  getTask: (taskId: string) => Promise<TaskCard>;
  getTaskFromSnapshot: (taskId: string) => Promise<TaskCard>;
}

type FileStat = Awaited<ReturnType<typeof lstat>>;

export interface TaskSnapshotReadHookInput {
  snapshotPath: string;
  laneTaskId: string;
}

export interface TaskSnapshotReadHooks {
  beforeSnapshotOpen?: (input: TaskSnapshotReadHookInput) => Promise<void> | void;
  /**
   * Root D (V33-09): fires between the caller's last lane-shape proof and the
   * frozen durable reader's first pathname inspection — the only window where
   * an ENOTDIR-shaped lane swap collapses to a reader "missing" report.
   */
  beforeSnapshotDurableRead?: (
    input: TaskSnapshotReadHookInput
  ) => Promise<void> | void;
  beforeHydrationTasksRootMetadata?: (
    input: Readonly<{ tasksRoot: string }>
  ) => Promise<void> | void;
  lstatTasksRootForHydration?: (
    input: Readonly<{ tasksRoot: string }>
  ) => Promise<BigIntStats>;
}

export interface TaskSnapshotWriteHookInput {
  taskDirectory: string;
  taskId: string;
}

export interface TaskSnapshotWriteHooks {
  beforeSnapshotWrite?: (input: TaskSnapshotWriteHookInput) => Promise<void> | void;
  afterSnapshotWrite?: (input: TaskSnapshotWriteHookInput) => Promise<void> | void;
}

type TaskSnapshotCleanupCondition =
  | { readonly kind: "record"; readonly expected: unknown }
  | { readonly kind: "malformed" };

interface TaskSnapshotCleanupObservationState {
  readonly taskId: string;
  readonly snapshotPath: string;
  readonly evidenceRef: string;
  readonly condition?: TaskSnapshotCleanupCondition;
  readonly cleanupPermit?: WorkspaceRecordCleanupPermit;
  readonly cacheClaim: TaskCardCacheClaim;
  readonly authority: "missing" | "exact" | "unknown";
  readonly error?: TaskServiceError;
  readonly task?: TaskCard;
  status: "outstanding" | "settling" | "settled";
}

type TaskSnapshotCacheSettlement =
  | { readonly status: "current"; readonly task: TaskCard }
  | { readonly status: "changed" }
  | {
      readonly status: "failed";
      readonly error: unknown;
    };

interface TaskCardCacheValue {
  readonly taskId: string;
  readonly task: TaskCard;
}

interface TaskCardCacheSlot {
  readonly taskId: string;
  epoch: number;
  value?: TaskCardCacheValue;
  activeClaims: number;
}

interface TaskCardCacheClaim {
  readonly taskId: string;
  readonly slot: TaskCardCacheSlot;
  readonly epoch: number;
  readonly observed?: TaskCardCacheValue;
}

type TaskCardCacheClaimSettlement =
  | { readonly status: "published"; readonly task?: TaskCard }
  | { readonly status: "equivalent"; readonly task: TaskCard }
  | { readonly status: "cancelled" }
  | { readonly status: "lost"; readonly task?: TaskCard }
  | { readonly status: "already_settled"; readonly task?: TaskCard };

interface TaskCardCache {
  claim: (taskId: string) => TaskCardCacheClaim;
  claimAll: () => ReadonlyMap<string, TaskCardCacheClaim>;
  has: (taskId: string) => boolean;
  get: (taskId: string) => TaskCard | undefined;
  values: () => TaskCard[];
  settleSet: (claim: TaskCardCacheClaim, task: TaskCard) => TaskCardCacheClaimSettlement;
  settleDelete: (claim: TaskCardCacheClaim) => TaskCardCacheClaimSettlement;
  settleCancel: (claim: TaskCardCacheClaim) => TaskCardCacheClaimSettlement;
}

interface HydratedTaskCard {
  readonly task: TaskCard;
  readonly cacheClaim: TaskCardCacheClaim;
}

type TaskSnapshotWithTaskCard = TaskSnapshot & { task_card: TaskCard };

interface ValidatedTaskSnapshotValues {
  readonly canonical: TaskSnapshotWithTaskCard;
  readonly validatedRaw: TaskSnapshotWithTaskCard;
}

type PersistTaskSnapshotResult =
  | "exists"
  | {
      readonly status: "created";
      readonly task: TaskCard;
      readonly publicationAuthority?: TaskPublicationAuthority;
    };

interface TaskPublicationAuthority {
  readonly pinnedFile: WorkspaceRecordTransferredPinnedFile;
  readonly identity: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly ctimeNs: bigint;
    readonly mtimeNs: bigint;
    readonly size: bigint;
    readonly nlink: bigint;
  };
  readonly snapshotPath: string;
  readonly evidenceRef: string;
}

async function retainTaskSnapshotPublicationAuthority(
  cleanupPermit: WorkspaceRecordCleanupPermit,
  snapshotPath: string,
  evidenceRef: string,
  expectedSnapshot: TaskSnapshotWithTaskCard,
  workspaceRoot: string,
  taskId: string
): Promise<TaskPublicationAuthority> {
  let transferred;
  try {
    await refreshWorkspaceRecordCleanupPermitAfterSiblingMutation(
      cleanupPermit,
      snapshotPath,
      evidenceRef
    );
    transferred = await transferWorkspaceRecordCleanupPermitPublicationAuthority(
      cleanupPermit,
      snapshotPath,
      evidenceRef
    );
  } catch (error) {
    const primaryOccurrence = captureFailureFoldEntry("body", error);
    const compensationEntries: FailureFoldEntry[] = [];
    try {
      await conditionalDeletePublishedJsonRecordGenerationWithCleanupPermit(
        cleanupPermit,
        snapshotPath,
        evidenceRef,
        TaskSnapshotSchema,
        { kind: "record", expected: expectedSnapshot, matches: () => true }
      );
    } catch (cleanupError) {
      compensationEntries.push(
        captureFailureFoldEntry("final_release", cleanupError)
      );
    }
    try {
      await removeEmptyTaskLaneAfterRollback(workspaceRoot, taskId);
    } catch (cleanupError) {
      compensationEntries.push(
        captureFailureFoldEntry("final_release", cleanupError)
      );
    }
    if (compensationEntries.length > 0) {
      // Root C (V33-05 residue): fold through the preservation protocol so no
      // future fold above this site can adopt a bare AggregateError as the
      // semantic primary.
      throw preserveTaskServiceErrorFailureEntries(
        primaryOccurrence,
        compensationEntries,
        "Task snapshot publication authority transfer and compensation failed.",
      );
    }
    throw error;
  }
  const identity = transferred.identity;
  return Object.freeze({
    pinnedFile: transferred.pinnedFile,
    identity: Object.freeze({
      dev: identity.dev,
      ino: identity.ino,
      ctimeNs: identity.ctimeNs,
      mtimeNs: identity.mtimeNs,
      size: identity.size,
      nlink: identity.nlink
    }),
    snapshotPath,
    evidenceRef
  });
}

const TaskSnapshotCleanupRawSchema = z.unknown();

function foldTaskSnapshotSettlementErrors(
  entries: readonly FailureFoldEntry[]
): Error | undefined {
  if (entries.length === 0) return undefined;
  if (entries.length === 1 && isTrustedFailureOccurrence(entries[0])) {
    const value = entries[0].value;
    const exactError = semanticPrimaryError(value);
    if (exactError !== undefined && exactError === value) return exactError;
  }
  return preserveTaskServiceErrorFailureEntries(
    entries[0]!,
    entries.slice(1),
    "Task snapshot exact settlement and bounded cache rehydration failed."
  ) as Error;
}

function presentWorkspaceErrorCause(cause: Error | undefined): [] | [Error] {
  return cause === undefined ? [] : [cause];
}

function copyTaskCard(task: TaskCard): TaskCard {
  return {
    ...task,
    inference_budget: { ...task.inference_budget },
    linked_jobs: [...task.linked_jobs],
    linked_reports: [...task.linked_reports],
    ...(task.theory_bundle_ids === undefined
      ? {}
      : { theory_bundle_ids: [...task.theory_bundle_ids] })
  };
}

function createTaskCardCache(
  diagnosticsSink?: (diagnostics: TaskCardCacheDiagnosticsForTest) => void
): TaskCardCache {
  const slots = new Map<string, TaskCardCacheSlot>();
  const openClaims = new WeakSet<TaskCardCacheClaim>();
  let nextEpoch = 0;

  const publishDiagnostics = (): void => {
    if (!diagnosticsSink) return;
    try {
      const observation: unknown = (
        diagnosticsSink as (
          diagnostics: TaskCardCacheDiagnosticsForTest
        ) => unknown
      )(Object.freeze({
        slots: slots.size,
        activeClaims: Array.from(slots.values()).reduce(
          (total, slot) => total + slot.activeClaims,
          0
        )
      }));
      if (
        observation !== null &&
        (typeof observation === "object" || typeof observation === "function") &&
        "then" in observation &&
        typeof observation.then === "function"
      ) {
        void Promise.resolve(observation).catch(() => undefined);
      }
    } catch {
      // Diagnostics are deliberately observation-only.
    }
  };

  const currentTask = (taskId: string): TaskCard | undefined =>
    slots.get(taskId)?.value?.task;
  const getOrCreateSlot = (taskId: string): TaskCardCacheSlot => {
    const existing = slots.get(taskId);
    if (existing) return existing;
    const slot: TaskCardCacheSlot = {
      taskId,
      epoch: ++nextEpoch,
      activeClaims: 0
    };
    slots.set(taskId, slot);
    return slot;
  };
  const pruneEmptySlot = (slot: TaskCardCacheSlot): void => {
    if (
      slot.value === undefined &&
      slot.activeClaims === 0 &&
      slots.get(slot.taskId) === slot
    ) {
      slots.delete(slot.taskId);
    }
  };
  const claim = (taskId: string): TaskCardCacheClaim => {
    const slot = getOrCreateSlot(taskId);
    slot.activeClaims += 1;
    const observed = slot.value;
    const operationClaim = Object.freeze({
      taskId,
      slot,
      epoch: slot.epoch,
      ...(observed === undefined ? {} : { observed })
    });
    openClaims.add(operationClaim);
    publishDiagnostics();
    return operationClaim;
  };
  const beginSettlement = (
    operationClaim: TaskCardCacheClaim
  ): TaskCardCacheSlot | undefined => {
    if (!openClaims.has(operationClaim)) return undefined;
    openClaims.delete(operationClaim);
    operationClaim.slot.activeClaims -= 1;
    return operationClaim.slot;
  };
  const claimStillOwnsSlotEpoch = (operationClaim: TaskCardCacheClaim): boolean =>
    slots.get(operationClaim.taskId) === operationClaim.slot &&
    operationClaim.slot.epoch === operationClaim.epoch;
  const finishSettlement = (slot: TaskCardCacheSlot): void => {
    pruneEmptySlot(slot);
    publishDiagnostics();
  };

  publishDiagnostics();

  return {
    claim(taskId) {
      return claim(taskId);
    },

    claimAll() {
      return new Map(
        Array.from(slots.values())
          .filter((slot) => slot.value !== undefined)
          .map((slot) => [slot.taskId, claim(slot.taskId)])
      );
    },

    has(taskId) {
      return slots.get(taskId)?.value !== undefined;
    },

    get(taskId) {
      return slots.get(taskId)?.value?.task;
    },

    values() {
      return Array.from(slots.values())
        .map((slot) => slot.value?.task)
        .filter((task): task is TaskCard => task !== undefined);
    },


    settleSet(operationClaim, task) {
      const slot = beginSettlement(operationClaim);
      if (!slot) {
        return { status: "already_settled", task: currentTask(operationClaim.taskId) };
      }
      if (claimStillOwnsSlotEpoch(operationClaim)) {
        const current = slot.value?.task;
        if (current && taskCardsEquivalent(current, task)) {
          finishSettlement(slot);
          return { status: "equivalent", task: current };
        }
        slot.epoch = ++nextEpoch;
        slot.value = Object.freeze({ taskId: operationClaim.taskId, task });
        finishSettlement(slot);
        return { status: "published", task };
      }
      const current = currentTask(operationClaim.taskId);
      finishSettlement(slot);
      if (current && taskCardsEquivalent(current, task)) {
        return { status: "equivalent", task: current };
      }
      return { status: "lost", ...(current === undefined ? {} : { task: current }) };
    },

    settleDelete(operationClaim) {
      const slot = beginSettlement(operationClaim);
      if (!slot) {
        return { status: "already_settled", task: currentTask(operationClaim.taskId) };
      }
      if (claimStillOwnsSlotEpoch(operationClaim)) {
        slot.value = undefined;
        slot.epoch = ++nextEpoch;
        finishSettlement(slot);
        return { status: "published" };
      }
      const current = currentTask(operationClaim.taskId);
      finishSettlement(slot);
      return { status: "lost", ...(current === undefined ? {} : { task: current }) };
    },

    settleCancel(operationClaim) {
      const slot = beginSettlement(operationClaim);
      if (!slot) {
        return { status: "already_settled", task: currentTask(operationClaim.taskId) };
      }
      const current = currentTask(operationClaim.taskId);
      const ownsEpoch = claimStillOwnsSlotEpoch(operationClaim);
      finishSettlement(slot);
      if (ownsEpoch && operationClaim.observed === slot.value) {
        return current
          ? { status: "equivalent", task: current }
          : { status: "cancelled" };
      }
      return { status: "lost", ...(current === undefined ? {} : { task: current }) };
    }
  };
}

function taskCardsEquivalent(left: TaskCard, right: TaskCard): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createTaskCardService(options: TaskCardServiceOptions): TaskCardService {
  const workspaceRoot = resolve(options.workspaceRoot);
  const now = options.now ?? (() => new Date());
  const taskIdFactory = options.taskIdFactory ?? (() => `TASK-${randomUUID()}`);
  const snapshotReadHooks = options.snapshotReadHooks;
  const snapshotWriteHooks = options.snapshotWriteHooks;
  const taskCache = createTaskCardCache(options.cacheDiagnosticsForTest);
  const reservedTaskIds = new Set<string>();
  const cleanupObservations = new WeakMap<
    TaskSnapshotCleanupObservation,
    TaskSnapshotCleanupObservationState
  >();
  const idempotentPublicationAuthorities = new WeakMap<
    TaskCard,
    TaskPublicationAuthority
  >();
  let hydration: Promise<void> | undefined;

  async function publishTaskCacheClaimWithBoundedReobservation(
    taskId: string,
    initialClaim: TaskCardCacheClaim,
    initialTask: { readonly canonical: TaskCard; readonly validatedRaw: TaskCard }
  ): Promise<{ readonly canonical: TaskCard; readonly validatedRaw: TaskCard }> {
    const reobservationErrors: FailureFoldEntry[] = [];
    const initialSettlement = taskCache.settleSet(initialClaim, initialTask.canonical);
    if (
      initialSettlement.status === "published" ||
      initialSettlement.status === "equivalent"
    ) {
      return initialTask;
    }

    for (
      let attempt = 0;
      attempt < MAX_TASK_SNAPSHOT_CACHE_REOBSERVATIONS;
      attempt += 1
    ) {
      const claim = taskCache.claim(taskId);
      try {
        const task = await readTaskCardFromSnapshot(
          workspaceRoot,
          taskId,
          snapshotReadHooks
        );
        if (claim.observed && taskCardsEquivalent(claim.observed.task, task.canonical)) {
          const cancellation = taskCache.settleCancel(claim);
          if (cancellation.status === "equivalent") return task;
          continue;
        }
        const settlement = taskCache.settleSet(claim, task.canonical);
        if (
          settlement.status === "published" ||
          settlement.status === "equivalent"
        ) {
          return task;
        }
      } catch (error) {
        taskCache.settleCancel(claim);
        // Root C (V33-12): the read-attempt carrier is itself an Error whose
        // `cause` is the semantic reason, so the fold below stays transparent
        // while the carrier keeps its `.reason` transport channel.
        reobservationErrors.push(captureFailureFoldEntry("settlement", error));
      }
    }

    throw workspaceError(
      "workspace_path_not_safe",
      "Failed to publish a durably observed task into the local cache.",
      "The task snapshot could not be made locally visible safely.",
      [taskSnapshotEvidenceRef(taskId), "snapshot.bytes"],
      ...presentWorkspaceErrorCause(
        foldTaskSnapshotSettlementErrors(reobservationErrors)
      )
    );
  }

  async function ensureHydrated(): Promise<void> {
    if (!hydration) {
      hydration = hydrateTaskCardCacheFromDisk();
    }

    try {
      await hydration;
    } catch (error) {
      hydration = undefined;
      throw error;
    }
  }

  async function hydrateTaskCardCacheFromDisk(): Promise<void> {
    // Root C (V32-05): one attempt-scoped registry owns every claim hydration
    // creates — the prior-cache snapshot claims and every per-entry claim — so
    // success, mid-batch publication failure, and cancellation all settle
    // every claim exactly once (unsettled remainders are cancelled in the
    // finally below).
    const outstandingClaims = new Set<TaskCardCacheClaim>();
    let priorClaims = new Map<string, TaskCardCacheClaim>();
    let priorClaimsConsumed = true;

    const claimPriorCache = (): void => {
      priorClaims = new Map(taskCache.claimAll());
      for (const claim of priorClaims.values()) outstandingClaims.add(claim);
      priorClaimsConsumed = false;
    };
    claimPriorCache();

    // Root B (V32-02): the cache commit executes inside the hydration attempt
    // under the tasks-root generation proof; a post-commit re-proof drift
    // cancels and restarts the whole attempt within the existing bound.
    const commitHydratedTasks = async (
      hydratedTasks: Map<string, HydratedTaskCard>
    ): Promise<void> => {
      if (priorClaimsConsumed) claimPriorCache();
      priorClaimsConsumed = true;
      for (const { task, cacheClaim } of hydratedTasks.values()) {
        const priorClaim = priorClaims.get(task.task_id);
        if (priorClaim) {
          priorClaims.delete(task.task_id);
          outstandingClaims.delete(priorClaim);
          taskCache.settleCancel(priorClaim);
        }
        outstandingClaims.delete(cacheClaim);
        await publishTaskCacheClaimWithBoundedReobservation(
          task.task_id,
          cacheClaim,
          { canonical: task, validatedRaw: task }
        );
      }
      for (const [taskId, cacheClaim] of priorClaims) {
        priorClaims.delete(taskId);
        outstandingClaims.delete(cacheClaim);
        taskCache.settleDelete(cacheClaim);
      }
    };

    try {
      await hydrateTasksFromDisk(
        workspaceRoot,
        snapshotReadHooks,
        (taskId) => {
          const claim = taskCache.claim(taskId);
          outstandingClaims.add(claim);
          return claim;
        },
        (claim) => {
          outstandingClaims.delete(claim);
          return taskCache.settleCancel(claim);
        },
        commitHydratedTasks
      );
    } catch (error) {
      const attemptFailure = error instanceof TaskSnapshotReadAttemptFailure
        ? error
        : undefined;
      const failure = attemptFailure?.reason ?? error;
      // Root C (V32-04): durable-read failures are unknown — cancel and retain
      // the prior cache. Only exact content evidence may delete, and only the
      // failing lane's entry; unrelated lanes are never invalidated.
      const exactContentLane =
        !attemptFailure &&
        isExactTaskSnapshotContentCandidate(failure) &&
        !isTaskSnapshotDurableReadFailure(failure)
          ? hydrationLaneFailureTaskId(failure)
          : undefined;
      if (exactContentLane !== undefined) {
        const laneClaim = priorClaims.get(exactContentLane);
        if (laneClaim && outstandingClaims.has(laneClaim)) {
          priorClaims.delete(exactContentLane);
          outstandingClaims.delete(laneClaim);
          taskCache.settleDelete(laneClaim);
        }
      }
      throw failure;
    } finally {
      for (const claim of outstandingClaims) {
        taskCache.settleCancel(claim);
      }
      outstandingClaims.clear();
    }
  }

  function registerCleanupObservation(
    publicObservation: TaskSnapshotCleanupObservationData,
    state: Omit<TaskSnapshotCleanupObservationState, "status">
  ): TaskSnapshotCleanupObservation {
    const observation = Object.freeze({
      ...publicObservation,
      [TASK_SNAPSHOT_CLEANUP_OBSERVATION]: true as const
    }) as TaskSnapshotCleanupObservation;
    cleanupObservations.set(observation, { ...state, status: "outstanding" });
    return observation;
  }

  function outstandingCleanupObservationState(
    observation: TaskSnapshotCleanupObservation
  ): TaskSnapshotCleanupObservationState;
  function outstandingCleanupObservationState(
    observation: TaskSnapshotCleanupObservation,
    requireTask: true
  ): TaskSnapshotCleanupObservationState & { readonly task: TaskCard };
  function outstandingCleanupObservationState(
    observation: TaskSnapshotCleanupObservation,
    requireTask = false
  ): TaskSnapshotCleanupObservationState {
    const state = cleanupObservations.get(observation);
    if (!state || state.status !== "outstanding") {
      throw new TypeError(
        "Task snapshot cleanup observation is not owned by this TaskCard service or is already settled."
      );
    }
    if (requireTask && !state.task) {
      throw new TypeError("Only a valid TaskCard cleanup observation can be accepted.");
    }
    state.status = "settling";
    return state;
  }

  async function observeTaskSnapshotForCleanupInternal(
    taskId: string,
    suppliedCacheClaim?: TaskCardCacheClaim,
    snapshotReadHookAlreadyRan = false
  ): Promise<TaskSnapshotCleanupObservation> {
    assertSafeTaskId(taskId, `path.task_id:${taskId}`);
    const cacheClaim = suppliedCacheClaim ?? taskCache.claim(taskId);
    const evidenceRef = taskSnapshotEvidenceRef(taskId);
    const configuredTaskDirectory = join(workspaceRoot, "tasks", taskId);
    let snapshotPath = join(configuredTaskDirectory, "snapshot.json");
    try {
      const taskDirectoryEntry = await maybeLstat(configuredTaskDirectory);
      if (
        taskDirectoryEntry &&
        (!taskDirectoryEntry.isDirectory() ||
          taskDirectoryEntry.isSymbolicLink() ||
          !(await isSafeExistingDirectoryPath(configuredTaskDirectory)))
      ) {
        throw taskLaneNotDirectoryError(taskId);
      }
      const observationWorkspaceRoot = taskDirectoryEntry
        ? await realpath(workspaceRoot)
        : workspaceRoot;
      const taskDirectory = join(observationWorkspaceRoot, "tasks", taskId);
      snapshotPath = join(taskDirectory, "snapshot.json");
      const configuredSnapshotPath = join(configuredTaskDirectory, "snapshot.json");
      assertPathInsideWorkspace(observationWorkspaceRoot, snapshotPath, evidenceRef);
      assertPathInsideWorkspace(workspaceRoot, configuredSnapshotPath, evidenceRef);

      if (!snapshotReadHookAlreadyRan && await maybeLstat(snapshotPath)) {
        await snapshotReadHooks?.beforeSnapshotOpen?.({
          snapshotPath: configuredSnapshotPath,
          laneTaskId: taskId
        });
      }

      const commonState = {
        taskId,
        snapshotPath,
        evidenceRef,
        cacheClaim
      };
      let observed: Awaited<ReturnType<typeof observeJsonRecordForCleanup<unknown>>>;
      try {
        observed = await observeJsonRecordForCleanup(
          snapshotPath,
          evidenceRef,
          TaskSnapshotCleanupRawSchema
        );
      } catch (error) {
        if (!isWorkspaceRecordDurableReadError(error)) throw error;
        return registerCleanupObservation(
          {
            status: "unknown",
            taskId,
            error: unknownTaskSnapshotAuthorityError(taskId, evidenceRef, error)
          },
          {
            ...commonState,
            authority: "unknown",
            error: unknownTaskSnapshotAuthorityError(taskId, evidenceRef, error)
          }
        );
      }

      if (observed.status === "missing") {
        return registerCleanupObservation(
          { status: "missing", taskId },
          { ...commonState, authority: "missing" }
        );
      }

      if (observed.status === "malformed") {
        const error = workspaceError(
          "task_snapshot_malformed",
          "Task snapshot is not valid JSON.",
          "A task snapshot is malformed and recovery has been stopped.",
          [evidenceRef],
          observed.error
        );
        return registerCleanupObservation(
          { status: "invalid", taskId, error },
          {
            ...commonState,
            authority: "exact",
            cleanupPermit: observed.cleanupPermit,
            condition: { kind: "malformed" }
          }
        );
      }

      if (observed.status === "schema_threw") {
        const error = workspaceError(
          "task_snapshot_malformed",
          "Task snapshot schema validation could not complete.",
          "A task snapshot is malformed and recovery has been stopped.",
          [evidenceRef],
          observed.error
        );
        return registerCleanupObservation(
          { status: "invalid", taskId, error },
          {
            ...commonState,
            authority: "exact",
            cleanupPermit: observed.cleanupPermit,
            condition: { kind: "record", expected: undefined }
          }
        );
      }

      const condition = { kind: "record" as const, expected: observed.record };
      try {
        const snapshot = validateRawTaskSnapshot(observed.record, taskId, evidenceRef);
        return registerCleanupObservation(
          { status: "record", taskId, task: snapshot.validatedRaw.task_card },
          {
            ...commonState,
            authority: "exact",
            cleanupPermit: observed.cleanupPermit,
            condition,
            task: snapshot.canonical.task_card
          }
        );
      } catch (error) {
        const validationEntry = captureFailureFoldEntry("body", error);
        const taskServiceError = taskServiceErrorAtBoundary(error);
        if (!taskServiceError) {
          try {
            await cancelWorkspaceRecordCleanupPermit(observed.cleanupPermit);
          } catch (cancellationError) {
            throw foldTaskSnapshotSettlementErrors([
              validationEntry,
              captureFailureFoldEntry("final_release", cancellationError)
            ]);
          }
          throw error;
        }
        return registerCleanupObservation(
          {
            status: taskServiceError.code === "task_snapshot_missing_card" ? "repairable" : "invalid",
            taskId,
            error: taskServiceError
          },
          {
            ...commonState,
            authority: "exact",
            cleanupPermit: observed.cleanupPermit,
            condition
          }
        );
      }
    } catch (error) {
      const authorityError = unknownTaskSnapshotAuthorityError(taskId, evidenceRef, error);
      return registerCleanupObservation(
        { status: "unknown", taskId, error: authorityError },
        {
          taskId,
          snapshotPath,
          evidenceRef,
          cacheClaim,
          authority: "unknown",
          error: authorityError
        }
      );
    }
  }

  async function cancelTaskSnapshotCleanupObservationInternal(
    observation: TaskSnapshotCleanupObservation
  ): Promise<void> {
    const state = outstandingCleanupObservationState(observation);
    try {
      if (state.cleanupPermit) {
        await cancelWorkspaceRecordCleanupPermit(state.cleanupPermit);
      }
    } finally {
      taskCache.settleCancel(state.cacheClaim);
      state.status = "settled";
    }
  }

  async function rejectKnownUnavailableTaskSnapshotObservationInternal(
    observation: TaskSnapshotCleanupObservation,
    reconcileLostDeleteSettlement = true
  ): Promise<void> {
    const state = outstandingCleanupObservationState(observation);
    let cacheMayBeInvalidated = false;
    let lostDeleteSettlement = false;
    try {
      if (state.authority === "unknown" || state.task) {
        throw new TypeError(
          "Only known unavailable task snapshot authority may invalidate a local cache value."
        );
      }
      if (state.cleanupPermit) {
        await cancelWorkspaceRecordCleanupPermit(state.cleanupPermit);
      }
      cacheMayBeInvalidated = true;
    } finally {
      if (cacheMayBeInvalidated) {
        lostDeleteSettlement =
          taskCache.settleDelete(state.cacheClaim).status === "lost";
      } else {
        taskCache.settleCancel(state.cacheClaim);
      }
      state.status = "settled";
    }
    if (lostDeleteSettlement && reconcileLostDeleteSettlement) {
      // Root B (V33-02): a lost delete-settlement means an interleaved
      // publish won the slot epoch; re-prove the durable absence into the
      // cache instead of silently discarding the deletion.
      await reconcileLostTaskSnapshotDeleteSettlement(state.taskId, state.evidenceRef);
    }
  }

  async function acceptTaskSnapshotCleanupObservationInternal(
    observation: TaskSnapshotCleanupObservation
  ): Promise<TaskCard> {
    const settlement = await settleValidTaskSnapshotObservationInCache(observation);
    if (settlement.status === "current") {
      return copyTaskCard(settlement.task);
    }
    const settlementEntry = settlement.status === "failed"
      ? captureFailureFoldEntry("settlement", settlement.error)
      : undefined;

    const rehydrationErrors = await boundedlyRehydrateTaskSnapshotCache(
      observation.taskId
    );
    if (settlement.status === "failed") {
      throw workspaceError(
        "workspace_path_not_safe",
        "Failed to settle the exact observed task snapshot generation.",
        "The task snapshot could not be accepted safely.",
        [taskSnapshotEvidenceRef(observation.taskId), "snapshot.bytes"],
        ...presentWorkspaceErrorCause(
          foldTaskSnapshotSettlementErrors([
            settlementEntry!,
            ...rehydrationErrors
          ])
        )
      );
    }

    throw workspaceError(
      "task_snapshot_mismatch",
      "Observed task snapshot changed before exact cache settlement.",
      "The task snapshot changed before it could be accepted safely.",
      [taskSnapshotEvidenceRef(observation.taskId), "snapshot.bytes"],
      ...presentWorkspaceErrorCause(
        foldTaskSnapshotSettlementErrors(rehydrationErrors)
      )
    );
  }

  async function settleValidTaskSnapshotObservationInCache(
    observation: TaskSnapshotCleanupObservation
  ): Promise<TaskSnapshotCacheSettlement> {
    const state = outstandingCleanupObservationState(observation, true);
    const cleanupPermit = state.cleanupPermit;
    let cacheSettlement: TaskSnapshotCacheSettlement | undefined;
    try {
      if (!cleanupPermit) {
        taskCache.settleCancel(state.cacheClaim);
        return {
          status: "failed",
          error: new TypeError("Valid task snapshot observation is missing its cleanup permit.")
        };
      }

      const settlement = await validateWorkspaceRecordCleanupPermitAfterExactObservation(
        cleanupPermit,
        state.snapshotPath,
        state.evidenceRef,
        () => {
          const publication = taskCache.settleSet(state.cacheClaim, state.task);
          cacheSettlement =
            publication.status === "published" || publication.status === "equivalent"
              ? { status: "current", task: publication.task ?? state.task }
              : { status: "changed" };
        }
      );
      if (settlement.status !== "current") {
        taskCache.settleCancel(state.cacheClaim);
        return { status: "changed" };
      }
      return cacheSettlement ?? {
        status: "failed",
        error: new TypeError("Exact task snapshot acceptance did not settle its cache claim.")
      };
    } catch (error) {
      taskCache.settleCancel(state.cacheClaim);
      return {
        status: "failed",
        error
      };
    } finally {
      state.status = "settled";
    }
  }

  /**
   * Root B (V33-02): shared reconciliation for lost delete-settlements —
   * re-proves the durable state into the cache via the bounded rehydration
   * loop and fails loud when the reconciliation itself cannot complete.
   */
  async function reconcileLostTaskSnapshotDeleteSettlement(
    taskId: string,
    evidenceRef: string
  ): Promise<void> {
    const rehydrationErrors = await boundedlyRehydrateTaskSnapshotCache(taskId);
    if (rehydrationErrors.length > 0) {
      throw workspaceError(
        "workspace_path_not_safe",
        "Failed to reconcile a lost task snapshot delete-settlement.",
        "The removed task snapshot could not be reconciled into the local cache safely.",
        [evidenceRef],
        ...presentWorkspaceErrorCause(
          foldTaskSnapshotSettlementErrors(rehydrationErrors)
        )
      );
    }
  }

  async function boundedlyRehydrateTaskSnapshotCache(
    taskId: string
  ): Promise<FailureFoldEntry[]> {
    const errors: FailureFoldEntry[] = [];
    for (
      let attempt = 0;
      attempt < MAX_TASK_SNAPSHOT_CACHE_REOBSERVATIONS;
      attempt += 1
    ) {
      let observation: TaskSnapshotCleanupObservation | undefined;
      try {
        observation = await observeTaskSnapshotForCleanupInternal(taskId);
        if (observation.status !== "record") {
          if (
            observation.status === "repairable" ||
            observation.status === "invalid" ||
            observation.status === "unknown"
          ) {
            errors.push(captureFailureFoldEntry("settlement", observation.error));
          }
          const ownedObservation = observation;
          observation = undefined;
          try {
            if (ownedObservation.status === "unknown") {
              await cancelTaskSnapshotCleanupObservationInternal(ownedObservation);
            } else {
              // Root B (V33-02): the rehydration loop is itself the
              // reconciler — a nested lost delete-settlement must not recurse.
              await rejectKnownUnavailableTaskSnapshotObservationInternal(
                ownedObservation,
                false
              );
            }
          } catch (error) {
            errors.push(captureFailureFoldEntry("final_release", error));
          }
          return errors;
        }

        const ownedObservation = observation;
        observation = undefined;
        const settlement = await settleValidTaskSnapshotObservationInCache(
          ownedObservation
        );
        if (settlement.status === "current") return errors;
        if (settlement.status === "failed") {
          errors.push(captureFailureFoldEntry("settlement", settlement.error));
        }
      } catch (error) {
        errors.push(captureFailureFoldEntry("settlement", error));
        return errors;
      } finally {
        if (observation) {
          try {
            await cancelTaskSnapshotCleanupObservationInternal(observation);
          } catch (error) {
            errors.push(captureFailureFoldEntry("final_release", error));
          }
        }
      }
    }
    return errors;
  }

  async function cleanupTaskSnapshotObservationInternal(
    observation: TaskSnapshotCleanupObservation
  ): Promise<void> {
    const state = outstandingCleanupObservationState(observation);
    let cacheSettled = false;
    try {
      if (state.authority === "unknown") {
        taskCache.settleCancel(state.cacheClaim);
        cacheSettled = true;
        throw (
          state.error ??
          unknownTaskSnapshotAuthorityError(
            state.taskId,
            state.evidenceRef,
            new Error("Unknown task snapshot authority has no typed diagnostic.")
          )
        );
      }
      let result: ConditionalDeleteObservedJsonRecordResult = { status: "missing" };
      if (state.authority === "exact" && (!state.cleanupPermit || !state.condition)) {
        taskCache.settleCancel(state.cacheClaim);
        cacheSettled = true;
        throw unknownTaskSnapshotAuthorityError(
          state.taskId,
          state.evidenceRef,
          new Error("Exact task snapshot authority is missing its cleanup capability.")
        );
      }
      if (state.cleanupPermit && state.condition) {
        try {
          result = await conditionalDeleteObservedJsonRecordWithCleanupPermit(
            state.cleanupPermit,
            state.snapshotPath,
            state.evidenceRef,
            TaskSnapshotCleanupRawSchema,
            state.condition.kind === "malformed"
              ? { kind: "malformed" }
              : {
                  kind: "record",
                  expected: state.condition.expected,
                  matches: () => true
                }
          );
        } catch (error) {
          throw workspaceError(
            "workspace_path_not_safe",
            "Failed to clean up the observed task snapshot generation.",
            "The task snapshot could not be cleaned up safely.",
            [state.evidenceRef],
            error
          );
        }
      }

      if (result.status === "condition_not_met") {
        taskCache.settleCancel(state.cacheClaim);
        cacheSettled = true;
        const rehydrationErrors = await boundedlyRehydrateTaskSnapshotCache(
          state.taskId
        );
        throw workspaceError(
          "task_snapshot_mismatch",
          "Observed task snapshot no longer satisfies its cleanup condition.",
          "The task snapshot changed before it could be cleaned up safely.",
          [state.evidenceRef],
          ...presentWorkspaceErrorCause(
            foldTaskSnapshotSettlementErrors(rehydrationErrors)
          )
        );
      }

      if (result.status === "superseded") {
        try {
          const successor = await readTaskCardFromSnapshot(
            workspaceRoot,
            state.taskId,
            snapshotReadHooks
          );
          cacheSettled = true;
          await publishTaskCacheClaimWithBoundedReobservation(
            state.taskId,
            state.cacheClaim,
            successor
          );
        } catch (error) {
          throw workspaceError(
            "workspace_path_not_safe",
            "Failed to reconcile a superseding task snapshot generation.",
            "The current task snapshot could not be made locally visible safely.",
            [state.evidenceRef, "snapshot.bytes"],
            error
          );
        }
        return;
      }

      const deleteSettlement = taskCache.settleDelete(state.cacheClaim);
      cacheSettled = true;
      await removeEmptyTaskLaneAfterRollback(workspaceRoot, state.taskId);
      if (deleteSettlement.status === "lost") {
        // Root B (V33-02): an interleaved publish won the slot epoch between
        // the durable deletion and this settlement; re-prove the durable
        // absence into the cache instead of silently discarding it.
        await reconcileLostTaskSnapshotDeleteSettlement(
          state.taskId,
          state.evidenceRef
        );
      }
    } finally {
      if (!cacheSettled) taskCache.settleCancel(state.cacheClaim);
      state.status = "settled";
    }
  }

  async function getTaskFromSnapshotInternal(taskId: string): Promise<TaskCard> {
    assertSafeTaskId(taskId, `path.task_id:${taskId}`);
    const cacheClaim = taskCache.claim(taskId);
    let observation: TaskSnapshotCleanupObservation | undefined;
    try {
      try {
        const task = await readTaskCardFromSnapshot(
          workspaceRoot,
          taskId,
          snapshotReadHooks
        );
        const published = await publishTaskCacheClaimWithBoundedReobservation(
          taskId,
          cacheClaim,
          task
        );
        return copyTaskCard(published.validatedRaw);
      } catch (error) {
        if (error instanceof TaskSnapshotReadAttemptFailure) {
          taskCache.settleCancel(cacheClaim);
          throw error.reason;
        }
        if (!isExactTaskSnapshotContentCandidate(error)) {
          const taskServiceError = taskServiceErrorAtBoundary(error);
          if (taskServiceError?.code === "task_not_found") {
            if (taskCache.settleDelete(cacheClaim).status === "lost") {
              // Root B (V33-02): an interleaved publish won the slot epoch
              // between the durable absence observation and this settlement;
              // re-prove the durable absence into the cache.
              await reconcileLostTaskSnapshotDeleteSettlement(
                taskId,
                taskSnapshotEvidenceRef(taskId)
              );
            }
          } else {
            taskCache.settleCancel(cacheClaim);
          }
          throw error;
        }
      }

      observation = await observeTaskSnapshotForCleanupInternal(taskId, cacheClaim, true);
      if (observation.status === "record") {
        const ownedObservation = observation;
        observation = undefined;
        return await acceptTaskSnapshotCleanupObservationInternal(ownedObservation);
      }
      if (observation.status === "unknown") {
        const authorityError = observation.error;
        const ownedObservation = observation;
        observation = undefined;
        await cancelTaskSnapshotCleanupObservationInternal(ownedObservation);
        throw authorityError;
      }

      const unavailableError = observation.status === "missing"
        ? taskNotFoundError(taskId)
        : observation.error;
      const ownedObservation = observation;
      observation = undefined;
      await rejectKnownUnavailableTaskSnapshotObservationInternal(ownedObservation);
      throw unavailableError;
    } finally {
      if (observation) {
        await cancelTaskSnapshotCleanupObservationInternal(observation);
      }
      taskCache.settleCancel(cacheClaim);
    }
  }

  async function cachedTaskIdStillHasDurableAuthority(taskId: string): Promise<boolean> {
    try {
      await getTaskFromSnapshotInternal(taskId);
      return true;
    } catch (error) {
      if (taskServiceErrorAtBoundary(error)?.code === "task_not_found") {
        return false;
      }
      throw error;
    }
  }

  async function createTaskInternal(
    input: CreateTaskInput,
    retainPublicationAuthority: boolean
  ): Promise<TaskCard> {
    const parsedInput = CreateTaskInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new TaskServiceError({
        code: "schema_error",
        status: 400,
        category: "schema_error",
        message: "Task create input failed schema validation.",
        userMessage: "The task request is missing required fields or contains invalid values.",
        evidenceRefs: toSchemaEvidenceRefs(parsedInput.error)
      });
    }

    await ensureHydrated();

    const timestamp = now().toISOString();
    for (let attempt = 0; attempt < MAX_TASK_ID_ATTEMPTS; attempt += 1) {
      const taskId = taskIdFactory();
      assertSafeTaskId(taskId, `generated_task_id:${taskId}`);
      if (reservedTaskIds.has(taskId)) continue;
      if (
        taskCache.has(taskId) &&
        await cachedTaskIdStillHasDurableAuthority(taskId)
      ) {
        continue;
      }
      if (reservedTaskIds.has(taskId)) continue;
      reservedTaskIds.add(taskId);
      const cacheClaim = taskCache.claim(taskId);
      let publicationAuthority: TaskPublicationAuthority | undefined;
      let bodyOutcome:
        | { readonly status: "returned"; readonly task: TaskCard }
        | { readonly status: "retry" }
        | {
            readonly status: "threw";
            readonly reason: unknown;
            readonly occurrence: FailureFoldEntry;
          };

      try {
        const task: TaskCard = TaskCardSchema.parse({
          task_id: taskId,
          type: parsedInput.data.type,
          status: "created",
          title: parsedInput.data.title,
          question_or_goal: parsedInput.data.question_or_goal,
          created_by: parsedInput.data.created_by ?? DEFAULT_TASK_CREATED_BY,
          current_owner: DEFAULT_TASK_CURRENT_OWNER,
          reviewer: DEFAULT_TASK_REVIEWER,
          inference_budget: parsedInput.data.inference_budget,
          linked_jobs: [],
          linked_reports: [],
          created_at: timestamp,
          updated_at: timestamp
        });

        const publication = await persistTaskSnapshot(
          workspaceRoot,
          task,
          snapshotWriteHooks,
          retainPublicationAuthority
        );
        if (publication === "exists") {
          bodyOutcome = { status: "retry" };
        } else {
          publicationAuthority = publication.publicationAuthority;
          const published = await publishTaskCacheClaimWithBoundedReobservation(
            taskId,
            cacheClaim,
            { canonical: publication.task, validatedRaw: publication.task }
          );
          const returnedTask = copyTaskCard(published.validatedRaw);
          if (publicationAuthority) {
            idempotentPublicationAuthorities.set(returnedTask, publicationAuthority);
            publicationAuthority = undefined;
          }
          bodyOutcome = { status: "returned", task: returnedTask };
        }
      } catch (error) {
        bodyOutcome = {
          status: "threw",
          reason: error,
          occurrence: captureFailureFoldEntry("body", error)
        };
      }
      // Root D (V32-06): settle the descriptor close first-class and run the
      // sibling cleanups regardless of its outcome; a rejected close folds
      // into the preserved primary instead of replacing it.
      let closeRejection:
        | { readonly reason: unknown; readonly occurrence: FailureFoldEntry }
        | undefined;
      if (publicationAuthority) {
        try {
          await publicationAuthority.pinnedFile.close();
        } catch (closeError) {
          closeRejection = {
            reason: closeError,
            occurrence: captureFailureFoldEntry("final_release", closeError)
          };
        }
        publicationAuthority = undefined;
      }
      taskCache.settleCancel(cacheClaim);
      reservedTaskIds.delete(taskId);
      if (bodyOutcome.status === "threw") {
        if (closeRejection) {
          throw preserveTaskServiceErrorFailureEntries(
            bodyOutcome.occurrence,
            [closeRejection.occurrence],
            "Task creation and publication-authority settlement both failed.",
          );
        }
        throw bodyOutcome.reason;
      }
      if (closeRejection) throw closeRejection.reason;
      if (bodyOutcome.status === "returned") return bodyOutcome.task;
      // bodyOutcome.status === "retry": fall through to the next id attempt.
    }

    throw taskIdGenerationFailedError();
  }

  return {
    async createTask(input: CreateTaskInput): Promise<TaskCard> {
      return await createTaskInternal(input, false);
    },

    async createTaskForIdempotency(input: CreateTaskInput): Promise<TaskCard> {
      return await createTaskInternal(input, true);
    },

    async releaseTaskPublicationForIdempotency(task: TaskCard): Promise<void> {
      const authority = idempotentPublicationAuthorities.get(task);
      if (!authority) return;
      // Root D (V32-06): settle the descriptor close before disowning the
      // authority so a rejected close stays re-drivable instead of turning
      // the retry into a silent no-op.
      await authority.pinnedFile.close();
      idempotentPublicationAuthorities.delete(task);
    },

    async rollbackTaskForIdempotency(
      taskId: string,
      expectedTask?: TaskCard
    ): Promise<void> {
      await ensureHydrated();
      assertSafeTaskId(taskId, `path.task_id:${taskId}`);
      const publicationAuthority = expectedTask
        ? idempotentPublicationAuthorities.get(expectedTask)
        : undefined;
      if (publicationAuthority) {
        const cacheClaim = taskCache.claim(taskId);
        let observation: TaskSnapshotCleanupObservation | undefined;
        let bodyOutcome:
          | { readonly status: "returned" }
          | {
              readonly status: "threw";
              readonly reason: unknown;
              readonly occurrence: FailureFoldEntry;
            };
        try {
          await (async (): Promise<void> => {
            observation = await observeTaskSnapshotForCleanupInternal(taskId, cacheClaim);
            if (observation.status === "missing") {
              const ownedObservation = observation;
              observation = undefined;
              await cleanupTaskSnapshotObservationInternal(ownedObservation);
              return;
            }
            const currentIdentity = await lstat(publicationAuthority.snapshotPath, {
              bigint: true
            });
            const originalIdentity = publicationAuthority.identity;
            const sameGeneration =
              currentIdentity.dev === originalIdentity.dev &&
              currentIdentity.ino === originalIdentity.ino &&
              currentIdentity.ctimeNs === originalIdentity.ctimeNs &&
              currentIdentity.mtimeNs === originalIdentity.mtimeNs &&
              currentIdentity.size === originalIdentity.size &&
              currentIdentity.nlink === originalIdentity.nlink;
            if (!sameGeneration) {
              const ownedObservation = observation;
              observation = undefined;
              if (ownedObservation.status === "record") {
                await acceptTaskSnapshotCleanupObservationInternal(ownedObservation);
              } else {
                await cancelTaskSnapshotCleanupObservationInternal(ownedObservation);
              }
              throw workspaceError(
                "task_snapshot_mismatch",
                "Task rollback publication authority no longer matches the durable generation.",
                "The task snapshot lane is not safe to roll back automatically.",
                [publicationAuthority.evidenceRef, "snapshot.bytes"]
              );
            }
            const ownedObservation = observation;
            observation = undefined;
            await cleanupTaskSnapshotObservationInternal(ownedObservation);
          })();
          bodyOutcome = { status: "returned" };
        } catch (error) {
          bodyOutcome = {
            status: "threw",
            reason: error,
            occurrence: captureFailureFoldEntry("body", error)
          };
        }
        // Root D (V32-06): settle the descriptor close first-class, run every
        // sibling cleanup regardless of its outcome, disown the authority only
        // after the close settles, and fold settlement failures around the
        // preserved primary instead of replacing it.
        const compensationEntries: FailureFoldEntry[] = [];
        try {
          await publicationAuthority.pinnedFile.close();
        } catch (closeError) {
          compensationEntries.push(
            captureFailureFoldEntry(
              bodyOutcome.status === "threw" ? "final_release" : "initial_release",
              closeError
            )
          );
        }
        idempotentPublicationAuthorities.delete(expectedTask!);
        if (observation) {
          const ownedObservation = observation;
          observation = undefined;
          try {
            await cancelTaskSnapshotCleanupObservationInternal(ownedObservation);
          } catch (cancellationError) {
            compensationEntries.push(
              captureFailureFoldEntry(
                bodyOutcome.status === "threw"
                  ? "final_release"
                  : compensationEntries.length === 0
                    ? "initial_release"
                    : "settlement",
                cancellationError
              )
            );
          }
        }
        taskCache.settleCancel(cacheClaim);
        if (bodyOutcome.status === "threw") {
          if (compensationEntries.length > 0) {
            throw preserveTaskServiceErrorFailureEntries(
              bodyOutcome.occurrence,
              compensationEntries,
              "Task rollback and publication-authority settlement both failed.",
            );
          }
          throw bodyOutcome.reason;
        }
        if (compensationEntries.length > 0) {
          throw compensationEntries.length === 1
            ? failureFoldEntryValue(compensationEntries[0]!)
            : preserveTaskServiceErrorFailureEntries(
                compensationEntries[0]!,
                compensationEntries.slice(1),
                "Task rollback publication-authority settlement failed.",
              );
        }
        return;
      }
      if (expectedTask && expectedTask.task_id !== taskId) {
        throw workspaceError(
          "task_snapshot_mismatch",
          "Task rollback authority does not match the requested task id.",
          "The task snapshot lane is not safe to roll back automatically.",
          [`workspace/tasks/${taskId}`, "snapshot.task_card"]
        );
      }
      const cachedBeforeClaim = taskCache.get(taskId);
      if (!expectedTask && !cachedBeforeClaim) {
        throw new TaskServiceError({
          code: "task_not_found",
          status: 404,
          category: "not_found",
          message: `Task not found: ${taskId}`,
          userMessage: "The task selected for idempotency rollback does not exist.",
          evidenceRefs: [`path.task_id:${taskId}`],
          recommendedNextActions: ["Inspect the idempotency rollback state before retrying."]
        });
      }
      const cacheClaim = taskCache.claim(taskId);
      const cachedTask = cacheClaim.observed?.task;
      if (
        cachedTask &&
        expectedTask &&
        !taskCardsEquivalent(cachedTask, expectedTask)
      ) {
        taskCache.settleCancel(cacheClaim);
        throw workspaceError(
          "task_snapshot_mismatch",
          "Task rollback authority does not match the in-memory task.",
          "The task snapshot lane is not safe to roll back automatically.",
          [`workspace/tasks/${taskId}`, "snapshot.task_card"]
        );
      }
      const task = expectedTask ?? cachedTask;
      if (!task) {
        taskCache.settleCancel(cacheClaim);
        throw new TaskServiceError({
          code: "task_not_found",
          status: 404,
          category: "not_found",
          message: `Task not found: ${taskId}`,
          userMessage: "The task selected for idempotency rollback does not exist.",
          evidenceRefs: [`path.task_id:${taskId}`],
          recommendedNextActions: ["Inspect the idempotency rollback state before retrying."]
        });
      }

      let observation: TaskSnapshotCleanupObservation | undefined;
      try {
        observation = await observeTaskSnapshotForCleanupInternal(taskId, cacheClaim);
        if (observation.status === "record") {
          if (taskCardsEquivalent(observation.task, task)) {
            const ownedObservation = observation;
            observation = undefined;
            await cleanupTaskSnapshotObservationInternal(ownedObservation);
          } else {
            const ownedObservation = observation;
            observation = undefined;
            await acceptTaskSnapshotCleanupObservationInternal(ownedObservation);
            throw workspaceError(
              "task_snapshot_mismatch",
              "Task rollback authority does not match the durable task snapshot.",
              "The task snapshot lane is not safe to roll back automatically.",
              [`workspace/tasks/${taskId}`, "snapshot.task_card"]
            );
          }
          return;
        }

        if (observation.status !== "missing") {
          const ownedObservation = observation;
          observation = undefined;
          await cleanupTaskSnapshotObservationInternal(ownedObservation);
          return;
        }

        const ownedObservation = observation;
        observation = undefined;
        await cleanupTaskSnapshotObservationInternal(ownedObservation);
      } finally {
        if (observation) {
          await cancelTaskSnapshotCleanupObservationInternal(observation);
        }
        taskCache.settleCancel(cacheClaim);
      }
    },

    async observeTaskSnapshotForCleanup(
      taskId: string
    ): Promise<TaskSnapshotCleanupObservation> {
      return await observeTaskSnapshotForCleanupInternal(taskId);
    },

    async acceptTaskSnapshotCleanupObservation(
      observation: TaskSnapshotCleanupObservation
    ): Promise<TaskCard> {
      return await acceptTaskSnapshotCleanupObservationInternal(observation);
    },

    async cancelTaskSnapshotCleanupObservation(
      observation: TaskSnapshotCleanupObservation
    ): Promise<void> {
      await cancelTaskSnapshotCleanupObservationInternal(observation);
    },

    async rejectTaskSnapshotCleanupObservation(
      observation: TaskSnapshotCleanupObservation
    ): Promise<void> {
      await rejectKnownUnavailableTaskSnapshotObservationInternal(observation);
    },

    async cleanupTaskSnapshotObservation(
      observation: TaskSnapshotCleanupObservation
    ): Promise<void> {
      await cleanupTaskSnapshotObservationInternal(observation);
    },

    async listTasks(): Promise<TaskCard[]> {
      await ensureHydrated();
      return taskCache.values().sort(compareTaskCards).map(copyTaskCard);
    },

    async getTask(taskId: string): Promise<TaskCard> {
      await ensureHydrated();
      assertSafeTaskId(taskId, `path.task_id:${taskId}`);
      const task = taskCache.get(taskId);
      if (!task) {
        throw taskNotFoundError(taskId);
      }

      return copyTaskCard(task);
    },

    async getTaskFromSnapshot(taskId: string): Promise<TaskCard> {
      return await getTaskFromSnapshotInternal(taskId);
    }
  };
}

export function isSafeTaskId(taskId: string): boolean {
  return TASK_ID_PATTERN.test(taskId);
}

function taskIdGenerationFailedError(): TaskServiceError {
  return new TaskServiceError({
    code: "task_id_generation_failed",
    status: 500,
    category: "workspace_error",
    message: "Unable to generate a unique task id.",
    userMessage: "The service could not allocate a new task id.",
    evidenceRefs: ["generated_task_id"]
  });
}

async function hydrateTasksFromDisk(
  workspaceRoot: string,
  snapshotReadHooks: TaskSnapshotReadHooks | undefined,
  claimCacheOperation: (taskId: string) => TaskCardCacheClaim,
  cancelCacheOperation: (claim: TaskCardCacheClaim) => TaskCardCacheClaimSettlement,
  commitHydratedTasks: (tasks: Map<string, HydratedTaskCard>) => Promise<void>
): Promise<void> {
  for (
    let attempt = 0;
    attempt < MAX_TASK_SNAPSHOT_CACHE_REOBSERVATIONS;
    attempt += 1
  ) {
    const attemptClaims: TaskCardCacheClaim[] = [];
    try {
      return await hydrateTasksFromDiskAttempt(
        workspaceRoot,
        snapshotReadHooks,
        (taskId) => {
          const claim = claimCacheOperation(taskId);
          attemptClaims.push(claim);
          return claim;
        },
        commitHydratedTasks
      );
    } catch (error) {
      const claimSettlements = attemptClaims.map(cancelCacheOperation);
      if (!(error instanceof TasksRootGenerationChanged)) throw error;
      if (claimSettlements.some((settlement) => settlement.status === "lost")) {
        throw workspaceError(
          "workspace_path_not_safe",
          "Workspace tasks root and an attempt-local cache claim changed together.",
          "The workspace task inventory could not be reconciled safely.",
          ["workspace/tasks", "workspace/tasks:generation", "task.cache.epoch"],
          error
        );
      }
      // Root E (V33-10, documented disposition): this fail-closed escalation
      // is a deliberate Root B deviation, pinned by S34-P62-14. A lane that
      // was claimed by this attempt and disappeared together with a root
      // generation change is treated as suspicious coupled mutation — the
      // bounded retry is refused so the caller observes the escalation
      // loudly. Availability self-heals: the next gated call hydrates the
      // new root generation from scratch.
      for (const claim of attemptClaims) {
        const snapshotPath = join(workspaceRoot, "tasks", claim.taskId, "snapshot.json");
        if (!(await maybeLstat(snapshotPath))) {
          throw workspaceError(
            "workspace_path_not_safe",
            "A task observed by a changed-root hydration attempt disappeared before retry.",
            "The workspace task inventory could not be reconciled safely.",
            ["workspace/tasks", "workspace/tasks:generation", taskSnapshotEvidenceRef(claim.taskId)],
            error
          );
        }
      }
    }
  }
  throw workspaceError(
    "workspace_path_not_safe",
    "Workspace tasks root changed during every bounded hydration attempt.",
    "The workspace tasks directory could not be observed consistently.",
    ["workspace/tasks", "workspace/tasks:generation"]
  );
}

async function hydrateTasksFromDiskAttempt(
  workspaceRoot: string,
  snapshotReadHooks: TaskSnapshotReadHooks | undefined,
  claimCacheOperation: (taskId: string) => TaskCardCacheClaim,
  commitHydratedTasks: (tasks: Map<string, HydratedTaskCard>) => Promise<void>
): Promise<void> {
  const tasks = new Map<string, HydratedTaskCard>();
  const workspaceEntry = await maybeLstat(workspaceRoot);
  if (!workspaceEntry) {
    // Root B (V32-02): an empty inventory is committed only under an absence
    // witness that is re-proved after the commit; absent-to-created restarts.
    await commitHydratedTasks(tasks);
    if (await maybeLstat(workspaceRoot)) {
      throw new TasksRootGenerationChanged();
    }
    return;
  }
  if (!(await isSafeExistingDirectoryPath(workspaceRoot))) {
    throw workspaceError(
      "workspace_path_not_safe",
      "Configured workspace root is not a safe directory.",
      "The configured workspace root is not usable.",
      ["workspace"]
    );
  }

  const tasksRoot = join(workspaceRoot, "tasks");
  const tasksRootEntry = await lstatTasksRootForHydration(tasksRoot, snapshotReadHooks);
  if (!tasksRootEntry) {
    // Root B (V32-02): re-prove the tasks-root absence witness after the
    // empty commit; a root created during the commit restarts the attempt.
    await commitHydratedTasks(tasks);
    if (await lstatTasksRootForHydration(tasksRoot, snapshotReadHooks)) {
      throw new TasksRootGenerationChanged();
    }
    return;
  }
  if (!(await isSafeExistingDirectoryPath(tasksRoot))) {
    throw workspaceError(
      "workspace_path_not_safe",
      "Workspace tasks root is not a safe directory.",
      "The workspace tasks directory is not usable.",
      ["workspace/tasks"]
    );
  }

  const entries = await readBoundedTaskEntries(tasksRoot);
  // Root E (V33-11): every generation proof consumes the same stat source as
  // the initial expected stats, so a virtualized source stays coherent and
  // drift is injectable at every proof window.
  await assertTasksRootGeneration(tasksRoot, tasksRootEntry, snapshotReadHooks);

  for (const entry of entries) {
    if (!isSafeTaskId(entry.name)) {
      continue;
    }

    const lanePath = join(tasksRoot, entry.name);
    await assertTasksRootGeneration(tasksRoot, tasksRootEntry, snapshotReadHooks);
    assertSafeTaskLaneEntry(entry, lanePath);
    if (!(await isSafeExistingDirectoryPath(lanePath))) {
      throw workspaceError(
        "task_lane_not_directory",
        `Task lane is not a safe directory: ${entry.name}`,
        "A task snapshot lane is blocked by a non-directory filesystem entry.",
        [`workspace/tasks/${entry.name}`]
      );
    }

    const snapshotPath = join(lanePath, "snapshot.json");
    const snapshotEvidenceRef = taskSnapshotEvidenceRef(entry.name);
    if (!(await maybeLstat(snapshotPath))) {
      continue;
    }

    const cacheClaim = claimCacheOperation(entry.name);
    try {
      await snapshotReadHooks?.beforeSnapshotOpen?.({
        snapshotPath,
        laneTaskId: entry.name
      });
    } catch (error) {
      throw new TaskSnapshotReadAttemptFailure("unknown", error);
    }
    await assertTasksRootGeneration(tasksRoot, tasksRootEntry, snapshotReadHooks);
    if (!(await isSafeExistingDirectoryPath(lanePath))) {
      throw workspaceError(
        "task_lane_not_directory",
        `Task lane is not a safe directory: ${entry.name}`,
        "A task snapshot lane is blocked by a non-directory filesystem entry.",
        [`workspace/tasks/${entry.name}`]
      );
    }

    let snapshot: ValidatedTaskSnapshotValues;
    try {
      snapshot = await readTaskSnapshot(
        snapshotPath,
        entry.name,
        lanePath,
        snapshotEvidenceRef,
        undefined,
        snapshotReadHooks
      );
    } catch (error) {
      annotateHydrationLaneFailure(error, entry.name);
      throw error;
    }
    tasks.set(snapshot.canonical.task_id, {
      task: snapshot.canonical.task_card,
      cacheClaim
    });
    await assertTasksRootGeneration(tasksRoot, tasksRootEntry, snapshotReadHooks);
  }

  await assertTasksRootGeneration(tasksRoot, tasksRootEntry, snapshotReadHooks);
  // Root B (V32-02): the generation proof extends through the cache commit —
  // drift between the final proof and the committed inventory restarts the
  // bounded attempt instead of publishing a stale cache.
  await commitHydratedTasks(tasks);
  await assertTasksRootGeneration(tasksRoot, tasksRootEntry, snapshotReadHooks);
}

async function assertTasksRootGeneration(
  tasksRoot: string,
  expected: BigIntStats,
  snapshotReadHooks?: TaskSnapshotReadHooks
): Promise<void> {
  const current = await lstatTasksRootForHydration(tasksRoot, snapshotReadHooks);
  if (
    !current ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.ctimeNs !== expected.ctimeNs ||
    current.mtimeNs !== expected.mtimeNs ||
    current.mode !== expected.mode ||
    current.nlink !== expected.nlink ||
    !current.isDirectory() ||
    current.isSymbolicLink()
  ) {
    throw new TasksRootGenerationChanged();
  }
}

async function lstatTasksRootForHydration(
  tasksRoot: string,
  snapshotReadHooks?: TaskSnapshotReadHooks
): Promise<BigIntStats | undefined> {
  try {
    await snapshotReadHooks?.beforeHydrationTasksRootMetadata?.({ tasksRoot });
    return snapshotReadHooks?.lstatTasksRootForHydration
      ? await snapshotReadHooks.lstatTasksRootForHydration({ tasksRoot })
      : await lstat(tasksRoot, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw workspaceError(
      "workspace_path_not_safe",
      "Workspace tasks root metadata could not be inspected safely.",
      "The workspace tasks directory is temporarily unavailable.",
      ["workspace/tasks", "workspace/tasks:metadata"],
      error
    );
  }
}

async function readTaskCardFromSnapshot(
  workspaceRoot: string,
  taskId: string,
  snapshotReadHooks?: TaskSnapshotReadHooks
): Promise<{ readonly canonical: TaskCard; readonly validatedRaw: TaskCard }> {
  assertSafeTaskId(taskId, `path.task_id:${taskId}`);
  const workspaceEntry = await maybeLstat(workspaceRoot);
  if (!workspaceEntry) {
    throw taskNotFoundError(taskId);
  }
  if (!(await isSafeExistingDirectoryPath(workspaceRoot))) {
    throw workspaceError(
      "workspace_path_not_safe",
      "Configured workspace root is not a safe directory.",
      "The configured workspace root is not usable.",
      ["workspace"]
    );
  }

  const tasksRoot = join(workspaceRoot, "tasks");
  const tasksRootEntry = await maybeLstat(tasksRoot);
  if (!tasksRootEntry) {
    throw taskNotFoundError(taskId);
  }
  if (!(await isSafeExistingDirectoryPath(tasksRoot))) {
    throw workspaceError(
      "workspace_path_not_safe",
      "Workspace tasks root is not a safe directory.",
      "The workspace tasks directory is not usable.",
      ["workspace/tasks"]
    );
  }

  const lanePath = join(tasksRoot, taskId);
  assertPathInsideWorkspace(workspaceRoot, lanePath, `workspace/tasks/${taskId}`);
  const laneEntry = await maybeLstat(lanePath);
  if (!laneEntry) {
    throw taskNotFoundError(taskId);
  }
  if (!laneEntry.isDirectory() || laneEntry.isSymbolicLink()) {
    throw workspaceError(
      "task_lane_not_directory",
      `Task lane is not a safe directory: ${taskId}`,
      "A task snapshot lane is blocked by a non-directory filesystem entry.",
      [`workspace/tasks/${taskId}`]
    );
  }
  if (!(await isSafeExistingDirectoryPath(lanePath))) {
    throw workspaceError(
      "task_lane_not_directory",
      `Task lane is not a safe directory: ${taskId}`,
      "A task snapshot lane is blocked by a non-directory filesystem entry.",
      [`workspace/tasks/${taskId}`]
    );
  }

  const snapshotPath = join(lanePath, "snapshot.json");
  if (!(await maybeLstat(snapshotPath))) {
    throw taskNotFoundError(taskId);
  }
  try {
    await snapshotReadHooks?.beforeSnapshotOpen?.({ snapshotPath, laneTaskId: taskId });
  } catch (error) {
    throw new TaskSnapshotReadAttemptFailure("unknown", error);
  }
  if (!(await isSafeExistingDirectoryPath(lanePath))) {
    throw workspaceError(
      "task_lane_not_directory",
      `Task lane is not a safe directory: ${taskId}`,
      "A task snapshot lane is blocked by a non-directory filesystem entry.",
      [`workspace/tasks/${taskId}`]
    );
  }

  const snapshot = await readTaskSnapshot(
    snapshotPath,
    taskId,
    lanePath,
    taskSnapshotEvidenceRef(taskId),
    undefined,
    snapshotReadHooks
  );
  return {
    canonical: snapshot.canonical.task_card,
    validatedRaw: snapshot.validatedRaw.task_card
  };
}

async function readBoundedTaskEntries(tasksRoot: string): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  let entryCount = 0;

  try {
    const directory = await opendir(tasksRoot);
    for await (const entry of directory) {
      const isGenuineReservedControlLane =
        entry.name === "_idempotency" &&
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        await isSafeExistingDirectoryPath(join(tasksRoot, entry.name));
      if (!isGenuineReservedControlLane) entryCount += 1;
      if (entryCount > MAX_TASK_HYDRATION_ENTRIES) {
        throw workspaceError(
          "workspace_path_not_safe",
          `Workspace tasks root contains more than ${MAX_TASK_HYDRATION_ENTRIES} entries, exceeding the M1 hydration limit.`,
          "The workspace tasks directory has too many entries to hydrate safely.",
          ["workspace/tasks", "workspace/tasks:entry_count"]
        );
      }
      entries.push(entry);
    }
  } catch (error) {
    if (taskServiceErrorAtBoundary(error)) {
      throw error;
    }
    throw workspaceError(
      "workspace_path_not_safe",
      "Workspace tasks root cannot be scanned safely.",
      "The workspace tasks directory is not usable.",
      ["workspace/tasks"],
      error
    );
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

async function removeEmptyTaskLaneAfterRollback(
  workspaceRoot: string,
  taskId: string
): Promise<void> {
  try {
    await removeWorkspaceRecordDirectoryIfEmpty(
      workspaceRoot,
      ["tasks", taskId],
      `workspace/tasks/${taskId}`
    );
  } catch (error) {
    throw workspaceError(
      "workspace_path_not_safe",
      "Failed to remove empty idempotency rollback task lane.",
      "The task snapshot lane could not be rolled back safely.",
      [`workspace/tasks/${taskId}`],
      error
    );
  }
}

function assertSafeTaskLaneEntry(entry: Dirent, lanePath: string): void {
  if (entry.isDirectory() && !entry.isSymbolicLink()) {
    return;
  }

  throw workspaceError(
    "task_lane_not_directory",
    `Task lane is not a safe directory: ${entry.name}`,
    "A task snapshot lane is blocked by a non-directory filesystem entry.",
    [taskLaneEvidenceRef(lanePath)]
  );
}

async function readTaskSnapshot(
  snapshotPath: string,
  laneTaskId: string,
  lanePath: string,
  evidenceRef: string,
  expectedSnapshotText?: string,
  snapshotReadHooks?: TaskSnapshotReadHooks
): Promise<ValidatedTaskSnapshotValues> {
  try {
    await snapshotReadHooks?.beforeSnapshotDurableRead?.({
      snapshotPath,
      laneTaskId
    });
  } catch (error) {
    throw new TaskSnapshotReadAttemptFailure("unknown", error);
  }
  const durableRead = await readDurableSingleLinkFile({
    path: snapshotPath,
    maxBytes: MAX_TASK_SNAPSHOT_BYTES,
    validateParentPath: async () => await isSafeExistingDirectoryPath(lanePath)
  });
  if (durableRead.status === "missing") {
    // Root D (V33-09): the frozen reader collapses ENOTDIR into "missing".
    // Re-verify the lane shape before adopting exact-absence semantics: a
    // lane blocked by a non-directory entry is a retained (unknown)
    // classification, never exact durable absence.
    const laneEntry = await maybeLstat(lanePath);
    if (laneEntry && (!laneEntry.isDirectory() || laneEntry.isSymbolicLink())) {
      throw workspaceError(
        "task_lane_not_directory",
        `Task lane is not a safe directory: ${laneTaskId}`,
        "A task snapshot lane is blocked by a non-directory filesystem entry.",
        [`workspace/tasks/${laneTaskId}`]
      );
    }
    const error = workspaceError(
      "task_snapshot_malformed",
      "Task snapshot cannot be inspected.",
      "A task snapshot cannot be read safely.",
      [evidenceRef]
    );
    throw error;
  }
  if (durableRead.status === "invalid") {
    throw taskSnapshotDurableReadError(
      durableRead.reason,
      laneTaskId,
      evidenceRef,
      ...(Object.prototype.hasOwnProperty.call(durableRead, "cause")
        ? [durableRead.cause] as [unknown]
        : [])
    );
  }

  const rawSnapshotBytes = durableRead.bytes;
  if (
    expectedSnapshotText !== undefined &&
    !rawSnapshotBytes.equals(Buffer.from(expectedSnapshotText, "utf8"))
  ) {
    throw workspaceError(
      "task_snapshot_mismatch",
      "Published task snapshot bytes do not match the canonical snapshot.",
      "The task snapshot changed during publication and cannot be accepted.",
      [evidenceRef, "snapshot.bytes"]
    );
  }
  const rawSnapshotText = rawSnapshotBytes.toString("utf8");
  let rawSnapshot: unknown;
  try {
    rawSnapshot = JSON.parse(rawSnapshotText) as unknown;
  } catch (error) {
    const malformedError = workspaceError(
      "task_snapshot_malformed",
      "Task snapshot is not valid JSON.",
      "A task snapshot is malformed and recovery has been stopped.",
      [evidenceRef],
      error
    );
    throw malformedError;
  }

  return validateRawTaskSnapshot(rawSnapshot, laneTaskId, evidenceRef);
}

function isExactTaskSnapshotContentCandidate(error: unknown): boolean {
  const taskServiceError = taskServiceErrorAtBoundary(error);
  return taskServiceError !== undefined && (
    taskServiceError.code === "task_snapshot_malformed" ||
    taskServiceError.code === "task_snapshot_mismatch" ||
    taskServiceError.code === "task_snapshot_missing_card"
  );
}

/**
 * Root C (V32-04): durable-read transport failures (open/read/inspect and
 * identity drift) share the cleanup path's durable-read marking pattern so the
 * hydration settlement discriminant classifies them as unknown instead of
 * laundering them into exact content evidence.
 */
const taskSnapshotDurableReadFailures = new WeakSet<TaskServiceError>();

function markTaskSnapshotDurableReadFailure(error: TaskServiceError): TaskServiceError {
  taskSnapshotDurableReadFailures.add(error);
  return error;
}

function isTaskSnapshotDurableReadFailure(error: unknown): boolean {
  const taskServiceError = taskServiceErrorAtBoundary(error);
  return taskServiceError !== undefined && taskSnapshotDurableReadFailures.has(taskServiceError);
}

/**
 * Root C (V32-05): every read failure raised inside a hydration attempt is
 * annotated with its originating lane so settlement can scope exact-content
 * deletion to the single failing lane.
 */
const hydrationLaneFailures = new WeakMap<object, string>();

function annotateHydrationLaneFailure(error: unknown, laneTaskId: string): void {
  if (typeof error === "object" && error !== null) {
    hydrationLaneFailures.set(error, laneTaskId);
  }
}

function hydrationLaneFailureTaskId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return hydrationLaneFailures.get(error);
}

function validateRawTaskSnapshot(
  rawSnapshot: unknown,
  laneTaskId: string,
  evidenceRef: string
): ValidatedTaskSnapshotValues {
  const parsedSnapshot = TaskSnapshotSchema.safeParse(rawSnapshot);
  if (!parsedSnapshot.success) {
    throw workspaceError(
      "task_snapshot_malformed",
      "Task snapshot failed schema validation.",
      "A task snapshot is malformed and recovery has been stopped.",
      [evidenceRef, ...toSchemaEvidenceRefs(parsedSnapshot.error, "snapshot")]
    );
  }
  if (canonicalSnapshotJson(rawSnapshot) !== canonicalSnapshotJson(parsedSnapshot.data)) {
    throw workspaceError(
      "task_snapshot_malformed",
      "Task snapshot contains fields outside the canonical durable shape.",
      "A task snapshot has unsupported fields and recovery has been stopped.",
      [evidenceRef, "snapshot"]
    );
  }

  if (!isSafeTaskId(parsedSnapshot.data.task_id)) {
    throw workspaceError(
      "task_snapshot_malformed",
      "Task snapshot id is not safe.",
      "A task snapshot is malformed and recovery has been stopped.",
      [evidenceRef, "snapshot.task_id"]
    );
  }

  if (parsedSnapshot.data.task_id !== laneTaskId) {
    throw workspaceError(
      "task_snapshot_mismatch",
      "Task snapshot id does not match its lane.",
      "A task snapshot does not match its task directory.",
      [
        `workspace/tasks/${laneTaskId}/snapshot.json`,
        `snapshot.task_id:${parsedSnapshot.data.task_id}`
      ]
    );
  }

  if (parsedSnapshot.data.latest_seq !== TASK_SNAPSHOT_LATEST_SEQ) {
    throw workspaceError(
      "task_snapshot_mismatch",
      "Task snapshot latest sequence is not supported by M1 recovery.",
      "A task snapshot is inconsistent and recovery has been stopped.",
      [evidenceRef, "snapshot.latest_seq"]
    );
  }

  if (!parsedSnapshot.data.task_card) {
    throw workspaceError(
      "task_snapshot_missing_card",
      "Task snapshot does not include the M1 task_card recovery payload.",
      "A task snapshot is missing the data needed for recovery.",
      [evidenceRef]
    );
  }

  validateSnapshotTaskCardConsistency(parsedSnapshot.data, evidenceRef);
  return {
    canonical: parsedSnapshot.data as TaskSnapshotWithTaskCard,
    validatedRaw: rawSnapshot as TaskSnapshotWithTaskCard
  };
}

function canonicalSnapshotJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSnapshotJson(item)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalSnapshotJson(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function taskSnapshotDurableReadError(
  reason: DurableSingleLinkReadFailureReason,
  laneTaskId: string,
  evidenceRef: string,
  ...causeArguments: [] | [unknown]
): TaskServiceError {
  if (reason === "parent_not_safe") {
    return workspaceError(
      "task_lane_not_directory",
      `Task lane is not a safe directory: ${laneTaskId}`,
      "A task snapshot lane is blocked by a non-directory filesystem entry.",
      [`workspace/tasks/${laneTaskId}`],
      ...causeArguments
    );
  }
  if (reason === "not_regular_file" || reason === "multiple_links") {
    return workspaceError(
      "task_snapshot_malformed",
      "Task snapshot is not a safe regular file.",
      "A task snapshot cannot be read safely.",
      [evidenceRef],
      ...causeArguments
    );
  }
  if (reason === "too_large") {
    return workspaceError(
      "task_snapshot_malformed",
      "Task snapshot exceeds the M1 bounded read size.",
      "A task snapshot is too large to load safely.",
      [evidenceRef],
      ...causeArguments
    );
  }
  if (reason === "open_failed") {
    return markTaskSnapshotDurableReadFailure(workspaceError(
      "task_snapshot_malformed",
      "Task snapshot cannot be opened safely.",
      "A task snapshot cannot be read safely.",
      [evidenceRef],
      ...causeArguments
    ));
  }
  if (reason === "read_failed") {
    return markTaskSnapshotDurableReadFailure(workspaceError(
      "task_snapshot_malformed",
      "Task snapshot cannot be read safely.",
      "A task snapshot cannot be read safely.",
      [evidenceRef],
      ...causeArguments
    ));
  }

  return markTaskSnapshotDurableReadFailure(workspaceError(
    "task_snapshot_malformed",
    "Task snapshot cannot be inspected.",
    "A task snapshot cannot be read safely.",
    [evidenceRef],
    ...causeArguments
  ));
}

function unknownTaskSnapshotAuthorityError(
  taskId: string,
  evidenceRef: string,
  cause: unknown
): TaskServiceError {
  const taskServiceError = taskServiceErrorAtBoundary(cause);
  if (taskServiceError) return taskServiceError;
  return workspaceError(
    "workspace_path_not_safe",
    `Task snapshot authority could not be classified safely: ${taskId}`,
    "The task snapshot state is temporarily unknown and was left unchanged.",
    [evidenceRef],
    cause
  );
}

async function persistTaskSnapshot(
  workspaceRoot: string,
  task: TaskCard,
  snapshotWriteHooks?: TaskSnapshotWriteHooks,
  retainPublicationAuthority = false
): Promise<PersistTaskSnapshotResult> {
  const snapshotInput = createTaskSnapshotInput(task);
  const publicationHooksActive =
    !snapshotWriteHooks && workspaceRecordPublicationHooksActive();
  let snapshot = snapshotInput;
  if (snapshotWriteHooks || publicationHooksActive) {
    snapshot = TaskSnapshotSchema.parse(snapshotInput) as TaskSnapshotWithTaskCard;
    const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(snapshotText, "utf8") > MAX_TASK_SNAPSHOT_BYTES) {
      throw taskSnapshotTooLargeError();
    }
  }

  const taskDirectory = join(workspaceRoot, "tasks", task.task_id);
  const existingTaskDirectory = await maybeLstat(taskDirectory);
  if (
    existingTaskDirectory &&
    (await isSafeExistingDirectoryPath(join(workspaceRoot, "tasks"))) &&
    (!existingTaskDirectory.isDirectory() ||
      existingTaskDirectory.isSymbolicLink() ||
      !(await isSafeExistingDirectoryPath(taskDirectory)))
  ) {
    throw workspaceError(
      "task_lane_not_directory",
      "Path is not a safe directory.",
      "A required workspace path is not a safe directory.",
      [`workspace/tasks/${task.task_id}`]
    );
  }

  const evidenceRef = taskSnapshotEvidenceRef(task.task_id);
  if (!snapshotWriteHooks && !publicationHooksActive) {
    try {
      if (retainPublicationAuthority) {
        const created = await createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          ["tasks", task.task_id],
          "snapshot.json",
          snapshotInput,
          evidenceRef,
          TaskSnapshotSchema
        );
        if (created.status === "exists") return "exists";
        const snapshotPath = join(taskDirectory, "snapshot.json");
        return {
          status: "created",
          task: created.record.task_card!,
          publicationAuthority: await retainTaskSnapshotPublicationAuthority(
            created.cleanupPermit,
            snapshotPath,
            evidenceRef,
            snapshotInput,
            workspaceRoot,
            task.task_id
          )
        };
      }
      const created = await createJsonRecordIfAbsent(
        workspaceRoot,
        ["tasks", task.task_id],
        "snapshot.json",
        snapshotInput,
        evidenceRef,
        TaskSnapshotSchema
      );
      if (created.status === "exists") return "exists";
      return { status: "created", task: created.record.task_card! };
    } catch (error) {
      if (isWorkspaceRecordOversizeError(error)) {
        throw taskSnapshotTooLargeError();
      }
      throw workspaceError(
        "workspace_path_not_safe",
        "Failed to persist task snapshot under the configured workspace.",
        "The task snapshot could not be written safely.",
        [`workspace/tasks/${task.task_id}/snapshot.json`],
        error
      );
    }
  }

  const snapshotWriteHookOwner = snapshotWriteHooks;
  const beforeSnapshotWrite = snapshotWriteHookOwner?.beforeSnapshotWrite;
  const afterSnapshotWrite = snapshotWriteHookOwner?.afterSnapshotWrite;
  let beforeWriteStarted = false;
  let beforeWriteReturned = false;
  let afterWriteStarted = false;
  let cleanupPermit: WorkspaceRecordCleanupPermit | undefined;
  try {
    await ensureWorkspaceDirectoryTree(
      workspaceRoot,
      [["tasks", task.task_id]],
      evidenceRef
    );
    beforeWriteStarted = true;
    if (beforeSnapshotWrite) {
      await Reflect.apply(beforeSnapshotWrite, snapshotWriteHookOwner, [
        { taskDirectory, taskId: task.task_id }
      ]);
    }
    beforeWriteReturned = true;

    const created = await createJsonRecordIfAbsentWithCleanupPermit(
      workspaceRoot,
      ["tasks", task.task_id],
      "snapshot.json",
      snapshot,
      evidenceRef,
      TaskSnapshotSchema
    );
    if (created.status === "exists") return "exists";
    cleanupPermit = created.cleanupPermit;
    const publishedTask = created.record.task_card!;

    afterWriteStarted = true;
    if (afterSnapshotWrite) {
      try {
        await Reflect.apply(afterSnapshotWrite, snapshotWriteHookOwner, [
          { taskDirectory, taskId: task.task_id }
        ]);
      } catch (callbackError) {
        const callbackOccurrence = captureFailureFoldEntry("body", callbackError);
        const permit = cleanupPermit;
        cleanupPermit = undefined;
        const compensationEntries: FailureFoldEntry[] = [];
        try {
          await conditionalDeletePublishedJsonRecordGenerationWithCleanupPermit(
            permit,
            join(taskDirectory, "snapshot.json"),
            evidenceRef,
            TaskSnapshotSchema,
            { kind: "record", expected: snapshot, matches: () => true }
          );
        } catch (cleanupError) {
          compensationEntries.push(
            captureFailureFoldEntry("final_release", cleanupError)
          );
        }
        try {
          await removeEmptyTaskLaneAfterRollback(workspaceRoot, task.task_id);
        } catch (cleanupError) {
          compensationEntries.push(
            captureFailureFoldEntry("final_release", cleanupError)
          );
        }
        if (compensationEntries.length > 0) {
          throw preserveTaskServiceErrorFailureEntries(
            callbackOccurrence,
            compensationEntries,
            "Task snapshot publication compensation failed.",
          );
        }
        throw callbackError;
      }
    }

    const permit = cleanupPermit;
    cleanupPermit = undefined;
    if (retainPublicationAuthority) {
      const snapshotPath = join(taskDirectory, "snapshot.json");
      return {
        status: "created",
        task: publishedTask,
        publicationAuthority: await retainTaskSnapshotPublicationAuthority(
          permit,
          snapshotPath,
          evidenceRef,
          snapshot,
          workspaceRoot,
          task.task_id
        )
      };
    }
    const settlement = await settleWorkspaceRecordCleanupPermitAfterExactObservation(
      permit,
      join(taskDirectory, "snapshot.json"),
      evidenceRef
    );
    if (settlement.status !== "current") {
      throw workspaceError(
        "task_snapshot_mismatch",
        "Published task snapshot generation changed before final observation.",
        "The task snapshot changed during publication and cannot be accepted.",
        [evidenceRef, "snapshot.bytes"]
      );
    }
    return { status: "created", task: publishedTask };
  } catch (error) {
    const primaryOccurrence = captureFailureFoldEntry("body", error);
    let publicationFailure: unknown = error;
    if (beforeWriteStarted && !beforeWriteReturned) {
      try {
        await removeEmptyTaskLaneAfterRollback(workspaceRoot, task.task_id);
      } catch (cleanupError) {
        const cleanupOccurrence = captureFailureFoldEntry(
          "final_release",
          cleanupError
        );
        publicationFailure = preserveTaskServiceErrorFailureEntries(
          primaryOccurrence,
          [cleanupOccurrence],
          "Task snapshot publication compensation failed.",
        );
      }
    }
    if (
      !beforeWriteStarted &&
      (await isSafeExistingDirectoryPath(join(workspaceRoot, "tasks")))
    ) {
      const taskDirectoryEntry = await maybeLstat(taskDirectory);
      if (!taskDirectoryEntry || !(await isSafeExistingDirectoryPath(taskDirectory))) {
        const taskLaneFailure = taskServiceErrorAtBoundary(error);
        throw workspaceError(
          "task_lane_not_directory",
          taskLaneFailure?.message ?? "Failed to create workspace directory.",
          taskLaneFailure?.userMessage ??
            "A required workspace directory could not be created safely.",
          [`workspace/tasks/${task.task_id}`],
          publicationFailure
        );
      }
    }
    if (
      beforeWriteReturned &&
      !afterWriteStarted &&
      !(await isSafeExistingDirectoryPath(taskDirectory))
    ) {
      throw taskLaneNotDirectoryError(task.task_id, publicationFailure);
    }
    if (failureLedger(publicationFailure)) {
      const taskServiceFailure = taskServiceErrorAtBoundary(publicationFailure);
      if (taskServiceFailure) throw publicationFailure;
    }
    throw workspaceError(
      "workspace_path_not_safe",
      "Failed to persist task snapshot under the configured workspace.",
      "The task snapshot could not be written safely.",
      [`workspace/tasks/${task.task_id}/snapshot.json`],
      publicationFailure
    );
  } finally {
    if (cleanupPermit) {
      await cancelWorkspaceRecordCleanupPermit(cleanupPermit);
    }
  }
}

function taskSnapshotTooLargeError(): TaskServiceError {
  return new TaskServiceError({
    code: "task_snapshot_too_large",
    status: 400,
    category: "schema_error",
    message: "Task snapshot would exceed the M1 bounded recovery size.",
    userMessage: "The task request is too large to persist safely.",
    evidenceRefs: ["request.body"],
    recommendedNextActions: ["Shorten the task title, goal, or creator fields and submit again."]
  });
}

function taskLaneNotDirectoryError(
  taskId: string,
  ...causeArguments: [] | [unknown]
): TaskServiceError {
  return workspaceError(
    "task_lane_not_directory",
    `Task lane is not a safe directory: ${taskId}`,
    "A task snapshot lane is blocked by a non-directory filesystem entry.",
    [`workspace/tasks/${taskId}`],
    ...causeArguments
  );
}

function createTaskSnapshotInput(task: TaskCard): TaskSnapshotWithTaskCard {
  return {
    task_id: task.task_id,
    status: task.status,
    runtime_phase: task.runtime_phase ?? null,
    ...(task.stack_id ? { stack_id: task.stack_id } : {}),
    ...(task.data_id ? { data_id: task.data_id } : {}),
    linked_jobs: task.linked_jobs,
    linked_runs: [],
    linked_reports: task.linked_reports,
    pending_pi_gates: [],
    latest_seq: TASK_SNAPSHOT_LATEST_SEQ,
    updated_at: task.updated_at,
    task_card: task
  };
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

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function maybeLstat(path: string): Promise<FileStat | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw workspaceError(
      "workspace_path_not_safe",
      "Workspace path metadata could not be inspected safely.",
      "The workspace path is temporarily unavailable.",
      ["workspace"],
      error
    );
  }
}

function assertSafeTaskId(taskId: string, evidenceRef: string): void {
  if (isSafeTaskId(taskId)) {
    return;
  }

  throw new TaskServiceError({
    code: "task_id_not_safe",
    status: 404,
    category: "not_found",
    message: `Task id is not safe: ${taskId}`,
    userMessage: "The requested task id is not valid.",
    evidenceRefs: [evidenceRef],
    recommendedNextActions: ["Refresh the task list and choose an existing task."]
  });
}

function taskNotFoundError(taskId: string): TaskServiceError {
  return new TaskServiceError({
    code: "task_not_found",
    status: 404,
    category: "not_found",
    message: `Task not found: ${taskId}`,
    userMessage: "The requested task does not exist.",
    evidenceRefs: [`path.task_id:${taskId}`],
    recommendedNextActions: ["Refresh the task list and choose an existing task."]
  });
}

function assertPathInsideWorkspace(
  workspaceRoot: string,
  targetPath: string,
  evidenceRef: string
): void {
  if (isPathInsideBoundary(workspaceRoot, targetPath)) {
    return;
  }

  throw workspaceError(
    "workspace_path_not_safe",
    `Resolved path escapes workspace: ${targetPath}`,
    "A workspace path resolved outside the configured workspace.",
    [evidenceRef]
  );
}

function validateSnapshotTaskCardConsistency(snapshot: TaskSnapshot, evidenceRef: string): void {
  const taskCard = snapshot.task_card;
  if (!taskCard) {
    return;
  }

  const mismatches: string[] = [];
  if (taskCard.task_id !== snapshot.task_id) {
    mismatches.push("task_id");
  }
  if (taskCard.status !== snapshot.status) {
    mismatches.push("status");
  }
  if ((taskCard.runtime_phase ?? null) !== (snapshot.runtime_phase ?? null)) {
    mismatches.push("runtime_phase");
  }
  if (taskCard.stack_id !== snapshot.stack_id) {
    mismatches.push("stack_id");
  }
  if (taskCard.data_id !== snapshot.data_id) {
    mismatches.push("data_id");
  }
  if (!stringArraysEqual(taskCard.linked_jobs, snapshot.linked_jobs)) {
    mismatches.push("linked_jobs");
  }
  if (!stringArraysEqual(taskCard.linked_reports, snapshot.linked_reports)) {
    mismatches.push("linked_reports");
  }
  if (taskCard.updated_at !== snapshot.updated_at) {
    mismatches.push("updated_at");
  }

  if (mismatches.length > 0) {
    throw workspaceError(
      "task_snapshot_mismatch",
      "Task snapshot outer fields do not match nested task_card.",
      "A task snapshot is inconsistent and recovery has been stopped.",
      [evidenceRef, ...mismatches.map((field) => `snapshot.${field}`)]
    );
  }
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareTaskCards(left: TaskCard, right: TaskCard): number {
  return (
    left.created_at.localeCompare(right.created_at) || left.task_id.localeCompare(right.task_id)
  );
}

function toSchemaEvidenceRefs(error: z.ZodError, prefix = "request.body"): string[] {
  return Array.from(
    new Set(
      error.issues.map((issue) =>
        issue.path.length > 0 ? `${prefix}.${issue.path.join(".")}` : prefix
      )
    )
  );
}

function workspaceError(
  code: Exclude<TaskServiceErrorCode, "schema_error" | "task_not_found" | "task_id_not_safe">,
  message: string,
  userMessage: string,
  evidenceRefs: string[],
  ...causeArguments: [] | [unknown]
): TaskServiceError {
  const error = new TaskServiceError({
    code,
    status: 500,
    category: "workspace_error",
    message,
    userMessage,
    evidenceRefs,
    retryable: false,
    recommendedNextActions: ["Inspect the workspace task snapshot state before retrying."]
  });

  if (causeArguments.length === 1) {
    const cause = causeArguments[0];
    if (failureLedger(cause)) {
      error.cause = cause as Error;
    } else {
      const exactError = semanticPrimaryError(cause);
      error.cause = exactError !== undefined && exactError === cause
        ? exactError
        : preserveTaskServiceErrorFailureEntries(
            captureFailureFoldEntry("body", cause),
            [],
            "A TaskCard workspace operation failed before its cause could be classified safely."
          ) as Error;
    }
  }

  return error;
}

function taskSnapshotEvidenceRef(taskId: string): string {
  return `workspace/tasks/${taskId}/snapshot.json`;
}

function taskLaneEvidenceRef(path: string): string {
  const name = parse(path).base;
  return isSafeTaskId(name) ? `workspace/tasks/${name}` : "workspace/tasks";
}

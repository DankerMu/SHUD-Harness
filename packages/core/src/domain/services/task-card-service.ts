import { randomUUID } from "node:crypto";
import { type Dirent } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
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
import { isPathInsideBoundary } from "./workspace-path-safety";
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
  removeWorkspaceRecordDirectoryIfEmpty,
  settleWorkspaceRecordCleanupPermitAfterExactObservation,
  workspaceRecordPublicationHooksActive,
  type ConditionalDeleteObservedJsonRecordResult,
  type WorkspaceRecordCleanupPermit
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
  }
}

export interface TaskCardServiceOptions {
  workspaceRoot: string;
  now?: () => Date;
  taskIdFactory?: () => string;
  snapshotReadHooks?: TaskSnapshotReadHooks;
  snapshotWriteHooks?: TaskSnapshotWriteHooks;
}

export interface TaskCardService {
  createTask: (input: CreateTaskInput) => Promise<TaskCard>;
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
  readonly cachedAtObservation?: TaskCard;
  readonly task?: TaskCard;
  status: "outstanding" | "settling" | "settled";
}

type TaskSnapshotWithTaskCard = TaskSnapshot & { task_card: TaskCard };

interface ValidatedTaskSnapshotValues {
  readonly canonical: TaskSnapshotWithTaskCard;
  readonly validatedRaw: TaskSnapshotWithTaskCard;
}

type PersistTaskSnapshotResult =
  | "exists"
  | { readonly status: "created"; readonly task: TaskCard };

const TaskSnapshotCleanupRawSchema = z.unknown();

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

export function createTaskCardService(options: TaskCardServiceOptions): TaskCardService {
  const workspaceRoot = resolve(options.workspaceRoot);
  const now = options.now ?? (() => new Date());
  const taskIdFactory = options.taskIdFactory ?? (() => `TASK-${randomUUID()}`);
  const snapshotReadHooks = options.snapshotReadHooks;
  const snapshotWriteHooks = options.snapshotWriteHooks;
  const tasks = new Map<string, TaskCard>();
  const reservedTaskIds = new Set<string>();
  const cleanupObservations = new WeakMap<
    TaskSnapshotCleanupObservation,
    TaskSnapshotCleanupObservationState
  >();
  let hydration: Promise<void> | undefined;

  async function ensureHydrated(): Promise<void> {
    hydration ??= hydrateTasksFromDisk(workspaceRoot, snapshotReadHooks).then((hydratedTasks) => {
      tasks.clear();
      for (const [taskId, task] of hydratedTasks) {
        tasks.set(taskId, task);
      }
    });

    try {
      await hydration;
    } catch (error) {
      hydration = undefined;
      throw error;
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
    taskId: string
  ): Promise<TaskSnapshotCleanupObservation> {
    assertSafeTaskId(taskId, `path.task_id:${taskId}`);
    const taskDirectory = join(workspaceRoot, "tasks", taskId);
    const snapshotPath = join(taskDirectory, "snapshot.json");
    const evidenceRef = taskSnapshotEvidenceRef(taskId);
    assertPathInsideWorkspace(workspaceRoot, snapshotPath, evidenceRef);

    const taskDirectoryEntry = await maybeLstat(taskDirectory);
    if (
      taskDirectoryEntry &&
      (!taskDirectoryEntry.isDirectory() ||
        taskDirectoryEntry.isSymbolicLink() ||
        !(await isSafeExistingDirectoryPath(taskDirectory)))
    ) {
      throw taskLaneNotDirectoryError(taskId);
    }

    if (await maybeLstat(snapshotPath)) {
      await snapshotReadHooks?.beforeSnapshotOpen?.({
        snapshotPath,
        laneTaskId: taskId
      });
    }

    const cachedAtObservation = tasks.get(taskId);
    const commonState = {
      taskId,
      snapshotPath,
      evidenceRef,
      cachedAtObservation
    };
    let observed: Awaited<ReturnType<typeof observeJsonRecordForCleanup<unknown>>>;
    try {
      observed = await observeJsonRecordForCleanup(
        snapshotPath,
        evidenceRef,
        TaskSnapshotCleanupRawSchema
      );
    } catch (error) {
      if (tasks.get(taskId) === cachedAtObservation) tasks.delete(taskId);
      if (isWorkspaceRecordDurableReadError(error)) {
        return registerCleanupObservation(
          { status: "invalid", taskId, error },
          commonState
        );
      }
      throw error;
    }
    if (observed.status === "missing") {
      return registerCleanupObservation(
        { status: "missing", taskId },
        commonState
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
          cleanupPermit: observed.cleanupPermit,
          condition,
          task: snapshot.canonical.task_card
        }
      );
    } catch (error) {
      if (!(error instanceof TaskServiceError)) {
        await cancelWorkspaceRecordCleanupPermit(observed.cleanupPermit);
        throw error;
      }
      return registerCleanupObservation(
        {
          status: error.code === "task_snapshot_missing_card" ? "repairable" : "invalid",
          taskId,
          error
        },
        {
          ...commonState,
          cleanupPermit: observed.cleanupPermit,
          condition
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
      if (
        !state.task &&
        tasks.get(state.taskId) === state.cachedAtObservation
      ) {
        tasks.delete(state.taskId);
      }
    } finally {
      state.status = "settled";
    }
  }

  async function acceptTaskSnapshotCleanupObservationInternal(
    observation: TaskSnapshotCleanupObservation
  ): Promise<TaskCard> {
    const state = outstandingCleanupObservationState(observation, true);
    try {
      if (state.cleanupPermit) {
        await cancelWorkspaceRecordCleanupPermit(state.cleanupPermit);
      }
      const task = state.task;
      tasks.set(state.taskId, task);
      return copyTaskCard(task);
    } finally {
      state.status = "settled";
    }
  }

  async function cleanupTaskSnapshotObservationInternal(
    observation: TaskSnapshotCleanupObservation
  ): Promise<void> {
    const state = outstandingCleanupObservationState(observation);
    let result: ConditionalDeleteObservedJsonRecordResult = { status: "missing" };
    try {
      if (state.cleanupPermit && state.condition) {
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
      }
    } catch (error) {
      throw workspaceError(
        "workspace_path_not_safe",
        "Failed to clean up the observed task snapshot generation.",
        "The task snapshot could not be cleaned up safely.",
        [state.evidenceRef],
        error
      );
    } finally {
      state.status = "settled";
    }

    if (result.status === "condition_not_met") {
      throw workspaceError(
        "task_snapshot_mismatch",
        "Observed task snapshot no longer satisfies its cleanup condition.",
        "The task snapshot changed before it could be cleaned up safely.",
        [state.evidenceRef]
      );
    }

    if (result.status === "superseded") {
      if (tasks.get(state.taskId) === state.cachedAtObservation) {
        try {
          const successor = await readTaskCardFromSnapshot(
            workspaceRoot,
            state.taskId
          );
          if (tasks.get(state.taskId) === state.cachedAtObservation) {
            tasks.set(state.taskId, successor.canonical);
          }
        } catch {
          if (tasks.get(state.taskId) === state.cachedAtObservation) {
            tasks.delete(state.taskId);
          }
        }
      }
      return;
    }

    if (tasks.get(state.taskId) === state.cachedAtObservation) {
      tasks.delete(state.taskId);
    }
    await removeEmptyTaskLaneAfterRollback(workspaceRoot, state.taskId);
  }

  return {
    async createTask(input: CreateTaskInput): Promise<TaskCard> {
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
        if (tasks.has(taskId) || reservedTaskIds.has(taskId)) continue;
        reservedTaskIds.add(taskId);

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
            snapshotWriteHooks
          );
          if (publication === "exists") continue;
          tasks.set(task.task_id, publication.task);
          return task;
        } finally {
          reservedTaskIds.delete(taskId);
        }
      }

      throw taskIdGenerationFailedError();
    },

    async rollbackTaskForIdempotency(
      taskId: string,
      expectedTask?: TaskCard
    ): Promise<void> {
      await ensureHydrated();
      assertSafeTaskId(taskId, `path.task_id:${taskId}`);
      if (expectedTask && expectedTask.task_id !== taskId) {
        throw workspaceError(
          "task_snapshot_mismatch",
          "Task rollback authority does not match the requested task id.",
          "The task snapshot lane is not safe to roll back automatically.",
          [`workspace/tasks/${taskId}`, "snapshot.task_card"]
        );
      }
      const cachedTask = tasks.get(taskId);
      if (
        cachedTask &&
        expectedTask &&
        JSON.stringify(cachedTask) !== JSON.stringify(expectedTask)
      ) {
        throw workspaceError(
          "task_snapshot_mismatch",
          "Task rollback authority does not match the in-memory task.",
          "The task snapshot lane is not safe to roll back automatically.",
          [`workspace/tasks/${taskId}`, "snapshot.task_card"]
        );
      }
      const task = expectedTask ?? cachedTask;
      if (!task) {
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
      let cacheHandled = false;
      try {
        observation = await observeTaskSnapshotForCleanupInternal(taskId);
        if (observation.status === "record") {
          if (JSON.stringify(observation.task) === JSON.stringify(task)) {
            const ownedObservation = observation;
            observation = undefined;
            await cleanupTaskSnapshotObservationInternal(ownedObservation);
          } else {
            const ownedObservation = observation;
            observation = undefined;
            await acceptTaskSnapshotCleanupObservationInternal(ownedObservation);
          }
          cacheHandled = true;
          return;
        }

        if (observation.status !== "missing") {
          const ownedObservation = observation;
          observation = undefined;
          await cleanupTaskSnapshotObservationInternal(ownedObservation);
          cacheHandled = true;
          return;
        }

        const ownedObservation = observation;
        observation = undefined;
        await cleanupTaskSnapshotObservationInternal(ownedObservation);
        cacheHandled = true;
      } finally {
        if (observation) {
          await cancelTaskSnapshotCleanupObservationInternal(observation);
        }
        if (!cacheHandled && tasks.get(taskId) === cachedTask) {
          tasks.delete(taskId);
        }
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

    async cleanupTaskSnapshotObservation(
      observation: TaskSnapshotCleanupObservation
    ): Promise<void> {
      await cleanupTaskSnapshotObservationInternal(observation);
    },

    async listTasks(): Promise<TaskCard[]> {
      await ensureHydrated();
      return Array.from(tasks.values()).sort(compareTaskCards).map(copyTaskCard);
    },

    async getTask(taskId: string): Promise<TaskCard> {
      await ensureHydrated();
      assertSafeTaskId(taskId, `path.task_id:${taskId}`);
      const task = tasks.get(taskId);
      if (!task) {
        throw taskNotFoundError(taskId);
      }

      return copyTaskCard(task);
    },

    async getTaskFromSnapshot(taskId: string): Promise<TaskCard> {
      try {
        const task = await readTaskCardFromSnapshot(
          workspaceRoot,
          taskId,
          snapshotReadHooks
        );
        tasks.set(task.canonical.task_id, task.canonical);
        return task.validatedRaw;
      } catch (error) {
        tasks.delete(taskId);
        throw error;
      }
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
  snapshotReadHooks?: TaskSnapshotReadHooks
): Promise<Map<string, TaskCard>> {
  const tasks = new Map<string, TaskCard>();
  const workspaceEntry = await maybeLstat(workspaceRoot);
  if (!workspaceEntry) {
    return tasks;
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
    return tasks;
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

  for (const entry of entries) {
    if (!isSafeTaskId(entry.name)) {
      continue;
    }

    const lanePath = join(tasksRoot, entry.name);
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

    await snapshotReadHooks?.beforeSnapshotOpen?.({ snapshotPath, laneTaskId: entry.name });
    if (!(await isSafeExistingDirectoryPath(lanePath))) {
      throw workspaceError(
        "task_lane_not_directory",
        `Task lane is not a safe directory: ${entry.name}`,
        "A task snapshot lane is blocked by a non-directory filesystem entry.",
        [`workspace/tasks/${entry.name}`]
      );
    }

    const snapshot = await readTaskSnapshot(
      snapshotPath,
      entry.name,
      lanePath,
      snapshotEvidenceRef
    );
    tasks.set(snapshot.canonical.task_id, snapshot.canonical.task_card);
  }

  return tasks;
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
  await snapshotReadHooks?.beforeSnapshotOpen?.({ snapshotPath, laneTaskId: taskId });
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
    taskSnapshotEvidenceRef(taskId)
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
      entryCount += 1;
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
    if (error instanceof TaskServiceError) {
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

  return entries;
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
  expectedSnapshotText?: string
): Promise<ValidatedTaskSnapshotValues> {
  const durableRead = await readDurableSingleLinkFile({
    path: snapshotPath,
    maxBytes: MAX_TASK_SNAPSHOT_BYTES,
    validateParentPath: async () => await isSafeExistingDirectoryPath(lanePath)
  });
  if (durableRead.status === "missing") {
    throw workspaceError(
      "task_snapshot_malformed",
      "Task snapshot cannot be inspected.",
      "A task snapshot cannot be read safely.",
      [evidenceRef]
    );
  }
  if (durableRead.status === "invalid") {
    throw taskSnapshotDurableReadError(
      durableRead.reason,
      laneTaskId,
      evidenceRef,
      durableRead.cause
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
    throw workspaceError(
      "task_snapshot_malformed",
      "Task snapshot is not valid JSON.",
      "A task snapshot is malformed and recovery has been stopped.",
      [evidenceRef],
      error
    );
  }

  return validateRawTaskSnapshot(rawSnapshot, laneTaskId, evidenceRef);
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
  cause?: unknown
): TaskServiceError {
  if (reason === "parent_not_safe") {
    return workspaceError(
      "task_lane_not_directory",
      `Task lane is not a safe directory: ${laneTaskId}`,
      "A task snapshot lane is blocked by a non-directory filesystem entry.",
      [`workspace/tasks/${laneTaskId}`],
      cause
    );
  }
  if (reason === "not_regular_file" || reason === "multiple_links") {
    return workspaceError(
      "task_snapshot_malformed",
      "Task snapshot is not a safe regular file.",
      "A task snapshot cannot be read safely.",
      [evidenceRef],
      cause
    );
  }
  if (reason === "too_large") {
    return workspaceError(
      "task_snapshot_malformed",
      "Task snapshot exceeds the M1 bounded read size.",
      "A task snapshot is too large to load safely.",
      [evidenceRef],
      cause
    );
  }
  if (reason === "open_failed") {
    return workspaceError(
      "task_snapshot_malformed",
      "Task snapshot cannot be opened safely.",
      "A task snapshot cannot be read safely.",
      [evidenceRef],
      cause
    );
  }
  if (reason === "read_failed") {
    return workspaceError(
      "task_snapshot_malformed",
      "Task snapshot cannot be read safely.",
      "A task snapshot cannot be read safely.",
      [evidenceRef],
      cause
    );
  }

  return workspaceError(
    "task_snapshot_malformed",
    "Task snapshot cannot be inspected.",
    "A task snapshot cannot be read safely.",
    [evidenceRef],
    cause
  );
}

async function persistTaskSnapshot(
  workspaceRoot: string,
  task: TaskCard,
  snapshotWriteHooks?: TaskSnapshotWriteHooks
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
        const permit = cleanupPermit;
        cleanupPermit = undefined;
        const compensationErrors: unknown[] = [];
        try {
          await conditionalDeletePublishedJsonRecordGenerationWithCleanupPermit(
            permit,
            join(taskDirectory, "snapshot.json"),
            evidenceRef,
            TaskSnapshotSchema,
            { kind: "record", expected: snapshot, matches: () => true }
          );
        } catch (cleanupError) {
          compensationErrors.push(cleanupError);
        }
        try {
          await removeEmptyTaskLaneAfterRollback(workspaceRoot, task.task_id);
        } catch (cleanupError) {
          compensationErrors.push(cleanupError);
        }
        if (compensationErrors.length > 0) {
          throw new AggregateError(
            [callbackError, ...compensationErrors],
            "Task snapshot publication compensation failed."
          );
        }
        throw callbackError;
      }
    }

    const permit = cleanupPermit;
    cleanupPermit = undefined;
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
    let publicationFailure: unknown = error;
    if (beforeWriteStarted && !beforeWriteReturned) {
      try {
        await removeEmptyTaskLaneAfterRollback(workspaceRoot, task.task_id);
      } catch (cleanupError) {
        publicationFailure = new AggregateError(
          [error, cleanupError],
          "Task snapshot publication compensation failed."
        );
      }
    }
    if (
      !beforeWriteStarted &&
      (await isSafeExistingDirectoryPath(join(workspaceRoot, "tasks")))
    ) {
      const taskDirectoryEntry = await maybeLstat(taskDirectory);
      if (!taskDirectoryEntry || !(await isSafeExistingDirectoryPath(taskDirectory))) {
        const taskLaneFailure = error instanceof TaskServiceError ? error : undefined;
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

function taskLaneNotDirectoryError(taskId: string, cause?: unknown): TaskServiceError {
  return workspaceError(
    "task_lane_not_directory",
    `Task lane is not a safe directory: ${taskId}`,
    "A task snapshot lane is blocked by a non-directory filesystem entry.",
    [`workspace/tasks/${taskId}`],
    cause
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

async function maybeLstat(path: string): Promise<FileStat | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
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
    recommendedNextActions: ["Inspect the workspace task snapshot state before retrying."]
  });

  if (cause instanceof Error) {
    error.cause = cause;
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

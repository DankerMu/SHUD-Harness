import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  InferenceBudgetSchema,
  TaskCardSchema,
  TaskRuntimePhaseSchema,
  TaskStatusSchema,
  TaskTypeSchema,
  type TaskCard
} from "../schemas/task";

export const DEFAULT_TASK_CREATED_BY = "pi" as const;
export const DEFAULT_TASK_CURRENT_OWNER = "coordinator" as const;
export const DEFAULT_TASK_REVIEWER = "reviewer" as const;
export const TASK_SNAPSHOT_LATEST_SEQ = 0 as const;

const TASK_ID_PATTERN = /^TASK-[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_TASK_ID_ATTEMPTS = 20;
// M1 skeleton bound: cap workspace/tasks fan-out before opening any task snapshots.
const MAX_TASK_HYDRATION_ENTRIES = 1024;
const MAX_TASK_SNAPSHOT_BYTES = 1024 * 1024;
const TASK_SNAPSHOT_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

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

export type TaskServiceErrorCode =
  | "schema_error"
  | "task_not_found"
  | "task_id_not_safe"
  | "workspace_path_not_safe"
  | "task_lane_not_directory"
  | "task_snapshot_malformed"
  | "task_snapshot_mismatch"
  | "task_snapshot_missing_card"
  | "task_id_generation_failed";

export interface TaskServiceErrorOptions {
  code: TaskServiceErrorCode;
  message: string;
  userMessage: string;
  status: 400 | 404 | 500;
  category: string;
  evidenceRefs?: string[];
  retryable?: boolean;
  recommendedNextActions?: string[];
}

export class TaskServiceError extends Error {
  readonly code: TaskServiceErrorCode;
  readonly status: 400 | 404 | 500;
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
}

export interface TaskCardService {
  createTask: (input: CreateTaskInput) => Promise<TaskCard>;
  listTasks: () => Promise<TaskCard[]>;
  getTask: (taskId: string) => Promise<TaskCard>;
}

type FileStat = Awaited<ReturnType<typeof lstat>>;
type SnapshotFileHandle = Awaited<ReturnType<typeof open>>;

export interface TaskSnapshotReadHookInput {
  snapshotPath: string;
  laneTaskId: string;
}

export interface TaskSnapshotReadHooks {
  beforeSnapshotOpen?: (input: TaskSnapshotReadHookInput) => Promise<void> | void;
}

export function createTaskCardService(options: TaskCardServiceOptions): TaskCardService {
  const workspaceRoot = resolve(options.workspaceRoot);
  const now = options.now ?? (() => new Date());
  const taskIdFactory = options.taskIdFactory ?? (() => `TASK-${randomUUID()}`);
  const snapshotReadHooks = options.snapshotReadHooks;
  const tasks = new Map<string, TaskCard>();
  const reservedTaskIds = new Set<string>();
  let hydration: Promise<void> | undefined;

  async function ensureHydrated(): Promise<void> {
    hydration ??= hydrateTasksFromDisk(workspaceRoot, tasks, snapshotReadHooks);
    await hydration;
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
      const taskId = nextTaskId(tasks, reservedTaskIds, taskIdFactory);
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

        await persistTaskSnapshot(workspaceRoot, task);
        tasks.set(task.task_id, task);
        return task;
      } finally {
        reservedTaskIds.delete(taskId);
      }
    },

    async listTasks(): Promise<TaskCard[]> {
      await ensureHydrated();
      return Array.from(tasks.values()).sort(compareTaskCards);
    },

    async getTask(taskId: string): Promise<TaskCard> {
      await ensureHydrated();
      assertSafeTaskId(taskId, `path.task_id:${taskId}`);
      const task = tasks.get(taskId);
      if (!task) {
        throw new TaskServiceError({
          code: "task_not_found",
          status: 404,
          category: "not_found",
          message: `Task not found: ${taskId}`,
          userMessage: "The requested task does not exist.",
          evidenceRefs: [`path.task_id:${taskId}`],
          recommendedNextActions: ["Refresh the task list and choose an existing task."]
        });
      }

      return task;
    }
  };
}

export function isSafeTaskId(taskId: string): boolean {
  return TASK_ID_PATTERN.test(taskId);
}

function nextTaskId(
  tasks: ReadonlyMap<string, TaskCard>,
  reservedTaskIds: ReadonlySet<string>,
  taskIdFactory: () => string
): string {
  for (let attempt = 0; attempt < MAX_TASK_ID_ATTEMPTS; attempt += 1) {
    const taskId = taskIdFactory();
    assertSafeTaskId(taskId, `generated_task_id:${taskId}`);
    if (!tasks.has(taskId) && !reservedTaskIds.has(taskId)) {
      return taskId;
    }
  }

  throw new TaskServiceError({
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
  tasks: Map<string, TaskCard>,
  snapshotReadHooks?: TaskSnapshotReadHooks
): Promise<void> {
  const workspaceEntry = await maybeLstat(workspaceRoot);
  if (!workspaceEntry) {
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
  const tasksRootEntry = await maybeLstat(tasksRoot);
  if (!tasksRootEntry) {
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

  const entries = await readdir(tasksRoot, { withFileTypes: true });
  if (entries.length > MAX_TASK_HYDRATION_ENTRIES) {
    throw workspaceError(
      "workspace_path_not_safe",
      `Workspace tasks root contains ${entries.length} entries, exceeding the M1 hydration limit of ${MAX_TASK_HYDRATION_ENTRIES}.`,
      "The workspace tasks directory has too many entries to hydrate safely.",
      ["workspace/tasks", "workspace/tasks:entry_count"]
    );
  }

  for (const entry of entries) {
    if (!isSafeTaskId(entry.name)) {
      continue;
    }

    const lanePath = join(tasksRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !(await isSafeExistingDirectoryPath(lanePath))) {
      throw workspaceError(
        "task_lane_not_directory",
        `Task lane is not a safe directory: ${entry.name}`,
        "A task snapshot lane is blocked by a non-directory filesystem entry.",
        [`workspace/tasks/${entry.name}`]
      );
    }

    const snapshotPath = join(lanePath, "snapshot.json");
    if (!(await maybeLstat(snapshotPath))) {
      continue;
    }

    await snapshotReadHooks?.beforeSnapshotOpen?.({ snapshotPath, laneTaskId: entry.name });
    const snapshot = await readTaskSnapshot(snapshotPath, entry.name);
    tasks.set(snapshot.task_id, snapshot.task_card);
  }
}

async function readTaskSnapshot(
  snapshotPath: string,
  laneTaskId: string
): Promise<TaskSnapshot & { task_card: TaskCard }> {
  let snapshotFile: SnapshotFileHandle;
  try {
    snapshotFile = await open(snapshotPath, TASK_SNAPSHOT_OPEN_FLAGS);
  } catch (error) {
    throw workspaceError(
      "task_snapshot_malformed",
      "Task snapshot cannot be opened safely.",
      "A task snapshot cannot be read safely.",
      [snapshotPath],
      error
    );
  }

  try {
    const snapshotEntry = await snapshotFile.stat().catch((error: unknown) => {
      throw workspaceError(
        "task_snapshot_malformed",
        "Task snapshot cannot be inspected.",
        "A task snapshot cannot be read safely.",
        [snapshotPath],
        error
      );
    });
    if (!snapshotEntry.isFile() || snapshotEntry.isSymbolicLink()) {
      throw workspaceError(
        "task_snapshot_malformed",
        "Task snapshot is not a safe regular file.",
        "A task snapshot cannot be read safely.",
        [snapshotPath]
      );
    }
    if (snapshotEntry.size > MAX_TASK_SNAPSHOT_BYTES) {
      throw workspaceError(
        "task_snapshot_malformed",
        "Task snapshot exceeds the M1 bounded read size.",
        "A task snapshot is too large to load safely.",
        [snapshotPath]
      );
    }

    const rawSnapshotText = await readBoundedTaskSnapshot(snapshotFile, snapshotPath);
    let rawSnapshot: unknown;
    try {
      rawSnapshot = JSON.parse(rawSnapshotText) as unknown;
    } catch (error) {
      throw workspaceError(
        "task_snapshot_malformed",
        "Task snapshot is not valid JSON.",
        "A task snapshot is malformed and recovery has been stopped.",
        [snapshotPath],
        error
      );
    }

    const parsedSnapshot = TaskSnapshotSchema.safeParse(rawSnapshot);
    if (!parsedSnapshot.success) {
      throw workspaceError(
        "task_snapshot_malformed",
        "Task snapshot failed schema validation.",
        "A task snapshot is malformed and recovery has been stopped.",
        [snapshotPath, ...toSchemaEvidenceRefs(parsedSnapshot.error, "snapshot")]
      );
    }

    assertSafeTaskId(parsedSnapshot.data.task_id, `snapshot.task_id:${parsedSnapshot.data.task_id}`);
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

    if (!parsedSnapshot.data.task_card) {
      throw workspaceError(
        "task_snapshot_missing_card",
        "Task snapshot does not include the M1 task_card recovery payload.",
        "A task snapshot is missing the data needed for recovery.",
        [`workspace/tasks/${laneTaskId}/snapshot.json`]
      );
    }

    validateSnapshotTaskCardConsistency(parsedSnapshot.data, snapshotPath);
    return parsedSnapshot.data as TaskSnapshot & { task_card: TaskCard };
  } finally {
    await snapshotFile.close().catch(() => undefined);
  }
}

async function readBoundedTaskSnapshot(
  snapshotFile: SnapshotFileHandle,
  snapshotPath: string
): Promise<string> {
  const buffer = Buffer.allocUnsafe(MAX_TASK_SNAPSHOT_BYTES + 1);
  let offset = 0;

  try {
    while (offset < buffer.length) {
      const { bytesRead } = await snapshotFile.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
  } catch (error) {
    throw workspaceError(
      "task_snapshot_malformed",
      "Task snapshot cannot be read safely.",
      "A task snapshot cannot be read safely.",
      [snapshotPath],
      error
    );
  }

  if (offset > MAX_TASK_SNAPSHOT_BYTES) {
    throw workspaceError(
      "task_snapshot_malformed",
      "Task snapshot exceeds the M1 bounded read size.",
      "A task snapshot is too large to load safely.",
      [snapshotPath]
    );
  }

  return buffer.subarray(0, offset).toString("utf8");
}

async function persistTaskSnapshot(workspaceRoot: string, task: TaskCard): Promise<void> {
  const taskDirectory = await ensureTaskDirectory(workspaceRoot, task.task_id);
  const snapshot = createTaskSnapshot(task);
  const snapshotPath = join(taskDirectory, "snapshot.json");
  assertPathInsideWorkspace(workspaceRoot, snapshotPath, `workspace/tasks/${task.task_id}/snapshot.json`);

  const temporaryPath = join(taskDirectory, `.snapshot-${process.pid}-${randomUUID()}.tmp`);
  assertPathInsideWorkspace(workspaceRoot, temporaryPath, `workspace/tasks/${task.task_id}/snapshot.tmp`);

  let wroteTemporary = false;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
    wroteTemporary = true;
    await rename(temporaryPath, snapshotPath);
    wroteTemporary = false;
  } catch (error) {
    throw workspaceError(
      "workspace_path_not_safe",
      "Failed to persist task snapshot under the configured workspace.",
      "The task snapshot could not be written safely.",
      [`workspace/tasks/${task.task_id}/snapshot.json`],
      error
    );
  } finally {
    if (wroteTemporary) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function createTaskSnapshot(task: TaskCard): TaskSnapshot & { task_card: TaskCard } {
  return TaskSnapshotSchema.parse({
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
  }) as TaskSnapshot & { task_card: TaskCard };
}

async function ensureTaskDirectory(workspaceRoot: string, taskId: string): Promise<string> {
  assertSafeTaskId(taskId, `task.task_id:${taskId}`);
  await ensureSafeDirectory(workspaceRoot, "workspace_path_not_safe");

  const tasksRoot = join(workspaceRoot, "tasks");
  assertPathInsideWorkspace(workspaceRoot, tasksRoot, "workspace/tasks");
  await ensureSafeDirectory(tasksRoot, "workspace_path_not_safe");

  const taskDirectory = join(tasksRoot, taskId);
  assertPathInsideWorkspace(workspaceRoot, taskDirectory, `workspace/tasks/${taskId}`);
  await ensureSafeDirectory(taskDirectory, "task_lane_not_directory");

  return taskDirectory;
}

async function ensureSafeDirectory(
  path: string,
  errorCode: Extract<TaskServiceErrorCode, "workspace_path_not_safe" | "task_lane_not_directory">
): Promise<void> {
  const existingEntry = await maybeLstat(path);
  if (existingEntry) {
    if (!(await isSafeExistingDirectoryPath(path))) {
      throw workspaceError(
        errorCode,
        `Path is not a safe directory: ${path}`,
        "A required workspace path is not a safe directory.",
        [path]
      );
    }
    return;
  }

  const parentPath = dirname(path);
  if (parentPath === path || !(await isSafeExistingDirectoryPath(parentPath))) {
    throw workspaceError(
      errorCode,
      `Parent path is not a safe directory: ${parentPath}`,
      "A required workspace parent path is not a safe directory.",
      [parentPath]
    );
  }

  try {
    await mkdir(path);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      if (await isSafeExistingDirectoryPath(path)) {
        return;
      }
      throw workspaceError(
        errorCode,
        `Existing path is not a safe directory: ${path}`,
        "A required workspace path is not a safe directory.",
        [path],
        error
      );
    }

    throw workspaceError(
      errorCode,
      `Failed to create workspace directory: ${path}`,
      "A required workspace directory could not be created safely.",
      [path],
      error
    );
  }

  if (!(await isSafeExistingDirectoryPath(path))) {
    throw workspaceError(
      errorCode,
      `Created path is not a safe directory: ${path}`,
      "A required workspace path is not a safe directory.",
      [path]
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

function assertPathInsideWorkspace(
  workspaceRoot: string,
  targetPath: string,
  evidenceRef: string
): void {
  const relativePath = relative(workspaceRoot, resolve(targetPath));
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return;
  }

  throw workspaceError(
    "workspace_path_not_safe",
    `Resolved path escapes workspace: ${targetPath}`,
    "A workspace path resolved outside the configured workspace.",
    [evidenceRef]
  );
}

function validateSnapshotTaskCardConsistency(snapshot: TaskSnapshot, snapshotPath: string): void {
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
      [snapshotPath, ...mismatches.map((field) => `snapshot.${field}`)]
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

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

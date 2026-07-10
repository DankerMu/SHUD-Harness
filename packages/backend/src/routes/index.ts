import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DEFAULT_TASK_CREATED_BY,
  CreateTaskInputSchema,
  MAX_TASK_SNAPSHOT_BYTES,
  TaskServiceError,
  canonicalJson,
  createIdempotencyMismatchError,
  createIdempotencyRecordService,
  createTaskCardService,
  isSafeTaskId,
  sha256Hex,
  type CreateTaskInput,
  type IdempotencyRecordService,
  type TaskCard,
  type TaskCardService,
  type TaskSnapshotReadHooks,
  type TaskSnapshotWriteHooks
} from "@shud-harness/core";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError } from "zod";
import {
  createApiRequestLoggerMiddleware,
  type ApiRequestLogSink
} from "../middleware";

export const BACKEND_ROUTES_NAMESPACE = "backend/routes" as const;

export type BackendRoutesNamespace = typeof BACKEND_ROUTES_NAMESPACE;

export const WORKSPACE_CANONICAL_DIRECTORIES = [
  "repos",
  "repos/SHUD",
  "repos/rSHUD",
  "repos/AutoSHUD",
  "repos/zero",
  "stacks",
  "data",
  "tasks",
  "jobs",
  "runs",
  "artifacts",
  "artifacts/logs",
  "artifacts/figures",
  "artifacts/metrics",
  "artifacts/reports",
  "artifacts/patches",
  "artifacts/repo_context",
  "artifacts/toolcalls",
  "artifacts/manifests",
  "reports",
  "sessions",
  "warehouse",
  "tmp",
  "snapshots",
  "locks",
  "exports",
  "packages",
  "notifications",
  "readiness"
] as const;

export type WorkspaceCanonicalDirectory = (typeof WORKSPACE_CANONICAL_DIRECTORIES)[number];
export type WorkspaceHealthCheckStatus = "ok" | "fail";
export type WorkspaceReadyStatus = "ok" | "not_ready";

export interface WorkspaceWritableProbeInput {
  workspaceRoot: string;
}

export type WorkspaceWritableProbe = (
  input: WorkspaceWritableProbeInput
) => Promise<boolean> | boolean;

export interface WorkspaceSnapshotReadableProbeInput {
  workspaceRoot: string;
  snapshotsPath: string;
}

export type WorkspaceSnapshotReadableProbe = (
  input: WorkspaceSnapshotReadableProbeInput
) => Promise<boolean> | boolean;

export interface BackendApiOptions {
  workspaceRoot?: string;
  version?: string;
  startTimeMs?: number;
  now?: () => Date;
  taskIdFactory?: () => string;
  taskSnapshotReadHooks?: TaskSnapshotReadHooks;
  taskSnapshotWriteHooks?: TaskSnapshotWriteHooks;
  requestIdFactory?: () => string;
  requestLogSink?: ApiRequestLogSink;
  writableProbe?: WorkspaceWritableProbe;
  snapshotReadableProbe?: WorkspaceSnapshotReadableProbe;
}

export interface WorkspaceInitResponse {
  status: "ok";
  directory_count: number;
  directories: readonly WorkspaceCanonicalDirectory[];
}

export interface WorkspaceLiveResponse {
  status: "ok";
  version: string;
  uptime_seconds: number;
  timestamp: string;
}

export interface WorkspaceReadyResponse {
  status: WorkspaceReadyStatus;
  timestamp: string;
  checks: {
    directory_tree: WorkspaceHealthCheckStatus;
    snapshot_readable: WorkspaceHealthCheckStatus;
    workspace_writable: WorkspaceHealthCheckStatus;
  };
  missing_directories?: readonly WorkspaceCanonicalDirectory[];
}

interface WorkspaceRoutesService {
  initWorkspace: () => Promise<WorkspaceInitResponse>;
  live: () => WorkspaceLiveResponse;
  ready: () => Promise<WorkspaceReadyResponse>;
}

export interface ApiErrorResponse {
  error: {
    error_id: string;
    category: string;
    severity: "info" | "warn" | "error" | "critical";
    message: string;
    user_message: string;
    evidence_refs: string[];
    retryable: boolean;
    recommended_next_actions: string[];
  };
}

export function createBackendApi(options: BackendApiOptions = {}): Hono {
  const app = new Hono();
  const workspaceRoot = resolveWorkspaceRoot(options);
  const service = createWorkspaceRoutesService({ ...options, workspaceRoot });
  const taskService = createTaskCardService({
    workspaceRoot,
    now: options.now,
    taskIdFactory: options.taskIdFactory,
    snapshotReadHooks: options.taskSnapshotReadHooks,
    snapshotWriteHooks: options.taskSnapshotWriteHooks
  });
  const idempotencyService = createIdempotencyRecordService({
    workspaceRoot,
    now: options.now
  });

  app.use(
    "*",
    createApiRequestLoggerMiddleware({
      now: options.now,
      requestIdFactory: options.requestIdFactory,
      sink: options.requestLogSink
    })
  );

  app.post("/api/workspace/init", async (c) => {
    try {
      return c.json(await service.initWorkspace(), 200);
    } catch {
      return c.json({ status: "error", error: "workspace_init_failed" }, 500);
    }
  });

  app.get("/api/health/live", (c) => c.json(service.live(), 200));

  app.get("/api/health/ready", async (c) => {
    const readiness = await service.ready();
    return c.json(readiness, readiness.status === "ok" ? 200 : 503);
  });

  app.post("/api/tasks", async (c) => {
    let idempotencyKey: ParsedIdempotencyKey;
    try {
      idempotencyKey = parseIdempotencyKey(c);
    } catch (error) {
      return jsonTaskServiceError(c, error);
    }

    let rawBody: unknown;
    try {
      rawBody =
        idempotencyKey.status === "present"
          ? parseJsonRequestText(await readBoundedKeyedTaskCreateRequestText(c))
          : await c.req.json();
    } catch (error) {
      if (error instanceof TaskServiceError) {
        return jsonTaskServiceError(c, error);
      }

      return jsonApiError(
        c,
        {
          category: "schema_error",
          severity: "error",
          message: "Request body is not valid JSON.",
          userMessage: "The task request body must be valid JSON.",
          evidenceRefs: ["request.body"],
          retryable: false,
          recommendedNextActions: ["Submit a JSON body matching the TaskCard create schema."]
        },
        400
      );
    }

    const parsedBody = CreateTaskInputSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return jsonApiError(
        c,
        {
          category: "schema_error",
          severity: "error",
          message: "Task create request failed schema validation.",
          userMessage: "The task request is missing required fields or contains invalid values.",
          evidenceRefs: zodEvidenceRefs(parsedBody.error),
          retryable: false,
          recommendedNextActions: ["Fix the highlighted request fields and submit again."]
        },
        400
      );
    }

    if (idempotencyKey.status === "absent") {
      try {
        return c.json(await taskService.createTask(parsedBody.data), 201);
      } catch (error) {
        return jsonTaskServiceError(c, error);
      }
    }

    try {
      assertKeyedTaskCreateRequestWithinDigestBounds(parsedBody.data);
      const requestDigest = taskCreateRequestDigest(parsedBody.data);
      const result = await createIdempotentTaskCard({
        input: parsedBody.data,
        workspaceRoot,
        idempotencyKey: idempotencyKey.key,
        requestDigest,
        taskService,
        idempotencyService
      });
      return c.json(result.task, result.created ? 201 : 200);
    } catch (error) {
      return jsonTaskServiceError(c, error);
    }
  });

  app.get("/api/tasks", async (c) => {
    try {
      return c.json({ tasks: await taskService.listTasks() }, 200);
    } catch (error) {
      return jsonTaskServiceError(c, error);
    }
  });

  app.get("/api/tasks/:id", async (c) => {
    const taskId = c.req.param("id");
    if (!isSafeTaskId(taskId)) {
      return jsonApiError(
        c,
        {
          category: "not_found",
          severity: "error",
          message: `Task not found: ${taskId}`,
          userMessage: "The requested task does not exist.",
          evidenceRefs: [`path.task_id:${taskId}`],
          retryable: false,
          recommendedNextActions: ["Refresh the task list and choose an existing task."]
        },
        404
      );
    }

    try {
      return c.json(await taskService.getTask(taskId), 200);
    } catch (error) {
      return jsonTaskServiceError(c, error);
    }
  });

  app.notFound((c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return jsonApiError(
        c,
        {
          category: "not_found",
          severity: "error",
          message: `API route not found: ${pathname}`,
          userMessage: "The requested API route does not exist.",
          evidenceRefs: [`path:${pathname}`],
          retryable: false,
          recommendedNextActions: ["Use one of the registered API routes."]
        },
        404
      );
    }

    return c.text("Not Found", 404);
  });

  return app;
}

const IDEMPOTENCY_REPLAY_WAIT_TIMEOUT_MS = 1000;
const IDEMPOTENCY_REPLAY_POLL_INTERVAL_MS = 10;
const MAX_IN_FLIGHT_IDEMPOTENT_TASK_CREATES = 1024;

type ParsedIdempotencyKey = { status: "absent" } | { status: "present"; key: string };

interface IdempotentTaskCreateResult {
  task: TaskCard;
  created: boolean;
}

interface CreateIdempotentTaskCardInput {
  input: CreateTaskInput;
  workspaceRoot: string;
  idempotencyKey: string;
  requestDigest: string;
  taskService: TaskCardService;
  idempotencyService: IdempotencyRecordService;
}

interface InFlightIdempotentTaskCreateEntry {
  done: Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

const inFlightIdempotentTaskCreates = new Map<string, InFlightIdempotentTaskCreateEntry>();

async function createIdempotentTaskCard(
  input: CreateIdempotentTaskCardInput
): Promise<IdempotentTaskCreateResult> {
  const inFlightIdentity = idempotentTaskCreateInFlightIdentity(input);
  const existingEntry = inFlightIdempotentTaskCreates.get(inFlightIdentity);
  if (existingEntry) {
    return await waitForInFlightIdempotentTaskCreate(input, existingEntry);
  }

  if (inFlightIdempotentTaskCreates.size >= MAX_IN_FLIGHT_IDEMPOTENT_TASK_CREATES) {
    throw new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "workspace_error",
      message: "Too many task idempotency requests are active in this process.",
      userMessage: "The backend is already processing too many idempotent task creates.",
      evidenceRefs: ["workspace/tasks/_idempotency/task"],
      retryable: true,
      recommendedNextActions: ["Retry after active task create requests finish."]
    });
  }

  const owner = createDeferred<void>();
  owner.promise.catch(() => undefined);
  const entry: InFlightIdempotentTaskCreateEntry = { done: owner.promise };
  inFlightIdempotentTaskCreates.set(inFlightIdentity, entry);

  try {
    const result = await createOwnedIdempotentTaskCard(input);
    owner.resolve();
    return result;
  } catch (error) {
    owner.reject(error);
    throw error;
  } finally {
    if (inFlightIdempotentTaskCreates.get(inFlightIdentity) === entry) {
      inFlightIdempotentTaskCreates.delete(inFlightIdentity);
    }
  }
}

async function createOwnedIdempotentTaskCard(
  input: CreateIdempotentTaskCardInput
): Promise<IdempotentTaskCreateResult> {
  const begin = await input.idempotencyService.beginRecord({
    scope: "task",
    key: input.idempotencyKey,
    requestDigest: input.requestDigest
  });

  if (begin.status === "mismatch") {
    throw createIdempotencyMismatchError();
  }
  if (begin.status === "completed") {
    return {
      task: await getIdempotentTaskResult(
        input.taskService,
        begin.record.result_ref,
        input.requestDigest
      ),
      created: false
    };
  }
  if (begin.status === "incomplete") {
    return await waitForIdempotentTaskCompletion(input);
  }

  let task: TaskCard;
  try {
    task = await input.taskService.createTask(input.input);
  } catch (error) {
    await input.idempotencyService.recoverFailedRecordAfterRollback({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest
    });
    throw error;
  }

  let completedRecord: Awaited<ReturnType<IdempotencyRecordService["completeRecord"]>>;
  try {
    const replayBeforeCompletion = await input.idempotencyService.lookupReplay({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest
    });
    if (replayBeforeCompletion.status === "mismatch") {
      throw createIdempotencyMismatchError();
    }
    if (replayBeforeCompletion.status !== "completed") {
      await assertTaskSnapshotBindsRequest(input.taskService, task, input.requestDigest);
    }
    completedRecord = await input.idempotencyService.completeRecord({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest,
      resultRef: task.task_id
    });
  } catch (error) {
    let rollbackError: unknown;
    try {
      await input.taskService.rollbackTaskForIdempotency(task.task_id);
    } catch (caughtError) {
      rollbackError = caughtError;
    }

    if (rollbackError) {
      const remainingSnapshot = await inspectRemainingRollbackTaskSnapshot(
        input.taskService,
        task
      );
      if (remainingSnapshot.status === "matched") {
        await input.idempotencyService.recoverCompletedRecordAfterRollbackFailure({
          scope: "task",
          key: input.idempotencyKey,
          requestDigest: input.requestDigest,
          resultRef: task.task_id
        });
        return { task: remainingSnapshot.task, created: true };
      }
      if (remainingSnapshot.status === "missing") {
        await input.idempotencyService.recoverFailedRecordAfterRollback({
          scope: "task",
          key: input.idempotencyKey,
          requestDigest: input.requestDigest
        });
        throw error;
      }

      await input.idempotencyService.quarantineRecordAfterUnsafeRollback({
        scope: "task",
        key: input.idempotencyKey,
        requestDigest: input.requestDigest
      });
      throw rollbackError;
    }

    await input.idempotencyService.recoverFailedRecordAfterRollback({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest
    });
    throw error;
  }

  if (completedRecord.status !== "completed" || !completedRecord.result_ref) {
    throw idempotencyResultBindingError();
  }
  if (completedRecord.result_ref !== task.task_id) {
    let convergenceRollbackError: unknown;
    try {
      await input.taskService.rollbackTaskForIdempotency(task.task_id);
    } catch (caughtError) {
      convergenceRollbackError = caughtError;
    }
    if (convergenceRollbackError) {
      const remainingSnapshot = await inspectRemainingRollbackTaskSnapshot(
        input.taskService,
        task
      );
      if (remainingSnapshot.status !== "missing") {
        throw convergenceRollbackError;
      }
    }

    const authoritativeTask = await getIdempotentTaskResult(
      input.taskService,
      completedRecord.result_ref,
      input.requestDigest
    );
    return { task: authoritativeTask, created: false };
  }

  return { task, created: true };
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred!: (value: T | PromiseLike<T>) => void;
  let rejectDeferred!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });

  return {
    promise,
    resolve: resolveDeferred,
    reject: rejectDeferred
  };
}

function idempotentTaskCreateInFlightIdentity(input: CreateIdempotentTaskCardInput): string {
  return sha256Hex(
    canonicalJson({
      workspace: sha256Hex(resolve(input.workspaceRoot)),
      scope: "task",
      key: sha256Hex(input.idempotencyKey),
      request_digest: input.requestDigest
    })
  );
}

async function waitForInFlightIdempotentTaskCreate(
  input: CreateIdempotentTaskCardInput,
  entry: InFlightIdempotentTaskCreateEntry
): Promise<IdempotentTaskCreateResult> {
  await entry.done;
  const replay = await input.idempotencyService.lookupReplay({
    scope: "task",
    key: input.idempotencyKey,
    requestDigest: input.requestDigest
  });

  if (replay.status === "mismatch") {
    throw createIdempotencyMismatchError();
  }
  if (replay.status !== "completed") {
    throw idempotencyInFlightCompletionError();
  }

  return {
    task: await getIdempotentTaskResult(
      input.taskService,
      replay.record.result_ref,
      input.requestDigest
    ),
    created: false
  };
}

async function assertTaskSnapshotBindsRequest(
  taskService: TaskCardService,
  task: TaskCard,
  requestDigest: string
): Promise<void> {
  const snapshotTask = await taskService.getTaskFromSnapshot(task.task_id);
  if (JSON.stringify(snapshotTask) !== JSON.stringify(task)) {
    throw idempotencyResultBindingError();
  }
  if (taskCreateRequestDigestFromTask(snapshotTask) !== requestDigest) {
    throw idempotencyResultBindingError();
  }
}

type RemainingRollbackTaskSnapshot =
  | { status: "matched"; task: TaskCard }
  | { status: "missing" }
  | { status: "unsafe" };

async function inspectRemainingRollbackTaskSnapshot(
  taskService: TaskCardService,
  task: TaskCard
): Promise<RemainingRollbackTaskSnapshot> {
  try {
    const remainingTask = await taskService.getTaskFromSnapshot(task.task_id);
    if (JSON.stringify(remainingTask) === JSON.stringify(task)) {
      return { status: "matched", task: remainingTask };
    }

    return { status: "unsafe" };
  } catch (error) {
    if (error instanceof TaskServiceError && error.code === "task_not_found") {
      return { status: "missing" };
    }

    return { status: "unsafe" };
  }
}

async function waitForIdempotentTaskCompletion(
  input: CreateIdempotentTaskCardInput
): Promise<IdempotentTaskCreateResult> {
  const deadline = Date.now() + IDEMPOTENCY_REPLAY_WAIT_TIMEOUT_MS;

  for (;;) {
    const replay = await input.idempotencyService.lookupReplay({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest
    });

    if (replay.status === "mismatch") {
      throw createIdempotencyMismatchError();
    }
    if (replay.status === "completed") {
      return {
        task: await getIdempotentTaskResult(
          input.taskService,
          replay.record.result_ref,
          input.requestDigest
        ),
        created: false
      };
    }

    if (Date.now() >= deadline) {
      throw new TaskServiceError({
        code: "record_malformed",
        status: 409,
        category: "workspace_error",
        message: "Idempotency record did not complete before replay timeout.",
        userMessage: "The task create request is still pending idempotency completion.",
        evidenceRefs: ["workspace/tasks/_idempotency/task"],
        retryable: true,
        recommendedNextActions: ["Retry after the in-progress task create request finishes."]
      });
    }

    await sleep(IDEMPOTENCY_REPLAY_POLL_INTERVAL_MS);
  }
}

async function getIdempotentTaskResult(
  taskService: TaskCardService,
  taskId: string,
  requestDigest: string
): Promise<TaskCard> {
  if (!isSafeTaskId(taskId)) {
    throw new TaskServiceError({
      code: "record_malformed",
      status: 500,
      category: "workspace_error",
      message: "Completed task idempotency result_ref is not a safe TaskCard id.",
      userMessage: "The idempotency result reference cannot be used safely.",
      evidenceRefs: ["idempotency.result_ref"],
      retryable: false,
      recommendedNextActions: ["Inspect and repair the idempotency result reference before retrying."]
    });
  }

  let task: TaskCard;
  try {
    task = await taskService.getTaskFromSnapshot(taskId);
  } catch (error) {
    if (error instanceof TaskServiceError) {
      if (error.code === "task_snapshot_missing_card") {
        throw error;
      }
      throw idempotencyResultBindingError();
    }

    throw error;
  }

  if (taskCreateRequestDigestFromTask(task) !== requestDigest) {
    throw idempotencyResultBindingError();
  }

  return task;
}

async function readBoundedKeyedTaskCreateRequestText(c: Context): Promise<string> {
  const contentLength = c.req.header("content-length");
  if (typeof contentLength === "string" && contentLength.trim().length > 0) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_TASK_SNAPSHOT_BYTES) {
      throw oversizedTaskCreateRequestError(["request.body"]);
    }
  }

  const body = c.req.raw.body;
  if (!body) {
    return "";
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let decoded = "";
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > MAX_TASK_SNAPSHOT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw oversizedTaskCreateRequestError(["request.body"]);
      }

      decoded += decoder.decode(value, { stream: true });
    }
  } finally {
    decoded += decoder.decode();
  }

  return decoded;
}

function parseJsonRequestText(rawText: string): unknown {
  return JSON.parse(rawText) as unknown;
}

function assertKeyedTaskCreateRequestWithinDigestBounds(input: CreateTaskInput): void {
  const fields: Array<[string, string | undefined]> = [
    ["request.body.title", input.title],
    ["request.body.question_or_goal", input.question_or_goal],
    ["request.body.created_by", input.created_by]
  ];

  for (const [evidenceRef, value] of fields) {
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_TASK_SNAPSHOT_BYTES) {
      throw oversizedTaskCreateRequestError([evidenceRef]);
    }
  }

  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_TASK_SNAPSHOT_BYTES) {
    throw oversizedTaskCreateRequestError(["request.body"]);
  }
}

function oversizedTaskCreateRequestError(evidenceRefs: string[]): TaskServiceError {
  return new TaskServiceError({
    code: "task_snapshot_too_large",
    status: 400,
    category: "schema_error",
    message: "Task create request exceeds the M1 bounded idempotency digest size.",
    userMessage: "The task request is too large to process safely.",
    evidenceRefs,
    retryable: false,
    recommendedNextActions: ["Shorten the task title, goal, or creator fields and submit again."]
  });
}

function taskCreateRequestDigest(input: CreateTaskInput): string {
  return sha256Hex(
    canonicalJson({
      ...input,
      created_by: input.created_by ?? DEFAULT_TASK_CREATED_BY
    })
  );
}

function taskCreateRequestDigestFromTask(task: TaskCard): string {
  return sha256Hex(
    canonicalJson({
      type: task.type,
      title: task.title,
      question_or_goal: task.question_or_goal,
      inference_budget: task.inference_budget,
      created_by: task.created_by
    })
  );
}

function idempotencyResultBindingError(): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 500,
    category: "workspace_error",
    message: "Completed idempotency result is not bound to the task create request.",
    userMessage: "The idempotency result cannot be used safely.",
    evidenceRefs: ["workspace/tasks/_idempotency/task", "idempotency.result_ref"],
    retryable: false,
    recommendedNextActions: ["Inspect and repair the idempotency record before retrying."]
  });
}

function idempotencyInFlightCompletionError(): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 409,
    category: "workspace_error",
    message: "Active idempotent task create finished without a completed durable result.",
    userMessage: "The task create request did not publish a replayable idempotency result.",
    evidenceRefs: ["workspace/tasks/_idempotency/task"],
    retryable: true,
    recommendedNextActions: ["Retry after repairing the task snapshot or idempotency record state."]
  });
}

function parseIdempotencyKey(c: Context): ParsedIdempotencyKey {
  const header = c.req.header("Idempotency-Key");
  if (typeof header !== "string") {
    return { status: "absent" };
  }

  const trimmedHeader = header.trim();
  if (trimmedHeader.length > 0) {
    return { status: "present", key: trimmedHeader };
  }

  throw new TaskServiceError({
    code: "schema_error",
    status: 400,
    category: "schema_error",
    message: "Idempotency-Key header must be nonblank when provided.",
    userMessage: "The idempotency key must be nonblank when provided.",
    evidenceRefs: ["request.headers.Idempotency-Key"],
    retryable: false,
    recommendedNextActions: ["Provide a nonblank idempotency key or omit the header."]
  });
}

function jsonTaskServiceError(c: Context, error: unknown): Response {
  if (error instanceof TaskServiceError) {
    return jsonApiError(
      c,
      {
        category: error.category,
        severity: "error",
        message: error.message,
        userMessage: error.userMessage,
        evidenceRefs: error.evidenceRefs,
        retryable: error.retryable,
        recommendedNextActions: error.recommendedNextActions
      },
      error.status
    );
  }

  return jsonApiError(
    c,
    {
      category: "workspace_error",
      severity: "error",
      message: "Unexpected backend route failure.",
      userMessage: "The backend could not complete the request.",
      evidenceRefs: ["backend/routes"],
      retryable: false,
      recommendedNextActions: ["Inspect backend logs before retrying."]
    },
    500
  );
}

function jsonApiError(
  c: Context,
  input: Omit<ApiErrorResponse["error"], "error_id" | "user_message" | "evidence_refs" | "recommended_next_actions"> & {
    userMessage: string;
    evidenceRefs: string[];
    recommendedNextActions: string[];
  },
  status: ContentfulStatusCode
): Response {
  return c.json(
    {
      error: {
        error_id: `api_error_${randomUUID()}`,
        category: input.category,
        severity: input.severity,
        message: input.message,
        user_message: input.userMessage,
        evidence_refs: input.evidenceRefs,
        retryable: input.retryable,
        recommended_next_actions: input.recommendedNextActions
      }
    } satisfies ApiErrorResponse,
    status
  );
}

function zodEvidenceRefs(error: ZodError): string[] {
  return Array.from(
    new Set(
      error.issues.map((issue) =>
        issue.path.length > 0 ? `request.body.${issue.path.join(".")}` : "request.body"
      )
    )
  );
}

export function createWorkspaceRoutesService(
  options: BackendApiOptions = {}
): WorkspaceRoutesService {
  const workspaceRoot = resolveWorkspaceRoot(options);
  const version = options.version ?? process.env.npm_package_version ?? "0.0.0";
  const now = options.now ?? (() => new Date());
  const startTimeMs = options.startTimeMs ?? Date.now();
  const writableProbe = options.writableProbe ?? defaultWorkspaceWritableProbe;
  const snapshotReadableProbe =
    options.snapshotReadableProbe ?? defaultSnapshotReadableProbe;

  return {
    async initWorkspace(): Promise<WorkspaceInitResponse> {
      await ensureWorkspaceRootDirectory(workspaceRoot);
      for (const relativeDir of WORKSPACE_CANONICAL_DIRECTORIES) {
        await ensureSafeWorkspaceDirectory(workspaceRoot, relativeDir);
      }

      return {
        status: "ok",
        directory_count: WORKSPACE_CANONICAL_DIRECTORIES.length,
        directories: WORKSPACE_CANONICAL_DIRECTORIES
      };
    },

    live(): WorkspaceLiveResponse {
      const currentTime = now();
      return {
        status: "ok",
        version,
        uptime_seconds: Math.max(0, (currentTime.getTime() - startTimeMs) / 1000),
        timestamp: currentTime.toISOString()
      };
    },

    async ready(): Promise<WorkspaceReadyResponse> {
      const missingDirectories = await findMissingWorkspaceDirectories(workspaceRoot);
      const snapshotReadable = await probeSnapshotReadable(
        workspaceRoot,
        snapshotReadableProbe
      );
      const workspaceWritable = await probeWorkspaceWritable(workspaceRoot, writableProbe);
      const checks = {
        directory_tree: statusFromBoolean(missingDirectories.length === 0),
        snapshot_readable: statusFromBoolean(snapshotReadable),
        workspace_writable: statusFromBoolean(workspaceWritable)
      };
      const isReady = Object.values(checks).every((status) => status === "ok");

      return {
        status: isReady ? "ok" : "not_ready",
        timestamp: now().toISOString(),
        checks,
        ...(missingDirectories.length > 0 ? { missing_directories: missingDirectories } : {})
      };
    }
  };
}

function resolveWorkspaceRoot(options: BackendApiOptions): string {
  return resolve(
    firstNonBlankString(
      options.workspaceRoot,
      process.env.HARNESS_WORKSPACE_DIR,
      process.env.SHUD_HARNESS_WORKSPACE_ROOT,
      "workspace"
    )
  );
}

function firstNonBlankString(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmedValue = value.trim();
    if (trimmedValue.length > 0) {
      return trimmedValue;
    }
  }

  return "workspace";
}

async function findMissingWorkspaceDirectories(
  workspaceRoot: string
): Promise<WorkspaceCanonicalDirectory[]> {
  const missingDirectories: WorkspaceCanonicalDirectory[] = [];

  for (const relativeDir of WORKSPACE_CANONICAL_DIRECTORIES) {
    if (!(await isSafeWorkspaceDirectory(workspaceRoot, relativeDir))) {
      missingDirectories.push(relativeDir);
    }
  }

  return missingDirectories;
}

async function ensureWorkspaceRootDirectory(workspaceRoot: string): Promise<void> {
  const existingEntry = await maybeLstat(workspaceRoot);
  if (existingEntry) {
    if (!(await isSafeExistingDirectoryPath(workspaceRoot))) {
      throw new Error("workspace_root_not_safe");
    }
    return;
  }

  const parentPath = dirname(workspaceRoot);
  if (parentPath === workspaceRoot || !(await isSafeExistingDirectoryPath(parentPath))) {
    throw new Error("workspace_root_not_safe");
  }

  try {
    await mkdir(workspaceRoot);
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }

  if (!(await isSafeExistingDirectoryPath(workspaceRoot))) {
    throw new Error("workspace_root_not_safe");
  }
}

async function ensureSafeWorkspaceDirectory(
  workspaceRoot: string,
  relativeDir: WorkspaceCanonicalDirectory
): Promise<void> {
  await ensureWorkspaceRootDirectory(workspaceRoot);

  let currentPath = workspaceRoot;
  for (const segment of relativeDir.split("/")) {
    currentPath = join(currentPath, segment);
    await ensureSafeDirectorySegment(currentPath, "workspace_directory_not_safe");
  }
}

async function probeSnapshotReadable(
  workspaceRoot: string,
  snapshotReadableProbe: WorkspaceSnapshotReadableProbe
): Promise<boolean> {
  const snapshotsPath = join(workspaceRoot, "snapshots");
  if (!(await isSafeWorkspaceDirectory(workspaceRoot, "snapshots"))) {
    return false;
  }

  try {
    const readable = await snapshotReadableProbe({ workspaceRoot, snapshotsPath });
    return Boolean(readable) && (await isSafeWorkspaceDirectory(workspaceRoot, "snapshots"));
  } catch {
    return false;
  }
}

async function defaultSnapshotReadableProbe(
  input: WorkspaceSnapshotReadableProbeInput
): Promise<boolean> {
  try {
    await access(input.snapshotsPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function isSafeWorkspaceDirectory(
  workspaceRoot: string,
  relativeDir: WorkspaceCanonicalDirectory
): Promise<boolean> {
  return await isSafeExistingDirectoryPath(join(workspaceRoot, relativeDir));
}

async function isAcceptedWorkspaceRootDirectory(workspaceRoot: string): Promise<boolean> {
  return await isSafeExistingDirectoryPath(workspaceRoot);
}

async function maybeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

async function probeWorkspaceWritable(
  workspaceRoot: string,
  writableProbe: WorkspaceWritableProbe
): Promise<boolean> {
  if (!(await isAcceptedWorkspaceRootDirectory(workspaceRoot))) {
    return false;
  }

  try {
    const writable = await writableProbe({ workspaceRoot });
    return Boolean(writable) && (await isAcceptedWorkspaceRootDirectory(workspaceRoot));
  } catch {
    return false;
  }
}

function statusFromBoolean(value: boolean): WorkspaceHealthCheckStatus {
  return value ? "ok" : "fail";
}

async function defaultWorkspaceWritableProbe(input: WorkspaceWritableProbeInput): Promise<boolean> {
  if (!(await isAcceptedWorkspaceRootDirectory(input.workspaceRoot))) {
    return false;
  }

  const probePath = join(
    input.workspaceRoot,
    `.health-write-probe-${process.pid}-${randomUUID()}`
  );

  let createdProbe = false;
  try {
    await writeFile(probePath, "", { flag: "wx" });
    createdProbe = true;
    return await isAcceptedWorkspaceRootDirectory(input.workspaceRoot);
  } catch {
    return false;
  } finally {
    if (createdProbe && (await isAcceptedWorkspaceRootDirectory(input.workspaceRoot))) {
      await unlink(probePath).catch(() => undefined);
    }
  }
}

async function ensureSafeDirectorySegment(path: string, errorCode: string): Promise<void> {
  const existingEntry = await maybeLstat(path);
  if (existingEntry) {
    if (!(await isSafeExistingDirectoryPath(path))) {
      throw new Error(errorCode);
    }
    return;
  }

  const parentPath = dirname(path);
  if (parentPath !== path && !(await isSafeExistingDirectoryPath(parentPath))) {
    throw new Error(errorCode);
  }

  try {
    await mkdir(path);
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }

  if (!(await isSafeExistingDirectoryPath(path))) {
    throw new Error(errorCode);
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

function isSafeDirectoryEntry(
  entry: Awaited<ReturnType<typeof lstat>> | undefined
): boolean {
  return Boolean(entry?.isDirectory() && !entry.isSymbolicLink());
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

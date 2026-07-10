import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, realpath, unlink, writeFile } from "node:fs/promises";
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
  type InvalidCompletedIdempotencyRecordLookup,
  type IdempotencyRecordServiceOptions,
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

export type IdempotencyRecordServiceFactory = (
  options: IdempotencyRecordServiceOptions
) => IdempotencyRecordService;

export interface BackendApiOptions {
  workspaceRoot?: string;
  version?: string;
  startTimeMs?: number;
  now?: () => Date;
  taskIdFactory?: () => string;
  taskSnapshotReadHooks?: TaskSnapshotReadHooks;
  taskSnapshotWriteHooks?: TaskSnapshotWriteHooks;
  idempotencyServiceFactory?: IdempotencyRecordServiceFactory;
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
  const idempotencyService = (options.idempotencyServiceFactory ?? createIdempotencyRecordService)({
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
const IN_FLIGHT_FOLLOWER_WAIT_TIMEOUT_MS = 5000;
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
  requestDigest: string;
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
  const inFlightIdentity = await idempotentTaskCreateInFlightIdentity(input);
  const existingEntry = inFlightIdempotentTaskCreates.get(inFlightIdentity);
  if (existingEntry) {
    if (existingEntry.requestDigest !== input.requestDigest) {
      throw createIdempotencyMismatchError();
    }
    return await waitForInFlightIdempotentTaskCreate(input, existingEntry);
  }

  if (inFlightIdempotentTaskCreates.size >= MAX_IN_FLIGHT_IDEMPOTENT_TASK_CREATES) {
    const durableResult = await resolveIdempotentTaskCreateWithoutOwner(input);
    if (durableResult !== undefined) {
      return durableResult;
    }

    const racedEntry = inFlightIdempotentTaskCreates.get(inFlightIdentity);
    if (racedEntry) {
      if (racedEntry.requestDigest !== input.requestDigest) {
        throw createIdempotencyMismatchError();
      }
      return await waitForInFlightIdempotentTaskCreate(input, racedEntry);
    }
    if (inFlightIdempotentTaskCreates.size >= MAX_IN_FLIGHT_IDEMPOTENT_TASK_CREATES) {
      throw idempotencyInFlightCapacityError();
    }
  }

  const owner = createDeferred<void>();
  owner.promise.catch(() => undefined);
  const entry: InFlightIdempotentTaskCreateEntry = {
    done: owner.promise,
    requestDigest: input.requestDigest
  };
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
  if (begin.status === "invalid_completed") {
    return await invalidateInvalidCompletedTaskAuthority(input, begin);
  }
  if (begin.status === "completed") {
    return completedTaskCreateResultWithoutLocal(
      await classifyCompletedTaskAuthority(input, begin.record.result_ref)
    );
  }
  if (begin.status === "incomplete") {
    return await waitForIdempotentTaskCompletion(input);
  }

  let task: TaskCard;
  try {
    task = await input.taskService.createTask(input.input);
  } catch (error) {
    const authority = await classifyCompletedTaskAuthorityIfPresent(input);
    if (authority.status !== "absent") {
      return completedTaskCreateResultWithoutLocal(authority);
    }

    await input.idempotencyService.recoverFailedRecordAfterRollback({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest
    });
    throw error;
  }

  let authority: ObservedCompletedTaskAuthorityClassification;
  try {
    const replayBeforeCompletion = await input.idempotencyService.lookupReplay({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest
    });
    if (replayBeforeCompletion.status === "mismatch") {
      throw createIdempotencyMismatchError();
    }
    if (replayBeforeCompletion.status === "invalid_completed") {
      return await invalidateInvalidCompletedTaskAuthority(input, replayBeforeCompletion);
    }
    if (replayBeforeCompletion.status === "completed") {
      authority = await classifyCompletedTaskAuthority(
        input,
        replayBeforeCompletion.record.result_ref
      );
    } else {
      await assertTaskSnapshotBindsRequest(input.taskService, task, input.requestDigest);
      const completedRecord = await input.idempotencyService.completeRecord({
        scope: "task",
        key: input.idempotencyKey,
        requestDigest: input.requestDigest,
        resultRef: task.task_id
      });
      if (completedRecord.status !== "completed" || !completedRecord.result_ref) {
        throw idempotencyResultBindingError();
      }
      authority = await classifyCompletedTaskAuthority(input, completedRecord.result_ref);
    }
  } catch (error) {
    let recoveredAuthority: CompletedTaskAuthorityClassification = { status: "absent" };
    let authorityError: unknown;
    try {
      recoveredAuthority = await classifyCompletedTaskAuthorityIfPresent(input);
    } catch (reconciliationError) {
      authorityError = reconciliationError;
    }

    if (authorityError !== undefined) {
      await rollbackLocalTaskAfterAuthorityFailure(input, task);
      throw authorityError;
    }
    if (recoveredAuthority.status !== "absent") {
      return await settleLocalTaskAgainstCompletedAuthority(input, task, recoveredAuthority);
    }

    await rollbackLocalTaskAfterAuthorityFailure(input, task);
    await input.idempotencyService.recoverFailedRecordAfterRollback({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest
    });
    throw error;
  }

  return await settleLocalTaskAgainstCompletedAuthority(input, task, authority);
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

async function idempotentTaskCreateInFlightIdentity(
  input: CreateIdempotentTaskCardInput
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      workspace: sha256Hex(await canonicalInFlightWorkspaceIdentity(input.workspaceRoot)),
      scope: "task",
      key: sha256Hex(input.idempotencyKey)
    })
  );
}

async function canonicalInFlightWorkspaceIdentity(workspaceRoot: string): Promise<string> {
  const resolvedRoot = resolve(workspaceRoot);
  try {
    await ensureWorkspaceRootDirectory(resolvedRoot);
  } catch {
    throw workspaceInFlightIdentityError();
  }

  if (!(await isSafeExistingDirectoryPath(resolvedRoot))) {
    throw workspaceInFlightIdentityError();
  }

  let firstPhysicalRoot: string;
  let secondPhysicalRoot: string;
  try {
    firstPhysicalRoot = await realpath(resolvedRoot);
    if (!(await isSafeExistingDirectoryPath(resolvedRoot))) {
      throw workspaceInFlightIdentityError();
    }
    secondPhysicalRoot = await realpath(resolvedRoot);
  } catch (error) {
    if (error instanceof TaskServiceError) {
      throw error;
    }
    throw workspaceInFlightIdentityError();
  }
  if (firstPhysicalRoot !== secondPhysicalRoot) {
    throw workspaceInFlightIdentityError();
  }

  return firstPhysicalRoot;
}

async function resolveIdempotentTaskCreateWithoutOwner(
  input: CreateIdempotentTaskCardInput
): Promise<IdempotentTaskCreateResult | undefined> {
  const replay = await input.idempotencyService.lookupReplay({
    scope: "task",
    key: input.idempotencyKey,
    requestDigest: input.requestDigest
  });
  if (replay.status === "mismatch") {
    throw createIdempotencyMismatchError();
  }
  if (replay.status === "invalid_completed") {
    return await invalidateInvalidCompletedTaskAuthority(input, replay);
  }
  if (replay.status === "completed") {
    return completedTaskCreateResultWithoutLocal(
      await classifyCompletedTaskAuthority(input, replay.record.result_ref)
    );
  }
  if (replay.status === "incomplete" && replay.record.status === "started") {
    return await waitForIdempotentTaskCompletion(input);
  }

  return undefined;
}

async function waitForInFlightIdempotentTaskCreate(
  input: CreateIdempotentTaskCardInput,
  entry: InFlightIdempotentTaskCreateEntry
): Promise<IdempotentTaskCreateResult> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const followerTimeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(idempotencyInFlightWaitTimeoutError()),
      IN_FLIGHT_FOLLOWER_WAIT_TIMEOUT_MS
    );
  });

  try {
    await Promise.race([entry.done, followerTimeout]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }

  const replay = await input.idempotencyService.lookupReplay({
    scope: "task",
    key: input.idempotencyKey,
    requestDigest: input.requestDigest
  });

  if (replay.status === "mismatch") {
    throw createIdempotencyMismatchError();
  }
  if (replay.status === "invalid_completed") {
    return await invalidateInvalidCompletedTaskAuthority(input, replay);
  }
  if (replay.status !== "completed") {
    throw idempotencyInFlightCompletionError();
  }

  return completedTaskCreateResultWithoutLocal(
    await classifyCompletedTaskAuthority(input, replay.record.result_ref)
  );
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

type ObservedCompletedTaskAuthorityClassification =
  | { status: "valid"; task: TaskCard; resultRef: string }
  | { status: "repairable"; error: TaskServiceError; resultRef: string }
  | {
      status: "invalid";
      reason: "invalid_durable_task_authority";
      error: TaskServiceError;
      resultRef: string;
    };

type CompletedTaskAuthorityClassification =
  | ObservedCompletedTaskAuthorityClassification
  | { status: "absent" };

async function classifyCompletedTaskAuthorityIfPresent(
  input: CreateIdempotentTaskCardInput
): Promise<CompletedTaskAuthorityClassification> {
  const replay = await input.idempotencyService.lookupReplay({
    scope: "task",
    key: input.idempotencyKey,
    requestDigest: input.requestDigest
  });
  if (replay.status === "mismatch") {
    throw createIdempotencyMismatchError();
  }
  if (replay.status === "invalid_completed") {
    return await invalidateInvalidCompletedTaskAuthority(input, replay);
  }
  if (replay.status !== "completed") {
    return { status: "absent" };
  }

  return await classifyCompletedTaskAuthority(input, replay.record.result_ref);
}

async function classifyCompletedTaskAuthority(
  input: CreateIdempotentTaskCardInput,
  resultRef: string
): Promise<ObservedCompletedTaskAuthorityClassification> {
  try {
    return {
      status: "valid",
      task: await getIdempotentTaskResult(input.taskService, resultRef, input.requestDigest),
      resultRef
    };
  } catch (error) {
    if (
      isSafeTaskId(resultRef) &&
      error instanceof TaskServiceError &&
      error.code === "task_snapshot_missing_card"
    ) {
      return { status: "repairable", error, resultRef };
    }

    const authorityError = invalidDurableTaskAuthorityError();
    await input.idempotencyService.invalidateCompletedRecord({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest,
      resultRef
    });
    return {
      status: "invalid",
      reason: "invalid_durable_task_authority",
      error: authorityError,
      resultRef
    };
  }
}

function completedTaskCreateResultWithoutLocal(
  authority: ObservedCompletedTaskAuthorityClassification
): IdempotentTaskCreateResult {
  if (authority.status === "valid") {
    return { task: authority.task, created: false };
  }
  if (authority.status === "repairable") {
    throw authority.error;
  }

  throw authority.error;
}

async function settleLocalTaskAgainstCompletedAuthority(
  input: CreateIdempotentTaskCardInput,
  localTask: TaskCard,
  authority: ObservedCompletedTaskAuthorityClassification
): Promise<IdempotentTaskCreateResult> {
  if (authority.status === "valid" && authority.resultRef === localTask.task_id) {
    return { task: authority.task, created: true };
  }

  await rollbackLocalTaskAfterAuthorityFailure(input, localTask);
  if (authority.status === "valid") {
    return { task: authority.task, created: false };
  }
  if (authority.status === "repairable") {
    throw authority.error;
  }

  await input.idempotencyService.recoverFailedRecordAfterRollback({
    scope: "task",
    key: input.idempotencyKey,
    requestDigest: input.requestDigest
  });
  throw authority.error;
}

async function rollbackLocalTaskAfterAuthorityFailure(
  input: CreateIdempotentTaskCardInput,
  localTask: TaskCard
): Promise<void> {
  try {
    await input.taskService.rollbackTaskForIdempotency(localTask.task_id, localTask);
  } catch (rollbackError) {
    await input.idempotencyService.quarantineRecordAfterUnsafeRollback({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest
    });
    throw rollbackError;
  }
}

async function invalidateInvalidCompletedTaskAuthority(
  input: CreateIdempotentTaskCardInput,
  authority: InvalidCompletedIdempotencyRecordLookup
): Promise<never> {
  const error = invalidCompletedTaskAuthorityError(authority.reason);
  await input.idempotencyService.invalidateCompletedRecord({
    scope: "task",
    key: input.idempotencyKey,
    requestDigest: input.requestDigest,
    resultRef: authority.observedResultRef
  });
  throw error;
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
    if (replay.status === "invalid_completed") {
      return await invalidateInvalidCompletedTaskAuthority(input, replay);
    }
    if (replay.status === "completed") {
      return completedTaskCreateResultWithoutLocal(
        await classifyCompletedTaskAuthority(input, replay.record.result_ref)
      );
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

function invalidDurableTaskAuthorityError(): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 500,
    category: "workspace_error",
    message: "Completed task idempotency authority is invalid and was quarantined.",
    userMessage: "The completed task result could not be verified and was quarantined.",
    evidenceRefs: ["workspace/tasks/_idempotency/task", "idempotency.result_ref"],
    retryable: true,
    recommendedNextActions: ["Repair the task workspace state and retry the same request."]
  });
}

function invalidCompletedTaskAuthorityError(
  reason: InvalidCompletedIdempotencyRecordLookup["reason"]
): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 500,
    category: "workspace_error",
    message:
      reason === "missing_result_ref"
        ? "Completed idempotency record is missing result_ref."
        : "Completed task idempotency result_ref is not a safe TaskCard id.",
    userMessage: "The completed idempotency result cannot be used safely.",
    evidenceRefs: ["workspace/tasks/_idempotency/task", "idempotency.result_ref"],
    retryable: true,
    recommendedNextActions: ["Retry after the invalid completed authority is quarantined."]
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

function idempotencyInFlightCapacityError(): TaskServiceError {
  return new TaskServiceError({
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

function workspaceInFlightIdentityError(): TaskServiceError {
  return new TaskServiceError({
    code: "workspace_path_not_safe",
    status: 500,
    category: "workspace_error",
    message: "Workspace root cannot be identified safely for task idempotency coordination.",
    userMessage: "The configured workspace cannot be used safely.",
    evidenceRefs: ["workspace"],
    retryable: false,
    recommendedNextActions: ["Inspect and repair the configured workspace root before retrying."]
  });
}

function idempotencyInFlightWaitTimeoutError(): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 409,
    category: "workspace_error",
    message: "Active idempotent task create did not finish before the follower wait timeout.",
    userMessage: "The task create request is still being processed by an active owner.",
    evidenceRefs: ["workspace/tasks/_idempotency/task"],
    retryable: true,
    recommendedNextActions: ["Retry after the active task create request finishes."]
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

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
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
  ensureWorkspaceDirectoryTree,
  ensureWorkspaceRecordRootPhysicalIdentity,
  isSafeTaskId,
  probeWorkspaceRecordDirectoryWritable,
  preserveTaskServiceErrorCompensationCompatibility,
  runWithExistingWorkspaceRecordDirectoryReproof,
  sha256Hex,
  type CreateTaskInput,
  type CompletedIdempotencyRecordMutationAuthority,
  type InvalidCompletedIdempotencyRecordLookup,
  type IdempotencyRecordServiceOptions,
  type IdempotencyRecordService,
  type TaskCard,
  type TaskCardService,
  type TaskCardServiceOptions,
  type TaskSnapshotCleanupObservation,
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

export type TaskCardServiceFactory = (
  options: TaskCardServiceOptions
) => TaskCardService;

export interface BackendApiOptions {
  workspaceRoot?: string;
  version?: string;
  startTimeMs?: number;
  now?: () => Date;
  taskIdFactory?: () => string;
  taskSnapshotReadHooks?: TaskSnapshotReadHooks;
  taskSnapshotWriteHooks?: TaskSnapshotWriteHooks;
  idempotencyServiceFactory?: IdempotencyRecordServiceFactory;
  taskServiceFactory?: TaskCardServiceFactory;
  taskRouteErrorSinkForTest?: (error: unknown) => void;
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
  const taskService = (options.taskServiceFactory ?? createTaskCardService)({
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
      observeTaskRouteErrorWithoutInterference(options.taskRouteErrorSinkForTest, error);
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface InFlightIdempotentTaskCreateWaiter {
  deferred: Deferred<IdempotentTaskCreateResult>;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
}

interface InFlightIdempotentTaskCreateGroup {
  readonly entry: InFlightIdempotentTaskCreateEntry;
  readonly inFlightIdentity: string;
  input: CreateIdempotentTaskCardInput;
  waiters: Set<InFlightIdempotentTaskCreateWaiter>;
  replayDriver?: Promise<IdempotentTaskCreateResult>;
  terminalOperation?: () => Promise<IdempotentTaskCreateResult>;
}

interface InFlightIdempotentTaskCreateEntry {
  done: Promise<void>;
  requestDigest: string;
  followerCount: number;
  ownerTerminal: "pending" | "resolved" | "rejected";
  groups: Map<TaskCardService, InFlightIdempotentTaskCreateGroup>;
}

const inFlightIdempotentTaskCreates = new Map<string, InFlightIdempotentTaskCreateEntry>();
const registeredTerminalReplayDrivers = new Map<
  string,
  Map<TaskCardService, InFlightIdempotentTaskCreateGroup>
>();
let registeredTerminalReplayDriverCount = 0;

async function createIdempotentTaskCard(
  input: CreateIdempotentTaskCardInput
): Promise<IdempotentTaskCreateResult> {
  const inFlightIdentity = await idempotentTaskCreateInFlightIdentity(input);
  const registeredDriver = registeredTerminalReplayDrivers
    .get(inFlightIdentity)
    ?.get(input.taskService);
  if (registeredDriver) {
    if (registeredDriver.input.requestDigest !== input.requestDigest) {
      throw createIdempotencyMismatchError();
    }
    return await waitForInFlightIdempotentTaskCreate(
      input,
      registeredDriver.entry,
      registeredDriver
    );
  }
  const existingEntry = inFlightIdempotentTaskCreates.get(inFlightIdentity);
  if (existingEntry) {
    if (existingEntry.requestDigest !== input.requestDigest) {
      throw createIdempotencyMismatchError();
    }
    return await waitForInFlightIdempotentTaskCreate(
      input,
      existingEntry,
      undefined,
      inFlightIdentity
    );
  }

  if (inFlightIdempotentTaskCreates.size >= MAX_IN_FLIGHT_IDEMPOTENT_TASK_CREATES) {
    return await resolveIdempotentTaskCreateThroughRegisteredDriver(
      input,
      inFlightIdentity
    );
  }

  const owner = createDeferred<void>();
  owner.promise.catch(() => undefined);
  const entry: InFlightIdempotentTaskCreateEntry = {
    done: owner.promise,
    requestDigest: input.requestDigest,
    followerCount: 0,
    ownerTerminal: "pending",
    groups: new Map()
  };
  inFlightIdempotentTaskCreates.set(inFlightIdentity, entry);

  try {
    const result = await createOwnedIdempotentTaskCard(input);
    entry.ownerTerminal = "resolved";
    owner.resolve();
    startInFlightIdempotentTaskCreateGroupDrivers(entry);
    return result;
  } catch (error) {
    entry.ownerTerminal = "rejected";
    owner.reject(error);
    rejectAllInFlightIdempotentTaskCreateGroups(entry, error);
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
    return await resolveInvalidCompletedTaskCreate(input);
  }
  if (begin.status === "completed") {
    return completedTaskCreateResultWithoutLocal(
      input,
      await classifyCompletedTaskAuthority(input)
    );
  }
  if (begin.status === "incomplete") {
    return await waitForIdempotentTaskCompletion(input);
  }

  let task: TaskCard;
  try {
    task = await input.taskService.createTaskForIdempotency(input.input);
  } catch (error) {
    const compensations: unknown[] = [];
    let authority: CompletedTaskAuthorityClassification = { status: "absent" };
    try {
      authority = await classifyCompletedTaskAuthorityIfPresent(input);
    } catch (classificationError) {
      compensations.push(classificationError);
    }
    if (authority.status !== "absent") {
      try {
        return await completedTaskCreateResultWithoutLocal(input, authority);
      } catch (settlementError) {
        compensations.push(settlementError);
      }
    }

    if (authority.status === "absent") {
      try {
        await input.idempotencyService.recoverFailedRecordAfterRollback({
          scope: "task",
          key: input.idempotencyKey,
          requestDigest: input.requestDigest
        });
      } catch (recoveryError) {
        compensations.push(recoveryError);
      }
    }
    throw preservePrimaryFailure(
      error,
      compensations,
      "Initial task publication and idempotency recovery both failed."
    );
  }

  try {
    const result = await completeOwnedIdempotentTaskCard(input, task);
    await input.taskService.releaseTaskPublicationForIdempotency(task);
    return result;
  } catch (error) {
    try {
      await input.taskService.releaseTaskPublicationForIdempotency(task);
    } catch (releaseError) {
      // Root C (V33-03): the fold is wrapper-aware so an unknown-authority
      // wrapper keeps its inner typed primary reachable end-to-end.
      throw preserveAuthorityAwarePrimaryFailure(
        error,
        [releaseError],
        "Task create failure and publication-authority release both failed."
      );
    }
    throw error;
  }
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
  try {
    return await ensureWorkspaceRecordRootPhysicalIdentity(
      workspaceRoot,
      "workspace.task_create_identity"
    );
  } catch {
    throw workspaceInFlightIdentityError();
  }
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
    return await resolveInvalidCompletedTaskCreate(input);
  }
  if (replay.status === "completed") {
    return completedTaskCreateResultWithoutLocal(
      input,
      await classifyCompletedTaskAuthority(input)
    );
  }
  if (replay.status === "incomplete" && replay.record.status === "started") {
    return await waitForIdempotentTaskCompletion(input);
  }

  return undefined;
}

/**
 * Root A (V32-01): every route classifier that observes an invalid-completed
 * record consumes it the same way the replay-driver sibling does — through
 * consumeCompletedRecord, which captures the exact generation authority at
 * classification and transports it into the destructive invalidation.
 */
async function resolveInvalidCompletedTaskCreate(
  input: CreateIdempotentTaskCardInput
): Promise<IdempotentTaskCreateResult> {
  const classified = await consumeCompletedTaskAuthority(input);
  if (classified.status === "absent") throw idempotencyInFlightCompletionError();
  return await completedTaskCreateResultWithoutLocal(input, classified);
}

async function resolveIdempotentTaskCreateThroughRegisteredDriver(
  input: CreateIdempotentTaskCardInput,
  inFlightIdentity: string
): Promise<IdempotentTaskCreateResult> {
  const existing = registeredTerminalReplayDrivers
    .get(inFlightIdentity)
    ?.get(input.taskService);
  if (existing) {
    if (existing.input.requestDigest !== input.requestDigest) {
      throw createIdempotencyMismatchError();
    }
    return await waitForInFlightIdempotentTaskCreate(input, existing.entry, existing);
  }

  const done = Promise.resolve();
  const entry: InFlightIdempotentTaskCreateEntry = {
    done,
    requestDigest: input.requestDigest,
    followerCount: 0,
    ownerTerminal: "resolved",
    groups: new Map()
  };
  const group: InFlightIdempotentTaskCreateGroup = {
    entry,
    inFlightIdentity,
    input,
    waiters: new Set(),
    terminalOperation: async () => {
      const durable = await resolveIdempotentTaskCreateWithoutOwner(input);
      if (durable !== undefined) return durable;
      throw idempotencyInFlightCapacityError();
    }
  };
  entry.groups.set(input.taskService, group);
  return await waitForInFlightIdempotentTaskCreate(input, entry, group);
}

async function waitForInFlightIdempotentTaskCreate(
  input: CreateIdempotentTaskCardInput,
  entry: InFlightIdempotentTaskCreateEntry,
  registeredGroup?: InFlightIdempotentTaskCreateGroup,
  knownInFlightIdentity?: string
): Promise<IdempotentTaskCreateResult> {
  if (entry.followerCount >= MAX_IN_FLIGHT_IDEMPOTENT_TASK_CREATES) {
    throw idempotencyInFlightCapacityError();
  }

  let group = registeredGroup ?? entry.groups.get(input.taskService);
  if (!group) {
    const inFlightIdentity =
      knownInFlightIdentity ?? (await idempotentTaskCreateInFlightIdentity(input));
    group = {
      entry,
      inFlightIdentity,
      input,
      waiters: new Set()
    };
    entry.groups.set(input.taskService, group);
  }
  const waiter: InFlightIdempotentTaskCreateWaiter = {
    deferred: createDeferred<IdempotentTaskCreateResult>(),
    timeoutHandle: undefined
  };
  group.waiters.add(waiter);
  entry.followerCount += 1;

  try {
    waiter.timeoutHandle = setTimeout(() => {
      if (detachInFlightIdempotentTaskCreateWaiter(entry, group!, waiter)) {
        waiter.deferred.reject(idempotencyInFlightWaitTimeoutError());
      }
    }, IN_FLIGHT_FOLLOWER_WAIT_TIMEOUT_MS);
    if (entry.ownerTerminal === "resolved") {
      ensureInFlightIdempotentTaskCreateGroupDriver(entry, group);
    } else if (entry.ownerTerminal === "rejected") {
      detachInFlightIdempotentTaskCreateWaiter(entry, group, waiter);
      waiter.deferred.reject(idempotencyInFlightCompletionError());
    }
    return await waiter.deferred.promise;
  } finally {
    detachInFlightIdempotentTaskCreateWaiter(entry, group, waiter);
  }
}

function startInFlightIdempotentTaskCreateGroupDrivers(
  entry: InFlightIdempotentTaskCreateEntry
): void {
  for (const group of entry.groups.values()) {
    if (group.waiters.size > 0) {
      ensureInFlightIdempotentTaskCreateGroupDriver(entry, group);
    }
  }
}

function ensureInFlightIdempotentTaskCreateGroupDriver(
  entry: InFlightIdempotentTaskCreateEntry,
  group: InFlightIdempotentTaskCreateGroup
): void {
  if (group.replayDriver) return;
  if (!registerTerminalReplayDriver(group)) {
    rejectInFlightIdempotentTaskCreateGroup(
      entry,
      group,
      idempotencyInFlightCapacityError()
    );
    return;
  }

  const replayDriver = runInFlightIdempotentTaskCreateGroupDriver(
    group.input,
    entry,
    group
  );
  group.replayDriver = replayDriver;
  const terminalDispatch = replayDriver.then(
    (result) => resolveInFlightIdempotentTaskCreateGroup(entry, group, result),
    (error) => rejectInFlightIdempotentTaskCreateGroup(entry, group, error)
  );
  terminalDispatch.catch(() => undefined);
}

async function runInFlightIdempotentTaskCreateGroupDriver(
  input: CreateIdempotentTaskCardInput,
  entry: InFlightIdempotentTaskCreateEntry,
  group?: InFlightIdempotentTaskCreateGroup
): Promise<IdempotentTaskCreateResult> {
  await entry.done;
  if (group?.terminalOperation) return await group.terminalOperation();
  return await replayInFlightIdempotentTaskCreate(input);
}

function detachInFlightIdempotentTaskCreateWaiter(
  entry: InFlightIdempotentTaskCreateEntry,
  group: InFlightIdempotentTaskCreateGroup,
  waiter: InFlightIdempotentTaskCreateWaiter
): boolean {
  const wasRegistered = group.waiters.delete(waiter);
  if (wasRegistered) entry.followerCount -= 1;
  if (waiter.timeoutHandle !== undefined) {
    clearTimeout(waiter.timeoutHandle);
    waiter.timeoutHandle = undefined;
  }
  if (group.waiters.size === 0 && !group.replayDriver) {
    if (entry.groups.get(group.input.taskService) === group) {
      entry.groups.delete(group.input.taskService);
    }
  }
  return wasRegistered;
}

function resolveInFlightIdempotentTaskCreateGroup(
  entry: InFlightIdempotentTaskCreateEntry,
  group: InFlightIdempotentTaskCreateGroup,
  result: IdempotentTaskCreateResult
): void {
  unregisterTerminalReplayDriver(group);
  for (const waiter of group.waiters) {
    if (!detachInFlightIdempotentTaskCreateWaiter(entry, group, waiter)) continue;
    waiter.deferred.resolve(result);
  }
  group.waiters.clear();
  if (entry.groups.get(group.input.taskService) === group) {
    entry.groups.delete(group.input.taskService);
  }
}

function rejectInFlightIdempotentTaskCreateGroup(
  entry: InFlightIdempotentTaskCreateEntry,
  group: InFlightIdempotentTaskCreateGroup,
  error: unknown
): void {
  unregisterTerminalReplayDriver(group);
  for (const waiter of group.waiters) {
    if (!detachInFlightIdempotentTaskCreateWaiter(entry, group, waiter)) continue;
    waiter.deferred.reject(error);
  }
  group.waiters.clear();
  if (entry.groups.get(group.input.taskService) === group) {
    entry.groups.delete(group.input.taskService);
  }
}

function registerTerminalReplayDriver(
  group: InFlightIdempotentTaskCreateGroup
): boolean {
  let serviceDrivers = registeredTerminalReplayDrivers.get(group.inFlightIdentity);
  const existing = serviceDrivers?.get(group.input.taskService);
  if (existing) return existing === group;
  if (
    registeredTerminalReplayDriverCount >= MAX_IN_FLIGHT_IDEMPOTENT_TASK_CREATES
  ) {
    return false;
  }
  if (!serviceDrivers) {
    serviceDrivers = new Map();
    registeredTerminalReplayDrivers.set(group.inFlightIdentity, serviceDrivers);
  }
  serviceDrivers.set(group.input.taskService, group);
  registeredTerminalReplayDriverCount += 1;
  return true;
}

function unregisterTerminalReplayDriver(
  group: InFlightIdempotentTaskCreateGroup
): void {
  const serviceDrivers = registeredTerminalReplayDrivers.get(group.inFlightIdentity);
  if (serviceDrivers?.get(group.input.taskService) !== group) return;
  serviceDrivers.delete(group.input.taskService);
  registeredTerminalReplayDriverCount -= 1;
  if (serviceDrivers.size === 0) {
    registeredTerminalReplayDrivers.delete(group.inFlightIdentity);
  }
}

function rejectAllInFlightIdempotentTaskCreateGroups(
  entry: InFlightIdempotentTaskCreateEntry,
  error: unknown
): void {
  for (const group of entry.groups.values()) {
    rejectInFlightIdempotentTaskCreateGroup(entry, group, error);
  }
  entry.groups.clear();
}

async function replayInFlightIdempotentTaskCreate(
  input: CreateIdempotentTaskCardInput
): Promise<IdempotentTaskCreateResult> {
  const replay = await input.idempotencyService.lookupReplay({
    scope: "task",
    key: input.idempotencyKey,
    requestDigest: input.requestDigest
  });
  if (replay.status === "mismatch") throw createIdempotencyMismatchError();
  if (replay.status === "invalid_completed") {
    return await resolveInvalidCompletedTaskCreate(input);
  }
  if (replay.status !== "completed") throw idempotencyInFlightCompletionError();

  const deadline = Date.now() + IDEMPOTENCY_REPLAY_WAIT_TIMEOUT_MS;
  for (;;) {
    try {
      return completedTaskCreateResultWithoutLocal(
        input,
        await classifyCompletedTaskAuthority(input)
      );
    } catch (error) {
      if (
        !(error instanceof CompletedTaskSnapshotAuthorityUnknownError) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await sleep(IDEMPOTENCY_REPLAY_POLL_INTERVAL_MS);
    }
  }
}

async function completeOwnedIdempotentTaskCard(
  input: CreateIdempotentTaskCardInput,
  task: TaskCard
): Promise<IdempotentTaskCreateResult> {
  let observation: TaskSnapshotCleanupObservation | undefined;
  return await runWithTaskSnapshotObservationFinalizer(
    async () => {
    try {
      observation = await observeTaskSnapshotBindsRequest(
        input.taskService,
        task,
        input.requestDigest
      );
    } catch (error) {
      return await reconcileLocalTaskAfterPreCompletionFailure(input, task, error);
    }

    let completedRecord: Awaited<
      ReturnType<IdempotencyRecordService["completeRecord"]>
    >;
    try {
      completedRecord = await input.idempotencyService.completeRecord({
        scope: "task",
        key: input.idempotencyKey,
        requestDigest: input.requestDigest,
        resultRef: task.task_id
      });
    } catch (error) {
      const ownedObservation = observation;
      observation = undefined;
      return await reconcileLocalTaskAfterCompletionFailure(
        input,
        task,
        ownedObservation,
        error
      );
    }

    if (completedRecord.status !== "completed" || !completedRecord.result_ref) {
      const ownedObservation = observation;
      observation = undefined;
      return await reconcileLocalTaskAfterCompletionFailure(
        input,
        task,
        ownedObservation,
        idempotencyResultBindingError()
      );
    }

    const local: LocalCompletedTaskConsumption = { task, observation };
    observation = undefined;
    return await runWithTaskSnapshotObservationFinalizer(
      async () => {
      const authority = await consumeCompletedTaskAuthority(input, local);
      if (authority.status === "absent") throw idempotencyResultBindingError();
      if (authority.resultRef === task.task_id) {
        return await settleLocalTaskAgainstCompletedAuthority(input, task, authority);
      }

      const competingObservation = local.observation;
      local.observation = undefined;
      if (competingObservation) {
        await cleanupLocalTaskCompletionObservation(
          input,
          competingObservation,
          authority.resultRef,
          authority.mutationAuthority
        );
      }
      return completedTaskCreateResultWithoutLocal(input, authority);
      },
      () => {
        const owned = local.observation;
        local.observation = undefined;
        return owned;
      },
      input.taskService,
      "Completed task consumption and local observation cancellation both failed."
    );
    },
    () => {
      const owned = observation;
      observation = undefined;
      return owned;
    },
    input.taskService,
    "Owned task completion and observation cancellation both failed."
  );
}

async function runWithTaskSnapshotObservationFinalizer<T>(
  body: () => Promise<T>,
  takeObservation: () => TaskSnapshotCleanupObservation | undefined,
  taskService: TaskCardService,
  aggregateMessage: string
): Promise<T> {
  let bodyOutcome:
    | { readonly status: "fulfilled"; readonly value: T }
    | { readonly status: "rejected"; readonly reason: unknown };
  try {
    bodyOutcome = { status: "fulfilled", value: await body() };
  } catch (reason) {
    bodyOutcome = { status: "rejected", reason };
  }

  let settlementError: unknown;
  const observation = takeObservation();
  if (observation) {
    try {
      await taskService.cancelTaskSnapshotCleanupObservation(observation);
    } catch (error) {
      settlementError = error;
    }
  }
  if (bodyOutcome.status === "rejected") {
    if (settlementError !== undefined) {
      // Root C (V33-03): the finalizer fold is wrapper-aware so an
      // unknown-authority wrapper keeps its inner typed primary reachable.
      throw preserveAuthorityAwarePrimaryFailure(
        bodyOutcome.reason,
        [settlementError],
        aggregateMessage
      );
    }
    throw bodyOutcome.reason;
  }
  if (settlementError !== undefined) throw settlementError;
  return bodyOutcome.value;
}

async function observeTaskSnapshotBindsRequest(
  taskService: TaskCardService,
  task: TaskCard,
  requestDigest: string
): Promise<TaskSnapshotCleanupObservation> {
  const observation = await taskService.observeTaskSnapshotForCleanup(task.task_id);
  let error: unknown;
  if (observation.status === "record") {
    if (
      JSON.stringify(observation.task) === JSON.stringify(task) &&
      taskCreateRequestDigestFromTask(observation.task) === requestDigest
    ) {
      return observation;
    }
    error = idempotencyResultBindingError();
  } else if (
    observation.status === "repairable" ||
    observation.status === "invalid" ||
    observation.status === "unknown"
  ) {
    error = observation.error;
  } else {
    error = idempotencyResultBindingError();
  }

  try {
    await taskService.cancelTaskSnapshotCleanupObservation(observation);
  } catch (settlementError) {
    error = preserveTaskServiceErrorCompensationCompatibility(
      error,
      [settlementError],
      "Task snapshot observation rejection and cancellation both failed."
    );
  }
  throw error;
}

async function reconcileLocalTaskAfterPreCompletionFailure(
  input: CreateIdempotentTaskCardInput,
  task: TaskCard,
  error: unknown
): Promise<IdempotentTaskCreateResult> {
  let recoveredAuthority: CompletedTaskAuthorityClassification = { status: "absent" };
  let authorityError: unknown;
  try {
    recoveredAuthority = await classifyCompletedTaskAuthorityIfPresent(input);
  } catch (reconciliationError) {
    authorityError = reconciliationError;
  }

  if (authorityError !== undefined) {
    throw preservePrimaryFailure(
      error,
      [authorityError],
      "Task creation failure and completed-authority reconciliation both failed."
    );
  }
  if (recoveredAuthority.status !== "absent") {
    try {
      return await settleLocalTaskAgainstCompletedAuthority(
        input,
        task,
        recoveredAuthority
      );
    } catch (settlementError) {
      throw preservePrimaryFailure(
        error,
        [settlementError],
        "Task creation failure and recovered-authority settlement both failed."
      );
    }
  }

  const compensationErrors: unknown[] = [];
  try {
    await rollbackLocalTaskAfterAuthorityFailure(input, task);
  } catch (rollbackError) {
    compensationErrors.push(rollbackError);
  }
  try {
    await input.idempotencyService.recoverFailedRecordAfterRollback({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest
    });
  } catch (recoveryError) {
    compensationErrors.push(recoveryError);
  }
  throw preservePrimaryFailure(
    error,
    compensationErrors,
    "Task creation failure and pre-completion compensation both failed."
  );
}

async function reconcileLocalTaskAfterCompletionFailure(
  input: CreateIdempotentTaskCardInput,
  task: TaskCard,
  initialObservation: TaskSnapshotCleanupObservation,
  completionError: unknown
): Promise<IdempotentTaskCreateResult> {
  const local: LocalCompletedTaskConsumption = {
    task,
    observation: initialObservation
  };

  try {
    let authority: CompletedTaskAuthorityClassification;
    try {
      authority = await consumeCompletedTaskAuthority(input, local);
    } catch (reconciliationError) {
      const cancellationErrors: unknown[] = [];
      if (local.observation) {
        const ownedObservation = local.observation;
        local.observation = undefined;
        try {
          await input.taskService.cancelTaskSnapshotCleanupObservation(ownedObservation);
        } catch (error) {
          cancellationErrors.push(error);
        }
      }
      throw preservePrimaryFailure(
        completionError,
        [reconciliationError, ...cancellationErrors],
        "Task completion failure, authority reconciliation, and observation cancellation failed."
      );
    }

    if (authority.status !== "absent") {
      try {
        if (authority.resultRef === task.task_id) {
          return await settleLocalTaskAgainstCompletedAuthority(input, task, authority);
        }
        const competingObservation = local.observation;
        local.observation = undefined;
        if (competingObservation) {
          await cleanupLocalTaskCompletionObservation(
            input,
            competingObservation,
            authority.resultRef,
            authority.mutationAuthority
          );
        }
        return await completedTaskCreateResultWithoutLocal(input, authority);
      } catch (settlementError) {
        throw preservePrimaryFailure(
          completionError,
          [settlementError],
          "Task completion failure and completed-authority settlement both failed."
        );
      }
    }

    const settlementErrors: unknown[] = [];
    if (local.observation) {
      const ownedObservation = local.observation;
      local.observation = undefined;
      try {
        await cleanupLocalTaskCompletionObservation(input, ownedObservation);
      } catch (error) {
        settlementErrors.push(error);
      }
    }
    try {
      await input.idempotencyService.recoverFailedRecordAfterRollback({
        scope: "task",
        key: input.idempotencyKey,
        requestDigest: input.requestDigest
      });
    } catch (error) {
      settlementErrors.push(error);
    }
    throw preservePrimaryFailure(
      completionError,
      settlementErrors,
      "Task completion failure and known-absent authority settlement failed."
    );
  } catch (bodyError) {
    if (local.observation) {
      const ownedObservation = local.observation;
      local.observation = undefined;
      try {
        await input.taskService.cancelTaskSnapshotCleanupObservation(ownedObservation);
      } catch (cancellationError) {
        throw preservePrimaryFailure(
          bodyError,
          [cancellationError],
          "Task completion reconciliation and final observation cancellation both failed."
        );
      }
    }
    throw bodyError;
  } finally {
    if (local.observation) {
      await input.taskService.cancelTaskSnapshotCleanupObservation(local.observation);
    }
  }
}

async function cleanupLocalTaskCompletionObservation(
  input: CreateIdempotentTaskCardInput,
  observation: TaskSnapshotCleanupObservation,
  expectedCompletedResultRef?: string,
  mutationAuthority?: CompletedIdempotencyRecordMutationAuthority
): Promise<void> {
  try {
    await input.taskService.cleanupTaskSnapshotObservation(observation);
  } catch (error) {
    try {
      await input.idempotencyService.quarantineRecordAfterUnsafeRollback({
        scope: "task",
        key: input.idempotencyKey,
        requestDigest: input.requestDigest,
        ...(expectedCompletedResultRef === undefined
          ? {}
          : {
              expectedCompletedAuthority: {
                resultRef: expectedCompletedResultRef,
                ...(mutationAuthority === undefined ? {} : { mutationAuthority })
              }
            })
      });
    } catch (quarantineError) {
      throw preservePrimaryFailure(
        error,
        [quarantineError],
        "Task snapshot cleanup and idempotency quarantine both failed."
      );
    }
    throw error;
  }
}

type ClassifiedCompletedTaskAuthority =
  | { status: "valid"; task: TaskCard; resultRef: string }
  | { status: "repairable"; error: TaskServiceError; resultRef: string }
  | {
      status: "invalid";
      reason: "invalid_durable_task_authority";
      error: TaskServiceError;
      resultRef: string;
      durablyFailed: boolean;
    };

type ObservedCompletedTaskAuthorityClassification =
  ClassifiedCompletedTaskAuthority & {
    mutationAuthority: CompletedIdempotencyRecordMutationAuthority;
  };

type CompletedTaskAuthorityClassification =
  | ObservedCompletedTaskAuthorityClassification
  | { status: "absent" };

interface LocalCompletedTaskConsumption {
  readonly task: TaskCard;
  observation?: TaskSnapshotCleanupObservation;
}

interface RejectedCompletedTaskAuthority {
  readonly resultRef: string;
  readonly authorityError: TaskServiceError;
  readonly classificationErrors: readonly unknown[];
  readonly observation?: TaskSnapshotCleanupObservation;
}

class CompletedTaskSnapshotAuthorityReadError extends Error {
  constructor() {
    super("Completed task snapshot durable authority could not be read.");
    this.name = "CompletedTaskSnapshotAuthorityReadError";
  }
}

class CompletedTaskSnapshotAuthorityUnknownError extends Error {
  readonly authorityError: unknown;

  constructor(authorityError: unknown) {
    super("Completed task snapshot authority is temporarily unknown.", {
      cause: authorityError
    });
    this.name = "CompletedTaskSnapshotAuthorityUnknownError";
    this.authorityError = authorityError;
  }
}

async function classifyCompletedTaskAuthorityIfPresent(
  input: CreateIdempotentTaskCardInput
): Promise<CompletedTaskAuthorityClassification> {
  return await consumeCompletedTaskAuthority(input);
}

async function classifyCompletedTaskAuthority(
  input: CreateIdempotentTaskCardInput
): Promise<ObservedCompletedTaskAuthorityClassification> {
  const authority = await consumeCompletedTaskAuthority(input);
  if (authority.status === "absent") throw idempotencyInFlightCompletionError();
  return authority;
}

async function consumeCompletedTaskAuthority(
  input: CreateIdempotentTaskCardInput,
  local?: LocalCompletedTaskConsumption
): Promise<CompletedTaskAuthorityClassification> {
  const consumption = await input.idempotencyService.consumeCompletedRecord(
    {
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest
    },
    async (record) => {
      const decision = await classifyCompletedTaskAuthorityUnderLease(
        input,
        record.result_ref,
        local
      );
      if (decision.status !== "rejected" || !decision.reason.observation) {
        return decision;
      }
      const rejectedObservation = decision.reason.observation;
      return {
        ...decision,
        // Root A (V33-01): the rejected reason transports an observation that
        // owns a counted cleanup permit, a pinned fd, and a cache claim.
        // consumeCompletedRecord settles it through this hook if it fails on
        // its own throw windows after fulfilling this decision; the returned
        // rejected result still settles through
        // settleRejectedCompletedTaskAuthority unchanged.
        settleReasonAfterConsumptionFailure: async () => {
          await input.taskService.cancelTaskSnapshotCleanupObservation(
            rejectedObservation
          );
        }
      };
    }
  );

  if (consumption.status === "accepted") {
    return { ...consumption.value, mutationAuthority: consumption.mutationAuthority };
  }
  if (consumption.status === "rejected") {
    return await settleRejectedCompletedTaskAuthority(
      input,
      consumption.reason,
      consumption.mutationAuthority
    );
  }
  if (consumption.status === "mismatch") throw createIdempotencyMismatchError();
  if (consumption.status === "invalid_completed") {
    return await invalidateInvalidCompletedTaskAuthority(input, consumption);
  }
  return { status: "absent" };
}

async function classifyCompletedTaskAuthorityUnderLease(
  input: CreateIdempotentTaskCardInput,
  resultRef: string,
  local?: LocalCompletedTaskConsumption
): Promise<
  | {
      readonly status: "accepted";
      readonly value: ClassifiedCompletedTaskAuthority;
    }
  | { readonly status: "rejected"; readonly reason: RejectedCompletedTaskAuthority }
> {
  if (local && resultRef === local.task.task_id) {
    const observation = local.observation;
    if (!observation) {
      throw new CompletedTaskSnapshotAuthorityUnknownError(
        new TypeError("Local completed TaskCard observation was already settled.")
      );
    }
    local.observation = undefined;
    try {
      const task = await input.taskService.acceptTaskSnapshotCleanupObservation(observation);
      if (
        JSON.stringify(task) !== JSON.stringify(local.task) ||
        taskCreateRequestDigestFromTask(task) !== input.requestDigest
      ) {
        throw idempotencyResultBindingError();
      }
      return {
        status: "accepted",
        value: { status: "valid", task, resultRef }
      };
    } catch (error) {
      throw new CompletedTaskSnapshotAuthorityUnknownError(error);
    }
  }

  let observation: TaskSnapshotCleanupObservation | undefined;
  try {
    if (!isSafeTaskId(resultRef)) {
      throw new TaskServiceError({
        code: "record_malformed",
        status: 500,
        category: "workspace_error",
        message: "Completed task idempotency result_ref is not a safe TaskCard id.",
        userMessage: "The idempotency result reference cannot be used safely.",
        evidenceRefs: ["idempotency.result_ref"],
        retryable: false,
        recommendedNextActions: [
          "Inspect and repair the idempotency result reference before retrying."
        ]
      });
    }

    observation = await input.taskService.observeTaskSnapshotForCleanup(resultRef);
    if (observation.status === "unknown") {
      const error = observation.error;
      const ownedObservation = observation;
      observation = undefined;
      // Root D (V32-03): a throwing settlement must never replace the typed
      // classification primary; fold it as an ordered compensation instead.
      try {
        await input.taskService.cancelTaskSnapshotCleanupObservation(ownedObservation);
      } catch (settlementError) {
        throw new CompletedTaskSnapshotAuthorityUnknownError(
          preservePrimaryFailure(
            error,
            [settlementError],
            "Completed task authority classification and observation cancellation both failed."
          )
        );
      }
      throw new CompletedTaskSnapshotAuthorityUnknownError(error);
    }
    if (observation.status === "repairable") {
      const error = observation.error;
      const ownedObservation = observation;
      observation = undefined;
      // Root D (V32-03): the repairable primary survives a throwing rejection
      // with the settlement failure retained exactly once as compensation.
      try {
        await input.taskService.rejectTaskSnapshotCleanupObservation(ownedObservation);
      } catch (settlementError) {
        return {
          status: "accepted",
          value: {
            status: "repairable",
            error: preservePrimaryFailure(
              error,
              [settlementError],
              "Completed task authority classification and observation rejection both failed."
            ) as TaskServiceError,
            resultRef
          }
        };
      }
      return {
        status: "accepted",
        value: { status: "repairable", error, resultRef }
      };
    }
    if (observation.status === "missing" || observation.status === "invalid") {
      const classificationError =
        observation.status === "invalid"
          ? observation.error
          : new CompletedTaskSnapshotAuthorityReadError();
      const rejectedObservation = observation;
      observation = undefined;
      return {
        status: "rejected",
        reason: {
          resultRef,
          authorityError: invalidDurableTaskAuthorityError(),
          classificationErrors: [classificationError],
          observation: rejectedObservation
        }
      };
    }
    if (taskCreateRequestDigestFromTask(observation.task) !== input.requestDigest) {
      const classificationError = idempotencyResultBindingError();
      const ownedObservation = observation;
      observation = undefined;
      try {
        await input.taskService.acceptTaskSnapshotCleanupObservation(ownedObservation);
      } catch (error) {
        // Root C (V33-04): both occurrences are retained exactly once. A
        // typed acceptance failure (e.g. the exact-generation mismatch) stays
        // the actionable primary with the binding classification folded as
        // its ordered compensation, preserving the pre-existing envelope; an
        // untyped acceptance failure folds behind the typed binding
        // classification as the semantic primary.
        throw new CompletedTaskSnapshotAuthorityUnknownError(
          error instanceof TaskServiceError
            ? preservePrimaryFailure(
                error,
                [classificationError],
                "Completed task authority classification and observation acceptance both failed."
              )
            : preservePrimaryFailure(
                classificationError,
                [error],
                "Completed task authority classification and observation acceptance both failed."
              )
        );
      }
      return {
        status: "rejected",
        reason: {
          resultRef,
          authorityError: invalidDurableTaskAuthorityError(),
          classificationErrors: [classificationError]
        }
      };
    }

    const ownedObservation = observation;
    observation = undefined;
    try {
      const task = await input.taskService.acceptTaskSnapshotCleanupObservation(
        ownedObservation
      );
      return {
        status: "accepted",
        value: { status: "valid", task, resultRef }
      };
    } catch (error) {
      throw new CompletedTaskSnapshotAuthorityUnknownError(error);
    }
  } catch (error) {
    if (
      isSafeTaskId(resultRef) &&
      error instanceof TaskServiceError &&
      error.code === "task_snapshot_missing_card"
    ) {
      return {
        status: "accepted",
        value: { status: "repairable", error, resultRef }
      };
    }
    if (observation) {
      const ownedObservation = observation;
      observation = undefined;
      try {
        await input.taskService.cancelTaskSnapshotCleanupObservation(ownedObservation);
      } catch (settlementError) {
        throw new CompletedTaskSnapshotAuthorityUnknownError(
          preservePrimaryFailure(
            error,
            [settlementError],
            "Completed task authority observation and cancellation both failed."
          )
        );
      }
    }
    if (error instanceof CompletedTaskSnapshotAuthorityUnknownError) throw error;
    throw new CompletedTaskSnapshotAuthorityUnknownError(error);
  }
}

async function settleRejectedCompletedTaskAuthority(
  input: CreateIdempotentTaskCardInput,
  rejection: RejectedCompletedTaskAuthority,
  mutationAuthority: CompletedIdempotencyRecordMutationAuthority
): Promise<ObservedCompletedTaskAuthorityClassification> {
  const recovery = await invalidateCompletedTaskAuthorityWithRecovery(
    input,
    rejection.resultRef,
    mutationAuthority
  );
  const settlementErrors: unknown[] = [];
  if (rejection.observation) {
    try {
      if (recovery.durablyFailed) {
        await input.taskService.cleanupTaskSnapshotObservation(rejection.observation);
      } else {
        await input.taskService.cancelTaskSnapshotCleanupObservation(rejection.observation);
      }
    } catch (settlementError) {
      settlementErrors.push(settlementError);
      try {
        await input.idempotencyService.quarantineRecordAfterUnsafeRollback({
          scope: "task",
          key: input.idempotencyKey,
          requestDigest: input.requestDigest,
          expectedCompletedAuthority: {
            resultRef: rejection.resultRef,
            mutationAuthority
          }
        });
      } catch (quarantineError) {
        settlementErrors.push(quarantineError);
      }
    }
  }
  return {
    status: "invalid",
    reason: "invalid_durable_task_authority",
    error: preservePrimaryFailure(
      rejection.authorityError,
      [...rejection.classificationErrors, ...recovery.errors, ...settlementErrors],
      "Completed task authority classification and recovery failed."
    ) as TaskServiceError,
    resultRef: rejection.resultRef,
    durablyFailed: recovery.durablyFailed,
    mutationAuthority
  };
}

async function completedTaskCreateResultWithoutLocal(
  input: CreateIdempotentTaskCardInput,
  authority: ObservedCompletedTaskAuthorityClassification
): Promise<IdempotentTaskCreateResult> {
  if (authority.status === "valid") {
    await input.idempotencyService.cancelCompletedRecordMutationAuthority(
      authority.mutationAuthority
    );
    return { task: authority.task, created: false };
  }
  if (authority.status === "repairable") {
    try {
      await input.idempotencyService.cancelCompletedRecordMutationAuthority(
        authority.mutationAuthority
      );
    } catch (cancellationError) {
      throw preservePrimaryFailure(
        authority.error,
        [cancellationError],
        "Repairable completed authority and mutation-authority cancellation both failed."
      );
    }
    throw authority.error;
  }

  if (authority.durablyFailed) {
    try {
      await input.idempotencyService.recoverFailedRecordAfterRollback({
        scope: "task",
        key: input.idempotencyKey,
        requestDigest: input.requestDigest
      });
    } catch (recoveryError) {
      throw preservePrimaryFailure(
        authority.error,
        [recoveryError],
        "Completed authority failure and failed-record recovery both failed."
      );
    }
  }
  throw authority.error;
}

async function settleLocalTaskAgainstCompletedAuthority(
  input: CreateIdempotentTaskCardInput,
  localTask: TaskCard,
  authority: ObservedCompletedTaskAuthorityClassification
): Promise<IdempotentTaskCreateResult> {
  if (authority.status === "valid" && authority.resultRef === localTask.task_id) {
    await input.idempotencyService.cancelCompletedRecordMutationAuthority(
      authority.mutationAuthority
    );
    return { task: authority.task, created: true };
  }

  if (authority.status === "invalid" && !authority.durablyFailed) {
    throw authority.error;
  }

  await rollbackLocalTaskAfterAuthorityFailure(
    input,
    localTask,
    authority.resultRef,
    authority.status === "invalid" ? undefined : authority.mutationAuthority
  );
  if (authority.status !== "invalid") {
    try {
      await input.idempotencyService.cancelCompletedRecordMutationAuthority(
        authority.mutationAuthority
      );
    } catch (cancellationError) {
      if (authority.status === "repairable") {
        throw preservePrimaryFailure(
          authority.error,
          [cancellationError],
          "Repairable completed authority and mutation-authority cancellation both failed."
        );
      }
      throw cancellationError;
    }
  }
  if (authority.status === "valid") {
    return { task: authority.task, created: false };
  }
  if (authority.status === "repairable") {
    throw authority.error;
  }

  try {
    await input.idempotencyService.recoverFailedRecordAfterRollback({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest
    });
  } catch (recoveryError) {
    throw preservePrimaryFailure(
      authority.error,
      [recoveryError],
      "Completed authority failure and post-rollback recovery both failed."
    );
  }
  throw authority.error;
}

async function rollbackLocalTaskAfterAuthorityFailure(
  input: CreateIdempotentTaskCardInput,
  localTask: TaskCard,
  expectedCompletedResultRef?: string,
  mutationAuthority?: CompletedIdempotencyRecordMutationAuthority
): Promise<void> {
  try {
    await input.taskService.rollbackTaskForIdempotency(localTask.task_id, localTask);
  } catch (rollbackError) {
    try {
      await input.idempotencyService.quarantineRecordAfterUnsafeRollback({
        scope: "task",
        key: input.idempotencyKey,
        requestDigest: input.requestDigest,
        ...(expectedCompletedResultRef === undefined
          ? {}
          : {
              expectedCompletedAuthority: {
                resultRef: expectedCompletedResultRef,
                ...(mutationAuthority === undefined ? {} : { mutationAuthority })
              }
            })
      });
    } catch (quarantineError) {
      throw preservePrimaryFailure(
        rollbackError,
        [quarantineError],
        "Task rollback and idempotency quarantine both failed."
      );
    }
    throw rollbackError;
  }
}

async function invalidateInvalidCompletedTaskAuthority(
  input: CreateIdempotentTaskCardInput,
  authority: InvalidCompletedIdempotencyRecordLookup & {
    readonly mutationAuthority: CompletedIdempotencyRecordMutationAuthority;
  }
): Promise<never> {
  const error = invalidCompletedTaskAuthorityError(authority.reason);
  const recovery = await invalidateCompletedTaskAuthorityWithRecovery(
    input,
    authority.observedResultRef,
    authority.mutationAuthority
  );
  throw preservePrimaryFailure(
    error,
    recovery.errors,
    "Invalid completed task authority and durable recovery failed."
  );
}

interface CompletedTaskAuthorityInvalidationOutcome {
  readonly durablyFailed: boolean;
  readonly errors: unknown[];
}

async function invalidateCompletedTaskAuthorityWithRecovery(
  input: CreateIdempotentTaskCardInput,
  resultRef: string | undefined,
  mutationAuthority?: CompletedIdempotencyRecordMutationAuthority
): Promise<CompletedTaskAuthorityInvalidationOutcome> {
  try {
    const failed = await input.idempotencyService.invalidateCompletedRecord({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest,
      resultRef,
      ...(mutationAuthority === undefined ? {} : { mutationAuthority })
    });
    return { durablyFailed: failed.status === "failed", errors: [] };
  } catch (invalidationError) {
    const errors: unknown[] = [invalidationError];
    try {
      const failed = await input.idempotencyService.quarantineRecordAfterUnsafeRollback({
        scope: "task",
        key: input.idempotencyKey,
        requestDigest: input.requestDigest,
        expectedCompletedAuthority: {
          resultRef,
          ...(mutationAuthority === undefined ? {} : { mutationAuthority })
        }
      });
      return { durablyFailed: failed.status === "failed", errors };
    } catch (quarantineError) {
      errors.push(quarantineError);
    }
    if (mutationAuthority !== undefined) {
      try {
        await input.idempotencyService.cancelCompletedRecordMutationAuthority(
          mutationAuthority
        );
      } catch (settlementError) {
        if (!isCompletedMutationAuthorityAlreadySettledError(settlementError)) {
          errors.push(settlementError);
        }
      }
    }
    return { durablyFailed: false, errors };
  }
}

function isCompletedMutationAuthorityAlreadySettledError(error: unknown): boolean {
  return error instanceof TypeError &&
    error.message ===
      "Completed idempotency mutation authority is not owned by this service or is already settled.";
}

function preservePrimaryFailure(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string
): unknown {
  // Root C (V33-13): never count one occurrence twice — a compensation
  // candidate that IS the primary is already represented by the primary
  // itself, so a memoized rejection folded into itself yields primary-only.
  const distinctCompensations = compensations.filter(
    (candidate) => !Object.is(primary, candidate)
  );
  if (distinctCompensations.length === 0) return primary;
  return preserveTaskServiceErrorCompensationCompatibility(
    primary,
    distinctCompensations,
    aggregateMessage
  );
}

/**
 * Root C (V33-03): fold sites whose caught primary may be a
 * CompletedTaskSnapshotAuthorityUnknownError preserve the INNER typed primary
 * with the compensations retained as an ordered vector, re-wrapping so
 * jsonTaskServiceError's existing one-level unwrap still renders the typed
 * envelope instead of a generic 500.
 */
function preserveAuthorityAwarePrimaryFailure(
  primary: unknown,
  compensations: readonly unknown[],
  aggregateMessage: string
): unknown {
  // Root C (V33-13): drop compensation candidates that ARE the primary
  // before folding, so the same occurrence is never transported twice.
  const distinctCompensations = compensations.filter(
    (candidate) => !Object.is(primary, candidate)
  );
  if (distinctCompensations.length === 0) return primary;
  if (primary instanceof CompletedTaskSnapshotAuthorityUnknownError) {
    return new CompletedTaskSnapshotAuthorityUnknownError(
      preservePrimaryFailure(
        primary.authorityError,
        distinctCompensations,
        aggregateMessage
      )
    );
  }
  return preservePrimaryFailure(primary, distinctCompensations, aggregateMessage);
}

function observeTaskRouteErrorWithoutInterference(
  sink: ((error: unknown) => void) | undefined,
  error: unknown
): void {
  if (!sink) return;
  try {
    const observation: unknown = (sink as (error: unknown) => unknown)(error);
    if (
      observation !== null &&
      (typeof observation === "object" || typeof observation === "function") &&
      "then" in observation &&
      typeof observation.then === "function"
    ) {
      void Promise.resolve(observation).catch(() => undefined);
    }
  } catch {
    // Route observers are best-effort diagnostics and cannot affect HTTP semantics.
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
    if (replay.status === "invalid_completed") {
      return await resolveInvalidCompletedTaskCreate(input);
    }
    if (replay.status === "completed") {
      return completedTaskCreateResultWithoutLocal(
        input,
        await classifyCompletedTaskAuthority(input)
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
      throw new CompletedTaskSnapshotAuthorityReadError();
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
  if (error instanceof CompletedTaskSnapshotAuthorityUnknownError) {
    return jsonTaskServiceError(c, error.authorityError);
  }
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
  const writableProbe = options.writableProbe;
  const snapshotReadableProbe =
    options.snapshotReadableProbe ?? defaultSnapshotReadableProbe;

  return {
    async initWorkspace(): Promise<WorkspaceInitResponse> {
      await ensureWorkspaceDirectoryTree(
        workspaceRoot,
        WORKSPACE_CANONICAL_DIRECTORIES.map((relativeDir) => relativeDir.split("/")),
        "workspace.init"
      );

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

async function maybeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

async function probeWorkspaceWritable(
  workspaceRoot: string,
  writableProbe: WorkspaceWritableProbe | undefined
): Promise<boolean> {
  try {
    if (!writableProbe) {
      return await probeWorkspaceRecordDirectoryWritable(
        workspaceRoot,
        "workspace.health.writable"
      );
    }
    return await runWithExistingWorkspaceRecordDirectoryReproof(
      workspaceRoot,
      [],
      "workspace.health.custom_writable",
      async () => Boolean(await writableProbe({ workspaceRoot }))
    );
  } catch {
    return false;
  }
}

function statusFromBoolean(value: boolean): WorkspaceHealthCheckStatus {
  return value ? "ok" : "fail";
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

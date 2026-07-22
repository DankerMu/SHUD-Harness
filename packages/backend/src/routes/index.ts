import { dlopen, ptr, read as ffiRead, toBuffer, type Pointer } from "bun:ffi";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  writeSync,
  type BigIntStats
} from "node:fs";
import { access, lstat } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DEFAULT_TASK_CREATED_BY,
  CreateTaskInputSchema,
  MAX_TASK_SNAPSHOT_BYTES,
  TaskServiceError,
  captureFailureFoldEntry,
  canonicalJson,
  createIdempotencyMismatchError,
  createIdempotencyRecordService,
  createTaskCardService,
  ensureWorkspaceDirectoryTree,
  ensureWorkspaceRecordRootPhysicalIdentity,
  failureTerminalPhysicalPhase,
  isSafeTaskId,
  probeWorkspaceRecordDirectoryWritable,
  preserveTaskServiceErrorFailureEntries,
  semanticPrimaryValue,
  taskServiceErrorAuthorityTransportFamily,
  taskServiceErrorAtBoundary,
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
  type FailureAsyncOutcome,
  type FailureFoldEntry,
  type TaskSnapshotReadHooks,
  type TaskSnapshotWriteHooks
} from "@shud-harness/core";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError } from "zod";
import {
  createApiRequestLoggerMiddleware,
  type ApiRequestLogSink
} from "../middleware";
import {
  currentLocalTokenDirectoryEntryReplayForTest,
  currentLocalTokenPublicationStageHookForTest,
  type LocalTokenDirectoryBoundaryForTest,
  type LocalTokenPublicationStageForTest,
  type LocalTokenPublicationStageHookForTest
} from "./local-auth-publication-test-support";

export const BACKEND_ROUTES_NAMESPACE = "backend/routes" as const;
export const BACKEND_PRODUCTION_LISTEN_OPTIONS = Object.freeze({
  hostname: "127.0.0.1"
} as const);

export type BackendRoutesNamespace = typeof BACKEND_ROUTES_NAMESPACE;
const LOCAL_TOKEN_ENV_VAR = "HARNESS_LOCAL_TOKEN" as const;
const LOCAL_TOKEN_FILE = "local-token";
const LOCAL_TOKEN_DIRECTORY = "secrets";
const LOCAL_TOKEN_MAX_BYTES = 4096;
const LOCAL_TOKEN_DIRECTORY_ENTRY_LIMIT = 1024;
const LOCAL_TOKEN_DIRECTORY_NAME_MAX_BYTES = 255;
const LOCAL_TOKEN_DIRECTORY_ENTRY_BUFFER_BYTES = 4 * 1024;
const LOCAL_TOKEN_DIRECTORY_UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true
});
const PRIVATE_MODE_MASK = 0o7777n;
const PRIVATE_TOKEN_MODE = 0o600n;
const PRIVATE_TOKEN_DIRECTORY_MODE = 0o700n;
const LOCAL_TOKEN_DIRECTORY_OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_DIRECTORY ?? 0) |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);
const LOCAL_TOKEN_READ_OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);
const LOCAL_TOKEN_CREATE_OPEN_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);
const LOCAL_TOKEN_LEASE_OPEN_FLAGS =
  constants.O_RDWR |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);
const LOCAL_TOKEN_LEASE_CREATE_FLAGS =
  LOCAL_TOKEN_LEASE_OPEN_FLAGS |
  constants.O_CREAT |
  constants.O_EXCL;
const LOCAL_TOKEN_TEMPORARY_NAME_PATTERN =
  /^\.local-token-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;
const LOCAL_TOKEN_TRANSACTION_ARTIFACT_PATTERN =
  /^\.local-token-transaction-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(lease|staged|candidate)$/u;
const LOCAL_TOKEN_TRANSACTION_PHASE_PATTERN =
  /^\.local-token-transaction-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{64})-([0-9a-f]+)-([0-9a-f]+)\.(publishing|rolling-back)$/u;
const LOCAL_TOKEN_RETIRED_ARTIFACT_PATTERN =
  /^\.local-token-retired-([0-9a-f]+)-([0-9a-f]+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.retired$/u;
const LOCAL_TOKEN_FLOCK_EXCLUSIVE = 0x02;
const LOCAL_TOKEN_FLOCK_NONBLOCKING = 0x04;
const LOCAL_TOKEN_PUBLICATION_LEASE_WAIT_MS = 2_000;
const localTokenPublicationLeaseDepthByDirectory = new Map<string, number>();
const activeLocalTokenTransactionIds = new Set<string>();

export const WORKSPACE_CANONICAL_DIRECTORIES = [
  "repos",
  "repos/SHUD",
  "repos/rSHUD",
  "repos/AutoSHUD",
  "repos/zero",
  "secrets",
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

interface EnvironmentLocalAuthAuthority {
  readonly kind: "environment";
  readonly token: string;
}

interface FileLocalAuthAuthority {
  readonly kind: "file";
  readonly token: string;
  readonly workspaceRoot: string;
  readonly workspaceObservation: BigIntStats;
  readonly secretsObservation: BigIntStats;
  readonly tokenObservation: BigIntStats;
}

type LocalAuthAuthority = EnvironmentLocalAuthAuthority | FileLocalAuthAuthority;

interface LocalTokenDescriptorRead {
  readonly token: string;
  readonly observation: BigIntStats;
}

interface LocalTokenPhysicalIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface OwnedLocalTokenControlArtifact {
  readonly name: string;
  readonly identity: LocalTokenPhysicalIdentity;
}

interface CreatedLocalTokenLease {
  readonly descriptor: number;
  readonly control: OwnedLocalTokenControlArtifact;
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

export interface BackendProductionListenOptions {
  readonly hostname: typeof BACKEND_PRODUCTION_LISTEN_OPTIONS.hostname;
  readonly fetch: Hono["fetch"];
}

export function createBackendProductionListenOptions(
  options: BackendApiOptions = {}
): BackendProductionListenOptions {
  const app = createBackendApi(options);
  return Object.freeze({
    ...BACKEND_PRODUCTION_LISTEN_OPTIONS,
    fetch: app.fetch
  });
}

export function createBackendApi(options: BackendApiOptions = {}): Hono {
  const app = new Hono();
  const workspaceRoot = resolveWorkspaceRoot(options);
  const localAuthAuthority = resolveWorkspaceLocalAuthToken(
    workspaceRoot,
    currentLocalTokenPublicationStageHookForTest()
  );
  const service = createWorkspaceRoutesService({ ...options, workspaceRoot }, localAuthAuthority);
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
  app.use("*", createLocalApiAuthMiddleware(localAuthAuthority));

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
      const taskServiceError = taskServiceErrorAtBoundary(error);
      if (taskServiceError) {
        return jsonTaskServiceError(c, taskServiceError);
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

function createLocalApiAuthMiddleware(localAuthAuthority: LocalAuthAuthority): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    if (path !== "/api" && !path.startsWith("/api/")) {
      await next();
      return;
    }

    if (
      c.req.method === "GET" &&
      (path === "/api/health/live" || path === "/api/health/ready")
    ) {
      await next();
      return;
    }

    const bearerToken = parseBearerTokenFromAuthorizationHeader(c.req.header("authorization"));
    if (
      bearerToken !== undefined &&
      localAuthAuthorityIsCurrent(localAuthAuthority) &&
      localAuthTokensMatch(bearerToken, localAuthAuthority.token)
    ) {
      await next();
      return;
    }

    return jsonApiError(
      c,
      {
        category: "permission_error",
        severity: "error",
        message: "API request is not authorized.",
        userMessage: "Missing or invalid Authorization token.",
        evidenceRefs: ["request.headers.authorization"],
        retryable: false,
        recommendedNextActions: ["Provide a valid bearer token in the Authorization header."]
      },
      401
    );
  };
}

function parseBearerTokenFromAuthorizationHeader(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const matched = /^Bearer ([^\s,]+)$/u.exec(value);
  if (!matched) {
    return undefined;
  }

  const token = matched[1];
  return isValidLocalAuthToken(token) ? token : undefined;
}

function localAuthTokensMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function resolveWorkspaceLocalAuthToken(
  workspaceRoot: string,
  publicationHookForTest?: LocalTokenPublicationStageHookForTest
): LocalAuthAuthority {
  const configuredValue = process.env[LOCAL_TOKEN_ENV_VAR];
  const configuredToken = normalizeConfiguredLocalAuthToken(configuredValue);
  if (configuredToken !== undefined) {
    return Object.freeze({ kind: "environment", token: configuredToken });
  }

  return provisionWorkspaceLocalAuthToken(workspaceRoot, publicationHookForTest);
}

function provisionWorkspaceLocalAuthToken(
  workspaceRoot: string,
  publicationHookForTest?: LocalTokenPublicationStageHookForTest
): FileLocalAuthAuthority {
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  if (resolvedWorkspaceRoot === parse(resolvedWorkspaceRoot).root) {
    throw unsafeLocalTokenStorageError();
  }

  let workspaceDescriptor: number | undefined;
  let secretsDescriptor: number | undefined;
  let publicationLeaseKey: string | undefined;
  try {
    workspaceDescriptor = openWorkspaceRootDescriptor(resolvedWorkspaceRoot);
    secretsDescriptor = openOrCreatePrivateDirectory(
      workspaceDescriptor,
      LOCAL_TOKEN_DIRECTORY
    );
    publicationLeaseKey = acquireLocalTokenPublicationLease(secretsDescriptor);
    recoverInterruptedLocalTokenPublication(
      resolvedWorkspaceRoot,
      workspaceDescriptor,
      secretsDescriptor,
      publicationHookForTest
    );
    const token = readExistingLocalToken(secretsDescriptor) ??
      publishGeneratedLocalToken({
        workspaceRoot: resolvedWorkspaceRoot,
        workspaceDescriptor,
        secretsDescriptor,
        hookForTest: publicationHookForTest
      });
    assertDirectoryDescriptorMode(secretsDescriptor, PRIVATE_TOKEN_DIRECTORY_MODE);
    assertWorkspaceTokenDirectoryBinding(
      resolvedWorkspaceRoot,
      workspaceDescriptor,
      secretsDescriptor
    );
    return captureFileLocalAuthAuthority(
      resolvedWorkspaceRoot,
      token,
      workspaceDescriptor,
      secretsDescriptor
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Local API token is invalid.") {
      throw error;
    }
    throw unsafeLocalTokenStorageError();
  } finally {
    releaseLocalTokenPublicationLease(publicationLeaseKey);
    closeDescriptorIfOwned(secretsDescriptor);
    closeDescriptorIfOwned(workspaceDescriptor);
  }
}

function recoverInterruptedLocalTokenPublication(
  workspaceRoot: string,
  workspaceDescriptor: number,
  secretsDescriptor: number,
  hookForTest?: LocalTokenPublicationStageHookForTest
): void {
  assertWorkspaceTokenDirectoryBinding(workspaceRoot, workspaceDescriptor, secretsDescriptor);
  const names = readLocalTokenDirectoryNames(secretsDescriptor, hookForTest);
  assertWorkspaceTokenDirectoryBinding(workspaceRoot, workspaceDescriptor, secretsDescriptor);
  let directoryMutated = false;

  for (const name of names) {
    const retired = LOCAL_TOKEN_RETIRED_ARTIFACT_PATTERN.exec(name);
    if (!retired) continue;
    retireObservedLocalTokenArtifact(
      secretsDescriptor,
      name,
      Object.freeze({ dev: BigInt(`0x${retired[1]}`), ino: BigInt(`0x${retired[2]}`) })
    );
    directoryMutated = true;
  }

  const transactions = collectLocalTokenTransactions(names);
  for (const transaction of transactions.values()) {
    if (activeLocalTokenTransactionIds.has(transaction.id)) continue;
    if (recoverLocalTokenTransaction(
      secretsDescriptor,
      transaction,
      hookForTest
    )) {
      directoryMutated = true;
    }
  }

  for (const name of names) {
    const matched = LOCAL_TOKEN_TEMPORARY_NAME_PATTERN.exec(name);
    if (!matched) continue;
    invokeLocalTokenPublicationHookForTest(hookForTest, "before_recovery_artifact_open", name);
    const temporaryDescriptor = syscallOpenAt(
      secretsDescriptor,
      name,
      LOCAL_TOKEN_READ_OPEN_FLAGS
    );
    if (temporaryDescriptor < 0) {
      if (!localTokenDirectoryContainsName(secretsDescriptor, name, hookForTest)) continue;
      throw unsafeLocalTokenStorageError();
    }
    try {
      const temporaryObservation = fstatSync(temporaryDescriptor, { bigint: true });
      if (
        !temporaryObservation.isFile() ||
        temporaryObservation.isSymbolicLink() ||
        (temporaryObservation.mode & PRIVATE_MODE_MASK) !== PRIVATE_TOKEN_MODE ||
        temporaryObservation.nlink < 1n ||
        temporaryObservation.nlink > 2n
      ) {
        throw unsafeLocalTokenStorageError();
      }

      if (temporaryObservation.nlink === 2n) {
        const finalDescriptor = syscallOpenAt(
          secretsDescriptor,
          LOCAL_TOKEN_FILE,
          LOCAL_TOKEN_READ_OPEN_FLAGS
        );
        if (finalDescriptor < 0) throw unsafeLocalTokenStorageError();
        try {
          if (!sameFilesystemIdentity(
            temporaryObservation,
            fstatSync(finalDescriptor, { bigint: true })
          )) {
            throw unsafeLocalTokenStorageError();
          }
        } finally {
          closeSync(finalDescriptor);
        }
      }

      // Legacy artifacts have no process-instance proof. A live PID cannot establish
      // ownership because PID values are reusable, so a single-link legacy staging
      // file is always stale. New publishers hold a kernel-released directory flock.
      retireObservedLocalTokenArtifact(
        secretsDescriptor,
        name,
        physicalIdentityFromObservation(temporaryObservation)
      );
      directoryMutated = true;
    } finally {
      closeSync(temporaryDescriptor);
    }
  }

  if (directoryMutated) fsyncSync(secretsDescriptor);
}

function readLocalTokenDirectoryNames(
  secretsDescriptor: number,
  hookForTest?: LocalTokenPublicationStageHookForTest
): string[] {
  const syscalls = getLocalTokenFilesystemSyscalls();
  const replayForTest = currentLocalTokenDirectoryEntryReplayForTest();
  const streamDescriptor = syscallOpenAt(
    secretsDescriptor,
    ".",
    LOCAL_TOKEN_DIRECTORY_OPEN_FLAGS
  );
  if (streamDescriptor < 0) throw unsafeLocalTokenStorageError();
  const stream = syscalls.openDirectoryStream(streamDescriptor);
  if (stream === null) {
    closeSync(streamDescriptor);
    throw unsafeLocalTokenStorageError();
  }

  const names: string[] = [];
  const decodedNames = new Set<string>();
  let maxNameBytes = 0;
  let failure: unknown;
  try {
    invokeLocalTokenPublicationHookForTest(hookForTest, "before_recovery_directory_read");
    const acceptEntry = (entry: Pointer, layout: "darwin" | "linux"): void => {
      let name: string;
      try {
        name = decodeLocalTokenDirectoryEntryName(entry, layout);
      } catch (error) {
        invokeLocalTokenDirectoryBoundaryRejectionForTest(
          hookForTest,
          "decode",
          names.length,
          maxNameBytes
        );
        throw error;
      }
      if (name === "." || name === "..") return;
      const nameBytes = Buffer.byteLength(name, "utf8");
      if (nameBytes > LOCAL_TOKEN_DIRECTORY_NAME_MAX_BYTES) {
        invokeLocalTokenDirectoryBoundaryRejectionForTest(
          hookForTest,
          "name_bytes",
          names.length,
          Math.max(maxNameBytes, nameBytes)
        );
        throw unsafeLocalTokenStorageError();
      }
      if (decodedNames.has(name)) {
        invokeLocalTokenDirectoryBoundaryRejectionForTest(
          hookForTest,
          "duplicate_decoded_name",
          names.length,
          Math.max(maxNameBytes, nameBytes)
        );
        throw unsafeLocalTokenStorageError();
      }
      if (names.length >= LOCAL_TOKEN_DIRECTORY_ENTRY_LIMIT) {
        invokeLocalTokenDirectoryBoundaryRejectionForTest(
          hookForTest,
          "entry_limit",
          names.length,
          Math.max(maxNameBytes, nameBytes)
        );
        throw unsafeLocalTokenStorageError();
      }
      decodedNames.add(name);
      names.push(name);
      maxNameBytes = Math.max(maxNameBytes, nameBytes);
    };

    if (replayForTest) {
      for (const record of replayForTest.records) {
        acceptEntry(ptr(record), replayForTest.layout);
      }
    } else {
      for (;;) {
        const errnoPointer = syscalls.errnoPointer();
        syscalls.clearErrno(errnoPointer);
        const entry = syscalls.readDirectoryEntry(stream);
        if (entry === null) {
          if (ffiRead.i32(errnoPointer) !== 0) throw unsafeLocalTokenStorageError();
          break;
        }
        acceptEntry(entry, process.platform === "darwin" ? "darwin" : "linux");
      }
    }
    invokeLocalTokenPublicationHookForTest(
      hookForTest,
      "after_recovery_directory_read",
      undefined,
      { entryCount: names.length, maxNameBytes }
    );
  } catch (error) {
    failure = error;
  }
  if (syscalls.closeDirectoryStream(stream) !== 0) {
    failure ??= unsafeLocalTokenStorageError();
  }
  if (failure !== undefined) throw failure;
  return names;
}

function decodeLocalTokenDirectoryEntryName(
  entry: Pointer,
  layout: "darwin" | "linux"
): string {
  try {
    if (layout === "darwin") {
      const nameLength = ffiRead.u16(entry, 18);
      if (
        nameLength === 0 ||
        nameLength > LOCAL_TOKEN_DIRECTORY_NAME_MAX_BYTES ||
        nameLength > LOCAL_TOKEN_DIRECTORY_ENTRY_BUFFER_BYTES - 21
      ) {
        throw new Error("invalid Darwin directory entry");
      }
      return LOCAL_TOKEN_DIRECTORY_UTF8_DECODER.decode(toBuffer(entry, 21, nameLength));
    }
    if (layout === "linux") {
      const recordLength = ffiRead.u16(entry, 16);
      if (recordLength <= 19 || recordLength > LOCAL_TOKEN_DIRECTORY_ENTRY_BUFFER_BYTES) {
        throw new Error("invalid Linux directory entry");
      }
      const bytes = toBuffer(entry, 19, recordLength - 19);
      const terminator = bytes.indexOf(0);
      if (terminator <= 0 || terminator > LOCAL_TOKEN_DIRECTORY_NAME_MAX_BYTES) {
        throw new Error("invalid Linux directory entry name");
      }
      return LOCAL_TOKEN_DIRECTORY_UTF8_DECODER.decode(bytes.subarray(0, terminator));
    }
  } catch {
    throw unsafeLocalTokenStorageError();
  }
  throw unsafeLocalTokenStorageError();
}

function invokeLocalTokenDirectoryBoundaryRejectionForTest(
  hookForTest: LocalTokenPublicationStageHookForTest | undefined,
  boundary: LocalTokenDirectoryBoundaryForTest,
  entryCount: number,
  maxNameBytes: number
): void {
  invokeLocalTokenPublicationHookForTest(
    hookForTest,
    "recovery_directory_boundary_rejected",
    undefined,
    { boundary, entryCount, maxNameBytes }
  );
}

function localTokenDirectoryContainsName(
  secretsDescriptor: number,
  name: string,
  hookForTest?: LocalTokenPublicationStageHookForTest
): boolean {
  return readLocalTokenDirectoryNames(secretsDescriptor, hookForTest).includes(name);
}

interface LocalTokenTransactionArtifacts {
  readonly id: string;
  leaseName?: string;
  stagedName?: string;
  candidateName?: string;
  publishingMarkerName?: string;
  rollbackMarkerName?: string;
  digest?: string;
  generationIdentity?: LocalTokenPhysicalIdentity;
}

function collectLocalTokenTransactions(
  names: readonly string[]
): Map<string, LocalTokenTransactionArtifacts> {
  const transactions = new Map<string, LocalTokenTransactionArtifacts>();
  for (const name of names) {
    const artifact = LOCAL_TOKEN_TRANSACTION_ARTIFACT_PATTERN.exec(name);
    if (artifact) {
      const id = artifact[1] as string;
      const transaction = transactions.get(id) ?? { id };
      const kind = artifact[2];
      if (kind === "lease") transaction.leaseName = name;
      if (kind === "staged") transaction.stagedName = name;
      if (kind === "candidate") transaction.candidateName = name;
      transactions.set(id, transaction);
      continue;
    }

    const phase = LOCAL_TOKEN_TRANSACTION_PHASE_PATTERN.exec(name);
    if (!phase) continue;
    const id = phase[1] as string;
    const digest = phase[2] as string;
    const generationIdentity = Object.freeze({
      dev: BigInt(`0x${phase[3]}`),
      ino: BigInt(`0x${phase[4]}`)
    });
    const transaction = transactions.get(id) ?? { id };
    if (transaction.digest !== undefined && transaction.digest !== digest) {
      throw unsafeLocalTokenStorageError();
    }
    if (
      transaction.generationIdentity !== undefined &&
      !sameLocalTokenPhysicalIdentity(transaction.generationIdentity, generationIdentity)
    ) {
      throw unsafeLocalTokenStorageError();
    }
    transaction.digest = digest;
    transaction.generationIdentity = generationIdentity;
    if (phase[5] === "publishing") {
      if (transaction.publishingMarkerName !== undefined) throw unsafeLocalTokenStorageError();
      transaction.publishingMarkerName = name;
    } else {
      if (transaction.rollbackMarkerName !== undefined) throw unsafeLocalTokenStorageError();
      transaction.rollbackMarkerName = name;
    }
    transactions.set(id, transaction);
  }
  return transactions;
}

function recoverLocalTokenTransaction(
  secretsDescriptor: number,
  transaction: LocalTokenTransactionArtifacts,
  hookForTest?: LocalTokenPublicationStageHookForTest
): boolean {
  const leaseControl = transaction.leaseName
    ? validateLocalTokenTransactionControlArtifact(
      secretsDescriptor,
      transaction.leaseName
    )
    : undefined;
  if (transaction.publishingMarkerName && transaction.rollbackMarkerName) {
    throw unsafeLocalTokenStorageError();
  }
  if (transaction.digest === undefined) {
    if (transaction.candidateName) throw unsafeLocalTokenStorageError();
    if (transaction.stagedName) {
      const stagedIdentity = assertRecoverablePartialLocalTokenArtifact(
        secretsDescriptor,
        transaction.stagedName
      );
      retireObservedLocalTokenArtifact(
        secretsDescriptor,
        transaction.stagedName,
        stagedIdentity
      );
    }
    if (leaseControl) {
      unlinkOwnedLocalTokenControlArtifact(
        secretsDescriptor,
        leaseControl,
        hookForTest
      );
    }
    return true;
  }
  if (transaction.rollbackMarkerName) {
    recoverRollingBackLocalTokenTransaction(
      secretsDescriptor,
      transaction,
      leaseControl,
      hookForTest
    );
  } else if (transaction.publishingMarkerName) {
    recoverPublishingLocalTokenTransaction(
      secretsDescriptor,
      transaction,
      leaseControl,
      hookForTest
    );
  } else {
    throw unsafeLocalTokenStorageError();
  }
  return true;
}

function recoverPublishingLocalTokenTransaction(
  secretsDescriptor: number,
  transaction: LocalTokenTransactionArtifacts,
  leaseControl: OwnedLocalTokenControlArtifact | undefined,
  hookForTest?: LocalTokenPublicationStageHookForTest
): void {
  if (
    !transaction.publishingMarkerName ||
    !transaction.digest ||
    !transaction.generationIdentity ||
    transaction.candidateName
  ) {
    throw unsafeLocalTokenStorageError();
  }
  const publishingMarker = validateLocalTokenTransactionControlArtifact(
    secretsDescriptor,
    transaction.publishingMarkerName
  );
  const canonical = readObservedLocalTokenArtifact(secretsDescriptor, LOCAL_TOKEN_FILE);
  if (
    canonical !== undefined &&
    sameLocalTokenPhysicalIdentity(canonical.identity, transaction.generationIdentity)
  ) {
    if (canonical.digest !== transaction.digest) throw unsafeLocalTokenStorageError();
    if (transaction.stagedName) throw unsafeLocalTokenStorageError();
  } else if (transaction.stagedName) {
    const staged = requireObservedLocalTokenArtifact(
      secretsDescriptor,
      transaction.stagedName
    );
    if (
      staged.digest !== transaction.digest ||
      !sameLocalTokenPhysicalIdentity(staged.identity, transaction.generationIdentity)
    ) {
      throw unsafeLocalTokenStorageError();
    }
    retireObservedLocalTokenArtifact(
      secretsDescriptor,
      transaction.stagedName,
      transaction.generationIdentity
    );
  }
  unlinkOwnedLocalTokenControlArtifact(
    secretsDescriptor,
    publishingMarker,
    hookForTest
  );
  if (leaseControl) {
    unlinkOwnedLocalTokenControlArtifact(
      secretsDescriptor,
      leaseControl,
      hookForTest
    );
  }
}

function recoverRollingBackLocalTokenTransaction(
  secretsDescriptor: number,
  transaction: LocalTokenTransactionArtifacts,
  leaseControl: OwnedLocalTokenControlArtifact | undefined,
  hookForTest?: LocalTokenPublicationStageHookForTest
): void {
  if (
    !transaction.rollbackMarkerName ||
    !transaction.digest ||
    !transaction.generationIdentity ||
    transaction.stagedName
  ) {
    throw unsafeLocalTokenStorageError();
  }
  const rollbackMarker = validateLocalTokenTransactionControlArtifact(
    secretsDescriptor,
    transaction.rollbackMarkerName
  );

  if (transaction.candidateName) {
    const candidate = requireObservedLocalTokenArtifact(
      secretsDescriptor,
      transaction.candidateName
    );
    if (sameLocalTokenPhysicalIdentity(candidate.identity, transaction.generationIdentity)) {
      if (candidate.digest !== transaction.digest) throw unsafeLocalTokenStorageError();
      retireObservedLocalTokenArtifact(
        secretsDescriptor,
        transaction.candidateName,
        transaction.generationIdentity
      );
      transaction.candidateName = undefined;
    } else {
      if (readObservedLocalTokenArtifact(secretsDescriptor, LOCAL_TOKEN_FILE) !== undefined) {
        // Two independently written foreign generations cannot be ordered without
        // deleting one. Preserve both and fail closed; cooperating publishers cannot
        // create this state because their leases cover the whole transition.
        throw unsafeLocalTokenStorageError();
      }
      if (syscallRenameAtNoReplace(
        secretsDescriptor,
        transaction.candidateName,
        secretsDescriptor,
        LOCAL_TOKEN_FILE
      ) !== 0) {
        throw unsafeLocalTokenStorageError();
      }
      transaction.candidateName = undefined;
      fsyncSync(secretsDescriptor);
      const restored = requireObservedLocalTokenArtifact(
        secretsDescriptor,
        LOCAL_TOKEN_FILE
      );
      if (!sameLocalTokenPhysicalIdentity(restored.identity, candidate.identity)) {
        throw unsafeLocalTokenStorageError();
      }
    }
  }

  const canonical = readObservedLocalTokenArtifact(secretsDescriptor, LOCAL_TOKEN_FILE);
  if (
    canonical !== undefined &&
    sameLocalTokenPhysicalIdentity(canonical.identity, transaction.generationIdentity)
  ) {
    if (canonical.digest !== transaction.digest) throw unsafeLocalTokenStorageError();
    const candidateName = localTokenTransactionCandidateName(transaction.id);
    if (syscallRenameAtNoReplace(
      secretsDescriptor,
      LOCAL_TOKEN_FILE,
      secretsDescriptor,
      candidateName
    ) !== 0) {
      throw unsafeLocalTokenStorageError();
    }
    fsyncSync(secretsDescriptor);
    retireObservedLocalTokenArtifact(
      secretsDescriptor,
      candidateName,
      transaction.generationIdentity
    );
  }

  unlinkOwnedLocalTokenControlArtifact(
    secretsDescriptor,
    rollbackMarker,
    hookForTest
  );
  if (leaseControl) {
    unlinkOwnedLocalTokenControlArtifact(
      secretsDescriptor,
      leaseControl,
      hookForTest
    );
  }
}

function assertLocalTokenTransactionControlFile(descriptor: number): void {
  const entry = fstatSync(descriptor, { bigint: true });
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1n ||
    entry.size !== 0n ||
    (entry.mode & PRIVATE_MODE_MASK) !== PRIVATE_TOKEN_MODE
  ) {
    throw unsafeLocalTokenStorageError();
  }
}

function validateLocalTokenTransactionControlArtifact(
  secretsDescriptor: number,
  name: string
): OwnedLocalTokenControlArtifact {
  const descriptor = syscallOpenAt(secretsDescriptor, name, LOCAL_TOKEN_READ_OPEN_FLAGS);
  if (descriptor < 0) throw unsafeLocalTokenStorageError();
  try {
    assertLocalTokenTransactionControlFile(descriptor);
    const observed = fstatSync(descriptor, { bigint: true });
    const reboundDescriptor = syscallOpenAt(
      secretsDescriptor,
      name,
      LOCAL_TOKEN_READ_OPEN_FLAGS
    );
    if (reboundDescriptor < 0) throw unsafeLocalTokenStorageError();
    try {
      assertLocalTokenTransactionControlFile(reboundDescriptor);
      if (!sameFilesystemIdentity(
        observed,
        fstatSync(reboundDescriptor, { bigint: true })
      )) {
        throw unsafeLocalTokenStorageError();
      }
    } finally {
      closeSync(reboundDescriptor);
    }
    return ownedLocalTokenControlArtifact(
      name,
      physicalIdentityFromObservation(observed)
    );
  } finally {
    closeSync(descriptor);
  }
}

function unlinkOwnedLocalTokenControlArtifact(
  secretsDescriptor: number,
  control: OwnedLocalTokenControlArtifact,
  hookForTest?: LocalTokenPublicationStageHookForTest
): void {
  invokeLocalTokenPublicationHookForTest(
    hookForTest,
    localTokenControlCleanupStageForTest(control.name),
    control.name
  );
  retireObservedLocalTokenArtifact(
    secretsDescriptor,
    control.name,
    control.identity
  );
}

function localTokenControlCleanupStageForTest(
  name: string
): LocalTokenPublicationStageForTest {
  if (name.endsWith(".publishing")) return "before_publishing_marker_cleanup";
  if (name.endsWith(".rolling-back")) return "before_rollback_marker_cleanup";
  if (name.endsWith(".lease")) return "before_lease_cleanup";
  throw unsafeLocalTokenStorageError();
}

function ownedLocalTokenControlArtifact(
  name: string,
  identity: LocalTokenPhysicalIdentity
): OwnedLocalTokenControlArtifact {
  return Object.freeze({ name, identity });
}

function assertOwnedLocalTokenControlArtifactCurrent(
  secretsDescriptor: number,
  expected: OwnedLocalTokenControlArtifact
): void {
  const current = validateLocalTokenTransactionControlArtifact(
    secretsDescriptor,
    expected.name
  );
  if (!sameLocalTokenPhysicalIdentity(current.identity, expected.identity)) {
    throw unsafeLocalTokenStorageError();
  }
}

interface ObservedLocalTokenArtifact extends LocalTokenDescriptorRead {
  readonly digest: string;
  readonly identity: LocalTokenPhysicalIdentity;
}

function readObservedLocalTokenArtifact(
  secretsDescriptor: number,
  name: string
): ObservedLocalTokenArtifact | undefined {
  const descriptor = syscallOpenAt(secretsDescriptor, name, LOCAL_TOKEN_READ_OPEN_FLAGS);
  if (descriptor < 0) {
    if (!localTokenDirectoryContainsName(secretsDescriptor, name)) return undefined;
    throw unsafeLocalTokenStorageError();
  }
  try {
    const observed = readAndValidateLocalTokenDescriptor(
      descriptor,
      secretsDescriptor,
      name
    );
    return Object.freeze({
      ...observed,
      digest: sha256Hex(observed.token),
      identity: physicalIdentityFromObservation(observed.observation)
    });
  } finally {
    closeSync(descriptor);
  }
}

function requireObservedLocalTokenArtifact(
  secretsDescriptor: number,
  name: string
): ObservedLocalTokenArtifact {
  const observed = readObservedLocalTokenArtifact(secretsDescriptor, name);
  if (observed === undefined) throw unsafeLocalTokenStorageError();
  return observed;
}

function observeLocalTokenArtifactIdentity(
  secretsDescriptor: number,
  name: string
): LocalTokenPhysicalIdentity | undefined {
  const descriptor = syscallOpenAt(secretsDescriptor, name, LOCAL_TOKEN_READ_OPEN_FLAGS);
  if (descriptor < 0) {
    if (!localTokenDirectoryContainsName(secretsDescriptor, name)) return undefined;
    throw unsafeLocalTokenStorageError();
  }
  try {
    const observed = fstatSync(descriptor, { bigint: true });
    if (!observed.isFile() || observed.isSymbolicLink()) {
      throw unsafeLocalTokenStorageError();
    }
    const reboundDescriptor = syscallOpenAt(
      secretsDescriptor,
      name,
      LOCAL_TOKEN_READ_OPEN_FLAGS
    );
    if (reboundDescriptor < 0) throw unsafeLocalTokenStorageError();
    try {
      if (!sameFilesystemIdentity(observed, fstatSync(reboundDescriptor, { bigint: true }))) {
        throw unsafeLocalTokenStorageError();
      }
    } finally {
      closeSync(reboundDescriptor);
    }
    return physicalIdentityFromObservation(observed);
  } finally {
    closeSync(descriptor);
  }
}

function retireObservedLocalTokenArtifact(
  secretsDescriptor: number,
  name: string,
  expectedIdentity: LocalTokenPhysicalIdentity
): void {
  const before = observeLocalTokenArtifactIdentity(secretsDescriptor, name);
  if (before === undefined || !sameLocalTokenPhysicalIdentity(before, expectedIdentity)) {
    throw unsafeLocalTokenStorageError();
  }
  const retirementName = `.local-token-retired-${localTokenPhysicalIdentityName(expectedIdentity)}-${randomUUID()}.retired`;
  if (syscallRenameAtNoReplace(
    secretsDescriptor,
    name,
    secretsDescriptor,
    retirementName
  ) !== 0) {
    throw unsafeLocalTokenStorageError();
  }
  fsyncSync(secretsDescriptor);

  const retired = observeLocalTokenArtifactIdentity(secretsDescriptor, retirementName);
  if (retired === undefined || !sameLocalTokenPhysicalIdentity(retired, expectedIdentity)) {
    if (retired !== undefined) {
      syscallRenameAtNoReplace(
        secretsDescriptor,
        retirementName,
        secretsDescriptor,
        name
      );
      fsyncSync(secretsDescriptor);
    }
    throw unsafeLocalTokenStorageError();
  }
  const reproof = observeLocalTokenArtifactIdentity(secretsDescriptor, retirementName);
  if (reproof === undefined || !sameLocalTokenPhysicalIdentity(reproof, expectedIdentity)) {
    throw unsafeLocalTokenStorageError();
  }
  if (syscallUnlinkAt(secretsDescriptor, retirementName) !== 0) {
    throw unsafeLocalTokenStorageError();
  }
  fsyncSync(secretsDescriptor);
}

function physicalIdentityFromObservation(
  observation: BigIntStats
): LocalTokenPhysicalIdentity {
  return Object.freeze({ dev: observation.dev, ino: observation.ino });
}

function sameLocalTokenPhysicalIdentity(
  left: LocalTokenPhysicalIdentity,
  right: LocalTokenPhysicalIdentity
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function localTokenPhysicalIdentityName(identity: LocalTokenPhysicalIdentity): string {
  return `${identity.dev.toString(16)}-${identity.ino.toString(16)}`;
}

function assertRecoverablePartialLocalTokenArtifact(
  secretsDescriptor: number,
  name: string
): LocalTokenPhysicalIdentity {
  const descriptor = syscallOpenAt(secretsDescriptor, name, LOCAL_TOKEN_READ_OPEN_FLAGS);
  if (descriptor < 0) throw unsafeLocalTokenStorageError();
  try {
    const observed = fstatSync(descriptor, { bigint: true });
    if (
      !observed.isFile() ||
      observed.isSymbolicLink() ||
      observed.nlink !== 1n ||
      observed.size < 0n ||
      observed.size > BigInt(LOCAL_TOKEN_MAX_BYTES) ||
      (observed.mode & PRIVATE_MODE_MASK) !== PRIVATE_TOKEN_MODE
    ) {
      throw unsafeLocalTokenStorageError();
    }
    const reboundDescriptor = syscallOpenAt(
      secretsDescriptor,
      name,
      LOCAL_TOKEN_READ_OPEN_FLAGS
    );
    if (reboundDescriptor < 0) throw unsafeLocalTokenStorageError();
    try {
      if (!sameTokenFileObservation(
        observed,
        fstatSync(reboundDescriptor, { bigint: true })
      )) {
        throw unsafeLocalTokenStorageError();
      }
    } finally {
      closeSync(reboundDescriptor);
    }
    return physicalIdentityFromObservation(observed);
  } finally {
    closeSync(descriptor);
  }
}

function normalizeConfiguredLocalAuthToken(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  if (!isValidLocalAuthToken(value)) {
    throw invalidLocalTokenError();
  }
  return value;
}

function captureFileLocalAuthAuthority(
  workspaceRoot: string,
  expectedToken: string,
  workspaceDescriptor: number,
  secretsDescriptor: number
): FileLocalAuthAuthority {
  const tokenDescriptor = syscallOpenAt(
    secretsDescriptor,
    LOCAL_TOKEN_FILE,
    LOCAL_TOKEN_READ_OPEN_FLAGS
  );
  if (tokenDescriptor < 0) throw unsafeLocalTokenStorageError();
  try {
    const current = readAndValidateLocalTokenDescriptor(tokenDescriptor, secretsDescriptor);
    if (!localAuthTokensMatch(current.token, expectedToken)) {
      throw unsafeLocalTokenStorageError();
    }
    return Object.freeze({
      kind: "file",
      token: current.token,
      workspaceRoot,
      workspaceObservation: fstatSync(workspaceDescriptor, { bigint: true }),
      secretsObservation: fstatSync(secretsDescriptor, { bigint: true }),
      tokenObservation: current.observation
    });
  } finally {
    closeSync(tokenDescriptor);
  }
}

function localAuthAuthorityIsCurrent(authority: LocalAuthAuthority): boolean {
  if (authority.kind === "environment") return true;

  let workspaceDescriptor: number | undefined;
  let secretsDescriptor: number | undefined;
  let tokenDescriptor: number | undefined;
  try {
    workspaceDescriptor = openExistingWorkspaceRootDescriptor(authority.workspaceRoot);
    if (!sameFilesystemIdentity(
      authority.workspaceObservation,
      fstatSync(workspaceDescriptor, { bigint: true })
    )) return false;

    secretsDescriptor = syscallOpenAt(
      workspaceDescriptor,
      LOCAL_TOKEN_DIRECTORY,
      LOCAL_TOKEN_DIRECTORY_OPEN_FLAGS
    );
    if (secretsDescriptor < 0) return false;
    assertDirectoryDescriptorMode(secretsDescriptor, PRIVATE_TOKEN_DIRECTORY_MODE);
    if (!sameFilesystemIdentity(
      authority.secretsObservation,
      fstatSync(secretsDescriptor, { bigint: true })
    )) return false;

    tokenDescriptor = syscallOpenAt(
      secretsDescriptor,
      LOCAL_TOKEN_FILE,
      LOCAL_TOKEN_READ_OPEN_FLAGS
    );
    if (tokenDescriptor < 0) return false;
    const current = readAndValidateLocalTokenDescriptor(tokenDescriptor, secretsDescriptor);
    return sameTokenFileObservation(authority.tokenObservation, current.observation) &&
      localAuthTokensMatch(current.token, authority.token);
  } catch {
    return false;
  } finally {
    closeDescriptorIfOwned(tokenDescriptor);
    closeDescriptorIfOwned(secretsDescriptor);
    closeDescriptorIfOwned(workspaceDescriptor);
  }
}

function isValidLocalAuthToken(token: string): boolean {
  return (
    token.length > 0 &&
    !/[\s,\u0000]/u.test(token) &&
    Buffer.byteLength(token, "utf8") <= LOCAL_TOKEN_MAX_BYTES
  );
}

function openWorkspaceRootDescriptor(workspaceRoot: string): number {
  const parsed = parse(workspaceRoot);
  let descriptor = openSync(parsed.root, LOCAL_TOKEN_DIRECTORY_OPEN_FLAGS);
  try {
    const segments = workspaceRoot.slice(parsed.root.length).split(sep).filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string;
      let nextDescriptor = syscallOpenAt(descriptor, segment, LOCAL_TOKEN_DIRECTORY_OPEN_FLAGS);
      if (nextDescriptor < 0 && index === segments.length - 1) {
        const created = syscallMkdirAt(descriptor, segment, 0o700) === 0;
        nextDescriptor = syscallOpenAt(descriptor, segment, LOCAL_TOKEN_DIRECTORY_OPEN_FLAGS);
        if (nextDescriptor >= 0 && created) {
          fchmodSync(nextDescriptor, 0o700);
        }
      }
      if (nextDescriptor < 0) {
        throw unsafeLocalTokenStorageError();
      }
      closeSync(descriptor);
      descriptor = nextDescriptor;
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function openExistingWorkspaceRootDescriptor(workspaceRoot: string): number {
  const parsed = parse(workspaceRoot);
  let descriptor = openSync(parsed.root, LOCAL_TOKEN_DIRECTORY_OPEN_FLAGS);
  try {
    for (const segment of workspaceRoot.slice(parsed.root.length).split(sep).filter(Boolean)) {
      const nextDescriptor = syscallOpenAt(descriptor, segment, LOCAL_TOKEN_DIRECTORY_OPEN_FLAGS);
      if (nextDescriptor < 0) throw unsafeLocalTokenStorageError();
      closeSync(descriptor);
      descriptor = nextDescriptor;
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function openOrCreatePrivateDirectory(parentDescriptor: number, name: string): number {
  let descriptor = syscallOpenAt(parentDescriptor, name, LOCAL_TOKEN_DIRECTORY_OPEN_FLAGS);
  if (descriptor >= 0) {
    assertDirectoryDescriptorMode(descriptor, PRIVATE_TOKEN_DIRECTORY_MODE);
    return descriptor;
  }

  const created = syscallMkdirAt(parentDescriptor, name, 0o700) === 0;
  descriptor = syscallOpenAt(parentDescriptor, name, LOCAL_TOKEN_DIRECTORY_OPEN_FLAGS);
  if (descriptor < 0) throw unsafeLocalTokenStorageError();
  if (created) {
    fchmodSync(descriptor, 0o700);
    fsyncSync(parentDescriptor);
  }
  assertDirectoryDescriptorMode(descriptor, PRIVATE_TOKEN_DIRECTORY_MODE);
  return descriptor;
}

function readExistingLocalToken(secretsDescriptor: number): string | undefined {
  const descriptor = syscallOpenAt(
    secretsDescriptor,
    LOCAL_TOKEN_FILE,
    LOCAL_TOKEN_READ_OPEN_FLAGS
  );
  if (descriptor < 0) return undefined;
  try {
    return readAndValidateLocalTokenDescriptor(descriptor, secretsDescriptor).token;
  } finally {
    closeSync(descriptor);
  }
}

function publishGeneratedLocalToken(input: {
  workspaceRoot: string;
  workspaceDescriptor: number;
  secretsDescriptor: number;
  hookForTest?: LocalTokenPublicationStageHookForTest;
}): string {
  const { workspaceRoot, workspaceDescriptor, secretsDescriptor, hookForTest } = input;
  const token = randomBytes(32).toString("base64url");
  const tokenBytes = Buffer.from(token, "utf8");
  const transactionId = randomUUID();
  const digest = sha256Hex(token);
  const leaseName = localTokenTransactionLeaseName(transactionId);
  const temporaryName = localTokenTransactionStagedName(transactionId);
  const lease = createLocalTokenTransactionLeaseFile(
    secretsDescriptor,
    leaseName
  );
  const leaseDescriptor = lease.descriptor;
  const temporaryDescriptor = syscallOpenAt(
    secretsDescriptor,
    temporaryName,
    LOCAL_TOKEN_CREATE_OPEN_FLAGS,
    0o600
  );
  if (temporaryDescriptor < 0) {
    unlinkOwnedLocalTokenControlArtifact(
      secretsDescriptor,
      lease.control,
      hookForTest
    );
    closeSync(leaseDescriptor);
    throw unsafeLocalTokenStorageError();
  }
  const generationIdentity = physicalIdentityFromObservation(
    fstatSync(temporaryDescriptor, { bigint: true })
  );
  const publishingMarkerName = localTokenTransactionPublishingMarkerName(
    transactionId,
    digest,
    generationIdentity
  );
  const rollbackMarkerName = localTokenTransactionRollbackMarkerName(
    transactionId,
    digest,
    generationIdentity
  );

  let temporaryExists = true;
  let markerControl: OwnedLocalTokenControlArtifact | undefined;
  let leaseExists = true;
  let published = false;
  activeLocalTokenTransactionIds.add(transactionId);
  try {
    fchmodSync(temporaryDescriptor, 0o600);
    writeAllDescriptorBytes(temporaryDescriptor, tokenBytes);
    invokeLocalTokenPublicationHookForTest(hookForTest, "after_write");
    fsyncSync(temporaryDescriptor);
    invokeLocalTokenPublicationHookForTest(hookForTest, "after_file_fsync");
    assertTokenFileStat(fstatSync(temporaryDescriptor, { bigint: true }));
    markerControl = createLocalTokenTransactionMarker(
      secretsDescriptor,
      publishingMarkerName
    );
    fsyncSync(secretsDescriptor);

    published = syscallRenameAtNoReplace(
      secretsDescriptor,
      temporaryName,
      secretsDescriptor,
      LOCAL_TOKEN_FILE
    ) === 0;
    if (published) {
      temporaryExists = false;
      invokeLocalTokenPublicationHookForTest(hookForTest, "after_publish");
    } else {
      invokeLocalTokenPublicationHookForTest(hookForTest, "before_temp_cleanup");
      retireObservedLocalTokenArtifact(
        secretsDescriptor,
        temporaryName,
        generationIdentity
      );
      temporaryExists = false;
    }

    invokeLocalTokenPublicationHookForTest(hookForTest, "before_directory_fsync");
    fsyncSync(secretsDescriptor);
    if (!published) {
      const racedToken = readExistingLocalTokenWithRetry(secretsDescriptor);
      if (racedToken === undefined) throw unsafeLocalTokenStorageError();
      cleanupLocalTokenTransactionControlArtifacts(
        secretsDescriptor,
        markerControl,
        lease.control,
        hookForTest
      );
      markerControl = undefined;
      leaseExists = false;
      return racedToken;
    }

    invokeLocalTokenPublicationHookForTest(hookForTest, "before_post_publish_binding");
    // A synchronous parent-displacement failure is still cleaned through the held
    // directory descriptor below. General POSIX has no reverse lookup from that
    // descriptor to a workspace path: if an uncooperative actor moves the parent
    // and this process is then killed, a later startup at the original path cannot
    // discover the old inode. The transaction guarantees crash recovery only while
    // the transaction directory remains reachable at its observed workspace path.
    assertWorkspaceTokenDirectoryBinding(
      workspaceRoot,
      workspaceDescriptor,
      secretsDescriptor
    );
    const publishedObservation = requireObservedLocalTokenArtifact(
      secretsDescriptor,
      LOCAL_TOKEN_FILE
    );
    if (
      publishedObservation.token !== token ||
      !sameLocalTokenPhysicalIdentity(publishedObservation.identity, generationIdentity)
    ) {
      throw unsafeLocalTokenStorageError();
    }
    cleanupLocalTokenTransactionControlArtifacts(
      secretsDescriptor,
      markerControl,
      lease.control,
      hookForTest
    );
    markerControl = undefined;
    leaseExists = false;
    return publishedObservation.token;
  } catch (error) {
    if (published && markerControl?.name === publishingMarkerName) {
      rollbackPublishedLocalTokenTransaction({
        secretsDescriptor,
        transactionId,
        digest,
        generationIdentity,
        publishingMarker: markerControl,
        rollbackMarkerName,
        leaseControl: lease.control,
        hookForTest
      });
      markerControl = undefined;
      leaseExists = false;
    }
    if (temporaryExists) {
      retireObservedLocalTokenArtifact(
        secretsDescriptor,
        temporaryName,
        generationIdentity
      );
      temporaryExists = false;
    }
    if (markerControl !== undefined) {
      unlinkOwnedLocalTokenControlArtifact(
        secretsDescriptor,
        markerControl,
        hookForTest
      );
      markerControl = undefined;
    }
    if (leaseExists) {
      unlinkOwnedLocalTokenControlArtifact(
        secretsDescriptor,
        lease.control,
        hookForTest
      );
      leaseExists = false;
    }
    fsyncSync(secretsDescriptor);
    throw error;
  } finally {
    try {
      closeSync(temporaryDescriptor);
    } catch {
      // The descriptor has no namespace authority after cleanup/rollback.
    }
    try {
      closeSync(leaseDescriptor);
    } catch {
      // The directory descriptor remains the kernel lease owner until provisioning exits.
    }
    activeLocalTokenTransactionIds.delete(transactionId);
  }
}

function invokeLocalTokenPublicationHookForTest(
  hook: LocalTokenPublicationStageHookForTest | undefined,
  stage: LocalTokenPublicationStageForTest,
  name?: string,
  details: Readonly<{
    entryCount?: number;
    maxNameBytes?: number;
    boundary?: LocalTokenDirectoryBoundaryForTest;
  }> = {}
): void {
  hook?.(Object.freeze({ stage, ...(name === undefined ? {} : { name }), ...details }));
}

function rollbackPublishedLocalTokenTransaction(input: {
  secretsDescriptor: number;
  transactionId: string;
  digest: string;
  generationIdentity: LocalTokenPhysicalIdentity;
  publishingMarker: OwnedLocalTokenControlArtifact;
  rollbackMarkerName: string;
  leaseControl: OwnedLocalTokenControlArtifact;
  hookForTest?: LocalTokenPublicationStageHookForTest;
}): void {
  const {
    secretsDescriptor,
    transactionId,
    digest,
    generationIdentity,
    publishingMarker,
    rollbackMarkerName,
    leaseControl,
    hookForTest
  } = input;
  const candidateName = localTokenTransactionCandidateName(transactionId);
  assertOwnedLocalTokenControlArtifactCurrent(
    secretsDescriptor,
    publishingMarker
  );

  // Arm durable recovery before moving the canonical name. If this process dies
  // after the following fsync, startup can distinguish and finish own-generation
  // deletion or foreign-generation restoration from the identity-bearing marker.
  if (syscallRenameAtNoReplace(
    secretsDescriptor,
    publishingMarker.name,
    secretsDescriptor,
    rollbackMarkerName
  ) !== 0) {
    throw unsafeLocalTokenStorageError();
  }
  fsyncSync(secretsDescriptor);
  const rollbackMarker = validateLocalTokenTransactionControlArtifact(
    secretsDescriptor,
    rollbackMarkerName
  );
  if (!sameLocalTokenPhysicalIdentity(
    rollbackMarker.identity,
    publishingMarker.identity
  )) {
    throw unsafeLocalTokenStorageError();
  }
  invokeLocalTokenPublicationHookForTest(hookForTest, "after_rollback_armed");

  if (syscallRenameAtNoReplace(
    secretsDescriptor,
    LOCAL_TOKEN_FILE,
    secretsDescriptor,
    candidateName
  ) !== 0) {
    const canonical = readObservedLocalTokenArtifact(secretsDescriptor, LOCAL_TOKEN_FILE);
    if (
      canonical === undefined ||
      sameLocalTokenPhysicalIdentity(canonical.identity, generationIdentity)
    ) {
      // Absence cannot be distinguished from an unsafe/unopenable binding after a
      // failed rename, so retain the durable marker for fail-closed recovery.
      throw unsafeLocalTokenStorageError();
    }
    cleanupLocalTokenTransactionControlArtifacts(
      secretsDescriptor,
      rollbackMarker,
      leaseControl,
      hookForTest
    );
    return;
  }
  fsyncSync(secretsDescriptor);
  invokeLocalTokenPublicationHookForTest(hookForTest, "after_rollback_move");

  const candidate = requireObservedLocalTokenArtifact(secretsDescriptor, candidateName);
  if (sameLocalTokenPhysicalIdentity(candidate.identity, generationIdentity)) {
    if (candidate.digest !== digest) throw unsafeLocalTokenStorageError();
    invokeLocalTokenPublicationHookForTest(hookForTest, "before_rollback_candidate_cleanup");
    retireObservedLocalTokenArtifact(
      secretsDescriptor,
      candidateName,
      generationIdentity
    );
  } else {
    invokeLocalTokenPublicationHookForTest(hookForTest, "before_rollback_restore");
    if (syscallRenameAtNoReplace(
      secretsDescriptor,
      candidateName,
      secretsDescriptor,
      LOCAL_TOKEN_FILE
    ) !== 0) {
      // Never silently strand or delete a foreign generation. The durable rollback
      // marker remains for startup adjudication; an uncooperative writer that also
      // installs a second canonical generation is outside the serializable protocol.
      throw unsafeLocalTokenStorageError();
    }
    fsyncSync(secretsDescriptor);
    const restored = requireObservedLocalTokenArtifact(
      secretsDescriptor,
      LOCAL_TOKEN_FILE
    );
    if (!sameLocalTokenPhysicalIdentity(restored.identity, candidate.identity)) {
      throw unsafeLocalTokenStorageError();
    }
    invokeLocalTokenPublicationHookForTest(hookForTest, "after_rollback_restore");
  }
  cleanupLocalTokenTransactionControlArtifacts(
    secretsDescriptor,
    rollbackMarker,
    leaseControl,
    hookForTest
  );
}

function createLocalTokenTransactionMarker(
  secretsDescriptor: number,
  markerName: string
): OwnedLocalTokenControlArtifact {
  const markerDescriptor = syscallOpenAt(
    secretsDescriptor,
    markerName,
    LOCAL_TOKEN_CREATE_OPEN_FLAGS,
    0o600
  );
  if (markerDescriptor < 0) throw unsafeLocalTokenStorageError();
  let markerControl: OwnedLocalTokenControlArtifact | undefined;
  let valid = false;
  try {
    markerControl = ownedLocalTokenControlArtifact(
      markerName,
      physicalIdentityFromObservation(fstatSync(markerDescriptor, { bigint: true }))
    );
    fchmodSync(markerDescriptor, 0o600);
    assertLocalTokenTransactionControlFile(markerDescriptor);
    fsyncSync(markerDescriptor);
    valid = true;
    return markerControl;
  } finally {
    closeSync(markerDescriptor);
    if (!valid && markerControl !== undefined) {
      unlinkOwnedLocalTokenControlArtifact(secretsDescriptor, markerControl);
    }
  }
}

function createLocalTokenTransactionLeaseFile(
  secretsDescriptor: number,
  leaseName: string
): CreatedLocalTokenLease {
  const descriptor = syscallOpenAt(
    secretsDescriptor,
    leaseName,
    LOCAL_TOKEN_LEASE_CREATE_FLAGS,
    0o600
  );
  if (descriptor < 0) throw unsafeLocalTokenStorageError();
  let leaseControl: OwnedLocalTokenControlArtifact | undefined;
  let valid = false;
  try {
    leaseControl = ownedLocalTokenControlArtifact(
      leaseName,
      physicalIdentityFromObservation(fstatSync(descriptor, { bigint: true }))
    );
    fchmodSync(descriptor, 0o600);
    assertLocalTokenTransactionControlFile(descriptor);
    valid = true;
    return Object.freeze({ descriptor, control: leaseControl });
  } finally {
    if (!valid) {
      closeSync(descriptor);
      if (leaseControl !== undefined) {
        unlinkOwnedLocalTokenControlArtifact(secretsDescriptor, leaseControl);
      }
    }
  }
}

function acquireLocalTokenPublicationLease(secretsDescriptor: number): string {
  const observation = fstatSync(secretsDescriptor, { bigint: true });
  const leaseKey = `${observation.dev}:${observation.ino}`;
  const existingDepth = localTokenPublicationLeaseDepthByDirectory.get(leaseKey);
  if (existingDepth !== undefined) {
    localTokenPublicationLeaseDepthByDirectory.set(leaseKey, existingDepth + 1);
    return leaseKey;
  }

  const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const deadline = Date.now() + LOCAL_TOKEN_PUBLICATION_LEASE_WAIT_MS;
  do {
    if (syscallFlock(
      secretsDescriptor,
      LOCAL_TOKEN_FLOCK_EXCLUSIVE | LOCAL_TOKEN_FLOCK_NONBLOCKING
    ) === 0) {
      localTokenPublicationLeaseDepthByDirectory.set(leaseKey, 1);
      return leaseKey;
    }
    Atomics.wait(waitCell, 0, 0, 1);
  } while (Date.now() < deadline);

  // The directory descriptor is the cross-process publisher-instance lease. flock
  // is released by the kernel at process exit on macOS and Linux; repeated refusal
  // means either a truly active publisher or an unsupported/erroring filesystem,
  // both of which fail closed without touching transaction artifacts.
  throw unsafeLocalTokenStorageError();
}

function releaseLocalTokenPublicationLease(leaseKey: string | undefined): void {
  if (leaseKey === undefined) return;
  const depth = localTokenPublicationLeaseDepthByDirectory.get(leaseKey);
  if (depth === undefined) return;
  if (depth === 1) {
    localTokenPublicationLeaseDepthByDirectory.delete(leaseKey);
  } else {
    localTokenPublicationLeaseDepthByDirectory.set(leaseKey, depth - 1);
  }
}

function cleanupLocalTokenTransactionControlArtifacts(
  secretsDescriptor: number,
  marker: OwnedLocalTokenControlArtifact | undefined,
  lease: OwnedLocalTokenControlArtifact,
  hookForTest?: LocalTokenPublicationStageHookForTest
): void {
  if (marker !== undefined) {
    unlinkOwnedLocalTokenControlArtifact(
      secretsDescriptor,
      marker,
      hookForTest
    );
  }
  unlinkOwnedLocalTokenControlArtifact(
    secretsDescriptor,
    lease,
    hookForTest
  );
  fsyncSync(secretsDescriptor);
}

function localTokenTransactionLeaseName(transactionId: string): string {
  return `.local-token-transaction-${transactionId}.lease`;
}

function localTokenTransactionStagedName(transactionId: string): string {
  return `.local-token-transaction-${transactionId}.staged`;
}

function localTokenTransactionCandidateName(transactionId: string): string {
  return `.local-token-transaction-${transactionId}.candidate`;
}

function localTokenTransactionPublishingMarkerName(
  transactionId: string,
  digest: string,
  generationIdentity: LocalTokenPhysicalIdentity
): string {
  return `.local-token-transaction-${transactionId}-${digest}-${localTokenPhysicalIdentityName(generationIdentity)}.publishing`;
}

function localTokenTransactionRollbackMarkerName(
  transactionId: string,
  digest: string,
  generationIdentity: LocalTokenPhysicalIdentity
): string {
  return `.local-token-transaction-${transactionId}-${digest}-${localTokenPhysicalIdentityName(generationIdentity)}.rolling-back`;
}

function readExistingLocalTokenWithRetry(secretsDescriptor: number): string | undefined {
  const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const token = readExistingLocalToken(secretsDescriptor);
      if (token !== undefined) return token;
    } catch (error) {
      if (attempt === 49) throw error;
    }
    Atomics.wait(waitCell, 0, 0, 1);
  }
  return undefined;
}

function readAndValidateLocalTokenDescriptor(
  descriptor: number,
  secretsDescriptor: number,
  boundName = LOCAL_TOKEN_FILE
): LocalTokenDescriptorRead {
  const before = fstatSync(descriptor, { bigint: true });
  assertTokenFileStat(before);
  const expectedBytes = Number(before.size);
  const bytes = Buffer.alloc(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const bytesRead = readSync(descriptor, bytes, offset, expectedBytes - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const overflowProbe = Buffer.alloc(1);
  const overflowBytes = readSync(descriptor, overflowProbe, 0, 1, offset);
  const after = fstatSync(descriptor, { bigint: true });
  if (
    offset !== expectedBytes ||
    overflowBytes !== 0 ||
    !sameTokenFileObservation(before, after)
  ) {
    throw unsafeLocalTokenStorageError();
  }

  const reboundDescriptor = syscallOpenAt(
    secretsDescriptor,
    boundName,
    LOCAL_TOKEN_READ_OPEN_FLAGS
  );
  if (reboundDescriptor < 0) throw unsafeLocalTokenStorageError();
  try {
    if (!sameTokenFileObservation(after, fstatSync(reboundDescriptor, { bigint: true }))) {
      throw unsafeLocalTokenStorageError();
    }
  } finally {
    closeSync(reboundDescriptor);
  }

  let token: string;
  try {
    token = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidLocalTokenError();
  }
  if (!isValidLocalAuthToken(token)) throw invalidLocalTokenError();
  return Object.freeze({ token, observation: after });
}

function assertTokenFileStat(entry: BigIntStats): void {
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.nlink !== 1n ||
    (entry.mode & PRIVATE_MODE_MASK) !== PRIVATE_TOKEN_MODE ||
    entry.size <= 0n ||
    entry.size > BigInt(LOCAL_TOKEN_MAX_BYTES)
  ) {
    throw unsafeLocalTokenStorageError();
  }
}

function assertDirectoryDescriptorMode(descriptor: number, expectedMode: bigint): void {
  const entry = fstatSync(descriptor, { bigint: true });
  if (!entry.isDirectory() || (entry.mode & PRIVATE_MODE_MASK) !== expectedMode) {
    throw unsafeLocalTokenStorageError();
  }
}

function assertWorkspaceTokenDirectoryBinding(
  workspaceRoot: string,
  workspaceDescriptor: number,
  secretsDescriptor: number
): void {
  const reboundWorkspace = openExistingWorkspaceRootDescriptor(workspaceRoot);
  try {
    if (!sameFilesystemIdentity(
      fstatSync(workspaceDescriptor, { bigint: true }),
      fstatSync(reboundWorkspace, { bigint: true })
    )) {
      throw unsafeLocalTokenStorageError();
    }
  } finally {
    closeSync(reboundWorkspace);
  }

  const reboundSecrets = syscallOpenAt(
    workspaceDescriptor,
    LOCAL_TOKEN_DIRECTORY,
    LOCAL_TOKEN_DIRECTORY_OPEN_FLAGS
  );
  if (reboundSecrets < 0) throw unsafeLocalTokenStorageError();
  try {
    const reboundStat = fstatSync(reboundSecrets, { bigint: true });
    assertDirectoryDescriptorMode(reboundSecrets, PRIVATE_TOKEN_DIRECTORY_MODE);
    if (!sameFilesystemIdentity(fstatSync(secretsDescriptor, { bigint: true }), reboundStat)) {
      throw unsafeLocalTokenStorageError();
    }
  } finally {
    closeSync(reboundSecrets);
  }
}

function secureExistingWorkspaceTokenDirectory(workspaceRoot: string): void {
  let workspaceDescriptor: number | undefined;
  let secretsDescriptor: number | undefined;
  try {
    const resolvedWorkspaceRoot = resolve(workspaceRoot);
    workspaceDescriptor = openExistingWorkspaceRootDescriptor(resolvedWorkspaceRoot);
    secretsDescriptor = syscallOpenAt(
      workspaceDescriptor,
      LOCAL_TOKEN_DIRECTORY,
      LOCAL_TOKEN_DIRECTORY_OPEN_FLAGS
    );
    if (secretsDescriptor < 0) throw unsafeLocalTokenStorageError();
    fchmodSync(secretsDescriptor, 0o700);
    assertDirectoryDescriptorMode(secretsDescriptor, PRIVATE_TOKEN_DIRECTORY_MODE);
    assertWorkspaceTokenDirectoryBinding(
      resolvedWorkspaceRoot,
      workspaceDescriptor,
      secretsDescriptor
    );
  } catch {
    throw unsafeLocalTokenStorageError();
  } finally {
    closeDescriptorIfOwned(secretsDescriptor);
    closeDescriptorIfOwned(workspaceDescriptor);
  }
}

function sameTokenFileObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFilesystemIdentity(left, right) &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function sameFilesystemIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function writeAllDescriptorBytes(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const bytesWritten = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (bytesWritten <= 0) throw unsafeLocalTokenStorageError();
    offset += bytesWritten;
  }
}

function closeDescriptorIfOwned(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // A close failure cannot recover storage authority and is fail-closed above.
  }
}

interface LocalTokenFilesystemSyscalls {
  openAt(parentDescriptor: number, path: Buffer, flags: number, mode?: number): number;
  flock(descriptor: number, operation: number): number;
  mkdirAt(parentDescriptor: number, path: Buffer, mode: number): number;
  renameAtNoReplace(
    oldParentDescriptor: number,
    oldPath: Buffer,
    newParentDescriptor: number,
    newPath: Buffer
  ): number;
  unlinkAt(parentDescriptor: number, path: Buffer, flags: number): number;
  openDirectoryStream(descriptor: number): Pointer | null;
  readDirectoryEntry(stream: Pointer): Pointer | null;
  closeDirectoryStream(stream: Pointer): number;
  errnoPointer(): Pointer;
  clearErrno(pointer: Pointer): void;
}

let localTokenFilesystemSyscalls: LocalTokenFilesystemSyscalls | undefined;

function getLocalTokenFilesystemSyscalls(): LocalTokenFilesystemSyscalls {
  if (localTokenFilesystemSyscalls) return localTokenFilesystemSyscalls;
  const baseSymbols = {
    openat: { args: ["i32", "cstring", "i32", "i32"], returns: "i32" },
    flock: { args: ["i32", "i32"], returns: "i32" },
    mkdirat: { args: ["i32", "cstring", "i32"], returns: "i32" },
    unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
    fdopendir: { args: ["i32"], returns: "ptr" },
    readdir: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    memset: { args: ["ptr", "i32", "u64"], returns: "ptr" }
  } as const;
  if (process.platform === "darwin") {
    const symbols = {
      ...baseSymbols,
      renameatx_np: {
        args: ["i32", "cstring", "i32", "cstring", "u32"],
        returns: "i32"
      },
      __error: { args: [], returns: "ptr" }
    } as const;
    const library = dlopen("/usr/lib/libSystem.B.dylib", symbols);
    localTokenFilesystemSyscalls = {
      openAt: library.symbols.openat,
      flock: library.symbols.flock,
      mkdirAt: library.symbols.mkdirat,
      renameAtNoReplace: (oldParentDescriptor, oldPath, newParentDescriptor, newPath) =>
        library.symbols.renameatx_np(
          oldParentDescriptor,
          oldPath,
          newParentDescriptor,
          newPath,
          0x00000004
        ),
      unlinkAt: library.symbols.unlinkat,
      openDirectoryStream: library.symbols.fdopendir,
      readDirectoryEntry: library.symbols.readdir,
      closeDirectoryStream: library.symbols.closedir,
      errnoPointer: () => requiredLocalTokenPointer(library.symbols.__error()),
      clearErrno: (pointer) => {
        library.symbols.memset(pointer, 0, 4);
      }
    };
    return localTokenFilesystemSyscalls;
  }
  if (process.platform === "linux") {
    const symbols = {
      ...baseSymbols,
      renameat2: {
        args: ["i32", "cstring", "i32", "cstring", "u32"],
        returns: "i32"
      },
      __errno_location: { args: [], returns: "ptr" }
    } as const;
    const library = dlopen("libc.so.6", symbols);
    localTokenFilesystemSyscalls = {
      openAt: library.symbols.openat,
      flock: library.symbols.flock,
      mkdirAt: library.symbols.mkdirat,
      renameAtNoReplace: (oldParentDescriptor, oldPath, newParentDescriptor, newPath) =>
        library.symbols.renameat2(
          oldParentDescriptor,
          oldPath,
          newParentDescriptor,
          newPath,
          0x00000001
        ),
      unlinkAt: library.symbols.unlinkat,
      openDirectoryStream: library.symbols.fdopendir,
      readDirectoryEntry: library.symbols.readdir,
      closeDirectoryStream: library.symbols.closedir,
      errnoPointer: () => requiredLocalTokenPointer(library.symbols.__errno_location()),
      clearErrno: (pointer) => {
        library.symbols.memset(pointer, 0, 4);
      }
    };
    return localTokenFilesystemSyscalls;
  }
  throw unsafeLocalTokenStorageError();
}

function requiredLocalTokenPointer(pointer: Pointer | null): Pointer {
  if (pointer === null) throw unsafeLocalTokenStorageError();
  return pointer;
}

function syscallFlock(descriptor: number, operation: number): number {
  return getLocalTokenFilesystemSyscalls().flock(descriptor, operation);
}

function syscallOpenAt(parentDescriptor: number, path: string, flags: number, mode = 0): number {
  return getLocalTokenFilesystemSyscalls().openAt(
    parentDescriptor,
    cString(path),
    flags,
    mode
  );
}

function syscallMkdirAt(parentDescriptor: number, path: string, mode: number): number {
  return getLocalTokenFilesystemSyscalls().mkdirAt(parentDescriptor, cString(path), mode);
}

function syscallRenameAtNoReplace(
  oldParentDescriptor: number,
  oldPath: string,
  newParentDescriptor: number,
  newPath: string
): number {
  return getLocalTokenFilesystemSyscalls().renameAtNoReplace(
    oldParentDescriptor,
    cString(oldPath),
    newParentDescriptor,
    cString(newPath)
  );
}

function syscallUnlinkAt(parentDescriptor: number, path: string): number {
  return getLocalTokenFilesystemSyscalls().unlinkAt(parentDescriptor, cString(path), 0);
}

function cString(value: string): Buffer {
  if (value.includes("\u0000")) throw unsafeLocalTokenStorageError();
  return Buffer.from(`${value}\u0000`, "utf8");
}

function invalidLocalTokenError(): Error {
  return new Error("Local API token is invalid.");
}

function unsafeLocalTokenStorageError(): Error {
  return new Error("Local API token storage is unsafe.");
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
    const primaryEntry = captureFailureFoldEntry("body", error);
    const compensations: FailureFoldEntry[] = [];
    let finalReleaseFailureSeen = false;
    let authority: CompletedTaskAuthorityClassification = { status: "absent" };
    try {
      authority = await classifyCompletedTaskAuthorityIfPresent(input);
    } catch (classificationError) {
      finalReleaseFailureSeen = failureEndsInFinalRelease(classificationError);
      compensations.push(capturePostSettlementFailure(classificationError));
    }
    if (authority.status !== "absent") {
      try {
        return await completedTaskCreateResultWithoutLocal(input, authority);
      } catch (settlementError) {
        finalReleaseFailureSeen ||= failureEndsInFinalRelease(settlementError);
        compensations.push(capturePostSettlementFailure(settlementError));
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
        compensations.push(
          captureFailureFoldEntry(
            finalReleaseFailureSeen ? "final_release" : "settlement",
            recoveryError
          )
        );
      }
    }
    if (compensations.length === 0) throw error;
    throw preservePrimaryFailure(
      primaryEntry,
      compensations,
      "Initial task publication and idempotency recovery both failed."
    );
  }

  try {
    const result = await completeOwnedIdempotentTaskCard(input, task);
    await input.taskService.releaseTaskPublicationForIdempotency(task);
    return result;
  } catch (error) {
    const primaryOccurrence = captureFailureFoldEntry("body", error);
    try {
      await input.taskService.releaseTaskPublicationForIdempotency(task);
    } catch (releaseError) {
      const releaseOccurrence = captureFailureFoldEntry(
        "final_release",
        releaseError
      );
      // Root C (V33-03): the fold is wrapper-aware so an unknown-authority
      // wrapper keeps its inner typed primary reachable end-to-end.
      throw preserveAuthorityAwarePrimaryFailure(
        primaryOccurrence,
        [releaseOccurrence],
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
        !isCompletedTaskSnapshotAuthorityUnknownError(error) ||
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
      return await reconcileLocalTaskAfterPreCompletionFailure(
        input,
        task,
        captureFailureFoldEntry("body", error)
      );
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
        captureFailureFoldEntry("body", error)
      );
    }

    if (completedRecord.status !== "completed" || !completedRecord.result_ref) {
      const ownedObservation = observation;
      observation = undefined;
      return await reconcileLocalTaskAfterCompletionFailure(
        input,
        task,
        ownedObservation,
        captureFailureFoldEntry("body", idempotencyResultBindingError())
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
  let bodyOutcome: FailureAsyncOutcome<T>;
  try {
    bodyOutcome = { status: "fulfilled", value: await body() };
  } catch (reason) {
    bodyOutcome = {
      status: "rejected",
      reason,
      occurrence: captureFailureFoldEntry("body", reason)
    };
  }

  let settlementOutcome: FailureAsyncOutcome<void> = { status: "not_attempted" };
  const observation = takeObservation();
  if (observation) {
    try {
      await taskService.cancelTaskSnapshotCleanupObservation(observation);
      settlementOutcome = { status: "fulfilled", value: undefined };
    } catch (error) {
      settlementOutcome = {
        status: "rejected",
        reason: error,
        occurrence: captureFailureFoldEntry(
          bodyOutcome.status === "rejected" ? "final_release" : "initial_release",
          error
        )
      };
    }
  }
  if (bodyOutcome.status === "rejected") {
    if (settlementOutcome.status === "rejected") {
      throw preserveAuthorityAwarePrimaryFailure(
        bodyOutcome.occurrence,
        [settlementOutcome.occurrence],
        aggregateMessage
      );
    }
    throw bodyOutcome.reason;
  }
  if (settlementOutcome.status === "rejected") {
    throw preserveTaskServiceErrorFailureEntries(
      settlementOutcome.occurrence,
      [],
      aggregateMessage
    );
  }
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
    const primaryOccurrence = captureFailureFoldEntry("body", error);
    const settlementOccurrence = captureFailureFoldEntry(
      "final_release",
      settlementError
    );
    error = preserveTaskServiceErrorFailureEntries(
      primaryOccurrence,
      [settlementOccurrence],
      "Task snapshot observation rejection and cancellation both failed."
    );
  }
  throw error;
}

async function reconcileLocalTaskAfterPreCompletionFailure(
  input: CreateIdempotentTaskCardInput,
  task: TaskCard,
  errorEntry: FailureFoldEntry
): Promise<IdempotentTaskCreateResult> {
  let authorityOutcome: FailureAsyncOutcome<CompletedTaskAuthorityClassification>;
  try {
    authorityOutcome = {
      status: "fulfilled",
      value: await classifyCompletedTaskAuthorityIfPresent(input)
    };
  } catch (reconciliationError) {
    authorityOutcome = {
      status: "rejected",
      reason: reconciliationError,
      occurrence: capturePostSettlementFailure(reconciliationError)
    };
  }

  if (authorityOutcome.status === "rejected") {
    throw preserveTaskServiceErrorFailureEntries(
      errorEntry,
      [authorityOutcome.occurrence],
      "Task creation failure and completed-authority reconciliation both failed."
    );
  }
  const recoveredAuthority = authorityOutcome.value;
  if (recoveredAuthority.status !== "absent") {
    try {
      return await settleLocalTaskAgainstCompletedAuthority(
        input,
        task,
        recoveredAuthority
      );
    } catch (settlementError) {
      throw preserveTaskServiceErrorFailureEntries(
        errorEntry,
        [capturePostSettlementFailure(settlementError)],
        "Task creation failure and recovered-authority settlement both failed."
      );
    }
  }

  const compensationEntries: FailureFoldEntry[] = [];
  try {
    await rollbackLocalTaskAfterAuthorityFailure(input, task);
  } catch (rollbackError) {
    compensationEntries.push(captureFailureFoldEntry("final_release", rollbackError));
  }
  try {
    await input.idempotencyService.recoverFailedRecordAfterRollback({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest
    });
  } catch (recoveryError) {
    compensationEntries.push(captureFailureFoldEntry("final_release", recoveryError));
  }
  throw preserveTaskServiceErrorFailureEntries(
    errorEntry,
    compensationEntries,
    "Task creation failure and pre-completion compensation both failed."
  );
}

async function reconcileLocalTaskAfterCompletionFailure(
  input: CreateIdempotentTaskCardInput,
  task: TaskCard,
  initialObservation: TaskSnapshotCleanupObservation,
  completionEntry: FailureFoldEntry
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
      const reconciliationEntry = capturePostSettlementFailure(reconciliationError);
      const cancellationEntries: FailureFoldEntry[] = [];
      if (local.observation) {
        const ownedObservation = local.observation;
        local.observation = undefined;
        try {
          await input.taskService.cancelTaskSnapshotCleanupObservation(ownedObservation);
        } catch (error) {
          cancellationEntries.push(captureFailureFoldEntry("final_release", error));
        }
      }
      throw preserveTaskServiceErrorFailureEntries(
        completionEntry,
        [reconciliationEntry, ...cancellationEntries],
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
        throw preserveTaskServiceErrorFailureEntries(
          completionEntry,
          [captureFailureFoldEntry("final_release", settlementError)],
          "Task completion failure and completed-authority settlement both failed."
        );
      }
    }

    const settlementEntries: FailureFoldEntry[] = [];
    if (local.observation) {
      const ownedObservation = local.observation;
      local.observation = undefined;
      try {
        await cleanupLocalTaskCompletionObservation(input, ownedObservation);
      } catch (error) {
        settlementEntries.push(captureFailureFoldEntry("final_release", error));
      }
    }
    try {
      await input.idempotencyService.recoverFailedRecordAfterRollback({
        scope: "task",
        key: input.idempotencyKey,
        requestDigest: input.requestDigest
      });
    } catch (error) {
      settlementEntries.push(
        captureFailureFoldEntry(
          settlementEntries.length === 0 ? "settlement" : "final_release",
          error
        )
      );
    }
    throw preserveTaskServiceErrorFailureEntries(
      completionEntry,
      settlementEntries,
      "Task completion failure and known-absent authority settlement failed."
    );
  } catch (bodyError) {
    const bodyEntry = captureFailureFoldEntry("body", bodyError);
    if (local.observation) {
      const ownedObservation = local.observation;
      local.observation = undefined;
      try {
        await input.taskService.cancelTaskSnapshotCleanupObservation(ownedObservation);
      } catch (cancellationError) {
        throw preserveTaskServiceErrorFailureEntries(
          bodyEntry,
          [captureFailureFoldEntry("final_release", cancellationError)],
          "Task completion reconciliation and final observation cancellation both failed."
        );
      }
    }
    throw preserveTaskServiceErrorFailureEntries(
      bodyEntry,
      [],
      "Task completion reconciliation failed."
    );
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
    const cleanupEntry = captureFailureFoldEntry("final_release", error);
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
        cleanupEntry,
        [captureFailureFoldEntry("final_release", quarantineError)],
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
  readonly authorityEntry: FailureFoldEntry;
  readonly classificationEntries: readonly FailureFoldEntry[];
  readonly observation?: TaskSnapshotCleanupObservation;
}

class CompletedTaskSnapshotAuthorityReadError extends Error {
  constructor() {
    super("Completed task snapshot durable authority could not be read.");
    this.name = "CompletedTaskSnapshotAuthorityReadError";
  }
}

type CompletedTaskSnapshotAuthorityUnknownError = Error;

function completedTaskSnapshotAuthorityUnknownError(
  authorityError: unknown
): CompletedTaskSnapshotAuthorityUnknownError {
  return taskServiceErrorAuthorityTransportFamily.create(authorityError);
}

function preserveCompletedTaskSnapshotAuthorityUnknownFailureEntries(
  primary: FailureFoldEntry,
  compensations: readonly FailureFoldEntry[],
  aggregateMessage: string
): unknown {
  return preserveTaskServiceErrorFailureEntries(primary, compensations, aggregateMessage);
}

function isCompletedTaskSnapshotAuthorityUnknownError(
  value: unknown
): value is CompletedTaskSnapshotAuthorityUnknownError {
  return taskServiceErrorAuthorityTransportFamily.has(value);
}

function completedTaskSnapshotAuthorityProjection(value: unknown): unknown {
  return taskServiceErrorAuthorityTransportFamily.project(value);
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
      throw completedTaskSnapshotAuthorityUnknownError(
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
      throw completedTaskSnapshotAuthorityUnknownError(error);
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
      const transport = completedTaskSnapshotAuthorityUnknownError(error);
      const primaryEntry = captureFailureFoldEntry("body", transport);
      const ownedObservation = observation;
      observation = undefined;
      // Root D (V32-03): a throwing settlement must never replace the typed
      // classification primary; fold it as an ordered compensation instead.
      try {
        await input.taskService.cancelTaskSnapshotCleanupObservation(ownedObservation);
      } catch (settlementError) {
        throw preserveCompletedTaskSnapshotAuthorityUnknownFailureEntries(
          primaryEntry,
          [captureFailureFoldEntry("final_release", settlementError)],
          "Completed task authority classification and observation cancellation both failed."
        );
      }
      throw transport;
    }
    if (observation.status === "repairable") {
      const error = observation.error;
      const primaryEntry = captureFailureFoldEntry("body", error);
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
              primaryEntry,
              [captureFailureFoldEntry("final_release", settlementError)],
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
      const authorityError = invalidDurableTaskAuthorityError();
      const authorityEntry = captureFailureFoldEntry("body", authorityError);
      const rejectedObservation = observation;
      observation = undefined;
      return {
        status: "rejected",
        reason: {
          resultRef,
          authorityError,
          authorityEntry,
          classificationEntries: [captureFailureFoldEntry("settlement", classificationError)],
          observation: rejectedObservation
        }
      };
    }
    if (taskCreateRequestDigestFromTask(observation.task) !== input.requestDigest) {
      const classificationError = idempotencyResultBindingError();
      const authorityError = invalidDurableTaskAuthorityError();
      const authorityEntry = captureFailureFoldEntry("body", authorityError);
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
        const taskServiceError = taskServiceErrorAtBoundary(error);
        const transport = completedTaskSnapshotAuthorityUnknownError(
          taskServiceError ?? classificationError
        );
        throw preserveCompletedTaskSnapshotAuthorityUnknownFailureEntries(
          captureFailureFoldEntry("body", transport),
          [
            captureFailureFoldEntry(
              taskServiceError ? "settlement" : "final_release",
              taskServiceError ? classificationError : error
            )
          ],
          "Completed task authority classification and observation acceptance both failed."
        );
      }
      return {
        status: "rejected",
        reason: {
          resultRef,
          authorityError,
          authorityEntry,
          classificationEntries: [captureFailureFoldEntry("settlement", classificationError)]
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
      throw completedTaskSnapshotAuthorityUnknownError(error);
    }
  } catch (error) {
    const taskServiceError = taskServiceErrorAtBoundary(error);
    const transport = completedTaskSnapshotAuthorityUnknownError(error);
    const primaryEntry = captureFailureFoldEntry("body", transport);
    if (
      isSafeTaskId(resultRef) &&
      taskServiceError?.code === "task_snapshot_missing_card"
    ) {
      return {
        status: "accepted",
        value: { status: "repairable", error: taskServiceError, resultRef }
      };
    }
    if (observation) {
      const ownedObservation = observation;
      observation = undefined;
      try {
        await input.taskService.cancelTaskSnapshotCleanupObservation(ownedObservation);
      } catch (settlementError) {
        throw preserveCompletedTaskSnapshotAuthorityUnknownFailureEntries(
          primaryEntry,
          [captureFailureFoldEntry("final_release", settlementError)],
          "Completed task authority observation and cancellation both failed."
        );
      }
    }
    if (
      isCompletedTaskSnapshotAuthorityUnknownError(error) ||
      isCompletedTaskSnapshotAuthorityUnknownError(semanticPrimaryValue(error))
    ) {
      throw error;
    }
    throw completedTaskSnapshotAuthorityUnknownError(error);
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
  const settlementErrors: FailureFoldEntry[] = [];
  if (rejection.observation) {
    try {
      if (recovery.durablyFailed) {
        await input.taskService.cleanupTaskSnapshotObservation(rejection.observation);
      } else {
        await input.taskService.cancelTaskSnapshotCleanupObservation(rejection.observation);
      }
    } catch (settlementError) {
      settlementErrors.push(captureFailureFoldEntry("final_release", settlementError));
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
        settlementErrors.push(captureFailureFoldEntry("final_release", quarantineError));
      }
    }
  }
  return {
    status: "invalid",
    reason: "invalid_durable_task_authority",
    error: preservePrimaryFailure(
      rejection.authorityEntry,
      [...rejection.classificationEntries, ...recovery.entries, ...settlementErrors],
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
    const authorityEntry = captureFailureFoldEntry("body", authority.error);
    try {
      await input.idempotencyService.cancelCompletedRecordMutationAuthority(
        authority.mutationAuthority
      );
    } catch (cancellationError) {
      throw preservePrimaryFailure(
        authorityEntry,
        [captureFailureFoldEntry("final_release", cancellationError)],
        "Repairable completed authority and mutation-authority cancellation both failed."
      );
    }
    throw authority.error;
  }

  if (authority.durablyFailed) {
    const authorityEntry = captureFailureFoldEntry("body", authority.error);
    try {
      await input.idempotencyService.recoverFailedRecordAfterRollback({
        scope: "task",
        key: input.idempotencyKey,
        requestDigest: input.requestDigest
      });
    } catch (recoveryError) {
      throw preservePrimaryFailure(
        authorityEntry,
        [capturePostSettlementFailure(recoveryError)],
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
    const authorityEntry = authority.status === "repairable"
      ? captureFailureFoldEntry("body", authority.error)
      : undefined;
    try {
      await input.idempotencyService.cancelCompletedRecordMutationAuthority(
        authority.mutationAuthority
      );
    } catch (cancellationError) {
      if (authority.status === "repairable") {
        throw preservePrimaryFailure(
          authorityEntry!,
          [captureFailureFoldEntry("final_release", cancellationError)],
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

  const authorityEntry = captureFailureFoldEntry("body", authority.error);
  try {
    await input.idempotencyService.recoverFailedRecordAfterRollback({
      scope: "task",
      key: input.idempotencyKey,
      requestDigest: input.requestDigest
    });
  } catch (recoveryError) {
    throw preservePrimaryFailure(
      authorityEntry,
      [captureFailureFoldEntry("final_release", recoveryError)],
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
    const rollbackEntry = captureFailureFoldEntry("final_release", rollbackError);
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
        rollbackEntry,
        [captureFailureFoldEntry("final_release", quarantineError)],
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
  const errorEntry = captureFailureFoldEntry("body", error);
  const recovery = await invalidateCompletedTaskAuthorityWithRecovery(
    input,
    authority.observedResultRef,
    authority.mutationAuthority
  );
  if (recovery.entries.length === 0) throw error;
  throw preservePrimaryFailure(
    errorEntry,
    recovery.entries,
    "Invalid completed task authority and durable recovery failed."
  );
}

interface CompletedTaskAuthorityInvalidationOutcome {
  readonly durablyFailed: boolean;
  readonly entries: FailureFoldEntry[];
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
    return { durablyFailed: failed.status === "failed", entries: [] };
  } catch (invalidationError) {
    let finalReleaseFailureSeen = failureEndsInFinalRelease(invalidationError);
    const entries: FailureFoldEntry[] = [
      capturePostSettlementFailure(invalidationError)
    ];
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
      return { durablyFailed: failed.status === "failed", entries };
    } catch (quarantineError) {
      finalReleaseFailureSeen ||= failureEndsInFinalRelease(quarantineError);
      entries.push(captureFailureFoldEntry(
        finalReleaseFailureSeen ? "final_release" : "settlement",
        quarantineError
      ));
    }
    if (mutationAuthority !== undefined) {
      try {
        await input.idempotencyService.cancelCompletedRecordMutationAuthority(
          mutationAuthority
        );
      } catch (settlementError) {
        if (!isCompletedMutationAuthorityAlreadySettledError(settlementError)) {
          entries.push(captureFailureFoldEntry("final_release", settlementError));
        }
      }
    }
    return { durablyFailed: false, entries };
  }
}

function isCompletedMutationAuthorityAlreadySettledError(error: unknown): boolean {
  return error instanceof TypeError &&
    error.message ===
      "Completed idempotency mutation authority is not owned by this service or is already settled.";
}

function preservePrimaryFailure(
  primary: FailureFoldEntry,
  compensations: readonly FailureFoldEntry[],
  aggregateMessage: string
): unknown {
  return preserveTaskServiceErrorFailureEntries(
    primary,
    compensations,
    aggregateMessage
  );
}

function capturePostSettlementFailure(error: unknown): FailureFoldEntry {
  return captureFailureFoldEntry(
    failureTerminalPhysicalPhase(error) === "final_release"
      ? "final_release"
      : "settlement",
    error
  );
}

function failureEndsInFinalRelease(error: unknown): boolean {
  return failureTerminalPhysicalPhase(error) === "final_release";
}

/**
 * Root C (V33-03): fold sites whose caught primary may be a
 * CompletedTaskSnapshotAuthorityUnknownError preserve the INNER typed primary
 * with the compensations retained as an ordered vector, re-wrapping so
 * jsonTaskServiceError's existing one-level unwrap still renders the typed
 * envelope instead of a generic 500.
 */
function preserveAuthorityAwarePrimaryFailure(
  primary: FailureFoldEntry,
  compensations: readonly FailureFoldEntry[],
  aggregateMessage: string
): unknown {
  return preserveTaskServiceErrorFailureEntries(
    primary,
    compensations,
    aggregateMessage
  );
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
    const taskServiceError = taskServiceErrorAtBoundary(error);
    if (taskServiceError) {
      if (taskServiceError.code === "task_snapshot_missing_card") {
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
  const taskServiceError = taskServiceErrorAtBoundary(error);
  if (taskServiceError) {
    return jsonApiError(
      c,
      {
        category: taskServiceError.category,
        severity: "error",
        message: taskServiceError.message,
        userMessage: taskServiceError.userMessage,
        evidenceRefs: taskServiceError.evidenceRefs,
        retryable: taskServiceError.retryable,
        recommendedNextActions: taskServiceError.recommendedNextActions
      },
      taskServiceError.status
    );
  }
  const semanticPrimary = semanticPrimaryValue(error);
  if (!Object.is(semanticPrimary, error)) {
    return jsonTaskServiceError(c, semanticPrimary);
  }
  if (isCompletedTaskSnapshotAuthorityUnknownError(error)) {
    return jsonTaskServiceError(c, completedTaskSnapshotAuthorityProjection(error));
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
  options: BackendApiOptions = {},
  localAuthAuthority?: LocalAuthAuthority
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
      if (localAuthAuthority?.kind === "file") {
        if (!localAuthAuthorityIsCurrent(localAuthAuthority)) {
          throw unsafeLocalTokenStorageError();
        }
      } else {
        secureExistingWorkspaceTokenDirectory(workspaceRoot);
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
      if (
        localAuthAuthority?.kind === "file" &&
        !localAuthAuthorityIsCurrent(localAuthAuthority) &&
        !missingDirectories.includes(LOCAL_TOKEN_DIRECTORY)
      ) {
        missingDirectories.push(LOCAL_TOKEN_DIRECTORY);
      }
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
  const path = join(workspaceRoot, relativeDir);
  if (!(await isSafeExistingDirectoryPath(path))) {
    return false;
  }
  if (relativeDir !== LOCAL_TOKEN_DIRECTORY) {
    return true;
  }
  const entry = await maybeLstat(path);
  return Boolean(
    entry?.isDirectory() &&
    !entry.isSymbolicLink() &&
    (Number(entry.mode) & Number(PRIVATE_MODE_MASK)) === Number(PRIVATE_TOKEN_DIRECTORY_MODE)
  );
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

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import {
  CreateTaskInputSchema,
  TaskServiceError,
  createTaskCardService,
  isSafeTaskId
} from "@shud-harness/core";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError } from "zod";

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
    taskIdFactory: options.taskIdFactory
  });

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
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
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

    try {
      return c.json(await taskService.createTask(parsedBody.data), 201);
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
    if (pathname.startsWith("/api/")) {
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

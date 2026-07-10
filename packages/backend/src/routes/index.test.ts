import { afterEach, describe, expect, test } from "bun:test";
import { execFile as execFileWithCallback } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  access,
  readdir,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  DEFAULT_TASK_CREATED_BY,
  MAX_TASK_SNAPSHOT_BYTES,
  TaskServiceError,
  canonicalJson,
  createIdempotencyRecordService,
  createTaskCardService,
  idempotencyRecordEvidenceRef,
  idempotencyRecordFileName,
  sha256Hex,
  type CreateTaskInput,
  type TaskCard,
  type TaskSnapshot
} from "@shud-harness/core";
import { createBackendApi, type ApiErrorResponse, type WorkspaceReadyResponse } from "./index";
import {
  API_REQUEST_ID_HEADER,
  redactApiLogValue,
  type ApiRequestLogLine
} from "../middleware";

const tempRoots: string[] = [];
const originalCwd = process.cwd();
const originalHarnessWorkspaceDir = process.env.HARNESS_WORKSPACE_DIR;
const originalLegacyWorkspaceRoot = process.env.SHUD_HARNESS_WORKSPACE_ROOT;
const TASK_HYDRATION_ENTRY_LIMIT = 1024;
const IN_FLIGHT_TASK_CREATE_LIMIT = 1024;
const execFile = promisify(execFileWithCallback);

const EXPECTED_M1_RUNTIME_DIRECTORIES = [
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

describe("backend workspace and health routes", () => {
  afterEach(async () => {
    process.chdir(originalCwd);
    restoreEnv("HARNESS_WORKSPACE_DIR", originalHarnessWorkspaceDir);
    restoreEnv("SHUD_HARNESS_WORKSPACE_ROOT", originalLegacyWorkspaceRoot);

    await Promise.all(
      tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true, force: true }))
    );
  });

  test("POST /api/workspace/init creates the canonical M1 runtime directory tree", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({ workspaceRoot });

    await expectPathMissing(workspaceRoot);
    const response = await app.request("/api/workspace/init", { method: "POST" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      directory_count: EXPECTED_M1_RUNTIME_DIRECTORIES.length,
      directories: EXPECTED_M1_RUNTIME_DIRECTORIES
    });
    expect(body.directories).toContain("readiness");
    expect(body.directories).toContain("snapshots");

    for (const relativeDir of EXPECTED_M1_RUNTIME_DIRECTORIES) {
      expect((await stat(join(workspaceRoot, relativeDir))).isDirectory()).toBe(true);
    }

    const readyResponse = await app.request("/api/health/ready");
    const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;

    expect(readyResponse.status).toBe(200);
    expect(readyBody.status).toBe("ok");
    expect(readyBody.checks).toEqual({
      directory_tree: "ok",
      snapshot_readable: "ok",
      workspace_writable: "ok"
    });
  });

  test("POST /api/workspace/init creates an absent workspace root leaf when its parent is safe", async () => {
    const tempRoot = await createTempRoot("shud-harness-backend-routes-leaf-");
    tempRoots.push(tempRoot);
    const workspaceRoot = join(tempRoot, "workspace");
    const app = createBackendApi({ workspaceRoot });

    await expectPathMissing(workspaceRoot);
    const response = await app.request("/api/workspace/init", { method: "POST" });

    expect(response.status).toBe(200);
    expect((await stat(workspaceRoot)).isDirectory()).toBe(true);
    expect((await stat(join(workspaceRoot, "snapshots"))).isDirectory()).toBe(true);
    expect((await stat(join(workspaceRoot, "readiness"))).isDirectory()).toBe(true);
  });

  test("POST /api/workspace/init is idempotent and preserves existing files", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({ workspaceRoot });
    const sentinelPath = join(workspaceRoot, "readiness", "sentinel.txt");

    expect((await app.request("/api/workspace/init", { method: "POST" })).status).toBe(200);
    await writeFile(sentinelPath, "preserve me", { flag: "wx" });

    const response = await app.request("/api/workspace/init", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await readFile(sentinelPath, "utf8")).toBe("preserve me");
  });

  test("POST /api/workspace/init tolerates concurrent duplicate requests", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({ workspaceRoot });

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.request("/api/workspace/init", { method: "POST" })
      )
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    for (const relativeDir of EXPECTED_M1_RUNTIME_DIRECTORIES) {
      expect((await stat(join(workspaceRoot, relativeDir))).isDirectory()).toBe(true);
    }
  });

  test("GET /api/health/live returns OBS-HEALTH-001 fields without workspace readiness", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({
      workspaceRoot,
      version: "test-version",
      startTimeMs: Date.parse("2026-07-07T00:00:00.000Z"),
      now: () => new Date("2026-07-07T00:00:03.500Z")
    });

    const response = await app.request("/api/health/live");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      version: "test-version",
      uptime_seconds: 3.5,
      timestamp: "2026-07-07T00:00:03.500Z"
    });
  });

  test("API requests emit one OBS-LOG-001 NDJSON line with the response request id", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const logs: string[] = [];
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:02:00.000Z"),
      requestIdFactory: () => "REQ-log-success",
      requestLogSink: (line) => {
        logs.push(line);
      }
    });

    const response = await app.request("/api/health/live");

    expect(response.status).toBe(200);
    expect(response.headers.get(API_REQUEST_ID_HEADER)).toBe("REQ-log-success");
    await waitFor(() => logs.length === 1, "Success request log was not emitted");
    const log = parseApiRequestLogLine(logs[0] as string);
    expect(log).toMatchObject({
      ts: "2026-07-07T12:02:00.000Z",
      level: "info",
      service: "shud-harness-backend",
      event: "api.request.completed",
      request_id: "REQ-log-success",
      route: "/api/health/live",
      status: 200
    });
    expect(Number.isFinite(log.duration_ms)).toBe(true);
    expect(log.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("HEAD API requests use their GET-backed route patterns in request logs", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const requestIds = ["REQ-log-head-live", "REQ-log-head-ready"];
    const logs: string[] = [];
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:02:00.500Z"),
      requestIdFactory: () => requestIds.shift() ?? "REQ-log-head-extra",
      requestLogSink: (line) => {
        logs.push(line);
      }
    });

    const liveResponse = await app.request("/api/health/live", { method: "HEAD" });
    const readyResponse = await app.request("/api/health/ready", { method: "HEAD" });

    expect(liveResponse.status).toBe(200);
    expect(liveResponse.headers.get(API_REQUEST_ID_HEADER)).toBe("REQ-log-head-live");
    expect(readyResponse.status).toBe(503);
    expect(readyResponse.headers.get(API_REQUEST_ID_HEADER)).toBe("REQ-log-head-ready");
    await waitFor(() => logs.length === 2, "HEAD request logs were not emitted");
    const liveLog = parseApiRequestLogLine(logs[0] as string);
    expect(liveLog).toMatchObject({
      request_id: "REQ-log-head-live",
      route: "/api/health/live",
      status: 200,
      level: "info"
    });
    const readyLog = parseApiRequestLogLine(logs[1] as string);
    expect(readyLog).toMatchObject({
      request_id: "REQ-log-head-ready",
      route: "/api/health/ready",
      status: 503,
      level: "error"
    });
  });

  test("API error responses share a request id with the structured request log", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const logs: string[] = [];
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:02:01.000Z"),
      requestIdFactory: () => "REQ-log-error",
      requestLogSink: (line) => {
        logs.push(line);
      }
    });

    const response = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Missing required fields" })
    });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(400);
    expect(response.headers.get(API_REQUEST_ID_HEADER)).toBe("REQ-log-error");
    expectCanonicalError(body, "schema_error");
    await waitFor(() => logs.length === 1, "Error request log was not emitted");
    const log = parseApiRequestLogLine(logs[0] as string);
    expect(log.request_id).toBe("REQ-log-error");
    expect(log.level).toBe("warn");
    expect(log.route).toBe("/api/tasks");
    expect(log.status).toBe(400);
  });

  test("API request logs redact secret-like values and preserve secret refs", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const fakeSecret = "sk-test-secret-value";
    const logs: string[] = [];
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:02:02.000Z"),
      requestIdFactory: () => "REQ-log-secret",
      requestLogSink: (line) => {
        logs.push(line);
      }
    });

    const response = await app.request(`/api/tasks?api_key=${fakeSecret}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fakeSecret}`,
        "x-secret-ref": "env:GLM_API_KEY"
      },
      body: `{"title":"${fakeSecret}"`
    });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(400);
    expectCanonicalError(body, "schema_error");
    await waitFor(() => logs.length === 1, "Secret-redaction request log was not emitted");
    const serializedLog = logs[0] as string;
    const log = parseApiRequestLogLine(serializedLog);
    expect(log.route).toBe("/api/tasks");
    expect(serializedLog).not.toContain(fakeSecret);
    expect(serializedLog).not.toContain("authorization");
    expect(serializedLog).not.toContain("api_key");
    expect(redactApiLogValue(fakeSecret)).toBe("[REDACTED]");
    expect(redactApiLogValue("env:GLM_API_KEY")).toBe("env:GLM_API_KEY");
  });

  test("API request logging does not wait for delayed or failing sinks", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    let delayedSinkResolved = false;
    const delayedLogs: string[] = [];
    const delayedApp = createBackendApi({
      workspaceRoot,
      requestIdFactory: () => "REQ-log-delayed-sink",
      requestLogSink: async (line) => {
        delayedLogs.push(line);
        await new Promise((resolve) => setTimeout(resolve, 120));
        delayedSinkResolved = true;
      }
    });

    const response = await Promise.race([
      delayedApp.request("/api/health/live"),
      timeoutAfter(50, "API response waited for delayed request log sink")
    ]);

    expect(response.status).toBe(200);
    expect(response.headers.get(API_REQUEST_ID_HEADER)).toBe("REQ-log-delayed-sink");
    await waitFor(() => delayedLogs.length === 1, "Delayed sink did not receive a log line");
    expect(delayedSinkResolved).toBe(false);

    const rejectingLogs: string[] = [];
    const rejectingApp = createBackendApi({
      workspaceRoot,
      requestIdFactory: () => "REQ-log-rejecting-sink",
      requestLogSink: (line) => {
        rejectingLogs.push(line);
        return Promise.reject(new Error("sink unavailable"));
      }
    });

    const rejectingResponse = await rejectingApp.request("/api/health/live");

    expect(rejectingResponse.status).toBe(200);
    expect(rejectingResponse.headers.get(API_REQUEST_ID_HEADER)).toBe("REQ-log-rejecting-sink");
    await waitFor(() => rejectingLogs.length === 1, "Rejecting sink did not receive a log line");

    const throwingLogs: string[] = [];
    const throwingApp = createBackendApi({
      workspaceRoot,
      requestIdFactory: () => "REQ-log-throwing-sink",
      requestLogSink: (line) => {
        throwingLogs.push(line);
        throw new Error("sink threw synchronously");
      }
    });

    const throwingResponse = await throwingApp.request("/api/health/live");

    expect(throwingResponse.status).toBe(200);
    expect(throwingResponse.headers.get(API_REQUEST_ID_HEADER)).toBe("REQ-log-throwing-sink");
    await waitFor(() => throwingLogs.length === 1, "Throwing sink did not receive a log line");

    const synchronousLogs: string[] = [];
    let synchronousSinkFinished = false;
    const synchronousApp = createBackendApi({
      workspaceRoot,
      requestIdFactory: () => "REQ-log-sync-sink",
      requestLogSink: (line) => {
        synchronousLogs.push(line);
        busyWaitFor(120);
        synchronousSinkFinished = true;
      }
    });

    const synchronousResponse = await Promise.race([
      synchronousApp.request("/api/health/live"),
      timeoutAfter(50, "API response waited for synchronous request log sink work")
    ]);

    expect(synchronousResponse.status).toBe(200);
    expect(synchronousResponse.headers.get(API_REQUEST_ID_HEADER)).toBe("REQ-log-sync-sink");
    expect(synchronousLogs).toHaveLength(0);
    expect(synchronousSinkFinished).toBe(false);
    await waitFor(() => synchronousSinkFinished, "Synchronous sink did not run after response");
    expect(synchronousLogs).toHaveLength(1);
  });

  test("GET /api/health/ready is not_ready before init while live stays ok", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({ workspaceRoot });

    const readyResponse = await app.request("/api/health/ready");
    const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;
    const liveResponse = await app.request("/api/health/live");

    expect(readyResponse.status).toBe(503);
    expect(readyBody.status).toBe("not_ready");
    expect(readyBody.checks.directory_tree).toBe("fail");
    expect(readyBody.checks.snapshot_readable).toBe("fail");
    expect(readyBody.checks.workspace_writable).toBe("fail");
    expect(liveResponse.status).toBe(200);
  });

  test("GET /api/health/ready is ok after init with directory, snapshot, and writable checks", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({ workspaceRoot });

    expect((await app.request("/api/workspace/init", { method: "POST" })).status).toBe(200);
    const readyResponse = await app.request("/api/health/ready");
    const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;

    expect(readyResponse.status).toBe(200);
    expect(readyBody.status).toBe("ok");
    expect(readyBody.checks).toEqual({
      directory_tree: "ok",
      snapshot_readable: "ok",
      workspace_writable: "ok"
    });
    expect(readyBody.missing_directories).toBeUndefined();
  });

  test("GET /api/health/ready reports injected workspace_writable failure in the configured root", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const probeRoots: string[] = [];
    const app = createBackendApi({
      workspaceRoot,
      writableProbe: ({ workspaceRoot: probeRoot }) => {
        probeRoots.push(probeRoot);
        return false;
      }
    });

    expect((await app.request("/api/workspace/init", { method: "POST" })).status).toBe(200);
    const readyResponse = await app.request("/api/health/ready");
    const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;

    expect(readyResponse.status).toBe(503);
    expect(readyBody.status).toBe("not_ready");
    expect(readyBody.checks.directory_tree).toBe("ok");
    expect(readyBody.checks.snapshot_readable).toBe("ok");
    expect(readyBody.checks.workspace_writable).toBe("fail");
    expect(probeRoots).toEqual([resolve(workspaceRoot)]);
  });

  test("blank workspace option and env values fall back to workspace under the current cwd", async () => {
    const tempRoot = await createTempRoot("shud-harness-backend-routes-cwd-");
    tempRoots.push(tempRoot);
    process.chdir(tempRoot);
    process.env.HARNESS_WORKSPACE_DIR = "   ";
    process.env.SHUD_HARNESS_WORKSPACE_ROOT = "";
    const app = createBackendApi({ workspaceRoot: "\n\t " });

    const response = await app.request("/api/workspace/init", { method: "POST" });

    expect(response.status).toBe(200);
    for (const relativeDir of EXPECTED_M1_RUNTIME_DIRECTORIES) {
      expect((await stat(join(tempRoot, "workspace", relativeDir))).isDirectory()).toBe(true);
    }
  });

  test("HARNESS_WORKSPACE_DIR configures workspace root and takes precedence over the legacy env", async () => {
    const tempRoot = await createTempRoot("shud-harness-backend-routes-env-");
    tempRoots.push(tempRoot);
    const workspaceRoot = join(tempRoot, "canonical-workspace");
    const legacyRoot = join(tempRoot, "legacy-workspace");
    process.env.HARNESS_WORKSPACE_DIR = workspaceRoot;
    process.env.SHUD_HARNESS_WORKSPACE_ROOT = legacyRoot;
    const app = createBackendApi();

    expect((await app.request("/api/workspace/init", { method: "POST" })).status).toBe(200);
    const readyResponse = await app.request("/api/health/ready");
    const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;

    expect(readyResponse.status).toBe(200);
    expect(readyBody.status).toBe("ok");
    expect((await stat(join(workspaceRoot, "readiness"))).isDirectory()).toBe(true);
    await expectPathMissing(join(legacyRoot, "readiness"));
  });

  test("POST /api/workspace/init rejects a missing parent outside the configured root leaf", async () => {
    const tempRoot = await createTempRoot("shud-harness-backend-routes-missing-parent-");
    tempRoots.push(tempRoot);
    const missingParent = join(tempRoot, "missing-parent");
    const workspaceRoot = join(missingParent, "workspace");
    const app = createBackendApi({ workspaceRoot });

    const response = await app.request("/api/workspace/init", { method: "POST" });

    expect(response.status).toBe(500);
    await expectPathMissing(missingParent);
  });

  test("POST /api/workspace/init rejects a symlinked canonical parent without writing outside", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const outsideRoot = join(tempRoot, "outside-repos");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(outsideRoot);
    await symlink(outsideRoot, join(workspaceRoot, "repos"), "dir");
    const app = createBackendApi({ workspaceRoot });

    const response = await app.request("/api/workspace/init", { method: "POST" });
    const readyResponse = await app.request("/api/health/ready");
    const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;

    expect(response.status).toBe(500);
    await expectPathMissing(join(outsideRoot, "SHUD"));
    expect(readyResponse.status).toBe(503);
    expect(readyBody.status).toBe("not_ready");
    expect(readyBody.checks.directory_tree).toBe("fail");
  });

  test("POST /api/workspace/init rejects a symlinked configured ancestor without writing outside", async () => {
    const tempRoot = await createTempRoot("shud-harness-backend-routes-link-");
    tempRoots.push(tempRoot);
    const baseRoot = join(tempRoot, "base");
    const outsideRoot = join(tempRoot, "outside");
    const linkPath = join(baseRoot, "link");
    const workspaceRoot = join(linkPath, "workspace");
    await mkdir(baseRoot);
    await mkdir(outsideRoot);
    await symlink(outsideRoot, linkPath, "dir");
    const app = createBackendApi({ workspaceRoot });

    const response = await app.request("/api/workspace/init", { method: "POST" });
    const readyResponse = await app.request("/api/health/ready");
    const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;

    expect(response.status).toBe(500);
    await expectPathMissing(join(outsideRoot, "workspace", "readiness"));
    expect(readyResponse.status).toBe(503);
    expect(readyBody.status).toBe("not_ready");
    expect(readyBody.checks).toEqual({
      directory_tree: "fail",
      snapshot_readable: "fail",
      workspace_writable: "fail"
    });
  });

  test("POST /api/workspace/init rejects a symlinked workspace root without writing outside", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const outsideRoot = join(tempRoot, "outside-root");
    await mkdir(outsideRoot);
    await symlink(outsideRoot, workspaceRoot, "dir");
    const app = createBackendApi({ workspaceRoot });

    const response = await app.request("/api/workspace/init", { method: "POST" });

    expect(response.status).toBe(500);
    await expectPathMissing(join(outsideRoot, "readiness"));
  });

  test("GET /api/health/ready rejects a symlinked canonical leaf as not readable", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const outsideSnapshots = join(tempRoot, "outside-snapshots");
    await mkdir(outsideSnapshots, { recursive: true });
    await createExpectedRuntimeTree(workspaceRoot, { skip: new Set(["snapshots"]) });
    await symlink(outsideSnapshots, join(workspaceRoot, "snapshots"), "dir");
    const app = createBackendApi({ workspaceRoot });

    const readyResponse = await app.request("/api/health/ready");
    const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;

    expect(readyResponse.status).toBe(503);
    expect(readyBody.status).toBe("not_ready");
    expect(readyBody.checks.directory_tree).toBe("fail");
    expect(readyBody.checks.snapshot_readable).toBe("fail");
    expect(readyBody.checks.workspace_writable).toBe("ok");
  });

  test("GET /api/health/ready revalidates a snapshot symlink swap after probing", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const outsideSnapshots = join(tempRoot, "outside-snapshots");
    await mkdir(outsideSnapshots, { recursive: true });
    await createExpectedRuntimeTree(workspaceRoot);
    const app = createBackendApi({
      workspaceRoot,
      snapshotReadableProbe: async ({ snapshotsPath }) => {
        await rm(snapshotsPath, { recursive: true, force: true });
        await symlink(outsideSnapshots, snapshotsPath, "dir");
        return true;
      }
    });

    const readyResponse = await app.request("/api/health/ready");
    const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;

    expect(readyResponse.status).toBe(503);
    expect(readyBody.status).toBe("not_ready");
    expect(readyBody.checks).toEqual({
      directory_tree: "ok",
      snapshot_readable: "fail",
      workspace_writable: "ok"
    });
  });

  test("GET /api/health/ready does not run the writable probe for a symlinked workspace root", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const outsideRoot = join(tempRoot, "outside-root");
    await mkdir(outsideRoot);
    await symlink(outsideRoot, workspaceRoot, "dir");
    const probeRoots: string[] = [];
    const app = createBackendApi({
      workspaceRoot,
      writableProbe: ({ workspaceRoot: probeRoot }) => {
        probeRoots.push(probeRoot);
        return true;
      }
    });

    const readyResponse = await app.request("/api/health/ready");
    const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;

    expect(readyResponse.status).toBe(503);
    expect(readyBody.status).toBe("not_ready");
    expect(readyBody.checks.workspace_writable).toBe("fail");
    expect(probeRoots).toEqual([]);
  });

  test("GET /api/health/ready isolates injected snapshot_readable failure after init", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({
      workspaceRoot,
      snapshotReadableProbe: () => false
    });

    expect((await app.request("/api/workspace/init", { method: "POST" })).status).toBe(200);
    const readyResponse = await app.request("/api/health/ready");
    const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;

    expect(readyResponse.status).toBe(503);
    expect(readyBody.status).toBe("not_ready");
    expect(readyBody.checks).toEqual({
      directory_tree: "ok",
      snapshot_readable: "fail",
      workspace_writable: "ok"
    });
  });

  test("GET /api/health/ready accepts a default snapshot readability probe with many entries", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({ workspaceRoot });

    expect((await app.request("/api/workspace/init", { method: "POST" })).status).toBe(200);
    await Promise.all(
      Array.from({ length: 512 }, (_, index) =>
        writeFile(join(workspaceRoot, "snapshots", `snapshot-${index}.json`), "{}")
      )
    );

    const readyResponse = await app.request("/api/health/ready");
    const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;

    expect(readyResponse.status).toBe(200);
    expect(readyBody.status).toBe("ok");
    expect(readyBody.checks.snapshot_readable).toBe("ok");
  });

  test("POST /api/tasks creates a TaskCard and list/detail return stable shapes", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:00:00.000Z"),
      taskIdFactory: () => "TASK-route-create"
    });

    const response = await postTask(app, {
      type: "engineering",
      title: "Add optional event diagnostics",
      question_or_goal: "Add event_flux output without breaking old rSHUD readers",
      inference_budget: { mode: "normal" },
      created_by: "pi"
    });
    const task = (await response.json()) as TaskCard;

    expect(response.status).toBe(201);
    expect(task).toEqual({
      task_id: "TASK-route-create",
      type: "engineering",
      status: "created",
      title: "Add optional event diagnostics",
      question_or_goal: "Add event_flux output without breaking old rSHUD readers",
      created_by: "pi",
      current_owner: "coordinator",
      reviewer: "reviewer",
      inference_budget: { mode: "normal" },
      linked_jobs: [],
      linked_reports: [],
      created_at: "2026-07-07T12:00:00.000Z",
      updated_at: "2026-07-07T12:00:00.000Z"
    });

    const listResponse = await app.request("/api/tasks");
    const detailResponse = await app.request(`/api/tasks/${task.task_id}`);

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ tasks: [task] });
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toEqual(task);
  });

  test("POST /api/tasks defaults created_by when omitted", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:01:00.000Z"),
      taskIdFactory: () => "TASK-default-actor"
    });

    const response = await postTask(app, validTaskCreateBody({ created_by: undefined }));
    const task = (await response.json()) as TaskCard;

    expect(response.status).toBe(201);
    expect(task.created_by).toBe("pi");
    expect(task.current_owner).toBe("coordinator");
    expect(task.reviewer).toBe("reviewer");
  });

  test("POST /api/tasks writes a TaskSnapshot with nested TaskCard recovery data", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:02:00.000Z"),
      taskIdFactory: () => "TASK-snapshot"
    });

    const response = await postTask(app, validTaskCreateBody());
    const task = (await response.json()) as TaskCard;
    const snapshotPath = join(workspaceRoot, "tasks", task.task_id, "snapshot.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as TaskSnapshot & {
      task_card: TaskCard;
    };

    expect(response.status).toBe(201);
    expect(snapshot).toEqual({
      task_id: task.task_id,
      status: "created",
      runtime_phase: null,
      linked_jobs: [],
      linked_runs: [],
      linked_reports: [],
      pending_pi_gates: [],
      latest_seq: 0,
      updated_at: task.updated_at,
      task_card: task
    });
  });

  test("task snapshots recover list and detail after creating a fresh app", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const firstApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:00.000Z"),
      taskIdFactory: () => "TASK-restart"
    });
    const createResponse = await postTask(firstApp, validTaskCreateBody());
    const createdTask = (await createResponse.json()) as TaskCard;
    const freshApp = createBackendApi({ workspaceRoot });

    const listResponse = await freshApp.request("/api/tasks");
    const detailResponse = await freshApp.request(`/api/tasks/${createdTask.task_id}`);

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ tasks: [createdTask] });
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toEqual(createdTask);
  });

  test("fresh app list and detail reject unknown top-level and task_card snapshot fields", async () => {
    for (const location of ["top_level", "task_card"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const taskId = `TASK-fresh-unknown-${location.replace("_", "-")}`;
      const creatingApp = createBackendApi({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:10.000Z"),
        taskIdFactory: () => taskId
      });
      const createResponse = await postTask(creatingApp, validTaskCreateBody());
      const createdTask = (await createResponse.json()) as TaskCard;
      const snapshotPath = join(workspaceRoot, "tasks", taskId, "snapshot.json");
      const canonicalSnapshotText = await readFile(snapshotPath, "utf8");
      const poisonedSnapshot = JSON.parse(canonicalSnapshotText) as Record<string, unknown>;
      const unknownContent = `private-fresh-unknown-${location}`;
      if (location === "top_level") {
        poisonedSnapshot.unknown_top_level = unknownContent;
      } else {
        (poisonedSnapshot.task_card as Record<string, unknown>).unknown_nested = unknownContent;
      }
      await writeFile(snapshotPath, `${JSON.stringify(poisonedSnapshot)}\n`);
      const freshApp = createBackendApi({ workspaceRoot });

      const listResponse = await freshApp.request("/api/tasks");
      const listBody = (await listResponse.json()) as ApiErrorResponse;
      const detailResponse = await freshApp.request(`/api/tasks/${taskId}`);
      const detailBody = (await detailResponse.json()) as ApiErrorResponse;

      expect(listResponse.status).toBe(500);
      expect(detailResponse.status).toBe(500);
      expectCanonicalError(listBody, "workspace_error");
      expectCanonicalError(detailBody, "workspace_error");
      expect(listBody.error.message).toBe(
        "Task snapshot contains fields outside the canonical durable shape."
      );
      expect(detailBody.error.message).toBe(listBody.error.message);
      expect(JSON.stringify(listBody)).not.toContain(unknownContent);
      expect(JSON.stringify(detailBody)).not.toContain(unknownContent);
      expectNoAbsoluteWorkspacePath(listBody, tempRoot, workspaceRoot);
      expectNoAbsoluteWorkspacePath(detailBody, tempRoot, workspaceRoot);

      await writeFile(snapshotPath, canonicalSnapshotText);
      const repairedListResponse = await freshApp.request("/api/tasks");
      const repairedDetailResponse = await freshApp.request(`/api/tasks/${taskId}`);

      expect(repairedListResponse.status).toBe(200);
      expect(await repairedListResponse.json()).toEqual({ tasks: [createdTask] });
      expect(repairedDetailResponse.status).toBe(200);
      expect(await repairedDetailResponse.json()).toEqual(createdTask);
    }
  });

  test("POST /api/tasks replays same Idempotency-Key and body without duplicate snapshots", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    let nextId = 0;
    const idempotencyKey = "task:create:replay";
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:30.000Z"),
      taskIdFactory: () => {
        nextId += 1;
        return `TASK-idempotent-${nextId}`;
      }
    });

    const firstResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const secondResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const firstTask = (await firstResponse.json()) as TaskCard;
    const secondTask = (await secondResponse.json()) as TaskCard;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const idempotencyRecord = await idempotencyService.getRecord("task", idempotencyKey);

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(200);
    expect(secondTask).toEqual(firstTask);
    expect(nextId).toBe(1);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [firstTask]
    });
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([firstTask.task_id]);
    expect((await readdir(join(workspaceRoot, "tasks", "_idempotency", "task")))).toHaveLength(1);
    expect(idempotencyRecord?.status).toBe("completed");
    expect(idempotencyRecord?.result_ref).toBe(firstTask.task_id);
  });

  test("completed replay rejects unknown top-level and task_card snapshot fields until repaired", async () => {
    for (const location of ["top_level", "task_card"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const taskBody = validTaskCreateBody();
      const taskId = `TASK-replay-unknown-${location.replace("_", "-")}`;
      const idempotencyKey = `task:create:replay-unknown-${location}`;
      const requestDigest = sha256Hex(
        canonicalJson({
          ...taskBody,
          created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
        })
      );
      const task = await createTaskCardService({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:30.250Z"),
        taskIdFactory: () => taskId
      }).createTask(taskBody);
      const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
      await idempotencyService.beginRecord({
        scope: "task",
        key: idempotencyKey,
        requestDigest
      });
      await idempotencyService.completeRecord({
        scope: "task",
        key: idempotencyKey,
        requestDigest,
        resultRef: taskId
      });
      const snapshotPath = join(workspaceRoot, "tasks", taskId, "snapshot.json");
      const canonicalSnapshotText = await readFile(snapshotPath, "utf8");
      const poisonedSnapshot = JSON.parse(canonicalSnapshotText) as Record<string, unknown>;
      const unknownContent = `private-replay-unknown-${location}`;
      if (location === "top_level") {
        poisonedSnapshot.unknown_top_level = unknownContent;
      } else {
        (poisonedSnapshot.task_card as Record<string, unknown>).unknown_nested = unknownContent;
      }
      await writeFile(snapshotPath, `${JSON.stringify(poisonedSnapshot)}\n`);
      let taskIdFactoryCalls = 0;
      const replayApp = createBackendApi({
        workspaceRoot,
        taskIdFactory: () => {
          taskIdFactoryCalls += 1;
          return "TASK-replay-unknown-duplicate";
        }
      });

      const failedResponse = await postTask(replayApp, taskBody, {
        "Idempotency-Key": idempotencyKey
      });
      const failedBody = (await failedResponse.json()) as ApiErrorResponse;

      expect(failedResponse.status).toBe(500);
      expectCanonicalError(failedBody, "workspace_error");
      expect(failedBody.error.message).toBe(
        "Completed idempotency result is not bound to the task create request."
      );
      expect(JSON.stringify(failedBody)).not.toContain(unknownContent);
      expect(JSON.stringify(failedBody)).not.toContain(idempotencyKey);
      expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
      expect(taskIdFactoryCalls).toBe(0);

      await writeFile(snapshotPath, canonicalSnapshotText);
      const repairedReplayResponse = await postTask(replayApp, taskBody, {
        "Idempotency-Key": idempotencyKey
      });

      expect(repairedReplayResponse.status).toBe(200);
      expect(await repairedReplayResponse.json()).toEqual(task);
      expect(taskIdFactoryCalls).toBe(0);
      expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([taskId]);
    }
  });

  test("POST /api/tasks completed idempotency replay resolves a stale task cache from durable snapshot", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:stale-cache-replay";
    let staleAppTaskIdFactoryCalls = 0;
    const staleApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.000Z"),
      taskIdFactory: () => {
        staleAppTaskIdFactoryCalls += 1;
        return "TASK-stale-cache-duplicate";
      }
    });
    const creatingApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.000Z"),
      taskIdFactory: () => "TASK-stale-cache-original"
    });

    const emptyListResponse = await staleApp.request("/api/tasks");
    const firstResponse = await postTask(creatingApp, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const replayResponse = await postTask(staleApp, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const firstTask = (await firstResponse.json()) as TaskCard;
    const replayTask = (await replayResponse.json()) as TaskCard;

    expect(emptyListResponse.status).toBe(200);
    expect(await emptyListResponse.json()).toEqual({ tasks: [] });
    expect(firstResponse.status).toBe(201);
    expect(replayResponse.status).toBe(200);
    expect(replayTask).toEqual(firstTask);
    expect(staleAppTaskIdFactoryCalls).toBe(0);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([firstTask.task_id]);
    expect(await staleApp.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [firstTask]
    });
  });

  test("POST /api/tasks completed idempotency replay reads only the referenced snapshot lane", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:targeted-replay";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const targetTask = await createTaskCardService({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.250Z"),
      taskIdFactory: () => "TASK-targeted-replay"
    }).createTask(taskBody);
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    await idempotencyService.beginRecord({
      scope: "task",
      key: idempotencyKey,
      requestDigest
    });
    await idempotencyService.completeRecord({
      scope: "task",
      key: idempotencyKey,
      requestDigest,
      resultRef: targetTask.task_id
    });
    await mkdir(join(workspaceRoot, "tasks", "TASK-unrelated-malformed"), { recursive: true });
    await writeFile(join(workspaceRoot, "tasks", "TASK-unrelated-malformed", "snapshot.json"), "{", {
      flag: "wx"
    });
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-targeted-replay-duplicate";
      }
    });

    const response = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const replayTask = (await response.json()) as TaskCard;

    expect(response.status).toBe(200);
    expect(replayTask).toEqual(targetTask);
    expect(taskIdFactoryCalls).toBe(0);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([
      "TASK-targeted-replay",
      "TASK-unrelated-malformed"
    ]);
  });

  test("POST /api/tasks treats completeRecord convergence as authoritative and rolls back the local task", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:completion-converges-authoritative";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const authoritativeTask = await createTaskCardService({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.300Z"),
      taskIdFactory: () => "TASK-authoritative-completed"
    }).createTask(taskBody);
    let hookCompletions = 0;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.400Z"),
      taskIdFactory: () => "TASK-local-unbound",
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async () => {
          if (hookCompletions > 0) {
            return;
          }
          hookCompletions += 1;
          await createIdempotencyRecordService({ workspaceRoot }).completeRecord({
            scope: "task",
            key: idempotencyKey,
            requestDigest,
            resultRef: authoritativeTask.task_id
          });
        }
      }
    });

    const firstResponse = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const replayResponse = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const firstTask = (await firstResponse.json()) as TaskCard;
    const replayTask = (await replayResponse.json()) as TaskCard;
    const idempotencyRecord = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(firstResponse.status).toBe(200);
    expect(replayResponse.status).toBe(200);
    expect(firstTask).toEqual(authoritativeTask);
    expect(replayTask).toEqual(authoritativeTask);
    expect(hookCompletions).toBe(1);
    expect(idempotencyRecord?.result_ref).toBe(authoritativeTask.task_id);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([authoritativeTask.task_id]);
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-local-unbound", "snapshot.json"));
  });

  test("POST /api/tasks preserves repairable missing-card authority after local rollback", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:repairable-missing-card-convergence";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const authoritativeTask = await createTaskCardService({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.410Z"),
      taskIdFactory: () => "TASK-repairable-missing-card-authority"
    }).createTask(taskBody);
    const authoritativeSnapshotPath = join(
      workspaceRoot,
      "tasks",
      authoritativeTask.task_id,
      "snapshot.json"
    );
    const canonicalAuthoritativeSnapshotText = await readFile(
      authoritativeSnapshotPath,
      "utf8"
    );
    let hookCompletions = 0;
    let taskIdFactoryCalls = 0;
    const localTaskId = "TASK-repairable-missing-card-local";
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.415Z"),
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return localTaskId;
      },
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async () => {
          if (hookCompletions > 0) {
            return;
          }
          hookCompletions += 1;
          await createIdempotencyRecordService({ workspaceRoot }).completeRecord({
            scope: "task",
            key: idempotencyKey,
            requestDigest,
            resultRef: authoritativeTask.task_id
          });
        }
      }
    });
    const primedListResponse = await app.request("/api/tasks");
    const snapshotWithoutTaskCard = JSON.parse(
      canonicalAuthoritativeSnapshotText
    ) as Record<string, unknown>;
    delete snapshotWithoutTaskCard.task_card;
    await writeFile(authoritativeSnapshotPath, `${JSON.stringify(snapshotWithoutTaskCard)}\n`);

    const failedResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
    const localDetailResponse = await app.request(`/api/tasks/${localTaskId}`);

    expect(primedListResponse.status).toBe(200);
    expect(await primedListResponse.json()).toEqual({ tasks: [authoritativeTask] });
    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expect(failedBody.error.message).toBe(
      "Task snapshot does not include the M1 task_card recovery payload."
    );
    expect(failedBody.error.evidence_refs).toEqual([
      `workspace/tasks/${authoritativeTask.task_id}/snapshot.json`
    ]);
    expect(JSON.stringify(failedBody)).not.toContain(idempotencyKey);
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("completed");
    expect(recordAfterFailure?.result_ref).toBe(authoritativeTask.task_id);
    expect(hookCompletions).toBe(1);
    expect(taskIdFactoryCalls).toBe(1);
    expect(localDetailResponse.status).toBe(404);
    await expectPathMissing(join(workspaceRoot, "tasks", localTaskId, "snapshot.json"));
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([authoritativeTask.task_id]);

    await writeFile(authoritativeSnapshotPath, canonicalAuthoritativeSnapshotText);
    const replayResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const replayTask = (await replayResponse.json()) as TaskCard;
    const recordAfterRepair = await idempotencyService.getRecord("task", idempotencyKey);

    expect(replayResponse.status).toBe(200);
    expect(replayTask).toEqual(authoritativeTask);
    expect(recordAfterRepair).toEqual(recordAfterFailure);
    expect(taskIdFactoryCalls).toBe(1);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([authoritativeTask.task_id]);
  });

  test("POST /api/tasks invalidates complete-then-delete authority and permits repaired retry", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:complete-then-delete";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const taskIds = ["TASK-complete-then-delete", "TASK-complete-then-delete-retry"];
    let shouldPoisonCompletedResult = true;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.425Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-unexpected-complete-delete-extra",
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async ({ taskDirectory, taskId }) => {
          if (!shouldPoisonCompletedResult) {
            return;
          }
          shouldPoisonCompletedResult = false;
          await createIdempotencyRecordService({ workspaceRoot }).completeRecord({
            scope: "task",
            key: idempotencyKey,
            requestDigest,
            resultRef: taskId
          });
          await rm(join(taskDirectory, "snapshot.json"));
        }
      }
    });

    const failedResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
    const listAfterFailure = await app.request("/api/tasks");
    const freshListAfterFailure = await createBackendApi({ workspaceRoot }).request("/api/tasks");

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(JSON.stringify(failedBody)).not.toContain(idempotencyKey);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(listAfterFailure.status).toBe(200);
    expect(await listAfterFailure.json()).toEqual({ tasks: [] });
    expect(freshListAfterFailure.status).toBe(200);
    expect(await freshListAfterFailure.json()).toEqual({ tasks: [] });

    const retryResponse = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const retryTask = (await retryResponse.json()) as TaskCard;
    const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);

    expect(retryResponse.status).toBe(201);
    expect(retryTask.task_id).toBe("TASK-complete-then-delete-retry");
    expect(taskIds).toEqual([]);
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(retryTask.task_id);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([retryTask.task_id]);
  });

  test("POST /api/tasks rolls back the local task when authoritative convergence is not request-bound", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:completion-converges-unbound";
    const taskBody = validTaskCreateBody();
    const foreignTaskBody = validTaskCreateBody({
      title: "Foreign authoritative task",
      question_or_goal: "This task should not satisfy the original request digest"
    });
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const foreignTask = await createTaskCardService({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.450Z"),
      taskIdFactory: () => "TASK-foreign-unbound-convergence"
    }).createTask(foreignTaskBody);
    let hookCompletions = 0;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.475Z"),
      taskIdFactory: () => "TASK-local-unbound-convergence",
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async () => {
          if (hookCompletions > 0) {
            return;
          }
          hookCompletions += 1;
          await createIdempotencyRecordService({ workspaceRoot }).completeRecord({
            scope: "task",
            key: idempotencyKey,
            requestDigest,
            resultRef: foreignTask.task_id
          });
        }
      }
    });

    const response = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const body = (await response.json()) as ApiErrorResponse;
    const listResponse = await app.request("/api/tasks");
    const localDetailResponse = await app.request("/api/tasks/TASK-local-unbound-convergence");
    const localDetailBody = (await localDetailResponse.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.evidence_refs).toEqual([
      "workspace/tasks/_idempotency/task",
      "idempotency.result_ref"
    ]);
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
    expect(hookCompletions).toBe(1);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ tasks: [foreignTask] });
    expect(localDetailResponse.status).toBe(404);
    expectCanonicalError(localDetailBody, "not_found");
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([foreignTask.task_id]);
    await expectPathMissing(
      join(workspaceRoot, "tasks", "TASK-local-unbound-convergence", "snapshot.json")
    );
  });

  test("POST /api/tasks evicts local cache when authoritative convergence finds the local snapshot missing", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:completion-converges-rollback-fails";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const authoritativeTask = await createTaskCardService({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.500Z"),
      taskIdFactory: () => "TASK-authoritative-rollback-failure"
    }).createTask(taskBody);
    let hookCompletions = 0;
    let removedDuringRollback = false;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.600Z"),
      taskIdFactory: () => "TASK-local-rollback-failure",
      taskSnapshotReadHooks: {
        beforeSnapshotOpen: async ({ snapshotPath: candidatePath, laneTaskId }) => {
          if (laneTaskId !== "TASK-local-rollback-failure" || removedDuringRollback) {
            return;
          }
          removedDuringRollback = true;
          await rm(candidatePath);
        }
      },
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async () => {
          if (hookCompletions > 0) {
            return;
          }
          hookCompletions += 1;
          await createIdempotencyRecordService({ workspaceRoot }).completeRecord({
            scope: "task",
            key: idempotencyKey,
            requestDigest,
            resultRef: authoritativeTask.task_id
          });
        }
      }
    });

    const response = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const task = (await response.json()) as TaskCard;
    const idempotencyRecord = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );
    const listResponse = await app.request("/api/tasks");
    const localDetailResponse = await app.request("/api/tasks/TASK-local-rollback-failure");
    const localDetailBody = (await localDetailResponse.json()) as ApiErrorResponse;

    expect(response.status).toBe(200);
    expect(task).toEqual(authoritativeTask);
    expect(hookCompletions).toBe(1);
    expect(removedDuringRollback).toBe(true);
    expect(idempotencyRecord?.status).toBe("completed");
    expect(idempotencyRecord?.result_ref).toBe(authoritativeTask.task_id);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ tasks: [authoritativeTask] });
    expect(localDetailResponse.status).toBe(404);
    expectCanonicalError(localDetailBody, "not_found");
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([authoritativeTask.task_id]);
  });

  test("POST /api/tasks fails closed when idempotency record key does not match the lookup path", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:path-key-a";
    const storedKey = "task:create:path-key-b-secret";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const existingTask = await createTaskCardService({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.500Z"),
      taskIdFactory: () => "TASK-poisoned-idempotency-result"
    }).createTask(taskBody);
    const idempotencyDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    const recordPath = join(idempotencyDirectory, idempotencyRecordFileName(idempotencyKey));
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.750Z"),
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-duplicate-should-not-create";
      }
    });

    await mkdir(idempotencyDirectory, { recursive: true });
    await writeFile(
      recordPath,
      `${JSON.stringify({
        key: storedKey,
        scope: "task",
        request_digest: requestDigest,
        status: "completed",
        result_ref: existingTask.task_id,
        created_at: "2026-07-07T12:03:31.750Z",
        updated_at: "2026-07-07T12:03:31.750Z"
      })}\n`,
      { flag: "wx" }
    );

    const response = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.message).toBe(
      "Idempotency record identity does not match its lookup path."
    );
    expect(body.error.evidence_refs).toEqual([
      idempotencyRecordEvidenceRef("task", idempotencyKey),
      "idempotency.key",
      "idempotency.scope"
    ]);
    expect(JSON.stringify(body)).not.toContain(idempotencyKey);
    expect(JSON.stringify(body)).not.toContain(storedKey);
    expect(JSON.stringify(body)).not.toContain(existingTask.task_id);
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
    expect(taskIdFactoryCalls).toBe(0);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([existingTask.task_id]);
    expect(await app.request("/api/tasks").then((listResponse) => listResponse.json())).toEqual({
      tasks: [existingTask]
    });
  });

  test("POST /api/tasks invalidates completed idempotency missing result_ref before repaired retry", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:completed-missing-result-ref";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const idempotencyDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    const recordPath = join(idempotencyDirectory, idempotencyRecordFileName(idempotencyKey));
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.850Z"),
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-repaired-missing-result-ref";
      }
    });
    await mkdir(idempotencyDirectory, { recursive: true });
    await writeFile(
      recordPath,
      `${JSON.stringify({
        key: idempotencyKey,
        scope: "task",
        request_digest: requestDigest,
        status: "completed",
        created_at: "2026-07-07T12:03:31.850Z",
        updated_at: "2026-07-07T12:03:31.850Z"
      })}\n`,
      { flag: "wx" }
    );

    const failedResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const recordAfterFailure = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expect(failedBody.error.message).toBe(
      "Completed idempotency record is missing result_ref."
    );
    expect(JSON.stringify(failedBody)).not.toContain(idempotencyKey);
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(taskIdFactoryCalls).toBe(0);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: []
    });

    const retryResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const repairedTask = (await retryResponse.json()) as TaskCard;
    const recordAfterRetry = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(retryResponse.status).toBe(201);
    expect(repairedTask.task_id).toBe("TASK-repaired-missing-result-ref");
    expect(taskIdFactoryCalls).toBe(1);
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(repairedTask.task_id);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([repairedTask.task_id]);
  });

  test("POST /api/tasks invalidates completed idempotency with unsafe result_ref before repaired retry", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:unsafe-result-ref";
    const unsafeResultRef = "../outside/TASK-secret";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const idempotencyDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    const recordPath = join(idempotencyDirectory, idempotencyRecordFileName(idempotencyKey));
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.875Z"),
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-repaired-unsafe-result-ref";
      }
    });

    await mkdir(idempotencyDirectory, { recursive: true });
    await writeFile(
      recordPath,
      `${JSON.stringify({
        key: idempotencyKey,
        scope: "task",
        request_digest: requestDigest,
        status: "completed",
        result_ref: unsafeResultRef,
        created_at: "2026-07-07T12:03:31.875Z",
        updated_at: "2026-07-07T12:03:31.875Z"
      })}\n`,
      { flag: "wx" }
    );

    const response = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const body = (await response.json()) as ApiErrorResponse;
    const recordAfterFailure = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.evidence_refs).toEqual([
      "workspace/tasks/_idempotency/task",
      "idempotency.result_ref"
    ]);
    expect(JSON.stringify(body)).not.toContain(idempotencyKey);
    expect(JSON.stringify(body)).not.toContain(unsafeResultRef);
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
    expect(taskIdFactoryCalls).toBe(0);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(await app.request("/api/tasks").then((listResponse) => listResponse.json())).toEqual({
      tasks: []
    });
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-repaired-unsafe-result-ref"));

    const retryResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const repairedTask = (await retryResponse.json()) as TaskCard;
    const recordAfterRetry = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(retryResponse.status).toBe(201);
    expect(repairedTask.task_id).toBe("TASK-repaired-unsafe-result-ref");
    expect(taskIdFactoryCalls).toBe(1);
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(repairedTask.task_id);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([repairedTask.task_id]);
  });

  test("POST /api/tasks fails closed when completed idempotency result_ref points to a foreign task", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:foreign-result-ref";
    const taskBody = validTaskCreateBody({ title: "Expected request task" });
    const foreignTask = await createTaskCardService({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.900Z"),
      taskIdFactory: () => "TASK-foreign-secret-result"
    }).createTask(validTaskCreateBody({ title: "Foreign task must not replay" }));
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    await idempotencyService.beginRecord({
      scope: "task",
      key: idempotencyKey,
      requestDigest
    });
    await idempotencyService.completeRecord({
      scope: "task",
      key: idempotencyKey,
      requestDigest,
      resultRef: foreignTask.task_id
    });
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-foreign-result-duplicate";
      }
    });

    const response = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.message).toBe(
      "Completed idempotency result is not bound to the task create request."
    );
    expect(body.error.evidence_refs).toEqual([
      "workspace/tasks/_idempotency/task",
      "idempotency.result_ref"
    ]);
    expect(JSON.stringify(body)).not.toContain(idempotencyKey);
    expect(JSON.stringify(body)).not.toContain(foreignTask.task_id);
    expect(JSON.stringify(body)).not.toContain("Foreign task must not replay");
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
    expect(taskIdFactoryCalls).toBe(0);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([foreignTask.task_id]);
  });

  test("POST /api/tasks fails closed when completed idempotency result_ref points to a missing task", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:missing-result-ref";
    const missingResultRef = "TASK-missing-secret-result";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    await idempotencyService.beginRecord({
      scope: "task",
      key: idempotencyKey,
      requestDigest
    });
    await idempotencyService.completeRecord({
      scope: "task",
      key: idempotencyKey,
      requestDigest,
      resultRef: missingResultRef
    });
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-missing-result-duplicate";
      }
    });

    const response = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.evidence_refs).toEqual([
      "workspace/tasks/_idempotency/task",
      "idempotency.result_ref"
    ]);
    expect(JSON.stringify(body)).not.toContain(idempotencyKey);
    expect(JSON.stringify(body)).not.toContain(missingResultRef);
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
    expect(taskIdFactoryCalls).toBe(0);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([]);
  });

  test("POST /api/tasks completed replay reports task_snapshot_missing_card for canonical snapshots without task_card", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:missing-card-result-ref";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const targetTask = await createTaskCardService({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.950Z"),
      taskIdFactory: () => "TASK-missing-card-result"
    }).createTask(taskBody);
    const snapshotPath = join(workspaceRoot, "tasks", targetTask.task_id, "snapshot.json");
    const snapshotWithoutTaskCard = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete snapshotWithoutTaskCard.task_card;
    await writeFile(snapshotPath, `${JSON.stringify(snapshotWithoutTaskCard)}\n`);
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    await idempotencyService.beginRecord({
      scope: "task",
      key: idempotencyKey,
      requestDigest
    });
    await idempotencyService.completeRecord({
      scope: "task",
      key: idempotencyKey,
      requestDigest,
      resultRef: targetTask.task_id
    });
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-missing-card-duplicate";
      }
    });

    const response = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.message).toBe(
      "Task snapshot does not include the M1 task_card recovery payload."
    );
    expect(body.error.evidence_refs).toEqual([
      "workspace/tasks/TASK-missing-card-result/snapshot.json"
    ]);
    expect(JSON.stringify(body)).not.toContain(
      "Completed idempotency result is not bound to the task create request."
    );
    expect(JSON.stringify(body)).not.toContain(idempotencyKey);
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
    expect(taskIdFactoryCalls).toBe(0);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([targetTask.task_id]);
  });

  test("POST /api/tasks times out a stale started same-digest idempotency claim without creating a task", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    let taskIdFactoryCalls = 0;
    const idempotencyKey = "task:create:stale-started-claim";
    const taskBody = validTaskCreateBody({ created_by: undefined });
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const idempotencyService = createIdempotencyRecordService({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:32.000Z")
    });
    const seededBegin = await idempotencyService.beginRecord({
      scope: "task",
      key: idempotencyKey,
      requestDigest
    });
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:33.000Z"),
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-should-not-be-created";
      }
    });

    const response = await Promise.race([
      postTask(app, taskBody, { "Idempotency-Key": idempotencyKey }),
      timeoutAfter(2_000, "POST /api/tasks did not time out a stale idempotency claim")
    ]);
    const body = (await response.json()) as ApiErrorResponse;
    const recordAfterReplay = await idempotencyService.getRecord("task", idempotencyKey);

    expect(seededBegin.status).toBe("acquired");
    expect(response.status).toBe(409);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.message).toBe("Idempotency record did not complete before replay timeout.");
    expect(body.error.retryable).toBe(true);
    expect(body.error.evidence_refs).toEqual(["workspace/tasks/_idempotency/task"]);
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
    expect(taskIdFactoryCalls).toBe(0);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([]);
    expect(recordAfterReplay).toEqual(seededBegin.record);
    expect(recordAfterReplay?.status).toBe("started");
  });

  test("POST /api/tasks computes the same digest for reordered JSON keys", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    let nextId = 0;
    const idempotencyKey = "task:create:reordered-json";
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:35.000Z"),
      taskIdFactory: () => {
        nextId += 1;
        return `TASK-reordered-${nextId}`;
      }
    });

    const firstResponse = await postRawTask(
      app,
      {
        type: "engineering",
        title: "Add optional event diagnostics",
        question_or_goal: "Add event_flux output without breaking old rSHUD readers",
        inference_budget: { mode: "normal" },
        created_by: "pi"
      },
      idempotencyKey
    );
    const secondResponse = await app.request("/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey
      },
      body:
        '{"created_by":"pi","inference_budget":{"mode":"normal"},"question_or_goal":"Add event_flux output without breaking old rSHUD readers","title":"Add optional event diagnostics","type":"engineering"}'
    });
    const firstTask = (await firstResponse.json()) as TaskCard;
    const secondTask = (await secondResponse.json()) as TaskCard;

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(200);
    expect(secondTask).toEqual(firstTask);
    expect(nextId).toBe(1);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([firstTask.task_id]);
  });

  test("POST /api/tasks idempotency digest includes defaulted created_by", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    let nextId = 0;
    const idempotencyKey = "task:create:default-created-by";
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:40.000Z"),
      taskIdFactory: () => {
        nextId += 1;
        return `TASK-default-idempotent-${nextId}`;
      }
    });

    const omittedResponse = await postTask(app, validTaskCreateBody({ created_by: undefined }), {
      "Idempotency-Key": idempotencyKey
    });
    const explicitResponse = await postTask(app, validTaskCreateBody({ created_by: "pi" }), {
      "Idempotency-Key": idempotencyKey
    });
    const changedResponse = await postTask(app, validTaskCreateBody({ created_by: "engineer" }), {
      "Idempotency-Key": idempotencyKey
    });
    const omittedTask = (await omittedResponse.json()) as TaskCard;
    const explicitTask = (await explicitResponse.json()) as TaskCard;
    const changedBody = (await changedResponse.json()) as ApiErrorResponse;

    expect(omittedResponse.status).toBe(201);
    expect(explicitResponse.status).toBe(200);
    expect(changedResponse.status).toBe(422);
    expect(explicitTask).toEqual(omittedTask);
    expect(omittedTask.created_by).toBe("pi");
    expectCanonicalError(changedBody, "idempotency_mismatch");
    expect(nextId).toBe(1);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([omittedTask.task_id]);
  });

  test("POST /api/tasks returns 422 on same Idempotency-Key with different body", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "raw-secret-idempotency-key-should-not-leak";
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:45.000Z"),
      taskIdFactory: () => "TASK-idempotency-mismatch"
    });

    const firstResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const firstTask = (await firstResponse.json()) as TaskCard;
    const mismatchResponse = await postTask(
      app,
      validTaskCreateBody({ title: "Changed task title" }),
      { "Idempotency-Key": idempotencyKey }
    );
    const mismatchBody = (await mismatchResponse.json()) as ApiErrorResponse;

    expect(firstResponse.status).toBe(201);
    expect(mismatchResponse.status).toBe(422);
    expectCanonicalError(mismatchBody, "idempotency_mismatch");
    expect(mismatchBody.error.evidence_refs).toEqual([
      "request.headers.Idempotency-Key",
      "idempotency.scope:task",
      "idempotency.request_digest"
    ]);
    expect(JSON.stringify(mismatchBody)).not.toContain(idempotencyKey);
    expectNoAbsoluteWorkspacePath(mismatchBody, tempRoot, workspaceRoot);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [firstTask]
    });
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([firstTask.task_id]);
  });

  test("POST /api/tasks without Idempotency-Key preserves create/list/detail behavior and writes no record", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:50.000Z"),
      taskIdFactory: () => "TASK-no-idempotency-key"
    });

    const response = await postTask(app, validTaskCreateBody());
    const task = (await response.json()) as TaskCard;
    const listResponse = await app.request("/api/tasks");
    const detailResponse = await app.request(`/api/tasks/${task.task_id}`);

    expect(response.status).toBe(201);
    expect(listResponse.status).toBe(200);
    expect(detailResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ tasks: [task] });
    expect(await detailResponse.json()).toEqual(task);
    expect((await stat(join(workspaceRoot, "tasks", task.task_id, "snapshot.json"))).isFile()).toBe(
      true
    );
    await expectPathMissing(join(workspaceRoot, "tasks", "_idempotency"));
  });

  test("POST /api/tasks rejects a blank Idempotency-Key without task or idempotency state", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:52.000Z"),
      taskIdFactory: () => "TASK-blank-idempotency-key"
    });

    const response = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": "   "
    });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(400);
    expectCanonicalError(body, "schema_error");
    expect(body.error.evidence_refs).toEqual(["request.headers.Idempotency-Key"]);
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
    await expectPathMissing(join(workspaceRoot, "tasks"));
    await expectPathMissing(join(workspaceRoot, "tasks", "_idempotency"));
  });

  test("POST /api/tasks concurrent same-key creates converge on one completed result", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    let nextId = 0;
    const idempotencyKey = "task:create:concurrent";
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:55.000Z"),
      taskIdFactory: () => {
        nextId += 1;
        return `TASK-idempotent-concurrent-${nextId}`;
      }
    });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        postTask(app, validTaskCreateBody(), { "Idempotency-Key": idempotencyKey })
      )
    );
    const tasks = (await Promise.all(responses.map((response) => response.json()))) as TaskCard[];
    const statuses = responses.map((response) => response.status).sort();
    const uniqueSerializedTasks = Array.from(new Set(tasks.map((task) => JSON.stringify(task))));
    expect(uniqueSerializedTasks).toHaveLength(1);
    const firstTask = JSON.parse(uniqueSerializedTasks[0] as string) as TaskCard;
    const idempotencyRecord = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(nextId).toBe(1);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [firstTask]
    });
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([firstTask.task_id]);
    expect(idempotencyRecord?.status).toBe("completed");
    expect(idempotencyRecord?.result_ref).toBe(firstTask.task_id);
  });

  test("POST /api/tasks concurrent same-key creates converge across backend app instances", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:cross-app-concurrent";
    const firstApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:56.000Z"),
      taskIdFactory: () => "TASK-cross-app-a"
    });
    const secondApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:56.000Z"),
      taskIdFactory: () => "TASK-cross-app-b"
    });

    const responses = await Promise.all([
      postTask(firstApp, validTaskCreateBody(), { "Idempotency-Key": idempotencyKey }),
      postTask(secondApp, validTaskCreateBody(), { "Idempotency-Key": idempotencyKey })
    ]);
    const tasks = (await Promise.all(responses.map((response) => response.json()))) as TaskCard[];
    const statuses = responses.map((response) => response.status).sort();
    const idempotencyRecord = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(statuses).toEqual([200, 201]);
    expect(tasks[1]).toEqual(tasks[0]);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([tasks[0].task_id]);
    expect(idempotencyRecord?.status).toBe("completed");
    expect(idempotencyRecord?.result_ref).toBe(tasks[0].task_id);
  });

  test("POST /api/tasks rejects a different digest before the first owner publishes its record", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:pre-durable-owner";
    let releaseFirstBegin!: () => void;
    const firstBeginRelease = new Promise<void>((resolveRelease) => {
      releaseFirstBegin = resolveRelease;
    });
    let resolveFirstBeginEntered!: () => void;
    const firstBeginEntered = new Promise<void>((resolveEntered) => {
      resolveFirstBeginEntered = resolveEntered;
    });
    let shouldBlockFirstBegin = true;
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:56.050Z"),
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return `TASK-pre-durable-owner-${taskIdFactoryCalls}`;
      },
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          beginRecord: async (input) => {
            if (shouldBlockFirstBegin) {
              shouldBlockFirstBegin = false;
              resolveFirstBeginEntered();
              await firstBeginRelease;
            }
            return await service.beginRecord(input);
          }
        };
      }
    });

    const ownerRequest = postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    await firstBeginEntered;

    try {
      const mismatchResponse = await Promise.race([
        postTask(app, validTaskCreateBody({ title: "Different pre-durable digest" }), {
          "Idempotency-Key": idempotencyKey
        }),
        timeoutAfter(1_000, "pre-durable digest mismatch waited for the active owner")
      ]);
      const mismatchBody = (await mismatchResponse.json()) as ApiErrorResponse;

      expect(mismatchResponse.status).toBe(422);
      expectCanonicalError(mismatchBody, "idempotency_mismatch");
      expectNoAbsoluteWorkspacePath(mismatchBody, tempRoot, workspaceRoot);
      expect(JSON.stringify(mismatchBody)).not.toContain(idempotencyKey);
      expect(taskIdFactoryCalls).toBe(0);
      await expectPathMissing(join(workspaceRoot, "tasks"));
    } finally {
      releaseFirstBegin();
    }

    const ownerResponse = await ownerRequest;
    const ownerTask = (await ownerResponse.json()) as TaskCard;
    const replayResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const replayTask = (await replayResponse.json()) as TaskCard;
    const record = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(ownerResponse.status).toBe(201);
    expect(replayResponse.status).toBe(200);
    expect(replayTask).toEqual(ownerTask);
    expect(taskIdFactoryCalls).toBe(1);
    expect(record?.status).toBe("completed");
    expect(record?.result_ref).toBe(ownerTask.task_id);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([ownerTask.task_id]);
  });

  test("POST /api/tasks active same-key create delayed past replay timeout converges in one app", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:delayed-active";
    let resolveHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolveHook) => {
      resolveHookStarted = resolveHook;
    });
    let hookCalls = 0;
    let nextId = 0;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:56.100Z"),
      taskIdFactory: () => {
        nextId += 1;
        return `TASK-delayed-active-${nextId}`;
      },
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async () => {
          hookCalls += 1;
          resolveHookStarted();
          await sleep(1_100);
        }
      }
    });

    const firstRequest = postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    await hookStarted;
    const responses = await Promise.all([
      firstRequest,
      postTask(app, validTaskCreateBody(), { "Idempotency-Key": idempotencyKey })
    ]);
    const tasks = (await Promise.all(responses.map((response) => response.json()))) as TaskCard[];
    const statuses = responses.map((response) => response.status).sort();
    const replayResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const replayTask = (await replayResponse.json()) as TaskCard;
    const idempotencyRecord = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(statuses).toEqual([200, 201]);
    expect(tasks[1]).toEqual(tasks[0]);
    expect(replayResponse.status).toBe(200);
    expect(replayTask).toEqual(tasks[0]);
    expect(hookCalls).toBe(1);
    expect(nextId).toBe(1);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([tasks[0].task_id]);
    expect(idempotencyRecord?.status).toBe("completed");
    expect(idempotencyRecord?.result_ref).toBe(tasks[0].task_id);
  });

  test(
    "POST /api/tasks bounds an active same-key follower without releasing the owner",
    async () => {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const idempotencyKey = "task:create:bounded-active-follower";
      let releaseOwner!: () => void;
      const ownerRelease = new Promise<void>((resolveRelease) => {
        releaseOwner = resolveRelease;
      });
      let resolveHookStarted!: () => void;
      const hookStarted = new Promise<void>((resolveStarted) => {
        resolveHookStarted = resolveStarted;
      });
      let taskIdFactoryCalls = 0;
      const app = createBackendApi({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:56.150Z"),
        taskIdFactory: () => {
          taskIdFactoryCalls += 1;
          return `TASK-bounded-active-follower-${taskIdFactoryCalls}`;
        },
        taskSnapshotWriteHooks: {
          afterSnapshotWrite: async () => {
            resolveHookStarted();
            await ownerRelease;
          }
        }
      });

      const ownerRequest = postTask(app, validTaskCreateBody(), {
        "Idempotency-Key": idempotencyKey
      });
      await hookStarted;

      try {
        const followerResponse = await Promise.race([
          postTask(app, validTaskCreateBody(), { "Idempotency-Key": idempotencyKey }),
          timeoutAfter(7_000, "active same-key follower exceeded its bounded wait")
        ]);
        const followerBody = (await followerResponse.json()) as ApiErrorResponse;
        const activeRecord = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
          "task",
          idempotencyKey
        );

        expect(followerResponse.status).toBe(409);
        expectCanonicalError(followerBody, "workspace_error");
        expect(followerBody.error.message).toBe(
          "Active idempotent task create did not finish before the follower wait timeout."
        );
        expect(followerBody.error.retryable).toBe(true);
        expect(followerBody.error.evidence_refs).toEqual([
          "workspace/tasks/_idempotency/task"
        ]);
        expectNoAbsoluteWorkspacePath(followerBody, tempRoot, workspaceRoot);
        expect(taskIdFactoryCalls).toBe(1);
        expect(activeRecord?.status).toBe("started");
        expect(activeRecord?.result_ref).toBeUndefined();
        expect(await taskSnapshotIds(workspaceRoot)).toEqual([
          "TASK-bounded-active-follower-1"
        ]);
      } finally {
        releaseOwner();
      }

      const ownerResponse = await ownerRequest;
      const ownerTask = (await ownerResponse.json()) as TaskCard;
      const replayResponse = await postTask(app, validTaskCreateBody(), {
        "Idempotency-Key": idempotencyKey
      });
      const replayTask = (await replayResponse.json()) as TaskCard;
      const completedRecord = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
        "task",
        idempotencyKey
      );

      expect(ownerResponse.status).toBe(201);
      expect(replayResponse.status).toBe(200);
      expect(replayTask).toEqual(ownerTask);
      expect(taskIdFactoryCalls).toBe(1);
      expect(completedRecord?.status).toBe("completed");
      expect(completedRecord?.result_ref).toBe(ownerTask.task_id);
      expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([ownerTask.task_id]);
    },
    12_000
  );

  test("POST /api/tasks active same-key create delayed past replay timeout converges across app instances", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:delayed-cross-app";
    let resolveHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolveHook) => {
      resolveHookStarted = resolveHook;
    });
    let secondTaskIdFactoryCalls = 0;
    const firstApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:56.200Z"),
      taskIdFactory: () => "TASK-delayed-cross-app-a",
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async () => {
          resolveHookStarted();
          await sleep(1_100);
        }
      }
    });
    const secondApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:56.200Z"),
      taskIdFactory: () => {
        secondTaskIdFactoryCalls += 1;
        return "TASK-delayed-cross-app-b";
      }
    });

    const firstRequest = postTask(firstApp, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    await hookStarted;
    const responses = await Promise.all([
      firstRequest,
      postTask(secondApp, validTaskCreateBody(), { "Idempotency-Key": idempotencyKey })
    ]);
    const tasks = (await Promise.all(responses.map((response) => response.json()))) as TaskCard[];
    const statuses = responses.map((response) => response.status).sort();
    const idempotencyRecord = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(statuses).toEqual([200, 201]);
    expect(tasks[1]).toEqual(tasks[0]);
    expect(secondTaskIdFactoryCalls).toBe(0);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([tasks[0].task_id]);
    expect(idempotencyRecord?.status).toBe("completed");
    expect(idempotencyRecord?.result_ref).toBe(tasks[0].task_id);
  });

  test("POST /api/tasks in-flight convergence isolates normalized workspaces", async () => {
    const first = await createTempWorkspacePath();
    const second = await createTempWorkspacePath();
    tempRoots.push(first.tempRoot, second.tempRoot);
    const idempotencyKey = "task:create:workspace-isolated";
    let resolveHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolveHook) => {
      resolveHookStarted = resolveHook;
    });
    const firstApp = createBackendApi({
      workspaceRoot: join(first.workspaceRoot, "."),
      now: fixedNow("2026-07-07T12:03:56.300Z"),
      taskIdFactory: () => "TASK-workspace-isolated-a",
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async () => {
          resolveHookStarted();
          await sleep(1_100);
        }
      }
    });
    const secondApp = createBackendApi({
      workspaceRoot: second.workspaceRoot,
      now: fixedNow("2026-07-07T12:03:56.300Z"),
      taskIdFactory: () => "TASK-workspace-isolated-b"
    });

    const firstRequest = postTask(firstApp, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    await hookStarted;
    const secondResponse = await postTask(secondApp, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const firstResponse = await firstRequest;
    const firstTask = (await firstResponse.json()) as TaskCard;
    const secondTask = (await secondResponse.json()) as TaskCard;
    const firstRecord = await createIdempotencyRecordService({
      workspaceRoot: first.workspaceRoot
    }).getRecord("task", idempotencyKey);
    const secondRecord = await createIdempotencyRecordService({
      workspaceRoot: second.workspaceRoot
    }).getRecord("task", idempotencyKey);

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(firstTask.task_id).toBe("TASK-workspace-isolated-a");
    expect(secondTask.task_id).toBe("TASK-workspace-isolated-b");
    expect(await taskSnapshotIds(first.workspaceRoot)).toEqual([firstTask.task_id]);
    expect(await taskSnapshotIds(second.workspaceRoot)).toEqual([secondTask.task_id]);
    expect(firstRecord?.result_ref).toBe(firstTask.task_id);
    expect(secondRecord?.result_ref).toBe(secondTask.task_id);
  });

  test("POST /api/tasks active distinct keys in one workspace complete independently", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const firstKey = "task:create:active-distinct-a";
    const secondKey = "task:create:active-distinct-b";
    let releaseFirstOwner!: () => void;
    const firstOwnerRelease = new Promise<void>((resolveRelease) => {
      releaseFirstOwner = resolveRelease;
    });
    let resolveFirstHookStarted!: () => void;
    const firstHookStarted = new Promise<void>((resolveStarted) => {
      resolveFirstHookStarted = resolveStarted;
    });
    let nextId = 0;
    const app = createBackendApi({
      workspaceRoot: join(workspaceRoot, "."),
      now: fixedNow("2026-07-07T12:03:56.350Z"),
      taskIdFactory: () => {
        nextId += 1;
        return nextId === 1 ? "TASK-active-distinct-a" : "TASK-active-distinct-b";
      },
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async ({ taskId }) => {
          if (taskId !== "TASK-active-distinct-a") {
            return;
          }
          resolveFirstHookStarted();
          await firstOwnerRelease;
        }
      }
    });

    let firstOwnerSettled = false;
    const firstRequest = postTask(
      app,
      validTaskCreateBody({ title: "Independent owner A" }),
      { "Idempotency-Key": firstKey }
    ).finally(() => {
      firstOwnerSettled = true;
    });
    await firstHookStarted;

    let secondResponse: Response;
    try {
      secondResponse = await Promise.race([
        postTask(app, validTaskCreateBody({ title: "Independent owner B" }), {
          "Idempotency-Key": secondKey
        }),
        timeoutAfter(2_000, "distinct-key task create waited for the active first owner")
      ]);
      expect(secondResponse.status).toBe(201);
      expect(firstOwnerSettled).toBe(false);
    } finally {
      releaseFirstOwner();
    }

    const firstResponse = await firstRequest;
    const firstTask = (await firstResponse.json()) as TaskCard;
    const secondTask = (await secondResponse.json()) as TaskCard;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const [firstRecord, secondRecord] = await Promise.all([
      idempotencyService.getRecord("task", firstKey),
      idempotencyService.getRecord("task", secondKey)
    ]);

    expect(firstResponse.status).toBe(201);
    expect(firstTask.task_id).toBe("TASK-active-distinct-a");
    expect(firstTask.title).toBe("Independent owner A");
    expect(secondTask.task_id).toBe("TASK-active-distinct-b");
    expect(secondTask.title).toBe("Independent owner B");
    expect(firstRecord?.status).toBe("completed");
    expect(firstRecord?.result_ref).toBe(firstTask.task_id);
    expect(secondRecord?.status).toBe("completed");
    expect(secondRecord?.result_ref).toBe(secondTask.task_id);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([
      firstTask.task_id,
      secondTask.task_id
    ]);
  });

  test(
    "POST /api/tasks successful owners release bounded in-flight capacity",
    async () => {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      let nextId = 0;
      const app = createBackendApi({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:56.375Z"),
        requestLogSink: () => undefined,
        taskIdFactory: () => {
          nextId += 1;
          return `TASK-capacity-cleanup-${String(nextId).padStart(4, "0")}`;
        }
      });

      let finalTask: TaskCard | undefined;
      for (let index = 0; index <= IN_FLIGHT_TASK_CREATE_LIMIT; index += 1) {
        const response = await postTask(app, validTaskCreateBody(), {
          "Idempotency-Key": `task:create:capacity-cleanup:${index}`
        });
        expect(response.status).toBe(201);
        finalTask = (await response.json()) as TaskCard;
      }

      expect(nextId).toBe(IN_FLIGHT_TASK_CREATE_LIMIT + 1);
      expect(finalTask?.task_id).toBe("TASK-capacity-cleanup-1025");
      const finalRecord = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
        "task",
        `task:create:capacity-cleanup:${IN_FLIGHT_TASK_CREATE_LIMIT}`
      );
      expect(finalRecord?.status).toBe("completed");
      expect(finalRecord?.result_ref).toBe(finalTask?.task_id);
    },
    30_000
  );

  test("POST /api/tasks active same-key digest mismatch stays 422 and does not join owner", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:active-mismatch";
    let resolveHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolveHook) => {
      resolveHookStarted = resolveHook;
    });
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:56.400Z"),
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return `TASK-active-mismatch-${taskIdFactoryCalls}`;
      },
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async () => {
          resolveHookStarted();
          await sleep(1_100);
        }
      }
    });

    const firstRequest = postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    await hookStarted;
    const mismatchResponse = await postTask(
      app,
      validTaskCreateBody({ title: "Changed while owner is active" }),
      { "Idempotency-Key": idempotencyKey }
    );
    const mismatchBody = (await mismatchResponse.json()) as ApiErrorResponse;
    const firstResponse = await firstRequest;
    const firstTask = (await firstResponse.json()) as TaskCard;

    expect(firstResponse.status).toBe(201);
    expect(mismatchResponse.status).toBe(422);
    expectCanonicalError(mismatchBody, "idempotency_mismatch");
    expect(taskIdFactoryCalls).toBe(1);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([firstTask.task_id]);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [firstTask]
    });
  });

  test("POST /api/tasks blocked idempotency path fails before task state and succeeds after repair", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:blocked-idempotency-path";
    await mkdir(join(workspaceRoot, "tasks"), { recursive: true });
    await writeFile(join(workspaceRoot, "tasks", "_idempotency"), "blocked", { flag: "wx" });
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.000Z"),
      taskIdFactory: () => "TASK-after-idempotency-repair"
    });

    const failedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([]);

    await rm(join(workspaceRoot, "tasks", "_idempotency"), { force: true });
    const repairedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const repairedTask = (await repairedResponse.json()) as TaskCard;
    const idempotencyRecord = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(repairedResponse.status).toBe(201);
    expect(repairedTask.task_id).toBe("TASK-after-idempotency-repair");
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([repairedTask.task_id]);
    expect(idempotencyRecord?.status).toBe("completed");
    expect(idempotencyRecord?.result_ref).toBe(repairedTask.task_id);
  });

  test("POST /api/tasks failed task persistence marks claim failed and retries after repair", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:claim-succeeds-task-fails";
    const taskIds = ["TASK-claim-fails", "TASK-claim-retry"];
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.500Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-unexpected-extra"
    });

    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: []
    });
    await mkdir(join(workspaceRoot, "tasks"), { recursive: true });
    await writeFile(join(workspaceRoot, "tasks", "TASK-claim-fails"), "blocked lane", {
      flag: "wx"
    });

    const failedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-claim-fails", "snapshot.json"));
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-claim-retry"));

    await rm(join(workspaceRoot, "tasks", "TASK-claim-fails"), { force: true });
    const repairedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const repairedTask = (await repairedResponse.json()) as TaskCard;
    const recordAfterRepair = await idempotencyService.getRecord("task", idempotencyKey);

    expect(repairedResponse.status).toBe(201);
    expect(repairedTask.task_id).toBe("TASK-claim-retry");
    expect(taskIds).toEqual([]);
    expect(recordAfterRepair?.status).toBe("completed");
    expect(recordAfterRepair?.result_ref).toBe(repairedTask.task_id);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([repairedTask.task_id]);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [repairedTask]
    });
  });

  test("POST /api/tasks cleans a published snapshot when afterSnapshotWrite throws before retry", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:after-snapshot-hook-throws";
    const taskIds = ["TASK-hook-throws-orphan", "TASK-hook-throws-retry"];
    let shouldThrowAfterPublish = true;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.600Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-unexpected-hook-throws-extra",
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: () => {
          if (!shouldThrowAfterPublish) {
            return;
          }
          shouldThrowAfterPublish = false;
          throw new Error("after snapshot publish failure");
        }
      }
    });

    const failedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([]);
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-hook-throws-orphan", "snapshot.json"));

    const retryResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const retryTask = (await retryResponse.json()) as TaskCard;
    const freshApp = createBackendApi({ workspaceRoot });
    const freshListResponse = await freshApp.request("/api/tasks");

    expect(retryResponse.status).toBe(201);
    expect(retryTask.task_id).toBe("TASK-hook-throws-retry");
    expect(taskIds).toEqual([]);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([retryTask.task_id]);
    expect(freshListResponse.status).toBe(200);
    expect(await freshListResponse.json()).toEqual({ tasks: [retryTask] });
  });

  test("POST /api/tasks fails closed when afterSnapshotWrite deletes snapshot and returns", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:after-snapshot-deletes";
    const taskIds = ["TASK-hook-deletes-orphan", "TASK-hook-deletes-retry"];
    let shouldDeleteSnapshot = true;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.605Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-unexpected-hook-deletes-extra",
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async ({ taskDirectory }) => {
          if (!shouldDeleteSnapshot) {
            return;
          }
          shouldDeleteSnapshot = false;
          await rm(join(taskDirectory, "snapshot.json"));
        }
      }
    });

    const failedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
    const listAfterFailure = await app.request("/api/tasks");

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(listAfterFailure.status).toBe(200);
    expect(await listAfterFailure.json()).toEqual({ tasks: [] });
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([]);
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-hook-deletes-orphan", "snapshot.json"));

    const retryResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const retryTask = (await retryResponse.json()) as TaskCard;
    const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);
    const freshApp = createBackendApi({ workspaceRoot });
    const freshListResponse = await freshApp.request("/api/tasks");

    expect(retryResponse.status).toBe(201);
    expect(retryTask.task_id).toBe("TASK-hook-deletes-retry");
    expect(taskIds).toEqual([]);
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(retryTask.task_id);
    expect(freshListResponse.status).toBe(200);
    expect(await freshListResponse.json()).toEqual({ tasks: [retryTask] });
  });

  test("POST /api/tasks fails closed when afterSnapshotWrite corrupts snapshot and returns", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:after-snapshot-corrupts";
    const taskIds = ["TASK-hook-corrupts-orphan", "TASK-hook-corrupts-retry"];
    let shouldCorruptSnapshot = true;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.606Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-unexpected-hook-corrupts-extra",
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async ({ taskDirectory }) => {
          if (!shouldCorruptSnapshot) {
            return;
          }
          shouldCorruptSnapshot = false;
          await writeFile(join(taskDirectory, "snapshot.json"), "{");
        }
      }
    });

    const failedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
    const listAfterFailure = await app.request("/api/tasks");

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(listAfterFailure.status).toBe(200);
    expect(await listAfterFailure.json()).toEqual({ tasks: [] });
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([]);

    const retryResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const retryTask = (await retryResponse.json()) as TaskCard;
    const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);

    expect(retryResponse.status).toBe(201);
    expect(retryTask.task_id).toBe("TASK-hook-corrupts-retry");
    expect(taskIds).toEqual([]);
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(retryTask.task_id);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([retryTask.task_id]);
  });

  test("POST /api/tasks rejects schema-valid outer snapshot drift before idempotency completion", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:after-snapshot-outer-drift";
    const taskIds = ["TASK-hook-outer-drift", "TASK-hook-outer-drift-retry"];
    let shouldDriftSnapshot = true;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.607Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-unexpected-outer-drift-extra",
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async ({ taskDirectory }) => {
          if (!shouldDriftSnapshot) {
            return;
          }
          shouldDriftSnapshot = false;
          const snapshotPath = join(taskDirectory, "snapshot.json");
          const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as TaskSnapshot;
          snapshot.linked_runs = ["RUN-hook-outer-drift"];
          await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
        }
      }
    });

    const failedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
    const listAfterFailure = await app.request("/api/tasks");

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(listAfterFailure.status).toBe(200);
    expect(await listAfterFailure.json()).toEqual({ tasks: [] });
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-hook-outer-drift", "snapshot.json"));

    const retryResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const retryTask = (await retryResponse.json()) as TaskCard;
    const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);

    expect(retryResponse.status).toBe(201);
    expect(retryTask.task_id).toBe("TASK-hook-outer-drift-retry");
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(retryTask.task_id);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([retryTask.task_id]);
  });

  test("POST /api/tasks rejects unknown top-level fields added to producer snapshot bytes", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:after-snapshot-unknown-top-level";
    const taskIds = ["TASK-hook-unknown-top", "TASK-hook-unknown-top-retry"];
    let shouldAddUnknownField = true;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.6075Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-unexpected-unknown-top-extra",
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async ({ taskDirectory }) => {
          if (!shouldAddUnknownField) {
            return;
          }
          shouldAddUnknownField = false;
          const snapshotPath = join(taskDirectory, "snapshot.json");
          const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<
            string,
            unknown
          >;
          snapshot.unknown_producer_field = "must not be stripped before verification";
          await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
        }
      }
    });

    const failedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: []
    });
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-hook-unknown-top", "snapshot.json"));

    const retryResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const retryTask = (await retryResponse.json()) as TaskCard;
    const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);

    expect(retryResponse.status).toBe(201);
    expect(retryTask.task_id).toBe("TASK-hook-unknown-top-retry");
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(retryTask.task_id);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([retryTask.task_id]);
  });

  test("POST /api/tasks quarantines a directory replacement at the snapshot leaf", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:after-snapshot-directory";
    const taskIds = ["TASK-hook-directory", "TASK-hook-directory-retry"];
    let shouldReplaceSnapshot = true;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.608Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-unexpected-directory-extra",
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async ({ taskDirectory }) => {
          if (!shouldReplaceSnapshot) {
            return;
          }
          shouldReplaceSnapshot = false;
          const snapshotPath = join(taskDirectory, "snapshot.json");
          await rm(snapshotPath);
          await mkdir(snapshotPath);
          await writeFile(join(snapshotPath, "nested.txt"), "untrusted replacement");
        }
      }
    });

    const failedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
    const freshApp = createBackendApi({ workspaceRoot });
    const freshListResponse = await freshApp.request("/api/tasks");

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-hook-directory", "snapshot.json"));
    expect(freshListResponse.status).toBe(200);
    expect(await freshListResponse.json()).toEqual({ tasks: [] });

    const retryResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const retryTask = (await retryResponse.json()) as TaskCard;
    const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);

    expect(retryResponse.status).toBe(201);
    expect(retryTask.task_id).toBe("TASK-hook-directory-retry");
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(retryTask.task_id);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([retryTask.task_id]);
  });

  test("POST /api/tasks does not follow a swapped task lane symlink during failed snapshot cleanup", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:after-snapshot-hook-swaps-lane";
    const outsideLane = join(tempRoot, "outside-lane");
    const outsideSnapshot = join(outsideLane, "snapshot.json");
    const outsideSnapshotText = "outside snapshot must survive\n";
    let swappedLane = false;
    await mkdir(outsideLane, { recursive: true });
    await writeFile(outsideSnapshot, outsideSnapshotText, { flag: "wx" });
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.610Z"),
      taskIdFactory: () => "TASK-hook-swaps-lane",
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async ({ taskDirectory }) => {
          if (swappedLane) {
            return;
          }
          swappedLane = true;
          await rm(taskDirectory, { recursive: true, force: true });
          await symlink(outsideLane, taskDirectory);
          throw new Error("after snapshot publish lane swap");
        }
      }
    });

    const failedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(swappedLane).toBe(true);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(await readFile(outsideSnapshot, "utf8")).toBe(outsideSnapshotText);
  });

  test("POST /api/tasks rolls back snapshot when idempotency completion fails", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:complete-fails-after-snapshot";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(canonicalJson(taskBody));
    const taskIds = ["TASK-complete-fails", "TASK-complete-retry"];
    let poisonedCompletion = false;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.625Z"),
      taskIdFactory: () => {
        const taskId = taskIds.shift() ?? "TASK-unexpected-complete-extra";
        if (!poisonedCompletion) {
          poisonedCompletion = true;
          writeFileSync(
            join(
              workspaceRoot,
              "tasks",
              "_idempotency",
              "task",
              idempotencyRecordFileName(idempotencyKey)
            ),
            `${JSON.stringify(
              {
                key: idempotencyKey,
                scope: "task",
                request_digest: requestDigest,
                status: "failed",
                created_at: "2026-07-07T12:03:57.625Z",
                updated_at: "2026-07-07T12:03:57.625Z"
              },
              null,
              2
            )}\n`
          );
        }
        return taskId;
      }
    });

    const failedResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);

    expect(failedResponse.status).toBe(400);
    expectCanonicalError(failedBody, "schema_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-complete-fails"));
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([]);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: []
    });

    const repairedResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const repairedTask = (await repairedResponse.json()) as TaskCard;
    const recordAfterRepair = await idempotencyService.getRecord("task", idempotencyKey);
    const idempotencyFiles = await readdir(join(workspaceRoot, "tasks", "_idempotency", "task"));

    expect(repairedResponse.status).toBe(201);
    expect(repairedTask.task_id).toBe("TASK-complete-retry");
    expect(taskIds).toEqual([]);
    expect(recordAfterRepair?.status).toBe("completed");
    expect(recordAfterRepair?.result_ref).toBe(repairedTask.task_id);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([repairedTask.task_id]);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [repairedTask]
    });
    expect(idempotencyFiles).toEqual([idempotencyRecordFileName(idempotencyKey)]);
  });

  test("POST /api/tasks recovers a malformed transition guard after completion rollback", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:malformed-guard-route-retry";
    const taskIds = ["TASK-malformed-guard-first", "TASK-malformed-guard-retry"];
    let poisonedGuard = false;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.635Z"),
      taskIdFactory: () => {
        const taskId = taskIds.shift() ?? "TASK-unexpected-malformed-guard-extra";
        if (!poisonedGuard) {
          poisonedGuard = true;
          writeFileSync(
            join(
              workspaceRoot,
              "tasks",
              "_idempotency",
              "task",
              `${sha256Hex(`transition:${idempotencyKey}`)}.guard.json`
            ),
            "{"
          );
        }
        return taskId;
      }
    });

    const failedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([]);

    const repairedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const repairedTask = (await repairedResponse.json()) as TaskCard;
    const recordAfterRepair = await idempotencyService.getRecord("task", idempotencyKey);
    const idempotencyFiles = await readdir(join(workspaceRoot, "tasks", "_idempotency", "task"));

    expect(repairedResponse.status).toBe(201);
    expect(repairedTask.task_id).toBe("TASK-malformed-guard-retry");
    expect(taskIds).toEqual([]);
    expect(recordAfterRepair?.status).toBe("completed");
    expect(recordAfterRepair?.result_ref).toBe(repairedTask.task_id);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([repairedTask.task_id]);
    expect(idempotencyFiles).toEqual([idempotencyRecordFileName(idempotencyKey)]);
  });

  test("POST /api/tasks quarantines idempotency state when completion and rollback cannot prove the snapshot", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:rollback-failure-bound";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(canonicalJson(taskBody));
    let taskIdFactoryCalls = 0;
    let poisonedCompletion = false;
    let snapshotOpenCount = 0;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.640Z"),
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        if (!poisonedCompletion) {
          poisonedCompletion = true;
          writeFileSync(
            join(
              workspaceRoot,
              "tasks",
              "_idempotency",
              "task",
              idempotencyRecordFileName(idempotencyKey)
            ),
            `${JSON.stringify(
              {
                key: idempotencyKey,
                scope: "task",
                request_digest: requestDigest,
                status: "failed",
                created_at: "2026-07-07T12:03:57.640Z",
                updated_at: "2026-07-07T12:03:57.640Z"
              },
              null,
              2
            )}\n`
          );
        }
        return taskIdFactoryCalls === 1
          ? "TASK-rollback-failure-original"
          : "TASK-rollback-failure-duplicate";
      },
      taskSnapshotReadHooks: {
        beforeSnapshotOpen: async ({ snapshotPath, laneTaskId }) => {
          if (laneTaskId !== "TASK-rollback-failure-original") {
            return;
          }
          snapshotOpenCount += 1;
          if (snapshotOpenCount === 2) {
            await rm(snapshotPath);
            await mkdir(snapshotPath);
          }
        }
      }
    });

    const failedResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
    const listAfterFailure = await app.request("/api/tasks");
    const detailAfterFailure = await app.request(
      "/api/tasks/TASK-rollback-failure-original"
    );
    const detailBody = (await detailAfterFailure.json()) as ApiErrorResponse;
    const freshListAfterFailure = await createBackendApi({ workspaceRoot }).request("/api/tasks");
    const retryResponse = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const retryTask = (await retryResponse.json()) as TaskCard;
    const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);

    expect(failedResponse.status).toBe(400);
    expectCanonicalError(failedBody, "schema_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(listAfterFailure.status).toBe(200);
    expect(await listAfterFailure.json()).toEqual({ tasks: [] });
    expect(detailAfterFailure.status).toBe(404);
    expectCanonicalError(detailBody, "not_found");
    expect(freshListAfterFailure.status).toBe(200);
    expect(await freshListAfterFailure.json()).toEqual({ tasks: [] });
    await expectPathMissing(
      join(workspaceRoot, "tasks", "TASK-rollback-failure-original", "snapshot.json")
    );
    expect(retryResponse.status).toBe(201);
    expect(retryTask.task_id).toBe("TASK-rollback-failure-duplicate");
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(retryTask.task_id);
    expect(taskIdFactoryCalls).toBe(2);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([retryTask.task_id]);
  });

  test("POST /api/tasks rollback preserves existing lane files and leaves failed claim retryable", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:existing-lane-rollback";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(canonicalJson(taskBody));
    const taskIds = ["TASK-existing-lane", "TASK-existing-lane-retry"];
    const taskLane = join(workspaceRoot, "tasks", "TASK-existing-lane");
    const sentinelPath = join(taskLane, "sentinel.txt");
    let poisonedCompletion = false;
    await mkdir(taskLane, { recursive: true });
    await writeFile(sentinelPath, "preserve lane sentinel", { flag: "wx" });
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.650Z"),
      taskIdFactory: () => {
        const taskId = taskIds.shift() ?? "TASK-unexpected-existing-lane-extra";
        if (!poisonedCompletion) {
          poisonedCompletion = true;
          writeFileSync(
            join(
              workspaceRoot,
              "tasks",
              "_idempotency",
              "task",
              idempotencyRecordFileName(idempotencyKey)
            ),
            `${JSON.stringify(
              {
                key: idempotencyKey,
                scope: "task",
                request_digest: requestDigest,
                status: "failed",
                created_at: "2026-07-07T12:03:57.650Z",
                updated_at: "2026-07-07T12:03:57.650Z"
              },
              null,
              2
            )}\n`
          );
        }
        return taskId;
      }
    });

    const failedResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);

    expect(failedResponse.status).toBe(400);
    expectCanonicalError(failedBody, "schema_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(await readFile(sentinelPath, "utf8")).toBe("preserve lane sentinel");
    await expectPathMissing(join(taskLane, "snapshot.json"));
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([]);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: []
    });
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();

    const repairedResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const repairedTask = (await repairedResponse.json()) as TaskCard;
    const recordAfterRepair = await idempotencyService.getRecord("task", idempotencyKey);

    expect(repairedResponse.status).toBe(201);
    expect(repairedTask.task_id).toBe("TASK-existing-lane-retry");
    expect(taskIds).toEqual([]);
    expect(await readFile(sentinelPath, "utf8")).toBe("preserve lane sentinel");
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([repairedTask.task_id]);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [repairedTask]
    });
    expect(recordAfterRepair?.status).toBe("completed");
    expect(recordAfterRepair?.result_ref).toBe(repairedTask.task_id);
  });

  test("POST /api/tasks concurrent failed-claim retries converge across backend app instances", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:failed-concurrent-route-retry";
    await mkdir(join(workspaceRoot, "tasks"), { recursive: true });
    await writeFile(join(workspaceRoot, "tasks", "TASK-route-failed-retry"), "blocked lane", {
      flag: "wx"
    });
    const failingApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.750Z"),
      taskIdFactory: () => "TASK-route-failed-retry"
    });
    const failedResponse = await postTask(failingApp, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("failed");
    await expectPathMissing(
      join(workspaceRoot, "tasks", "TASK-route-failed-retry", "snapshot.json")
    );

    await rm(join(workspaceRoot, "tasks", "TASK-route-failed-retry"), { force: true });
    const firstRetryApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:58.000Z"),
      taskIdFactory: () => "TASK-route-retry-a"
    });
    const secondRetryApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:58.000Z"),
      taskIdFactory: () => "TASK-route-retry-b"
    });

    const retryResponses = await Promise.all([
      postTask(firstRetryApp, validTaskCreateBody(), { "Idempotency-Key": idempotencyKey }),
      postTask(secondRetryApp, validTaskCreateBody(), { "Idempotency-Key": idempotencyKey })
    ]);
    const retryTasks = (await Promise.all(
      retryResponses.map((response) => response.json())
    )) as TaskCard[];
    const statuses = retryResponses.map((response) => response.status).sort();
    const uniqueSerializedTasks = Array.from(new Set(retryTasks.map((task) => JSON.stringify(task))));
    const createdTask = JSON.parse(uniqueSerializedTasks[0] as string) as TaskCard;
    const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);

    expect(statuses).toEqual([200, 201]);
    expect(uniqueSerializedTasks).toHaveLength(1);
    expect(["TASK-route-retry-a", "TASK-route-retry-b"]).toContain(createdTask.task_id);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([createdTask.task_id]);
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(createdTask.task_id);
  });

  test("POST /api/tasks failed create retry does not leave a poisoned completed idempotency record", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const outsideTasksRoot = join(tempRoot, "outside-tasks");
    const idempotencyKey = "task:create:failed-retry";
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(outsideTasksRoot);
    await symlink(outsideTasksRoot, join(workspaceRoot, "tasks"), "dir");
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:58.000Z"),
      taskIdFactory: () => "TASK-retry-after-repair"
    });

    const failedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    await rm(join(workspaceRoot, "tasks"), { recursive: true, force: true });
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
    const repairedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const repairedTask = (await repairedResponse.json()) as TaskCard;
    const recordAfterRepair = await idempotencyService.getRecord("task", idempotencyKey);

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure).toBeUndefined();
    expect(repairedResponse.status).toBe(201);
    expect(repairedTask.task_id).toBe("TASK-retry-after-repair");
    expect(recordAfterRepair?.status).toBe("completed");
    expect(recordAfterRepair?.result_ref).toBe(repairedTask.task_id);
    expect(await taskSnapshotIds(workspaceRoot)).toEqual([repairedTask.task_id]);
    await expectPathMissing(join(outsideTasksRoot, "TASK-retry-after-repair"));
  });

  test("POST /api/tasks preserves unrelated files in an existing task lane", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const taskLane = join(workspaceRoot, "tasks", "TASK-preserve-lane");
    const sentinelPath = join(taskLane, "sentinel.txt");
    await mkdir(taskLane, { recursive: true });
    await writeFile(sentinelPath, "keep this file", { flag: "wx" });
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:04:00.000Z"),
      taskIdFactory: () => "TASK-preserve-lane"
    });

    const response = await postTask(app, validTaskCreateBody());

    expect(response.status).toBe(201);
    expect(await readFile(sentinelPath, "utf8")).toBe("keep this file");
    expect((await stat(join(taskLane, "snapshot.json"))).isFile()).toBe(true);
  });

  test("POST /api/tasks rejects invalid request bodies with a canonical schema_error envelope", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({ workspaceRoot });

    const response = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "engineering",
        title: "Missing goal",
        inference_budget: { mode: "normal" }
      })
    });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(400);
    expectCanonicalError(body, "schema_error");
    expect(body.error.evidence_refs).toContain("request.body.question_or_goal");
    await expectPathMissing(join(workspaceRoot, "tasks"));
  });

  test("POST /api/tasks rejects malformed JSON with a canonical schema_error envelope", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({ workspaceRoot });

    const response = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(400);
    expectCanonicalError(body, "schema_error");
    expect(body.error.evidence_refs).toEqual(["request.body"]);
  });

  test("POST /api/tasks rejects invalid enum values without creating task state", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-invalid-enum"
    });

    const response = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...validTaskCreateBody(),
        type: "unsupported"
      })
    });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(400);
    expectCanonicalError(body, "schema_error");
    expect(body.error.evidence_refs).toContain("request.body.type");
    await expectPathMissing(join(workspaceRoot, "tasks"));
  });

  test("POST /api/tasks rejects oversized task snapshots before accepting state", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-too-large"
    });

    const response = await postTask(
      app,
      validTaskCreateBody({
        question_or_goal: "x".repeat(MAX_TASK_SNAPSHOT_BYTES + 1)
      })
    );
    const body = (await response.json()) as ApiErrorResponse;
    const freshApp = createBackendApi({ workspaceRoot });
    const listResponse = await freshApp.request("/api/tasks");

    expect(response.status).toBe(400);
    expectCanonicalError(body, "schema_error");
    expect(body.error.evidence_refs).toEqual(["request.body"]);
    await expectPathMissing(join(workspaceRoot, "tasks"));
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ tasks: [] });
  });

  test("POST /api/tasks rejects oversized keyed requests before digest state", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:oversized-before-digest";
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-oversized-keyed";
      }
    });

    const response = await postTask(
      app,
      validTaskCreateBody({
        question_or_goal: "x".repeat(MAX_TASK_SNAPSHOT_BYTES + 1)
      }),
      { "Idempotency-Key": idempotencyKey }
    );
    const body = (await response.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });

    expect(response.status).toBe(400);
    expectCanonicalError(body, "schema_error");
    expect(body.error.evidence_refs).toEqual(["request.body"]);
    expect(taskIdFactoryCalls).toBe(0);
    expect(await idempotencyService.getRecord("task", idempotencyKey)).toBeUndefined();
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-oversized-keyed"));
  });

  test("POST /api/tasks rejects oversized keyed malformed JSON before parsing body", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:oversized-malformed-before-parse";
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-oversized-malformed-keyed";
      }
    });
    const oversizedMalformedBody = `{"type":"engineering","title":"Oversized","question_or_goal":"${"x".repeat(
      MAX_TASK_SNAPSHOT_BYTES + 1
    )}`;

    const response = await app.request("/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey
      },
      body: oversizedMalformedBody
    });
    const body = (await response.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });

    expect(response.status).toBe(400);
    expectCanonicalError(body, "schema_error");
    expect(body.error.message).toBe(
      "Task create request exceeds the M1 bounded idempotency digest size."
    );
    expect(body.error.evidence_refs).toEqual(["request.body"]);
    expect(taskIdFactoryCalls).toBe(0);
    expect(await idempotencyService.getRecord("task", idempotencyKey)).toBeUndefined();
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-oversized-malformed-keyed"));
  });

  test("POST /api/tasks accepts and recovers large snapshots below the M1 byte cap", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:04:30.000Z"),
      taskIdFactory: () => "TASK-large-under-cap"
    });

    const response = await postTask(
      app,
      validTaskCreateBody({
        question_or_goal: "x".repeat(900_000)
      })
    );
    const task = (await response.json()) as TaskCard;
    const freshApp = createBackendApi({ workspaceRoot });
    const listResponse = await freshApp.request("/api/tasks");

    expect(response.status).toBe(201);
    expect((await stat(join(workspaceRoot, "tasks", task.task_id, "snapshot.json"))).size).toBeLessThanOrEqual(
      MAX_TASK_SNAPSHOT_BYTES
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ tasks: [task] });
  });

  test("unknown API paths and missing task ids return canonical 404 envelopes", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const logs: string[] = [];
    const app = createBackendApi({
      workspaceRoot,
      requestIdFactory: () => "REQ-api-root-not-found",
      requestLogSink: (line) => {
        logs.push(line);
      }
    });

    const apiRootResponse = await app.request("/api");
    const unknownRouteResponse = await app.request("/api/not-registered");
    const missingTaskResponse = await app.request("/api/tasks/TASK-missing");
    const apiRootBody = (await apiRootResponse.json()) as ApiErrorResponse;
    const unknownRouteBody = (await unknownRouteResponse.json()) as ApiErrorResponse;
    const missingTaskBody = (await missingTaskResponse.json()) as ApiErrorResponse;

    expect(apiRootResponse.status).toBe(404);
    expect(apiRootResponse.headers.get(API_REQUEST_ID_HEADER)).toBe("REQ-api-root-not-found");
    expect(unknownRouteResponse.status).toBe(404);
    expect(missingTaskResponse.status).toBe(404);
    expectCanonicalError(apiRootBody, "not_found");
    expectCanonicalError(unknownRouteBody, "not_found");
    expectCanonicalError(missingTaskBody, "not_found");
    expect(apiRootBody.error.message).toContain("API route not found");
    expect(unknownRouteBody.error.message).toContain("API route not found");
    expect(missingTaskBody.error.message).toContain("Task not found");
    await waitFor(() => logs.length === 3, "404 request logs were not emitted");
    const apiRootLog = parseApiRequestLogLine(logs[0] as string);
    expect(apiRootLog).toMatchObject({
      request_id: "REQ-api-root-not-found",
      route: "/api/*",
      status: 404,
      level: "warn"
    });
  });

  test("malformed task snapshots fail closed with a canonical envelope", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    await mkdir(join(workspaceRoot, "tasks", "TASK-malformed"), { recursive: true });
    await writeFile(join(workspaceRoot, "tasks", "TASK-malformed", "snapshot.json"), "{", {
      flag: "wx"
    });
    const app = createBackendApi({ workspaceRoot });

    const response = await app.request("/api/tasks");
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.evidence_refs).toContain("workspace/tasks/TASK-malformed/snapshot.json");
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
  });

  test("symlinked task snapshots fail closed without reading outside the workspace", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const outsideSnapshot = join(tempRoot, "outside-snapshot.json");
    const outsideTask = taskCardFixture("TASK-symlink-snapshot", {
      title: "Outside snapshot must not hydrate"
    });
    await mkdir(join(workspaceRoot, "tasks", "TASK-symlink-snapshot"), { recursive: true });
    await writeTaskSnapshotFixture(outsideSnapshot, outsideTask);
    await symlink(
      outsideSnapshot,
      join(workspaceRoot, "tasks", "TASK-symlink-snapshot", "snapshot.json")
    );
    const app = createBackendApi({ workspaceRoot });

    const response = await app.request("/api/tasks");
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.evidence_refs).toContain("workspace/tasks/TASK-symlink-snapshot/snapshot.json");
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
  });

  test("task snapshot leaf swaps during recovery fail closed without hydrating outside snapshots", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const laneTaskId = "TASK-leaf-swap";
    const taskLane = join(workspaceRoot, "tasks", laneTaskId);
    const snapshotPath = join(taskLane, "snapshot.json");
    const outsideSnapshot = join(tempRoot, "outside-leaf-swap.json");
    await mkdir(taskLane, { recursive: true });
    await writeTaskSnapshotFixture(
      snapshotPath,
      taskCardFixture(laneTaskId, { title: "Original workspace snapshot" })
    );
    await writeTaskSnapshotFixture(
      outsideSnapshot,
      taskCardFixture(laneTaskId, { title: "Outside swapped snapshot must not hydrate" })
    );
    let swapped = false;
    const service = createTaskCardService({
      workspaceRoot,
      snapshotReadHooks: {
        beforeSnapshotOpen: async ({ snapshotPath: candidatePath, laneTaskId: candidateTaskId }) => {
          expect(candidatePath).toBe(snapshotPath);
          expect(candidateTaskId).toBe(laneTaskId);
          swapped = true;
          await rm(candidatePath);
          await symlink(outsideSnapshot, candidatePath);
        }
      }
    });

    try {
      await service.listTasks();
      throw new Error("Expected snapshot leaf swap to fail closed.");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskServiceError);
      const taskError = error as TaskServiceError;
      expect(taskError.code).toBe("task_snapshot_malformed");
      expect(taskError.evidenceRefs).toEqual(["workspace/tasks/TASK-leaf-swap/snapshot.json"]);
    }
    expect(swapped).toBe(true);
  });

  test("task snapshot parent-lane swaps during recovery fail closed without outside hydration", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const laneTaskId = "TASK-parent-swap";
    const taskLane = join(workspaceRoot, "tasks", laneTaskId);
    const snapshotPath = join(taskLane, "snapshot.json");
    const outsideLane = join(tempRoot, "outside-parent-swap");
    await mkdir(taskLane, { recursive: true });
    await mkdir(outsideLane);
    await writeTaskSnapshotFixture(
      snapshotPath,
      taskCardFixture(laneTaskId, { title: "Original workspace snapshot" })
    );
    await writeTaskSnapshotFixture(
      join(outsideLane, "snapshot.json"),
      taskCardFixture(laneTaskId, { title: "Outside parent swap must not hydrate" })
    );
    let swapped = false;
    const service = createTaskCardService({
      workspaceRoot,
      snapshotReadHooks: {
        beforeSnapshotOpen: async () => {
          swapped = true;
          await rm(taskLane, { recursive: true, force: true });
          await symlink(outsideLane, taskLane, "dir");
        }
      }
    });

    try {
      await service.listTasks();
      throw new Error("Expected snapshot parent swap to fail closed.");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskServiceError);
      const taskError = error as TaskServiceError;
      expect(taskError.code).toBe("task_lane_not_directory");
      expect(taskError.evidenceRefs).toEqual(["workspace/tasks/TASK-parent-swap"]);
      expect(JSON.stringify(error)).not.toContain("Outside parent swap must not hydrate");
    }
    expect(swapped).toBe(true);
  });

  test("task snapshot writes reject parent-lane swaps before writing outside", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const outsideLane = join(tempRoot, "outside-write-swap");
    await mkdir(outsideLane);
    let swapped = false;
    const service = createTaskCardService({
      workspaceRoot,
      taskIdFactory: () => "TASK-write-parent-swap",
      snapshotWriteHooks: {
        beforeSnapshotWrite: async ({ taskDirectory }) => {
          swapped = true;
          await rm(taskDirectory, { recursive: true, force: true });
          await symlink(outsideLane, taskDirectory, "dir");
        }
      }
    });

    try {
      await service.createTask(validTaskCreateBody());
      throw new Error("Expected snapshot write parent swap to fail closed.");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskServiceError);
      const taskError = error as TaskServiceError;
      expect(taskError.code).toBe("task_lane_not_directory");
      expect(taskError.evidenceRefs).toEqual(["workspace/tasks/TASK-write-parent-swap"]);
    }
    expect(swapped).toBe(true);
    await expectPathMissing(join(outsideLane, "snapshot.json"));
  });

  test("special-file task snapshots fail closed before opening", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const snapshotPath = join(workspaceRoot, "tasks", "TASK-fifo", "snapshot.json");
    await mkdir(join(workspaceRoot, "tasks", "TASK-fifo"), { recursive: true });
    await execFile("mkfifo", [snapshotPath]);
    const app = createBackendApi({ workspaceRoot });

    const response = await Promise.race([
      app.request("/api/tasks"),
      timeoutAfter(1_000, "GET /api/tasks hung on a special snapshot file")
    ]);
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.evidence_refs).toContain("workspace/tasks/TASK-fifo/snapshot.json");
  });

  test("task snapshot recovery rejects unsafe and mismatched task ids with workspace envelopes", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const tasksRoot = join(workspaceRoot, "tasks");
    await mkdir(join(tasksRoot, "TASK-unsafe-snapshot-id"), { recursive: true });
    await writeTaskSnapshotFixture(
      join(tasksRoot, "TASK-unsafe-snapshot-id", "snapshot.json"),
      taskCardFixture("bad")
    );
    const unsafeApp = createBackendApi({ workspaceRoot });

    const unsafeResponse = await unsafeApp.request("/api/tasks");
    const unsafeBody = (await unsafeResponse.json()) as ApiErrorResponse;

    expect(unsafeResponse.status).toBe(500);
    expectCanonicalError(unsafeBody, "workspace_error");
    expect(unsafeBody.error.evidence_refs).toContain(
      "workspace/tasks/TASK-unsafe-snapshot-id/snapshot.json"
    );
    expect(unsafeBody.error.evidence_refs).toContain("snapshot.task_id");

    await rm(join(tasksRoot, "TASK-unsafe-snapshot-id"), { recursive: true, force: true });
    await mkdir(join(tasksRoot, "TASK-lane-mismatch"), { recursive: true });
    await writeTaskSnapshotFixture(
      join(tasksRoot, "TASK-lane-mismatch", "snapshot.json"),
      taskCardFixture("TASK-other")
    );
    const mismatchApp = createBackendApi({ workspaceRoot });

    const mismatchResponse = await mismatchApp.request("/api/tasks");
    const mismatchBody = (await mismatchResponse.json()) as ApiErrorResponse;

    expect(mismatchResponse.status).toBe(500);
    expectCanonicalError(mismatchBody, "workspace_error");
    expect(mismatchBody.error.evidence_refs).toContain(
      "workspace/tasks/TASK-lane-mismatch/snapshot.json"
    );
    expect(mismatchBody.error.evidence_refs).toContain("snapshot.task_id:TASK-other");
  });

  test("task snapshot recovery rejects nested task_card mismatches and nonzero latest_seq", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const tasksRoot = join(workspaceRoot, "tasks");
    const nestedMismatchTask = taskCardFixture("TASK-nested-mismatch");
    await mkdir(join(tasksRoot, nestedMismatchTask.task_id), { recursive: true });
    await writeTaskSnapshotFixture(
      join(tasksRoot, nestedMismatchTask.task_id, "snapshot.json"),
      nestedMismatchTask,
      {
        task_card: taskCardFixture(nestedMismatchTask.task_id, { status: "done" })
      }
    );
    const nestedMismatchApp = createBackendApi({ workspaceRoot });

    const nestedMismatchResponse = await nestedMismatchApp.request("/api/tasks");
    const nestedMismatchBody = (await nestedMismatchResponse.json()) as ApiErrorResponse;

    expect(nestedMismatchResponse.status).toBe(500);
    expectCanonicalError(nestedMismatchBody, "workspace_error");
    expect(nestedMismatchBody.error.evidence_refs).toContain("snapshot.status");

    await rm(join(tasksRoot, nestedMismatchTask.task_id), { recursive: true, force: true });
    const latestSeqTask = taskCardFixture("TASK-latest-seq");
    await mkdir(join(tasksRoot, latestSeqTask.task_id), { recursive: true });
    await writeTaskSnapshotFixture(
      join(tasksRoot, latestSeqTask.task_id, "snapshot.json"),
      latestSeqTask,
      { latest_seq: 1 }
    );
    const latestSeqApp = createBackendApi({ workspaceRoot });

    const latestSeqResponse = await latestSeqApp.request("/api/tasks");
    const latestSeqBody = (await latestSeqResponse.json()) as ApiErrorResponse;

    expect(latestSeqResponse.status).toBe(500);
    expectCanonicalError(latestSeqBody, "workspace_error");
    expect(latestSeqBody.error.evidence_refs).toContain("snapshot.latest_seq");
  });

  test("oversized existing task snapshots fail closed without leaking task content", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const snapshotPath = join(workspaceRoot, "tasks", "TASK-oversized-read", "snapshot.json");
    await mkdir(join(workspaceRoot, "tasks", "TASK-oversized-read"), { recursive: true });
    await writeFile(snapshotPath, "x".repeat(MAX_TASK_SNAPSHOT_BYTES + 1), { flag: "wx" });
    const app = createBackendApi({ workspaceRoot });

    const response = await app.request("/api/tasks");
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.evidence_refs).toContain("workspace/tasks/TASK-oversized-read/snapshot.json");
    expect(JSON.stringify(body)).not.toContain("Recovered task fixture");
  });

  test("regular-file task lanes fail closed with a canonical envelope", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    await mkdir(join(workspaceRoot, "tasks"), { recursive: true });
    await writeFile(join(workspaceRoot, "tasks", "TASK-file-lane"), "not a directory", {
      flag: "wx"
    });
    const app = createBackendApi({ workspaceRoot });

    const response = await app.request("/api/tasks");
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.evidence_refs).toContain("workspace/tasks/TASK-file-lane");
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
  });

  test("startup hydration ignores unrelated files and only reads bounded task snapshot candidates", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const firstApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:05:00.000Z"),
      taskIdFactory: () => "TASK-bounded"
    });
    const createResponse = await postTask(firstApp, validTaskCreateBody());
    const task = (await createResponse.json()) as TaskCard;
    await writeFile(join(workspaceRoot, "tasks", "README.txt"), "not a task lane", {
      flag: "wx"
    });
    await mkdir(join(workspaceRoot, "tasks", "notes"), { recursive: true });
    await writeFile(join(workspaceRoot, "tasks", "notes", "snapshot.json"), "{", {
      flag: "wx"
    });
    await mkdir(join(workspaceRoot, "tasks", "TASK-empty"), { recursive: true });
    await mkdir(join(workspaceRoot, "tasks", "TASK-bounded", "nested"), { recursive: true });
    await writeFile(join(workspaceRoot, "tasks", "TASK-bounded", "nested", "snapshot.json"), "{", {
      flag: "wx"
    });
    const freshApp = createBackendApi({ workspaceRoot });

    const listResponse = await freshApp.request("/api/tasks");

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ tasks: [task] });
  });

  test("GET /api/tasks fails closed when workspace task entry count exceeds the M1 hydration limit", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const tasksRoot = join(workspaceRoot, "tasks");
    const hiddenTask = taskCardFixture("TASK-hidden-valid", {
      title: "Hidden valid snapshot must not hydrate past the entry limit"
    });
    await mkdir(join(tasksRoot, hiddenTask.task_id), { recursive: true });
    await writeTaskSnapshotFixture(
      join(tasksRoot, hiddenTask.task_id, "snapshot.json"),
      hiddenTask
    );
    await writeFillerTaskEntries(tasksRoot, TASK_HYDRATION_ENTRY_LIMIT);
    const app = createBackendApi({ workspaceRoot });

    const response = await app.request("/api/tasks");
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.evidence_refs).toContain("workspace/tasks:entry_count");
    expect(body.error.message).toContain("exceeding the M1 hydration limit");
    expect(JSON.stringify(body)).not.toContain(hiddenTask.title);
  });

  test("duplicate generated task ids retry safely and fail without adding accepted state", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const generatedIds = ["TASK-duplicate", "TASK-duplicate", "TASK-retry"];
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:05:30.000Z"),
      taskIdFactory: () => generatedIds.shift() ?? "TASK-retry"
    });

    const firstResponse = await postTask(app, validTaskCreateBody({ title: "First task" }));
    const secondResponse = await postTask(app, validTaskCreateBody({ title: "Second task" }));
    const firstTask = (await firstResponse.json()) as TaskCard;
    const secondTask = (await secondResponse.json()) as TaskCard;

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(firstTask.task_id).toBe("TASK-duplicate");
    expect(secondTask.task_id).toBe("TASK-retry");

    const failingApp = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-duplicate"
    });
    const failureResponse = await postTask(failingApp, validTaskCreateBody({ title: "Third task" }));
    const failureBody = (await failureResponse.json()) as ApiErrorResponse;

    expect(failureResponse.status).toBe(500);
    expectCanonicalError(failureBody, "workspace_error");
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [firstTask, secondTask]
    });
    expect((await readdir(join(workspaceRoot, "tasks"))).filter((entry) => entry.startsWith("TASK-")).sort()).toEqual(
      ["TASK-duplicate", "TASK-retry"]
    );
  });

  test("task hydration failures can be repaired and retried in the same service", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const snapshotPath = join(workspaceRoot, "tasks", "TASK-repairable", "snapshot.json");
    const repairedTask = taskCardFixture("TASK-repairable");
    await mkdir(join(workspaceRoot, "tasks", repairedTask.task_id), { recursive: true });
    await writeFile(snapshotPath, "{", { flag: "wx" });
    const app = createBackendApi({ workspaceRoot });

    const failedResponse = await app.request("/api/tasks");
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    await rm(snapshotPath);
    await writeTaskSnapshotFixture(snapshotPath, repairedTask);
    const repairedResponse = await app.request("/api/tasks");

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expect(repairedResponse.status).toBe(200);
    expect(await repairedResponse.json()).toEqual({ tasks: [repairedTask] });
  });

  test("concurrent task creates keep unique ids, coherent list/detail, and one snapshot per task", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    let nextId = 0;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:06:00.000Z"),
      taskIdFactory: () => {
        nextId += 1;
        return `TASK-concurrent-${nextId}`;
      }
    });

    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        postTask(app, validTaskCreateBody({ title: `Concurrent task ${index + 1}` }))
      )
    );
    const tasks = (await Promise.all(responses.map((response) => response.json()))) as TaskCard[];
    const taskIds = tasks.map((task) => task.task_id);

    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(taskIds).size).toBe(4);
    expect((await app.request("/api/tasks").then((response) => response.json()))).toEqual({
      tasks
    });
    for (const task of tasks) {
      expect(await app.request(`/api/tasks/${task.task_id}`).then((response) => response.json())).toEqual(
        task
      );
      expect((await stat(join(workspaceRoot, "tasks", task.task_id, "snapshot.json"))).isFile()).toBe(
        true
      );
    }
    expect((await readdir(join(workspaceRoot, "tasks"))).filter((entry) => entry.startsWith("TASK-")).sort()).toEqual(
      taskIds.sort()
    );
  });

  test("task snapshot writes reject a symlinked tasks root without writing outside", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const outsideRoot = join(tempRoot, "outside-tasks");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(outsideRoot);
    await symlink(outsideRoot, join(workspaceRoot, "tasks"), "dir");
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-symlink-blocked"
    });

    const response = await postTask(app, validTaskCreateBody());
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    await expectPathMissing(join(outsideRoot, "TASK-symlink-blocked"));
  });
});

async function createTempWorkspacePath(): Promise<{ tempRoot: string; workspaceRoot: string }> {
  const tempRoot = await createTempRoot("shud-harness-backend-routes-");
  return {
    tempRoot,
    workspaceRoot: join(tempRoot, "workspace")
  };
}

async function createTempRoot(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function createExpectedRuntimeTree(
  workspaceRoot: string,
  options: { skip?: ReadonlySet<string> } = {}
): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  for (const relativeDir of EXPECTED_M1_RUNTIME_DIRECTORIES) {
    if (options.skip?.has(relativeDir)) {
      continue;
    }
    await mkdir(join(workspaceRoot, relativeDir), { recursive: true });
  }
}

async function expectPathMissing(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }

  throw new Error(`Expected path to be missing: ${path}`);
}

function fixedNow(isoTimestamp: string): () => Date {
  return () => new Date(isoTimestamp);
}

function validTaskCreateBody(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    type: "engineering",
    title: "Add optional event diagnostics",
    question_or_goal: "Add event_flux output without breaking old rSHUD readers",
    inference_budget: { mode: "normal" },
    created_by: "pi",
    ...overrides
  };
}

function taskCardFixture(taskId: string, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    task_id: taskId,
    type: "engineering",
    status: "created",
    title: "Recovered task fixture",
    question_or_goal: "Recover task fixture from a persisted snapshot",
    created_by: "pi",
    current_owner: "coordinator",
    reviewer: "reviewer",
    inference_budget: { mode: "normal" },
    linked_jobs: [],
    linked_reports: [],
    created_at: "2026-07-07T12:00:00.000Z",
    updated_at: "2026-07-07T12:00:00.000Z",
    ...overrides
  };
}

async function writeTaskSnapshotFixture(
  snapshotPath: string,
  task: TaskCard,
  overrides: Partial<TaskSnapshot & { task_card: TaskCard }> = {}
): Promise<void> {
  const snapshot: TaskSnapshot & { task_card: TaskCard } = {
    task_id: task.task_id,
    status: task.status,
    runtime_phase: task.runtime_phase ?? null,
    stack_id: task.stack_id,
    data_id: task.data_id,
    linked_jobs: task.linked_jobs,
    linked_runs: [],
    linked_reports: task.linked_reports,
    active_analysis_plan_id: undefined,
    latest_report_id: undefined,
    pending_pi_gates: [],
    latest_seq: 0,
    updated_at: task.updated_at,
    task_card: task,
    ...overrides
  };
  await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`, { flag: "wx" });
}

async function writeFillerTaskEntries(tasksRoot: string, count: number): Promise<void> {
  const batchSize = 64;
  for (let offset = 0; offset < count; offset += batchSize) {
    const batchCount = Math.min(batchSize, count - offset);
    await Promise.all(
      Array.from({ length: batchCount }, (_, index) =>
        writeFile(join(tasksRoot, `note-${String(offset + index).padStart(4, "0")}.txt`), "", {
          flag: "wx"
        })
      )
    );
  }
}

async function postTask(
  app: ReturnType<typeof createBackendApi>,
  body: CreateTaskInput,
  headers: Record<string, string> = {}
): Promise<Response> {
  return await app.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

async function postRawTask(
  app: ReturnType<typeof createBackendApi>,
  body: Record<string, unknown>,
  idempotencyKey: string
): Promise<Response> {
  return await app.request("/api/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify(body)
  });
}

async function taskSnapshotIds(workspaceRoot: string): Promise<string[]> {
  return (await readdir(join(workspaceRoot, "tasks")))
    .filter((entry) => entry.startsWith("TASK-"))
    .sort();
}

async function taskIdsWithSnapshots(workspaceRoot: string): Promise<string[]> {
  const taskIds = await taskSnapshotIds(workspaceRoot);
  const idsWithSnapshots: string[] = [];
  for (const taskId of taskIds) {
    try {
      const snapshot = await stat(join(workspaceRoot, "tasks", taskId, "snapshot.json"));
      if (snapshot.isFile()) {
        idsWithSnapshots.push(taskId);
      }
    } catch {
      continue;
    }
  }

  return idsWithSnapshots.sort();
}

function expectCanonicalError(body: ApiErrorResponse, category: string): void {
  expect(Object.keys(body.error).sort()).toEqual(
    [
      "category",
      "error_id",
      "evidence_refs",
      "message",
      "recommended_next_actions",
      "retryable",
      "severity",
      "user_message"
    ].sort()
  );
  expect(body.error.error_id.startsWith("api_error_")).toBe(true);
  expect(body.error.category).toBe(category);
  expect(body.error.severity).toBe("error");
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(body.error.user_message.length).toBeGreaterThan(0);
  expect(Array.isArray(body.error.evidence_refs)).toBe(true);
  expect(typeof body.error.retryable).toBe("boolean");
  expect(Array.isArray(body.error.recommended_next_actions)).toBe(true);
  expect(body.error.recommended_next_actions.length).toBeGreaterThan(0);
}

function expectNoAbsoluteWorkspacePath(
  body: ApiErrorResponse,
  tempRoot: string,
  workspaceRoot: string
): void {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(tempRoot);
  expect(serialized).not.toContain(workspaceRoot);
}

function parseApiRequestLogLine(line: string): ApiRequestLogLine {
  expect(line.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(line) as ApiRequestLogLine;
  expect(Object.keys(parsed).sort()).toEqual(
    [
      "duration_ms",
      "event",
      "level",
      "request_id",
      "route",
      "service",
      "status",
      "ts"
    ].sort()
  );
  expect(typeof parsed.ts).toBe("string");
  expect(["info", "warn", "error"]).toContain(parsed.level);
  expect(typeof parsed.request_id).toBe("string");
  expect(typeof parsed.route).toBe("string");
  expect(typeof parsed.status).toBe("number");
  expect(typeof parsed.duration_ms).toBe("number");

  return parsed;
}

async function timeoutAfter(milliseconds: number, message: string): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  throw new Error(message);
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(message);
}

function busyWaitFor(milliseconds: number): void {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    // Intentionally block to prove log sink work is no longer on the response path.
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

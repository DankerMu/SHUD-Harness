import { afterEach, describe, expect, test } from "bun:test";
import { execFile as execFileWithCallback } from "node:child_process";
import { writeFileSync, type BigIntStats } from "node:fs";
import {
  access,
  link,
  readdir,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import * as ts from "typescript";
import { z } from "zod";
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
  type CompletedIdempotencyRecordMutationAuthority,
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
import {
  runWithWorkspaceRecordCompensationTestHooks,
  runWithWorkspaceRecordPublicationHooks,
  workspaceRecordAuthorityDiagnosticsForTest,
  workspaceRecordDirectoryBindingDiagnosticsForTest,
  writeJsonRecord,
  type WorkspaceRecordPublicationHooks
} from "../../../core/src/domain/services/workspace-record-store";
import {
  PreservedErrorCompensationEnvelope,
  semanticPrimaryError
} from "../../../core/src/domain/services/compensation-error-preservation";

const tempRoots: string[] = [];
const originalCwd = process.cwd();
const originalHarnessWorkspaceDir = process.env.HARNESS_WORKSPACE_DIR;
const originalLegacyWorkspaceRoot = process.env.SHUD_HARNESS_WORKSPACE_ROOT;
const TASK_HYDRATION_ENTRY_LIMIT = 1024;
const IN_FLIGHT_TASK_CREATE_LIMIT = 1024;
const INVALID_DURABLE_TASK_AUTHORITY_MESSAGE =
  "Completed task idempotency authority is invalid and was quarantined.";
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

  test("workspace init and record writers share canonical missing-child authority", async () => {
    const recordSchema = z.object({ id: z.string(), parent: z.string() });
    for (const directorySegments of [
      [],
      ["tasks"],
      ["artifacts", "manifests"]
    ] as const) {
      for (const schedule of ["simultaneous", "init-first", "record-first"] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        if (directorySegments.length > 0) await mkdir(workspaceRoot);
        if (directorySegments.length > 1) {
          await mkdir(join(workspaceRoot, ...directorySegments.slice(0, -1)), {
            recursive: true
          });
        }
        const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
        const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
        const targetDirectory = join(workspaceRoot, ...directorySegments);
        const firstObservedMissing = createSignal();
        const bothObservedMissing = createSignal();
        const simultaneousGate = createAsyncGate();
        const firstGate = createAsyncGate();
        const secondGate = createAsyncGate();
        let missingObservations = 0;
        let internalCreations = 0;
        const hooks: WorkspaceRecordPublicationHooks = {
          beforeDurableDirectoryCreation: async ({ path }) => {
            if (path !== targetDirectory) return;
            missingObservations += 1;
            if (missingObservations === 1) firstObservedMissing.resolve();
            if (missingObservations === 2) bothObservedMissing.resolve();
            if (schedule === "simultaneous") {
              await simultaneousGate.wait;
            } else if (missingObservations === 1) {
              await firstGate.wait;
            } else {
              await secondGate.wait;
            }
          },
          afterDurableDirectoryCreated: ({ path }) => {
            if (path === targetDirectory) internalCreations += 1;
          }
        };
        const app = createBackendApi({ workspaceRoot });
        const record = {
          id: `init-record-${directorySegments.join("-") || "root"}-${schedule}`,
          parent: directorySegments.join("/") || "."
        };
        const startInit = () =>
          runWithWorkspaceRecordPublicationHooks(hooks, () =>
            app.request("/api/workspace/init", { method: "POST" })
          );
        const startRecord = () =>
          runWithWorkspaceRecordPublicationHooks(hooks, () =>
            writeJsonRecord(
              workspaceRoot,
              directorySegments,
              "integration-record.json",
              record,
              `workspace.init.integration.${directorySegments.join(".")}.${schedule}`,
              recordSchema
            )
          );
        let initPromise: Promise<Response>;
        let recordPromise: Promise<typeof record>;

        if (schedule === "simultaneous") {
          initPromise = startInit();
          recordPromise = startRecord();
          await Promise.race([
            bothObservedMissing.promise,
            timeoutAfter(2_000, `init/record did not both observe ${targetDirectory}`)
          ]);
          simultaneousGate.open();
        } else {
          const firstKind = schedule === "init-first" ? "init" : "record";
          const firstPromise = firstKind === "init"
            ? (initPromise = startInit())
            : (recordPromise = startRecord());
          await Promise.race([
            firstObservedMissing.promise,
            timeoutAfter(2_000, `${firstKind} did not observe ${targetDirectory}`)
          ]);
          if (firstKind === "init") recordPromise = startRecord();
          else initPromise = startInit();
          await Promise.race([
            bothObservedMissing.promise,
            timeoutAfter(2_000, `staggered peer did not observe ${targetDirectory}`)
          ]);

          firstGate.open();
          const firstResult = await Promise.race([
            firstPromise,
            timeoutAfter(2_000, `${firstKind} did not finish while its peer was paused`)
          ]);
          if (firstKind === "init") expect((firstResult as Response).status).toBe(200);
          else expect(firstResult).toEqual(record);
          secondGate.open();
        }

        const [initResponse, storedRecord] = await Promise.race([
          Promise.all([initPromise!, recordPromise!]),
          timeoutAfter(2_000, `init/record did not converge for ${targetDirectory}`)
        ]);
        const initBody = await initResponse.json();

        expect(initResponse.status).toBe(200);
        expect(initBody).toEqual({
          status: "ok",
          directory_count: EXPECTED_M1_RUNTIME_DIRECTORIES.length,
          directories: EXPECTED_M1_RUNTIME_DIRECTORIES
        });
        expect(storedRecord).toEqual(record);
        expect(missingObservations).toBe(2);
        expect(internalCreations).toBe(1);
        expect(await readFile(join(targetDirectory, "integration-record.json"), "utf8")).toBe(
          `${JSON.stringify(record, null, 2)}\n`
        );
        expect(await workspaceDirectoryInventory(workspaceRoot)).toEqual(
          [...EXPECTED_M1_RUNTIME_DIRECTORIES].sort()
        );
        expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
        expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
      }
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

  test("default writable probe converges with an active root record publication", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({ workspaceRoot });
    expect((await app.request("/api/workspace/init", { method: "POST" })).status).toBe(200);
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const recordPath = join(workspaceRoot, "active-root-record.json");
    const temporaryWritten = createSignal();
    const publicationGate = createAsyncGate();
    const record = { id: "active-root-ready", revision: 1 };
    const recordSchema = z.object({ id: z.string(), revision: z.number().int() });
    const publication = runWithWorkspaceRecordPublicationHooks(
      {
        afterTemporaryFileWritten: async ({ canonicalPath }) => {
          if (canonicalPath !== recordPath) return;
          temporaryWritten.resolve();
          await publicationGate.wait;
        }
      },
      () =>
        writeJsonRecord(
          workspaceRoot,
          [],
          "active-root-record.json",
          record,
          "workspace.ready.active-root",
          recordSchema
        )
    );
    await Promise.race([
      temporaryWritten.promise,
      timeoutAfter(2_000, "root record publication did not reach its active generation")
    ]);

    const readyResponse = await Promise.race([
      app.request("/api/health/ready"),
      timeoutAfter(2_000, "default writable probe waited on an unlocked root callback")
    ]);
    const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;

    expect(readyResponse.status).toBe(200);
    expect(readyBody.status).toBe("ok");
    expect(readyBody.checks.workspace_writable).toBe("ok");
    expect((await readdir(workspaceRoot)).filter((entry) => entry.includes("health-write-probe")))
      .toEqual([]);

    publicationGate.open();
    expect(await Promise.race([
      publication,
      timeoutAfter(2_000, "root record publication did not finish after readiness")
    ])).toEqual(record);
    expect(await readFile(recordPath, "utf8")).toBe(`${JSON.stringify(record, null, 2)}\n`);
    expect((await readdir(workspaceRoot)).filter((entry) => entry.includes("health-write-probe")))
      .toEqual([]);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
  });

  test("custom writable probe mutation and root replacement fail closed after exact reproof", async () => {
    for (const drift of ["mutation", "replacement"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const foreignLeaf = join(workspaceRoot, "custom-probe-foreign.txt");
      const displacedRoot = join(tempRoot, "workspace-displaced-by-custom-probe");
      let probeCalls = 0;
      const app = createBackendApi({
        workspaceRoot,
        writableProbe: async ({ workspaceRoot: probeRoot }) => {
          probeCalls += 1;
          expect(probeRoot).toBe(resolve(workspaceRoot));
          if (drift === "mutation") {
            await writeFile(foreignLeaf, "external custom probe mutation", { flag: "wx" });
          } else {
            await rename(workspaceRoot, displacedRoot);
            await mkdir(workspaceRoot);
          }
          return true;
        }
      });
      expect((await app.request("/api/workspace/init", { method: "POST" })).status).toBe(200);
      const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
      const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();

      const readyResponse = await app.request("/api/health/ready");
      const readyBody = (await readyResponse.json()) as WorkspaceReadyResponse;

      expect(readyResponse.status).toBe(503);
      expect(readyBody.status).toBe("not_ready");
      expect(readyBody.checks.workspace_writable).toBe("fail");
      expect(probeCalls).toBe(1);
      if (drift === "mutation") {
        expect(await readFile(foreignLeaf, "utf8")).toBe("external custom probe mutation");
      } else {
        expect((await stat(displacedRoot)).isDirectory()).toBe(true);
        expect((await stat(workspaceRoot)).isDirectory()).toBe(true);
      }
      expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
      expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    }
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

  test("POST /api/tasks delegates normal-owner pre-completion observation to completeRecord", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:normal-owner-observation";
    const taskId = "TASK-normal-owner-observation";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    const callOrder: string[] = [];
    let beginRecordCalls = 0;
    let lookupReplayCalls = 0;
    let completeRecordCalls = 0;
    let snapshotReads = 0;
    let snapshotReadsAtCompletion: number | undefined;
    let cleanupPermitsAtCompletion: number | undefined;
    let cleanupPermitsAfterCompletion: number | undefined;
    let completionResultRef: string | undefined;
    let completionRequestDigest: string | undefined;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:30.125Z"),
      taskIdFactory: () => taskId,
      taskSnapshotReadHooks: {
        beforeSnapshotOpen: ({ laneTaskId }) => {
          if (laneTaskId !== taskId) return;
          snapshotReads += 1;
          callOrder.push(`snapshot:${snapshotReads}`);
        }
      },
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          beginRecord: async (input) => {
            beginRecordCalls += 1;
            callOrder.push("beginRecord");
            return await service.beginRecord(input);
          },
          lookupReplay: async (input) => {
            lookupReplayCalls += 1;
            callOrder.push("lookupReplay");
            return await service.lookupReplay(input);
          },
          completeRecord: async (input) => {
            completeRecordCalls += 1;
            snapshotReadsAtCompletion = snapshotReads;
            cleanupPermitsAtCompletion =
              workspaceRecordAuthorityDiagnosticsForTest().cleanupPermits;
            completionResultRef = input.resultRef;
            completionRequestDigest = input.requestDigest;
            callOrder.push("completeRecord");
            const completed = await service.completeRecord(input);
            cleanupPermitsAfterCompletion =
              workspaceRecordAuthorityDiagnosticsForTest().cleanupPermits;
            return completed;
          }
        };
      }
    });

    const response = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const createdTask = (await response.json()) as TaskCard;
    const completedRecord = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );
    const snapshot = JSON.parse(
      await readFile(join(workspaceRoot, "tasks", taskId, "snapshot.json"), "utf8")
    ) as TaskSnapshot & { task_card: TaskCard };

    expect(response.status).toBe(201);
    expect(createdTask.task_id).toBe(taskId);
    expect(beginRecordCalls).toBe(1);
    expect(lookupReplayCalls).toBe(0);
    expect(completeRecordCalls).toBe(1);
    expect(snapshotReadsAtCompletion).toBe(1);
    expect(cleanupPermitsAtCompletion).toBe(authorityBaseline.cleanupPermits + 1);
    expect(cleanupPermitsAfterCompletion).toBe(authorityBaseline.cleanupPermits + 1);
    expect(snapshotReads).toBe(1);
    expect(callOrder).toEqual([
      "beginRecord",
      "snapshot:1",
      "completeRecord"
    ]);
    expect(completionResultRef).toBe(taskId);
    expect(completionRequestDigest).toBe(requestDigest);
    expect(completedRecord?.status).toBe("completed");
    expect(completedRecord?.request_digest).toBe(requestDigest);
    expect(completedRecord?.result_ref).toBe(taskId);
    expect(snapshot.task_card).toEqual(createdTask);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });

  test("POST /api/tasks retains a committed snapshot when completion cleanup and reconciliation reads fail", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:unknown-post-completion-authority";
    const taskId = "TASK-unknown-post-completion-authority";
    const taskBody = validTaskCreateBody({ title: "Retain post-completion authority" });
    const completionMarker = new Error("post-completion cleanup marker");
    const reconciliationMarker = new Error("post-completion reconciliation marker");
    let completionCommitted = false;
    let reconciliationFaultActive = true;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:30.125Z"),
      taskIdFactory: () => taskId,
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          completeRecord: async (input) => {
            await service.completeRecord(input);
            completionCommitted = true;
            throw completionMarker;
          },
          consumeCompletedRecord: async (input, consume) => {
            if (completionCommitted && reconciliationFaultActive) {
              throw reconciliationMarker;
            }
            return await service.consumeCompletedRecord(input, consume);
          }
        };
      }
    });

    const failedResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const snapshotPath = join(workspaceRoot, "tasks", taskId, "snapshot.json");
    const retainedBytes = await readFile(snapshotPath);
    const record = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expect(completionCommitted).toBe(true);
    expect(record?.status).toBe("completed");
    expect(record?.result_ref).toBe(taskId);
    expect(retainedBytes.byteLength).toBeGreaterThan(0);
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);

    reconciliationFaultActive = false;
    const replayResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const replayTask = (await replayResponse.json()) as TaskCard;

    expect(replayResponse.status).toBe(200);
    expect(replayTask.task_id).toBe(taskId);
    expect(await readFile(snapshotPath)).toEqual(retainedBytes);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [replayTask]
    });
  });

  test("POST /api/tasks retains a snapshot when pre-completion authority is unknown and a completion references it", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:unknown-pre-completion-authority";
    const taskId = "TASK-unknown-pre-completion-authority";
    const taskBody = validTaskCreateBody({ title: "Retain pre-completion authority" });
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const observationMarker = new Error("pre-completion observation marker");
    const reconciliationMarker = new Error("pre-completion reconciliation marker");
    let serviceForCompetingCompletion:
      | ReturnType<typeof createIdempotencyRecordService>
      | undefined;
    let competingCompletionPublished = false;
    let reconciliationFaultActive = true;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:30.156Z"),
      taskIdFactory: () => taskId,
      taskSnapshotReadHooks: {
        beforeSnapshotOpen: async ({ laneTaskId }) => {
          if (laneTaskId !== taskId || competingCompletionPublished) return;
          competingCompletionPublished = true;
          await serviceForCompetingCompletion!.completeRecord({
            scope: "task",
            key: idempotencyKey,
            requestDigest,
            resultRef: taskId
          });
          throw observationMarker;
        }
      },
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        serviceForCompetingCompletion = service;
        return {
          ...service,
          consumeCompletedRecord: async (input, consume) => {
            if (competingCompletionPublished && reconciliationFaultActive) {
              throw reconciliationMarker;
            }
            return await service.consumeCompletedRecord(input, consume);
          }
        };
      }
    });

    const failedResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const snapshotPath = join(workspaceRoot, "tasks", taskId, "snapshot.json");
    const retainedBytes = await readFile(snapshotPath);
    const record = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expect(competingCompletionPublished).toBe(true);
    expect(record?.status).toBe("completed");
    expect(record?.result_ref).toBe(taskId);
    expect(retainedBytes.byteLength).toBeGreaterThan(0);
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);

    reconciliationFaultActive = false;
    const replayResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const replayTask = (await replayResponse.json()) as TaskCard;

    expect(replayResponse.status).toBe(200);
    expect(replayTask.task_id).toBe(taskId);
    expect(await readFile(snapshotPath)).toEqual(retainedBytes);
  });

  test("POST /api/tasks retains exact snapshot drift and replays after fault-free reproof", async () => {
    for (const drift of ["minified_bytes", "pending_pi_gates"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const idempotencyKey = `task:create:r23-completion-drift-${drift}`;
      const ownerTaskId = `TASK-r23-completion-drift-${drift}`;
      const unusedTaskId = `${ownerTaskId}-unused`;
      const taskIds = [ownerTaskId, unusedTaskId];
      const taskBody = validTaskCreateBody({
        title: `R23 exact completion drift ${drift}`
      });
      const snapshotPath = join(workspaceRoot, "tasks", ownerTaskId, "snapshot.json");
      const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
      const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
      let mutationCount = 0;
      let generationBefore:
        | { readonly dev: bigint; readonly ino: bigint }
        | undefined;
      let generationAfter:
        | { readonly dev: bigint; readonly ino: bigint }
        | undefined;
      const app = createBackendApi({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:30.187Z"),
        taskIdFactory: () => taskIds.shift() ?? `${unusedTaskId}-unexpected`,
        idempotencyServiceFactory: (serviceOptions) => {
          const service = createIdempotencyRecordService(serviceOptions);
          return {
            ...service,
            completeRecord: async (input) => {
              if (input.resultRef === ownerTaskId && mutationCount === 0) {
                mutationCount += 1;
                const before = await stat(snapshotPath, { bigint: true });
                generationBefore = { dev: before.dev, ino: before.ino };
                const snapshot = JSON.parse(
                  await readFile(snapshotPath, "utf8")
                ) as TaskSnapshot & { task_card: TaskCard };
                await writeFile(
                  snapshotPath,
                  drift === "minified_bytes"
                    ? JSON.stringify(snapshot)
                    : `${JSON.stringify({
                        ...snapshot,
                        pending_pi_gates: ["GATE-r23-after-first-read"]
                      }, null, 2)}\n`
                );
                const after = await stat(snapshotPath, { bigint: true });
                generationAfter = { dev: after.dev, ino: after.ino };
              }
              return await service.completeRecord(input);
            }
          };
        }
      });

      const failedResponse = await postTask(app, taskBody, {
        "Idempotency-Key": idempotencyKey
      });
      const failedBody = (await failedResponse.json()) as ApiErrorResponse;
      const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
      const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
      const retainedBytes = await readFile(snapshotPath);
      const retainedSnapshot = JSON.parse(retainedBytes.toString("utf8")) as TaskSnapshot & {
        task_card: TaskCard;
      };
      const retainedTask = retainedSnapshot.task_card;
      const sameAppList = await app.request("/api/tasks");
      const sameAppDetail = await app.request(`/api/tasks/${ownerTaskId}`);
      const freshApp = createBackendApi({ workspaceRoot });
      const freshList = await freshApp.request("/api/tasks");
      const freshDetail = await freshApp.request(`/api/tasks/${ownerTaskId}`);

      expect(failedResponse.status).toBe(500);
      expectCanonicalError(failedBody, "workspace_error");
      expect(failedBody.error.message).toBe(
        "Observed task snapshot changed before exact cache settlement."
      );
      expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
      expect(mutationCount).toBe(1);
      expect(generationBefore).toBeDefined();
      expect(generationAfter).toEqual(generationBefore!);
      expect(recordAfterFailure?.status).toBe("completed");
      expect(recordAfterFailure?.result_ref).toBe(ownerTaskId);
      expect(sameAppList.status).toBe(200);
      expect(await sameAppList.json()).toEqual({ tasks: [retainedTask] });
      expect(sameAppDetail.status).toBe(200);
      expect(await sameAppDetail.json()).toEqual(retainedTask);
      expect(freshList.status).toBe(200);
      expect(await freshList.json()).toEqual({ tasks: [retainedTask] });
      expect(freshDetail.status).toBe(200);
      expect(await freshDetail.json()).toEqual(retainedTask);
      expect(await readFile(snapshotPath)).toEqual(retainedBytes);
      expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
      expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);

      const replayResponse = await postTask(app, taskBody, {
        "Idempotency-Key": idempotencyKey
      });
      const replayTask = (await replayResponse.json()) as TaskCard;
      const recordAfterReplay = await idempotencyService.getRecord("task", idempotencyKey);

      expect(replayResponse.status).toBe(200);
      expect(replayTask).toEqual(retainedTask);
      expect(taskIds).toEqual([unusedTaskId]);
      expect(recordAfterReplay).toEqual(recordAfterFailure);
      expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
        tasks: [retainedTask]
      });
      expect(await createBackendApi({ workspaceRoot }).request("/api/tasks").then(
        (response) => response.json()
      )).toEqual({ tasks: [retainedTask] });
      expect(await readFile(snapshotPath)).toEqual(retainedBytes);
      expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
      expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
    }
  });

  test("POST /api/tasks exact invalidation bypasses unrelated transition-guard recovery", async () => {
    for (const failureClass of ["post_mutation_release"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const idempotencyKey = `task:create:r23-invalidation-recovery-${failureClass}`;
      const ownerTaskId = `TASK-r23-invalidation-recovery-${failureClass}`;
      const repairedTaskId = `${ownerTaskId}-repaired`;
      const taskIds = [ownerTaskId, repairedTaskId];
      const taskBody = validTaskCreateBody({
        title: `R23 invalidation recovery ${failureClass}`
      });
      const snapshotPath = join(workspaceRoot, "tasks", ownerTaskId, "snapshot.json");
      const guardPath = join(
        workspaceRoot,
        "tasks",
        "_idempotency",
        "task",
        `${sha256Hex(`transition:${idempotencyKey}`)}.guard.json`
      );
      const invalidationMarker = new Error(`private ${failureClass} invalidation marker`);
      const quarantineMarker = new Error(`private ${failureClass} quarantine marker`);
      const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
      const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
      let replacementCount = 0;
      let invalidationCalls = 0;
      let quarantineCalls = 0;
      let matchingGuardReleaseCalls = 0;
      let invalidationActive = false;
      let quarantineActive = false;
      let successorTask: TaskCard | undefined;
      let successorBytes: Buffer | undefined;
      let successorIdentity: { readonly dev: bigint; readonly ino: bigint } | undefined;
      const app = createBackendApi({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:30.218Z"),
        requestLogSink: () => undefined,
        taskIdFactory: () => taskIds.shift() ?? `${repairedTaskId}-unexpected`,
        idempotencyServiceFactory: (serviceOptions) => {
          const service = createIdempotencyRecordService(serviceOptions);
          return {
            ...service,
            completeRecord: async (input) => {
              const completed = await service.completeRecord(input);
              if (input.resultRef !== ownerTaskId || replacementCount > 0) return completed;
              replacementCount += 1;
              const snapshot = JSON.parse(
                await readFile(snapshotPath, "utf8")
              ) as TaskSnapshot & { task_card: TaskCard };
              successorTask = {
                ...snapshot.task_card,
                title: `R23 valid successor ${failureClass}`
              };
              successorBytes = Buffer.from(
                `${JSON.stringify({ ...snapshot, task_card: successorTask }, null, 2)}\n`
              );
              const temporarySuccessor = `${snapshotPath}.successor`;
              await writeFile(temporarySuccessor, successorBytes, {
                flag: "wx",
                mode: 0o600
              });
              await rename(temporarySuccessor, snapshotPath);
              const successorEntry = await stat(snapshotPath, { bigint: true });
              successorIdentity = { dev: successorEntry.dev, ino: successorEntry.ino };
              return completed;
            },
            invalidateCompletedRecord: async (input) => {
              invalidationCalls += 1;
              invalidationActive = true;
              try {
                return await service.invalidateCompletedRecord(input);
              } finally {
                invalidationActive = false;
              }
            },
            quarantineRecordAfterUnsafeRollback: async (input) => {
              quarantineCalls += 1;
              quarantineActive = true;
              try {
                return await service.quarantineRecordAfterUnsafeRollback(input);
              } finally {
                quarantineActive = false;
              }
            }
          };
        }
      });

      const phaseResponses = await runWithWorkspaceRecordPublicationHooks(
        {
          beforeAuthorityOwnedUnlink: ({ path, operation }) => {
            if (
              path !== guardPath ||
              operation !== "conditional_delete" ||
              !invalidationActive
            ) {
              return;
            }
            matchingGuardReleaseCalls += 1;
            if (matchingGuardReleaseCalls === 1) {
              throw invalidationMarker;
            }
          }
        },
        async () => {
          const unknownResponse = await postTask(app, taskBody, {
            "Idempotency-Key": idempotencyKey
          });
          const unknownBody = (await unknownResponse.json()) as ApiErrorResponse;
          const recordAfterUnknown = await createIdempotencyRecordService({
            workspaceRoot
          }).getRecord("task", idempotencyKey);
          const bytesAfterUnknown = await readFile(snapshotPath);
          const countsAfterUnknown = {
            invalidationCalls,
            quarantineCalls,
            matchingGuardReleaseCalls
          };
          const failedResponse = await postTask(app, taskBody, {
            "Idempotency-Key": idempotencyKey
          });
          return {
            unknownResponse,
            unknownBody,
            recordAfterUnknown,
            bytesAfterUnknown,
            countsAfterUnknown,
            failedResponse
          };
        }
      );
      const {
        unknownResponse,
        unknownBody,
        recordAfterUnknown,
        bytesAfterUnknown,
        countsAfterUnknown,
        failedResponse
      } = phaseResponses;
      const failedBody = (await failedResponse.json()) as ApiErrorResponse;
      const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
      const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);

      expect(unknownResponse.status).toBe(500);
      expectCanonicalError(unknownBody, "workspace_error");
      expect(unknownBody.error.message).toBe(
        "Observed task snapshot changed before exact cache settlement."
      );
      expect(recordAfterUnknown?.status).toBe("completed");
      expect(recordAfterUnknown?.result_ref).toBe(ownerTaskId);
      expect(countsAfterUnknown).toEqual({
        invalidationCalls: 0,
        quarantineCalls: 0,
        matchingGuardReleaseCalls: 0
      });
      expect(bytesAfterUnknown).toEqual(successorBytes!);
      expect(failedResponse.status).toBe(500);
      expectCanonicalError(failedBody, "workspace_error");
      expect(failedBody.error.message).toBe(INVALID_DURABLE_TASK_AUTHORITY_MESSAGE);
      expect(failedBody.error.retryable).toBe(true);
      expect(JSON.stringify(failedBody)).not.toContain(invalidationMarker.message);
      expect(JSON.stringify(failedBody)).not.toContain(quarantineMarker.message);
      expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
      expect(replacementCount).toBe(1);
      expect(invalidationCalls).toBe(1);
      expect(quarantineCalls).toBe(0);
      expect(matchingGuardReleaseCalls).toBe(0);
      expect(recordAfterFailure?.status).toBe("failed");
      expect(recordAfterFailure?.result_ref).toBeUndefined();
      expect(successorTask).toBeDefined();
      expect(successorBytes).toBeDefined();
      expect(successorIdentity).toBeDefined();
      expect(await readFile(snapshotPath)).toEqual(successorBytes!);
      const successorEntryAfterFailure = await stat(snapshotPath, { bigint: true });
      expect({
        dev: successorEntryAfterFailure.dev,
        ino: successorEntryAfterFailure.ino
      }).toEqual(successorIdentity!);
      expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
        tasks: [successorTask]
      });
      expect(
        await createBackendApi({ workspaceRoot }).request("/api/tasks").then(
          (response) => response.json()
        )
      ).toEqual({ tasks: [successorTask] });
      await expectPathMissing(guardPath);
      expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
      expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);

      const repairedResponse = await postTask(app, taskBody, {
        "Idempotency-Key": idempotencyKey
      });
      const repairedTask = (await repairedResponse.json()) as TaskCard;
      const repairedRecord = await idempotencyService.getRecord("task", idempotencyKey);

      expect(repairedResponse.status).toBe(201);
      expect(repairedTask.task_id).toBe(repairedTaskId);
      expect(repairedRecord?.status).toBe("completed");
      expect(repairedRecord?.result_ref).toBe(repairedTaskId);
      expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
        tasks: [successorTask, repairedTask]
      });
      expect(await readFile(snapshotPath)).toEqual(successorBytes!);
      await expectPathMissing(guardPath);
      expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
      expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
    }
  });

  test("POST /api/tasks does not retain fail intent across rejected completed authority", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:durable-fail-intent-fence";
    const ownerTaskId = "TASK-durable-fail-intent-fence-a";
    const repairedTaskId = "TASK-durable-fail-intent-fence-repaired";
    const taskIds = [ownerTaskId, repairedTaskId];
    const taskBody = validTaskCreateBody({ title: "Durable fail-intent fence" });
    const snapshotPath = join(workspaceRoot, "tasks", ownerTaskId, "snapshot.json");
    const recordPath = join(
      workspaceRoot,
      "tasks",
      "_idempotency",
      "task",
      idempotencyRecordFileName(idempotencyKey)
    );
    const guardPath = join(
      workspaceRoot,
      "tasks",
      "_idempotency",
      "task",
      `${sha256Hex(`transition:${idempotencyKey}`)}.guard.json`
    );
    let successorBytes: Buffer | undefined;
    let successorIdentity: { readonly dev: bigint; readonly ino: bigint } | undefined;
    let successorTask: TaskCard | undefined;
    let replacementPublished = false;
    let storageHealthy = false;
    let failedRecordWrites = 0;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:30.312Z"),
      requestLogSink: () => undefined,
      taskIdFactory: () => taskIds.shift() ?? "TASK-durable-fail-intent-unexpected",
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          completeRecord: async (input) => {
            const completed = await service.completeRecord(input);
            if (input.resultRef !== ownerTaskId || replacementPublished) return completed;
            replacementPublished = true;
            const snapshot = JSON.parse(
              await readFile(snapshotPath, "utf8")
            ) as TaskSnapshot & { task_card: TaskCard };
            successorTask = {
              ...snapshot.task_card,
              title: "Durable fail-intent successor A2"
            };
            successorBytes = Buffer.from(
              `${JSON.stringify({ ...snapshot, task_card: successorTask }, null, 2)}\n`
            );
            const temporarySuccessor = `${snapshotPath}.successor`;
            await writeFile(temporarySuccessor, successorBytes, {
              flag: "wx",
              mode: 0o600
            });
            await rename(temporarySuccessor, snapshotPath);
            const successorEntry = await stat(snapshotPath, { bigint: true });
            successorIdentity = { dev: successorEntry.dev, ino: successorEntry.ino };
            return completed;
          }
        };
      }
    });
    const freshApp = createBackendApi({ workspaceRoot, requestLogSink: () => undefined });
    const writeFailure = new Error("durable fail-intent record write failure");
    const hooks: WorkspaceRecordPublicationHooks = {
      afterTemporaryFileWritten: ({ canonicalPath }) => {
        if (!replacementPublished || storageHealthy || canonicalPath !== recordPath) return;
        failedRecordWrites += 1;
        throw writeFailure;
      }
    };

    const { failedResponse, sameAppBlocked, freshAppBlocked, writesAfterOwner } =
      await runWithWorkspaceRecordPublicationHooks(hooks, async () => {
        const failedResponse = await postTask(app, taskBody, {
          "Idempotency-Key": idempotencyKey
        });
        const writesAfterOwner = failedRecordWrites;
        const sameAppBlocked = await postTask(app, taskBody, {
          "Idempotency-Key": idempotencyKey
        });
        const freshAppBlocked = await postTask(freshApp, taskBody, {
          "Idempotency-Key": idempotencyKey
        });
        return { failedResponse, sameAppBlocked, freshAppBlocked, writesAfterOwner };
      });
    const retainedRecord = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );
    expect(failedResponse.status).toBe(500);
    expect(writesAfterOwner).toBe(0);
    expect(sameAppBlocked.status).toBe(500);
    expect(freshAppBlocked.status).toBe(500);
    expect(failedRecordWrites).toBeGreaterThan(0);
    expect(retainedRecord?.status).toBe("completed");
    expect(retainedRecord?.result_ref).toBe(ownerTaskId);
    await expectPathMissing(guardPath);
    expect(successorTask).toBeDefined();
    expect(successorBytes).toBeDefined();
    expect(successorIdentity).toBeDefined();
    expect(await readFile(snapshotPath)).toEqual(successorBytes!);
    const successorEntryWhileFenced = await stat(snapshotPath, { bigint: true });
    expect({
      dev: successorEntryWhileFenced.dev,
      ino: successorEntryWhileFenced.ino
    }).toEqual(successorIdentity!);

    storageHealthy = true;
    const recoveryResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const recoveryService = createIdempotencyRecordService({ workspaceRoot });
    const recoveredRecord = await recoveryService.getRecord("task", idempotencyKey);

    expect(recoveryResponse.status).toBe(500);
    expect(recoveredRecord?.status).toBe("failed");
    expect(recoveredRecord?.result_ref).toBeUndefined();
    await expectPathMissing(guardPath);
    expect(await readFile(snapshotPath)).toEqual(successorBytes!);

    const repairedResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const repairedTask = (await repairedResponse.json()) as TaskCard;

    expect(repairedResponse.status).toBe(201);
    expect(repairedTask.task_id).toBe(repairedTaskId);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [successorTask, repairedTask]
    });
  });

  test("completed replay evicts same-app cache after external snapshot deletion", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:cached-replay-deleted-snapshot";
    const taskIds = ["TASK-cached-replay-deleted", "TASK-cached-replay-repaired"];
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return taskIds.shift() ?? "TASK-cached-replay-unexpected";
      }
    });

    const createResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const createdTask = (await createResponse.json()) as TaskCard;
    const taskLane = join(workspaceRoot, "tasks", createdTask.task_id);
    await rm(join(taskLane, "snapshot.json"));

    const replayResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const replayBody = (await replayResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
    const sameAppList = await app.request("/api/tasks");
    const sameAppDetail = await app.request(`/api/tasks/${createdTask.task_id}`);
    const freshApp = createBackendApi({ workspaceRoot });
    const freshList = await freshApp.request("/api/tasks");
    const freshDetail = await freshApp.request(`/api/tasks/${createdTask.task_id}`);

    expect(createResponse.status).toBe(201);
    expect(replayResponse.status).toBe(500);
    expectCanonicalError(replayBody, "workspace_error");
    expect(replayBody.error.message).toBe(INVALID_DURABLE_TASK_AUTHORITY_MESSAGE);
    expect(replayBody.error.retryable).toBe(true);
    expect(JSON.stringify(replayBody)).not.toContain(idempotencyKey);
    expectNoAbsoluteWorkspacePath(replayBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(sameAppList.status).toBe(200);
    expect(await sameAppList.json()).toEqual({ tasks: [] });
    expect(sameAppDetail.status).toBe(404);
    expect(freshList.status).toBe(200);
    expect(await freshList.json()).toEqual({ tasks: [] });
    expect(freshDetail.status).toBe(404);
    expect(taskIdFactoryCalls).toBe(1);

    await rm(taskLane, { recursive: true, force: true });
    const repairedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const repairedTask = (await repairedResponse.json()) as TaskCard;
    const recordAfterRepair = await idempotencyService.getRecord("task", idempotencyKey);

    expect(repairedResponse.status).toBe(201);
    expect(repairedTask.task_id).toBe("TASK-cached-replay-repaired");
    expect(taskIdFactoryCalls).toBe(2);
    expect(recordAfterRepair?.status).toBe("completed");
    expect(recordAfterRepair?.result_ref).toBe(repairedTask.task_id);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [repairedTask]
    });
  });

  test("completed replay invalidates malformed or unknown snapshots before repaired retry", async () => {
    for (const location of ["top_level", "task_card", "malformed"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const taskBody = validTaskCreateBody();
      const taskId = `TASK-replay-unknown-${location.replace("_", "-")}`;
      const retryTaskId = `TASK-replay-repaired-${location.replace("_", "-")}`;
      const idempotencyKey = `task:create:replay-unknown-${location}`;
      const taskIds = [taskId, retryTaskId];
      let taskIdFactoryCalls = 0;
      const replayApp = createBackendApi({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:30.250Z"),
        taskIdFactory: () => {
          taskIdFactoryCalls += 1;
          return taskIds.shift() ?? "TASK-replay-unknown-unexpected";
        }
      });
      const createResponse = await postTask(replayApp, taskBody, {
        "Idempotency-Key": idempotencyKey
      });
      const task = (await createResponse.json()) as TaskCard;
      const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
      const snapshotPath = join(workspaceRoot, "tasks", taskId, "snapshot.json");
      const canonicalSnapshotText = await readFile(snapshotPath, "utf8");
      const poisonedSnapshot = JSON.parse(canonicalSnapshotText) as Record<string, unknown>;
      const unknownContent = `private-replay-unknown-${location}`;
      if (location === "top_level") {
        poisonedSnapshot.unknown_top_level = unknownContent;
      } else if (location === "task_card") {
        (poisonedSnapshot.task_card as Record<string, unknown>).unknown_nested = unknownContent;
      }
      await writeFile(
        snapshotPath,
        location === "malformed" ? "{" : `${JSON.stringify(poisonedSnapshot)}\n`
      );

      const failedResponse = await postTask(replayApp, taskBody, {
        "Idempotency-Key": idempotencyKey
      });
      const failedBody = (await failedResponse.json()) as ApiErrorResponse;
      const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
      const sameAppList = await replayApp.request("/api/tasks");
      const sameAppDetail = await replayApp.request(`/api/tasks/${taskId}`);
      const freshApp = createBackendApi({ workspaceRoot });
      const freshList = await freshApp.request("/api/tasks");
      const freshDetail = await freshApp.request(`/api/tasks/${taskId}`);

      expect(createResponse.status).toBe(201);
      expect(task.task_id).toBe(taskId);
      expect(failedResponse.status).toBe(500);
      expectCanonicalError(failedBody, "workspace_error");
      expect(failedBody.error.message).toBe(INVALID_DURABLE_TASK_AUTHORITY_MESSAGE);
      expect(failedBody.error.retryable).toBe(true);
      expect(JSON.stringify(failedBody)).not.toContain(unknownContent);
      expect(JSON.stringify(failedBody)).not.toContain(idempotencyKey);
      expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
      expect(taskIdFactoryCalls).toBe(1);
      expect(recordAfterFailure?.status).toBe("failed");
      expect(recordAfterFailure?.result_ref).toBeUndefined();
      expect(sameAppList.status).toBe(200);
      expect(await sameAppList.json()).toEqual({ tasks: [] });
      expect(sameAppDetail.status).toBe(404);
      expect(freshList.status).toBe(200);
      expect(await freshList.json()).toEqual({ tasks: [] });
      expect(freshDetail.status).toBe(404);
      await expectPathMissing(snapshotPath);

      const repairedReplayResponse = await postTask(replayApp, taskBody, {
        "Idempotency-Key": idempotencyKey
      });
      const repairedTask = (await repairedReplayResponse.json()) as TaskCard;
      const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);

      expect(repairedReplayResponse.status).toBe(201);
      expect(repairedTask.task_id).toBe(retryTaskId);
      expect(repairedTask.title).toBe(task.title);
      expect(taskIdFactoryCalls).toBe(2);
      expect(recordAfterRetry?.status).toBe("completed");
      expect(recordAfterRetry?.result_ref).toBe(repairedTask.task_id);
      expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([repairedTask.task_id]);
    }
  });

  test("invalid completed authority cleanup preserves a valid successor published after invalidation", async () => {
    for (const invalidAuthority of ["malformed", "invalid"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const taskId = `TASK-completed-successor-${invalidAuthority}`;
      const invalidKey = `task:create:completed-invalid-${invalidAuthority}`;
      const successorKey = `task:create:completed-successor-${invalidAuthority}`;
      const taskBody = validTaskCreateBody({
        title: `Completed cleanup successor ${invalidAuthority}`
      });
      const requestDigest = sha256Hex(canonicalJson(taskBody));
      const creatingApp = createBackendApi({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:30.500Z"),
        taskIdFactory: () => taskId
      });
      const createResponse = await postTask(creatingApp, taskBody, {
        "Idempotency-Key": invalidKey
      });
      const task = (await createResponse.json()) as TaskCard;
      const snapshotPath = join(workspaceRoot, "tasks", taskId, "snapshot.json");
      const canonicalSnapshotText = await readFile(snapshotPath, "utf8");
      const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
      await idempotencyService.beginRecord({
        scope: "task",
        key: successorKey,
        requestDigest
      });
      await idempotencyService.completeRecord({
        scope: "task",
        key: successorKey,
        requestDigest,
        resultRef: taskId
      });

      if (invalidAuthority === "missing") {
        await rm(snapshotPath);
      } else if (invalidAuthority === "malformed") {
        await writeFile(snapshotPath, "{");
      } else {
        const invalidSnapshot = JSON.parse(canonicalSnapshotText) as Record<string, unknown>;
        invalidSnapshot.unknown_completed_authority = "must not authorize successor cleanup";
        await writeFile(snapshotPath, `${JSON.stringify(invalidSnapshot)}\n`);
      }
      const observedIdentity = invalidAuthority === "missing"
        ? undefined
        : await stat(snapshotPath, { bigint: true });
      let replacementCount = 0;
      let taskIdFactoryCalls = 0;
      let successorIdentity: { dev: bigint; ino: bigint } | undefined;
      const replayApp = createBackendApi({
        workspaceRoot,
        taskIdFactory: () => {
          taskIdFactoryCalls += 1;
          return `TASK-completed-successor-unexpected-${invalidAuthority}`;
        },
        idempotencyServiceFactory: (serviceOptions) => {
          const service = createIdempotencyRecordService(serviceOptions);
          return {
            ...service,
            invalidateCompletedRecord: async (input) => {
              try {
                return await service.invalidateCompletedRecord(input);
              } finally {
                if (input.key === invalidKey && replacementCount === 0) {
                  replacementCount += 1;
                  const successorTempPath = `${snapshotPath}.successor`;
                  await writeFile(successorTempPath, canonicalSnapshotText, {
                    flag: "wx",
                    mode: 0o600
                  });
                  await rm(snapshotPath, { recursive: true, force: true });
                  await rename(successorTempPath, snapshotPath);
                  const successorEntry = await stat(snapshotPath, { bigint: true });
                  successorIdentity = {
                    dev: successorEntry.dev,
                    ino: successorEntry.ino
                  };
                }
              }
            }
          };
        }
      });

      const failedResponse = await postTask(replayApp, taskBody, {
        "Idempotency-Key": invalidKey
      });
      const failedBody = (await failedResponse.json()) as ApiErrorResponse;
      const invalidRecord = await idempotencyService.getRecord("task", invalidKey);
      const successorRecordBeforeReplay = await idempotencyService.getRecord(
        "task",
        successorKey
      );

      expect(createResponse.status).toBe(201);
      expect(failedResponse.status).toBe(500);
      expectCanonicalError(failedBody, "workspace_error");
      expect(failedBody.error.message).toBe(INVALID_DURABLE_TASK_AUTHORITY_MESSAGE);
      expect(replacementCount).toBe(1);
      expect(taskIdFactoryCalls).toBe(0);
      expect(successorIdentity).toBeDefined();
      if (observedIdentity) {
        expect({ dev: successorIdentity!.dev, ino: successorIdentity!.ino }).not.toEqual({
          dev: observedIdentity.dev,
          ino: observedIdentity.ino
        });
      }
      expect(await readFile(snapshotPath, "utf8")).toBe(canonicalSnapshotText);
      expect(invalidRecord?.status).toBe("failed");
      expect(invalidRecord?.result_ref).toBeUndefined();
      expect(successorRecordBeforeReplay?.status).toBe("completed");
      expect(successorRecordBeforeReplay?.result_ref).toBe(taskId);

      const successorReplay = await postTask(replayApp, taskBody, {
        "Idempotency-Key": successorKey
      });
      expect(successorReplay.status).toBe(200);
      expect(await successorReplay.json()).toEqual(task);
      expect(await replayApp.request("/api/tasks").then((response) => response.json())).toEqual({
        tasks: [task]
      });
      const freshApp = createBackendApi({ workspaceRoot });
      expect(await freshApp.request("/api/tasks").then((response) => response.json())).toEqual({
        tasks: [task]
      });
      const freshReplay = await postTask(freshApp, taskBody, {
        "Idempotency-Key": successorKey
      });
      expect(freshReplay.status).toBe(200);
      expect(await freshReplay.json()).toEqual(task);
      expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([taskId]);
      expect(taskIdFactoryCalls).toBe(0);
    }
  });

  test("completed A invalidation installs durable B and boundedly converges when B changes during settlement", async () => {
    for (const settlement of ["stable_b", "b_changes_to_d"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const idempotencyKey = `task:create:r23-successor-${settlement}`;
      const taskId = `TASK-r23-successor-a-${settlement}`;
      const repairedTaskId = `TASK-r23-successor-c-${settlement}`;
      const taskIds = [taskId, repairedTaskId];
      let taskIdFactoryCalls = 0;
      const taskBody = validTaskCreateBody({
        title: `R23 cached authority A ${settlement}`
      });
      const app = createBackendApi({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:30.625Z"),
        taskIdFactory: () => {
          taskIdFactoryCalls += 1;
          return taskIds.shift() ?? `${repairedTaskId}-unexpected`;
        }
      });
      const createResponse = await postTask(app, taskBody, {
        "Idempotency-Key": idempotencyKey
      });
      const taskA = (await createResponse.json()) as TaskCard;
      const snapshotPath = join(workspaceRoot, "tasks", taskId, "snapshot.json");
      const snapshotA = JSON.parse(
        await readFile(snapshotPath, "utf8")
      ) as TaskSnapshot & { task_card: TaskCard };
      const identityA = await stat(snapshotPath, { bigint: true });
      const taskB: TaskCard = {
        ...taskA,
        title: `R23 durable successor B ${settlement}`
      };
      const snapshotB = { ...snapshotA, task_card: taskB };
      const bytesB = Buffer.from(`${JSON.stringify(snapshotB, null, 2)}\n`);
      const tempBPath = `${snapshotPath}.b`;
      await writeFile(tempBPath, bytesB, { flag: "wx", mode: 0o600 });
      await rename(tempBPath, snapshotPath);
      const identityB = await stat(snapshotPath, { bigint: true });
      const taskD: TaskCard = {
        ...taskB,
        title: `R23 settlement successor D ${settlement}`
      };
      const snapshotD = { ...snapshotA, task_card: taskD };
      const bytesD = Buffer.from(`${JSON.stringify(snapshotD, null, 2)}\n`);
      const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
      const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
      let settlementReplacementCount = 0;
      let identityD:
        | { readonly dev: bigint; readonly ino: bigint }
        | undefined;

      const replay = () =>
        postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
      const initialResponse = settlement === "stable_b"
        ? await replay()
        : await runWithWorkspaceRecordPublicationHooks(
            {
              beforeCleanupPermitIdentityResolution: async ({ path }) => {
                if (path !== snapshotPath || settlementReplacementCount > 0) return;
                settlementReplacementCount += 1;
                const tempDPath = `${snapshotPath}.d`;
                await writeFile(tempDPath, bytesD, { flag: "wx", mode: 0o600 });
                await rename(tempDPath, snapshotPath);
                const successor = await stat(snapshotPath, { bigint: true });
                identityD = { dev: successor.dev, ino: successor.ino };
              }
            },
            replay
          );
      const initialBody = (await initialResponse.json()) as ApiErrorResponse;
      const expectedSuccessor = settlement === "stable_b" ? taskB : taskD;
      const expectedBytes = settlement === "stable_b" ? bytesB : bytesD;
      const expectedIdentity = settlement === "stable_b"
        ? { dev: identityB.dev, ino: identityB.ino }
        : identityD!;
      const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
      let failedResponse = initialResponse;
      let failedBody = initialBody;
      if (settlement === "b_changes_to_d") {
        const retainedRecord = await idempotencyService.getRecord("task", idempotencyKey);
        const retainedList = await app.request("/api/tasks");
        const retainedIdentity = await stat(snapshotPath, { bigint: true });

        expect(initialResponse.status).toBe(500);
        expectCanonicalError(initialBody, "workspace_error");
        expect(initialBody.error.message).toBe(
          "Observed task snapshot changed before exact cache settlement."
        );
        expect(retainedRecord?.status).toBe("completed");
        expect(retainedRecord?.result_ref).toBe(taskId);
        expect(await retainedList.json()).toEqual({ tasks: [taskD] });
        expect(await readFile(snapshotPath)).toEqual(bytesD);
        expect({ dev: retainedIdentity.dev, ino: retainedIdentity.ino }).toEqual(identityD!);

        failedResponse = await replay();
        failedBody = (await failedResponse.json()) as ApiErrorResponse;
      }
      const invalidatedRecord = await idempotencyService.getRecord("task", idempotencyKey);
      const sameAppList = await app.request("/api/tasks");
      const sameAppDetail = await app.request(`/api/tasks/${taskId}`);
      const freshApp = createBackendApi({ workspaceRoot });
      const freshList = await freshApp.request("/api/tasks");
      const freshDetail = await freshApp.request(`/api/tasks/${taskId}`);
      const currentIdentity = await stat(snapshotPath, { bigint: true });

      expect(createResponse.status).toBe(201);
      expect(taskA.task_id).toBe(taskId);
      expect({ dev: identityB.dev, ino: identityB.ino }).not.toEqual({
        dev: identityA.dev,
        ino: identityA.ino
      });
      expect(failedResponse.status).toBe(500);
      expectCanonicalError(failedBody, "workspace_error");
      expect(failedBody.error.message).toBe(INVALID_DURABLE_TASK_AUTHORITY_MESSAGE);
      expect(failedBody.error.retryable).toBe(true);
      expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
      expect(settlementReplacementCount).toBe(settlement === "stable_b" ? 0 : 1);
      if (settlement === "b_changes_to_d") {
        expect(identityD).toBeDefined();
        expect(identityD).not.toEqual({ dev: identityB.dev, ino: identityB.ino });
      }
      expect(await readFile(snapshotPath)).toEqual(expectedBytes);
      expect({ dev: currentIdentity.dev, ino: currentIdentity.ino }).toEqual(expectedIdentity);
      expect(invalidatedRecord?.status).toBe("failed");
      expect(invalidatedRecord?.result_ref).toBeUndefined();
      expect(sameAppList.status).toBe(200);
      expect(await sameAppList.json()).toEqual({ tasks: [expectedSuccessor] });
      expect(sameAppDetail.status).toBe(200);
      expect(await sameAppDetail.json()).toEqual(expectedSuccessor);
      expect(freshList.status).toBe(200);
      expect(await freshList.json()).toEqual({ tasks: [expectedSuccessor] });
      expect(freshDetail.status).toBe(200);
      expect(await freshDetail.json()).toEqual(expectedSuccessor);
      expect(taskIdFactoryCalls).toBe(1);
      expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
      expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);

      const repairedResponse = await postTask(app, taskBody, {
        "Idempotency-Key": idempotencyKey
      });
      const repairedTask = (await repairedResponse.json()) as TaskCard;
      const repairedRecord = await idempotencyService.getRecord("task", idempotencyKey);
      const expectedTasks = [expectedSuccessor, repairedTask];
      const sameAppAfterRepair = await app.request("/api/tasks");
      const freshAppAfterRepair = createBackendApi({ workspaceRoot });
      const freshListAfterRepair = await freshAppAfterRepair.request("/api/tasks");
      const freshSuccessorDetail = await freshAppAfterRepair.request(`/api/tasks/${taskId}`);
      const freshRepairDetail = await freshAppAfterRepair.request(
        `/api/tasks/${repairedTaskId}`
      );
      const identityAfterRepair = await stat(snapshotPath, { bigint: true });

      expect(repairedResponse.status).toBe(201);
      expect(repairedTask.task_id).toBe(repairedTaskId);
      expect(repairedRecord?.status).toBe("completed");
      expect(repairedRecord?.result_ref).toBe(repairedTaskId);
      expect(taskIdFactoryCalls).toBe(2);
      expect(await sameAppAfterRepair.json()).toEqual({ tasks: expectedTasks });
      expect(await freshListAfterRepair.json()).toEqual({ tasks: expectedTasks });
      expect(await freshSuccessorDetail.json()).toEqual(expectedSuccessor);
      expect(await freshRepairDetail.json()).toEqual(repairedTask);
      expect(await readFile(snapshotPath)).toEqual(expectedBytes);
      expect({ dev: identityAfterRepair.dev, ino: identityAfterRepair.ino }).toEqual(
        expectedIdentity
      );
      expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
      expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
    }
  });

  test("invalid completed cleanup preserves a same-inode snapshot after a pre-consume sibling write", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const taskId = "TASK-invalid-completion-strategy-14";
    const idempotencyKey = "task:create:invalid-completion-strategy-14";
    const taskBody = validTaskCreateBody({
      title: "Invalid completion Strategy 14"
    });
    const creatingApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:30.750Z"),
      taskIdFactory: () => taskId
    });
    const createResponse = await postTask(creatingApp, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const task = (await createResponse.json()) as TaskCard;
    const snapshotPath = join(workspaceRoot, "tasks", taskId, "snapshot.json");
    const taskDirectory = dirname(snapshotPath);
    const canonicalSnapshotText = await readFile(snapshotPath, "utf8");
    const invalidSnapshot = JSON.parse(canonicalSnapshotText) as Record<string, unknown>;
    invalidSnapshot.unknown_strategy_14_authority = "observe before sibling write";
    const invalidSnapshotText = `${JSON.stringify(invalidSnapshot)}\n`;
    await writeFile(snapshotPath, invalidSnapshotText);
    const observedSnapshot = await stat(snapshotPath, { bigint: true });
    const siblingSchema = z.object({ id: z.string() });
    const sibling = { id: "invalid-completion-strategy-14-sibling" };
    const siblingFileName = "invalid-completion-sibling.json";
    const siblingEvidenceRef = `workspace/tasks/${taskId}/${siblingFileName}`;
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let invalidationCount = 0;
    let taskIdFactoryCalls = 0;
    let parentBefore:
      | { dev: bigint; ino: bigint; ctimeNs: bigint; mtimeNs: bigint }
      | undefined;
    let parentAfter:
      | { dev: bigint; ino: bigint; ctimeNs: bigint; mtimeNs: bigint }
      | undefined;
    let restoredSnapshot: { dev: bigint; ino: bigint } | undefined;
    const replayApp = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-invalid-completion-strategy-14-unexpected";
      },
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          invalidateCompletedRecord: async (input) => {
            try {
              return await service.invalidateCompletedRecord(input);
            } finally {
              if (input.key === idempotencyKey && invalidationCount === 0) {
                invalidationCount += 1;
                const parentBeforeEntry = await stat(taskDirectory, { bigint: true });
                parentBefore = {
                  dev: parentBeforeEntry.dev,
                  ino: parentBeforeEntry.ino,
                  ctimeNs: parentBeforeEntry.ctimeNs,
                  mtimeNs: parentBeforeEntry.mtimeNs
                };
                await writeJsonRecord(
                  workspaceRoot,
                  ["tasks", taskId],
                  siblingFileName,
                  sibling,
                  siblingEvidenceRef,
                  siblingSchema
                );
                const parentAfterEntry = await stat(taskDirectory, { bigint: true });
                parentAfter = {
                  dev: parentAfterEntry.dev,
                  ino: parentAfterEntry.ino,
                  ctimeNs: parentAfterEntry.ctimeNs,
                  mtimeNs: parentAfterEntry.mtimeNs
                };
                const snapshotHandle = await open(snapshotPath, "r+");
                try {
                  const canonicalBytes = Buffer.from(canonicalSnapshotText);
                  await snapshotHandle.truncate(0);
                  const writeResult = await snapshotHandle.write(
                    canonicalBytes,
                    0,
                    canonicalBytes.length,
                    0
                  );
                  expect(writeResult.bytesWritten).toBe(canonicalBytes.length);
                  await snapshotHandle.sync();
                } finally {
                  await snapshotHandle.close();
                }
                const restoredEntry = await stat(snapshotPath, { bigint: true });
                restoredSnapshot = {
                  dev: restoredEntry.dev,
                  ino: restoredEntry.ino
                };
              }
            }
          }
        };
      }
    });

    const failedResponse = await postTask(replayApp, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const invalidatedRecord = await idempotencyService.getRecord(
      "task",
      idempotencyKey
    );

    expect(createResponse.status).toBe(201);
    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expect(failedBody.error.message).toBe(INVALID_DURABLE_TASK_AUTHORITY_MESSAGE);
    expect(invalidationCount).toBe(1);
    expect(taskIdFactoryCalls).toBe(0);
    expect(parentBefore).toBeDefined();
    expect(parentAfter).toBeDefined();
    expect(parentAfter!.dev).toBe(parentBefore!.dev);
    expect(parentAfter!.ino).toBe(parentBefore!.ino);
    expect(
      parentAfter!.ctimeNs === parentBefore!.ctimeNs &&
        parentAfter!.mtimeNs === parentBefore!.mtimeNs
    ).toBe(false);
    expect(restoredSnapshot).toEqual({
      dev: observedSnapshot.dev,
      ino: observedSnapshot.ino
    });
    expect(await readFile(snapshotPath, "utf8")).toBe(canonicalSnapshotText);
    expect(
      JSON.parse(
        await readFile(join(taskDirectory, siblingFileName), "utf8")
      )
    ).toEqual(sibling);
    expect(invalidatedRecord?.status).toBe("failed");
    expect(invalidatedRecord?.result_ref).toBeUndefined();
    const freshApp = createBackendApi({ workspaceRoot });
    expect(await freshApp.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [task]
    });
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([taskId]);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });

  test("completed replay preserves an unowned hardlinked TaskSnapshot generation", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:hardlinked-completed-snapshot";
    const taskIds = ["TASK-hardlinked-completed", "TASK-hardlinked-repaired"];
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return taskIds.shift() ?? "TASK-hardlinked-unexpected";
      }
    });
    const taskBody = validTaskCreateBody();
    const createResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const createdTask = (await createResponse.json()) as TaskCard;
    const snapshotPath = join(
      workspaceRoot,
      "tasks",
      createdTask.task_id,
      "snapshot.json"
    );
    const outsideAlias = join(tempRoot, "outside-hardlinked-task-snapshot.json");
    const snapshotBytes = await readFile(snapshotPath);
    await link(snapshotPath, outsideAlias);

    const replayResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const replayBody = (await replayResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const retainedRecord = await idempotencyService.getRecord("task", idempotencyKey);
    const sameAppList = await app.request("/api/tasks");
    const sameAppDetail = await app.request(`/api/tasks/${createdTask.task_id}`);
    const freshApp = createBackendApi({ workspaceRoot });
    const freshList = await freshApp.request("/api/tasks");
    const freshDetail = await freshApp.request(`/api/tasks/${createdTask.task_id}`);

    expect(createResponse.status).toBe(201);
    expect(replayResponse.status).toBe(500);
    expectCanonicalError(replayBody, "workspace_error");
    expect(replayBody.error.message).toBe("Record path is not a safe regular file.");
    expect(JSON.stringify(replayBody)).not.toContain(idempotencyKey);
    expectNoAbsoluteWorkspacePath(replayBody, tempRoot, workspaceRoot);
    expect(retainedRecord?.status).toBe("completed");
    expect(retainedRecord?.result_ref).toBe(createdTask.task_id);
    expect(sameAppList.status).toBe(200);
    expect(await sameAppList.json()).toEqual({ tasks: [createdTask] });
    expect(sameAppDetail.status).toBe(200);
    expect(await sameAppDetail.json()).toEqual(createdTask);
    expect(freshList.status).toBe(500);
    expectCanonicalError((await freshList.json()) as ApiErrorResponse, "workspace_error");
    expect(freshDetail.status).toBe(500);
    expectCanonicalError((await freshDetail.json()) as ApiErrorResponse, "workspace_error");
    expect(await readFile(snapshotPath)).toEqual(snapshotBytes);
    expect(await readFile(outsideAlias)).toEqual(snapshotBytes);
    expect((await stat(snapshotPath)).nlink).toBe(2);
    expect((await stat(outsideAlias)).nlink).toBe(2);
    expect(taskIdFactoryCalls).toBe(1);

    await unlink(outsideAlias);
    const repairedResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const repairedTask = (await repairedResponse.json()) as TaskCard;
    const repairedRecord = await idempotencyService.getRecord("task", idempotencyKey);

    expect(repairedResponse.status).toBe(200);
    expect(repairedTask).toEqual(createdTask);
    expect(repairedRecord).toEqual(retainedRecord);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([createdTask.task_id]);
    expect(await readFile(snapshotPath)).toEqual(snapshotBytes);
    await expectPathMissing(outsideAlias);
    expect((await stat(snapshotPath)).nlink).toBe(1);
    expect(taskIdFactoryCalls).toBe(1);
    expect(taskIds).toEqual(["TASK-hardlinked-repaired"]);
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

  test("POST /api/tasks retains equal-ref drift before exact missing reproof", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:equal-ref-post-complete-delete";
    const taskIds = ["TASK-equal-ref-deleted", "TASK-equal-ref-repaired"];
    let shouldDeleteCompletedSnapshot = true;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.420Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-equal-ref-unexpected",
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          completeRecord: async (input) => {
            const completed = await service.completeRecord(input);
            if (shouldDeleteCompletedSnapshot) {
              shouldDeleteCompletedSnapshot = false;
              await rm(join(workspaceRoot, "tasks", input.resultRef, "snapshot.json"));
            }
            return completed;
          }
        };
      }
    });

    const failedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
    const sameAppListResponse = await app.request("/api/tasks");
    const freshAppListResponse = await createBackendApi({ workspaceRoot }).request("/api/tasks");

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expect(failedBody.error.message).toBe(
      "Observed task snapshot changed before exact cache settlement."
    );
    expect(JSON.stringify(failedBody)).not.toContain(idempotencyKey);
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("completed");
    expect(recordAfterFailure?.result_ref).toBe("TASK-equal-ref-deleted");
    expect(sameAppListResponse.status).toBe(200);
    expect(await sameAppListResponse.json()).toEqual({ tasks: [] });
    expect(freshAppListResponse.status).toBe(200);
    expect(await freshAppListResponse.json()).toEqual({ tasks: [] });
    await expectPathMissing(
      join(workspaceRoot, "tasks", "TASK-equal-ref-deleted", "snapshot.json")
    );

    const invalidationResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const invalidationBody = (await invalidationResponse.json()) as ApiErrorResponse;
    const recordAfterInvalidation = await idempotencyService.getRecord(
      "task",
      idempotencyKey
    );

    expect(invalidationResponse.status).toBe(500);
    expectCanonicalError(invalidationBody, "workspace_error");
    expect(invalidationBody.error.message).toBe(INVALID_DURABLE_TASK_AUTHORITY_MESSAGE);
    expect(recordAfterInvalidation?.status).toBe("failed");
    expect(recordAfterInvalidation?.result_ref).toBeUndefined();

    const retryResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const retryTask = (await retryResponse.json()) as TaskCard;
    const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);

    expect(retryResponse.status).toBe(201);
    expect(retryTask.task_id).toBe("TASK-equal-ref-repaired");
    expect(taskIds).toEqual([]);
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(retryTask.task_id);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([retryTask.task_id]);
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
    expect(failedBody.error.retryable).toBe(true);
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
    expect(body.error.retryable).toBe(true);
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
    const foreignSnapshotPath = join(
      workspaceRoot,
      "tasks",
      foreignTask.task_id,
      "snapshot.json"
    );
    const foreignSnapshotText = await readFile(foreignSnapshotPath, "utf8");
    const primedListResponse = await app.request("/api/tasks");

    const response = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const body = (await response.json()) as ApiErrorResponse;
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
    const listAfterFailure = await app.request("/api/tasks");
    const detailAfterFailure = await app.request(`/api/tasks/${foreignTask.task_id}`);

    expect(primedListResponse.status).toBe(200);
    expect(await primedListResponse.json()).toEqual({ tasks: [foreignTask] });
    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.message).toBe(INVALID_DURABLE_TASK_AUTHORITY_MESSAGE);
    expect(body.error.retryable).toBe(true);
    expect(body.error.evidence_refs).toEqual([
      "workspace/tasks/_idempotency/task",
      "idempotency.result_ref"
    ]);
    expect(JSON.stringify(body)).not.toContain(idempotencyKey);
    expect(JSON.stringify(body)).not.toContain(foreignTask.task_id);
    expect(JSON.stringify(body)).not.toContain("Foreign task must not replay");
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
    expect(taskIdFactoryCalls).toBe(0);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(listAfterFailure.status).toBe(200);
    expect(await listAfterFailure.json()).toEqual({ tasks: [foreignTask] });
    expect(detailAfterFailure.status).toBe(200);
    expect(await detailAfterFailure.json()).toEqual(foreignTask);
    expect(await readFile(foreignSnapshotPath, "utf8")).toBe(foreignSnapshotText);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([foreignTask.task_id]);

    const retryResponse = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const retryTask = (await retryResponse.json()) as TaskCard;
    const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);

    expect(retryResponse.status).toBe(201);
    expect(retryTask.task_id).toBe("TASK-foreign-result-duplicate");
    expect(retryTask.title).toBe(taskBody.title);
    expect(taskIdFactoryCalls).toBe(1);
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(retryTask.task_id);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual(
      [foreignTask.task_id, retryTask.task_id].sort()
    );
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
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.message).toBe(INVALID_DURABLE_TASK_AUTHORITY_MESSAGE);
    expect(body.error.retryable).toBe(true);
    expect(body.error.evidence_refs).toEqual([
      "workspace/tasks/_idempotency/task",
      "idempotency.result_ref"
    ]);
    expect(JSON.stringify(body)).not.toContain(idempotencyKey);
    expect(JSON.stringify(body)).not.toContain(missingResultRef);
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
    expect(taskIdFactoryCalls).toBe(0);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([]);

    const retryResponse = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const retryTask = (await retryResponse.json()) as TaskCard;
    const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);

    expect(retryResponse.status).toBe(201);
    expect(retryTask.task_id).toBe("TASK-missing-result-duplicate");
    expect(taskIdFactoryCalls).toBe(1);
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(retryTask.task_id);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([retryTask.task_id]);
  });

  test("POST /api/tasks completed replay reports task_snapshot_missing_card for canonical snapshots without task_card", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:missing-card-result-ref";
    const taskBody = validTaskCreateBody();
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:31.950Z"),
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-missing-card-result";
      }
    });
    const createResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const targetTask = (await createResponse.json()) as TaskCard;
    const snapshotPath = join(workspaceRoot, "tasks", targetTask.task_id, "snapshot.json");
    const canonicalSnapshotText = await readFile(snapshotPath, "utf8");
    const snapshotWithoutTaskCard = JSON.parse(canonicalSnapshotText) as Record<string, unknown>;
    delete snapshotWithoutTaskCard.task_card;
    await writeFile(snapshotPath, `${JSON.stringify(snapshotWithoutTaskCard)}\n`);
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });

    const response = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const body = (await response.json()) as ApiErrorResponse;
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
    const listAfterFailure = await app.request("/api/tasks");
    const detailAfterFailure = await app.request(`/api/tasks/${targetTask.task_id}`);

    expect(createResponse.status).toBe(201);
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
    expect(taskIdFactoryCalls).toBe(1);
    expect(recordAfterFailure?.status).toBe("completed");
    expect(recordAfterFailure?.result_ref).toBe(targetTask.task_id);
    expect(listAfterFailure.status).toBe(200);
    expect(await listAfterFailure.json()).toEqual({ tasks: [] });
    expect(detailAfterFailure.status).toBe(404);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([targetTask.task_id]);

    await writeFile(snapshotPath, canonicalSnapshotText);
    const repairedReplayResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const repairedReplayTask = (await repairedReplayResponse.json()) as TaskCard;
    const recordAfterRepair = await idempotencyService.getRecord("task", idempotencyKey);
    const listAfterRepair = await app.request("/api/tasks");
    const detailAfterRepair = await app.request(`/api/tasks/${targetTask.task_id}`);

    expect(repairedReplayResponse.status).toBe(200);
    expect(repairedReplayTask).toEqual(targetTask);
    expect(recordAfterRepair).toEqual(recordAfterFailure);
    expect(taskIdFactoryCalls).toBe(1);
    expect(listAfterRepair.status).toBe(200);
    expect(await listAfterRepair.json()).toEqual({ tasks: [targetTask] });
    expect(detailAfterRepair.status).toBe(200);
    expect(await detailAfterRepair.json()).toEqual(targetTask);
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

  test("POST /api/tasks stale polling classifies a completed durable authority", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:stale-poll-completes";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const authoritativeTask = await createTaskCardService({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:34.000Z"),
      taskIdFactory: () => "TASK-stale-poll-authority"
    }).createTask(taskBody);
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    await idempotencyService.beginRecord({
      scope: "task",
      key: idempotencyKey,
      requestDigest
    });
    let resolveIncompleteBegin!: () => void;
    const incompleteBegin = new Promise<void>((resolveBegin) => {
      resolveIncompleteBegin = resolveBegin;
    });
    let taskIdFactoryCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-stale-poll-duplicate";
      },
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          beginRecord: async (input) => {
            const begin = await service.beginRecord(input);
            if (begin.status === "incomplete") {
              resolveIncompleteBegin();
            }
            return begin;
          }
        };
      }
    });

    const request = postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    await incompleteBegin;
    await idempotencyService.completeRecord({
      scope: "task",
      key: idempotencyKey,
      requestDigest,
      resultRef: authoritativeTask.task_id
    });
    const response = await request;
    const replayTask = (await response.json()) as TaskCard;

    expect(response.status).toBe(200);
    expect(replayTask).toEqual(authoritativeTask);
    expect(taskIdFactoryCalls).toBe(0);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([authoritativeTask.task_id]);
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

  test("POST /api/tasks attached followers share one completed-authority replay", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const ownerGate = createAsyncGate();
    const ownerSnapshotStarted = createSignal();
    const idempotencyKey = "task:create:shared-follower-replay";
    let lookupReplayCalls = 0;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:55.500Z"),
      requestLogSink: () => undefined,
      taskIdFactory: () => "TASK-shared-follower-replay",
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async () => {
          ownerSnapshotStarted.resolve();
          await ownerGate.wait;
        }
      },
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          lookupReplay: async (input) => {
            lookupReplayCalls += 1;
            return await service.lookupReplay(input);
          }
        };
      }
    });

    const ownerRequest = postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    await ownerSnapshotStarted.promise;
    const followerRequests = Array.from({ length: 12 }, () =>
      postTask(app, validTaskCreateBody(), { "Idempotency-Key": idempotencyKey })
    );
    await sleep(50);
    ownerGate.open();

    const [ownerResponse, followerResponses] = await Promise.all([
      ownerRequest,
      Promise.all(followerRequests)
    ]);
    const ownerTask = (await ownerResponse.json()) as TaskCard;
    const followerTasks = (await Promise.all(
      followerResponses.map((response) => response.json())
    )) as TaskCard[];

    expect(ownerResponse.status).toBe(201);
    expect(followerResponses.every((response) => response.status === 200)).toBe(true);
    expect(followerTasks.every((task) => JSON.stringify(task) === JSON.stringify(ownerTask))).toBe(
      true
    );
    expect(lookupReplayCalls).toBe(1);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([ownerTask.task_id]);
  });

  test("POST /api/tasks coalesces attached replay once per app-local TaskCard service", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const ownerGate = createAsyncGate();
    const ownerSnapshotStarted = createSignal();
    const idempotencyKey = "task:create:app-local-follower-replay";
    let ownerTaskIdFactoryCalls = 0;
    let followerBReplayCalls = 0;
    let followerCReplayCalls = 0;
    const ownerApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:55.625Z"),
      requestLogSink: () => undefined,
      taskIdFactory: () => {
        ownerTaskIdFactoryCalls += 1;
        return "TASK-app-local-follower-replay";
      },
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async () => {
          ownerSnapshotStarted.resolve();
          await ownerGate.wait;
        }
      }
    });
    const createFollowerApp = (onReplay: () => void) =>
      createBackendApi({
        workspaceRoot,
        requestLogSink: () => undefined,
        idempotencyServiceFactory: (serviceOptions) => {
          const service = createIdempotencyRecordService(serviceOptions);
          return {
            ...service,
            lookupReplay: async (input) => {
              if (input.key === idempotencyKey) onReplay();
              return await service.lookupReplay(input);
            }
          };
        }
      });
    const followerB = createFollowerApp(() => {
      followerBReplayCalls += 1;
    });
    const followerC = createFollowerApp(() => {
      followerCReplayCalls += 1;
    });

    expect(await followerB.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: []
    });
    expect(await followerC.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: []
    });

    const ownerRequest = postTask(ownerApp, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    await ownerSnapshotStarted.promise;
    const followerBRequest = postTask(followerB, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const followerCRequest = postTask(followerC, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    await sleep(50);
    ownerGate.open();

    const [ownerResponse, followerBResponse, followerCResponse] = await Promise.all([
      ownerRequest,
      followerBRequest,
      followerCRequest
    ]);
    const ownerTask = (await ownerResponse.json()) as TaskCard;
    const followerBTask = (await followerBResponse.json()) as TaskCard;
    const followerCTask = (await followerCResponse.json()) as TaskCard;

    expect([ownerResponse.status, followerBResponse.status, followerCResponse.status]).toEqual([
      201,
      200,
      200
    ]);
    expect(followerBTask).toEqual(ownerTask);
    expect(followerCTask).toEqual(ownerTask);
    expect(followerBReplayCalls).toBe(1);
    expect(followerCReplayCalls).toBe(1);
    expect(ownerTaskIdFactoryCalls).toBe(1);
    for (const app of [followerB, followerC]) {
      expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
        tasks: [ownerTask]
      });
      const detail = await app.request(`/api/tasks/${ownerTask.task_id}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toEqual(ownerTask);
    }
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([ownerTask.task_id]);
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
      const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
      const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
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
      await waitFor(
        () =>
          JSON.stringify(workspaceRecordAuthorityDiagnosticsForTest()) ===
            JSON.stringify(authorityBaseline) &&
          JSON.stringify(workspaceRecordDirectoryBindingDiagnosticsForTest()) ===
            JSON.stringify(bindingBaseline),
        "timed-out follower shared replay retained workspace diagnostics"
      );
      expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
      expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
    },
    20_000
  );

  test(
    "S27-P62-09 POST /api/tasks keeps detached terminal drivers registered and bounded",
    async () => {
      const routeSourceText = await readFile(new URL("./index.ts", import.meta.url), "utf8");
      const routeSource = ts.createSourceFile(
        "index.ts",
        routeSourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      const waitSource = sourceFunctionText(
        routeSource,
        "waitForInFlightIdempotentTaskCreate"
      );
      expect(routeSourceText).toContain("registeredTerminalReplayDrivers");
      expect(routeSourceText).toContain("registeredTerminalReplayDriverCount");
      expect(routeSourceText).toContain(
        "registeredTerminalReplayDriverCount >= MAX_IN_FLIGHT_IDEMPOTENT_TASK_CREATES"
      );
      expect(countSourceOccurrences(waitSource, "Promise.race")).toBe(0);
      expect(waitSource).toContain("setTimeout(");

      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const idempotencyKey = "task:create:detached-follower-waves";
      const ownerGate = createAsyncGate();
      const ownerSnapshotStarted = createSignal();
      let snapshotReads = 0;
      let beginRecordCalls = 0;
      let lookupReplayCalls = 0;
      const app = createBackendApi({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:56.160Z"),
        requestLogSink: () => undefined,
        taskIdFactory: () => "TASK-detached-follower-waves",
        taskSnapshotWriteHooks: {
          afterSnapshotWrite: async () => {
            ownerSnapshotStarted.resolve();
            await ownerGate.wait;
          }
        },
        taskSnapshotReadHooks: {
          beforeSnapshotOpen: ({ laneTaskId }) => {
            if (laneTaskId !== "TASK-detached-follower-waves") return;
            snapshotReads += 1;
          }
        },
        idempotencyServiceFactory: (serviceOptions) => {
          const service = createIdempotencyRecordService(serviceOptions);
          return {
            ...service,
            beginRecord: async (input) => {
              if (input.key === idempotencyKey) beginRecordCalls += 1;
              return await service.beginRecord(input);
            },
            lookupReplay: async (input) => {
              if (input.key === idempotencyKey) lookupReplayCalls += 1;
              return await service.lookupReplay(input);
            }
          };
        }
      });
      const taskBody = validTaskCreateBody();
      const ownerRequest = postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
      ownerRequest.catch(() => undefined);
      await ownerSnapshotStarted.promise;

      const runTimeoutWave = async (followerCount: number): Promise<void> => {
        const responses = await Promise.all(
          Array.from({ length: followerCount }, () =>
            postTask(app, taskBody, { "Idempotency-Key": idempotencyKey })
          )
        );
        const bodies = (await Promise.all(
          responses.map((response) => response.json())
        )) as ApiErrorResponse[];

        expect(responses.every((response) => response.status === 409)).toBe(true);
        expect(
          bodies.every(
            (body) =>
              body.error.message ===
              "Active idempotent task create did not finish before the follower wait timeout."
          )
        ).toBe(true);
      };

      try {
        await runTimeoutWave(1);
        await runTimeoutWave(IN_FLIGHT_TASK_CREATE_LIMIT);
        expect(lookupReplayCalls).toBe(0);
      } finally {
        ownerGate.open();
      }

      const ownerResponse = await ownerRequest;
      const ownerTask = (await ownerResponse.json()) as TaskCard;
      expect(ownerResponse.status).toBe(201);
      expect(lookupReplayCalls).toBe(0);

      const laterReplay = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
      const laterTask = (await laterReplay.json()) as TaskCard;
      expect(laterReplay.status).toBe(200);
      expect(laterTask).toEqual(ownerTask);
      expect(beginRecordCalls).toBe(2);
      expect(lookupReplayCalls).toBe(0);
    },
    40_000
  );

  test(
    "S27-P62-09 POST /api/tasks reuses a hung registered driver after owner release",
    async () => {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
      const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
      const idempotencyKey = "task:create:hung-shared-follower-replay";
      const ownerGate = createAsyncGate();
      const ownerSnapshotStarted = createSignal();
      const replayGate = createAsyncGate();
      const replayEntered = createSignal();
      const replayFinished = createSignal();
      const sharedClassificationStarted = createSignal();
      let snapshotWrites = 0;
      let ownerSnapshotReads = 0;
      let taskIdFactoryCalls = 0;
      let targetReplayCalls = 0;
      const app = createBackendApi({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:56.175Z"),
        requestLogSink: () => undefined,
        taskIdFactory: () => {
          taskIdFactoryCalls += 1;
          return `TASK-hung-shared-replay-${taskIdFactoryCalls}`;
        },
        taskSnapshotWriteHooks: {
          afterSnapshotWrite: async () => {
            snapshotWrites += 1;
            if (snapshotWrites !== 1) return;
            ownerSnapshotStarted.resolve();
            await ownerGate.wait;
          }
        },
        taskSnapshotReadHooks: {
          beforeSnapshotOpen: ({ laneTaskId }) => {
            if (laneTaskId !== "TASK-hung-shared-replay-1") return;
            ownerSnapshotReads += 1;
            if (ownerSnapshotReads === 2) sharedClassificationStarted.resolve();
          }
        },
        idempotencyServiceFactory: (serviceOptions) => {
          const service = createIdempotencyRecordService(serviceOptions);
          return {
            ...service,
            lookupReplay: async (input) => {
              if (input.key !== idempotencyKey) {
                return await service.lookupReplay(input);
              }
              targetReplayCalls += 1;
              replayEntered.resolve();
              await replayGate.wait;
              try {
                return await service.lookupReplay(input);
              } finally {
                replayFinished.resolve();
              }
            }
          };
        }
      });

      const ownerRequest = postTask(app, validTaskCreateBody(), {
        "Idempotency-Key": idempotencyKey
      });
      await ownerSnapshotStarted.promise;
      const firstJoinedAt = Date.now();
      const firstFollower = postTask(app, validTaskCreateBody(), {
        "Idempotency-Key": idempotencyKey
      }).then((response) => ({
        response,
        completedAt: Date.now(),
        elapsedMs: Date.now() - firstJoinedAt
      }));
      await sleep(250);
      const secondJoinedAt = Date.now();
      const secondFollower = postTask(app, validTaskCreateBody(), {
        "Idempotency-Key": idempotencyKey
      }).then((response) => ({
        response,
        completedAt: Date.now(),
        elapsedMs: Date.now() - secondJoinedAt
      }));
      await sleep(50);
      ownerGate.open();

      const ownerResponse = await ownerRequest;
      const ownerTask = (await ownerResponse.json()) as TaskCard;
      await Promise.race([
        replayEntered.promise,
        timeoutAfter(1_000, "shared follower replay did not start after owner completion")
      ]);
      const laterJoinedAt = Date.now();
      const laterFollower = postTask(app, validTaskCreateBody(), {
        "Idempotency-Key": idempotencyKey
      }).then((response) => ({
        response,
        elapsedMs: Date.now() - laterJoinedAt
      }));
      const distinctResponse = await Promise.race([
        postTask(app, validTaskCreateBody({ title: "Distinct after hung replay" }), {
          "Idempotency-Key": "task:create:distinct-after-hung-replay"
        }),
        timeoutAfter(1_000, "distinct caller was retained behind hung shared replay")
      ]);

      const [firstResult, secondResult, laterResult] = await Promise.all([
        firstFollower,
        secondFollower,
        laterFollower
      ]);
      const firstBody = (await firstResult.response.json()) as ApiErrorResponse;
      const secondBody = (await secondResult.response.json()) as ApiErrorResponse;
      const laterBody = (await laterResult.response.json()) as ApiErrorResponse;

      expect(ownerResponse.status).toBe(201);
      expect(ownerTask.task_id).toBe("TASK-hung-shared-replay-1");
      expect(distinctResponse.status).toBe(201);
      expect(firstResult.response.status).toBe(409);
      expect(secondResult.response.status).toBe(409);
      expect(laterResult.response.status).toBe(409);
      expect(firstBody.error.message).toBe(
        "Active idempotent task create did not finish before the follower wait timeout."
      );
      expect(secondBody.error.message).toBe(firstBody.error.message);
      expect(laterBody.error.message).toBe(firstBody.error.message);
      expect(firstResult.elapsedMs).toBeGreaterThanOrEqual(4_800);
      expect(secondResult.elapsedMs).toBeGreaterThanOrEqual(4_800);
      expect(firstResult.elapsedMs).toBeLessThan(6_500);
      expect(secondResult.elapsedMs).toBeLessThan(6_500);
      expect(laterResult.elapsedMs).toBeGreaterThanOrEqual(4_800);
      expect(laterResult.elapsedMs).toBeLessThan(6_500);
      expect(secondResult.completedAt - firstResult.completedAt).toBeGreaterThanOrEqual(150);
      expect(targetReplayCalls).toBe(1);
      expect(taskIdFactoryCalls).toBe(2);

      replayGate.open();
      await Promise.race([
        replayFinished.promise,
        timeoutAfter(1_000, "orphaned shared replay did not settle after release")
      ]);
      await Promise.race([
        sharedClassificationStarted.promise,
        timeoutAfter(1_000, "orphaned shared replay did not start authority classification")
      ]);
      await sleep(25);
      await waitFor(
        () =>
          JSON.stringify(workspaceRecordAuthorityDiagnosticsForTest()) ===
            JSON.stringify(authorityBaseline) &&
          JSON.stringify(workspaceRecordDirectoryBindingDiagnosticsForTest()) ===
            JSON.stringify(bindingBaseline),
        "orphaned shared replay retained workspace authority diagnostics"
      );
      expect(targetReplayCalls).toBe(1);
      expect(ownerSnapshotReads).toBe(2);
      expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
      expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
    },
    20_000
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

  test("POST /api/tasks physical workspace case aliases share one active owner when supported", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const aliasRoot = join(dirname(workspaceRoot), basename(workspaceRoot).toUpperCase());
    const physicalRoot = await realpath(workspaceRoot);
    let aliasPhysicalRoot: string;
    try {
      aliasPhysicalRoot = await realpath(aliasRoot);
    } catch {
      return;
    }
    if (aliasPhysicalRoot !== physicalRoot || aliasRoot === workspaceRoot) {
      return;
    }

    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    const idempotencyKey = "task:create:physical-workspace-alias";
    let resolveHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolveStarted) => {
      resolveHookStarted = resolveStarted;
    });
    let ownerTaskIdFactoryCalls = 0;
    let aliasTaskIdFactoryCalls = 0;
    const ownerApp = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:56.250Z"),
      taskIdFactory: () => {
        ownerTaskIdFactoryCalls += 1;
        return "TASK-physical-workspace-owner";
      },
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async () => {
          resolveHookStarted();
          await sleep(1_100);
        }
      }
    });
    const aliasApp = createBackendApi({
      workspaceRoot: aliasRoot,
      now: fixedNow("2026-07-07T12:03:56.250Z"),
      taskIdFactory: () => {
        aliasTaskIdFactoryCalls += 1;
        return "TASK-physical-workspace-alias-duplicate";
      }
    });

    const ownerRequest = postTask(ownerApp, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    await hookStarted;
    const aliasRequest = postTask(aliasApp, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const [ownerResponse, aliasResponse] = await Promise.all([ownerRequest, aliasRequest]);
    const ownerTask = (await ownerResponse.json()) as TaskCard;
    const aliasTask = (await aliasResponse.json()) as TaskCard;

    expect(ownerResponse.status).toBe(201);
    expect(aliasResponse.status).toBe(200);
    expect(aliasTask).toEqual(ownerTask);
    expect(ownerTaskIdFactoryCalls).toBe(1);
    expect(aliasTaskIdFactoryCalls).toBe(0);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([ownerTask.task_id]);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });

  test("POST /api/tasks physical workspace identity rejects a symlinked root", async () => {
    const tempRoot = await createTempRoot("shud-harness-physical-workspace-symlink-");
    tempRoots.push(tempRoot);
    const outsideRoot = join(tempRoot, "outside-workspace");
    const configuredRoot = join(tempRoot, "configured-workspace");
    await mkdir(outsideRoot);
    await symlink(outsideRoot, configuredRoot, "dir");
    const app = createBackendApi({
      workspaceRoot: configuredRoot,
      taskIdFactory: () => "TASK-symlinked-physical-workspace"
    });

    const response = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": "task:create:symlinked-physical-workspace"
    });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.message).toBe(
      "Workspace root cannot be identified safely for task idempotency coordination."
    );
    expect(body.error.evidence_refs).toEqual(["workspace"]);
    expectNoAbsoluteWorkspacePath(body, tempRoot, configuredRoot);
    await expectPathMissing(join(outsideRoot, "tasks"));
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

  test("POST /api/tasks bounds keyed and absent-key durable task-id collisions", async () => {
    for (const requestMode of ["keyed", "absent"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const collisionId = `TASK-constant-collision-${requestMode}`;
      let taskIdFactoryCalls = 0;
      const app = createBackendApi({
        workspaceRoot,
        taskIdFactory: () => {
          taskIdFactoryCalls += 1;
          return collisionId;
        }
      });
      expect(await app.request("/api/tasks").then((result) => result.json())).toEqual({
        tasks: []
      });
      const seed = await createTaskCardService({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:56.355Z"),
        taskIdFactory: () => collisionId
      }).createTask(validTaskCreateBody({ title: `Durable collision seed ${requestMode}` }));
      const snapshotPath = join(workspaceRoot, "tasks", collisionId, "snapshot.json");
      const seedBytes = await readFile(snapshotPath);
      const idempotencyKey = `task:create:constant-collision-${requestMode}`;

      const response = await postTask(
        app,
        validTaskCreateBody({ title: `Rejected collision ${requestMode}` }),
        requestMode === "keyed" ? { "Idempotency-Key": idempotencyKey } : {}
      );
      const body = (await response.json()) as ApiErrorResponse;

      expect(response.status).toBe(500);
      expectCanonicalError(body, "workspace_error");
      expect(body.error.message).toBe("Unable to generate a unique task id.");
      expect(body.error.evidence_refs).toEqual(["generated_task_id"]);
      expect(taskIdFactoryCalls).toBe(20);
      expect(await readFile(snapshotPath)).toEqual(seedBytes);
      expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([collisionId]);
      expect(await app.request("/api/tasks").then((result) => result.json())).toEqual({
        tasks: []
      });
      expect(
        await createBackendApi({ workspaceRoot })
          .request("/api/tasks")
          .then((result) => result.json())
      ).toEqual({ tasks: [seed] });
      if (requestMode === "keyed") {
        const record = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
          "task",
          idempotencyKey
        );
        expect(record?.status).toBe("failed");
        expect(record?.result_ref).toBeUndefined();
      }
    }
  });

  test("POST /api/tasks retries keyed and absent-key durable collisions with a unique id", async () => {
    for (const requestMode of ["keyed", "absent"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const collisionId = `TASK-retry-collision-${requestMode}`;
      const uniqueId = `TASK-retry-unique-${requestMode}`;
      const candidates = [collisionId, uniqueId];
      let taskIdFactoryCalls = 0;
      const app = createBackendApi({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:56.357Z"),
        taskIdFactory: () => {
          taskIdFactoryCalls += 1;
          return candidates.shift() ?? `${uniqueId}-unexpected`;
        }
      });
      expect(await app.request("/api/tasks").then((result) => result.json())).toEqual({
        tasks: []
      });
      const seed = await createTaskCardService({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:56.356Z"),
        taskIdFactory: () => collisionId
      }).createTask(validTaskCreateBody({ title: `Retry collision seed ${requestMode}` }));
      const taskBody = validTaskCreateBody({ title: `Unique after collision ${requestMode}` });
      const idempotencyKey = `task:create:retry-collision-${requestMode}`;

      const response = await postTask(
        app,
        taskBody,
        requestMode === "keyed" ? { "Idempotency-Key": idempotencyKey } : {}
      );
      const created = (await response.json()) as TaskCard;

      expect(response.status).toBe(201);
      expect(created.task_id).toBe(uniqueId);
      expect(taskIdFactoryCalls).toBe(2);
      expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([collisionId, uniqueId]);
      expect(await app.request("/api/tasks").then((result) => result.json())).toEqual({
        tasks: [created]
      });
      expect(
        await createBackendApi({ workspaceRoot })
          .request("/api/tasks")
          .then((result) => result.json())
      ).toEqual({ tasks: [seed, created] });
      if (requestMode === "keyed") {
        const replay = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(created);
        expect(taskIdFactoryCalls).toBe(2);
      }
    }
  });

  test("two apps atomically allocate a shared first task id in both owner orders", async () => {
    for (const owner of ["A", "B"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const sharedId = `TASK-two-app-shared-${owner}`;
      const uniqueIds = {
        A: `TASK-two-app-unique-a-${owner}`,
        B: `TASK-two-app-unique-b-${owner}`
      } as const;
      const keys = {
        A: `task:create:two-app-a-${owner}`,
        B: `task:create:two-app-b-${owner}`
      } as const;
      const bodies = {
        A: validTaskCreateBody({ title: `Two app body A, owner ${owner}` }),
        B: validTaskCreateBody({ title: `Two app body B, owner ${owner}` })
      } as const;
      const candidates = {
        A: [sharedId, uniqueIds.A],
        B: [sharedId, uniqueIds.B]
      };
      const factoryCalls = { A: 0, B: 0 };
      const ownerHookStarted = createSignal();
      const ownerRelease = createAsyncGate();
      const makeApp = (label: "A" | "B") => createBackendApi({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:56.358Z"),
        taskIdFactory: () => {
          factoryCalls[label] += 1;
          return candidates[label].shift() ?? `${uniqueIds[label]}-unexpected`;
        },
        taskSnapshotWriteHooks: label === owner
          ? {
              afterSnapshotWrite: async ({ taskId }) => {
                if (taskId !== sharedId) return;
                ownerHookStarted.resolve();
                await ownerRelease.wait;
              }
            }
          : undefined
      });
      const apps = { A: makeApp("A"), B: makeApp("B") };
      await Promise.all([
        apps.A.request("/api/tasks"),
        apps.B.request("/api/tasks")
      ]);
      const follower = owner === "A" ? "B" : "A";
      const ownerRequest = postTask(apps[owner], bodies[owner], {
        "Idempotency-Key": keys[owner]
      });
      await Promise.race([
        ownerHookStarted.promise,
        timeoutAfter(2_000, `two-app ${owner} owner did not publish the shared id`)
      ]);
      const followerRequest = postTask(apps[follower], bodies[follower], {
        "Idempotency-Key": keys[follower]
      });
      await waitFor(
        () => factoryCalls[follower] >= 1,
        `two-app ${follower} follower did not request the shared candidate`
      );
      ownerRelease.open();
      const [ownerResponse, followerResponse] = await Promise.all([
        ownerRequest,
        followerRequest
      ]);
      const tasks = {
        [owner]: (await ownerResponse.json()) as TaskCard,
        [follower]: (await followerResponse.json()) as TaskCard
      } as Record<"A" | "B", TaskCard>;

      expect(ownerResponse.status).toBe(201);
      expect(followerResponse.status).toBe(201);
      expect(tasks[owner].task_id).toBe(sharedId);
      expect(tasks[follower].task_id).toBe(uniqueIds[follower]);
      expect(tasks.A.title).toBe(bodies.A.title);
      expect(tasks.B.title).toBe(bodies.B.title);
      expect(factoryCalls[owner]).toBe(1);
      expect(factoryCalls[follower]).toBe(2);
      expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual(
        [tasks.A.task_id, tasks.B.task_id].sort()
      );
      for (const label of ["A", "B"] as const) {
        const detail = await apps[label].request(`/api/tasks/${tasks[label].task_id}`);
        expect(detail.status).toBe(200);
        expect(await detail.json()).toEqual(tasks[label]);
        const completed = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
          "task",
          keys[label]
        );
        expect(completed?.status).toBe("completed");
        expect(completed?.result_ref).toBe(tasks[label].task_id);
        const snapshot = JSON.parse(
          await readFile(
            join(workspaceRoot, "tasks", tasks[label].task_id, "snapshot.json"),
            "utf8"
          )
        ) as TaskSnapshot & { task_card: TaskCard };
        expect(snapshot.task_card).toEqual(tasks[label]);
      }

      const freshApp = createBackendApi({ workspaceRoot });
      expect(await freshApp.request("/api/tasks").then((response) => response.json())).toEqual({
        tasks: [tasks.A, tasks.B].sort((left, right) =>
          left.created_at.localeCompare(right.created_at) ||
          left.task_id.localeCompare(right.task_id)
        )
      });
      for (const label of ["A", "B"] as const) {
        const replayApp = createBackendApi({ workspaceRoot });
        const replay = await postTask(replayApp, bodies[label], {
          "Idempotency-Key": keys[label]
        });
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(tasks[label]);
        expect(
          await replayApp.request(`/api/tasks/${tasks[label].task_id}`).then((response) =>
            response.json()
          )
        ).toEqual(tasks[label]);
      }
    }
  });

  test(
    "S29-P62-08 owner-full terminal work is registered before durable classification",
    async () => {
      const routeSourceText = await readFile(new URL("./index.ts", import.meta.url), "utf8");
      const routeSource = ts.createSourceFile(
        "index.ts",
        routeSourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      const createBody = sourceFunctionText(routeSource, "createIdempotentTaskCard");
      const ownerFullBody = sourceFunctionText(
        routeSource,
        "resolveIdempotentTaskCreateThroughRegisteredDriver"
      );
      expect(createBody).toContain("resolveIdempotentTaskCreateThroughRegisteredDriver");
      expect(createBody).not.toContain("resolveIdempotentTaskCreateWithoutOwner(input)");
      expect(ownerFullBody.indexOf("waitForInFlightIdempotentTaskCreate")).toBeLessThan(
        ownerFullBody.indexOf("resolveIdempotentTaskCreateWithoutOwner")
      );
      expect(ownerFullBody).toContain("terminalOperation");
      const saturation = await createTempWorkspacePath();
      const target = await createTempWorkspacePath();
      tempRoots.push(saturation.tempRoot, target.tempRoot);
      const taskBody = validTaskCreateBody();
      const requestDigest = sha256Hex(
        canonicalJson({
          ...taskBody,
          created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
        })
      );
      const keys = {
        valid: "task:create:capacity-valid-replay",
        mismatch: "task:create:capacity-mismatch",
        invalidSafe: "task:create:capacity-invalid-safe",
        invalidCompleted: "task:create:capacity-invalid-completed",
        orphan: "task:create:capacity-started-orphan",
        failed: "task:create:capacity-failed",
        missing: "task:create:capacity-missing"
      } as const;
      const targetService = createIdempotencyRecordService({
        workspaceRoot: target.workspaceRoot
      });
      const validTask = await createTaskCardService({
        workspaceRoot: target.workspaceRoot,
        taskIdFactory: () => "TASK-capacity-valid-replay"
      }).createTask(taskBody);
      await targetService.beginRecord({
        scope: "task",
        key: keys.valid,
        requestDigest
      });
      await targetService.completeRecord({
        scope: "task",
        key: keys.valid,
        requestDigest,
        resultRef: validTask.task_id
      });
      await targetService.beginRecord({
        scope: "task",
        key: keys.mismatch,
        requestDigest: "digest-capacity-mismatch"
      });
      await targetService.beginRecord({
        scope: "task",
        key: keys.invalidSafe,
        requestDigest
      });
      await targetService.completeRecord({
        scope: "task",
        key: keys.invalidSafe,
        requestDigest,
        resultRef: "TASK-capacity-missing-authority"
      });
      await targetService.beginRecord({
        scope: "task",
        key: keys.orphan,
        requestDigest
      });
      await targetService.beginRecord({
        scope: "task",
        key: keys.failed,
        requestDigest
      });
      const failedBeforeCapacity = await targetService.failRecord({
        scope: "task",
        key: keys.failed,
        requestDigest
      });
      await writeFile(
        join(
          target.workspaceRoot,
          "tasks",
          "_idempotency",
          "task",
          idempotencyRecordFileName(keys.invalidCompleted)
        ),
        `${JSON.stringify({
          key: keys.invalidCompleted,
          scope: "task",
          request_digest: requestDigest,
          status: "completed",
          created_at: "2026-07-07T12:03:56.370Z",
          updated_at: "2026-07-07T12:03:56.370Z"
        })}\n`,
        { flag: "wx" }
      );

      let enteredOwners = 0;
      let resolveAllOwnersEntered!: () => void;
      const allOwnersEntered = new Promise<void>((resolveEntered) => {
        resolveAllOwnersEntered = resolveEntered;
      });
      let releaseOwners!: () => void;
      const ownersReleased = new Promise<void>((resolveRelease) => {
        releaseOwners = resolveRelease;
      });
      const ownerPrefix = "task:create:capacity-saturation:";
      const saturationApp = createBackendApi({
        workspaceRoot: saturation.workspaceRoot,
        requestLogSink: () => undefined,
        idempotencyServiceFactory: (serviceOptions) => {
          const service = createIdempotencyRecordService(serviceOptions);
          return {
            ...service,
            beginRecord: async (input) => {
              if (input.key.startsWith(ownerPrefix)) {
                enteredOwners += 1;
                if (enteredOwners === IN_FLIGHT_TASK_CREATE_LIMIT) {
                  resolveAllOwnersEntered();
                }
                await ownersReleased;
                throw new TaskServiceError({
                  code: "record_malformed",
                  status: 500,
                  category: "workspace_error",
                  message: "Injected saturated owner release failure.",
                  userMessage: "The saturated owner was released for test cleanup.",
                  evidenceRefs: ["workspace/tasks/_idempotency/task"],
                  retryable: false,
                  recommendedNextActions: ["Retry the request."]
                });
              }
              return await service.beginRecord(input);
            }
          };
        }
      });
      const ownerRequests = Array.from({ length: IN_FLIGHT_TASK_CREATE_LIMIT }, (_, index) =>
        postTask(saturationApp, taskBody, {
          "Idempotency-Key": `${ownerPrefix}${index}`
        })
      );
      let ownerResponses: Response[] = [];
      let targetTaskIdFactoryCalls = 0;
      const targetApp = createBackendApi({
        workspaceRoot: target.workspaceRoot,
        requestLogSink: () => undefined,
        taskIdFactory: () => {
          targetTaskIdFactoryCalls += 1;
          return "TASK-capacity-post-release";
        }
      });

      try {
        await Promise.race([
          allOwnersEntered,
          timeoutAfter(30_000, "in-flight map did not reach deterministic capacity")
        ]);

        const validResponse = await postTask(targetApp, taskBody, {
          "Idempotency-Key": keys.valid
        });
        const mismatchResponse = await postTask(targetApp, taskBody, {
          "Idempotency-Key": keys.mismatch
        });
        const invalidSafeResponse = await postTask(targetApp, taskBody, {
          "Idempotency-Key": keys.invalidSafe
        });
        const invalidSafeBody = (await invalidSafeResponse.json()) as ApiErrorResponse;
        const invalidCompletedResponse = await postTask(targetApp, taskBody, {
          "Idempotency-Key": keys.invalidCompleted
        });
        const invalidCompletedBody =
          (await invalidCompletedResponse.json()) as ApiErrorResponse;
        const orphanResponse = await postTask(targetApp, taskBody, {
          "Idempotency-Key": keys.orphan
        });
        const missingResponse = await postTask(targetApp, taskBody, {
          "Idempotency-Key": keys.missing
        });
        const missingBody = (await missingResponse.json()) as ApiErrorResponse;
        const failedResponse = await postTask(targetApp, taskBody, {
          "Idempotency-Key": keys.failed
        });
        const failedBody = (await failedResponse.json()) as ApiErrorResponse;

        expect(validResponse.status).toBe(200);
        expect(await validResponse.json()).toEqual(validTask);
        expect(mismatchResponse.status).toBe(422);
        expectCanonicalError(
          (await mismatchResponse.json()) as ApiErrorResponse,
          "idempotency_mismatch"
        );
        expect(invalidSafeResponse.status).toBe(500);
        expectCanonicalError(invalidSafeBody, "workspace_error");
        expect(invalidSafeBody.error.message).toBe(
          INVALID_DURABLE_TASK_AUTHORITY_MESSAGE
        );
        expect(invalidCompletedResponse.status).toBe(500);
        expectCanonicalError(invalidCompletedBody, "workspace_error");
        expect(invalidCompletedBody.error.message).toBe(
          "Completed idempotency record is missing result_ref."
        );
        expect(invalidCompletedBody.error.retryable).toBe(true);
        expect(orphanResponse.status).toBe(409);
        expect(missingResponse.status).toBe(409);
        expect(failedResponse.status).toBe(409);
        expect(missingBody.error.message).toBe(
          "Too many task idempotency requests are active in this process."
        );
        expect(failedBody.error.message).toBe(missingBody.error.message);
        expect(targetTaskIdFactoryCalls).toBe(0);
        expect(await targetService.getRecord("task", keys.invalidSafe)).toMatchObject({
          status: "failed"
        });
        expect(await targetService.getRecord("task", keys.invalidCompleted)).toMatchObject({
          status: "failed"
        });
        expect(await targetService.getRecord("task", keys.missing)).toBeUndefined();
        expect(await targetService.getRecord("task", keys.failed)).toEqual(
          failedBeforeCapacity
        );
        expect((await targetService.getRecord("task", keys.orphan))?.status).toBe(
          "started"
        );
      } finally {
        releaseOwners();
        ownerResponses = await Promise.all(ownerRequests);
      }

      expect(enteredOwners).toBe(IN_FLIGHT_TASK_CREATE_LIMIT);
      expect(ownerResponses).toHaveLength(IN_FLIGHT_TASK_CREATE_LIMIT);
      expect(ownerResponses.every((response) => response.status === 500)).toBe(true);
      const postReleaseResponse = await postTask(targetApp, taskBody, {
        "Idempotency-Key": keys.missing
      });
      const postReleaseTask = (await postReleaseResponse.json()) as TaskCard;
      expect(postReleaseResponse.status).toBe(201);
      expect(postReleaseTask.task_id).toBe("TASK-capacity-post-release");
      expect(targetTaskIdFactoryCalls).toBe(1);
    },
    60_000
  );

  test(
    "S29-P62-08 counts 1,024 pending terminal drivers before work and releases them for a second wave",
    async () => {
      const saturation = await createTempWorkspacePath();
      const target = await createTempWorkspacePath();
      tempRoots.push(saturation.tempRoot, target.tempRoot);
      const taskBody = validTaskCreateBody();
      const ownerPrefix = "task:create:terminal-driver-owner:";
      const firstWavePrefix = "task:create:terminal-driver-wave-1:";
      const secondWavePrefix = "task:create:terminal-driver-wave-2:";

      let enteredOwners = 0;
      let resolveAllOwnersEntered!: () => void;
      const allOwnersEntered = new Promise<void>((resolve) => {
        resolveAllOwnersEntered = resolve;
      });
      const ownerGate = createAsyncGate();
      const saturationApp = createBackendApi({
        workspaceRoot: saturation.workspaceRoot,
        requestLogSink: () => undefined,
        idempotencyServiceFactory: (serviceOptions) => {
          const service = createIdempotencyRecordService(serviceOptions);
          return {
            ...service,
            beginRecord: async (input) => {
              if (!input.key.startsWith(ownerPrefix)) {
                return await service.beginRecord(input);
              }
              enteredOwners += 1;
              if (enteredOwners === IN_FLIGHT_TASK_CREATE_LIMIT) {
                resolveAllOwnersEntered();
              }
              await ownerGate.wait;
              throw new TaskServiceError({
                code: "record_malformed",
                status: 500,
                category: "workspace_error",
                message: "Injected owner release after terminal-driver fixture.",
                userMessage: "The test owner was released.",
                evidenceRefs: ["workspace/tasks/_idempotency/task"],
                retryable: false,
                recommendedNextActions: ["Retry the request."]
              });
            }
          };
        }
      });
      const ownerRequests = Array.from({ length: IN_FLIGHT_TASK_CREATE_LIMIT }, (_, index) =>
        postTask(saturationApp, taskBody, {
          "Idempotency-Key": `${ownerPrefix}${index}`
        })
      );

      const firstWaveGate = createAsyncGate();
      const secondWaveGate = createAsyncGate();
      let totalDriverCalls = 0;
      let firstAppDriverCalls = 0;
      let secondAppDriverCalls = 0;
      let resolveFirstWaveEntered!: () => void;
      const firstWaveEntered = new Promise<void>((resolve) => {
        resolveFirstWaveEntered = resolve;
      });
      let resolveSecondWaveEntered!: () => void;
      const secondWaveEntered = new Promise<void>((resolve) => {
        resolveSecondWaveEntered = resolve;
      });
      const createDriverApp = (appIndex: 1 | 2) =>
        createBackendApi({
          workspaceRoot: target.workspaceRoot,
          requestLogSink: () => undefined,
          idempotencyServiceFactory: (serviceOptions) => {
            const service = createIdempotencyRecordService(serviceOptions);
            return {
              ...service,
              lookupReplay: async (input) => {
                if (
                  !input.key.startsWith(firstWavePrefix) &&
                  !input.key.startsWith(secondWavePrefix)
                ) {
                  return await service.lookupReplay(input);
                }
                totalDriverCalls += 1;
                if (appIndex === 1) firstAppDriverCalls += 1;
                else secondAppDriverCalls += 1;
                if (totalDriverCalls === IN_FLIGHT_TASK_CREATE_LIMIT) {
                  resolveFirstWaveEntered();
                } else if (totalDriverCalls === IN_FLIGHT_TASK_CREATE_LIMIT * 2) {
                  resolveSecondWaveEntered();
                }
                if (input.key.startsWith(firstWavePrefix)) {
                  await firstWaveGate.wait;
                } else {
                  await secondWaveGate.wait;
                }
                return { status: "missing" as const };
              }
            };
          }
        });
      const firstApp = createDriverApp(1);
      const secondApp = createDriverApp(2);
      let ownerResponses: Response[] = [];

      try {
        await Promise.race([
          allOwnersEntered,
          timeoutAfter(30_000, "owner map did not reach terminal-driver fixture capacity")
        ]);

        const firstWaveRequests = Array.from(
          { length: IN_FLIGHT_TASK_CREATE_LIMIT - 1 },
          (_, index) =>
            postTask(firstApp, taskBody, {
              "Idempotency-Key": `${firstWavePrefix}${index}`
            })
        );
        const sameDomainReuse = postTask(firstApp, taskBody, {
          "Idempotency-Key": `${firstWavePrefix}0`
        });
        const isolatedServiceRequest = postTask(secondApp, taskBody, {
          "Idempotency-Key": `${firstWavePrefix}0`
        });
        await Promise.race([
          firstWaveEntered,
          timeoutAfter(10_000, "1,024 terminal drivers did not enter the first gate")
        ]);

        const firstOverflow = await postTask(firstApp, taskBody, {
          "Idempotency-Key": `${firstWavePrefix}overflow`
        });
        expect(firstOverflow.status).toBe(409);
        expect(totalDriverCalls).toBe(IN_FLIGHT_TASK_CREATE_LIMIT);
        expect(firstAppDriverCalls).toBe(IN_FLIGHT_TASK_CREATE_LIMIT - 1);
        expect(secondAppDriverCalls).toBe(1);
        firstWaveGate.open();
        const firstWaveResponses = await Promise.all([
          ...firstWaveRequests,
          sameDomainReuse,
          isolatedServiceRequest
        ]);
        expect(firstWaveResponses).toHaveLength(IN_FLIGHT_TASK_CREATE_LIMIT + 1);
        expect(firstWaveResponses.every((response) => response.status === 409)).toBe(true);

        const secondWaveRequests = Array.from(
          { length: IN_FLIGHT_TASK_CREATE_LIMIT },
          (_, index) =>
            postTask(firstApp, taskBody, {
              "Idempotency-Key": `${secondWavePrefix}${index}`
            })
        );
        await Promise.race([
          secondWaveEntered,
          timeoutAfter(10_000, "1,024 terminal drivers did not enter the second gate")
        ]);
        const secondOverflow = await postTask(firstApp, taskBody, {
          "Idempotency-Key": `${secondWavePrefix}overflow`
        });
        expect(secondOverflow.status).toBe(409);
        expect(totalDriverCalls).toBe(IN_FLIGHT_TASK_CREATE_LIMIT * 2);
        expect(firstAppDriverCalls).toBe(IN_FLIGHT_TASK_CREATE_LIMIT * 2 - 1);
        expect(secondAppDriverCalls).toBe(1);
        secondWaveGate.open();
        const secondWaveResponses = await Promise.all(secondWaveRequests);
        expect(secondWaveResponses).toHaveLength(IN_FLIGHT_TASK_CREATE_LIMIT);
        expect(secondWaveResponses.every((response) => response.status === 409)).toBe(true);
      } finally {
        firstWaveGate.open();
        secondWaveGate.open();
        ownerGate.open();
        ownerResponses = await Promise.all(ownerRequests);
      }

      expect(enteredOwners).toBe(IN_FLIGHT_TASK_CREATE_LIMIT);
      expect(ownerResponses).toHaveLength(IN_FLIGHT_TASK_CREATE_LIMIT);
      expect(ownerResponses.every((response) => response.status === 500)).toBe(true);
    },
    60_000
  );

  test(
    "POST /api/tasks admits at most 1024 attached followers and releases their accounting",
    async () => {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const idempotencyKey = "task:create:follower-capacity";
      const ownerGate = createAsyncGate();
      const ownerSnapshotStarted = createSignal();
      let snapshotWrites = 0;
      let taskIdFactoryCalls = 0;
      let lookupReplayCalls = 0;
      const app = createBackendApi({
        workspaceRoot,
        now: fixedNow("2026-07-07T12:03:56.372Z"),
        requestLogSink: () => undefined,
        taskIdFactory: () => {
          taskIdFactoryCalls += 1;
          return `TASK-follower-capacity-${taskIdFactoryCalls}`;
        },
        taskSnapshotWriteHooks: {
          afterSnapshotWrite: async () => {
            snapshotWrites += 1;
            if (snapshotWrites !== 1) return;
            ownerSnapshotStarted.resolve();
            await ownerGate.wait;
          }
        },
        idempotencyServiceFactory: (serviceOptions) => {
          const service = createIdempotencyRecordService(serviceOptions);
          return {
            ...service,
            lookupReplay: async (input) => {
              lookupReplayCalls += 1;
              return await service.lookupReplay(input);
            }
          };
        }
      });

      const ownerRequest = postTask(app, validTaskCreateBody(), {
        "Idempotency-Key": idempotencyKey
      });
      await ownerSnapshotStarted.promise;
      const followerRequests = Array.from({ length: 1_025 }, () =>
        postTask(app, validTaskCreateBody(), { "Idempotency-Key": idempotencyKey })
      );
      let firstSettled: Response;
      try {
        firstSettled = await Promise.race([
          ...followerRequests,
          timeoutAfter(3_000, "bounded follower fixture did not reject its overflow")
        ]);
        expect(firstSettled.status).toBe(409);
        const capacityBody = (await firstSettled.json()) as ApiErrorResponse;
        expectCanonicalError(capacityBody, "workspace_error");
        expect(capacityBody.error.message).toBe(
          "Too many task idempotency requests are active in this process."
        );
      } finally {
        ownerGate.open();
      }

      const [ownerResponse, followerResponses] = await Promise.all([
        ownerRequest,
        Promise.all(followerRequests)
      ]);
      expect(ownerResponse.status).toBe(201);
      expect(followerResponses.filter((response) => response.status === 200)).toHaveLength(1_024);
      expect(followerResponses.filter((response) => response.status === 409)).toHaveLength(1);
      expect(lookupReplayCalls).toBe(1);

      const repairedReplay = await postTask(app, validTaskCreateBody(), {
        "Idempotency-Key": idempotencyKey
      });
      const distinctResponse = await postTask(
        app,
        validTaskCreateBody({ title: "Follower accounting released" }),
        { "Idempotency-Key": "task:create:follower-capacity-released" }
      );
      expect(repairedReplay.status).toBe(200);
      expect(distinctResponse.status).toBe(201);
      expect(taskIdFactoryCalls).toBe(2);
    },
    20_000
  );

  test(
    "POST /api/tasks terminal owner with delayed follower leaves room beside 1023 active owners",
    async () => {
      const terminal = await createTempWorkspacePath();
      const saturation = await createTempWorkspacePath();
      const admitted = await createTempWorkspacePath();
      tempRoots.push(terminal.tempRoot, saturation.tempRoot, admitted.tempRoot);
      const terminalKey = "task:create:terminal-delayed-follower";
      const terminalOwnerGate = createAsyncGate();
      const terminalOwnerStarted = createSignal();
      const delayedReplayGate = createAsyncGate();
      const delayedReplayEntered = createSignal();
      const activeOwnersGate = createAsyncGate();
      const allActiveOwnersEntered = createSignal();
      const activePrefix = "task:create:1023-active-owner:";
      let activeOwnersEntered = 0;
      let terminalFollower: Promise<Response> | undefined;
      let terminalOwner: Promise<Response> | undefined;
      let activeOwnerRequests: Promise<Response>[] = [];
      const terminalApp = createBackendApi({
        workspaceRoot: terminal.workspaceRoot,
        requestLogSink: () => undefined,
        taskIdFactory: () => "TASK-terminal-delayed-follower",
        taskSnapshotWriteHooks: {
          afterSnapshotWrite: async () => {
            terminalOwnerStarted.resolve();
            await terminalOwnerGate.wait;
          }
        },
        idempotencyServiceFactory: (serviceOptions) => {
          const service = createIdempotencyRecordService(serviceOptions);
          return {
            ...service,
            lookupReplay: async (input) => {
              if (input.key === terminalKey) {
                delayedReplayEntered.resolve();
                await delayedReplayGate.wait;
              }
              return await service.lookupReplay(input);
            }
          };
        }
      });
      const saturationApp = createBackendApi({
        workspaceRoot: saturation.workspaceRoot,
        requestLogSink: () => undefined,
        idempotencyServiceFactory: (serviceOptions) => {
          const service = createIdempotencyRecordService(serviceOptions);
          return {
            ...service,
            beginRecord: async (input) => {
              if (!input.key.startsWith(activePrefix)) {
                return await service.beginRecord(input);
              }
              activeOwnersEntered += 1;
              if (activeOwnersEntered === IN_FLIGHT_TASK_CREATE_LIMIT - 1) {
                allActiveOwnersEntered.resolve();
              }
              await activeOwnersGate.wait;
              throw new TaskServiceError({
                code: "record_malformed",
                status: 500,
                category: "workspace_error",
                message: "Injected 1023-owner fixture release.",
                userMessage: "The bounded owner fixture was released.",
                evidenceRefs: ["workspace/tasks/_idempotency/task"],
                retryable: false,
                recommendedNextActions: ["Retry the request."]
              });
            }
          };
        }
      });
      const admittedApp = createBackendApi({
        workspaceRoot: admitted.workspaceRoot,
        requestLogSink: () => undefined,
        taskIdFactory: () => "TASK-admitted-beside-1023"
      });

      try {
        terminalOwner = postTask(terminalApp, validTaskCreateBody(), {
          "Idempotency-Key": terminalKey
        });
        await terminalOwnerStarted.promise;
        terminalFollower = postTask(terminalApp, validTaskCreateBody(), {
          "Idempotency-Key": terminalKey
        });
        await sleep(50);
        terminalOwnerGate.open();
        const terminalOwnerResponse = await terminalOwner;
        expect(terminalOwnerResponse.status).toBe(201);
        await Promise.race([
          delayedReplayEntered.promise,
          timeoutAfter(1_000, "delayed follower did not enter shared replay")
        ]);

        activeOwnerRequests = Array.from(
          { length: IN_FLIGHT_TASK_CREATE_LIMIT - 1 },
          (_, index) =>
            postTask(saturationApp, validTaskCreateBody(), {
              "Idempotency-Key": `${activePrefix}${index}`
            })
        );
        await Promise.race([
          allActiveOwnersEntered.promise,
          timeoutAfter(30_000, "1023-owner bounded fixture did not become active")
        ]);

        const admittedResponse = await Promise.race([
          postTask(admittedApp, validTaskCreateBody(), {
            "Idempotency-Key": "task:create:admitted-beside-1023"
          }),
          timeoutAfter(2_000, "terminal follower entry consumed active-owner capacity")
        ]);
        expect(admittedResponse.status).toBe(201);
        expect((await admittedResponse.json()) as TaskCard).toMatchObject({
          task_id: "TASK-admitted-beside-1023"
        });
      } finally {
        terminalOwnerGate.open();
        activeOwnersGate.open();
        delayedReplayGate.open();
      }

      const activeOwnerResponses = await Promise.all(activeOwnerRequests);
      const terminalFollowerResponse = await terminalFollower!;
      expect(activeOwnersEntered).toBe(IN_FLIGHT_TASK_CREATE_LIMIT - 1);
      expect(activeOwnerResponses).toHaveLength(IN_FLIGHT_TASK_CREATE_LIMIT - 1);
      expect(activeOwnerResponses.every((response) => response.status === 500)).toBe(true);
      expect(terminalFollowerResponse.status).toBe(200);
    },
    60_000
  );

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
    360_000
  );

  test(
    "S29-P62-07 1,024 keyed tasks restart while the 1,025th task lane fails closed",
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
      for (let index = 0; index < IN_FLIGHT_TASK_CREATE_LIMIT; index += 1) {
        const response = await postTask(app, validTaskCreateBody(), {
          "Idempotency-Key": `task:create:capacity-cleanup:${index}`
        });
        expect(response.status).toBe(201);
        finalTask = (await response.json()) as TaskCard;
      }

      const freshAtLimit = createBackendApi({
        workspaceRoot,
        requestLogSink: () => undefined
      });
      const listAtLimit = await freshAtLimit.request("/api/tasks");
      const tasksAtLimit = (await listAtLimit.json()) as { tasks: TaskCard[] };
      const detailAtLimit = await freshAtLimit.request(
        `/api/tasks/${finalTask!.task_id}`
      );
      expect(listAtLimit.status).toBe(200);
      expect(tasksAtLimit.tasks).toHaveLength(IN_FLIGHT_TASK_CREATE_LIMIT);
      expect(detailAtLimit.status).toBe(200);

      const overflowResponse = await postTask(app, validTaskCreateBody(), {
        "Idempotency-Key": `task:create:capacity-cleanup:${IN_FLIGHT_TASK_CREATE_LIMIT}`
      });
      expect(overflowResponse.status).toBe(201);
      finalTask = (await overflowResponse.json()) as TaskCard;

      expect(nextId).toBe(IN_FLIGHT_TASK_CREATE_LIMIT + 1);
      expect(finalTask?.task_id).toBe("TASK-capacity-cleanup-1025");
      const finalRecord = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
        "task",
        `task:create:capacity-cleanup:${IN_FLIGHT_TASK_CREATE_LIMIT}`
      );
      expect(finalRecord?.status).toBe("completed");
      expect(finalRecord?.result_ref).toBe(finalTask?.task_id);
      const freshOverflow = createBackendApi({
        workspaceRoot,
        requestLogSink: () => undefined
      });
      expect((await freshOverflow.request("/api/tasks")).status).toBe(500);
    },
    360_000
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

  test("POST /api/tasks preserves a directory successor at the snapshot leaf", async () => {
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
    const successorPath = join(
      workspaceRoot,
      "tasks",
      "TASK-hook-directory",
      "snapshot.json"
    );
    expect((await stat(successorPath)).isDirectory()).toBe(true);
    expect(await readFile(join(successorPath, "nested.txt"), "utf8")).toBe(
      "untrusted replacement"
    );
    expect(freshListResponse.status).toBe(500);
    expectCanonicalError(
      (await freshListResponse.json()) as ApiErrorResponse,
      "workspace_error"
    );

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
    expect((await stat(successorPath)).isDirectory()).toBe(true);
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

  test("POST /api/tasks retains unknown rollback cache and retries after lane repair", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:unsafe-rollback-repair";
    const taskId = "TASK-unsafe-rollback-repair";
    const taskLane = join(workspaceRoot, "tasks", taskId);
    const outsideLane = join(tempRoot, "outside-unsafe-rollback-lane");
    const outsideSentinel = join(outsideLane, "snapshot.json");
    const outsideText = "outside rollback target must survive\n";
    let taskIdFactoryCalls = 0;
    let shouldSwapLane = true;
    await mkdir(outsideLane, { recursive: true });
    await writeFile(outsideSentinel, outsideText, { flag: "wx" });
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.615Z"),
      requestLogSink: () => undefined,
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return taskId;
      },
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          completeRecord: async (input) => {
            if (shouldSwapLane) {
              shouldSwapLane = false;
              await rm(taskLane, { recursive: true, force: true });
              await symlink(outsideLane, taskLane, "dir");
              throw new TaskServiceError({
                code: "record_malformed",
                status: 500,
                category: "workspace_error",
                message: "Injected completion failure after unsafe lane replacement.",
                userMessage: "The task completion could not be persisted safely.",
                evidenceRefs: ["workspace/tasks/_idempotency/task"],
                retryable: false,
                recommendedNextActions: ["Repair the task lane before retrying."]
              });
            }
            return await service.completeRecord(input);
          }
        };
      }
    });

    const firstResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const firstBody = (await firstResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFirst = await idempotencyService.getRecord("task", idempotencyKey);
    const firstList = await app.request("/api/tasks");
    const firstDetail = await app.request(`/api/tasks/${taskId}`);
    const firstListBody = (await firstList.json()) as { tasks: TaskCard[] };
    const retainedTask = firstListBody.tasks[0]!;

    const unsafeRetryResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const unsafeRetryBody = (await unsafeRetryResponse.json()) as ApiErrorResponse;
    const recordAfterUnsafeRetry = await idempotencyService.getRecord("task", idempotencyKey);

    expect(firstResponse.status).toBe(500);
    expectCanonicalError(firstBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(firstBody, tempRoot, workspaceRoot);
    expect(recordAfterFirst?.status).toBe("failed");
    expect(recordAfterFirst?.result_ref).toBeUndefined();
    expect(firstList.status).toBe(200);
    expect(firstListBody.tasks).toHaveLength(1);
    expect(retainedTask.task_id).toBe(taskId);
    expect(firstDetail.status).toBe(200);
    expect(await firstDetail.json()).toEqual(retainedTask);
    expect(unsafeRetryResponse.status).toBe(500);
    expectCanonicalError(unsafeRetryBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(unsafeRetryBody, tempRoot, workspaceRoot);
    expect(recordAfterUnsafeRetry?.status).toBe("failed");
    expect(recordAfterUnsafeRetry?.result_ref).toBeUndefined();
    expect(taskIdFactoryCalls).toBe(2);
    expect(await realpath(taskLane)).toBe(await realpath(outsideLane));
    expect(await readFile(outsideSentinel, "utf8")).toBe(outsideText);
    expect(await app.request("/api/tasks").then((response) => response.json())).toEqual({
      tasks: [retainedTask]
    });

    await unlink(taskLane);
    const repairedList = await createBackendApi({ workspaceRoot }).request("/api/tasks");
    const repairedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const repairedTask = (await repairedResponse.json()) as TaskCard;
    const recordAfterRepair = await idempotencyService.getRecord("task", idempotencyKey);

    expect(repairedList.status).toBe(200);
    expect(await repairedList.json()).toEqual({ tasks: [] });
    expect(repairedResponse.status).toBe(201);
    expect(repairedTask.task_id).toBe(taskId);
    expect(taskIdFactoryCalls).toBe(3);
    expect(recordAfterRepair?.status).toBe("completed");
    expect(recordAfterRepair?.result_ref).toBe(taskId);
    expect(await readFile(outsideSentinel, "utf8")).toBe(outsideText);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([taskId]);
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

  test("POST /api/tasks preserves semantic TaskServiceError fields across completion and release failure", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:semantic-completion-release-failure";
    const taskId = "TASK-semantic-completion-release-failure";
    const recordPath = join(
      workspaceRoot,
      "tasks",
      "_idempotency",
      "task",
      idempotencyRecordFileName(idempotencyKey)
    );
    const guardPath = join(
      workspaceRoot,
      "tasks",
      "_idempotency",
      "task",
      `${sha256Hex(`transition:${idempotencyKey}`)}.guard.json`
    );
    const semanticFailure = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "The completed idempotency record lost its semantic authority.",
      userMessage: "The task request conflicted with its durable idempotency authority.",
      evidenceRefs: ["workspace/tasks/_idempotency/task", "idempotency.semantic_authority"],
      retryable: true,
      recommendedNextActions: [
        "Inspect the retained idempotency evidence.",
        "Retry after repairing the transition authority."
      ]
    });
    const releaseFailure = new Error("Injected transition guard release failure.");
    let bodyFailureCount = 0;
    let releaseFailureCount = 0;
    let releaseNamespacePath: string | undefined;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.627Z"),
      taskIdFactory: () => taskId,
      idempotencyServiceFactory: (options) => {
        const service = createIdempotencyRecordService(options);
        return {
          ...service,
          completeRecord: async (input) =>
            await runWithWorkspaceRecordPublicationHooks(
              {
                afterTemporaryFileWritten: ({ canonicalPath }) => {
                  if (canonicalPath !== recordPath) return;
                  bodyFailureCount += 1;
                  throw semanticFailure;
                },
                beforeAuthorityNamespaceRemoval: ({ path }) => {
                  if (!basename(path).startsWith(`.${basename(guardPath)}-`)) return;
                  releaseNamespacePath ??= path;
                  if (path !== releaseNamespacePath) return;
                  releaseFailureCount += 1;
                  throw releaseFailure;
                }
              },
              () => service.completeRecord(input)
            )
        };
      }
    });

    const response = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const body = (await response.json()) as ApiErrorResponse;
    const recordAfterFailure = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(response.status).toBe(409);
    expect(body.error.category).toBe(semanticFailure.category);
    expect(body.error.message).toBe(semanticFailure.message);
    expect(body.error.user_message).toBe(semanticFailure.userMessage);
    expect(body.error.evidence_refs).toEqual(semanticFailure.evidenceRefs);
    expect(body.error.retryable).toBe(true);
    expect(body.error.recommended_next_actions).toEqual(
      semanticFailure.recommendedNextActions
    );
    expect(body.error.message).not.toBe("Unexpected backend route failure.");
    expect(bodyFailureCount).toBe(1);
    expect(releaseFailureCount).toBe(3);
    expect(recordAfterFailure?.status).toBe("failed");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([]);
  });

  test("S29-P62-10 POST /api/tasks binds descriptor-safe adapter at both route failure folds", async () => {
    const routeSourceText = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    const routeSource = ts.createSourceFile(
      "index.ts",
      routeSourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    expect(sourceFunctionText(routeSource, "observeTaskSnapshotBindsRequest")).toContain(
      "preserveTaskServiceErrorCompensationCompatibility"
    );
    expect(sourceFunctionText(routeSource, "preservePrimaryFailure")).toContain(
      "preserveTaskServiceErrorCompensationCompatibility"
    );
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:r28-frozen-semantic-error";
    const semanticFailure = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "R28 semantic completion authority failed.",
      userMessage: "The durable completion authority could not be reconciled.",
      evidenceRefs: ["idempotency.r28.semantic"],
      retryable: true,
      recommendedNextActions: ["Inspect the retained completion authority."]
    });
    let primaryCauseReads = 0;
    const originalPrimaryCause = new Error("R28 original primary cause");
    Object.defineProperty(semanticFailure, "cause", {
      configurable: false,
      enumerable: false,
      get: () => {
        primaryCauseReads += 1;
        return originalPrimaryCause;
      }
    });
    const originalCauseDescriptor = Object.getOwnPropertyDescriptor(semanticFailure, "cause");
    Object.freeze(semanticFailure);

    const reconciliationFailure = new Error("R28 cyclic reconciliation failure");
    let reconciliationCauseReads = 0;
    Object.defineProperty(reconciliationFailure, "cause", {
      configurable: false,
      enumerable: false,
      get: () => {
        reconciliationCauseReads += 1;
        return reconciliationFailure;
      }
    });
    let completionAttempted = false;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-15T12:28:11.000Z"),
      taskIdFactory: () => "TASK-r28-frozen-semantic-error",
      idempotencyServiceFactory: (options) => {
        const service = createIdempotencyRecordService(options);
        return {
          ...service,
          completeRecord: async () => {
            completionAttempted = true;
            throw semanticFailure;
          },
          lookupReplay: async (input) => {
            if (completionAttempted) throw reconciliationFailure;
            return await service.lookupReplay(input);
          },
          consumeCompletedRecord: async (input, consume) => {
            if (completionAttempted) throw reconciliationFailure;
            return await service.consumeCompletedRecord(input, consume);
          }
        };
      }
    });

    const response = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(semanticFailure.status);
    expect(body.error.category).toBe(semanticFailure.category);
    expect(body.error.message).toBe(semanticFailure.message);
    expect(body.error.user_message).toBe(semanticFailure.userMessage);
    expect(body.error.evidence_refs).toEqual(semanticFailure.evidenceRefs);
    expect(body.error.retryable).toBe(semanticFailure.retryable);
    expect(body.error.recommended_next_actions).toEqual(
      semanticFailure.recommendedNextActions
    );
    expect(Object.getOwnPropertyDescriptor(semanticFailure, "cause")).toEqual(
      originalCauseDescriptor
    );
    expect(primaryCauseReads).toBe(1);
    expect(reconciliationCauseReads).toBeLessThanOrEqual(1);
  });

  test("S30-P62-03/S31-P62-03/S32-P62-03 pre-completion primary dominates recovered-authority settlement", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const taskId = "TASK-s30-primary-before-rollback";
    const primary = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "S30 primary observation failure.",
      userMessage: "The original task operation failed before completion.",
      evidenceRefs: ["s30.primary"],
      retryable: true,
      recommendedNextActions: ["Inspect the primary operation evidence."]
    });
    let foreignIdentity: Awaited<ReturnType<typeof stat>> | undefined;
    let routedError: unknown;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => taskId,
      taskRouteErrorSinkForTest: (error) => {
        routedError = error;
      },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return {
          ...service,
          observeTaskSnapshotForCleanup: async () => {
            throw primary;
          },
          rollbackTaskForIdempotency: async (rollbackTaskId, expectedTask) => {
            const snapshotPath = join(
              workspaceRoot,
              "tasks",
              rollbackTaskId,
              "snapshot.json"
            );
            const bytes = await readFile(snapshotPath);
            const foreignPath = `${snapshotPath}.foreign`;
            await writeFile(foreignPath, bytes, { flag: "wx", mode: 0o600 });
            await rename(foreignPath, snapshotPath);
            foreignIdentity = await stat(snapshotPath, { bigint: true });
            await service.rollbackTaskForIdempotency(rollbackTaskId, expectedTask);
          }
        };
      }
    });

    const response = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": "task:create:s30-primary-before-rollback"
    });
    const body = (await response.json()) as ApiErrorResponse;
    const survivingIdentity = await stat(
      join(workspaceRoot, "tasks", taskId, "snapshot.json"),
      { bigint: true }
    );

    expect(response.status).toBe(primary.status);
    expect(body.error.category).toBe(primary.category);
    expect(body.error.message).toBe(primary.message);
    expect(body.error.user_message).toBe(primary.userMessage);
    expect(body.error.evidence_refs).toEqual(primary.evidenceRefs);
    expect(body.error.retryable).toBe(primary.retryable);
    expect(body.error.recommended_next_actions).toEqual(primary.recommendedNextActions);
    expect(foreignIdentity).toBeDefined();
    expect(survivingIdentity.dev).toBe(foreignIdentity!.dev);
    expect(survivingIdentity.ino).toBe(foreignIdentity!.ino);
    // Complete ordered compensation identity vector: the pre-completion
    // primary carries exactly the foreign-generation rollback refusal.
    expect(semanticPrimaryError(routedError)).toBe(primary);
    const orderedVector = orderedPreservedCompensationVector(routedError);
    expect(orderedVector.length).toBe(1);
    expect(orderedVector[0]).toBeInstanceOf(TaskServiceError);
    expect((orderedVector[0] as TaskServiceError).code).toBe("task_snapshot_mismatch");
    expect((orderedVector[0] as TaskServiceError).message).toBe(
      "Task rollback publication authority no longer matches the durable generation."
    );
  });

  test("S32-P62-03 competing completed cleanup consumes exact authority and preserves cleanup primary", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:s32-competing-cleanup";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(
      canonicalJson({
        ...taskBody,
        created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
      })
    );
    const authoritativeTask = await createTaskCardService({
      workspaceRoot,
      now: fixedNow("2026-07-15T12:28:10.900Z"),
      taskIdFactory: () => "TASK-s32-competing-authority"
    }).createTask(taskBody);
    const localTaskId = "TASK-s32-competing-local";
    const cleanupPrimary = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "S32 local cleanup failed after exact deletion.",
      userMessage: "The local task cleanup could not be confirmed.",
      evidenceRefs: ["s32.competing.cleanup"],
      retryable: true,
      recommendedNextActions: ["Inspect the local cleanup evidence."]
    });
    const quarantineCompensation = new Error(
      "S32 exact quarantine failed after committing its terminal outcome."
    );
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let completedByHook = false;
    let cleanupCalls = 0;
    let quarantineCalls = 0;
    let routedError: unknown;
    let capturedAuthority: CompletedIdempotencyRecordMutationAuthority | undefined;
    let routeIdempotencyService:
      | ReturnType<typeof createIdempotencyRecordService>
      | undefined;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-15T12:28:11.000Z"),
      taskIdFactory: () => localTaskId,
      taskRouteErrorSinkForTest: (error) => {
        routedError = error;
      },
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async () => {
          if (completedByHook) return;
          completedByHook = true;
          await createIdempotencyRecordService({ workspaceRoot }).completeRecord({
            scope: "task",
            key: idempotencyKey,
            requestDigest,
            resultRef: authoritativeTask.task_id
          });
        }
      },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return {
          ...service,
          cleanupTaskSnapshotObservation: async (observation) => {
            cleanupCalls += 1;
            await service.cleanupTaskSnapshotObservation(observation);
            throw cleanupPrimary;
          }
        };
      },
      idempotencyServiceFactory: (options) => {
        const service = createIdempotencyRecordService(options);
        routeIdempotencyService = service;
        return {
          ...service,
          quarantineRecordAfterUnsafeRollback: async (input) => {
            quarantineCalls += 1;
            capturedAuthority = input.expectedCompletedAuthority?.mutationAuthority;
            await service.quarantineRecordAfterUnsafeRollback(input);
            throw quarantineCompensation;
          }
        };
      }
    });

    const response = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const body = (await response.json()) as ApiErrorResponse;
    const record = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );

    expect(response.status).toBe(cleanupPrimary.status);
    expect(body.error.category).toBe(cleanupPrimary.category);
    expect(body.error.message).toBe(cleanupPrimary.message);
    expect(body.error.user_message).toBe(cleanupPrimary.userMessage);
    expect(body.error.evidence_refs).toEqual(cleanupPrimary.evidenceRefs);
    expect(body.error.retryable).toBe(cleanupPrimary.retryable);
    expect(body.error.recommended_next_actions).toEqual(
      cleanupPrimary.recommendedNextActions
    );
    expect(cleanupCalls).toBe(1);
    expect(quarantineCalls).toBe(1);
    expect(capturedAuthority).toBeDefined();
    expect(semanticPrimaryError(routedError)).toBe(cleanupPrimary);
    expect(countErrorGraphIdentity(routedError, quarantineCompensation)).toBe(1);
    // Complete ordered compensation identity vector with multiplicity.
    expectOrderedPreservedCompensationVector(routedError, [quarantineCompensation]);
    expect(record?.status).toBe("failed");
    expect(record?.result_ref).toBeUndefined();
    await expectPathMissing(join(workspaceRoot, "tasks", localTaskId, "snapshot.json"));
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([
      authoritativeTask.task_id
    ]);
    await expect(
      routeIdempotencyService!.cancelCompletedRecordMutationAuthority(
        capturedAuthority!
      )
    ).rejects.toThrow(TypeError);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });

  test("S30-P62-08/S31-P62-04/S32-P62-04 observation body dominates final cancellation", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const taskId = "TASK-s30-observation-cancellation";
    const primary = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "S30 observation authority rejected the request.",
      userMessage: "The observed task authority does not match this request.",
      evidenceRefs: ["s30.observation.primary"],
      retryable: true,
      recommendedNextActions: ["Inspect the observed task authority."]
    });
    let primaryCauseReads = 0;
    Object.defineProperty(primary, "cause", {
      configurable: false,
      enumerable: false,
      get: () => {
        primaryCauseReads += 1;
        throw new Error("S30 throwing primary cause getter.");
      }
    });
    Object.freeze(primary);
    const cancellationFailure = new Error("S30 observation cancellation failure.");
    let cancellationCauseReads = 0;
    Object.defineProperty(cancellationFailure, "cause", {
      configurable: false,
      enumerable: false,
      get: () => {
        cancellationCauseReads += 1;
        return cancellationFailure;
      }
    });
    Object.freeze(cancellationFailure);
    let cancellationAttempts = 0;
    let rejectObservation = true;
    let routedError: unknown;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => taskId,
      taskRouteErrorSinkForTest: (error) => {
        routedError = error;
      },
      taskSnapshotReadHooks: {
        beforeSnapshotOpen: () => {
          if (!rejectObservation) return;
          rejectObservation = false;
          throw primary;
        }
      },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return {
          ...service,
          cancelTaskSnapshotCleanupObservation: async (observation) => {
            cancellationAttempts += 1;
            await service.cancelTaskSnapshotCleanupObservation(observation);
            throw cancellationFailure;
          }
        };
      }
    });

    const response = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": "task:create:s30-observation-cancellation"
    });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(primary.status);
    expect(body.error.category).toBe(primary.category);
    expect(body.error.message).toBe(primary.message);
    expect(body.error.user_message).toBe(primary.userMessage);
    expect(body.error.evidence_refs).toEqual(primary.evidenceRefs);
    expect(body.error.retryable).toBe(primary.retryable);
    expect(body.error.recommended_next_actions).toEqual(primary.recommendedNextActions);
    expect(body.error.message).not.toBe("Unexpected backend route failure.");
    expect(cancellationAttempts).toBe(1);
    expect(routedError).toBeInstanceOf(TaskServiceError);
    expect(routedError).not.toBe(primary);
    expect(semanticPrimaryError(routedError)).toBe(primary);
    expect(errorGraphContainsIdentity(routedError, cancellationFailure)).toBe(true);
    expect(countErrorGraphIdentity(routedError, cancellationFailure)).toBe(1);
    expect(primaryCauseReads).toBeLessThanOrEqual(1);
    expect(cancellationCauseReads).toBeLessThanOrEqual(1);
  });

  test("S31-P62-05 initial publication primary dominates failed-record recovery", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const primary = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "S31 initial publication primary.",
      userMessage: "The initial task publication failed.",
      evidenceRefs: ["s31.initial.primary"],
      retryable: true,
      recommendedNextActions: ["Inspect the initial publication evidence."]
    });
    const recovery = new Error("S31 failed-record recovery compensation");
    let routedError: unknown;
    const app = createBackendApi({
      workspaceRoot,
      taskRouteErrorSinkForTest: (error) => { routedError = error; },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return { ...service, createTaskForIdempotency: async () => { throw primary; } };
      },
      idempotencyServiceFactory: (options) => {
        const service = createIdempotencyRecordService(options);
        return {
          ...service,
          recoverFailedRecordAfterRollback: async () => { throw recovery; }
        };
      }
    });

    const response = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": "task:create:s31-initial-primary"
    });
    const body = (await response.json()) as ApiErrorResponse;
    expect(response.status).toBe(primary.status);
    expect(body.error.message).toBe(primary.message);
    expect(routedError).toBeInstanceOf(TaskServiceError);
    expect(semanticPrimaryError(routedError)).toBe(primary);
    expect(errorGraphContainsIdentity(routedError, recovery)).toBe(true);
    expect(countErrorGraphIdentity(routedError, recovery)).toBe(1);
  });

  test("S31-P62-06 earlier caller primary dominates invalid authority and post-rollback recovery", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const taskId = "TASK-s31-invalid-authority";
    const invalidResultRef = "TASK-s31-invalid-authority-foreign";
    const completionPrimary = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "S31 completion trigger primary.",
      userMessage: "The completion path entered authority reconciliation.",
      evidenceRefs: ["s31.completion.trigger"],
      retryable: true,
      recommendedNextActions: ["Inspect completion reconciliation."]
    });
    const recovery = new Error("S31 post-rollback recovery compensation");
    let recoveryCalls = 0;
    let routedError: unknown;
    let completionWritten = false;
    let transportedAuthority: Parameters<
      ReturnType<typeof createIdempotencyRecordService>["cancelCompletedRecordMutationAuthority"]
    >[0] | undefined;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => taskId,
      taskRouteErrorSinkForTest: (error) => { routedError = error; },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return {
          ...service,
          rollbackTaskForIdempotency: async () => undefined
        };
      },
      idempotencyServiceFactory: (options) => {
        const service = createIdempotencyRecordService(options);
        return {
          ...service,
          invalidateCompletedRecord: async (input) => {
            transportedAuthority = input.mutationAuthority;
            if (input.mutationAuthority) {
              await service.cancelCompletedRecordMutationAuthority(input.mutationAuthority);
            }
            return {
              key: input.key,
              scope: input.scope,
              request_digest: input.requestDigest,
              status: "failed" as const,
              created_at: "2026-07-15T23:56:00.000Z",
              updated_at: "2026-07-15T23:56:00.000Z"
            };
          },
          completeRecord: async (input) => {
            await mkdir(join(workspaceRoot, "tasks", invalidResultRef), {
              recursive: true
            });
            await writeFile(
              join(workspaceRoot, "tasks", invalidResultRef, "snapshot.json"),
              "{",
              { flag: "wx", mode: 0o600 }
            );
            await service.completeRecord({ ...input, resultRef: invalidResultRef });
            completionWritten = true;
            throw completionPrimary;
          },
          recoverFailedRecordAfterRollback: async () => {
            recoveryCalls += 1;
            throw recovery;
          }
        };
      }
    });
    const response = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": "task:create:s31-invalid-authority"
    });
    const body = (await response.json()) as ApiErrorResponse;
    expect(completionWritten).toBe(true);
    expect(response.status).toBe(completionPrimary.status);
    expect(body.error.message).toBe(completionPrimary.message);
    expect(recoveryCalls).toBe(1);
    expect(routedError).toBeInstanceOf(TaskServiceError);
    expect(semanticPrimaryError(routedError)).toBe(completionPrimary);
    expect(errorGraphContainsIdentity(routedError, recovery)).toBe(true);
    expect(countErrorGraphIdentity(routedError, recovery)).toBe(1);
    // Complete ordered compensation vector with multiplicity: the quarantined
    // invalid-authority refusal, its malformed-snapshot evidence, then the
    // post-rollback recovery compensation identity.
    const orderedVector = orderedPreservedCompensationVector(routedError);
    expect(orderedVector.length).toBe(3);
    expect(orderedVector[0]).toBeInstanceOf(TaskServiceError);
    expect((orderedVector[0] as TaskServiceError).code).toBe("record_malformed");
    expect((orderedVector[0] as TaskServiceError).message).toBe(
      INVALID_DURABLE_TASK_AUTHORITY_MESSAGE
    );
    expect(orderedVector[1]).toBeInstanceOf(TaskServiceError);
    expect((orderedVector[1] as TaskServiceError).code).toBe(
      "task_snapshot_malformed"
    );
    expect((orderedVector[1] as TaskServiceError).message).toBe(
      "Task snapshot is not valid JSON."
    );
    expect(orderedVector[2]).toBe(recovery);
    expect(transportedAuthority).toBeDefined();
  });

  test("S31-P62-10 throwing route observer cannot replace canonical typed JSON", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const primary = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "S31 observer-isolated primary.",
      userMessage: "The route primary must remain authoritative.",
      evidenceRefs: ["s31.route.observer"],
      retryable: true,
      recommendedNextActions: ["Inspect the routed primary."]
    });
    const app = createBackendApi({
      workspaceRoot,
      taskRouteErrorSinkForTest: () => { throw new Error("S31 observer throw"); },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return { ...service, createTaskForIdempotency: async () => { throw primary; } };
      }
    });
    const response = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": "task:create:s31-observer-isolation"
    });
    expect(response.status).toBe(primary.status);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as ApiErrorResponse;
    expect(body.error.message).toBe(primary.message);
    expect(body.error.category).toBe(primary.category);
  });

  test("S32-P62-10 rejected-thenable route observer cannot replace typed JSON", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const primary = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "S32 rejected observer primary.",
      userMessage: "The route primary remains authoritative.",
      evidenceRefs: ["s32.route.observer.reject"],
      retryable: true,
      recommendedNextActions: ["Inspect the routed primary."]
    });
    const app = createBackendApi({
      workspaceRoot,
      taskRouteErrorSinkForTest: () =>
        Promise.reject(new Error("S32 observer rejected thenable")) as never,
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return { ...service, createTaskForIdempotency: async () => { throw primary; } };
      }
    });
    const response = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": "task:create:s32-observer-rejection"
    });
    expect(response.status).toBe(primary.status);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as ApiErrorResponse;
    expect(body.error.message).toBe(primary.message);
    expect(body.error.category).toBe(primary.category);
    await Promise.resolve();
  });

  test("S32-P62-05 repairable authority primary dominates authority cancellation", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:s32-repairable-cancellation";
    const taskBody = validTaskCreateBody();
    const initialApp = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-s32-repairable-cancellation"
    });
    const initial = await postTask(initialApp, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const task = (await initial.json()) as TaskCard;
    const snapshotPath = join(workspaceRoot, "tasks", task.task_id, "snapshot.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete snapshot.task_card;
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
    const cancellationFailure = new Error("S32 repairable authority cancellation");
    let repairablePrimary: TaskServiceError | undefined;
    let routedError: unknown;
    const app = createBackendApi({
      workspaceRoot,
      taskRouteErrorSinkForTest: (error) => { routedError = error; },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return {
          ...service,
          rejectTaskSnapshotCleanupObservation: async (observation) => {
            if (observation.status === "repairable") repairablePrimary = observation.error;
            await service.rejectTaskSnapshotCleanupObservation(observation);
          }
        };
      },
      idempotencyServiceFactory: (options) => {
        const service = createIdempotencyRecordService(options);
        return {
          ...service,
          cancelCompletedRecordMutationAuthority: async (authority) => {
            await service.cancelCompletedRecordMutationAuthority(authority);
            throw cancellationFailure;
          }
        };
      }
    });
    const response = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const body = (await response.json()) as ApiErrorResponse;
    expect(repairablePrimary).toBeDefined();
    expect(response.status).toBe(repairablePrimary!.status);
    expect(body.error.message).toBe(repairablePrimary!.message);
    expect(semanticPrimaryError(routedError)).toBe(repairablePrimary);
    expect(countErrorGraphIdentity(routedError, cancellationFailure)).toBe(1);
    // Complete ordered compensation identity vector with multiplicity: the
    // repairable primary's observed cause precedes the authority-cancellation
    // compensation.
    expectOrderedPreservedCompensationVector(routedError, [
      ...(repairablePrimary!.cause === undefined ? [] : [repairablePrimary!.cause]),
      cancellationFailure
    ]);
  });

  test("S33-P62-01 owner invalid-completed preserves same-semantic physical B behind exact authority", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:s33-owner-invalid-completed";
    const taskBody = validTaskCreateBody();
    const requestDigest = taskCreateRequestDigest(taskBody);
    const recordPath = await writeInvalidCompletedIdempotencyRecord(
      workspaceRoot,
      idempotencyKey,
      requestDigest
    );
    const recordBytes = await readFile(recordPath);
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-s33-owner-invalid-completed"
    });
    const swap = createSameSemanticRecordSwap(recordPath, recordBytes);

    const first = await runWithWorkspaceRecordPublicationHooks(swap.hooks, () =>
      postTask(app, taskBody, { "Idempotency-Key": idempotencyKey })
    );
    const firstBody = (await first.json()) as ApiErrorResponse;

    expect(swap.swapped()).toBe(true);
    expect(first.status).toBe(500);
    expect(firstBody.error.message).toBe(
      "Completed idempotency record is missing result_ref."
    );
    const survivingIdentity = await stat(recordPath, { bigint: true });
    expect(survivingIdentity.dev).toBe(swap.physicalB()!.dev);
    expect(survivingIdentity.ino).toBe(swap.physicalB()!.ino);
    expect(survivingIdentity.mtimeNs).toBe(swap.physicalB()!.mtimeNs);
    expect(await readFile(recordPath)).toEqual(recordBytes);

    const second = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    expect(second.status).toBe(500);
    expect(((await second.json()) as ApiErrorResponse).error.message).toBe(
      "Completed idempotency record is missing result_ref."
    );
    expect(
      JSON.parse(await readFile(recordPath, "utf8")) as { status: string }
    ).toMatchObject({ status: "failed" });
    const third = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    expect(third.status).toBe(201);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });

  test("S33-P62-01 polling invalid-completed preserves same-semantic physical B behind exact authority", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:s33-polling-invalid-completed";
    const taskBody = validTaskCreateBody();
    const requestDigest = taskCreateRequestDigest(taskBody);
    const recordDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    await mkdir(recordDirectory, { recursive: true });
    const recordPath = join(recordDirectory, idempotencyRecordFileName(idempotencyKey));
    const invalidRecordText = invalidCompletedIdempotencyRecordText(
      idempotencyKey,
      requestDigest
    );
    await writeFile(
      recordPath,
      `${JSON.stringify({
        key: idempotencyKey,
        scope: "task",
        request_digest: requestDigest,
        status: "started",
        created_at: "2026-07-16T09:00:00.000Z",
        updated_at: "2026-07-16T09:00:00.000Z"
      })}\n`,
      { flag: "wx" }
    );
    const recordBytes = Buffer.from(invalidRecordText, "utf8");
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let invalidCompletedInjected = false;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-s33-polling-invalid-completed",
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          lookupReplay: async (input) => {
            if (input.key === idempotencyKey && !invalidCompletedInjected) {
              invalidCompletedInjected = true;
              await writeFile(recordPath, invalidRecordText, { flag: "w" });
            }
            return await service.lookupReplay(input);
          }
        };
      }
    });
    const swap = createSameSemanticRecordSwap(recordPath, recordBytes);

    const first = await runWithWorkspaceRecordPublicationHooks(swap.hooks, () =>
      postTask(app, taskBody, { "Idempotency-Key": idempotencyKey })
    );
    const firstBody = (await first.json()) as ApiErrorResponse;

    expect(invalidCompletedInjected).toBe(true);
    expect(swap.swapped()).toBe(true);
    expect(first.status).toBe(500);
    expect(firstBody.error.message).toBe(
      "Completed idempotency record is missing result_ref."
    );
    const survivingIdentity = await stat(recordPath, { bigint: true });
    expect(survivingIdentity.dev).toBe(swap.physicalB()!.dev);
    expect(survivingIdentity.ino).toBe(swap.physicalB()!.ino);
    expect(survivingIdentity.mtimeNs).toBe(swap.physicalB()!.mtimeNs);
    expect(await readFile(recordPath)).toEqual(recordBytes);

    const second = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    expect(second.status).toBe(500);
    expect(
      JSON.parse(await readFile(recordPath, "utf8")) as { status: string }
    ).toMatchObject({ status: "failed" });
    const third = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    expect(third.status).toBe(201);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });

  test(
    "S33-P62-01 no-owner invalid-completed preserves same-semantic physical B behind exact authority",
    async () => {
      const saturation = await createTempWorkspacePath();
      const target = await createTempWorkspacePath();
      tempRoots.push(saturation.tempRoot, target.tempRoot);
      const taskBody = validTaskCreateBody();
      const ownerPrefix = "task:create:s33-no-owner-saturation:";
      const idempotencyKey = "task:create:s33-no-owner-invalid-completed";
      const requestDigest = taskCreateRequestDigest(taskBody);
      const recordPath = await writeInvalidCompletedIdempotencyRecord(
        target.workspaceRoot,
        idempotencyKey,
        requestDigest
      );
      const recordBytes = await readFile(recordPath);
      // S34-P62-11 (V33-07): the no-owner schedule pins both diagnostics
      // baselines, mirroring the owner/polling siblings, so a leak on this
      // arm is observable.
      const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
      const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();

      let enteredOwners = 0;
      let resolveAllOwnersEntered!: () => void;
      const allOwnersEntered = new Promise<void>((resolve) => {
        resolveAllOwnersEntered = resolve;
      });
      const ownerGate = createAsyncGate();
      const saturationApp = createBackendApi({
        workspaceRoot: saturation.workspaceRoot,
        requestLogSink: () => undefined,
        idempotencyServiceFactory: (serviceOptions) => {
          const service = createIdempotencyRecordService(serviceOptions);
          return {
            ...service,
            beginRecord: async (input) => {
              if (!input.key.startsWith(ownerPrefix)) {
                return await service.beginRecord(input);
              }
              enteredOwners += 1;
              if (enteredOwners === IN_FLIGHT_TASK_CREATE_LIMIT) {
                resolveAllOwnersEntered();
              }
              await ownerGate.wait;
              throw new TaskServiceError({
                code: "record_malformed",
                status: 500,
                category: "workspace_error",
                message: "Injected owner release after no-owner fixture.",
                userMessage: "The test owner was released.",
                evidenceRefs: ["workspace/tasks/_idempotency/task"],
                retryable: false,
                recommendedNextActions: ["Retry the request."]
              });
            }
          };
        }
      });
      const ownerRequests = Array.from(
        { length: IN_FLIGHT_TASK_CREATE_LIMIT },
        (_, index) =>
          postTask(saturationApp, taskBody, {
            "Idempotency-Key": `${ownerPrefix}${index}`
          })
      );
      const targetApp = createBackendApi({
        workspaceRoot: target.workspaceRoot,
        requestLogSink: () => undefined,
        taskIdFactory: () => "TASK-s33-no-owner-invalid-completed"
      });
      const swap = createSameSemanticRecordSwap(recordPath, recordBytes);

      try {
        await Promise.race([
          allOwnersEntered,
          timeoutAfter(30_000, "owner map did not reach no-owner fixture capacity")
        ]);

        const first = await runWithWorkspaceRecordPublicationHooks(swap.hooks, () =>
          postTask(targetApp, taskBody, { "Idempotency-Key": idempotencyKey })
        );
        const firstBody = (await first.json()) as ApiErrorResponse;

        expect(swap.swapped()).toBe(true);
        expect(first.status).toBe(500);
        expect(firstBody.error.message).toBe(
          "Completed idempotency record is missing result_ref."
        );
        const survivingIdentity = await stat(recordPath, { bigint: true });
        expect(survivingIdentity.dev).toBe(swap.physicalB()!.dev);
        expect(survivingIdentity.ino).toBe(swap.physicalB()!.ino);
        expect(survivingIdentity.mtimeNs).toBe(swap.physicalB()!.mtimeNs);
        expect(await readFile(recordPath)).toEqual(recordBytes);

        const second = await postTask(targetApp, taskBody, {
          "Idempotency-Key": idempotencyKey
        });
        expect(second.status).toBe(500);
        expect(
          JSON.parse(await readFile(recordPath, "utf8")) as { status: string }
        ).toMatchObject({ status: "failed" });

        // Drain the saturation owners so the durably failed key can be
        // re-acquired by a fresh owner and replayed to creation.
        ownerGate.open();
        const ownerResponses = await Promise.all(ownerRequests);
        expect(ownerResponses).toHaveLength(IN_FLIGHT_TASK_CREATE_LIMIT);
        expect(ownerResponses.every((response) => response.status === 500)).toBe(true);
        const third = await postTask(targetApp, taskBody, {
          "Idempotency-Key": idempotencyKey
        });
        expect(third.status).toBe(201);
      } finally {
        ownerGate.open();
        await Promise.all(ownerRequests);
      }
      expect(enteredOwners).toBe(IN_FLIGHT_TASK_CREATE_LIMIT);
      // S34-P62-11 (V33-07): every counted authority and directory-binding
      // resource is settled once the no-owner schedule fully drains.
      expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
      expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
    },
    60_000
  );

  test("S34-P62-01 unrecoverable guard-release and exact-settlement failure settles every transported rejected-decision resource on the malformed arm", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:s34-guard-release-malformed";
    const taskId = "TASK-s34-guard-release-malformed";
    const taskBody = validTaskCreateBody();
    const requestDigest = taskCreateRequestDigest(taskBody);
    const recordDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    await mkdir(recordDirectory, { recursive: true });
    const recordPath = join(recordDirectory, idempotencyRecordFileName(idempotencyKey));
    await writeFile(
      recordPath,
      `${JSON.stringify({
        key: idempotencyKey,
        scope: "task",
        request_digest: requestDigest,
        status: "completed",
        result_ref: taskId,
        created_at: "2026-07-16T09:00:00.000Z",
        updated_at: "2026-07-16T09:00:00.000Z"
      })}\n`,
      { flag: "wx" }
    );
    const recordBytes = await readFile(recordPath);
    const taskLane = join(workspaceRoot, "tasks", taskId);
    await mkdir(taskLane, { recursive: true });
    const snapshotPath = join(taskLane, "snapshot.json");
    await writeFile(snapshotPath, "{", { flag: "wx" });
    const guardPath = join(recordDirectory, `${sha256Hex(`transition:${idempotencyKey}`)}.guard.json`);
    const releaseFailure = new Error("S34 injected guard release failure.");
    const settlementFailure = new Error("S34 injected guard exact-settlement failure.");
    let releaseInjectionArmed = true;
    let decisionFulfilled = false;
    let releaseInjections = 0;
    let settlementInjections = 0;
    let routedError: unknown;
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let cacheDiagnostics: { slots: number; activeClaims: number } | undefined;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-s34-guard-release-malformed-recovered",
      taskRouteErrorSinkForTest: (error) => {
        routedError = error;
      },
      taskServiceFactory: (options) =>
        createTaskCardService({
          ...options,
          cacheDiagnosticsForTest: (diagnostics) => {
            cacheDiagnostics = diagnostics;
          }
        }),
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          consumeCompletedRecord: async (input, consume) => {
            decisionFulfilled = false;
            return await runWithWorkspaceRecordCompensationTestHooks(
              {
                beforeExactFailureSettlement: ({ path }) => {
                  if (path !== guardPath) return;
                  settlementInjections += 1;
                  throw settlementFailure;
                }
              },
              () =>
                runWithWorkspaceRecordPublicationHooks(
                  {
                    // The guard-path unlink after the fulfilled rejected decision
                    // is the transition-guard release. Its post-mutation failure
                    // remains unrecoverable only when exact settlement also fails.
                    beforeAuthorityOwnedUnlink: ({ path, operation }) => {
                      if (!releaseInjectionArmed || !decisionFulfilled) return;
                      if (operation !== "conditional_delete" || path !== guardPath) return;
                      releaseInjections += 1;
                      if (releaseInjections === 1) throw releaseFailure;
                    }
                  },
                  () =>
                    service.consumeCompletedRecord(input, async (record) => {
                      const decision = await consume(record);
                      decisionFulfilled = true;
                      return decision;
                    })
                )
            );
          }
        };
      }
    });

    const first = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    expect(first.status).toBe(500);
    expect(releaseInjections).toBe(1);
    expect(settlementInjections).toBe(1);
    const releasePrimary = semanticPrimaryError(semanticPrimaryError(routedError)?.cause);
    expect(errorGraphContainsIdentity(releasePrimary, releaseFailure)).toBe(true);
    expect(errorGraphContainsIdentity(releasePrimary, settlementFailure)).toBe(false);
    expect(countErrorGraphIdentity(routedError, releaseFailure)).toBe(1);
    expect(countErrorGraphIdentity(routedError, settlementFailure)).toBe(1);
    // Every transported resource is settled on the guard-release throw window:
    // record + snapshot permits, mutexes, pinned fds, and the cache claim.
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
    expect(cacheDiagnostics).toEqual({ slots: 0, activeClaims: 0 });
    // The failed replay is re-drivable: nothing durable was destroyed.
    expect(await readFile(recordPath)).toEqual(recordBytes);
    expect(await readFile(snapshotPath, "utf8")).toBe("{");

    // The failed release preserves the guard generation (fail-closed, bounded
    // by IDEMPOTENCY_TRANSITION_GUARD_STALE_MS). Simulate the elapsed
    // staleness window so the replay drives immediately.
    await unlink(guardPath);
    releaseInjectionArmed = false;
    const second = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    expect(second.status).toBe(500);
    expect(((await second.json()) as ApiErrorResponse).error.message).toBe(
      INVALID_DURABLE_TASK_AUTHORITY_MESSAGE
    );
    // No per-path permit wedge: the replay re-observed, re-classified, and
    // conditional-deleted the malformed snapshot.
    expect(
      JSON.parse(await readFile(recordPath, "utf8")) as { status: string }
    ).toMatchObject({ status: "failed" });
    await expectPathMissing(snapshotPath);

    const third = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    expect(third.status).toBe(201);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });

  test("S34-P62-01 unrecoverable guard-release and exact-settlement failure settles the missing-arm cache claim without per-retry growth", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:s34-guard-release-missing";
    const taskId = "TASK-s34-guard-release-missing";
    const taskBody = validTaskCreateBody();
    const requestDigest = taskCreateRequestDigest(taskBody);
    const recordDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    await mkdir(recordDirectory, { recursive: true });
    const recordPath = join(recordDirectory, idempotencyRecordFileName(idempotencyKey));
    await writeFile(
      recordPath,
      `${JSON.stringify({
        key: idempotencyKey,
        scope: "task",
        request_digest: requestDigest,
        status: "completed",
        result_ref: taskId,
        created_at: "2026-07-16T09:00:00.000Z",
        updated_at: "2026-07-16T09:00:00.000Z"
      })}\n`,
      { flag: "wx" }
    );
    const guardPath = join(recordDirectory, `${sha256Hex(`transition:${idempotencyKey}`)}.guard.json`);
    const releaseFailure = new Error("S34 injected missing-arm guard release failure.");
    const settlementFailure = new Error(
      "S34 injected missing-arm guard exact-settlement failure."
    );
    let releaseInjectionArmed = true;
    let decisionFulfilled = false;
    let releaseInjections = 0;
    let settlementInjections = 0;
    let routedError: unknown;
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let cacheDiagnostics: { slots: number; activeClaims: number } | undefined;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-s34-guard-release-missing-recovered",
      taskRouteErrorSinkForTest: (error) => {
        routedError = error;
      },
      taskServiceFactory: (options) =>
        createTaskCardService({
          ...options,
          cacheDiagnosticsForTest: (diagnostics) => {
            cacheDiagnostics = diagnostics;
          }
        }),
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          consumeCompletedRecord: async (input, consume) => {
            decisionFulfilled = false;
            const armedAtEntry = releaseInjectionArmed;
            let thrownThisCall = false;
            return await runWithWorkspaceRecordCompensationTestHooks(
              {
                beforeExactFailureSettlement: ({ path }) => {
                  if (path !== guardPath) return;
                  settlementInjections += 1;
                  throw settlementFailure;
                }
              },
              () =>
                runWithWorkspaceRecordPublicationHooks(
                  {
                    beforeAuthorityOwnedUnlink: ({ path, operation }) => {
                      if (!armedAtEntry || !decisionFulfilled || thrownThisCall) return;
                      if (operation !== "conditional_delete" || path !== guardPath) return;
                      thrownThisCall = true;
                      releaseInjections += 1;
                      throw releaseFailure;
                    }
                  },
                  () =>
                    service.consumeCompletedRecord(input, async (record) => {
                      const decision = await consume(record);
                      decisionFulfilled = true;
                      return decision;
                    })
                )
            );
          }
        };
      }
    });

    // Three failing replays in a row: the missing-arm cache claim is settled
    // on every attempt (no unbounded per-retry cache-claim growth). Each
    // failed release preserves the guard generation (fail-closed, bounded by
    // IDEMPOTENCY_TRANSITION_GUARD_STALE_MS); simulate the elapsed staleness
    // window between attempts so every replay drives immediately.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
      expect(failed.status).toBe(500);
      expect(cacheDiagnostics).toEqual({ slots: 0, activeClaims: 0 });
      expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
      expect(releaseInjections).toBe(attempt + 1);
      expect(settlementInjections).toBe(attempt + 1);
      const releasePrimary = semanticPrimaryError(semanticPrimaryError(routedError)?.cause);
      expect(errorGraphContainsIdentity(releasePrimary, releaseFailure)).toBe(true);
      expect(errorGraphContainsIdentity(releasePrimary, settlementFailure)).toBe(false);
      expect(countErrorGraphIdentity(routedError, releaseFailure)).toBe(1);
      expect(countErrorGraphIdentity(routedError, settlementFailure)).toBe(1);
      await unlink(guardPath);
    }
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);

    releaseInjectionArmed = false;
    const second = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    expect(second.status).toBe(500);
    expect(((await second.json()) as ApiErrorResponse).error.message).toBe(
      INVALID_DURABLE_TASK_AUTHORITY_MESSAGE
    );
    expect(
      JSON.parse(await readFile(recordPath, "utf8")) as { status: string }
    ).toMatchObject({ status: "failed" });

    const third = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    expect(third.status).toBe(201);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });

  test("S34-P62-02 refresh failure settles every transported rejected-decision resource", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:s34-refresh-window";
    const taskId = "TASK-s34-refresh-window";
    const taskBody = validTaskCreateBody();
    const requestDigest = taskCreateRequestDigest(taskBody);
    const recordDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    await mkdir(recordDirectory, { recursive: true });
    const recordPath = join(recordDirectory, idempotencyRecordFileName(idempotencyKey));
    await writeFile(
      recordPath,
      `${JSON.stringify({
        key: idempotencyKey,
        scope: "task",
        request_digest: requestDigest,
        status: "completed",
        result_ref: taskId,
        created_at: "2026-07-16T09:00:00.000Z",
        updated_at: "2026-07-16T09:00:00.000Z"
      })}\n`,
      { flag: "wx" }
    );
    const recordBytes = await readFile(recordPath);
    const taskLane = join(workspaceRoot, "tasks", taskId);
    await mkdir(taskLane, { recursive: true });
    const snapshotPath = join(taskLane, "snapshot.json");
    await writeFile(snapshotPath, "{", { flag: "wx" });
    let swapArmed = true;
    let swapped = false;
    let physicalB: BigIntStats | undefined;
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let cacheDiagnostics: { slots: number; activeClaims: number } | undefined;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-s34-refresh-window-recovered",
      taskServiceFactory: (options) =>
        createTaskCardService({
          ...options,
          cacheDiagnosticsForTest: (diagnostics) => {
            cacheDiagnostics = diagnostics;
          }
        }),
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          consumeCompletedRecord: async (input, consume) =>
            await service.consumeCompletedRecord(input, async (record) => {
              // Same-semantic physical B swap after the rejected decision is
              // classified but before the guard release — exactly like a real
              // sibling rewrite under the same transition guard — so the
              // post-release cleanup-permit refresh window itself throws on
              // the exact pinned generation.
              const decision = await consume(record);
              if (swapArmed && !swapped) {
                swapped = true;
                const replacementPath = `${recordPath}.same-semantic-b`;
                await writeFile(replacementPath, recordBytes, {
                  flag: "wx",
                  mode: 0o600
                });
                await rename(replacementPath, recordPath);
                physicalB = await stat(recordPath, { bigint: true });
              }
              return decision;
            })
        };
      }
    });

    const first = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const firstBody = (await first.json()) as ApiErrorResponse;
    expect(swapped).toBe(true);
    expect(first.status).toBe(500);
    expect(firstBody.error.message).toBe(
      "Workspace record publication authority could not be verified."
    );
    // Every transported resource is settled on the refresh throw window.
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
    expect(cacheDiagnostics).toEqual({ slots: 0, activeClaims: 0 });
    // Physical generation B survives byte-identically.
    const survivingIdentity = await stat(recordPath, { bigint: true });
    expect(survivingIdentity.dev).toBe(physicalB!.dev);
    expect(survivingIdentity.ino).toBe(physicalB!.ino);
    expect(await readFile(recordPath)).toEqual(recordBytes);
    expect(await readFile(snapshotPath, "utf8")).toBe("{");

    // The out-of-band sibling swap left the guard's parent binding stale, so
    // the release preserved the guard generation (fail-closed, bounded by
    // IDEMPOTENCY_TRANSITION_GUARD_STALE_MS). Simulate the elapsed staleness
    // window so the replay drives immediately.
    await unlink(
      join(recordDirectory, `${sha256Hex(`transition:${idempotencyKey}`)}.guard.json`)
    );
    swapArmed = false;
    const second = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    expect(second.status).toBe(500);
    expect(((await second.json()) as ApiErrorResponse).error.message).toBe(
      INVALID_DURABLE_TASK_AUTHORITY_MESSAGE
    );
    expect(
      JSON.parse(await readFile(recordPath, "utf8")) as { status: string }
    ).toMatchObject({ status: "failed" });
    await expectPathMissing(snapshotPath);

    const third = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    expect(third.status).toBe(201);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });

  test("S34-P62-04 compound settlement and release failure preserves the unknown-wrapped typed primary", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:s34-compound-release";
    const taskBody = validTaskCreateBody();
    const typedPrimary = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "S34 compound settlement typed primary.",
      userMessage: "The completed task snapshot could not be settled.",
      evidenceRefs: ["s34.compound.primary"],
      retryable: true,
      recommendedNextActions: ["Retry the task creation."]
    });
    const releaseFailure = Object.assign(
      new Error("S34 injected publication-authority release failure."),
      { code: "EBADF" }
    );
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let recordCompleted = false;
    let acceptInjectionArmed = true;
    let releaseInjectionArmed = true;
    let routedError: unknown;
    let taskSequence = 0;
    const app = createBackendApi({
      workspaceRoot,
      // Each request creates its own durable task lane so the counterfactual
      // request replays the same injection schedule instead of colliding with
      // the first request's committed lane.
      taskIdFactory: () => {
        taskSequence += 1;
        return `TASK-s34-compound-release-${taskSequence}`;
      },
      taskRouteErrorSinkForTest: (error) => {
        routedError = error;
      },
      idempotencyServiceFactory: (options) => {
        const service = createIdempotencyRecordService(options);
        return {
          ...service,
          completeRecord: async (input) => {
            const record = await service.completeRecord(input);
            recordCompleted = true;
            return record;
          }
        };
      },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return {
          ...service,
          acceptTaskSnapshotCleanupObservation: async (observation) => {
            const task = await service.acceptTaskSnapshotCleanupObservation(observation);
            if (recordCompleted && acceptInjectionArmed) {
              acceptInjectionArmed = false;
              throw typedPrimary;
            }
            return task;
          },
          releaseTaskPublicationForIdempotency: async (task) => {
            await service.releaseTaskPublicationForIdempotency(task);
            if (!releaseInjectionArmed) return;
            releaseInjectionArmed = false;
            throw releaseFailure;
          }
        };
      }
    });

    const response = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const body = (await response.json()) as ApiErrorResponse;
    // The HTTP envelope preserves the typed primary through the unknown
    // wrapper with the release failure retained exactly once — not a generic
    // 500.
    expect(response.status).toBe(typedPrimary.status);
    expect(body.error.category).toBe(typedPrimary.category);
    expect(body.error.message).toBe(typedPrimary.message);
    expect(body.error.evidence_refs).toEqual(typedPrimary.evidenceRefs);
    expect(body.error.message).not.toBe("Unexpected backend route failure.");
    const unknownAuthorityError = (
      routedError as { authorityError?: unknown } | undefined
    )?.authorityError;
    expect(semanticPrimaryError(unknownAuthorityError)).toBe(typedPrimary);
    expectOrderedPreservedCompensationVector(unknownAuthorityError, [releaseFailure]);
    expect(countErrorGraphIdentity(routedError, releaseFailure)).toBe(1);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);

    // Counterfactual: the release-success path renders the same typed
    // envelope without any release compensation.
    recordCompleted = false;
    acceptInjectionArmed = true;
    releaseInjectionArmed = false;
    routedError = undefined;
    const counterfactual = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": "task:create:s34-compound-release-counterfactual"
    });
    const counterfactualBody = (await counterfactual.json()) as ApiErrorResponse;
    expect(counterfactual.status).toBe(typedPrimary.status);
    expect(counterfactualBody.error.message).toBe(typedPrimary.message);
    expect(
      semanticPrimaryError(
        (routedError as { authorityError?: unknown } | undefined)?.authorityError
      )
    ).toBe(typedPrimary);
    expect(countErrorGraphIdentity(routedError, releaseFailure)).toBe(0);
  });

  test("S34-P62-05 digest-mismatch accept-settlement failure preserves the typed binding primary", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:s34-digest-mismatch-settlement";
    const taskBody = validTaskCreateBody();
    const initialApp = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-s34-digest-mismatch"
    });
    const initial = await postTask(initialApp, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    expect(initial.status).toBe(201);
    const task = (await initial.json()) as TaskCard;
    // Divergent durable snapshot: the completed record still matches the
    // request digest, but the task-derived digest no longer binds.
    const snapshotPath = join(workspaceRoot, "tasks", task.task_id, "snapshot.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      task_card: { title: string };
    };
    snapshot.task_card.title = "S34 divergent durable title";
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);

    const settlementFailure = new Error("S34 digest-mismatch acceptance failure");
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let acceptInjectionArmed = true;
    let routedError: unknown;
    const app = createBackendApi({
      workspaceRoot,
      taskRouteErrorSinkForTest: (error) => {
        routedError = error;
      },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return {
          ...service,
          acceptTaskSnapshotCleanupObservation: async (observation) => {
            const accepted = await service.acceptTaskSnapshotCleanupObservation(observation);
            if (!acceptInjectionArmed) return accepted;
            acceptInjectionArmed = false;
            throw settlementFailure;
          }
        };
      }
    });

    const response = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const body = (await response.json()) as ApiErrorResponse;
    // The typed record_malformed binding classification is the semantic
    // primary; the settlement failure is retained exactly once as an ordered
    // compensation.
    expect(response.status).toBe(500);
    expect(body.error.message).toBe(
      "Completed idempotency result is not bound to the task create request."
    );
    expect(body.error.message).not.toBe("Unexpected backend route failure.");
    const unknownAuthorityError = (
      routedError as { authorityError?: unknown } | undefined
    )?.authorityError;
    const semanticPrimary = semanticPrimaryError(unknownAuthorityError);
    expect(semanticPrimary).toBeInstanceOf(TaskServiceError);
    expect((semanticPrimary as TaskServiceError).message).toBe(
      "Completed idempotency result is not bound to the task create request."
    );
    expectOrderedPreservedCompensationVector(unknownAuthorityError, [settlementFailure]);
    expect(countErrorGraphIdentity(routedError, settlementFailure)).toBe(1);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });

  test("S34-P62-05b digest-mismatch typed acceptance failure keeps the typed primary with the binding classification folded", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:s34-digest-mismatch-typed-settlement";
    const taskBody = validTaskCreateBody();
    const initialApp = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-s34-digest-mismatch-typed"
    });
    const initial = await postTask(initialApp, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    expect(initial.status).toBe(201);
    const task = (await initial.json()) as TaskCard;
    // Divergent durable snapshot: the completed record still matches the
    // request digest, but the task-derived digest no longer binds.
    const snapshotPath = join(workspaceRoot, "tasks", task.task_id, "snapshot.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      task_card: { title: string };
    };
    snapshot.task_card.title = "S34 divergent durable title (typed arm)";
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);

    const typedSettlementFailure = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "S34 typed digest-mismatch acceptance failure.",
      userMessage: "The completed task authority could not settle its observation.",
      evidenceRefs: ["s34.digest-mismatch.typed-settlement"],
      retryable: true,
      recommendedNextActions: ["Retry the task creation."]
    });
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let acceptInjectionArmed = true;
    let routedError: unknown;
    const app = createBackendApi({
      workspaceRoot,
      taskRouteErrorSinkForTest: (error) => {
        routedError = error;
      },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return {
          ...service,
          acceptTaskSnapshotCleanupObservation: async (observation) => {
            const accepted = await service.acceptTaskSnapshotCleanupObservation(observation);
            if (!acceptInjectionArmed) return accepted;
            acceptInjectionArmed = false;
            throw typedSettlementFailure;
          }
        };
      }
    });

    const response = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const body = (await response.json()) as ApiErrorResponse;
    // Root C (V33-04) typed arm: the typed acceptance failure stays the
    // actionable primary; the binding classification is retained exactly once
    // as its ordered compensation behind the unknown-authority wrapper.
    expect(response.status).toBe(typedSettlementFailure.status);
    expect(body.error.category).toBe(typedSettlementFailure.category);
    expect(body.error.message).toBe(typedSettlementFailure.message);
    expect(body.error.message).not.toBe("Unexpected backend route failure.");
    const unknownAuthorityError = (
      routedError as { authorityError?: unknown } | undefined
    )?.authorityError;
    expect(semanticPrimaryError(unknownAuthorityError)).toBe(typedSettlementFailure);
    const orderedVector = orderedPreservedCompensationVector(unknownAuthorityError);
    expect(orderedVector).toHaveLength(1);
    const classificationEntry = orderedVector[0];
    expect(classificationEntry).toBeInstanceOf(TaskServiceError);
    expect((classificationEntry as TaskServiceError).code).toBe("record_malformed");
    expect((classificationEntry as TaskServiceError).message).toBe(
      "Completed idempotency result is not bound to the task create request."
    );
    // The typed primary rides only the semantic-primary channel — zero
    // occurrences in the cause/errors graph proves it was never duplicated as
    // a compensation.
    expect(countErrorGraphIdentity(routedError, typedSettlementFailure)).toBe(0);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });

  test("S34-P62-08 self-identical release rejection folds the failure exactly once", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const taskBody = validTaskCreateBody();
    const typedFailure = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "S34 self-identical release failure.",
      userMessage: "The task creation could not settle its authority.",
      evidenceRefs: ["s34.self-identical.release"],
      retryable: true,
      recommendedNextActions: ["Retry the task creation."]
    });
    const distinctReleaseFailure = new Error("S34 distinct release failure");
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let recordCompleted = false;
    let acceptInjectionArmed = false;
    let releaseInjection: unknown;
    let routedError: unknown;
    const app = createBackendApi({
      workspaceRoot,
      taskRouteErrorSinkForTest: (error) => {
        routedError = error;
      },
      idempotencyServiceFactory: (options) => {
        const service = createIdempotencyRecordService(options);
        return {
          ...service,
          completeRecord: async (input) => {
            const record = await service.completeRecord(input);
            recordCompleted = true;
            return record;
          }
        };
      },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return {
          ...service,
          acceptTaskSnapshotCleanupObservation: async (observation) => {
            const accepted = await service.acceptTaskSnapshotCleanupObservation(observation);
            if (recordCompleted && acceptInjectionArmed) {
              acceptInjectionArmed = false;
              throw typedFailure;
            }
            return accepted;
          },
          releaseTaskPublicationForIdempotency: async (task) => {
            await service.releaseTaskPublicationForIdempotency(task);
            if (releaseInjection === undefined) return;
            const injected = releaseInjection;
            releaseInjection = undefined;
            throw injected;
          }
        };
      }
    });

    // Self-identical: the release rejects with the same object that failed
    // the body — the envelope carries it exactly once, as the primary.
    recordCompleted = false;
    acceptInjectionArmed = true;
    releaseInjection = typedFailure;
    const selfIdentical = await postTask(app, taskBody, {
      "Idempotency-Key": "task:create:s34-self-identical-release"
    });
    const selfIdenticalBody = (await selfIdentical.json()) as ApiErrorResponse;
    expect(selfIdentical.status).toBe(typedFailure.status);
    expect(selfIdenticalBody.error.message).toBe(typedFailure.message);
    expect(selfIdenticalBody.error.message).not.toBe("Unexpected backend route failure.");
    expect(countErrorGraphIdentity(routedError, typedFailure)).toBe(1);
    const selfIdenticalAuthorityError = (
      routedError as { authorityError?: unknown } | undefined
    )?.authorityError;
    expect(semanticPrimaryError(selfIdenticalAuthorityError)).toBe(typedFailure);
    expectOrderedPreservedCompensationVector(selfIdenticalAuthorityError, []);

    // Distinct-error case: both failures are folded, the release failure
    // exactly once as an ordered compensation.
    recordCompleted = false;
    acceptInjectionArmed = true;
    releaseInjection = distinctReleaseFailure;
    routedError = undefined;
    const distinct = await postTask(app, taskBody, {
      "Idempotency-Key": "task:create:s34-distinct-release"
    });
    const distinctBody = (await distinct.json()) as ApiErrorResponse;
    expect(distinct.status).toBe(typedFailure.status);
    expect(distinctBody.error.message).toBe(typedFailure.message);
    const distinctAuthorityError = (
      routedError as { authorityError?: unknown } | undefined
    )?.authorityError;
    expect(semanticPrimaryError(distinctAuthorityError)).toBe(typedFailure);
    expectOrderedPreservedCompensationVector(distinctAuthorityError, [
      distinctReleaseFailure
    ]);
    // The typed primary is transported exactly once, via the envelope's
    // semantic-primary channel (asserted above); zero occurrences in the
    // cause/errors graph proves it was never duplicated as a compensation.
    expect(countErrorGraphIdentity(routedError, typedFailure)).toBe(0);
    expect(countErrorGraphIdentity(routedError, distinctReleaseFailure)).toBe(1);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });

  test("S33-P62-04 completed-replay unknown settlement failure preserves the typed primary", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:s33-unknown-settlement";
    const taskBody = validTaskCreateBody();
    const initialApp = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-s33-unknown-settlement"
    });
    const initial = await postTask(initialApp, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    expect(initial.status).toBe(201);
    const initialTask = (await initial.json()) as TaskCard;

    const primary = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "S33 unknown completed-replay primary.",
      userMessage: "The completed task authority is temporarily unknown.",
      evidenceRefs: ["s33.unknown.primary"],
      retryable: true,
      recommendedNextActions: ["Retry the completed replay."]
    });
    const cancellationFailure = new Error(
      "S33 unknown observation cancellation failure"
    );
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let observationArmed = true;
    let cancellationArmed = true;
    let cancellations = 0;
    let routedError: unknown;
    const app = createBackendApi({
      workspaceRoot,
      taskRouteErrorSinkForTest: (error) => {
        routedError = error;
      },
      taskSnapshotReadHooks: {
        beforeSnapshotOpen: () => {
          if (!observationArmed) return;
          observationArmed = false;
          throw primary;
        }
      },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return {
          ...service,
          cancelTaskSnapshotCleanupObservation: async (observation) => {
            await service.cancelTaskSnapshotCleanupObservation(observation);
            if (!cancellationArmed) return;
            cancellationArmed = false;
            cancellations += 1;
            throw cancellationFailure;
          }
        };
      }
    });

    const response = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const body = (await response.json()) as ApiErrorResponse;
    expect(response.status).toBe(primary.status);
    expect(body.error.category).toBe(primary.category);
    expect(body.error.message).toBe(primary.message);
    expect(body.error.message).not.toBe("Unexpected backend route failure.");
    expect(cancellations).toBe(1);
    const unknownAuthorityError = (
      routedError as { authorityError?: unknown } | undefined
    )?.authorityError;
    expect(semanticPrimaryError(unknownAuthorityError)).toBe(primary);
    // S34-P62-09 (V33-16): exact primary identity plus the complete ordered
    // compensation identity vector, pinned at the unknown-branch fold.
    expectOrderedPreservedCompensationVector(unknownAuthorityError, [
      cancellationFailure
    ]);
    expect(countErrorGraphIdentity(routedError, cancellationFailure)).toBe(1);

    // The completed record and durable task survive the settlement failure;
    // the replay succeeds once the transient authority denial clears.
    const replay = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()) as TaskCard).toEqual(initialTask);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(
      bindingBaseline
    );
  });

  test("S33-P62-04 completed-replay repairable settlement failure preserves the typed primary", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:s33-repairable-settlement";
    const taskBody = validTaskCreateBody();
    const initialApp = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => "TASK-s33-repairable-settlement"
    });
    const initial = await postTask(initialApp, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    expect(initial.status).toBe(201);
    const task = (await initial.json()) as TaskCard;
    const snapshotPath = join(workspaceRoot, "tasks", task.task_id, "snapshot.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete snapshot.task_card;
    await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);

    const rejectionFailure = new Error(
      "S33 repairable observation rejection failure"
    );
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let repairablePrimary: TaskServiceError | undefined;
    let rejections = 0;
    let routedError: unknown;
    const app = createBackendApi({
      workspaceRoot,
      taskRouteErrorSinkForTest: (error) => {
        routedError = error;
      },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return {
          ...service,
          rejectTaskSnapshotCleanupObservation: async (observation) => {
            if (observation.status === "repairable") {
              repairablePrimary = observation.error;
            }
            await service.rejectTaskSnapshotCleanupObservation(observation);
            rejections += 1;
            throw rejectionFailure;
          }
        };
      }
    });

    const response = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const body = (await response.json()) as ApiErrorResponse;
    expect(repairablePrimary).toBeDefined();
    expect(response.status).toBe(repairablePrimary!.status);
    expect(body.error.message).toBe(repairablePrimary!.message);
    expect(body.error.message).not.toBe("Unexpected backend route failure.");
    expect(rejections).toBe(1);
    expect(semanticPrimaryError(routedError)).toBe(repairablePrimary);
    // S34-P62-09 (V33-16): exact primary identity plus the complete ordered
    // compensation identity vector, pinned at the repairable-branch fold.
    expectOrderedPreservedCompensationVector(routedError, [rejectionFailure]);
    expect(countErrorGraphIdentity(routedError, rejectionFailure)).toBe(1);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(
      bindingBaseline
    );
  });

  test("S33-P62-09 inner completed-consumption fold preserves the primary with the complete ordered vector", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:s33-inner-consumption-fold";
    const taskId = "TASK-s33-inner-consumption-fold";
    const taskBody = validTaskCreateBody();
    const consumptionPrimary = new TaskServiceError({
      code: "record_malformed",
      status: 409,
      category: "idempotency_conflict",
      message: "S33 inner completed-consumption primary.",
      userMessage: "The freshly completed record could not be consumed.",
      evidenceRefs: ["s33.inner.consumption"],
      retryable: true,
      recommendedNextActions: ["Retry the completed consumption."]
    });
    const cancellationFailure = new Error(
      "S33 inner local observation cancellation failure"
    );
    let recordCompleted = false;
    let consumptionArmed = true;
    let cancellationArmed = true;
    let cancellations = 0;
    let routedError: unknown;
    const app = createBackendApi({
      workspaceRoot,
      taskIdFactory: () => taskId,
      taskRouteErrorSinkForTest: (error) => {
        routedError = error;
      },
      idempotencyServiceFactory: (options) => {
        const service = createIdempotencyRecordService(options);
        return {
          ...service,
          completeRecord: async (input) => {
            const record = await service.completeRecord(input);
            recordCompleted = true;
            return record;
          },
          consumeCompletedRecord: async (input, consume) => {
            if (recordCompleted && consumptionArmed) {
              consumptionArmed = false;
              throw consumptionPrimary;
            }
            return await service.consumeCompletedRecord(input, consume);
          }
        };
      },
      taskServiceFactory: (options) => {
        const service = createTaskCardService(options);
        return {
          ...service,
          cancelTaskSnapshotCleanupObservation: async (observation) => {
            await service.cancelTaskSnapshotCleanupObservation(observation);
            if (!cancellationArmed) return;
            cancellationArmed = false;
            cancellations += 1;
            throw cancellationFailure;
          }
        };
      }
    });

    // The owner establishes a REAL completed record before the inner
    // completed-consumption fold (routes/index.ts, "Completed task
    // consumption and local observation cancellation both failed.") runs.
    const response = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const body = (await response.json()) as ApiErrorResponse;
    expect(recordCompleted).toBe(true);
    expect(cancellations).toBe(1);
    expect(response.status).toBe(consumptionPrimary.status);
    expect(body.error.category).toBe(consumptionPrimary.category);
    expect(body.error.message).toBe(consumptionPrimary.message);
    expect(routedError).toBeInstanceOf(TaskServiceError);
    expect(semanticPrimaryError(routedError)).toBe(consumptionPrimary);
    // Exact primary identity plus the complete ordered compensation identity
    // vector with multiplicity, pinned at the inner fold's altitude.
    expectOrderedPreservedCompensationVector(routedError, [cancellationFailure]);
    expect(countErrorGraphIdentity(routedError, cancellationFailure)).toBe(1);
    const envelope = (routedError as Error).cause;
    expect(envelope).toBeInstanceOf(PreservedErrorCompensationEnvelope);
    expect(((envelope as PreservedErrorCompensationEnvelope).cause as AggregateError).message).toBe(
      "Completed task consumption and local observation cancellation both failed."
    );

    // The durable outcome is intact: the real completed record replays the
    // created task once the injected consumption denial clears.
    const record = await createIdempotencyRecordService({ workspaceRoot }).getRecord(
      "task",
      idempotencyKey
    );
    expect(record).toMatchObject({ status: "completed", result_ref: taskId });
    const replay = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as TaskCard).task_id).toBe(taskId);
  });

  test("POST /api/tasks fails closed on a malformed transition guard", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:malformed-guard-route-retry";
    const taskIds = ["TASK-malformed-guard-first", "TASK-malformed-guard-retry"];
    const guardPath = join(
      workspaceRoot,
      "tasks",
      "_idempotency",
      "task",
      `${sha256Hex(`transition:${idempotencyKey}`)}.guard.json`
    );
    let poisonedGuard = false;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.635Z"),
      taskIdFactory: () => {
        const taskId = taskIds.shift() ?? "TASK-unexpected-malformed-guard-extra";
        if (!poisonedGuard) {
          poisonedGuard = true;
          writeFileSync(guardPath, "{");
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
    expect(recordAfterFailure?.status).toBe("started");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([
      "TASK-malformed-guard-first"
    ]);

    const blockedResponse = await postTask(app, validTaskCreateBody(), {
      "Idempotency-Key": idempotencyKey
    });
    const blockedBody = (await blockedResponse.json()) as ApiErrorResponse;
    const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);
    const idempotencyFiles = await readdir(join(workspaceRoot, "tasks", "_idempotency", "task"));

    expect(blockedResponse.status).toBe(500);
    expectCanonicalError(blockedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(blockedBody, tempRoot, workspaceRoot);
    expect(taskIds).toEqual(["TASK-malformed-guard-retry"]);
    expect(recordAfterRetry).toEqual(recordAfterFailure);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([
      "TASK-malformed-guard-first"
    ]);
    expect(await readFile(guardPath, "utf8")).toBe("{");
    expect(idempotencyFiles.sort()).toEqual(
      [
        idempotencyRecordFileName(idempotencyKey),
        `${sha256Hex(`transition:${idempotencyKey}`)}.guard.json`
      ].sort()
    );
  });

  test("POST /api/tasks preserves a directory successor when rollback cannot observe its generation", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const idempotencyKey = "task:create:rollback-failure-bound";
    const taskBody = validTaskCreateBody();
    const requestDigest = sha256Hex(canonicalJson(taskBody));
    let taskIdFactoryCalls = 0;
    let poisonedCompletion = false;
    let successorReplacementCount = 0;
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
      idempotencyServiceFactory: (serviceOptions) => {
        const service = createIdempotencyRecordService(serviceOptions);
        return {
          ...service,
          consumeCompletedRecord: async (input, consume) => {
            const replay = await service.consumeCompletedRecord(input, consume);
            if (input.key === idempotencyKey && successorReplacementCount === 0) {
              successorReplacementCount += 1;
              await rm(
                join(
                  workspaceRoot,
                  "tasks",
                  "TASK-rollback-failure-original",
                  "snapshot.json"
                )
              );
              await mkdir(
                join(
                  workspaceRoot,
                  "tasks",
                  "TASK-rollback-failure-original",
                  "snapshot.json"
                )
              );
            }
            return replay;
          }
        };
      }
    });

    const snapshotPath = join(
      workspaceRoot,
      "tasks",
      "TASK-rollback-failure-original",
      "snapshot.json"
    );
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
    const listBody = (await listAfterFailure.json()) as { tasks: TaskCard[] };
    const retainedTask = listBody.tasks[0]!;
    const detailBody = (await detailAfterFailure.json()) as TaskCard;
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
    expect(listBody.tasks).toHaveLength(1);
    expect(retainedTask.task_id).toBe("TASK-rollback-failure-original");
    expect(detailAfterFailure.status).toBe(200);
    expect(detailBody).toEqual(retainedTask);
    expect(freshListAfterFailure.status).toBe(500);
    expectCanonicalError(
      (await freshListAfterFailure.json()) as ApiErrorResponse,
      "workspace_error"
    );
    expect(successorReplacementCount).toBe(1);
    expect((await stat(snapshotPath)).isDirectory()).toBe(true);
    expect(retryResponse.status).toBe(201);
    expect(retryTask.task_id).toBe("TASK-rollback-failure-duplicate");
    expect(recordAfterRetry?.status).toBe("completed");
    expect(recordAfterRetry?.result_ref).toBe(retryTask.task_id);
    expect(taskIdFactoryCalls).toBe(2);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([retryTask.task_id]);
    expect((await stat(snapshotPath)).isDirectory()).toBe(true);
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
    const fanoutCount = 2_048;
    let poisonedCompletion = false;
    await mkdir(taskLane, { recursive: true });
    await writeFile(sentinelPath, "preserve lane sentinel", { flag: "wx" });
    await writeFillerTaskEntries(taskLane, fanoutCount);
    const existingLaneEntries = (await readdir(taskLane)).sort();
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
    expect(existingLaneEntries).toHaveLength(fanoutCount + 1);
    expect((await readdir(taskLane)).sort()).toEqual(existingLaneEntries);
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
    expect((await readdir(taskLane)).sort()).toEqual(existingLaneEntries);
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

async function workspaceDirectoryInventory(workspaceRoot: string): Promise<string[]> {
  const inventory: string[] = [];
  const visit = async (directoryPath: string, relativeParent: string): Promise<void> => {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const relativePath = relativeParent ? join(relativeParent, entry.name) : entry.name;
      inventory.push(relativePath);
      await visit(join(directoryPath, entry.name), relativePath);
    }
  };
  await visit(workspaceRoot, "");
  return inventory.sort();
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

function taskCreateRequestDigest(taskBody: CreateTaskInput): string {
  return sha256Hex(
    canonicalJson({
      ...taskBody,
      created_by: taskBody.created_by ?? DEFAULT_TASK_CREATED_BY
    })
  );
}

function invalidCompletedIdempotencyRecordText(
  idempotencyKey: string,
  requestDigest: string
): string {
  return `${JSON.stringify({
    key: idempotencyKey,
    scope: "task",
    request_digest: requestDigest,
    status: "completed",
    created_at: "2026-07-16T09:00:00.000Z",
    updated_at: "2026-07-16T09:00:00.000Z"
  })}\n`;
}

async function writeInvalidCompletedIdempotencyRecord(
  workspaceRoot: string,
  idempotencyKey: string,
  requestDigest: string
): Promise<string> {
  const recordDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
  await mkdir(recordDirectory, { recursive: true });
  const recordPath = join(recordDirectory, idempotencyRecordFileName(idempotencyKey));
  await writeFile(
    recordPath,
    invalidCompletedIdempotencyRecordText(idempotencyKey, requestDigest),
    { flag: "wx" }
  );
  return recordPath;
}

function createSameSemanticRecordSwap(
  recordPath: string,
  recordBytes: Buffer
): {
  hooks: WorkspaceRecordPublicationHooks;
  swapped: () => boolean;
  physicalB: () => BigIntStats | undefined;
} {
  let swapped = false;
  let physicalB: BigIntStats | undefined;
  return {
    hooks: {
      afterTemporaryFileWritten: async ({ canonicalPath }) => {
        if (canonicalPath !== recordPath || swapped) return;
        swapped = true;
        const replacementPath = `${recordPath}.same-semantic-b`;
        await writeFile(replacementPath, recordBytes, { flag: "wx", mode: 0o600 });
        await rename(replacementPath, recordPath);
        physicalB = await stat(recordPath, { bigint: true });
      }
    },
    swapped: () => swapped,
    physicalB: () => physicalB
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

function errorGraphContainsIdentity(
  root: unknown,
  target: unknown,
  seen = new Set<object>()
): boolean {
  if (root === target) return true;
  if ((typeof root !== "object" && typeof root !== "function") || root === null) {
    return false;
  }
  const object = root as object;
  if (seen.has(object)) return false;
  seen.add(object);
  for (const property of ["cause", "errors"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(object, property);
    if (!descriptor || !("value" in descriptor)) continue;
    const value = descriptor.value as unknown;
    if (Array.isArray(value)) {
      if (value.some((entry) => errorGraphContainsIdentity(entry, target, seen))) {
        return true;
      }
    } else if (errorGraphContainsIdentity(value, target, seen)) {
      return true;
    }
  }
  return false;
}

function orderedPreservedCompensationVector(error: unknown): readonly unknown[] {
  const envelope =
    error instanceof PreservedErrorCompensationEnvelope
      ? error
      : error instanceof Error &&
          error.cause instanceof PreservedErrorCompensationEnvelope
        ? error.cause
        : undefined;
  if (!envelope || !(envelope.cause instanceof AggregateError)) return [];
  return envelope.cause.errors;
}

function expectOrderedPreservedCompensationVector(
  error: unknown,
  expectedVector: readonly unknown[]
): void {
  const orderedVector = orderedPreservedCompensationVector(error);
  expect(orderedVector.length).toBe(expectedVector.length);
  for (let index = 0; index < expectedVector.length; index += 1) {
    expect(orderedVector[index]).toBe(expectedVector[index]);
  }
}

function countErrorGraphIdentity(
  root: unknown,
  target: unknown,
  seen = new Set<object>()
): number {
  let count = root === target ? 1 : 0;
  if ((typeof root !== "object" && typeof root !== "function") || root === null) {
    return count;
  }
  const object = root as object;
  if (seen.has(object)) return count;
  seen.add(object);
  for (const property of ["cause", "errors"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(object, property);
    if (!descriptor || !("value" in descriptor)) continue;
    const value = descriptor.value as unknown;
    if (Array.isArray(value)) {
      for (const entry of value) count += countErrorGraphIdentity(entry, target, seen);
    } else {
      count += countErrorGraphIdentity(value, target, seen);
    }
  }
  return count;
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

function createAsyncGate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolvePromise) => {
    open = resolvePromise;
  });
  return { wait, open };
}

function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function sourceFunctionText(sourceFile: ts.SourceFile, name: string): string {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  if (!declaration) {
    throw new Error(`Missing source function: ${name}`);
  }
  return declaration.getText(sourceFile);
}

function countSourceOccurrences(source: string, fragment: string): number {
  return source.split(fragment).length - 1;
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

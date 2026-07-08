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

const tempRoots: string[] = [];
const originalCwd = process.cwd();
const originalHarnessWorkspaceDir = process.env.HARNESS_WORKSPACE_DIR;
const originalLegacyWorkspaceRoot = process.env.SHUD_HARNESS_WORKSPACE_ROOT;
const TASK_HYDRATION_ENTRY_LIMIT = 1024;
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

  test("POST /api/tasks fails closed when completed idempotency result_ref is unsafe", async () => {
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
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return "TASK-unsafe-result-ref-duplicate";
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

    expect(response.status).toBe(500);
    expectCanonicalError(body, "workspace_error");
    expect(body.error.evidence_refs).toEqual([
      idempotencyRecordEvidenceRef("task", idempotencyKey),
      "idempotency.result_ref"
    ]);
    expect(JSON.stringify(body)).not.toContain(unsafeResultRef);
    expectNoAbsoluteWorkspacePath(body, tempRoot, workspaceRoot);
    expect(taskIdFactoryCalls).toBe(0);
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-unsafe-result-ref-duplicate"));
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
    expect(response.status).toBe(500);
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
    let poisonedAfterSnapshot = false;
    const app = createBackendApi({
      workspaceRoot,
      now: fixedNow("2026-07-07T12:03:57.640Z"),
      taskIdFactory: () => {
        taskIdFactoryCalls += 1;
        return taskIdFactoryCalls === 1
          ? "TASK-rollback-failure-original"
          : "TASK-rollback-failure-duplicate";
      },
      taskSnapshotWriteHooks: {
        afterSnapshotWrite: async ({ taskDirectory }) => {
          if (poisonedAfterSnapshot) {
            return;
          }
          poisonedAfterSnapshot = true;
          await writeFile(
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
          await rm(join(taskDirectory, "snapshot.json"));
          await mkdir(join(taskDirectory, "snapshot.json"));
        }
      }
    });

    const failedResponse = await postTask(app, taskBody, {
      "Idempotency-Key": idempotencyKey
    });
    const failedBody = (await failedResponse.json()) as ApiErrorResponse;
    const idempotencyService = createIdempotencyRecordService({ workspaceRoot });
    const recordAfterFailure = await idempotencyService.getRecord("task", idempotencyKey);
    const retryResponse = await postTask(app, taskBody, { "Idempotency-Key": idempotencyKey });
    const retryBody = (await retryResponse.json()) as ApiErrorResponse;
    const recordAfterRetry = await idempotencyService.getRecord("task", idempotencyKey);

    expect(failedResponse.status).toBe(500);
    expectCanonicalError(failedBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(failedBody, tempRoot, workspaceRoot);
    expect(recordAfterFailure?.status).toBe("started");
    expect(recordAfterFailure?.result_ref).toBeUndefined();
    expect(retryResponse.status).toBe(500);
    expectCanonicalError(retryBody, "workspace_error");
    expectNoAbsoluteWorkspacePath(retryBody, tempRoot, workspaceRoot);
    expect(recordAfterRetry?.status).toBe("started");
    expect(recordAfterRetry?.result_ref).toBeUndefined();
    expect(taskIdFactoryCalls).toBe(1);
    expect(await taskIdsWithSnapshots(workspaceRoot)).toEqual([]);
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-rollback-failure-duplicate"));
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
    const app = createBackendApi({ workspaceRoot });

    const unknownRouteResponse = await app.request("/api/not-registered");
    const missingTaskResponse = await app.request("/api/tasks/TASK-missing");
    const unknownRouteBody = (await unknownRouteResponse.json()) as ApiErrorResponse;
    const missingTaskBody = (await missingTaskResponse.json()) as ApiErrorResponse;

    expect(unknownRouteResponse.status).toBe(404);
    expect(missingTaskResponse.status).toBe(404);
    expectCanonicalError(unknownRouteBody, "not_found");
    expectCanonicalError(missingTaskBody, "not_found");
    expect(unknownRouteBody.error.message).toContain("API route not found");
    expect(missingTaskBody.error.message).toContain("Task not found");
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

async function timeoutAfter(milliseconds: number, message: string): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  throw new Error(message);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

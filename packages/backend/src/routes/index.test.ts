import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createBackendApi,
  WORKSPACE_CANONICAL_DIRECTORIES,
  type WorkspaceReadyResponse
} from "./index";

const tempRoots: string[] = [];

describe("backend workspace and health routes", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true, force: true }))
    );
  });

  test("POST /api/workspace/init creates the canonical M1 runtime directory tree", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const app = createBackendApi({ workspaceRoot });

    const response = await app.request("/api/workspace/init", { method: "POST" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      directory_count: WORKSPACE_CANONICAL_DIRECTORIES.length,
      directories: WORKSPACE_CANONICAL_DIRECTORIES
    });
    expect(body.directories).toContain("readiness");
    expect(body.directories).toContain("snapshots");

    for (const relativeDir of WORKSPACE_CANONICAL_DIRECTORIES) {
      expect((await stat(join(workspaceRoot, relativeDir))).isDirectory()).toBe(true);
    }
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
});

async function createTempWorkspacePath(): Promise<{ tempRoot: string; workspaceRoot: string }> {
  const tempRoot = await mkdtemp(join(tmpdir(), "shud-harness-backend-routes-"));
  return {
    tempRoot,
    workspaceRoot: join(tempRoot, "workspace")
  };
}

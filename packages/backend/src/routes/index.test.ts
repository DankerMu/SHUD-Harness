import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
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
import { createBackendApi, type WorkspaceReadyResponse } from "./index";

const tempRoots: string[] = [];
const originalCwd = process.cwd();
const originalHarnessWorkspaceDir = process.env.HARNESS_WORKSPACE_DIR;
const originalLegacyWorkspaceRoot = process.env.SHUD_HARNESS_WORKSPACE_ROOT;

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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

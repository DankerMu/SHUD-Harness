import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskCardService } from "@shud-harness/core";
import { LocalTokenStorageError } from "../local-auth/local-token-store";
import {
  BACKEND_PRODUCTION_LISTEN_OPTIONS,
  WORKSPACE_CANONICAL_DIRECTORIES,
  createBackendApi,
  createBackendProductionListenOptions,
  type ApiErrorResponse,
  type WorkspaceReadyResponse
} from "./index";

const tempRoots: string[] = [];
const originalToken = process.env.HARNESS_LOCAL_TOKEN;

describe("backend local API authentication", () => {
  afterEach(async () => {
    restoreToken(originalToken);
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("production listen options bind only to the IPv4 loopback hostname", async () => {
    const workspaceRoot = await temporaryWorkspacePath();
    process.env.HARNESS_LOCAL_TOKEN = "listener-test-token";

    expect(BACKEND_PRODUCTION_LISTEN_OPTIONS).toEqual({ hostname: "127.0.0.1" });
    const options = createBackendProductionListenOptions({ workspaceRoot });
    expect(options.hostname).toBe("127.0.0.1");
    expect(typeof options.fetch).toBe("function");
    expect((await options.fetch(new Request("http://127.0.0.1/api/health/live"))).status).toBe(200);
  });

  test("missing, malformed, and wrong credentials fail before the protected handler", async () => {
    const workspaceRoot = await temporaryWorkspacePath();
    const configured = "configured-auth-token";
    process.env.HARNESS_LOCAL_TOKEN = configured;
    let handlerEffects = 0;
    const app = createBackendApi({
      workspaceRoot,
      requestLogSink: () => undefined,
      taskServiceFactory: (options) => ({
        ...createTaskCardService(options),
        listTasks: async () => {
          handlerEffects += 1;
          return [];
        }
      })
    });

    const fixtures: Array<{ label: string; authorization?: string }> = [
      { label: "missing" },
      { label: "wrong scheme", authorization: `Basic ${configured}` },
      { label: "lowercase scheme", authorization: `bearer ${configured}` },
      { label: "extra whitespace", authorization: `Bearer  ${configured}` },
      { label: "comma", authorization: `Bearer ${configured},other` },
      { label: "wrong token", authorization: "Bearer presented-wrong-token" }
    ];

    for (const fixture of fixtures) {
      const response = await app.request("/api/tasks", {
        headers: fixture.authorization ? { Authorization: fixture.authorization } : undefined
      });
      const body = (await response.json()) as ApiErrorResponse;
      expect(response.status, fixture.label).toBe(401);
      expect(body.error.category, fixture.label).toBe("permission_error");
      expect(JSON.stringify(body), fixture.label).not.toContain(configured);
      expect(JSON.stringify(body), fixture.label).not.toContain("presented-wrong-token");
    }
    expect(handlerEffects).toBe(0);

    const accepted = await app.request("/api/tasks", {
      headers: { Authorization: `Bearer ${configured}` }
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ tasks: [] });
    expect(handlerEffects).toBe(1);
  });

  test("only exact GET live and ready routes are exempt while non-API requests stay outside auth", async () => {
    const workspaceRoot = await temporaryWorkspacePath();
    process.env.HARNESS_LOCAL_TOKEN = "health-exemption-token";
    const app = createBackendApi({ workspaceRoot, requestLogSink: () => undefined });

    expect((await app.request("/api/health/live")).status).toBe(200);
    expect((await app.request("/api/health/ready")).status).toBe(503);
    expect((await app.request("/api/health/live", { method: "HEAD" })).status).toBe(401);
    expect((await app.request("/api/health/ready", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/health/live/")).status).toBe(401);
    expect((await app.request("/api/health/readiness")).status).toBe(401);
    expect((await app.request("/api")).status).toBe(401);
    expect((await app.request("/not-api")).status).toBe(404);
  });

  test("the exact Bearer grammar accepts the 4096-byte boundary and rejects overlong presentation", async () => {
    const workspaceRoot = await temporaryWorkspacePath();
    const maximumToken = "x".repeat(4096);
    process.env.HARNESS_LOCAL_TOKEN = maximumToken;
    const app = createBackendApi({ workspaceRoot, requestLogSink: () => undefined });

    expect((await app.request("/api/tasks", {
      headers: authenticatedHeaders(maximumToken)
    })).status).toBe(200);
    const overlong = await app.request("/api/tasks", {
      headers: authenticatedHeaders(`${maximumToken}y`)
    });
    const body = (await overlong.json()) as ApiErrorResponse;
    expect(overlong.status).toBe(401);
    expect(body.error.category).toBe("permission_error");
    expect(JSON.stringify(body)).not.toContain(maximumToken);
  });

  test("a valid environment token wins without creating or overwriting local-token", async () => {
    const workspaceRoot = await temporaryWorkspacePath();
    process.env.HARNESS_LOCAL_TOKEN = "environment-authority-token";
    const app = createBackendApi({ workspaceRoot, requestLogSink: () => undefined });

    await expectMissing(join(workspaceRoot, "secrets", "local-token"));
    const init = await app.request("/api/workspace/init", {
      method: "POST",
      headers: authenticatedHeaders("environment-authority-token")
    });
    expect(init.status).toBe(200);
    expect((await stat(join(workspaceRoot, "secrets"))).mode & 0o7777).toBe(0o700);
    await expectMissing(join(workspaceRoot, "secrets", "local-token"));

    const existingBytes = "preexisting-local-token-bytes";
    await writeFile(join(workspaceRoot, "secrets", "local-token"), existingBytes, { mode: 0o600 });
    const second = createBackendApi({ workspaceRoot, requestLogSink: () => undefined });
    expect((await second.request("/api/workspace/init", {
      method: "POST",
      headers: authenticatedHeaders("environment-authority-token")
    })).status).toBe(200);
    expect(await readFile(join(workspaceRoot, "secrets", "local-token"), "utf8")).toBe(existingBytes);
  });

  test("invalid environment token values fail construction without file fallback or disclosure", async () => {
    const invalidTokens = [
      "",
      "contains space",
      "contains,comma",
      "contains\nnewline",
      "non-ascii-é",
      "x".repeat(4097)
    ];

    for (const invalidToken of invalidTokens) {
      const workspaceRoot = await temporaryWorkspacePath();
      process.env.HARNESS_LOCAL_TOKEN = invalidToken;
      let thrown: unknown;
      try {
        createBackendApi({ workspaceRoot });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(LocalTokenStorageError);
      expect((thrown as Error).message).toBe("Local API token storage is unsafe.");
      if (invalidToken.length > 0) {
        expect((thrown as Error).message).not.toContain(invalidToken);
      }
      await expectMissing(join(workspaceRoot, "secrets", "local-token"));
    }
  });

  test("absent environment uses Child A and a replaced authority fails closed before handler", async () => {
    const workspaceRoot = await temporaryWorkspacePath();
    delete process.env.HARNESS_LOCAL_TOKEN;
    let handlerEffects = 0;
    const lines: string[] = [];
    const app = createBackendApi({
      workspaceRoot,
      requestLogSink: (line) => lines.push(line),
      taskServiceFactory: (options) => ({
        ...createTaskCardService(options),
        listTasks: async () => {
          handlerEffects += 1;
          return [];
        }
      })
    });
    const tokenPath = join(workspaceRoot, "secrets", "local-token");
    const token = await readFile(tokenPath, "utf8");

    const accepted = await app.request("/api/tasks", {
      headers: authenticatedHeaders(token)
    });
    expect(accepted.status).toBe(200);
    expect(handlerEffects).toBe(1);

    await unlink(tokenPath);
    await writeFile(tokenPath, token, { mode: 0o600 });
    const rejected = await app.request("/api/tasks", {
      headers: authenticatedHeaders(token)
    });
    const body = (await rejected.json()) as ApiErrorResponse;
    expect(rejected.status).toBe(401);
    expect(body.error.category).toBe("permission_error");
    expect(handlerEffects).toBe(1);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain(tokenPath);
    await waitFor(() => lines.length === 2);
    const staleLog = lines[1] as string;
    expect(JSON.parse(staleLog).status).toBe(401);
    expect(staleLog).not.toContain(token);
    expect(staleLog).not.toContain(tokenPath);
    expect(staleLog).not.toContain("local-token");
  });

  test("secrets readiness is private and non-sensitive before and after initialization", async () => {
    const workspaceRoot = await temporaryWorkspacePath();
    const token = "ready-private-token";
    process.env.HARNESS_LOCAL_TOKEN = token;
    const app = createBackendApi({ workspaceRoot, requestLogSink: () => undefined });

    const before = await app.request("/api/health/ready");
    const beforeBody = (await before.json()) as WorkspaceReadyResponse;
    expect(before.status).toBe(503);
    expect(beforeBody.missing_directories).toContain("secrets");
    expect(JSON.stringify(beforeBody)).not.toContain(workspaceRoot);
    expect(JSON.stringify(beforeBody)).not.toContain(token);

    expect((await app.request("/api/workspace/init", {
      method: "POST",
      headers: authenticatedHeaders(token)
    })).status).toBe(200);
    const after = await app.request("/api/health/ready");
    const afterText = await after.text();
    expect(after.status).toBe(200);
    expect(afterText).not.toContain(workspaceRoot);
    expect(afterText).not.toContain(token);

    await chmod(join(workspaceRoot, "secrets"), 0o755);
    const unsafe = await app.request("/api/health/ready");
    const unsafeBody = (await unsafe.json()) as WorkspaceReadyResponse;
    expect(unsafe.status).toBe(503);
    expect(unsafeBody.missing_directories).toContain("secrets");
  });

  test("workspace init rejects an existing non-private secrets directory without normalizing it", async () => {
    const workspaceRoot = await temporaryWorkspacePath();
    await mkdir(join(workspaceRoot, "secrets"), { recursive: true, mode: 0o755 });
    await chmod(join(workspaceRoot, "secrets"), 0o755);
    process.env.HARNESS_LOCAL_TOKEN = "existing-secrets-mode-token";
    const app = createBackendApi({ workspaceRoot, requestLogSink: () => undefined });

    const response = await app.request("/api/workspace/init", {
      method: "POST",
      headers: authenticatedHeaders("existing-secrets-mode-token")
    });
    expect(response.status).toBe(500);
    expect((await stat(join(workspaceRoot, "secrets"))).mode & 0o7777).toBe(0o755);
    await expectMissing(join(workspaceRoot, "secrets", "local-token"));
  });

  test("workspace init creates secrets at exact 0700 under permissive and restrictive umasks", async () => {
    process.env.HARNESS_LOCAL_TOKEN = "umask-private-secrets-token";
    for (const fixture of [
      { label: "permissive", mode: 0o000 },
      { label: "restrictive-owner-bits", mode: 0o777 }
    ]) {
      const workspaceRoot = await temporaryWorkspacePath();
      if (fixture.mode === 0o777) {
        for (const relativeDirectory of WORKSPACE_CANONICAL_DIRECTORIES) {
          if (relativeDirectory === "secrets") continue;
          await mkdir(join(workspaceRoot, relativeDirectory), { recursive: true });
        }
      }
      const app = createBackendApi({ workspaceRoot, requestLogSink: () => undefined });
      const previousUmask = process.umask(fixture.mode);
      let response!: Response;
      try {
        response = await app.request("/api/workspace/init", {
          method: "POST",
          headers: authenticatedHeaders("umask-private-secrets-token")
        });
      } finally {
        process.umask(previousUmask);
      }

      expect(response.status, fixture.label).toBe(200);
      expect(
        (await stat(join(workspaceRoot, "secrets"))).mode & 0o7777,
        fixture.label
      ).toBe(0o700);
      await expectMissing(join(workspaceRoot, "secrets", "local-token"));
    }
  });

  test("configured and presented credentials never enter 200, 401, or 500 logs and bodies", async () => {
    const workspaceRoot = await temporaryWorkspacePath();
    const configured = "configured-log-token-unique";
    const presented = "presented-log-token-unique";
    process.env.HARNESS_LOCAL_TOKEN = configured;
    const lines: string[] = [];
    const app = createBackendApi({
      workspaceRoot,
      requestLogSink: (line) => lines.push(line),
      taskServiceFactory: (options) => ({
        ...createTaskCardService(options),
        listTasks: async () => {
          throw new Error(`internal ${configured} ${presented}`);
        }
      })
    });

    const successBody = await app.request("/api/workspace/init", {
      method: "POST",
      headers: authenticatedHeaders(configured)
    }).then((response) => response.text());
    const unauthorizedBody = await app.request("/api/tasks", {
      headers: authenticatedHeaders(presented)
    }).then((response) => response.text());
    const errorResponse = await app.request("/api/tasks", {
      headers: authenticatedHeaders(configured)
    });
    const errorBody = await errorResponse.text();
    expect(errorResponse.status).toBe(500);
    await waitFor(() => lines.length === 3);

    for (const evidence of [...lines, successBody, unauthorizedBody, errorBody]) {
      expect(evidence).not.toContain(configured);
      expect(evidence).not.toContain(presented);
      expect(evidence).not.toContain("local-token");
    }
    expect(lines.map((line) => JSON.parse(line).status)).toEqual([200, 401, 500]);
  });
});

function authenticatedHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

async function temporaryWorkspacePath(): Promise<string> {
  const tempRoot = await realpath(
    await mkdtemp(join(tmpdir(), "shud-harness-local-auth-integration-"))
  );
  tempRoots.push(tempRoot);
  return join(tempRoot, "workspace");
}

async function expectMissing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

function restoreToken(value: string | undefined): void {
  if (value === undefined) delete process.env.HARNESS_LOCAL_TOKEN;
  else process.env.HARNESS_LOCAL_TOKEN = value;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("request logs were not emitted in time");
}

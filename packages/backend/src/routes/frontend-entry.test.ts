import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HARNESS_API_CLIENT_SCRIPT_ATTRIBUTE,
  HARNESS_BOOTSTRAP_SCRIPT_ATTRIBUTE
} from "@shud-harness/frontend";
import { createBackendProductionServerOptions } from "../production-server";

const TEST_TOKEN = "backend-frontend-entry-token";
const TEST_ORIGIN = "http://127.0.0.1:3000";
const CREATED_TASK_ID = "TASK-11111111-1111-4111-8111-111111111111";
const REPLACEMENT_TOKEN = "backend-frontend-entry-replacement-token";
const tempRoots: string[] = [];

describe("production frontend entry", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  test("bootstraps the local token and completes browser create/list through the API wrapper", async () => {
    const tempRoot = await createTempRoot("shud-harness-frontend-entry-");
    tempRoots.push(tempRoot);
    const workspaceRoot = join(tempRoot, "workspace");
    const server = createServerWithTestToken({
      workspaceRoot,
      taskIdFactory: () => CREATED_TASK_ID,
      requestLogSink: () => undefined
    });

    const initResponse = await server.fetch(
      new Request(`${TEST_ORIGIN}/api/workspace/init`, {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_TOKEN}` }
      })
    );
    expect(initResponse.status).toBe(200);

    const entryResponse = await server.fetch(new Request(`${TEST_ORIGIN}/`));
    expect(entryResponse.status).toBe(200);
    expect(entryResponse.headers.get("content-type")).toContain("text/html");
    expectFrontendPageSecurityHeaders(entryResponse);
    const entryDocument = await entryResponse.text();
    expect(entryDocument).toContain(HARNESS_BOOTSTRAP_SCRIPT_ATTRIBUTE);
    expect(entryDocument).toContain(HARNESS_API_CLIENT_SCRIPT_ATTRIBUTE);
    expect(entryDocument).toContain("data-dashboard-create-script");

    const browserRequests: Array<{
      url: string;
      method: string;
      authorization: string | null;
    }> = [];
    const listeners = new Map<
      string,
      (event: { preventDefault: () => void }) => void | Promise<void>
    >();
    const listRegion = { innerHTML: "" };
    const errorRegion = { innerHTML: "", hidden: true };
    let resetCalled = false;
    const formValues: Record<string, string> = {
      type: "engineering",
      title: "浏览器 token 建卡回归",
      question_or_goal: "验证 bootstrap、wrapper、POST 与 GET 的完整链路。",
      budget_mode: "normal"
    };
    const form = {
      addEventListener(
        type: string,
        listener: (event: { preventDefault: () => void }) => void | Promise<void>
      ) {
        listeners.set(type, listener);
      },
      reset() {
        resetCalled = true;
      }
    };
    const documentLike = {
      querySelector(selector: string) {
        if (selector === "[data-create-task-form]") return form;
        if (selector === "[data-dashboard-task-list]") return listRegion;
        if (selector === "[data-dashboard-errors]") return errorRegion;
        return undefined;
      }
    };
    class FakeFormData {
      get(name: string): string | null {
        return formValues[name] ?? null;
      }
    }

    const windowLike: Record<string, unknown> = {
      location: { origin: TEST_ORIGIN },
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = toBrowserRequest(input, init);
        browserRequests.push({
          url: request.url,
          method: request.method,
          authorization: request.headers.get("authorization")
        });
        return await server.fetch(request);
      }
    };
    Object.defineProperty(windowLike, "localStorage", {
      get() {
        throw new Error("The browser credential must not use localStorage.");
      }
    });

    new Function("window", inlineScript(entryDocument, HARNESS_BOOTSTRAP_SCRIPT_ATTRIBUTE))(
      windowLike
    );
    new Function("window", inlineScript(entryDocument, HARNESS_API_CLIENT_SCRIPT_ATTRIBUTE))(
      windowLike
    );
    new Function(
      "document",
      "window",
      "FormData",
      inlineScript(entryDocument, "data-dashboard-create-script")
    )(documentLike, windowLike, FakeFormData);

    const submit = listeners.get("submit");
    if (!submit) throw new Error("Dashboard submit listener was not registered.");
    let prevented = false;
    await submit({
      preventDefault() {
        prevented = true;
      }
    });

    expect(prevented).toBe(true);
    expect(resetCalled).toBe(true);
    expect(errorRegion.hidden).toBe(true);
    expect(listRegion.innerHTML).toContain(CREATED_TASK_ID);
    expect(listRegion.innerHTML).toContain("浏览器 token 建卡回归");
    expect(browserRequests.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
      ["POST", "/api/tasks"],
      ["GET", "/api/tasks"]
    ]);
    expect(browserRequests.map((request) => request.authorization)).toEqual([
      `Bearer ${TEST_TOKEN}`,
      `Bearer ${TEST_TOKEN}`
    ]);
    expect(browserRequests.every((request) => !request.url.includes(TEST_TOKEN))).toBe(true);
  });

  test("serves both frontend aliases with anti-framing and credential-safe headers", async () => {
    const tempRoot = await createTempRoot("shud-harness-frontend-headers-");
    tempRoots.push(tempRoot);
    const server = createServerWithTestToken({
      workspaceRoot: join(tempRoot, "workspace"),
      requestLogSink: () => undefined
    });

    for (const pathname of ["/", "/dashboard"] as const) {
      const response = await server.fetch(new Request(`${TEST_ORIGIN}${pathname}`));
      const body = await response.text();

      expect(response.status, pathname).toBe(200);
      expect(response.headers.get("content-type"), pathname).toContain("text/html");
      expectFrontendPageSecurityHeaders(response);
      expect(body, pathname).toContain(HARNESS_BOOTSTRAP_SCRIPT_ATTRIBUTE);
      expect(body, pathname).toContain(HARNESS_API_CLIENT_SCRIPT_ATTRIBUTE);
    }
  });

  test("does not disclose the bootstrap to a non-loopback Host origin", async () => {
    const tempRoot = await createTempRoot("shud-harness-frontend-host-");
    tempRoots.push(tempRoot);
    const server = createServerWithTestToken({
      workspaceRoot: join(tempRoot, "workspace"),
      requestLogSink: () => undefined
    });

    const response = await server.fetch(new Request("http://attacker.example/"));
    const body = await response.text();

    expect(response.status).toBe(404);
    expectFrontendPageSecurityHeaders(response);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(body).toBe("Not Found");
    expect(body).not.toContain(TEST_TOKEN);
    expect(body).not.toContain(HARNESS_BOOTSTRAP_SCRIPT_ATTRIBUTE);
  });

  test("returns a generic 503 when file authority changes before the dashboard proof", async () => {
    await withoutEnvironmentLocalToken(async () => {
      const tempRoot = await createTempRoot("shud-harness-frontend-stale-before-");
      tempRoots.push(tempRoot);
      const workspaceRoot = join(tempRoot, "workspace");
      const server = createBackendProductionServerOptions({
        workspaceRoot,
        requestLogSink: () => undefined
      });
      const oldToken = await readWorkspaceLocalToken(workspaceRoot);
      await replaceWorkspaceLocalToken(workspaceRoot, REPLACEMENT_TOKEN);

      const response = await server.fetch(new Request(`${TEST_ORIGIN}/dashboard`));

      await expectGenericUnavailableResponse(response, {
        oldToken,
        newToken: REPLACEMENT_TOKEN,
        workspaceRoot
      });
    });
  });

  test("returns a generic 503 when file authority changes during root snapshot rendering", async () => {
    await withoutEnvironmentLocalToken(async () => {
      const tempRoot = await createTempRoot("shud-harness-frontend-stale-render-");
      tempRoots.push(tempRoot);
      const workspaceRoot = join(tempRoot, "workspace");
      let replacementStarted = false;
      const server = createBackendProductionServerOptions({
        workspaceRoot,
        requestLogSink: () => undefined,
        taskSnapshotReadHooks: {
          async beforeHydrationTasksRootMetadata() {
            if (replacementStarted) return;
            replacementStarted = true;
            await replaceWorkspaceLocalToken(workspaceRoot, REPLACEMENT_TOKEN);
          }
        }
      });
      const oldToken = await readWorkspaceLocalToken(workspaceRoot);

      const response = await server.fetch(new Request(`${TEST_ORIGIN}/`));

      expect(replacementStarted).toBe(true);
      await expectGenericUnavailableResponse(response, {
        oldToken,
        newToken: REPLACEMENT_TOKEN,
        workspaceRoot
      });
    });
  });
});

async function createTempRoot(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

function toBrowserRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  if (input instanceof Request) return new Request(input, init);
  const rawUrl = input instanceof URL ? input.href : String(input);
  return new Request(new URL(rawUrl, TEST_ORIGIN), init);
}

function inlineScript(document: string, attribute: string): string {
  const pattern = new RegExp(`<script ${attribute}>([\\s\\S]*?)<\\/script>`);
  const match = pattern.exec(document);
  if (!match?.[1]) throw new Error(`Missing inline script: ${attribute}`);
  return match[1];
}

function expectFrontendPageSecurityHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

async function expectGenericUnavailableResponse(
  response: Response,
  secrets: { readonly oldToken: string; readonly newToken: string; readonly workspaceRoot: string }
): Promise<void> {
  const body = await response.text();
  const publication = `${JSON.stringify([...response.headers])}\n${body}`;
  expect(response.status).toBe(503);
  expect(body).toBe("Service Unavailable");
  expectFrontendPageSecurityHeaders(response);
  expect(publication).not.toContain(HARNESS_BOOTSTRAP_SCRIPT_ATTRIBUTE);
  expect(publication).not.toContain(secrets.oldToken);
  expect(publication).not.toContain(secrets.newToken);
  expect(publication).not.toContain(secrets.workspaceRoot);
}

async function readWorkspaceLocalToken(workspaceRoot: string): Promise<string> {
  return await readFile(join(workspaceRoot, "secrets", "local-token"), "utf8");
}

async function replaceWorkspaceLocalToken(workspaceRoot: string, token: string): Promise<void> {
  const tokenPath = join(workspaceRoot, "secrets", "local-token");
  const displacedPath = join(workspaceRoot, "secrets", "local-token.displaced");
  await rename(tokenPath, displacedPath);
  await writeFile(tokenPath, token, { flag: "wx", mode: 0o600 });
  await unlink(displacedPath);
}

async function withoutEnvironmentLocalToken(action: () => Promise<void>): Promise<void> {
  const previousToken = process.env.HARNESS_LOCAL_TOKEN;
  delete process.env.HARNESS_LOCAL_TOKEN;
  try {
    await action();
  } finally {
    if (previousToken === undefined) {
      delete process.env.HARNESS_LOCAL_TOKEN;
    } else {
      process.env.HARNESS_LOCAL_TOKEN = previousToken;
    }
  }
}

function createServerWithTestToken(
  options: Parameters<typeof createBackendProductionServerOptions>[0]
): ReturnType<typeof createBackendProductionServerOptions> {
  const previousToken = process.env.HARNESS_LOCAL_TOKEN;
  process.env.HARNESS_LOCAL_TOKEN = TEST_TOKEN;
  try {
    return createBackendProductionServerOptions(options);
  } finally {
    if (previousToken === undefined) {
      delete process.env.HARNESS_LOCAL_TOKEN;
    } else {
      process.env.HARNESS_LOCAL_TOKEN = previousToken;
    }
  }
}

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HARNESS_API_CLIENT_SCRIPT_ATTRIBUTE,
  HARNESS_BOOTSTRAP_SCRIPT_ATTRIBUTE
} from "../../../frontend/src/index";
import { createBackendProductionServerOptions } from "../production-server";

const TEST_TOKEN = "backend-frontend-entry-token";
const TEST_ORIGIN = "http://127.0.0.1:3000";
const CREATED_TASK_ID = "TASK-11111111-1111-4111-8111-111111111111";
const tempRoots: string[] = [];

describe("production frontend entry", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  test("bootstraps the local token and completes browser create/list through the API wrapper", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shud-harness-frontend-entry-"));
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
    expect(entryResponse.headers.get("cache-control")).toBe("no-store");
    expect(entryResponse.headers.get("access-control-allow-origin")).toBeNull();
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

  test("does not disclose the bootstrap to a non-loopback Host origin", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "shud-harness-frontend-host-"));
    tempRoots.push(tempRoot);
    const server = createServerWithTestToken({
      workspaceRoot: join(tempRoot, "workspace"),
      requestLogSink: () => undefined
    });

    const response = await server.fetch(new Request("http://attacker.example/"));
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).not.toContain(TEST_TOKEN);
    expect(body).not.toContain(HARNESS_BOOTSTRAP_SCRIPT_ATTRIBUTE);
  });
});

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

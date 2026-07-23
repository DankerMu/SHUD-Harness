import { describe, expect, test } from "bun:test";

import type { TaskCard } from "@shud-harness/core";
import {
  DASHBOARD_CREATE_FORM_SCRIPT,
  DASHBOARD_TASKS_ENDPOINT,
  HARNESS_API_CLIENT_SCRIPT,
  HARNESS_API_FETCH_GLOBAL,
  HARNESS_BOOTSTRAP_GLOBAL,
  createDashboardController,
  createDashboardTask,
  listDashboardTasks,
  renderDashboardDocument,
  renderDashboardFromServer
} from "../index";

const DASHBOARD_TEST_ORIGIN = "http://127.0.0.1:3000";
const DASHBOARD_TEST_TOKEN = "dashboard-browser-test-token";

describe("Dashboard task page", () => {
  test("page-local helpers parse task list and create responses", async () => {
    const existingTask = taskCardFixture("TASK-dashboard-list", {
      title: "恢复已有 TaskCard"
    });
    const createdTask = taskCardFixture("TASK-dashboard-create", {
      title: "新建 TaskCard"
    });
    const fake = createFakeFetch([
      { body: { tasks: [existingTask] } },
      { status: 201, body: createdTask }
    ]);

    await expect(listDashboardTasks(fake.fetchClient)).resolves.toEqual([existingTask]);
    await expect(
      createDashboardTask(
        {
          type: "engineering",
          title: "新建 TaskCard",
          question_or_goal: "检查 Dashboard 建卡 helper。",
          inference_budget: { mode: "normal" }
        },
        fake.fetchClient
      )
    ).resolves.toEqual(createdTask);

    expect(fake.requests.map((request) => request.url)).toEqual([
      DASHBOARD_TASKS_ENDPOINT,
      DASHBOARD_TASKS_ENDPOINT
    ]);
    expect(fake.requests.map((request) => request.method)).toEqual(["GET", "POST"]);
  });

  test("renders empty state, bootstrap order, and create controls", () => {
    const document = renderDashboardDocument(
      { tasks: [], phase: "ready" },
      { token: DASHBOARD_TEST_TOKEN }
    );

    expect(document.startsWith("<!doctype html>")).toBe(true);
    expect(document).toContain('<html lang="zh-CN">');
    expect(document).toContain("当前没有 TaskCard。");
    expect(document).toContain('name="type"');
    expect(document).toContain('name="title"');
    expect(document).toContain('name="question_or_goal"');
    expect(document).toContain('name="budget_mode"');
    expect(document).toContain("创建 TaskCard");
    expect(document).toContain("data-harness-bootstrap");
    expect(document).toContain("data-harness-api-client");
    expect(document).toContain("data-dashboard-create-script");
    expect(document.indexOf("data-harness-bootstrap")).toBeLessThan(
      document.indexOf("data-harness-api-client")
    );
    expect(document.indexOf("data-harness-api-client")).toBeLessThan(
      document.indexOf("data-dashboard-create-script")
    );
    expect(DASHBOARD_CREATE_FORM_SCRIPT).not.toContain("window.fetch");
    expect(DASHBOARD_CREATE_FORM_SCRIPT).toContain(HARNESS_API_FETCH_GLOBAL);
  });

  test("create flow posts exact payload keys and refreshes from the backend list", async () => {
    const createdTask = taskCardFixture("TASK-dashboard-created", {
      title: "Dashboard 建卡验收",
      status: "created"
    });
    const fake = createFakeFetch([
      { body: { tasks: [] } },
      { status: 201, body: createdTask },
      { body: { tasks: [createdTask] } }
    ]);
    const controller = createDashboardController(fake.fetchClient);

    const initialDocument = await controller.load();
    expect(initialDocument).toContain("当前没有 TaskCard。");

    const createdDocument = await controller.createTask({
      type: "engineering",
      title: "Dashboard 建卡验收",
      question_or_goal: "验证 POST 后重新读取 GET /api/tasks。",
      inference_budget: { mode: "normal" }
    });

    expect(fake.requests).toHaveLength(3);
    expect(fake.requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", DASHBOARD_TASKS_ENDPOINT],
      ["POST", DASHBOARD_TASKS_ENDPOINT],
      ["GET", DASHBOARD_TASKS_ENDPOINT]
    ]);

    const postBody = fake.requests[1]?.jsonBody as Record<string, unknown>;
    expect(Object.keys(postBody)).toEqual([
      "type",
      "title",
      "question_or_goal",
      "inference_budget"
    ]);
    expect(postBody).toEqual({
      type: "engineering",
      title: "Dashboard 建卡验收",
      question_or_goal: "验证 POST 后重新读取 GET /api/tasks。",
      inference_budget: { mode: "normal" }
    });
    expect(Object.keys(postBody.inference_budget as Record<string, unknown>)).toEqual(["mode"]);

    expect(countOccurrences(createdDocument, "<tr data-task-row>")).toBe(1);
    expect(countOccurrences(createdDocument, "TASK-dashboard-created")).toBe(1);
    expect(countOccurrences(createdDocument, "Dashboard 建卡验收")).toBe(1);
    expect(countOccurrences(createdDocument, ">created<")).toBe(1);
  });

  test("rendered form submit script posts exact authenticated JSON and refreshes task rows", async () => {
    const createdTask = taskCardFixture("TASK-dashboard-script", {
      title: "脚本建卡验收",
      status: "created"
    });
    const harness = createDashboardScriptHarness(
      {
        type: "engineering",
        title: "脚本建卡验收",
        question_or_goal: "验证可见表单提交路径。",
        budget_mode: "normal"
      },
      [{ status: 201, body: createdTask }, { body: { tasks: [createdTask] } }]
    );

    await harness.submit();

    expect(harness.prevented).toBe(true);
    expect(harness.fake.requests.map((request) => [request.method, request.url])).toEqual([
      ["POST", DASHBOARD_TASKS_ENDPOINT],
      ["GET", DASHBOARD_TASKS_ENDPOINT]
    ]);
    expect(harness.fake.requests.map((request) => request.authorization)).toEqual([
      `Bearer ${DASHBOARD_TEST_TOKEN}`,
      `Bearer ${DASHBOARD_TEST_TOKEN}`
    ]);

    const postBody = harness.fake.requests[0]?.jsonBody as Record<string, unknown>;
    expect(Object.keys(postBody)).toEqual([
      "type",
      "title",
      "question_or_goal",
      "inference_budget"
    ]);
    expect(postBody).toEqual({
      type: "engineering",
      title: "脚本建卡验收",
      question_or_goal: "验证可见表单提交路径。",
      inference_budget: { mode: "normal" }
    });
    expect(Object.keys(postBody.inference_budget as Record<string, unknown>)).toEqual(["mode"]);
    expect(harness.listRegion.innerHTML).toContain("TASK-dashboard-script");
    expect(harness.listRegion.innerHTML).toContain("脚本建卡验收");
    expect(harness.listRegion.innerHTML).toContain(">created<");
    expect(harness.errorRegion.hidden).toBe(true);
    expect(harness.resetCalled).toBe(true);
  });

  test("rendered form submit script rejects malformed create responses without phantom rows", async () => {
    const harness = createDashboardScriptHarness(
      {
        type: "engineering",
        title: "脚本畸形创建",
        question_or_goal: "POST 响应缺少 TaskCard 字段。",
        budget_mode: "normal"
      },
      [{ status: 201, body: { task_id: "TASK-script-incomplete" } }]
    );

    await harness.submit();

    expect(harness.fake.requests).toHaveLength(1);
    expect(harness.errorRegion.hidden).toBe(false);
    expect(harness.errorRegion.innerHTML).toContain("任务创建失败。");
    expect(harness.errorRegion.innerHTML).toContain("任务创建响应格式不符合 TaskCard 契约。");
    expect(harness.listRegion.innerHTML).not.toContain("<tr data-task-row>");
    expect(harness.listRegion.innerHTML).not.toContain("TASK-script-incomplete");
    expect(harness.resetCalled).toBe(false);
  });

  test("rendered form submit script rejects invalid create status enum", async () => {
    const harness = createDashboardScriptHarness(
      {
        type: "engineering",
        title: "脚本非法状态创建",
        question_or_goal: "POST 响应 status 非法。",
        budget_mode: "normal"
      },
      [
        {
          status: 201,
          body: taskCardFixture("TASK-script-invalid-create-status", {
            status: "not_a_status" as TaskCard["status"]
          })
        }
      ]
    );

    await harness.submit();

    expect(harness.errorRegion.hidden).toBe(false);
    expect(harness.errorRegion.innerHTML).toContain("任务创建失败。");
    expect(harness.errorRegion.innerHTML).toContain("任务创建响应格式不符合 TaskCard 契约。");
    expect(harness.listRegion.innerHTML).not.toContain("<tr data-task-row>");
    expect(harness.listRegion.innerHTML).not.toContain("TASK-script-invalid-create-status");
    expect(harness.resetCalled).toBe(false);
  });

  test("rendered form submit script rejects malformed refreshed task rows", async () => {
    const createdTask = taskCardFixture("TASK-script-refresh", {
      title: "脚本创建后刷新畸形",
      status: "created"
    });
    const harness = createDashboardScriptHarness(
      {
        type: "engineering",
        title: "脚本创建后刷新畸形",
        question_or_goal: "GET tasks 元素缺少字段。",
        budget_mode: "normal"
      },
      [
        { status: 201, body: createdTask },
        { body: { tasks: [{ task_id: "TASK-script-malformed" }] } }
      ]
    );

    await harness.submit();

    expect(harness.fake.requests.map((request) => request.method)).toEqual(["POST", "GET"]);
    expect(harness.errorRegion.hidden).toBe(false);
    expect(harness.errorRegion.innerHTML).toContain("任务已提交，但列表刷新失败。");
    expect(harness.errorRegion.innerHTML).toContain("任务列表响应格式不符合 TaskCard 契约。");
    expect(harness.listRegion.innerHTML).not.toContain("<tr data-task-row>");
    expect(harness.listRegion.innerHTML).not.toContain("TASK-script-malformed");
    expect(harness.resetCalled).toBe(false);
  });

  test("rendered form submit script rejects invalid refreshed task status enum", async () => {
    const createdTask = taskCardFixture("TASK-script-valid-create", {
      title: "脚本创建成功",
      status: "created"
    });
    const harness = createDashboardScriptHarness(
      {
        type: "engineering",
        title: "脚本非法状态刷新",
        question_or_goal: "GET tasks status 非法。",
        budget_mode: "normal"
      },
      [
        { status: 201, body: createdTask },
        {
          body: {
            tasks: [
              taskCardFixture("TASK-script-invalid-list-status", {
                title: "非法状态行",
                status: "not_a_status" as TaskCard["status"]
              })
            ]
          }
        }
      ]
    );

    await harness.submit();

    expect(harness.fake.requests.map((request) => request.method)).toEqual(["POST", "GET"]);
    expect(harness.errorRegion.hidden).toBe(false);
    expect(harness.errorRegion.innerHTML).toContain("任务已提交，但列表刷新失败。");
    expect(harness.errorRegion.innerHTML).toContain("任务列表响应格式不符合 TaskCard 契约。");
    expect(harness.listRegion.innerHTML).not.toContain("<tr data-task-row>");
    expect(harness.listRegion.innerHTML).not.toContain("TASK-script-invalid-list-status");
    expect(harness.resetCalled).toBe(false);
  });

  test("fresh render recovers a previously created task from GET /api/tasks", async () => {
    const previouslyCreated = taskCardFixture("TASK-dashboard-recovered", {
      title: "刷新恢复任务",
      status: "created"
    });
    const fake = createFakeFetch([{ body: { tasks: [previouslyCreated] } }]);

    const document = await renderDashboardFromServer(fake.fetchClient);

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.method).toBe("GET");
    expect(countOccurrences(document, "<tr data-task-row>")).toBe(1);
    expect(countOccurrences(document, "TASK-dashboard-recovered")).toBe(1);
    expect(countOccurrences(document, "刷新恢复任务")).toBe(1);
    expect(countOccurrences(document, ">created<")).toBe(1);
  });

  test("list failure renders Chinese-first error copy and no phantom task row", async () => {
    const fake = createFakeFetch([{ status: 500, body: { error: "boom" } }]);
    const controller = createDashboardController(fake.fetchClient);

    const document = await controller.load();

    expect(document).toContain("任务列表加载失败。");
    expect(document).toContain("任务列表请求失败");
    expect(document).toContain("任务列表暂不可用。");
    expect(document).not.toContain("<tr data-task-row>");
    expect(document).not.toContain("TASK-phantom");
  });

  test("malformed list response renders an error state without phantom rows", async () => {
    const fake = createFakeFetch([{ body: { items: [taskCardFixture("TASK-wrong-shape")] } }]);
    const controller = createDashboardController(fake.fetchClient);

    const document = await controller.load();

    expect(document).toContain("任务列表加载失败。");
    expect(document).toContain("任务列表响应格式不符合 TaskCard 契约。");
    expect(document).toContain("任务列表暂不可用。");
    expect(document).not.toContain("<tr data-task-row>");
    expect(document).not.toContain("TASK-wrong-shape");
  });

  test("create failure renders Chinese-first error copy and no phantom task row", async () => {
    const fake = createFakeFetch([
      { body: { tasks: [] } },
      { status: 500, body: { error: "boom" } }
    ]);
    const controller = createDashboardController(fake.fetchClient);

    await controller.load();
    const document = await controller.createTask({
      type: "engineering",
      title: "不会出现的任务",
      question_or_goal: "失败时不能乐观插入列表。",
      inference_budget: { mode: "normal" }
    });

    expect(fake.requests).toHaveLength(2);
    expect(document).toContain("任务创建失败。");
    expect(document).toContain("任务创建请求失败");
    expect(document).not.toContain("<tr data-task-row>");
    expect(document).not.toContain("不会出现的任务");
  });

  test("post-create refresh failure is not reported as create failure", async () => {
    const createdTask = taskCardFixture("TASK-refresh-failed", {
      title: "已创建但刷新失败",
      status: "created"
    });
    const fake = createFakeFetch([
      { body: { tasks: [] } },
      { status: 201, body: createdTask },
      { status: 500, body: { error: "list failed" } }
    ]);
    const controller = createDashboardController(fake.fetchClient);

    await controller.load();
    const document = await controller.createTask({
      type: "engineering",
      title: "已创建但刷新失败",
      question_or_goal: "POST 成功后 GET 失败。",
      inference_budget: { mode: "normal" }
    });

    expect(document).toContain("任务已提交，但列表刷新失败。");
    expect(document).toContain("任务列表请求失败");
    expect(document).not.toContain("任务创建失败。");
    expect(document).not.toContain("<tr data-task-row>");
    expect(document).not.toContain("TASK-refresh-failed");
  });

  test("post-create malformed refresh is not reported as create failure", async () => {
    const createdTask = taskCardFixture("TASK-refresh-malformed", {
      title: "已创建但刷新畸形",
      status: "created"
    });
    const fake = createFakeFetch([
      { body: { tasks: [] } },
      { status: 201, body: createdTask },
      { status: 200, body: { items: [createdTask] } }
    ]);
    const controller = createDashboardController(fake.fetchClient);

    await controller.load();
    const document = await controller.createTask({
      type: "engineering",
      title: "已创建但刷新畸形",
      question_or_goal: "POST 成功后 GET shape 错误。",
      inference_budget: { mode: "normal" }
    });

    expect(document).toContain("任务已提交，但列表刷新失败。");
    expect(document).toContain("任务列表响应格式不符合 TaskCard 契约。");
    expect(document).not.toContain("任务创建失败。");
    expect(document).not.toContain("<tr data-task-row>");
    expect(document).not.toContain("TASK-refresh-malformed");
  });

  test("malformed create response renders an error state without phantom rows", async () => {
    const fake = createFakeFetch([
      { body: { tasks: [] } },
      { status: 201, body: { task_id: "TASK-incomplete" } }
    ]);
    const controller = createDashboardController(fake.fetchClient);

    await controller.load();
    const document = await controller.createTask({
      type: "engineering",
      title: "格式错误不应出现",
      question_or_goal: "创建响应缺少 TaskCard 字段。",
      inference_budget: { mode: "normal" }
    });

    expect(document).toContain("任务创建失败。");
    expect(document).toContain("任务创建响应格式不符合 TaskCard 契约。");
    expect(document).not.toContain("<tr data-task-row>");
    expect(document).not.toContain("TASK-incomplete");
    expect(document).not.toContain("格式错误不应出现");
  });
});

interface FakeFetchResponse {
  status?: number;
  body: unknown;
}

interface RecordedFetchRequest {
  url: string;
  method: string;
  authorization: string | null;
  jsonBody?: unknown;
}

function createFakeFetch(responses: FakeFetchResponse[]) {
  const requests: RecordedFetchRequest[] = [];

  const fetchClient = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const next = responses.shift();
    if (!next) {
      throw new Error("No fake fetch response queued.");
    }

    const method = init?.method ?? "GET";
    const textBody = typeof init?.body === "string" ? init.body : undefined;
    requests.push({
      url: String(input),
      method,
      authorization: new Headers(init?.headers).get("authorization"),
      jsonBody: textBody ? JSON.parse(textBody) : undefined
    });

    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  return { fetchClient, requests };
}

interface DashboardScriptHarness {
  fake: ReturnType<typeof createFakeFetch>;
  listRegion: { innerHTML: string };
  errorRegion: { innerHTML: string; hidden: boolean };
  prevented: boolean;
  resetCalled: boolean;
  submit: () => Promise<void>;
}

function createDashboardScriptHarness(
  formValues: Record<string, string>,
  responses: FakeFetchResponse[]
): DashboardScriptHarness {
  const fake = createFakeFetch(responses);
  const listeners = new Map<string, (event: { preventDefault: () => void }) => void | Promise<void>>();
  const listRegion = { innerHTML: "" };
  const errorRegion = { innerHTML: "", hidden: true };
  let prevented = false;
  let resetCalled = false;
  const form = {
    addEventListener: (
      type: string,
      listener: (event: { preventDefault: () => void }) => void | Promise<void>
    ) => {
      listeners.set(type, listener);
    },
    reset: () => {
      resetCalled = true;
    }
  };
  const documentLike = {
    querySelector: (selector: string) => {
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
    [HARNESS_BOOTSTRAP_GLOBAL]: Object.freeze({ token: DASHBOARD_TEST_TOKEN }),
    location: { origin: DASHBOARD_TEST_ORIGIN },
    fetch: fake.fetchClient
  };
  Object.defineProperty(windowLike, "localStorage", {
    get() {
      throw new Error("Dashboard authentication must not use localStorage.");
    }
  });
  new Function("window", HARNESS_API_CLIENT_SCRIPT)(windowLike);
  if (typeof windowLike[HARNESS_API_FETCH_GLOBAL] !== "function") {
    throw new Error("Harness API client was not installed.");
  }

  const runScript = new Function("document", "window", "FormData", DASHBOARD_CREATE_FORM_SCRIPT);
  runScript(documentLike, windowLike, FakeFormData);

  return {
    fake,
    listRegion,
    errorRegion,
    get prevented() {
      return prevented;
    },
    get resetCalled() {
      return resetCalled;
    },
    async submit() {
      const listener = listeners.get("submit");
      if (!listener) {
        throw new Error("Dashboard submit listener was not registered.");
      }
      await listener({
        preventDefault: () => {
          prevented = true;
        }
      });
    }
  };
}

function taskCardFixture(taskId: string, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    task_id: taskId,
    type: "engineering",
    status: "created",
    title: "Dashboard 任务",
    question_or_goal: "验证 Dashboard 页面。",
    created_by: "pi",
    current_owner: "coordinator",
    reviewer: "reviewer",
    inference_budget: { mode: "normal" },
    linked_jobs: [],
    linked_reports: [],
    created_at: "2026-07-08T05:00:00.000Z",
    updated_at: "2026-07-08T05:00:00.000Z",
    ...overrides
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

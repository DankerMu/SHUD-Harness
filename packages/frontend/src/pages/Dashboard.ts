import {
  CreateTaskInputSchema,
  TaskCardSchema,
  type CreateTaskInput,
  type TaskCard,
  type TaskType
} from "@shud-harness/core";
import {
  harnessApiFetch,
  renderHarnessApiClientScript,
  renderHarnessBootstrapScript,
  type HarnessApiFetch,
  type HarnessBootstrap
} from "../api";
import { DASHBOARD_CREATE_FORM_SCRIPT } from "./DashboardClientScript";
import { DASHBOARD_CSS } from "./DashboardCss";
import { escapeHtml } from "../components";

export const DASHBOARD_ROUTE = "/" as const;
export const DASHBOARD_ALTERNATE_ROUTE = "/dashboard" as const;
export const DASHBOARD_TASKS_ENDPOINT = "/api/tasks" as const;

export type DashboardFetch = HarnessApiFetch;

export type DashboardBudgetMode = CreateTaskInput["inference_budget"]["mode"];

export interface DashboardCreateTaskInput {
  type: TaskType;
  title: string;
  question_or_goal: string;
  inference_budget: {
    mode: DashboardBudgetMode;
  };
}

export interface DashboardFormValues {
  type: TaskType;
  title: string;
  question_or_goal: string;
  budgetMode: DashboardBudgetMode;
}

export interface DashboardRenderState {
  tasks: readonly TaskCard[];
  phase?: "loading" | "ready" | "submitting";
  listError?: string;
  createError?: string;
  formValues?: Partial<DashboardFormValues>;
}

export class DashboardTaskApiError extends Error {
  readonly endpoint: string;
  readonly status?: number;

  constructor(message: string, options: { endpoint: string; status?: number }) {
    super(message);
    this.name = "DashboardTaskApiError";
    this.endpoint = options.endpoint;
    this.status = options.status;
  }
}

export async function listDashboardTasks(
  fetchClient: DashboardFetch = harnessApiFetch
): Promise<TaskCard[]> {
  const response = await fetchClient(DASHBOARD_TASKS_ENDPOINT, {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new DashboardTaskApiError(`任务列表请求失败（HTTP ${response.status}）。`, {
      endpoint: DASHBOARD_TASKS_ENDPOINT,
      status: response.status
    });
  }

  const payload = await readJsonResponse(response, DASHBOARD_TASKS_ENDPOINT);
  return parseDashboardTaskListResponse(payload, DASHBOARD_TASKS_ENDPOINT);
}

export async function createDashboardTask(
  input: DashboardCreateTaskInput,
  fetchClient: DashboardFetch = harnessApiFetch
): Promise<TaskCard> {
  const body = dashboardCreateTaskBody(input);
  const response = await fetchClient(DASHBOARD_TASKS_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new DashboardTaskApiError(`任务创建请求失败（HTTP ${response.status}）。`, {
      endpoint: DASHBOARD_TASKS_ENDPOINT,
      status: response.status
    });
  }

  const payload = await readJsonResponse(response, DASHBOARD_TASKS_ENDPOINT);
  return parseDashboardTaskCardResponse(payload, DASHBOARD_TASKS_ENDPOINT);
}

export function dashboardCreateTaskBody(
  input: DashboardCreateTaskInput
): DashboardCreateTaskInput {
  const parsed = CreateTaskInputSchema.parse(input);

  return {
    type: parsed.type,
    title: parsed.title,
    question_or_goal: parsed.question_or_goal,
    inference_budget: {
      mode: parsed.inference_budget.mode
    }
  };
}

export function createDashboardController(fetchClient: DashboardFetch = harnessApiFetch) {
  let state: DashboardRenderState = {
    tasks: [],
    phase: "loading"
  };

  return {
    async load(): Promise<string> {
      state = {
        tasks: [],
        phase: "loading"
      };

      try {
        state = {
          tasks: await listDashboardTasks(fetchClient),
          phase: "ready"
        };
      } catch (error) {
        state = {
          tasks: [],
          phase: "ready",
          listError: dashboardErrorMessage(error, "任务列表加载失败。")
        };
      }

      return renderDashboardPage(state);
    },

    async createTask(input: DashboardCreateTaskInput): Promise<string> {
      state = {
        ...state,
        phase: "submitting",
        createError: undefined
      };

      try {
        await createDashboardTask(input, fetchClient);
      } catch (error) {
        state = {
          ...state,
          phase: "ready",
          createError: dashboardErrorMessage(error, "任务创建失败。")
        };
        return renderDashboardPage(state);
      }

      try {
        state = {
          tasks: await listDashboardTasks(fetchClient),
          phase: "ready"
        };
      } catch (error) {
        state = {
          ...state,
          phase: "ready",
          listError: dashboardErrorMessage(error, "任务已提交，但列表刷新失败。")
        };
      }

      return renderDashboardPage(state);
    },

    render(): string {
      return renderDashboardPage(state);
    }
  };
}

export async function renderDashboardFromServer(
  fetchClient: DashboardFetch = harnessApiFetch,
  bootstrap?: HarnessBootstrap
): Promise<string> {
  const tasks = await listDashboardTasks(fetchClient);
  return renderDashboardDocument({ tasks, phase: "ready" }, bootstrap);
}

export function renderDashboardPage(state: DashboardRenderState): string {
  const phaseMarkup =
    state.phase === "loading"
      ? '<p class="dashboard-status" role="status">正在加载任务列表...</p>'
      : state.phase === "submitting"
        ? '<p class="dashboard-status" role="status">正在创建 TaskCard...</p>'
        : "";

  return [
    '<main class="dashboard" data-dashboard-page="task-list-create">',
    '<section class="dashboard__tasks" aria-labelledby="dashboard-task-list-title">',
    '<header class="dashboard__header">',
    '<span class="dashboard__eyebrow">TaskCard</span>',
    '<h1 id="dashboard-task-list-title">任务看板</h1>',
    "</header>",
    phaseMarkup,
    renderDashboardErrors(state),
    renderTaskList(state),
    "</section>",
    '<section class="dashboard__create" aria-labelledby="dashboard-create-title">',
    '<header class="dashboard__header">',
    '<span class="dashboard__eyebrow">Create</span>',
    '<h2 id="dashboard-create-title">新建任务卡</h2>',
    "</header>",
    renderCreateTaskForm(state.formValues),
    "</section>",
    "</main>"
  ].join("");
}

export function renderDashboardDocument(
  state: DashboardRenderState,
  bootstrap?: HarnessBootstrap
): string {
  const title = "SHUD Harness 任务看板";

  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${DASHBOARD_CSS}</style>`,
    "</head>",
    "<body>",
    renderDashboardPage(state),
    bootstrap ? renderHarnessBootstrapScript(bootstrap) : "",
    renderHarnessApiClientScript(),
    `<script data-dashboard-create-script>${DASHBOARD_CREATE_FORM_SCRIPT}</script>`,
    "</body>",
    "</html>"
  ].join("");
}

export function renderDashboardRoute(
  path: string,
  state: DashboardRenderState = { tasks: [], phase: "ready" },
  bootstrap?: HarnessBootstrap
): string | undefined {
  return path === DASHBOARD_ROUTE || path === DASHBOARD_ALTERNATE_ROUTE
    ? renderDashboardDocument(state, bootstrap)
    : undefined;
}

function renderDashboardErrors(state: DashboardRenderState): string {
  const messages = [
    state.listError ? ["dashboard-list-error", state.listError] : undefined,
    state.createError ? ["dashboard-create-error", state.createError] : undefined
  ].filter((entry): entry is [string, string] => Boolean(entry));

  const hidden = messages.length === 0 ? " hidden" : "";

  return `<div class="dashboard-errors" data-dashboard-errors${hidden}>${messages
    .map(
      ([id, message]) =>
        `<p class="dashboard-error" id="${id}" role="alert">${escapeHtml(message)}</p>`
    )
    .join("")}</div>`;
}

function renderTaskList(state: DashboardRenderState): string {
  const contents = renderTaskListContents(state);
  return `<div data-dashboard-task-list>${contents}</div>`;
}

function renderTaskListContents(state: DashboardRenderState): string {
  if (state.listError) {
    return '<div class="dashboard-empty" data-task-empty-state>任务列表暂不可用。</div>';
  }

  if (state.tasks.length === 0) {
    return '<div class="dashboard-empty" data-task-empty-state>当前没有 TaskCard。</div>';
  }

  return [
    '<table class="dashboard-task-table" aria-label="TaskCard 列表">',
    "<thead><tr>",
    "<th>task_id</th>",
    "<th>标题</th>",
    "<th>status</th>",
    "</tr></thead>",
    "<tbody>",
    state.tasks.map((task) => renderTaskRow(task)).join(""),
    "</tbody>",
    "</table>"
  ].join("");
}

function renderTaskRow(task: TaskCard): string {
  return [
    "<tr data-task-row>",
    `<td>${escapeHtml(task.task_id)}</td>`,
    `<td>${escapeHtml(task.title)}</td>`,
    `<td>${escapeHtml(task.status)}</td>`,
    "</tr>"
  ].join("");
}

function renderCreateTaskForm(values: Partial<DashboardFormValues> = {}): string {
  const taskType = values.type ?? "engineering";
  const budgetMode = values.budgetMode ?? "normal";
  const title = values.title ?? "";
  const questionOrGoal = values.question_or_goal ?? "";

  return [
    '<form class="dashboard-form" data-create-task-form method="post" action="/api/tasks">',
    '<label for="dashboard-task-type">任务类型</label>',
    '<select id="dashboard-task-type" name="type">',
    renderOption("engineering", "工程 engineering", taskType),
    renderOption("science_assist", "科研协助 science_assist", taskType),
    renderOption("ops", "运维 ops", taskType),
    "</select>",
    '<label for="dashboard-task-title">标题</label>',
    `<input id="dashboard-task-title" name="title" type="text" value="${escapeHtml(title)}" autocomplete="off">`,
    '<label for="dashboard-task-goal">问题 / 目标</label>',
    `<textarea id="dashboard-task-goal" name="question_or_goal" rows="5">${escapeHtml(
      questionOrGoal
    )}</textarea>`,
    '<label for="dashboard-budget-mode">预算模式</label>',
    '<select id="dashboard-budget-mode" name="budget_mode">',
    renderOption("cheap", "cheap", budgetMode),
    renderOption("normal", "normal", budgetMode),
    renderOption("deep", "deep", budgetMode),
    "</select>",
    '<button type="submit">创建 TaskCard</button>',
    "</form>"
  ].join("");
}

function renderOption(
  value: TaskType | DashboardBudgetMode,
  label: string,
  selectedValue: TaskType | DashboardBudgetMode
): string {
  const selected = value === selectedValue ? " selected" : "";
  return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
}

function parseDashboardTaskListResponse(payload: unknown, endpoint: string): TaskCard[] {
  if (!isRecord(payload) || !Array.isArray(payload.tasks)) {
    throw new DashboardTaskApiError("任务列表响应格式不符合 TaskCard 契约。", {
      endpoint
    });
  }

  try {
    return payload.tasks.map((task) => TaskCardSchema.parse(task));
  } catch {
    throw new DashboardTaskApiError("任务列表响应格式不符合 TaskCard 契约。", {
      endpoint
    });
  }
}

function parseDashboardTaskCardResponse(payload: unknown, endpoint: string): TaskCard {
  try {
    return TaskCardSchema.parse(payload);
  } catch {
    throw new DashboardTaskApiError("任务创建响应格式不符合 TaskCard 契约。", {
      endpoint
    });
  }
}

async function readJsonResponse(response: Response, endpoint: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new DashboardTaskApiError("API 响应不是有效 JSON。", {
      endpoint,
      status: response.status
    });
  }
}

function dashboardErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof DashboardTaskApiError) {
    return `${fallback} ${error.message}`;
  }

  if (error instanceof Error && error.message.length > 0) {
    return `${fallback} ${error.message}`;
  }

  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


export { DASHBOARD_CREATE_FORM_SCRIPT } from "./DashboardClientScript";
export { DASHBOARD_CSS } from "./DashboardCss";

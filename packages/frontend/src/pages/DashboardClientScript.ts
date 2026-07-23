export const DASHBOARD_CREATE_FORM_SCRIPT = `
(() => {
  const endpoint = "/api/tasks";
  const apiFetch = window.__HARNESS_API_FETCH__;
  const form = document.querySelector("[data-create-task-form]");
  const listRegion = document.querySelector("[data-dashboard-task-list]");
  const errorRegion = document.querySelector("[data-dashboard-errors]");
  if (!form || !listRegion || !errorRegion || typeof apiFetch !== "function") {
    return;
  }

  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const setErrors = (messages) => {
    errorRegion.innerHTML = messages
      .map(
        (message, index) =>
          '<p class="dashboard-error" id="dashboard-client-error-' +
          index +
          '" role="alert">' +
          escapeHtml(message) +
          "</p>"
      )
      .join("");
    errorRegion.hidden = messages.length === 0;
  };

  const renderTaskRows = (tasks) =>
    tasks
      .map(
        (task) =>
          "<tr data-" +
          "task-row><td>" +
          escapeHtml(task.task_id) +
          "</td><td>" +
          escapeHtml(task.title) +
          "</td><td>" +
          escapeHtml(task.status) +
          "</td></tr>"
      )
      .join("");

  const renderTasks = (tasks) => {
    if (tasks.length === 0) {
      listRegion.innerHTML =
        '<div class="dashboard-empty" data-task-empty-state>当前没有 TaskCard。</div>';
      return;
    }

    listRegion.innerHTML =
      '<table class="dashboard-task-table" aria-label="TaskCard 列表"><thead><tr><th>task_id</th><th>标题</th><th>status</th></tr></thead><tbody>' +
      renderTaskRows(tasks) +
      "</tbody></table>";
  };

  const errorMessage = (error, fallback) =>
    fallback + " " + (error instanceof Error && error.message ? error.message : "API 请求失败。");

  const allowedTaskStatuses = new Set([
    "created",
    "planned",
    "running",
    "parked",
    "reporting",
    "awaiting_pi",
    "done",
    "cancelled",
    "blocked"
  ]);

  const isTaskCardLike = (task) =>
    task &&
    typeof task === "object" &&
    typeof task.task_id === "string" &&
    task.task_id.length > 0 &&
    typeof task.title === "string" &&
    task.title.length > 0 &&
    typeof task.status === "string" &&
    allowedTaskStatuses.has(task.status);

  const assertTaskCard = (task, message) => {
    if (!isTaskCardLike(task)) {
      throw new Error(message);
    }
    return task;
  };

  const assertTaskList = (payload) => {
    if (!payload || !Array.isArray(payload.tasks)) {
      throw new Error("任务列表响应格式不符合 TaskCard 契约。");
    }
    return payload.tasks.map((task) =>
      assertTaskCard(task, "任务列表响应格式不符合 TaskCard 契约。")
    );
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setErrors([]);

    const data = new FormData(form);
    const payload = {
      type: String(data.get("type") ?? ""),
      title: String(data.get("title") ?? ""),
      question_or_goal: String(data.get("question_or_goal") ?? ""),
      inference_budget: {
        mode: String(data.get("budget_mode") ?? "normal")
      }
    };

    try {
      const createResponse = await apiFetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      if (!createResponse.ok) {
        throw new Error("任务创建请求失败（HTTP " + createResponse.status + "）。");
      }
      assertTaskCard(await createResponse.json(), "任务创建响应格式不符合 TaskCard 契约。");
    } catch (error) {
      setErrors([errorMessage(error, "任务创建失败。")]);
      return;
    }

    try {
      const listResponse = await apiFetch(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json"
        }
      });
      if (!listResponse.ok) {
        throw new Error("任务列表请求失败（HTTP " + listResponse.status + "）。");
      }
      const listPayload = await listResponse.json();
      renderTasks(assertTaskList(listPayload));
      form.reset();
    } catch (error) {
      setErrors([errorMessage(error, "任务已提交，但列表刷新失败。")]);
    }
  });
})();
`;

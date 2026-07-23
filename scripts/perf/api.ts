import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createBackendApi } from "../../packages/backend/src/index";
import type { CreateTaskInput, TaskCard } from "../../packages/core/src/index";

const TASK_COUNT = 100;
const WARMUP_REQUESTS_PER_ENDPOINT = 5;
const SAMPLE_REQUESTS_PER_ENDPOINT = 40;
const P95_LIMIT_MS = 300;
const PERF_LOCAL_TOKEN = "perf-api-local-token";

type EndpointMeasurement = {
  label: string;
  path: string;
  expectedStatus: number;
  p95Ms: number;
};

type TaskListResponse = {
  tasks: TaskCard[];
};

async function main(): Promise<void> {
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "shud-harness-perf-api-")));
  try {
    const workspaceRoot = join(tempRoot, "workspace");
    const previousToken = process.env.HARNESS_LOCAL_TOKEN;
    process.env.HARNESS_LOCAL_TOKEN = PERF_LOCAL_TOKEN;
    let app: ReturnType<typeof createBackendApi>;
    try {
      app = createBackendApi({
        workspaceRoot,
        requestLogSink: () => undefined,
        taskIdFactory: sequentialTaskIdFactory()
      });
    } finally {
      if (previousToken === undefined) delete process.env.HARNESS_LOCAL_TOKEN;
      else process.env.HARNESS_LOCAL_TOKEN = previousToken;
    }

    await expectStatus(
      requestWithAuth(app, "/api/workspace/init", { method: "POST" }),
      200,
      "POST /api/workspace/init"
    );
    const tasks = await createTaskFixture(app);
    const targetTask = tasks[0];
    if (!targetTask) {
      throw new Error("PERF-API-001 fixture did not create a target task.");
    }
    await expectTaskListCount(app, TASK_COUNT);

    const measurements: EndpointMeasurement[] = [
      await measureEndpoint(app, "GET /api/tasks", "/api/tasks", 200),
      await measureEndpoint(app, "GET /api/tasks/:id", `/api/tasks/${targetTask.task_id}`, 200),
      await measureEndpoint(app, "GET /api/health/ready", "/api/health/ready", 200)
    ];

    printMeasurements(measurements);
    const failures = measurements.filter((measurement) => measurement.p95Ms > P95_LIMIT_MS);
    if (failures.length > 0) {
      const summary = failures
        .map(
          (measurement) =>
            `${measurement.label} P95 ${formatMs(measurement.p95Ms)} > ${P95_LIMIT_MS}ms`
        )
        .join("; ");
      throw new Error(`PERF-API-001 failed: ${summary}`);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function createTaskFixture(app: ReturnType<typeof createBackendApi>): Promise<TaskCard[]> {
  const tasks: TaskCard[] = [];
  for (let index = 0; index < TASK_COUNT; index += 1) {
    const response = await requestWithAuth(app, "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(taskCreateInput(index))
    });
    if (response.status !== 201) {
      throw new Error(
        `PERF-API-001 fixture failed to create task ${index + 1}: HTTP ${response.status}`
      );
    }
    tasks.push((await response.json()) as TaskCard);
  }

  if (tasks.length !== TASK_COUNT) {
    throw new Error(`PERF-API-001 fixture created ${tasks.length} tasks, expected ${TASK_COUNT}.`);
  }

  return tasks;
}

async function expectTaskListCount(
  app: ReturnType<typeof createBackendApi>,
  expectedCount: number
): Promise<void> {
  const response = await expectStatus(
    requestWithAuth(app, "/api/tasks"),
    200,
    "GET /api/tasks",
    false
  );
  const body = (await response.json()) as TaskListResponse;
  if (!Array.isArray(body.tasks) || body.tasks.length !== expectedCount) {
    const actualCount = Array.isArray(body.tasks) ? body.tasks.length : "non-array";
    throw new Error(
      `PERF-API-001 fixture listed ${actualCount} tasks, expected ${expectedCount}.`
    );
  }
}

async function measureEndpoint(
  app: ReturnType<typeof createBackendApi>,
  label: string,
  path: string,
  expectedStatus: number
): Promise<EndpointMeasurement> {
  for (let index = 0; index < WARMUP_REQUESTS_PER_ENDPOINT; index += 1) {
    await expectStatus(requestWithAuth(app, path), expectedStatus, label);
  }

  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_REQUESTS_PER_ENDPOINT; index += 1) {
    const startedAtMs = performance.now();
    await expectStatus(requestWithAuth(app, path), expectedStatus, label);
    samples.push(performance.now() - startedAtMs);
  }

  return {
    label,
    path,
    expectedStatus,
    p95Ms: percentile(samples, 95)
  };
}

async function expectStatus(
  responsePromise: Response | Promise<Response>,
  expectedStatus: number,
  label: string,
  consumeBody = true
): Promise<Response> {
  const response = await responsePromise;
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned HTTP ${response.status}, expected ${expectedStatus}.`);
  }
  if (consumeBody) {
    await response.arrayBuffer();
  }
  return response;
}

function percentile(samples: readonly number[], percentileValue: number): number {
  if (samples.length === 0) {
    throw new Error("Cannot compute percentile for an empty sample set.");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] as number;
}

function printMeasurements(measurements: readonly EndpointMeasurement[]): void {
  console.log(`PERF-API-001 fixture: ${TASK_COUNT} tasks`);
  for (const measurement of measurements) {
    console.log(
      `${measurement.label} P95=${formatMs(measurement.p95Ms)} limit=${P95_LIMIT_MS}ms status=${measurement.expectedStatus}`
    );
  }
}

function formatMs(value: number): string {
  return `${value.toFixed(2)}ms`;
}

function sequentialTaskIdFactory(): () => string {
  let nextId = 1;
  return () => `TASK-perf-${String(nextId++).padStart(3, "0")}`;
}

function requestWithAuth(
  app: ReturnType<typeof createBackendApi>,
  path: string,
  init?: RequestInit
): Response | Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${PERF_LOCAL_TOKEN}`);
  return app.request(path, { ...init, headers });
}

function taskCreateInput(index: number): CreateTaskInput {
  const sequence = String(index + 1).padStart(3, "0");
  return {
    type: "engineering",
    title: `PERF-API-001 fixture task ${sequence}`,
    question_or_goal: `Exercise metadata API latency for fixture task ${sequence}.`,
    inference_budget: { mode: "normal" },
    created_by: "pi"
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

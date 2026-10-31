import * as fs from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { TaskCardSchema, TaskIdSchema } from "@shud-harness/dsh-shud-core";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { expect, test } from "vitest";
import { expectToolError, treeOrAbsent } from "./task-linked/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";

const args = {
  type: "science_assist",
  title: "ccw 30 天运行",
  question_or_goal: "跑通 ccw 并生成证据报告",
};

function createTask(runtime: ToolRuntime, agent: Agent) {
  return runtime.execute({
    callId: "task-create-raw-guard-tracer" as ToolCallId,
    name: "task_create",
    arguments: args,
    agent,
    signal: new AbortController().signal,
  });
}

async function admission(ctx: Context) {
  const approvals: Array<Parameters<ApprovalService["request"]>[0]> = [];
  let executions = 0;
  await ctx.plugin((services: Context) => {
    services.provide("approval", {
      request(request: Parameters<ApprovalService["request"]>[0]) {
        approvals.push(request);
        return Promise.resolve("allowed-once" as const);
      },
    });
    services.on("tools/execute", (_event, next) => {
      executions++;
      return next();
    });
  });
  return {
    approvals,
    get executions() {
      return executions;
    },
  };
}

test.each([
  { label: "absent relative tasks root", raw: "tasks", exists: false },
  { label: "existing relative tasks root", raw: "tasks", exists: true },
  { label: "protected workspace ancestor", raw: ".", exists: false },
])("task_create denies $label before execute, approval or writes", async ({ raw, exists }) => {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  try {
    const tasks = join(h.cwd, "tasks");
    if (exists) {
      fs.mkdirSync(tasks);
      fs.writeFileSync(join(tasks, "original.txt"), "protected original task data\n");
    }
    fs.writeFileSync(join(h.cwd, "original.txt"), "original workspace data\n");
    expect(fs.existsSync(tasks)).toBe(exists);
    await h.apply(rawGuard, { rawDirs: [raw] });
    const seen = await admission(h.ctx);
    const before = await treeOrAbsent(h.cwd);

    expectToolError(await createTask(h.runtime, h.agent), /immutable/iu);
    expect(seen.executions).toBe(0);
    expect(seen.approvals).toEqual([]);
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  } finally {
    await h.dispose();
  }
});

test("task_create with disjoint data/raw publishes a planned card without changing raw", async () => {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  try {
    const raw = join(h.cwd, "data", "raw");
    fs.mkdirSync(raw, { recursive: true });
    fs.writeFileSync(join(raw, "original.txt"), "protected original observations\n");
    await h.apply(rawGuard, { rawDirs: ["data/raw"] });
    const seen = await admission(h.ctx);
    const rawBefore = await treeOrAbsent(raw);

    const result = await createTask(h.runtime, h.agent);
    expect(result.isError, JSON.stringify(result)).toBe(false);
    if (result.isError) throw new Error(result.error.message);
    expect(seen.executions).toBe(1);
    expect(seen.approvals).toEqual([]);
    const tasks = join(h.cwd, "tasks");
    const entries = fs.readdirSync(tasks);
    expect(entries).toHaveLength(1);
    const taskId = TaskIdSchema.parse(entries[0]);
    const directory = join(tasks, taskId);
    expect(fs.readdirSync(directory)).toEqual(["task.json"]);
    const card = TaskCardSchema.parse(
      JSON.parse(fs.readFileSync(join(directory, "task.json"), "utf8")),
    );
    expect(result.value).toEqual({ task_id: taskId, status: "planned" });
    const { created_at, updated_at, ...fields } = card;
    expect(fields).toEqual({
      ...args,
      task_id: taskId,
      status: "planned",
      runtime_phase: null,
      created_by: "unknown",
      current_owner: "unknown",
      reviewer: "pi",
      inference_budget: { mode: "normal" },
      stack_id: null,
      data_id: null,
      linked_jobs: [],
      linked_reports: [],
    });
    expect(updated_at).toBe(created_at);
    expect(await treeOrAbsent(raw)).toEqual(rawBefore);
  } finally {
    await h.dispose();
  }
});

import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import {
  ChangeIdSchema,
  ChangeRequestSchema,
  TaskCardSchema,
  TaskIdSchema,
  type TaskId,
} from "@shud-harness/dsh-shud-core";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { expectToolError, treeOrAbsent } from "./task-linked/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

let h: {
  ctx: Context;
  cwd: string;
  agent: Agent;
  runtime: ToolRuntime;
  apply(plugin: Plugin, config: unknown): Promise<unknown>;
  dispose(): Promise<void>;
};
let source: string;
let head: string;
let taskId: TaskId;
const modified = "all:\n\t@echo candidate\n";
const description = "Capture the tracked Makefile change";

function git(...argv: string[]) {
  return childProcess.execFileSync("git", ["-C", source, ...argv], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LC_ALL: "C",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function invoke(name: string, args: unknown) {
  return h.runtime.execute({
    callId: "change-create-runtime-tracer" as ToolCallId,
    name,
    arguments: args,
    agent: h.agent,
    signal: new AbortController().signal,
  });
}

function readCard() {
  return TaskCardSchema.parse(
    JSON.parse(fs.readFileSync(join(h.cwd, "tasks", taskId, "task.json"), "utf8")),
  );
}

async function admission() {
  const approvals: Array<Parameters<ApprovalService["request"]>[0]> = [];
  let executions = 0;
  await h.ctx.plugin((services: Context) => {
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

beforeEach(async () => {
  h = await createToolHarness({ pumpPollMs: 60_000 });
  source = join(h.cwd, "repos", "SHUD");
  fs.mkdirSync(source, { recursive: true });
  git("init", "-q", "--object-format=sha1");
  fs.writeFileSync(join(source, "Makefile"), "all:\n\t@echo base\n");
  git("add", "Makefile");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "base",
  );
  head = git("rev-parse", "HEAD").toString("utf8").replace(/\n$/u, "");
  expect(head).toMatch(/^[0-9a-f]{40}$/u);
  const created = await invoke("task_create", {
    type: "code_change",
    title: "Controlled tracked source change",
    question_or_goal: "Capture a proposed patch against the pinned checkout",
  });
  expect(created.isError, JSON.stringify(created)).toBe(false);
  if (created.isError) throw new Error(created.error.message);
  taskId = TaskIdSchema.parse(fs.readdirSync(join(h.cwd, "tasks"))[0]);
  expect(created.value).toEqual({ task_id: taskId, status: "planned" });
  expect(readCard()).toMatchObject({ source_base_commit: head, status: "planned" });
  fs.writeFileSync(join(source, "Makefile"), modified);
});

afterEach(async () => {
  await h.dispose();
});

test("change_create publishes the pinned proposed patch, raises its floor and links the running card", async () => {
  await h.apply(rawGuard, { rawDirs: ["data/raw"] });
  const seen = await admission();
  const index = join(source, ".git", "index");
  const indexBytes = fs.readFileSync(index);
  const indexMtime = fs.statSync(index, { bigint: true }).mtimeNs;
  const expectedPatch = git(
    "diff",
    "HEAD",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--",
    "Makefile",
  );
  const expectedSha = createHash("sha256").update(expectedPatch).digest("hex");

  const result = await invoke("change_create", {
    task_id: taskId,
    semantic_level: "pure_engineering",
    description,
  });

  expect(result.isError, JSON.stringify(result)).toBe(false);
  if (result.isError) throw new Error(result.error.message);
  if (typeof result.value !== "object" || result.value === null || Array.isArray(result.value)) {
    throw new Error("change_create must return an object");
  }
  const changeId = ChangeIdSchema.parse(result.value.change_id);
  expect(result.value).toMatchObject({
    change_id: changeId,
    semantic_level: "numerical_implementation",
    semantic_floor: "numerical_implementation",
    floor_categories: ["numerical_implementation"],
    risk: "high",
    files_changed: ["Makefile"],
    patch_path: `patches/${changeId}.patch`,
    status: "proposed",
  });
  // The result must explain the raised declaration, without prescribing its presentation field.
  expect(JSON.stringify(result.value)).toContain("pure_engineering");
  const record = ChangeRequestSchema.parse(
    JSON.parse(fs.readFileSync(join(h.cwd, "changes", `${changeId}.json`), "utf8")),
  );
  expect(record).toMatchObject({
    change_id: changeId,
    task_id: taskId,
    source_path: "repos/SHUD",
    base_commit: head,
    files_changed: ["Makefile"],
    semantic_level: "numerical_implementation",
    semantic_floor: "numerical_implementation",
    floor_categories: ["numerical_implementation"],
    risk: "high",
    patch_path: `patches/${changeId}.patch`,
    patch_sha256: expectedSha,
    status: "proposed",
    approval_ref: null,
    approved_at: null,
    description,
  });
  expect(fs.readFileSync(join(h.cwd, record.patch_path))).toEqual(expectedPatch);
  expect(fs.readdirSync(join(h.cwd, "changes"))).toEqual([`${changeId}.json`]);
  expect(fs.readdirSync(join(h.cwd, "patches"))).toEqual([`${changeId}.patch`]);
  expect(readCard()).toMatchObject({
    task_id: taskId,
    type: "code_change",
    status: "running",
    runtime_phase: "running_local",
    source_base_commit: head,
    linked_changes: [changeId],
    linked_jobs: [],
    linked_reports: [],
    linked_verifications: [],
  });
  expect(seen.executions).toBe(1);
  expect(seen.approvals).toEqual([]);
  expect(fs.readFileSync(join(source, "Makefile"), "utf8")).toBe(modified);
  expect(fs.readFileSync(index)).toEqual(indexBytes);
  expect(fs.statSync(index, { bigint: true }).mtimeNs).toBe(indexMtime);
  expect(git("rev-parse", "HEAD").toString("utf8").replace(/\n$/u, "")).toBe(head);
});

test.each(["patches", "repos/SHUD"])(
  "change_create denies protected %s before execution, approval or Git",
  async (raw) => {
    await h.apply(rawGuard, { rawDirs: [raw] });
    const seen = await admission();
    const before = await treeOrAbsent(h.cwd);
    vi.mocked(childProcess.execFile).mockClear();

    const result = await invoke("change_create", {
      task_id: taskId,
      semantic_level: "pure_engineering",
      description,
    });

    expectToolError(result, /immutable/iu);
    expect(seen.executions).toBe(0);
    expect(seen.approvals).toEqual([]);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(await treeOrAbsent(h.cwd)).toEqual(before);
  },
);

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolExecutionResult, ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ApprovalService } from "@deepseek-ai/dsh-user-approval";
import { TaskCardSchema, TaskIdSchema, type TaskId } from "@shud-harness/dsh-shud-core";
import { expect } from "vitest";
import { createToolHarness } from "../test-harness.ts";

export const PRIVATE = "PRIVATE_CHANGE_FIXTURE_536";
export const taskArgs = {
  type: "code_change",
  title: "Tracked source change",
  question_or_goal: "Capture pinned evidence",
};
export interface ChangeHarness {
  ctx: Context;
  agent: Agent;
  runtime: ToolRuntime;
  root: string;
  cwd: string;
  source: string;
  apply(plugin: Plugin, config: unknown): Promise<unknown>;
  dispose(): Promise<void>;
  invoke(name: string, args: unknown): Promise<ToolExecutionResult>;
}

export async function changeHarness(): Promise<ChangeHarness> {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  return {
    ...h,
    source: join(h.cwd, "repos", "SHUD"),
    invoke(name, args) {
      return h.runtime.execute({
        callId: "change-create-matrix" as ToolCallId,
        name,
        arguments: args,
        agent: h.agent,
        signal: new AbortController().signal,
      });
    },
  };
}

export function git(source: string, ...argv: string[]) {
  return execFileSync("git", ["-C", source, ...argv], {
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

export function seedSource(h: ChangeHarness, paths = ["Makefile"], format = "sha1") {
  fs.mkdirSync(h.source, { recursive: true });
  git(h.source, "init", "-q", "--template=", `--object-format=${format}`);
  for (const path of paths) {
    fs.mkdirSync(dirname(join(h.source, path)), { recursive: true });
    fs.writeFileSync(join(h.source, path), "base\n");
  }
  git(h.source, "add", "--all");
  git(
    h.source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "base",
  );
  return git(h.source, "rev-parse", "HEAD").toString("utf8").replace(/\n$/u, "");
}

export function valueOf(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result)).toBe(false);
  if (result.isError) throw new Error(result.error.message);
  if (typeof result.value !== "object" || result.value === null || Array.isArray(result.value)) {
    throw new Error("Expected an object tool result");
  }
  return result.value;
}

export async function seedTask(h: ChangeHarness): Promise<TaskId> {
  const result = valueOf(await h.invoke("task_create", taskArgs));
  return TaskIdSchema.parse(result.task_id);
}

export function taskPath(h: ChangeHarness, id: TaskId) {
  return join(fs.realpathSync.native(h.cwd), "tasks", id, "task.json");
}

export function readCard(h: ChangeHarness, id: TaskId) {
  return TaskCardSchema.parse(JSON.parse(fs.readFileSync(taskPath(h, id), "utf8")));
}

export function fileSnapshot(path: string) {
  return { bytes: fs.readFileSync(path), mtime: fs.statSync(path, { bigint: true }).mtimeNs };
}

export function sourceSnapshot(h: ChangeHarness, paths = ["Makefile"]) {
  return {
    files: paths.map((path) => fileSnapshot(join(h.source, path))),
    index: fileSnapshot(join(h.source, ".git", "index")),
    headFile: fileSnapshot(join(h.source, ".git", "HEAD")),
    head: git(h.source, "rev-parse", "HEAD").toString("utf8"),
  };
}

export function noChangeObjects(h: ChangeHarness) {
  for (const name of ["changes", "patches"]) {
    const path = join(h.cwd, name);
    if (fs.existsSync(path) && fs.lstatSync(path).isDirectory())
      expect(fs.readdirSync(path)).toEqual([]);
  }
}

/** Only ctx is used; the full harness member keeps contextual typing for inline literals. */
export async function admission(h: ChangeHarness | Pick<ChangeHarness, "ctx">) {
  const approvals: Array<Parameters<ApprovalService["request"]>[0]> = [];
  let executions = 0;
  let preExecutions = 0;
  await h.ctx.plugin((services: Context) => {
    services.provide("approval", {
      request(request: Parameters<ApprovalService["request"]>[0]) {
        approvals.push(request);
        return Promise.resolve("allowed-once" as const);
      },
    });
    services.on("tools/pre-execute", (_event, next) => {
      preExecutions++;
      return next();
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
    get preExecutions() {
      return preExecutions;
    },
  };
}

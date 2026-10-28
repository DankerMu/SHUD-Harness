import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import type * as NodeCrypto from "node:crypto";
import type * as NodeFs from "node:fs";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { ShudJobRegistry } from "@shud-harness/dsh-shud-jobs";
import { TaskCardSchema } from "@shud-harness/dsh-shud-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createToolHarness } from "./test-harness.ts";

const entropy = vi.hoisted(() => ({ suffixes: [] as string[] }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof NodeCrypto>();
  return {
    ...actual,
    randomBytes(size: number, callback?: (error: Error | null, bytes: Buffer) => void) {
      if (callback) return actual.randomBytes(size, callback);
      const suffix = size === 2 ? entropy.suffixes.shift() : undefined;
      return suffix === undefined ? actual.randomBytes(size) : Buffer.from(suffix, "hex");
    },
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    openSync: vi.fn(actual.openSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const args = {
  type: "science_assist",
  title: "ccw 30 天运行",
  question_or_goal: "跑通 ccw 并生成证据报告",
};
const firstId = "TASK-20261027T080005-3f9c";
const secondId = "TASK-20261027T080005-abcd";
let h: {
  runtime: ToolRuntime;
  agent: Agent;
  registry: ShudJobRegistry;
  root: string;
  cwd: string;
  dispose(): Promise<void>;
};
const call = (input: unknown = args, agent: typeof h.agent | null = h.agent) =>
  h.runtime.execute({
    callId: "task-create-consumer-tracer" as ToolCallId,
    name: "task_create",
    arguments: input,
    ...(agent === null ? {} : { agent }),
    signal: new AbortController().signal,
  });

beforeEach(async () => {
  vi.clearAllMocks();
  entropy.suffixes = [];
  h = await createToolHarness({ pumpPollMs: 60_000 });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T08:00:05.987Z"));
  entropy.suffixes = ["3f9c"];
  Object.assign(h.agent.session.header, { agentPreset: "coordinator" });
});
afterEach(async () => {
  vi.useRealTimers();
  await h.dispose();
});

async function expectError(
  input: unknown,
  message: RegExp,
  agent: typeof h.agent | null = h.agent,
) {
  const result = await call(input, agent);
  expect(result.isError).toBe(true);
  if (!result.isError) throw new Error("Invalid task creation succeeded");
  expect(result.error.message).toMatch(message);
  expect(result.error.message).not.toContain("UNKNOWN_TOOL");
}

function clearFileCalls() {
  vi.mocked(fs.lstatSync).mockClear();
  vi.mocked(fs.mkdirSync).mockClear();
  vi.mocked(fs.openSync).mockClear();
}
function expectNoFileCalls() {
  expect(fs.lstatSync).not.toHaveBeenCalled();
  expect(fs.mkdirSync).not.toHaveBeenCalled();
  expect(fs.openSync).not.toHaveBeenCalled();
}

async function readCard(id = firstId) {
  return TaskCardSchema.parse(
    JSON.parse(await io.readFile(join(h.cwd, "tasks", id, "task.json"), "utf8")),
  );
}

test("task_create publishes the exact planned card through the closed ToolRuntime contract", async () => {
  const schema = h.runtime.schemas(h.agent).find((tool) => tool.name === "task_create");
  expect(schema?.parameters).toMatchObject({ type: "object", additionalProperties: false });
  expect(Object.keys(schema?.parameters?.properties ?? {}).sort()).toEqual([
    "question_or_goal",
    "title",
    "type",
  ]);
  const result = await call();
  expect(result).toMatchObject({ isError: false, value: { task_id: firstId, status: "planned" } });
  expect(await readCard()).toEqual({
    ...args,
    task_id: firstId,
    status: "planned",
    runtime_phase: null,
    created_by: "coordinator",
    current_owner: "coordinator",
    reviewer: "pi",
    inference_budget: { mode: "normal" },
    stack_id: null,
    data_id: null,
    linked_jobs: [],
    linked_reports: [],
    created_at: "2026-10-27T08:00:05.987Z",
    updated_at: "2026-10-27T08:00:05.987Z",
  });
  expect(await io.readdir(join(h.cwd, "tasks", firstId))).toEqual(["task.json"]);
  expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
});

const invalid = [
  ...[null, [], "task", 7, false].map((input) => ({ input, message: /object/iu })),
  ...["type", "title", "question_or_goal"].flatMap((field) =>
    [undefined, "", null, 7, [], {}].map((value) => {
      const input = { ...args, [field]: value };
      if (value === undefined) Reflect.deleteProperty(input, field);
      return { input, message: new RegExp(field, "iu") };
    }),
  ),
  ...["engineering", "ops"].map((type) => ({ input: { ...args, type }, message: /type/iu })),
  ...["status", "cwd", "toString"].map((key) => ({
    input: { ...args, [key]: "unexpected" },
    message: /unknown parameter/iu,
  })),
];
test.each(invalid)("task_create rejects $input before file IO", async ({ input, message }) => {
  clearFileCalls();
  await expectError(input, message);
  expectNoFileCalls();
  await expect(io.readdir(join(h.cwd, "tasks"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["agent", "session", "header", "cwd", "empty cwd"])(
  "missing %s rejects without a launch-directory fallback",
  async (missing) => {
    const session = h.agent.session;
    const header = session.header;
    try {
      if (missing === "session") Reflect.deleteProperty(h.agent, "session");
      if (missing === "header") Reflect.deleteProperty(session, "header");
      if (missing === "cwd") Reflect.deleteProperty(header, "cwd");
      if (missing === "empty cwd") Object.assign(header, { cwd: "" });
      clearFileCalls();
      await expectError(args, /workspace|session.*cwd/iu, missing === "agent" ? null : h.agent);
      expectNoFileCalls();
    } finally {
      Object.assign(h.agent, { session });
      Object.assign(session, { header });
      Object.assign(header, { cwd: h.cwd });
    }
  },
);

test.each([undefined, "", null, 7, " custom-preset "])(
  "preset %s preserves the original nonempty identity or uses unknown",
  async (preset) => {
    Object.assign(h.agent.session.header, { agentPreset: preset });
    expect(await call()).toMatchObject({ isError: false });
    const expected = preset === " custom-preset " ? preset : "unknown";
    expect(await readCard()).toMatchObject({ created_by: expected, current_owner: expected });
  },
);

test.each(
  ["tasks", "allocated", "target"].flatMap((level) =>
    ["symlink", level === "target" ? "directory" : "file", "fifo"].map((kind) => ({ level, kind })),
  ),
)("$level $kind fails closed without changing foreign bytes", async ({ level, kind }) => {
  const outside = join(h.root, "outside");
  await io.mkdir(outside);
  const sentinel = join(outside, "sentinel");
  await io.writeFile(sentinel, "foreign bytes");
  const tasks = join(h.cwd, "tasks");
  const allocated = join(tasks, firstId);
  if (level !== "tasks") await io.mkdir(tasks);
  if (level === "target") await io.mkdir(allocated);
  const path =
    level === "tasks" ? tasks : level === "allocated" ? allocated : join(allocated, "task.json");
  if (kind === "symlink") await io.symlink(level === "target" ? sentinel : outside, path);
  if (kind === "file") await io.writeFile(path, "original file");
  if (kind === "fifo") execFileSync("mkfifo", [path]);
  if (kind === "directory") await io.mkdir(path);
  const before = await io.lstat(path, { bigint: true });
  await expectError(args, new RegExp(level === "target" ? "task\\.json" : "tasks", "u"));
  expect(await io.readFile(sentinel, "utf8")).toBe("foreign bytes");
  expect(await io.readdir(outside)).toEqual(["sentinel"]);
  expect((await io.lstat(path, { bigint: true })).ino).toBe(before.ino);
  if (kind === "file") expect(await io.readFile(path, "utf8")).toBe("original file");
  if (kind === "symlink")
    expect(await io.readlink(path)).toBe(level === "target" ? sentinel : outside);
});

test("colliding cards retain their bytes while simultaneous requests allocate distinct cards", async () => {
  const directory = join(h.cwd, "tasks", firstId);
  await io.mkdir(directory, { recursive: true });
  const path = join(directory, "task.json");
  await io.writeFile(path, "original card bytes\n");
  const before = await io.stat(path, { bigint: true });
  entropy.suffixes = ["3f9c", "abcd", "abcd", "1234"];
  const results = await Promise.all([call(), call()]);
  expect(results).toMatchObject([
    { isError: false, value: { task_id: secondId, status: "planned" } },
    { isError: false, value: { task_id: "TASK-20261027T080005-1234", status: "planned" } },
  ]);
  expect(await io.readFile(path, "utf8")).toBe("original card bytes\n");
  expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  expect(await io.readdir(join(h.cwd, "tasks"))).toEqual([
    "TASK-20261027T080005-1234",
    firstId,
    secondId,
  ]);
  for (const id of [secondId, "TASK-20261027T080005-1234"]) {
    expect((await readCard(id)).task_id).toBe(id);
    expect(await io.readdir(join(h.cwd, "tasks", id))).toEqual(["task.json"]);
  }
});

test("failed atomic publication reports the IO error and removes its temporary file", async () => {
  vi.mocked(fs.renameSync).mockImplementationOnce(() => {
    throw Object.assign(new Error("task publication EIO"), { code: "EIO" });
  });
  await expectError(args, /EIO/u);
  expect(await io.readdir(join(h.cwd, "tasks", firstId))).toEqual([]);
});

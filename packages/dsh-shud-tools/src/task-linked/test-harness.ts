import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { expect } from "vitest";
import {
  RunJobSchema,
  TaskCardSchema,
  TaskIdSchema,
  type RunJob,
  type TaskCard,
} from "@shud-harness/dsh-shud-core";
import { produceDetachedShud, type ShudJobRegistry } from "@shud-harness/dsh-shud-jobs";
import { writeWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { makeTaskCard } from "../../../dsh-shud-records/src/task-lifecycle-test-harness.ts";
import { readInvocation } from "../../../dsh-shud-jobs/src/detached-shud/test-harness.ts";
import { snapshotQueryTree } from "../../../dsh-shud-jobs/src/list-run-jobs/test-harness.ts";

export const TASK = TaskIdSchema.parse("TASK-20261027T080005-3f9c");
export const OTHER_TASK = TaskIdSchema.parse("TASK-20261027T080005-abcd");
export const PRIVATE_FAULT = "PRIVATE_TASK_WRITE_FAILURE_445";
export interface TaskToolHarness {
  cwd: string;
  stateDir: string;
  inputDir: string;
  ownerId: SessionId;
  registry: ShudJobRegistry;
}
export type CallResult = ToolExecutionResult;

export function plannedCard(overrides: Partial<TaskCard> = {}) {
  return makeTaskCard({
    task_id: TASK,
    status: "planned",
    runtime_phase: null,
    stack_id: null,
    data_id: null,
    linked_jobs: [],
    ...overrides,
  });
}

export function cardPath(h: Pick<TaskToolHarness, "cwd">, id = TASK) {
  return join(h.cwd, "tasks", id, "task.json");
}

export function putCard(h: Pick<TaskToolHarness, "cwd">, card = plannedCard()) {
  writeWorkspaceRecord(h.cwd, "task", card);
  return card;
}

export function getCard(h: Pick<TaskToolHarness, "cwd">) {
  return TaskCardSchema.parse(JSON.parse(fs.readFileSync(cardPath(h), "utf8")));
}

export async function cardSnapshot(h: Pick<TaskToolHarness, "cwd">) {
  return {
    bytes: await io.readFile(cardPath(h)),
    mtime: (await io.stat(cardPath(h), { bigint: true })).mtimeNs,
  };
}

export async function treeOrAbsent(path: string) {
  try {
    return await snapshotQueryTree(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function submissionSnapshot(h: TaskToolHarness) {
  return {
    indexes: h.registry.indexes.read(),
    runs: await treeOrAbsent(join(h.cwd, "runs")),
    stacks: await treeOrAbsent(join(h.cwd, "stacks")),
    provenance: await treeOrAbsent(join(h.cwd, "provenance")),
  };
}

export function expectToolError(result: CallResult, message: RegExp) {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  if (!result.isError) throw new Error("Expected a controlled tool error");
  expect(result.error.message).toMatch(message);
  expect(result.error.message).not.toMatch(/UNKNOWN_TOOL|Unknown parameter: task_id/iu);
  return result.error.message;
}

export async function returnedRun(h: TaskToolHarness, result: CallResult): Promise<RunJob> {
  expect(result.isError, JSON.stringify(result)).toBe(false);
  if (result.isError) throw new Error(result.error.message);
  const records = await Promise.all(
    h.registry.indexes
      .read()
      .active.map(async (entry) =>
        RunJobSchema.parse(
          JSON.parse(await io.readFile(join(entry.run_dir, "run-job.json"), "utf8")),
        ),
      ),
  );
  const record = records.find((candidate) =>
    typeof result.value === "object" && result.value !== null && !Array.isArray(result.value)
      ? candidate.run_id === result.value.run_id
      : false,
  );
  if (!record) throw new Error("Tool result has no actual active RunJob");
  expect(result.value).toEqual({
    status: "running",
    job_id: record.job_id,
    run_id: record.run_id,
    dsh_job_id: record.dsh_job_id,
    run_dir: record.run_dir,
  });
  return record;
}

export async function seedLiveRun(h: TaskToolHarness) {
  const record = await h.registry.submitShud(
    {
      cwd: h.cwd,
      input_dir: h.inputDir,
      project: "tiny",
      owner_session: h.ownerId,
      llm: { response_model: "configured-test-model", response_model_source: "configured" },
      task_id: TASK,
    },
    produceDetachedShud,
  );
  await expect.poll(() => readInvocation(record.run_dir)).not.toBeNull();
  return record;
}

export async function expectLiveDurable(h: TaskToolHarness, record: RunJob) {
  expect(
    RunJobSchema.parse(JSON.parse(await io.readFile(join(record.run_dir, "run-job.json"), "utf8"))),
  ).toEqual(record);
  expect(h.registry.indexes.read().active).toContainEqual({
    job_id: record.job_id,
    run_id: record.run_id,
    run_dir: record.run_dir,
  });
  expect(h.registry.list()).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: record.dsh_job_id, status: "running" })]),
  );
  await expect.poll(() => readInvocation(record.run_dir)).not.toBeNull();
  const invocation = await readInvocation(record.run_dir);
  if (!invocation) throw new Error("Native solver omitted invocation evidence");
  expect(() => process.kill(invocation.pid, 0)).not.toThrow();
  await expect(io.readFile(join(record.run_dir, "exit_code"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(record.stack_id).not.toBeNull();
  expect(record.data_id).not.toBeNull();
  expect(fs.existsSync(join(h.cwd, "stacks", `${record.stack_id}.json`))).toBe(true);
  expect(fs.existsSync(join(h.cwd, "provenance", `${record.data_id}.json`))).toBe(true);
}

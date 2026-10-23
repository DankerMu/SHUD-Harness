import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { RunRecordSchema, type RunJob, type RunRecord } from "@shud-harness/dsh-shud-core";
import { type pollFixture, seedRun } from "../poll-shud/test-harness.ts";

export type CollectFixture = Awaited<ReturnType<typeof pollFixture>>;

const STARTED_AT = "2026-10-22T03:15:00.000Z";
const FINISHED_AT = "2026-10-22T03:15:02.500Z";

export function outputRoot(record: Pick<RunJob, "run_dir">): string {
  // The fixture's actual project is tiny, including when a test corrupts persisted project metadata.
  return join(record.run_dir, "output", "tiny.out");
}

export async function publishExit(record: Pick<RunJob, "run_dir">, bytes: string): Promise<void> {
  const target = join(record.run_dir, "exit_code");
  await io.writeFile(`${target}.fixture`, bytes);
  await io.rename(`${target}.fixture`, target);
}

/** Finish every disk fixture mutation before admitting the entry to the live 7ms dispatcher. */
export function seedTerminal(
  h: CollectFixture,
  changes: Partial<RunJob> = {},
  prepare?: (record: RunJob) => void | Promise<void>,
): Promise<RunJob> {
  return seedRun(
    h,
    {
      status: "succeeded",
      exit_code: 0,
      started_at: STARTED_AT,
      finished_at: FINISHED_AT,
      ...changes,
    },
    async (record) => {
      await io.mkdir(outputRoot(record), { recursive: true });
      await io.writeFile(join(record.run_dir, "stdout.log"), "fixture stdout bytes\n");
      await io.writeFile(join(record.run_dir, "stderr.log"), "fixture stderr bytes\n");
      if (record.exit_code !== null) await publishExit(record, `${record.exit_code}\n`);
      await prepare?.(record);
    },
  );
}

export async function readResult(runDir: string): Promise<RunRecord> {
  return RunRecordSchema.parse(
    JSON.parse(await io.readFile(join(runDir, "run-record.json"), "utf8")),
  );
}

export async function readLedger(
  runDir: string,
): Promise<{ attempts: number; last_error: string; at: string }> {
  const value: unknown = JSON.parse(await io.readFile(join(runDir, "collect-error.json"), "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("attempts" in value) ||
    typeof value.attempts !== "number" ||
    !("last_error" in value) ||
    typeof value.last_error !== "string" ||
    !("at" in value) ||
    typeof value.at !== "string"
  ) {
    throw new Error("Collection error ledger does not have the prescribed fields");
  }
  expect(Object.keys(value).sort()).toEqual(["at", "attempts", "last_error"]);
  expect(Number.isSafeInteger(value.attempts)).toBe(true);
  expect(value.attempts).toBeGreaterThanOrEqual(0);
  expect(value.last_error.length).toBeGreaterThan(0);
  expect(Number.isFinite(Date.parse(value.at))).toBe(true);
  expect(value.at.endsWith("Z")).toBe(true);
  return { attempts: value.attempts, last_error: value.last_error, at: value.at };
}

/** Fixed independent fixture for tests that start with an already committed result. */
export function existingResult(record: RunJob): RunRecord {
  return RunRecordSchema.parse({
    run_id: record.run_id,
    job_id: record.job_id,
    task_id: record.task_id,
    stack_id: record.stack_id,
    data_id: record.data_id,
    status: "succeeded",
    command: record.command,
    exit_code: 0,
    exit_class: "ok",
    artifacts: {
      stdout: join(record.run_dir, "stdout.log"),
      stderr: join(record.run_dir, "stderr.log"),
      shud_output: outputRoot(record),
      files: [],
    },
    numerical_health: {
      water_balance_residual: null,
      cvode_failures: null,
      negative_state_count: null,
      max_solver_dt: null,
    },
    resources: { wall_seconds: 2.5, peak_memory_mb: null },
    llm: record.llm,
    collected_at: "2026-10-22T03:15:03.000Z",
  });
}

export async function expectAbsent(path: string): Promise<void> {
  await expect(io.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

import { createHash } from "node:crypto";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { RunRecordSchema, type RunJob, type RunRecord } from "@shud-harness/dsh-shud-core";
import { readRunMetrics } from "@shud-harness/dsh-shud-records";
import { makeClosedBudgetRun } from "../../../dsh-shud-records/src/water-balance-test-harness.ts";
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

export const NULL_HEALTH = {
  water_balance_residual: null,
  cvode_failures: null,
  negative_state_count: null,
  max_solver_dt: null,
} as const;

/** Two authored solver-failure signatures between ordinary lines; independent of the counter. */
const METRICS_STDERR = "SUNDIALS_ERROR: first\nordinary solver line\nSUNDIALS_ERROR: second\n";

/** Terminal run with the records closed-budget project (wbmini) as its genuine metrics inputs. */
export function seedMetricsRun(
  h: CollectFixture,
  changes: Partial<RunJob> = {},
  prepare?: (record: RunJob) => void | Promise<void>,
): Promise<RunJob> {
  return seedTerminal(h, { project: "wbmini", ...changes }, async (record) => {
    makeClosedBudgetRun(record.run_dir);
    await io.writeFile(join(record.run_dir, "stderr.log"), METRICS_STDERR);
    await prepare?.(record);
  });
}

/** The committed digest binds the exact metrics.json bytes and the record repeats its health. */
export async function expectMetricsBound(record: RunRecord, runDir: string) {
  const bytes = await io.readFile(join(runDir, "metrics.json"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  expect(record.artifacts.metrics_summary).toEqual({ path: "metrics.json", sha256 });
  const metrics = readRunMetrics(runDir, sha256);
  const health = metrics.numerical_health;
  expect(record.numerical_health).toEqual({
    water_balance_residual: health.water_balance_residual,
    cvode_failures: health.cvode_failures,
    negative_state_count: health.negative_state_count,
    max_solver_dt: health.max_solver_dt,
  });
  return { bytes, metrics };
}

/** Run-metrics owns availability; collect still publishes the unavailable file and null health. */
export async function expectUnavailableMetrics(
  record: RunRecord,
  runDir: string,
  reason: string,
): Promise<void> {
  const { metrics } = await expectMetricsBound(record, runDir);
  expect(metrics).toMatchObject({ status: "unavailable", reason });
  expect(record.numerical_health).toEqual(NULL_HEALTH);
  expect(record).toMatchObject({ status: "succeeded", exit_class: "ok" });
  await expectAbsent(join(runDir, "collect-error.json"));
}

export function wakeText(h: CollectFixture): string {
  expect(h.followups).toHaveLength(1);
  return h.followups[0].message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

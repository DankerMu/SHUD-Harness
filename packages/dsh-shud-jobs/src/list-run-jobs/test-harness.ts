import * as io from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import { expect, vi } from "vitest";
import { RunJobSchema, TaskIdSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry, type IndexEntry } from "../index.ts";
import { createHarness } from "../test-harness.ts";
import { actualRegistry } from "../submit-shud/test-harness.ts";
import { entry } from "../state-indexes/test-harness.ts";
import { waitForOwnershipRelease } from "../poll-shud/test-harness.ts";
import { waitForRecovery } from "../reconcile-shud/test-harness.ts";

export const TARGET_TASK = TaskIdSchema.parse("TASK-20261029T031500-a001");
export const OTHER_TASK = TaskIdSchema.parse("TASK-20261029T031500-b002");
export const UNKNOWN_TASK = TaskIdSchema.parse("TASK-20261029T031500-c003");
export const PRIVATE_PAYLOAD = "PRIVATE_QUERY_PAYLOAD_453";
export const QUERY_POLL_MS = 600_000;

export async function queryFixture() {
  // Apply validates configuration, not Git history or solver execution. No capture is needed.
  const h = await createHarness(undefined, "absent", false);
  const logs: string[] = [];
  h.ctx.logger.exporter({
    export(message) {
      logs.push(message.args.map((value: unknown) => inspect(value, { depth: 8 })).join(" "));
    },
  });
  try {
    const fiber = await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: QUERY_POLL_MS });
    return {
      ...h,
      fiber,
      registry: actualRegistry(h.ctx),
      logs,
      async close() {
        await h.ctx.fiber.dispose();
        await waitForOwnershipRelease(h.stateDir);
        await h.dispose();
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

export interface QueryFixture {
  cwd: string;
  shudBin: string;
  registry: ShudJobRegistry;
}

export function queryRecord(
  h: Pick<QueryFixture, "cwd" | "shudBin">,
  suffix: string,
  changes: Partial<RunJob> = {},
): RunJob {
  const identity = entry(join(h.cwd, "runs", `RUN-20261022T031500-${suffix}`), suffix);
  return RunJobSchema.parse({
    ...identity,
    task_id: TARGET_TASK,
    stack_id: null,
    data_id: null,
    backend: "local_job",
    status: "created",
    project: "tiny",
    label: null,
    input_dir: join(h.cwd, "input"),
    command: [h.shudBin, "-o", "output/tiny.out", "tiny"],
    end_days: null,
    owner_session: null,
    dsh_job_id: null,
    dsh_job_ids: [],
    pid: null,
    pid_started_at: null,
    input_bytes: 0,
    submitted_at: null,
    started_at: null,
    finished_at: null,
    cancel_requested_at: null,
    exit_code: null,
    llm: { response_model: "query-fixture", response_model_source: "configured" },
    notify: { status: "pending", attempts: 0, at: null, detail: null },
    ...changes,
  });
}

export function indexed(record: RunJob): IndexEntry {
  return { run_id: record.run_id, job_id: record.job_id, run_dir: record.run_dir };
}

export async function writeQueryRecord(record: RunJob): Promise<void> {
  await io.mkdir(record.run_dir, { recursive: true });
  await io.writeFile(join(record.run_dir, "run-job.json"), JSON.stringify(record));
}

export async function seedQueryRun(
  h: QueryFixture,
  suffix: string,
  changes: Partial<RunJob> = {},
  index: "active" | "completed" | "unindexed" = "active",
): Promise<RunJob> {
  const record = queryRecord(h, suffix, changes);
  await writeQueryRecord(record);
  if (index !== "unindexed") await h.registry.indexes.addActive(indexed(record));
  if (index === "completed") await h.registry.indexes.completeActive(record.run_id);
  return record;
}

// Bypass injected filesystem failures/barriers when observing evidence; never follow links or FIFOs.
const nativeIo = await vi.importActual<typeof io>("node:fs/promises");
export async function snapshotQueryTree(root: string): Promise<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};
  async function visit(path: string, relative: string): Promise<void> {
    const stat = await nativeIo.lstat(path, { bigint: true });
    const metadata = { mode: stat.mode, ino: stat.ino, mtimeNs: stat.mtimeNs };
    if (stat.isDirectory()) {
      snapshot[relative] = { ...metadata, kind: "directory" };
      for (const name of (await nativeIo.readdir(path)).sort()) {
        await visit(join(path, name), join(relative, name));
      }
    } else if (stat.isFile()) {
      snapshot[relative] = { ...metadata, kind: "file", bytes: await nativeIo.readFile(path) };
    } else if (stat.isSymbolicLink()) {
      snapshot[relative] = { ...metadata, kind: "link", target: await nativeIo.readlink(path) };
    } else {
      snapshot[relative] = { ...metadata, kind: "special" };
    }
  }
  await visit(root, "");
  return snapshot;
}

export function observe<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

export async function expectQueryFailure(operation: Promise<unknown>, identifier: string) {
  const outcome = await observe(operation);
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("Invalid query unexpectedly returned records");
  expect(outcome.error).toBeInstanceOf(Error);
  if (!(outcome.error instanceof Error)) throw new Error("Query omitted its controlled error");
  expect(outcome.error.message).toContain(identifier);
  expect(inspect(outcome.error, { depth: 12 })).not.toContain(PRIVATE_PAYLOAD);
  return outcome.error;
}

/** Bound a missing/bypassed barrier without leaving an accepted operation unhandled. */
export async function enteredBeforeCompletion(
  entered: Promise<void>,
  operation: Promise<unknown>,
): Promise<void> {
  await Promise.race([
    entered,
    operation.then(() => {
      throw new Error("Operation completed before entering its filesystem barrier");
    }),
  ]);
}

/** A queue-coupling regression must release barriers in finally, rather than hang cleanup. */
export async function settlesWhileHeld<T>(operation: Promise<T>): Promise<T> {
  const observed = observe(operation);
  let settled = false;
  void observed.then(() => {
    settled = true;
  });
  await waitForRecovery(() => settled, "readonly query admission/completion");
  return operation;
}

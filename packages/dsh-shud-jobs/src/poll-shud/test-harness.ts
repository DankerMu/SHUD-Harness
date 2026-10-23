import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import type { JobHandle, JobOutcome } from "@deepseek-ai/dsh-jobs";
import { generateRunIdentifiers, RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry, startDetachedShud, type ShudExecution } from "../index.ts";
import {
  actualRegistry,
  registrationResource,
  submissionFixture,
} from "../submit-shud/test-harness.ts";
import {
  installFakeShud,
  observedStart,
  readInvocation,
  releaseInvocation,
  terminateGroup,
} from "../detached-shud/test-harness.ts";

/** Observe actual lock release rather than assuming Cordis dispose() has invoked every effect yet. */
export async function waitForOwnershipRelease(stateDir: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while ((await io.readdir(stateDir)).includes("lock")) {
    if (performance.now() >= deadline)
      throw new Error(`Registry did not release state ownership: ${stateDir}`);
  }
}

export async function readRecord(runDir: string): Promise<RunJob> {
  return RunJobSchema.parse(JSON.parse(await io.readFile(join(runDir, "run-job.json"), "utf8")));
}

export async function replaceRecord(record: RunJob, changes: Partial<RunJob>): Promise<RunJob> {
  const next = RunJobSchema.parse({ ...record, ...changes });
  const target = join(record.run_dir, "run-job.json");
  await io.writeFile(`${target}.fixture`, JSON.stringify(next));
  await io.rename(`${target}.fixture`, target);
  return next;
}

/** Wait in an independent process, without advancing/faking the registry's timer or reaping its child. */
export function waitForEvidence(runDir: string, name: "invocation.json" | "exit_code"): void {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const fs = require("node:fs");
    const path = process.argv[1];
    const deadline = Date.now() + 5000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(path)) {
      if (Date.now() > deadline) throw new Error("Execution evidence did not appear: " + path);
      Atomics.wait(pause, 0, 0, 5);
    }
  `,
      join(runDir, name),
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Independent execution barrier failed: ${result.stderr}`, {
      cause: result.error,
    });
  }
}

export function settlingProducer(
  beforeSettle?: (outcome: JobOutcome, record: RunJob) => void | Promise<void>,
) {
  const registration = registrationResource();
  const executions: ShudExecution[] = [];
  const attempts: JobOutcome[] = [];
  const completed: JobOutcome[] = [];
  const durableAtSettle: RunJob[] = [];
  const durableAtDone: RunJob[] = [];
  let doneObserved: Promise<void> | undefined;
  let accepted = false;
  return {
    registration,
    executions,
    attempts,
    completed,
    durableAtSettle,
    durableAtDone,
    get doneObserved() {
      return doneObserved;
    },
    start: (record: RunJob, handle: JobHandle, pumpPollMs: number): ShudExecution => {
      const resource = registration.open(record, handle);
      const hooks = {
        done: resource.done,
        cancel: (reason?: string) => resource.cancel(reason),
        async settle(outcome: JobOutcome) {
          attempts.push(outcome);
          if (accepted) return;
          const durable = RunJobSchema.parse(
            JSON.parse(readFileSync(join(record.run_dir, "run-job.json"), "utf8")),
          );
          durableAtSettle.push(durable);
          await beforeSettle?.(outcome, durable);
          accepted = true;
          completed.push(outcome);
          registration.finish(outcome);
        },
      };
      doneObserved = hooks.done.then(() => {
        if (accepted)
          durableAtDone.push(
            RunJobSchema.parse(
              JSON.parse(readFileSync(join(record.run_dir, "run-job.json"), "utf8")),
            ),
          );
      });
      const execution = startDetachedShud(record, hooks, pumpPollMs);
      executions.push(execution);
      return execution;
    },
    async cleanup() {
      const failures: unknown[] = [];
      for (const execution of executions) {
        const identity = await execution.started.catch(() => undefined);
        if (identity) {
          try {
            await terminateGroup(identity.pid);
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          await execution.abort();
        } catch (error) {
          failures.push(error);
        }
      }
      registration.finish();
      await doneObserved;
      if (failures.length) throw new AggregateError(failures, "Settlement fixture cleanup failed");
    },
  };
}

export async function pollFixture(code = 0, mode: "held" | "immediate" = "held") {
  const h = await submissionFixture();
  const producers: ReturnType<typeof settlingProducer>[] = [];
  const submissions: Promise<RunJob>[] = [];
  const errors: string[] = [];
  try {
    await installFakeShud(h.shudBin, code, mode);
    h.ctx.logger.exporter({
      export(message) {
        if (message.type === "error")
          errors.push(message.args.map((value: unknown) => inspect(value, { depth: 5 })).join(" "));
      },
    });
    const fiber = await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    const registry = actualRegistry(h.ctx);
    return {
      ...h,
      fiber,
      registry,
      errors,
      producers,
      submissions,
      start(beforeSettle?: (outcome: JobOutcome, record: RunJob) => void | Promise<void>) {
        const producer = settlingProducer(beforeSettle);
        producers.push(producer);
        const pending = registry.submitShud(h.request, producer.start);
        submissions.push(pending);
        return { producer, pending };
      },
      async close() {
        const failures: unknown[] = [];
        // Callers release their held filesystem barriers before this cleanup.
        await Promise.allSettled(submissions);
        for (const producer of producers) {
          try {
            await producer.cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          await h.ctx.fiber.dispose();
          await waitForOwnershipRelease(h.stateDir);
          await h.dispose();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) throw new AggregateError(failures, "Polling fixture cleanup failed");
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

export async function releaseRun(record: RunJob): Promise<void> {
  waitForEvidence(record.run_dir, "invocation.json");
  const invocation = await readInvocation(record.run_dir);
  if (!invocation) throw new Error("Held fake SHUD has no invocation receipt");
  await releaseInvocation(invocation);
  waitForEvidence(record.run_dir, "exit_code");
}

/** Disk-only running entry with genuine identity and no producer/current registration. */
export async function seedRun(
  h: Awaited<ReturnType<typeof pollFixture>>,
  changes: Partial<RunJob> = {},
): Promise<RunJob> {
  const ids = generateRunIdentifiers();
  const runDir = join(h.cwd, "runs", ids.run_id);
  await io.mkdir(runDir, { recursive: true });
  const stamp = observedStart(process.pid);
  const record = RunJobSchema.parse({
    ...ids,
    task_id: null,
    stack_id: null,
    data_id: null,
    backend: "local_job",
    status: "running",
    project: "tiny",
    label: null,
    input_dir: h.inputDir,
    run_dir: runDir,
    command: [h.shudBin, "-o", "output/tiny.out", "tiny"],
    end_days: null,
    owner_session: h.ownerId,
    dsh_job_id: null,
    dsh_job_ids: [],
    pid: process.pid,
    pid_started_at: stamp,
    input_bytes: 0,
    submitted_at: stamp,
    started_at: stamp,
    finished_at: null,
    cancel_requested_at: null,
    exit_code: null,
    llm: h.request.llm,
    notify: { status: "pending", attempts: 0, at: null, detail: null },
    ...changes,
  });
  await io.writeFile(join(runDir, "run-job.json"), JSON.stringify(record));
  await h.registry.indexes.addActive({ run_id: ids.run_id, job_id: ids.job_id, run_dir: runDir });
  return record;
}

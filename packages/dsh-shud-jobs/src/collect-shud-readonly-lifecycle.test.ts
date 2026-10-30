import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { RunJobSchema, type RunJob, type RunRecord } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { StateIndexStore } from "./state-indexes.ts";
import { createHarness } from "./test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";
import { barrier } from "./state-indexes/test-harness.ts";
import {
  pollFixture,
  readRecord,
  releaseRun,
  replaceRecord,
  waitForOwnershipRelease,
} from "./poll-shud/test-harness.ts";
import { waitForRecovery } from "./reconcile-shud/test-harness.ts";
import { existingResult } from "./collect-shud/test-harness.ts";
import {
  QUERY_POLL_MS,
  enteredBeforeCompletion,
  indexed,
  observe,
  queryFixture,
  queryRecord,
  seedQueryRun,
  settlesWhileHeld,
  snapshotQueryTree,
  writeQueryRecord,
} from "./list-run-jobs/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename) };
});
const native = await vi.importActual<typeof io>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.readFile).mockReset().mockImplementation(native.readFile);
  vi.mocked(io.rename).mockReset().mockImplementation(native.rename);
});

test("readonly collection rejects before startup readiness without additional IO", async () => {
  const h = await createHarness(undefined, "absent", false);
  const entered = barrier();
  const release = barrier();
  let applying: Promise<unknown> | undefined;
  try {
    const job = queryRecord(h, "a001");
    await writeQueryRecord(job);
    await io.writeFile(join(h.stateDir, "active.json"), JSON.stringify([indexed(job)]));
    await io.writeFile(join(h.stateDir, "completed.json"), "[]");
    vi.mocked(io.readFile).mockImplementation(async (...args) => {
      if (args[0] === join(job.run_dir, "run-job.json")) {
        entered.release();
        await release.waiting;
      }
      return native.readFile(...args);
    });
    applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: QUERY_POLL_MS });
    void applying.catch(() => undefined);
    await enteredBeforeCompletion(entered.waiting, applying);
    const reads = vi.mocked(io.readFile).mock.calls.length;
    await expect(actualRegistry(h.ctx).collectShud(job.run_id, { readonly: true })).rejects.toThrow(
      /not ready/iu,
    );
    expect(io.readFile).toHaveBeenCalledTimes(reads);
  } finally {
    release.release();
    await applying?.catch(() => undefined);
    vi.mocked(io.readFile).mockImplementation(native.readFile);
    await h.ctx.fiber.dispose();
    await waitForOwnershipRelease(h.stateDir);
    await h.dispose();
  }
}, 15000);

test.each([false, true])(
  "readonly per-entry read drains before native unlock, read fails=%s",
  async (fails) => {
    const h = await queryFixture();
    const entered = barrier();
    const release = barrier();
    let pending: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    let contender: StateIndexStore | undefined;
    try {
      const job = await seedQueryRun(h, "a001", { status: "collected" });
      const record = existingResult(job);
      const path = join(job.run_dir, "run-record.json");
      await io.writeFile(path, JSON.stringify(record));
      const before = await snapshotQueryTree(job.run_dir);
      let held = false;
      vi.mocked(io.readFile).mockImplementation(async (...args) => {
        if (args[0] === path && !held) {
          held = true;
          entered.release();
          await release.waiting;
          if (fails) throw Object.assign(new Error("PRIVATE_READONLY_DRAIN"), { code: "EIO" });
        }
        return native.readFile(...args);
      });
      const operation = h.registry.collectShud(job.run_id, { readonly: true });
      pending = observe(operation);
      await enteredBeforeCompletion(entered.waiting, pending);
      let disposed = false;
      closing = Promise.resolve(h.fiber.dispose()).then(() => {
        disposed = true;
      });
      await waitForRecovery(async () => {
        const result = await observe(h.registry.listRunJobsByTask(job.task_id!));
        return !result.ok && /closed/iu.test(String(result.error));
      }, "readonly collection closing admission");
      const reads = vi.mocked(io.readFile).mock.calls.length;
      await expect(h.registry.collectShud(job.job_id, { readonly: true })).rejects.toThrow(
        /CLOSED/u,
      );
      expect(io.readFile).toHaveBeenCalledTimes(reads);
      expect(disposed).toBe(false);
      expect(() => {
        contender = new StateIndexStore(h.stateDir);
      }).toThrow(h.stateDir);
      release.release();
      if (fails) await expect(operation).rejects.toThrow();
      else expect(await operation).toEqual(record);
      await closing;
      await waitForOwnershipRelease(h.stateDir);
      expect(await snapshotQueryTree(job.run_dir)).toEqual(before);
      contender = new StateIndexStore(h.stateDir);
      expect(contender.read()).toEqual({ active: [indexed(job)], completed: [] });
      expect(h.logs.join("\n")).not.toContain("PRIVATE_READONLY_DRAIN");
    } finally {
      release.release();
      await pending;
      await closing;
      await contender?.close();
      vi.mocked(io.readFile).mockImplementation(native.readFile);
      await h.close();
    }
  },
  15000,
);

test("readonly D7 admission remains rejected after submission finishes while its read is held", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const h = await pollFixture();
  const published = barrier();
  const finishSubmission = barrier();
  const entered = barrier();
  const finishRead = barrier();
  let checkpoint: RunJob | undefined;
  let pendingRead: Promise<unknown> | undefined;
  let readPath = "";
  try {
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (String(target).endsWith("/run-job.json")) {
        const candidate = RunJobSchema.parse(JSON.parse(await native.readFile(source, "utf8")));
        if (candidate.status === "running") {
          await native.rename(source, target);
          checkpoint = candidate;
          published.release();
          await finishSubmission.waiting;
          return;
        }
      }
      await native.rename(source, target);
    });
    vi.mocked(io.readFile).mockImplementation(async (...args) => {
      if (args[0] === readPath) {
        entered.release();
        await finishRead.waiting;
      }
      return native.readFile(...args);
    });
    const { pending } = h.start();
    await enteredBeforeCompletion(published.waiting, pending);
    if (!checkpoint) throw new Error("Submission omitted the D7 checkpoint");
    expect(h.registry.isSubmissionInFlight(checkpoint.run_id)).toBe(true);
    readPath = join(checkpoint.run_dir, "run-job.json");
    const operation = h.registry.collectShud(checkpoint.run_id, { readonly: true });
    pendingRead = observe(operation);
    await enteredBeforeCompletion(entered.waiting, pendingRead);
    finishSubmission.release();
    await pending;
    expect(h.registry.isSubmissionInFlight(checkpoint.run_id)).toBe(false);
    const before = await snapshotQueryTree(checkpoint.run_dir);
    finishRead.release();
    await expect(operation).rejects.toMatchObject({ code: "SUBMISSION_IN_FLIGHT" });
    expect(await snapshotQueryTree(checkpoint.run_dir)).toEqual(before);
  } finally {
    finishSubmission.release();
    finishRead.release();
    await pendingRead;
    vi.mocked(io.readFile).mockImplementation(native.readFile);
    vi.mocked(io.rename).mockImplementation(native.rename);
    try {
      await h.close();
    } finally {
      vi.useRealTimers();
    }
  }
}, 15000);

test("readonly cached retrieval never retries an outstanding registration completion receipt", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const h = await pollFixture();
  try {
    const { producer, pending } = h.start(() =>
      Promise.reject(new Error("PRIVATE_PENDING_RECEIPT")),
    );
    const job = await pending;
    await releaseRun(job);
    await h.registry.pollOnce();
    expect(producer.attempts).toHaveLength(1);
    expect(producer.completed).toEqual([]);
    const collected = await replaceRecord(await readRecord(job.run_dir), { status: "collected" });
    const record = existingResult(collected);
    await io.writeFile(join(job.run_dir, "run-record.json"), JSON.stringify(record));
    const before = await snapshotQueryTree(h.root);
    expect(await settlesWhileHeld(h.registry.collectShud(job.run_id, { readonly: true }))).toEqual(
      record,
    );
    expect(producer.attempts).toHaveLength(1);
    expect(producer.completed).toEqual([]);
    expect(h.followups).toEqual([]);
    expect(await snapshotQueryTree(h.root)).toEqual(before);
  } finally {
    try {
      await h.close();
    } finally {
      vi.useRealTimers();
    }
  }
}, 15000);

test("readonly requests use the existing per-entry queue without concurrent evidence reads", async () => {
  const h = await queryFixture();
  const entered = barrier();
  const release = barrier();
  const operations: Promise<RunRecord>[] = [];
  try {
    const job = await seedQueryRun(h, "a001", { status: "collected" });
    const record = existingResult(job);
    const path = join(job.run_dir, "run-record.json");
    await io.writeFile(path, JSON.stringify(record));
    let reads = 0;
    vi.mocked(io.readFile).mockImplementation(async (...args) => {
      if (args[0] === path) {
        reads++;
        if (reads === 1) {
          entered.release();
          await release.waiting;
        }
      }
      return native.readFile(...args);
    });
    operations.push(h.registry.collectShud(job.run_id, { readonly: true }));
    await enteredBeforeCompletion(entered.waiting, operations[0]);
    operations.push(h.registry.collectShud(job.job_id, { readonly: true }));
    await settlesWhileHeld(h.registry.listRunJobsByTask(job.task_id!));
    expect(reads).toBe(1);
    release.release();
    expect(await Promise.all(operations)).toEqual([record, record]);
    expect(reads).toBe(2);
  } finally {
    release.release();
    await Promise.allSettled(operations);
    vi.mocked(io.readFile).mockImplementation(native.readFile);
    await h.close();
  }
}, 15000);

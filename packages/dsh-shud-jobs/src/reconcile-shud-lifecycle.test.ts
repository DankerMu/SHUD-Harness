import * as io from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeIo from "node:fs/promises";
import { generateRunIdentifiers, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { expectAbsent, readResult } from "./collect-shud/test-harness.ts";
import { activeGroup } from "./detached-shud/test-harness.ts";
import {
  pollFixture,
  readRecord,
  seedRun,
  settlingProducer,
  waitForOwnershipRelease,
} from "./poll-shud/test-harness.ts";
import {
  closeRecovery,
  completedWithinWindow,
  stopWithCancellation,
  waitForRecovery,
  waitForTerm,
} from "./reconcile-shud/test-harness.ts";
import { StateIndexStore } from "./state-indexes.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";
import { createHarness } from "./test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.readFile).mockReset().mockImplementation(actualIo.readFile);
});

/** A removed guard may enqueue behind startup; bound the assertion so finally can release recovery. */
async function expectRejectedWhileHeld(operation: Promise<unknown>): Promise<void> {
  let outcome: "pending" | "accepted" | "rejected" = "pending";
  let failure: unknown;
  void operation.then(
    () => {
      outcome = "accepted";
    },
    (error: unknown) => {
      outcome = "rejected";
      failure = error;
    },
  );
  await waitForRecovery(() => outcome !== "pending", "the startup API admission decision");
  expect(outcome).toBe("rejected");
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toMatch(/not ready/iu);
}

test("non-strict SHUD APIs reject while recovered cancellation owns startup readiness", async () => {
  const h = await pollFixture();
  let pid: number | undefined;
  let applying: Promise<unknown> | undefined;
  const requests: Promise<unknown>[] = [];
  try {
    let healthy: RunJob | undefined;
    const run = await stopWithCancellation(h, async () => {
      healthy = await seedRun(
        h,
        {
          status: "created",
          pid: null,
          pid_started_at: null,
          submitted_at: null,
          started_at: null,
        },
        async (record) => {
          await io.mkdir(join(record.run_dir, "output"));
          await io.writeFile(join(record.run_dir, "stdout.log"), "");
          await io.writeFile(join(record.run_dir, "stderr.log"), "");
        },
      );
    });
    if (!healthy) throw new Error("Independent startup entry was not prepared");
    const independent = healthy;
    pid = run.pid;
    const path = join(run.record.run_dir, "run-job.json");
    const bytes = await io.readFile(path);
    const mtime = (await io.stat(path, { bigint: true })).mtimeNs;
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(run.requestedAt + 5000);
    let ready = false;
    applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 }).then((fiber) => {
      ready = true;
      return fiber;
    });
    void applying.catch(() => undefined);
    await waitForTerm(run.record.run_dir);
    expect(activeGroup(pid)).toContain(run.invocation.pid);
    expect(ready).toBe(false);
    // This entry follows the held R8 entry in active.json; startup must not serialize behind it.
    await waitForRecovery(async () => {
      try {
        return (await readResult(independent.run_dir)).exit_class === "lost";
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    }, "the independent startup entry's collection");
    expect(ready).toBe(false);
    const registry = actualRegistry(h.ctx);
    const indexes = registry.indexes.read();
    const candidate = settlingProducer();
    h.producers.push(candidate);
    const submitted = registry.submitShud(h.request, candidate.start);
    h.submissions.push(submitted);
    requests.push(submitted);
    await expectRejectedWhileHeld(submitted);
    const polled = registry.pollOnce();
    requests.push(polled);
    await expectRejectedWhileHeld(polled);
    const collected = registry.collectShud(independent.run_id);
    requests.push(collected);
    await expectRejectedWhileHeld(collected);
    expect(candidate.registration.handles).toEqual([]);
    expect(registry.indexes.read()).toEqual(indexes);
    expect(registry.list()).toEqual([]);
    expect(await io.readFile(path)).toEqual(bytes);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(mtime);
    await expectAbsent(join(run.record.run_dir, "run-record.json"));
    expect(ready).toBe(false);

    vi.setSystemTime(run.requestedAt + 10000);
    await completedWithinWindow(applying);
    expect(ready).toBe(true);
    expect(activeGroup(pid)).toEqual([]);
    await expect(registry.pollOnce()).resolves.toBeUndefined();
    expect((await registry.collectShud(run.record.run_id)).exit_class).toBe("cancelled");
    expect(candidate.registration.handles).toEqual([]);
  } finally {
    vi.useRealTimers();
    await closeRecovery(h, pid, applying);
    await Promise.allSettled(requests);
  }
}, 15000);

test("disposal drains recovered startup before unlocking and admits no later timer work", async () => {
  const h = await pollFixture();
  const contender = await createHarness();
  let pid: number | undefined;
  let applying: Promise<unknown> | undefined;
  let disposing: Promise<void> | undefined;
  try {
    const run = await stopWithCancellation(h);
    pid = run.pid;
    const path = join(run.record.run_dir, "run-job.json");
    let reads = 0;
    vi.mocked(io.readFile).mockImplementation(async (...args) => {
      if (args[0] === path) reads++;
      return actualIo.readFile(...args);
    });
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(run.requestedAt + 5000);
    const timersBefore = vi.getTimerCount();
    const fiber = h.ctx.plugin(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    applying = Promise.resolve(fiber);
    void applying.catch(() => undefined);
    await waitForTerm(run.record.run_dir);
    const registry = actualRegistry(h.ctx);
    let disposed = false;
    disposing = Promise.resolve(fiber.dispose()).then(() => {
      disposed = true;
    });
    await expect(contender.apply(ShudJobRegistry, h.config)).rejects.toThrow(h.stateDir);
    expect(disposed).toBe(false);
    expect(await io.readdir(h.stateDir)).toContain("lock");
    expect((await readRecord(run.record.run_dir)).status).toBe("running");
    expect(activeGroup(pid)).toContain(run.invocation.pid);

    vi.setSystemTime(run.requestedAt + 10000);
    await completedWithinWindow(Promise.allSettled([applying, disposing]));
    await disposing;
    await waitForOwnershipRelease(h.stateDir);
    expect(disposed).toBe(true);
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(activeGroup(pid)).toEqual([]);
    expect((await readRecord(run.record.run_dir)).status).toBe("collected");
    expect((await readResult(run.record.run_dir)).exit_class).toBe("cancelled");
    const bytes = await actualIo.readFile(path);
    const mtime = (await io.stat(path, { bigint: true })).mtimeNs;
    reads = 0;
    await expect(registry.pollOnce()).rejects.toThrow(/closed|not ready/iu);
    await vi.advanceTimersByTimeAsync(70);
    expect(reads).toBe(0);
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(await actualIo.readFile(path)).toEqual(bytes);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(mtime);
    expect(await io.readdir(h.stateDir)).not.toContain("lock");
  } finally {
    vi.useRealTimers();
    await closeRecovery(h, pid, applying);
    await disposing?.catch(() => undefined);
    await contender.dispose();
  }
}, 15000);

test("ACTIVE disposal retains the kernel lock until an accepted recovered retry drains", async () => {
  const h = await pollFixture();
  let pid: number | undefined;
  let applying: Promise<unknown> | undefined;
  let polling: Promise<void> | undefined;
  let disposing: Promise<void> | undefined;
  let contender: StateIndexStore | undefined;
  let restoreSignals: (() => void) | undefined;
  const requests: Promise<unknown>[] = [];
  const expectClosed = async (operation: Promise<unknown>): Promise<void> => {
    requests.push(operation);
    await completedWithinWindow(
      operation.then(
        () => {
          throw new Error("Closed registry accepted an API operation");
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(Error);
          expect(String(error)).toMatch(/closed/iu);
        },
      ),
    );
  };
  try {
    const run = await stopWithCancellation(h);
    pid = run.pid;
    const path = join(run.record.run_dir, "run-job.json");
    const original = await io.readFile(path);
    const originalMtime = (await io.stat(path, { bigint: true })).mtimeNs;
    const nativeKill = process.kill.bind(process);
    const signals: string[] = [];
    let denyTerm = true;
    const signalSpy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (signal !== 0 && target < 0 && target !== -run.pid)
        throw new Error("Refusing a foreign test-group signal");
      if (target === -run.pid && signal !== 0) {
        signals.push(String(signal));
        if (denyTerm && signal === "SIGTERM")
          throw Object.assign(new Error("startup TERM denied"), { code: "EPERM" });
      }
      return nativeKill(target, signal);
    });
    restoreSignals = () => signalSpy.mockRestore();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(run.requestedAt + 5000);
    const timersBefore = vi.getTimerCount();
    const errorsBefore = h.errors.length;
    const pendingFiber = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    applying = pendingFiber;
    await completedWithinWindow(pendingFiber);
    const fiber = await pendingFiber;
    // Init has completed: Cordis's LOADING drain cannot mask the dispatcher's drain here.
    expect(h.errors.length).toBeGreaterThan(errorsBefore);
    expect(signals).toEqual(["SIGTERM"]);
    expect(activeGroup(run.pid)).toContain(run.pid);
    expect(activeGroup(run.pid)).toContain(run.invocation.pid);
    expect(await io.readFile(path)).toEqual(original);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(originalMtime);
    const registry = actualRegistry(h.ctx);
    const unknown = generateRunIdentifiers().run_id;
    expect(registry.indexes.lookup(unknown)).toBeUndefined();
    // This public probe cannot enqueue: unknown-id rejection precedes the per-entry queue.
    await expect(registry.collectShud(unknown)).rejects.toThrow("UNKNOWN_ID");
    denyTerm = false;
    let polled = false;
    polling = registry.pollOnce().then(() => {
      polled = true;
    });
    void polling.catch(() => undefined);
    await waitForTerm(run.record.run_dir);
    await completedWithinWindow(run.producer.executions[0].waitForExit());
    expect(activeGroup(run.pid)).not.toContain(run.pid);
    expect(activeGroup(run.pid)).toContain(run.invocation.pid);
    expect(polled).toBe(false);
    expect(signals).toEqual(["SIGTERM", "SIGTERM"]);

    let disposed = false;
    disposing = Promise.resolve(fiber.dispose()).then(() => {
      disposed = true;
    });
    void disposing.catch(() => undefined);
    // Cordis may invoke disposal effects later; observe actual admission closure before
    // probing an existing entry, which could otherwise queue behind the held recovery.
    await waitForRecovery(async () => {
      try {
        await registry.collectShud(unknown);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toMatch(/\b(?:UNKNOWN_ID|CLOSED)\b/u);
        return String(error).includes("CLOSED");
      }
      throw new Error("Unknown run unexpectedly collected");
    }, "ACTIVE registry admission closure");
    // Closure is proven above; now allow premature disposal to finish without moving fake Date.
    await delay(75);
    await expectClosed(registry.pollOnce());
    await expectClosed(registry.collectShud(run.record.run_id));
    const candidate = settlingProducer();
    h.producers.push(candidate);
    const submitted = registry.submitShud(h.request, candidate.start);
    h.submissions.push(submitted);
    await expectClosed(submitted);
    expect(candidate.registration.handles).toEqual([]);
    expect(() => {
      contender = new StateIndexStore(h.stateDir);
    }).toThrow(h.stateDir);
    expect(disposed).toBe(false);
    expect(polled).toBe(false);
    expect(await io.readdir(h.stateDir)).toContain("lock");
    expect(await io.readFile(path)).toEqual(original);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(originalMtime);
    expect((await readRecord(run.record.run_dir)).status).toBe("running");
    expect(activeGroup(run.pid)).toContain(run.invocation.pid);
    expect(signals).toEqual(["SIGTERM", "SIGTERM"]);
    await expectAbsent(join(run.record.run_dir, "run-record.json"));

    vi.setSystemTime(run.requestedAt + 10000);
    await completedWithinWindow(Promise.all([polling, disposing]));
    await waitForOwnershipRelease(h.stateDir);
    expect(polled).toBe(true);
    expect(disposed).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]);
    expect(activeGroup(run.pid)).toEqual([]);
    expect(await readRecord(run.record.run_dir)).toMatchObject({
      status: "collected",
      exit_code: null,
      cancel_requested_at: run.record.cancel_requested_at,
      notify: run.record.notify,
    });
    expect((await readResult(run.record.run_dir)).exit_class).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(await io.readdir(h.stateDir)).not.toContain("lock");
    // A real subsequent owner can acquire; the disposed registry must remain inert thereafter.
    contender = new StateIndexStore(h.stateDir);
    const bytes = await actualIo.readFile(path);
    const mtime = (await io.stat(path, { bigint: true })).mtimeNs;
    let reads = 0;
    vi.mocked(io.readFile).mockImplementation(async (...args) => {
      if (args[0] === path) reads++;
      return actualIo.readFile(...args);
    });
    await expectClosed(registry.pollOnce());
    await vi.advanceTimersByTimeAsync(70);
    expect(reads).toBe(0);
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(await actualIo.readFile(path)).toEqual(bytes);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(mtime);
  } finally {
    restoreSignals?.();
    vi.useRealTimers();
    await contender?.close();
    await closeRecovery(h, pid, Promise.allSettled([applying, polling, disposing, ...requests]));
  }
}, 15000);

import * as io from "node:fs/promises";
import { join } from "node:path";
import { JobId } from "@deepseek-ai/dsh-jobs";
import { expect, test, vi } from "vitest";
import { activeGroup, installFakeShud } from "./detached-shud/test-harness.ts";
import { pollFixture, settlingProducer, waitForEvidence } from "./poll-shud/test-harness.ts";
import { observeSignals, readDurable, readyRun } from "./kill-shud/test-harness.ts";
import { barrier } from "./state-indexes/test-harness.ts";
import {
  completedWithinWindow,
  waitForRecovery,
  waitForTerm,
} from "./reconcile-shud/test-harness.ts";

test("leader-first exit retains a SIGTERM-resistant descendant until the original ten-second deadline", async () => {
  const h = await pollFixture();
  let signals: ReturnType<typeof observeSignals> | undefined;
  try {
    await installFakeShud(h.shudBin, 0, "resistant");
    const { record, id, pid, invocation, producer } = await readyRun(h);
    const origin = Date.now();
    // Only the deadline clock is controlled. The dispatcher, subprocess and its I/O remain real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(origin);
    signals = observeSignals();
    expect(h.registry.kill(id, h.ownerId, "first request")).toBe("requested");
    const requestedAt = readDurable(record.run_dir).cancel_requested_at;
    expect(requestedAt).toBe(new Date(origin).toISOString());
    await expect
      .poll(async () => {
        try {
          return await io.readFile(join(record.run_dir, "sigterm-seen"), "utf8");
        } catch {
          return null;
        }
      })
      .toBe("SIGTERM\n");
    await expect.poll(() => activeGroup(pid).includes(pid)).toBe(false);
    await producer.executions[0].waitForExit();
    expect(activeGroup(pid)).toContain(invocation.pid);
    await h.registry.pollOnce();
    expect(producer.completed).toEqual([]);
    expect(readDurable(record.run_dir).status).toBe("running");
    await expect
      .poll(async () => {
        try {
          return (await io.stat(join(record.run_dir, "live-output"))).size;
        } catch {
          return 0;
        }
      })
      .toBeGreaterThan(0);
    const size = (await io.stat(join(record.run_dir, "live-output"))).size;

    vi.setSystemTime(origin + 5000);
    expect(h.registry.kill(id, h.ownerId, "repeat request")).toBe("requested");
    expect(readDurable(record.run_dir).cancel_requested_at).toBe(requestedAt);
    vi.setSystemTime(origin - 5000);
    await h.registry.pollOnce();
    vi.setSystemTime(origin + 9999);
    await h.registry.pollOnce();
    expect(signals.events).toEqual([{ pid: -pid, signal: "SIGTERM" }]);
    expect(activeGroup(pid)).toContain(invocation.pid);
    expect(producer.completed).toEqual([]);
    expect(producer.durableAtDone).toEqual([]);
    expect(readDurable(record.run_dir).status).toBe("running");
    await expect
      .poll(async () => (await io.stat(join(record.run_dir, "live-output"))).size)
      .toBeGreaterThan(size);

    vi.setSystemTime(origin + 10000);
    await h.registry.pollOnce();
    await expect.poll(() => producer.completed.length, { timeout: 5000 }).toBe(1);
    await producer.doneObserved;
    expect(signals.events).toEqual([
      { pid: -pid, signal: "SIGTERM" },
      { pid: -pid, signal: "SIGKILL" },
    ]);
    expect(activeGroup(pid)).toEqual([]);
    expect(producer.durableAtSettle[0]).toMatchObject({
      status: "cancelled",
      exit_code: null,
      cancel_requested_at: requestedAt,
    });
    expect(producer.durableAtDone).toEqual(producer.durableAtSettle);
    expect(producer.completed[0].status).toBe("killed");
    expect(producer.registration.cancellations).toEqual([]);
    await expect.poll(() => h.registry.get(id, h.ownerId).status).toBe("killed");
    expect(h.registry.get(id, h.ownerId).detail).toContain("repeat request");
  } finally {
    signals?.restore();
    vi.useRealTimers();
    await h.close();
  }
}, 15000);

test("local cancellation waits for the genuine native-child waiter before settling producer done", async () => {
  // Freeze cadence before fixture creation; genuine child exit and pump timeouts remain real.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const h = await pollFixture();
  const producer = settlingProducer();
  h.producers.push(producer);
  const entered = barrier();
  const release = barrier();
  let polling: Promise<void> | undefined;
  let enteredWaiter = false;
  let restoreSignals: (() => void) | undefined;
  try {
    await installFakeShud(h.shudBin, 0, "resistant");
    const pending = h.registry.submitShud(h.request, (record, handle, cadence) => {
      const execution = producer.start(record, handle, cadence);
      return {
        ...execution,
        async waitForExit() {
          await execution.waitForExit();
          enteredWaiter = true;
          entered.release();
          await release.waiting;
        },
      };
    });
    h.submissions.push(pending);
    await completedWithinWindow(pending);
    const record = await pending;
    if (record.pid === null || record.dsh_job_id === null)
      throw new Error("Actual local execution lacks process or registration identity");
    const pid = record.pid;
    const id = JobId(record.dsh_job_id);
    waitForEvidence(record.run_dir, "invocation.json");
    const origin = Date.now();
    vi.setSystemTime(origin);
    const signals = observeSignals();
    restoreSignals = signals.restore;
    expect(h.registry.kill(id, h.ownerId, "local child reaping")).toBe("requested");
    await waitForTerm(record.run_dir);
    const intent = readDurable(record.run_dir).cancel_requested_at;
    expect(intent).toBe(new Date(origin).toISOString());
    vi.setSystemTime(origin + 10000);
    // Quiescence can require another native scheduling turn after SIGKILL.
    await waitForRecovery(async () => {
      if (enteredWaiter || producer.completed.length !== 0) return true;
      polling ??= h.registry.pollOnce();
      let finished = false;
      void polling.then(() => {
        finished = true;
      });
      await completedWithinWindow(Promise.race([polling, entered.waiting, producer.doneObserved]));
      if (finished) polling = undefined;
      return enteredWaiter || producer.completed.length !== 0;
    }, "native waiter or producer completion");
    // A mutant that omits native reaping reaches producer done instead of this actual waiter.
    expect(enteredWaiter).toBe(true);
    expect(activeGroup(pid)).toEqual([]);
    expect(producer.completed).toEqual([]);
    expect(producer.durableAtSettle).toEqual([]);
    expect(producer.durableAtDone).toEqual([]);
    expect(h.registry.get(id).status).toBe("stopping");
    expect(readDurable(record.run_dir)).toMatchObject({
      status: "cancelled",
      exit_code: null,
      cancel_requested_at: intent,
    });
    release.release();
    await completedWithinWindow(Promise.all([polling, producer.doneObserved]));
    expect(producer.completed).toHaveLength(1);
    expect(producer.completed[0].status).toBe("killed");
    expect(producer.durableAtDone).toEqual(producer.durableAtSettle);
    expect(producer.durableAtDone[0]).toMatchObject({
      status: "cancelled",
      exit_code: null,
      cancel_requested_at: intent,
    });
    await waitForRecovery(() => h.registry.get(id).status === "killed", "local parent completion");
    expect(signals.events).toEqual([
      { pid: -pid, signal: "SIGTERM" },
      { pid: -pid, signal: "SIGKILL" },
    ]);
    expect(producer.registration.cancellations).toEqual([]);
  } finally {
    release.release();
    restoreSignals?.();
    try {
      try {
        await completedWithinWindow(Promise.allSettled([polling]));
      } finally {
        await h.close();
      }
    } finally {
      vi.useRealTimers();
    }
  }
}, 15000);

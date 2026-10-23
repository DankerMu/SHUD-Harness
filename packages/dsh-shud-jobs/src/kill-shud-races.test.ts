import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeIo from "node:fs/promises";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { activeGroup, installFakeShud, terminateGroup } from "./detached-shud/test-harness.ts";
import { barrier } from "./state-indexes/test-harness.ts";
import {
  pollFixture,
  readRecord,
  replaceRecord,
  settlingProducer,
  waitForOwnershipRelease,
} from "./poll-shud/test-harness.ts";
import {
  expectAbsent,
  outputRoot,
  publishExit,
  readLedger,
  readResult,
  seedTerminal,
} from "./collect-shud/test-harness.ts";
import { observeSignals, readDurable, readyRun } from "./kill-shud/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    rename: vi.fn(actual.rename),
  };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.readFile).mockReset().mockImplementation(actualIo.readFile);
  vi.mocked(io.readdir).mockReset().mockImplementation(actualIo.readdir);
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
});

test("kill after an accepted poll snapshot preserves fresh intent and classifies absent exit as cancelled, not lost", async () => {
  const h = await pollFixture();
  const entered = barrier();
  const release = barrier();
  let polling: Promise<void> | undefined;
  let signals: ReturnType<typeof observeSignals> | undefined;
  try {
    const { record, id, pid, producer } = await readyRun(h);
    let held = false;
    vi.mocked(io.readFile).mockImplementation(async (...args) => {
      if (!held && args[0] === join(record.run_dir, "exit_code")) {
        held = true;
        entered.release();
        await release.waiting;
      }
      return actualIo.readFile(...args);
    });
    polling = h.registry.pollOnce();
    await entered.waiting;
    // The accepted poll already read running/null-cancel metadata, but has not classified death.
    await terminateGroup(pid);
    await producer.executions[0].waitForExit();
    signals = observeSignals();
    expect(h.registry.kill(id, h.ownerId, "cancel before final classification")).toBe("requested");
    const intent = readDurable(record.run_dir);
    expect(intent.cancel_requested_at).toEqual(expect.any(String));
    expect(intent.status).toBe("running");
    expect(producer.completed).toEqual([]);
    expect(signals.events).toEqual([]);
    release.release();
    await polling;
    await expect.poll(() => producer.completed.length).toBe(1);
    await producer.doneObserved;
    expect(producer.durableAtSettle[0].finished_at).toEqual(expect.any(String));
    expect(producer.durableAtSettle[0]).toEqual({
      ...intent,
      status: "cancelled",
      exit_code: null,
      finished_at: producer.durableAtSettle[0].finished_at,
    });
    expect(producer.completed[0].status).toBe("killed");
    expect(producer.completed[0].detail).not.toMatch(/lost/iu);
    expect(producer.durableAtDone).toEqual(producer.durableAtSettle);
    expect(producer.registration.cancellations).toEqual([]);
    expect((await h.registry.collectShud(record.run_id)).exit_class).toBe("cancelled");
  } finally {
    release.release();
    await polling?.catch(() => undefined);
    signals?.restore();
    await h.close();
  }
}, 15000);

test.each(["collected", "failed"] as const)(
  "%s collection projection preserves metadata changed after its snapshot",
  async (status) => {
    const h = await pollFixture();
    const entered = barrier();
    const release = barrier();
    let polling: Promise<void> | undefined;
    let root = "";
    let ledgerPath = "";
    try {
      vi.mocked(io.readdir).mockImplementation(async (...args) => {
        if (status === "collected" && args[0] === root) {
          entered.release();
          await release.waiting;
        }
        return actualIo.readdir(...args);
      });
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (status === "failed" && target === ledgerPath) {
          entered.release();
          await release.waiting;
        }
        await actualIo.rename(source, target);
      });
      const job = await seedTerminal(h, {}, async (record) => {
        root = outputRoot(record);
        ledgerPath = join(record.run_dir, "collect-error.json");
        if (status === "failed") await publishExit(record, "invalid");
      });
      polling = h.registry.pollOnce();
      await entered.waiting;
      const fresh = await replaceRecord(job, {
        cancel_requested_at: "2026-10-22T03:15:01.000Z",
        label: "metadata published after collector snapshot",
      });
      release.release();
      await polling;
      expect(await readRecord(job.run_dir)).toEqual({ ...fresh, status });
      if (status === "collected") {
        expect((await readResult(job.run_dir)).exit_class).toBe("ok");
        const resultPath = join(job.run_dir, "run-record.json");
        const bytes = await io.readFile(resultPath);
        const mtime = (await io.stat(resultPath, { bigint: true })).mtimeNs;
        await h.registry.collectShud(job.run_id);
        expect(await io.readFile(resultPath)).toEqual(bytes);
        expect((await io.stat(resultPath, { bigint: true })).mtimeNs).toBe(mtime);
      } else {
        expect((await readLedger(job.run_dir)).attempts).toBe(1);
        await expectAbsent(join(job.run_dir, "run-record.json"));
      }
    } finally {
      release.release();
      await polling?.catch(() => undefined);
      await h.close();
    }
  },
);

test("public kill rejects a visible D7 registration before metadata publication or signaling", async () => {
  const h = await pollFixture();
  const entered = barrier();
  const release = barrier();
  let candidate: RunJob | undefined;
  let signals: ReturnType<typeof observeSignals> | undefined;
  try {
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (typeof target === "string" && target.endsWith("/run-job.json")) {
        const record = RunJobSchema.parse(JSON.parse(await actualIo.readFile(source, "utf8")));
        if (record.status === "running") {
          candidate = record;
          entered.release();
          await release.waiting;
        }
      }
      await actualIo.rename(source, target);
    });
    const { producer, pending } = h.start();
    await entered.waiting;
    if (!candidate) throw new Error("Running publication did not reach its barrier");
    const id = producer.registration.handles[0].id;
    const path = join(candidate.run_dir, "run-job.json");
    const before = await io.readFile(path);
    const mtime = (await io.stat(path, { bigint: true })).mtimeNs;
    signals = observeSignals();
    expect(h.registry.isSubmissionInFlight(candidate.run_id)).toBe(true);
    expect(() => h.registry.kill(id, h.ownerId, "too early")).toThrow(/submission.*in flight/iu);
    expect(await io.readFile(path)).toEqual(before);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(mtime);
    expect(signals.events).toEqual([]);
    expect(producer.registration.cancellations).toEqual([]);
    expect(producer.completed).toEqual([]);
    release.release();
    const running = await pending;
    expect(running.cancel_requested_at).toBeNull();
  } finally {
    release.release();
    signals?.restore();
    await h.close();
  }
}, 15000);

test("closed SHUD admission rejects kill while parent completion is still draining", async () => {
  const h = await pollFixture();
  const doneEntered = barrier();
  const releaseDone = barrier();
  const producer = settlingProducer();
  h.producers.push(producer);
  let disposing: Promise<void> | undefined;
  let signals: ReturnType<typeof observeSignals> | undefined;
  try {
    // Real execution/resource hooks, with only the parent-facing done delivery held at its boundary.
    const pending = h.registry.submitShud(h.request, (record, handle, cadence) => {
      const execution = producer.start(record, handle, cadence);
      return {
        ...execution,
        hooks: {
          ...execution.hooks,
          done: execution.hooks.done.then(async (outcome) => {
            doneEntered.release();
            await releaseDone.waiting;
            return outcome;
          }),
        },
      };
    });
    h.submissions.push(pending);
    const record = await pending;
    const id = producer.registration.handles[0].id;
    const path = join(record.run_dir, "run-job.json");
    const before = await io.readFile(path);
    const mtime = (await io.stat(path, { bigint: true })).mtimeNs;
    disposing = Promise.resolve(h.fiber.dispose());
    await doneEntered.waiting;
    await waitForOwnershipRelease(h.stateDir);
    expect(h.registry.get(id, h.ownerId).status).toBe("stopping");
    signals = observeSignals();
    expect(() => h.registry.kill(id, h.ownerId, "after close")).toThrow(/admission is closed/iu);
    expect(await io.readFile(path)).toEqual(before);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(mtime);
    expect(signals.events).toEqual([]);
    if (record.pid === null) throw new Error("Real wrapper identity is absent");
    expect(activeGroup(record.pid)).toContain(record.pid);
  } finally {
    signals?.restore();
    releaseDone.release();
    await disposing;
    await h.close();
  }
}, 15000);

test("D7 kill rejection remains in force while failed startup is rolling back its owned execution", async () => {
  const h = await pollFixture();
  const entered = barrier();
  const release = barrier();
  const producer = settlingProducer();
  h.producers.push(producer);
  let pending: Promise<RunJob> | undefined;
  let candidate: RunJob | undefined;
  let signals: ReturnType<typeof observeSignals> | undefined;
  try {
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (typeof target === "string" && target.endsWith("/run-job.json")) {
        const record = RunJobSchema.parse(JSON.parse(await actualIo.readFile(source, "utf8")));
        if (record.status === "running") {
          candidate = record;
          throw new Error("running publication failed before rollback");
        }
      }
      await actualIo.rename(source, target);
    });
    pending = h.registry.submitShud(h.request, (record, handle, cadence) => {
      const execution = producer.start(record, handle, cadence);
      return {
        ...execution,
        async abort() {
          entered.release();
          await release.waiting;
          await execution.abort();
        },
      };
    });
    h.submissions.push(pending);
    void pending.catch(() => undefined);
    await entered.waiting;
    if (!candidate) throw new Error("Startup did not reach the real rollback boundary");
    const id = producer.registration.handles[0].id;
    const path = join(candidate.run_dir, "run-job.json");
    const before = await io.readFile(path);
    signals = observeSignals();
    expect(h.registry.isSubmissionInFlight(candidate.run_id)).toBe(true);
    expect(h.registry.get(id, h.ownerId).status).toBe("running");
    expect(() => h.registry.kill(id, h.ownerId, "during rollback")).toThrow(
      /submission.*in flight/iu,
    );
    expect(await io.readFile(path)).toEqual(before);
    expect(signals.events).toEqual([]);
    expect(producer.registration.cancellations).toEqual([]);
    signals.restore();
    release.release();
    await expect(pending).rejects.toThrow("running publication failed before rollback");
  } finally {
    signals?.restore();
    release.release();
    await pending?.catch(() => undefined);
    await h.close();
  }
}, 15000);

test("late cancellation rechecks descendant quiescence before publishing a terminal RunJob", async () => {
  const h = await pollFixture();
  const entered = barrier();
  const release = barrier();
  let polling: Promise<void> | undefined;
  let signals: ReturnType<typeof observeSignals> | undefined;
  try {
    await installFakeShud(h.shudBin, 0, "resistant");
    const { record, id, pid, invocation, producer } = await readyRun(h);
    const origin = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(origin);
    let held = false;
    vi.mocked(io.readFile).mockImplementation(async (...args) => {
      if (!held && args[0] === join(record.run_dir, "exit_code")) {
        // This read follows the step's initial cancellation check and its running snapshot.
        held = true;
        entered.release();
        await release.waiting;
      }
      return actualIo.readFile(...args);
    });
    polling = h.registry.pollOnce();
    await entered.waiting;
    expect(readDurable(record.run_dir).cancel_requested_at).toBeNull();
    signals = observeSignals();
    expect(h.registry.kill(id, h.ownerId, "cancel after the first quiescence check")).toBe(
      "requested",
    );
    const intent = readDurable(record.run_dir);
    expect(intent.cancel_requested_at).toBe(new Date(origin).toISOString());
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
    const path = join(record.run_dir, "run-job.json");
    const bytes = await io.readFile(path);
    const mtime = (await io.stat(path, { bigint: true })).mtimeNs;
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

    vi.setSystemTime(origin + 9999);
    release.release();
    await polling;
    // A completion-only guard is insufficient: the durable record itself must remain running.
    expect(readDurable(record.run_dir)).toEqual(intent);
    expect(await io.readFile(path)).toEqual(bytes);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(mtime);
    expect(producer.completed).toEqual([]);
    expect(producer.durableAtSettle).toEqual([]);
    expect(producer.durableAtDone).toEqual([]);
    expect(activeGroup(pid)).toContain(invocation.pid);
    expect(signals.events).toEqual([{ pid: -pid, signal: "SIGTERM" }]);
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
    expect(producer.durableAtSettle[0].finished_at).toEqual(expect.any(String));
    expect(producer.durableAtSettle[0]).toEqual({
      ...intent,
      status: "cancelled",
      exit_code: null,
      finished_at: producer.durableAtSettle[0].finished_at,
    });
    expect(producer.durableAtDone).toEqual(producer.durableAtSettle);
    expect(producer.completed[0].status).toBe("killed");
    expect(producer.registration.cancellations).toEqual([]);
  } finally {
    release.release();
    signals?.restore();
    vi.useRealTimers();
    await polling?.catch(() => undefined);
    await h.close();
  }
}, 15000);

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { JobId, type JobEvent } from "@deepseek-ai/dsh-jobs";
import { KILL_GRACE_PERIOD_MS, type RunJob } from "@shud-harness/dsh-shud-core";
import { expect, test, vi } from "vitest";
import {
  activeGroup,
  readInvocation,
  releaseInvocation,
} from "../../dsh-shud-jobs/src/detached-shud/test-harness.ts";
import { observeSignals, readDurable } from "../../dsh-shud-jobs/src/kill-shud/test-harness.ts";
import { readRecord } from "../../dsh-shud-jobs/src/poll-shud/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";

test.each([0, 13])(
  "native tool run settles exit %s before public completion and collects",
  async (code) => {
    const h = await createToolHarness({ code });
    try {
      const terminalAtEvents: RunJob[] = [];
      h.ctx.jobs.events.subscribe({ owners: "all" }, (event) => {
        if (event.type === "settled") {
          const entry = h.registry.indexes.read().active[0];
          if (!entry) throw new Error("Settlement lost its durable index");
          terminalAtEvents.push(readDurable(entry.run_dir));
        }
      });
      expect((await h.call({ input_dir: h.inputDir })).isError).toBe(false);
      const entry = h.registry.indexes.read().active[0];
      if (!entry) throw new Error("Tool did not submit a run");
      const record = await readRecord(entry.run_dir);
      if (!record.dsh_job_id || !record.pid) throw new Error("Running record omitted identity");
      await expect.poll(() => readInvocation(record.run_dir)).not.toBeNull();
      const invocation = await readInvocation(record.run_dir);
      if (!invocation) throw new Error("Native invocation was not observed");
      await releaseInvocation(invocation);
      const id = JobId(record.dsh_job_id);
      await expect.poll(() => h.registry.get(id).status).toBe(code === 0 ? "completed" : "failed");
      expect(terminalAtEvents).toHaveLength(1);
      const terminal = terminalAtEvents[0];
      if (!terminal) throw new Error("Public completion omitted its durable-state observation");
      expect(terminal.status).toMatch(
        code === 0 ? /^(succeeded|collected)$/u : /^(failed|collected)$/u,
      );
      expect(terminal.exit_code).toBe(code);
      expect(terminal.finished_at).toBeTypeOf("string");
      expect(activeGroup(record.pid)).toEqual([]);
      await expect.poll(async () => (await readRecord(record.run_dir)).status).toBe("collected");
      const collected = await h.registry.collectShud(record.run_id);
      expect(collected).toMatchObject({ exit_code: code, exit_class: code === 0 ? "ok" : "input" });
    } finally {
      await h.dispose();
    }
  },
  15_000,
);

test("public kill of a tool-created run persists intent and reaches actual producer completion", async () => {
  const h = await createToolHarness();
  const signals = observeSignals();
  try {
    expect((await h.call({ input_dir: h.inputDir })).isError).toBe(false);
    const entry = h.registry.indexes.read().active[0];
    if (!entry) throw new Error("Tool did not submit a run");
    const record = await readRecord(entry.run_dir);
    if (!record.dsh_job_id || !record.pid) throw new Error("Running record omitted identity");
    await expect.poll(() => readInvocation(record.run_dir)).not.toBeNull();
    const id = JobId(record.dsh_job_id);
    expect(h.registry.kill(id, h.ownerId, "cancel tool run")).toBe("requested");
    const intent = readDurable(record.run_dir);
    expect(intent.cancel_requested_at).toBeTypeOf("string");
    expect(signals.events).toEqual([{ pid: -record.pid, signal: "SIGTERM" }]);
    await expect.poll(() => h.registry.get(id).status).toBe("killed");
    expect(activeGroup(record.pid)).toEqual([]);
    await expect.poll(async () => (await readRecord(record.run_dir)).status).toBe("collected");
    expect(await h.registry.collectShud(record.run_id)).toMatchObject({
      exit_class: "cancelled",
      exit_code: null,
    });
  } finally {
    signals.restore();
    await h.dispose();
  }
}, 15_000);

test.each([false, true])(
  "tool producer teardown preserves durable state with kill intent=%s",
  async (killing) => {
    const h = await createToolHarness({ mode: killing ? "resistant" : "held" });
    const signals = observeSignals();
    const events: JobEvent[] = [];
    try {
      h.ctx.jobs.events.subscribe({ owners: "all" }, (event) =>
        events.push(structuredClone(event)),
      );
      expect((await h.call({ input_dir: h.inputDir })).isError).toBe(false);
      const entry = h.registry.indexes.read().active[0];
      if (!entry) throw new Error("Tool did not submit a run");
      const record = await readRecord(entry.run_dir);
      if (!record.dsh_job_id || !record.pid) throw new Error("Running record omitted identity");
      await expect.poll(() => readInvocation(record.run_dir)).not.toBeNull();
      const invocation = await readInvocation(record.run_dir);
      if (!invocation) throw new Error("Native invocation was not observed");
      if (killing) {
        expect(h.registry.kill(JobId(record.dsh_job_id), h.ownerId, "stop before reload")).toBe(
          "requested",
        );
        await expect
          .poll(() => readFile(join(record.run_dir, "sigterm-seen"), "utf8"))
          .toBe("SIGTERM\n");
      }
      const intent = readDurable(record.run_dir);
      const deadline =
        intent.cancel_requested_at === null
          ? null
          : Date.parse(intent.cancel_requested_at) + KILL_GRACE_PERIOD_MS;
      const snapshots = await Promise.all(
        [
          join(record.run_dir, "run-job.json"),
          join(h.stateDir, "active.json"),
          join(h.stateDir, "completed.json"),
        ].map(async (path) => ({
          path,
          bytes: await readFile(path),
          mtime: (await stat(path, { bigint: true })).mtimeNs,
        })),
      );
      await h.disposeRegistry();
      const settled = events.filter((event) => event.type === "settled");
      expect(settled).toHaveLength(1);
      const teardown = settled[0];
      if (!teardown || teardown.type !== "settled")
        throw new Error("Teardown omitted its settled event");
      expect(teardown.cause).toBe("teardown");
      expect(teardown.job.status).toBe("failed");
      expect(teardown.job.detail).toMatch(killing ? /kill.*progress/iu : /continu.*background/iu);
      expect(signals.events).toEqual(
        killing
          ? [
              { pid: -record.pid, signal: "SIGTERM" },
              { pid: -record.pid, signal: "SIGTERM" },
            ]
          : [],
      );
      expect(activeGroup(record.pid)).toContain(invocation.pid);
      for (const snapshot of snapshots) {
        expect(await readFile(snapshot.path)).toEqual(snapshot.bytes);
        expect((await stat(snapshot.path, { bigint: true })).mtimeNs).toBe(snapshot.mtime);
      }
      const after = readDurable(record.run_dir);
      expect(after).toEqual(intent);
      expect(
        after.cancel_requested_at === null
          ? null
          : Date.parse(after.cancel_requested_at) + KILL_GRACE_PERIOD_MS,
      ).toBe(deadline);
      await expect(readFile(join(record.run_dir, "run-record.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(h.sessionEvents).toEqual([]);
      expect(h.flushes).toEqual([]);
    } finally {
      signals.restore();
      await h.dispose();
    }
  },
  15_000,
);

test("a repeated kill cannot reset the native tool producer's original escalation deadline", async () => {
  const h = await createToolHarness({ mode: "resistant" });
  const signals = observeSignals();
  try {
    expect((await h.call({ input_dir: h.inputDir })).isError).toBe(false);
    const entry = h.registry.indexes.read().active[0];
    if (!entry) throw new Error("Tool did not submit a run");
    const record = await readRecord(entry.run_dir);
    if (!record.dsh_job_id || !record.pid) throw new Error("Running record omitted identity");
    await expect.poll(() => readInvocation(record.run_dir)).not.toBeNull();
    const id = JobId(record.dsh_job_id);
    const origin = Date.now();
    // Only wall-clock observations are controlled; process I/O, signals and polling are native.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(origin);
    expect(h.registry.kill(id, h.ownerId, "first request")).toBe("requested");
    await expect
      .poll(() => readFile(join(record.run_dir, "sigterm-seen"), "utf8"))
      .toBe("SIGTERM\n");
    const intent = readDurable(record.run_dir).cancel_requested_at;
    expect(intent).toBe(new Date(origin).toISOString());
    vi.setSystemTime(origin + 5000);
    expect(h.registry.kill(id, h.ownerId, "repeated request")).toBe("requested");
    expect(readDurable(record.run_dir).cancel_requested_at).toBe(intent);
    vi.setSystemTime(origin + 9999);
    await h.registry.pollOnce();
    expect(readDurable(record.run_dir).status).toBe("running");
    expect(signals.events).toEqual([{ pid: -record.pid, signal: "SIGTERM" }]);
    vi.setSystemTime(origin + 10000);
    await expect.poll(() => h.registry.get(id).status).toBe("killed");
    expect(signals.events).toEqual([
      { pid: -record.pid, signal: "SIGTERM" },
      { pid: -record.pid, signal: "SIGKILL" },
    ]);
    expect(activeGroup(record.pid)).toEqual([]);
    expect(readDurable(record.run_dir).cancel_requested_at).toBe(intent);
  } finally {
    vi.useRealTimers();
    signals.restore();
    await h.dispose();
  }
}, 15_000);

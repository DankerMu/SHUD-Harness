import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { JobId, type JobEvent } from "@deepseek-ai/dsh-jobs";
import { ShudJobRegistry } from "./index.ts";
import { expectAbsent } from "./collect-shud/test-harness.ts";
import { activeGroup, observedStart, readInvocation } from "./detached-shud/test-harness.ts";
import { observeSignals } from "./kill-shud/test-harness.ts";
import {
  pollFixture,
  readRecord,
  releaseRun,
  settlingProducer,
  waitForEvidence,
  waitForOwnershipRelease,
} from "./poll-shud/test-harness.ts";
import {
  closeRecovery,
  completedWithinWindow,
  stopAtSubmitted,
  waitForRecovery,
} from "./reconcile-shud/test-harness.ts";
import { actualRegistry, injectedRegistry } from "./submit-shud/test-harness.ts";
import { producer as ordinaryProducer } from "./test-harness.ts";
import { deliveredWake, expectSingleWake } from "./wake-shud/test-harness.ts";

test("R5 takeover without external controllers registers the original labelled execution once and collects its exit", async () => {
  const h = await pollFixture();
  let pid: number | undefined;
  let applying: Promise<unknown> | undefined;
  let restoreSignals: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    expect(() => h.registry.start(ordinaryProducer().spec)).toThrow(
      "no job controller serves this agent",
    );
    const label = "held takeover tracer";
    const originalProducer = settlingProducer();
    h.producers.push(originalProducer);
    const submission = h.registry.submitShud({ ...h.request, label }, originalProducer.start);
    h.submissions.push(submission);
    await completedWithinWindow(submission);
    const record = await submission;
    if (record.pid === null || record.dsh_job_id === null)
      throw new Error("Original SHUD run has no committed process or registration identity");
    pid = record.pid;
    const oldId = JobId(record.dsh_job_id);
    expect(record.label).toBe(label);
    expect(record.dsh_job_ids).toEqual([oldId]);
    const originalView = h.registry.get(oldId);
    expect(originalView.label).toBe(`${record.run_id} ${label}`);
    expect(originalView.owner).toBeUndefined();
    waitForEvidence(record.run_dir, "invocation.json");
    const invocation = await readInvocation(record.run_dir);
    if (!invocation) throw new Error("Original held solver did not publish its invocation");
    const invocationPath = join(record.run_dir, "invocation.json");
    const invocationBytes = await io.readFile(invocationPath);
    const invocationMtime = (await io.stat(invocationPath, { bigint: true })).mtimeNs;
    const path = join(record.run_dir, "run-job.json");
    const originalBytes = await io.readFile(path);
    const originalMtime = (await io.stat(path, { bigint: true })).mtimeNs;
    const signals = observeSignals();
    restoreSignals = signals.restore;

    await completedWithinWindow(
      Promise.all([h.fiber.dispose(), originalProducer.executions[0].hooks.done]),
    );
    await waitForOwnershipRelease(h.stateDir);
    expect(await readRecord(record.run_dir)).toEqual(record);
    expect(await io.readFile(path)).toEqual(originalBytes);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(originalMtime);
    expect(activeGroup(pid)).toContain(pid);
    expect(activeGroup(pid)).toContain(invocation.pid);
    expect(signals.events).toEqual([]);

    // Only startup may create the replacement registration; normal interval ticks stay frozen.
    // Native execution, Date, output-pump timeouts and bounded barriers remain real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    await completedWithinWindow(applying);
    const replacement = actualRegistry(h.ctx);
    expect(replacement).not.toBe(h.registry);
    const listed = replacement.list();
    // The baseline RED is missing consumer-visible registration, not an absent new API.
    expect(listed).toHaveLength(1);
    const adopted = listed[0];
    if (!adopted) throw new Error("Takeover registration is absent");
    expect(adopted).toMatchObject({
      kind: "shud",
      label: `${record.run_id} ${label}`,
      status: "running",
    });
    expect(adopted.owner).toBeUndefined();
    expect(adopted.id).not.toBe(oldId);
    expect(replacement.get(adopted.id)).toEqual(adopted);
    const expected = {
      ...record,
      dsh_job_id: adopted.id,
      dsh_job_ids: [...record.dsh_job_ids, adopted.id],
    };
    expect(await readRecord(record.run_dir)).toEqual(expected);
    expect(observedStart(pid)).toBe(record.pid_started_at);
    expect(activeGroup(pid)).toContain(pid);
    expect(activeGroup(pid)).toContain(invocation.pid);
    expect(await io.readFile(invocationPath)).toEqual(invocationBytes);
    expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(invocationMtime);
    await expectAbsent(join(record.run_dir, "run-record.json"));
    await expectAbsent(join(record.run_dir, "exit_code"));
    expect(() => replacement.start(ordinaryProducer().spec)).toThrow(
      "no job controller serves this agent",
    );
    await waitForRecovery(
      () =>
        replacement
          .readAt(adopted.id, 0)
          .chunks.map((chunk) => chunk.text)
          .join("") === "fake stdout\n",
      "the adopted registration's original stdout",
    );

    const events: JobEvent[] = [];
    unsubscribe = h.ctx.jobs.events.subscribe({ owners: "all" }, (event) => {
      events.push(structuredClone(event));
    });
    const adoptedBytes = await io.readFile(path);
    const adoptedMtime = (await io.stat(path, { bigint: true })).mtimeNs;
    for (let tick = 0; tick < 3; tick++) await completedWithinWindow(replacement.pollOnce());
    expect(replacement.list().map((job) => job.id)).toEqual([adopted.id]);
    expect(events.filter((event) => event.type === "registered")).toEqual([]);
    expect(await readRecord(record.run_dir)).toEqual(expected);
    expect(await io.readFile(path)).toEqual(adoptedBytes);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(adoptedMtime);

    await releaseRun(record);
    await completedWithinWindow(replacement.pollOnce());
    await waitForRecovery(
      () => replacement.get(adopted.id).status === "completed",
      "the adopted parent registration's natural completion",
    );
    await completedWithinWindow(replacement.pollOnce());
    const result = await replacement.collectShud(record.run_id);
    expect(result).toMatchObject({
      run_id: record.run_id,
      job_id: record.job_id,
      exit_code: 0,
      exit_class: "ok",
      resources: { wall_seconds: null },
    });
    const collected = await readRecord(record.run_dir);
    expect(collected.finished_at).toEqual(expect.any(String));
    expect(collected).toEqual({
      ...expected,
      status: "collected",
      exit_code: 0,
      finished_at: collected.finished_at,
    });
    expect(events.filter((event) => event.type === "settled")).toMatchObject([
      { cause: "producer", job: { id: adopted.id, status: "completed" } },
    ]);
    expect(await io.readFile(invocationPath)).toEqual(invocationBytes);
    expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(invocationMtime);
    await completedWithinWindow(originalProducer.executions[0].waitForExit());
    expect(activeGroup(pid)).toEqual([]);
    expect(signals.events).toEqual([]);
    expect(originalProducer.attempts).toEqual([]);
    expect(replacement.indexes.read().active.map((entry) => entry.run_id)).toEqual([record.run_id]);
    expect(replacement.indexes.read().completed).toEqual([]);
    expect(h.sessionEvents).toEqual([]);
    expect(h.flushes).toEqual([]);
    expect(h.errors).toEqual([]);
    const resultPath = join(record.run_dir, "run-record.json");
    const resultBytes = await io.readFile(resultPath);
    const resultMtime = (await io.stat(resultPath, { bigint: true })).mtimeNs;
    expect(result.artifacts.files).toEqual([]);
    await h.mountSessionController();
    await deliveredWake(replacement, record.run_dir);
    expectSingleWake(h, record.run_id, "ok", 0);
    expect((await readRecord(record.run_dir)).notify).toMatchObject({
      status: "delivered",
      attempts: 0,
    });
    expect(replacement.indexes.read()).toEqual({
      active: [],
      completed: [{ run_id: record.run_id, job_id: record.job_id, run_dir: record.run_dir }],
    });
    expect(await io.readFile(resultPath)).toEqual(resultBytes);
    expect((await io.stat(resultPath, { bigint: true })).mtimeNs).toBe(resultMtime);
    expect(await io.readFile(invocationPath)).toEqual(invocationBytes);
  } finally {
    restoreSignals?.();
    unsubscribe?.();
    try {
      await closeRecovery(h, pid, applying);
    } finally {
      vi.useRealTimers();
    }
  }
}, 15000);

test("R3 promotion with the actual submission timestamp exposes takeover to a later preset-only caller", async () => {
  const h = await pollFixture();
  let pid: number | undefined;
  let applying: Promise<unknown> | undefined;
  let restoreSignals: (() => void) | undefined;
  try {
    const running = await stopAtSubmitted(h);
    pid = running.pid;
    const { record, submitted, invocation, stamp } = running;
    expect(submitted.submitted_at).toBe(record.submitted_at);
    expect(submitted).toMatchObject({
      status: "submitted",
      pid: null,
      pid_started_at: null,
      started_at: null,
    });
    expect(record.label).toBeNull();
    expect(await readRecord(record.run_dir)).toEqual(submitted);
    const invocationPath = join(record.run_dir, "invocation.json");
    const invocationBytes = await io.readFile(invocationPath);
    const invocationMtime = (await io.stat(invocationPath, { bigint: true })).mtimeNs;
    await expectAbsent(join(record.run_dir, "run-record.json"));
    await expectAbsent(join(record.run_dir, "exit_code"));
    const signals = observeSignals();
    restoreSignals = signals.restore;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    await completedWithinWindow(applying);
    const replacement = actualRegistry(h.ctx);
    const promoted = await readRecord(record.run_dir);
    // Existing R3 promotion must pass before the missing-registration RED is reached.
    expect(promoted).toMatchObject({
      status: "running",
      pid,
      pid_started_at: stamp,
      started_at: stamp,
      submitted_at: record.submitted_at,
    });
    const listed = replacement.list();
    expect(listed).toHaveLength(1);
    const adopted = listed[0];
    if (!adopted) throw new Error("Promoted R3 run has no takeover registration");
    expect(adopted).toMatchObject({ kind: "shud", label: record.run_id, status: "running" });
    expect(adopted.owner).toBeUndefined();
    expect(adopted.id).not.toBe(record.dsh_job_id);
    expect(promoted).toEqual({
      ...submitted,
      status: "running",
      pid,
      pid_started_at: stamp,
      started_at: stamp,
      dsh_job_id: adopted.id,
      dsh_job_ids: [...submitted.dsh_job_ids, adopted.id],
    });

    // This controller is deliberately mounted after readiness. It proves preset-only visibility,
    // not controller availability during startup; takeover must not wait for this consumer.
    await completedWithinWindow(h.attachController(true));
    const scopedPending = injectedRegistry(h.presetCtx);
    await completedWithinWindow(scopedPending);
    const scoped = await scopedPending;
    expect(scoped.list(h.ownerId).map((job) => job.id)).toEqual([adopted.id]);
    expect(scoped.get(adopted.id, h.ownerId)).toMatchObject({
      id: adopted.id,
      kind: "shud",
      label: record.run_id,
      status: "running",
    });
    expect(() => h.ctx.jobs.start(ordinaryProducer().spec)).toThrow(
      "no job controller serves this agent",
    );
    expect(() => scoped.start(ordinaryProducer().spec)).toThrow(
      "no job controller serves this agent",
    );
    const path = join(record.run_dir, "run-job.json");
    const publishedBytes = await io.readFile(path);
    const publishedMtime = (await io.stat(path, { bigint: true })).mtimeNs;
    await completedWithinWindow(replacement.pollOnce());
    expect(scoped.list(h.ownerId).map((job) => job.id)).toEqual([adopted.id]);
    expect(await io.readFile(path)).toEqual(publishedBytes);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(publishedMtime);
    expect(await io.readFile(invocationPath)).toEqual(invocationBytes);
    expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(invocationMtime);
    expect(observedStart(pid)).toBe(stamp);
    expect(activeGroup(pid)).toContain(pid);
    expect(activeGroup(pid)).toContain(invocation.pid);
    expect(signals.events).toEqual([]);
    expect(h.sessionEvents).toEqual([]);
    expect(h.flushes).toEqual([]);
    expect(h.errors).toEqual([]);
    await h.mountSessionController();
    await releaseRun(record);
    await deliveredWake(replacement, record.run_dir);
    expect(await replacement.collectShud(record.run_id)).toMatchObject({
      exit_code: 0,
      exit_class: "ok",
      artifacts: { files: [] },
      resources: { wall_seconds: null },
    });
    expectSingleWake(h, record.run_id, "ok", 0);
    expect(await readRecord(record.run_dir)).toMatchObject({
      status: "collected",
      pid,
      pid_started_at: stamp,
      dsh_job_id: adopted.id,
      dsh_job_ids: promoted.dsh_job_ids,
      notify: { status: "delivered", attempts: 0 },
    });
    expect(replacement.indexes.read()).toEqual({
      active: [],
      completed: [{ run_id: record.run_id, job_id: record.job_id, run_dir: record.run_dir }],
    });
    expect(await io.readFile(invocationPath)).toEqual(invocationBytes);
    expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(invocationMtime);
    expect(running.producer.attempts).toEqual([]);
  } finally {
    restoreSignals?.();
    try {
      await closeRecovery(h, pid, applying);
    } finally {
      vi.useRealTimers();
    }
  }
}, 15000);

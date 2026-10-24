import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { RunJob, RunRecord } from "@shud-harness/dsh-shud-core";
import type { IndexSnapshot } from "./state-indexes.ts";
import { ShudJobRegistry } from "./index.ts";
import { outputRoot, readResult } from "./collect-shud/test-harness.ts";
import { readInvocation } from "./detached-shud/test-harness.ts";
import {
  pollFixture,
  readRecord,
  releaseRun,
  settlingProducer,
  waitForEvidence,
  waitForOwnershipRelease,
} from "./poll-shud/test-harness.ts";
import { barrier, persisted } from "./state-indexes/test-harness.ts";
import { captureEvents } from "./test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";

test("online completion wakes its owner once and only acknowledged flush completes the durable entry", async () => {
  const h = await pollFixture(0, "held", "available");
  const resumeFlush = barrier();
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
  let atFlush:
    | {
        job: RunJob;
        indexes: IndexSnapshot;
        result: RunRecord;
        bytes: Buffer;
        mtime: bigint;
      }
    | undefined;
  const flushSpy = vi.spyOn(h.ctx.sessions, "flush");
  try {
    const events = await captureEvents(h.ctx);
    const { producer, pending } = h.start();
    const running = await pending;
    const entry = {
      run_id: running.run_id,
      job_id: running.job_id,
      run_dir: running.run_dir,
    };
    const resultPath = join(running.run_dir, "run-record.json");
    flushSpy.mockImplementation(async (session) => {
      // The real seam double observes accepted messages; withhold its positive acknowledgement.
      const acknowledged = await flush(session);
      atFlush = {
        job: await readRecord(running.run_dir),
        indexes: h.registry.indexes.read(),
        result: await readResult(running.run_dir),
        bytes: await io.readFile(resultPath),
        mtime: (await io.stat(resultPath, { bigint: true })).mtimeNs,
      };
      await resumeFlush.waiting;
      return acknowledged;
    });
    waitForEvidence(running.run_dir, "invocation.json");
    const invocation = await readInvocation(running.run_dir);
    expect(invocation).toMatchObject({
      ppid: running.pid,
      cwd: running.run_dir,
      argv: ["-o", "output/tiny.out", "tiny"],
    });
    await io.mkdir(outputRoot(running));
    await io.writeFile(join(outputRoot(running), "hydrograph.dat"), "1 2\n");
    expect(h.followups).toEqual([]);
    expect(producer.completed).toEqual([]);
    await releaseRun(running);

    // Observe actual conditions: a manual poll may join an older accepted running snapshot.
    // Keep Date, native processes, pump cadence and bounded observation timeouts real.
    await expect
      .poll(async () => (await readRecord(running.run_dir)).status, { timeout: 5000 })
      .toBe("collected");
    const collected = await readResult(running.run_dir);
    expect(collected).toMatchObject({
      run_id: running.run_id,
      job_id: running.job_id,
      status: "succeeded",
      exit_code: 0,
      exit_class: "ok",
      command: running.command,
      artifacts: { files: [{ path: "hydrograph.dat", size_bytes: 4 }] },
    });
    await expect.poll(() => h.followups.length, { timeout: 5000 }).toBe(1);
    await expect.poll(() => atFlush !== undefined, { timeout: 5000 }).toBe(true);
    if (!atFlush) throw new Error("Wake never reached the flush acknowledgement barrier");
    const [{ sessionId, message }] = h.followups;
    expect(sessionId).toBe(h.ownerId);
    expect(message).toMatchObject({ role: "user", source: { kind: "shud-jobs" } });
    expect(message.id).toEqual(expect.any(String));
    const text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    expect(text).toContain(running.run_id);
    expect(text).toMatch(/\bok\b/u);
    expect(text).toMatch(/\b1\b/u);
    expect(h.flushObservations).toEqual([{ sessionId: h.ownerId, messages: [message] }]);
    expect(atFlush.job.notify).toMatchObject({ status: "pending", attempts: 0 });
    expect(atFlush.indexes).toEqual({ active: [entry], completed: [] });
    expect(atFlush.result).toEqual(collected);
    expect(await persisted(h.stateDir)).toEqual([entry]);
    expect(await persisted(h.stateDir, "completed.json")).toEqual([]);
    expect((await readRecord(running.run_dir)).notify.status).toBe("pending");

    resumeFlush.release();
    await expect
      .poll(async () => (await readRecord(running.run_dir)).notify.status, { timeout: 5000 })
      .toBe("delivered");
    await expect
      .poll(() => h.registry.indexes.read(), { timeout: 5000 })
      .toEqual({ active: [], completed: [entry] });
    // Drain another ordinary step: finished notification/index repair must not send again.
    await h.registry.pollOnce();
    await h.registry.pollOnce();
    const delivered = await readRecord(running.run_dir);
    expect(delivered).toEqual({ ...atFlush.job, notify: delivered.notify });
    expect(delivered.notify).toMatchObject({ status: "delivered", attempts: 0 });
    expect(delivered.pid).toBe(running.pid);
    expect(delivered.pid_started_at).toBe(running.pid_started_at);
    expect(await persisted(h.stateDir)).toEqual([]);
    expect(await persisted(h.stateDir, "completed.json")).toEqual([entry]);
    expect(await h.registry.collectShud(running.run_id)).toEqual(collected);
    expect(await io.readFile(resultPath)).toEqual(atFlush.bytes);
    expect((await io.stat(resultPath, { bigint: true })).mtimeNs).toBe(atFlush.mtime);
    expect(await readInvocation(running.run_dir)).toEqual(invocation);
    expect(await io.readFile(join(running.run_dir, "exit_code"), "utf8")).toBe("0\n");
    expect(producer.executions).toHaveLength(1);
    expect(producer.attempts).toHaveLength(1);
    expect(producer.completed).toEqual([expect.objectContaining({ status: "completed" })]);
    expect(producer.durableAtSettle[0]).toMatchObject({ status: "succeeded", exit_code: 0 });
    expect(producer.registration.cancellations).toEqual([]);
    expect(events.filter((event) => event.type === "settled")).toHaveLength(1);
    expect(h.sessionEvents.filter((event) => event.type === "job/settled")).toEqual([]);
    expect(h.followups).toEqual([{ sessionId: h.ownerId, message }]);
    expect(h.flushes).toEqual([h.ownerId]);
    expect(h.errors).toEqual([]);
  } finally {
    resumeFlush.release();
    try {
      await h.close();
    } finally {
      flushSpy.mockRestore();
    }
  }
}, 15000);

test("a collected run waits durably through registry reload and wakes once when its controller mounts late", async () => {
  const h = await pollFixture(0, "held", "absent");
  try {
    const { producer, pending } = h.start();
    const running = await pending;
    const entry = {
      run_id: running.run_id,
      job_id: running.job_id,
      run_dir: running.run_dir,
    };
    await releaseRun(running);
    const invocation = await readInvocation(running.run_dir);
    expect(invocation).toMatchObject({ ppid: running.pid, cwd: running.run_dir });
    await expect
      .poll(async () => (await readRecord(running.run_dir)).status, { timeout: 5000 })
      .toBe("collected");
    const result = await readResult(running.run_dir);
    expect(result).toMatchObject({
      run_id: running.run_id,
      exit_code: 0,
      exit_class: "ok",
      artifacts: { files: [] },
    });
    const resultPath = join(running.run_dir, "run-record.json");
    const resultBytes = await io.readFile(resultPath);
    const resultMtime = (await io.stat(resultPath, { bigint: true })).mtimeNs;
    const active = actualRegistry(h.ctx);
    await active.pollOnce();
    expect(active.indexes.read()).toEqual({ active: [entry], completed: [] });
    expect((await readRecord(running.run_dir)).notify).toMatchObject({
      status: "pending",
      attempts: running.notify.attempts,
      at: running.notify.at,
    });
    expect(h.followups).toEqual([]);
    expect(h.flushes).toEqual([]);
    // Missing optional services are a durable waiting condition, not a failed delivery attempt.
    await expect
      .poll(async () => (await readRecord(running.run_dir)).notify.detail, { timeout: 5000 })
      .toMatch(/wait.*session|session.*wait/iu);
    await active.pollOnce();
    const waiting = await readRecord(running.run_dir);
    const jobPath = join(running.run_dir, "run-job.json");
    const waitingBytes = await io.readFile(jobPath);
    const waitingMtime = (await io.stat(jobPath, { bigint: true })).mtimeNs;
    for (let tick = 0; tick < 3; tick++) await active.pollOnce();
    expect(await io.readFile(jobPath)).toEqual(waitingBytes);
    expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(waitingMtime);
    expect(waiting.notify).toMatchObject({
      status: "pending",
      attempts: running.notify.attempts,
      at: running.notify.at,
    });
    expect(h.followups).toEqual([]);
    expect(h.flushes).toEqual([]);
    expect(h.errors).toEqual([]);

    await h.fiber.dispose();
    await waitForOwnershipRelease(h.stateDir);
    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    const replacement = actualRegistry(h.ctx);
    await replacement.pollOnce();
    expect(replacement.indexes.read()).toEqual({ active: [entry], completed: [] });
    expect(await io.readFile(jobPath)).toEqual(waitingBytes);
    expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(waitingMtime);
    expect(h.followups).toEqual([]);
    expect(h.flushes).toEqual([]);

    await h.mountSessionController();
    await expect
      .poll(async () => (await readRecord(running.run_dir)).notify.status, { timeout: 5000 })
      .toBe("delivered");
    await expect
      .poll(() => replacement.indexes.read(), { timeout: 5000 })
      .toEqual({ active: [], completed: [entry] });
    await replacement.pollOnce();
    await replacement.pollOnce();
    expect(h.followups).toHaveLength(1);
    const [{ sessionId, message }] = h.followups;
    expect(sessionId).toBe(h.ownerId);
    expect(message).toMatchObject({ role: "user", source: { kind: "shud-jobs" } });
    expect(message.id).toEqual(expect.any(String));
    const text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    expect(text).toContain(running.run_id);
    expect(text).toMatch(/\bok\b/u);
    expect(text).toMatch(/\b0\b/u);
    expect(h.flushes).toEqual([h.ownerId]);
    expect(h.flushObservations).toEqual([{ sessionId: h.ownerId, messages: [message] }]);
    expect(h.sessionEvents.filter((event) => event.type === "job/settled")).toEqual([]);
    const delivered = await readRecord(running.run_dir);
    expect(delivered).toEqual({ ...waiting, notify: delivered.notify });
    expect(delivered.notify).toMatchObject({ status: "delivered", attempts: 0 });
    expect(await persisted(h.stateDir)).toEqual([]);
    expect(await persisted(h.stateDir, "completed.json")).toEqual([entry]);
    expect(await replacement.collectShud(running.run_id)).toEqual(result);
    expect(await io.readFile(resultPath)).toEqual(resultBytes);
    expect((await io.stat(resultPath, { bigint: true })).mtimeNs).toBe(resultMtime);
    expect(await readInvocation(running.run_dir)).toEqual(invocation);
    expect(producer.executions).toHaveLength(1);
    expect(producer.attempts).toHaveLength(1);
    expect(producer.registration.cancellations).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally {
    await h.close();
  }
}, 15000);

test.each(["null owner", "deleted session"] as const)(
  "%s becomes unreachable without a wake or retry, but only after session services are ready",
  async (kind) => {
    const h = await pollFixture(0, "held", kind === "null owner" ? "absent" : "available");
    const owner = kind === "null owner" ? null : h.ownerId;
    const producer = settlingProducer();
    h.producers.push(producer);
    try {
      const pending = h.registry.submitShud({ ...h.request, owner_session: owner }, producer.start);
      h.submissions.push(pending);
      const running = await pending;
      const entry = {
        run_id: running.run_id,
        job_id: running.job_id,
        run_dir: running.run_dir,
      };
      waitForEvidence(running.run_dir, "invocation.json");
      const invocation = await readInvocation(running.run_dir);
      expect(invocation).toMatchObject({ ppid: running.pid, cwd: running.run_dir });
      const registration = producer.registration.handles[0].id;
      expect(h.registry.get(registration).owner).toBeUndefined();
      if (kind === "deleted session") await h.releaseOwner();
      expect(h.registry.get(registration).status).toBe("running");
      expect(producer.completed).toEqual([]);
      expect(producer.registration.cancellations).toEqual([]);
      await releaseRun(running);
      await expect
        .poll(async () => (await readRecord(running.run_dir)).status, { timeout: 5000 })
        .toBe("collected");
      const result = await readResult(running.run_dir);
      expect(result).toMatchObject({
        run_id: running.run_id,
        exit_code: 0,
        exit_class: "ok",
      });
      const resultPath = join(running.run_dir, "run-record.json");
      const resultBytes = await io.readFile(resultPath);
      const resultMtime = (await io.stat(resultPath, { bigint: true })).mtimeNs;
      if (kind === "null owner") {
        await expect
          .poll(async () => (await readRecord(running.run_dir)).notify.detail, { timeout: 5000 })
          .toMatch(/wait.*session|session.*wait/iu);
        await h.registry.pollOnce();
        const waiting = await readRecord(running.run_dir);
        expect(waiting.notify.detail).toMatch(/wait.*session|session.*wait/iu);
        expect(waiting).toMatchObject({
          owner_session: null,
          notify: {
            status: "pending",
            attempts: running.notify.attempts,
            at: running.notify.at,
          },
        });
        expect(h.registry.indexes.read()).toEqual({ active: [entry], completed: [] });
        expect(h.resolutions).toEqual([]);
        expect(h.followups).toEqual([]);
        expect(h.flushes).toEqual([]);
        await h.mountSessionController();
      }
      await expect
        .poll(async () => (await readRecord(running.run_dir)).notify.status, { timeout: 5000 })
        .toBe("unreachable");
      await expect
        .poll(() => h.registry.indexes.read(), { timeout: 5000 })
        .toEqual({ active: [], completed: [entry] });
      const unreachable = await readRecord(running.run_dir);
      expect(unreachable).toMatchObject({
        status: "collected",
        owner_session: owner,
        pid: running.pid,
        pid_started_at: running.pid_started_at,
        notify: { status: "unreachable", attempts: 0 },
      });
      expect(unreachable.notify.detail).toMatch(
        kind === "null owner"
          ? /owner.*(?:missing|null|absent)|(?:no|missing|null|absent).*owner/iu
          : /session.*(?:not.found|missing|deleted)|(?:not.found|missing|deleted).*session/iu,
      );
      expect(unreachable.notify.detail).not.toContain("PRIVATE_SESSION_RESTORE_DETAIL");
      expect(h.errors.join("\n")).not.toContain("PRIVATE_SESSION_RESTORE_DETAIL");
      expect(h.resolutions).toEqual(kind === "null owner" ? [] : [h.ownerId]);
      expect(h.followups).toEqual([]);
      expect(h.flushes).toEqual([]);
      expect(producer.completed).toEqual([expect.objectContaining({ status: "completed" })]);
      expect(producer.durableAtSettle[0]).toMatchObject({ status: "succeeded", exit_code: 0 });
      expect(producer.registration.cancellations).toEqual([]);

      const jobPath = join(running.run_dir, "run-job.json");
      const unreachableBytes = await io.readFile(jobPath);
      const unreachableMtime = (await io.stat(jobPath, { bigint: true })).mtimeNs;
      await h.fiber.dispose();
      await waitForOwnershipRelease(h.stateDir);
      await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      const replacement = actualRegistry(h.ctx);
      await replacement.pollOnce();
      await replacement.pollOnce();
      expect(replacement.indexes.read()).toEqual({ active: [], completed: [entry] });
      expect(await persisted(h.stateDir)).toEqual([]);
      expect(await persisted(h.stateDir, "completed.json")).toEqual([entry]);
      expect(await readRecord(running.run_dir)).toEqual(unreachable);
      expect(await io.readFile(jobPath)).toEqual(unreachableBytes);
      expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(unreachableMtime);
      expect(await replacement.collectShud(running.run_id)).toEqual(result);
      expect(await io.readFile(resultPath)).toEqual(resultBytes);
      expect((await io.stat(resultPath, { bigint: true })).mtimeNs).toBe(resultMtime);
      expect(await readInvocation(running.run_dir)).toEqual(invocation);
      expect(producer.executions).toHaveLength(1);
      expect(producer.attempts).toHaveLength(1);
      expect(h.resolutions).toEqual(kind === "null owner" ? [] : [h.ownerId]);
      expect(h.followups).toEqual([]);
      expect(h.flushes).toEqual([]);
      expect(h.sessionEvents.filter((event) => event.type === "job/settled")).toEqual([]);
      expect(h.errors.join("\n")).not.toContain("PRIVATE_SESSION_RESTORE_DETAIL");
    } finally {
      await h.close();
    }
  },
  15000,
);

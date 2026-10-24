import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { collectedWake, deliveredWake, expectWakeEvidence } from "./wake-shud/test-harness.ts";
import { MAX_NOTIFY_ATTEMPTS, NOTIFY_RETRY_INTERVAL_MS } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { outputRoot, readResult } from "./collect-shud/test-harness.ts";
import { readInvocation } from "./detached-shud/test-harness.ts";
import {
  pollFixture,
  readRecord,
  releaseRun,
  waitForEvidence,
  waitForOwnershipRelease,
} from "./poll-shud/test-harness.ts";
import { waitForRecovery } from "./reconcile-shud/test-harness.ts";
import { persisted } from "./state-indexes/test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";

test("a failed flush retries its accepted wake only after ten seconds without appending another message", async () => {
  // Start at the real wall clock; freeze only accounting and cadence, not native/pump timeouts.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const h = await pollFixture(0, "held", "available").catch((error: unknown) => {
    vi.useRealTimers();
    throw error;
  });
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
  const acknowledgements: boolean[] = [];
  const flushSpy = vi.spyOn(h.ctx.sessions, "flush").mockImplementation(async (session) => {
    // Preserve the real seam's live-session validation and accepted-buffer observations.
    const acknowledged = await flush(session);
    const result = acknowledgements.length === 0 ? false : acknowledged;
    acknowledgements.push(result);
    return result;
  });
  try {
    const { producer, pending } = h.start();
    const running = await pending;
    waitForEvidence(running.run_dir, "invocation.json");
    const invocation = await readInvocation(running.run_dir);
    expect(invocation).toMatchObject({ ppid: running.pid, cwd: running.run_dir });
    // Native identity is established before choosing the controlled failure/retry timestamps.
    const origin = vi.getRealSystemTime();
    vi.setSystemTime(origin);
    await io.mkdir(outputRoot(running));
    await io.writeFile(join(outputRoot(running), "hydrograph.dat"), "1 2\n");
    await releaseRun(running);
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      return (await readRecord(running.run_dir)).status === "collected";
    }, "real collection before the first notification attempt");
    const result = await readResult(running.run_dir);
    expect(result).toMatchObject({
      run_id: running.run_id,
      exit_code: 0,
      exit_class: "ok",
      artifacts: { files: [{ path: "hydrograph.dat", size_bytes: 4 }] },
    });
    const resultPath = join(running.run_dir, "run-record.json");
    const resultBytes = await io.readFile(resultPath);
    const resultMtime = (await io.stat(resultPath, { bigint: true })).mtimeNs;
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      return h.flushes.length > 0;
    }, "the first flush observing an accepted wake");
    expect(acknowledgements).toEqual([false]);
    expect(h.flushes).toEqual([h.ownerId]);
    expect(h.followups).toHaveLength(1);
    const [{ sessionId, message }] = h.followups;
    expect(sessionId).toBe(h.ownerId);
    expect(message).toMatchObject({ role: "user", source: { kind: "shud-jobs" } });
    expect(message.id).toEqual(expect.any(String));
    expect(h.flushObservations).toEqual([{ sessionId: h.ownerId, messages: [message] }]);
    const failed = await readRecord(running.run_dir);
    // The completed manual step must have durably counted its actual false acknowledgement.
    expect(failed.notify.detail).toMatch(/flush|persist|acknowledg/iu);
    expect(failed.notify).toMatchObject({
      status: "pending",
      attempts: 1,
      at: new Date(origin).toISOString(),
    });
    const entry = {
      run_id: running.run_id,
      job_id: running.job_id,
      run_dir: running.run_dir,
    };
    expect(h.registry.indexes.read()).toEqual({ active: [entry], completed: [] });
    const jobPath = join(running.run_dir, "run-job.json");
    const failedBytes = await io.readFile(jobPath);
    const failedMtime = (await io.stat(jobPath, { bigint: true })).mtimeNs;
    for (const offset of [100, 500, 1000, -1000, NOTIFY_RETRY_INTERVAL_MS - 1]) {
      vi.setSystemTime(origin + offset);
      for (let tick = 0; tick < 3; tick++) await h.registry.pollOnce();
      expect(h.followups).toEqual([{ sessionId: h.ownerId, message }]);
      expect(h.flushes).toEqual([h.ownerId]);
      expect(acknowledgements).toEqual([false]);
      expect(await io.readFile(jobPath)).toEqual(failedBytes);
      expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(failedMtime);
    }

    vi.setSystemTime(origin + NOTIFY_RETRY_INTERVAL_MS);
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      return (await readRecord(running.run_dir)).notify.status === "delivered";
    }, "acknowledged retry at the original ten-second boundary");
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      return h.registry.indexes.read().active.length === 0;
    }, "completed-index migration after the successful retry");
    const delivered = await readRecord(running.run_dir);
    expect(delivered).toEqual({
      ...failed,
      notify: {
        status: "delivered",
        attempts: 1,
        at: new Date(origin + NOTIFY_RETRY_INTERVAL_MS).toISOString(),
        detail: null,
      },
    });
    expect(acknowledgements).toEqual([false, true]);
    expect(h.followups).toEqual([{ sessionId: h.ownerId, message }]);
    expect(h.flushes).toEqual([h.ownerId, h.ownerId]);
    // The second real flush sees the same retained buffer, not a new append after failure.
    expect(h.flushObservations).toEqual([
      { sessionId: h.ownerId, messages: [message] },
      { sessionId: h.ownerId, messages: [message] },
    ]);
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [entry] });
    expect(await persisted(h.stateDir)).toEqual([]);
    expect(await persisted(h.stateDir, "completed.json")).toEqual([entry]);
    expect(await h.registry.collectShud(running.run_id)).toEqual(result);
    expect(await io.readFile(resultPath)).toEqual(resultBytes);
    expect((await io.stat(resultPath, { bigint: true })).mtimeNs).toBe(resultMtime);
    expect(await readInvocation(running.run_dir)).toEqual(invocation);
    expect(producer.executions).toHaveLength(1);
    expect(producer.attempts).toHaveLength(1);
    expect(producer.registration.cancellations).toEqual([]);
    expect(h.sessionEvents.filter((event) => event.type === "job/settled")).toEqual([]);
  } finally {
    try {
      await h.close();
    } finally {
      flushSpy.mockRestore();
      vi.useRealTimers();
    }
  }
}, 15000);

test("failed flushes exhaust the notification budget without losing or appending the accepted wake", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const h = await pollFixture(0, "held", "available").catch((error: unknown) => {
    vi.useRealTimers();
    throw error;
  });
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
  const privateDetail = "PRIVATE_FLUSH_DIAGNOSTIC";
  let rejected = false;
  const flushSpy = vi.spyOn(h.ctx.sessions, "flush").mockImplementation(async (session) => {
    await flush(session);
    if (h.flushes.length === 2) {
      rejected = true;
      throw new Error(privateDetail);
    }
    return false;
  });
  try {
    const { producer, pending } = h.start();
    const running = await pending;
    waitForEvidence(running.run_dir, "invocation.json");
    const invocation = await readInvocation(running.run_dir);
    expect(invocation).toMatchObject({ ppid: running.pid, cwd: running.run_dir });
    const origin = vi.getRealSystemTime();
    vi.setSystemTime(origin);
    await releaseRun(running);
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      return (await readRecord(running.run_dir)).status === "collected";
    }, "real collection before exhausting notification attempts");
    const result = await readResult(running.run_dir);
    expect(result).toMatchObject({
      run_id: running.run_id,
      exit_code: 0,
      exit_class: "ok",
    });
    const resultPath = join(running.run_dir, "run-record.json");
    const resultBytes = await io.readFile(resultPath);
    const resultMtime = (await io.stat(resultPath, { bigint: true })).mtimeNs;
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      return h.flushes.length > 0;
    }, "the first false flush acknowledgement");
    const firstFailure = await readRecord(running.run_dir);
    expect(firstFailure.notify.detail).toMatch(/flush|persist|acknowledg/iu);
    expect(firstFailure.notify).toMatchObject({
      status: "pending",
      attempts: 1,
      at: new Date(origin).toISOString(),
    });
    expect(h.followups).toHaveLength(1);
    const [{ sessionId, message }] = h.followups;
    expect(sessionId).toBe(h.ownerId);
    expect(message).toMatchObject({ role: "user", source: { kind: "shud-jobs" } });
    expect(message.id).toEqual(expect.any(String));
    const entry = {
      run_id: running.run_id,
      job_id: running.job_id,
      run_dir: running.run_dir,
    };
    const jobPath = join(running.run_dir, "run-job.json");
    for (let attempt = 2; attempt <= MAX_NOTIFY_ATTEMPTS; attempt++) {
      const previousBytes = await io.readFile(jobPath);
      const previousMtime = (await io.stat(jobPath, { bigint: true })).mtimeNs;
      const nextAttemptAt = origin + (attempt - 1) * NOTIFY_RETRY_INTERVAL_MS;
      vi.setSystemTime(nextAttemptAt - 1);
      await h.registry.pollOnce();
      await h.registry.pollOnce();
      expect(h.flushes).toHaveLength(attempt - 1);
      expect(h.followups).toEqual([{ sessionId: h.ownerId, message }]);
      expect(await io.readFile(jobPath)).toEqual(previousBytes);
      expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(previousMtime);
      expect(h.registry.indexes.read()).toEqual({ active: [entry], completed: [] });

      vi.setSystemTime(nextAttemptAt);
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        return h.flushes.length >= attempt;
      }, `flush failure ${attempt} at its original retry boundary`);
      const failed = await readRecord(running.run_dir);
      expect(failed.notify.detail).toMatch(/flush|persist|acknowledg/iu);
      expect(failed.notify).toMatchObject({
        status: attempt === MAX_NOTIFY_ATTEMPTS ? "unreachable" : "pending",
        attempts: attempt,
        at: new Date(nextAttemptAt).toISOString(),
      });
      expect(failed.notify.detail).not.toContain(privateDetail);
      expect(h.errors.join("\n")).not.toContain(privateDetail);
      expect(h.flushes).toHaveLength(attempt);
      expect(h.followups).toEqual([{ sessionId: h.ownerId, message }]);
      expect(h.flushObservations).toEqual(
        Array.from({ length: attempt }, () => ({ sessionId: h.ownerId, messages: [message] })),
      );
    }
    expect(rejected).toBe(true);
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      return h.registry.indexes.read().active.length === 0;
    }, "completed-index migration after notification exhaustion");
    const exhausted = await readRecord(running.run_dir);
    expect(exhausted.notify).toMatchObject({
      status: "unreachable",
      attempts: MAX_NOTIFY_ATTEMPTS,
    });
    const exhaustedBytes = await io.readFile(jobPath);
    const exhaustedMtime = (await io.stat(jobPath, { bigint: true })).mtimeNs;
    const resolutions = [...h.resolutions];
    vi.setSystemTime(origin + MAX_NOTIFY_ATTEMPTS * NOTIFY_RETRY_INTERVAL_MS);
    await h.registry.pollOnce();
    await h.registry.pollOnce();
    expect(h.resolutions).toEqual(resolutions);
    expect(h.flushes).toHaveLength(MAX_NOTIFY_ATTEMPTS);
    expect(h.followups).toEqual([{ sessionId: h.ownerId, message }]);

    await h.fiber.dispose();
    await waitForOwnershipRelease(h.stateDir);
    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    const replacement = actualRegistry(h.ctx);
    await replacement.pollOnce();
    await replacement.pollOnce();
    expect(replacement.indexes.read()).toEqual({ active: [], completed: [entry] });
    expect(await persisted(h.stateDir)).toEqual([]);
    expect(await persisted(h.stateDir, "completed.json")).toEqual([entry]);
    expect(await readRecord(running.run_dir)).toEqual(exhausted);
    expect(await io.readFile(jobPath)).toEqual(exhaustedBytes);
    expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(exhaustedMtime);
    expect(await replacement.collectShud(running.run_id)).toEqual(result);
    expect(await io.readFile(resultPath)).toEqual(resultBytes);
    expect((await io.stat(resultPath, { bigint: true })).mtimeNs).toBe(resultMtime);
    expect(await readInvocation(running.run_dir)).toEqual(invocation);
    expect(producer.executions).toHaveLength(1);
    expect(producer.attempts).toHaveLength(1);
    expect(producer.registration.cancellations).toEqual([]);
    expect(h.resolutions).toEqual(resolutions);
    expect(h.flushes).toHaveLength(MAX_NOTIFY_ATTEMPTS);
    expect(h.followups).toEqual([{ sessionId: h.ownerId, message }]);
    expect(h.sessionEvents.filter((event) => event.type === "job/settled")).toEqual([]);
    expect(h.errors.join("\n")).not.toContain(privateDetail);
  } finally {
    try {
      await h.close();
    } finally {
      flushSpy.mockRestore();
      vi.useRealTimers();
    }
  }
}, 15000);

test.each([
  "session/agent-busy",
  "session/writer-held",
  "gateway/internal",
  "rejected restoration",
] as const)(
  "%s counts as a spaced restoration failure, not a missing owner, before recovering",
  async (failure) => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const h = await pollFixture(0, "held", "available").catch((error: unknown) => {
      vi.useRealTimers();
      throw error;
    });
    const resolve = h.ctx.sessionController.resolveAgent.bind(h.ctx.sessionController);
    const requests: SessionId[] = [];
    const privateDetail = "PRIVATE_RESTORATION_DIAGNOSTIC: session not found";
    const resolveSpy = vi
      .spyOn(h.ctx.sessionController, "resolveAgent")
      .mockImplementation(async (id) => {
        requests.push(id);
        if (requests.length !== 1) return resolve(id);
        if (failure === "rejected restoration") throw new Error(privateDetail);
        // Structural public error data only; no host error constructor or fabricated Agent.
        return {
          error: Object.assign(new Error(privateDetail), {
            code: failure,
            details:
              failure === "session/writer-held"
                ? { sessionId: id }
                : failure === "session/agent-busy"
                  ? { reason: privateDetail }
                  : {},
            isDSHRemoteError: true as const,
          }),
        };
      });
    try {
      const { producer, pending } = h.start();
      const running = await pending;
      waitForEvidence(running.run_dir, "invocation.json");
      const invocation = await readInvocation(running.run_dir);
      expect(invocation).toMatchObject({ ppid: running.pid, cwd: running.run_dir });
      const origin = vi.getRealSystemTime();
      vi.setSystemTime(origin);
      await releaseRun(running);
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        return (await readRecord(running.run_dir)).status === "collected";
      }, "real collection before transient session restoration");
      const result = await readResult(running.run_dir);
      expect(result).toMatchObject({
        run_id: running.run_id,
        exit_code: 0,
        exit_class: "ok",
      });
      const resultPath = join(running.run_dir, "run-record.json");
      const resultBytes = await io.readFile(resultPath);
      const resultMtime = (await io.stat(resultPath, { bigint: true })).mtimeNs;
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        return requests.length > 0;
      }, "the first failing public session resolution");
      expect(requests).toEqual([h.ownerId]);
      expect(h.resolutions).toEqual([]);
      expect(h.followups).toEqual([]);
      expect(h.flushes).toEqual([]);
      const failed = await readRecord(running.run_dir);
      expect(failed.notify.detail).toMatch(/resolv|restor|session.*(?:fail|unavailable|retry)/iu);
      expect(failed.notify).toMatchObject({
        status: "pending",
        attempts: 1,
        at: new Date(origin).toISOString(),
      });
      expect(failed.notify.detail).not.toMatch(/not found/iu);
      expect(failed.notify.detail).not.toContain("PRIVATE_RESTORATION_DIAGNOSTIC");
      expect(h.errors.join("\n")).not.toContain("PRIVATE_RESTORATION_DIAGNOSTIC");
      const entry = {
        run_id: running.run_id,
        job_id: running.job_id,
        run_dir: running.run_dir,
      };
      expect(h.registry.indexes.read()).toEqual({ active: [entry], completed: [] });
      const jobPath = join(running.run_dir, "run-job.json");
      const failedBytes = await io.readFile(jobPath);
      const failedMtime = (await io.stat(jobPath, { bigint: true })).mtimeNs;
      for (const offset of [1000, -1000, NOTIFY_RETRY_INTERVAL_MS - 1]) {
        vi.setSystemTime(origin + offset);
        await h.registry.pollOnce();
        await h.registry.pollOnce();
        expect(requests).toEqual([h.ownerId]);
        expect(h.resolutions).toEqual([]);
        expect(h.followups).toEqual([]);
        expect(h.flushes).toEqual([]);
        expect(await io.readFile(jobPath)).toEqual(failedBytes);
        expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(failedMtime);
      }

      vi.setSystemTime(origin + NOTIFY_RETRY_INTERVAL_MS);
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        return (await readRecord(running.run_dir)).notify.status === "delivered";
      }, "successful public restoration at the retry boundary");
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        return h.registry.indexes.read().active.length === 0;
      }, "completed-index migration after restoration recovery");
      expect((await readRecord(running.run_dir)).notify).toEqual({
        status: "delivered",
        attempts: 1,
        at: new Date(origin + NOTIFY_RETRY_INTERVAL_MS).toISOString(),
        detail: null,
      });
      expect(requests).toEqual([h.ownerId, h.ownerId]);
      expect(h.resolutions).toEqual([h.ownerId]);
      expect(h.followups).toHaveLength(1);
      const [{ sessionId, message }] = h.followups;
      expect(sessionId).toBe(h.ownerId);
      expect(message).toMatchObject({ role: "user", source: { kind: "shud-jobs" } });
      expect(message.id).toEqual(expect.any(String));
      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      expect(text).toContain(running.run_id);
      expect(h.flushes).toEqual([h.ownerId]);
      expect(h.flushObservations).toEqual([{ sessionId: h.ownerId, messages: [message] }]);
      expect(h.registry.indexes.read()).toEqual({ active: [], completed: [entry] });
      expect(await persisted(h.stateDir)).toEqual([]);
      expect(await persisted(h.stateDir, "completed.json")).toEqual([entry]);
      expect(await h.registry.collectShud(running.run_id)).toEqual(result);
      expect(await io.readFile(resultPath)).toEqual(resultBytes);
      expect((await io.stat(resultPath, { bigint: true })).mtimeNs).toBe(resultMtime);
      expect(await readInvocation(running.run_dir)).toEqual(invocation);
      expect(producer.executions).toHaveLength(1);
      expect(producer.attempts).toHaveLength(1);
      expect(producer.registration.cancellations).toEqual([]);
      expect(h.sessionEvents.filter((event) => event.type === "job/settled")).toEqual([]);
      expect(h.errors.join("\n")).not.toContain("PRIVATE_RESTORATION_DIAGNOSTIC");
    } finally {
      try {
        await h.close();
      } finally {
        resolveSpy.mockRestore();
        vi.useRealTimers();
      }
    }
  },
  15000,
);

test("a followup rejection after actual append counts a failure without pretending the throw was atomic", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const h = await pollFixture(0, "held", "available").catch((error: unknown) => {
    vi.useRealTimers();
    throw error;
  });
  let restoreFollowup: (() => void) | undefined;
  try {
    const resolved = await h.ctx.sessionController.resolveAgent(h.ownerId);
    if ("error" in resolved) throw new Error("The live fixture owner did not resolve");
    const followup = resolved.agent.followup.bind(resolved.agent);
    let thrown = false;
    const spy = vi.spyOn(resolved.agent, "followup").mockImplementation((message) => {
      followup(message);
      if (!thrown) {
        thrown = true;
        throw new Error("PRIVATE_POST_APPEND_FOLLOWUP_PAYLOAD");
      }
    });
    restoreFollowup = () => spy.mockRestore();
    const run = await collectedWake(h);
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      return h.followups.length > 0;
    }, "the real accepted message preceding the followup rejection");
    expect(thrown).toBe(true);
    expect(h.followups).toHaveLength(1);
    expect(h.flushes).toEqual([]);
    const failed = await readRecord(run.running.run_dir);
    expect(failed.notify.detail).toMatch(/followup|append|deliver/iu);
    expect(failed.notify).toMatchObject({
      status: "pending",
      attempts: 1,
      at: new Date(run.origin).toISOString(),
    });
    expect(h.errors.join("\n")).not.toContain("PRIVATE_POST_APPEND_FOLLOWUP_PAYLOAD");
    expect((await readRecord(run.running.run_dir)).notify.detail).not.toContain("PRIVATE_");
    vi.setSystemTime(run.origin + NOTIFY_RETRY_INTERVAL_MS - 1);
    await h.registry.pollOnce();
    expect(h.followups).toHaveLength(1);
    expect(h.flushes).toEqual([]);
    vi.setSystemTime(run.origin + NOTIFY_RETRY_INTERVAL_MS);
    await deliveredWake(h.registry, run.running.run_dir);
    // This seam deterministically appends before throwing. Its unconfirmed return must not
    // create a receipt: the retry appends again, demonstrating the permitted at-least-once window.
    expect(h.followups).toHaveLength(2);
    for (const accepted of h.followups) {
      expect(accepted.sessionId).toBe(h.ownerId);
      expect(accepted.message).toMatchObject({ role: "user", source: { kind: "shud-jobs" } });
      const text = accepted.message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      expect(text).toContain(run.running.run_id);
    }
    expect(h.flushes).toEqual([h.ownerId]);
    expect(h.flushObservations).toEqual([
      { sessionId: h.ownerId, messages: h.followups.map(({ message }) => message) },
    ]);
    expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
      status: "delivered",
      attempts: 1,
    });
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [run.entry] });
    await expectWakeEvidence(run);
  } finally {
    try {
      await h.close();
    } finally {
      restoreFollowup?.();
      vi.useRealTimers();
    }
  }
}, 15000);

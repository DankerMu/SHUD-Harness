import { spawnSync } from "node:child_process";
import type * as NodeFs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import type { JobEvent, JobOutcome } from "@deepseek-ai/dsh-jobs";
import { KILL_GRACE_PERIOD_MS } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry, startDetachedShud, type ShudExecution } from "./index.ts";
import { expectAbsent, readResult } from "./collect-shud/test-harness.ts";
import {
  activeGroup,
  installFakeShud,
  readInvocation,
  terminateGroup,
} from "./detached-shud/test-harness.ts";
import { observeSignals, readyRun } from "./kill-shud/test-harness.ts";
import {
  pollFixture,
  readRecord,
  releaseRun,
  waitForEvidence,
  waitForOwnershipRelease,
} from "./poll-shud/test-harness.ts";
import {
  captureRecoveryStderr,
  completedWithinWindow,
  expectUnownedRecoveryWarning,
  waitForRecovery,
  waitForTerm,
} from "./reconcile-shud/test-harness.ts";
import {
  actualRegistry,
  registrationResource,
  submissionFixture,
} from "./submit-shud/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, write: vi.fn(actual.write) };
});

test("plain registry disposal synchronously fails its own SHUD registration without stopping execution", async () => {
  const h = await submissionFixture();
  const resource = registrationResource();
  let execution: ShudExecution | undefined;
  let disposing: Promise<void> | undefined;
  let restoreSignals: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    await installFakeShud(h.shudBin, 0, "held");
    const fiber = await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    const registry = actualRegistry(h.ctx);
    const events: JobEvent[] = [];
    // Root subscription outlives this registry fiber; unowned SHUD has no session job events.
    unsubscribe = h.ctx.jobs.events.subscribe({ owners: "all" }, (event) => {
      events.push(structuredClone(event));
    });
    const completions: Array<{ outcome: JobOutcome; publicStatus: string }> = [];
    const record = await registry.submitShud(h.request, (prepared, handle, pumpPollMs) => {
      const lifecycle = resource.open(prepared, handle);
      execution = startDetachedShud(
        prepared,
        {
          ...lifecycle,
          detach(detail) {
            // Host teardown marks stopping only after cancel returns. A delayed completion
            // sees stopping, not running, even if it eventually reports the correct outcome.
            completions.push({
              outcome: { status: "failed", detail },
              publicStatus: registry.get(handle.id).status,
            });
            lifecycle.detach(detail);
          },
        },
        pumpPollMs,
      );
      return execution;
    });
    if (!execution || record.pid === null || record.dsh_job_id === null)
      throw new Error("Real SHUD execution did not publish its registration and process identity");
    const ownDone = execution.hooks.done;
    waitForEvidence(record.run_dir, "invocation.json");
    const invocation = await readInvocation(record.run_dir);
    if (!invocation) throw new Error("Held SHUD did not publish its invocation receipt");
    expect(registry.get(record.dsh_job_id).status).toBe("running");
    expect(record.cancel_requested_at).toBeNull();
    expect(completions).toEqual([]);
    const snapshots = await Promise.all(
      [
        join(record.run_dir, "run-job.json"),
        join(h.stateDir, "active.json"),
        join(h.stateDir, "completed.json"),
      ].map(async (path) => ({
        path,
        bytes: await io.readFile(path),
        mtime: (await io.stat(path, { bigint: true })).mtimeNs,
      })),
    );
    const signals = observeSignals();
    restoreSignals = signals.restore;

    disposing = Promise.resolve(fiber.dispose());
    void disposing.catch(() => undefined);
    // A parent forced-failure cannot satisfy this: the producer's actual done must fulfill.
    await completedWithinWindow(ownDone);
    const outcome = await ownDone;
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toMatch(/host.*exit/iu);
    expect(outcome.detail).toMatch(/shud.*(?:continu|background)/iu);
    expect(outcome.detail).not.toMatch(/cancel threw|orphan|jobs service disposed/iu);
    expect(completions).toEqual([{ outcome, publicStatus: "running" }]);
    expect(resource.cancellations).toEqual([]);
    expect(() => resource.append("must not write after registration completion")).toThrow(
      "no live output descriptor",
    );
    await completedWithinWindow(disposing);
    await waitForOwnershipRelease(h.stateDir);
    const settled = events.filter(
      (event) => event.type === "settled" && event.job.id === record.dsh_job_id,
    );
    expect(settled).toMatchObject([
      {
        type: "settled",
        cause: "teardown",
        job: { status: "failed", detail: outcome.detail },
      },
    ]);
    expect(signals.events).toEqual([]);
    expect(activeGroup(record.pid)).toContain(record.pid);
    expect(activeGroup(record.pid)).toContain(invocation.pid);
    for (const snapshot of snapshots) {
      expect(await io.readFile(snapshot.path)).toEqual(snapshot.bytes);
      expect((await io.stat(snapshot.path, { bigint: true })).mtimeNs).toBe(snapshot.mtime);
    }
    expect(await readRecord(record.run_dir)).toEqual(record);
    await expectAbsent(join(record.run_dir, "run-record.json"));
    await expectAbsent(join(record.run_dir, "collect-error.json"));
    await expectAbsent(join(record.run_dir, "exit_code"));
    expect(h.sessionEvents).toEqual([]);
    expect(h.flushes).toEqual([]);
  } finally {
    restoreSignals?.();
    unsubscribe?.();
    try {
      if (execution) {
        const identity = await execution.started.catch(() => undefined);
        if (identity) await terminateGroup(identity.pid);
        await execution.abort();
      }
    } finally {
      // Release the same real resource on a RED/no-completion path, so parent teardown can drain.
      resource.finish();
      try {
        if (disposing) await completedWithinWindow(disposing);
      } finally {
        await h.dispose();
      }
    }
  }
}, 15000);

test("kill-grace disposal resends TERM before startup cancellation: Linux R8 and Darwin R7", async () => {
  const h = await submissionFixture();
  const stderr = captureRecoveryStderr();
  const resource = registrationResource();
  let execution: ShudExecution | undefined;
  let disposing: Promise<void> | undefined;
  let recovering: Promise<unknown> | undefined;
  let restoreSignals: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    await installFakeShud(h.shudBin, 0, "resistant");
    const fiber = await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    const registry = actualRegistry(h.ctx);
    const events: JobEvent[] = [];
    const completions: Array<{ outcome: JobOutcome; signalCount: number }> = [];
    const completionAtStopping: number[] = [];
    let signalEvents: Array<{ pid: number; signal: string | number }> = [];
    unsubscribe = h.ctx.jobs.events.subscribe({ owners: "all" }, (event) => {
      events.push(structuredClone(event));
      if (event.type === "stopping") completionAtStopping.push(completions.length);
    });
    const record = await registry.submitShud(h.request, (prepared, handle, pumpPollMs) => {
      const lifecycle = resource.open(prepared, handle);
      execution = startDetachedShud(
        prepared,
        {
          ...lifecycle,
          detach(detail) {
            lifecycle.detach(detail);
            completions.push({
              outcome: { status: "failed", detail },
              signalCount: signalEvents.length,
            });
          },
        },
        pumpPollMs,
      );
      return execution;
    });
    if (!execution || record.pid === null || record.dsh_job_id === null)
      throw new Error("Real SHUD execution did not publish its registration and process identity");
    const pid = record.pid;
    const ownDone = execution.hooks.done;
    waitForEvidence(record.run_dir, "invocation.json");
    const invocation = await readInvocation(record.run_dir);
    if (!invocation) throw new Error("Resistant SHUD did not publish its invocation receipt");
    // The resistant fixture protects only the solver. Native controls show that STOP then TERM
    // preserves a Linux T-state wrapper but kills the Darwin leader. Exercise real R8 on Linux
    // and explicitly retain the known R7/#343 orphan limitation on Darwin; never fabricate R8.
    expect(["linux", "darwin"]).toContain(process.platform);
    process.kill(pid, "SIGSTOP");
    const wrapperState = () => {
      const observed = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
      });
      if (observed.error) throw observed.error;
      if (observed.status === 1 && observed.stdout.trim() === "") return null;
      expect(observed.status).toBe(0);
      return observed.stdout.trim();
    };
    await waitForRecovery(
      () => wrapperState()?.startsWith("T") === true,
      "the owned wrapper's native stopped state",
    );
    expect(activeGroup(pid)).toContain(invocation.pid);
    const signals = observeSignals();
    signalEvents = signals.events;
    restoreSignals = signals.restore;
    const began = performance.now();
    expect(registry.kill(record.dsh_job_id, h.ownerId, "stop this run before host exit")).toBe(
      "requested",
    );
    const intent = await readRecord(record.run_dir);
    if (intent.cancel_requested_at === null) throw new Error("Public kill did not persist intent");
    const requestedAt = Date.parse(intent.cancel_requested_at);
    expect(intent).toEqual({ ...record, cancel_requested_at: intent.cancel_requested_at });
    expect(signals.events).toEqual([{ pid: -pid, signal: "SIGTERM" }]);
    await waitForTerm(record.run_dir);
    // The solver overwrites this receipt. Removing the first one makes a later receipt
    // evidence of another actual handler delivery, not only another process.kill call.
    await io.rm(join(record.run_dir, "sigterm-seen"));
    if (process.platform === "linux") {
      expect(wrapperState()).toMatch(/^T/u);
    } else {
      await completedWithinWindow(execution.waitForExit());
      expect(wrapperState()).toBeNull();
      expect(activeGroup(pid)).not.toContain(pid);
    }
    expect(activeGroup(pid)).toContain(invocation.pid);
    const snapshots = await Promise.all(
      [join(record.run_dir, "run-job.json"), join(h.stateDir, "active.json")].map(async (path) => ({
        path,
        bytes: await io.readFile(path),
        mtime: (await io.stat(path, { bigint: true })).mtimeNs,
      })),
    );

    disposing = Promise.resolve(fiber.dispose());
    void disposing.catch(() => undefined);
    await completedWithinWindow(Promise.all([ownDone, disposing]));
    await waitForOwnershipRelease(h.stateDir);
    expect(performance.now() - began).toBeLessThan(5000);
    const outcome = await ownDone;
    expect(outcome.status).toBe("failed");
    // Fast RED checkpoint: teardown must resend before reporting completion, not await grace.
    expect(signals.events).toEqual([
      { pid: -pid, signal: "SIGTERM" },
      { pid: -pid, signal: "SIGTERM" },
    ]);
    await waitForTerm(record.run_dir);
    expect(outcome.detail).toMatch(/host.*exit/iu);
    expect(outcome.detail).toMatch(/kill.*(?:progress|pending)/iu);
    expect(outcome.detail).not.toMatch(/cancel threw|orphan|stop this run before host exit/iu);
    expect(completions).toEqual([{ outcome, signalCount: 2 }]);
    // The first stopping event is public kill; teardown's event follows its synchronous cancel.
    expect(completionAtStopping).toEqual([0, 1]);
    expect(resource.cancellations).toEqual([]);
    expect(
      events.filter((event) => event.type === "settled" && event.job.id === record.dsh_job_id),
    ).toMatchObject([{ cause: "teardown", job: { status: "failed", detail: outcome.detail } }]);
    for (const snapshot of snapshots) {
      expect(await io.readFile(snapshot.path)).toEqual(snapshot.bytes);
      expect((await io.stat(snapshot.path, { bigint: true })).mtimeNs).toBe(snapshot.mtime);
    }
    expect(await readRecord(record.run_dir)).toEqual(intent);
    if (process.platform === "linux") expect(wrapperState()).toMatch(/^T/u);
    else expect(wrapperState()).toBeNull();
    expect(activeGroup(pid)).toContain(invocation.pid);
    await expectAbsent(join(record.run_dir, "run-record.json"));
    await expectAbsent(join(record.run_dir, "exit_code"));
    expect(h.sessionEvents).toEqual([]);
    expect(h.flushes).toEqual([]);

    if (process.platform === "linux") {
      // Real downtime makes a restart-relative ten-second grace observably different.
      // No fake Date, PID, process stamp, wrapper script, or production timer is substituted.
      await delay(Math.max(0, requestedAt + KILL_GRACE_PERIOD_MS * 0.65 - Date.now()));
      expect(signals.events).toHaveLength(2);
      expect(wrapperState()).toMatch(/^T/u);
      expect(activeGroup(pid)).toContain(invocation.pid);
      expect(await readRecord(record.run_dir)).toEqual(intent);
      let ready = false;
      recovering = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 }).then((replacement) => {
        ready = true;
        return replacement;
      });
      void recovering.catch(() => undefined);
      await waitForRecovery(() => signals.events.length >= 3, "startup's recovered TERM");
      await delay(Math.max(0, requestedAt + KILL_GRACE_PERIOD_MS - 1000 - Date.now()));
      expect(ready).toBe(false);
      expect(signals.events).toEqual([
        { pid: -pid, signal: "SIGTERM" },
        { pid: -pid, signal: "SIGTERM" },
        { pid: -pid, signal: "SIGTERM" },
      ]);
      expect(wrapperState()).toMatch(/^T/u);
      expect(activeGroup(pid)).toContain(invocation.pid);
      expect(await readRecord(record.run_dir)).toEqual(intent);
      await expectAbsent(join(record.run_dir, "run-record.json"));
      await completedWithinWindow(recovering);
      expect(Date.now() - requestedAt).toBeGreaterThanOrEqual(KILL_GRACE_PERIOD_MS);
      expect(performance.now() - began).toBeLessThan(KILL_GRACE_PERIOD_MS + 3000);
      expect(signals.events).toEqual([
        { pid: -pid, signal: "SIGTERM" },
        { pid: -pid, signal: "SIGTERM" },
        { pid: -pid, signal: "SIGTERM" },
        { pid: -pid, signal: "SIGKILL" },
      ]);
      expect(activeGroup(pid)).toEqual([]);
      expect(stderr.lines(record.run_id)).toEqual([]);
    } else {
      expect(process.platform).toBe("darwin");
      recovering = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      await completedWithinWindow(recovering);
      expect(wrapperState()).toBeNull();
      // R7 cannot reconstruct historical group ownership (#343). Cancelled is not proof
      // of quiescence here: the real resistant descendant survives until owned test cleanup.
      expect(activeGroup(pid)).not.toContain(pid);
      expect(activeGroup(pid)).toContain(invocation.pid);
      expect(signals.events).toEqual([
        { pid: -pid, signal: "SIGTERM" },
        { pid: -pid, signal: "SIGTERM" },
      ]);
      expectUnownedRecoveryWarning(stderr, intent);
    }
    await expect
      .poll(async () => (await readRecord(record.run_dir)).notify.detail, { timeout: 5000 })
      .toMatch(/wait.*session|session.*wait/iu);
    const collected = await readRecord(record.run_dir);
    expect(collected.notify.detail).toMatch(/wait.*session|session.*wait/iu);
    expect(collected).toMatchObject({
      status: "collected",
      cancel_requested_at: intent.cancel_requested_at,
      notify: {
        ...intent.notify,
        detail: collected.notify.detail,
      },
      exit_code: null,
    });
    expect(await readResult(record.run_dir)).toMatchObject({
      exit_class: "cancelled",
      exit_code: null,
    });
    expect(actualRegistry(h.ctx).list()).toEqual([]);
    expect(h.sessionEvents).toEqual([]);
    expect(h.flushes).toEqual([]);
  } finally {
    stderr.restore();
    restoreSignals?.();
    unsubscribe?.();
    try {
      if (execution) {
        const identity = await execution.started.catch(() => undefined);
        if (identity) await terminateGroup(identity.pid);
        await execution.abort();
      }
    } finally {
      resource.finish();
      try {
        await completedWithinWindow(Promise.allSettled([disposing, recovering]));
      } finally {
        await h.dispose();
      }
    }
  }
}, 25000);

test("owner Agent release leaves unowned SHUD running until normal settlement and collection", async () => {
  const h = await pollFixture();
  let restoreSignals: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const { record, id, pid, invocation, producer } = await readyRun(h);
    const events: JobEvent[] = [];
    unsubscribe = h.ctx.jobs.events.subscribe({ owners: "all" }, (event) => {
      events.push(structuredClone(event));
    });
    expect(h.registry.get(id).owner).toBeUndefined();
    expect(record.owner_session).toBe(h.ownerId);
    const snapshots = await Promise.all(
      [join(record.run_dir, "run-job.json"), join(h.stateDir, "active.json")].map(async (path) => ({
        path,
        bytes: await io.readFile(path),
        mtime: (await io.stat(path, { bigint: true })).mtimeNs,
      })),
    );
    let done = false;
    const ownDone = producer.executions[0].hooks.done;
    void ownDone.then(() => {
      done = true;
    });
    const signals = observeSignals();
    restoreSignals = signals.restore;

    await h.releaseOwner();
    expect(h.registry.get(id).status).toBe("running");
    expect(done).toBe(false);
    expect(producer.completed).toEqual([]);
    expect(producer.registration.cancellations).toEqual([]);
    expect(signals.events).toEqual([]);
    expect(events.filter((event) => event.type === "settled")).toEqual([]);
    expect(activeGroup(pid)).toContain(pid);
    expect(activeGroup(pid)).toContain(invocation.pid);
    for (const snapshot of snapshots) {
      expect(await io.readFile(snapshot.path)).toEqual(snapshot.bytes);
      expect((await io.stat(snapshot.path, { bigint: true })).mtimeNs).toBe(snapshot.mtime);
    }
    await expectAbsent(join(record.run_dir, "run-record.json"));

    await releaseRun(record);
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      return (await readRecord(record.run_dir)).status === "collected";
    }, "normal collection after owner Agent release");
    await completedWithinWindow(producer.executions[0].waitForExit());
    expect(await ownDone).toMatchObject({ status: "completed" });
    expect(done).toBe(true);
    expect(producer.completed).toHaveLength(1);
    expect(producer.durableAtDone).toEqual(producer.durableAtSettle);
    expect(producer.durableAtDone[0].status).toBe("succeeded");
    expect(producer.registration.cancellations).toEqual([]);
    expect(h.registry.get(id).status).toBe("completed");
    expect(events.filter((event) => event.type === "settled" && event.job.id === id)).toMatchObject(
      [{ cause: "producer", job: { status: "completed" } }],
    );
    expect(await readResult(record.run_dir)).toMatchObject({ exit_class: "ok", exit_code: 0 });
    await expect
      .poll(async () => (await readRecord(record.run_dir)).notify.detail, { timeout: 5000 })
      .toMatch(/wait.*session|session.*wait/iu);
    const collected = await readRecord(record.run_dir);
    expect(collected.notify.detail).toMatch(/wait.*session|session.*wait/iu);
    expect(collected).toMatchObject({
      status: "collected",
      owner_session: record.owner_session,
      notify: {
        ...record.notify,
        detail: collected.notify.detail,
      },
    });
    expect(activeGroup(pid)).toEqual([]);
    expect(signals.events).toEqual([]);
    expect(h.sessionEvents).toEqual([]);
    expect(h.flushes).toEqual([]);
  } finally {
    restoreSignals?.();
    unsubscribe?.();
    await h.close();
  }
}, 15000);

import * as io from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import { expect, onTestFailed, test, vi } from "vitest";
import type { JobEvent, JobHooks, JobId } from "@deepseek-ai/dsh-jobs";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import { ShudJobRegistry } from "./index.ts";
import { expectAbsent } from "./collect-shud/test-harness.ts";
import { activeGroup, installFakeShud } from "./detached-shud/test-harness.ts";
import { observeSignals, readDurable } from "./kill-shud/test-harness.ts";
import { pollFixture, readRecord, waitForOwnershipRelease } from "./poll-shud/test-harness.ts";
import {
  closeRecovery,
  completedWithinWindow,
  stopAtSubmitted,
  stopWhileRunning,
  waitForRecovery,
  waitForTerm,
} from "./reconcile-shud/test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";

/** Observe the actual parent producer boundary without replacing its resource or done promise. */
function captureTakeovers(beforeStart?: (registry: ShudJobRegistry) => void) {
  const registrations: Array<{ id: JobId; hooks: JobHooks }> = [];
  const method: unknown = Object.getOwnPropertyDescriptor(
    LocalJobRegistry.prototype,
    "start",
  )?.value;
  if (typeof method !== "function") throw new Error("Parent start implementation is missing");
  const original = method as typeof LocalJobRegistry.prototype.start;
  const start = vi.spyOn(LocalJobRegistry.prototype, "start");
  start.mockImplementation(function (this: LocalJobRegistry, spec) {
    if (!(this instanceof ShudJobRegistry)) throw new Error("Expected the actual SHUD registry");
    beforeStart?.(this);
    return original.call(this, {
      ...spec,
      run(handle) {
        const hooks = spec.run(handle);
        registrations.push({ id: handle.id, hooks });
        return hooks;
      },
    });
  });
  return { registrations, restore: () => start.mockRestore() };
}

test.each(["R3", "R5"] as const)(
  "%s registered-event kill refuses unpublished identity, then committed public kill controls the original group",
  async (row) => {
    let pid: number | undefined;
    let applying: Promise<unknown> | undefined;
    let capture: ReturnType<typeof captureTakeovers> | undefined;
    let signals: ReturnType<typeof observeSignals> | undefined;
    let unsubscribe: (() => void) | undefined;
    const state: { fixture?: { errors: readonly unknown[] } } = {};
    let runDir: string | undefined;
    let preCleanup: unknown = {
      phase: "pre-cleanup",
      unavailable: "fixture setup did not reach cleanup",
      registrations: 0,
    };
    onTestFailed(() => {
      try {
        console.error(
          "[takeover lifecycle failure]",
          inspect(
            {
              row,
              errors: state.fixture?.errors ?? { unavailable: "fixture setup did not complete" },
              preCleanup,
            },
            {
              depth: null,
              maxArrayLength: null,
              maxStringLength: null,
              customInspect: false,
            },
          ),
        );
      } catch {
        // Diagnostic reporting must not replace the test or cleanup failure.
      }
    });
    const h = await pollFixture();
    state.fixture = h;
    try {
      await installFakeShud(h.shudBin, 0, "resistant");
      const original = await (row === "R3" ? stopAtSubmitted(h) : stopWhileRunning(h));
      const { record, invocation } = original;
      runDir = record.run_dir;
      pid = original.pid;
      const invocationPath = join(record.run_dir, "invocation.json");
      const invocationBytes = await io.readFile(invocationPath);
      const invocationMtime = (await io.stat(invocationPath, { bigint: true })).mtimeNs;
      const realDate = Date;
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      const fakeDate = Date;
      // Keep native startup observations coherent without reinstalling the fake intervals.
      vi.stubGlobal("Date", realDate);
      signals = observeSignals();
      const refusals: unknown[] = [];
      const snapshots: ReturnType<typeof readDurable>[] = [];
      capture = captureTakeovers((registry) => {
        unsubscribe = registry.events.subscribe({ owners: "all" }, (event) => {
          if (event.type !== "registered") return;
          // Parent event delivery swallows listener exceptions; assert the captured result outside.
          try {
            registry.kill(event.job.id, h.ownerId, "reentrant prepublication kill");
            refusals.push("unexpected acceptance");
          } catch (error) {
            refusals.push(error);
          }
          snapshots.push(readDurable(record.run_dir));
        });
      });
      applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      await completedWithinWindow(applying);
      const registry = actualRegistry(h.ctx);
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({ stage: "kill identity", code: "MISMATCH" });
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        status: "running",
        pid,
        dsh_job_id: null,
        dsh_job_ids: record.dsh_job_ids,
        cancel_requested_at: null,
      });
      expect(signals.events).toEqual([]);
      expect(activeGroup(pid)).toContain(pid);
      expect(activeGroup(pid)).toContain(invocation.pid);
      const adopted = capture.registrations[0];
      if (!adopted) throw new Error("Takeover did not expose actual producer hooks");
      expect(registry.list().map((job) => job.id)).toEqual([adopted.id]);
      const committed = await readRecord(record.run_dir);
      expect(committed.dsh_job_id).toBe(adopted.id);
      expect(committed.dsh_job_ids).toEqual([...record.dsh_job_ids, adopted.id]);
      expect(committed.cancel_requested_at).toBeNull();
      vi.stubGlobal("Date", fakeDate);
      const origin = realDate.now();
      vi.setSystemTime(origin);
      expect(registry.kill(adopted.id, h.ownerId, "postcommit public kill")).toBe("requested");
      const intent = readDurable(record.run_dir);
      expect(intent).toEqual({ ...committed, cancel_requested_at: new Date(origin).toISOString() });
      expect(signals.events).toEqual([{ pid: -pid, signal: "SIGTERM" }]);
      await waitForTerm(record.run_dir);
      expect(activeGroup(pid)).toContain(invocation.pid);
      vi.setSystemTime(origin + 9999);
      await completedWithinWindow(registry.pollOnce());
      expect(readDurable(record.run_dir)).toEqual(intent);
      expect(registry.get(adopted.id).status).toBe("stopping");
      vi.setSystemTime(origin + 10000);
      await waitForRecovery(async () => {
        await registry.pollOnce();
        return registry.get(adopted.id).status === "killed";
      }, "adopted cancellation and parent completion");
      expect(await adopted.hooks.done).toMatchObject({ status: "killed" });
      expect(readDurable(record.run_dir)).toMatchObject({
        exit_code: null,
        cancel_requested_at: intent.cancel_requested_at,
      });
      expect((await registry.collectShud(record.run_id)).exit_class).toBe("cancelled");
      expect(signals.events).toEqual([
        { pid: -pid, signal: "SIGTERM" },
        { pid: -pid, signal: "SIGKILL" },
      ]);
      expect(activeGroup(pid)).toEqual([]);
      expect(await io.readFile(invocationPath)).toEqual(invocationBytes);
      expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(invocationMtime);
      expect(h.sessionEvents).toEqual([]);
      expect(h.flushes).toEqual([]);
      expect(h.errors).toEqual([]);
    } finally {
      try {
        preCleanup = {
          phase: "pre-cleanup",
          registrations: capture?.registrations.length ?? 0,
          durable:
            runDir === undefined
              ? { unavailable: "run directory was not established" }
              : readDurable(runDir),
        };
      } catch (error) {
        preCleanup = {
          phase: "pre-cleanup",
          registrations: capture?.registrations.length ?? 0,
          durable: { unavailable: error },
        };
      }
      try {
        capture?.restore();
        unsubscribe?.();
        signals?.restore();
        for (const registration of capture?.registrations ?? [])
          registration.hooks.cancel("test cleanup");
        await closeRecovery(h, pid, applying);
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    }
  },
  15000,
);

test.each([false, true])(
  "adopted teardown during grace=%s completes its actual done and preserves durable execution evidence",
  async (grace) => {
    const h = await pollFixture();
    let pid: number | undefined;
    let applying: ReturnType<typeof h.apply> | undefined;
    let capture: ReturnType<typeof captureTakeovers> | undefined;
    let signals: ReturnType<typeof observeSignals> | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      if (grace) await installFakeShud(h.shudBin, 0, "resistant");
      const { record, invocation, pid: originalPid } = await stopWhileRunning(h);
      pid = originalPid;
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      const origin = Date.now();
      vi.setSystemTime(origin);
      capture = captureTakeovers();
      applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      await completedWithinWindow(applying);
      const fiber = await applying;
      const registry = actualRegistry(h.ctx);
      const adopted = capture.registrations[0];
      if (!adopted) throw new Error("Takeover did not expose actual producer hooks");
      const events: JobEvent[] = [];
      unsubscribe = registry.events.subscribe({ owners: "all" }, (event) => {
        events.push(structuredClone(event));
      });
      const committed = await readRecord(record.run_dir);
      expect(committed.dsh_job_id).toBe(adopted.id);
      expect(committed.dsh_job_ids).toEqual([...record.dsh_job_ids, adopted.id]);
      signals = observeSignals();
      if (grace) {
        expect(registry.kill(adopted.id, h.ownerId, "adopted cancellation")).toBe("requested");
        await waitForTerm(record.run_dir);
        await io.rm(join(record.run_dir, "sigterm-seen"));
        expect(signals.events).toEqual([{ pid: -pid, signal: "SIGTERM" }]);
        vi.setSystemTime(origin + 5000);
      } else {
        await completedWithinWindow(h.releaseOwner());
        expect(registry.get(adopted.id).status).toBe("running");
        expect(signals.events).toEqual([]);
        expect(events.filter((event) => event.type === "stopping")).toEqual([]);
      }
      const retained = await readRecord(record.run_dir);
      expect(retained).toEqual({
        ...committed,
        cancel_requested_at: grace ? new Date(origin).toISOString() : null,
      });
      const snapshots = await Promise.all(
        [
          join(record.run_dir, "run-job.json"),
          join(record.run_dir, "invocation.json"),
          join(h.stateDir, "active.json"),
          join(h.stateDir, "completed.json"),
        ].map(async (path) => ({
          path,
          bytes: await io.readFile(path),
          mtime: (await io.stat(path, { bigint: true })).mtimeNs,
        })),
      );
      const disposing = Promise.resolve(fiber.dispose());
      await completedWithinWindow(Promise.all([adopted.hooks.done, disposing]));
      const outcome = await adopted.hooks.done;
      expect(outcome.status).toBe("failed");
      expect(outcome.detail).toMatch(/host.*exit/iu);
      expect(outcome.detail).toMatch(grace ? /kill.*progress/iu : /continu|background/iu);
      expect(outcome.detail).not.toMatch(/cancel threw|orphan/iu);
      await waitForOwnershipRelease(h.stateDir);
      expect(events.filter((event) => event.type === "settled")).toMatchObject([
        { cause: "teardown", job: { id: adopted.id, status: "failed", detail: outcome.detail } },
      ]);
      expect(signals.events).toEqual(
        grace
          ? [
              { pid: -pid, signal: "SIGTERM" },
              { pid: -pid, signal: "SIGTERM" },
            ]
          : [],
      );
      if (grace) await waitForTerm(record.run_dir);
      else expect(activeGroup(pid)).toContain(pid);
      expect(activeGroup(pid)).toContain(invocation.pid);
      for (const snapshot of snapshots) {
        expect(await io.readFile(snapshot.path)).toEqual(snapshot.bytes);
        expect((await io.stat(snapshot.path, { bigint: true })).mtimeNs).toBe(snapshot.mtime);
      }
      expect(await readRecord(record.run_dir)).toEqual(retained);
      await expectAbsent(join(record.run_dir, "run-record.json"));
      await expectAbsent(join(record.run_dir, "exit_code"));
      if (!grace) {
        // A third actual instance must append once despite the previous non-null current id.
        unsubscribe();
        applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
        await completedWithinWindow(applying);
        const third = actualRegistry(h.ctx);
        expect(capture.registrations).toHaveLength(2);
        const latest = capture.registrations[1];
        if (!latest) throw new Error("Third instance did not acquire a fresh registration");
        expect(latest.id).not.toBe(adopted.id);
        expect(latest.id).not.toBe(record.dsh_job_id);
        const expected = {
          ...retained,
          dsh_job_id: latest.id,
          dsh_job_ids: [...retained.dsh_job_ids, latest.id],
        };
        expect(await readRecord(record.run_dir)).toEqual(expected);
        for (let tick = 0; tick < 3; tick++) await completedWithinWindow(third.pollOnce());
        expect(capture.registrations).toHaveLength(2);
        expect(third.list().map((job) => job.id)).toEqual([latest.id]);
        expect(await readRecord(record.run_dir)).toEqual(expected);
        expect(activeGroup(pid)).toContain(pid);
        expect(activeGroup(pid)).toContain(invocation.pid);
        expect(signals.events).toEqual([]);
      }
      expect(h.sessionEvents).toEqual([]);
      expect(h.flushes).toEqual([]);
      expect(h.errors).toEqual([]);
    } finally {
      capture?.restore();
      unsubscribe?.();
      signals?.restore();
      for (const registration of capture?.registrations ?? [])
        registration.hooks.cancel("test cleanup");
      try {
        await closeRecovery(h, pid, applying);
      } finally {
        vi.useRealTimers();
      }
    }
  },
  15000,
);

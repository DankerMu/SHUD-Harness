import * as io from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { generateRunIdentifiers, NOTIFY_RETRY_INTERVAL_MS } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { pollFixture, readRecord, waitForOwnershipRelease } from "./poll-shud/test-harness.ts";
import { waitForRecovery } from "./reconcile-shud/test-harness.ts";
import { barrier, persisted } from "./state-indexes/test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";
import { createHarness } from "./test-harness.ts";
import { collectedWake, deliveredWake, expectWakeEvidence } from "./wake-shud/test-harness.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test.each(["resolved", "rejected"] as const)(
  "a %s restoration from a revoked controller epoch cannot append or consume an attempt",
  async (outcome) => {
    const h = await pollFixture(0, "held", "absent");
    const release = barrier();
    let ticking: Promise<void> | undefined;
    let restoreResolve: (() => void) | undefined;
    try {
      const run = await collectedWake(h);
      const controller = await h.mountSessionController();
      const resolve = h.ctx.sessionController.resolveAgent.bind(h.ctx.sessionController);
      let entered = false;
      const spy = vi
        .spyOn(h.ctx.sessionController, "resolveAgent")
        .mockImplementation(async (id) => {
          entered = true;
          await release.waiting;
          if (outcome === "rejected") throw new Error("PRIVATE_REVOKED_RESTORE_PAYLOAD");
          return resolve(id);
        });
      restoreResolve = () => spy.mockRestore();
      ticking = waitForRecovery(async () => {
        await h.registry.pollOnce();
        return entered;
      }, "delivery through the original controller epoch");
      void ticking.catch(() => undefined);
      await waitForRecovery(() => entered, "the held public resolver");
      const before = await readRecord(run.running.run_dir);
      await controller.dispose();
      await waitForRecovery(
        () => h.ctx.get("sessionController") === undefined,
        "controller service revocation",
      );
      release.release();
      await ticking;
      expect((await readRecord(run.running.run_dir)).notify).toEqual(before.notify);
      expect(h.followups).toEqual([]);
      expect(h.flushes).toEqual([]);
      expect(h.registry.indexes.read()).toEqual({ active: [run.entry], completed: [] });
      expect(h.errors.join("\n")).not.toContain("PRIVATE_REVOKED_RESTORE_PAYLOAD");
      restoreResolve();
      restoreResolve = undefined;
      await h.mountSessionController();
      await deliveredWake(h.registry, run.running.run_dir);
      expect(h.followups).toHaveLength(1);
      expect(h.flushes).toEqual([h.ownerId]);
      expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
        status: "delivered",
        attempts: 0,
      });
      await expectWakeEvidence(run);
    } finally {
      release.release();
      await ticking?.catch(() => undefined);
      restoreResolve?.();
      await h.close();
    }
  },
  15000,
);

test("registry disposal drains an accepted flush and delivered publication before releasing the state lock", async () => {
  const h = await pollFixture(0, "held", "available");
  const contender = await createHarness(undefined, "absent");
  const release = barrier();
  let ticking: Promise<void> | undefined;
  let disposing: Promise<void> | undefined;
  let restoreFlush: (() => void) | undefined;
  try {
    const run = await collectedWake(h);
    const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
    let entered = false;
    const spy = vi.spyOn(h.ctx.sessions, "flush").mockImplementation(async (session) => {
      const acknowledged = await flush(session);
      entered = true;
      await release.waiting;
      return acknowledged;
    });
    restoreFlush = () => spy.mockRestore();
    ticking = waitForRecovery(async () => {
      await h.registry.pollOnce();
      return entered;
    }, "accepted flush completion");
    void ticking.catch(() => undefined);
    await waitForRecovery(() => entered, "the held flush acknowledgement");
    disposing = Promise.resolve(h.fiber.dispose());
    await waitForRecovery(async () => {
      try {
        await h.registry.submitShud(
          { ...h.request, project: "../admission-probe" },
          run.producer.start,
        );
      } catch (error) {
        return error instanceof Error && /closed/u.test(error.message);
      }
      return false;
    }, "closed submission admission while accepted flush drains");
    const refused: unknown = await contender.apply(ShudJobRegistry, h.config).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect(refused instanceof Error ? refused.message : null).toContain(h.stateDir);
    expect(await io.readdir(h.stateDir)).toContain("lock");
    expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    expect(await persisted(h.stateDir)).toEqual([run.entry]);
    expect(await persisted(h.stateDir, "completed.json")).toEqual([]);
    release.release();
    await ticking;
    await disposing;
    await waitForOwnershipRelease(h.stateDir);
    expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
      status: "delivered",
      attempts: 0,
    });
    expect(await persisted(h.stateDir)).toEqual([]);
    expect(await persisted(h.stateDir, "completed.json")).toEqual([run.entry]);
    await contender.apply(ShudJobRegistry, h.config);
    expect(actualRegistry(contender.ctx).indexes.read()).toEqual({
      active: [],
      completed: [run.entry],
    });
    expect(h.followups).toHaveLength(1);
    expect(h.flushes).toEqual([h.ownerId]);
    await expectWakeEvidence(run);
  } finally {
    release.release();
    await ticking?.catch(() => undefined);
    await disposing?.catch(() => undefined);
    restoreFlush?.();
    await contender.dispose();
    await h.close();
  }
}, 15000);

test.each(["same live Session", "replacement Session"] as const)(
  "reload after append and failed flush respects the %s receipt boundary",
  async (sessionKind) => {
    const h = await pollFixture(0, "held", "available");
    const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
    const spy = vi.spyOn(h.ctx.sessions, "flush").mockImplementation(async (session) => {
      const acknowledged = await flush(session);
      return h.flushes.length === 1 ? false : acknowledged;
    });
    try {
      const run = await collectedWake(h);
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        return h.flushes.length > 0;
      }, "confirmed append and failed flush before registry reload");
      expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
        status: "pending",
        attempts: 1,
      });
      expect(h.followups).toHaveLength(1);
      const first = h.followups[0];
      const originalSession = h.ctx.sessions.get(h.ownerId);
      await h.fiber.dispose();
      await waitForOwnershipRelease(h.stateDir);
      if (sessionKind === "replacement Session") h.replaceOwnerSession();
      await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      const replacement = actualRegistry(h.ctx);
      const currentSession = h.ctx.sessions.get(h.ownerId);
      if (sessionKind === "same live Session") expect(currentSession).toBe(originalSession);
      else expect(currentSession).not.toBe(originalSession);
      vi.setSystemTime(run.origin + NOTIFY_RETRY_INTERVAL_MS);
      await deliveredWake(replacement, run.running.run_dir);
      const count = sessionKind === "same live Session" ? 1 : 2;
      expect(h.followups).toHaveLength(count);
      expect(h.followups[0]).toEqual(first);
      const deliveredMessage = h.followups[count - 1].message;
      expect(h.flushes).toEqual([h.ownerId, h.ownerId]);
      expect(h.flushObservations).toEqual([
        { sessionId: h.ownerId, messages: [first.message] },
        { sessionId: h.ownerId, messages: [deliveredMessage] },
      ]);
      expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
        status: "delivered",
        attempts: 1,
      });
      expect(replacement.indexes.read()).toEqual({ active: [], completed: [run.entry] });
      await expectWakeEvidence(run);
    } finally {
      try {
        await h.close();
      } finally {
        spy.mockRestore();
      }
    }
  },
  15000,
);

test.each(["run_id", "job_id", "run_dir"] as const)(
  "a different persisted %s cannot inherit a confirmed append for another full run identity",
  async (field) => {
    const h = await pollFixture(0, "held", "available");
    const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
    const spy = vi.spyOn(h.ctx.sessions, "flush").mockImplementation(async (session) => {
      const acknowledged = await flush(session);
      return h.flushes.length === 1 ? false : acknowledged;
    });
    try {
      const run = await collectedWake(h);
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        return h.flushes.length > 0;
      }, "the original identity's confirmed append");
      const pending = await readRecord(run.running.run_dir);
      expect(pending.notify).toMatchObject({ status: "pending", attempts: 1 });
      expect(h.followups).toHaveLength(1);
      await h.fiber.dispose();
      await waitForOwnershipRelease(h.stateDir);
      const ids = generateRunIdentifiers();
      const runDir =
        field === "run_dir"
          ? join(h.cwd, "runs", `relocated-${run.running.run_id}`)
          : run.running.run_dir;
      if (field === "run_dir") await io.rename(run.running.run_dir, runDir);
      const replacementJob = {
        ...pending,
        run_id: field === "run_id" ? ids.run_id : pending.run_id,
        job_id: field === "job_id" ? ids.job_id : pending.job_id,
        run_dir: runDir,
      };
      const replacementResult = {
        ...run.result,
        run_id: replacementJob.run_id,
        job_id: replacementJob.job_id,
        artifacts: {
          ...run.result.artifacts,
          stdout: join(runDir, "stdout.log"),
          stderr: join(runDir, "stderr.log"),
          shud_output: join(runDir, "output", "tiny.out"),
        },
      };
      const entry = {
        run_id: replacementJob.run_id,
        job_id: replacementJob.job_id,
        run_dir: runDir,
      };
      // Fixture-only checkpoint replacement while no registry owns the files: exactly one
      // identity component differs, with consistent index, RunJob and immutable-result routing.
      await io.writeFile(join(runDir, "run-job.json"), JSON.stringify(replacementJob));
      const resultPath = join(runDir, "run-record.json");
      await io.writeFile(resultPath, JSON.stringify(replacementResult));
      await io.writeFile(join(h.stateDir, "active.json"), JSON.stringify([entry]));
      const resultBytes = await io.readFile(resultPath);
      const resultMtime = (await io.stat(resultPath, { bigint: true })).mtimeNs;
      await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      const replacement = actualRegistry(h.ctx);
      vi.setSystemTime(run.origin + NOTIFY_RETRY_INTERVAL_MS);
      await deliveredWake(replacement, runDir);
      expect(h.followups).toHaveLength(2);
      expect(h.followups.every(({ sessionId }) => sessionId === h.ownerId)).toBe(true);
      expect(h.flushes).toEqual([h.ownerId, h.ownerId]);
      expect(h.flushObservations[1].messages).toEqual(h.followups.map(({ message }) => message));
      expect(replacement.indexes.read()).toEqual({ active: [], completed: [entry] });
      await expectWakeEvidence({
        running: replacementJob,
        invocation: run.invocation,
        result: replacementResult,
        resultPath,
        resultBytes,
        resultMtime,
      });
    } finally {
      try {
        await h.close();
      } finally {
        spy.mockRestore();
      }
    }
  },
  15000,
);

test("cold owner restoration cannot make registry activation await its own completion", async () => {
  const h = await pollFixture(0, "held", "absent");
  const activationReturned = barrier();
  let applying: Promise<unknown> | undefined;
  let restoreResolve: (() => void) | undefined;
  try {
    const run = await collectedWake(h);
    await h.fiber.dispose();
    await waitForOwnershipRelease(h.stateDir);
    await h.mountSessionController();
    const resolve = h.ctx.sessionController.resolveAgent.bind(h.ctx.sessionController);
    const spy = vi.spyOn(h.ctx.sessionController, "resolveAgent").mockImplementation(async (id) => {
      // Model the public cold-owner dependency on completion of the host row's activation.
      await activationReturned.waiting;
      return resolve(id);
    });
    restoreResolve = () => spy.mockRestore();
    let applied = false;
    applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 }).then(() => {
      applied = true;
      activationReturned.release();
    });
    void applying.catch(() => undefined);
    await waitForRecovery(
      () => applied,
      "registry activation before cold-owner restoration can finish",
    );
    await applying;
    const replacement = actualRegistry(h.ctx);
    await deliveredWake(replacement, run.running.run_dir);
    expect(h.followups).toHaveLength(1);
    expect(h.flushes).toEqual([h.ownerId]);
    expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
      status: "delivered",
      attempts: 0,
    });
    expect(replacement.indexes.read()).toEqual({ active: [], completed: [run.entry] });
    await expectWakeEvidence(run);
  } finally {
    activationReturned.release();
    await applying?.catch(() => undefined);
    restoreResolve?.();
    await h.close();
  }
}, 15000);

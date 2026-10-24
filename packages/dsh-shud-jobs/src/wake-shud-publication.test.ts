import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as NodeFs from "node:fs";
import type * as NodeIo from "node:fs/promises";
import {
  generateRunIdentifiers,
  MAX_NOTIFY_ATTEMPTS,
  NOTIFY_RETRY_INTERVAL_MS,
  RunJobSchema,
} from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { pollFixture, readRecord, waitForOwnershipRelease } from "./poll-shud/test-harness.ts";
import { waitForRecovery } from "./reconcile-shud/test-harness.ts";
import { persisted } from "./state-indexes/test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";
import { collectedWake, deliveredWake, expectWakeEvidence } from "./wake-shud/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualFs = await vi.importActual<typeof NodeFs>("node:fs");
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actualFs.renameSync);
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("a failed delivered-marker publication retries the durable mark without reappend or reflush", async () => {
  const h = await pollFixture(0, "held", "available");
  let blocked = true;
  try {
    const run = await collectedWake(h);
    const jobPath = join(run.running.run_dir, "run-job.json");
    let rejected = 0;
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (blocked && target === jobPath) {
        const candidate = RunJobSchema.parse(JSON.parse(actualFs.readFileSync(source, "utf8")));
        if (candidate.notify.status === "delivered") {
          rejected++;
          throw Object.assign(new Error("delivered marker write refused"), { code: "EIO" });
        }
      }
      actualFs.renameSync(source, target);
    });
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      return rejected > 0;
    }, "positive flush followed by a rejected delivered-marker rename");
    expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    expect(h.followups).toHaveLength(1);
    const [accepted] = h.followups;
    expect(h.flushes).toEqual([h.ownerId]);
    expect(h.flushObservations).toEqual([{ sessionId: h.ownerId, messages: [accepted.message] }]);
    expect(h.registry.indexes.read()).toEqual({ active: [run.entry], completed: [] });
    await h.registry.pollOnce();
    await h.registry.pollOnce();
    expect(h.followups).toEqual([accepted]);
    expect(h.flushes).toEqual([h.ownerId]);
    expect(h.errors.join("\n")).toMatch(/EIO/u);
    blocked = false;
    await deliveredWake(h.registry, run.running.run_dir);
    expect(h.followups).toEqual([accepted]);
    expect(h.flushes).toEqual([h.ownerId]);
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [run.entry] });
    await expectWakeEvidence(run);
  } finally {
    blocked = false;
    vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
    await h.close();
  }
}, 15000);

test.each([
  ["completed.json", "ordinary poll"],
  ["active.json", "ordinary poll"],
  ["completed.json", "registry reload"],
  ["active.json", "registry reload"],
] as const)(
  "%s repair through %s keeps the wake unique",
  async (file, recovery) => {
    const h = await pollFixture(0, "held", "available");
    let blocked = true;
    try {
      const run = await collectedWake(h);
      let rejected = 0;
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (blocked && target === join(h.stateDir, file)) {
          rejected++;
          if (file === "active.json")
            expect(await persisted(h.stateDir, "completed.json")).toEqual([run.entry]);
          throw Object.assign(new Error("index publication refused"), { code: "EIO" });
        }
        await actualIo.rename(source, target);
      });
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        return rejected > 0;
      }, "index interruption after durable delivered publication");
      const delivered = await readRecord(run.running.run_dir);
      expect(delivered.notify).toMatchObject({ status: "delivered", attempts: 0 });
      expect(await persisted(h.stateDir)).toEqual([run.entry]);
      expect(await persisted(h.stateDir, "completed.json")).toEqual(
        file === "active.json" ? [run.entry] : [],
      );
      expect(h.followups).toHaveLength(1);
      const [accepted] = h.followups;
      expect(h.flushes).toEqual([h.ownerId]);
      const resolutions = [...h.resolutions];
      const jobPath = join(run.running.run_dir, "run-job.json");
      const jobBytes = await io.readFile(jobPath);
      const jobMtime = (await io.stat(jobPath, { bigint: true })).mtimeNs;
      blocked = false;
      let registry = h.registry;
      if (recovery === "registry reload") {
        await h.fiber.dispose();
        await waitForOwnershipRelease(h.stateDir);
        await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
        registry = actualRegistry(h.ctx);
      }
      await registry.pollOnce();
      expect(registry.indexes.read()).toEqual({ active: [], completed: [run.entry] });
      await registry.pollOnce();
      expect(await persisted(h.stateDir)).toEqual([]);
      expect(await persisted(h.stateDir, "completed.json")).toEqual([run.entry]);
      expect(await io.readFile(jobPath)).toEqual(jobBytes);
      expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(jobMtime);
      expect(h.resolutions).toEqual(resolutions);
      expect(h.followups).toEqual([accepted]);
      expect(h.flushes).toEqual([h.ownerId]);
      await expectWakeEvidence(run);
    } finally {
      blocked = false;
      vi.mocked(io.rename).mockImplementation(actualIo.rename);
      await h.close();
    }
  },
  15000,
);

test("malformed terminal notification metadata cannot authorize ordinary or startup index migration", async () => {
  const h = await pollFixture(0, "held", "available");
  try {
    const run = await collectedWake(h);
    const jobPath = join(run.running.run_dir, "run-job.json");
    const collected = await readRecord(run.running.run_dir);
    await io.writeFile(
      jobPath,
      JSON.stringify({
        ...collected,
        notify: { status: "delivered", attempts: -1, at: null, detail: null },
      }),
    );
    const bytes = await io.readFile(jobPath);
    const mtime = (await io.stat(jobPath, { bigint: true })).mtimeNs;
    await h.registry.pollOnce();
    expect(h.registry.indexes.read()).toEqual({ active: [run.entry], completed: [] });
    await h.fiber.dispose();
    await waitForOwnershipRelease(h.stateDir);
    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    const replacement = actualRegistry(h.ctx);
    await replacement.pollOnce();
    expect(replacement.indexes.read()).toEqual({ active: [run.entry], completed: [] });
    expect(await io.readFile(jobPath)).toEqual(bytes);
    expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(mtime);
    expect(h.followups).toEqual([]);
    expect(h.flushes).toEqual([]);
    await expectWakeEvidence(run);
  } finally {
    await h.close();
  }
}, 15000);

test.each(["flush", "restoration"] as const)(
  "%s failure accounting retries its original publication across reload before any more transport",
  async (stage) => {
    const h = await pollFixture(0, "held", "available");
    const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
    const resolve = h.ctx.sessionController.resolveAgent.bind(h.ctx.sessionController);
    let resolves = 0;
    const resolveSpy = vi
      .spyOn(h.ctx.sessionController, "resolveAgent")
      .mockImplementation(async (id) => {
        resolves++;
        if (stage === "restoration" && resolves === 1)
          throw new Error("PRIVATE_RESTORE_ACCOUNTING_PAYLOAD");
        return resolve(id);
      });
    const flushSpy = vi.spyOn(h.ctx.sessions, "flush").mockImplementation(async (session) => {
      const acknowledged = await flush(session);
      return stage === "flush" && h.flushes.length === 1 ? false : acknowledged;
    });
    let blocked = true;
    try {
      const run = await collectedWake(h);
      const jobPath = join(run.running.run_dir, "run-job.json");
      const before = await readRecord(run.running.run_dir);
      let rejected = 0;
      vi.mocked(fs.renameSync).mockImplementation((source, target) => {
        if (blocked && target === jobPath) {
          const candidate = RunJobSchema.parse(JSON.parse(actualFs.readFileSync(source, "utf8")));
          if (candidate.notify.attempts > before.notify.attempts) {
            rejected++;
            throw Object.assign(new Error("PRIVATE_ACCOUNTING_IO_PAYLOAD"), { code: "EIO" });
          }
        }
        actualFs.renameSync(source, target);
      });
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        return rejected > 0;
      }, "the actual failure followed by accounting-publication EIO");
      const unpublished = await io.readFile(jobPath);
      const unpublishedMtime = (await io.stat(jobPath, { bigint: true })).mtimeNs;
      expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
        status: "pending",
        attempts: before.notify.attempts,
        at: before.notify.at,
      });
      expect(resolves).toBe(1);
      expect(h.followups).toHaveLength(stage === "flush" ? 1 : 0);
      expect(h.flushes).toHaveLength(stage === "flush" ? 1 : 0);
      const accepted = [...h.followups];
      const flushes = [...h.flushes];
      vi.setSystemTime(run.origin + 1000);
      await h.registry.pollOnce();
      await h.registry.pollOnce();
      expect(resolves).toBe(1);
      expect(h.followups).toEqual(accepted);
      expect(h.flushes).toEqual(flushes);
      expect(await io.readFile(jobPath)).toEqual(unpublished);
      expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(unpublishedMtime);

      await h.fiber.dispose();
      await waitForOwnershipRelease(h.stateDir);
      await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      const replacement = actualRegistry(h.ctx);
      await replacement.pollOnce();
      await replacement.pollOnce();
      expect(resolves).toBe(1);
      expect(h.followups).toEqual(accepted);
      expect(h.flushes).toEqual(flushes);
      expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
        status: "pending",
        attempts: before.notify.attempts,
        at: before.notify.at,
      });
      expect(replacement.indexes.read()).toEqual({ active: [run.entry], completed: [] });
      expect(h.errors.join("\n")).toMatch(/EIO/u);
      expect(h.errors.join("\n")).not.toMatch(
        /PRIVATE_(?:ACCOUNTING_IO|RESTORE_ACCOUNTING)_PAYLOAD/u,
      );
      expect(unpublished.toString()).not.toContain("PRIVATE_");

      blocked = false;
      await waitForRecovery(async () => {
        await replacement.pollOnce();
        return (await readRecord(run.running.run_dir)).notify.attempts === 1;
      }, "publication of the original failure after accounting storage recovers");
      const accounted = await readRecord(run.running.run_dir);
      expect(accounted.notify.detail).toMatch(
        stage === "flush" ? /flush|persist|acknowledg/iu : /resolv|restor/iu,
      );
      expect(accounted.notify).toMatchObject({
        status: "pending",
        attempts: 1,
        at: new Date(run.origin).toISOString(),
      });
      expect(resolves).toBe(1);
      expect(h.followups).toEqual(accepted);
      expect(h.flushes).toEqual(flushes);
      vi.setSystemTime(run.origin + NOTIFY_RETRY_INTERVAL_MS - 1);
      await replacement.pollOnce();
      expect(resolves).toBe(1);
      vi.setSystemTime(run.origin + NOTIFY_RETRY_INTERVAL_MS);
      await deliveredWake(replacement, run.running.run_dir);
      expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
        status: "delivered",
        attempts: 1,
      });
      expect(h.followups).toHaveLength(1);
      expect(h.flushes).toHaveLength(stage === "flush" ? 2 : 1);
      expect(replacement.indexes.read()).toEqual({ active: [], completed: [run.entry] });
      await expectWakeEvidence(run);
    } finally {
      blocked = false;
      vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
      try {
        await h.close();
      } finally {
        flushSpy.mockRestore();
        resolveSpy.mockRestore();
      }
    }
  },
  15000,
);

test("an accounting rename that committed before reporting failure is not counted or written twice", async () => {
  const h = await pollFixture(0, "held", "available");
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
  const spy = vi.spyOn(h.ctx.sessions, "flush").mockImplementation(async (session) => {
    const acknowledged = await flush(session);
    return h.flushes.length === 1 ? false : acknowledged;
  });
  try {
    const run = await collectedWake(h);
    const jobPath = join(run.running.run_dir, "run-job.json");
    let reported = false;
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      const candidate =
        target === jobPath
          ? RunJobSchema.parse(JSON.parse(actualFs.readFileSync(source, "utf8")))
          : undefined;
      actualFs.renameSync(source, target);
      if (!reported && candidate?.notify.attempts === 1) {
        reported = true;
        throw Object.assign(new Error("PRIVATE_COMMITTED_RENAME_PAYLOAD"), { code: "EIO" });
      }
    });
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      return reported;
    }, "a committed failure-accounting rename reporting EIO");
    expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
      status: "pending",
      attempts: 1,
      at: new Date(run.origin).toISOString(),
    });
    const bytes = await io.readFile(jobPath);
    const mtime = (await io.stat(jobPath, { bigint: true })).mtimeNs;
    await h.registry.pollOnce();
    await h.registry.pollOnce();
    expect(await io.readFile(jobPath)).toEqual(bytes);
    expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(mtime);
    expect(h.followups).toHaveLength(1);
    expect(h.flushes).toEqual([h.ownerId]);
    expect(h.errors.join("\n")).not.toContain("PRIVATE_COMMITTED_RENAME_PAYLOAD");
    vi.setSystemTime(run.origin + NOTIFY_RETRY_INTERVAL_MS);
    await deliveredWake(h.registry, run.running.run_dir);
    expect((await readRecord(run.running.run_dir)).notify.attempts).toBe(1);
    expect(h.followups).toHaveLength(1);
    expect(h.flushes).toEqual([h.ownerId, h.ownerId]);
    await expectWakeEvidence(run);
  } finally {
    vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
    try {
      await h.close();
    } finally {
      spy.mockRestore();
    }
  }
}, 15000);

test("an unknown changed accounting detail blocks transport until the committed detail is restored", async () => {
  const h = await pollFixture(0, "held", "available");
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
  const spy = vi.spyOn(h.ctx.sessions, "flush").mockImplementation(async (session) => {
    const acknowledged = await flush(session);
    return h.flushes.length === 1 ? false : acknowledged;
  });
  try {
    const run = await collectedWake(h);
    const jobPath = join(run.running.run_dir, "run-job.json");
    let reported = false;
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      const candidate =
        target === jobPath
          ? RunJobSchema.parse(JSON.parse(actualFs.readFileSync(source, "utf8")))
          : undefined;
      actualFs.renameSync(source, target);
      if (!reported && candidate?.notify.attempts === 1) {
        reported = true;
        throw Object.assign(new Error("PRIVATE_CHANGED_DETAIL_RENAME_PAYLOAD"), { code: "EIO" });
      }
    });
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      return reported;
    }, "committed accounting retained after rename EIO");
    const accounted = await readRecord(run.running.run_dir);
    expect(accounted.notify).toMatchObject({
      status: "pending",
      attempts: 1,
      at: new Date(run.origin).toISOString(),
    });
    expect(accounted.notify.detail).toMatch(/flush|persist|acknowledg/iu);
    const accepted = [...h.followups];
    const resolutions = [...h.resolutions];
    expect(accepted).toHaveLength(1);
    expect(h.flushes).toEqual([h.ownerId]);
    await io.writeFile(
      jobPath,
      JSON.stringify({
        ...accounted,
        notify: { ...accounted.notify, detail: "PRIVATE_UNKNOWN_ACCOUNTING_DETAIL" },
      }),
    );
    const changedBytes = await io.readFile(jobPath);
    const changedMtime = (await io.stat(jobPath, { bigint: true })).mtimeNs;
    vi.setSystemTime(run.origin + NOTIFY_RETRY_INTERVAL_MS);
    // More than one step distinguishes rejecting the checkpoint from accepting it then retrying.
    await h.registry.pollOnce();
    await h.registry.pollOnce();
    await h.registry.pollOnce();
    expect(await io.readFile(jobPath)).toEqual(changedBytes);
    expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(changedMtime);
    expect(h.registry.indexes.read()).toEqual({ active: [run.entry], completed: [] });
    expect(h.resolutions).toEqual(resolutions);
    expect(h.followups).toEqual(accepted);
    expect(h.flushes).toEqual([h.ownerId]);
    expect(h.errors.join("\n")).not.toMatch(/PRIVATE_(?:UNKNOWN|CHANGED_DETAIL)/u);
    expect(JSON.stringify(h.followups)).not.toContain("PRIVATE_");

    await io.writeFile(jobPath, JSON.stringify(accounted));
    await deliveredWake(h.registry, run.running.run_dir);
    expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
      status: "delivered",
      attempts: 1,
    });
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [run.entry] });
    expect(h.followups).toEqual(accepted);
    expect(h.flushes).toEqual([h.ownerId, h.ownerId]);
    await expectWakeEvidence(run);
  } finally {
    vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
    spy.mockRestore();
    await h.close();
  }
}, 15000);

test.each(["flush", "restoration"] as const)(
  "%s accounting committed before EIO survives service revocation and headless registry reload",
  async (stage) => {
    const h = await pollFixture(0, "held", "absent");
    let restoreResolve: (() => void) | undefined;
    let restoreFlush: (() => void) | undefined;
    try {
      const run = await collectedWake(h);
      const controller = await h.mountSessionController();
      const resolve = h.ctx.sessionController.resolveAgent.bind(h.ctx.sessionController);
      let resolves = 0;
      const resolveSpy = vi
        .spyOn(h.ctx.sessionController, "resolveAgent")
        .mockImplementation(async (id) => {
          resolves++;
          if (stage === "restoration" && resolves === 1)
            throw new Error("PRIVATE_POSTCOMMIT_RESTORATION_PAYLOAD");
          return resolve(id);
        });
      restoreResolve = () => resolveSpy.mockRestore();
      const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
      const flushedSessions: Array<Parameters<typeof flush>[0]> = [];
      const flushSpy = vi.spyOn(h.ctx.sessions, "flush").mockImplementation(async (session) => {
        flushedSessions.push(session);
        const acknowledged = await flush(session);
        return stage === "flush" && h.flushes.length === 1 ? false : acknowledged;
      });
      restoreFlush = () => flushSpy.mockRestore();
      const jobPath = join(run.running.run_dir, "run-job.json");
      let reported = false;
      vi.mocked(fs.renameSync).mockImplementation((source, target) => {
        const candidate =
          target === jobPath
            ? RunJobSchema.parse(JSON.parse(actualFs.readFileSync(source, "utf8")))
            : undefined;
        actualFs.renameSync(source, target);
        if (!reported && candidate?.notify.attempts === 1) {
          reported = true;
          throw Object.assign(new Error("PRIVATE_POSTCOMMIT_ACCOUNTING_PAYLOAD"), {
            code: "EIO",
          });
        }
      });
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        return reported;
      }, "failure accounting actually committed before reporting EIO");
      const accounted = await readRecord(run.running.run_dir);
      expect(accounted.notify).toMatchObject({
        status: "pending",
        attempts: 1,
        at: new Date(run.origin).toISOString(),
      });
      expect(accounted.notify.detail).toMatch(
        stage === "flush" ? /flush|persist|acknowledg/iu : /resolv|restor/iu,
      );
      expect(resolves).toBe(1);
      expect(h.resolutions).toEqual(stage === "flush" ? [h.ownerId] : []);
      expect(h.followups).toHaveLength(stage === "flush" ? 1 : 0);
      expect(h.flushes).toHaveLength(stage === "flush" ? 1 : 0);
      const accepted = [...h.followups];
      const flushes = [...h.flushes];
      const resolutions = [...h.resolutions];

      // No repair poll may run between the committed rename and actual epoch revocation.
      await controller.dispose();
      await waitForRecovery(
        () => h.ctx.get("sessionController") === undefined,
        "controller service removal before accounting reconciliation",
      );
      restoreResolve();
      restoreResolve = undefined;
      vi.setSystemTime(run.origin + 1000);
      await h.registry.pollOnce();
      const waiting = await readRecord(run.running.run_dir);
      expect(waiting).toEqual({
        ...accounted,
        notify: { ...accounted.notify, detail: waiting.notify.detail },
      });
      expect(waiting.notify.detail).toMatch(/wait.*session|session.*wait/iu);
      const waitingBytes = await io.readFile(jobPath);
      const waitingMtime = (await io.stat(jobPath, { bigint: true })).mtimeNs;
      await h.registry.pollOnce();
      expect(await io.readFile(jobPath)).toEqual(waitingBytes);
      expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(waitingMtime);
      expect(resolves).toBe(1);
      expect(h.resolutions).toEqual(resolutions);
      expect(h.followups).toEqual(accepted);
      expect(h.flushes).toEqual(flushes);

      await h.fiber.dispose();
      await waitForOwnershipRelease(h.stateDir);
      await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      const replacement = actualRegistry(h.ctx);
      await replacement.pollOnce();
      expect(await io.readFile(jobPath)).toEqual(waitingBytes);
      expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(waitingMtime);
      expect(replacement.indexes.read()).toEqual({ active: [run.entry], completed: [] });
      expect(resolves).toBe(1);
      expect(h.resolutions).toEqual(resolutions);
      expect(h.followups).toEqual(accepted);
      expect(h.flushes).toEqual(flushes);

      await h.mountSessionController();
      const remountedResolve = h.ctx.sessionController.resolveAgent.bind(h.ctx.sessionController);
      const remountedSpy = vi
        .spyOn(h.ctx.sessionController, "resolveAgent")
        .mockImplementation(async (id) => {
          resolves++;
          return remountedResolve(id);
        });
      restoreResolve = () => remountedSpy.mockRestore();
      vi.setSystemTime(run.origin + NOTIFY_RETRY_INTERVAL_MS - 1);
      await replacement.pollOnce();
      await replacement.pollOnce();
      expect(await io.readFile(jobPath)).toEqual(waitingBytes);
      expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(waitingMtime);
      expect(resolves).toBe(1);
      expect(h.resolutions).toEqual(resolutions);
      expect(h.followups).toEqual(accepted);
      expect(h.flushes).toEqual(flushes);

      vi.setSystemTime(run.origin + NOTIFY_RETRY_INTERVAL_MS);
      await deliveredWake(replacement, run.running.run_dir);
      expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
        status: "delivered",
        attempts: 1,
      });
      expect(replacement.indexes.read()).toEqual({ active: [], completed: [run.entry] });
      await replacement.pollOnce();
      expect(resolves).toBe(2);
      expect(h.followups).toHaveLength(1);
      if (stage === "flush") expect(h.followups).toEqual(accepted);
      expect(h.flushes).toEqual(stage === "flush" ? [h.ownerId, h.ownerId] : [h.ownerId]);
      expect(flushedSessions).toHaveLength(stage === "flush" ? 2 : 1);
      if (stage === "flush") expect(flushedSessions[1]).toBe(flushedSessions[0]);
      expect(h.flushObservations).toEqual(
        Array.from({ length: stage === "flush" ? 2 : 1 }, () => ({
          sessionId: h.ownerId,
          messages: [h.followups[0].message],
        })),
      );
      expect(h.sessionEvents.filter((event) => event.type === "job/settled")).toEqual([]);
      expect(h.errors.join("\n")).toMatch(/EIO/u);
      expect(h.errors.join("\n")).not.toMatch(/accounting checkpoint|PRIVATE_POSTCOMMIT/u);
      await expectWakeEvidence(run);
      expect(run.producer.executions).toHaveLength(1);
    } finally {
      vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
      restoreResolve?.();
      restoreFlush?.();
      await h.close();
    }
  },
  15000,
);

test.each(["run identity", "owner identity"] as const)(
  "a changed %s cannot inherit another obligation's unpublished failure budget",
  async (kind) => {
    const h = await pollFixture(0, "held", "available");
    const resolve = h.ctx.sessionController.resolveAgent.bind(h.ctx.sessionController);
    let resolves = 0;
    const spy = vi.spyOn(h.ctx.sessionController, "resolveAgent").mockImplementation(async (id) => {
      resolves++;
      if (resolves === 1) throw new Error("PRIVATE_FOREIGN_ACCOUNTING_PAYLOAD");
      return resolve(id);
    });
    try {
      const run = await collectedWake(h);
      const jobPath = join(run.running.run_dir, "run-job.json");
      let rejected = false;
      vi.mocked(fs.renameSync).mockImplementation((source, target) => {
        if (target === jobPath) {
          const candidate = RunJobSchema.parse(JSON.parse(actualFs.readFileSync(source, "utf8")));
          if (candidate.notify.attempts > 0) {
            rejected = true;
            throw Object.assign(new Error("accounting storage refused"), { code: "EIO" });
          }
        }
        actualFs.renameSync(source, target);
      });
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        return rejected;
      }, "the original obligation's unpublished restoration failure");
      expect(h.followups).toEqual([]);
      expect(h.flushes).toEqual([]);
      const prior = await readRecord(run.running.run_dir);
      expect(prior.notify).toMatchObject({ status: "pending", attempts: 0, at: null });
      await h.fiber.dispose();
      await waitForOwnershipRelease(h.stateDir);
      const ids = generateRunIdentifiers();
      const replacementJob = {
        ...prior,
        run_id: kind === "run identity" ? ids.run_id : prior.run_id,
        owner_session: kind === "owner identity" ? h.otherId : prior.owner_session,
      };
      const replacementResult = { ...run.result, run_id: replacementJob.run_id };
      const entry = { ...run.entry, run_id: replacementJob.run_id };
      // Replace the complete fixture checkpoint only after releasing registry ownership.
      await io.writeFile(jobPath, JSON.stringify(replacementJob));
      await io.writeFile(run.resultPath, JSON.stringify(replacementResult));
      await io.writeFile(join(h.stateDir, "active.json"), JSON.stringify([entry]));
      const resultBytes = await io.readFile(run.resultPath);
      const resultMtime = (await io.stat(run.resultPath, { bigint: true })).mtimeNs;
      vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
      await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      const replacement = actualRegistry(h.ctx);
      // No clock advance: importing the old failure would incorrectly impose its retry budget.
      await deliveredWake(replacement, replacementJob.run_dir);
      expect((await readRecord(replacementJob.run_dir)).notify).toMatchObject({
        status: "delivered",
        attempts: 0,
      });
      expect(h.followups).toHaveLength(1);
      expect(h.followups[0].sessionId).toBe(replacementJob.owner_session);
      expect(h.flushes).toEqual([replacementJob.owner_session]);
      expect(replacement.indexes.read()).toEqual({ active: [], completed: [entry] });
      await expectWakeEvidence({
        ...run,
        running: replacementJob,
        result: replacementResult,
        resultBytes,
        resultMtime,
      });
    } finally {
      vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
      try {
        await h.close();
      } finally {
        spy.mockRestore();
      }
    }
  },
  15000,
);

test("an unpublished capped failure completes atomically after storage recovery without another transport", async () => {
  const h = await pollFixture(0, "held", "available");
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
  const spy = vi.spyOn(h.ctx.sessions, "flush").mockImplementation(async (session) => {
    await flush(session);
    return false;
  });
  let blocked = true;
  try {
    const run = await collectedWake(h);
    const jobPath = join(run.running.run_dir, "run-job.json");
    let rejected = false;
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (blocked && target === jobPath) {
        const candidate = RunJobSchema.parse(JSON.parse(actualFs.readFileSync(source, "utf8")));
        if (candidate.notify.attempts === MAX_NOTIFY_ATTEMPTS) {
          rejected = true;
          throw Object.assign(new Error("terminal accounting write refused"), { code: "EIO" });
        }
      }
      actualFs.renameSync(source, target);
    });
    for (let attempt = 1; attempt <= MAX_NOTIFY_ATTEMPTS; attempt++) {
      vi.setSystemTime(run.origin + (attempt - 1) * NOTIFY_RETRY_INTERVAL_MS);
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        return h.flushes.length >= attempt;
      }, `actual flush failure ${attempt}`);
    }
    expect(rejected).toBe(true);
    expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
      status: "pending",
      attempts: MAX_NOTIFY_ATTEMPTS - 1,
      at: new Date(run.origin + (MAX_NOTIFY_ATTEMPTS - 2) * NOTIFY_RETRY_INTERVAL_MS).toISOString(),
    });
    const resolutions = [...h.resolutions];
    await h.registry.pollOnce();
    await h.registry.pollOnce();
    expect(h.resolutions).toEqual(resolutions);
    expect(h.flushes).toHaveLength(MAX_NOTIFY_ATTEMPTS);
    expect(h.followups).toHaveLength(1);
    blocked = false;
    await h.registry.pollOnce();
    expect((await readRecord(run.running.run_dir)).notify).toMatchObject({
      status: "unreachable",
      attempts: MAX_NOTIFY_ATTEMPTS,
      at: new Date(run.origin + (MAX_NOTIFY_ATTEMPTS - 1) * NOTIFY_RETRY_INTERVAL_MS).toISOString(),
    });
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [run.entry] });
    expect(h.resolutions).toEqual(resolutions);
    expect(h.flushes).toHaveLength(MAX_NOTIFY_ATTEMPTS);
    expect(h.followups).toHaveLength(1);
    await expectWakeEvidence(run);
  } finally {
    blocked = false;
    vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
    try {
      await h.close();
    } finally {
      spy.mockRestore();
    }
  }
}, 15000);

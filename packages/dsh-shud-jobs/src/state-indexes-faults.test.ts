import { randomUUID } from "node:crypto";
import * as io from "node:fs/promises";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type * as NodeIo from "node:fs/promises";
import type * as NodeFs from "node:fs";
import type * as NodeCrypto from "node:crypto";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import { ShudJobRegistry } from "./index.ts";
import { createHarness, producer } from "./test-harness.ts";
import { barrier, entry, persisted, publishedStore } from "./state-indexes/test-harness.ts";
import { createRegistryChild, type RegistryChild } from "./state-lock/test-harness.ts";

vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof NodeCrypto>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), unlinkSync: vi.fn(actual.unlinkSync) };
});
const realIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
const realFs = await vi.importActual<typeof NodeFs>("node:fs");
const realCrypto = await vi.importActual<typeof NodeCrypto>("node:crypto");
beforeEach(() => {
  vi.mocked(randomUUID).mockReset().mockImplementation(realCrypto.randomUUID);
  vi.mocked(io.open).mockReset().mockImplementation(realIo.open);
  vi.mocked(io.rename).mockReset().mockImplementation(realIo.rename);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(realFs.renameSync);
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(realFs.unlinkSync);
});
afterEach(() => vi.restoreAllMocks());

interface OwnershipEvidence {
  guard: { dev: number; ino: number };
  metadata: string;
  active: Buffer;
  completed: Buffer;
}

async function ownershipEvidence(stateDir: string) {
  const { dev, ino } = await io.stat(join(stateDir, ".lock-guard"));
  return {
    guard: { dev, ino },
    metadata: await io.readFile(join(stateDir, "lock"), "utf8"),
    active: await io.readFile(join(stateDir, "active.json")),
    completed: await io.readFile(join(stateDir, "completed.json")),
  };
}

function expectReleasedFailure(error: unknown, stateDir: string, cause: Error) {
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw error;
  expect.soft(error.message).toContain(stateDir);
  expect.soft(error.message).toContain(join(stateDir, "lock"));
  expect.soft(error.message).toMatch(/unlink|remov/iu);
  expect.soft(error.message).toContain("EACCES");
  expect.soft(error.message).toMatch(/guard.*released/iu);
  expect.soft(error.message).toMatch(/metadata.*(retain|remain|residu|remov.*fail)/iu);
  expect.soft(error.cause).toBe(cause);
}

async function recoverUnderGuard(
  stateDir: string,
  apply: () => Promise<unknown>,
  child: RegistryChild,
  before: OwnershipEvidence,
) {
  expect(await ownershipEvidence(stateDir)).toEqual(before);
  expect(await child.acquireGuard()).toMatchObject({ acquired: true, guard: before.guard });
  // A real registry still cannot enter while the independent operator holds exclusion.
  const busyRefusal = apply();
  await expect(busyRefusal).rejects.toThrow(`held by pid ${process.pid}`);
  await expect(busyRefusal).rejects.not.toThrow(/residu/iu);
  await child.releaseGuard();
  const selfRefusal: unknown = await apply().catch((error: unknown) => error);
  expect(selfRefusal).toBeInstanceOf(Error);
  if (!(selfRefusal instanceof Error)) throw new Error("live-self metadata admitted a writer");
  expect(selfRefusal.message).toContain(stateDir);
  expect(selfRefusal.message).toContain(String(process.pid));
  expect.soft(selfRefusal.message).toMatch(/suspect|possible/iu);
  expect.soft(selfRefusal.message).toMatch(/self|same.process|current.process|this.process/iu);
  expect.soft(selfRefusal.message).toMatch(/residu/iu);
  expect.soft(selfRefusal.message).toMatch(/operator|verif/iu);
  const foreignRefusal = await child.apply();
  expect(foreignRefusal.error).toContain(`held by pid ${process.pid}`);
  expect(foreignRefusal.error).not.toMatch(/residu/iu);
  expect(await ownershipEvidence(stateDir)).toEqual(before);

  expect(await child.acquireGuard()).toMatchObject({ acquired: true, guard: before.guard });
  await expect(child.recoverMetadata(`${before.metadata}\nchanged-owner`)).rejects.toThrow(
    /owner recheck/u,
  );
  expect(await io.readFile(join(stateDir, "lock"), "utf8")).toBe(before.metadata);
  expect(await child.recoverMetadata(before.metadata)).toMatchObject({ metadata: before.metadata });
  // Removal is not the end of exclusion: the operator still owns the permanent guard.
  await expect(apply()).rejects.toThrow("ownership publication contention");
  await child.releaseGuard();
  const { dev, ino } = await io.stat(join(stateDir, ".lock-guard"));
  expect({ dev, ino }).toEqual(before.guard);
  expect(await io.readFile(join(stateDir, "active.json"))).toEqual(before.active);
  expect(await io.readFile(join(stateDir, "completed.json"))).toEqual(before.completed);
}

describe("atomic index failure recovery", () => {
  test.each(["open", "writeFile", "sync", "close", "rename"] as const)(
    "%s failure rejects its caller, cleans temporary files and leaves the queue usable",
    async (phase) => {
      const h = await createHarness();
      try {
        await h.apply(ShudJobRegistry, h.config);
        const store = publishedStore(h.ctx);
        const first = entry(h.cwd);
        const second = entry(h.cwd, "c3d4");
        const failure = new Error(`injected ${phase} failure`);
        const opened: NodeIo.FileHandle[] = [];
        if (phase === "open") vi.mocked(io.open).mockRejectedValueOnce(failure);
        else if (phase === "rename") vi.mocked(io.rename).mockRejectedValueOnce(failure);
        else {
          vi.mocked(io.open).mockImplementationOnce(async (...args) => {
            const file = await realIo.open(...args);
            opened.push(file);
            vi.spyOn(file, phase).mockRejectedValueOnce(failure);
            return file;
          });
        }
        const failed = store.addActive(first);
        const following = store.addActive(second);
        await expect(failed).rejects.toThrow(failure.message);
        await following;
        expect(opened.every((file) => file.fd === -1)).toBe(true);
        expect(store.read()).toEqual({ active: [second], completed: [] });
        expect(await persisted(h.stateDir)).toEqual([second]);
        expect((await io.readdir(h.stateDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      } finally {
        await h.dispose();
      }
    },
  );

  test("a pre-existing temporary file is never overwritten or removed by a colliding write", async () => {
    const h = await createHarness();
    try {
      await h.apply(ShudJobRegistry, h.config);
      const store = publishedStore(h.ctx);
      const first = entry(h.cwd);
      await store.addActive(first);
      const original = await io.readFile(join(h.stateDir, "active.json"), "utf8");
      const collisionId = "00000000-0000-4000-8000-000000000000";
      const collision = join(h.stateDir, `active.json.${collisionId}.tmp`);
      const sentinel = "pre-existing temporary file belongs to another write\n";
      await io.writeFile(collision, sentinel);
      vi.mocked(randomUUID).mockReturnValueOnce(collisionId);

      await expect(store.addActive(entry(h.cwd, "c3d4"))).rejects.toMatchObject({
        code: "EEXIST",
      });
      expect(await io.readFile(collision, "utf8")).toBe(sentinel);
      expect(await io.readFile(join(h.stateDir, "active.json"), "utf8")).toBe(original);
      expect(store.read()).toEqual({ active: [first], completed: [] });

      const following = entry(h.cwd, "e5f6");
      await store.addActive(following);
      expect(await persisted(h.stateDir)).toEqual([first, following]);
      expect(store.read()).toEqual({ active: [first, following], completed: [] });
      expect(await io.readFile(collision, "utf8")).toBe(sentinel);
    } finally {
      await h.dispose();
    }
  });

  test("disk is flushed and closed before rename, and readers see only committed state", async () => {
    const h = await createHarness();
    const entered = barrier();
    const resume = barrier();
    try {
      await h.apply(ShudJobRegistry, h.config);
      const store = publishedStore(h.ctx);
      const first = entry(h.cwd);
      const events: string[] = [];
      vi.mocked(io.open).mockImplementationOnce(async (...args) => {
        const file = await realIo.open(...args);
        const sync = file.sync.bind(file);
        const close = file.close.bind(file);
        vi.spyOn(file, "sync").mockImplementation(async () => {
          await sync();
          events.push("flush");
        });
        vi.spyOn(file, "close").mockImplementation(async () => {
          await close();
          events.push("close");
        });
        return file;
      });
      vi.mocked(io.rename).mockImplementationOnce(async (source, target) => {
        entered.release();
        expect(events).toEqual(["flush", "close"]);
        expect(JSON.parse(await io.readFile(source, "utf8"))).toEqual([first]);
        expect(await persisted(h.stateDir)).toEqual([]);
        expect(store.read()).toEqual({ active: [], completed: [] });
        await resume.waiting;
        await realIo.rename(source, target);
      });
      const pending = store.addActive(first);
      await entered.waiting;
      resume.release();
      await pending;
      expect(await persisted(h.stateDir)).toEqual([first]);
      expect(store.lookup(first.run_id)).toEqual(first);
    } finally {
      resume.release();
      await h.dispose();
    }
  });

  test("failed active removal after completed persistence remains recoverable across restart", async () => {
    const h = await createHarness();
    try {
      const fiber = await h.apply(ShudJobRegistry, h.config);
      const store = publishedStore(h.ctx);
      const first = entry(h.cwd);
      await store.addActive(first);
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (target === join(h.stateDir, "active.json")) {
          expect(await persisted(h.stateDir, "completed.json")).toEqual([first]);
          throw new Error("interrupted before active replacement");
        }
        await realIo.rename(source, target);
      });
      await expect(store.completeActive(first.run_id)).rejects.toThrow("interrupted");
      expect(store.read()).toEqual({ active: [first], completed: [first] });
      expect(await persisted(h.stateDir)).toEqual([first]);
      expect(await persisted(h.stateDir, "completed.json")).toEqual([first]);
      await fiber.dispose();
      vi.mocked(io.rename).mockImplementation(realIo.rename);
      await h.apply(ShudJobRegistry, h.config);
      const reopened = publishedStore(h.ctx);
      expect(reopened.lookup(first.job_id)).toEqual(first);
      await reopened.completeActive(first.run_id);
      expect(reopened.read()).toEqual({ active: [], completed: [first] });
    } finally {
      await h.dispose();
    }
  });

  test("completed write failure never removes the active entry", async () => {
    const h = await createHarness();
    try {
      await h.apply(ShudJobRegistry, h.config);
      const store = publishedStore(h.ctx);
      const first = entry(h.cwd);
      await store.addActive(first);
      vi.mocked(io.rename).mockRejectedValueOnce(new Error("completed write failure"));
      await expect(store.completeActive(first.run_id)).rejects.toThrow("completed write failure");
      expect(store.read()).toEqual({ active: [first], completed: [] });
      expect(await persisted(h.stateDir)).toEqual([first]);
      expect(await persisted(h.stateDir, "completed.json")).toEqual([]);
      await store.completeActive(first.run_id);
      expect(store.read()).toEqual({ active: [], completed: [first] });
    } finally {
      await h.dispose();
    }
  });
});

describe("store-owned Cordis lifecycle", () => {
  test("unlink failure reports once through Cordis, caches close and permits only guarded recovery", async () => {
    const h = await createHarness();
    let child: RegistryChild | undefined;
    try {
      child = await createRegistryChild(h.config, true);
      const fiber = await h.apply(ShudJobRegistry, h.config);
      const store = publishedStore(h.ctx);
      const active = entry(h.cwd);
      const completed = entry(h.cwd, "c3d4");
      await store.addActive(completed);
      await store.completeActive(completed.run_id);
      await store.addActive(active);
      const before = await ownershipEvidence(h.stateDir);
      expect(await child.acquireGuard()).toMatchObject({ acquired: false, guard: before.guard });
      const failure = Object.assign(new Error("injected metadata permission failure"), {
        code: "EACCES",
      });
      vi.mocked(fs.unlinkSync).mockImplementation((path) => {
        if (path === join(h.stateDir, "lock")) throw failure;
        realFs.unlinkSync(path);
      });
      const closeStarted = barrier();
      const reported = barrier();
      const close = store.close.bind(store);
      let closing!: Promise<void>;
      let outcome!: Promise<unknown>;
      let closingError: unknown;
      const reports: unknown[] = [];
      vi.spyOn(store, "close").mockImplementation(() => {
        closing = close();
        // Observe the real Cordis-owned rejection immediately, without initiating close ourselves.
        outcome = closing.catch((reason: unknown) => {
          closingError = reason;
          if (reports.includes(reason)) reported.release();
          return reason;
        });
        closeStarted.release();
        return closing;
      });
      // Observe the public exporter on the live root. Nested causes are separate objects;
      // count only the actual close rejection, not every rendered error in its cause graph.
      h.ctx.logger.exporter({
        export(message) {
          if (message.type !== "error") return;
          const error: unknown = message.args[0];
          reports.push(error);
          if (closingError !== undefined && error === closingError) reported.release();
        },
      });
      await fiber.dispose();
      await closeStarted.waiting;
      const error = await outcome;
      // Await the reporting event itself; the integration test's timeout bounds this barrier.
      await reported.waiting;
      expectReleasedFailure(error, h.stateDir, failure);
      expect.soft(reports.filter((report) => report === error)).toHaveLength(1);
      expect(
        vi.mocked(fs.unlinkSync).mock.calls.filter(([path]) => path === join(h.stateDir, "lock")),
      ).toHaveLength(1);
      await expect(store.addActive(entry(h.cwd, "e5f6"))).rejects.toThrow("closed");
      vi.mocked(fs.unlinkSync).mockImplementation(realFs.unlinkSync);
      expect(store.close()).toBe(closing);
      await expect(store.close()).rejects.toBe(error);
      expect.soft(reports.filter((report) => report === error)).toHaveLength(1);
      expect(
        vi.mocked(fs.unlinkSync).mock.calls.filter(([path]) => path === join(h.stateDir, "lock")),
      ).toHaveLength(1);
      await recoverUnderGuard(h.stateDir, () => h.apply(ShudJobRegistry, h.config), child, before);
      await h.apply(ShudJobRegistry, h.config);
      expect(publishedStore(h.ctx).read()).toEqual({ active: [active], completed: [completed] });
      expect(await io.readFile(join(h.stateDir, "active.json"))).toEqual(before.active);
      expect(await io.readFile(join(h.stateDir, "completed.json"))).toEqual(before.completed);
      const { dev, ino } = await io.stat(join(h.stateDir, ".lock-guard"));
      expect({ dev, ino }).toEqual(before.guard);
    } finally {
      vi.mocked(fs.unlinkSync).mockImplementation(realFs.unlinkSync);
      await child?.stop();
      await h.dispose();
    }
  }, 15000);

  test("invalid index and unlink failure retain the initialization cause and separate data repair from lock recovery", async () => {
    const h = await createHarness();
    let child: RegistryChild | undefined;
    try {
      child = await createRegistryChild(h.config, true);
      const active = entry(h.cwd);
      const completed = entry(h.cwd, "c3d4");
      const invalid = '{"not":"an index array"}\n';
      const validActive = `${JSON.stringify([active])}\n`;
      const validCompleted = `${JSON.stringify([completed])}\n`;
      await io.writeFile(join(h.stateDir, "active.json"), invalid);
      await io.writeFile(join(h.stateDir, "completed.json"), validCompleted);
      // Establish the permanent inode before initialization so replacement is observable.
      realFs.closeSync(realFs.openSync(join(h.stateDir, ".lock-guard"), "a", 0o600));
      const { dev, ino } = await io.stat(join(h.stateDir, ".lock-guard"));
      const failure = Object.assign(new Error("injected initialization cleanup failure"), {
        code: "EACCES",
      });
      vi.mocked(fs.unlinkSync).mockImplementation((path) => {
        if (path === join(h.stateDir, "lock")) throw failure;
        realFs.unlinkSync(path);
      });
      const error: unknown = await h
        .apply(ShudJobRegistry, h.config)
        .catch((reason: unknown) => reason);
      expect.soft(error).toBeInstanceOf(AggregateError);
      if (error instanceof AggregateError) {
        expect(error.errors).toHaveLength(2);
        expect(error.cause).toBe(error.errors[0]);
        expect(error.cause).toBeInstanceOf(Error);
        if (!(error.cause instanceof Error)) throw new Error("missing initialization cause");
        expect(error.cause.message).toContain(join(h.stateDir, "active.json"));
        expect(error.cause.message).toMatch(/invalid index/iu);
        expect(error.cause.cause).toBeInstanceOf(Error);
        expect(error.message).toMatch(/initial|invalid index/iu);
        // Cordis renders the primary cause and aggregate message, not errors[1] separately.
        expect(error.message).toContain(join(h.stateDir, "active.json"));
        expect(error.message).toContain(join(h.stateDir, "lock"));
        expect(error.message).toContain("EACCES");
        expect(error.message).toMatch(/guard.*released/iu);
        expectReleasedFailure(error.errors[1], h.stateDir, failure);
      }
      expect(h.ctx.get("jobs")).toBeUndefined();
      expect(
        vi.mocked(fs.unlinkSync).mock.calls.filter(([path]) => path === join(h.stateDir, "lock")),
      ).toHaveLength(1);
      const before = await ownershipEvidence(h.stateDir);
      expect(before.guard).toEqual({ dev, ino });
      expect(before.active.toString()).toBe(invalid);
      expect(before.completed.toString()).toBe(validCompleted);
      vi.mocked(fs.unlinkSync).mockImplementation(realFs.unlinkSync);
      await recoverUnderGuard(h.stateDir, () => h.apply(ShudJobRegistry, h.config), child, before);
      // Lock recovery does not repair invalid data: an actual apply still rejects it unchanged.
      await expect(h.apply(ShudJobRegistry, h.config)).rejects.toThrow(/Invalid index/u);
      expect(await io.readFile(join(h.stateDir, "active.json"), "utf8")).toBe(invalid);
      expect(await io.readFile(join(h.stateDir, "completed.json"), "utf8")).toBe(validCompleted);
      // Explicit fixture restoration is a separate precondition, never operator lock recovery.
      await io.writeFile(join(h.stateDir, "active.json"), validActive);
      await h.apply(ShudJobRegistry, h.config);
      expect(publishedStore(h.ctx).read()).toEqual({ active: [active], completed: [completed] });
      expect(await io.readFile(join(h.stateDir, "active.json"), "utf8")).toBe(validActive);
      expect(await io.readFile(join(h.stateDir, "completed.json"), "utf8")).toBe(validCompleted);
      const recovered = await io.stat(join(h.stateDir, ".lock-guard"));
      expect({ dev: recovered.dev, ino: recovered.ino }).toEqual({ dev, ino });
    } finally {
      vi.mocked(fs.unlinkSync).mockImplementation(realFs.unlinkSync);
      await child?.stop();
      await h.dispose();
    }
  }, 15000);

  test.each(["plugin", "root"])(
    "%s disposal closes admission and retains ownership until an admitted write drains",
    async (scope) => {
      const h = await createHarness();
      const contender = await createHarness();
      const entered = barrier();
      const resume = barrier();
      const admissionClosed = barrier();
      try {
        const fiber = await h.apply(ShudJobRegistry, h.config);
        const store = publishedStore(h.ctx);
        const close = store.close.bind(store);
        vi.spyOn(store, "close").mockImplementation(() => {
          const closing = close();
          admissionClosed.release();
          return closing;
        });
        const first = entry(h.cwd);
        vi.mocked(io.rename).mockImplementationOnce(async (source, target) => {
          entered.release();
          await resume.waiting;
          await realIo.rename(source, target);
        });
        const pending = store.addActive(first);
        await entered.waiting;
        let disposed = false;
        const disposing = Promise.resolve(
          scope === "root" ? h.ctx.fiber.dispose() : fiber.dispose(),
        ).then(() => {
          disposed = true;
        });
        await admissionClosed.waiting;
        await expect(store.addActive(entry(h.cwd, "c3d4"))).rejects.toThrow("closed");
        await expect(store.removeActive(first.run_id)).rejects.toThrow("closed");
        await expect(store.completeActive(first.run_id)).rejects.toThrow("closed");
        expect(disposed).toBe(false);
        expect(await io.readdir(h.stateDir)).toContain("lock");
        await expect(contender.apply(ShudJobRegistry, h.config)).rejects.toThrow(h.stateDir);
        resume.release();
        await Promise.all([pending, disposing]);
        expect(await persisted(h.stateDir)).toEqual([first]);
        expect(await io.readdir(h.stateDir)).not.toContain("lock");
        await contender.apply(ShudJobRegistry, h.config);
        expect(publishedStore(contender.ctx).lookup(first.run_id)).toEqual(first);
      } finally {
        resume.release();
        await contender.dispose();
        await h.dispose();
      }
    },
  );

  test("parent non-shud teardown stays concurrent and overall disposal awaits its producer", async () => {
    const h = await createHarness();
    const cancelled = barrier();
    const unlocked = barrier();
    const task = producer();
    try {
      await h.apply(ShudJobRegistry, h.config);
      await h.attachController(false);
      vi.mocked(fs.unlinkSync).mockImplementation((path) => {
        realFs.unlinkSync(path);
        if (path === join(h.stateDir, "lock")) unlocked.release();
      });
      const original = task.spec.run.bind(task.spec);
      h.ctx.jobs.start({
        ...task.spec,
        run(handle) {
          const result = original(handle);
          return {
            ...result,
            cancel() {
              cancelled.release();
            },
          };
        },
      });
      let disposed = false;
      const disposing = Promise.resolve(h.ctx.fiber.dispose()).then(() => {
        disposed = true;
      });
      await Promise.all([cancelled.waiting, unlocked.waiting]);
      expect(await io.readdir(h.stateDir)).not.toContain("lock");
      expect(disposed).toBe(false);
      task.settle({ status: "killed" });
      await disposing;
      expect(disposed).toBe(true);
    } finally {
      task.settle({ status: "killed" });
      await h.dispose();
    }
  });

  test.each(["metadata publication", "index initialization", "parent construction"])(
    "%s failure releases only newly owned resources",
    async (phase) => {
      const h = await createHarness();
      const prior = JSON.stringify({
        pid: process.pid,
        pid_started_at: "Thu Jan  1 00:00:00 1970",
      });
      try {
        if (phase !== "parent construction") {
          if (phase === "metadata publication") await io.writeFile(join(h.stateDir, "lock"), prior);
          vi.mocked(fs.renameSync).mockImplementation((source, target) => {
            const filename = phase === "metadata publication" ? "lock" : "completed.json";
            if (target === join(h.stateDir, filename)) throw new Error("initial state failure");
            realFs.renameSync(source, target);
          });
        } else await h.apply(LocalJobRegistry, {});
        await expect(h.apply(ShudJobRegistry, h.config)).rejects.toThrow();
        if (phase === "metadata publication") {
          expect(await io.readFile(join(h.stateDir, "lock"), "utf8")).toBe(prior);
        } else expect(await io.readdir(h.stateDir)).not.toContain("lock");
        expect((await io.readdir(h.stateDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
        vi.mocked(fs.renameSync).mockImplementation(realFs.renameSync);
        if (phase === "parent construction") await h.ctx.fiber.dispose();
        const replacement = await createHarness();
        try {
          await replacement.apply(ShudJobRegistry, h.config);
        } finally {
          await replacement.dispose();
        }
      } finally {
        await h.dispose();
      }
    },
  );
});

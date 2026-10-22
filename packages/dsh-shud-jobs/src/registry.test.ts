import { accessSync, constants } from "node:fs";
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import type { Plugin } from "@deepseek-ai/cordis";
import type { JobId } from "@deepseek-ai/dsh-jobs";
import { ShudJobRegistry } from "./index.ts";
import { captureEvents, createHarness, normalizeTrace, producer } from "./test-harness.ts";

async function applyError(operation: () => Promise<unknown>): Promise<Error | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
}

function caughtError(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("expected the operation to reject");
}

async function operationTrace(registry: Plugin) {
  const h = await createHarness();
  try {
    const fiber = await h.apply(registry, { ...h.config, maxConcurrentJobsPerOwner: 2 });
    const scoped = await h.attachController(true);
    const global = await h.attachController(false);
    const jobs = h.ctx.jobs;
    const events = await captureEvents(h.ctx);
    const scopedEvents = await captureEvents(h.presetCtx, "scope");
    const unrelatedEvents = await captureEvents(h.otherCtx, "scope");
    const ids: JobId[] = [];
    const natural = producer(h.ownerId);
    const id = jobs.start(natural.spec);
    ids.push(id);
    natural.append("hello\n");
    const listed = jobs.list(h.ownerId);
    const foreignList = jobs.list(h.otherId);
    const foreignRead = caughtError(() => jobs.read(id, h.otherId));
    const observed = jobs.readAt(id, 0, h.ownerId);
    const consumed = jobs.read(id, h.ownerId);
    const consumedAgain = jobs.read(id, h.ownerId);
    const settled = jobs.wait(id, 1000, h.ownerId);
    natural.settle({ status: "completed", result: "complete", detail: "natural exit" });
    const terminal = await settled;
    const finalRead = jobs.read(id, h.ownerId);
    const finalReadAgain = jobs.read(id, h.ownerId);
    const killed = producer(h.ownerId);
    const killId = jobs.start(killed.spec);
    ids.push(killId);
    const killResult = jobs.kill(killId, h.ownerId, "user requested");
    const killedView = await jobs.wait(killId, 1000, h.ownerId);
    const repeatedKill = jobs.kill(killId, h.ownerId);
    const first = producer();
    const second = producer();
    ids.push(jobs.start(first.spec), jobs.start(second.spec));
    const limit = caughtError(() => jobs.start(producer().spec));
    const ownerLive = producer(h.ownerId);
    ids.push(jobs.start(ownerLive.spec));
    await h.releaseOwner();
    const afterOwnerRelease = jobs.list(h.ownerId);
    await scoped.dispose();
    await global.dispose();
    const noController = caughtError(() => jobs.start(producer().spec));
    await fiber.dispose();
    const afterTeardown = jobs.list();
    const stateFiles = await readdir(h.stateDir);
    const workspaceFiles = await readdir(h.cwd);
    await h.apply(registry, h.config);
    const forgotten = caughtError(() => h.ctx.jobs.get(id, h.ownerId));
    expect(foreignList).toEqual([]);
    expect(foreignRead).toContain("belongs to another session");
    expect(observed.chunks.map((chunk) => chunk.text).join("")).toBe("hello\n");
    expect(consumedAgain.chunks).toEqual([]);
    expect(terminal.status).toBe("completed");
    expect(finalRead.result).toBe("complete");
    expect(finalReadAgain.result).toBeUndefined();
    expect(killedView.status).toBe("killed");
    expect(limit).toContain("limit: 2");
    expect(noController).toContain("no job controller serves this agent");
    expect(forgotten).toContain("unknown job");
    expect(ownerLive.cancels).toEqual(["owner disposed"]);
    expect(first.cancels).toEqual(["jobs service disposed"]);
    expect(second.cancels).toEqual(["jobs service disposed"]);
    expect(afterOwnerRelease.map((job) => job.id)).toEqual(ids.slice(2, 4));
    expect(afterTeardown).toEqual([]);
    expect(stateFiles).toEqual([]);
    expect(workspaceFiles).toEqual([]);
    expect(h.sessionEvents.filter((event) => event.type === "job/settled")).toHaveLength(3);
    expect(scopedEvents.filter((event) => event.type === "settled")).toHaveLength(3);
    expect(unrelatedEvents).toEqual([]);
    expect(h.flushes).toEqual([]);
    expect(events.some((event) => event.type === "settled" && event.cause === "producer")).toBe(
      true,
    );
    return normalizeTrace(
      {
        listed,
        foreignList,
        foreignRead,
        observed,
        consumed,
        consumedAgain,
        terminal,
        finalRead,
        finalReadAgain,
        killResult,
        killedView,
        repeatedKill,
        limit,
        afterOwnerRelease,
        noController,
        afterTeardown,
        forgotten,
        stateFiles,
        workspaceFiles,
        events,
        scopedEvents,
        unrelatedEvents,
        sessionEvents: h.sessionEvents,
        flushes: h.flushes,
        cancels: [
          natural.cancels,
          killed.cancels,
          ownerLive.cancels,
          first.cancels,
          second.cancels,
        ],
      },
      ids,
    );
  } finally {
    await h.dispose();
  }
}

describe("registry parent behavior", () => {
  test("O5a: a preset controller cannot admit unowned work; an unscoped controller can", async () => {
    const h = await createHarness();
    try {
      await h.apply(LocalJobRegistry, {});
      await h.attachController(true);
      expect(() => h.ctx.jobs.start(producer().spec)).toThrow(
        "no job controller serves this agent",
      );
      expect(() => h.ctx.jobs.start(producer(h.otherId).spec)).toThrow(
        "no job controller serves this agent",
      );
      const owned = producer(h.ownerId);
      const ownedId = h.ctx.jobs.start(owned.spec);
      expect(h.ctx.jobs.get(ownedId, h.ownerId).status).toBe("running");
      const controller = await h.attachController(false);
      const unowned = producer();
      const id = h.ctx.jobs.start(unowned.spec);
      expect(h.ctx.jobs.get(id).status).toBe("running");
      await controller.dispose();
      expect(() => h.ctx.jobs.start(producer().spec)).toThrow(
        "no job controller serves this agent",
      );
    } finally {
      await h.dispose();
    }
  });

  test("non-shud operations, events and lifecycle match the real parent", async () => {
    const parent = await operationTrace(LocalJobRegistry);
    const subclass = await operationTrace(ShudJobRegistry);
    expect(subclass).toEqual(parent);
  });

  test("subclass installs no implicit global controller", async () => {
    const h = await createHarness();
    try {
      await h.apply(ShudJobRegistry, h.config);
      expect(() => h.ctx.jobs.start(producer().spec)).toThrow(
        "no job controller serves this agent",
      );
      await h.attachController(true);
      expect(() => h.ctx.jobs.start(producer().spec)).toThrow(
        "no job controller serves this agent",
      );
      expect(() => h.ctx.jobs.start(producer(h.otherId).spec)).toThrow(
        "no job controller serves this agent",
      );
    } finally {
      await h.dispose();
    }
  });
});

describe("registry apply configuration", () => {
  test.each([
    ["stateDir", undefined],
    ["shudBin", undefined],
    ["stateDir", ""],
    ["shudBin", ""],
    ["stateDir", "relative-state"],
    ["shudBin", "relative-shud"],
  ])("rejects invalid %s=%s before registering jobs", async (key, value) => {
    const h = await createHarness();
    try {
      const error = await applyError(() => h.apply(ShudJobRegistry, { ...h.config, [key]: value }));
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain(key);
      expect(h.ctx.get("jobs")).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  test("rejects unknown shudbin rather than silently passing it through", async () => {
    const h = await createHarness();
    try {
      const error = await applyError(() =>
        h.apply(ShudJobRegistry, { ...h.config, shudbin: h.shudBin }),
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain("shudbin");
      expect(h.ctx.get("jobs")).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  test.each(["maxConcurrentJobsPerOwner", "retainBytes", "settledRetainBytes", "pumpPollMs"])(
    "preserves parent rejection of invalid %s",
    async (key) => {
      const h = await createHarness();
      try {
        const error = await applyError(() => h.apply(ShudJobRegistry, { ...h.config, [key]: 0 }));
        expect(error).toBeInstanceOf(Error);
        expect(error?.message).toContain(key);
        expect(h.ctx.get("jobs")).toBeUndefined();
      } finally {
        await h.dispose();
      }
    },
  );

  test("preserves parent Config identity and resolved defaults", async () => {
    const original = LocalJobRegistry.Config;
    const parent = original["~standard"].validate({});
    const h = await createHarness();
    try {
      await h.apply(ShudJobRegistry, h.config);
      expect(LocalJobRegistry.Config).toBe(original);
      expect(LocalJobRegistry.Config["~standard"].validate({})).toEqual(parent);
      const extended = ShudJobRegistry.Config["~standard"].validate(h.config);
      if (!("value" in parent) || !("value" in extended))
        throw new Error("expected synchronous config values");
      for (const key of Object.keys(original.dict ?? {})) {
        expect(Reflect.get(extended.value, key)).toEqual(Reflect.get(parent.value, key));
      }
      expect(h.ctx.jobs).toBeInstanceOf(LocalJobRegistry);
    } finally {
      await h.dispose();
    }
  });

  test("creates a missing stateDir without index or run files", async () => {
    const h = await createHarness();
    const stateDir = join(h.root, "new", "state");
    try {
      await h.apply(ShudJobRegistry, { ...h.config, stateDir });
      expect(await readdir(h.root)).toContain("new");
      expect((await stat(stateDir)).isDirectory()).toBe(true);
      expect(await readdir(stateDir)).toEqual([]);
      expect(await readdir(h.cwd)).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  test.each(["state-file", "binary-missing", "binary-directory", "binary-not-executable"])(
    "rejects filesystem config %s before registering jobs",
    async (kind) => {
      const h = await createHarness();
      try {
        const target = join(h.root, "invalid");
        const key = kind === "state-file" ? "stateDir" : "shudBin";
        if (kind === "binary-directory") await mkdir(target);
        else if (kind !== "binary-missing") {
          await writeFile(target, "not executable\n");
          await chmod(target, 0o600);
        }
        const error = await applyError(() =>
          h.apply(ShudJobRegistry, { ...h.config, [key]: target }),
        );
        expect(error).toBeInstanceOf(Error);
        expect(error?.message).toContain(key);
        expect(h.ctx.get("jobs")).toBeUndefined();
      } finally {
        await h.dispose();
      }
    },
  );

  test("rejects a stateDir on an unwritable system volume under actual privileges", async () => {
    const h = await createHarness();
    const stateDir = process.platform === "darwin" ? "/System" : "/sys";
    try {
      expect(() => accessSync(stateDir, constants.W_OK)).toThrow();
      const error = await applyError(() => h.apply(ShudJobRegistry, { ...h.config, stateDir }));
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain("stateDir");
      expect(h.ctx.get("jobs")).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });
});

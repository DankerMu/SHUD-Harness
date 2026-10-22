import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ShudJobRegistry } from "./registry.ts";
import { createHarness } from "./test-harness.ts";
import { createRegistryChild, type RegistryChild } from "./state-lock/test-harness.ts";

async function stateBytes(stateDir: string) {
  const names = await readdir(stateDir);
  return Promise.all(
    ["lock", "active.json", "completed.json"].map(async (name) => [
      name,
      names.includes(name) ? await readFile(join(stateDir, name), "utf8") : null,
    ]),
  );
}

async function rejection(operation: () => Promise<unknown>) {
  try {
    await operation();
    return null;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
}

async function expectOwner(stateDir: string, pid: number) {
  expect(await readdir(stateDir), "an applied registry must publish owner metadata").toContain(
    "lock",
  );
  const metadata: unknown = JSON.parse(await readFile(join(stateDir, "lock"), "utf8"));
  const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
  }).trim();
  expect(metadata).toEqual({ pid, pid_started_at: started });
}

describe("registry state directory ownership", () => {
  test("activation publishes the current process identity", async () => {
    const h = await createHarness();
    try {
      await h.apply(ShudJobRegistry, h.config);
      await expectOwner(h.stateDir, process.pid);
      expect(h.ctx.jobs.list()).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  test("activation creates valid empty active and completed indexes", async () => {
    const h = await createHarness();
    try {
      await h.apply(ShudJobRegistry, h.config);
      const names = await readdir(h.stateDir);
      expect(names, "both persistent indexes must exist after activation").toEqual(
        expect.arrayContaining(["active.json", "completed.json"]),
      );
      for (const name of ["active.json", "completed.json"]) {
        const index: unknown = JSON.parse(await readFile(join(h.stateDir, name), "utf8"));
        expect(index).not.toBeNull();
        expect(typeof index).toBe("object");
        if (typeof index !== "object" || index === null) {
          throw new Error(`${name} must contain an index collection`);
        }
        // Assert zero entries without choosing the future store API's collection shape.
        expect(Object.values(index)).toEqual([]);
      }
      expect(await readdir(h.cwd)).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  test("a second Cordis root in the same process rejects without disturbing its holder", async () => {
    const holder = await createHarness();
    const contender = await createHarness();
    try {
      await holder.apply(ShudJobRegistry, holder.config);
      const before = await stateBytes(holder.stateDir);
      const error = await rejection(() => contender.apply(ShudJobRegistry, holder.config));
      expect(
        error,
        "state ownership must exclude even another root in this process",
      ).toBeInstanceOf(Error);
      expect(error?.message).toContain(holder.stateDir);
      expect(error?.message).toContain(String(process.pid));
      expect(contender.ctx.get("jobs")).toBeUndefined();
      await contender.dispose();
      expect(await stateBytes(holder.stateDir)).toEqual(before);
      expect(holder.ctx.jobs.list()).toEqual([]);
      await expectOwner(holder.stateDir, process.pid);
    } finally {
      await contender.dispose();
      await holder.dispose();
    }
  });

  test("another process cannot acquire an applied holder's state directory", async () => {
    const h = await createHarness();
    let holder: RegistryChild | undefined;
    try {
      holder = await createRegistryChild(h.config);
      expect(holder.pid).not.toBe(process.pid);
      const before = await stateBytes(h.stateDir);
      const error = await rejection(() => h.apply(ShudJobRegistry, h.config));
      expect(
        error,
        "the child acknowledged actual registry activation before contention",
      ).toBeInstanceOf(Error);
      expect(error?.message).toContain(h.stateDir);
      expect(error?.message).toContain(String(holder.pid));
      expect(h.ctx.get("jobs")).toBeUndefined();
      expect(await stateBytes(h.stateDir)).toEqual(before);
      expect(await holder.inspect()).toEqual({ event: "inspected", pid: holder.pid, jobs: [] });
      await expectOwner(h.stateDir, holder.pid);
      await holder.release();
      expect(await readdir(h.stateDir)).not.toContain("lock");
      await h.apply(ShudJobRegistry, h.config);
      await expectOwner(h.stateDir, process.pid);
    } finally {
      try {
        await holder?.stop();
      } finally {
        await h.dispose();
      }
    }
  }, 15000);

  test("disposal removes owner metadata and permits reacquisition without replacing the guard", async () => {
    const h = await createHarness();
    try {
      const fiber = await h.apply(ShudJobRegistry, h.config);
      await expectOwner(h.stateDir, process.pid);
      expect(await readdir(h.stateDir)).toContain(".lock-guard");
      const guard = await stat(join(h.stateDir, ".lock-guard"));
      const active = await readFile(join(h.stateDir, "active.json"), "utf8");
      const completed = await readFile(join(h.stateDir, "completed.json"), "utf8");
      await fiber.dispose();
      expect(await readdir(h.stateDir)).not.toContain("lock");
      const releasedGuard = await stat(join(h.stateDir, ".lock-guard"));
      expect([releasedGuard.dev, releasedGuard.ino]).toEqual([guard.dev, guard.ino]);
      expect(await readFile(join(h.stateDir, "active.json"), "utf8")).toBe(active);
      expect(await readFile(join(h.stateDir, "completed.json"), "utf8")).toBe(completed);
      await h.apply(ShudJobRegistry, h.config);
      await expectOwner(h.stateDir, process.pid);
      const reacquiredGuard = await stat(join(h.stateDir, ".lock-guard"));
      expect([reacquiredGuard.dev, reacquiredGuard.ino]).toEqual([guard.dev, guard.ino]);
    } finally {
      await h.dispose();
    }
  });
});

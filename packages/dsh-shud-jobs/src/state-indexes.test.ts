import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { RunId } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry, type IndexEntry } from "./index.ts";
import { createHarness } from "./test-harness.ts";
import { entry, persisted, publishedStore } from "./state-indexes/test-harness.ts";

describe("registry durable index API", () => {
  test("concurrent adds retain both entries and lookup accepts either branded identifier", async () => {
    const h = await createHarness();
    try {
      const fiber = await h.apply(ShudJobRegistry, h.config);
      const store = publishedStore(h.ctx);
      const first = entry(join(h.cwd, "first"));
      const second = entry(join(h.cwd, "second"), "c3d4");
      await Promise.all([store.addActive(first), store.addActive(second)]);
      expect(await persisted(h.stateDir)).toEqual([first, second]);
      expect(store.read()).toEqual({ active: [first, second], completed: [] });
      expect(store.lookup(first.run_id)).toEqual(first);
      expect(store.lookup(second.job_id)).toEqual(second);
      expect(store.lookup(entry(h.cwd, "eeee").run_id)).toBeUndefined();
      const snapshot = store.read();
      expect(() => Object.assign(snapshot.active[0], { run_dir: "/mutated" })).toThrow();
      expect(store.lookup(first.run_id)).toEqual(first);
      await fiber.dispose();
      await h.apply(ShudJobRegistry, h.config);
      expect(publishedStore(h.ctx).read()).toEqual({ active: [first, second], completed: [] });
    } finally {
      await h.dispose();
    }
  });

  test("rollback removes only its active entry and completion persists across replacement", async () => {
    const h = await createHarness();
    try {
      const fiber = await h.apply(ShudJobRegistry, h.config);
      const store = publishedStore(h.ctx);
      const first = entry(join(h.cwd, "first"));
      const second = entry(join(h.cwd, "second"), "c3d4");
      await store.addActive(first);
      await store.addActive(second);
      await store.removeActive(first.run_id);
      await store.removeActive(first.run_id);
      expect(store.lookup(first.job_id)).toBeUndefined();
      await store.completeActive(second.run_id);
      await store.completeActive(second.run_id);
      expect(await persisted(h.stateDir)).toEqual([]);
      expect(await persisted(h.stateDir, "completed.json")).toEqual([second]);
      expect(store.read()).toEqual({ active: [], completed: [second] });
      await expect(store.completeActive(first.run_id)).rejects.toThrow("Unknown active run");
      await fiber.dispose();
      await h.apply(ShudJobRegistry, h.config);
      expect(publishedStore(h.ctx).lookup(second.job_id)).toEqual(second);
    } finally {
      await h.dispose();
    }
  });

  test("duplicate, conflicting and invalid additions reject without poisoning later transactions", async () => {
    const h = await createHarness();
    try {
      await h.apply(ShudJobRegistry, h.config);
      const store = publishedStore(h.ctx);
      const first = entry(h.cwd);
      await store.addActive(first);
      await expect(store.addActive(first)).rejects.toThrow("already exists");
      await expect(
        store.addActive({ ...entry(h.cwd, "c3d4"), job_id: first.job_id }),
      ).rejects.toThrow("already exists");
      await expect(
        store.addActive({ ...entry(h.cwd, "c3d4"), run_dir: "relative" }),
      ).rejects.toThrow("absolute");
      // Deliberately cross the runtime boundary as an untyped JavaScript consumer.
      for (const invalid of [
        { ...first, run_id: "not-a-run" },
        { ...first, job_id: "not-a-job" },
        { ...first, extra: true },
        null,
      ]) {
        await expect(store.addActive(invalid as unknown as IndexEntry)).rejects.toThrow();
      }
      await expect(store.removeActive("not-a-run" as RunId)).rejects.toThrow();
      await expect(store.completeActive("not-a-run" as RunId)).rejects.toThrow();
      expect(() => store.lookup("not-a-run" as RunId)).toThrow();
      await store.completeActive(first.run_id);
      await expect(store.addActive(first)).rejects.toThrow("already exists");
      const next = entry(h.cwd, "c3d4");
      await store.addActive(next);
      expect(store.read()).toEqual({ active: [next], completed: [first] });
    } finally {
      await h.dispose();
    }
  });

  test("every mutation rejects after close, including otherwise idempotent mutations", async () => {
    const h = await createHarness();
    try {
      await h.apply(ShudJobRegistry, h.config);
      const store = publishedStore(h.ctx);
      const first = entry(h.cwd);
      await store.addActive(first);
      await store.completeActive(first.run_id);
      await Promise.all([store.close(), store.close()]);
      await expect(store.addActive(entry(h.cwd, "c3d4"))).rejects.toThrow("closed");
      await expect(store.removeActive(first.run_id)).rejects.toThrow("closed");
      await expect(store.completeActive(first.run_id)).rejects.toThrow("closed");
      expect(await persisted(h.stateDir)).toEqual([]);
      expect(await persisted(h.stateDir, "completed.json")).toEqual([first]);
      expect(await readdir(h.stateDir)).not.toContain("lock");
    } finally {
      await h.dispose();
    }
  });
});

describe("persisted index validation and initialization cleanup", () => {
  test.each([
    "json",
    "shape",
    "run-id",
    "job-id",
    "relative",
    "extra",
    "duplicate",
    "conflict",
    "directory",
  ])("rejects %s evidence without rewriting it and releases acquired ownership", async (kind) => {
    const h = await createHarness();
    const first = entry(h.cwd);
    const activePath = join(h.stateDir, "active.json");
    const completedPath = join(h.stateDir, "completed.json");
    const active =
      kind === "json"
        ? "{broken"
        : JSON.stringify(
            kind === "shape"
              ? {}
              : kind === "duplicate"
                ? [first, first]
                : [
                    {
                      ...first,
                      ...(kind === "run-id" ? { run_id: "bad" } : {}),
                      ...(kind === "job-id" ? { job_id: "bad" } : {}),
                      ...(kind === "relative" ? { run_dir: "relative" } : {}),
                      ...(kind === "extra" ? { unexpected: true } : {}),
                    },
                  ],
          );
    const completed = JSON.stringify(
      kind === "conflict" ? [{ ...first, run_dir: "/conflicting" }] : [],
    );
    try {
      if (kind === "directory") await mkdir(activePath);
      else await writeFile(activePath, active);
      await writeFile(completedPath, completed);
      await expect(h.apply(ShudJobRegistry, h.config)).rejects.toThrow(/index|state file/u);
      expect(h.ctx.get("jobs")).toBeUndefined();
      if (kind !== "directory") expect(await readFile(activePath, "utf8")).toBe(active);
      expect(await readFile(completedPath, "utf8")).toBe(completed);
      expect(await readdir(h.stateDir)).not.toContain("lock");
      if (kind === "directory") await rm(activePath, { recursive: true });
      await writeFile(activePath, "[]");
      await writeFile(completedPath, "[]");
      await h.apply(ShudJobRegistry, h.config);
      expect(publishedStore(h.ctx).read()).toEqual({ active: [], completed: [] });
    } finally {
      await h.dispose();
    }
  });

  test("a missing active index is not created before corrupt completed evidence is validated", async () => {
    const h = await createHarness();
    try {
      await writeFile(join(h.stateDir, "completed.json"), "not-json");
      await expect(h.apply(ShudJobRegistry, h.config)).rejects.toThrow("completed.json");
      expect(await readdir(h.stateDir)).not.toContain("active.json");
      expect(await readFile(join(h.stateDir, "completed.json"), "utf8")).toBe("not-json");
    } finally {
      await h.dispose();
    }
  });

  test("identical entries in both indexes survive interrupted completion and can finish", async () => {
    const h = await createHarness();
    const first = entry(h.cwd);
    try {
      await writeFile(join(h.stateDir, "active.json"), JSON.stringify([first]));
      await writeFile(join(h.stateDir, "completed.json"), JSON.stringify([first]));
      await h.apply(ShudJobRegistry, h.config);
      const store = publishedStore(h.ctx);
      expect(store.lookup(first.run_id)).toEqual(first);
      await store.completeActive(first.run_id);
      expect(store.read()).toEqual({ active: [], completed: [first] });
      expect(await persisted(h.stateDir)).toEqual([]);
      expect(await persisted(h.stateDir, "completed.json")).toEqual([first]);
    } finally {
      await h.dispose();
    }
  });
});

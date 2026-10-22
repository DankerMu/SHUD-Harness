import { execFileSync } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ShudJobRegistry } from "./index.ts";
import { createHarness } from "./test-harness.ts";
import { entry, persisted, publishedStore } from "./state-indexes/test-harness.ts";
import { createRegistryChild, type RegistryChild } from "./state-lock/test-harness.ts";

function actualStart(pid: number) {
  return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
  }).trim();
}

describe("state lock process identity and kernel exclusion", () => {
  test.each(["initial", "stale"])(
    "simultaneous %s acquisition admits exactly one process",
    async (kind) => {
      const h = await createHarness();
      const children: RegistryChild[] = [];
      try {
        if (kind === "stale") {
          const previous = await createRegistryChild(h.config);
          children.push(previous);
          await previous.kill();
          expect(await readdir(h.stateDir)).toContain("lock");
        }
        const first = await createRegistryChild(h.config, true);
        children.push(first);
        const second = await createRegistryChild(h.config, true);
        children.push(second);
        // Both children acknowledged their pre-apply barrier; neither is released until both report.
        const results = await Promise.all([first.apply(), second.apply()]);
        const accepted = results.filter((result) => result.error === undefined);
        const refused = results.filter((result) => result.error !== undefined);
        expect(accepted).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(refused[0].error).toContain(h.stateDir);
        const owner: unknown = JSON.parse(await readFile(join(h.stateDir, "lock"), "utf8"));
        expect(owner).toEqual({
          pid: accepted[0].pid,
          pid_started_at: actualStart(accepted[0].pid),
        });
        const winner = first.pid === accepted[0].pid ? first : second;
        const loser = first.pid === accepted[0].pid ? second : first;
        await loser.stop();
        expect(JSON.parse(await readFile(join(h.stateDir, "lock"), "utf8"))).toEqual(owner);
        expect(await winner.inspect()).toEqual({ event: "inspected", pid: winner.pid, jobs: [] });
        expect(await persisted(h.stateDir)).toEqual([]);
        expect(await persisted(h.stateDir, "completed.json")).toEqual([]);
      } finally {
        await Promise.all(children.map((child) => child.stop()));
        await h.dispose();
      }
    },
    15000,
  );

  test("SIGKILL leaves reclaimable metadata and preserves existing index entries", async () => {
    const h = await createHarness();
    let holder: RegistryChild | undefined;
    const first = entry(h.cwd);
    try {
      await writeFile(join(h.stateDir, "active.json"), JSON.stringify([first]));
      holder = await createRegistryChild(h.config);
      await holder.kill();
      expect(JSON.parse(await readFile(join(h.stateDir, "lock"), "utf8"))).toMatchObject({
        pid: holder.pid,
      });
      await h.apply(ShudJobRegistry, h.config);
      expect(JSON.parse(await readFile(join(h.stateDir, "lock"), "utf8"))).toEqual({
        pid: process.pid,
        pid_started_at: actualStart(process.pid),
      });
      expect(publishedStore(h.ctx).lookup(first.job_id)).toEqual(first);
    } finally {
      await holder?.stop();
      await h.dispose();
    }
  }, 15000);

  test("unrelated children do not inherit registry ownership after the holder dies", async () => {
    const h = await createHarness();
    let holder: RegistryChild | undefined;
    let unrelatedPid: number | undefined;
    const failures: unknown[] = [];
    try {
      holder = await createRegistryChild(h.config);
      const spawned = await holder.spawnUnrelated();
      unrelatedPid = spawned.childPid;
      expect(unrelatedPid).toBeTypeOf("number");
      if (unrelatedPid === undefined) throw new Error("unrelated child did not report a pid");
      const pid = unrelatedPid;
      await holder.kill();
      expect(() => process.kill(pid, 0)).not.toThrow();
      await h.apply(ShudJobRegistry, h.config);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(publishedStore(h.ctx).read()).toEqual({ active: [], completed: [] });
    } catch (error) {
      failures.push(error);
    } finally {
      if (unrelatedPid !== undefined) {
        try {
          process.kill(unrelatedPid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            failures.push(error);
          }
        }
      }
      try {
        await holder?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        await h.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Registry inheritance test and cleanup failed", {
        cause: failures[0],
      });
    }
  }, 15000);

  test("a different recorded start stamp permits takeover even when the pid is still alive", async () => {
    const h = await createHarness();
    const first = entry(h.cwd);
    try {
      await writeFile(
        join(h.stateDir, "lock"),
        JSON.stringify({ pid: process.pid, pid_started_at: "Thu Jan  1 00:00:00 1970" }),
      );
      await writeFile(join(h.stateDir, "active.json"), JSON.stringify([first]));
      await h.apply(ShudJobRegistry, h.config);
      expect(JSON.parse(await readFile(join(h.stateDir, "lock"), "utf8"))).toEqual({
        pid: process.pid,
        pid_started_at: actualStart(process.pid),
      });
      expect(publishedStore(h.ctx).lookup(first.run_id)).toEqual(first);
    } finally {
      await h.dispose();
    }
  });

  test("matching live metadata without a held kernel lock still rejects and preserves bytes", async () => {
    const h = await createHarness();
    const metadata = JSON.stringify({ pid: process.pid, pid_started_at: actualStart(process.pid) });
    try {
      await writeFile(join(h.stateDir, "lock"), metadata);
      await writeFile(join(h.stateDir, "active.json"), "[]\n");
      await expect(h.apply(ShudJobRegistry, h.config)).rejects.toThrow(String(process.pid));
      expect(h.ctx.get("jobs")).toBeUndefined();
      expect(await readFile(join(h.stateDir, "lock"), "utf8")).toBe(metadata);
      expect(await readFile(join(h.stateDir, "active.json"), "utf8")).toBe("[]\n");
      expect(await readdir(h.stateDir)).not.toContain("completed.json");
      await rm(join(h.stateDir, "lock"));
      await h.apply(ShudJobRegistry, h.config);
    } finally {
      await h.dispose();
    }
  });

  test.each([
    "{broken",
    "null",
    '{"pid":-1,"pid_started_at":"stamp"}',
    '{"pid":1}',
    '{"pid":1,"pid_started_at":""}',
    '{"pid":1,"pid_started_at":"not-a-start-stamp"}',
  ])("malformed owner metadata fails closed: %s", async (metadata) => {
    const h = await createHarness();
    try {
      await writeFile(join(h.stateDir, "lock"), metadata);
      await expect(h.apply(ShudJobRegistry, h.config)).rejects.toThrow(/metadata|JSON/u);
      expect(h.ctx.get("jobs")).toBeUndefined();
      expect(await readFile(join(h.stateDir, "lock"), "utf8")).toBe(metadata);
      expect(await readdir(h.stateDir)).not.toContain("active.json");
      await rm(join(h.stateDir, "lock"));
      await h.apply(ShudJobRegistry, h.config);
    } finally {
      await h.dispose();
    }
  });
});

test("SIGKILL between completed persistence and active removal never loses the run", async () => {
  const h = await createHarness();
  let holder: RegistryChild | undefined;
  const first = entry(h.cwd);
  try {
    await writeFile(join(h.stateDir, "active.json"), JSON.stringify([first]));
    holder = await createRegistryChild(h.config);
    await holder.interruptCompletion();
    expect(await persisted(h.stateDir, "completed.json")).toEqual([first]);
    expect(await persisted(h.stateDir)).toEqual([first]);
    await holder.kill();
    await h.apply(ShudJobRegistry, h.config);
    const store = publishedStore(h.ctx);
    expect(store.lookup(first.run_id)).toEqual(first);
    expect(store.lookup(first.job_id)).toEqual(first);
    await store.completeActive(first.run_id);
    expect(store.read()).toEqual({ active: [], completed: [first] });
  } finally {
    await holder?.stop();
    await h.dispose();
  }
}, 15000);

test("a busy guard with unpublished metadata rejects without inventing an owner pid", async () => {
  const holder = await createHarness();
  const contender = await createHarness();
  let metadata: string | undefined;
  try {
    await holder.apply(ShudJobRegistry, holder.config);
    metadata = await readFile(join(holder.stateDir, "lock"), "utf8");
    await rm(join(holder.stateDir, "lock"));
    await expect(contender.apply(ShudJobRegistry, holder.config)).rejects.toThrow(
      "ownership publication contention",
    );
    expect(contender.ctx.get("jobs")).toBeUndefined();
    expect(await readdir(holder.stateDir)).not.toContain("lock");
    expect(await persisted(holder.stateDir)).toEqual([]);
    expect(await persisted(holder.stateDir, "completed.json")).toEqual([]);
  } finally {
    await contender.dispose();
    if (metadata !== undefined) await writeFile(join(holder.stateDir, "lock"), metadata);
    await holder.dispose();
  }
});

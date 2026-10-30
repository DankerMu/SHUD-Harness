import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { ShudJobRegistry } from "./index.ts";
import { StateIndexStore } from "./state-indexes.ts";
import { createHarness } from "./test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";
import { barrier, entry, persisted } from "./state-indexes/test-harness.ts";
import { waitForOwnershipRelease } from "./poll-shud/test-harness.ts";
import { waitForRecovery } from "./reconcile-shud/test-harness.ts";
import { outputRoot, publishExit } from "./collect-shud/test-harness.ts";
import {
  PRIVATE_PAYLOAD,
  QUERY_POLL_MS,
  TARGET_TASK,
  enteredBeforeCompletion,
  expectQueryFailure,
  indexed,
  observe,
  queryFixture,
  queryRecord,
  seedQueryRun,
  settlesWhileHeld,
  snapshotQueryTree,
  writeQueryRecord,
} from "./list-run-jobs/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    rename: vi.fn(actual.rename),
  };
});
const nativeIo = await vi.importActual<typeof io>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.readFile).mockReset().mockImplementation(nativeIo.readFile);
  vi.mocked(io.readdir).mockReset().mockImplementation(nativeIo.readdir);
  vi.mocked(io.rename).mockReset().mockImplementation(nativeIo.rename);
});

test("the root registry rejects task queries while real startup reconciliation is held", async () => {
  const h = await createHarness(undefined, "absent", false);
  const entered = barrier();
  const release = barrier();
  let applying: Promise<unknown> | undefined;
  try {
    const record = queryRecord(h, "a001");
    await writeQueryRecord(record);
    await io.writeFile(join(h.stateDir, "active.json"), JSON.stringify([indexed(record)]));
    await io.writeFile(join(h.stateDir, "completed.json"), "[]");
    vi.mocked(io.readFile).mockImplementation(async (...args) => {
      if (args[0] === join(record.run_dir, "run-job.json")) {
        entered.release();
        await release.waiting;
      }
      return nativeIo.readFile(...args);
    });
    applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: QUERY_POLL_MS });
    void applying.catch(() => undefined);
    await enteredBeforeCompletion(entered.waiting, applying);
    const registry = actualRegistry(h.ctx);
    const before = await snapshotQueryTree(h.root);
    const reads = vi.mocked(io.readFile).mock.calls.length;
    const outcome = await settlesWhileHeld(observe(registry.listRunJobsByTask(TARGET_TASK)));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("Startup query bypassed readiness");
    expect(String(outcome.error)).toMatch(/not ready/iu);
    expect(io.readFile).toHaveBeenCalledTimes(reads);
    expect(await snapshotQueryTree(h.root)).toEqual(before);
    release.release();
    await applying;
    expect(await registry.listRunJobsByTask(TARGET_TASK)).toHaveLength(1);
  } finally {
    release.release();
    await applying?.catch(() => undefined);
    vi.mocked(io.readFile).mockImplementation(nativeIo.readFile);
    await h.ctx.fiber.dispose();
    await waitForOwnershipRelease(h.stateDir);
    await h.dispose();
  }
}, 15000);

test.each([false, true])(
  "accepted query read drains before ownership release even when it fails=%s; closing rejects new reads",
  async (failRead) => {
    const h = await queryFixture();
    const entered = barrier();
    const release = barrier();
    let pending: Promise<unknown> | undefined;
    let disposing: Promise<void> | undefined;
    let contender: StateIndexStore | undefined;
    let disposed = false;
    try {
      const record = await seedQueryRun(h, "a001");
      const path = join(record.run_dir, "run-job.json");
      let held = false;
      vi.mocked(io.readFile).mockImplementation(async (...args) => {
        if (args[0] === path && !held) {
          held = true;
          entered.release();
          await release.waiting;
          if (failRead) throw Object.assign(new Error(PRIVATE_PAYLOAD), { code: "EIO" });
        }
        return nativeIo.readFile(...args);
      });
      const query = h.registry.listRunJobsByTask(TARGET_TASK);
      pending = observe(query);
      await enteredBeforeCompletion(entered.waiting, pending);
      disposing = Promise.resolve(h.fiber.dispose()).then(() => {
        disposed = true;
      });
      void disposing.catch(() => undefined);
      // Observe an existing admission gate: Cordis may schedule its effects after dispose() returns.
      const unknown = entry(h.cwd, "eeee").run_id;
      await waitForRecovery(async () => {
        const result = await observe(h.registry.collectShud(unknown));
        if (result.ok) throw new Error("Unknown run unexpectedly collected");
        return /CLOSED/u.test(String(result.error));
      }, "registry closing admission");
      const before = await snapshotQueryTree(h.root);
      const reads = vi.mocked(io.readFile).mock.calls.length;
      const rejected = await settlesWhileHeld(observe(h.registry.listRunJobsByTask(TARGET_TASK)));
      expect(rejected.ok).toBe(false);
      if (rejected.ok) throw new Error("Closing registry admitted another query");
      expect(String(rejected.error)).toMatch(/closed/iu);
      expect(io.readFile).toHaveBeenCalledTimes(reads);
      expect(disposed).toBe(false);
      expect(() => {
        contender = new StateIndexStore(h.stateDir);
      }).toThrow(h.stateDir);
      expect(await snapshotQueryTree(h.root)).toEqual(before);
      release.release();
      if (failRead) await expectQueryFailure(query, record.run_id);
      else expect(await query).toEqual([record]);
      await disposing;
      await waitForOwnershipRelease(h.stateDir);
      expect(disposed).toBe(true);
      expect(h.logs.join("\n")).not.toContain(PRIVATE_PAYLOAD);
      const afterClose = await snapshotQueryTree(h.root);
      await expect(h.registry.listRunJobsByTask(TARGET_TASK)).rejects.toThrow(/closed/iu);
      expect(await snapshotQueryTree(h.root)).toEqual(afterClose);
      // The same permanent guard can now be acquired; failed reads must not poison disposal.
      contender = new StateIndexStore(h.stateDir);
      expect(contender.read()).toEqual({ active: [indexed(record)], completed: [] });
    } finally {
      release.release();
      await pending;
      await disposing;
      await contender?.close();
      vi.mocked(io.readFile).mockImplementation(nativeIo.readFile);
      await h.close();
    }
  },
  15000,
);

test("complete-first migration exposes the same identity in both indexes but query returns it once without awaiting the writer", async () => {
  const h = await queryFixture();
  const entered = barrier();
  const release = barrier();
  let migrating: Promise<void> | undefined;
  let querying: Promise<unknown> | undefined;
  try {
    const duplicate = await seedQueryRun(h, "f002", { status: "collected" });
    const distinct = await seedQueryRun(h, "a001", { status: "collected" }, "completed");
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (target === join(h.stateDir, "active.json")) {
        entered.release();
        await release.waiting;
      }
      await nativeIo.rename(source, target);
    });
    migrating = h.registry.indexes.completeActive(duplicate.run_id);
    void migrating.catch(() => undefined);
    await enteredBeforeCompletion(entered.waiting, migrating);
    const indexes = {
      active: [indexed(duplicate)],
      completed: [indexed(distinct), indexed(duplicate)],
    };
    expect(h.registry.indexes.read()).toEqual(indexes);
    expect(await persisted(h.stateDir)).toEqual(indexes.active);
    expect(await persisted(h.stateDir, "completed.json")).toEqual(indexes.completed);
    const before = await snapshotQueryTree(h.root);
    vi.mocked(io.readFile).mockClear();
    const query = h.registry.listRunJobsByTask(TARGET_TASK);
    querying = observe(query);
    expect(await settlesWhileHeld(query)).toEqual([distinct, duplicate]);
    expect(
      vi
        .mocked(io.readFile)
        .mock.calls.filter(([path]) => path === join(duplicate.run_dir, "run-job.json")),
    ).toHaveLength(1);
    expect(h.registry.indexes.read()).toEqual(indexes);
    expect(await snapshotQueryTree(h.root)).toEqual(before);
    release.release();
    await migrating;
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: indexes.completed });
    expect(await h.registry.listRunJobsByTask(TARGET_TASK)).toEqual([distinct, duplicate]);
  } finally {
    release.release();
    await querying;
    await migrating;
    vi.mocked(io.rename).mockImplementation(nativeIo.rename);
    await h.close();
  }
}, 15000);

test.each(["collect", "poll"] as const)(
  "task query does not enqueue behind an accepted held per-entry %s",
  async (operation) => {
    const h = await queryFixture();
    const entered = barrier();
    const release = barrier();
    let pending: Promise<unknown> | undefined;
    let querying: Promise<unknown> | undefined;
    try {
      const record = await seedQueryRun(h, "a001", {
        status: "succeeded",
        exit_code: 0,
        started_at: "2026-10-22T03:15:00.000Z",
        finished_at: "2026-10-22T03:15:02.500Z",
      });
      await publishExit(record, "0\n");
      await io.mkdir(outputRoot(record), { recursive: true });
      await io.writeFile(join(outputRoot(record), "artifact.dat"), "abc");
      vi.mocked(io.readdir).mockImplementation(async (...args) => {
        if (args[0] === outputRoot(record)) {
          entered.release();
          await release.waiting;
        }
        return nativeIo.readdir(...args);
      });
      pending =
        operation === "collect" ? h.registry.collectShud(record.run_id) : h.registry.pollOnce();
      void pending.catch(() => undefined);
      await enteredBeforeCompletion(entered.waiting, pending);
      const before = await snapshotQueryTree(h.root);
      const logs = [...h.logs];
      const query = h.registry.listRunJobsByTask(TARGET_TASK);
      querying = observe(query);
      expect(await settlesWhileHeld(query)).toEqual([record]);
      expect(await snapshotQueryTree(h.root)).toEqual(before);
      expect(h.logs).toEqual(logs);
      release.release();
      await pending;
      expect((await h.registry.listRunJobsByTask(TARGET_TASK))[0].status).toBe("collected");
    } finally {
      release.release();
      await querying;
      await pending?.catch(() => undefined);
      vi.mocked(io.readdir).mockImplementation(nativeIo.readdir);
      await h.close();
    }
  },
  15000,
);

test("an accepted held query does not occupy the entry queue or prevent real collection", async () => {
  const h = await queryFixture();
  const entered = barrier();
  const release = barrier();
  let querying: Promise<unknown> | undefined;
  let collecting: Promise<unknown> | undefined;
  try {
    const record = await seedQueryRun(h, "a001", {
      status: "succeeded",
      exit_code: 0,
      started_at: "2026-10-22T03:15:00.000Z",
      finished_at: "2026-10-22T03:15:02.500Z",
    });
    await publishExit(record, "0\n");
    let held = false;
    vi.mocked(io.readFile).mockImplementation(async (...args) => {
      const bytes = await nativeIo.readFile(...args);
      if (args[0] === join(record.run_dir, "run-job.json") && !held) {
        held = true;
        entered.release();
        await release.waiting;
      }
      return bytes;
    });
    const query = h.registry.listRunJobsByTask(TARGET_TASK);
    querying = observe(query);
    await enteredBeforeCompletion(entered.waiting, querying);
    const collect = h.registry.collectShud(record.run_id);
    collecting = observe(collect);
    expect(await settlesWhileHeld(collect)).toMatchObject({
      run_id: record.run_id,
      exit_class: "ok",
    });
    release.release();
    // There is deliberately no cross-file atomic snapshot promise during legitimate updates.
    expect(await query).toEqual([record]);
    expect((await h.registry.listRunJobsByTask(TARGET_TASK))[0].status).toBe("collected");
  } finally {
    release.release();
    await querying;
    await collecting;
    vi.mocked(io.readFile).mockImplementation(nativeIo.readFile);
    await h.close();
  }
}, 15000);

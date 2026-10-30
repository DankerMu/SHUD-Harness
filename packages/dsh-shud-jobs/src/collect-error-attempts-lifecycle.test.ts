import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { ShudJobRegistry } from "./index.ts";
import { StateIndexStore } from "./state-indexes.ts";
import { createHarness } from "./test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";
import { barrier } from "./state-indexes/test-harness.ts";
import { waitForOwnershipRelease } from "./poll-shud/test-harness.ts";
import { waitForRecovery } from "./reconcile-shud/test-harness.ts";
import {
  QUERY_POLL_MS,
  enteredBeforeCompletion,
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
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const native = await vi.importActual<typeof io>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.readFile).mockReset().mockImplementation(native.readFile);
});

test("attempt reads reject before readiness while real startup reconciliation is held", async () => {
  const h = await createHarness(undefined, "absent", false);
  const entered = barrier();
  const release = barrier();
  let applying: Promise<unknown> | undefined;
  try {
    const job = queryRecord(h, "a001");
    await writeQueryRecord(job);
    await io.writeFile(join(h.stateDir, "active.json"), JSON.stringify([indexed(job)]));
    await io.writeFile(join(h.stateDir, "completed.json"), "[]");
    vi.mocked(io.readFile).mockImplementation(async (...args) => {
      if (args[0] === join(job.run_dir, "run-job.json")) {
        entered.release();
        await release.waiting;
      }
      return native.readFile(...args);
    });
    applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: QUERY_POLL_MS });
    void applying.catch(() => undefined);
    await enteredBeforeCompletion(entered.waiting, applying);
    const registry = actualRegistry(h.ctx);
    const reads = vi.mocked(io.readFile).mock.calls.length;
    const outcome = await settlesWhileHeld(observe(registry.readCollectErrorAttempts(job.run_id)));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("Attempt read bypassed readiness");
    expect(String(outcome.error)).toMatch(/not ready/iu);
    expect(io.readFile).toHaveBeenCalledTimes(reads);
    release.release();
    await applying;
  } finally {
    release.release();
    await applying?.catch(() => undefined);
    vi.mocked(io.readFile).mockImplementation(native.readFile);
    await h.ctx.fiber.dispose();
    await waitForOwnershipRelease(h.stateDir);
    await h.dispose();
  }
}, 15000);

test.each([false, true])(
  "accepted ledger read drains before native lock release; read failure=%s",
  async (fails) => {
    const h = await queryFixture();
    const entered = barrier();
    const release = barrier();
    let pending: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    let contender: StateIndexStore | undefined;
    try {
      const job = await seedQueryRun(h, "a001");
      const path = join(job.run_dir, "collect-error.json");
      await io.writeFile(
        path,
        JSON.stringify({
          attempts: 2,
          last_error: "PRIVATE_DRAIN_LEDGER",
          at: "2026-10-22T03:16:00Z",
        }),
      );
      let held = false;
      vi.mocked(io.readFile).mockImplementation(async (...args) => {
        if (args[0] === path && !held) {
          held = true;
          entered.release();
          await release.waiting;
          if (fails) throw Object.assign(new Error("PRIVATE_DRAIN_LEDGER"), { code: "EIO" });
        }
        return native.readFile(...args);
      });
      const operation = h.registry.readCollectErrorAttempts(job.run_id);
      pending = observe(operation);
      await enteredBeforeCompletion(entered.waiting, pending);
      let disposed = false;
      closing = Promise.resolve(h.fiber.dispose()).then(() => {
        disposed = true;
      });
      await waitForRecovery(async () => {
        const outcome = await observe(h.registry.listRunJobsByTask(job.task_id!));
        return !outcome.ok && /closed/iu.test(String(outcome.error));
      }, "registry query closing admission");
      const before = await snapshotQueryTree(h.root);
      const reads = vi.mocked(io.readFile).mock.calls.length;
      await expect(h.registry.readCollectErrorAttempts(job.job_id)).rejects.toThrow(/closed/iu);
      expect(io.readFile).toHaveBeenCalledTimes(reads);
      expect(disposed).toBe(false);
      expect(() => {
        contender = new StateIndexStore(h.stateDir);
      }).toThrow(h.stateDir);
      expect(await snapshotQueryTree(h.root)).toEqual(before);
      release.release();
      if (fails) await expect(operation).rejects.toThrow();
      else expect(await operation).toBe(2);
      await closing;
      await waitForOwnershipRelease(h.stateDir);
      contender = new StateIndexStore(h.stateDir);
      expect(contender.read()).toEqual({ active: [indexed(job)], completed: [] });
      expect(h.logs.join("\n")).not.toContain("PRIVATE_DRAIN_LEDGER");
    } finally {
      release.release();
      await pending;
      await closing;
      await contender?.close();
      vi.mocked(io.readFile).mockImplementation(native.readFile);
      await h.close();
    }
  },
  15000,
);

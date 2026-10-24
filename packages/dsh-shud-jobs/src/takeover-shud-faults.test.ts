import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeFs from "node:fs";
import type { JobHooks, JobView } from "@deepseek-ai/dsh-jobs";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { expectAbsent } from "./collect-shud/test-harness.ts";
import { activeGroup } from "./detached-shud/test-harness.ts";
import { observeSignals } from "./kill-shud/test-harness.ts";
import { pollFixture, readRecord, releaseRun } from "./poll-shud/test-harness.ts";
import { completedWithinWindow, stopWhileRunning } from "./reconcile-shud/test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";
import { producer as ordinaryProducer } from "./test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const actualFs = await vi.importActual<typeof NodeFs>("node:fs");
beforeEach(() => {
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actualFs.renameSync);
});

test.each(["start", "publish", "post-start"] as const)(
  "R5 takeover %s failure leaves no registration and continues file-only collection",
  async (mode) => {
    const h = await pollFixture();
    let applying: Promise<unknown> | undefined;
    let restoreStart: (() => void) | undefined;
    let restoreSignals: (() => void) | undefined;
    const actualHooks: JobHooks[] = [];
    try {
      const { record, pid, invocation, producer } = await stopWhileRunning(h);
      expect(record.dsh_job_id).not.toBeNull();
      const path = join(record.run_dir, "run-job.json");
      const invocationPath = join(record.run_dir, "invocation.json");
      const invocationBytes = await io.readFile(invocationPath);
      const invocationMtime = (await io.stat(invocationPath, { bigint: true })).mtimeNs;
      const files = (await io.readdir(record.run_dir)).sort();
      const indexes = await Promise.all(
        ["active.json", "completed.json"].map(async (name) => {
          const indexPath = join(h.stateDir, name);
          return {
            path: indexPath,
            bytes: await io.readFile(indexPath),
            mtime: (await io.stat(indexPath, { bigint: true })).mtimeNs,
          };
        }),
      );
      const errorsBefore = h.errors.length;
      const signals = observeSignals();
      restoreSignals = signals.restore;
      // Keep the failure armed while manual ticks prove absence of registration retries.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const method: unknown = Object.getOwnPropertyDescriptor(
        LocalJobRegistry.prototype,
        "start",
      )?.value;
      if (typeof method !== "function") throw new Error("Parent start implementation is missing");
      const originalStart = method as typeof LocalJobRegistry.prototype.start;
      const start = vi.spyOn(LocalJobRegistry.prototype, "start");
      restoreStart = () => start.mockRestore();
      const committed: JobView[] = [];
      if (mode === "start") {
        // No producer callback runs: reject at the parent's public admission boundary.
        start.mockImplementation(() => {
          throw Object.assign(new Error("PRIVATE_TAKEOVER_START_PAYLOAD"), { code: "EACCES" });
        });
      } else {
        start.mockImplementation(function (this: LocalJobRegistry, spec) {
          const id = originalStart.call(this, {
            ...spec,
            run(handle) {
              const hooks = spec.run(handle);
              actualHooks.push(hooks);
              return hooks;
            },
          });
          committed.push(this.get(id));
          if (mode === "post-start")
            throw Object.assign(new Error("PRIVATE_TAKEOVER_POST_START_PAYLOAD"), {
              code: "EACCES",
            });
          return id;
        });
      }
      let injections = 0;
      const publications: Array<{ before: RunJob; candidate: RunJob; committed: JobView }> = [];
      if (mode === "publish") {
        vi.mocked(fs.renameSync).mockImplementation((source, target) => {
          if (target === path) {
            const candidate = RunJobSchema.parse(JSON.parse(actualFs.readFileSync(source, "utf8")));
            if (candidate.dsh_job_id !== null && candidate.dsh_job_id !== record.dsh_job_id) {
              const returned = start.mock.results[start.mock.results.length - 1];
              if (!returned || returned.type !== "return")
                throw new Error("Publication fault requires a successfully returned parent start");
              // Observe the actual committed public entry before denying its durable id write.
              publications.push({
                before: RunJobSchema.parse(JSON.parse(actualFs.readFileSync(path, "utf8"))),
                candidate,
                committed: actualRegistry(h.ctx).get(returned.value),
              });
              injections++;
              throw Object.assign(new Error("PRIVATE_TAKEOVER_PUBLISH_PAYLOAD"), { code: "EIO" });
            }
          }
          actualFs.renameSync(source, target);
        });
      }

      applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      await completedWithinWindow(applying);
      const replacement = actualRegistry(h.ctx);
      expect(start.mock.calls.map(([spec]) => spec.kind)).toEqual(["shud"]);
      expect(start.mock.results.map((result) => result.type)).toEqual([
        mode === "publish" ? "return" : "throw",
      ]);
      expect(injections).toBe(mode === "publish" ? 1 : 0);
      expect(committed).toHaveLength(mode === "start" ? 0 : 1);
      if (mode === "post-start") {
        expect(committed[0]).toMatchObject({
          kind: "shud",
          label: record.run_id,
          status: "running",
        });
        expect(committed[0]?.id).not.toBe(record.dsh_job_id);
        expect(committed[0]?.owner).toBeUndefined();
      }
      if (mode === "publish") {
        expect(publications).toHaveLength(1);
        const publication = publications[0];
        if (!publication) throw new Error("The post-start publication fault did not execute");
        expect(publication.before).toEqual({ ...record, dsh_job_id: null });
        expect(publication.committed).toMatchObject({
          kind: "shud",
          label: record.run_id,
          status: "running",
        });
        expect(publication.committed.owner).toBeUndefined();
        expect(publication.committed.id).not.toBe(record.dsh_job_id);
        expect(publication.candidate).toEqual({
          ...record,
          dsh_job_id: publication.committed.id,
          dsh_job_ids: [...record.dsh_job_ids, publication.committed.id],
        });
      } else expect(publications).toEqual([]);
      const retained = { ...record, dsh_job_id: null };
      expect(await readRecord(record.run_dir)).toEqual(retained);
      // Check immediately: a lingering association can suppress retries while leaking this entry.
      expect(replacement.list()).toEqual([]);
      expect(signals.events).toEqual([]);
      expect(activeGroup(pid)).toContain(pid);
      expect(activeGroup(pid)).toContain(invocation.pid);
      expect(await io.readFile(invocationPath)).toEqual(invocationBytes);
      expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(invocationMtime);
      expect((await io.readdir(record.run_dir)).sort()).toEqual(files);
      await expectAbsent(join(record.run_dir, "run-record.json"));
      const retainedBytes = await io.readFile(path);
      const retainedMtime = (await io.stat(path, { bigint: true })).mtimeNs;
      for (let tick = 0; tick < 3; tick++) await completedWithinWindow(replacement.pollOnce());
      // Start rejection currently retries here; the post-start leak fails the earlier list oracle.
      expect(start).toHaveBeenCalledTimes(1);
      expect(injections).toBe(mode === "publish" ? 1 : 0);
      expect(replacement.list()).toEqual([]);
      expect(await io.readFile(path)).toEqual(retainedBytes);
      expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(retainedMtime);
      const diagnostics = h.errors.slice(errorsBefore).join("\n");
      expect(diagnostics).toContain(record.run_id);
      expect(diagnostics).not.toContain("PRIVATE_");
      for (const index of indexes) {
        expect(await io.readFile(index.path)).toEqual(index.bytes);
        expect((await io.stat(index.path, { bigint: true })).mtimeNs).toBe(index.mtime);
      }

      // Still armed: physical completion must not need another parent registration attempt.
      await releaseRun(record);
      await completedWithinWindow(replacement.pollOnce());
      const result = await replacement.collectShud(record.run_id);
      expect(result).toMatchObject({
        run_id: record.run_id,
        job_id: record.job_id,
        exit_code: 0,
        exit_class: "ok",
      });
      const collected = await readRecord(record.run_dir);
      expect(collected.finished_at).toEqual(expect.any(String));
      expect(collected).toEqual({
        ...retained,
        status: "collected",
        exit_code: 0,
        finished_at: collected.finished_at,
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(injections).toBe(mode === "publish" ? 1 : 0);
      expect(replacement.list()).toEqual([]);
      expect(await io.readFile(invocationPath)).toEqual(invocationBytes);
      expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(invocationMtime);
      await completedWithinWindow(producer.executions[0].waitForExit());
      expect(activeGroup(pid)).toEqual([]);
      expect(signals.events).toEqual([]);
      expect(h.sessionEvents).toEqual([]);
      expect(h.flushes).toEqual([]);
      // Exercise real parent admission, not the rejecting spy, for controller-residue proof.
      start.mockRestore();
      expect(() => replacement.start(ordinaryProducer().spec)).toThrow(
        "no job controller serves this agent",
      );
    } finally {
      restoreStart?.();
      vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
      restoreSignals?.();
      for (const hooks of actualHooks) hooks.cancel("test cleanup");
      try {
        // Dispose the actual context before joining startup: this also detaches any leaked
        // committed parent entry and drains its output pump without private store access.
        await completedWithinWindow(h.close());
      } finally {
        try {
          await completedWithinWindow(Promise.allSettled([applying]));
        } finally {
          vi.useRealTimers();
        }
      }
    }
  },
  15000,
);

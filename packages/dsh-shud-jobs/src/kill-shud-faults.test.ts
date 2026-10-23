import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeFs from "node:fs";
import type * as NodeIo from "node:fs/promises";
import type * as NodeChild from "node:child_process";
import { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import { generateRunIdentifiers, RunJobSchema } from "@shud-harness/dsh-shud-core";
import { activeGroup, terminateGroup } from "./detached-shud/test-harness.ts";
import { pollFixture, waitForOwnershipRelease } from "./poll-shud/test-harness.ts";
import { barrier } from "./state-indexes/test-harness.ts";
import { observeSignals, readDurable, readyRun } from "./kill-shud/test-harness.ts";

const inspection = vi.hoisted(() => ({ mode: "", pid: 0 }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChild>();
  return {
    ...actual,
    spawnSync(command: string, args: readonly string[], options: NodeChild.SpawnSyncOptions) {
      if (command === "ps" && args[0] === "-axo" && inspection.mode) {
        const result = actual.spawnSync(command, args, options);
        return {
          ...result,
          stdout:
            inspection.mode === "malformed"
              ? "malformed group inspection\n"
              : `${String(result.stdout).trimEnd()}\n${inspection.pid} ${inspection.pid} S\n`,
        };
      }
      if (
        command === "ps" &&
        args[0] === "-p" &&
        args[1] === String(inspection.pid) &&
        inspection.mode === "replacement"
      ) {
        return {
          pid: 0,
          output: [],
          stdout: "Thu Jan  1 00:00:01 1970\n",
          stderr: "",
          status: 0,
          signal: null,
        };
      }
      return actual.spawnSync(command, args, options);
    },
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const actualFs = await vi.importActual<typeof NodeFs>("node:fs");
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  inspection.mode = "";
  inspection.pid = 0;
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actualFs.renameSync);
  vi.mocked(io.readFile).mockReset().mockImplementation(actualIo.readFile);
});

test.each(["rename", "json", "symlink", "job-id", "pid"] as const)(
  "kill rejects %s metadata failure without signals, a mark, or damaged evidence",
  async (kind) => {
    const h = await pollFixture();
    let signals: ReturnType<typeof observeSignals> | undefined;
    try {
      const { record, id, pid, producer } = await readyRun(h);
      const path = join(record.run_dir, "run-job.json");
      if (kind === "json") await io.writeFile(path, "{broken metadata");
      else if (kind === "symlink") {
        const foreign = join(h.root, "foreign-run-job.json");
        await io.writeFile(foreign, JSON.stringify(record));
        await io.rm(path);
        await io.symlink(foreign, path);
      } else if (kind === "job-id" || kind === "pid") {
        await io.writeFile(
          path,
          JSON.stringify({
            ...record,
            ...(kind === "job-id"
              ? { job_id: generateRunIdentifiers().job_id }
              : { pid: pid + 1000000 }),
          }),
        );
      }
      await h.registry.pollOnce();
      const bytes = await io.readFile(path);
      const mtime = (await io.stat(path, { bigint: true })).mtimeNs;
      if (kind === "rename") {
        vi.mocked(fs.renameSync).mockImplementation((source, target) => {
          if (target === path) {
            const candidate = RunJobSchema.parse(JSON.parse(actualFs.readFileSync(source, "utf8")));
            if (candidate.cancel_requested_at !== null)
              throw Object.assign(new Error("intent publication denied"), { code: "EIO" });
          }
          actualFs.renameSync(source, target);
        });
      }
      signals = observeSignals();
      expect(() => h.registry.kill(id, h.ownerId, "invalid intent request")).toThrow();
      expect(await io.readFile(path)).toEqual(bytes);
      expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(mtime);
      if (kind === "symlink") expect((await io.lstat(path)).isSymbolicLink()).toBe(true);
      expect((await io.readdir(record.run_dir)).filter((name) => name.endsWith(".tmp"))).toEqual(
        [],
      );
      expect(h.registry.get(id, h.ownerId).status).toBe("running");
      expect(producer.registration.cancellations).toEqual([]);
      expect(signals.events).toEqual([]);
      expect(activeGroup(pid)).toContain(pid);
      // A failed persistence must not misclassify the parent's subsequent unmarked disposal call.
      await h.fiber.dispose();
      await waitForOwnershipRelease(h.stateDir);
      await expect
        .poll(() => producer.registration.cancellations)
        .toEqual(["jobs service disposed"]);
      expect(signals.events).toEqual([]);
      expect(activeGroup(pid)).toContain(pid);
      expect(await io.readFile(path)).toEqual(bytes);
    } finally {
      signals?.restore();
      vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
      await h.close();
    }
  },
  15000,
);

test.each(["throw", "already-finished"] as const)(
  "parent kill %s clears its unconsumed mark but retains durable intent",
  async (mode) => {
    const h = await pollFixture();
    let signals: ReturnType<typeof observeSignals> | undefined;
    let restoreParent: (() => void) | undefined;
    try {
      const { record, id, pid, producer } = await readyRun(h);
      signals = observeSignals();
      const parent = vi.spyOn(LocalJobRegistry.prototype, "kill").mockImplementationOnce(() => {
        if (mode === "throw") throw new Error("parent kill refused before cancel");
        return "already-finished";
      });
      restoreParent = () => parent.mockRestore();
      if (mode === "throw") {
        expect(() => h.registry.kill(id, h.ownerId, "parent boundary fault")).toThrow(
          "parent kill refused before cancel",
        );
      } else {
        expect(h.registry.kill(id, h.ownerId, "parent boundary fault")).toBe("already-finished");
      }
      parent.mockRestore();
      const intent = readDurable(record.run_dir);
      expect(intent.cancel_requested_at).toEqual(expect.any(String));
      expect(intent).toEqual({ ...record, cancel_requested_at: intent.cancel_requested_at });
      expect(signals.events).toEqual([]);
      expect(producer.registration.cancellations).toEqual([]);
      await h.fiber.dispose();
      await waitForOwnershipRelease(h.stateDir);
      await expect
        .poll(() => producer.registration.cancellations)
        .toEqual(["jobs service disposed"]);
      expect(signals.events).toEqual([]);
      expect(activeGroup(pid)).toContain(pid);
      expect(readDurable(record.run_dir)).toEqual(intent);
    } finally {
      restoreParent?.();
      signals?.restore();
      await h.close();
    }
  },
  15000,
);

test.each([false, true])(
  "live signal denial retains intent and preserves an additional inspection failure=%s",
  async (failInspection) => {
    const h = await pollFixture();
    let restoreKill: (() => void) | undefined;
    try {
      const { record, id, pid, producer } = await readyRun(h);
      const native = process.kill.bind(process);
      const denied: string[] = [];
      const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target === -pid && signal !== 0) {
          denied.push(String(signal));
          if (failInspection) inspection.mode = "malformed";
          throw Object.assign(new Error("permission denied for live owned group"), {
            code: "EPERM",
          });
        }
        return native(target, signal);
      });
      restoreKill = () => kill.mockRestore();
      let failure: unknown;
      try {
        h.registry.kill(id, h.ownerId, "denied signal");
      } catch (error) {
        failure = error;
      }
      if (failInspection) {
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError))
          throw new Error("Signal and inspection errors were not preserved");
        expect(failure.errors).toHaveLength(2);
        expect(failure.errors[0]).toMatchObject({ code: "EPERM" });
        expect(failure.errors[1]).toBeInstanceOf(Error);
        expect(String(failure.errors[1])).toMatch(/group/iu);
      } else expect(failure).toMatchObject({ code: "EPERM" });
      expect(denied).toEqual(["SIGTERM"]);
      const intent = readDurable(record.run_dir);
      expect(intent.cancel_requested_at).toEqual(expect.any(String));
      expect(intent).toEqual({ ...record, cancel_requested_at: intent.cancel_requested_at });
      expect(h.registry.get(id, h.ownerId).status).toBe("running");
      expect(producer.completed).toEqual([]);
      await h.fiber.dispose();
      await waitForOwnershipRelease(h.stateDir);
      await expect
        .poll(() => producer.registration.cancellations)
        .toEqual(["jobs service disposed"]);
      inspection.mode = "";
      expect(activeGroup(pid)).toContain(pid);
      expect(readDurable(record.run_dir)).toEqual(intent);
      expect(denied).not.toContain("SIGKILL");
    } finally {
      inspection.mode = "";
      restoreKill?.();
      await h.close();
    }
  },
  15000,
);

test.each(["malformed", "replacement"] as const)(
  "kill fails closed on %s ownership inspection without touching metadata or signaling",
  async (mode) => {
    const h = await pollFixture();
    const entered = barrier();
    const release = barrier();
    let polling: Promise<void> | undefined;
    let signals: ReturnType<typeof observeSignals> | undefined;
    try {
      const { record, id, pid, producer } = await readyRun(h);
      if (mode === "replacement") {
        let held = false;
        vi.mocked(io.readFile).mockImplementation(async (...args) => {
          if (!held && args[0] === join(record.run_dir, "exit_code")) {
            held = true;
            entered.release();
            await release.waiting;
          }
          return actualIo.readFile(...args);
        });
        polling = h.registry.pollOnce();
        await entered.waiting;
        await terminateGroup(pid);
        await producer.executions[0].waitForExit();
      }
      const path = join(record.run_dir, "run-job.json");
      const bytes = await io.readFile(path);
      const mtime = (await io.stat(path, { bigint: true })).mtimeNs;
      inspection.pid = pid;
      inspection.mode = mode;
      signals = observeSignals();
      expect(() => h.registry.kill(id, h.ownerId, "uncertain ownership")).toThrow(
        /kill ownership/iu,
      );
      expect(await io.readFile(path)).toEqual(bytes);
      expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(mtime);
      expect(signals.events).toEqual([]);
      expect(h.registry.get(id, h.ownerId).status).toBe("running");
      expect(producer.registration.cancellations).toEqual([]);
    } finally {
      inspection.mode = "";
      release.release();
      await polling?.catch(() => undefined);
      signals?.restore();
      await h.close();
    }
  },
  15000,
);

test.each(["invalid", "unreadable"] as const)(
  "public kill preserves %s exit evidence as failure rather than cancelled or lost",
  async (kind) => {
    const h = await pollFixture();
    try {
      const { record, id, pid, producer } = await readyRun(h);
      const path = join(record.run_dir, "exit_code");
      const bytes = kind === "invalid" ? "13junk\n" : "13\n";
      if (kind === "unreadable") {
        vi.mocked(io.readFile).mockImplementation(async (...args) => {
          if (args[0] === path)
            throw Object.assign(new Error("exit evidence denied"), { code: "EACCES" });
          return actualIo.readFile(...args);
        });
      }
      // Publish and kill in one turn; no timer may consume this file before cancellation admission.
      actualFs.writeFileSync(path, bytes);
      expect(h.registry.kill(id, h.ownerId, "kill with existing bad evidence")).toBe("requested");
      const requestedAt = readDurable(record.run_dir).cancel_requested_at;
      await expect.poll(() => producer.completed.length).toBe(1);
      await producer.doneObserved;
      expect(producer.durableAtSettle[0]).toMatchObject({
        status: "failed",
        exit_code: null,
        cancel_requested_at: requestedAt,
      });
      expect(producer.completed[0].status).toBe("failed");
      expect(producer.completed[0].detail).toMatch(
        kind === "invalid" ? /integer/iu : /unreadable/iu,
      );
      expect(producer.completed[0].detail).not.toMatch(/cancelled|lost/iu);
      expect(producer.durableAtDone).toEqual(producer.durableAtSettle);
      expect(activeGroup(pid)).toEqual([]);
      expect(await actualIo.readFile(path, "utf8")).toBe(bytes);
      expect(producer.registration.cancellations).toEqual([]);
    } finally {
      vi.mocked(io.readFile).mockImplementation(actualIo.readFile);
      await h.close();
    }
  },
  15000,
);

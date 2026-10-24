import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeChild from "node:child_process";
import type * as NodeFs from "node:fs";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { expectAbsent, publishExit, readResult } from "./collect-shud/test-harness.ts";
import { activeGroup } from "./detached-shud/test-harness.ts";
import { readDurable } from "./kill-shud/test-harness.ts";
import { pollFixture, readRecord, waitForOwnershipRelease } from "./poll-shud/test-harness.ts";
import {
  closeRecovery,
  completedWithinWindow,
  stopWithCancellation,
  waitForRecovery,
  waitForTerm,
} from "./reconcile-shud/test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";

interface RecoveryFault {
  mode: string;
  pid: number;
  path: string;
  leaderReads: number;
  absentReads: number;
  replacementStamp: string;
  denyWrite: boolean;
  terminals: Array<{ status: RunJob["status"]; exit_code: number | null }>;
}

const fault = vi.hoisted((): RecoveryFault => ({
  mode: "",
  pid: 0,
  path: "",
  leaderReads: 0,
  absentReads: 0,
  replacementStamp: "Thu Jan  1 00:00:01 1970",
  denyWrite: false,
  terminals: [],
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChild>();
  return {
    ...actual,
    spawnSync(command: string, args: readonly string[], options: NodeChild.SpawnSyncOptions) {
      const result = actual.spawnSync(command, args, options);
      if (command === "ps" && args[0] === "-axo" && fault.pid) {
        if (fault.mode === "group") return { ...result, stdout: "malformed group\n", status: 0 };
        if (fault.mode === "replacement") {
          return {
            ...result,
            stdout: `${String(result.stdout).trimEnd()}\n${fault.pid} ${fault.pid} S\n`,
            stderr: "",
            status: 0,
          };
        }
      }
      if (command === "ps" && args[0] === "-p" && args[1] === String(fault.pid)) {
        fault.leaderReads++;
        if (result.status === 1 && !String(result.stdout).trim()) fault.absentReads++;
        if (fault.mode === "identity")
          return { ...result, stdout: "malformed identity\n", stderr: "", status: 0 };
        if (fault.mode === "replacement") {
          return {
            ...result,
            stdout: `${fault.replacementStamp}${args.join(" ").includes("stat=") ? " S" : ""}\n`,
            stderr: "",
            status: 0,
          };
        }
      }
      return result;
    },
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const actualFs = await vi.importActual<typeof NodeFs>("node:fs");
const actualChild = await vi.importActual<typeof NodeChild>("node:child_process");
const nativeKill = process.kill.bind(process);
beforeEach(() => {
  fault.mode = "";
  fault.pid = 0;
  fault.path = "";
  fault.leaderReads = 0;
  fault.absentReads = 0;
  fault.replacementStamp = "Thu Jan  1 00:00:01 1970";
  fault.denyWrite = false;
  fault.terminals = [];
  vi.mocked(fs.renameSync)
    .mockReset()
    .mockImplementation((source, target) => {
      let terminal: RunJob | undefined;
      if (target === fault.path) {
        const candidate = RunJobSchema.parse(JSON.parse(actualFs.readFileSync(source, "utf8")));
        if (["succeeded", "failed", "cancelled"].includes(candidate.status)) {
          if (fault.denyWrite)
            throw Object.assign(new Error("terminal publication denied"), { code: "EIO" });
          terminal = candidate;
        }
      }
      actualFs.renameSync(source, target);
      if (terminal)
        fault.terminals.push({ status: terminal.status, exit_code: terminal.exit_code });
    });
});

function groupSignals(pid: number) {
  const events: Array<{ pid: number; signal: string }> = [];
  let denied: "SIGTERM" | "SIGKILL" | undefined;
  const spy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (signal !== 0) {
      events.push({ pid: target, signal: String(signal ?? "SIGTERM") });
      if (target < 0 && target !== -pid) throw new Error("Refusing a foreign test-group signal");
    }
    if (target === -pid && denied !== undefined && signal === denied)
      throw Object.assign(new Error("owned group signal denied"), { code: "EPERM" });
    return nativeKill(target, signal);
  });
  return {
    events,
    deny(signal?: "SIGTERM" | "SIGKILL") {
      denied = signal;
    },
    restore: () => spy.mockRestore(),
  };
}

test.each([
  { code: null, status: "cancelled", exitClass: "cancelled" },
  { code: 19, status: "failed", exitClass: "cvode" },
] as const)(
  "recovered leader-first cancellation retains its original deadline with exit=$code",
  async ({ code, status, exitClass }) => {
    const h = await pollFixture();
    let pid: number | undefined;
    let applying: Promise<unknown> | undefined;
    let restoreSignals: (() => void) | undefined;
    try {
      const run = await stopWithCancellation(h);
      pid = run.pid;
      fault.pid = pid;
      fault.path = join(run.record.run_dir, "run-job.json");
      const bytes = await io.readFile(fault.path);
      const mtime = (await io.stat(fault.path, { bigint: true })).mtimeNs;
      const signals = groupSignals(pid);
      restoreSignals = signals.restore;
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      vi.setSystemTime(run.requestedAt + 5000);
      let ready = false;
      applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 }).then((fiber) => {
        ready = true;
        return fiber;
      });
      void applying.catch(() => undefined);
      await waitForTerm(run.record.run_dir);
      await waitForRecovery(() => !activeGroup(run.pid).includes(run.pid), "leader exit");
      await run.producer.executions[0].waitForExit();
      expect(activeGroup(pid)).toContain(run.invocation.pid);
      expect(ready).toBe(false);
      if (code !== null) await publishExit(run.record, `${code}\n`);

      for (const now of [run.requestedAt - 1000, run.requestedAt + 9999]) {
        const inspected = fault.leaderReads;
        vi.setSystemTime(now);
        await waitForRecovery(() => fault.leaderReads > inspected, "another recovery inspection");
        expect(signals.events).toEqual([{ pid: -pid, signal: "SIGTERM" }]);
        expect(activeGroup(pid)).toContain(run.invocation.pid);
        expect(await io.readFile(fault.path)).toEqual(bytes);
        expect((await io.stat(fault.path, { bigint: true })).mtimeNs).toBe(mtime);
        expect(readDurable(run.record.run_dir)).toEqual(run.record);
        expect(fault.terminals).toEqual([]);
        expect(ready).toBe(false);
      }
      vi.setSystemTime(run.requestedAt + 10000);
      await completedWithinWindow(applying);
      expect(signals.events).toEqual([
        { pid: -pid, signal: "SIGTERM" },
        { pid: -pid, signal: "SIGKILL" },
      ]);
      expect(activeGroup(pid)).toEqual([]);
      // Observe the committed terminal RunJob, not only collect's independent exit-file reread.
      expect(fault.terminals).toEqual([{ status, exit_code: code }]);
      const collected = await readRecord(run.record.run_dir);
      expect(collected.status).toBe("collected");
      expect(collected.exit_code).toBe(code);
      expect(collected.cancel_requested_at).toBe(run.record.cancel_requested_at);
      expect(collected.notify).toEqual(run.record.notify);
      expect(await readResult(run.record.run_dir)).toMatchObject({
        exit_code: code,
        exit_class: exitClass,
      });
      expect(actualRegistry(h.ctx).list()).toEqual([]);
    } finally {
      fault.mode = "";
      fault.denyWrite = false;
      restoreSignals?.();
      vi.useRealTimers();
      await closeRecovery(h, pid, applying);
    }
  },
  15000,
);

test.each(["unowned-inspection", "owned-inspection", "TERM", "KILL", "write"] as const)(
  "recovered %s failure retains the responsibility needed for later settlement",
  async (kind) => {
    const h = await pollFixture();
    let pid: number | undefined;
    let applying: Promise<unknown> | undefined;
    let restoreSignals: (() => void) | undefined;
    try {
      const run = await stopWithCancellation(h);
      pid = run.pid;
      fault.pid = pid;
      fault.path = join(run.record.run_dir, "run-job.json");
      const bytes = await io.readFile(fault.path);
      const mtime = (await io.stat(fault.path, { bigint: true })).mtimeNs;
      const signals = groupSignals(pid);
      restoreSignals = signals.restore;
      if (kind === "unowned-inspection") fault.mode = "identity";
      if (kind === "owned-inspection") fault.mode = "group";
      if (kind === "TERM") signals.deny("SIGTERM");
      if (kind === "KILL") signals.deny("SIGKILL");
      if (kind === "write") fault.denyWrite = true;
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      vi.setSystemTime(run.requestedAt + 10000);
      applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      await completedWithinWindow(applying);
      expect(h.errors.length).toBeGreaterThan(0);
      expect(await io.readFile(fault.path)).toEqual(bytes);
      expect((await io.stat(fault.path, { bigint: true })).mtimeNs).toBe(mtime);
      await expectAbsent(join(run.record.run_dir, "run-record.json"));
      expect(fault.terminals).toEqual([]);
      fault.mode = "";
      fault.denyWrite = false;
      signals.deny();
      const registry = actualRegistry(h.ctx);

      if (kind === "owned-inspection" || kind === "TERM") {
        // Ownership was already established: losing the leader must not turn this into unowned R7.
        nativeKill(run.pid, "SIGKILL");
        await run.producer.executions[0].waitForExit();
        expect(activeGroup(pid)).toContain(run.invocation.pid);
      } else if (kind === "KILL") {
        await run.producer.executions[0].waitForExit();
        expect(activeGroup(pid)).toContain(run.invocation.pid);
      } else if (kind === "unowned-inspection") {
        expect(activeGroup(pid)).toContain(pid);
        expect(signals.events).toEqual([]);
      } else {
        expect(activeGroup(pid)).toEqual([]);
        const priorSignals = [...signals.events];
        fault.mode = "replacement";
        await registry.pollOnce();
        expect(await io.readFile(fault.path)).toEqual(bytes);
        expect(signals.events).toEqual(priorSignals);
        expect(fault.terminals).toEqual([]);
        fault.mode = "";
      }
      await waitForRecovery(async () => {
        await completedWithinWindow(registry.pollOnce());
        return (await readRecord(run.record.run_dir)).status === "collected";
      }, "collection after the recovered fault clears");
      expect(activeGroup(pid)).toEqual([]);
      expect(signals.events).toContainEqual({ pid: -pid, signal: "SIGKILL" });
      expect(fault.terminals).toEqual([{ status: "cancelled", exit_code: null }]);
      const collected = await readRecord(run.record.run_dir);
      expect(collected.cancel_requested_at).toBe(run.record.cancel_requested_at);
      expect(collected.notify).toEqual(run.record.notify);
      expect((await readResult(run.record.run_dir)).exit_class).toBe("cancelled");
      expect(registry.list()).toEqual([]);
      if (kind === "write") expect(signals.events).toHaveLength(2);
    } finally {
      fault.mode = "";
      fault.denyWrite = false;
      restoreSignals?.();
      vi.useRealTimers();
      await closeRecovery(h, pid, applying);
    }
  },
  15000,
);

test("interrupted recovered TERM failure preserves the original deadline for another owner", async () => {
  const h = await pollFixture();
  let pid: number | undefined;
  let applying: Promise<unknown> | undefined;
  let restoreSignals: (() => void) | undefined;
  try {
    const run = await stopWithCancellation(h);
    pid = run.pid;
    fault.pid = pid;
    fault.path = join(run.record.run_dir, "run-job.json");
    const bytes = await io.readFile(fault.path);
    const signals = groupSignals(pid);
    restoreSignals = signals.restore;
    signals.deny("SIGTERM");
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(run.requestedAt + 5000);
    const firstPending = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    applying = firstPending;
    await completedWithinWindow(firstPending);
    const first = await firstPending;
    expect(h.errors.length).toBeGreaterThan(0);
    expect(signals.events).toEqual([{ pid: -pid, signal: "SIGTERM" }]);
    expect(await io.readFile(fault.path)).toEqual(bytes);
    await first.dispose();
    await waitForOwnershipRelease(h.stateDir);
    expect(activeGroup(pid)).toContain(pid);
    expect(activeGroup(pid)).toContain(run.invocation.pid);
    expect(await io.readFile(fault.path)).toEqual(bytes);
    signals.deny();
    vi.setSystemTime(run.requestedAt + 10000);

    applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    await completedWithinWindow(applying);
    expect(signals.events).toEqual([
      { pid: -pid, signal: "SIGTERM" },
      { pid: -pid, signal: "SIGTERM" },
      { pid: -pid, signal: "SIGKILL" },
    ]);
    expect(activeGroup(pid)).toEqual([]);
    expect((await readRecord(run.record.run_dir)).cancel_requested_at).toBe(
      run.record.cancel_requested_at,
    );
    expect((await readResult(run.record.run_dir)).exit_class).toBe("cancelled");
    expect(actualRegistry(h.ctx).list()).toEqual([]);
  } finally {
    restoreSignals?.();
    vi.useRealTimers();
    await closeRecovery(h, pid, applying);
  }
}, 15000);

test("recovered ownership refuses a reappearing leader even when its coarse start stamp matches", async () => {
  const h = await pollFixture();
  let pid: number | undefined;
  let applying: Promise<unknown> | undefined;
  let restoreSignals: (() => void) | undefined;
  try {
    const run = await stopWithCancellation(h);
    pid = run.pid;
    fault.pid = pid;
    fault.path = join(run.record.run_dir, "run-job.json");
    const stamp = actualChild.spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
    });
    expect(stamp.status).toBe(0);
    fault.replacementStamp = stamp.stdout.trim();
    const signals = groupSignals(pid);
    restoreSignals = signals.restore;
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(run.requestedAt + 5000);
    applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    void applying.catch(() => undefined);
    await waitForTerm(run.record.run_dir);
    await run.producer.executions[0].waitForExit();
    await waitForRecovery(() => fault.absentReads > 0, "an observed absent leader");
    fault.mode = "replacement";
    vi.setSystemTime(run.requestedAt + 10000);
    await completedWithinWindow(applying);
    expect(h.errors.length).toBeGreaterThan(0);
    expect(readDurable(run.record.run_dir)).toEqual(run.record);
    expect(fault.terminals).toEqual([]);
    expect(signals.events).toEqual([{ pid: -pid, signal: "SIGTERM" }]);
    expect(activeGroup(pid)).toContain(run.invocation.pid);
    fault.mode = "";
    const registry = actualRegistry(h.ctx);
    await waitForRecovery(async () => {
      await completedWithinWindow(registry.pollOnce());
      return (await readRecord(run.record.run_dir)).status === "collected";
    }, "collection after the replacement leader disappears");
    expect(activeGroup(pid)).toEqual([]);
  } finally {
    fault.mode = "";
    restoreSignals?.();
    vi.useRealTimers();
    await closeRecovery(h, pid, applying);
  }
}, 15000);

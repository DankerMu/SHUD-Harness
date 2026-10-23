import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeChild from "node:child_process";
import type * as NodeIo from "node:fs/promises";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry, startDetachedShud, type ShudExecution } from "./index.ts";
import {
  actualRegistry,
  registrationResource,
  submissionFixture,
} from "./submit-shud/test-harness.ts";
import {
  activeGroup,
  installFakeShud,
  readInvocation,
  terminateGroup,
  waitForUnreapedWrapper,
} from "./detached-shud/test-harness.ts";

const observed = vi.hoisted(() => ({
  failInspection: false,
  reusedPid: 0,
  children: [] as Array<{ pid: number; exited: Promise<void>; hasExited: boolean }>,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChild>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[], options: NodeChild.SpawnOptions) {
      const child = actual.spawn(command, args, options);
      if (child.pid !== undefined) {
        const receipt = { pid: child.pid, exited: Promise.resolve(), hasExited: false };
        receipt.exited = new Promise<void>((resolve) =>
          child.once("exit", () => {
            receipt.hasExited = true;
            resolve();
          }),
        );
        observed.children.push(receipt);
      }
      return child;
    },
    spawnSync(command: string, args: readonly string[], options: NodeChild.SpawnSyncOptions) {
      if (observed.failInspection && command === "ps" && args[0] === "-axo") {
        return { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null };
      }
      if (observed.reusedPid > 0 && command === "ps") {
        if (args[0] === "-p" && args[1] === String(observed.reusedPid)) {
          return actual.spawnSync(command, ["-p", String(process.pid), "-o", "lstart="], options);
        }
        if (args[0] === "-axo") {
          const result = actual.spawnSync(command, args, options);
          return {
            ...result,
            stdout: `${String(result.stdout).trimEnd()}\n${observed.reusedPid} ${observed.reusedPid} Ss\n`,
          };
        }
      }
      return actual.spawnSync(command, args, options);
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  observed.failInspection = false;
  observed.reusedPid = 0;
  observed.children = [];
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
});

async function stopChildren(): Promise<void> {
  const failures: unknown[] = [];
  for (const child of observed.children) {
    try {
      await terminateGroup(child.pid);
    } catch (error) {
      failures.push(error);
    }
  }
  await Promise.all(observed.children.map((child) => child.exited));
  if (failures.length) throw new AggregateError(failures, "Independent abort-test cleanup failed");
}

test("abort reaps an already-exited wrapper after an independent native Z barrier", async () => {
  const h = await submissionFixture();
  const registration = registrationResource();
  const receipt: {
    execution?: ShudExecution;
    pid?: number;
    outcome?: Promise<unknown>;
    reapedAtReturn?: boolean;
  } = {};
  try {
    await h.apply(ShudJobRegistry, h.config);
    const record = await actualRegistry(h.ctx).submitShud(
      h.request,
      (prepared, handle, pumpPollMs) => {
        receipt.execution = startDetachedShud(
          prepared,
          registration.open(prepared, handle),
          pumpPollMs,
        );
        // No await: this host cannot reap while the separate inspector waits for exit_code and Z.
        receipt.pid = waitForUnreapedWrapper(prepared.run_dir);
        receipt.outcome = receipt.execution.abort().then(
          () => {
            receipt.reapedAtReturn = observed.children.every((child) => child.hasExited);
            return null;
          },
          (error: unknown) => error,
        );
        return receipt.execution;
      },
    );
    expect(receipt.pid).toBe(record.pid);
    expect(await receipt.outcome).toBeNull();
    expect(receipt.reapedAtReturn).toBe(true);
    if (!receipt.execution) throw new Error("No actual execution reached the Z barrier");
    const identity = await receipt.execution.started;
    expect(identity.pid).toBe(receipt.pid);
    if (receipt.pid === undefined)
      throw new Error("Independent Z barrier did not observe a wrapper");
    expect(activeGroup(receipt.pid)).toEqual([]);
    expect(await io.readFile(join(record.run_dir, "exit_code"), "utf8")).toBe("0\n");
    // Abort owns process cleanup, not normal registration settlement or the durable outcome.
    expect(registration.cancellations).toEqual([]);
  } finally {
    await stopChildren();
    await receipt.outcome;
    registration.finish();
    await h.dispose();
  }
}, 15000);

test.each(["live", "indeterminate", "quiescent"] as const)(
  "signal denial with %s group evidence cannot invent successful rollback",
  async (evidence) => {
    const h = await submissionFixture();
    const registration = registrationResource();
    const persistenceFailure = new Error("injected running persistence failure");
    const denied = Object.assign(new Error("injected owned-group permission denial"), {
      code: "EPERM",
    });
    const nativeKill = process.kill.bind(process);
    let restoreKill: (() => void) | undefined;
    let pending: Promise<RunJob> | undefined;
    let running: RunJob | undefined;
    let denials = 0;
    try {
      await installFakeShud(h.shudBin, 0, "held");
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (typeof target === "string" && target.endsWith("/run-job.json")) {
          const candidate = RunJobSchema.parse(JSON.parse(await io.readFile(source, "utf8")));
          if (candidate.status === "running") {
            running = candidate;
            if (candidate.pid === null) throw new Error("Running write has no owned wrapper pid");
            const pid = candidate.pid;
            await expect
              .poll(() => readInvocation(candidate.run_dir), { timeout: 5000 })
              .not.toBeNull();
            expect(activeGroup(pid)).toContain(pid);
            const kill = vi.spyOn(process, "kill").mockImplementation((targetPid, signal) => {
              if (targetPid === -pid && signal === "SIGKILL") {
                denials++;
                if (evidence === "indeterminate") observed.failInspection = true;
                if (evidence === "quiescent") {
                  nativeKill(targetPid, signal);
                  expect(waitForUnreapedWrapper(candidate.run_dir, false)).toBe(pid);
                }
                throw denied;
              }
              return nativeKill(targetPid, signal);
            });
            restoreKill = () => kill.mockRestore();
            throw persistenceFailure;
          }
        }
        await actualIo.rename(source, target);
      });
      pending = registry.submitShud(h.request, (prepared, handle, pumpPollMs) =>
        startDetachedShud(prepared, registration.open(prepared, handle), pumpPollMs),
      );
      const outcome: unknown = await pending.then(
        () => null,
        (error: unknown) => error,
      );
      expect(denials).toBe(1);
      if (!running) throw new Error("Permission-denial test did not reach running persistence");
      if (evidence === "quiescent") {
        expect(outcome).toBe(persistenceFailure);
        expect(registration.cancellations).toEqual(["SHUD submission rolled back"]);
        expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
        expect(registry.list()).toEqual([]);
        expect(await io.readdir(join(h.cwd, "runs"))).toEqual([]);
      } else {
        expect(outcome).toBeInstanceOf(AggregateError);
        if (!(outcome instanceof AggregateError))
          throw new Error("Permission denial was not retained");
        expect(outcome.errors[0]).toBe(persistenceFailure);
        const cleanup: unknown = outcome.errors[1];
        if (evidence === "live") expect(cleanup).toBe(denied);
        else {
          expect(cleanup).toBeInstanceOf(AggregateError);
          if (!(cleanup instanceof AggregateError))
            throw new Error("Signal and inspection failures were not both retained");
          expect(cleanup.errors[0]).toBe(denied);
          const inspection: unknown = cleanup.errors[1];
          expect(inspection instanceof Error ? inspection.message : null).toContain(
            "Cannot inspect owned process group",
          );
        }
        expect(registration.cancellations).toEqual([]);
        expect(registry.indexes.lookup(running.run_id)?.run_dir).toBe(running.run_dir);
        expect(registry.isSubmissionInFlight(running.run_id)).toBe(true);
        expect(registry.list()).toHaveLength(1);
        expect(
          RunJobSchema.parse(
            JSON.parse(await io.readFile(join(running.run_dir, "run-job.json"), "utf8")),
          ).status,
        ).toBe("submitted");
      }
    } finally {
      restoreKill?.();
      observed.failInspection = false;
      await stopChildren();
      await pending?.catch(() => undefined);
      registration.finish();
      await h.dispose();
    }
  },
  15000,
);

test("abort refuses an observable replacement leader after its original wrapper has been reaped", async () => {
  const h = await submissionFixture();
  const registration = registrationResource();
  const receipt: { execution?: ShudExecution } = {};
  const nativeKill = process.kill.bind(process);
  let restoreKill: (() => void) | undefined;
  let foreignSignals = 0;
  try {
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    const record = await registry.submitShud(h.request, (prepared, handle, pumpPollMs) => {
      receipt.execution = startDetachedShud(
        prepared,
        registration.open(prepared, handle),
        pumpPollMs,
      );
      return receipt.execution;
    });
    if (record.pid === null || !receipt.execution) throw new Error("No owned wrapper was started");
    const wrapperPid = record.pid;
    const child = observed.children.find((entry) => entry.pid === record.pid);
    if (!child) throw new Error("No actual child reaping receipt");
    await child.exited;
    expect(child.hasExited).toBe(true);
    expect(activeGroup(record.pid)).toEqual([]);
    // Replay OS evidence of a replacement only after the real original leader has been reaped.
    observed.reusedPid = record.pid;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -wrapperPid && signal === "SIGKILL") {
        foreignSignals++;
        throw new Error("Attempted to signal the observable replacement group");
      }
      return nativeKill(pid, signal);
    });
    restoreKill = () => kill.mockRestore();
    await expect(receipt.execution.abort()).rejects.toThrow(
      "Cannot prove ownership of reused process group",
    );
    expect(foreignSignals).toBe(0);
    expect(registration.cancellations).toEqual([]);
    expect(registry.indexes.lookup(record.run_id)?.run_dir).toBe(record.run_dir);
    expect(JSON.parse(await io.readFile(join(record.run_dir, "run-job.json"), "utf8"))).toEqual(
      record,
    );
  } finally {
    restoreKill?.();
    observed.reusedPid = 0;
    await stopChildren();
    registration.finish();
    await h.dispose();
  }
}, 15000);

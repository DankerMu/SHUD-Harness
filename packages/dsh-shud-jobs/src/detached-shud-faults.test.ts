import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeChild from "node:child_process";
import type * as NodeIo from "node:fs/promises";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { createHarness } from "./test-harness.ts";
import { barrier } from "./state-indexes/test-harness.ts";
import { actualRegistry, submissionFixture } from "./submit-shud/test-harness.ts";
import {
  activeGroup,
  cleanupResources,
  detachedProducer,
  installFakeShud,
  readInvocation,
  terminateGroup,
} from "./detached-shud/test-harness.ts";

const fault = vi.hoisted(() => ({
  mode: "",
  missingExecutable: "",
  replayPid: 0,
  replayRemaining: 0,
  groupReads: 0,
  children: [] as Array<{ pid: number; exited: Promise<void> }>,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChild>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[], options: NodeChild.SpawnOptions) {
      const child = actual.spawn(
        fault.mode === "spawn" && command === "/bin/sh" ? fault.missingExecutable : command,
        args,
        options,
      );
      if (child.pid !== undefined) {
        fault.children.push({
          pid: child.pid,
          exited: new Promise<void>((resolve) => child.once("exit", () => resolve())),
        });
      }
      return child;
    },
    spawnSync(command: string, args: readonly string[], options: NodeChild.SpawnSyncOptions) {
      if (
        fault.mode === "identity" &&
        command === "ps" &&
        args[0] === "-p" &&
        args[1] !== String(process.pid)
      ) {
        return { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null };
      }
      if (fault.mode === "group" && command === "ps" && args[0] === "-axo") {
        fault.mode = "";
        return { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null };
      }
      if (fault.mode === "transient-state" && command === "ps" && args[0] === "-axo") {
        fault.groupReads++;
        const result = actual.spawnSync(command, args, options);
        if (fault.replayRemaining > 0) {
          fault.replayRemaining--;
          // Native Darwin capture: "32050 32050 ?s  "; rebind only its owned pid/pgid.
          return {
            ...result,
            stdout: `${String(result.stdout).trimEnd()}\n${fault.replayPid} ${fault.replayPid} ?s  \n`,
          };
        }
        return result;
      }
      return actual.spawnSync(command, args, options);
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  fault.mode = "";
  fault.children = [];
  fault.replayPid = 0;
  fault.replayRemaining = 0;
  fault.groupReads = 0;
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
  vi.mocked(io.rm).mockReset().mockImplementation(actualIo.rm);
});

async function stopObservedChildren(): Promise<void> {
  for (const child of fault.children) await terminateGroup(child.pid);
  await Promise.all(fault.children.map((child) => child.exited));
}

test("D7 membership survives the held running rename and clears only after atomic identity publication", async () => {
  const h = await submissionFixture();
  const execution = detachedProducer();
  const entered = barrier();
  const release = barrier();
  let pending: Promise<RunJob> | undefined;
  let running: RunJob | undefined;
  try {
    await installFakeShud(h.shudBin, 0, "held");
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (typeof target === "string" && target.endsWith("/run-job.json")) {
        const candidate = RunJobSchema.parse(JSON.parse(await io.readFile(source, "utf8")));
        if (candidate.status === "running") {
          running = candidate;
          entered.release();
          await release.waiting;
        }
      }
      await actualIo.rename(source, target);
    });
    pending = registry.submitShud(h.request, execution.start);
    await Promise.race([
      entered.waiting,
      pending.then(() => {
        throw new Error("Submission bypassed the running persistence barrier");
      }),
    ]);
    if (!running || running.pid === null)
      throw new Error("Running write has no genuine process identity");
    expect(registry.isSubmissionInFlight(running.run_id)).toBe(true);
    const previous = RunJobSchema.parse(
      JSON.parse(await io.readFile(join(running.run_dir, "run-job.json"), "utf8")),
    );
    expect(previous.status).toBe("submitted");
    expect(previous.pid).toBeNull();
    expect(previous.pid_started_at).toBeNull();
    expect(previous.dsh_job_id).not.toBeNull();
    expect(activeGroup(running.pid)).toContain(running.pid);
    release.release();
    const record = await pending;
    expect(record).toEqual(running);
    expect(registry.isSubmissionInFlight(record.run_id)).toBe(false);
    expect(JSON.parse(await io.readFile(join(record.run_dir, "run-job.json"), "utf8"))).toEqual(
      record,
    );
  } finally {
    release.release();
    await stopObservedChildren();
    await pending?.catch(() => undefined);
    await stopObservedChildren();
    await cleanupResources([() => execution.cleanup(), () => h.dispose()]);
  }
}, 15000);

test.each(["spawn", "identity"])(
  "%s failure rejects and rolls back only after owned execution is quiescent",
  async (mode) => {
    const h = await submissionFixture();
    const execution = detachedProducer();
    let pending: Promise<RunJob> | undefined;
    try {
      await installFakeShud(h.shudBin, 0, "held");
      await h.apply(ShudJobRegistry, h.config);
      fault.mode = mode;
      fault.missingExecutable = join(h.root, "missing-wrapper-executable");
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.rm).mockImplementation(async (path, options) => {
        if (typeof path === "string" && path.includes("/runs/RUN-") && options?.recursive) {
          for (const child of fault.children) expect(activeGroup(child.pid)).toEqual([]);
        }
        await actualIo.rm(path, options);
      });
      pending = registry.submitShud(h.request, execution.start);
      await expect(pending).rejects.toThrow(
        mode === "spawn" ? /spawn|ENOENT/u : /identity|inspect/u,
      );
      expect(await io.readdir(join(h.cwd, "runs"))).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(registry.list()).toEqual([]);
      for (const child of fault.children) expect(activeGroup(child.pid)).toEqual([]);
    } finally {
      fault.mode = "";
      await stopObservedChildren();
      await pending?.catch(() => undefined);
      await stopObservedChildren();
      await cleanupResources([() => execution.cleanup(), () => h.dispose()]);
    }
  },
  15000,
);

test("running-write rollback terminates an output-holding descendant even after the wrapper shell exits", async () => {
  const h = await submissionFixture();
  let wrapperPid: number | undefined;
  const execution = detachedProducer(() => {
    if (wrapperPid !== undefined) expect(activeGroup(wrapperPid)).toEqual([]);
  });
  let pending: Promise<RunJob> | undefined;
  let descendantPid: number | undefined;
  try {
    await installFakeShud(h.shudBin, 0, "descendant");
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (typeof target === "string" && target.endsWith("/run-job.json")) {
        const record = RunJobSchema.parse(JSON.parse(await io.readFile(source, "utf8")));
        if (record.status === "running") {
          if (record.pid === null) throw new Error("Running write omitted wrapper identity");
          wrapperPid = record.pid;
          const pid = record.pid;
          await expect.poll(() => readInvocation(record.run_dir), { timeout: 5000 }).not.toBeNull();
          const invocation = await readInvocation(record.run_dir);
          if (!invocation) throw new Error("Descendant readiness receipt disappeared");
          descendantPid = invocation.pid;
          await expect.poll(() => activeGroup(pid), { timeout: 5000 }).not.toContain(pid);
          expect(activeGroup(pid)).toContain(descendantPid);
          throw new Error("injected running persistence failure");
        }
      }
      await actualIo.rename(source, target);
    });
    vi.mocked(io.rm).mockImplementation(async (path, options) => {
      if (
        typeof path === "string" &&
        path.includes("/runs/RUN-") &&
        options?.recursive &&
        wrapperPid !== undefined
      ) {
        expect(activeGroup(wrapperPid)).toEqual([]);
      }
      await actualIo.rm(path, options);
    });
    pending = registry.submitShud(h.request, execution.start);
    await expect(pending).rejects.toThrow("injected running persistence failure");
    expect(descendantPid).toBeTypeOf("number");
    if (wrapperPid === undefined) throw new Error("No owned wrapper group was observed");
    expect(activeGroup(wrapperPid)).toEqual([]);
    expect(execution.registration.cancellations).toContain("SHUD submission rolled back");
    expect(registry.list()).toEqual([]);
    expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
    expect(await io.readdir(join(h.cwd, "runs"))).toEqual([]);
  } finally {
    await stopObservedChildren();
    await pending?.catch(() => undefined);
    await stopObservedChildren();
    await cleanupResources([() => execution.cleanup(), () => h.dispose()]);
  }
}, 15000);

test("captured Darwin ?s state keeps rollback waiting until the owned group is quiescent", async () => {
  const h = await submissionFixture();
  const execution = detachedProducer(() => {
    expect(fault.replayRemaining).toBe(0);
    expect(fault.groupReads).toBeGreaterThanOrEqual(3);
  });
  const persistenceFailure = new Error("late id persistence failed during captured-state replay");
  let pending: Promise<RunJob> | undefined;
  try {
    await installFakeShud(h.shudBin, 0, "held");
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (typeof target === "string" && target.endsWith("/run-job.json")) {
        const candidate = RunJobSchema.parse(JSON.parse(await io.readFile(source, "utf8")));
        if (candidate.status === "submitted" && candidate.dsh_job_id !== null) {
          const child = fault.children.at(-1);
          if (!child) throw new Error("Replay requires the actual spawned wrapper");
          fault.replayPid = child.pid;
          fault.replayRemaining = 2;
          fault.mode = "transient-state";
          throw persistenceFailure;
        }
      }
      await actualIo.rename(source, target);
    });
    pending = registry.submitShud(h.request, execution.start);
    const outcome: unknown = await pending.then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBe(persistenceFailure);
    expect(fault.groupReads).toBeGreaterThanOrEqual(3);
    expect(fault.replayRemaining).toBe(0);
    expect(execution.registration.cancellations).toEqual(["SHUD submission rolled back"]);
    expect(registry.list()).toEqual([]);
    expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
    expect(await io.readdir(join(h.cwd, "runs"))).toEqual([]);
  } finally {
    fault.mode = "";
    await stopObservedChildren();
    await pending?.catch(() => undefined);
    await stopObservedChildren();
    // Release independently after process quiescence, including the pre-fix abort-rejection case.
    execution.registration.finish();
    await h.dispose();
  }
}, 15000);

test("indeterminate group cleanup retains the run and both failure causes instead of claiming rollback", async () => {
  const h = await submissionFixture();
  const execution = detachedProducer();
  const persistenceFailure = new Error("injected running persistence failure");
  let pending: Promise<RunJob> | undefined;
  let running: RunJob | undefined;
  try {
    await installFakeShud(h.shudBin, 0, "held");
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (typeof target === "string" && target.endsWith("/run-job.json")) {
        const candidate = RunJobSchema.parse(JSON.parse(await io.readFile(source, "utf8")));
        if (candidate.status === "running") {
          running = candidate;
          fault.mode = "group";
          throw persistenceFailure;
        }
      }
      await actualIo.rename(source, target);
    });
    pending = registry.submitShud(h.request, execution.start);
    const failure: unknown = await pending.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError) || !running)
      throw new Error("Expected retained failed submission");
    expect(failure.message).toContain(running.run_dir);
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(persistenceFailure);
    const cleanup: unknown = failure.errors[1];
    expect(cleanup).toBeInstanceOf(Error);
    expect(cleanup instanceof Error ? cleanup.message : null).toContain(
      "Cannot inspect owned process group",
    );
    expect(failure.cause).toBe(cleanup);
    expect(registry.indexes.lookup(running.run_id)?.run_dir).toBe(running.run_dir);
    expect(registry.isSubmissionInFlight(running.run_id)).toBe(true);
    expect(registry.list()).toHaveLength(1);
    expect(execution.registration.cancellations).toEqual([]);
    const retained = RunJobSchema.parse(
      JSON.parse(await io.readFile(join(running.run_dir, "run-job.json"), "utf8")),
    );
    expect(retained.status).toBe("submitted");
    expect(retained.dsh_job_id).toBe(running.dsh_job_id);
    expect(retained.pid).toBeNull();
  } finally {
    fault.mode = "";
    await stopObservedChildren();
    await pending?.catch(() => undefined);
    await stopObservedChildren();
    // The memoized abort rejection is the tested outcome, not a successful cleanup receipt.
    // Independently prove quiescence before releasing the real registration resource.
    execution.registration.finish();
    await h.dispose();
  }
}, 15000);

test("automatic disposal retains state ownership while an accepted running write is held", async () => {
  const h = await submissionFixture();
  const contender = await createHarness();
  const execution = detachedProducer();
  const entered = barrier();
  const release = barrier();
  let pending: Promise<RunJob> | undefined;
  let disposing: Promise<void> | undefined;
  try {
    await installFakeShud(h.shudBin, 0, "held");
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (typeof target === "string" && target.endsWith("/run-job.json")) {
        const candidate = RunJobSchema.parse(JSON.parse(await io.readFile(source, "utf8")));
        if (candidate.status === "running") {
          entered.release();
          await release.waiting;
        }
      }
      await actualIo.rename(source, target);
    });
    pending = registry.submitShud(h.request, execution.start);
    await Promise.race([
      entered.waiting,
      pending.then(() => {
        throw new Error("Submission bypassed the running write barrier");
      }),
    ]);
    disposing = Promise.resolve(h.ctx.fiber.dispose());
    await expect
      .poll(async () => {
        try {
          await registry.submitShud(
            { ...h.request, project: "../admission-probe" },
            execution.start,
          );
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return "unexpected acceptance";
      })
      .toContain("admission is closed");
    const refused: unknown = await contender.apply(ShudJobRegistry, h.config).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect(refused instanceof Error ? refused.message : null).toContain(h.stateDir);
    expect(await io.readdir(h.stateDir)).toContain("lock");
    release.release();
    const record = await pending;
    expect(record.status).toBe("running");
    await disposing;
    expect(await io.readdir(h.stateDir)).not.toContain("lock");
    await contender.apply(ShudJobRegistry, h.config);
    expect(actualRegistry(contender.ctx).indexes.lookup(record.run_id)?.run_dir).toBe(
      record.run_dir,
    );
  } finally {
    release.release();
    await stopObservedChildren();
    await pending?.catch(() => undefined);
    await stopObservedChildren();
    await cleanupResources([
      async () => {
        await disposing;
      },
      () => execution.cleanup(),
      () => contender.dispose(),
      () => h.dispose(),
    ]);
  }
}, 15000);

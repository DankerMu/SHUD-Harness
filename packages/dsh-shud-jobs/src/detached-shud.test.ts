import { mkdirSync } from "node:fs";
import { readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeChild from "node:child_process";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { actualRegistry, submissionFixture } from "./submit-shud/test-harness.ts";
import { waitForRecovery } from "./reconcile-shud/test-harness.ts";
import {
  activeGroup,
  cleanupResources,
  createWrapperHost,
  detachedProducer,
  installFakeShud,
  observedStart,
  readInvocation,
  releaseInvocation,
  terminateGroup,
  type Invocation,
  type WrapperHost,
} from "./detached-shud/test-harness.ts";

interface SpawnReceipt {
  pid: number;
  exited: Promise<void>;
  observed?: string;
  inspectionError?: unknown;
}

const spawned = vi.hoisted(() => ({ children: [] as SpawnReceipt[] }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChild>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[], options: NodeChild.SpawnOptions) {
      const child = actual.spawn(command, args, options);
      if (child.pid !== undefined) {
        const receipt: SpawnReceipt = {
          pid: child.pid,
          exited: new Promise<void>((resolve) => child.once("exit", () => resolve())),
        };
        spawned.children.push(receipt);
        // Observe synchronously before returning the real child, while even an exited child is unreaped.
        try {
          receipt.observed = observedStart(child.pid);
        } catch (error) {
          receipt.inspectionError = error;
        }
      }
      return child;
    },
  };
});
beforeEach(() => {
  spawned.children = [];
});

async function stopObservedChildren(): Promise<void> {
  for (const child of spawned.children) await terminateGroup(child.pid);
  await Promise.all(spawned.children.map((child) => child.exited));
}

async function textIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function ready(runDir: string): Promise<Invocation> {
  await expect.poll(() => readInvocation(runDir), { timeout: 5000 }).not.toBeNull();
  const invocation = await readInvocation(runDir);
  if (!invocation) throw new Error("Fake-SHUD readiness receipt disappeared");
  return invocation;
}

test.each([0, 13])(
  "immediate exit %s publishes real wrapper identity and atomic exit evidence",
  async (code) => {
    const h = await submissionFixture();
    const execution = detachedProducer();
    let pending: Promise<RunJob> | undefined;
    try {
      await installFakeShud(h.shudBin, code);
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      pending = registry.submitShud(h.request, execution.start);
      const record = await pending;
      expect(RunJobSchema.parse(record)).toEqual(record);
      expect(record.status).toBe("running");
      expect(record.pid).toBeGreaterThan(1);
      const identity = await execution.starts[0];
      expect(record.pid).toBe(identity.pid);
      const receipt = spawned.children.find((child) => child.pid === identity.pid);
      expect(receipt?.inspectionError).toBeUndefined();
      expect(receipt?.observed).toBeTypeOf("string");
      expect(record.pid_started_at).toBe(receipt?.observed);
      expect(identity.pid_started_at).toBe(receipt?.observed);
      expect(record.started_at).toBe(receipt?.observed);
      expect(registry.isSubmissionInFlight(record.run_id)).toBe(false);
      await expect
        .poll(() => textIfPresent(join(record.run_dir, "exit_code")), { timeout: 5000 })
        .toBe(`${code}\n`);
      await waitForRecovery(async () => {
        await registry.pollOnce();
        const settled = RunJobSchema.parse(
          JSON.parse(await readFile(join(record.run_dir, "run-job.json"), "utf8")),
        );
        return (
          settled.status === "succeeded" ||
          settled.status === "failed" ||
          settled.status === "cancelled" ||
          settled.status === "collected"
        );
      }, "immediate native exit durable terminal publication before collection");
      expect(await registry.collectShud(record.run_id)).toMatchObject({ exit_code: code });
      const terminal = RunJobSchema.parse(
        JSON.parse(await readFile(join(record.run_dir, "run-job.json"), "utf8")),
      );
      expect(terminal.finished_at).not.toBeNull();
      expect(terminal).toEqual({
        ...record,
        status: "collected",
        exit_code: code,
        finished_at: terminal.finished_at,
      });
      expect(Number(await readFile(join(record.run_dir, "wrapper.pid"), "utf8"))).toBe(record.pid);
      const invocation = await ready(record.run_dir);
      expect(invocation.ppid).toBe(record.pid);
      expect(invocation.argv).toEqual(["-o", "output/tiny.out", "tiny"]);
      expect(invocation.cwd).toBe(record.run_dir);
      expect(await readFile(join(record.run_dir, "stdout.log"), "utf8")).toBe("fake stdout\n");
      expect(await readFile(join(record.run_dir, "stderr.log"), "utf8")).toBe("fake stderr\n");
      expect((await readdir(record.run_dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      // Exit evidence is consumed by the registry poll path, not classified by child exit events.
      await expect
        .poll(() => registry.get(execution.registration.handles[0].id).status)
        .toBe(code === 0 ? "completed" : "failed");
      expect(execution.registration.cancellations).toEqual([]);
    } finally {
      await stopObservedChildren();
      await pending?.catch(() => undefined);
      await stopObservedChildren();
      await cleanupResources([() => execution.cleanup(), () => h.dispose()]);
    }
  },
  15000,
);

test("two concurrent submissions return running while both independent wrapper groups are held", async () => {
  const h = await submissionFixture();
  const first = detachedProducer();
  const second = detachedProducer();
  const submissions: Promise<RunJob>[] = [];
  try {
    await installFakeShud(h.shudBin, 0, "held");
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    submissions.push(
      registry.submitShud(h.request, first.start),
      registry.submitShud(h.request, second.start),
    );
    const pending = Promise.all(submissions);
    const records = await pending;
    const invocations = await Promise.all(records.map((record) => ready(record.run_dir)));
    expect(records[0].pid).not.toBe(records[1].pid);
    expect(records[0].run_dir).not.toBe(records[1].run_dir);
    expect(registry.indexes.read().active).toHaveLength(2);
    for (const [index, record] of records.entries()) {
      expect(record.status).toBe("running");
      if (record.pid === null) throw new Error("Running record has no wrapper pid");
      expect(activeGroup(record.pid)).toContain(record.pid);
      expect(activeGroup(record.pid)).toContain(invocations[index].pid);
      expect(record.pid_started_at).toBe(observedStart(record.pid));
      expect(registry.isSubmissionInFlight(record.run_id)).toBe(false);
      expect(await textIfPresent(join(record.run_dir, "exit_code"))).toBeNull();
    }
    await Promise.all(invocations.map((invocation) => releaseInvocation(invocation)));
    for (const record of records) {
      await expect
        .poll(() => textIfPresent(join(record.run_dir, "exit_code")), { timeout: 5000 })
        .toBe("0\n");
    }
  } finally {
    await stopObservedChildren();
    await Promise.allSettled(submissions);
    await stopObservedChildren();
    await cleanupResources([() => first.cleanup(), () => second.cleanup(), () => h.dispose()]);
  }
}, 15000);

test("configured binary and project metacharacters remain literal positional arguments", async () => {
  const h = await submissionFixture();
  const execution = detachedProducer();
  const binary = join(h.root, "solver '; touch BINARY_INJECTION; #");
  const project = "tiny; touch PROJECT_INJECTION";
  let pending: Promise<RunJob> | undefined;
  try {
    await rename(join(h.inputDir, "tiny.cfg.para"), join(h.inputDir, `${project}.cfg.para`));
    await installFakeShud(binary, 0);
    await h.apply(ShudJobRegistry, { ...h.config, shudBin: binary });
    pending = actualRegistry(h.ctx).submitShud({ ...h.request, project }, execution.start);
    const record = await pending;
    await expect
      .poll(() => textIfPresent(join(record.run_dir, "exit_code")), { timeout: 5000 })
      .toBe("0\n");
    const invocation = await ready(record.run_dir);
    expect(record.command).toEqual([binary, "-o", `output/${project}.out`, project]);
    expect(invocation.argv).toEqual(["-o", `output/${project}.out`, project]);
    expect(invocation.cwd).toBe(record.run_dir);
    expect(await textIfPresent(join(record.run_dir, "BINARY_INJECTION"))).toBeNull();
    expect(await textIfPresent(join(record.run_dir, "PROJECT_INJECTION"))).toBeNull();
  } finally {
    await stopObservedChildren();
    await pending?.catch(() => undefined);
    await stopObservedChildren();
    await cleanupResources([() => execution.cleanup(), () => h.dispose()]);
  }
}, 15000);

test.each(["temporary creation", "rename"])(
  "PID publication %s failure never invokes the model or publishes exit_code",
  async (phase) => {
    const h = await submissionFixture();
    const execution = detachedProducer();
    let runDir = "";
    let pending: Promise<unknown> | undefined;
    try {
      await installFakeShud(h.shudBin, 0);
      await h.apply(ShudJobRegistry, h.config);
      pending = actualRegistry(h.ctx)
        .submitShud(h.request, (record, handle, pumpPollMs) => {
          runDir = record.run_dir;
          if (phase === "temporary creation") mkdirSync(join(runDir, "wrapper.pid.tmp"));
          else {
            // mv into an existing directory must also fail, rather than silently moving the temp inside it.
            mkdirSync(join(runDir, "wrapper.pid", "wrapper.pid.tmp"), { recursive: true });
          }
          return execution.start(record, handle, pumpPollMs);
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      const outcome = await pending;
      if (execution.starts.length === 0 && outcome !== null) {
        throw outcome instanceof Error
          ? outcome
          : new Error("Detached submission failed before startup", { cause: outcome });
      }
      expect(execution.starts).toHaveLength(1);
      const identity = await execution.starts[0];
      await expect.poll(() => activeGroup(identity.pid), { timeout: 5000 }).toEqual([]);
      expect(await readInvocation(runDir)).toBeNull();
      expect(await textIfPresent(join(runDir, "exit_code"))).toBeNull();
    } finally {
      await stopObservedChildren();
      await pending;
      await stopObservedChildren();
      await cleanupResources([() => execution.cleanup(), () => h.dispose()]);
    }
  },
  15000,
);

test("a wrapper survives actual host SIGKILL and publishes exit_code after its barrier is released", async () => {
  const h = await submissionFixture();
  let host: WrapperHost | undefined;
  let wrapperPid: number | undefined;
  try {
    await installFakeShud(h.shudBin, 13, "held");
    host = await createWrapperHost(h.config, h.request);
    const record = host.record;
    expect(record.status).toBe("running");
    if (record.pid === null) throw new Error("Host did not publish a wrapper pid");
    wrapperPid = record.pid;
    const invocation = await ready(record.run_dir);
    expect(activeGroup(wrapperPid)).toContain(invocation.pid);
    await host.kill();
    expect(activeGroup(wrapperPid)).toContain(wrapperPid);
    expect(activeGroup(wrapperPid)).toContain(invocation.pid);
    expect(await textIfPresent(join(record.run_dir, "exit_code"))).toBeNull();
    await releaseInvocation(invocation);
    await expect
      .poll(() => textIfPresent(join(record.run_dir, "exit_code")), { timeout: 5000 })
      .toBe("13\n");
    expect(Number(await readFile(join(record.run_dir, "wrapper.pid"), "utf8"))).toBe(wrapperPid);
    expect((await readdir(record.run_dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await expect.poll(() => activeGroup(wrapperPid ?? 0), { timeout: 5000 }).toEqual([]);
  } finally {
    await host?.stop();
    if (wrapperPid !== undefined) await terminateGroup(wrapperPid);
    await h.dispose();
  }
}, 15000);

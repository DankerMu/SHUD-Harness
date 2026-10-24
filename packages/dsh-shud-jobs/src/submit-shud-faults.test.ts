import * as io from "node:fs/promises";
import { basename, join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeIo from "node:fs/promises";
import type * as NodeFs from "node:fs";
import type { JobOutcome } from "@deepseek-ai/dsh-jobs";
import { RunIdSchema, RunJobSchema } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { createHarness, producer as ordinaryProducer } from "./test-harness.ts";
import { barrier } from "./state-indexes/test-harness.ts";
import {
  actualRegistry,
  submissionFixture,
  submissionProducer,
} from "./submit-shud/test-harness.ts";

const fault = vi.hoisted(() => ({ verificationPath: "" }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    lstatSync(path: NodeFs.PathLike, options?: NodeFs.StatOptions) {
      if (path === fault.verificationPath) {
        fault.verificationPath = "";
        throw new Error("injected post-mkdir verification failure");
      }
      return actual.lstatSync(path, options);
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return {
    ...actual,
    copyFile: vi.fn(actual.copyFile),
    rename: vi.fn(actual.rename),
    mkdir: vi.fn(actual.mkdir),
    rm: vi.fn(actual.rm),
  };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  fault.verificationPath = "";
  vi.mocked(io.copyFile).mockReset().mockImplementation(actualIo.copyFile);
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
  vi.mocked(io.mkdir).mockReset().mockImplementation(actualIo.mkdir);
  vi.mocked(io.rm).mockReset().mockImplementation(actualIo.rm);
});

function containing(fragment: string): unknown {
  return expect.stringContaining(fragment);
}

test("record/index/registration order is durable and the in-flight guard precedes created persistence", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  try {
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    const observed: string[] = [];
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      await actualIo.rename(source, target);
      if (typeof target === "string" && target.endsWith("/run-job.json")) {
        const record = RunJobSchema.parse(JSON.parse(await io.readFile(target, "utf8")));
        expect(registry.isSubmissionInFlight(record.run_id)).toBe(true);
        observed.push(
          record.status === "running"
            ? "running"
            : record.dsh_job_id === null
              ? record.status
              : "identified",
        );
        const active: unknown = JSON.parse(
          await io.readFile(join(h.stateDir, "active.json"), "utf8"),
        );
        expect(active).toEqual(
          record.status === "created"
            ? []
            : [{ run_id: record.run_id, job_id: record.job_id, run_dir: record.run_dir }],
        );
      } else if (target === join(h.stateDir, "active.json")) observed.push("active");
    });
    const record = await registry.submitShud(h.request, (prepared, handle, pumpPollMs) => {
      observed.push("registered");
      return execution.start(prepared, handle, pumpPollMs);
    });
    expect(observed).toEqual([
      "created",
      "active",
      "submitted",
      "registered",
      "identified",
      "running",
    ]);
    expect(registry.isSubmissionInFlight(record.run_id)).toBe(false);
  } finally {
    await execution.finish();
    await h.dispose();
  }
});

test.each(["copy", "created", "active", "submitted", "identified", "producer"])(
  "%s failure rolls back owned state and never leaves a controller",
  async (phase) => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    let failedRun: string | undefined;
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      if (phase === "copy") {
        vi.mocked(io.copyFile).mockImplementation(async (source, target, flags) => {
          if (String(source).endsWith("nested/forcing.dat"))
            throw new Error("injected copy denial");
          await actualIo.copyFile(source, target, flags);
        });
      }
      let recordWrites = 0;
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (typeof target === "string" && target.endsWith("/run-job.json")) {
          recordWrites += 1;
          const record = RunJobSchema.parse(JSON.parse(await io.readFile(source, "utf8")));
          failedRun = record.run_id;
          if (
            (phase === "created" && recordWrites === 1) ||
            (phase === "submitted" && recordWrites === 2) ||
            (phase === "identified" && recordWrites === 3)
          ) {
            throw new Error(`injected ${phase} failure`);
          }
        }
        if (phase === "active" && target === join(h.stateDir, "active.json"))
          throw new Error("injected active failure");
        await actualIo.rename(source, target);
      });
      await expect(
        registry.submitShud(h.request, (prepared, handle, pumpPollMs) => {
          if (phase === "producer") throw new Error("injected producer failure");
          return execution.start(prepared, handle, pumpPollMs);
        }),
      ).rejects.toThrow(phase === "copy" ? "nested/forcing.dat" : `injected ${phase}`);
      expect(await io.readdir(join(h.cwd, "runs"))).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(registry.list()).toEqual([]);
      if (failedRun)
        expect(registry.isSubmissionInFlight(RunIdSchema.parse(failedRun))).toBe(false);
      if (phase === "identified")
        expect(execution.cancellations).toContain("SHUD submission rolled back");
      expect(() => registry.start(ordinaryProducer(h.ownerId).spec)).toThrow(
        "no job controller serves this agent",
      );
      for (const [name, bytes] of Object.entries(h.originals))
        expect(await io.readFile(join(h.inputDir, name))).toEqual(bytes);
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
);

test("a post-mkdir verification error removes only the directory this transaction created", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  try {
    await h.apply(ShudJobRegistry, h.config);
    vi.mocked(io.mkdir).mockImplementation(async (...args) => {
      const result = await actualIo.mkdir(...args);
      if (typeof args[0] === "string" && basename(args[0]).startsWith("RUN-"))
        fault.verificationPath = args[0];
      return result;
    });
    const registry = actualRegistry(h.ctx);
    await expect(registry.submitShud(h.request, execution.start)).rejects.toThrow(
      "post-mkdir verification",
    );
    expect(await io.readdir(join(h.cwd, "runs"))).toEqual([]);
    expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
    expect(execution.handles).toEqual([]);
  } finally {
    await execution.finish();
    await h.dispose();
  }
});

test("a foreign replacement after mkdir is preserved, with retained-path cleanup evidence", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  let replacement = "";
  try {
    await h.apply(ShudJobRegistry, h.config);
    vi.mocked(io.copyFile).mockImplementationOnce(async (source, target, flags) => {
      await actualIo.copyFile(source, target, flags);
      const runs = await io.readdir(join(h.cwd, "runs"));
      replacement = join(h.cwd, "runs", runs[0]);
      await actualIo.rename(replacement, join(h.root, "original-owned-directory"));
      await actualIo.mkdir(replacement);
      await io.writeFile(join(replacement, "foreign-sentinel"), "foreign bytes");
      throw new Error("injected failure after foreign replacement");
    });
    const registry = actualRegistry(h.ctx);
    await expect(registry.submitShud(h.request, execution.start)).rejects.toMatchObject({
      message: containing("retained run path"),
      errors: [
        { message: containing("Cannot copy input entry") },
        { message: containing("ownership changed") },
      ],
    });
    expect(await io.readdir(replacement)).toEqual(["foreign-sentinel"]);
    expect(await io.readFile(join(replacement, "foreign-sentinel"), "utf8")).toBe("foreign bytes");
    expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
  } finally {
    await execution.finish();
    await h.dispose();
  }
});

test("late record failure awaits producer resource settlement before removing parent registration or files", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  const cancelled = barrier();
  const release = barrier();
  try {
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    let writes = 0;
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (typeof target === "string" && target.endsWith("/run-job.json") && ++writes === 3)
        throw new Error("late id persistence failed");
      await actualIo.rename(source, target);
    });
    const submission = registry.submitShud(h.request, (record, handle, pumpPollMs) => {
      const started = execution.start(record, handle, pumpPollMs);
      return {
        ...started,
        hooks: {
          done: release.waiting.then(() => started.hooks.done),
          settle: (outcome: JobOutcome) => started.hooks.settle(outcome),
          detach: (detail: string) => started.hooks.detach(detail),
          cancel(reason) {
            cancelled.release();
            void release.waiting.then(() => started.hooks.cancel(reason));
          },
        },
      };
    });
    const outcome = submission.then(
      () => null,
      (error: unknown) => error,
    );
    const first = await Promise.race([
      cancelled.waiting.then(() => ({ kind: "cancel" as const })),
      outcome.then((error) => ({ kind: "outcome" as const, error })),
    ]);
    if (first.kind === "outcome") {
      throw new Error("Submission settled before the cancellation barrier", { cause: first.error });
    }
    const prepared = execution.prepared[0];
    expect(await io.readFile(join(prepared.run_dir, "stdout.log"), "utf8")).toBe("");
    expect(registry.list().map((job) => job.id)).toContain(execution.handles[0].id);
    expect(registry.indexes.lookup(prepared.run_id)).toBeDefined();
    release.release();
    expect(await outcome).toMatchObject({ message: "late id persistence failed" });
    expect(registry.list()).toEqual([]);
    expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
    expect(await io.readdir(join(h.cwd, "runs"))).toEqual([]);
  } finally {
    release.release();
    await execution.finish();
    await h.dispose();
  }
});

test("cleanup failure retains both original cause and undeleted path evidence", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  try {
    await h.apply(ShudJobRegistry, h.config);
    vi.mocked(io.rm).mockImplementation(async (path, options) => {
      if (typeof path === "string" && basename(path).startsWith("RUN-"))
        throw new Error("cleanup denied");
      await actualIo.rm(path, options);
    });
    const registry = actualRegistry(h.ctx);
    await expect(
      registry.submitShud(h.request, () => {
        throw new Error("producer refused start");
      }),
    ).rejects.toMatchObject({
      message: containing("retained run path"),
      errors: [{ message: "producer refused start" }, { message: "cleanup denied" }],
    });
    expect(await io.readdir(join(h.cwd, "runs"))).toHaveLength(1);
    expect(registry.list()).toEqual([]);
    expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
  } finally {
    vi.mocked(io.rm).mockImplementation(actualIo.rm);
    await execution.finish();
    await h.dispose();
  }
});

test("automatic root disposal drains a held submission rollback before unlocking indexes", async () => {
  const h = await submissionFixture();
  const contender = await createHarness();
  const execution = submissionProducer();
  const entered = barrier();
  const release = barrier();
  let pending: Promise<unknown> | undefined;
  let disposing: Promise<void> | undefined;
  try {
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    vi.mocked(io.copyFile).mockImplementationOnce(async (...args) => {
      entered.release();
      await release.waiting;
      await actualIo.copyFile(...args);
    });
    pending = registry.submitShud(h.request, execution.start).then(
      () => null,
      (error: unknown) => error,
    );
    await entered.waiting;
    disposing = Promise.resolve(h.ctx.fiber.dispose());
    // Probe admission through a request that cannot reach mkdir, even before the effect is invoked.
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
    await expect(registry.submitShud(h.request, execution.start)).rejects.toThrow("closed");
    const contenderError: unknown = await contender.apply(ShudJobRegistry, h.config).then(
      () => null,
      (error: unknown) => error,
    );
    expect(contenderError).toBeInstanceOf(Error);
    expect(contenderError instanceof Error ? contenderError.message : null).toContain(h.stateDir);
    expect(await io.readdir(h.stateDir)).toContain("lock");
    release.release();
    expect(await pending).toBeInstanceOf(Error);
    await disposing;
    expect(await io.readdir(join(h.cwd, "runs"))).toEqual([]);
    expect(await io.readdir(h.stateDir)).not.toContain("lock");
    await contender.apply(ShudJobRegistry, h.config);
    expect(actualRegistry(contender.ctx).indexes.read()).toEqual({ active: [], completed: [] });
  } finally {
    release.release();
    await pending;
    await execution.finish();
    await disposing;
    await contender.dispose();
    await h.dispose();
  }
}, 15000);

test("producer cancellation failure preserves original failure and retains files that may still be in use", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  try {
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    let writes = 0;
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (typeof target === "string" && target.endsWith("/run-job.json") && ++writes === 3) {
        throw new Error("identified record persistence failed");
      }
      await actualIo.rename(source, target);
    });
    let refused = false;
    await expect(
      registry.submitShud(h.request, (record, handle, pumpPollMs) => {
        const started = execution.start(record, handle, pumpPollMs);
        return {
          ...started,
          hooks: {
            done: started.hooks.done,
            settle: (outcome: JobOutcome) => started.hooks.settle(outcome),
            detach: (detail: string) => started.hooks.detach(detail),
            cancel(reason) {
              if (!refused) {
                refused = true;
                throw new Error("producer could not release its resource");
              }
              started.hooks.cancel(reason);
            },
          },
        };
      }),
    ).rejects.toMatchObject({
      message: containing("retained run path"),
      errors: [
        { message: "identified record persistence failed" },
        { message: "producer could not release its resource" },
      ],
    });
    const prepared = execution.prepared[0];
    expect(registry.indexes.lookup(prepared.run_id)?.run_dir).toBe(prepared.run_dir);
    expect(await io.readFile(join(prepared.run_dir, "stdout.log"), "utf8")).toBe("");
    execution.append("resource remains live\n");
    expect(await io.readFile(join(prepared.run_dir, "stdout.log"), "utf8")).toBe(
      "resource remains live\n",
    );
  } finally {
    await execution.finish();
    await h.dispose();
  }
});

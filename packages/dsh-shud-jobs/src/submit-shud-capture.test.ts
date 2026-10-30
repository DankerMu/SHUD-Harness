import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeIo from "node:fs/promises";
import {
  DataProvenanceSchema,
  StackLockSchema,
  TaskIdSchema,
  RunJobSchema,
  RunRecordSchema,
  type RunJob,
} from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry, type SubmitShudRequest } from "./index.ts";
import {
  actualRegistry,
  submissionFixture,
  submissionProducer,
} from "./submit-shud/test-harness.ts";
import { installFakeShud } from "./detached-shud/test-harness.ts";
import { releaseRun, settlingProducer } from "./poll-shud/test-harness.ts";
import { waitForRecovery } from "./reconcile-shud/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    mkdir: vi.fn(actual.mkdir),
    copyFile: vi.fn(actual.copyFile),
  };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
  vi.mocked(io.mkdir).mockReset().mockImplementation(actualIo.mkdir);
  vi.mocked(io.copyFile).mockReset().mockImplementation(actualIo.copyFile);
});

const taskId = TaskIdSchema.parse("TASK-20261029T031500-a1b2");

test.each([false, true])(
  "first created publication already binds durable copied-input lineage; task=%s",
  async (withTask) => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    const observed: RunJob[] = [];
    try {
      if (withTask) {
        await io.mkdir(join(h.root, "include", "sundials"), { recursive: true });
        await io.writeFile(
          join(h.root, "include", "sundials", "sundials_config.h"),
          '#define SUNDIALS_VERSION "7.2.1"\n',
        );
      }
      await h.apply(ShudJobRegistry, {
        ...h.config,
        ...(withTask ? { sundialsRoot: h.root } : {}),
      });
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (String(target).endsWith("/run-job.json")) {
          const record = RunJobSchema.parse(JSON.parse(await io.readFile(source, "utf8")));
          if (record.status === "created") {
            expect(record.task_id).toBe(withTask ? taskId : null);
            expect(record.stack_id).toMatch(/^STACK-\d{8}T\d{6}-[0-9a-f]{4}$/u);
            expect(record.data_id).toMatch(/^DATA-\d{8}T\d{6}-[0-9a-f]{4}$/u);
            const lock = StackLockSchema.parse(
              JSON.parse(
                await io.readFile(join(h.cwd, "stacks", `${record.stack_id}.json`), "utf8"),
              ),
            );
            const data = DataProvenanceSchema.parse(
              JSON.parse(
                await io.readFile(join(h.cwd, "provenance", `${record.data_id}.json`), "utf8"),
              ),
            );
            expect(lock.stack_id).toBe(record.stack_id);
            expect(lock.llm).toEqual({
              ...h.config.llm,
              response_model: h.request.llm.response_model,
            });
            expect(lock.runtime).toMatchObject({
              host_version: h.config.hostVersion,
              sundials_version: withTask ? "7.2.1" : null,
            });
            expect(data.data_id).toBe(record.data_id);
            expect(data.sources.input_root).toBe(await io.realpath(h.inputDir));
            expect(data.basin).toBe("tiny");
            expect(data.event_window).toEqual({ start: null, end: null });
            const bytes = {
              "binary.dat": Buffer.from([0, 255, 1, 128, 10]),
              "nested/forcing.dat": Buffer.from("original forcing bytes\n"),
              "tiny.cfg.para": Buffer.from(
                "# synthetic input\r\nSTART\t0\r\nEND\t30\r\nOTHER\t17\r\n",
              ),
            };
            expect(data.sources.files).toEqual(
              Object.entries(bytes).map(([path, content]) => ({
                path,
                size_bytes: content.length,
                sha256: createHash("sha256").update(content).digest("hex"),
              })),
            );
            for (const [name, path] of Object.entries(h.config.stackRepos)) {
              expect(lock.repos[name as keyof typeof lock.repos]).toMatchObject({
                commit: execFileSync("git", ["rev-parse", "HEAD"], {
                  cwd: path,
                  encoding: "utf8",
                }).trim(),
                dirty: false,
              });
            }
            expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
            observed.push(record);
          }
        }
        await actualIo.rename(source, target);
      });
      const request = { ...h.request, end_days: 30, ...(withTask ? { task_id: taskId } : {}) };
      const job = await registry.submitShud(request, execution.start);
      expect(observed).toHaveLength(1);
      expect(job).toMatchObject({
        task_id: observed[0].task_id,
        stack_id: observed[0].stack_id,
        data_id: observed[0].data_id,
      });
      for (const [name, original] of Object.entries(h.originals))
        expect(await io.readFile(join(h.inputDir, name))).toEqual(original);
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
);

test("repeated submissions reuse immutable lock bytes and mtime but allocate separate provenance", async () => {
  const h = await submissionFixture();
  const first = submissionProducer();
  const second = submissionProducer();
  try {
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    const a = await registry.submitShud(h.request, first.start);
    const lockPath = join(h.cwd, "stacks", `${a.stack_id}.json`);
    const bytes = await io.readFile(lockPath);
    const before = await io.stat(lockPath, { bigint: true });
    const b = await registry.submitShud(h.request, second.start);
    expect(b.stack_id).toBe(a.stack_id);
    expect(b.data_id).not.toBe(a.data_id);
    expect(await io.readFile(lockPath)).toEqual(bytes);
    const after = await io.stat(lockPath, { bigint: true });
    expect({ ino: after.ino, mtimeNs: after.mtimeNs }).toEqual({
      ino: before.ino,
      mtimeNs: before.mtimeNs,
    });
    expect(await io.readdir(join(h.cwd, "stacks"))).toEqual([`${a.stack_id}.json`]);
    expect((await io.readdir(join(h.cwd, "provenance"))).sort()).toEqual(
      [`${a.data_id}.json`, `${b.data_id}.json`].sort(),
    );
    const inventories = await Promise.all(
      [a, b].map(
        async (record) =>
          DataProvenanceSchema.parse(
            JSON.parse(
              await io.readFile(join(h.cwd, "provenance", `${record.data_id}.json`), "utf8"),
            ),
          ).sources,
      ),
    );
    expect(inventories[1]).toEqual(inventories[0]);
  } finally {
    await first.finish();
    await second.finish();
    await h.dispose();
  }
});

test.each([null, "", "TASK-invalid", "RUN-20261029T031500-a1b2", 7, {}])(
  "invalid explicit task_id %j rejects before any submission effects",
  async (task_id) => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    try {
      await h.apply(ShudJobRegistry, h.config);
      vi.mocked(io.mkdir).mockClear();
      vi.mocked(io.copyFile).mockClear();
      const request = { ...h.request, task_id } as unknown as SubmitShudRequest;
      await expect(actualRegistry(h.ctx).submitShud(request, execution.start)).rejects.toThrow(
        /task_id/u,
      );
      expect(io.mkdir).not.toHaveBeenCalled();
      expect(io.copyFile).not.toHaveBeenCalled();
      expect(await io.readdir(h.cwd)).toEqual([]);
      expect(actualRegistry(h.ctx).indexes.read()).toEqual({ active: [], completed: [] });
      expect(execution.handles).toEqual([]);
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
);

test.each([false, true])(
  "actual terminal collector inherits submission ids; task=%s",
  async (withTask) => {
    const h = await submissionFixture();
    const execution = settlingProducer();
    try {
      await installFakeShud(h.shudBin, 0, "held");
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      const request = { ...h.request, ...(withTask ? { task_id: taskId } : {}) };
      const job = await registry.submitShud(request, execution.start);
      expect(job.task_id).toBe(withTask ? taskId : null);
      expect(job.stack_id).toMatch(/^STACK-/u);
      expect(job.data_id).toMatch(/^DATA-/u);
      await releaseRun(job);
      await waitForRecovery(async () => {
        await registry.pollOnce();
        return execution.completed.length === 1;
      }, "capture submission completion");
      const result = await registry.collectShud(job.run_id);
      expect(RunRecordSchema.parse(result)).toEqual(result);
      expect(result).toMatchObject({
        task_id: job.task_id,
        stack_id: job.stack_id,
        data_id: job.data_id,
        status: "succeeded",
      });
      expect(await registry.collectShud(job.job_id)).toEqual(result);
    } finally {
      await execution.cleanup();
      await h.dispose();
    }
  },
  15000,
);

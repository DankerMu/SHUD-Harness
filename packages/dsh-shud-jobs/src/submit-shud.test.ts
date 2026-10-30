import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { producer } from "./test-harness.ts";
import { activeGroup } from "./detached-shud/test-harness.ts";
import {
  actualRegistry,
  injectedRegistry,
  submissionFixture,
  submissionProducer,
} from "./submit-shud/test-harness.ts";

describe("SHUD execution transaction through the actual registry", () => {
  test("copies all input, patches only the copy and publishes a validated running record", async () => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      const record: RunJob = await registry.submitShud(
        { ...h.request, end_days: 30, label: "independent experiment" },
        execution.start,
      );
      const identity = await execution.executions[0].started;
      expect(RunJobSchema.parse(record)).toEqual(record);
      expect(record).toMatchObject({
        status: "running",
        backend: "local_job",
        project: "tiny",
        label: "independent experiment",
        input_dir: await realpath(h.inputDir),
        run_dir: join(await realpath(h.cwd), "runs", record.run_id),
        command: [h.shudBin, "-o", "output/tiny.out", "tiny"],
        end_days: 30,
        owner_session: h.ownerId,
        llm: h.request.llm,
        task_id: null,
        pid: identity.pid,
        pid_started_at: identity.pid_started_at,
        started_at: identity.pid_started_at,
        finished_at: null,
        cancel_requested_at: null,
        exit_code: null,
        notify: { status: "pending", attempts: 0, at: null, detail: null },
      });
      expect(record.stack_id).toMatch(/^STACK-\d{8}T\d{6}-[0-9a-f]{4}$/u);
      expect(record.data_id).toMatch(/^DATA-\d{8}T\d{6}-[0-9a-f]{4}$/u);
      expect(record.submitted_at).toEqual(expect.any(String));
      expect(record.dsh_job_id).toMatch(/^shud-[0-9a-f]{16}$/u);
      expect(record.dsh_job_ids).toEqual([record.dsh_job_id]);
      expect(record.input_bytes).toBe(
        Object.values(h.originals).reduce((sum, bytes) => sum + bytes.length, 0),
      );
      expect(JSON.parse(await readFile(join(record.run_dir, "run-job.json"), "utf8"))).toEqual(
        record,
      );
      expect(registry.indexes.read()).toEqual({
        active: [{ run_id: record.run_id, job_id: record.job_id, run_dir: record.run_dir }],
        completed: [],
      });
      expect(execution.handles).toHaveLength(1);
      expect(execution.handles[0].id).toBe(record.dsh_job_id);
      expect(execution.prepared[0]).toMatchObject({
        status: "submitted",
        dsh_job_id: null,
        dsh_job_ids: [],
      });
      expect(execution.persistedAtStart[0]).toEqual(execution.prepared[0]);
      expect(record).toEqual({
        ...execution.prepared[0],
        status: "running",
        pid: identity.pid,
        pid_started_at: identity.pid_started_at,
        started_at: identity.pid_started_at,
        dsh_job_id: execution.handles[0].id,
        dsh_job_ids: [execution.handles[0].id],
      });
      for (const [name, original] of Object.entries(h.originals)) {
        expect(await readFile(join(h.inputDir, name))).toEqual(original);
        const expected =
          name === "tiny.cfg.para"
            ? Buffer.from("# synthetic input\r\nSTART\t0\r\nEND\t30\r\nOTHER\t17\r\n")
            : original;
        expect(await readFile(join(record.run_dir, "input", "tiny", name))).toEqual(expected);
      }
      expect(await readdir(join(record.run_dir, "input", "tiny", "nested", "empty"))).toEqual([]);
      await expect.poll(() => readdir(record.run_dir)).toContain("wrapper.pid");
      expect(Number(await readFile(join(record.run_dir, "wrapper.pid"), "utf8"))).toBe(record.pid);
      expect(registry.get(execution.handles[0].id)).toMatchObject({
        kind: "shud",
        label: `${record.run_id} independent experiment`,
      });
    } finally {
      await execution.finish();
      await h.dispose();
    }
  });

  test.each([
    ["END\t7\r\n", "END\t30\r\n"],
    ["end 7 # retain comment\n", "end 30 # retain comment\n"],
    ["\tEnD\t7\n", "\tEnD\t30\n"],
    [" END 999\n#END 123\n\nEND 7\n", " END 999\n#END 123\n\nEND 30\n"],
  ])(
    "updates effective END tokens without rewriting unrelated bytes: %j",
    async (parameter, expected) => {
      const h = await submissionFixture(parameter);
      const execution = submissionProducer();
      try {
        await h.apply(ShudJobRegistry, h.config);
        const record: RunJob = await actualRegistry(h.ctx).submitShud(
          { ...h.request, end_days: 30 },
          execution.start,
        );
        expect(await readFile(join(record.run_dir, "input", "tiny", "tiny.cfg.para"), "utf8")).toBe(
          expected,
        );
        expect(await readFile(join(h.inputDir, "tiny.cfg.para"), "utf8")).toBe(parameter);
        expect(record.input_bytes).toBe(
          Object.values(h.originals).reduce((sum, bytes) => sum + bytes.length, 0),
        );
      } finally {
        await execution.finish();
        await h.dispose();
      }
    },
  );

  test("a scoped caller submits with only preset controls, without leaving a global controller", async () => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    try {
      await h.apply(ShudJobRegistry, h.config);
      const controller = await h.attachController(true);
      const scoped = await injectedRegistry(h.presetCtx);
      const unrelated = await injectedRegistry(h.otherCtx);
      const record: RunJob = await scoped.submitShud(h.request, execution.start);
      const id = execution.handles[0].id;
      expect(scoped.list(h.ownerId).map((job) => job.id)).toContain(record.dsh_job_id);
      expect(scoped.get(id, h.ownerId).owner).toBeUndefined();
      execution.append("actual file output\n");
      await expect
        .poll(() =>
          scoped
            .readAt(id, 0, h.ownerId)
            .chunks.map((chunk) => chunk.text)
            .join(""),
        )
        .toBe("actual file output\n");
      expect(
        scoped
          .read(id, h.ownerId)
          .chunks.map((chunk) => chunk.text)
          .join(""),
      ).toBe("actual file output\n");
      expect(scoped.kill(id, h.ownerId, "test cancellation")).toBe("requested");
      const cancelled = RunJobSchema.parse(
        JSON.parse(await readFile(join(record.run_dir, "run-job.json"), "utf8")),
      );
      expect(cancelled.cancel_requested_at).toEqual(expect.any(String));
      const outcome = await scoped.wait(id, 1000, h.ownerId);
      expect(outcome.status).toBe("killed");
      expect(outcome.detail).toContain("test cancellation");
      expect(execution.cancellations).toEqual([]);
      if (record.pid === null) throw new Error("Submitted execution has no wrapper identity");
      expect(activeGroup(record.pid)).toEqual([]);
      await controller.dispose();
      expect(() => h.ctx.jobs.start(producer().spec)).toThrow(
        "no job controller serves this agent",
      );
      expect(() => unrelated.start(producer(h.otherId).spec)).toThrow(
        "no job controller serves this agent",
      );
    } finally {
      await execution.finish();
      await h.dispose();
    }
  });

  test("concurrent submissions get independent directories and retain both active entries", async () => {
    const h = await submissionFixture();
    const first = submissionProducer();
    const second = submissionProducer();
    const pending: Promise<RunJob>[] = [];
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      pending.push(
        registry.submitShud(h.request, first.start),
        registry.submitShud(h.request, second.start),
      );
      const records = await Promise.all(pending);
      expect(records[0].run_id).not.toBe(records[1].run_id);
      expect(records[0].job_id).not.toBe(records[1].job_id);
      expect(records[0].run_dir).not.toBe(records[1].run_dir);
      expect((await readdir(join(h.cwd, "runs"))).sort()).toEqual(
        records.map((record) => record.run_id).sort(),
      );
      expect(registry.indexes.read().active).toEqual(
        expect.arrayContaining(
          records.map((record) => ({
            run_id: record.run_id,
            job_id: record.job_id,
            run_dir: record.run_dir,
          })),
        ),
      );
      expect(registry.indexes.read().active).toHaveLength(2);
      expect(registry.list()).toHaveLength(2);
      for (const record of records) {
        expect(record.status).toBe("running");
        expect(await readFile(join(record.run_dir, "input", "tiny", "binary.dat"))).toEqual(
          h.originals["binary.dat"],
        );
      }
    } finally {
      await Promise.allSettled(pending);
      await first.finish();
      await second.finish();
      await h.dispose();
    }
  });

  test("parent unowned limit rejects the next submission and rolls back all its state", async () => {
    const h = await submissionFixture();
    const first = submissionProducer();
    const rejected = submissionProducer();
    try {
      await h.apply(ShudJobRegistry, { ...h.config, maxConcurrentJobsPerOwner: 1 });
      const registry = actualRegistry(h.ctx);
      const unrelated = await injectedRegistry(h.otherCtx);
      const record: RunJob = await registry.submitShud(h.request, first.start);
      await expect(registry.submitShud(h.request, rejected.start)).rejects.toThrow("limit: 1");
      expect(await readdir(join(h.cwd, "runs"))).toEqual([record.run_id]);
      expect(registry.indexes.read()).toEqual({
        active: [{ run_id: record.run_id, job_id: record.job_id, run_dir: record.run_dir }],
        completed: [],
      });
      expect(registry.list().map((job) => job.id)).toEqual([record.dsh_job_id]);
      expect(rejected.handles).toEqual([]);
      expect(() => unrelated.start(producer(h.otherId).spec)).toThrow(
        "no job controller serves this agent",
      );
    } finally {
      await first.finish();
      await rejected.finish();
      await h.dispose();
    }
  });

  test("job reads consume only incremental stdout file output", async () => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      await registry.submitShud(h.request, execution.start);
      const id = execution.handles[0].id;
      execution.append("first α\n");
      await expect
        .poll(() =>
          registry
            .readAt(id, 0)
            .chunks.map((chunk) => chunk.text)
            .join(""),
        )
        .toBe("first α\n");
      expect(
        registry
          .read(id)
          .chunks.map((chunk) => chunk.text)
          .join(""),
      ).toBe("first α\n");
      expect(registry.read(id).chunks).toEqual([]);
      execution.append("second β\n");
      await expect
        .poll(() =>
          registry
            .readAt(id, 0)
            .chunks.map((chunk) => chunk.text)
            .join(""),
        )
        .toBe("first α\nsecond β\n");
      expect(
        registry
          .read(id)
          .chunks.map((chunk) => chunk.text)
          .join(""),
      ).toBe("second β\n");
      expect(registry.read(id).chunks).toEqual([]);
    } finally {
      await execution.finish();
      await h.dispose();
    }
  });
});

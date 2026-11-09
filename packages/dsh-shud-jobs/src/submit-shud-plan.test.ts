import * as io from "node:fs/promises";
import { join } from "node:path";
import type * as NodeIo from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RunJobSchema, RunRecordSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import {
  actualRegistry,
  submissionFixture,
  submissionProducer,
} from "./submit-shud/test-harness.ts";
import { binaryBytes } from "./submit-shud-build/test-harness.ts";
import { settlingProducer } from "./poll-shud/test-harness.ts";
import { waitForRecovery } from "./reconcile-shud/test-harness.ts";
import { ccwPlanFixture, PLAN_ID, sha256, submittedFile } from "./submit-shud-plan/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const latin1 = (text: string) => Buffer.from(text, "latin1");

/** Replace the fake solver with a script that records its thread environment, then waits. */
async function receiptSolver(shudBin: string) {
  vi.stubEnv("OMP_NUM_THREADS", "4");
  vi.stubEnv("SHUD_RHS_THREADS", "5");
  await io.unlink(shudBin);
  await io.writeFile(shudBin, binaryBytes, { mode: 0o755 });
}

async function threadReceipt(job: RunJob): Promise<string> {
  await waitForRecovery(
    async () => (await io.readdir(job.run_dir)).includes("argv-receipt"),
    "thread environment receipt",
  );
  return io.readFile(join(job.run_dir, "thread-receipt"), "utf8");
}

test("a GEOL_KSATH x2 set rewrites calib and NUM_OPENMP before provenance and binds ids at created", async () => {
  const h = await ccwPlanFixture();
  const execution = submissionProducer();
  const created: RunJob[] = [];
  try {
    await h.apply(ShudJobRegistry, h.config);
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (String(target).endsWith("/run-job.json")) {
        const record = RunJobSchema.parse(JSON.parse(await io.readFile(source, "utf8")));
        if (record.status === "created") created.push(record);
      }
      await actualIo.rename(source, target);
    });
    const calib = h.source["ccw.cfg.calib"].toString("latin1");
    const para = h.source["ccw.cfg.para"].toString("latin1");
    expect(calib.startsWith("GEOL_KSATH\t1\n")).toBe(true);
    expect(para).toContain("\nNUM_OPENMP\t8\n");
    expect(para).toContain("\nEND 1827\n");
    // The original cfg.para digest matches only if the check precedes the END/DT_YE_IC/NUM_OPENMP rewrites.
    const record = await actualRegistry(h.ctx).submitShud(
      h.planRequest({
        parameter_set_id: "PSET-2",
        calib_overrides: [{ key: "GEOL_KSATH", multiplier: 2 }],
        end_days: 30,
        input_digests: h.digests("ccw.cfg.calib", "ccw.para.geol", "ccw.cfg.para"),
      }),
      execution.start,
    );
    const expected: Record<string, Buffer> = {
      "ccw.cfg.calib": latin1(calib.replace(/^GEOL_KSATH\t1\n/u, "GEOL_KSATH\t2\n")),
      "ccw.cfg.para": latin1(
        `${para.replace("\nNUM_OPENMP\t8\n", "\nNUM_OPENMP\t1\n").replace("\nEND 1827\n", "\nEND 30\n")}DT_YE_IC\t1440\n`,
      ),
    };
    for (const [name, bytes] of Object.entries(h.source)) {
      const copy = await submittedFile(h.cwd, record, name);
      const want = expected[name] ?? bytes;
      expect(copy.bytes).toEqual(want);
      expect(copy.provenance).toBe(sha256(want));
      expect(await io.readFile(join(h.input, name))).toEqual(bytes);
    }
    expect(created).toHaveLength(1);
    const ids = { analysis_plan_id: PLAN_ID, parameter_set_id: "PSET-2", threads: 1 };
    expect(created[0]).toMatchObject(ids);
    expect(record).toMatchObject({ ...ids, status: "running", stack_id: created[0].stack_id });
  } finally {
    await execution.finish();
    await h.dispose();
  }
});

test("the baseline set keeps calib bytes, runs with one thread and collect inherits plan ids", async () => {
  const h = await ccwPlanFixture();
  const execution = settlingProducer();
  try {
    await receiptSolver(h.shudBin);
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    const job = await registry.submitShud(h.planRequest(), execution.start);
    const calib = await submittedFile(h.cwd, job, "ccw.cfg.calib");
    expect(calib.bytes).toEqual(h.source["ccw.cfg.calib"]);
    expect(calib.provenance).toBe(sha256(h.source["ccw.cfg.calib"]));
    const para = await submittedFile(h.cwd, job, "ccw.cfg.para");
    const before = h.source["ccw.cfg.para"].toString("latin1").split("\n");
    const after = para.bytes.toString("latin1").split("\n");
    expect(after.length).toBe(before.length + 1);
    const changed = after.filter((line, index) => line !== before[index]);
    expect(changed).toEqual(["NUM_OPENMP\t1", "DT_YE_IC\t1440", ""]);
    expect(para.provenance).toBe(sha256(para.bytes));
    const persisted = RunJobSchema.parse(
      JSON.parse(await io.readFile(join(job.run_dir, "run-job.json"), "utf8")),
    );
    const ids = { analysis_plan_id: PLAN_ID, parameter_set_id: "PSET-1", threads: 1 };
    expect(persisted).toMatchObject(ids);
    expect(await threadReceipt(job)).toBe("1\n1\nunset\n");
    await io.writeFile(join(job.run_dir, "allow-exit"), "release\n");
    await waitForRecovery(async () => {
      await registry.pollOnce();
      return execution.completed.length === 1;
    }, "plan-bound settlement");
    const result = await registry.collectShud(job.run_id);
    expect(RunRecordSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ ...ids, exit_code: 0 });
  } finally {
    await execution.cleanup();
    await h.dispose();
  }
}, 15000);

test("an unbound threads 2 submission keeps NUM_OPENMP 8 and still sets the thread environment", async () => {
  const h = await ccwPlanFixture();
  const execution = settlingProducer();
  try {
    await receiptSolver(h.shudBin);
    await h.apply(ShudJobRegistry, h.config);
    const job = await actualRegistry(h.ctx).submitShud(
      { ...h.request, input_dir: h.input, project: "ccw", threads: 2 },
      execution.start,
    );
    expect(job).toMatchObject({ analysis_plan_id: null, parameter_set_id: null, threads: 2 });
    const para = await submittedFile(h.cwd, job, "ccw.cfg.para");
    expect(para.bytes).toEqual(
      latin1(`${h.source["ccw.cfg.para"].toString("latin1")}DT_YE_IC\t1440\n`),
    );
    expect((await submittedFile(h.cwd, job, "ccw.cfg.calib")).bytes).toEqual(
      h.source["ccw.cfg.calib"],
    );
    expect(await threadReceipt(job)).toBe("2\n2\nunset\n");
  } finally {
    await execution.cleanup();
    await h.dispose();
  }
}, 15000);

test("a comment-only NUM_OPENMP is appended after DT_YE_IC with the plan threads", async () => {
  const parameter = "# NUM_OPENMP 4\nSTART\t0\nEND\t7\n";
  const h = await submissionFixture(parameter);
  const execution = submissionProducer();
  try {
    const calib = latin1("GEOL_KSATH\t1\n");
    await io.writeFile(join(h.inputDir, "tiny.cfg.calib"), calib);
    await h.apply(ShudJobRegistry, h.config);
    const record = await actualRegistry(h.ctx).submitShud(
      {
        ...h.request,
        analysis_plan_id: PLAN_ID,
        parameter_set_id: "PSET-3",
        calib_overrides: [],
        threads: 2,
        input_digests: { "tiny.cfg.calib": sha256(calib) },
      },
      execution.start,
    );
    const expected = latin1(`${parameter}DT_YE_IC\t1440\nNUM_OPENMP\t2\n`);
    const para = await submittedFile(h.cwd, record, "tiny.cfg.para");
    expect(para.bytes).toEqual(expected);
    expect(para.provenance).toBe(sha256(expected));
    expect(await io.readFile(join(h.inputDir, "tiny.cfg.para"), "utf8")).toBe(parameter);
  } finally {
    await execution.finish();
    await h.dispose();
  }
});

test("a baseline and three calib-only sets in one environment share one StackLock", async () => {
  const h = await ccwPlanFixture();
  const executions = [0, 1, 2, 3].map(() => submissionProducer());
  try {
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    const sets = [
      [],
      [{ key: "GEOL_KSATH", multiplier: 2 }],
      [{ key: "LC_ROUGH", multiplier: 0.5 }],
      [{ key: "RIV_ROUGH", multiplier: 1.5 }],
    ] as const;
    const records: RunJob[] = [];
    for (const [index, overrides] of sets.entries()) {
      records.push(
        await registry.submitShud(
          h.planRequest({
            parameter_set_id: `PSET-${index + 1}`,
            calib_overrides: overrides.map((override) => ({ ...override })),
          }),
          executions[index].start,
        ),
      );
    }
    expect(new Set(records.map((record) => record.stack_id)).size).toBe(1);
    expect(await io.readdir(join(h.cwd, "stacks"))).toEqual([`${records[0].stack_id}.json`]);
    const hashes = await Promise.all(
      records.map(
        async (record) => (await submittedFile(h.cwd, record, "ccw.cfg.calib")).provenance,
      ),
    );
    expect(hashes[0]).toBe(sha256(h.source["ccw.cfg.calib"]));
    expect(new Set(hashes).size).toBe(4);
    expect(records.map((record) => record.parameter_set_id)).toEqual([
      "PSET-1",
      "PSET-2",
      "PSET-3",
      "PSET-4",
    ]);
  } finally {
    for (const execution of executions) await execution.finish();
    await h.dispose();
  }
}, 15000);

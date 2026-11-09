import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { produceDetachedShud } from "@shud-harness/dsh-shud-jobs";
import { expectNativeReceipt } from "./shud-run-build/test-harness.ts";
import { returnedRun, TASK } from "./task-linked/test-harness.ts";
import {
  aliasedInput,
  DIGEST_FILES,
  readCard,
  readPlan,
  sha256,
} from "./analysis-create/test-harness.ts";
import { copied, planHarness, type PlanHarness } from "./shud-run-plan/test-harness.ts";

let h: PlanHarness;
beforeEach(async () => {
  h = await planHarness();
});
afterEach(async () => {
  await h.dispose();
});

const source = (name: string) => fs.readFileSync(join(h.input, name), "latin1");
const llm = { response_model: "configured-test-model", response_model_source: "configured" };

test("a linked plan's PSET-3 runs with the plan window, threads, override and digests", async () => {
  const plan = await h.createPlan();
  const original = { para: source("ccw.cfg.para"), calib: source("ccw.cfg.calib") };
  expect(original.para).toContain("\nNUM_OPENMP\t8\n");
  expect(original.para).toContain("\nEND 1827\n");
  expect(original.calib.startsWith("GEOL_KSATH\t1\n")).toBe(true);
  const digests = Object.fromEntries(
    DIGEST_FILES.map((file) => [file, sha256(join(h.input, file))]),
  );
  const before = await h.effects();
  const submit = vi.spyOn(h.registry, "submitShud");

  const job = await returnedRun(h, await h.run(plan));

  expect(submit).toHaveBeenCalledExactlyOnceWith(
    {
      cwd: h.cwd,
      input_dir: "input/ccw",
      project: "ccw",
      task_id: TASK,
      owner_session: h.ownerId,
      llm,
      analysis_plan_id: plan,
      parameter_set_id: "PSET-3",
      end_days: 90,
      threads: 1,
      calib_overrides: [{ key: "GEOL_KSATH", multiplier: 2 }],
      input_digests: digests,
    },
    produceDetachedShud,
  );
  // Forwarded verbatim: every key of the plan's own digest map, nothing added or dropped.
  expect(submit.mock.calls[0][0].input_digests).toEqual(readPlan(h, plan).input_digests);
  expect(job).toMatchObject({
    analysis_plan_id: plan,
    parameter_set_id: "PSET-3",
    end_days: 90,
    threads: 1,
    task_id: TASK,
  });
  await expectNativeReceipt(job.run_dir, "thread-receipt", "1\n1\nunset\n");
  const para = copied(job, "ccw.cfg.para");
  expect(para).toContain("\nEND 90\n");
  expect(para).toContain("\nNUM_OPENMP\t1\n");
  expect(para).not.toContain("NUM_OPENMP\t8");
  expect(copied(job, "ccw.cfg.calib")).toBe(
    original.calib.replace(/^GEOL_KSATH\t1\n/u, "GEOL_KSATH\t2\n"),
  );
  const after = await h.effects();
  expect(after.input).toEqual(before.input);
  expect(after.analyses).toEqual(before.analyses);
  expect(readCard(h)).toMatchObject({ status: "running", linked_jobs: [job.job_id] });
}, 20_000);

test("the baseline set forwards no override and keeps the calib copy unchanged", async () => {
  const plan = await h.createPlan();
  const submit = vi.spyOn(h.registry, "submitShud");
  const job = await returnedRun(h, await h.run(plan, { parameter_set_id: "PSET-1" }));
  expect(submit.mock.calls[0][0]).toMatchObject({
    parameter_set_id: "PSET-1",
    calib_overrides: [],
  });
  expect(job.parameter_set_id).toBe("PSET-1");
  expect(copied(job, "ccw.cfg.calib")).toBe(source("ccw.cfg.calib"));
}, 20_000);

test("explicit threads and end_days equal to the plan are accepted", async () => {
  const plan = await h.createPlan();
  const job = await returnedRun(h, await h.run(plan, { threads: 1, end_days: 90 }));
  expect(job).toMatchObject({ threads: 1, end_days: 90 });
}, 20_000);

test("plan threads 2 apply when the call omits threads", async () => {
  const plan = await h.createPlan({ threads: 2 });
  const job = await returnedRun(h, await h.run(plan));
  expect(job.threads).toBe(2);
  await expectNativeReceipt(job.run_dir, "thread-receipt", "2\n2\nunset\n");
  expect(copied(job, "ccw.cfg.para")).toContain("\nNUM_OPENMP\t2\n");
}, 20_000);

test("input_dir resolves physically through link/.., never by textual collapse", async () => {
  const physical = aliasedInput(h, "alias");
  const plan = await h.createPlan({ input_dir: "link/../alias", project: "ccw" });
  expect(readPlan(h, plan).input_dir).toBe(physical);
  const collapse = await h.run(plan, { input_dir: "alias", project: "ccw" });
  expect(collapse.isError).toBe(true);
  if (!collapse.isError) throw new Error("textual collapse was accepted");
  expect(collapse.error.message).toMatch(/input_dir/u);
  const job = await returnedRun(
    h,
    await h.run(plan, { input_dir: "link/../alias", project: "ccw" }),
  );
  expect(job.analysis_plan_id).toBe(plan);
}, 20_000);

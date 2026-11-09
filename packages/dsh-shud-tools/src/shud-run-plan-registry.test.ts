import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { classifyRunExit, type AnalysisPlanId, type RunJob } from "@shud-harness/dsh-shud-core";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import * as policyGate from "../../dsh-shud-policy-gate/src/index.ts";
import { RAW_READ_PROVENANCE_REASON } from "../../dsh-shud-raw-guard/src/decide.ts";
import { ledger } from "../../dsh-shud-jobs/src/submit-shud-pset/test-harness.ts";
import { admission } from "./change-create/test-harness.ts";
import { expectToolError, putCard, returnedRun, treeOrAbsent } from "./task-linked/test-harness.ts";
import { analysesDir, readCard } from "./analysis-create/test-harness.ts";
import {
  planHarness,
  seedPriorJob,
  type PlanHarness,
  type SeededEvidence,
} from "./shud-run-plan/test-harness.ts";

let h: PlanHarness;
beforeEach(async () => {
  h = await planHarness();
});
afterEach(async () => {
  await h.dispose();
});

/** Run directory names; an absent runs/ root is empty (the registry may or may not leave it). */
function runNames() {
  try {
    return fs.readdirSync(join(h.cwd, "runs")).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** Every effect but the runs/ tree, which live solvers keep writing; run names are checked apart. */
async function effectsBesideRuns() {
  const { outputs, ...rest } = await h.effects();
  return { ...rest, outputs: outputs.slice(1) };
}

/** A same-pset prior job, already linked to the card as an earlier submission left it. */
async function linkedPrior(
  plan: AnalysisPlanId,
  changes: Partial<RunJob>,
  evidence: SeededEvidence,
) {
  const job = await seedPriorJob(
    h,
    "a001",
    { analysis_plan_id: plan, parameter_set_id: "PSET-3", ...changes },
    evidence,
  );
  putCard(h, { ...readCard(h), linked_jobs: [job.job_id] });
  return job;
}

test("an input edited after the plan was linked is rejected naming the file", async () => {
  const plan = await h.createPlan();
  fs.appendFileSync(join(h.input, "ccw.cfg.calib"), "# edited after the plan\n");
  const planBytes = fs.readFileSync(join(analysesDir(h), `${plan}.json`));
  const before = await effectsBesideRuns();
  expectToolError(await h.run(plan), /ccw\.cfg\.calib/u);
  // The registry may leave its empty runs/ root; no run directory of this call remains.
  expect(runNames()).toEqual([]);
  expect(await effectsBesideRuns()).toEqual(before);
  expect(readCard(h).linked_jobs).toEqual([]);
  expect(fs.readFileSync(join(analysesDir(h), `${plan}.json`))).toEqual(planBytes);
}, 20_000);

const DUPLICATE = /Parameter set PSET-3 of analysis plan PLAN-\S+ already has a non-failed run/u;

test("a running job of the same pset rejects the resubmission naming the pset", async () => {
  const plan = await h.createPlan();
  const first = await returnedRun(h, await h.run(plan));
  const before = await effectsBesideRuns();
  expectToolError(await h.run(plan), DUPLICATE);
  expect(runNames()).toEqual([first.run_id]);
  expect(readCard(h).linked_jobs).toEqual([first.job_id]);
  expect(await effectsBesideRuns()).toEqual(before);
  // A different pset of the same plan is not a duplicate.
  const other = await returnedRun(h, await h.run(plan, { parameter_set_id: "PSET-2" }));
  expect(readCard(h).linked_jobs).toEqual([first.job_id, other.job_id].sort());
  expect(readCard(h).linked_analyses).toEqual([plan]);
}, 30_000);

test("a collected succeeded job of the same pset rejects the resubmission", async () => {
  const plan = await h.createPlan();
  const prior = await linkedPrior(
    plan,
    { status: "collected", exit_code: 0 },
    { record: {}, index: "completed" },
  );
  const before = await h.effects();
  expectToolError(await h.run(plan), DUPLICATE);
  expect(runNames()).toEqual([prior.run_id]);
  expect(readCard(h).linked_jobs).toEqual([prior.job_id]);
  expect(await h.effects()).toEqual(before);
}, 20_000);

const failedRows: Array<[string, Partial<RunJob>, SeededEvidence]> = [
  [
    "a collected failed",
    { status: "collected", exit_code: 1 },
    {
      record: { status: "failed", exit_code: 1, exit_class: classifyRunExit(1) },
      index: "completed",
    },
  ],
  ["a cancelled", { status: "cancelled" }, { ledger: ledger(1) }],
  ["a collect-exhausted", { status: "succeeded", exit_code: 0 }, { ledger: ledger(3) }],
];

test.each(failedRows)(
  "%s prior job allows the retry and both stay linked",
  async (_name, changes, evidence) => {
    const plan = await h.createPlan();
    const prior = await linkedPrior(plan, changes, evidence);
    const priorFiles = await treeOrAbsent(prior.run_dir);
    const job = await returnedRun(h, await h.run(plan));
    expect(job).toMatchObject({ analysis_plan_id: plan, parameter_set_id: "PSET-3" });
    expect(readCard(h).linked_jobs).toEqual([prior.job_id, job.job_id].sort());
    expect(await treeOrAbsent(prior.run_dir)).toEqual(priorFiles);
  },
  20_000,
);

test("corrupt registry evidence is an integrity failure, never reported as a duplicate", async () => {
  const plan = await h.createPlan();
  // Collected without run-record.json: the task query passes, the pset check cannot decide.
  const prior = await linkedPrior(
    plan,
    { status: "collected", exit_code: 0 },
    { index: "completed" },
  );
  const before = await h.effects();
  const message = expectToolError(
    await h.run(plan),
    new RegExp(`SHUD parameter set check ${prior.run_id}`, "u"),
  );
  expect(message).not.toMatch(/already has a non-failed run/u);
  expect(await h.effects()).toEqual(before);
}, 20_000);

/** A projected role through the real raw-guard and policy-gate pre-execute chain. */
async function roleChain(rawDirs: string[], role = "worker") {
  const plan = await h.createPlan();
  h.presets.set(h.agent.session, role);
  await h.apply(rawGuard, { rawDirs });
  await h.apply(policyGate, {});
  return { plan, seen: await admission(h) };
}

test("a worker plan-bound run outside raw executes without any approval", async () => {
  const { plan, seen } = await roleChain([join(h.root, "unrelated-raw")]);
  const job = await returnedRun(h, await h.run(plan));
  expect(job.analysis_plan_id).toBe(plan);
  expect(seen.approvals).toEqual([]);
  expect(seen.executions).toBe(1);
}, 20_000);

test("the same chain denies a coordinator plan-bound run: the projected role is read", async () => {
  const { plan, seen } = await roleChain([join(h.root, "unrelated-raw")], "coordinator");
  const before = await h.effects();
  expectToolError(await h.run(plan), /Role coordinator cannot call tool shud_run/u);
  expect(seen.approvals).toEqual([]);
  expect(seen.executions).toBe(0);
  expect(await h.effects()).toEqual(before);
}, 20_000);

test("a worker plan-bound run on raw input keeps raw-guard's provenance ask", async () => {
  const { plan, seen } = await roleChain(["input/ccw"]);
  const job = await returnedRun(h, await h.run(plan));
  expect(job.parameter_set_id).toBe("PSET-3");
  expect(seen.approvals).toHaveLength(1);
  expect(seen.approvals[0]).toMatchObject({
    toolName: "shud_run",
    agent: h.agent,
    reason: RAW_READ_PROVENANCE_REASON,
  });
  expect(seen.executions).toBe(1);
}, 20_000);

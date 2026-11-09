import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AnalysisPlanIdSchema } from "@shud-harness/dsh-shud-core";
import {
  cardSnapshot,
  expectToolError,
  getCard,
  OTHER_TASK,
  plannedCard,
  putCard,
  returnedRun,
  TASK,
} from "./task-linked/test-harness.ts";
import { analysesDir, seedCard, seedOrphan } from "./analysis-create/test-harness.ts";
import { planHarness, seedPriorJob, type PlanHarness } from "./shud-run-plan/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    openSync: vi.fn(actual.openSync),
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    renameSync: vi.fn(actual.renameSync),
    statSync: vi.fn(actual.statSync),
  };
});

const MISSING_PLAN = AnalysisPlanIdSchema.parse("PLAN-20261108T093000-dead");
let h: PlanHarness;
beforeEach(async () => {
  h = await planHarness();
});
afterEach(async () => {
  await h.dispose();
});

/** Synchronous filesystem calls that name a path under analyses/, tasks/ or runs/. */
function governedCalls(pattern = /\/(?:analyses|tasks|runs)(?:\/|$)/u) {
  const calls: unknown[][] = [];
  for (const operation of [
    fs.lstatSync,
    fs.mkdirSync,
    fs.openSync,
    fs.readdirSync,
    fs.readFileSync,
    fs.renameSync,
    fs.statSync,
  ]) {
    for (const args of vi.mocked(operation).mock.calls) {
      if (args.some((arg) => typeof arg === "string" && pattern.test(arg))) calls.push([...args]);
    }
  }
  return calls;
}

async function rejectsWithoutEffects(
  args: Record<string, unknown>,
  message: RegExp,
  unknownKey = false,
) {
  const query = vi.spyOn(h.registry, "listRunJobsByTask");
  const submit = vi.spyOn(h.registry, "submitShud");
  const before = await h.effects();
  vi.clearAllMocks();
  const error = expectToolError(await h.call(args), message);
  // The plan pair is part of the closed schema; only internal fields are unknown keys.
  if (!unknownKey) expect(error).not.toMatch(/unknown parameter/iu);
  expect(query).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(await h.effects()).toEqual(before);
  return error;
}

const shapes: Array<[string, Record<string, unknown>, RegExp]> = [
  ["only analysis_plan_id", { analysis_plan_id: MISSING_PLAN }, /parameter_set_id/u],
  ["only parameter_set_id", { parameter_set_id: "PSET-3" }, /analysis_plan_id/u],
  [
    "the pair without task_id",
    { analysis_plan_id: MISSING_PLAN, parameter_set_id: "PSET-3", task_id: undefined },
    /task_id/u,
  ],
  ["PSET-0", { analysis_plan_id: MISSING_PLAN, parameter_set_id: "PSET-0" }, /parameter_set_id/u],
  ["PSET-6", { analysis_plan_id: MISSING_PLAN, parameter_set_id: "PSET-6" }, /parameter_set_id/u],
  [
    "a malformed plan id",
    { analysis_plan_id: "PLAN-1", parameter_set_id: "PSET-3" },
    /analysis_plan_id/u,
  ],
  [
    "a traversal plan id",
    { analysis_plan_id: "../tasks/x", parameter_set_id: "PSET-3" },
    /analysis_plan_id/u,
  ],
  ["a numeric pset", { analysis_plan_id: MISSING_PLAN, parameter_set_id: 3 }, /parameter_set_id/u],
];

test.each(shapes)("%s is rejected with zero filesystem access", async (_name, fields, message) => {
  putCard(h, plannedCard({ type: "sensitivity" }));
  const args: Record<string, unknown> = { input_dir: "input/ccw", task_id: TASK, ...fields };
  // An explicit undefined marks the omitted key; native calls carry lossless JSON only.
  if ("task_id" in fields) Reflect.deleteProperty(args, "task_id");
  await rejectsWithoutEffects(args, message);
  expect(governedCalls()).toEqual([]);
});

test.each(["calib_overrides", "changes", "input_digests"])(
  "model-supplied %s is an unknown parameter",
  async (key) => {
    const plan = await h.createPlan();
    const value =
      key === "calib_overrides"
        ? [{ key: "GEOL_KSATH", multiplier: 3 }]
        : key === "changes"
          ? { GEOL_KSATH: 3 }
          : {};
    await rejectsWithoutEffects(
      {
        task_id: TASK,
        input_dir: "input/ccw",
        analysis_plan_id: plan,
        parameter_set_id: "PSET-3",
        [key]: value,
      },
      new RegExp(`unknown parameter: ${key}`, "iu"),
      true,
    );
    expect(governedCalls()).toEqual([]);
  },
);

const mismatches: Array<[string, Record<string, unknown>, RegExp]> = [
  ["a missing plan", { analysis_plan_id: MISSING_PLAN }, /analysis_plan_id.*missing/u],
  [
    "another card's plan",
    { analysis_plan_id: "OTHER" },
    /analysis_plan_id \S+ belongs to task TASK-20261027T080005-abcd/u,
  ],
  ["a pset not in the plan", { parameter_set_id: "PSET-5" }, /parameter_set_id.*PSET-5/u],
  [
    "another input_dir",
    { input_dir: "input/other", project: "ccw" },
    /input_dir input\/other does not/u,
  ],
  [
    "a missing input_dir",
    { input_dir: "input/absent", project: "ccw" },
    /input_dir input\/absent does not/u,
  ],
  ["another project", { project: "tiny" }, /project tiny differs/u],
  ["end_days 30 against plan 90", { end_days: 30 }, /end_days 30 differs/u],
  ["threads 2 against plan 1", { threads: 2 }, /threads 2 differs/u],
  ["threads 8 against plan 1", { threads: 8 }, /threads 8 differs/u],
];

test.each(mismatches)(
  "%s is rejected before the task query, card read or any write",
  async (_name, fields, message) => {
    const plan = await h.createPlan();
    fs.cpSync(h.input, join(h.cwd, "input", "other"), { recursive: true });
    const other = seedOrphan(h, "PLAN-20261108T093000-0ff1", { task_id: OTHER_TASK }).plan;
    const card = await cardSnapshot(h);
    const resolved = {
      ...fields,
      ...(fields.analysis_plan_id === "OTHER" ? { analysis_plan_id: other.analysis_plan_id } : {}),
    };
    await rejectsWithoutEffects(
      {
        task_id: TASK,
        input_dir: "input/ccw",
        analysis_plan_id: plan,
        parameter_set_id: "PSET-3",
        ...resolved,
      },
      message,
    );
    // Positive control: the mock sees the records package's plan read, so the zero-access
    // assertions in this file observe real reads rather than a blind spy.
    expect(governedCalls(/\/analyses\//u)).not.toEqual([]);
    expect(governedCalls(/\/(?:tasks|runs)(?:\/|$)/u)).toEqual([]);
    expect(await cardSnapshot(h)).toEqual(card);
  },
);

test("a missing plan with no analyses/ root is rejected without creating it", async () => {
  seedCard(h, { linked_analyses: [MISSING_PLAN] });
  const card = await cardSnapshot(h);
  expect((await h.effects()).analyses).toBeNull();
  await rejectsWithoutEffects(
    {
      task_id: TASK,
      input_dir: "input/ccw",
      analysis_plan_id: MISSING_PLAN,
      parameter_set_id: "PSET-3",
    },
    new RegExp(`analysis_plan_id ${MISSING_PLAN}.*missing`, "u"),
  );
  // A read never creates the plan root: analyses/ stays absent, not an empty directory.
  expect((await h.effects()).analyses).toBeNull();
  expect(governedCalls(/\/(?:tasks|runs)(?:\/|$)/u)).toEqual([]);
  expect(await cardSnapshot(h)).toEqual(card);
});

test("a schema-valid plan whose analysis_plan_id differs from its filename is rejected", async () => {
  const id = AnalysisPlanIdSchema.parse("PLAN-20261108T093000-f11e");
  seedCard(h, { linked_analyses: [id] });
  const { plan } = seedOrphan(h, id, { analysis_plan_id: "PLAN-20261108T093000-b0d7" });
  expect(plan.analysis_plan_id).not.toBe(id);
  const card = await cardSnapshot(h);
  await rejectsWithoutEffects(
    { task_id: TASK, input_dir: "input/ccw", analysis_plan_id: id, parameter_set_id: "PSET-3" },
    new RegExp(`analysis_plan_id ${id}.*identity`, "u"),
  );
  expect(governedCalls(/\/(?:tasks|runs)(?:\/|$)/u)).toEqual([]);
  expect(await cardSnapshot(h)).toEqual(card);
});

test.each([
  ["unparsable", "{not json"],
  ["schema-invalid", JSON.stringify({ analysis_plan_id: "PLAN-20261108T093000-bad0" })],
])("a %s plan file is rejected naming the plan", async (_name, bytes) => {
  seedCard(h);
  const id = AnalysisPlanIdSchema.parse("PLAN-20261108T093000-bad0");
  fs.mkdirSync(analysesDir(h));
  fs.writeFileSync(join(analysesDir(h), `${id}.json`), bytes);
  const card = await cardSnapshot(h);
  await rejectsWithoutEffects(
    { task_id: TASK, input_dir: "input/ccw", analysis_plan_id: id, parameter_set_id: "PSET-3" },
    new RegExp(`analysis_plan_id ${id}.*(?:parse|schema)`, "u"),
  );
  expect(await cardSnapshot(h)).toEqual(card);
});

/** A prior job of this card that reconciliation would link: proof the check precedes publication. */
async function unlinkedPriorJob() {
  return seedPriorJob(
    h,
    "a001",
    { status: "collected", exit_code: 0 },
    { record: {}, index: "completed" },
  );
}

test("a plan of this card that the card does not link is rejected before reconciliation", async () => {
  seedCard(h);
  const { plan } = seedOrphan(h, "PLAN-20261108T093000-0a0a");
  await unlinkedPriorJob();
  const card = await cardSnapshot(h);
  const before = await h.effects();
  expectToolError(
    await h.run(plan.analysis_plan_id),
    new RegExp(`analysis_plan_id ${plan.analysis_plan_id} is not linked to task ${TASK}`, "u"),
  );
  expect(await cardSnapshot(h)).toEqual(card);
  expect(getCard(h).linked_analyses).toEqual([]);
  expect(await h.effects()).toEqual(before);
});

test("a sensitivity card without plan arguments is rejected before reconciliation", async () => {
  await h.createPlan();
  await unlinkedPriorJob();
  const card = await cardSnapshot(h);
  const before = await h.effects();
  expectToolError(
    await h.call({ task_id: TASK, input_dir: "input/ccw" }),
    /sensitivity.*analysis_plan_id.*parameter_set_id/u,
  );
  expect(await cardSnapshot(h)).toEqual(card);
  expect(await h.effects()).toEqual(before);
});

test.each([
  ["a science_assist card", true, false],
  ["no card", false, false],
  ["a science_assist card beside a broken analyses link", true, true],
  ["no card beside a broken analyses link", false, true],
])(
  "an unbound run with %s never touches analyses/",
  async (_name, linked, broken) => {
    if (linked) putCard(h);
    if (broken) fs.symlinkSync(join(h.root, "absent-analyses"), analysesDir(h));
    const submit = vi.spyOn(h.registry, "submitShud");
    vi.clearAllMocks();
    const job = await returnedRun(
      h,
      await h.call({ input_dir: "input/ccw", ...(linked ? { task_id: TASK } : {}) }),
    );
    expect(governedCalls(/\/analyses(?:\/|$)/u)).toEqual([]);
    expect(Object.keys(submit.mock.calls[0][0]).sort()).toEqual(
      [
        "cwd",
        "input_dir",
        "llm",
        "owner_session",
        "project",
        ...(linked ? ["task_id"] : []),
      ].sort(),
    );
    expect(job).toMatchObject({ analysis_plan_id: null, parameter_set_id: null, threads: null });
    if (linked) expect(getCard(h)).toMatchObject({ status: "running", linked_jobs: [job.job_id] });
    if (broken) expect(fs.readlinkSync(analysesDir(h))).toBe(join(h.root, "absent-analyses"));
    await expect(io.readdir(join(h.cwd, "analyses"))).rejects.toMatchObject({ code: "ENOENT" });
  },
  20_000,
);

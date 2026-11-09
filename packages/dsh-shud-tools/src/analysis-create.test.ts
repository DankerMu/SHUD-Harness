import * as fs from "node:fs";
import { join } from "node:path";
import { AnalysisPlanIdSchema } from "@shud-harness/dsh-shud-core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { cardPath, expectToolError, OTHER_TASK, TASK } from "./task-linked/test-harness.ts";
import {
  aliasedInput,
  analysisHarness,
  DIGEST_FILES,
  planNames,
  readCard,
  readPlan,
  seedCard,
  sha256,
  successValue,
  validArgs,
  workspaceSnapshot,
  type AnalysisHarness,
} from "./analysis-create/test-harness.ts";

let h: AnalysisHarness;
beforeEach(async () => {
  h = await analysisHarness();
});
afterEach(async () => {
  await h.dispose();
});

const expectedSets = [
  { parameter_set_id: "PSET-1", label: null, baseline: true, changes: {} },
  { parameter_set_id: "PSET-2", label: null, baseline: false, changes: { GEOL_KSATH: 0.5 } },
  { parameter_set_id: "PSET-3", label: null, baseline: false, changes: { GEOL_KSATH: 2 } },
  { parameter_set_id: "PSET-4", label: null, baseline: false, changes: { LC_ROUGH: 2 } },
];

test("acceptance call publishes one plan, links the planned card and leaves input bytes", async () => {
  const before = seedCard(h);
  const snapshot = await workspaceSnapshot(h);
  const started = Date.now();

  const value = successValue(await h.invoke(validArgs));

  const id = AnalysisPlanIdSchema.parse(value.analysis_plan_id);
  expect(value).toEqual({ analysis_plan_id: id, parameter_sets: expectedSets });
  expect(planNames(h)).toEqual([`${id}.json`]);
  const plan = readPlan(h, id);
  expect(plan).toEqual({
    analysis_plan_id: id,
    task_id: TASK,
    mode: "sensitivity",
    strategy: "one_at_a_time",
    input_dir: fs.realpathSync.native(h.input),
    project: "ccw",
    end_days: 90,
    threads: 1,
    parameter_sets: expectedSets,
    parameter_space_rationale: {
      proposed_by: "agent",
      basis: validArgs.rationale_basis,
      confirmed_by: null,
    },
    input_digests: Object.fromEntries(
      DIGEST_FILES.map((file) => [file, sha256(join(h.input, file))]),
    ),
    created_by: "coordinator",
    created_at: plan.created_at,
  });
  expect(Date.parse(plan.created_at)).toBeGreaterThanOrEqual(started - 1000);

  const card = readCard(h);
  expect(before.linked_analyses).toEqual([]);
  expect(card.linked_analyses).toEqual([id]);
  expect(card.updated_at).not.toBe(before.updated_at);
  expect(Date.parse(card.updated_at)).toBeGreaterThanOrEqual(started - 1000);
  expect(card).toEqual({ ...before, linked_analyses: [id], updated_at: card.updated_at });
  expect(card.status).toBe("planned");
  expect(card.runtime_phase).toBeNull();
  expect(fs.readdirSync(join(h.cwd, "tasks", TASK))).toEqual(["task.json"]);

  const after = await workspaceSnapshot(h);
  expect(after.input).toEqual(snapshot.input);
  expect(after.outputs).toEqual([null, null, null, null]);
});

test("running card stays running with its runtime phase while linking", async () => {
  seedCard(h, { status: "running", runtime_phase: "waiting_for_job" });
  const value = successValue(await h.invoke(validArgs));
  expect(readCard(h)).toMatchObject({
    status: "running",
    runtime_phase: "waiting_for_job",
    linked_analyses: [value.analysis_plan_id],
  });
});

test("labels, explicit threads and project are recorded; missing projection is unknown", async () => {
  seedCard(h);
  h.presets.delete(h.agent.session);
  const value = successValue(
    await h.invoke({
      ...validArgs,
      project: "ccw",
      threads: 2,
      parameter_sets: validArgs.parameter_sets.map((set, index) =>
        index === 0 ? { ...set, label: "baseline" } : set,
      ),
    }),
  );
  expect(value.parameter_sets[0]).toEqual({ ...expectedSets[0], label: "baseline" });
  const plan = readPlan(h, value.analysis_plan_id);
  expect(plan).toMatchObject({ threads: 2, project: "ccw", created_by: "unknown" });
  expect(plan.parameter_sets[0].label).toBe("baseline");
});

test.each([
  {
    label: "symlinked input/link",
    arrange: () => {
      fs.symlinkSync(h.input, join(h.cwd, "input", "link"));
      return ["input/link", fs.realpathSync.native(h.input)];
    },
  },
  { label: "link/.. alias", arrange: () => ["link/../ccw", aliasedInput(h, "ccw")] },
  {
    label: "absolute link/.. alias",
    arrange: () => [`${h.cwd}/link/../ccw`, aliasedInput(h, "ccw")],
  },
])("$label records the physically resolved input_dir", async ({ arrange }) => {
  seedCard(h);
  const [input_dir, expected] = arrange();
  const value = successValue(await h.invoke({ ...validArgs, input_dir, project: "ccw" }));
  expect(readPlan(h, value.analysis_plan_id).input_dir).toBe(expected);
});

test.each([
  {
    label: "science_assist card",
    card: { type: "science_assist" as const },
    message: /type|sensitivity/iu,
  },
  {
    label: "reporting card",
    card: { status: "reporting" as const },
    message: /status|reporting/iu,
  },
  {
    label: "already-linked card",
    card: { linked_analyses: [AnalysisPlanIdSchema.parse("PLAN-20261108T093000-aaaa")] },
    message: /already|linked/iu,
  },
])("$label is rejected without plan or card writes", async ({ card, message }) => {
  seedCard(h, card);
  const before = await workspaceSnapshot(h);
  expectToolError(await h.invoke(validArgs), message);
  expect(await workspaceSnapshot(h)).toEqual(before);
  expect(planNames(h)).toBeNull();
});

test("missing task card is named without creating tasks/<id> or analyses/", async () => {
  seedCard(h);
  const before = await workspaceSnapshot(h);
  expectToolError(await h.invoke({ ...validArgs, task_id: OTHER_TASK }), /missing|not found/iu);
  expect(await workspaceSnapshot(h)).toEqual(before);
  expect(fs.existsSync(join(h.cwd, "tasks", OTHER_TASK))).toBe(false);
  expect(planNames(h)).toBeNull();
  expect(fs.existsSync(cardPath(h))).toBe(true);
});

test("input_dir '.' without project names project and writes nothing", async () => {
  seedCard(h);
  const before = await workspaceSnapshot(h);
  expectToolError(await h.invoke({ ...validArgs, input_dir: "." }), /project/u);
  expect(await workspaceSnapshot(h)).toEqual(before);
});
